import { describe, expect, it, vi } from 'vitest';
import { Subject } from '../identity/index.js';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import type { ContractProviderOptions } from '../provider/provider.contract.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { Brief, Provider, SessionHandle, SessionStatus } from '../provider/index.js';
import {
  currentVersionOf,
  makeMemoryArtifactStore,
  makeMemoryCatalog,
  PlaygroundId,
  PlaygroundNotFoundError,
} from '../storage/index.js';
import type { ArtifactStore } from '../storage/index.js';
import {
  makeGenerationService,
  ProviderCannotContinueError,
  ProviderCannotForkError,
  startTurnRetentionSweeper,
} from './generationService.js';
import type { GenerationService, GenerationStatus } from './generationService.js';
import { makeTestQuota } from './__fixtures__/testQuota.js';
import { makeGenerationQuota, QuotaExceededError } from './generationQuota.js';
import type { GenerationQuota } from './generationQuota.js';
import { FunctionalDefectError, passThroughValidator } from './artifactValidation.js';
import type { ArtifactValidator } from './artifactValidation.js';

// The generation service's contract: it wires a chosen provider to the store and
// catalog, persists exactly once on success, surfaces failure without writing anything,
// and stays agnostic to which provider it drives. The assertions are over OBSERVABLE
// behavior (what ends up in the store/catalog, what poll returns) — never how it gets
// there. [LAW:behavior-not-structure]

interface Harness {
  readonly service: GenerationService;
  readonly store: ArtifactStore;
  readonly catalog: ReturnType<typeof makeMemoryCatalog>;
  readonly disposed: SessionHandle[];
  // The reason threaded to the disposer for each disposed turn, in order — the surfaced failure the
  // Node root preserves into the diagnostics record (ppu.4). Parallel to `disposed`. [LAW:one-source-of-truth]
  readonly disposedReasons: string[];
  readonly providerId: ProviderId;
}

const harnessFor = (
  opts: ContractProviderOptions & { readonly html?: string },
  disposeTurn?: (handle: SessionHandle, reason: string) => Promise<void>,
  quota: GenerationQuota = makeTestQuota(),
  // Default 1 = no retry, so every existing failure/dispose assertion sees exactly one attempt;
  // the retry suite opts into a larger budget.
  maxAttempts = 1,
  // Default pass-through, so every existing success assertion sees the artifact stored unconditionally;
  // the functional-gate suite injects a validator that rejects to exercise the built-but-broken path.
  validateArtifact: ArtifactValidator = passThroughValidator,
): Harness => {
  const registry = new ProviderRegistry();
  registry.register(makeFakeProvider(opts));
  const store = makeMemoryArtifactStore();
  const catalog = makeMemoryCatalog();
  const disposed: SessionHandle[] = [];
  const disposedReasons: string[] = [];
  const service = makeGenerationService({
    registry,
    store,
    catalog,
    disposeTurn:
      disposeTurn ??
      (async (handle, reason) => {
        disposed.push(handle);
        disposedReasons.push(reason);
      }),
    quota,
    maxAttempts,
    validateArtifact,
    now: () => Date.now(),
  });
  return { service, store, catalog, disposed, disposedReasons, providerId: ProviderId(opts.id) };
};

// The authenticated principal the gated write path would resolve. The service records it as the
// new playground's author; FORKER stands in for a different principal remixing someone else's
// playground, to prove a fork is authored by the forker, not the parent's author.
const AUTHOR = Subject('ada');
const FORKER = Subject('grace');
// The principal driving a refine. continue takes it only as the turn's quota subject (the
// playground keeps its own author), so which principal it is is immaterial to these tests.
const REFINER = Subject('lin');

const submit = (h: Harness, description: string): Promise<SessionHandle> =>
  h.service.submit({ providerId: h.providerId, brief: { description } }, AUTHOR);

describe('GenerationService.submit', () => {
  it('returns a handle pinned to the chosen provider', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'a wave explorer');
    expect(handle.providerId).toBe(h.providerId);
  });

  it('throws loudly when the chosen provider is unknown', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    await expect(
      h.service.submit({ providerId: ProviderId('nope'), brief: { description: 'x' } }, AUTHOR),
    ).rejects.toThrow('unknown provider: nope');
  });
});

describe('GenerationService.poll — success persists the file as a catalogued playground', () => {
  it('stores the artifact, records a playground, and reports ready with its id', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'a wave explorer');

    const status = await h.service.poll(handle);
    expect(status.state).toBe('ready');
    if (status.state !== 'ready') throw new Error('unreachable');

    const summaries = await h.catalog.listPlaygrounds();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(status.playgroundId);
    expect(summaries[0]?.prompt).toBe('a wave explorer');
    // The authenticated principal passed to submit is recorded as the playground's author.
    expect(summaries[0]?.author).toBe(AUTHOR);

    // The file actually landed in the store under the catalogued version.
    const version = summaries[0]?.currentVersion;
    if (version === undefined) throw new Error('no version');
    expect((await h.store.get(version)).html).toContain('a wave explorer');
  });

  // The post-generation extraction step runs on success: every new playground is classified into a
  // non-empty tag list derived from its describe prompt, so the commons is discoverable from the
  // first playground on. [LAW:no-silent-failure]
  it('classifies the new playground into non-empty topic tags derived from its prompt', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'a fractal geometry explorer with an interactive slider');
    const status = await h.service.poll(handle);
    if (status.state !== 'ready') throw new Error('unreachable');

    const summary = (await h.catalog.listPlaygrounds()).find((s) => s.id === status.playgroundId);
    const tags = summary?.tags.map(String) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    // The tags reflect the prompt's topics, not a fixed default.
    expect(tags).toContain('math');
    expect(tags).toContain('interactive');
  });

  it('does NOT release a successful turn — its workdir is the session continuable state', async () => {
    // A successful turn's workdir is what a follow-up (continue) resumes into, so the
    // service must not dispose it on success. Only failed turns, which leave nothing
    // continuable, are released.
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'x');
    await h.service.poll(handle);
    expect(h.disposed).toEqual([]);
  });

  it('persists exactly once across repeated polls of a settled turn', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'once only');

    const first = await h.service.poll(handle);
    const second = await h.service.poll(handle);
    expect(first).toEqual(second);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
  });

  it('persists exactly once even under concurrent polls of the same turn', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'race me');

    const [a, b] = await Promise.all([h.service.poll(handle), h.service.poll(handle)]);
    expect(a).toEqual(b);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
  });
});

