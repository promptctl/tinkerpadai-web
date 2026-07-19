import { describe, expect, it } from 'vitest';
import { makeMockProvider } from './mockProvider.js';
import type { MockConversation } from './mockProvider.js';

// The mock provider's OWN contract. It cannot ride the shared describeProviderContract suite
// because that suite asserts the result html round-trips the brief (a brief-DERIVED property);
// this provider is canned, so its results are fixed by turn POSITION and deliberately ignore
// the brief. These assertions are that canned contract. [LAW:behavior-not-structure]

const twoTurnScript: MockConversation = {
  turns: [
    { progress: ['start v1', 'done v1'], outcome: { kind: 'artifact', html: '<!-- canned v1 -->' } },
    { progress: ['start v2'], outcome: { kind: 'artifact', html: '<!-- canned v2 -->' } },
  ],
};

const make = (conversation: MockConversation = twoTurnScript) =>
  makeMockProvider({ id: 'mock', label: 'Mock', conversation });

describe('makeMockProvider', () => {
  it('serves the FIRST canned artifact from start, ignoring the brief', async () => {
    const provider = make();
    const handle = await provider.startSession({ description: 'a wave explorer nobody scripted' });
    expect(handle.providerId).toBe(provider.id);

    const status = await provider.getStatus(handle);
    expect(status.state).toBe('succeeded');
    if (status.state !== 'succeeded') throw new Error('unreachable');
    // Canned, not derived: the artifact is the script's, and does NOT echo the brief.
    expect(status.result.artifact.html).toBe('<!-- canned v1 -->');
    expect(status.result.artifact.html).not.toContain('wave explorer');
  });

  it('awaits a non-terminal turn through to success — runningPolls is exercised', async () => {
    const provider = make({
      turns: [{ progress: ['x'], runningPolls: 2, outcome: { kind: 'artifact', html: '<!-- slow -->' } }],
    });
    const handle = await provider.startSession({ description: 'anything' });
    expect((await provider.getStatus(handle)).state).toBe('running');
    expect((await provider.getStatus(handle)).state).toBe('running');
    expect((await provider.getResult(handle)).artifact.html).toBe('<!-- slow -->');
  });

  it('a follow-up advances to the NEXT scripted turn in the same session', async () => {
    const provider = make();
    if (provider.continueSession === undefined) throw new Error('mock must implement continueSession');
    const first = await provider.startSession({ description: 'v1' });
    const second = await provider.continueSession(first, { description: 'change it' }, { html: '<!-- canned v1 -->' });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turnId).not.toBe(first.turnId);

    const status = await provider.getStatus(second);
    if (status.state !== 'succeeded') throw new Error('unreachable');
    expect(status.result.artifact.html).toBe('<!-- canned v2 -->');
  });

  it('clamps past the end of the script — a conversation never dead-ends, it replays the last turn', async () => {
    const provider = make();
    if (provider.continueSession === undefined) throw new Error('mock must implement continueSession');
    const first = await provider.startSession({ description: 'v1' });
    const second = await provider.continueSession(first, { description: 'v2' }, { html: '<!-- canned v1 -->' });
    const third = await provider.continueSession(second, { description: 'v3, past the script' }, { html: '<!-- canned v2 -->' });

    const status = await provider.getStatus(third);
    if (status.state !== 'succeeded') throw new Error('unreachable');
    expect(status.result.artifact.html).toBe('<!-- canned v2 -->');
  });

  it('forks into a NEW independent session whose genesis artifact IS the seed', async () => {
    const provider = make();
    if (provider.fork === undefined) throw new Error('mock must implement fork');
    const parent = await provider.startSession({ description: 'original' });
    const forked = await provider.fork(parent, { html: '<!-- forked seed -->' });

    expect(forked.sessionId).not.toBe(parent.sessionId);
    expect(forked.turnId).not.toBe(parent.turnId);

    const status = await provider.getStatus(forked);
    if (status.state !== 'succeeded') throw new Error('unreachable');
    expect(status.result.artifact.html).toBe('<!-- forked seed -->');
  });

  it('on a failure turn, surfaces the reason and never yields an empty file', async () => {
    const provider = make({
      turns: [{ progress: ['boom'], outcome: { kind: 'failure', message: 'skill crashed' } }],
    });
    const handle = await provider.startSession({ description: 'anything' });

    const status = await provider.getStatus(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error.message).toBe('skill crashed');

    await expect(provider.getResult(handle)).rejects.toThrow('skill crashed');
  });

  it('streams the canned lines in order as data flowing out of the turn', async () => {
    const provider = make();
    const handle = await provider.startSession({ description: 'x' });
    const events = [];
    for await (const event of provider.streamProgress(handle)) events.push(event);
    expect(events).toEqual([
      { at: 0, message: 'start v1' },
      { at: 1, message: 'done v1' },
    ]);
  });

  it('advertises continue and fork as present capabilities', () => {
    const provider = make();
    expect(typeof provider.continueSession).toBe('function');
    expect(typeof provider.fork).toBe('function');
  });

  it('reports its configured availability', async () => {
    const available = make();
    expect(await available.getAvailability()).toEqual({ state: 'available' });

    const down = makeMockProvider({
      id: 'mock',
      label: 'Mock',
      conversation: twoTurnScript,
      availability: { state: 'unavailable', reason: 'canned as down' },
    });
    expect(await down.getAvailability()).toEqual({ state: 'unavailable', reason: 'canned as down' });
  });
});
