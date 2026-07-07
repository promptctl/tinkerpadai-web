import { readFile, writeFile } from 'node:fs/promises';
import { generateIndexHtml } from '../src/web/generateIndexHtml.js';

// THE FRONT-DOOR BUILD STEP — the one effect boundary that turns the hand-authored template into the
// shipped static page. It reads index.html.tmpl, runs the pure generator, and writes index.html; all
// of the actual composition lives in generateIndexHtml, which touches no files, so this shell is just
// its read/write edge. `pnpm build` runs it; the drift test (generateIndexHtml.test.ts) proves the
// committed index.html is what this would produce, so a stale checkin is a red test. [LAW:effects-at-boundaries]

const tmplUrl = new URL('../src/web/index.html.tmpl', import.meta.url);
const outUrl = new URL('../src/web/index.html', import.meta.url);

const main = async (): Promise<void> => {
  const template = await readFile(tmplUrl, 'utf8');
  const html = generateIndexHtml(template);
  await writeFile(outUrl, html);
  console.log(`gen-index: wrote src/web/index.html (${html.length} bytes)`);
};

main().catch((error: unknown) => {
  console.error(`gen-index failed: ${String(error instanceof Error ? (error.stack ?? error.message) : error)}`);
  process.exitCode = 1;
});
