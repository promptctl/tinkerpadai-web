import type { D1Database } from '@cloudflare/workers-types';
import type { ReportStore, ReportStoreBackend } from './reportStore.js';
import { EMPTY_REPORTS, hydrateReportsDoc, makeReportStore } from './reportStore.js';
import type { ReportsDoc } from './types.js';

// The single row that holds the whole reports document. The ReportStoreBackend seam is
// document-oriented (read the whole doc, write the whole doc), so the faithful D1 backing is one row
// keyed to a fixed id whose `doc` column carries the serialized ReportsDoc — the database sibling of
// the file backend's single JSON file, and the exact shape makeD1Catalog uses for the catalog. This
// is a real, cold-start-durable store, not a normalized schema: the seam does not ask for row-level
// report operations, so inventing tables the seam cannot address would be shape the callers can't
// use. When moderation volume warrants indexed queries (the review queue at scale), normalizing into
// per-report rows is a change BEHIND this same seam. [LAW:decomposition] [LAW:carrying-cost]
const REPORTS_ROW_ID = 1;

// The D1 backend for the report-store seam: read and write the whole document as one row. The table
// is created by its own deploy-time migration (migrations/0002_reports.sql — a separate file so D1's
// filename-keyed migration tracking actually applies it), NOT lazily here — the schema has one owner
// (the migration with its rollback path), and a missing table means the deploy skipped its
// migrations, a real failure that must surface loudly rather than be masked as an empty store.
// [LAW:single-enforcer] [LAW:no-silent-failure]
//
// KNOWN LIMITATION, stated not hidden: read-modify-write of the whole document is atomic only within
// a single Worker isolate (makeReportStore's serialize()), so two concurrent report writes from
// different isolates could read the same state, each append locally, and have one overwrite the other
// — losing a report. This is the same accepted trade-off makeD1Catalog documents, with one honest
// difference: unlike the catalog (which takes NO app writes at the first edge deploy, generation
// being disabled), reports CAN be written at the edge — a browser reporting an existing playground —
// so the window is genuinely reachable here, not merely theoretical. It stays accepted because report
// volume at launch is near zero, making a same-instant cross-isolate collision vanishingly unlikely,
// and because the fix is a real schema change with no payoff yet: normalizing to per-report rows
// (individual INSERTs, no read-modify-write) closes the gap BEHIND this same seam when volume makes it
// worth the carrying cost. [LAW:no-silent-failure] [LAW:carrying-cost]
export const makeD1ReportStore = (db: D1Database): ReportStore => {
  const backend: ReportStoreBackend = {
    async read(): Promise<ReportsDoc> {
      const row = await db
        .prepare('SELECT doc FROM reports WHERE id = ?')
        .bind(REPORTS_ROW_ID)
        .first<{ doc: string }>();
      // No row is the legitimate initial state (no reports). A thrown query (e.g. missing table) is a
      // real failure and propagates — absence of a ROW is not the absence of the TABLE.
      if (row === null) return EMPTY_REPORTS;
      return hydrateReportsDoc(JSON.parse(row.doc));
    },
    async write(doc: ReportsDoc): Promise<void> {
      await db
        .prepare('INSERT INTO reports (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc')
        .bind(REPORTS_ROW_ID, JSON.stringify(doc))
        .run();
    },
  };
  return makeReportStore(backend);
};
