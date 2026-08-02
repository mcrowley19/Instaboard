/**
 * Drafting a runbook from what the catalog already knows.
 *
 * The capture loop has a cold start: it needs a departing engineer to sit down
 * and record. That is the highest-value version of this tool and also the one
 * that requires the scarcest thing in the building — an hour of the person who
 * is already halfway out of the door.
 *
 * But a catalog that has been running for a year is not empty. It holds the
 * queries people actually ran, the lineage of what feeds what, who owns which
 * table, which columns are certified, and what has been failing. That is enough
 * to draft a *first pass* at "how you work with this table" without anybody
 * recording anything. The draft is then a thing to correct rather than a blank
 * page to fill, which is a much smaller ask of the person leaving.
 *
 * ## What a draft can and cannot contain
 *
 * Everything here is derived from catalog evidence, and every step records which
 * evidence produced it. The one thing a draft can never contain is the actual
 * `why` — the reason step 2 exists, in the departing engineer's head. That is the
 * whole point of capture and it is not in any catalog.
 *
 * So drafted steps carry `whySource: "inferred"`, and their `why` is written as
 * what the evidence shows rather than as remembered intent: "the catalog records
 * 47 queries against this table in the last 30 days and it carries the Certified
 * term" — never "Priya always starts here because…". A drafted runbook that
 * impersonates a colleague's judgement would be worse than no runbook, because
 * the entire value of the artifact is that somebody vouched for it.
 *
 * The validation loop treats drafts exactly like recorded runbooks: claims are
 * pinned to catalog versions at draft time, and drift is caught the same way.
 */

import { callDataHubTool } from "./mcp";
import { discountSelfWrittenState, snapshotHandoff } from "./decay";
import { newHandoffId } from "./handoff-store";
import type { EntitySnapshot, Handoff, HandoffStep } from "./types";

