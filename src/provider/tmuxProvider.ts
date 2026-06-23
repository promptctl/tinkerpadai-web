import { randomUUID } from 'node:crypto';
import type { CodeGenDriver, DriverSnapshot } from './codeGenDriver.js';
import type { Provider } from './provider.js';
import type {
  Availability,
  Brief,
  GenerationResult,
  ProgressEvent,
  SessionHandle,
  SessionStatus,
} from './types.js';
import { ProviderId, SessionId, TurnId } from './types.js';

// THE Provider implementation behind the seam (p0v.3). It is pure orchestration over
// a CodeGenDriver: it mints identity, maps the driver's snapshots onto the seam's
// discriminated unions, and owns the await-to-terminal loop. It knows NOTHING about
// tmux — swap the driver for an HTTP client or an in-memory fake and this body is
// unchanged. That ignorance is the proof the seam is real. [LAW:effects-at-boundaries]
//
// One-shot: startSession + getResult are the headline path; continueSession/fork are
// OMITTED, not stubbed — capability is method presence, so capabilitiesOf reports
// continue:false/fork:false with no boolean to keep in sync. [LAW:one-source-of-truth]

export interface TmuxProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly driver: CodeGenDriver;
}

// The single mapping from a driver snapshot to the seam's status. Total over the
// union: a new DriverSnapshot variant would stop this compiling at the `never`.
// Because only `succeeded` carries html and only `failed` carries a message, the
// illegal pairings are unrepresentable here too. [LAW:types-are-the-program]
const statusOf = (snapshot: DriverSnapshot): SessionStatus => {
  switch (snapshot.state) {
    case 'running':
      return { state: 'running' };
    case 'succeeded':
      return { state: 'succeeded', result: { artifact: { html: snapshot.html } } };
    case 'failed':
      return { state: 'failed', error: { message: snapshot.message } };
    default: {
      const unreachable: never = snapshot;
      return unreachable;
    }
  }
};

export const makeTmuxProvider = (config: TmuxProviderConfig): Provider => {
  const providerId = ProviderId(config.id);
  const { driver } = config;

  // The provider owns the identity space. A turn always gets a fresh turnId; a NEW
  // session also gets a fresh sessionId, while a follow-up turn reuses the caller's
  // sessionId so successive versions stay one session. Minting a turn lives in one
  // place so start and continue cannot diverge on identity. [LAW:one-source-of-truth]
  const mintTurn = (sessionId: SessionId): SessionHandle => ({
    providerId,
    sessionId,
    turnId: TurnId(`turn-${randomUUID()}`),
  });
  const mintHandle = (): SessionHandle => mintTurn(SessionId(`session-${randomUUID()}`));

  async function startSession(brief: Brief): Promise<SessionHandle> {
    const handle = mintHandle();
    await driver.begin(brief, handle);
    return handle;
  }

  // Continue an existing session with a follow-up: mint a fresh turn pinned to the
  // SAME session, then resume the prior turn through the driver. Symmetric to
  // startSession — same orchestration, the only difference is which driver effect and
  // which session id, both carried as values. The driver owns the resume effect; this
  // body stays ignorant of tmux. [LAW:dataflow-not-control-flow] [LAW:effects-at-boundaries]
  async function continueSession(prior: SessionHandle, followUp: Brief): Promise<SessionHandle> {
    const handle = mintTurn(prior.sessionId);
    await driver.continue(followUp, handle, prior);
    return handle;
  }

  async function getStatus(handle: SessionHandle): Promise<SessionStatus> {
    return statusOf(await driver.poll(handle));
  }

  // Await the turn to terminal, then resolve on success or reject (carrying the
  // surfaced message) on failure. 'running' is not a distinct outcome — it just
  // continues the loop, so an early caller sees an unsettled promise, never a
  // placeholder. The loop terminates because driver.poll is contracted to settle.
  // [LAW:types-are-the-program] [LAW:no-silent-failure]
  async function getResult(handle: SessionHandle): Promise<GenerationResult> {
    for (;;) {
      const status = await getStatus(handle);
      if (status.state === 'succeeded') return status.result;
      if (status.state === 'failed') throw new Error(status.error.message);
    }
  }

  function streamProgress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
    return driver.progress(handle);
  }

  function getAvailability(): Promise<Availability> {
    return driver.isAvailable();
  }

  // continueSession is PRESENT, so capabilitiesOf reports continue:true for the real
  // provider — capability is method presence, no boolean to keep in sync. fork stays
  // omitted until the remix epic. [LAW:one-source-of-truth]
  return {
    id: providerId,
    label: config.label,
    startSession,
    getStatus,
    streamProgress,
    getResult,
    getAvailability,
    continueSession,
  };
};
