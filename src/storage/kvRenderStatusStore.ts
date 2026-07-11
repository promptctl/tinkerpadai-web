import type { KVNamespace } from '@cloudflare/workers-types';
import type { RenderStatus, RenderStatusStore } from './renderStatusStore.js';
import { parseRenderStatus, renderStatusKey } from './renderStatusStore.js';
import type { VersionId } from './types.js';

// The KV backend for the render-status seam: one small text entry per version, the edge sibling of the
// in-memory backend. KV (not R2, not D1) because a status is a tiny, hot, evictable operational flag read
// on every commons render — exactly KV's shape — and it is kept in its OWN namespace, distinct from the
// catalog (authoritative) and the thumbnail bucket (the rendered-ness source of truth), so this derived
// operational state can neither address nor clobber either. [LAW:one-source-of-truth] [LAW:decomposition]
export const makeKvRenderStatusStore = (kv: KVNamespace): RenderStatusStore => ({
  async set(versionId: VersionId, status: RenderStatus): Promise<void> {
    await kv.put(renderStatusKey(versionId), status);
  },
  // A genuinely absent key is `null` from KV — turned into `undefined` by parseRenderStatus, the honest
  // "no status". A stored value that is neither status fails LOUDLY there (manual tampering), never masked
  // as absence. Any other KV failure (network, auth) throws out of get() and propagates. [LAW:no-silent-failure]
  async get(versionId: VersionId): Promise<RenderStatus | undefined> {
    return parseRenderStatus(await kv.get(renderStatusKey(versionId)));
  },
  async clear(versionId: VersionId): Promise<void> {
    await kv.delete(renderStatusKey(versionId));
  },
});
