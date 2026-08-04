/**
 * The two catalogs the proof drills run against, and the breaking changes they
 * make. Shared by `npm run prove` (scripts/prove-loop.ts), which breaks all
 * three kinds and restores them, and `npm run prove:repair`
 * (scripts/prove-repair.ts), which breaks only the column rename and repairs
 * the consumers that read it.
 *
 * Everything here goes through DataHub's own write APIs. The decay engine is
 * never told what changed — it re-reads the catalog and works it out.
 */

import { datahubGraphQL } from "./datahub-graphql";
import { snapshotEntity } from "./decay";
import { readAspect, writeAspect } from "./gms-aspects";
import { callDataHubTool } from "./mcp";
import type { Handoff } from "./types";

const UI = () => process.env.DATAHUB_UI_URL || "http://localhost:9002";
export const entityUrl = (urn: string) => `${UI()}/dataset/${encodeURIComponent(urn)}`;

export const shortName = (urn: string) => urn.match(/,([^,]+),[^,]*\)$/)?.[1]?.split(".").pop() ?? urn;

const sf = (table: string) =>
  `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.${table},PROD)`;
const showcase = (platform: string, table: string) =>
  `urn:li:dataset:(urn:li:dataPlatform:${platform},b2fd91.order_entry_db.${table},PROD)`;

/**
 * Which catalog to prove against.
 *
 * Northbeam is seeded by this repo, which is a fair objection: we chose the
 * catalog, the runbook and the breaking changes. `--catalog=showcase` re-points
 * the whole proof at `showcase-ecommerce`, the datapack DataHub publishes, so a
 * judge can verify it on the same catalog everyone else is using and compare
 * like for like.
 *
 * The profile is only *what* to break. Every phase, assertion and receipt in
 * the drills is shared, so runs are the same proof on different data.
 */
export interface CatalogProfile {
  name: string;
  description: string;
  /** Bring the catalog into existence. */
  ingest: () => { command: string; args: string[]; note: string } | null;
  /** Read this back to confirm the ingest worked. */
  probeUrn: string;
  runbook: () => Handoff;
  /** A column the runbook's SQL selects, renamed out from under it. */
  rename: { urn: string; from: string; to: string };
  /** A table a step routes you to, deprecated mid-runbook. */
  deprecate: { urn: string; note: string; replacement: string };
  /** An owner a step tells you to page, moved off the dataset. */
  ownerRemoval: { urn: string; ownerUrn: string; display: string };
  /** Consumer SQL under examples/consumer/<dir> that reads the same tables. */
  consumerDir: string;
}

export const NORTHBEAM: CatalogProfile = {
  name: "northbeam",
  description: "the sample catalog this repo seeds with scripts/seed_datahub.py",
  ingest: () => ({
    command: "uv",
    args: ["run", "--with", "acryl-datahub", "scripts/seed_datahub.py"],
    note: "ingesting the sample catalog (14 datasets, 4 people, glossary, assertions)…",
  }),
  probeUrn: sf("fct_revenue"),
  rename: { urn: sf("fct_revenue"), from: "net_amount_usd", to: "net_revenue_usd" },
  deprecate: {
    urn: sf("mrr_monthly"),
    note: "Rebuilt with plan-level grain at the FY close. Use analytics.marts.mrr_monthly_v2 instead.",
    replacement: "analytics.marts.mrr_monthly_v2",
  },
  ownerRemoval: { urn: sf("fct_revenue"), ownerUrn: "urn:li:corpuser:mike.rodriguez", display: "Mike Rodriguez" },
  consumerDir: "northbeam",
  runbook: () => ({
    id: "prove-monthly-revenue-close",
    title: "Monthly revenue close",
    author: "Priya Patel",
    role: "Payments Data Lead",
    summary:
      "How I close the monthly revenue numbers: check payment health hasn't blown up, pull net revenue off the " +
      "revenue fact, then reconcile against the MRR rollup before finance quotes anything.",
    createdAt: new Date().toISOString(),
    recorded: [],
    steps: [
      {
        title: "Check payment health before trusting anything downstream",
        instruction:
          "Open payment_health_daily and look at success_rate for the last 7 days. Anything under 0.9 on a " +
          "provider means the revenue numbers are understated and the close waits.",
        why: "Failed payments look identical to lost revenue in the fact table. Catching it here saves a restatement.",
        urn: sf("payment_health_daily"),
        url: entityUrl(sf("payment_health_daily")),
        sql: "SELECT date, provider, success_rate FROM analytics.marts.payment_health_daily ORDER BY date DESC LIMIT 30;",
      },
      {
        title: "Pull net revenue for the month",
        instruction:
          "Sum net_amount_usd from fct_revenue for the close month. Use net_amount_usd, never gross_amount_usd — " +
          "gross is before refunds and will not tie to the bank.",
        why: "Finance reconciles to settled cash, so refunds have to be out before the number leaves this step.",
        urn: sf("fct_revenue"),
        url: entityUrl(sf("fct_revenue")),
        sql:
          "SELECT DATE_TRUNC('month', revenue_date) AS month, SUM(net_amount_usd) AS net_revenue\n" +
          "FROM analytics.marts.fct_revenue\nGROUP BY 1 ORDER BY 1 DESC;",
        tips: "If the total looks short, ping Mike Rodriguez — he owns the dbt job that loads this table.",
      },
      {
        title: "Reconcile against the MRR rollup",
        instruction:
          "Compare the recurring slice of the number above against mrr_usd in mrr_monthly for the same month. " +
          "They should agree to within rounding; if they don't, the rollup ran before the fact finished loading.",
        why: "The board deck quotes MRR and finance quotes net revenue. If those two disagree in public it is a bad month.",
        urn: sf("mrr_monthly"),
        url: entityUrl(sf("mrr_monthly")),
        sql: "SELECT month, SUM(mrr_usd) AS mrr FROM analytics.marts.mrr_monthly GROUP BY 1 ORDER BY 1 DESC LIMIT 12;",
      },
    ],
  }),
};

