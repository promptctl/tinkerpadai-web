import { describe, expect, it } from 'vitest';
import { makeApp } from '../app.js';
import { ProviderRegistry } from '../provider/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { SessionHandle } from '../provider/index.js';
import { makeMemoryArtifactStore, makeMemoryCatalog, makeMemoryReportStore, makeMemoryThumbnailStore, PlaygroundId, VersionId } from '../storage/index.js';
import type { ArtifactStore, Catalog } from '../storage/index.js';
import { makeMemorySessionStore, passThroughValidator, Subject } from '../api/index.js';
import { makeFakeOAuthProvider } from '../api/__fixtures__/fakeOAuthProvider.js';
import { makeTestQuota } from '../api/__fixtures__/testQuota.js';
import { makeFrontDoorRouter } from './frontDoorRouter.js';
import { AppOrigin } from './originGuard.js';

// The two-origin router's contract: a request to the APP host reaches the app pages, the session
// surface, and the API; a request to the CONTENT host reaches ONLY the sandboxed raw-html handler
// under the strict CSP — the same path (`/session`) is auth on one host and a sealed 404 on the
// other. This is the sandbox boundary on a single fetch entry, asserted as behavior at the seam with
// a memory-backed app (no R2/D1/env). [LAW:behavior-not-structure] [LAW:single-enforcer]

const APP_ORIGIN = AppOrigin('https://app.tinkerpad.test');
const CONTENT_ORIGIN = 'https://content.tinkerpad.test';

const handle = (session: string, turn: string): SessionHandle => ({
  providerId: ProviderId('fake'),
  sessionId: SessionId(session),
  turnId: TurnId(turn),
});

// A memory-backed app in the SAME shape the edge builds: empty registry (generation disabled),
// no-op disposer, secure cookies. Only the persistence backends differ from the real Worker — which
// is the whole point of the injected seams. [LAW:one-type-per-behavior]
const makeMemoryApp = (): { catalog: Catalog; store: ArtifactStore; router: ReturnType<typeof makeFrontDoorRouter> } => {
  const store = makeMemoryArtifactStore();
  const catalog = makeMemoryCatalog();
  const app = makeApp({
    registry: new ProviderRegistry(),
    store,
    catalog,
    thumbnails: makeMemoryThumbnailStore(),
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
  const router = makeFrontDoorRouter({ app, page: '<!doctype html><title>front door</title>', contentOrigin: CONTENT_ORIGIN, appOrigin: APP_ORIGIN });
  return { catalog, store, router };
};

const seedPlayground = async (catalog: Catalog, store: ArtifactStore, html: string): Promise<string> => {
  const version = await store.put({ html });
  const playground = await catalog.createPlayground({
    handle: handle('session-1', 'turn-1'),
    prompt: 'a bouncing ball',
    version,
    lineage: null,
    author: Subject('github:1'),
    tags: [],
  });
  return playground.id;
};

describe('makeFrontDoorRouter — app host', () => {
  it('serves the front door page at / on the app host', async () => {
    const { router } = makeMemoryApp();
    const res = await router(new Request(`${APP_ORIGIN}/`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('front door');
  });

  it('serves the commons list (reads the catalog) on the app host', async () => {
    const { catalog, store, router } = makeMemoryApp();
    await seedPlayground(catalog, store, '<html><body>ball</body></html>');
    const res = await router(new Request(`${APP_ORIGIN}/commons`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('a bouncing ball');
  });

  it('exposes the session (whoami) surface on the app host', async () => {
    const { router } = makeMemoryApp();
    const res = await router(new Request(`${APP_ORIGIN}/session`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: null });
  });
});

describe('makeFrontDoorRouter — content host', () => {
  it('serves the raw playground html under the strict CSP on the content host', async () => {
    const { catalog, store, router } = makeMemoryApp();
    const html = '<html><body><script>1</script>ball</body></html>';
    const id = await seedPlayground(catalog, store, html);
    const res = await router(new Request(`${CONTENT_ORIGIN}/?id=${id}`));
    expect(res.status).toBe(200);
    // The sandbox CSP is present, and the body is the raw file byte-for-byte (live code, unescaped).
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(await res.text()).toBe(html);
  });

  it('gives the content host NO app surface: /session is a sealed 404, not the whoami', async () => {
    const { router } = makeMemoryApp();
    const res = await router(new Request(`${CONTENT_ORIGIN}/session`));
    // The app's whoami would be a 200 identity JSON; on the content host the same path is the content
    // handler's sealed not-found — proof the content origin cannot reach the session surface.
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await res.text()).not.toContain('identity');
  });

  it('gives the content host NO generation API: POST /generations is a sealed 404', async () => {
    const { router } = makeMemoryApp();
    const res = await router(new Request(`${CONTENT_ORIGIN}/generations`, { method: 'POST' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
