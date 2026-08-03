/**
 * Breaking the catalog from a browser, with no DataHub and no credentials.
 *
 * The hosted demo used to state the claim — "when the catalog moves, the runbook
 * reports which step stopped working" — and a reader had to take it. This lets
 * them do it: drop the column the SQL selects, deprecate the table step 3 points
 * at, move the owner step 2 tells you to page, and watch what comes back.
 *
 * What makes it worth showing is that nothing here is a script of the result.
 * The mutations are applied to a copy of the fixture's snapshots, and the report
 * comes out of `diffAgainstCatalog` — the same function the live sweep calls with
 * the same arguments. There is no demo branch inside the engine. The one thing
 * this cannot do is write back to a catalog, because there isn't one; the
 * receipts from a real run are committed under `examples/live/`.
 */

import { diffAgainstCatalog } from "./decay";
import { versionOf } from "./provenance";
import type { DecayReport, EntitySnapshot, Handoff } from "./types";

const sf = (table: string) => `urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.${table},PROD)`;

export const DEMO_URNS = {
  paymentHealth: sf("payment_health_daily"),
  fctRevenue: sf("fct_revenue"),
  mrrMonthly: sf("mrr_monthly"),
};

const RECORDED_AT = "2026-07-01T09:00:00.000Z";

/**
 * The catalog as it stood when the runbook was recorded.
 *
 * Written out rather than read from the fixture module so the demo has a stable
 * baseline: a snapshot is what the author saw on the day, and the whole point is
 * that it does not move when the catalog does.
 */
function baseline(): Record<string, EntitySnapshot> {
  const snap = (urn: string, name: string, over: Partial<EntitySnapshot>): EntitySnapshot => {
    const s: EntitySnapshot = {
      urn,
      name,
      exists: true,
      fields: [],
      owners: [],
      deprecated: false,
      openIncidents: 0,
      failingAssertions: 0,
      assertionCount: 0,
      capturedAt: RECORDED_AT,
      ...over,
    };
    s.version = versionOf(s);
    return s;
  };

  return {
    [DEMO_URNS.paymentHealth]: snap(DEMO_URNS.paymentHealth, "payment_health_daily", {
      fields: ["health_date", "provider", "success_rate", "attempts", "failures"],
      owners: ["Priya Patel (Payments Data Lead, urn:li:corpuser:priya.patel)"],
      ownerUrns: ["urn:li:corpuser:priya.patel"],
      // One freshness assertion, passing on the day the runbook was written.
      assertionCount: 1,
    }),
    [DEMO_URNS.fctRevenue]: snap(DEMO_URNS.fctRevenue, "fct_revenue", {
      fields: ["revenue_date", "customer_id", "plan", "net_amount_usd", "gross_amount_usd", "refund_amount_usd"],
      owners: [
        "Mike Rodriguez (Analytics Engineer, urn:li:corpuser:mike.rodriguez)",
        "Priya Patel (Payments Data Lead, urn:li:corpuser:priya.patel)",
      ],
      ownerUrns: ["urn:li:corpuser:mike.rodriguez", "urn:li:corpuser:priya.patel"],
      assertionCount: 2,
    }),
    [DEMO_URNS.mrrMonthly]: snap(DEMO_URNS.mrrMonthly, "mrr_monthly", {
      fields: ["month", "plan", "mrr_usd", "net_new_mrr_usd", "churned_mrr_usd"],
      owners: ["Mike Rodriguez (Analytics Engineer, urn:li:corpuser:mike.rodriguez)"],
      ownerUrns: ["urn:li:corpuser:mike.rodriguez"],
      assertionCount: 0,
    }),
  };
}

/** The runbook under test: the sample one this repo ships, steps and all. */
export function demoRunbook(): Handoff {
  return {
    id: "sample-monthly-mrr-report",
    title: "Monthly MRR report for the board deck",
    author: "Priya Patel",
    role: "Analytics Engineer",
    summary: "How the monthly MRR figures in the board deck are produced, and what to check before trusting them.",
    createdAt: RECORDED_AT,
    recorded: [],
    sample: true,
    source: "recorded",
    snapshots: baseline(),
    steps: [
      {
        title: "Check payment pipeline health",
        instruction:
          "Open payment_health_daily and confirm yesterday's success_rate is above 0.97 for both providers. " +
          "If it dipped, the revenue numbers below will be short and the report has to wait.",
        why: "A payment outage shows up as missing revenue, not as an error. Nothing downstream will tell you.",
        urn: DEMO_URNS.paymentHealth,
        tips: "The saved query 'Payment success rate by provider' on this dataset is the fastest check.",
        whySource: "recorded",
      },
      {
        title: "Verify fct_revenue loaded cleanly",
        instruction:
          "Open fct_revenue and check the last updated time and row-count trend. Use net_amount_usd for anything " +
          "you report — gross includes refunds.",
        why: "The board deck reports net. Reporting gross overstates the month and it is caught late.",
        urn: DEMO_URNS.fctRevenue,
        sql: "SELECT MAX(revenue_date) AS latest, SUM(net_amount_usd) AS net FROM analytics.marts.fct_revenue;",
        tips: "If latest is more than a day behind, ping Mike Rodriguez — the dbt mart job may have failed.",
        whySource: "recorded",
      },
      {
        title: "Pull the MRR rollup",
        instruction:
          "Open mrr_monthly and run the saved query 'Monthly MRR trend by plan' for the last 12 months. Copy " +
          "mrr_usd and net_new_mrr_usd into the deck.",
        why: "Plan-level rows are what the board asks about; the total is the sum over plans, not a separate table.",
        urn: DEMO_URNS.mrrMonthly,
        sql: "SELECT month, plan, mrr_usd, net_new_mrr_usd FROM analytics.marts.mrr_monthly ORDER BY month DESC;",
        whySource: "recorded",
      },
    ],
  };
}

