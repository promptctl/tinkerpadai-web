-- Schema for the Cloudflare deploy (tinkerpadai-cloudflare-8le). One owner of the D1 shape.
-- Applied with: wrangler d1 migrations apply tinkerpad
--
-- Rollback is MANUAL: D1 migrations are forward-only (there is no `wrangler d1 migrations rollback`).
-- To reverse this migration, run the DROP statements documented at the bottom of this file with
-- `wrangler d1 execute tinkerpad --command "..."`. The data-schema law asks every migration to be a
-- reversible deployment event; here the reverse is those explicit statements, stated not implied.

-- The catalog as a single-row JSON document (src/storage/d1Catalog.ts). The CatalogStore seam is
-- document-oriented (read/write the whole doc), so the faithful backing is one row whose `doc` column
-- holds the serialized CatalogDoc. `id` is fixed to 1 by the adapter; the CHECK makes a second row
-- unrepresentable rather than merely unused.
CREATE TABLE catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);

-- Live sessions (src/api/d1SessionStore.ts): one row per session token, strongly consistent so a
-- just-minted session is readable on the very next request. `expires_at` is epoch milliseconds; the
-- adapter evicts a row it observes past its deadline, and the index supports a future bulk sweep.
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Rollback (manual, forward-only tooling) — run to reverse this migration. DROP INDEX is implied by
-- DROP TABLE, listed only for clarity:
--   wrangler d1 execute tinkerpad --command "DROP TABLE IF EXISTS sessions;"
--   wrangler d1 execute tinkerpad --command "DROP TABLE IF EXISTS catalog;"
