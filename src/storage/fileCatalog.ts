import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Catalog, CatalogStore } from './catalog.js';
import { makeCatalog } from './catalog.js';
import { isNotFound } from './fsErrors.js';
import type { CatalogDoc } from './types.js';

const EMPTY: CatalogDoc = { playgrounds: [] };

// The local-file backend: the whole catalog as one JSON document at `path`. An absent
// file is the legitimate initial state (empty catalog); any other read error is a real
// failure and propagates. We are the only writer, so JSON.parse trusts our own format.
export const makeFileCatalog = (path: string): Catalog => {
  const backend: CatalogStore = {
    async read(): Promise<CatalogDoc> {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as CatalogDoc;
      } catch (err) {
        if (isNotFound(err)) return EMPTY;
        throw err;
      }
    },
    async write(doc: CatalogDoc): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(doc, null, 2), 'utf8');
    },
  };
  return makeCatalog(backend);
};