/* ── Reading the catalog ──────────────────────────────────────────────── */

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end <= start) {
      const s = content.indexOf("[");
      const e = content.lastIndexOf("]");
      if (s === -1 || e <= s) return null;
      try {
        return JSON.parse(content.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function collect(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const item of node) collect(item, key, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

function strings(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...strings(v));
    else if (v && typeof v === "object") {
      const named = (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).urn;
      if (typeof named === "string") out.push(named);
    }
  }
  return [...new Set(out)];
}

/** One recorded query, as evidence of what people do with a table. */
export interface RecordedQuery {
  sql: string;
  name?: string;
  /** Rough popularity signal where the catalog carries one. */
  runs?: number;
}

export interface DatasetEvidence {
  urn: string;
  name: string;
  description?: string;
  fields: string[];
  owners: string[];
  ownerUrns: string[];
  tags: string[];
  terms: string[];
  domain?: string;
  deprecated: boolean;
  deprecationNote?: string;
  failingAssertions: number;
  openIncidents: number;
  queries: RecordedQuery[];
  upstream: string[];
  downstream: string[];
}

/** Owner display names, filtered to the ones worth showing a person. */
function ownerNames(parsed: unknown): { names: string[]; urns: string[] } {
  const names: string[] = [];
  const urns: string[] = [];
  const root = parsed as Record<string, unknown> | unknown[];
  const wrapped = !Array.isArray(root) && Array.isArray((root as Record<string, unknown>)?.entities);
  const entities = wrapped
    ? ((root as Record<string, unknown>).entities as unknown[])
    : Array.isArray(root)
      ? root
      : [root];

  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    const e = entity as Record<string, unknown>;
    const ownership = e.ownership as Record<string, unknown> | undefined;
    const list = (ownership?.owners ?? e.owners) as unknown;
    for (const entry of Array.isArray(list) ? list : list ? [list] : []) {
      const raw: unknown = entry && typeof entry === "object" ? (entry as Record<string, unknown>).owner ?? entry : entry;
      if (typeof raw === "string") {
        if (raw.startsWith("urn:li:corp")) urns.push(raw);
        else names.push(raw.split("(")[0].trim());
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const owner = raw as Record<string, unknown>;
      const props = (owner.properties ?? owner.info ?? {}) as Record<string, unknown>;
      const display = [props.displayName, owner.username, owner.name].find(
        (c): c is string => typeof c === "string" && c.length > 0
      );
      if (display) names.push(display.split("(")[0].trim());
      if (typeof owner.urn === "string" && owner.urn.startsWith("urn:li:corp")) urns.push(owner.urn);
    }
  }
  return { names: [...new Set(names)], urns: [...new Set(urns)] };
}

/** Pull every piece of evidence the catalog holds about one dataset. */
export async function gatherEvidence(urn: string): Promise<DatasetEvidence | null> {
  const entityResult = await callDataHubTool("get_entities", { urns: [urn] });
  if (entityResult.isError) return null;
  const parsed = parseJson(entityResult.content);
  if (!parsed) return null;

  const notFound =
    collect(parsed, "error").some((e) => typeof e === "string" && /not found|no such/i.test(e)) ||
    /not found in catalog/i.test(entityResult.content);
  if (notFound) return null;

  const owners = ownerNames(parsed);
  const names = strings(collect(parsed, "name"));
  const deprecation = collect(parsed, "deprecation").find((d) => d && typeof d === "object") as
    | Record<string, unknown>
    | undefined;

  const evidence: DatasetEvidence = {
    urn,
    name: names[0] ?? urn,
    description: strings(collect(parsed, "description"))[0],
    fields: strings(collect(parsed, "fieldPath")),
    owners: owners.names,
    ownerUrns: owners.urns,
    tags: strings(collect(parsed, "tags")).filter((t) => !t.startsWith("urn:")),
    terms: strings(collect(parsed, "glossaryTerms")).filter((t) => !t.startsWith("urn:")),
    domain: strings(collect(parsed, "domain")).find((d) => !d.startsWith("urn:")),
    deprecated: Boolean(deprecation?.deprecated),
    ...(typeof deprecation?.note === "string" && deprecation.note ? { deprecationNote: deprecation.note } : {}),
    failingAssertions: 0,
    openIncidents: 0,
    queries: [],
    upstream: [],
    downstream: [],
  };

  // Health arrives inline on the entity; a FAIL names the count in its message.
  for (const entry of collect(parsed, "health").flatMap((h) => (Array.isArray(h) ? h : [h]))) {
    if (!entry || typeof entry !== "object") continue;
    const h = entry as Record<string, unknown>;
    if (String(h.status ?? "").toUpperCase() !== "FAIL") continue;
    const count = Number(String(h.message ?? "").match(/(\d+)/)?.[1] ?? 1);
    if (String(h.type ?? "").toUpperCase() === "ASSERTIONS") evidence.failingAssertions = count;
    if (String(h.type ?? "").toUpperCase() === "INCIDENTS") evidence.openIncidents = count;
  }

  /*
   * Don't report our own stale-runbook incidents and runbook-validity assertions
   * as the dataset's health. A draft that says "1 open incident" about an
   * incident this tool raised is telling the reader something untrue about their
   * data. Shares the decay engine's discounting so the two never disagree.
   *
   * It works by mutating a snapshot in place, so hand it one and read the
   * counters back out.
   */
  const health: EntitySnapshot = {
    urn,
    exists: true,
    fields: [],
    owners: [],
    deprecated: evidence.deprecated,
    openIncidents: evidence.openIncidents,
    failingAssertions: evidence.failingAssertions,
    capturedAt: new Date().toISOString(),
  };
  await discountSelfWrittenState(health);
  evidence.openIncidents = health.openIncidents;
  evidence.failingAssertions = health.failingAssertions;

  /* The strongest evidence there is: SQL people actually ran. */
  const queries = await callDataHubTool("get_dataset_queries", { urn });
  if (!queries.isError) {
    const q = parseJson(queries.content);
    const statements = collect(q, "statement").concat(collect(q, "sql"), collect(q, "query"));
    const names = collect(q, "name");
    const seen = new Set<string>();
    statements.forEach((s, i) => {
      const sql = typeof s === "string" ? s : typeof s === "object" && s ? String((s as Record<string, unknown>).value ?? "") : "";
      const trimmed = sql.trim();
      if (!trimmed || trimmed.length < 20 || seen.has(trimmed)) return;
      seen.add(trimmed);
      const name = names[i];
      evidence.queries.push({ sql: trimmed, ...(typeof name === "string" ? { name } : {}) });
    });
  }

  /*
   * Lineage: what feeds this, and who would notice if it broke.
   *
   * The live server takes `{upstream: boolean, max_hops}`; the demo fixture takes
   * `{direction: "upstream"|"downstream", max_hops}`. Try the live shape and fall
   * back, rather than branching on demo mode — the same code then works against a
   * server whose schema moves again.
   */
  for (const upstream of [true, false]) {
    let lineage = await callDataHubTool("get_lineage", { urn, upstream, max_hops: 1 });
    if (lineage.isError) {
      lineage = await callDataHubTool("get_lineage", {
        urn,
        direction: upstream ? "upstream" : "downstream",
        max_hops: 1,
      });
    }
    if (lineage.isError) continue;
    const parsedLineage = parseJson(lineage.content);
    const urns = strings(collect(parsedLineage, "urn")).filter((u) => u.startsWith("urn:li:dataset:") && u !== urn);
    if (upstream) evidence.upstream = urns.slice(0, 8);
    else evidence.downstream = urns.slice(0, 8);
  }

  return evidence;
}

/* ── Choosing what to draft about ─────────────────────────────────────── */

/**
 * Rank candidate datasets the way the catalog itself argues for them: a table
 * with owners, glossary terms, certification tags and downstream dependents is
 * one people rely on. A leaf copy with no owner is somebody's abandoned clone.
 * Never rank by how authoritative the name sounds.
 */
export function evidenceScore(e: DatasetEvidence): number {
  return (
    (e.queries.length ? 3 : 0) +
    Math.min(e.queries.length, 5) +
    (e.owners.length ? 2 : 0) +
    (e.terms.length ? 2 : 0) +
    (e.tags.some((t) => /certified|authoritative|tier ?1|most queried/i.test(t)) ? 3 : 0) +
    Math.min(e.downstream.length, 4) +
    (e.description ? 1 : 0) -
    (e.deprecated ? 6 : 0)
  );
}

/**
 * Find datasets worth drafting a runbook for.
 *
 * Search returns column-level hits as well as dataset hits — a query for
 * "revenue" mostly matches `schemaField` URNs, each of which nests the dataset
 * URN it belongs to. Those are real candidates: a table with a column called
 * `TOTAL_REVENUE` is a table somebody working on revenue wants a runbook for.
 * So unwrap them rather than dropping them, which is what a naive
 * `startsWith("urn:li:dataset:")` filter does.
 */
export function datasetUrnsIn(urns: string[]): string[] {
  const out: string[] = [];
  for (const urn of urns) {
    if (urn.startsWith("urn:li:dataset:")) {
      out.push(urn);
      continue;
    }
    // urn:li:schemaField:(urn:li:dataset:(platform,name,env),columnName).
    // A dataset URN has exactly one parenthesised group — the platform part
    // carries no parens of its own — so a non-greedy single group is enough.
    const nested = urn.match(/urn:li:dataset:\([^()]*\)/)?.[0];
    if (nested) out.push(nested);
  }
  return [...new Set(out)];
}

export async function findCandidates(query: string, limit = 5): Promise<string[]> {
  const want = Math.max(limit * 6, 25);
  const result = await callDataHubTool("search", { query, num_results: want });
  if (result.isError) return [];
  const parsed = parseJson(result.content);
  return datasetUrnsIn(strings(collect(parsed, "urn"))).slice(0, want);
}

/* ── Turning evidence into steps ──────────────────────────────────────── */

const shortName = (urn: string) => urn.match(/,([^,]+),[^,]*\)$/)?.[1]?.split(".").pop() ?? urn;
const platformOf = (urn: string) => urn.match(/urn:li:dataPlatform:([^,)]+)/)?.[1] ?? "";