/**
 * The same proof on DataHub's own published datapack — 1,065 entities nobody
 * here authored. The runbook mirrors the Northbeam one step for step so the two
 * runs are directly comparable.
 */
export const SHOWCASE: CatalogProfile = {
  name: "showcase",
  description: "showcase-ecommerce, the demo datapack DataHub publishes (1,065 entities)",
  ingest: () => ({
    command: "uv",
    args: ["run", "--with", "acryl-datahub", "datahub", "datapack", "load", "showcase-ecommerce"],
    note: "loading DataHub's showcase-ecommerce datapack…",
  }),
  probeUrn: showcase("snowflake", "analytics.order_details"),
  rename: { urn: showcase("snowflake", "analytics.order_details"), from: "cost_of_delivery", to: "delivery_cost_usd" },
  deprecate: {
    urn: showcase("snowflake", "analytics.order_history"),
    note: "Retired at the FY close. Use order_entry_db.analytics.order_details with a point-in-time filter instead.",
    replacement: "order_entry_db.analytics.order_details",
  },
  ownerRemoval: {
    urn: showcase("dbt", "order_entry.products"),
    ownerUrn: "urn:li:corpuser:b2fd91.patrick1@example.com",
    display: "Priya Sharma",
  },
  consumerDir: "showcase",
  runbook: () => ({
    id: "prove-weekly-order-revenue",
    title: "Weekly order revenue pack",
    author: "David Kim",
    role: "Data Scientist",
    summary:
      "How I build the Monday commercial pack: check the order fact is healthy, pull revenue and delivery cost by " +
      "customer class off ORDER_DETAILS, then cross-check the point-in-time history before anyone quotes a number.",
    createdAt: new Date().toISOString(),
    recorded: [],
    steps: [
      {
        title: "Confirm ORDER_DETAILS is healthy and current",
        instruction:
          "Open ORDER_DETAILS in the analytics schema and check the health badge for failing assertions or open " +
          "incidents before you trust today's numbers.",
        why: "This is the certified wide order table. If it is stale, every number in the pack is stale.",
        urn: showcase("snowflake", "analytics.order_details"),
        url: entityUrl(showcase("snowflake", "analytics.order_details")),
      },
      {
        title: "Pull revenue and delivery cost by customer class",
        instruction:
          "Run the aggregation below. order_total is the glossary-sanctioned measure; cost_of_delivery is what the " +
          "commercial team wants netted off it.",
        why: "The commercial review asks for revenue net of delivery every week, and the wide table already carries both.",
        urn: showcase("snowflake", "analytics.order_details"),
        url: entityUrl(showcase("snowflake", "analytics.order_details")),
        sql:
          "SELECT customer_class,\n       SUM(order_total)      AS total_revenue,\n" +
          "       SUM(cost_of_delivery) AS delivery_cost\n" +
          "FROM order_entry_db.analytics.order_details\nGROUP BY customer_class\nORDER BY total_revenue DESC;",
        tips: "cost_of_delivery is on the wide table already, so do not join back to orders for it.",
      },
      {
        title: "Cross-check against the point-in-time history",
        instruction:
          "Compare the totals above against ORDER_HISTORY at the latest as_of_date. They should agree; if they " +
          "don't, the snapshot ran mid-load.",
        why: "The pack quotes a weekly movement, and a mid-load snapshot makes the movement look like a real swing.",
        urn: showcase("snowflake", "analytics.order_history"),
        url: entityUrl(showcase("snowflake", "analytics.order_history")),
        sql:
          "SELECT order_status, COUNT(*) AS orders, SUM(order_total) AS value\n" +
          "FROM order_entry_db.analytics.order_history\n" +
          "WHERE as_of_date = (SELECT MAX(as_of_date) FROM order_entry_db.analytics.order_history)\n" +
          "GROUP BY order_status;",
      },
      {
        title: "Get sign-off on the product margins",
        instruction: "Before the pack goes out, have the product margins signed off against the dbt products model.",
        why: "Margins are the number the commercial team argues about, and the steward is the one who settles it.",
        urn: showcase("dbt", "order_entry.products"),
        url: entityUrl(showcase("dbt", "order_entry.products")),
        tips: "Priya Sharma is the Data Steward on the products model — she signs these off.",
      },
    ],
  }),
};

