import type { ThumbnailStore } from './thumbnailStore.js';
import type { VersionId } from './types.js';

// The in-memory backend for the thumbnail seam: a Map keyed by version. Used by tests and the cheapest
// proof the seam composes without touching R2. Put overwrites (a re-render replaces bytes) and an absent
// version reads back `undefined` — the two behaviours the contract fixes — fall straight out of Map
// semantics, so nothing is re-implemented here. [LAW:decomposition]
export const makeMemoryThumbnailStore = (): ThumbnailStore => {
  const thumbnails = new Map<VersionId, Uint8Array>();
  return {
    async put(versionId: VersionId, png: Uint8Array): Promise<void> {
      thumbnails.set(versionId, png);
    },
    async get(versionId: VersionId): Promise<Uint8Array | undefined> {
      return thumbnails.get(versionId);
    },
  };
};