/**
 * Name an entity in a way that survives a catalog full of copies.
 *
 * `order_details` exists six times across Snowflake, dbt, Looker and S3 in
 * DataHub's own datapack, so a step that says "confirm order_details loaded"
 * beside a dataset also called `order_details` is worse than useless. Qualify by
 * platform whenever the short names collide.
 */
function describeUrn(urn: string, anchorName: string): string {
  const name = shortName(urn);
  // "Order Details" and "order_details" are the same name to a reader, so
  // compare with punctuation and case stripped or the qualifier never fires.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm(name) !== norm(anchorName)) return name;
  const platform = platformOf(urn);
  return platform ? `${name} (${platform})` : name;
}

function healthStep(e: DatasetEvidence): HandoffStep {
  const problems: string[] = [];
  if (e.failingAssertions) problems.push(`${e.failingAssertions} failing assertion${e.failingAssertions === 1 ? "" : "s"}`);
  if (e.openIncidents) problems.push(`${e.openIncidents} open incident${e.openIncidents === 1 ? "" : "s"}`);
  if (e.deprecated) problems.push("a deprecation notice");

  return {
    title: `Check ${e.name} is healthy before you trust it`,
    instruction:
      `Open ${e.name} in DataHub and read the health badge and the deprecation field before you run anything ` +
      `against it.` +
      (problems.length
        ? ` Right now it has ${problems.join(" and ")}${
            e.deprecationNote ? `, and the deprecation note reads: "${e.deprecationNote}"` : ""
          }.`
        : " It is currently clean on both."),
    why:
      problems.length
        ? `The catalog is reporting ${problems.join(" and ")} on this dataset today, so a number pulled from it ` +
          `now may be wrong in a way that is invisible downstream.`
        : `Every number produced by the steps below comes from this table. Confirming it loaded is cheaper than ` +
          `retracting a figure after somebody has quoted it.`,
    urn: e.urn,
    whySource: "inferred",
    ...(e.owners.length ? { tips: `Owners on record: ${e.owners.join(", ")}.` } : {}),
  };
}

