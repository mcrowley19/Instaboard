/**
 * Which columns a SQL statement actually reads, from its syntax tree.
 *
 * The word-boundary matcher this replaces treated a column name anywhere in
 * the text as a dependency — including inside a string literal or a comment,
 * which is a false positive no amount of word-boundary care can fix. Parsing
 * answers the question the detector is really asking. `node-sql-parser` is
 * pure JavaScript, so it rides in the deploy path without a native build or a
 * Python runtime.
 *
 * The parser does not get everything. A statement it cannot read (templated
 * dbt SQL, an exotic dialect) returns `null`, and a `SELECT *` returns
 * `complete: false`, because the statement reads columns the tree does not
 * name. Callers fall back to the word match in both cases and say so — a
 * wrong "not referenced" from a half-read query would silently drop real
 * findings, which is worse than the false positives parsing exists to remove.
 */

import pkg from "node-sql-parser";

const { Parser } = pkg;

export interface SqlColumnRefs {
  /** Lowercased column identifiers the statement references, deduplicated. */
  columns: string[];
  /** False when the statement selects `*`, so absence from `columns` proves nothing. */
  complete: boolean;
}

/** Tried in order; the first dialect that parses wins. */
const DIALECTS = ["snowflake", "postgresql", "mysql"] as const;

export function sqlColumnRefs(sql: string): SqlColumnRefs | null {
  for (const database of DIALECTS) {
    try {
      // Entries come back as `clause::table::column`; `(.*)` marks a star.
      const entries = new Parser().columnList(sql, { database });
      const columns = new Set<string>();
      let complete = true;
      for (const entry of entries) {
        const column = entry.split("::")[2];
        if (!column) continue;
        if (column === "(.*)") {
          complete = false;
          continue;
        }
        columns.add(column.toLowerCase());
      }
      return { columns: [...columns].sort(), complete };
    } catch {
      // Try the next dialect; null after the last one.
    }
  }
  return null;
}
