import { describe, expect, it } from 'vitest';
import type { ProgressEvent, SessionStatus } from './types.js';
import { makeFakeProvider } from './__fixtures__/fakeProvider.js';

// These tests assert the CONTRACT of the seam — what an implementation must do —
// not how the fake does it. [LAW:behavior-not-structure] Any provider (the tmux
// one, p0v.3) must satisfy them.

describe('Provider seam contract', () => {
  it('carries a generation through start → status(succeeded) → result, with the file intact', async () => {
    const provider = makeFakeProvider({ id: 'p', label: 'P', outcome: 'success' });
    const handle = await provider.startSession({ description: 'a wave explorer' });
    expect(handle.providerId).toBe(provider.id);

    const status = await provider.getStatus(handle);
    expect(status.state).toBe('succeeded');
    if (status.state !== 'succeeded') throw new Error('unreachable');
    expect(status.result.artifact.html).toContain('a wave explorer');

    const result = await provider.getResult(handle);
    expect(result.artifact.html).toBe(status.result.artifact.html);
  });

  it('on failure, surfaces the error and never yields an empty file', async () => {
    const provider = makeFakeProvider({ id: 'p', label: 'P', outcome: { fail: 'skill crashed' } });
    const handle = await provider.startSession({ description: 'anything' });

    const status = await provider.getStatus(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error.message).toBe('skill crashed');

    await expect(provider.getResult(handle)).rejects.toThrow('skill crashed');
  });

  it('getResult awaits a non-terminal turn through to success — early is not a distinct outcome', async () => {
    // The turn reports `running` twice before it succeeds; getResult must wait it
    // out rather than reject or return early. [LAW:types-are-the-program]
    const provider = makeFakeProvider({ id: 'p', label: 'P', outcome: 'success', runningPolls: 2 });
    const handle = await provider.startSession({ description: 'slow one' });
    expect((await provider.getStatus(handle)).state).toBe('running');

    const result = await provider.getResult(handle);
    expect(result.artifact.html).toContain('slow one');
  });

  it('every handle pins its own turn — a follow-up turn gets a distinct id in the same session', async () => {
    const provider = makeFakeProvider({ id: 'p', label: 'P', outcome: 'success', iterable: true });
    const first = await provider.startSession({ description: 'v1' });
    const second = await provider.continueSession!(first, { description: 'v2' });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.providerId).toBe(first.providerId);
  });

  it('streams progress as data flowing out of the session', async () => {
    const provider = makeFakeProvider({ id: 'p', label: 'P', outcome: 'success' });
    const handle = await provider.startSession({ description: 'x' });
    const events: ProgressEvent[] = [];
    for await (const event of provider.streamProgress(handle)) events.push(event);
    expect(events.map((e) => e.message)).toEqual(['started', 'finished']);
  });

  it('SessionStatus is exhaustive — every state is handled, by construction', () => {
    // A total function over the union: if a variant were added, this stops
    // compiling at the `never`. The test is the type check; the runtime asserts a
    // sane label per state. [LAW:types-are-the-program]
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
