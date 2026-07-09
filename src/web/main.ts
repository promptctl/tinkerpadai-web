import { readFile } from 'node:fs/promises';
import { makeNodeApp } from './nodeApp.js';
import { makeGitHubOAuthProvider } from '../api/index.js';
import { startWorkdirJanitor } from '../provider/index.js';
import { makeSiteHandler } from './siteHandler.js';
import { makeContentHandler } from './contentHandler.js';
import { serve } from './server.js';
import { resolveServerConfig } from './serverConfig.js';

// THE FRONT-DOOR ENTRY POINT — the effectful top of the steel thread. It is the only place
// that reads the environment, loads the page from disk, and binds sockets; everything it
// composes (the app graph, the handlers) is pure with respect to those effects.
// [LAW:effects-at-boundaries] Run it with `node src/web/main.ts`.
//
// TWO ORIGINS, on purpose. The app origin serves trusted pages (front door, commons,
// player chrome) and the API; the CONTENT origin serves only raw, untrusted playground html
// behind the sandbox CSP. They are separate sockets so a playground's opaque-origin frame
// can never reach the app's origin, cookies, or storage. This is the load-bearing security
// boundary, not a deployment detail. [LAW:single-enforcer]

const pageUrl = new URL('./index.html', import.meta.url);

const main = async (): Promise<void> => {
  const { dataDir, port, contentPort, oauthCallbackUrl } = resolveServerConfig(import.meta.url);

  // The GitHub OAuth app credentials. These CANNOT be minted (unlike a dev secret) — a real
  // identity provider requires a registered OAuth app — so their absence is a hard, loud boot
  // failure, never a silent fallback to an open or dev gate. `|| undefined` so an empty string
  // is treated as unset, not as an empty credential. [LAW:no-silent-failure]
  const clientId = process.env.GITHUB_CLIENT_ID || undefined;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || undefined;
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      'GitHub OAuth is required: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. ' +
        'Create an OAuth app at https://github.com/settings/developers with ' +
        `Authorization callback URL = ${oauthCallbackUrl}`,
    );
  }

  // The Node entry binds a plain http socket, so cookies cannot be Secure here — that is the honest
  // transport, not a weakened default. The HTTPS edge (src/web/worker.ts) is the production target
  // that hardens the cookie with { secure: true }. [LAW:no-silent-failure]
  const app = makeNodeApp({
    dataDir,
    oauth: makeGitHubOAuthProvider({ clientId, clientSecret }),
    oauthCallbackUrl,
    cookieSecurity: { secure: false },
  });

  // Bind the content origin FIRST: the player's iframe src needs its concrete URL, so that
  // URL must exist before the site handler is built. The dependency is a value passed in,
  // not an ambient assumption about boot order. [LAW:no-ambient-temporal-coupling]
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

  // Start the idle-workdir sweeper. It lives HERE, in the runtime entry, not in makeApp:
  // a background timer is a runtime effect, and makeApp must stay a pure graph builder
  // that tests can construct without leaking timers. The local tmux provider is the only
  // thing that mints workdirs, so its cache GC is a local-runtime concern. The handle is
  // intentionally unreferenced — the sweep runs for the life of the process and stops on
  // exit (its timer is unref'd). [LAW:effects-at-boundaries] [LAW:no-ambient-temporal-coupling]
  startWorkdirJanitor();

  // The logs the operator needs: where each origin listens, and the OAuth callback the GitHub app
  // must have registered (a mismatch is the most common login misconfiguration). [LAW:no-silent-failure]
  console.log(`TinkerPad front door listening on ${url} (data: ${dataDir})`);
  console.log(`TinkerPad playground content origin on ${content.url} (sandboxed, untrusted)`);
  console.log(`TinkerPad sign in with GitHub at ${url}/session/login (callback: ${oauthCallbackUrl})`);
};

// A boot failure must be loud and non-zero, never a silently dead process. [LAW:no-silent-failure]
main().catch((error: unknown) => {
  console.error('TinkerPad failed to start:', error);
  process.exit(1);
});
