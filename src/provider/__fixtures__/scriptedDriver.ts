import type { CodeGenDriver, DriverSnapshot } from '../codeGenDriver.js';
import type { ContractProviderOptions } from '../provider.contract.js';
import type { Brief, ProgressEvent, SessionHandle } from '../types.js';

// A CodeGenDriver test double: it stands in for "drive Claude Code over tmux" so the
// real orchestration (tmuxProvider) can be run through the provider contract with no
// processes, files, or clocks. Its existence proves the effect boundary is honest —
// the provider body never reaches past this port. [LAW:effects-at-boundaries]
//
// It models time passing the same way the fake provider does: a per-turn countdown
// of `running` reads before the turn settles, so the await-until-terminal contract
// is exercised deterministically rather than via sleeps. [LAW:no-ambient-temporal-coupling]

interface TurnState {
  readonly brief: Brief;
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
      turns.set(handle.turnId, { brief, runningLeft: opts.runningPolls ?? 0 });
    },

    async poll(handle: SessionHandle): Promise<DriverSnapshot> {
      const turn = turnOf(handle);
      if (turn.runningLeft > 0) {
        turn.runningLeft -= 1;
        return { state: 'running' };
      }
      return opts.outcome === 'success'
        ? { state: 'succeeded', html: `<!-- ${turn.brief.description} -->` }
        : { state: 'failed', message: opts.outcome.fail };
    },

    async *progress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
      turnOf(handle);
      yield { at: 0, message: 'started' };
      yield { at: 1, message: 'finished' };
    },
  };
};
