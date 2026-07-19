import type { Provider } from './provider.js';
import type {
  Artifact,
  Availability,
  Brief,
  GenerationResult,
  ProgressEvent,
  SessionHandle,
  SessionStatus,
} from './types.js';
import { ProviderId, SessionId, TurnId } from './types.js';

// A REAL provider that satisfies the full Provider seam but serves a canned, scripted
// CONVERSATION instead of calling any upstream. Unlike the __fixtures__ fake (which DERIVES
// its html from the brief so the contract suite can assert the input round-trips), this one
// is genuinely canned: a turn's outcome is fixed by its POSITION in the conversation, not by
// what the user typed — so every session replays the same deterministic create → refine →
// refine walk. That determinism is the whole point: it is the instrument the rest of
// providers-u1h wires its edge seams against (real ArtifactValidator, durable quota, catalog
// normalization, render enqueue) WITHOUT a metered/secret upstream. [LAW:one-type-per-behavior]
//
// It stays validator-IGNORANT: a "validation-failing artifact" is just an `artifact` outcome
// whose html throws on load — the ArtifactValidator seam, not this provider, owns that
// judgment. So the only outcomes it knows are `artifact` (a file) and `failure` (a surfaced
// generation error), mirroring SessionStatus's succeeded/failed exactly. [LAW:single-enforcer]

// One canned turn's terminal result. The two kinds mirror the two terminal SessionStatus
// states, so an artifact-with-no-file or a failure-with-a-file is unrepresentable.
// [LAW:types-are-the-program]
export type ScriptedOutcome =
  | { readonly kind: 'artifact'; readonly html: string }
  | { readonly kind: 'failure'; readonly message: string };

// One turn of the scripted conversation: the assistant lines streamed while it "generates"
// (the live-chat content), how many status reads report `running` before it settles (so the
// await-until-terminal contract is exercised, not only the instant case), and what it settles
// to.
export interface ScriptedTurn {
  readonly progress: readonly string[];
  readonly runningPolls?: number;
  readonly outcome: ScriptedOutcome;
}

// A canned conversation: a NON-EMPTY ordered list of turns. The non-empty tuple makes "there
// is always a turn 0 to start from" a fact the type carries, so startSession/fork need no
// runtime guard for an empty script. [LAW:types-are-the-program] [LAW:no-defensive-null-guards]
export interface MockConversation {
  readonly turns: readonly [ScriptedTurn, ...ScriptedTurn[]];
}

export interface MockProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly conversation: MockConversation;
  readonly availability?: Availability;
}

// The single-enforcer parse of the mock-provider switch (TINKERPAD_MOCK_PROVIDER), shared by every
// composition root that reads it — the edge Worker and the Node dev entry — so its meaning cannot
// drift between them. Only 'true'/'false'/absent are legal; a typo'd value bricks startup by name
// rather than silently defaulting generation off (or on). [LAW:no-silent-failure] [LAW:single-enforcer]
export const parseMockProviderEnabled = (raw: string | undefined): boolean => {
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`TINKERPAD_MOCK_PROVIDER must be "true" or "false" (got ${JSON.stringify(raw)})`);
};

// A turn resolved against a session's position in the script: the fixed lines/outcome plus the
// countdown of `running` reads still owed before it settles (the only mutable field).
interface ResolvedTurn {
  readonly progress: readonly string[];
  readonly outcome: ScriptedOutcome;
  runningLeft: number;
}

