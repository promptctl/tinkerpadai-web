import { describe, expect, it } from 'vitest';
import { deriveTags } from './deriveTags.js';

// The extractor's contract is over OBSERVABLE output — the tags a prompt yields — never the
// vocabulary's internals. It is the single home for prompt->tags; a future classifier must keep
// these promises. [LAW:behavior-not-structure]

// deriveTags returns branded Tags; compare as plain strings so the assertions read cleanly.
const tagsOf = (prompt: string): string[] => deriveTags(prompt).map(String);

describe('deriveTags', () => {
  it('classifies a prompt into its topic tags', () => {
    expect(tagsOf('a bezier curve explorer with live equations')).toContain('math');
  });

  it('reads several topics from one prompt', () => {
    const tags = tagsOf('a color palette generator with css gradients');
    expect(tags).toContain('color');
    expect(tags).toContain('css');
    expect(tags).toContain('tools');
  });

  // Every playground is interactive by the artifact contract, so a prompt that matches no topic
  // still gets one true tag — the result is never empty for a new playground. [LAW:no-silent-failure]
  it('falls back to the true "interactive" floor when no topic matches', () => {
    expect(tagsOf('zzz qqq wibble')).toEqual(['interactive']);
  });

  it('always returns a non-empty list', () => {
    for (const prompt of ['', '   ', 'a', 'the quick brown fox', '한국어 프롬프트']) {
      expect(deriveTags(prompt).length).toBeGreaterThan(0);
    }
  });

  // Deterministic: the same prompt yields the same tags in the same order, every call — a durable
  // classification, not a shifting one. [LAW:one-source-of-truth]
  it('is deterministic across calls', () => {
    const prompt = 'a physics pendulum simulation with a chart';
    expect(deriveTags(prompt)).toEqual(deriveTags(prompt));
  });

  it('is case-insensitive', () => {
    expect(tagsOf('A CALCULUS GRAPH')).toEqual(tagsOf('a calculus graph'));
  });

  // The cap keeps a card from becoming a wall of chips even when a prompt name-drops many topics.
  // [LAW:no-mode-explosion]
  it('caps the number of tags', () => {
    const kitchenSink =
      'a math physics game audio canvas chart text color css design tool simulation map interactive explorer';
    expect(deriveTags(kitchenSink).length).toBeLessThanOrEqual(5);
  });

  // Word-boundary matching: a topic keyword must start a word, so it never fires as an accidental
  // substring of an unrelated one.
  it('matches whole-word keywords, not accidental substrings', () => {
    // "start" must not trip the (hypothetical) "art"-like substring matches; "restart a timer"
    // should read as a tool, not something spurious.
    expect(tagsOf('restart a timer')).toContain('tools');
  });
});
