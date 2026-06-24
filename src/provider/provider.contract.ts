import { expect, it } from 'vitest';
import type { Provider } from './provider.js';
import type { Availability, ProgressEvent } from './types.js';

// The Provider seam's contract, expressed ONCE as assertions over an abstract
// factory and run against every implementation (the fake, the tmux provider). The
// suite asserts WHAT a provider must do — carry a brief to a result, surface
// failures without an empty file, await non-terminal turns — never HOW any of them
// does it. [LAW:behavior-not-structure] [LAW:one-source-of-truth]

// The knobs a contract-testable provider must expose so the suite can drive it
// through success, failure, and a non-terminal→terminal transition. This is the
// single source of truth for those knobs; both the fake provider and the scripted
// tmux driver accept exactly this. [LAW:one-source-of-truth]
export interface ContractProviderOptions {
  readonly id: string;
  readonly label: string;
  // What a turn resolves to. 'success' produces html derived from the brief; a
  // failure carries a surfaced reason — never a silent empty file.
  readonly outcome: 'success' | { readonly fail: string };
  // How many status reads report `running` before the turn settles, so the
  // await-until-terminal contract is exercised, not only the instant case.
  readonly runningPolls?: number;
  readonly availability?: Availability;
  // Whether the optional iterate/remix methods are present. A one-shot provider
  // leaves this unset and the iterate contract below simply does not apply to it.
  readonly iterable?: boolean;
}

export type ContractProviderFactory = (opts: ContractProviderOptions) => Provider;

// The baseline every provider must satisfy. Registered under a caller-supplied name
// so the same assertions appear once per implementation in the test output.
export const describeProviderContract = (make: ContractProviderFactory): void => {
  it('carries a generation through start → status(succeeded) → result, with the file intact', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success' });
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
    const provider = make({ id: 'p', label: 'P', outcome: { fail: 'skill crashed' } });
    const handle = await provider.startSession({ description: 'anything' });

    const status = await provider.getStatus(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error.message).toBe('skill crashed');

    await expect(provider.getResult(handle)).rejects.toThrow('skill crashed');
  });

  it('getResult awaits a non-terminal turn through to success — early is not a distinct outcome', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success', runningPolls: 2 });
    const handle = await provider.startSession({ description: 'slow one' });
    expect((await provider.getStatus(handle)).state).toBe('running');

    const result = await provider.getResult(handle);
    expect(result.artifact.html).toContain('slow one');
  });

  it('streams progress as data flowing out of the session', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success' });
    const handle = await provider.startSession({ description: 'x' });
    const events: ProgressEvent[] = [];
    for await (const event of provider.streamProgress(handle)) events.push(event);
    expect(events.map((e) => e.message)).toEqual(['started', 'finished']);
  });
};

// The iterate capability's contract. Applies ONLY to providers that implement
// continueSession — capability is method presence, so a one-shot provider is not
// expected to satisfy this and the suite is simply not registered for it.
// [LAW:dataflow-not-control-flow]
export const describeIterateContract = (make: ContractProviderFactory): void => {
  it('every handle pins its own turn — a follow-up turn gets a distinct id in the same session', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success', iterable: true });
    if (provider.continueSession === undefined) {
      throw new Error('describeIterateContract requires a provider that implements continueSession');
    }
    const first = await provider.startSession({ description: 'v1' });
    const second = await provider.continueSession(first, { description: 'v2' }, { html: '<!-- v1 -->' });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turnId).not.toBe(first.turnId);
    expect(second.providerId).toBe(first.providerId);
  });

  it('a continued turn carries through to its own succeeded result, distinct from the first', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success', iterable: true });
    if (provider.continueSession === undefined) {
      throw new Error('describeIterateContract requires a provider that implements continueSession');
    }
    const first = await provider.startSession({ description: 'a counter' });
    const firstResult = await provider.getResult(first);

    const second = await provider.continueSession(
      first,
      { description: 'add a reset button' },
      firstResult.artifact,
    );
    const status = await provider.getStatus(second);
    expect(status.state).toBe('succeeded');
    if (status.state !== 'succeeded') throw new Error('unreachable');
    // The follow-up brief, not the original, drives the new turn's artifact — so the
    // continued version is genuinely a new version, not a replay of the first.
    expect(status.result.artifact.html).toContain('add a reset button');
    expect(status.result.artifact.html).not.toBe(firstResult.artifact.html);
  });
};

// The remix capability's contract. Applies ONLY to providers that implement fork —
// capability is method presence, so a provider without it is simply not registered for
// this suite. fork takes the parent handle and a `seed` (the parent's current artifact,
// a value crossing the seam), and yields a NEW independent session seeded from it.
// [LAW:dataflow-not-control-flow]
export const describeRemixContract = (make: ContractProviderFactory): void => {
  it('forks into a NEW independent session — distinct session and turn, same provider', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success', iterable: true });
    if (provider.fork === undefined) {
      throw new Error('describeRemixContract requires a provider that implements fork');
    }
    const parent = await provider.startSession({ description: 'a counter' });
    const forked = await provider.fork(parent, { html: '<!-- a counter -->' });

    // A fork is a NEW session, not another turn of the parent's — its identity is wholly
    // distinct so the two sessions iterate independently. [LAW:decomposition]
    expect(forked.sessionId).not.toBe(parent.sessionId);
    expect(forked.turnId).not.toBe(parent.turnId);
    expect(forked.providerId).toBe(parent.providerId);
  });

  it('a fork starts from the seed — its genesis version reflects the forked artifact, not a fresh brief', async () => {
    const provider = make({ id: 'p', label: 'P', outcome: 'success', iterable: true });
    if (provider.fork === undefined) {
      throw new Error('describeRemixContract requires a provider that implements fork');
    }
    const parent = await provider.startSession({ description: 'original sketch' });
    const seed = (await provider.getResult(parent)).artifact;

    const forked = await provider.fork(parent, seed);
    const status = await provider.getStatus(forked);
    expect(status.state).toBe('succeeded');
    if (status.state !== 'succeeded') throw new Error('unreachable');
    // The fork is seeded from the parent's CURRENT artifact, handed across the seam as a
    // value — so the independent branch begins where the parent is, not from an empty
    // brief. [LAW:one-source-of-truth]
    expect(status.result.artifact.html).toBe(seed.html);
  });
};
