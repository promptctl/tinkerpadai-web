// The persistence seams — ArtifactStore (immutable files keyed by version) and Catalog
// (the source of truth for what playgrounds exist). Import the contracts and the local
// adapters from here; future backends (sqlite, D1, R2, KV) implement the same seams and
// nothing upstream changes. See design-docs/PROJECT.md.

export type { ArtifactStore, BlobStore } from './artifactStore.js';
export { makeArtifactStore } from './artifactStore.js';
export { makeMemoryArtifactStore } from './memoryArtifactStore.js';
export { makeFileArtifactStore } from './fileArtifactStore.js';

export type { Catalog, CatalogStore } from './catalog.js';
export {
  makeCatalog,
  hydrateStoredDoc,
  currentTurnOf,
  currentVersionOf,
  recipeOf,
  summarize,
  forkAttributionOf,
  PlaygroundNotFoundError,
} from './catalog.js';
export { makeMemoryCatalog } from './memoryCatalog.js';
export { makeFileCatalog } from './fileCatalog.js';

export { VersionId, PlaygroundId, Tag, tryTag } from './types.js';
export type {
  CatalogDoc,
  ForkAttribution,
  Lineage,
  NewPlayground,
  ParentRef,
  Playground,
  PlaygroundSummary,
  Recipe,
  SessionRecord,
  Tags,
  TurnRecord,
} from './types.js';
