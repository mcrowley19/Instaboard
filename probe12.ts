import { snapshotEntity } from "./lib/decay";
const URN = "urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)";
async function main() {
  const t0 = Date.now();
  const s = await snapshotEntity(URN);
  console.log(`graphql transport: ${Date.now()-t0}ms · fields=${s.fields.length} owners=${s.owners.length} exists=${s.exists}`);
}
main();
