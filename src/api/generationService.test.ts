import { describe, expect, it, vi } from 'vitest';
import { Subject } from '../identity/index.js';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import type { ContractProviderOptions } from '../provider/provider.contract.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { SessionHandle } from '../provider/index.js';
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
} from './generationService.js';
import type { GenerationService } from './generationService.js';

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
  readonly providerId: ProviderId;
}

const harnessFor = (
  opts: ContractProviderOptions,
  disposeTurn?: (handle: SessionHandle) => Promise<void>,
): Harness => {
  const registry = new ProviderRegistry();
  registry.register(makeFakeProvider(opts));
  const store = makeMemoryArtifactStore();
  const catalog = makeMemoryCatalog();
  const disposed: SessionHandle[] = [];
  const service = makeGenerationService({
    registry,
    store,
    catalog,
    disposeTurn:
      disposeTurn ??
      (async (handle) => {
        disposed.push(handle);
      }),
  });
  return { service, store, catalog, disposed, providerId: ProviderId(opts.id) };
};

// The authenticated principal the gated write path would resolve. The service records it as the
// new playground's author; FORKER stands in for a different principal remixing someone else's
// playground, to prove a fork is authored by the forker, not the parent's author.
const AUTHOR = Subject('ada');
const FORKER = Subject('grace');

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
  });
});

describe('GenerationService.continue — refine an existing playground into a new version', () => {
  it('appends a second version to the same playground, current version being the follow-up', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const first = await submit(h, 'a counter');
    const ready = await h.service.poll(first);
    if (ready.state !== 'ready') throw new Error('unreachable');

    const second = await h.service.continue(ready.playgroundId, { description: 'add a reset button' });
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

    const handle = await h.service.continue(seed.id, { description: 'add a reset button' });
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

  it('fails loudly when the playground provider cannot continue', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const first = await submit(h, 'a counter');
    const ready = await h.service.poll(first);
    if (ready.state !== 'ready') throw new Error('unreachable');

    await expect(
      h.service.continue(ready.playgroundId, { description: 'add a reset button' }),
    ).rejects.toThrow(ProviderCannotContinueError);
  });

  it('fails loudly for an unknown playground id', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    await expect(
      h.service.continue(PlaygroundId('nope'), { description: 'x' }),
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