describe('GenerationService.poll — releasing a failed turn never misreports its outcome', () => {
  it('reports failed even when disposeTurn throws, surfacing the fault loudly', async () => {
    // Only a failed turn is released (a successful one's workdir is continuable). A disposal
    // fault cannot unmake that settled failure: the outcome stays failed, the fault is
    // surfaced loudly (not swallowed) — never a rejection that would wedge the turn behind a
    // lie. [LAW:no-silent-failure]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: { fail: 'skill crashed' } }, async () => {
      throw new Error('rm failed');
    });
    const handle = await submit(h, 'doomed despite cleanup fault');

    const status = await h.service.poll(handle);
    expect(status).toEqual({ state: 'failed', error: 'skill crashed' });
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);

    // Re-polling still returns the settled failure, not a memoized disposal rejection.
    expect(await h.service.poll(handle)).toEqual(status);

    // The disposal fault was surfaced, not hidden. [LAW:no-silent-failure]
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});

describe('GenerationService.poll — failure is loud and writes nothing', () => {
  it('surfaces the error and records no playground and no artifact', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: { fail: 'skill crashed' } });
    const handle = await submit(h, 'doomed');

    const status = await h.service.poll(handle);
    expect(status).toEqual({ state: 'failed', error: 'skill crashed' });
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);
    // The turn is still released even though nothing was stored.
    expect(h.disposed).toEqual([handle]);
    // The surfaced reason is threaded to the disposer, so the diagnostics record states WHY the turn
    // failed — the failed create's evidence is preserved, not reaped blind (ppu.4). [LAW:one-source-of-truth]
    expect(h.disposedReasons).toEqual(['skill crashed']);
  });

  it('re-throws a non-self-containment store failure — an infra fault is NOT relabelled as a generation failure', async () => {
    // finalizeSuccess catches ONLY SelfContainmentError (a quality failure routed to the failed-turn
    // path). Any OTHER store error — a disk/backend fault — must propagate loudly, never be misrouted to
    // a {failed} status that would hide a real infra problem. [LAW:no-silent-failure]
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ id: 'fake', label: 'Fake', outcome: 'success' }));
    const store: ArtifactStore = { ...makeMemoryArtifactStore(), put: () => Promise.reject(new Error('disk full')) };
    const catalog = makeMemoryCatalog();
    const service = makeGenerationService({ registry, store, catalog, disposeTurn: async () => {}, quota: makeTestQuota(), maxAttempts: 1, validateArtifact: passThroughValidator, now: () => Date.now() });

    const handle = await service.submit({ providerId: ProviderId('fake'), brief: { description: 'x' } }, AUTHOR);
    await expect(service.poll(handle)).rejects.toThrow('disk full');
    expect(await catalog.listPlaygrounds()).toHaveLength(0);
  });
});

describe('GenerationService.poll — a provider that succeeds but yields a non-self-contained file', () => {
  it('routes the storage refusal to the failed-turn path — actionable message, nothing catalogued, turn released', async () => {
    // The provider SUCCEEDS but emits an external <script>. The store refuses it at the seam; the
    // service must translate that typed refusal into a FAILED generation (retry-able), never a 500 and
    // never a half-written playground. This is the observable proof of the single-enforcer + translation
    // seam working end to end. [LAW:no-silent-failure]
    const h = harnessFor({
      id: 'fake',
      label: 'Fake',
      outcome: 'success',
      html: '<script src="https://cdn.example.com/x.js"></script>',
    });
    const handle = await submit(h, 'a playground that cheats');

    const status = await h.service.poll(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error).toContain('not self-contained');
    expect(status.error).toContain('https://cdn.example.com/x.js');

    // Nothing entered the commons, and the create turn was released like any other failed first turn.
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);
    expect(h.disposed).toEqual([handle]);
    // The actionable refusal is the reason the diagnostics record preserves (ppu.4): the offending file
    // survives in the workdir, its rejection stated alongside. [LAW:one-source-of-truth]
    expect(h.disposedReasons[0]).toContain('not self-contained');
  });
});