export const CATALOGS: Record<string, CatalogProfile> = { northbeam: NORTHBEAM, showcase: SHOWCASE };

/* ── The breaking changes ─────────────────────────────────────────────── */

const UPDATE_DEPRECATION = `
  mutation updateDeprecation($input: UpdateDeprecationInput!) { updateDeprecation(input: $input) }
`;

export interface Change {
  kind: string;
  urn: string;
  detail: string;
}

export type BreakKind = "rename" | "deprecate" | "owner";

type Say = (message: string) => void;
const quiet: Say = () => {};

/**
 * Rename the profile's target column in schemaMetadata, in either direction.
 * Returns false when the source column isn't there to rename.
 */
export async function renameColumn(profile: CatalogProfile, direction: "break" | "restore"): Promise<boolean> {
  const { urn } = profile.rename;
  const from = direction === "break" ? profile.rename.from : profile.rename.to;
  const to = direction === "break" ? profile.rename.to : profile.rename.from;
  const schema = await readAspect(urn, "schemaMetadata");
  const fields = (schema?.fields ?? []) as Record<string, unknown>[];
  if (!schema || !fields.some((f) => f.fieldPath === from)) return false;
  await writeAspect(urn, "schemaMetadata", {
    ...schema,
    fields: fields.map((f) => (f.fieldPath === from ? { ...f, fieldPath: to } : f)),
  });
  return true;
}

/**
 * Change the catalog for real, in the kinds asked for: a column renamed under a
 * query, a table retired mid-workflow, an owner moved off a dataset a runbook
 * tells you to page. Those are the three kinds that actually break runbooks.
 */
export async function breakCatalog(
  profile: CatalogProfile,
  kinds: BreakKind[] = ["rename", "deprecate", "owner"],
  say: Say = quiet
): Promise<Change[]> {
  const changes: Change[] = [];

  if (kinds.includes("rename")) {
    const { urn, from, to } = profile.rename;
    if (await renameColumn(profile, "break")) {
      changes.push({
        kind: "column-renamed",
        urn,
        detail: `Renamed ${shortName(urn)}.${from} to ${to} — a column the runbook's SQL selects.`,
      });
      say(`    ✓ renamed ${from} → ${to} on ${shortName(urn)}`);
    }
  }

  if (kinds.includes("deprecate")) {
    const dep = await datahubGraphQL(UPDATE_DEPRECATION, {
      input: { urn: profile.deprecate.urn, deprecated: true, note: profile.deprecate.note },
    });
    if (!dep.errors?.length) {
      changes.push({
        kind: "deprecated",
        urn: profile.deprecate.urn,
        detail: `Deprecated ${shortName(profile.deprecate.urn)}, which the runbook routes you to.`,
      });
      say(`    ✓ deprecated ${shortName(profile.deprecate.urn)}`);
    }
  }

  if (kinds.includes("owner")) {
    const removed = await callDataHubTool("remove_owners", {
      owner_urns: [profile.ownerRemoval.ownerUrn],
      entity_urns: [profile.ownerRemoval.urn],
    });
    if (!removed.isError) {
      changes.push({
        kind: "owner-removed",
        urn: profile.ownerRemoval.urn,
        detail: `Removed ${profile.ownerRemoval.display} as an owner of ${shortName(profile.ownerRemoval.urn)}, whom the runbook names.`,
      });
      say(`    ✓ removed ${profile.ownerRemoval.display} from ${shortName(profile.ownerRemoval.urn)}`);
    }
  }

  return changes;
}