export const makeMockProvider = (config: MockProviderConfig): Provider => {
  const providerId = ProviderId(config.id);
  const availability: Availability = config.availability ?? { state: 'available' };
  const { turns } = config.conversation;

  // Every turn ever begun, by turn id, for O(1) status/progress lookup; and the ordered turn
  // ids per session, so a follow-up resolves against the session's NEXT position in the script.
  const resolvedTurns = new Map<string, ResolvedTurn>();
  const sessionTurns = new Map<string, TurnId[]>();
  let minted = 0;

  // The scripted turn at a session position, CLAMPED to the last so a conversation that runs
  // past its script keeps replaying its final turn rather than dead-ending. The clamp lands in
  // [0, length-1] of a non-empty tuple, so it is total — the throw is a loud assertion of that
  // impossibility, never a silent substitution. [LAW:no-silent-failure]
  const scriptAt = (position: number): ScriptedTurn => {
    const turn = turns[Math.min(position, turns.length - 1)];
    if (turn === undefined) throw new Error('unreachable: clamped index fell outside a non-empty script');
    return turn;
  };

  const resolve = (turn: ScriptedTurn, outcome: ScriptedOutcome): ResolvedTurn => ({
    progress: turn.progress,
    outcome,
    runningLeft: turn.runningPolls ?? 0,
  });

  const beginTurn = (sessionId: SessionId, resolved: ResolvedTurn): SessionHandle => {
    const turnId = TurnId(`turn-${(minted += 1)}`);
    resolvedTurns.set(turnId, resolved);
    sessionTurns.set(sessionId, [...(sessionTurns.get(sessionId) ?? []), turnId]);
    return { providerId, sessionId, turnId };
  };

  const turnOf = (handle: SessionHandle): ResolvedTurn => {
    const turn = resolvedTurns.get(handle.turnId);
    if (turn === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return turn;
  };

  async function startSession(_brief: Brief): Promise<SessionHandle> {
    const sessionId = SessionId(`session-${(minted += 1)}`);
    const turn = scriptAt(0);
    return beginTurn(sessionId, resolve(turn, turn.outcome));
  }

  // A follow-up advances the SAME session to its next script position — canned data by turn
  // index is what makes the multi-turn refine loop deterministic regardless of what is typed.
  async function continueSession(handle: SessionHandle, _followUp: Brief, _seed: Artifact): Promise<SessionHandle> {
    const position = (sessionTurns.get(handle.sessionId) ?? []).length;
    const turn = scriptAt(position);
    return beginTurn(handle.sessionId, resolve(turn, turn.outcome));
  }

  // A fork mints a NEW session whose genesis artifact IS the seed — the remix begins where the
  // parent is, handed across the seam as a value. Its lines come from the script's turn 0 (the
  // canned "generating" chatter) but its outcome is the seed, not a scripted artifact, so the
  // fork faithfully continues the forked file. [LAW:dataflow-not-control-flow] [LAW:one-source-of-truth]
  async function fork(_parent: SessionHandle, seed: Artifact): Promise<SessionHandle> {
    const sessionId = SessionId(`session-${(minted += 1)}`);
    return beginTurn(sessionId, resolve(scriptAt(0), { kind: 'artifact', html: seed.html }));
  }

  async function getStatus(handle: SessionHandle): Promise<SessionStatus> {
    const turn = turnOf(handle);
    if (turn.runningLeft > 0) {
      turn.runningLeft -= 1;
      return { state: 'running' };
    }
    return turn.outcome.kind === 'artifact'
      ? { state: 'succeeded', result: { artifact: { html: turn.outcome.html } } }
      : { state: 'failed', error: { message: turn.outcome.message } };
  }

  // The canned lines as data flowing out of the turn. `at` is the line's index — a deterministic
  // ordinal, not a clock read, so a canned provider introduces no timing variance of its own.
  async function* streamProgress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
    const turn = turnOf(handle);
    for (const [at, message] of turn.progress.entries()) yield { at, message };
  }

  // Await the turn to terminal, then resolve or reject. A `running` read just continues the
  // loop — it is not a distinct outcome. [LAW:no-defensive-null-guards]
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

  // continueSession and fork are ALWAYS present: the mock exists to drive the full interactive
  // create → refine → remix loop, so both capabilities are part of what it is. Capability is
  // method presence, so the registry reports { continue: true, fork: true } with no extra flag.
  return {
    id: providerId,
    label: config.label,
    startSession,
    getStatus,
    streamProgress,
    getResult,
    getAvailability,
    continueSession,
    fork,
  };
};
