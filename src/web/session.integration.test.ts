import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { ProviderRegistry } from '../provider/index.js';
import {
  Subject,
  makeGenerationService,
  makeHttpHandler,
  makeMemorySessionStore,
  makeReportService,
  makeSessionHandler,
  makeSessionResolver,
} from '../api/index.js';
import { makeFakeOAuthProvider } from '../api/__fixtures__/fakeOAuthProvider.js';
import { makeMemoryArtifactStore, makeMemoryCatalog, makeMemoryReportStore } from '../storage/index.js';
import { makeSiteHandler } from './siteHandler.js';
import { serve } from './server.js';
import type { RunningServer } from './server.js';

// THE GENERATION GATE, proven end to end over a real socket. The session-backed resolver is wired
// into the enforcer exactly as production does, and the session handler is composed onto the front
// door. We drive the whole loop: a write is gated (401) until the OAuth login dance establishes a
// session cookie, then the SAME write succeeds — the credential carried by the cookie, no other
// change. The identity provider is a fake (no real GitHub), so the flow's CSRF state round-trip and
// cookie minting are proven without the network. This is the ticket's acceptance: the enforcement
// boundary is a working generation gate behind a real delegated-identity login. [LAW:verifiable-goals]

const PAGE = '<!doctype html><title>front door</title>';
const SUBJECT = Subject('github:7');

// Compose the front door the way main.ts does: one session store behind both the resolver (gate)
// and the session handler (login/callback/whoami), the fake generation + oauth providers so it
// runs with no tmux and no real GitHub.
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
  const reports = makeReportService({ catalog, reports: makeMemoryReportStore() });

  const sessionStore = makeMemorySessionStore({ now: () => Date.now(), ttlMs: 60 * 60 * 1000 });
  const security = { secure: false } as const;
  const resolveIdentity = makeSessionResolver(sessionStore, security);
  const handler = makeSiteHandler({
    page: PAGE,
    catalog,
    contentOrigin: 'http://content.local',
    sessionHandler: makeSessionHandler({
      store: sessionStore,
      resolveIdentity,
      oauth: makeFakeOAuthProvider({ subject: SUBJECT }),
      callbackUrl: 'http://app.local/session/callback',
      security,
    }),
    apiHandler: makeHttpHandler(service, reports, resolveIdentity),
  });
  return serve({ handler, port: 0 });
};

// Drive GET /session/login then GET /session/callback against the live server, returning the
// session cookie a subsequent write must carry. Plays the identity provider's role: read the state
// the login set, echo it back to the callback with the state cookie. `redirect: 'manual'` so fetch
// hands back the 302 (with its Set-Cookie) instead of following it.
const completeLogin = async (base: string): Promise<string> => {
  const login = await fetch(`${base}/session/login`, { redirect: 'manual' });
  const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('tp_oauth_state='))!;
  const state = /tp_oauth_state=([^;]*)/.exec(stateCookie)![1]!;
  const callback = await fetch(`${base}/session/callback?code=any&state=${state}`, {
    headers: { cookie: `tp_oauth_state=${state}` },
    redirect: 'manual',
  });
  const sessionCookie = callback.headers.getSetCookie().find((c) => c.startsWith('tp_session='))!;
  return sessionCookie.split(';')[0]!;
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

    // 3. Complete the GitHub OAuth dance (login redirect → callback) → a session cookie.
    const cookie = await completeLogin(base);
    expect(cookie).toContain('tp_session=');

    // 4. whoami with the cookie → the authenticated GitHub identity.
    const who = await fetch(`${base}/session`, { headers: { cookie } });
    expect(await who.json()).toEqual({ identity: { subject: 'github:7' } });

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

  it('gates a report until login, then records it against the real session identity', async () => {
    running = await startFrontDoor();
    const base = running.url;

    const report = (playgroundId: string, cookie?: string): Promise<Response> =>
      fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ playgroundId, reason: 'this is spam' }),
      });

    // Log in and mint a real playground to report (generation is itself gated, so this rides the
    // authenticated path end to end).
    const cookie = await completeLogin(base);
    const submit = await fetch(`${base}/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ providerId: 'fake', brief: { description: 'a tiny counter' } }),
    });
    const { handle } = (await submit.json()) as { handle: unknown };
    const poll = await fetch(`${base}/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ handle }),
    });
    const playgroundId = ((await poll.json()) as { playgroundId: string }).playgroundId;

    // 1. Unauthenticated report → 401 at the SAME gate the generation write uses.
    expect((await report(playgroundId)).status).toBe(401);

    // 2. The SAME report, carrying the cookie → 201, and the recorded reporter is the session
    // subject resolved by the gate — not any client-supplied value. This is the whole path over a
    // real socket: cookie → resolver → gate → service → store.
    const recorded = await report(playgroundId, cookie);
    expect(recorded.status).toBe(201);
    const { report: signal } = (await recorded.json()) as {
      report: { playgroundId: string; reporter: string; reason: string };
    };
    expect(signal.playgroundId).toBe(playgroundId);
    expect(signal.reporter).toBe('github:7');
    expect(signal.reason).toBe('this is spam');
  });

  it('rejects a forged callback state as 400 and grants no usable session cookie', async () => {
    running = await startFrontDoor();
    // A callback whose state does not match the cookie is a forged/CSRF attempt — no session minted.
    const res = await fetch(`${running.url}/session/callback?code=any&state=forged`, {
      headers: { cookie: 'tp_oauth_state=real' },
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('tp_session='))).toBe(false);
  });

  it('leaves the read path credential-free — the commons and provider list need no session', async () => {
    running = await startFrontDoor();
    expect((await fetch(`${running.url}/commons`)).status).toBe(200);
    expect((await fetch(`${running.url}/providers`)).status).toBe(200);
  });
});
