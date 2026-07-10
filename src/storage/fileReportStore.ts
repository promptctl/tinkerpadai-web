import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReportStore, ReportStoreBackend } from './reportStore.js';
import { EMPTY_REPORTS, hydrateReportsDoc, makeReportStore } from './reportStore.js';
import { isNotFound } from './fsErrors.js';
import type { ReportsDoc } from './types.js';

// The local-file backend: the whole reports document as one JSON file at `path`. An absent file is
// the legitimate initial state (no reports yet); any other read error is a real failure and
// propagates. We are the only writer, so JSON.parse trusts our own format for everything but the
// loud shape validation hydrateReportsDoc applies. Mirrors makeFileCatalog.
export const makeFileReportStore = (path: string): ReportStore => {
  const backend: ReportStoreBackend = {
    async read(): Promise<ReportsDoc> {
      try {
        return hydrateReportsDoc(JSON.parse(await readFile(path, 'utf8')));
      } catch (err) {
        if (isNotFound(err)) return EMPTY_REPORTS;
        throw err;
      }
    },
    async write(doc: ReportsDoc): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(doc, null, 2), 'utf8');
    },
  };
  return makeReportStore(backend);
};
