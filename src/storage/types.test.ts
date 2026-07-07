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
});
