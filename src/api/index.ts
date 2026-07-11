// The generation API surface: the agnostic orchestration service and the HTTP handler
// that fronts it. The composition root (src/app.ts) wires concrete adapters into the
// service; everything else imports only these contracts. See design-docs/PROJECT.md.
export { makeGenerationService, startTurnRetentionSweeper } from './generationService.js';
export type {
  GenerationProgress,
  GenerationService,
  GenerationServiceDeps,
  GenerationStatus,
  TurnRetentionSweeper,
  TurnRetentionSweeperConfig,
} from './generationService.js';
export { makeGenerationQuota, QuotaExceededError, DEFAULT_QUOTA_LIMITS, parseQuotaLimits } from './generationQuota.js';
export type { GenerationQuota, QuotaLimits, QuotaDenial, Reservation } from './generationQuota.js';
export { DEFAULT_GENERATION_POLICY, parseGenerationPolicy, parseMaxGenerationAttempts } from './generationPolicy.js';
export type { GenerationPolicy } from './generationPolicy.js';
// The functional-validation CONTRACT only — pure, edge-safe. The concrete headless-Chrome implementation
// (headlessArtifactValidator.js, which imports puppeteer) is DELIBERATELY not re-exported here: it is
// imported directly by the Node composition root, so the edge Worker bundle — which reaches api/index.js
// — never pulls puppeteer. [LAW:decomposition]
export { FunctionalDefectError, passThroughValidator } from './artifactValidation.js';
export type { ArtifactValidator, LoadErrors } from './artifactValidation.js';
// The render pipeline's PURE core — it only imports the browserRenderer as a TYPE, so no puppeteer runtime
// dep flows through this barrel. The concrete makeBrowserRenderer (which imports puppeteer) stays out of
// here for the same reason the headless validator does, imported directly by the edge root. [LAW:decomposition]
export { resolveRenderTarget, renderAttempt, runBackfill, runRenderBatch, parseRenderJob } from './renderPipeline.js';
export type {
  RenderJob,
  RenderMessage,
  RenderPipelineDeps,
  RenderTarget,
  ResolveResult,
  AttemptResult,
  Attempt,
  BackfillDeps,
  BackfillReport,
} from './renderPipeline.js';
export { makeReportService } from './reportService.js';
export type { ReportService, ReportServiceDeps } from './reportService.js';
export { makeReviewService } from './reviewService.js';
export type { ReviewItem, ReviewService, ReviewServiceDeps } from './reviewService.js';
export { makeHttpHandler } from './httpHandler.js';
export { localIdentityResolver, Subject } from './identity.js';
export type { Identity, IdentityResolver } from './identity.js';
export { makeMemorySessionStore } from './sessionStore.js';
export type { SessionStore } from './sessionStore.js';
export { makeSessionHandler, makeSessionResolver } from './session.js';
export type { CookieSecurity, SessionHandlerDeps } from './session.js';
export { makeGitHubOAuthProvider } from './oauth.js';
export type { OAuthProvider, GitHubOAuthConfig } from './oauth.js';
