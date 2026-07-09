import { describe, expect, it } from 'vitest';
import { makeMemorySessionStore } from './sessionStore.js';
import { makeSessionHandler, makeSessionResolver } from './session.js';
import type { CookieSecurity } from './session.js';
import { Subject } from './identity.js';
import { makeFakeOAuthProvider } from './__fixtures__/fakeOAuthProvider.js';

// The session mechanism's contract: the store maps tokens to principals, the resolver turns a
// request's cookie into Identity | null, and the route handler runs the OAuth login dance and
// reports sessions. Behavior at the seam, never internals. [LAW:behavior-not-structure]

// The cookie policy under test. The default is loopback-dev (no Secure, bare names) so the
// name-based fixtures below read the same cookie the handler writes; a dedicated block exercises
// the secure ({ __Host- } + Secure) edge policy. [LAW:dataflow-not-control-flow]
const INSECURE: CookieSecurity = { secure: false };
const SECURE: CookieSecurity = { secure: true };

const withCookie = (url: string, cookie: string): Request =>
  new Request(url, { headers: { cookie } });

// Pull the tp_session value out of a Set-Cookie header so a test can replay it as a Cookie.
const cookieFromSetCookie = (setCookie: string): string => setCookie.split(';')[0]!;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pull a named cookie's value out of a Set-Cookie line (value is everything up to the first ;). The
// name must sit on a cookie boundary — string start or just after `; ` — and is regex-escaped, so
// `valueOf(x, 'tp_session')` can never substring-match `__Host-tp_session=` (the two are distinct
// cookies). Mirrors production readCookie's strict `===` name equality. [LAW:behavior-not-structure]
const valueOf = (setCookie: string, name: string): string => {
  const match = new RegExp(`(?:^|;\\s*)${escapeRegex(name)}=([^;]*)`).exec(setCookie);
  if (match === null) throw new Error(`no ${name} in: ${setCookie}`);
  return match[1]!;
};

// A controllable clock: time only moves when the test advances it, so expiry is deterministic and
// needs no real sleep. [LAW:no-ambient-temporal-coupling]
const clockFrom = (start: number) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

const TTL_MS = 60_000;
// A store on a fresh clock at t=0 with a ttl no test reaches without advancing — the default for
// tests that exercise non-expiry behavior.
const newStore = () => makeMemorySessionStore({ now: clockFrom(0).now, ttlMs: TTL_MS });

describe('makeMemorySessionStore', () => {
  it('mints a token that resolves back to its principal', async () => {
    const store = newStore();
    const token = await store.create(Subject('dev'));
    expect(await store.lookup(token)).toBe('dev');
  });

  it('returns null for a token it never issued', async () => {
    const store = newStore();
    expect(await store.lookup('not-a-real-token')).toBeNull();
  });

  it('issues distinct tokens for successive sessions', async () => {
    const store = newStore();
    expect(await store.create(Subject('dev'))).not.toBe(await store.create(Subject('dev')));
  });

  it('keeps a session live right up to its ttl, then returns null once it elapses', async () => {
    const clock = clockFrom(0);
    const store = makeMemorySessionStore({ now: clock.now, ttlMs: TTL_MS });
    const token = await store.create(Subject('dev'));

    clock.advance(TTL_MS - 1);
    expect(await store.lookup(token)).toBe('dev');
    clock.advance(1);
    expect(await store.lookup(token)).toBeNull();
  });

  it('destroy ends a session so its token no longer resolves', async () => {
    const store = newStore();
    const token = await store.create(Subject('dev'));
    expect(await store.lookup(token)).toBe('dev');
    await store.destroy(token);
    expect(await store.lookup(token)).toBeNull();
  });

  it('destroy of a token it never issued is a harmless no-op', async () => {
    const store = newStore();
    await expect(store.destroy('not-a-real-token')).resolves.toBeUndefined();
  });
});