/* ── The changes a visitor can make ───────────────────────────────────── */

export interface DemoMutation {
  id: string;
  /** Button label. */
  label: string;
  /** What actually changes in the catalog, in the visitor's terms. */
  detail: string;
  /** Which step it should break, 1-indexed, for the "what to watch" line. */
  affectsStep: number;
  apply: (live: Record<string, EntitySnapshot>) => void;
}

export const DEMO_MUTATIONS: DemoMutation[] = [
  {
    id: "drop-column",
    label: "Drop net_amount_usd",
    detail: "Remove the column step 2's SQL selects from fct_revenue.",
    affectsStep: 2,
    apply: (live) => {
      const s = live[DEMO_URNS.fctRevenue];
      s.fields = s.fields.filter((f) => f !== "net_amount_usd");
    },
  },
  {
    id: "rename-column",
    label: "Rename it to net_revenue_usd",
    detail: "The same column, renamed rather than removed — the case a correction can be derived for.",
    affectsStep: 2,
    apply: (live) => {
      const s = live[DEMO_URNS.fctRevenue];
      s.fields = s.fields.map((f) => (f === "net_amount_usd" ? "net_revenue_usd" : f));
    },
  },
  {
    id: "deprecate",
    label: "Deprecate mrr_monthly",
    detail: "Mark the table step 3 routes you to as deprecated.",
    affectsStep: 3,
    apply: (live) => {
      const s = live[DEMO_URNS.mrrMonthly];
      s.deprecated = true;
      s.deprecationNote = "Rebuilt at the FY close. Use analytics.marts.mrr_monthly_v2 instead.";
    },
  },
  {
    id: "remove-owner",
    label: "Move Mike Rodriguez off fct_revenue",
    detail: "Step 2 tells you to page him. He no longer owns the table.",
    affectsStep: 2,
    apply: (live) => {
      const s = live[DEMO_URNS.fctRevenue];
      s.owners = s.owners.filter((o) => !o.includes("Mike Rodriguez"));
      s.ownerUrns = (s.ownerUrns ?? []).filter((o) => !o.includes("mike.rodriguez"));
    },
  },
  {
    id: "fail-assertion",
    label: "Fail the freshness assertion",
    detail: "payment_health_daily's freshness check starts failing. It was passing when this was recorded.",
    affectsStep: 1,
    apply: (live) => {
      live[DEMO_URNS.paymentHealth].failingAssertions = 1;
    },
  },
];

/**
 * Apply the chosen changes and re-validate.
 *
 * Re-fingerprints after mutating, exactly as `snapshotEntity` does when it reads
 * a real catalog: a pin that points at a version nobody can recompute is not a
 * provenance chain. The clean run is the same call with nothing selected, which
 * is what makes the before/after comparable.
 */
export function revalidateDemo(mutationIds: string[]): {
  report: DecayReport;
  runbook: Handoff;
  applied: { id: string; detail: string }[];
} {
  const runbook = demoRunbook();
  const live: Record<string, EntitySnapshot> = JSON.parse(JSON.stringify(runbook.snapshots ?? {}));
  const checkedAt = new Date().toISOString();

  const applied: { id: string; detail: string }[] = [];
  for (const id of mutationIds) {
    const mutation = DEMO_MUTATIONS.find((m) => m.id === id);
    if (!mutation) continue;
    mutation.apply(live);
    applied.push({ id: mutation.id, detail: mutation.detail });
  }

  for (const snapshot of Object.values(live)) {
    snapshot.capturedAt = checkedAt;
    snapshot.version = versionOf(snapshot);
  }

  return { report: diffAgainstCatalog(runbook, live), runbook, applied };
}
