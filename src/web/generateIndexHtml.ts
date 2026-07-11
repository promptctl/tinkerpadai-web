import { TOKENS_CSS, THEME_RESOLVER, FAVICON_LINK, CARD_FORMAT_JS, PREVIEW_IMG_CSS } from './frontDoorChrome.js';

// THE FRONT-DOOR GENERATOR — the pure transform that turns index.html.tmpl (the hand-authored
// source, with markers where shared chrome belongs) into index.html (the shipped, self-contained
// static file). It is a total String → String function: it reads no files and writes none, so the
// effect of building the page lives entirely in its one caller (scripts/gen-index.ts) and the drift
// test can exercise it with plain strings. [LAW:effects-at-boundaries]
//
// The single source for every spliced piece is frontDoorChrome; this file only positions those
// pieces. So an edit to a token, the favicon, or a card format changes ONE place and re-flows here
// into both the homepage and (via pageShell's own import) the server pages. [LAW:one-source-of-truth]

// Splice a marker that must appear EXACTLY ONCE. A marker that is missing (a renamed slot) or
// duplicated (a copy-paste) would otherwise silently ship an incomplete page — the split count makes
// that a loud build failure instead. [LAW:no-silent-failure]
const spliceOnce = (src: string, marker: string, replacement: string): string => {
  const parts = src.split(marker);
  if (parts.length !== 2) {
    throw new Error(
      `generateIndexHtml: marker ${JSON.stringify(marker)} must appear exactly once (found ${parts.length - 1})`,
    );
  }
  return parts[0] + replacement + parts[1];
};

export const generateIndexHtml = (template: string): string => {
  let out = template;
  out = spliceOnce(out, '<!--tp:favicon-->', FAVICON_LINK);
  out = spliceOnce(out, '<!--tp:theme-->', THEME_RESOLVER);
  out = spliceOnce(out, '/*tp:tokens*/', TOKENS_CSS);
  out = spliceOnce(out, '/*tp:formats*/', CARD_FORMAT_JS);
  out = spliceOnce(out, '/*tp:preview-img*/', PREVIEW_IMG_CSS);

  // No marker may survive: a leftover means the template names a slot the generator does not fill, so
  // the page would ship with a literal `tp:` comment where chrome belongs. Fail instead. [LAW:no-silent-failure]
  const leftover = out.match(/(?:<!--|\/\*)\s*tp:[a-zA-Z]+/);
  if (leftover !== null) {
    throw new Error(`generateIndexHtml: unfilled marker ${JSON.stringify(leftover[0])} — the template names a slot the generator does not fill`);
  }
  return out;
};