describe('GenerationService.poll — a provider that succeeds but yields a built-but-broken file', () => {
  // A validator that rejects the way the real headless gate does: a TYPED FunctionalDefectError carrying
  // the uncaught errors observed on load (the wave-1 class: an uncaught TypeError, a script SyntaxError).
  const brokenValidator: ArtifactValidator = async () => {
    throw new FunctionalDefectError(["TypeError: Cannot read properties of null (reading 'appendChild')"]);
  };

  it('routes a functional defect to the failed-turn path — actionable message, nothing catalogued, turn released', async () => {
    // The provider SUCCEEDS and the file is self-contained, but it throws an uncaught error on load. The
    // functional gate must translate that typed defect into a FAILED generation, never a 500 and never a
    // catalogued-but-broken playground. This is the observable end-to-end proof the gate closes the
    // wave-1 leak. [LAW:no-silent-failure]
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' }, undefined, makeTestQuota(), 1, brokenValidator);
    const handle = await submit(h, 'a playground that throws on load');

    const status = await h.service.poll(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error).toContain('not functional');
    expect(status.error).toContain('uncaught');
    expect(status.error).toContain('TypeError');

    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);
    expect(h.disposed).toEqual([handle]);
    // The load errors live ONLY in the surfaced reason (the broken artifact itself is preserved in the
    // workdir); threading that reason to the disposer is what carries them into the diagnostics record,
    // satisfying the ppu.3 forward note. [LAW:one-source-of-truth]
    expect(h.disposedReasons[0]).toContain('not functional');
    expect(h.disposedReasons[0]).toContain('TypeError');
  });

  it('runs the gate BEFORE store.put — a broken artifact never enters storage', async () => {
    // The gate is upstream of the write, so a functionally-broken artifact costs no stored bytes: store.put
    // is never reached. A put-spy proves the ordering behaviorally. [LAW:effects-at-boundaries]
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ id: 'fake', label: 'Fake', outcome: 'success' }));
    const inner = makeMemoryArtifactStore();
    let putCalls = 0;
    const store: ArtifactStore = {
      get: inner.get,
      put: async (artifact) => {
        putCalls += 1;
        return inner.put(artifact);
      },
    };
    const catalog = makeMemoryCatalog();
    const service = makeGenerationService({
      registry,
      store,
      catalog,
      disposeTurn: async () => {},
      quota: makeTestQuota(),
      maxAttempts: 1,
      validateArtifact: brokenValidator,
      now: () => Date.now(),
    });

    const handle = await service.submit({ providerId: ProviderId('fake'), brief: { description: 'x' } }, AUTHOR);
    expect((await service.poll(handle)).state).toBe('failed');
    expect(putCalls).toBe(0);
    expect(await catalog.listPlaygrounds()).toHaveLength(0);
  });

  it('re-throws a non-FunctionalDefectError from the validator — an infra fault is NOT relabelled', async () => {
    // finalizeSuccess catches ONLY FunctionalDefectError. If the validator itself faults (its browser could
    // not launch), that is an infra problem that must propagate loudly, never be misrouted to a {failed}
    // status that hides it — exactly as a non-SelfContainmentError store fault propagates. [LAW:no-silent-failure]
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ id: 'fake', label: 'Fake', outcome: 'success' }));
    const catalog = makeMemoryCatalog();
    const service = makeGenerationService({
      registry,
      store: makeMemoryArtifactStore(),
      catalog,
      disposeTurn: async () => {},
      quota: makeTestQuota(),
      maxAttempts: 1,
      validateArtifact: async () => {
        throw new Error('chrome failed to launch');
      },
      now: () => Date.now(),
    });

    const handle = await service.submit({ providerId: ProviderId('fake'), brief: { description: 'x' } }, AUTHOR);
    await expect(service.poll(handle)).rejects.toThrow('chrome failed to launch');
    expect(await catalog.listPlaygrounds()).toHaveLength(0);
  });

  it('does NOT consume a retry — a built-but-broken artifact is TERMINAL, not retried', async () => {
    // Retry is a provider-'failed' concern (a transient crash worth another attempt). A functional defect is
    // a deterministic property of the produced file — retrying would only reproduce it — so it settles the
    // request immediately even with retry budget left, exactly as a self-containment refusal does. With
    // maxAttempts 2, one poll of a functionally-broken success yields `failed`, never a `running` retry.
    // [LAW:dataflow-not-control-flow]
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' }, undefined, makeTestQuota(), 2, brokenValidator);
    const handle = await submit(h, 'broken but with retry budget');

    const status = await h.service.poll(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error).toContain('not functional');
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);
    expect(h.disposed).toEqual([handle]);
  });

  it('a continue that produces a built-but-broken artifact fails, keeps the session, and appends nothing', async () => {
    // The append branch of the functional-defect translation: a REFINE that succeeds but throws on load
    // fails like any refine failure — session kept (prior version still continuable), nothing appended,
    // actionable message — never a 500 and never a released workdir.
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true }, undefined, makeTestQuota(), 1, brokenValidator);
    const seedVersion = await h.store.put({ html: '<!-- a counter -->' });
    const seed = await h.catalog.createPlayground({
      handle: { providerId: h.providerId, sessionId: SessionId('seed-session'), turnId: TurnId('seed-turn') },
      prompt: 'a counter',
      version: seedVersion,
      lineage: null,
      author: AUTHOR,
      tags: [],
    });

    const handle = await h.service.continue(seed.id, { description: 'add a reset button' }, REFINER);
    const status = await h.service.poll(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error).toContain('not functional');

    const playground = await h.catalog.getPlayground(seed.id);
    expect(playground.session.turns).toHaveLength(1);
    expect(currentVersionOf(playground.session)).toBe(seedVersion);
    // A failed refine keeps the session — reclaimOnFailure never releases an append target.
    expect(h.disposed).toEqual([]);
  });
});

