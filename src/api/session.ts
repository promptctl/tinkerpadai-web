import { createHash, timingSafeEqual } from 'node:crypto';
import { Subject } from './identity.js';
import type { IdentityResolver } from './identity.js';
import type { SessionStore } from './sessionStore.js';
import { readCookie, serializeCookie } from './cookies.js';

// THE SESSION MECHANISM behind the identity seam. Two parts join here: the cookie-backed
// resolver (the VALUE the composition root swaps in for localIdentityResolver, turning the
// write-path gate real) and the route handler that establishes and reports a session. The
// enforcer (makeHttpHandler) is untouched — it still only ever sees Identity | null.
// [LAW:locality-or-seam]

// The dev principal a successful login grants. One configured secret ⇒ one dev identity; a
// real, multi-principal provider is a later slice (qw8.5) behind this same seam.
const DEV_SUBJECT = Subject('dev');

// The single name under which the session token rides as a cookie. The resolver READS it and
// the login route WRITES it, so it lives once, here, where both can see it — the two sides
// cannot drift to different names. [LAW:one-source-of-truth]
const SESSION_COOKIE = 'tp_session';

// The cookie's identity attributes — the ones a browser matches on to know two Set-Cookies name
// the SAME cookie. Login sets the cookie with these; logout clears it by re-emitting them with an
// empty value and Max-Age=0. They live once so the set and the clear cannot drift to a different
// Path/SameSite and leave a logout that fails to replace the cookie it meant to. [LAW:one-source-of-truth]
const SESSION_COOKIE_ATTRS = { httpOnly: true, sameSite: 'Strict', path: '/' } as const;

// THE SWAP TARGET. A session-backed IdentityResolver: read the cookie, resolve the token to a
// principal through the store, return the Identity or null. This replaces localIdentityResolver
// at the composition root and nothing else changes — the enforcer branches on the returned
// value exactly as before. [LAW:dataflow-not-control-flow]
export const makeSessionResolver = (store: SessionStore): IdentityResolver => (request) => {
  // HEADERS ONLY — never request.json()/body. The body is consumed downstream by the write-route
  // handler (readJson); reading it here would leave that stream drained and break every write
  // route's parse. This is the seam's load-bearing constraint, enforced by reading the cookie
  // header and nothing else. [LAW:no-silent-failure]
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (token === null) return null;
  const subject = store.lookup(token);
  return subject === null ? null : { subject };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Constant-time secret check. Hash both sides to a fixed 32-byte digest so timingSafeEqual never
// throws on a length mismatch AND the comparison cannot early-exit on the first differing byte —
// the response time leaks neither the secret's length nor any prefix of it. [LAW:no-silent-failure]
const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const secretsMatch = (provided: string, configured: string): boolean =>
  timingSafeEqual(sha256(provided), sha256(configured));

export interface SessionHandlerDeps {
  // The store the login route mints sessions into.
  readonly store: SessionStore;
  // The same resolver wired into the enforcer — whoami reports exactly what the gate would see,
  // so the two cannot disagree about who a request is. [LAW:one-source-of-truth]
  readonly resolveIdentity: IdentityResolver;
  // The configured shared secret a dev login must present. Required: there is no "auth disabled"
  // state — without a secret there is no app, so the dev login is always a real check.
  readonly secret: string;
}

const json = (data: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

// THE SESSION ROUTE HANDLER — owns exactly the session lifecycle routes and passes everything
// else through as null, so the surface it composes into never enumerates auth routes itself.
// [LAW:decomposition]
//
// - POST /session (login): present the shared secret; on a match, mint a session and set the
//   HttpOnly, host-scoped, SameSite=Strict cookie. This route is deliberately NOT in the
//   enforcer's WRITE_ROUTES — you cannot be authenticated to authenticate.
// - GET /session (whoami): public and credential-free to call; returns the identity the resolver
//   derives from this request, or null. The one read surface for "who am I".
// - DELETE /session (logout): destroy the session in the store and clear the cookie. Idempotent and
//   unauthenticated — also NOT in WRITE_ROUTES, resolved here before the enforcer.
export const makeSessionHandler = (
  deps: SessionHandlerDeps,
): ((request: Request) => Promise<Response | null>) => {
  const { store, resolveIdentity, secret } = deps;
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'POST /session': {
        // Read the body HERE — this is the login route, not the resolver, so consuming the body
        // is correct (the resolver's headers-only rule is about the write routes whose body the
        // service parses, not this one).
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'body is not valid JSON' }, 400);
        }
        const provided = isRecord(body) && typeof body.secret === 'string' ? body.secret : '';
        // A wrong (or missing) secret is an unauthenticated login attempt: 401 as a value, with a
        // message, never a silent rejection or a 500. [LAW:no-silent-failure]
        if (!secretsMatch(provided, secret)) return json({ error: 'invalid secret' }, 401);
        const token = store.create(DEV_SUBJECT);
        const cookie = serializeCookie(SESSION_COOKIE, token, SESSION_COOKIE_ATTRS);
        return json({ identity: { subject: DEV_SUBJECT } }, 200, { 'set-cookie': cookie });
      }
      case 'GET /session':
        // identity | null, derived by the SAME resolver the gate uses — whoami can never claim an
        // identity the write path would reject, or vice versa.
        return json({ identity: resolveIdentity(request) }, 200);
      case 'DELETE /session': {
        // Logout: end the session server-side and tell the browser to drop the cookie. The store is
        // the lifecycle owner, so destroy() is the real end; the cleared cookie (empty value,
        // Max-Age=0) is only the browser-side hint. Reading the cookie is the one trust-boundary
        // place a token may legitimately be absent — no cookie means nothing to destroy, but we
        // still clear and report identity:null, so logout is idempotent. NOT a WRITE_ROUTE: it is
        // resolved here before the enforcer and needs no auth — logging out when already logged out
        // is a harmless no-op. [LAW:no-ambient-temporal-coupling] [LAW:no-silent-failure]
        const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
        if (token !== null) store.destroy(token);
        const cleared = serializeCookie(SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRS, maxAge: 0 });
        return json({ identity: null }, 200, { 'set-cookie': cleared });
      }
      default:
        return null;
    }
  };
};
