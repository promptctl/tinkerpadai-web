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
  // What every session resolves to. 'success' produces html from the brief; a
  // failure carries a surfaced reason — never a silent empty file.
  readonly outcome: 'success' | { readonly fail: string };
  readonly availability?: Availability;
  // When true the optional iterate/remix methods are present, so capabilitiesOf
  // reports them. When false they are OMITTED (not set to undefined), the honest
  // shape of a one-shot provider.
  readonly iterable?: boolean;
}

const statusFor = (opts: FakeProviderOptions, brief: Brief): SessionStatus =>
  opts.outcome === 'success'
    ? {
        state: 'succeeded',
        result: { turnId: TurnId('turn-1'), artifact: { html: `<!-- ${brief.description} -->` } },
      }
    : { state: 'failed', error: { message: opts.outcome.fail } };

export const makeFakeProvider = (opts: FakeProviderOptions): Provider => {
  const id = ProviderId(opts.id);
  const availability: Availability = opts.availability ?? { state: 'available' };
  // The brief is captured per session so getStatus/getResult reflect what was asked.
  const briefs = new Map<string, Brief>();

  async function startSession(brief: Brief): Promise<SessionHandle> {
    const sessionId = SessionId(`session-${briefs.size + 1}`);
    briefs.set(sessionId, brief);
    return { providerId: id, sessionId };
  }

  async function getStatus(handle: SessionHandle): Promise<SessionStatus> {
    const brief = briefs.get(handle.sessionId);
    if (brief === undefined) throw new Error(`unknown session: ${handle.sessionId}`);
    return statusFor(opts, brief);
  }

  async function* streamProgress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
    if (!briefs.has(handle.sessionId)) throw new Error(`unknown session: ${handle.sessionId}`);
    yield { at: 0, message: 'started' };
    yield { at: 1, message: 'finished' };
  }

  async function getResult(handle: SessionHandle): Promise<GenerationResult> {
    const status = await getStatus(handle);
    if (status.state === 'succeeded') return status.result;
    if (status.state === 'failed') throw new Error(status.error.message);
    throw new Error(`not terminal: ${status.state}`);
  }

  async function getAvailability(): Promise<Availability> {
    return availability;
  }

  const base: Provider = {
    id,
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
      briefs.set(handle.sessionId, followUp);
      return handle;
    },
    async fork(handle: SessionHandle): Promise<SessionHandle> {
      const sessionId = SessionId(`session-${briefs.size + 1}`);
      briefs.set(sessionId, briefs.get(handle.sessionId) ?? { description: '' });
      return { providerId: id, sessionId };
    },
  };
};
