import { renameCandidate } from "./lib/remediate";
import { snapshotEntity } from "./lib/decay";
async function main() {
  const URN = "urn:li:dataset:(urn:li:dataPlatform:dbt,b2fd91.order_entry_db.order_entry.products,PROD)";
  const snap = await snapshotEntity(URN);
  console.log("live fields:", snap.fields);
  const before = snap.fields;
  // What the benchmark's injector does: rename in place, preserving position.
  const after = before.map((f) => (f === "product_status" ? "settled_value" : f));
  console.log("\nrenameCandidate('product_status') ->", renameCandidate("product_status", before, after));
}
main();
