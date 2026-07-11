import type { R2Bucket } from '@cloudflare/workers-types';
import type { ThumbnailStore } from './thumbnailStore.js';
import { thumbnailObjectKey } from './thumbnailStore.js';
import type { VersionId } from './types.js';

// The R2 backend for the thumbnail seam: one PNG object per version, the edge sibling of the in-memory
// backend. It lives in its OWN bucket, distinct from the artifact bucket — a derived, evictable cache
// kept physically apart from the immutable source of truth, so the cache can neither address nor clobber
// an artifact and can be purged/re-rendered wholesale without ever touching an artifact.
// [LAW:one-source-of-truth] [LAW:decomposition]
export const makeR2ThumbnailStore = (bucket: R2Bucket): ThumbnailStore => ({
  async put(versionId: VersionId, png: Uint8Array): Promise<void> {
    await bucket.put(thumbnailObjectKey(versionId), png);
  },
  // A genuinely absent object is `null` from R2 — turned into `undefined` here, the honest "not yet
  // rendered" the seam promises. Any other R2 failure (network, auth) throws out of get() and propagates,
  // never masked as absence. [LAW:no-silent-failure]
  async get(versionId: VersionId): Promise<Uint8Array | undefined> {
    const object = await bucket.get(thumbnailObjectKey(versionId));
    return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
  },
});