/**
 * Wait until the catalog stops moving before recording a baseline against it.
 *
 * A fixed sleep after ingest is enough for the datasets to resolve, and not
 * enough for everything hanging off them. Assertion *results* arrive through
 * Kafka after the assertions themselves, so on a cold machine the capture can
 * land in the window where `payment_health_daily` has its assertions but not
 * their outcomes. The runbook then records "0 failing assertions" as the state
 * of the world, the results turn up moments later, and the very next validation
 * reports drift that nobody caused — which is exactly what CI saw on its first
 * fresh run, and what a warm laptop never sees because the results settled days
 * ago.
 *
 * Rather than raise the sleep and hope, read the entities the runbook actually
 * depends on until two consecutive reads agree. The fingerprint is the same one
 * every claim is pinned to, so "the catalog has stopped moving" is being decided
 * by the same function that later decides "the catalog has moved".
 */
export async function waitForCatalogToSettle(profile: CatalogProfile, say: Say = quiet): Promise<void> {
  const urns = [...new Set(profile.runbook().steps.map((s) => s.urn).filter((u): u is string => Boolean(u)))];
  if (urns.length === 0) return;

  /*
   * "Settled" has to mean present *and* unchanging. An entity that has not been
   * indexed yet reads as `exists: false`, and two consecutive reads of a catalog
   * that has not arrived agree with each other perfectly — so a naive
   * fingerprint comparison would declare the emptiest possible catalog stable
   * and capture a runbook with no claims against it. That is the showcase
   * failure: 9 claims where a settled catalog gives 19, and a rename that could
   * not be "caught" because nothing had recorded the column in the first place.
   */
  const read = async () => {
    const snapshots = await Promise.all(urns.map((urn) => snapshotEntity(urn)));
    return {
      present: snapshots.filter((s) => s.exists).length,
      fingerprint: snapshots.map((s) => `${s.urn}@${s.version?.entity ?? "none"}`).join("|"),
      described: snapshots.filter((s) => s.fields.length > 0).length,
      owned: snapshots.filter((s) => s.owners.length > 0).length,
    };
  };

  /*
   * Fifteen minutes, because the budget has to fit the slower of the two
   * catalogs rather than the one that happens to be the default. Northbeam is
   * fourteen datasets and settles in seconds; the showcase datapack is 3,561
   * events across a thousand entities, and on a cold runner with nothing cached
   * it was still moving after six — which is how a capture ended up seeing one
   * of its three datasets and a rename that could not be caught. Waiting costs
   * nothing on the catalog that is already still.
   */
  const deadline = Date.now() + 15 * 60_000;
  let previous = await read();
  let announced = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const current = await read();
    /*
     * Present is not the same as usable. A dataset whose key aspect has been
     * written but whose schema has not still answers `exists: true`, and a
     * catalog full of those is stable, complete-looking and worth nothing to a
     * proof whose every claim is about columns and owners — CI captured exactly
     * that and reported "3 entities snapshotted, 0 resolved" without the wait
     * ever noticing. So the bar is a schema on every dataset the runbook reads,
     * which is the least the claims below need in order to mean anything.
     */
    if (current.described === urns.length && current.fingerprint === previous.fingerprint) return;
    if (!announced) {
      say("    the catalog is still settling after ingest; waiting for it to hold still…");
      announced = true;
    }
    previous = current;
  }
  say(
    `    the catalog never held still in 15 minutes — ${previous.present}/${urns.length} of the runbook's ` +
      `datasets present, ${previous.described} with a schema, ${previous.owned} with owners. Capturing ` +
      `anyway, and the checks below will say what that cost.`
  );
}

export async function restoreCatalog(
  profile: CatalogProfile,
  kinds: BreakKind[] = ["rename", "deprecate", "owner"],
  say: Say = quiet
): Promise<void> {
  if (kinds.includes("rename")) {
    if (await renameColumn(profile, "restore")) {
      say(`    ✓ restored ${profile.rename.from} on ${shortName(profile.rename.urn)}`);
    }
  }

  if (kinds.includes("deprecate")) {
    await datahubGraphQL(UPDATE_DEPRECATION, { input: { urn: profile.deprecate.urn, deprecated: false, note: "" } });
    say(`    ✓ un-deprecated ${shortName(profile.deprecate.urn)}`);
  }

  if (kinds.includes("owner")) {
    const added = await callDataHubTool("add_owners", {
      owner_urns: [profile.ownerRemoval.ownerUrn],
      entity_urns: [profile.ownerRemoval.urn],
      ownership_type: "__system__technical_owner",
    });
    say(
      added.isError
        ? `    • could not restore ${profile.ownerRemoval.display} as an owner: ${added.content.slice(0, 160)}`
        : `    ✓ restored ${profile.ownerRemoval.display} as an owner of ${shortName(profile.ownerRemoval.urn)}`
    );
  }
}
