import type { ReportStore, ReportStoreBackend } from './reportStore.js';
import { EMPTY_REPORTS, makeReportStore } from './reportStore.js';
import type { ReportsDoc } from './types.js';

// The in-memory backend: the whole document held in one variable. The store invariants (id/timestamp
// minting, write ordering) are not re-implemented here — they live in makeReportStore. Mirrors
// makeMemoryCatalog.
export const makeMemoryReportStore = (): ReportStore => {
  let doc: ReportsDoc = EMPTY_REPORTS;
  const backend: ReportStoreBackend = {
    async read(): Promise<ReportsDoc> {
      return doc;
    },
    async write(next: ReportsDoc): Promise<void> {
      doc = next;
    },
  };
  return makeReportStore(backend);
};
