import { readFile } from 'node:fs/promises';
import { makeNodeApp } from './nodeApp.js';
import { DEFAULT_GENERATION_POLICY, Subject, startTurnRetentionSweeper } from '../api/index.js';
import type { OAuthProvider } from '../api/index.js';
import { resolveBrowserExecutablePath } from '../api/headlessArtifactValidator.js';
import { diagnosticsDirOf, startDiagnosticsRetentionSweeper, startWorkdirJanitor } from '../provider/index.js';
import { generateIndexHtml } from './generateIndexHtml.js';
import { makeSiteHandler } from './siteHandler.js';
import { makeContentHandler } from './contentHandler.js';
import { appOriginOf } from './originGuard.js';
import { serve } from './server.js';
import { resolveServerConfig } from './serverConfig.js';

// THE DEV ENTRY POINT — identical to main.ts except the external identity provider. Production
// requires a registered GitHub OAuth app and hard-fails without one; that gate is correct for
// the real deployment but makes the creation loop impossible to DRIVE locally without secrets.
// This entry swaps ONLY the IdP for a local loopback that completes the real session dance —
// the same CSRF-state round-trip, cookie minting, and write-gate flip exercised in production —
// so the whole describe->generate->store->use->refine->remix loop can be driven in a browser.
// The engine (the real tmux/Claude-Code provider, store, catalog) is untouched and fully real;
// only "who is this principal, proven by a third party" is stubbed to a fixed local subject.
// [LAW:effects-at-boundaries] [LAW:locality-or-seam]

// A loopback OAuthProvider: authorizeUrl redirects the browser straight back to the app's own
// callback with a fixed code and the state echoed — exactly the shape a real IdP returns, so the
// callback's state-verification and cookie-minting run for real. The code exchange is the one
// step stubbed — authenticate ignores the code and brands a fixed dev subject, which IS the
// swapped IdP this entry exists to swap. No network, no secret. [LAW:one-type-per-behavior]
const makeDevOAuthProvider = (subject: Subject): OAuthProvider => ({
  authorizeUrl: ({ state, redirectUri }) =>
    `${redirectUri}?${new URLSearchParams({ code: 'dev-code', state }).toString()}`,
  authenticate: async () => subject,
});

// Dev derives the front door IN-PROCESS from its template, so every tsx-watch restart (which fires
// when frontDoorChrome or any imported source changes) serves a page regenerated from the same live
// source the server pages use — the homepage can never drift stale from the chrome mid-session. Prod
// (main.ts) serves the committed, pre-built index.html; the drift test guarantees the two are equal.
// [LAW:no-ambient-temporal-coupling] [LAW:one-source-of-truth]
const templateUrl = new URL('./index.html.tmpl', import.meta.url);

// The dev per-attempt deadline, stated by the composition root through the generation policy.
// Wave-1 seeding (tinkerpadai-seeding-bw1.1) measured real briefs hovering near — and four of them
// past — the old 5-minute default, so dev uses 10 minutes; production's deadline and the shared
// retry budget are the deliberate quality-ppu.2 policy. Dev takes the default retry budget so the
// local loop behaves like production. [LAW:no-ambient-temporal-coupling] [LAW:locality-or-seam]
const DEV_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

// The fixed principal the loopback IdP mints — and, in dev, the sole moderation admin, so the whole
// report→review→unlist→relist loop (moderation-5g7.2) can be driven locally without configuring an
// allowlist. In production the admin allowlist is real config (TINKERPAD_ADMIN_SUBJECTS); here the
// one dev subject IS the admin. [LAW:one-source-of-truth]
const DEV_SUBJECT = Subject('dev:local');

const main = async (): Promise<void> => {
  const { dataDir, port, contentPort, oauthCallbackUrl, frontDoorHost } = resolveServerConfig(import.meta.url);

  const app = makeNodeApp({
    dataDir,
    oauth: makeDevOAuthProvider(DEV_SUBJECT),
    oauthCallbackUrl,
    // Loopback dev over http://127.0.0.1 cannot offer HTTPS, so the cookie is not Secure. The real
    // session dance (state round-trip, cookie minting, write-gate flip) is otherwise identical.
    cookieSecurity: { secure: false },
    // The dev subject is the local admin — the moderation console works in the loopback loop.
    adminSubjects: new Set([DEV_SUBJECT]),
    generationPolicy: { timeoutMs: DEV_GENERATION_TIMEOUT_MS, maxAttempts: DEFAULT_GENERATION_POLICY.maxAttempts },
    // The dev loop drives real generation, so it runs the real functional gate too — the same headless
    // Chrome production uses. TINKERPAD_CHROME_PATH overrides; otherwise a known install is probed.
    browserExecutablePath: resolveBrowserExecutablePath(process.env),
  });

  const content = await serve({
    // The app origin scoped into the content CSP's frame-ancestors — derived from the OAuth callback
    // URL, the canonical app-origin source, exactly as production does. [LAW:one-source-of-truth]
    handler: makeContentHandler({ catalog: app.catalog, store: app.store, appOrigin: appOriginOf(oauthCallbackUrl) }),
    port: contentPort,
  });

  const page = generateIndexHtml(await readFile(templateUrl, 'utf8'));
  const handler = makeSiteHandler({
    page,
    catalog: app.catalog,
    contentOrigin: content.url,
    sessionHandler: app.sessionHandler,
    apiHandler: app.handler,
    reviewService: app.reviewService,
    isAdminRequest: app.isAdminRequest,
  });
  // Bind and report the front door on FRONT_DOOR_HOST — the same origin the OAuth callback
  // is scoped to — so the logged URL a developer opens carries the CSRF state cookie through
  // to the callback. The content origin stays on its own host for sandbox isolation.
  // [LAW:one-source-of-truth]
  const { url } = await serve({ handler, port, host: frontDoorHost });

  startWorkdirJanitor();

  // The settled-turn retention sweeper — bounds the service's in-memory turn map, the agnostic-service
  // sibling of the workdir janitor. Started here in the runtime entry for the same reason: a background
  // timer is a runtime effect makeApp must not own. [LAW:effects-at-boundaries]
  startTurnRetentionSweeper(app.service);

  // The durable-diagnostics retention sweeper — bounds the diagnostics dir ppu.4 fills with a record per
  // failed generation. Started here in the runtime entry for the same reason as its siblings: a background
  // timer is a runtime effect makeApp must not own. [LAW:effects-at-boundaries] [LAW:one-source-of-truth]
  startDiagnosticsRetentionSweeper(diagnosticsDirOf(dataDir));

  console.log(`[DEV] TinkerPad front door listening on ${url} (data: ${dataDir})`);
  console.log(`[DEV] TinkerPad playground content origin on ${content.url} (sandboxed, untrusted)`);
  console.log(`[DEV] Loopback login at ${url}/session/login (no GitHub app required; subject = dev:local)`);
};

main().catch((error: unknown) => {
  console.error('TinkerPad (dev) failed to start:', error);
  process.exit(1);
});