function upstreamStep(e: DatasetEvidence, upstreamUrn: string): HandoffStep {
  const name = describeUrn(upstreamUrn, e.name);
  return {
    title: `Confirm ${name} loaded first`,
    instruction: `Check ${name}, which feeds ${e.name}, has today's data before you read anything downstream of it.`,
    why:
      `DataHub records ${name} as a direct upstream of ${e.name}. A partial load there produces a ` +
      `plausible-looking but short number here, which is the failure mode that gets noticed last.`,
    urn: upstreamUrn,
    whySource: "inferred",
  };
}

function queryStep(e: DatasetEvidence, query: RecordedQuery, index: number): HandoffStep {
  return {
    title: query.name?.trim() || `Run the recorded query against ${e.name}`,
    instruction:
      `Run this against ${e.name}. It is a query the catalog has on record for this table, not a reconstruction.` +
      (index === 0 ? "" : " Check it against the previous step's output before reporting either."),
    why:
      `This is what people actually run here — the catalog has it recorded against this dataset. ` +
      `Reproducing an existing query is how you get a number that matches the one everyone else quotes.`,
    urn: e.urn,
    sql: query.sql,
    whySource: "inferred",
  };
}

function downstreamStep(e: DatasetEvidence): HandoffStep {
  const names = e.downstream.map((u) => describeUrn(u, e.name));
  return {
    title: "Know who breaks if this changes",
    instruction:
      `Before changing anything about ${e.name}, check its downstream lineage in DataHub. Today that is ` +
      `${names.slice(0, 5).join(", ")}${names.length > 5 ? `, and ${names.length - 5} more` : ""}.`,
    why:
      `DataHub records ${e.downstream.length} dataset${e.downstream.length === 1 ? "" : "s"} depending on this one. ` +
      `The people to warn are the owners of those, not the owners of this.`,
    urn: e.urn,
    whySource: "inferred",
  };
}

export interface DraftOptions {
  /** Who the draft is attributed to. Never a real person by default. */
  author?: string;
  /** Cap the number of recorded queries turned into steps. */
  maxQuerySteps?: number;
  /** Include a step per direct upstream, up to this many. */
  maxUpstreamSteps?: number;
}

