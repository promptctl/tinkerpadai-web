import type {
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

  // Resolve to the result once the latest turn SUCCEEDS; reject loudly (carrying
  // the surfaced GenerationError) if it FAILS. The terminal-fetch convenience the
  // one-shot provider is built on (p0v.3: startSession + getResult). Never resolves
  // with an empty/placeholder file on failure. [LAW:no-silent-failure]
  getResult(handle: SessionHandle): Promise<GenerationResult>;

  // Whether this provider can generate right now. Live, because availability
  // changes (e.g. the local tmux session isn't running); a frozen snapshot would
  // lie. Reading it is an effect, so it lives on the provider boundary.
  // [LAW:effects-at-boundaries]
  getAvailability(): Promise<Availability>;

  // Continue an existing session with a follow-up turn (iterate). Optional —
  // present iff the provider supports it.
  continueSession?(handle: SessionHandle, followUp: Brief): Promise<SessionHandle>;

  // Branch a new session from an existing one (remix). Optional — present iff the
  // provider supports it. Lineage is recorded by the catalog (p0v.2), not here.
  fork?(handle: SessionHandle): Promise<SessionHandle>;
}
