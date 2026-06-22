import { describe, expect, it } from 'vitest';
import { makeFakeProvider } from './__fixtures__/fakeProvider.js';
import { makeScriptedDriver } from './__fixtures__/scriptedDriver.js';
import {
  type ContractProviderFactory,
  describeIterateContract,
  describeProviderContract,
} from './provider.contract.js';
import { makeTmuxProvider } from './tmuxProvider.js';
import type { SessionStatus } from './types.js';

// The seam's contract, run against every implementation. The fake proves the seam is
// implementable standalone; the tmux provider (driven by a scripted CodeGenDriver)
// proves the real orchestration satisfies the same contract with the effects stubbed
// at the port. Same assertions, no per-implementation special-casing.
// [LAW:behavior-not-structure]

const tmuxFactory: ContractProviderFactory = (opts) =>
  makeTmuxProvider({ id: opts.id, label: opts.label, driver: makeScriptedDriver(opts) });

describe('Provider seam contract: fake provider', () => describeProviderContract(makeFakeProvider));
describe('Provider seam contract: tmux provider (scripted driver)', () =>
  describeProviderContract(tmuxFactory));

// Iterate is a capability — only the fake implements it. The one-shot tmux provider
// omits continueSession, so this contract simply does not apply to it.
describe('Provider iterate contract: fake provider', () => describeIterateContract(makeFakeProvider));

describe('SessionStatus is exhaustive — every state is handled, by construction', () => {
  it('a total function over the union has no uncovered case', () => {
    // If a variant were added, this stops compiling at the `never`. The test is the
    // type check; the runtime asserts a sane label per state. [LAW:types-are-the-program]
    const label = (status: SessionStatus): string => {
      switch (status.state) {
        case 'pending':
          return 'pending';
        case 'running':
          return 'running';
        case 'succeeded':
          return `succeeded:${status.result.artifact.html.length}`;
        case 'failed':
          return status.error.message;
        default: {
          const unreachable: never = status;
          return unreachable;
        }
      }
    };

    expect(label({ state: 'pending' })).toBe('pending');
    expect(label({ state: 'failed', error: { message: 'boom' } })).toBe('boom');
  });
});
