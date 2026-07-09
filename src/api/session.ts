import { randomBytes } from 'node:crypto';
import type { Subject } from '../identity/index.js';
import type { IdentityResolver } from './identity.js';
import type { OAuthProvider } from './oauth.js';
import type { SessionStore } from './sessionStore.js';
import type { CookieAttributes } from './cookies.js';
import { readCookie, serializeCookie } from './cookies.js';

// THE SESSION MECHANISM behind the identity seam. Two parts join here: the cookie-backed
// resolver (the VALUE the composition root swaps in for localIdentityResolver, turning the
// write-path gate real) and the route handler that establishes and reports a session. The
// enforcer (makeHttpHandler) is untouched — it still only ever sees Identity | null. The login
// MECHANISM is a delegated OAuth provider (GitHub today) reached through the OAuthProvider seam,
// so swapping the identity provider changes only which instance is wired here, never this flow.
// [LAW:locality-or-seam]

// THE COOKIE SECURITY POLICY — the one production-hardening decision, supplied as a VALUE by the
// composition root rather than read from the environment inside this module. The HTTPS edge passes
// `{ secure: true }`; http loopback dev passes `{ secure: false }`. It is the single input from
// which both the `Secure` attribute AND the `__Host-` name prefix are derived, so the two can never
// disagree (a `__Host-` name without Secure is rejected by the browser). This is variability living
// in a value at a seam, not a branch on `process.env` buried in the login flow.
// [LAW:dataflow-not-control-flow] [LAW:types-are-the-program]
export interface CookieSecurity {
  readonly secure: boolean;
}

// The host-scoped base names of the two auth cookies. The resolver READS the session name and the
// login callback WRITES it, so it lives once, here, where both derive it identically and cannot
// drift. Under a secure policy each gains the `__Host-` prefix — a browser-enforced guarantee the
// cookie is Secure, Path=/, and Domain-less, so the host-scoping the credential boundary rests on
// stops being merely a convention. [LAW:one-source-of-truth]
const SESSION_COOKIE_BASE = 'tp_session';
const STATE_COOKIE_BASE = 'tp_oauth_state';
const hostPrefixed = (base: string, secure: boolean): string => (secure ? `__Host-${base}` : base);

// The resolved cookie policy: the effective names plus the base attributes each Set-Cookie carries.
// SESSION is SameSite=Strict — the session credential's CSRF defense, withheld from cross-site
// requests. STATE is SameSite=**Lax**, LOAD-BEARING: the OAuth callback arrives as a top-level
// navigation the identity provider triggers from ITS origin, so a Strict cookie would be withheld
// and EVERY login would fail state verification; Lax is sent on exactly this top-level cross-site GET
// and nothing weaker. Both are HttpOnly and share the one `secure` value. Derived once from the
// policy so the set and the clear cannot drift to a different Path/SameSite/Secure and leave a logout
// that fails to replace the cookie it meant to. [LAW:one-source-of-truth]
interface CookiePolicy {
  readonly sessionName: string;
  readonly sessionAttrs: CookieAttributes;
  readonly stateName: string;
  readonly stateAttrs: CookieAttributes;
}
const cookiePolicy = ({ secure }: CookieSecurity): CookiePolicy => ({
  sessionName: hostPrefixed(SESSION_COOKIE_BASE, secure),
  sessionAttrs: { httpOnly: true, sameSite: 'Strict', path: '/', secure },
  stateName: hostPrefixed(STATE_COOKIE_BASE, secure),
  stateAttrs: { httpOnly: true, sameSite: 'Lax', path: '/', secure },
});

// The login window: how long a started login may sit before its callback. 10 minutes — long
// enough for a real sign-in, short enough that a stale state cannot linger. The store owns
// session lifetime; this only bounds the half-finished login. [LAW:no-ambient-temporal-coupling]
const STATE_TTL_SECONDS = 10 * 60;

// THE SWAP TARGET. A session-backed IdentityResolver: read the cookie, resolve the token to a
// principal through the store, return the Identity or null. This replaces localIdentityResolver
// at the composition root and nothing else changes — the enforcer awaits and branches on the
// returned value exactly as before. Async because the store lookup it fronts is genuine I/O against
// a durable backend at the edge. [LAW:dataflow-not-control-flow] [LAW:effects-at-boundaries]
export const makeSessionResolver =
  (store: SessionStore, security: CookieSecurity): IdentityResolver =>
  async (request) => {
    const { sessionName } = cookiePolicy(security);
    // HEADERS ONLY — never request.json()/body. The body is consumed downstream by the write-route
    // handler (readJson); reading it here would leave that stream drained and break every write
    // route's parse. This is the seam's load-bearing constraint, enforced by reading the cookie
    // header and nothing else. [LAW:no-silent-failure]
    const token = readCookie(request.headers.get('cookie'), sessionName);
    if (token === null) return null;
    const subject = await store.lookup(token);
    return subject === null ? null : { subject };
  };

export interface SessionHandlerDeps {
  // The store the login callback mints sessions into.
  readonly store: SessionStore;
  // The same resolver wired into the enforcer — whoami reports exactly what the gate would see,
  // so the two cannot disagree about who a request is. [LAW:one-source-of-truth]
  readonly resolveIdentity: IdentityResolver;
  // The delegated identity provider (GitHub today) reached through the seam: it builds the
  // authorize redirect and turns a callback code into the authenticated Subject. Swapping the
  // provider is swapping this instance at the composition root — this flow is untouched.
  readonly oauth: OAuthProvider;
  // The absolute URL the identity provider redirects the browser back to (this app's
  // GET /session/callback). It must match what the provider has registered, so it is one
  // configured value used identically at authorize and exchange time, not derived per request
  // (which would drift behind a proxy). [LAW:one-source-of-truth]
  readonly callbackUrl: string;
  // The cookie security policy (Secure + `__Host-`), supplied by the composition root. The SAME
  // value must reach the resolver above, so the name this handler WRITES matches the name the
  // resolver READS. [LAW:one-source-of-truth]
  readonly security: CookieSecurity;
}

