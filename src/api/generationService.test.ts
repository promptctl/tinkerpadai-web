import { describe, expect, it, vi } from 'vitest';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import type { ContractProviderOptions } from '../provider/provider.contract.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { SessionHandle } from '../provider/index.js';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import type { ArtifactStore } from '../storage/index.js';
import { makeGenerationService } from './generationService.js';
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

const submit = (h: Harness, description: string): Promise<SessionHandle> =>
  h.service.submit({ providerId: h.providerId, brief: { description } });

describe('GenerationService.submit', () => {
  it('returns a handle pinned to the chosen provider', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'a wave explorer');
    expect(handle.providerId).toBe(h.providerId);
  });

  it('throws loudly when the chosen provider is unknown', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    await expect(
      h.service.submit({ providerId: ProviderId('nope'), brief: { description: 'x' } }),
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

    // The file actually landed in the store under the catalogued version.
    const version = summaries[0]?.currentVersion;
    if (version === undefined) throw new Error('no version');
    expect((await h.store.get(version)).html).toContain('a wave explorer');
  });

  it('releases the settled turn exactly once, after persisting', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'x');
    await h.service.poll(handle);
    expect(h.disposed).toEqual([handle]);
  });

  it('persists exactly once across repeated polls of a settled turn', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'once only');

    const first = await h.service.poll(handle);
    const second = await h.service.poll(handle);
    expect(first).toEqual(second);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
    expect(h.disposed).toEqual([handle]);
  });

  it('persists exactly once even under concurrent polls of the same turn', async () => {
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const handle = await submit(h, 'race me');

    const [a, b] = await Promise.all([h.service.poll(handle), h.service.poll(handle)]);
    expect(a).toEqual(b);
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);
    expect(h.disposed).toEqual([handle]);
  });
});

describe('GenerationService.poll — releasing the turn never misreports a durable success', () => {
  it('reports ready and keeps the playground even when disposeTurn throws', async () => {
    // A disposal fault cannot unmake a durable playground: the outcome is ready, the
    // playground is catalogued, and the fault is surfaced loudly (not swallowed) — never
    // a rejection that would lie about the live playground and wedge the turn forever.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harnessFor({ id: 'fake', label: 'Fake', outcome: 'success' }, async () => {
      throw new Error('rm failed');
    });
    const handle = await submit(h, 'durable despite cleanup fault');

    const status = await h.service.poll(handle);
    expect(status.state).toBe('ready');
    expect(await h.catalog.listPlaygrounds()).toHaveLength(1);

    // Re-polling still returns the durable success, not a memoized disposal rejection.
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
