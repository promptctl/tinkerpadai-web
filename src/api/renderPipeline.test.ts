import { describe, expect, it, vi } from 'vitest';
import type { RenderResult, RenderSession } from './browserRenderer.js';
import { parseRenderJob, renderAttempt, resolveRenderTarget, runBackfill, runRenderBatch } from './renderPipeline.js';
import type { BackfillDeps, RenderJob, RenderMessage, RenderPipelineDeps } from './renderPipeline.js';
import { makeMemoryCatalog } from '../storage/memoryCatalog.js';
import { makeMemoryThumbnailStore } from '../storage/memoryThumbnailStore.js';
import { makeMemoryRenderStatusStore } from '../storage/memoryRenderStatusStore.js';
import type { Catalog, RenderStatusStore, ThumbnailStore } from '../storage/index.js';
import { PlaygroundId, VersionId } from '../storage/index.js';
import type { NewPlayground } from '../storage/types.js';
import { Subject } from '../identity/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';

// A minimal NewPlayground for a first-turn playground — the shape createPlayground records. Distinct ids per
// call so each playground has its own current version to key a thumbnail by.
let seq = 0;
const newPlayground = (): NewPlayground => {
  seq += 1;
  return {
    handle: {
      providerId: ProviderId('test'),
      sessionId: SessionId(`s-${seq}`),
      turnId: TurnId(`t-${seq}`),
    },
    prompt: `prompt ${seq}`,
    version: VersionId(`v-${seq}`),
    author: Subject('github:1'),
    lineage: null,
    tags: [],
  };
};

const png = (bytes: readonly number[]): Uint8Array => Uint8Array.from(bytes);

// A fake render session: records the URLs it was asked to render and yields a fixed png, or throws a fixed
// error to simulate a render failure. No browser, no puppeteer — the pipeline core depends only on the
// RenderSession seam. [LAW:decomposition]
const fakeSession = (
  behaviour: { readonly png: Uint8Array } | { readonly throws: Error },
): { session: RenderSession; urls: string[] } => {
  const urls: string[] = [];
  const session: RenderSession = {
    async render(targetUrl: string): Promise<RenderResult> {
      urls.push(targetUrl);
      if ('throws' in behaviour) throw behaviour.throws;
      return { png: behaviour.png, pageErrors: [] };
    },
  };
  return { session, urls };
};

const deps = (catalog: Catalog): RenderPipelineDeps & { thumbnails: ReturnType<typeof makeMemoryThumbnailStore>; statuses: ReturnType<typeof makeMemoryRenderStatusStore> } => {
  const thumbnails = makeMemoryThumbnailStore();
  const statuses = makeMemoryRenderStatusStore();
  return {
    catalog,
    thumbnails,
    statuses,
    contentUrlOf: (id) => `https://content.example/?id=${encodeURIComponent(id)}`,
  };
};

describe('resolveRenderTarget', () => {
  it('renders the current version keyed by that version, at its content URL', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const d = deps(catalog);
    const result = await resolveRenderTarget(d, { playgroundId: pg.id });
    expect(result).toEqual({
      render: {
        versionId: pg.session.turns[0].version,
        contentUrl: `https://content.example/?id=${encodeURIComponent(pg.id)}`,
      },
    });
  });

  it('skips an unlisted playground — a takedown reaches the derived cache', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    await catalog.setListing(pg.id, 'unlisted');
    const result = await resolveRenderTarget(deps(catalog), { playgroundId: pg.id });
    expect(result).toEqual({ skip: 'unlisted' });
  });

  it('skips a version that already has a thumbnail — idempotent by data flow', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const d = deps(catalog);
    await d.thumbnails.put(pg.session.turns[0].version, png([1, 2, 3]));
    expect(await resolveRenderTarget(d, { playgroundId: pg.id })).toEqual({ skip: 'already-rendered' });
  });
});

