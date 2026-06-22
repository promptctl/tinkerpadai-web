import type { Provider } from '../provider.js';
import type {
  Availability,
  Brief,
  GenerationResult,
  ProgressEvent,
  SessionHandle,
  SessionStatus,
} from '../types.js';
import { ProviderId, SessionId, TurnId } from '../types.js';

// A test double that implements the Provider seam. Its existence is the proof the
// seam asks for: that the contract is implementable and composes. It is the
// cheapest possible body — exactly what [LAW:types-are-the-program] predicts once
// the types are right. (The real implementation is the tmux provider, p0v.3.)

export interface FakeProviderOptions {
  readonly id: string;
  readonly label: string;
  // What every turn resolves to. 'success' produces html from the brief; a failure
  // carries a surfaced reason — never a silent empty file.
  readonly outcome: 'success' | { readonly fail: string };
  // How many getStatus reads report `running` before the turn reaches `outcome`.
  // Lets a test drive a real non-terminal→terminal transition so getResult's
  // await-until-terminal contract is exercised, not just the instant case.
  readonly runningPolls?: number;
  readonly availability?: Availability;
  // When true the optional iterate/remix methods are present, so capabilitiesOf
  // reports them. When false they are OMITTED (not set to undefined), the honest
  // shape of a one-shot provider.
  readonly iterable?: boolean;
}

// Per-turn mutable state: which brief produced it, and how many more `running`
// reads remain before it settles.
interface TurnState {
  readonly brief: Brief;
  runningLeft: number;
}

export const makeFakeProvider = (opts: FakeProviderOptions): Provider => {
  const providerId = ProviderId(opts.id);
  const availability: Availability = opts.availability ?? { state: 'available' };
  const turns = new Map<string, TurnState>();
  let minted = 0;

  const beginTurn = (sessionId: SessionId, brief: Brief): SessionHandle => {
    const turnId = TurnId(`turn-${(minted += 1)}`);
    turns.set(turnId, { brief, runningLeft: opts.runningPolls ?? 0 });
    return { providerId, sessionId, turnId };
  };

  const turnOf = (handle: SessionHandle): TurnState => {
    const turn = turns.get(handle.turnId);
    if (turn === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return turn;
  };

  async function startSession(brief: Brief): Promise<SessionHandle> {
    return beginTurn(SessionId(`session-${(minted += 1)}`), brief);
  }

  async function getStatus(handle: SessionHandle): Promise<SessionStatus> {
    const turn = turnOf(handle);
    if (turn.runningLeft > 0) {
      turn.runningLeft -= 1;
      return { state: 'running' };
    }
    return opts.outcome === 'success'
      ? { state: 'succeeded', result: { artifact: { html: `<!-- ${turn.brief.description} -->` } } }
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
    async continueSession(handle: SessionHandle, followUp: Brief): Promise<SessionHandle> {
      return beginTurn(handle.sessionId, followUp);
    },
    async fork(handle: SessionHandle): Promise<SessionHandle> {
      return beginTurn(SessionId(`session-${(minted += 1)}`), turnOf(handle).brief);
    },
  };
};
