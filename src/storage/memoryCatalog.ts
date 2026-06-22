import type { Catalog, CatalogStore } from './catalog.js';
import { makeCatalog } from './catalog.js';
import type { CatalogDoc } from './types.js';

// The in-memory backend: the whole document held in one variable. The catalog
// invariants (record shape, lineage separation, write ordering) are not re-implemented
// here — they live in makeCatalog.
export const makeMemoryCatalog = (): Catalog => {
  let doc: CatalogDoc = { playgrounds: [] };
  const backend: CatalogStore = {
    async read(): Promise<CatalogDoc> {
      return doc;
    },
    async write(next: CatalogDoc): Promise<void> {
      doc = next;
    },
  };
  return makeCatalog(backend);
};
