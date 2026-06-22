// The data types of the Provider seam — the contract everything in TinkerPad
// depends on for generation. These types ARE the program here: the body of every
// provider and every caller is residue once these are right. See the founding
// document (design-docs/PROJECT.md) for why generation is one isolated step whose
// output is "just a file".

// Branded identifiers. A bare `string` would let a ProviderId be passed where a
// SessionId is expected; branding makes that mix unrepresentable.
// [LAW:types-are-the-program]
type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProviderId = Brand<string, 'ProviderId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type TurnId = Brand<string, 'TurnId'>;

// The single place that mints branded ids — implementers and callers go through
// these rather than scattering `as` casts. [LAW:single-enforcer]
export const ProviderId = (raw: string): ProviderId => raw as ProviderId;
export const SessionId = (raw: string): SessionId => raw as SessionId;
export const TurnId = (raw: string): TurnId => raw as TurnId;

// A handle to one generation session. Hold it to track progress or fetch the
// result. Carries the provider it belongs to so a handle is never used against the
// wrong provider — another mix made unrepresentable. [LAW:types-are-the-program]
export interface SessionHandle {
  readonly providerId: ProviderId;
  readonly sessionId: SessionId;
}

// What the user describes — "say what you want to tinker with". A struct rather
// than a bare string so it can grow (type hints, examples) without changing every
// signature that carries it. [LAW:locality-or-seam]
export interface Brief {
  readonly description: string;
}

// The one effectful product of generation: a self-contained HTML file. Inline
// CSS/JS, no external deps — self-containment is the load-bearing invariant
// (design-docs/PROJECT.md). The seam carries the file's content; storing it under
// a version is a different boundary (the artifact store, p0v.2).
export interface Artifact {
  readonly html: string;
}

// The product of one succeeded turn: the file, plus the turn that produced it.
// Version IDENTITY (the immutable key the artifact store/catalog assigns) is NOT
// minted here — the catalog is the single source of truth for what versions exist
// (p0v.2). A provider knows which turn it ran; it does not own the version space.
// [LAW:one-source-of-truth]
export interface GenerationResult {
  readonly turnId: TurnId;
  readonly artifact: Artifact;
}

// Why a turn failed. Always carries a surfaced message — a failed generation is
// never a silent empty file. [LAW:no-silent-failure]
export interface GenerationError {
  readonly message: string;
}

// Point-in-time status of a session's latest turn. Only `succeeded` carries a
// result; only `failed` carries an error. The illegal pairings — a success with no
// file, a failure with a file — cannot be constructed. [LAW:types-are-the-program]
export type SessionStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'running' }
  | { readonly state: 'succeeded'; readonly result: GenerationResult }
  | { readonly state: 'failed'; readonly error: GenerationError };

// A streamed progress note. The timestamp is supplied by the provider because
// reading the clock is an effect, and effects live on the provider boundary.
// [LAW:effects-at-boundaries]
export interface ProgressEvent {
  readonly at: number;
  readonly message: string;
}

// Whether a provider can generate right now. `unavailable` always carries a
// reason, so a disabled provider explains itself rather than failing mutely; this
// is what the front door reads to toggle the generation UI (p0v.5).
// [LAW:no-silent-failure]
export type Availability =
  | { readonly state: 'available' }
  | { readonly state: 'unavailable'; readonly reason: string };

// What differs between providers, expressed as values the app reads — never a
// branch on which provider is in play. Derived from the optional methods a
// provider actually implements (see capabilitiesOf), so it cannot drift from what
// the provider can really do. [LAW:dataflow-not-control-flow]
export interface ProviderCapabilities {
  readonly continue: boolean;
  readonly fork: boolean;
}

// Static, cheap, synchronous metadata for rendering the provider-selection UI
// (the dropdown, p0v.5). A derived view of a registered provider — see describe().
export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
}

// A generation request from the front door. The chosen provider rides as a value
// the request carries; resolving it is a Map lookup in the registry, never a
// branch. [LAW:dataflow-not-control-flow]
export interface GenerationRequest {
  readonly providerId: ProviderId;
  readonly brief: Brief;
}
