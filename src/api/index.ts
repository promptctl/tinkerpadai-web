// The generation API surface: the agnostic orchestration service and the HTTP handler
// that fronts it. The composition root (src/app.ts) wires concrete adapters into the
// service; everything else imports only these contracts. See design-docs/PROJECT.md.
export { makeGenerationService } from './generationService.js';
export type {
  GenerationService,
  GenerationServiceDeps,
  GenerationStatus,
} from './generationService.js';
export { makeGenerationQuota, QuotaExceededError, DEFAULT_QUOTA_LIMITS, parseQuotaLimits } from './generationQuota.js';
export type { GenerationQuota, QuotaLimits, QuotaDenial, Reservation } from './generationQuota.js';
export { DEFAULT_GENERATION_POLICY, parseGenerationPolicy, parseMaxGenerationAttempts } from './generationPolicy.js';
export type { GenerationPolicy } from './generationPolicy.js';
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
