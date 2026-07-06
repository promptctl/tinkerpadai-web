import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_FORMAT_JS, FAVICON_LINK, THEME_RESOLVER, TOKENS_CSS, bylineText, stepText } from './frontDoorChrome.js';
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

  // The client format twin (CARD_FORMAT_JS) is inlined into the homepage, and it must compute exactly
  // what the server's typed bylineText/stepText do — that lockstep is what lets one format edit reach
  // both surfaces. Evaluate the inlined source and compare against the functions. [LAW:one-source-of-truth]
  it('inlines a client format twin that computes the same byline/step format as the server functions', () => {
    expect(generateIndexHtml(template)).toContain(CARD_FORMAT_JS);
    const evaluated = new Function(`${CARD_FORMAT_JS} return { bylineText, stepText };`)() as {
      bylineText: (author: string) => string;
      stepText: (count: number) => string;
    };
    for (const author of ['grace', 'a<b>&"\'', '']) {
      expect(evaluated.bylineText(author)).toBe(bylineText(author));
    }
    for (const count of [0, 1, 2, 3, 42]) {
      expect(evaluated.stepText(count)).toBe(stepText(count));
    }
  });

  // A template that names a slot the generator does not fill (typo'd or renamed marker) must fail the
  // build, never ship a page with a literal `tp:` comment where chrome belongs. [LAW:no-silent-failure]
  it('fails loudly when a required marker is missing', () => {
    expect(() => generateIndexHtml(template.replace('<!--tp:favicon-->', ''))).toThrow(/favicon/);
  });

  it('fails loudly on an unfilled marker left in the template', () => {
    expect(() => generateIndexHtml(template.replace('<!--tp:theme-->', '<!--tp:theme--><!--tp:bogus-->'))).toThrow(/bogus|unfilled/);
  });
});