describe('makeSessionResolver', () => {
  it('returns null when the request carries no cookie at all', async () => {
    const resolve = makeSessionResolver(newStore(), INSECURE);
    expect(await resolve(new Request('http://app.local/'))).toBeNull();
  });

  it('returns null when the session cookie names a token with no live session', async () => {
    const resolve = makeSessionResolver(newStore(), INSECURE);
    expect(await resolve(withCookie('http://app.local/', 'tp_session=ghost'))).toBeNull();
  });

  it('resolves a live session cookie to its identity', async () => {
    const store = newStore();
    const token = await store.create(Subject('github:42'));
    const resolve = makeSessionResolver(store, INSECURE);
    expect(await resolve(withCookie('http://app.local/', `tp_session=${token}`))).toEqual({ subject: 'github:42' });
  });

  it('resolves an expired session cookie to null — expiry flows through to no identity (-> 401)', async () => {
    const clock = clockFrom(0);
    const store = makeMemorySessionStore({ now: clock.now, ttlMs: TTL_MS });
    const token = await store.create(Subject('github:42'));
    const resolve = makeSessionResolver(store, INSECURE);
    const request = withCookie('http://app.local/', `tp_session=${token}`);

    expect(await resolve(request)).toEqual({ subject: 'github:42' });
    clock.advance(TTL_MS);
    expect(await resolve(request)).toBeNull();
  });

  it('under a secure policy reads the __Host- prefixed session cookie, not the bare name', async () => {
    // The hardened name and the bare name are DIFFERENT cookies: a resolver on the secure policy
    // must ignore a bare `tp_session` (which over HTTPS could only be a downgrade attempt) and read
    // only `__Host-tp_session`. [LAW:one-source-of-truth]
    const store = newStore();
    const token = await store.create(Subject('github:42'));
    const resolve = makeSessionResolver(store, SECURE);
    expect(await resolve(withCookie('http://app.local/', `tp_session=${token}`))).toBeNull();
    expect(await resolve(withCookie('http://app.local/', `__Host-tp_session=${token}`))).toEqual({
      subject: 'github:42',
    });
  });

  it('reads headers ONLY — it never consumes the body, so a write route can still parse it', async () => {
    // THE HARD CONSTRAINT, pinned: resolving identity must not drain request.json(). Build a
    // request with a JSON body, resolve it, then assert the body is still intact and parseable —
    // exactly what the downstream write-route handler depends on. [LAW:no-silent-failure]
    const store = newStore();
    const token = await store.create(Subject('github:42'));
    const resolve = makeSessionResolver(store, INSECURE);
    const request = new Request('http://app.local/generations', {
      method: 'POST',
      headers: { cookie: `tp_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'fake', brief: { description: 'x' } }),
    });

    expect(await resolve(request)).toEqual({ subject: 'github:42' });
    expect(request.bodyUsed).toBe(false);
    expect(await request.json()).toEqual({ providerId: 'fake', brief: { description: 'x' } });
  });
});

const SUBJECT = Subject('github:42');
const CALLBACK = 'http://app.local/session/callback';

const handlerWith = (
  store = newStore(),
  oauth = makeFakeOAuthProvider({ subject: SUBJECT }),
  security: CookieSecurity = INSECURE,
) =>
  makeSessionHandler({
    store,
    resolveIdentity: makeSessionResolver(store, security),
    oauth,
    callbackUrl: CALLBACK,
    security,
  });

// Run GET /session/login and return the state nonce + the cookie a callback must replay.
const beginLogin = async (handler: ReturnType<typeof handlerWith>, stateName = 'tp_oauth_state') => {
  const res = await handler(new Request('http://app.local/session/login'));
  const setCookie = res!.headers.get('set-cookie')!;
  const state = valueOf(setCookie, stateName);
  return { res: res!, state, cookie: `${stateName}=${state}` };
};

describe('makeSessionHandler — GET /session/login (begin OAuth)', () => {
  it('redirects to the provider authorize URL and sets a Lax, HttpOnly state cookie matching the URL state', async () => {
    const { res, state } = await beginLogin(handlerWith());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    // The state in the redirect URL is the SAME nonce as the cookie — the CSRF round-trip's two halves.
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK);
    const setCookie = res.headers.get('set-cookie')!;
    // Lax is load-bearing: the callback is a cross-site top-level navigation a Strict cookie would drop.
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=');
  });
});

describe('makeSessionHandler — GET /session/callback (complete OAuth)', () => {
  it('exchanges the code, mints a session, sets a Strict session cookie, and redirects home', async () => {
    const store = newStore();
    const handler = handlerWith(store);
    const { state, cookie } = await beginLogin(handler);

    const res = await handler(
      withCookie(`http://app.local/session/callback?code=any-code&state=${state}`, cookie),
    );
    expect(res!.status).toBe(302);
    expect(res!.headers.get('location')).toBe('/');

    const setCookies = res!.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith('tp_session='))!;
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    // The minted session resolves to the principal the provider authenticated.
    expect(await store.lookup(valueOf(sessionCookie, 'tp_session'))).toBe('github:42');
    // The spent state cookie is cleared in the same response.
    expect(setCookies.some((c) => c.startsWith('tp_oauth_state=') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('rejects a state that does not match the cookie as 400 and mints no session', async () => {
    const store = newStore();
    const handler = handlerWith(store);
    await beginLogin(handler);
    const res = await handler(
      withCookie('http://app.local/session/callback?code=any&state=forged', 'tp_oauth_state=real'),
    );
    expect(res!.status).toBe(400);
    expect(res!.headers.getSetCookie().some((c) => c.startsWith('tp_session='))).toBe(false);
  });

  it('rejects a callback with no state cookie at all as 400 — a forged or expired login', async () => {
    const res = await handlerWith()(new Request('http://app.local/session/callback?code=any&state=x'));
    expect(res!.status).toBe(400);
    expect(res!.headers.getSetCookie().some((c) => c.startsWith('tp_session='))).toBe(false);
  });

  it('surfaces a failed provider exchange as 502, never a silent anonymous session', async () => {
    const store = newStore();
    const handler = handlerWith(store, makeFakeOAuthProvider({ subject: SUBJECT, failingCode: 'bad' }));
    const { state, cookie } = await beginLogin(handler);
    const res = await handler(
      withCookie(`http://app.local/session/callback?code=bad&state=${state}`, cookie),
    );
    expect(res!.status).toBe(502);
    expect(res!.headers.getSetCookie().some((c) => c.startsWith('tp_session='))).toBe(false);
  });

  it('the session cookie it sets resolves back to an identity through the same store', async () => {
    const store = newStore();
    const handler = handlerWith(store);
    const { state, cookie } = await beginLogin(handler);
    const res = await handler(
      withCookie(`http://app.local/session/callback?code=any&state=${state}`, cookie),
    );
    const sessionCookie = res!.headers.getSetCookie().find((c) => c.startsWith('tp_session='))!;
    expect(
      await makeSessionResolver(store, INSECURE)(
        withCookie('http://app.local/', cookieFromSetCookie(sessionCookie)),
      ),
    ).toEqual({ subject: 'github:42' });
  });

  it('under a secure policy sets __Host- Secure cookies through the whole login dance', async () => {
    // The cookie hardening the deploy turns on: over HTTPS the state and session cookies are both
    // __Host- prefixed and Secure, and the minted session still resolves. [LAW:single-enforcer]
    const store = newStore();
    const handler = handlerWith(store, makeFakeOAuthProvider({ subject: SUBJECT }), SECURE);
    const { res: loginRes, state, cookie } = await beginLogin(handler, '__Host-tp_oauth_state');
    const stateSetCookie = loginRes.headers.get('set-cookie')!;
    expect(stateSetCookie.startsWith('__Host-tp_oauth_state=')).toBe(true);
    expect(stateSetCookie).toContain('Secure');
    expect(stateSetCookie).toContain('SameSite=Lax');

    const res = await handler(
      withCookie(`http://app.local/session/callback?code=any&state=${state}`, cookie),
    );
    const sessionCookie = res!.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_session='))!;
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).not.toContain('Domain');
    expect(await store.lookup(valueOf(sessionCookie, '__Host-tp_session'))).toBe('github:42');
  });
});

describe('makeSessionHandler — GET /session (whoami)', () => {
  it('returns identity null when there is no session', async () => {
    const res = await handlerWith()(new Request('http://app.local/session'));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ identity: null });
  });

  it('returns the identity the resolver derives from a live cookie', async () => {
    const store = newStore();
    const token = await store.create(Subject('github:42'));
    const res = await handlerWith(store)(withCookie('http://app.local/session', `tp_session=${token}`));
    expect(await res!.json()).toEqual({ identity: { subject: 'github:42' } });
  });
});

describe('makeSessionHandler — DELETE /session (logout)', () => {
  const logout = (handler: ReturnType<typeof handlerWith>, cookie?: string): Promise<Response | null> =>
    handler(new Request('http://app.local/session', { method: 'DELETE', headers: cookie ? { cookie } : {} }));

  it('destroys the session so its token no longer resolves, and clears the cookie', async () => {
    const store = newStore();
    const token = await store.create(Subject('github:42'));
    const handler = handlerWith(store);

    const res = await logout(handler, `tp_session=${token}`);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ identity: null });
    // The store-side end is the real logout — the token is dead regardless of the browser.
    expect(await store.lookup(token)).toBeNull();
    // The cleared cookie names the same cookie with an empty value and Max-Age=0 so the browser drops it.
    const setCookie = res!.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tp_session=;');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('HttpOnly');
  });

  it('is idempotent: logout with no cookie still clears and reports no identity', async () => {
    const res = await logout(handlerWith());
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ identity: null });
    expect(res!.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});

describe('makeSessionHandler — pass-through', () => {
  it('returns null for any route that is not a session route', async () => {
    const handler = handlerWith();
    expect(await handler(new Request('http://app.local/generations', { method: 'POST' }))).toBeNull();
    expect(await handler(new Request('http://app.local/providers'))).toBeNull();
    // The old shared-secret POST /session is gone — it is no longer a session route.
    expect(await handler(new Request('http://app.local/session', { method: 'POST' }))).toBeNull();
  });
});
