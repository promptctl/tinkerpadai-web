import { describe, expect, it } from 'vitest';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import type { ContractProviderOptions } from '../provider/provider.contract.js';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import { makeGenerationService } from './generationService.js';
import { makeHttpHandler } from './httpHandler.js';
import { Subject } from './identity.js';
import type { IdentityResolver } from './identity.js';

// The resolvers the gate tests pin against: one that always grants the same principal (the
// authenticated path), one that always returns null (the unauthenticated path). They stand in
// for whatever real mechanism sits behind the seam — the enforcer only ever sees the value.
const grantIdentity: IdentityResolver = async () => ({ subject: Subject('tester') });
const denyIdentity: IdentityResolver = async () => null;

// The HTTP surface's contract: it routes to the service, validates input at the boundary
// (bad shape -> 400), and surfaces service failures loudly (-> non-2xx with a message).
// It asserts the request/response behavior, not the service internals. [LAW:behavior-not-structure]

const handlerFor = (
  opts: ContractProviderOptions,
  resolveIdentity: IdentityResolver = grantIdentity,
): ((request: Request) => Promise<Response>) => {
  const registry = new ProviderRegistry();
  registry.register(makeFakeProvider(opts));
  const service = makeGenerationService({
    registry,
    store: makeMemoryArtifactStore(),
    catalog: makeMemoryCatalog(),
    disposeTurn: async () => undefined,
  });
  return makeHttpHandler(service, resolveIdentity);
};

const post = (path: string, body: unknown): Request =>
  new Request(`http://tinkerpad.local${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// Drive an initial generation all the way to a catalogued playground, returning its id. Both
// the continue and fork round trips operate on a playground that already exists, so each must
// mint one first — this is the single definition of "get me a ready playground". [LAW:one-source-of-truth]
const submitToReady = async (handler: (request: Request) => Promise<Response>): Promise<string> => {
  const { handle } = (await (
    await handler(post('/generations', { providerId: 'fake', brief: { description: 'a tiny counter' } }))
  ).json()) as { handle: Record<string, string> };
  const status = (await (await handler(post('/poll', { handle }))).json()) as {
    state: string;
    playgroundId?: string;
  };
  expect(status.state).toBe('ready');
  return status.playgroundId as string;
};

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

describe('POST /generations/continue then POST /poll — the iterate round trip', () => {
  it('continues an existing playground, returns a new handle, and polls it to ready', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const playgroundId = await submitToReady(handler);

    const continueRes = await handler(
      post('/generations/continue', { playgroundId, brief: { description: 'now make it count by two' } }),
    );
    expect(continueRes.status).toBe(201);
    const { handle } = (await continueRes.json()) as { handle: Record<string, string> };
    expect(handle.providerId).toBe('fake');

    const pollRes = await handler(post('/poll', { handle }));
    expect(pollRes.status).toBe(200);
    const status = (await pollRes.json()) as { state: string; playgroundId?: string };
    expect(status.state).toBe('ready');
    expect(status.playgroundId).toBe(playgroundId);
  });

  it('rejects an unknown playground id loudly as 404, never a turn that targets nothing', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const res = await handler(
      post('/generations/continue', { playgroundId: 'ghost', brief: { description: 'x' } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it('rejects continuing a non-iterable provider as 422, not a server fault or a silent no-op', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const playgroundId = await submitToReady(handler);
    const res = await handler(
      post('/generations/continue', { playgroundId, brief: { description: 'x' } }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a continue with a missing brief as 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const res = await handler(post('/generations/continue', { playgroundId: 'pg-1' }));
    expect(res.status).toBe(400);
  });

  it('rejects a continue with a missing playgroundId as 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const res = await handler(post('/generations/continue', { brief: { description: 'x' } }));
    expect(res.status).toBe(400);
  });
});

describe('POST /generations/fork then POST /poll — the remix round trip', () => {
  it('forks an existing playground, returns a new handle, and polls it to a NEW playground', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const parentId = await submitToReady(handler);

    const forkRes = await handler(post('/generations/fork', { playgroundId: parentId }));
    expect(forkRes.status).toBe(201);
    const { handle } = (await forkRes.json()) as { handle: Record<string, string> };
    expect(handle.providerId).toBe('fake');

    const pollRes = await handler(post('/poll', { handle }));
    expect(pollRes.status).toBe(200);
    const status = (await pollRes.json()) as { state: string; playgroundId?: string };
    expect(status.state).toBe('ready');
    // A fork is an INDEPENDENT playground, not another version of the parent — its id differs.
    expect(typeof status.playgroundId).toBe('string');
    expect(status.playgroundId).not.toBe(parentId);
  });

  it('rejects forking an unknown playground id loudly as 404, never a fork of nothing', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const res = await handler(post('/generations/fork', { playgroundId: 'ghost' }));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it('rejects forking with a non-forkable provider as 422, not a server fault or a silent no-op', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const playgroundId = await submitToReady(handler);
    const res = await handler(post('/generations/fork', { playgroundId }));
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a fork with a missing playgroundId as 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true });
    const res = await handler(post('/generations/fork', {}));
    expect(res.status).toBe(400);
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

describe('the identity enforcement boundary — the write path is gated, the read path is not', () => {
  // Exactly the routes the ticket names as the write path. Driven as data so the gate's reach
  // is asserted as a set, not re-stated per case. [LAW:dataflow-not-control-flow]
  const writeRoutes = [
    '/generations',
    '/generations/continue',
    '/generations/fork',
    '/poll',
  ];

  it.each(writeRoutes)(
    'rejects an unauthenticated write to POST %s as a 401 value with a message',
    async (path) => {
      const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' }, denyIdentity);
      const res = await handler(post(path, { providerId: 'fake', brief: { description: 'x' } }));
      expect(res.status).toBe(401);
      expect((await res.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
    },
  );

  it('gates before parsing — an unauthenticated write with a malformed body is 401, not 400', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' }, denyIdentity);
    const res = await handler(post('/generations', 'not json{'));
    expect(res.status).toBe(401);
  });

  it('lets an authenticated write through — the gate blocks absence, never presence', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' }, grantIdentity);
    const res = await handler(
      post('/generations', { providerId: 'fake', brief: { description: 'a tiny counter' } }),
    );
    expect(res.status).toBe(201);
  });

  it('leaves the read path credential-free — GET /providers is never gated, even with no identity', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' }, denyIdentity);
    const res = await handler(new Request('http://tinkerpad.local/providers'));
    expect(res.status).toBe(200);
  });

  it('leaves the availability read credential-free — GET /availability is never gated', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' }, denyIdentity);
    const res = await handler(new Request('http://tinkerpad.local/availability?providerId=fake'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'available' });
  });
});

describe('unknown routes', () => {
  it('returns 404 for an unmapped path', async () => {
    const handler = handlerFor({ id: 'fake', label: 'Fake', outcome: 'success' });
    const res = await handler(new Request('http://tinkerpad.local/nope'));
    expect(res.status).toBe(404);
  });
});
