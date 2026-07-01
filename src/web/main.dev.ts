import { readFile } from 'node:fs/promises';
import { makeApp } from '../app.js';
import { Subject } from '../api/index.js';
import type { OAuthProvider } from '../api/index.js';
import { startWorkdirJanitor } from '../provider/index.js';
import { makeSiteHandler } from './siteHandler.js';
import { makeContentHandler } from './contentHandler.js';
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
// callback's state-verification, exchange, and cookie-minting all run for real. authenticate
// brands a fixed dev subject. No network, no secret. [LAW:one-type-per-behavior]
const makeDevOAuthProvider = (subject: Subject): OAuthProvider => ({
  authorizeUrl: ({ state, redirectUri }) =>
    `${redirectUri}?${new URLSearchParams({ code: 'dev-code', state }).toString()}`,
  authenticate: async () => subject,
});

const pageUrl = new URL('./index.html', import.meta.url);

const main = async (): Promise<void> => {
  const { dataDir, port, contentPort, oauthCallbackUrl } = resolveServerConfig(import.meta.url);

  const app = makeApp({
    dataDir,
    oauth: makeDevOAuthProvider(Subject('dev:local')),
    oauthCallbackUrl,
  });

  const content = await serve({
    handler: makeContentHandler({ catalog: app.catalog, store: app.store }),
    port: contentPort,
  });

  const page = await readFile(pageUrl, 'utf8');
  const handler = makeSiteHandler({
    page,
    catalog: app.catalog,
    contentOrigin: content.url,
    sessionHandler: app.sessionHandler,
    apiHandler: app.handler,
  });
  const { url } = await serve({ handler, port });

  startWorkdirJanitor();

  console.log(`[DEV] TinkerPad front door listening on ${url} (data: ${dataDir})`);
  console.log(`[DEV] TinkerPad playground content origin on ${content.url} (sandboxed, untrusted)`);
  console.log(`[DEV] Loopback login at ${url}/session/login (no GitHub app required; subject = dev:local)`);
};

main().catch((error: unknown) => {
  console.error('TinkerPad (dev) failed to start:', error);
  process.exit(1);
});
