import { describe, expect, it } from "vitest";
import { sqlColumnRefs } from "@/lib/sql-refs";
import { stepReferences } from "@/lib/provenance";

describe("sqlColumnRefs", () => {
  it("reads the columns a query actually selects, filters and groups on", () => {
    const refs = sqlColumnRefs(
      "SELECT DATE_TRUNC('month', revenue_date) AS month, SUM(net_amount_usd) AS net_revenue\n" +
        "FROM analytics.marts.fct_revenue\nGROUP BY 1 ORDER BY 1 DESC;"
    );
    expect(refs).not.toBeNull();
    expect(refs!.complete).toBe(true);
    expect(refs!.columns).toContain("net_amount_usd");
    expect(refs!.columns).toContain("revenue_date");
  });

  it("does not treat a column name inside a string literal as a reference", () => {
    const refs = sqlColumnRefs("SELECT provider FROM payment_health_daily WHERE note = 'check net_amount_usd later';");
    expect(refs!.columns).toContain("provider");
    expect(refs!.columns).not.toContain("net_amount_usd");
  });

  it("reaches columns in subqueries", () => {
    const refs = sqlColumnRefs(
      "SELECT order_status FROM order_history WHERE as_of_date = (SELECT MAX(as_of_date) FROM order_history);"
    );
    expect(refs!.columns).toContain("as_of_date");
    expect(refs!.columns).toContain("order_status");
  });

  it("marks SELECT * as incomplete, because absence proves nothing there", () => {
    const refs = sqlColumnRefs("SELECT * FROM fct_revenue;");
    expect(refs).not.toBeNull();
    expect(refs!.complete).toBe(false);
  });

  it("returns null for SQL it cannot parse, like templated dbt", () => {
    expect(sqlColumnRefs("select sum(net_amount_usd) from {{ source('marts','fct_revenue') }}")).toBeNull();
  });
});

describe("stepReferences with a parsed query", () => {
  const step = {
    instruction: "Pull the month's revenue.",
    why: "Finance reconciles to settled cash.",
    sql: "SELECT SUM(net_amount_usd) AS net_revenue FROM fct_revenue WHERE note = 'gross_amount_usd is pre-refund';",
  };

  it("depends on the column the query reads", () => {
    expect(stepReferences(step, "net_amount_usd")).toBe(true);
  });

  it("does not depend on a column only a string literal mentions", () => {
    expect(stepReferences(step, "gross_amount_usd")).toBe(false);
  });

  it("still reads dependencies out of prose", () => {
    expect(
      stepReferences({ instruction: "Check success_rate for the last week.", why: "Failed payments hide." }, "success_rate")
    ).toBe(true);
  });

  it("falls back to word matching when the query selects *", () => {
    expect(
      stepReferences({ instruction: "Look.", why: "Because.", sql: "SELECT * FROM fct_revenue -- net_amount_usd" }, "net_amount_usd")
    ).toBe(true);
  });

  it("falls back to word matching when the query cannot be parsed", () => {
    expect(
      stepReferences(
        { instruction: "Run the model.", why: "Because.", sql: "select net_amount_usd from {{ source('marts','fct_revenue') }}" },
        "net_amount_usd"
      )
    ).toBe(true);
  });
});
