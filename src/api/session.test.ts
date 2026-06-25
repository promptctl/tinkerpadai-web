import { describe, expect, it } from 'vitest';
import { makeMemorySessionStore } from './sessionStore.js';
import { makeSessionHandler, makeSessionResolver } from './session.js';
import { Subject } from './identity.js';

// The session mechanism's contract: the store maps tokens to principals, the resolver turns a
// request's cookie into Identity | null, and the route handler establishes and reports sessions.
// Behavior at the seam, never internals. [LAW:behavior-not-structure]

const SECRET = 'open-sesame';

const withCookie = (url: string, cookie: string): Request =>
  new Request(url, { headers: { cookie } });

// Pull the tp_session value out of a Set-Cookie header so a test can replay it as a Cookie.
const cookieFromSetCookie = (setCookie: string): string => setCookie.split(';')[0]!;

describe('makeMemorySessionStore', () => {
  it('mints a token that resolves back to its principal', () => {
    const store = makeMemorySessionStore();
    const token = store.create(Subject('dev'));
    expect(store.lookup(token)).toBe('dev');
  });

  it('returns null for a token it never issued', () => {
    const store = makeMemorySessionStore();
    expect(store.lookup('not-a-real-token')).toBeNull();
  });

  it('issues distinct tokens for successive sessions', () => {
    const store = makeMemorySessionStore();
    expect(store.create(Subject('dev'))).not.toBe(store.create(Subject('dev')));
  });
});

describe('makeSessionResolver', () => {
  it('returns null when the request carries no cookie at all', () => {
    const resolve = makeSessionResolver(makeMemorySessionStore());
    expect(resolve(new Request('http://app.local/'))).toBeNull();
  });

  it('returns null when the session cookie names a token with no live session', () => {
    const resolve = makeSessionResolver(makeMemorySessionStore());
    expect(resolve(withCookie('http://app.local/', 'tp_session=ghost'))).toBeNull();
  });

  it('resolves a live session cookie to its identity', () => {
    const store = makeMemorySessionStore();
    const token = store.create(Subject('dev'));
    const resolve = makeSessionResolver(store);
    expect(resolve(withCookie('http://app.local/', `tp_session=${token}`))).toEqual({ subject: 'dev' });
  });

  it('reads headers ONLY — it never consumes the body, so a write route can still parse it', async () => {
    // THE HARD CONSTRAINT, pinned: resolving identity must not drain request.json(). Build a
    // request with a JSON body, resolve it, then assert the body is still intact and parseable —
    // exactly what the downstream write-route handler depends on. [LAW:no-silent-failure]
    const store = makeMemorySessionStore();
    const token = store.create(Subject('dev'));
    const resolve = makeSessionResolver(store);
    const request = new Request('http://app.local/generations', {
      method: 'POST',
      headers: { cookie: `tp_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'fake', brief: { description: 'x' } }),
    });

    expect(resolve(request)).toEqual({ subject: 'dev' });
    expect(request.bodyUsed).toBe(false);
    expect(await request.json()).toEqual({ providerId: 'fake', brief: { description: 'x' } });
  });
});

describe('makeSessionHandler — POST /session (login)', () => {
  const handlerWith = (store = makeMemorySessionStore()) =>
    makeSessionHandler({ store, resolveIdentity: makeSessionResolver(store), secret: SECRET });

  const login = (handler: ReturnType<typeof handlerWith>, secret: unknown): Promise<Response | null> =>
    handler(
      new Request('http://app.local/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      }),
    );

  it('establishes a session and sets a host-scoped, HttpOnly, SameSite cookie on the right secret', async () => {
    const res = await login(handlerWith(), SECRET);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ identity: { subject: 'dev' } });
    const setCookie = res!.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tp_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Domain');
  });

  it('rejects a wrong secret as 401 and sets no cookie', async () => {
    const res = await login(handlerWith(), 'wrong-secret');
    expect(res!.status).toBe(401);
    expect(res!.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a login with no secret field as 401, never a silent grant', async () => {
    const handler = handlerWith();
    const res = await handler(
      new Request('http://app.local/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res!.status).toBe(401);
  });

  it('the cookie it sets resolves back to an identity through the same store', async () => {
    const store = makeMemorySessionStore();
    const handler = handlerWith(store);
    const res = await login(handler, SECRET);
    const cookie = cookieFromSetCookie(res!.headers.get('set-cookie')!);
    expect(makeSessionResolver(store)(withCookie('http://app.local/', cookie))).toEqual({ subject: 'dev' });
  });
});

describe('makeSessionHandler — GET /session (whoami)', () => {
  it('returns identity null when there is no session', async () => {
    const store = makeMemorySessionStore();
    const handler = makeSessionHandler({ store, resolveIdentity: makeSessionResolver(store), secret: SECRET });
    const res = await handler(new Request('http://app.local/session'));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ identity: null });
  });

  it('returns the identity the resolver derives from a live cookie', async () => {
    const store = makeMemorySessionStore();
    const token = store.create(Subject('dev'));
    const handler = makeSessionHandler({ store, resolveIdentity: makeSessionResolver(store), secret: SECRET });
    const res = await handler(withCookie('http://app.local/session', `tp_session=${token}`));
    expect(await res!.json()).toEqual({ identity: { subject: 'dev' } });
  });
});

describe('makeSessionHandler — pass-through', () => {
  it('returns null for any route that is not a session route', async () => {
    const store = makeMemorySessionStore();
    const handler = makeSessionHandler({ store, resolveIdentity: makeSessionResolver(store), secret: SECRET });
    expect(await handler(new Request('http://app.local/generations', { method: 'POST' }))).toBeNull();
    expect(await handler(new Request('http://app.local/providers'))).toBeNull();
  });
});
