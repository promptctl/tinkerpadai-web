import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../app.js';
import { makeSiteHandler } from './siteHandler.js';
import { makeContentHandler } from './contentHandler.js';
import { serve } from './server.js';

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
  const dataDir = process.env.TINKERPAD_DATA_DIR ?? fileURLToPath(new URL('../../.tinkerpad-data', import.meta.url));
  const port = Number(process.env.PORT ?? 8787);
  // Default the content origin to the next port so a fresh checkout gets two origins with no
  // config; override explicitly to place it elsewhere.
  const contentPort = Number(process.env.TINKERPAD_CONTENT_PORT ?? port + 1);

  const app = makeApp({ dataDir });

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
    apiHandler: app.handler,
  });
  const { url } = await serve({ handler, port });

  // The logs the operator needs: where each origin listens. [LAW:no-silent-failure]
  console.log(`TinkerPad front door listening on ${url} (data: ${dataDir})`);
  console.log(`TinkerPad playground content origin on ${content.url} (sandboxed, untrusted)`);
};

// A boot failure must be loud and non-zero, never a silently dead process. [LAW:no-silent-failure]
main().catch((error: unknown) => {
  console.error('TinkerPad failed to start:', error);
  process.exit(1);
});
