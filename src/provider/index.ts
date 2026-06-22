// The Provider seam — TinkerPad's single dependency for all generation. Import the
// contract from here; the implementation behind it (p0v.3) stays invisible.
export type { Provider } from './provider.js';
export { ProviderRegistry, capabilitiesOf } from './registry.js';
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
