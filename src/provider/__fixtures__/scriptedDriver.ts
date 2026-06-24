import type { CodeGenDriver, DriverSnapshot } from '../codeGenDriver.js';
import type { ContractProviderOptions } from '../provider.contract.js';
import type { Artifact, Brief, ProgressEvent, SessionHandle } from '../types.js';

// A CodeGenDriver test double: it stands in for "drive Claude Code over tmux" so the
// real orchestration (tmuxProvider) can be run through the provider contract with no
// processes, files, or clocks. Its existence proves the effect boundary is honest —
// the provider body never reaches past this port. [LAW:effects-at-boundaries]
//
// It models time passing the same way the fake provider does: a per-turn countdown
// of `running` reads before the turn settles, so the await-until-terminal contract
// is exercised deterministically rather than via sleeps. [LAW:no-ambient-temporal-coupling]

// The html a succeeded poll yields, fixed when the turn is created: derived from the
// brief for begin/continue, taken from the seed for a fork — so a fork's genesis version
// reflects the forked artifact rather than a brief it never carried.
interface TurnState {
  readonly html: string;
  runningLeft: number;
}

export const makeScriptedDriver = (opts: ContractProviderOptions): CodeGenDriver => {
  const availability = opts.availability ?? { state: 'available' };
  const turns = new Map<string, TurnState>();

  const turnOf = (handle: SessionHandle): TurnState => {
    const turn = turns.get(handle.turnId);
    if (turn === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return turn;
  };

  return {
    async isAvailable() {
      return availability;
    },

    async begin(brief: Brief, handle: SessionHandle): Promise<void> {
      turns.set(handle.turnId, { html: `<!-- ${brief.description} -->`, runningLeft: opts.runningPolls ?? 0 });
    },

    // A follow-up turn is, to this double, just a new turn carrying the follow-up
    // brief — enough to prove the orchestration mints fresh identity and surfaces a
    // distinct artifact. The real resume effect — and the warm/cold re-seed that uses
    // `_seed` — lives in the tmux driver; this double has no workdir to lose.
    async continue(
      brief: Brief,
      handle: SessionHandle,
      _priorHandle: SessionHandle,
      _seed: Artifact,
    ): Promise<void> {
      turns.set(handle.turnId, { html: `<!-- ${brief.description} -->`, runningLeft: opts.runningPolls ?? 0 });
    },

    // A fork is, to this double, a new turn whose artifact IS the seed — proving the
    // orchestration mints a fresh independent identity and starts from the forked file.
    // The real seed-into-a-new-workdir effect lives in the tmux driver; this double has
    // no workdir, so the seed is simply the html the turn will yield.
    async fork(handle: SessionHandle, seed: Artifact): Promise<void> {
      turns.set(handle.turnId, { html: seed.html, runningLeft: opts.runningPolls ?? 0 });
    },

    async poll(handle: SessionHandle): Promise<DriverSnapshot> {
      const turn = turnOf(handle);
      if (turn.runningLeft > 0) {
        turn.runningLeft -= 1;
        return { state: 'running' };
      }
      return opts.outcome === 'success'
        ? { state: 'succeeded', html: turn.html }
        : { state: 'failed', message: opts.outcome.fail };
    },

    async *progress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
      turnOf(handle);
      yield { at: 0, message: 'started' };
      yield { at: 1, message: 'finished' };
    },
  };
};
