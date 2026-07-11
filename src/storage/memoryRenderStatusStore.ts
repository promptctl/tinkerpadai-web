import type { RenderStatus, RenderStatusStore } from './renderStatusStore.js';
import type { VersionId } from './types.js';

// The in-memory backend for the render-status seam: a Map keyed by version. Used by tests and the cheapest
// proof the seam composes without touching KV. set overwrites, get returns `undefined` for an absent
// version, and clear deletes — the three behaviours the contract fixes — fall straight out of Map
// semantics, so nothing is re-implemented here. [LAW:decomposition]
export const makeMemoryRenderStatusStore = (): RenderStatusStore => {
  const statuses = new Map<VersionId, RenderStatus>();
  return {
    async set(versionId: VersionId, status: RenderStatus): Promise<void> {
      statuses.set(versionId, status);
    },
    async get(versionId: VersionId): Promise<RenderStatus | undefined> {
      return statuses.get(versionId);
    },
    async clear(versionId: VersionId): Promise<void> {
      statuses.delete(versionId);
    },
  };
};