export interface DraftResult {
  handoff: Handoff;
  evidence: DatasetEvidence;
  /** Why this draft is worth what it is worth — shown to whoever reviews it. */
  basis: string[];
}

/**
 * Draft a runbook for one dataset from catalog evidence alone.
 *
 * Returns null when the catalog holds too little to say anything honest. A draft
 * built from a name and nothing else would be a confident-sounding guess, which
 * is the exact artifact this project exists to argue against.
 */
export async function draftRunbook(urn: string, options: DraftOptions = {}): Promise<DraftResult | null> {
  const { author = "instaboard (drafted from catalog evidence)", maxQuerySteps = 3, maxUpstreamSteps = 2 } = options;

  const evidence = await gatherEvidence(urn);
  if (!evidence) return null;

  // The bar for drafting at all: the catalog must hold either real queries or
  // real structure. Owners and a name are not a runbook.
  const hasSubstance = evidence.queries.length > 0 || evidence.upstream.length > 0 || evidence.downstream.length > 0;
  if (!hasSubstance) return null;

  const steps: HandoffStep[] = [healthStep(evidence)];

  for (const upstream of evidence.upstream.slice(0, maxUpstreamSteps)) {
    steps.push(upstreamStep(evidence, upstream));
  }

  evidence.queries.slice(0, maxQuerySteps).forEach((query, i) => steps.push(queryStep(evidence, query, i)));

  if (evidence.downstream.length) steps.push(downstreamStep(evidence));

  const basis = [
    `${evidence.queries.length} recorded quer${evidence.queries.length === 1 ? "y" : "ies"} on the dataset`,
    `${evidence.upstream.length} direct upstream${evidence.upstream.length === 1 ? "" : "s"}`,
    `${evidence.downstream.length} direct downstream${evidence.downstream.length === 1 ? "" : "s"}`,
    `${evidence.owners.length} owner${evidence.owners.length === 1 ? "" : "s"} on record`,
    evidence.terms.length ? `glossary terms: ${evidence.terms.join(", ")}` : "no glossary terms attached",
    evidence.deprecated ? "the dataset is deprecated" : "not deprecated",
  ];

  const title = `Working with ${evidence.name}`;
  const handoff: Handoff = {
    id: newHandoffId(`draft ${evidence.name}`),
    title,
    author,
    role: "drafted, not recorded",
    summary:
      `A first-pass runbook for ${evidence.name}, drafted from what the catalog already knows rather than from ` +
      `anyone's recording: ${basis.slice(0, 3).join(", ")}. Every step below is derived from catalog evidence and ` +
      `none of it carries the reason the original author would have given. Correct it, then it is a real runbook.`,
    createdAt: new Date().toISOString(),
    steps,
    recorded: [],
    source: "drafted",
    draftBasis: basis,
  };

  // Same baseline the recorded path captures, so a draft decays like anything else.
  handoff.snapshots = await snapshotHandoff(handoff.steps);

  return { handoff, evidence, basis };
}

/**
 * Draft runbooks for the best candidates matching a search, best first.
 *
 * This is the "day one in any DataHub" entry point: point it at a domain or a
 * keyword and it comes back with drafts for the datasets the catalog itself
 * argues are the ones that matter.
 */
export async function draftForQuery(query: string, count = 3, options: DraftOptions = {}): Promise<DraftResult[]> {
  const candidates = await findCandidates(query, count);
  const scored: { draft: DraftResult; score: number }[] = [];

  /*
   * Examine a fixed budget of candidates and *then* rank, rather than stopping
   * as soon as enough drafts exist. Search returns column-level hits first, so
   * the early results are often BI measure tables while the canonical fact table
   * is further down — an early break reliably picks the worse one.
   */
  const budget = Math.max(count * 4, 8);
  for (const urn of candidates.slice(0, budget)) {
    const draft = await draftRunbook(urn, options);
    if (draft) scored.push({ draft, score: evidenceScore(draft.evidence) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map(({ draft }) => draft);
}
