import type { Provider } from '../provider.js';
import type { ContractProviderOptions } from '../provider.contract.js';
import type {
  Artifact,
  Availability,
  Brief,
  GenerationResult,
  ProgressEvent,
  SessionHandle,
  SessionStatus,
} from '../types.js';
import { ProviderId, SessionId, TurnId } from '../types.js';

// A test double that implements the Provider seam directly (no driver). Its
// existence is the proof the seam asks for: that the contract is implementable and
// composes. It is the cheapest possible body — exactly what
// [LAW:types-are-the-program] predicts once the types are right. The real
// implementation is the tmux provider (tmuxProvider.ts + tmuxDriver.ts).
//
// It accepts the canonical ContractProviderOptions so the same knobs drive both this
// and the scripted tmux driver through one shared contract. [LAW:one-source-of-truth]

// Per-turn mutable state: the html a succeeded poll yields (computed when the turn is
// created — from the brief for a fresh/continued turn, from the seed for a fork — so a
// fork's genesis version reflects the forked artifact, not a brief it never had), and
// how many more `running` reads remain before it settles.
interface TurnState {
  readonly html: string;
  runningLeft: number;
}

// A fixture-only knob (NOT part of the shared provider contract): pin the exact html a succeeded turn
// yields, so a test can drive the store's self-containment refusal through the real service with an
// artifact the brief-derived default would never produce. When unset, html is derived from the brief.
export const makeFakeProvider = (opts: ContractProviderOptions & { readonly html?: string }): Provider => {
  const providerId = ProviderId(opts.id);
  const availability: Availability = opts.availability ?? { state: 'available' };
  const turns = new Map<string, TurnState>();
  let minted = 0;

  const beginTurn = (sessionId: SessionId, html: string): SessionHandle => {
    const turnId = TurnId(`turn-${(minted += 1)}`);
    turns.set(turnId, { html, runningLeft: opts.runningPolls ?? 0 });
    return { providerId, sessionId, turnId };
  };

  const htmlFor = (brief: Brief): string => opts.html ?? `<!-- ${brief.description} -->`;

  const turnOf = (handle: SessionHandle): TurnState => {
    const turn = turns.get(handle.turnId);
    if (turn === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return turn;
  };

  async function startSession(brief: Brief): Promise<SessionHandle> {
    return beginTurn(SessionId(`session-${(minted += 1)}`), htmlFor(brief));
  }

  async function getStatus(handle: SessionHandle): Promise<SessionStatus> {
    const turn = turnOf(handle);
    if (turn.runningLeft > 0) {
      turn.runningLeft -= 1;
      return { state: 'running' };
    }
    return opts.outcome === 'success'
      ? { state: 'succeeded', result: { artifact: { html: turn.html } } }
      : { state: 'failed', error: { message: opts.outcome.fail } };
  }

  async function* streamProgress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
    turnOf(handle);
    yield { at: 0, message: 'started' };
    yield { at: 1, message: 'finished' };
  }

  // Await the turn to terminal, then resolve or reject. A `running` read is not a
  // distinct outcome here — it just continues the loop. [LAW:no-defensive-null-guards]
  async function getResult(handle: SessionHandle): Promise<GenerationResult> {
    for (;;) {
      const status = await getStatus(handle);
      if (status.state === 'succeeded') return status.result;
      if (status.state === 'failed') throw new Error(status.error.message);
    }
  }

  async function getAvailability(): Promise<Availability> {
    return availability;
  }

  const base: Provider = {
    id: providerId,
    label: opts.label,
    startSession,
    getStatus,
    streamProgress,
    getResult,
    getAvailability,
  };

  if (opts.iterable !== true) return base;

  return {
    ...base,
    async continueSession(handle: SessionHandle, followUp: Brief, _seed: Artifact): Promise<SessionHandle> {
      return beginTurn(handle.sessionId, htmlFor(followUp));
    },
    // A fork mints a NEW session (its own sessionId) seeded from the parent's current
    // artifact — so its genesis version IS that seed, the independent branch starting
    // where the parent is. The parent handle is not read: the seed value carries
    // everything the fork needs. [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
    async fork(_parent: SessionHandle, seed: Artifact): Promise<SessionHandle> {
      return beginTurn(SessionId(`session-${(minted += 1)}`), seed.html);
    },
  };
};
