import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_FORMAT_JS, FAVICON_LINK, THEME_RESOLVER, TOKENS_CSS } from './frontDoorChrome.js';
import { generateIndexHtml } from './generateIndexHtml.js';

const template = readFileSync(new URL('./index.html.tmpl', import.meta.url), 'utf8');
const committed = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

describe('generateIndexHtml', () => {
  // THE DRIFT GUARD — the committed static front door must be exactly what the generator produces
  // from the current template and shared chrome source. If someone edits a token, the favicon, a
  // card format, or the template and forgets `pnpm build`, this fails loudly instead of shipping a
  // homepage that silently disagrees with the server pages. [LAW:no-silent-failure] [LAW:one-source-of-truth]
  it('regenerates byte-for-byte to the committed index.html (run `pnpm build` if this fails)', () => {
    expect(generateIndexHtml(template)).toBe(committed);
  });

  // The shared head chrome is spliced in from the one source, so the homepage wears the same tokens,
  // pre-paint theme resolver, and favicon the server pages do.
  it('inlines the shared token block, theme resolver, and favicon from frontDoorChrome', () => {
    const html = generateIndexHtml(template);
    expect(html).toContain(TOKENS_CSS);
    expect(html).toContain(THEME_RESOLVER);
    expect(html).toContain(FAVICON_LINK);
  });

  // The generator splices the client format twin (CARD_FORMAT_JS) into the homepage's card renderer.
  // That the twin computes the same format as the server functions is frontDoorChrome's own invariant,
  // asserted in frontDoorChrome.test.ts; here we only prove the generator inlines it. [LAW:one-source-of-truth]
  it('inlines the shared client format twin', () => {
    expect(generateIndexHtml(template)).toContain(CARD_FORMAT_JS);
  });

  // A template that names a slot the generator does not fill (typo'd or renamed marker) must fail the
  // build, never ship a page with a literal `tp:` comment where chrome belongs. [LAW:no-silent-failure]
  it('fails loudly when a required marker is missing', () => {
    expect(() => generateIndexHtml(template.replace('<!--tp:favicon-->', ''))).toThrow(/favicon/);
  });

  // A leftover marker must be caught regardless of casing — the guard exists to catch mistakes, and a
  // mixed-case marker name is exactly such a mistake. [LAW:no-silent-failure]
  it('fails loudly on an unfilled HTML-comment marker of any casing left in the template', () => {
    expect(() => generateIndexHtml(template.replace('<!--tp:theme-->', '<!--tp:theme--><!--tp:Bogus-->'))).toThrow(/Bogus|unfilled/);
  });

  // The guard covers CSS-comment markers too (the `/*...*/` branch of the regex), since tokens/formats
  // are spliced inside <style>/<script>. Exercise that branch, not just the HTML-comment one. [LAW:verifiable-goals]
  it('fails loudly on an unfilled CSS-comment marker left in the template', () => {
    expect(() => generateIndexHtml(template.replace('/*tp:tokens*/', '/*tp:tokens*/ /*tp:Extra*/'))).toThrow(/Extra|unfilled/);
  });
});