describe('GenerationService.continue — refine an existing playground into a new version', () => {
  it('appends a second version to the same playground, current version being the follow-up', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const first = await submit(h, 'a counter');
    const ready = await h.service.poll(first);
    if (ready.state !== 'ready') throw new Error('unreachable');

    const second = await h.service.continue(ready.playgroundId, { description: 'add a reset button' }, REFINER);
    const continued = await h.service.poll(second);
    if (continued.state !== 'ready') throw new Error('unreachable');
    // The follow-up lands on the SAME playground, not a new one.
    expect(continued.playgroundId).toBe(ready.playgroundId);

    const playground = await h.catalog.getPlayground(ready.playgroundId);
    expect(playground.session.turns).toHaveLength(2);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);

    // The current version is the second turn's, and its stored file reflects the follow-up
    // brief — a genuine new version, not a replay of the first.
    const summaries = await h.catalog.listPlaygrounds();
    const current = summaries[0]?.currentVersion;
    if (current === undefined) throw new Error('no version');
    expect(current).toBe(playground.session.turns[1]?.version);
    expect((await h.store.get(current)).html).toContain('add a reset button');
  });

  it('a continue turn that fails appends nothing and surfaces the error', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: { fail: 'continue crashed' }, iterable: true });
    // Seed an existing playground for this provider's session directly: the first turn need
    // not have succeeded through this fail-outcome instance to exercise a failing continue.
    // The current artifact MUST be in the store — continue reads it as the seed it hands the
    // provider, an invariant every real continuable playground satisfies (finalizeSuccess put
    // it there). Storing it here makes the harness honor that invariant rather than fake it.
    const seedVersion = await h.store.put({ html: '<!-- a counter -->' });
    const seed = await h.catalog.createPlayground({
      handle: { providerId: h.providerId, sessionId: SessionId('seed-session'), turnId: TurnId('seed-turn') },
      prompt: 'a counter',
      version: seedVersion,
      lineage: null,
      author: AUTHOR,
      tags: [],
    });

    const handle = await h.service.continue(seed.id, { description: 'add a reset button' }, REFINER);
    const status = await h.service.poll(handle);
    expect(status).toEqual({ state: 'failed', error: 'continue crashed' });

    // Nothing was appended — the playground still has its single original turn.
    const playground = await h.catalog.getPlayground(seed.id);
    expect(playground.session.turns).toHaveLength(1);

    // A failed REFINE must NOT release the session: its prior version is still
    // continuable, and the session's workdir is the live state a subsequent refine
    // re-enters — releasing it would delete that state. Only a failed FIRST turn, which
    // leaves nothing continuable, is released (see the create-failure test above). This
    // is the disposal invariant carried by the turn's target value, not the provider.
    // [LAW:dataflow-not-control-flow]
    expect(h.disposed).toEqual([]);
  });

  it('a continue that produces a non-self-contained artifact fails, keeps the session, and appends nothing', async () => {
    // The append branch of the SelfContainmentError translation: a REFINE whose provider succeeds but
    // emits an external reference must fail like any refine failure — session kept (prior version still
    // continuable), nothing appended, actionable message — never a 500 and never a released workdir. The
    // provider's html override applies to the continue turn; submit is not run, so it is seeded directly.
    const h = harnessFor({
      id: 'fake',
      label: 'Fake',
      outcome: 'success',
      iterable: true,
      html: '<script src="https://evil.example.com/x.js"></script>',
    });
    const seedVersion = await h.store.put({ html: '<!-- a counter -->' });
    const seed = await h.catalog.createPlayground({
      handle: { providerId: h.providerId, sessionId: SessionId('seed-session'), turnId: TurnId('seed-turn') },
      prompt: 'a counter',
      version: seedVersion,
      lineage: null,
      author: AUTHOR,
      tags: [],
    });

    const handle = await h.service.continue(seed.id, { description: 'add a reset button' }, REFINER);
    const status = await h.service.poll(handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error).toContain('not self-contained');

    // Nothing appended; the original version is still current and continuable.
    const playground = await h.catalog.getPlayground(seed.id);
    expect(playground.session.turns).toHaveLength(1);
    expect(currentVersionOf(playground.session)).toBe(seedVersion);

    // The refine did NOT release the session — reclaimOnFailure keeps append sessions alive.
    expect(h.disposed).toEqual([]);
  });

  it('fails loudly when the playground provider cannot continue', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const first = await submit(h, 'a counter');
    const ready = await h.service.poll(first);
    if (ready.state !== 'ready') throw new Error('unreachable');

    await expect(
      h.service.continue(ready.playgroundId, { description: 'add a reset button' }, REFINER),
    ).rejects.toThrow(ProviderCannotContinueError);
  });

  it('fails loudly for an unknown playground id', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    await expect(
      h.service.continue(PlaygroundId('nope'), { description: 'x' }, REFINER),
    ).rejects.toThrow(PlaygroundNotFoundError);
  });
});

describe('GenerationService.fork — branch a playground into an independent lineaged session', () => {
  it('creates a NEW playground whose lineage points at the parent and its forked version', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const first = await submit(h, 'a counter');
    const ready = await h.service.poll(first);
    if (ready.state !== 'ready') throw new Error('unreachable');

    // The version forked from is the parent's current version at the moment of the fork.
    const parent = await h.catalog.getPlayground(ready.playgroundId);
    const forkedFromVersion = currentVersionOf(parent.session);

    const forkHandle = await h.service.fork(ready.playgroundId, FORKER);
    const forked = await h.service.poll(forkHandle);
    if (forked.state !== 'ready') throw new Error('unreachable');

    // The fork is a DISTINCT playground, not another version of the parent — the catalog
    // now holds two, and the parent is untouched (still one turn).
    expect(forked.playgroundId).not.toBe(ready.playgroundId);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(2);
    expect((await h.catalog.getPlayground(ready.playgroundId)).session.turns).toHaveLength(1);

    const child = await h.catalog.getPlayground(forked.playgroundId);
    // Lineage is recorded, pointing back at the parent session and the exact forked version.
    expect(child.session.lineage).toEqual({
      parentSession: parent.session.sessionId,
      forkedFromVersion,
    });
    // The fork is its own independent session, distinct from the parent's.
    expect(child.session.sessionId).not.toBe(parent.session.sessionId);
    // A remix is authored by the FORKER, not inherited from the parent's author — provenance
    // credits who made this copy. The parent keeps its own author.
    expect(child.session.author).toBe(FORKER);
    expect(parent.session.author).toBe(AUTHOR);
    // It carries no version-history conflation — a fresh playground has a single first turn.
    expect(child.session.turns).toHaveLength(1);
    // fork carries no user brief, so the new playground's first-turn prompt is the parent's
    // original describe.
    expect(child.session.turns[0]?.prompt).toBe('a counter');
    // The fork create path runs the SAME persist→deriveTags step submit does, so the fork is
    // classified too — from its first-turn prompt ('a counter' → the 'counter' tools keyword). This
    // guards the fork path independently: a refactor of fork's target or brief that dropped tagging
    // would fail here, not silently ship untagged forks. [LAW:behavior-not-structure]
    expect(child.session.tags.map(String)).toContain('tools');
  });

  it('fails loudly for an unknown playground id', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    await expect(h.service.fork(PlaygroundId('nope'), FORKER)).rejects.toThrow(PlaygroundNotFoundError);
  });

  it('fails loudly when the playground provider cannot fork', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const first = await submit(h, 'a counter');
    const ready = await h.service.poll(first);
    if (ready.state !== 'ready') throw new Error('unreachable');

    await expect(h.service.fork(ready.playgroundId, FORKER)).rejects.toThrow(ProviderCannotForkError);
  });

  it('a fork turn that fails creates nothing, leaves the parent untouched, and releases its own session', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: { fail: 'fork crashed' }, iterable: true });
    // Seed a parent playground directly (its first turn need not have succeeded through this
    // fail-outcome instance). The current artifact MUST be in the store — fork reads it as
    // the seed, an invariant every real playground satisfies (finalizeSuccess put it there).
    const seedVersion = await h.store.put({ html: '<!-- a counter -->' });
    const parent = await h.catalog.createPlayground({
      handle: { providerId: h.providerId, sessionId: SessionId('parent-session'), turnId: TurnId('parent-turn') },
      prompt: 'a counter',
      version: seedVersion,
      lineage: null,
      author: AUTHOR,
      tags: [],
    });

    const forkHandle = await h.service.fork(parent.id, FORKER);
    const status = await h.service.poll(forkHandle);
    expect(status).toEqual({ state: 'failed', error: 'fork crashed' });

    // No new playground was created — the catalog still holds only the parent, unchanged.
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
    const after = await h.catalog.getPlayground(parent.id);
    expect(after.session.turns).toHaveLength(1);
    expect(after.session.sessionId).toBe(SessionId('parent-session'));

    // A failed fork is a failed CREATE — nothing continuable, parent untouched — so its own
    // brand-new session is released, exactly as a failed first submit is. The parent's
    // session handle is NEVER what gets disposed. [LAW:dataflow-not-control-flow]
    expect(h.disposed).toEqual([forkHandle]);
    expect(h.disposed[0]?.sessionId).not.toBe(SessionId('parent-session'));
  });
});

