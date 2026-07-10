import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import {
  localIdentityResolver,
  makeGenerationService,
  makeHttpHandler,
  makeReportService,
  makeReviewService,
  passThroughValidator,
} from '../api/index.js';
import { makeTestQuota } from '../api/__fixtures__/testQuota.js';
import { makeMemoryArtifactStore, makeMemoryCatalog, makeMemoryReportStore } from '../storage/index.js';
import { makeSiteHandler } from './siteHandler.js';
import { serve } from './server.js';
import type { RunningServer } from './server.js';

// The Node↔Web bridge proven against a REAL socket: bind an ephemeral port, drive the whole
// front-door surface over actual HTTP, and confirm the raw Node request/response is faithfully
// translated to and from the Web handler. It uses the fake provider, so it needs no tmux and
// runs in the normal suite — it is the steel thread's proof that the page, the API, and the
// socket compose end to end. [LAW:verifiable-goals]

const PAGE = '<!doctype html><title>tinkerpad front door</title>';

const startServer = async (availability?: { state: 'unavailable'; reason: string }): Promise<RunningServer> => {
  const registry = new ProviderRegistry();
  registry.register(
    makeFakeProvider({ id: 'fake', label: 'Fake Provider', outcome: 'success', ...(availability ? { availability } : {}) }),
  );
  // One catalog/store shared by the service (write path) and the site handler (read path):
  // the commons reads exactly what generation wrote, through the seam, no provider involved.
  const catalog = makeMemoryCatalog();
  const service = makeGenerationService({
    registry,
    store: makeMemoryArtifactStore(),
    catalog,
    disposeTurn: async () => undefined,
    quota: makeTestQuota(),
    maxAttempts: 1,
    validateArtifact: passThroughValidator,
  });
  // ONE report store behind both intake and review, mirroring production — the review queue reads
  // exactly what the report button writes. [LAW:one-source-of-truth]
  const reportStore = makeMemoryReportStore();
  const reports = makeReportService({ catalog, reports: reportStore });
  const handler = makeSiteHandler({
    page: PAGE,
    catalog,
    contentOrigin: 'http://content.local:9999',
    // This suite exercises the bridge and the always-open localIdentityResolver path, not
    // sessions — a pass-through session handler models "no session routes here". The dedicated
    // gate is proven in session.integration.test.
    sessionHandler: async () => null,
    apiHandler: makeHttpHandler(service, reports, localIdentityResolver),
    reviewService: makeReviewService({ reports: reportStore, catalog }),
    isAdminRequest: async () => false,
  });
  return serve({ handler, port: 0 });
};

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('serve — the front door over real HTTP', () => {
  it('serves the page at /', async () => {
    running = await startServer();
    const res = await fetch(`${running.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(PAGE);
  });

  it('serves the provider list for the dropdown', async () => {
    running = await startServer();
    const res = await fetch(`${running.url}/providers`);
    const providers = (await res.json()) as Array<{ id: string; label: string }>;
    expect(providers.map((p) => p.label)).toEqual(['Fake Provider']);
  });

  it('serves the live availability toggle, reason and all', async () => {
    running = await startServer({ state: 'unavailable', reason: 'tmux not found' });
    const res = await fetch(`${running.url}/availability?providerId=fake`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'unavailable', reason: 'tmux not found' });
  });

  it('drives a full submit→poll generation through to a ready playground', async () => {
    running = await startServer();
    const submitRes = await fetch(`${running.url}/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'fake', brief: { description: 'a tiny counter' } }),
    });
    expect(submitRes.status).toBe(201);
    const { handle } = (await submitRes.json()) as { handle: Record<string, string> };

    const pollRes = await fetch(`${running.url}/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    const status = (await pollRes.json()) as { state: string; playgroundId?: string };
    expect(status.state).toBe('ready');
    expect(typeof status.playgroundId).toBe('string');
  });

  it('surfaces a bad request as 400 across the bridge', async () => {
    running = await startServer();
    const res = await fetch(`${running.url}/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'fake' }),
    });
    expect(res.status).toBe(400);
  });

  it('emits MULTIPLE Set-Cookie headers as distinct headers, not one folded value', async () => {
    // The OAuth callback sets the session cookie AND clears the state cookie in one response. The
    // bridge must carry both as separate Set-Cookie headers — folding them into one comma-joined
    // value corrupts cookies, whose attributes contain commas. [LAW:no-silent-failure]
    running = await serve({
      port: 0,
      handler: async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'a=1; Path=/');
        headers.append('set-cookie', 'b=2; Path=/');
        return new Response(null, { status: 204, headers });
      },
    });
    const cookies = (await fetch(running.url)).headers.getSetCookie();
    expect(cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
});
