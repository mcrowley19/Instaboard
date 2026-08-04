# Consumer workspace

These are the queries downstream of the catalog: the reports that break when a column is renamed. Each folder matches one of the prove catalogs, and each file names the tables and columns it reads in a header comment. Two files per folder read the column the repair drill renames. One reads something else entirely, as a control.

To watch them break and get repaired, run

```
npm run prove:repair                        # against the seeded northbeam catalog
npm run prove:repair -- --catalog=showcase  # against DataHub's showcase datapack
```

The drill copies this folder into `data/consumer-workspace/`, builds a small SQLite warehouse from whatever schema the live catalog holds at that moment, and executes every file. It then makes the rename in both places at once, the way it happens in production: `ALTER TABLE … RENAME COLUMN` in the warehouse and the same rename through DataHub's schemaMetadata API. Executing again fails the two readers and leaves the control green. The approved correction from the proposal is applied to the workspace copy, after which every file passes and returns the exact result hash it had before the break. A rename cannot move warehouse data, so a repair that substituted the wrong column would move the hash.

Receipts from the committed run live at `examples/live/prove-repair-receipts.json`, and `npm run prove:verify -- --repair` re-checks them.
