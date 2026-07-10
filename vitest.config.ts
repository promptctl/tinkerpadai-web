import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirror wrangler's `Text` rule (wrangler.toml [[rules]]) under vitest: `import page from './foo.html'`
// yields the file's TEXT content — exactly what the edge bundle hands the Worker entry — rather than a
// URL path string (what vite's default asset handling would return) or a JS parse error (its default
// for an unknown import). Loading the real text keeps the Worker entry importable in tests AND keeps
// `page` faithful to production, so any test that flows `page` into the site handler sees real HTML,
// not a stand-in path. One meaning of "import a .html module" — text content — across both bundlers.
// [LAW:one-source-of-truth] [FRAMING:representation]
export default defineConfig({
  plugins: [
    {
      name: 'html-as-text-module',
      enforce: 'pre',
      load(id: string): string | null {
        const path = id.split('?', 1)[0];
        if (!path.endsWith('.html')) return null;
        return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`;
      },
    },
  ],
});
