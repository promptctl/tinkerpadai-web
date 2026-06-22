import type { Artifact } from '../provider/index.js';
import type { ArtifactStore, BlobStore } from './artifactStore.js';
import { makeArtifactStore } from './artifactStore.js';
import type { VersionId } from './types.js';

// The in-memory backend: a Map keyed by version. Used by tests and the cheapest proof
// the seam composes without touching the filesystem. The immutability and loud-on-
// unknown invariants are not re-implemented here — they live in makeArtifactStore.
export const makeMemoryArtifactStore = (): ArtifactStore => {
  const blobs = new Map<VersionId, Artifact>();
  const backend: BlobStore = {
    async write(versionId: VersionId, artifact: Artifact): Promise<void> {
      blobs.set(versionId, artifact);
    },
    async read(versionId: VersionId): Promise<Artifact | undefined> {
      return blobs.get(versionId);
    },
  };
  return makeArtifactStore(backend);
};
