import type { D1Database } from '@cloudflare/workers-types';
import type { Catalog, CatalogStore } from './catalog.js';
import { EMPTY_CATALOG, hydrateStoredDoc, makeCatalog } from './catalog.js';
import type { CatalogDoc } from './types.js';

// The single row that holds the whole catalog document. The CatalogStore seam is document-oriented
// (read the whole doc, write the whole doc), so the faithful D1 backing is one row keyed to a fixed
// id whose `doc` column carries the serialized CatalogDoc — the database sibling of the file
// backend's single JSON file. This is a real, cold-start-durable store, not a normalized schema: the
// seam does not ask for row-level playground operations, so inventing tables the seam cannot address
// would be shape the callers can't use. When edge WRITES turn on at scale (generation at the edge,
// tinkerpadai-providers-u1h), normalizing into per-playground rows is a change BEHIND this same seam
// — the seam is exactly what makes that migration safe. [LAW:decomposition] [LAW:carrying-cost]
const CATALOG_ROW_ID = 1;

// The D1 backend for the catalog seam: read and write the whole document as one row. The table is
// created by a migration at deploy time (migrations/0001_init.sql), NOT lazily here — the schema has
// one owner (the migration with its rollback path), and a missing table means the deploy skipped its
// migrations, a real failure that must surface loudly rather than be masked as an empty catalog.
// [LAW:single-enforcer] [LAW:no-silent-failure]
//
// KNOWN LIMITATION, stated not hidden: read-modify-write of the whole document is atomic only within
// a single Worker isolate (makeCatalog's serialize()), so two concurrent edge WRITES from different
// isolates could lose one. The first public deploy runs generation disabled at the edge, so no app
// write reaches here; the durable path is browse/use (reads). Concurrent edge writes are unblocked by
// the normalized schema noted above. [LAW:no-silent-failure]
export const makeD1Catalog = (db: D1Database): Catalog => {
  const backend: CatalogStore = {
    async read(): Promise<CatalogDoc> {
      const row = await db
        .prepare('SELECT doc FROM catalog WHERE id = ?')
        .bind(CATALOG_ROW_ID)
        .first<{ doc: string }>();
      // No row is the legitimate initial state (empty catalog). A thrown query (e.g. missing table)
      // is a real failure and propagates — absence of a ROW is not the absence of the TABLE.
      if (row === null) return EMPTY_CATALOG;
      return hydrateStoredDoc(JSON.parse(row.doc) as CatalogDoc);
    },
    async write(doc: CatalogDoc): Promise<void> {
      await db
        .prepare('INSERT INTO catalog (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc')
        .bind(CATALOG_ROW_ID, JSON.stringify(doc))
        .run();
    },
  };
  return makeCatalog(backend);
};