describe('GenerationService.poll — non-terminal status passes through unchanged', () => {
  it('reports running while the turn is in flight, then ready once it settles', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', runningPolls: 1 });
    const handle = await submit(h, 'slow one');

    expect((await h.service.poll(handle)).state).toBe('running');
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);

    expect((await h.service.poll(handle)).state).toBe('ready');
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
  });
});

describe('GenerationService.poll — invalid handles fail loudly', () => {
  it('throws when polling a turn this service never started', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const foreign: SessionHandle = {
      providerId: h.providerId,
      sessionId: SessionId('session-foreign'),
      turnId: TurnId('turn-foreign'),
    };
    await expect(h.service.poll(foreign)).rejects.toThrow('unknown turn: turn-foreign');
  });
});

describe('GenerationService.listProviders', () => {
  it('lists the registered providers for selection', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const listed = h.service.listProviders();
    expect(listed.map((p) => p.id)).toEqual([h.providerId]);
  });
});

describe('GenerationService.availabilityOf — the live generation toggle', () => {
  it('reports the chosen provider available when it is', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    expect(await h.service.availabilityOf(h.providerId)).toEqual({ state: 'available' });
  });

  it('forwards the reason when the provider is unavailable', async () => {
    const h = harnessFor({
      id: 'fake',
      label: 'Fake',
      outcome: 'success',
      availability: { state: 'unavailable', reason: 'tmux not found' },
    });
    expect(await h.service.availabilityOf(h.providerId)).toEqual({
      state: 'unavailable',
      reason: 'tmux not found',
    });
  });

  it('throws loudly for an unknown provider rather than guessing', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    await expect(h.service.availabilityOf(ProviderId('ghost'))).rejects.toThrow(
      'unknown provider: ghost',
    );
  });
});

// The service's USE of the quota seam: it reserves at a turn's start and releases when the turn
// settles — enforcing the per-identity cap at the one boundary the generation effect crosses, and
// never leaking a slot. The quota's own counting is proven in generationQuota.test.ts; here we
// assert the wiring. [LAW:behavior-not-structure]
describe('GenerationService — per-identity generation quota', () => {
  it('refuses a submit that would exceed the concurrent cap while a turn is in flight', async () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' }, undefined, quota);
    // The first turn holds the one concurrent slot — it is started but never polled to terminal.
    await submit(h, 'a wave explorer');
    await expect(submit(h, 'a second one')).rejects.toThrow(QuotaExceededError);
  });

  it('frees the concurrent slot once a turn settles, admitting the next submit', async () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' }, undefined, quota);
    const first = await submit(h, 'a wave explorer');
    const settled = await h.service.poll(first); // settle → releases the slot
    if (settled.state !== 'ready') throw new Error('unreachable');
    // The freed slot admits the next generation.
    await expect(submit(h, 'a second one')).resolves.toBeDefined();
  });

  it('also frees the slot when a turn settles as FAILED', async () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: { fail: 'boom' } }, undefined, quota);
    const first = await submit(h, 'a wave explorer');
    const settled = await h.service.poll(first);
    expect(settled).toEqual({ state: 'failed', error: 'boom' });
    await expect(submit(h, 'a second one')).resolves.toBeDefined();
  });

  it('does not burn the daily budget on an invalid request that never reaches the provider', async () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 100, maxDaily: 1 }, now: () => 0 });
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' }, undefined, quota);
    // An unknown provider is rejected before any reservation — so the single daily slot is intact.
    await expect(
      h.service.submit({ providerId: ProviderId('nope'), brief: { description: 'x' } }, AUTHOR),
    ).rejects.toThrow('unknown provider');
    await expect(submit(h, 'the real one')).resolves.toBeDefined();
  });

  it('frees the slot when the provider fails to START a turn, so it does not leak', async () => {
    // A provider whose startSession rejects: the turn never comes to exist, so the service must
    // return the reserved concurrent slot right there (startTurn), not leak it forever.
    const registry = new ProviderRegistry();
    const base = makeFakeProvider({ id: 'boom', label: 'Boom', outcome: 'success' });
    registry.register({
      ...base,
      startSession: async () => {
        throw new Error('cannot start');
      },
    });
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    const service = makeGenerationService({
      registry,
      store: makeMemoryArtifactStore(),
      catalog: makeMemoryCatalog(),
      disposeTurn: async () => undefined,
      quota,
      maxAttempts: 1,
      validateArtifact: passThroughValidator,
      now: () => Date.now(),
    });
    const request = { providerId: ProviderId('boom'), brief: { description: 'x' } };
    await expect(service.submit(request, AUTHOR)).rejects.toThrow('cannot start');
    // If the failed start had leaked the one slot, this second attempt would be refused with a
    // QuotaExceededError; instead it reaches the provider and fails with the SAME start error.
    await expect(service.submit(request, AUTHOR)).rejects.toThrow('cannot start');
  });
});

// The retry contract (quality-ppu.2): a failed provider attempt is retried from the same brief, at
// the ONE turn-lifecycle boundary, up to the request's attempt budget — transparently to the client,
// which keeps polling its stable handle. The assertions are over OBSERVABLE behavior: what settles,
// what enters the catalog, which workdirs are reclaimed, and how many attempts actually started.
// [LAW:behavior-not-structure]

