// The generation API surface: the agnostic orchestration service and the HTTP handler
// that fronts it. The composition root (src/app.ts) wires concrete adapters into the
// service; everything else imports only these contracts. See design-docs/PROJECT.md.
export { makeGenerationService } from './generationService.js';
export type {
  GenerationService,
  GenerationServiceDeps,
  GenerationStatus,
} from './generationService.js';
export { makeHttpHandler } from './httpHandler.js';
