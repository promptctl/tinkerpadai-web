import { describe, expect, it } from 'vitest';
import { CARD_FORMAT_JS, bylineText, stepText } from './frontDoorChrome.js';

describe('frontDoorChrome card format', () => {
  // THE LOCKSTEP GUARD — the card format exists in two forms (the typed functions the server calls,
  // and CARD_FORMAT_JS, the client source the generator inlines into the self-contained homepage).
  // They MUST compute identically, or a playground would read one way on the commons and another on
  // the homepage. This is what lets one format edit reach both surfaces; it fails loudly the instant
  // the two forms disagree. [LAW:one-source-of-truth]
  it('CARD_FORMAT_JS computes the same byline/step format as the typed functions', () => {
    const twin = new Function(`${CARD_FORMAT_JS} return { bylineText, stepText };`)() as {
      bylineText: (author: string) => string;
      stepText: (count: number) => string;
    };
    for (const author of ['grace', 'a<b>&"\'', '', 'Ada Lovelace']) {
      expect(twin.bylineText(author)).toBe(bylineText(author));
    }
    for (const count of [0, 1, 2, 3, 42]) {
      expect(twin.stepText(count)).toBe(stepText(count));
    }
  });
});
