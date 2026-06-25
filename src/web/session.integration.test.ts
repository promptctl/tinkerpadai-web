import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import {
  makeGenerationService,
  makeHttpHandler,
  makeMemorySessionStore,
  makeSessionHandler,
  makeSessionResolver,
} from '../api/index.js';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import { makeSiteHandler } from './siteHandler.js';
import { serve } from './server.js';
import type { RunningServer } from './server.js';

// THE GENERATION GATE, proven end to end over a real socket. The session-backed resolver is wired
// into the enforcer exactly as production does, and the session handler is composed onto the front
// door. We drive the whole loop: a write is gated (401) until a dev login establishes a cookie,
// then the SAME write succeeds — the credential carried by the cookie, no other change. This is
// the ticket's acceptance: the enforcement boundary becomes a working generation gate. [LAW:verifiable-goals]

const PAGE = '<!doctype html><title>front door</title>';
const SECRET = 'sesame-secret';

// Compose the front door the way main.ts does: one session store behind both the resolver (gate)
// and the session handler (login/whoami), the fake provider so it runs with no tmux.
const startFrontDoor = async (): Promise<RunningServer> => {
  const registry = new ProviderRegistry();
  registry.register(makeFakeProvider({ id: 'fake', label: 'Fake', outcome: 'success' }));
  const catalog = makeMemoryCatalog();
  const service = makeGenerationService({
    registry,
    store: makeMemoryArtifactStore(),
    catalog,
    disposeTurn: async () => undefined,
  });

  const sessionStore = makeMemorySessionStore();
  const resolveIdentity = makeSessionResolver(sessionStore);
  const handler = makeSiteHandler({
    page: PAGE,
    catalog,
    contentOrigin: 'http://content.local',
    sessionHandler: makeSessionHandler({ store: sessionStore, resolveIdentity, secret: SECRET }),
    apiHandler: makeHttpHandler(service, resolveIdentity),
  });
  return serve({ handler, port: 0 });
};

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('the generation gate over the composed front door', () => {
  it('gates a write until login, then lets the same write through with the session cookie', async () => {
    running = await startFrontDoor();
    const base = running.url;

    const generate = (cookie?: string): Promise<Response> =>
      fetch(`${base}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ providerId: 'fake', brief: { description: 'a tiny counter' } }),
      });

    // 1. Unauthenticated write → 401 at the gate, before any generation happens.
    const gated = await generate();
    expect(gated.status).toBe(401);

    // 2. whoami before login → identity null.
    expect(await (await fetch(`${base}/session`)).json()).toEqual({ identity: null });

    // 3. Log in with the dev secret → 200 and a session cookie.
    const loginRes = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(loginRes.status).toBe(200);
    const setCookie = loginRes.headers.get('set-cookie');
    expect(setCookie).toContain('tp_session=');
    const cookie = setCookie!.split(';')[0]!;

    // 4. whoami with the cookie → the dev identity.
    const who = await fetch(`${base}/session`, { headers: { cookie } });
    expect(await who.json()).toEqual({ identity: { subject: 'dev' } });

    // 5. The SAME write, now carrying the cookie → 201, and the poll drives it to ready.
    const submit = await generate(cookie);
    expect(submit.status).toBe(201);
    const { handle } = (await submit.json()) as { handle: unknown };
    const poll = await fetch(`${base}/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ handle }),
    });
    const status = (await poll.json()) as { state: string; playgroundId?: string };
    expect(status.state).toBe('ready');
    expect(typeof status.playgroundId).toBe('string');
  });

  it('rejects a wrong dev secret as 401 and grants no usable cookie', async () => {
    running = await startFrontDoor();
    const res = await fetch(`${running.url}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'not-the-secret' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('leaves the read path credential-free — the commons and provider list need no session', async () => {
    running = await startFrontDoor();
    expect((await fetch(`${running.url}/commons`)).status).toBe(200);
    expect((await fetch(`${running.url}/providers`)).status).toBe(200);
  });
});
