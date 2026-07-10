-- Moderation reports for the Cloudflare deploy (tinkerpadai-moderation-5g7). A SEPARATE migration
-- file, not an edit to 0001_init.sql: D1 tracks applied migrations BY FILENAME, so appending a new
-- table to an already-applied 0001 would be silently skipped on every database that ran 0001 before
-- this change — the D1 report store would then SELECT/INSERT against a table that does not exist. One
-- file per schema change keeps each migration a self-contained, reversible deployment event.
-- [LAW:single-enforcer]
--
-- Applied with: wrangler d1 migrations apply tinkerpad
--
-- Rollback is MANUAL: D1 migrations are forward-only (there is no `wrangler d1 migrations rollback`).
-- To reverse this migration, run the DROP statement documented at the bottom with
-- `wrangler d1 execute tinkerpad --command "..."`.

-- Moderation reports as a single-row JSON document (src/storage/d1ReportStore.ts). The
-- ReportStoreBackend seam is document-oriented (read/write the whole doc), so the faithful backing is
-- one row whose `doc` column holds the serialized ReportsDoc — the sibling of the catalog row in
-- 0001. `id` is fixed to 1 by the adapter; the CHECK makes a second row unrepresentable rather than
-- merely unused.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);

-- Rollback (manual, forward-only tooling) — run to reverse this migration:
--   wrangler d1 execute tinkerpad --command "DROP TABLE IF EXISTS reports;"
