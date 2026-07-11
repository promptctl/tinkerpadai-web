import type { R2Bucket } from '@cloudflare/workers-types';
import type { Artifact } from '../provider/index.js';
import type { ArtifactStore, BlobStore } from './artifactStore.js';
import { artifactObjectKey, makeArtifactStore } from './artifactStore.js';
import type { VersionId } from './types.js';

// The R2 backend for the artifact seam: one immutable html object per version in an R2 bucket, the
// edge sibling of the local-directory backend. It supplies ONLY the BlobStore (keyed byte storage);
// makeArtifactStore layers the immutability invariants — mint a fresh VersionId per put, so the key
// is new every time and a write never lands on an existing object — over it, exactly as it does for
// the file adapter. The two backends differ only in where the bytes live; the invariant logic exists
// once. [LAW:decomposition] [LAW:single-enforcer]
export const makeR2ArtifactStore = (bucket: R2Bucket): ArtifactStore => {
  const keyOf = artifactObjectKey;
  const backend: BlobStore = {
    async write(versionId: VersionId, artifact: Artifact): Promise<void> {
      await bucket.put(keyOf(versionId), artifact.html);
    },
    // A genuinely absent object is `null` from R2 — turned into `undefined` here, the optionality
    // the store above converts into a loud "unknown version" error. Any other R2 failure (network,
    // auth) throws out of get() and propagates, never masked as absence. [LAW:no-silent-failure]
    async read(versionId: VersionId): Promise<Artifact | undefined> {
      const object = await bucket.get(keyOf(versionId));
      return object === null ? undefined : { html: await object.text() };
    },
  };
  return makeArtifactStore(backend);
};
