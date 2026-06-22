import { describe, expect, it } from 'vitest';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import type { ContractProviderOptions } from '../provider/provider.contract.js';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import { makeGenerationService } from './generationService.js';
import { makeHttpHandler } from './httpHandler.js';

// The HTTP surface's contract: it routes to the service, validates input at the boundary
// (bad shape -> 400), and surfaces service failures loudly (-> non-2xx with a message).
// It asserts the request/response behavior, not the service internals. [LAW:behavior-not-structure]

const handlerFor = (opts: ContractProviderOptions): ((request: Request) => Promise<Response>) => {
  const registry = new ProviderRegistry();
  registry.register(makeFakeProvider(opts));
  const service = makeGenerationService({
    registry,
    store: makeMemoryArtifactStore(),
    catalog: makeMemoryCatalog(),
    disposeTurn: async () => undefined,
  });
  return makeHttpHandler(service);
};

const post = (path: string, body: unknown): Request =>
  new Request(`http://tinkerpad.local${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /providers', () => {
  it('returns the registered providers for the dropdown', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake Provider', outcome: 'success' });
    const res = await handler(new Request('http://tinkerpad.local/providers'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; label: string }>;
    expect(body.map((p) => p.label)).toEqual(['Fake Provider']);
  });
});

describe('GET /availability — the live generation toggle', () => {
  it('returns available for a ready provider, branding the providerId from the query', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(
      new Request('http://tinkerpad.local/availability?providerId=fake'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'available' });
  });

  it('surfaces the reason when the provider is unavailable', async () => {
    const handler = handlerFor({
      id: 'fake',
      label: 'Fake',
      outcome: 'success',
      availability: { state: 'unavailable', reason: 'claude CLI not found' },
    });
    const res = await handler(
      new Request('http://tinkerpad.local/availability?providerId=fake'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'unavailable', reason: 'claude CLI not found' });
  });

  it('rejects a missing providerId as 400 at the trust boundary', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(new Request('http://tinkerpad.local/availability'));
    expect(res.status).toBe(400);
  });

  it('surfaces an unknown provider loudly as 500, never a hidden default', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(
      new Request('http://tinkerpad.local/availability?providerId=ghost'),
    );
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unknown provider: ghost' });
  });
});

describe('POST /generations then POST /poll — the full submit→poll round trip', () => {
  it('submits a brief, returns a handle, and polls it through to ready', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });

    const submitRes = await handler(
      post('/generations', { providerId: 'fake', brief: { description: 'a tiny counter' } }),
    );
    expect(submitRes.status).toBe(201);
    const { handle } = (await submitRes.json()) as { handle: Record<string, string> };
    expect(handle.providerId).toBe('fake');

    const pollRes = await handler(post('/poll', { handle }));
    expect(pollRes.status).toBe(200);
    const status = (await pollRes.json()) as { state: string; playgroundId?: string };
    expect(status.state).toBe('ready');
    expect(typeof status.playgroundId).toBe('string');
  });
});

describe('POST /poll — a failed generation surfaces the error as data, not an empty file', () => {
  it('reports state failed with the surfaced message', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: { fail: 'skill crashed' } });
    const { handle } = (await (
      await handler(post('/generations', { providerId: 'fake', brief: { description: 'x' } }))
    ).json()) as { handle: Record<string, string> };

    const pollRes = await handler(post('/poll', { handle }));
    expect(pollRes.status).toBe(200);
    expect(await pollRes.json()).toEqual({ state: 'failed', error: 'skill crashed' });
  });
});

describe('input validation at the trust boundary', () => {
  it('rejects a generation with a missing brief as 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(post('/generations', { providerId: 'fake' }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a non-JSON body as 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(post('/generations', 'not json{'));
    expect(res.status).toBe(400);
  });

  it('rejects a poll with a malformed handle as 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(post('/poll', { handle: { providerId: 'fake' } }));
    expect(res.status).toBe(400);
  });
});

describe('service errors are surfaced loudly, never hidden behind a 200', () => {
  it('returns 500 with the message when submitting to an unknown provider', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(post('/generations', { providerId: 'ghost', brief: { description: 'x' } }));
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'unknown provider: ghost' });
  });
});

describe('unknown routes', () => {
  it('returns 404 for an unmapped path', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(new Request('http://tinkerpad.local/nope'));
    expect(res.status).toBe(404);
  });
});
