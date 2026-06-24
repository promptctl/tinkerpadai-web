// The Provider seam — TinkerPad's single dependency for all generation. Callers
// import the contract (Provider) and treat every implementation alike; the only
// thing a composition root additionally imports is a factory to build one.
export type { Provider } from './provider.js';
export { ProviderRegistry, capabilitiesOf } from './registry.js';

// The concrete provider (p0v.3): the tmux/Claude-Code body and its effect port. The
// composition root builds `makeTmuxProvider({ id, label, driver: makeTmuxDriver() })`
// and registers it; everything else sees only a Provider. [LAW:effects-at-boundaries]
export { makeTmuxProvider } from './tmuxProvider.js';
export type { TmuxProviderConfig } from './tmuxProvider.js';
export {
  makeTmuxDriver,
  cleanupTurn,
  expiredWorkdirs,
  evictIdleWorkdirs,
  startWorkdirJanitor,
} from './tmuxDriver.js';
export type {
  TmuxDriverConfig,
  WorkdirEntry,
  EvictWorkdirsOptions,
  WorkdirJanitorConfig,
  WorkdirJanitor,
} from './tmuxDriver.js';
export type { CodeGenDriver, DriverSnapshot } from './codeGenDriver.js';
export {
  ProviderId,
  SessionId,
  TurnId,
} from './types.js';
export type {
  Artifact,
  Availability,
  Brief,
  GenerationError,
  GenerationRequest,
  GenerationResult,
  ProgressEvent,
  ProviderCapabilities,
  ProviderDescriptor,
  SessionHandle,
  SessionStatus,
} from './types.js';