// A provider whose first `failFirst` attempts (counted across submit/continue/fork) report `failed`
// and every attempt after succeeds — the fixture the retry suite needs, since makeFakeProvider's
// outcome is fixed per instance. It counts starts so a test can prove a retry started EXACTLY one new
// attempt (single-flight), and can throw on a chosen start to model a retry that cannot even begin.
const makeFlakyProvider = (opts: {
  readonly id: string;
  readonly failFirst: number;
  readonly iterable?: boolean;
  readonly throwOnStart?: number;
}): { readonly provider: Provider; readonly starts: () => number } => {
  const providerId = ProviderId(opts.id);
  let started = 0;
  const turns = new Map<string, { readonly index: number; readonly html: string }>();

  // A fresh-session mint (startSession/fork) passes null; a continue passes the prior session id so
  // the appended turn belongs to the SAME session — exactly as the real provider pins it.
  const mint = (sessionId: SessionId | null, html: string): SessionHandle => {
    started += 1;
    if (opts.throwOnStart === started) throw new Error(`start #${started} exploded`);
    const turnId = TurnId(`flaky-turn-${started}`);
    turns.set(turnId, { index: started, html });
    return { providerId, sessionId: sessionId ?? SessionId(`flaky-session-${started}`), turnId };
  };
  const turnOf = (handle: SessionHandle): { readonly index: number; readonly html: string } => {
    const turn = turns.get(handle.turnId);
    if (turn === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return turn;
  };
  const statusOf = (handle: SessionHandle): SessionStatus => {
    const turn = turnOf(handle);
    return turn.index <= opts.failFirst
      ? { state: 'failed', error: { message: `attempt ${turn.index} failed` } }
      : { state: 'succeeded', result: { artifact: { html: turn.html } } };
  };
  const base: Provider = {
    id: providerId,
    label: opts.id,
    startSession: async (brief: Brief) => mint(null, `<!-- ${brief.description} -->`),
    getStatus: async (handle) => statusOf(handle),
    streamProgress: async function* (handle) {
      turnOf(handle);
      yield { at: 0, message: 'progress' };
    },
    getResult: async (handle) => {
      for (;;) {
        const status = statusOf(handle);
        if (status.state === 'succeeded') return status.result;
        if (status.state === 'failed') throw new Error(status.error.message);
      }
    },
    getAvailability: async () => ({ state: 'available' }),
  };
  if (opts.iterable !== true) return { provider: base, starts: () => started };
  return {
    provider: {
      ...base,
      continueSession: async (prior, followUp) => mint(prior.sessionId, `<!-- ${followUp.description} -->`),
      fork: async (_parent, seed) => mint(null, seed.html),
    },
    starts: () => started,
  };
};

interface FlakyHarness {
  readonly service: GenerationService;
  readonly store: ArtifactStore;
  readonly catalog: ReturnType<typeof makeMemoryCatalog>;
  readonly disposed: SessionHandle[];
  // The reason threaded to the disposer per reclaim, in order — proves an INTERMEDIATE retry reclaim
  // preserves its own attempt's failure, not only the terminal one (ppu.2/ppu.4 note). [LAW:one-source-of-truth]
  readonly disposedReasons: string[];
  readonly providerId: ProviderId;
  readonly starts: () => number;
}

const flakyHarness = (
  opts: { readonly id: string; readonly failFirst: number; readonly iterable?: boolean; readonly throwOnStart?: number },
  maxAttempts: number,
  quota: GenerationQuota = makeTestQuota(),
): FlakyHarness => {
  const registry = new ProviderRegistry();
  const { provider, starts } = makeFlakyProvider(opts);
  registry.register(provider);
  const store = makeMemoryArtifactStore();
  const catalog = makeMemoryCatalog();
  const disposed: SessionHandle[] = [];
  const disposedReasons: string[] = [];
  const service = makeGenerationService({
    registry,
    store,
    catalog,
    disposeTurn: async (handle, reason) => {
      disposed.push(handle);
      disposedReasons.push(reason);
    },
    quota,
    maxAttempts,
    validateArtifact: passThroughValidator,
    now: () => Date.now(),
  });
  return { service, store, catalog, disposed, disposedReasons, providerId: ProviderId(opts.id), starts };
};

// Poll a handle to its terminal outcome the way a real client does: repeatedly, until ready or
// failed — never asserting an exact number of `running` reads, since retry adds an
// implementation-timing number of them. [LAW:behavior-not-structure]
const pollToTerminal = async (service: GenerationService, handle: SessionHandle): Promise<GenerationStatus> => {
  for (let i = 0; i < 100; i += 1) {
    const status = await service.poll(handle);
    if (status.state === 'ready' || status.state === 'failed') return status;
  }
  throw new Error('turn did not settle within the poll budget');
};

// Seed a continuable/forkable playground directly for a provider id, honoring the invariant every real
// playground satisfies: its current artifact is in the store (continue/fork read it as the seed).
const seedPlayground = async (h: FlakyHarness, prompt: string): Promise<PlaygroundId> => {
  const version = await h.store.put({ html: `<!-- ${prompt} -->` });
  const playground = await h.catalog.createPlayground({
    handle: { providerId: h.providerId, sessionId: SessionId('seed-session'), turnId: TurnId('seed-turn') },
    prompt,
    version,
    lineage: null,
    author: AUTHOR,
    tags: [],
  });
  return playground.id;
};

describe('GenerationService.poll — retry: a failed provider attempt is retried from the same brief', () => {
  it('retries a create that fails once, then reports ready and catalogs the retried artifact', async () => {
    const h = flakyHarness({ id: 'flaky', failFirst: 1 }, 2);
    const handle = await h.service.submit({ providerId: h.providerId, brief: { description: 'a wave explorer' } }, AUTHOR);

    const status = await pollToTerminal(h.service, handle);
    expect(status.state).toBe('ready');

    // Exactly one retry started — the initial attempt plus one, never more.
    expect(h.starts()).toBe(2);

    // The playground is catalogued once, from the SUCCEEDING (second) attempt.
    const summaries = await h.catalog.listPlaygrounds();
    expect(summaries).toHaveLength(1);
    const version = summaries[0]?.currentVersion;
    if (version === undefined) throw new Error('no version');
    expect((await h.store.get(version)).html).toContain('a wave explorer');

    // The failed FIRST attempt's workdir was reclaimed — it is the client's original handle.
    expect(h.disposed).toEqual([handle]);
    // ...and its failure reason was threaded to the disposer, so the failed first attempt's evidence is
    // preserved even when the request ultimately SUCCEEDS on retry — not only when the budget is spent
    // (ppu.2/ppu.4 note). [LAW:one-source-of-truth]
    expect(h.disposedReasons).toEqual(['attempt 1 failed']);
  });

  it('surfaces failure only after the whole attempt budget is spent, reclaiming each failed attempt', async () => {
    const h = flakyHarness({ id: 'flaky', failFirst: 2 }, 2);
    const handle = await h.service.submit({ providerId: h.providerId, brief: { description: 'doomed' } }, AUTHOR);

    const status = await pollToTerminal(h.service, handle);
    // The surfaced message is the LAST attempt's, not the first.
    expect(status).toEqual({ state: 'failed', error: 'attempt 2 failed' });
    expect(h.starts()).toBe(2);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);
    // Both failed create attempts were reclaimed (the retry reclaimed the first, the settle the second).
    expect(h.disposed).toHaveLength(2);
    // Each reclaim threaded ITS OWN attempt's reason — the intermediate retry preserved 'attempt 1',
    // the terminal settle 'attempt 2'. A fails-then-retries request no longer destroys the first
    // attempt's evidence blind (ppu.2/ppu.4 note). [LAW:one-source-of-truth]
    expect(h.disposedReasons).toEqual(['attempt 1 failed', 'attempt 2 failed']);
  });

  it('maxAttempts = 1 disables retry — a failed create settles after a single attempt', async () => {
    const h = flakyHarness({ id: 'flaky', failFirst: 1 }, 1);
    const handle = await h.service.submit({ providerId: h.providerId, brief: { description: 'no retry' } }, AUTHOR);

    const status = await pollToTerminal(h.service, handle);
    expect(status).toEqual({ state: 'failed', error: 'attempt 1 failed' });
    expect(h.starts()).toBe(1);
    expect(h.disposed).toHaveLength(1);
  });

  it('starts at most ONE retry even when concurrent polls observe the same failure', async () => {
    const h = flakyHarness({ id: 'flaky', failFirst: 1 }, 3);
    const handle = await h.service.submit({ providerId: h.providerId, brief: { description: 'race the retry' } }, AUTHOR);

    // Two polls observe the first attempt's failure at once; only one retry may start.
    await Promise.all([h.service.poll(handle), h.service.poll(handle)]);
    const status = await pollToTerminal(h.service, handle);

    expect(status.state).toBe('ready');
    // Initial attempt + exactly one retry: a double-retry would show 3 starts.
    expect(h.starts()).toBe(2);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
  });

  it('does not re-charge the daily budget on a retry — a retried request spends one daily slot', async () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 5, maxDaily: 1 }, now: () => 0 });
    const h = flakyHarness({ id: 'flaky', failFirst: 1 }, 3, quota);
    const handle = await h.service.submit({ providerId: h.providerId, brief: { description: 'one budget' } }, AUTHOR);
    // The request retries internally and still succeeds on its single daily slot.
    expect((await pollToTerminal(h.service, handle)).state).toBe('ready');
    // The day's one slot is now spent — a fresh submit is refused, proving the retry never reserved again.
    await expect(
      h.service.submit({ providerId: h.providerId, brief: { description: 'second' } }, AUTHOR),
    ).rejects.toThrow(QuotaExceededError);
  });

  it('retries a continue that fails once, appending the retried version and keeping the session', async () => {
    const h = flakyHarness({ id: 'flaky', failFirst: 1, iterable: true }, 2);
    const playgroundId = await seedPlayground(h, 'a counter');

    const handle = await h.service.continue(playgroundId, { description: 'add a reset button' }, REFINER);
    const status = await pollToTerminal(h.service, handle);
    expect(status.state).toBe('ready');
    if (status.state !== 'ready') throw new Error('unreachable');
    expect(status.playgroundId).toBe(playgroundId);

    const playground = await h.catalog.getPlayground(playgroundId);
    expect(playground.session.turns).toHaveLength(2);
    const current = currentVersionOf(playground.session);
    expect((await h.store.get(current)).html).toContain('add a reset button');
    // A refine keeps its session across retries — nothing is released.
    expect(h.disposed).toEqual([]);
  });

  it('retries a fork that fails once, creating the lineaged playground and reclaiming the failed branch', async () => {
    const h = flakyHarness({ id: 'flaky', failFirst: 1, iterable: true }, 2);
    const parentId = await seedPlayground(h, 'a counter');

    const handle = await h.service.fork(parentId, FORKER);
    const status = await pollToTerminal(h.service, handle);
    expect(status.state).toBe('ready');
    if (status.state !== 'ready') throw new Error('unreachable');
    expect(status.playgroundId).not.toBe(parentId);

    expect(await h.catalog.listPlaygrounds()).toHaveLength(2);
    const child = await h.catalog.getPlayground(status.playgroundId);
    expect(child.session.lineage?.parentSession).toBe(SessionId('seed-session'));
    expect(child.session.author).toBe(FORKER);
    // A failed fork attempt is a failed CREATE — its own dead branch is reclaimed (the parent is untouched).
    expect(h.disposed).toHaveLength(1);
  });

  it('settles failed loudly when a retry cannot even start, and frees the concurrent slot', async () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    // The first attempt fails; the retry's startSession throws — an infra fault, not a normal failure.
    const h = flakyHarness({ id: 'flaky', failFirst: 1, throwOnStart: 2 }, 2, quota);
    const handle = await h.service.submit({ providerId: h.providerId, brief: { description: 'retry cannot start' } }, AUTHOR);

    const status = await pollToTerminal(h.service, handle);
    expect(status.state).toBe('failed');
    if (status.state !== 'failed') throw new Error('unreachable');
    expect(status.error).toContain('retry could not start');
    expect(status.error).toContain('start #2 exploded');
    expect(await h.catalog.listPlaygrounds()).toHaveLength(0);

    // The failed first attempt is reclaimed EXACTLY once — the restart-failure path settles the
    // failure directly rather than re-reclaiming the already-disposed handle. No double-dispose.
    expect(h.disposed).toHaveLength(1);

    // The request settled, so its one concurrent slot is freed — the next submit is admitted.
    await expect(
      h.service.submit({ providerId: h.providerId, brief: { description: 'after' } }, AUTHOR),
    ).resolves.toBeDefined();
  });
});

