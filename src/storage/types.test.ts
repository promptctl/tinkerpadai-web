import { describe, expect, it } from 'vitest';
import { Tag, tryTag } from './types.js';

// tryTag is the non-throwing minter for trust boundaries. Its contract is exactly two claims: it
// agrees with Tag() wherever Tag() produces a value (same single normalizer), and it represents "no
// valid tag here" as null instead of the exception Tag() throws. [LAW:single-enforcer]
describe('tryTag', () => {
  it('agrees with Tag() for every input that is a valid tag', () => {
    for (const raw of ['css', 'CSS', ' Data Viz ', 'C.S.S', 'math101']) {
      expect(tryTag(raw)).toBe(Tag(raw));
    }
  });

  it('is null for input with no valid tag token, where Tag() throws', () => {
    for (const raw of ['', '   ', '!!!', '---']) {
      expect(tryTag(raw)).toBeNull();
      expect(() => Tag(raw)).toThrow();
    }
  });

  // Letters in any script survive normalization rather than being silently dropped — the trust
  // boundary keeps a hand-typed non-ASCII tag intact instead of mangling 'café' into 'caf'. Only
  // true separators/punctuation between letters collapse to hyphens. [LAW:no-silent-failure]
  it('preserves non-ASCII letters instead of dropping them', () => {
    expect(tryTag('café')).toBe('café');
    expect(tryTag('Данные')).toBe('данные');
    expect(tryTag('日本語')).toBe('日本語');
    expect(tryTag('naïve viz')).toBe('naïve-viz');
  });
});
