import type {
  Artifact,
  Availability,
  Brief,
  GenerationResult,
  ProgressEvent,
  ProviderId,
  SessionHandle,
  SessionStatus,
} from './types.js';

// THE SEAM. Every path that turns a description into a playground goes through
// this interface, and the rest of the app must not be able to tell which
// implementation is behind it — that ignorance is the whole point. Async and
// session-oriented.
//
// Baseline — every provider implements these:
//   startSession / getStatus / streamProgress / getResult / getAvailability
//
// Optional capabilities — the iterate/remix expansions (p0v.3 defers them). The
// PRESENCE of the method is the capability; there is no separate boolean to keep
// in sync. [LAW:one-source-of-truth] A one-shot provider simply omits them and is
// still a complete, honest Provider.
export interface Provider {
  readonly id: ProviderId;
  readonly label: string;

  // Begin a generation from a brief; the returned handle tracks it. The work runs
  // asynchronously — this resolves once the session exists, not once it is done.
  startSession(brief: Brief): Promise<SessionHandle>;

  // The full point-in-time status of the latest turn — the poll surface (p0v.4).
  // Exhaustive by construction: callers must handle every state.
  getStatus(handle: SessionHandle): Promise<SessionStatus>;

  // A live feed of progress notes for the session. Pure data flowing out; the
  // provider owns when events are emitted. [LAW:no-ambient-temporal-coupling]
  streamProgress(handle: SessionHandle): AsyncIterable<ProgressEvent>;

  // AWAIT the handle's turn to a terminal state, then resolve with the result if it
  // SUCCEEDED or reject loudly (carrying the surfaced GenerationError) if it FAILED.
  // Because it awaits, "not yet terminal" is never a caller-visible outcome — just an
  // unsettled promise — so no two providers can diverge on the early-call case. This
  // is the one-shot convenience the tmux provider is built on (p0v.3: startSession +
  // getResult, no polling). Never resolves with an empty/placeholder file on failure.
  // [LAW:types-are-the-program] [LAW:no-silent-failure]
  getResult(handle: SessionHandle): Promise<GenerationResult>;

  // Whether this provider can generate right now. Live, because availability
  // changes (e.g. the local tmux session isn't running); a frozen snapshot would
  // lie. Reading it is an effect, so it lives on the provider boundary.
  // [LAW:effects-at-boundaries]
  getAvailability(): Promise<Availability>;

  // Continue an existing session with a follow-up turn (iterate). Optional —
  // present iff the provider supports it. `seed` is the playground's CURRENT durable
  // artifact — the store's source of truth for its bytes — passed as a value so a
  // provider whose private per-session state was reclaimed (the tmux workdir is a
  // CACHE of exactly this, evicted when idle) can reconstruct it and still continue.
  // A provider that retains its own durable context just ignores the seed; the value
  // always flows, the provider decides whether it needs it. [LAW:one-source-of-truth]
  // [LAW:dataflow-not-control-flow]
  continueSession?(handle: SessionHandle, followUp: Brief, seed: Artifact): Promise<SessionHandle>;

  // Branch a NEW independent session from an existing one (remix). Optional — present
  // iff the provider supports it. `seed` is the parent playground's CURRENT durable
  // artifact, read from the store and passed across the seam as a value — the same
  // shape continueSession uses — so the provider seeds the new session from it without
  // ever reaching into the parent's (possibly-evicted) private state. The returned
  // handle names a fresh session whose identity is wholly distinct from the parent's;
  // lineage (parent/forkedFromVersion) is recorded by the catalog (p0v.2), not here.
  // [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
  fork?(handle: SessionHandle, seed: Artifact): Promise<SessionHandle>;
}
