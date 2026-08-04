/**
 * The consumer side of a catalog break: real SQL files, executed for real.
 *
 * A runbook going stale is one kind of damage; the reports that read the same
 * table are the other. This module gives the repair drill something executable
 * to break and to fix: it copies the consumer SQL under `examples/consumer/`
 * into a working directory, builds a small SQLite warehouse whose DDL comes
 * from the live catalog's schema, runs every query, and hashes the results.
 *
 * The warehouse rows are deterministic, keyed by (table, row index, column
 * position), so two builds from the same schema are identical. The break
 * reaches the warehouse the way it reaches a real one: `ALTER TABLE … RENAME
 * COLUMN`, which moves the name and physically cannot move the data. That is
 * what makes the drill's central claim checkable — a correctly repaired query
 * must return byte-identical results, the same result hash, as it did before
 * the break, and a repair that substituted the wrong column moves the hash.
 *
 * No LLM anywhere in this path, same as the detector.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shortName } from "./prove-profiles";
import type { ProposedEdit } from "./remediate";
import type { EntitySnapshot } from "./types";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/* ── Deterministic rows ───────────────────────────────────────────────── */

/**
 * A stable integer derived from the key. sha256 rather than a PRNG so the
 * value depends only on the key, not on how many values were drawn before it.
 */
function det(key: string, modulo: number): number {
  return parseInt(sha256(key).slice(0, 12), 16) % modulo;
}

const TEXT_WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

const isDateColumn = (name: string) => /(^|_)(date|day)($|_)|_at$/.test(name);
const isMonthColumn = (name: string) => /(^|_)month($|_)/.test(name);
const isTextColumn = (name: string) =>
  /(^|_)(provider|plan|status|class|country|email|name|city|region|type|category|segment|channel)($|_)/.test(name);
const isIntColumn = (name: string) => /(^|_)(id|key|count|attempts|orders|qty|quantity|subscribers|churned|units)($|_)/.test(name);

