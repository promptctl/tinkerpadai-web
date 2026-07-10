import { defineConfig } from 'vitest/config';

// Under vitest the Worker entry (src/web/worker.ts) is importable so its composition-root wiring can
// be exercised. It does `import page from './index.html'`, which wrangler bundles as a TEXT module at
// the edge (wrangler.toml [[rules]]) but vite would otherwise try to parse as JS. Marking .html as a
// static asset makes the import resolve to a URL string instead of a parse error — the front-door
// HTML's contents are irrelevant to the wiring under test. This is the ONLY .html module import in
// src, so the rule touches nothing else. [LAW:one-source-of-truth] [LAW:decomposition]
export default defineConfig({
  assetsInclude: ['**/*.html'],
});
