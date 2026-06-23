import type { Availability, Brief, ProgressEvent, SessionHandle } from './types.js';

// The effectful boundary the tmux provider is built on: the interface to an
// external code-generating agent. EVERYTHING that touches the world — spawning a
// process, inspecting a pane, reading a file, the clock — lives behind this port,
// so the provider body above it (tmuxProvider.ts) is pure orchestration and is
// testable without any of it. [LAW:effects-at-boundaries]
//
// It is deliberately poll-shaped because that is how driving Claude Code over tmux
// actually works: there is no push signal that a generation finished, so you begin
// the work and then inspect for completion. A push-shaped port would be a lie about
// the underlying mechanism. [FRAMING:representation]

// What a single inspection of an in-flight turn found. A discriminated union so the
// illegal states — "succeeded but no file", "failed but no reason" — cannot be
// constructed; the provider's mapping to SessionStatus is then forced, not
// defended. [LAW:types-are-the-program] [LAW:no-silent-failure]
export type DriverSnapshot =
  | { readonly state: 'running' }
  | { readonly state: 'succeeded'; readonly html: string }
  | { readonly state: 'failed'; readonly message: string };

export interface CodeGenDriver {
  // Whether the driver can generate right now (the underlying tooling is present
  // and usable). Live, not a snapshot — it is read each time the front door asks.
  isAvailable(): Promise<Availability>;

  // Kick off generation for a brief, against the identity the provider already
  // minted. Resolves once the work is launched, NOT once it is done — the handle is
  // how completion is later inspected. The driver owns the work's lifecycle from
  // here; the provider only mints identity and reads state. [LAW:one-source-of-truth]
  begin(brief: Brief, handle: SessionHandle): Promise<void>;

  // Launch a FOLLOW-UP turn that resumes the work `priorHandle` began, applying a new
  // brief on top of it (iterate). `handle` is the fresh identity the provider minted
  // for this turn; `priorHandle` names the turn whose conversation and artifact carry
  // forward. This is a genuinely different effect from begin — resume-with-context vs
  // start-from-nothing — so it is its own method, not a flag on begin; the provider
  // varies behaviour by calling the right one, never by branching inside it.
  // [LAW:dataflow-not-control-flow] [LAW:no-mode-explosion]
  continue(brief: Brief, handle: SessionHandle, priorHandle: SessionHandle): Promise<void>;

  // Inspect the handle's turn once. MUST eventually return a terminal snapshot
  // (succeeded or failed) — a turn that never settles is the driver's bug to fix
  // (e.g. via a deadline), because the provider's getResult await-loop trusts this
  // to terminate. The driver also OWNS pacing: a 'running' result may block briefly
  // so the caller's loop does not spin. [LAW:no-ambient-temporal-coupling]
  poll(handle: SessionHandle): Promise<DriverSnapshot>;

  // A live feed of progress notes for the turn. Pure data flowing out; the driver
  // decides when an event is emitted and supplies its timestamp (reading the clock
  // is an effect, and effects live here). [LAW:effects-at-boundaries]
  progress(handle: SessionHandle): AsyncIterable<ProgressEvent>;
}