const json = (data: unknown, status: number): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// A redirect carrying one or more Set-Cookie headers. Built through Headers.append so MULTIPLE
// cookies (the callback both sets the session and clears the state) survive as distinct headers —
// a plain object would let the second overwrite the first. [LAW:no-silent-failure]
const redirect = (location: string, cookies: readonly string[]): Response => {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
};

// THE SESSION ROUTE HANDLER — owns exactly the session lifecycle routes and passes everything
// else through as null, so the surface it composes into never enumerates auth routes itself.
// [LAW:decomposition]
//
// - GET /session/login (begin): mint a CSRF state, set the SameSite=Lax state cookie, and redirect
//   the browser to the identity provider's authorize page. Credential-free to call — you cannot be
//   authenticated to authenticate.
// - GET /session/callback (complete): the provider returns the browser here with code+state. Verify
//   state against the cookie (CSRF), exchange the code for a Subject through the provider, mint a
//   session, set the HttpOnly SameSite=Strict session cookie, and redirect home.
// - GET /session (whoami): public and credential-free to call; returns the identity the resolver
//   derives from this request, or null. The one read surface for "who am I".
// - DELETE /session (logout): destroy the session in the store and clear the cookie. Idempotent and
//   unauthenticated.
export const makeSessionHandler = (
  deps: SessionHandlerDeps,
): ((request: Request) => Promise<Response | null>) => {
  const { store, resolveIdentity, oauth, callbackUrl, security } = deps;
  // Derived once at construction from the injected policy — the whole handler and the resolver see
  // identical names and attributes. [LAW:one-source-of-truth]
  const { sessionName, sessionAttrs, stateName, stateAttrs } = cookiePolicy(security);
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /session/login': {
        // 32 random bytes, base64url: an unguessable CSRF nonce the callback must echo back. It
        // rides in the Lax state cookie AND in the authorize URL's state param; the callback
        // proving the two match is what rejects a forged or cross-session callback.
        const state = randomBytes(32).toString('base64url');
        const stateCookie = serializeCookie(stateName, state, { ...stateAttrs, maxAge: STATE_TTL_SECONDS });
        return redirect(oauth.authorizeUrl({ state, redirectUri: callbackUrl }), [stateCookie]);
      }
      case 'GET /session/callback': {
        // The state cookie is cleared on EVERY outcome below — it is single-use, so a started
        // login never leaves a reusable nonce behind. [LAW:no-silent-failure]
        const clearState = serializeCookie(stateName, '', { ...stateAttrs, maxAge: 0 });
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const expectedState = readCookie(request.headers.get('cookie'), stateName);
        // CSRF gate: a missing code, a missing/empty state on either side, or a mismatch is a
        // forged or expired callback — rejected loudly as 400, never exchanged. [LAW:no-silent-failure]
        if (
          code === null ||
          returnedState === null ||
          expectedState === null ||
          returnedState === '' ||
          returnedState !== expectedState
        ) {
          const headers = new Headers({ 'content-type': 'application/json' });
          headers.append('set-cookie', clearState);
          return new Response(JSON.stringify({ error: 'invalid oauth callback' }), { status: 400, headers });
        }
        // Exchange the code for the authenticated principal. A thrown exchange (provider error,
        // rejected code) is the identity provider failing us — surfaced as 502 with its message,
        // never a silent fallback that would mint an anonymous session. [LAW:no-silent-failure]
        let subject: Subject;
        try {
          subject = await oauth.authenticate({ code, redirectUri: callbackUrl });
        } catch (error) {
          const headers = new Headers({ 'content-type': 'application/json' });
          headers.append('set-cookie', clearState);
          const message = error instanceof Error ? error.message : String(error);
          return new Response(JSON.stringify({ error: `oauth exchange failed: ${message}` }), { status: 502, headers });
        }
        const token = await store.create(subject);
        const sessionCookie = serializeCookie(sessionName, token, sessionAttrs);
        // Home, with the session set and the spent state cleared. The browser lands authenticated.
        return redirect('/', [sessionCookie, clearState]);
      }
      case 'GET /session':
        // identity | null, derived by the SAME resolver the gate uses — whoami can never claim an
        // identity the write path would reject, or vice versa.
        return json({ identity: await resolveIdentity(request) }, 200);
      case 'DELETE /session': {
        // Logout: end the session server-side and tell the browser to drop the cookie. The store is
        // the lifecycle owner, so destroy() is the real end; the cleared cookie (empty value,
        // Max-Age=0) is only the browser-side hint. Reading the cookie is the one trust-boundary
        // place a token may legitimately be absent — no cookie means nothing to destroy, but we
        // still clear and report identity:null, so logout is idempotent. NOT a WRITE_ROUTE: it is
        // resolved here before the enforcer and needs no auth — logging out when already logged out
        // is a harmless no-op. [LAW:no-ambient-temporal-coupling] [LAW:no-silent-failure]
        const token = readCookie(request.headers.get('cookie'), sessionName);
        if (token !== null) await store.destroy(token);
        const cleared = serializeCookie(sessionName, '', { ...sessionAttrs, maxAge: 0 });
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.append('set-cookie', cleared);
        return new Response(JSON.stringify({ identity: null }), { status: 200, headers });
      }
      default:
        return null;
    }
  };
};
