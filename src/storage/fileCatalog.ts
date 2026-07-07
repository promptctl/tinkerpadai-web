import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Catalog, CatalogStore } from './catalog.js';
import { makeCatalog } from './catalog.js';
import { isNotFound } from './fsErrors.js';
import type { CatalogDoc } from './types.js';

const EMPTY: CatalogDoc = { playgrounds: [] };

// Bytes on disk can predate a field the current type requires: tags arrived with the discovery
// epic, so a playground written before then has a session with no `tags`. Reading is the single
// trust boundary where an older on-disk shape meets the current type, so the shape is upgraded HERE,
// once — a tag-less session reads as an empty tag list (a value: no chips, never a crash), exactly
// what a pre-tagging playground should show. A subsequent write persists the upgraded shape, so the
// migration is a natural consequence of use, not a separate script. New required fields default in
// this same seam. [LAW:no-silent-failure] [LAW:types-are-the-program]
export const hydrateStoredDoc = (doc: CatalogDoc): CatalogDoc => ({
  playgrounds: doc.playgrounds.map((p) =>
    // The guard is legitimate defensive validation AT the trust boundary (persisted external input),
    // not control flow hiding a bug: legacy bytes genuinely lack the field the type now promises.
    // [LAW:no-defensive-null-guards]
    Array.isArray(p.session.tags) ? p : { ...p, session: { ...p.session, tags: [] } },
  ),
});

// The local-file backend: the whole catalog as one JSON document at `path`. An absent
// file is the legitimate initial state (empty catalog); any other read error is a real
// failure and propagates. We are the only writer, so JSON.parse trusts our own format for
// everything but forward-compatible shape upgrades, which hydrateStoredDoc applies.
export const makeFileCatalog = (path: string): Catalog => {
  const backend: CatalogStore = {
    async read(): Promise<CatalogDoc> {
      try {
        return hydrateStoredDoc(JSON.parse(await readFile(path, 'utf8')) as CatalogDoc);
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