// The retention seam (ppu.8): the in-memory turns map is bounded by evicting SETTLED records once their
// outcome has been observable long enough, while a still-in-flight record is never touched. The clock is
// injected so both settle-time stamping and the eviction cutoff are deterministic — no wall clock, no
// timer, in the mechanism tests. [LAW:no-shared-mutable-globals] [LAW:no-ambient-temporal-coupling]
describe('GenerationService.evictSettledTurns — retention bounds the turns map', () => {
  // These tests vary only two things — the clock and (once) the provider's running-poll count — and use
  // ONLY the service, so they build it directly through makeGenerationService's named-object deps rather
  // than threading defaults through harnessFor's positional parameters. Callers override exactly what
  // they need, nothing more. [LAW:composability]
  const retentionService = (
    now: () => number,
    opts: ContractProviderOptions = { id: 'fake', label: 'Fake', outcome: 'success' },
  ): { service: GenerationService; providerId: ProviderId } => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider(opts));
    const service = makeGenerationService({
      registry,
      store: makeMemoryArtifactStore(),
      catalog: makeMemoryCatalog(),
      disposeTurn: async () => {},
      quota: makeTestQuota(),
      maxAttempts: 1,
      validateArtifact: passThroughValidator,
      now,
    });
    return { service, providerId: ProviderId(opts.id) };
  };

  const submitTo = (h: { service: GenerationService; providerId: ProviderId }, description: string): Promise<SessionHandle> =>
    h.service.submit({ providerId: h.providerId, brief: { description } }, AUTHOR);

  it('evicts a settled request once the cutoff reaches its settle time; a later poll then fails loudly', async () => {
    const clock = { t: 1_000 };
    const h = retentionService(() => clock.t);
    const handle = await submitTo(h, 'a wave explorer');

    // Settle at t=5000 — the stamp the sweeper's cutoff is compared against.
    clock.t = 5_000;
    expect((await h.service.poll(handle)).state).toBe('ready');

    // A cutoff BEFORE the settle time retains the record — its outcome may still be being read.
    expect(h.service.evictSettledTurns(4_999)).toBe(0);
    // ...and the memoized terminal is still served WITHOUT re-hitting the provider.
    expect((await h.service.poll(handle)).state).toBe('ready');

    // A cutoff AT the settle time reclaims it (settledAtMs <= cutoff), returning the evicted count.
    expect(h.service.evictSettledTurns(5_000)).toBe(1);

    // The record is gone: a very late poll is a LOUD unknown-turn, never a silent misreport. This is the
    // deliberate opposite of the ppu.5 re-poll-after-reap defect — retention is sized so this only happens
    // long after the client stopped polling. [LAW:no-silent-failure]
    await expect(h.service.poll(handle)).rejects.toThrow('unknown turn');
  });

  it('never evicts an in-flight request, however far the cutoff advances', async () => {
    const clock = { t: 1_000 };
    // runningPolls: 1 — the first poll observes `running`, so the request is genuinely in flight
    // (settledAtMs still null) across an eviction attempt at the maximum possible cutoff.
    const h = retentionService(() => clock.t, { id: 'fake', label: 'Fake', outcome: 'success', runningPolls: 1 });
    const handle = await submitTo(h, 'a slow one');
    expect((await h.service.poll(handle)).state).toBe('running');

    // Even a cutoff at the end of time cannot reclaim a record that has not settled — its memoized
    // transition MUST stay reachable for the poll that will observe it. [LAW:no-silent-failure]
    expect(h.service.evictSettledTurns(Number.MAX_SAFE_INTEGER)).toBe(0);

    // Proof the record survived intact: the next poll still drives it to its terminal outcome.
    expect((await h.service.poll(handle)).state).toBe('ready');
  });

  it('evicts only the records settled at or before the cutoff, leaving newer ones', async () => {
    const clock = { t: 100 };
    const h = retentionService(() => clock.t);

    const older = await submitTo(h, 'older');
    expect((await h.service.poll(older)).state).toBe('ready'); // settled at t=100

    clock.t = 200;
    const newer = await submitTo(h, 'newer');
    expect((await h.service.poll(newer)).state).toBe('ready'); // settled at t=200

    // Cutoff between the two settle times: the older is reclaimed, the newer retained.
    expect(h.service.evictSettledTurns(150)).toBe(1);
    await expect(h.service.poll(older)).rejects.toThrow('unknown turn');
    expect((await h.service.poll(newer)).state).toBe('ready');
  });
});

