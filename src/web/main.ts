import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../app.js';
import { makeSiteHandler } from './siteHandler.js';
import { serve } from './server.js';

// THE FRONT-DOOR ENTRY POINT — the effectful top of the steel thread. It is the only place
// that reads the environment, loads the page from disk, and binds a socket; everything it
// composes (the app graph, the site handler) is pure with respect to those effects.
// [LAW:effects-at-boundaries] Run it with `node src/web/main.ts`.

const pageUrl = new URL('./index.html', import.meta.url);

const main = async (): Promise<void> => {
  const dataDir = process.env.TINKERPAD_DATA_DIR ?? fileURLToPath(new URL('../../.tinkerpad-data', import.meta.url));
  const port = Number(process.env.PORT ?? 8787);

  const app = makeApp({ dataDir });
  const page = await readFile(pageUrl, 'utf8');
  const handler = makeSiteHandler({ page, apiHandler: app.handler });

  const { url } = await serve({ handler, port });
  // The one log the operator needs: where the front door is listening. [LAW:no-silent-failure]
  console.log(`TinkerPad front door listening on ${url} (data: ${dataDir})`);
};

// A boot failure must be loud and non-zero, never a silently dead process. [LAW:no-silent-failure]
main().catch((error: unknown) => {
  console.error('TinkerPad failed to start:', error);
  process.exit(1);
});