function isoDate(daysFromEpoch: number): string {
  const d = new Date(Date.UTC(2025, 0, 1) + daysFromEpoch * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * The value at (table, row, column position). The column *name* picks the
 * flavor — date, month, text, integer, money — and the position picks the
 * value, so a build is a pure function of the schema it was given.
 */
export function valueFor(table: string, rowIndex: number, colPosition: number, columnName: string): string | number {
  const key = `${table}|${rowIndex}|${colPosition}`;
  if (isMonthColumn(columnName)) return isoDate((rowIndex % 12) * 30 + 14).slice(0, 7) + "-01";
  if (isDateColumn(columnName)) return isoDate((rowIndex * 7 + det(key, 5)) % 360);
  if (isTextColumn(columnName)) return TEXT_WORDS[det(key, TEXT_WORDS.length)];
  if (isIntColumn(columnName)) return 1 + det(key, 10_000);
  // Money-ish default: cents, so every downstream SUM lands on two decimals.
  return (100 + det(key, 1_900_000)) / 100;
}

export function rowCountFor(table: string): number {
  return 36 + det(`rows|${table}`, 12);
}

/* ── The warehouse ────────────────────────────────────────────────────── */

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface WarehouseTable {
  urn: string;
  table: string;
  columns: string[];
  rows: number;
}

/**
 * Build an in-memory warehouse whose tables and columns are exactly what the
 * catalog says they are right now. The drill builds it twice from the same
 * code: once against the baseline catalog and once after the break, so the
 * warehouse drifts precisely when the catalog does.
 */
export function buildWarehouse(snapshots: EntitySnapshot[]): { db: DatabaseSync; tables: WarehouseTable[] } {
  const db = new DatabaseSync(":memory:");
  const tables: WarehouseTable[] = [];
  const seen = new Set<string>();

  for (const snap of snapshots) {
    if (!snap.exists || snap.fields.length === 0) continue;
    const table = shortName(snap.urn);
    if (seen.has(table)) throw new Error(`Two snapshots share the table name ${table}`);
    seen.add(table);

    db.exec(`CREATE TABLE ${quoteIdent(table)} (${snap.fields.map(quoteIdent).join(", ")})`);
    const insert = db.prepare(
      `INSERT INTO ${quoteIdent(table)} VALUES (${snap.fields.map(() => "?").join(", ")})`
    );
    const rows = rowCountFor(table);
    for (let r = 0; r < rows; r++) {
      insert.run(...snap.fields.map((name, c) => valueFor(table, r, c, name)));
    }
    tables.push({ urn: snap.urn, table, columns: [...snap.fields], rows });
  }

  return { db, tables };
}

/* ── Running the consumer queries ─────────────────────────────────────── */

export interface QueryRun {
  file: string;
  /** sha256 of the SQL text, so the receipt pins which version of the file ran. */
  sqlHash: string;
  ok: boolean;
  error?: string;
  columns: string[];
  rowCount: number;
  /** sha256 over columns + every row, in order. Equal hashes, equal output. */
  resultHash?: string;
}

export interface WorkspaceRun {
  workspace: string;
  tables: WarehouseTable[];
  queries: QueryRun[];
  allGreen: boolean;
}

export function consumerFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export interface ColumnRename {
  table: string;
  from: string;
  to: string;
}

/**
 * Run every .sql file in the workspace against a warehouse built from the
 * given snapshots. Failures are results, not exceptions: the red phase of the
 * drill is the queries failing, and the receipt wants the error verbatim.
 *
 * `renames` is the breaking change, applied the way it happens to a real
 * warehouse: `ALTER TABLE … RENAME COLUMN`, after the deterministic build from
 * the baseline schema. The name moves and the data stays put, which is the
 * physical fact the drill's hash-equality claim rests on. Building from a
 * post-rename catalog snapshot instead would regenerate the rows, and on a
 * catalog that returns fields sorted by name the renamed column can land at a
 * different position and silently shuffle data — the showcase datapack did
 * exactly that.
 */
export function runWorkspace(
  workspaceDir: string,
  snapshots: EntitySnapshot[],
  renames: ColumnRename[] = []
): WorkspaceRun {
  const { db, tables } = buildWarehouse(snapshots);
  for (const rename of renames) {
    db.exec(
      `ALTER TABLE ${quoteIdent(rename.table)} RENAME COLUMN ${quoteIdent(rename.from)} TO ${quoteIdent(rename.to)}`
    );
    const table = tables.find((t) => t.table === rename.table);
    if (table) table.columns = table.columns.map((c) => (c === rename.from ? rename.to : c));
  }
  const queries: QueryRun[] = [];

  try {
    for (const file of consumerFiles(workspaceDir)) {
      const sql = readFileSync(path.join(workspaceDir, file), "utf8");
      const sqlHash = sha256(sql);
      try {
        const rows = db.prepare(sql).all() as Record<string, unknown>[];
        const columns = rows.length ? Object.keys(rows[0]) : [];
        const canonical = JSON.stringify({ columns, rows: rows.map((r) => columns.map((c) => r[c])) });
        queries.push({ file, sqlHash, ok: true, columns, rowCount: rows.length, resultHash: sha256(canonical) });
      } catch (err) {
        queries.push({
          file,
          sqlHash,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          columns: [],
          rowCount: 0,
        });
      }
    }
  } finally {
    db.close();
  }

  return { workspace: workspaceDir, tables, queries, allGreen: queries.length > 0 && queries.every((q) => q.ok) };
}

/* ── The workspace copy, and applying an approved correction to it ────── */

/** Copy the committed consumer SQL into a scratch workspace the drill may edit. */
export function prepareWorkspace(sourceDir: string, workDir: string): string[] {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const files = consumerFiles(sourceDir);
  for (const file of files) copyFileSync(path.join(sourceDir, file), path.join(workDir, file));
  return files;
}

export interface FileRepair {
  file: string;
  hashBefore: string;
  hashAfter: string;
  replacements: number;
  changed: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Apply column-rename edits from an approved proposal to every SQL file in the
 * workspace. Whole-word substitution only, and only the edits the caller has
 * decided to trust — the confidence filtering is an approval decision, so it
 * stays with the approver, not here.
 */
export function applyEditsToWorkspace(workDir: string, edits: ProposedEdit[]): FileRepair[] {
  const renames = edits.filter((e) => e.kind === "column-rename");
  const repairs: FileRepair[] = [];

  for (const file of consumerFiles(workDir)) {
    const filePath = path.join(workDir, file);
    const before = readFileSync(filePath, "utf8");
    let after = before;
    let replacements = 0;
    for (const edit of renames) {
      after = after.replace(new RegExp(`\\b${escapeRegExp(edit.from)}\\b`, "g"), () => {
        replacements++;
        return edit.to;
      });
    }
    if (after !== before) writeFileSync(filePath, after);
    repairs.push({
      file,
      hashBefore: sha256(before),
      hashAfter: sha256(after),
      replacements,
      changed: after !== before,
    });
  }

  return repairs;
}
