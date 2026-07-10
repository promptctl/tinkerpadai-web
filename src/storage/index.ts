// The persistence seams — ArtifactStore (immutable files keyed by version) and Catalog
// (the source of truth for what playgrounds exist). Import the contracts and the local
// adapters from here; future backends (sqlite, D1, R2, KV) implement the same seams and
// nothing upstream changes. See design-docs/PROJECT.md.

export type { ArtifactStore, BlobStore } from './artifactStore.js';
export { makeArtifactStore } from './artifactStore.js';
export { makeMemoryArtifactStore } from './memoryArtifactStore.js';
export { makeFileArtifactStore } from './fileArtifactStore.js';
export { SelfContainmentError, findSelfContainmentViolation, MAX_ARTIFACT_BYTES } from './selfContainment.js';
export type { SelfContainmentViolation, ResourceSink } from './selfContainment.js';

export type { Catalog, CatalogReader, CatalogStore } from './catalog.js';
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

export type { ReportReader, ReportStore, ReportStoreBackend } from './reportStore.js';
export { makeReportStore, hydrateReportsDoc, EMPTY_REPORTS } from './reportStore.js';
export { makeMemoryReportStore } from './memoryReportStore.js';
export { makeFileReportStore } from './fileReportStore.js';
export { makeD1ReportStore } from './d1ReportStore.js';

export { VersionId, PlaygroundId, ReportId, Tag, tryTag } from './types.js';
export type {
  CatalogDoc,
  ForkAttribution,
  Lineage,
  Listing,
  NewPlayground,
  NewReport,
  ParentRef,
  Playground,
  PlaygroundSummary,
  Recipe,
  Report,
  ReportsDoc,
  SessionRecord,
  Tags,
  TurnRecord,
} from './types.js';
