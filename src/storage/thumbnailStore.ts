import type { VersionId } from './types.js';

// THE DERIVED-THUMBNAIL SEAM. Holds PNG previews, each keyed by the version whose HTML it was rendered
// from. It is the deliberate sibling — and inverse — of the artifact store (artifactStore.ts):
//
//   - The artifact store MINTS a fresh version per put and NEVER overwrites: an artifact is an immutable
//     source of truth. A thumbnail is the OPPOSITE — it is DERIVED from an already-existing version, so
//     the caller supplies that VersionId and a re-put REPLACES the bytes. Re-rendering a version (a
//     better renderer, a repaired pipeline) must be allowed; the derived cache is regenerable by
//     definition. [LAW:one-source-of-truth]
//
//   - The artifact store's get fails LOUD on an unknown version (a missing artifact is a bug). This
//     store's get returns `undefined` for an absent thumbnail, because "no thumbnail yet" is a
//     legitimate domain state, not a fault: the version exists and is perfectly usable; its preview is
//     merely not rendered yet (or failed and awaiting retry). The consumer turns that optionality into an
//     honest empty slot, never a broken image or a loud error. [LAW:no-defensive-null-guards]
//     [FRAMING:representation]
//
// Because there is no invariant to enforce across backends (no minting, no self-containment — we produced
// these bytes; absence is a value, not an error), there is deliberately NO wrapper layer over the
// backends the way makeArtifactStore wraps BlobStore. A wrapper here would be an empty enforcer. The
// interface IS the seam; each backend (memory, R2) implements it directly. [LAW:decomposition]
export interface ThumbnailStore {
  // Store (or replace) the PNG preview for a version. Idempotent by version: writing again for the same
  // VersionId overwrites, so a re-render is a plain re-put.
  put(versionId: VersionId, png: Uint8Array): Promise<void>;

  // The preview for a version, or `undefined` when none has been rendered yet. Absence is the honest
  // "not yet" — never a loud failure, never fabricated bytes. [LAW:no-silent-failure]
  get(versionId: VersionId): Promise<Uint8Array | undefined>;
}

// The object key for a version's stored thumbnail: one PNG named for its version. This is the ONE owner
// of the `<versionId>.png` convention — the R2 backend and any tool that addresses thumbnails by key
// derive it from here, so the format has a single source and changing it changes every reader at once.
// It is deliberately the `.png` sibling of artifactObjectKey's `.html`: even were the two ever to share a
// bucket, the distinct suffix makes a thumbnail key and an artifact key provably disjoint, so a thumbnail
// can never clobber the artifact it derives from. [LAW:one-source-of-truth] [LAW:types-are-the-program]
export const thumbnailObjectKey = (versionId: VersionId): string => `${versionId}.png`;