// The retention lifecycle owner (ppu.8): a background sweeper that hands the service a
// now()-minus-retention cutoff on each interval — the single explicit owner of eviction timing, the
// agnostic-service sibling of startWorkdirJanitor. [LAW:no-ambient-temporal-coupling]
describe('startTurnRetentionSweeper — drives eviction on an interval', () => {
  it('calls evictSettledTurns with the now-minus-retention cutoff each interval, and stops on stop()', () => {
    vi.useFakeTimers();
    try {
      const clock = { t: 1_000_000 };
      const cutoffs: number[] = [];
      const sweeper = startTurnRetentionSweeper(
        { evictSettledTurns: (before) => (cutoffs.push(before), 0) },
        { retentionMs: 1_000, sweepIntervalMs: 500, now: () => clock.t },
      );

      // No eager first sweep — unlike the workdir janitor, the map starts empty every boot.
      expect(cutoffs).toEqual([]);

      clock.t = 2_000_000;
      vi.advanceTimersByTime(500);
      expect(cutoffs).toEqual([2_000_000 - 1_000]); // cutoff = now - retention

      clock.t = 3_000_000;
      vi.advanceTimersByTime(500);
      expect(cutoffs).toEqual([2_000_000 - 1_000, 3_000_000 - 1_000]);

      // After stop, no further sweeps fire however far time advances.
      sweeper.stop();
      vi.advanceTimersByTime(10_000);
      expect(cutoffs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