describe('renderAttempt', () => {
  const attempt = { number: 1, max: 3 };

  it('on success stores the thumbnail and clears the pending status', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const version = pg.session.turns[0].version;
    const d = deps(catalog);
    await d.statuses.set(version, 'pending');
    const { session, urls } = fakeSession({ png: png([137, 80, 78, 71]) });

    const result = await renderAttempt(session, d, { playgroundId: pg.id }, attempt);

    expect(result).toEqual({ kind: 'done' });
    expect(urls).toEqual([`https://content.example/?id=${encodeURIComponent(pg.id)}`]);
    expect(await d.thumbnails.get(version)).toEqual(png([137, 80, 78, 71]));
    // Cleared: rendered-ness now lives in the blob, not a stale 'pending'. [LAW:one-source-of-truth]
    expect(await d.statuses.get(version)).toBeUndefined();
  });

  it('an unlisted job is done without touching the session', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    await catalog.setListing(pg.id, 'unlisted');
    const { session, urls } = fakeSession({ png: png([1]) });
    expect(await renderAttempt(session, deps(catalog), { playgroundId: pg.id }, attempt)).toEqual({ kind: 'done' });
    expect(urls).toEqual([]);
  });

  it('an already-rendered job is done without touching the session — idempotent re-delivery', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const d = deps(catalog);
    // The current version already has a thumbnail (a prior render, or an overlapping backfill): renderAttempt
    // composes resolveRenderTarget's 'already-rendered' skip into a DONE and never re-renders. [LAW:one-source-of-truth]
    await d.thumbnails.put(pg.session.turns[0].version, png([1, 2]));
    const { session, urls } = fakeSession({ png: png([9]) });

    expect(await renderAttempt(session, d, { playgroundId: pg.id }, attempt)).toEqual({ kind: 'done' });
    expect(urls).toEqual([]);
    // The existing thumbnail is untouched — not overwritten by a needless re-render.
    expect(await d.thumbnails.get(pg.session.turns[0].version)).toEqual(png([1, 2]));
  });

  it('an unknown playground is a dropped poison message, not a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const { session } = fakeSession({ png: png([1]) });
    const result = await renderAttempt(session, deps(catalog), { playgroundId: PlaygroundId('ghost') }, attempt);
    expect(result).toEqual({ kind: 'done' });
    warn.mockRestore();
  });

  it('a resolve-time infra fault retries without recording failed — an outage is not a bad artifact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A catalog that cannot be READ (unlike an unknown id, which resolves to PlaygroundNotFoundError) — a
    // transient infra fault during resolveRenderTarget. It must retry, distinct from the drop-on-unknown
    // path, and record NO 'failed' status (the artifact was never even reached). [LAW:no-silent-failure]
    const brokenCatalog: Catalog = {
      createPlayground: async () => { throw new Error('not used'); },
      appendTurn: async () => { throw new Error('not used'); },
      setListing: async () => { throw new Error('not used'); },
      getPlayground: async () => { throw new Error('catalog unreachable'); },
      listPlaygrounds: async () => [],
    };
    const d = deps(brokenCatalog);
    const { session, urls } = fakeSession({ png: png([1]) });

    const result = await renderAttempt(session, d, { playgroundId: PlaygroundId('anything') }, { number: 1, max: 3 });

    expect(result).toEqual({ kind: 'retry' });
    // The session was never reached, and no status was recorded — the fault is upstream of the render.
    expect(urls).toEqual([]);
    expect(await d.statuses.get(VersionId('anything'))).toBeUndefined();
    warn.mockRestore();
  });

  it('a render failure below the bound retries and records no failed status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const version = pg.session.turns[0].version;
    const d = deps(catalog);
    const { session } = fakeSession({ throws: new Error('renderer crashed') });

    const result = await renderAttempt(session, d, { playgroundId: pg.id }, { number: 1, max: 3 });

    expect(result).toEqual({ kind: 'retry' });
    expect(await d.thumbnails.get(version)).toBeUndefined();
    // NOT recorded failed — it may still succeed on a later attempt. [LAW:no-silent-failure]
    expect(await d.statuses.get(version)).toBeUndefined();
    warn.mockRestore();
  });

  it('a persistence failure after a successful render retries — never recorded as a failed artifact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const version = pg.session.turns[0].version;
    const statuses = makeMemoryRenderStatusStore();
    // The render succeeds but the thumbnail store is down. renderAttempt must stay TOTAL: a store fault is
    // transient and the render is redoable, so it retries — and must NOT be recorded 'failed' (the artifact
    // is fine, only persistence blipped). [LAW:no-silent-failure]
    const failingThumbnails: ThumbnailStore = {
      get: async () => undefined,
      put: async () => { throw new Error('R2 unavailable'); },
    };
    const d: RenderPipelineDeps = {
      catalog,
      thumbnails: failingThumbnails,
      statuses,
      contentUrlOf: (id) => `https://content.example/?id=${encodeURIComponent(id)}`,
    };
    const { session } = fakeSession({ png: png([1]) });

    const result = await renderAttempt(session, d, { playgroundId: pg.id }, { number: 1, max: 3 });

    expect(result).toEqual({ kind: 'retry' });
    expect(await statuses.get(version)).toBeUndefined();
    warn.mockRestore();
  });

  it('a terminal failure whose status write ALSO fails still returns done — total, never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    // At the bound the render is terminally failed AND recording 'failed' fails too (KV down). renderAttempt
    // must STILL return done and never throw, or the edge shell's ack/retry mapping breaks. The backfill
    // re-enqueues the still-pending version later. [FRAMING:representation] [LAW:no-silent-failure]
    const failingStatuses: RenderStatusStore = {
      get: async () => undefined,
      set: async () => { throw new Error('KV unavailable'); },
      clear: async () => undefined,
    };
    const d: RenderPipelineDeps = {
      catalog,
      thumbnails: makeMemoryThumbnailStore(),
      statuses: failingStatuses,
      contentUrlOf: (id) => `https://content.example/?id=${encodeURIComponent(id)}`,
    };
    const { session } = fakeSession({ throws: new Error('renderer crashed') });

    const result = await renderAttempt(session, d, { playgroundId: pg.id }, { number: 3, max: 3 });

    expect(result).toEqual({ kind: 'done' });
    error.mockRestore();
  });

  it('a render failure AT the bound records failed and is done — surfaced, not an eternal blank', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const version = pg.session.turns[0].version;
    const d = deps(catalog);
    await d.statuses.set(version, 'pending');
    const { session } = fakeSession({ throws: new Error('renderer crashed') });

    const result = await renderAttempt(session, d, { playgroundId: pg.id }, { number: 3, max: 3 });

    expect(result).toEqual({ kind: 'done' });
    expect(await d.thumbnails.get(version)).toBeUndefined();
    // The crash is a distinguishable, surfaced state. [LAW:no-silent-failure]
    expect(await d.statuses.get(version)).toBe('failed');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe('runBackfill', () => {
  const backfillDeps = (
    catalog: Catalog,
    thumbnails = makeMemoryThumbnailStore(),
    statuses = makeMemoryRenderStatusStore(),
  ): { deps: BackfillDeps; enqueued: RenderJob[]; thumbnails: typeof thumbnails; statuses: typeof statuses } => {
    const enqueued: RenderJob[] = [];
    return {
      deps: {
        catalog,
        thumbnails,
        statuses,
        enqueue: async (jobs) => {
          enqueued.push(...jobs);
        },
      },
      enqueued,
      thumbnails,
      statuses,
    };
  };

  it('enqueues every listed playground missing a thumbnail, marking each pending', async () => {
    const catalog = makeMemoryCatalog();
    const a = await catalog.createPlayground(newPlayground());
    const b = await catalog.createPlayground(newPlayground());
    const { deps: d, enqueued, statuses } = backfillDeps(catalog);

    const report = await runBackfill(d);

    expect(report).toEqual({ enqueued: 2, skipped: 0 });
    expect(new Set(enqueued.map((j) => j.playgroundId))).toEqual(new Set([a.id, b.id]));
    expect(await statuses.get(a.session.turns[0].version)).toBe('pending');
    expect(await statuses.get(b.session.turns[0].version)).toBe('pending');
  });

  it('skips playgrounds already rendered — idempotent, converges to a no-op', async () => {
    const catalog = makeMemoryCatalog();
    const a = await catalog.createPlayground(newPlayground());
    const b = await catalog.createPlayground(newPlayground());
    const thumbnails = makeMemoryThumbnailStore();
    await thumbnails.put(a.session.turns[0].version, png([1]));
    const { deps: d, enqueued } = backfillDeps(catalog, thumbnails);

    const report = await runBackfill(d);

    expect(report).toEqual({ enqueued: 1, skipped: 1 });
    expect(enqueued.map((j) => j.playgroundId)).toEqual([b.id]);
  });

  it('skips a version already marked failed — a terminal failure is not re-enqueued every tick', async () => {
    const catalog = makeMemoryCatalog();
    const failed = await catalog.createPlayground(newPlayground());
    const pending = await catalog.createPlayground(newPlayground());
    const statuses = makeMemoryRenderStatusStore();
    // `failed` is past its retry bound (recorded terminal), with no thumbnail. Without consulting the status
    // store the backfill would find it "missing" and re-enqueue it forever, burning render quota every tick.
    await statuses.set(failed.session.turns[0].version, 'failed');
    const { deps: d, enqueued } = backfillDeps(catalog, makeMemoryThumbnailStore(), statuses);

    const report = await runBackfill(d);

    // Only the genuinely-pending version is enqueued; the failed one is skipped and its status is preserved.
    expect(report).toEqual({ enqueued: 1, skipped: 1 });
    expect(enqueued.map((j) => j.playgroundId)).toEqual([pending.id]);
    expect(await statuses.get(failed.session.turns[0].version)).toBe('failed');
    expect(await statuses.get(pending.session.turns[0].version)).toBe('pending');
  });

  it('never enqueues an unlisted playground — listPlaygrounds already excludes it', async () => {
    const catalog = makeMemoryCatalog();
    const a = await catalog.createPlayground(newPlayground());
    await catalog.setListing(a.id, 'unlisted');
    const { deps: d, enqueued } = backfillDeps(catalog);
    const report = await runBackfill(d);
    expect(report).toEqual({ enqueued: 0, skipped: 0 });
    expect(enqueued).toEqual([]);
  });
});

// The edge glue that maps the pure directive onto the queue's ack/retry, lifted out of worker.ts so it is
// testable without a browser. These are the acceptance criteria for "a bug in the Cloudflare-Queue wiring
// (wrong ack/retry, missing poison-pill guard) is caught before production". [LAW:verifiable-goals]
describe('runRenderBatch', () => {
  // A fake queue message that records how it was acknowledged — the RenderMessage seam a real Cloudflare
  // Message satisfies structurally.
  const fakeMessage = (body: unknown, attempts = 1): { message: RenderMessage; calls: { ack: number; retry: number } } => {
    const calls = { ack: 0, retry: 0 };
    return {
      message: { id: 'msg', body, attempts, ack: () => void (calls.ack += 1), retry: () => void (calls.retry += 1) },
      calls,
    };
  };

  it('acks a message whose render succeeds, and stores its thumbnail', async () => {
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const d = deps(catalog);
    const { session } = fakeSession({ png: png([1, 2, 3]) });
    const { message, calls } = fakeMessage({ playgroundId: pg.id }, 1);

    await runRenderBatch(session, d, [message], 3);

    expect(calls).toEqual({ ack: 1, retry: 0 });
    expect(await d.thumbnails.get(pg.session.turns[0].version)).toEqual(png([1, 2, 3]));
  });

  it('retries a message whose render fails below the bound — not acked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const { session } = fakeSession({ throws: new Error('renderer crashed') });
    const { message, calls } = fakeMessage({ playgroundId: pg.id }, 1);

    await runRenderBatch(session, deps(catalog), [message], 3);

    expect(calls).toEqual({ ack: 0, retry: 1 });
    warn.mockRestore();
  });

  it('acks a malformed message as a poison pill and keeps processing the rest of the batch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const d = deps(catalog);
    const { session } = fakeSession({ png: png([9]) });
    // A malformed body would loop forever if retried; it must be acked-and-dropped. The well-formed message
    // AFTER it must still render — one poison pill cannot sink the whole batch. [LAW:no-silent-failure]
    const poison = fakeMessage('not-an-object', 1);
    const good = fakeMessage({ playgroundId: pg.id }, 1);

    await runRenderBatch(session, d, [poison.message, good.message], 3);

    expect(poison.calls).toEqual({ ack: 1, retry: 0 });
    expect(good.calls).toEqual({ ack: 1, retry: 0 });
    expect(await d.thumbnails.get(pg.session.turns[0].version)).toEqual(png([9]));
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('acks a message whose render fails AT the bound — the failure is recorded, not retried forever', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const catalog = makeMemoryCatalog();
    const pg = await catalog.createPlayground(newPlayground());
    const d = deps(catalog);
    const { session } = fakeSession({ throws: new Error('renderer crashed') });
    // attempts === max: renderAttempt records 'failed' and returns done, so the queue must ack (not retry).
    const { message, calls } = fakeMessage({ playgroundId: pg.id }, 3);

    await runRenderBatch(session, d, [message], 3);

    expect(calls).toEqual({ ack: 1, retry: 0 });
    expect(await d.statuses.get(pg.session.turns[0].version)).toBe('failed');
    error.mockRestore();
  });
});

describe('parseRenderJob at the trust boundary', () => {
  it('brands a well-formed body', () => {
    expect(parseRenderJob({ playgroundId: 'p-1' })).toEqual({ playgroundId: PlaygroundId('p-1') });
  });

  it('rejects a malformed body loudly', () => {
    expect(() => parseRenderJob(null)).toThrow(/malformed/);
    expect(() => parseRenderJob({})).toThrow(/malformed/);
    expect(() => parseRenderJob({ playgroundId: '' })).toThrow(/malformed/);
    expect(() => parseRenderJob({ playgroundId: 42 })).toThrow(/malformed/);
  });
});
