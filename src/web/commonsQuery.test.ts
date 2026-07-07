import { describe, expect, it } from 'vitest';
import type { PlaygroundSummary, Tags } from '../storage/index.js';
import { PlaygroundId, Tag } from '../storage/index.js';
import type { CommonsQuery } from './commonsQuery.js';
import {
  commonsHref,
  EMPTY_QUERY,
  filterSummaries,
  isActiveQuery,
  parseCommonsQuery,
  tagFacets,
  withTagToggled,
} from './commonsQuery.js';

// The commons discovery model: pure query data-ops over the canonical summary list. The two
// load-bearing properties are that the empty query matches EVERYTHING with no special case, and
// that the URL is the single serialized form of a query (parse and href are inverses).
// [LAW:dataflow-not-control-flow] [LAW:one-source-of-truth]

const summary = (over: Partial<PlaygroundSummary> = {}): PlaygroundSummary => ({
  id: PlaygroundId('id'),
  prompt: 'a tiny counter',
  providerId: 'p' as never,
  currentVersion: 'v' as never,
  forkedFrom: null,
  author: 'ada' as never,
  recipe: ['a tiny counter'] as const,
  tags: [] as Tags,
  ...over,
});

describe('parseCommonsQuery', () => {
  it('reads q as trimmed free text and each tag param, normalized', () => {
    const q = parseCommonsQuery(new URLSearchParams('q=%20a+Counter%20&tag=CSS&tag=Data%20Viz'));
    expect(q.text).toBe('a Counter');
    expect(q.tags).toEqual([Tag('css'), Tag('data-viz')]);
  });

  it('is the empty query when there are no params', () => {
    expect(parseCommonsQuery(new URLSearchParams(''))).toEqual(EMPTY_QUERY);
  });

  // A hand-edited URL must not fault the page: a tag param that normalizes to nothing is dropped as
  // "not a constraint", never a thrown error. [LAW:no-defensive-null-guards]
  it('drops a tag param that has no valid token rather than throwing', () => {
    const q = parseCommonsQuery(new URLSearchParams('tag=css&tag=%21%21%21&tag='));
    expect(q.tags).toEqual([Tag('css')]);
  });

  it('collapses duplicate tags so the active set is canonical', () => {
    const q = parseCommonsQuery(new URLSearchParams('tag=css&tag=CSS'));
    expect(q.tags).toEqual([Tag('css')]);
  });
});

describe('commonsHref', () => {
  it('is the bare /commons for the empty query', () => {
    expect(commonsHref(EMPTY_QUERY)).toBe('/commons');
  });

  it('encodes text and each tag as query params', () => {
    expect(commonsHref({ text: 'a counter', tags: [Tag('css'), Tag('math')] })).toBe(
      '/commons?q=a+counter&tag=css&tag=math',
    );
  });

  // parse and href are inverses: serializing a query then parsing it yields the same query. The URL
  // is the ONE representation of filter state. [LAW:one-source-of-truth]
  it('round-trips through parseCommonsQuery', () => {
    const cases: CommonsQuery[] = [
      EMPTY_QUERY,
      { text: 'a counter', tags: [] },
      { text: '', tags: [Tag('css')] },
      { text: 'svg paths', tags: [Tag('css'), Tag('math')] },
    ];
    for (const q of cases) {
      expect(parseCommonsQuery(new URLSearchParams(commonsHref(q).split('?')[1] ?? ''))).toEqual(q);
    }
  });
});

describe('withTagToggled', () => {
  it('adds a tag when absent and removes it when present', () => {
    const base: CommonsQuery = { text: 'x', tags: [Tag('css')] };
    expect(withTagToggled(base, Tag('math')).tags).toEqual([Tag('css'), Tag('math')]);
    expect(withTagToggled(base, Tag('css')).tags).toEqual([]);
  });

  it('preserves the text when toggling', () => {
    expect(withTagToggled({ text: 'keep me', tags: [] }, Tag('css')).text).toBe('keep me');
  });
});

describe('isActiveQuery', () => {
  it('is false only for the empty query', () => {
    expect(isActiveQuery(EMPTY_QUERY)).toBe(false);
    expect(isActiveQuery({ text: 'x', tags: [] })).toBe(true);
    expect(isActiveQuery({ text: '', tags: [Tag('css')] })).toBe(true);
  });
});

describe('tagFacets', () => {
  it('counts distinct tags across summaries, ordered by count then name', () => {
    const facets = tagFacets([
      summary({ id: PlaygroundId('a'), tags: [Tag('css'), Tag('math')] }),
      summary({ id: PlaygroundId('b'), tags: [Tag('css')] }),
      summary({ id: PlaygroundId('c'), tags: [Tag('css'), Tag('math')] }),
    ]);
    expect(facets).toEqual([
      { tag: Tag('css'), count: 3 },
      { tag: Tag('math'), count: 2 },
    ]);
  });

  // The tie-breaker: equal counts fall back to lexicographic tag order, so the chip order is
  // stable regardless of input order. Distinct-count cases never exercise this branch. [LAW:behavior-not-structure]
  it('breaks equal counts by lexicographic tag order, independent of input order', () => {
    const facets = tagFacets([summary({ id: PlaygroundId('x'), tags: [Tag('b'), Tag('a')] })]);
    expect(facets).toEqual([
      { tag: Tag('a'), count: 1 },
      { tag: Tag('b'), count: 1 },
    ]);
  });

  it('is empty when no summary carries a tag', () => {
    expect(tagFacets([summary({ tags: [] })])).toEqual([]);
  });
});

describe('filterSummaries', () => {
  const a = summary({ id: PlaygroundId('a'), prompt: 'a color picker', recipe: ['a color picker'], tags: [Tag('css')] });
  const b = summary({ id: PlaygroundId('b'), prompt: 'a prime sieve', recipe: ['a prime sieve', 'add a chart'], tags: [Tag('math')] });
  const all = [a, b];

  // The load-bearing property: the empty query is a value that matches everything, with no branch.
  it('returns every summary for the empty query', () => {
    expect(filterSummaries(all, EMPTY_QUERY)).toEqual(all);
  });

  it('matches text case-insensitively against any recipe step', () => {
    expect(filterSummaries(all, { text: 'COLOR', tags: [] })).toEqual([a]);
    // "chart" appears only in b's second recipe step, not its title.
    expect(filterSummaries(all, { text: 'chart', tags: [] })).toEqual([b]);
  });

  it('requires every queried tag to be present (each tag narrows)', () => {
    expect(filterSummaries(all, { text: '', tags: [Tag('css')] })).toEqual([a]);
    expect(filterSummaries(all, { text: '', tags: [Tag('css'), Tag('math')] })).toEqual([]);
  });

  it('applies text and tags together', () => {
    expect(filterSummaries(all, { text: 'picker', tags: [Tag('css')] })).toEqual([a]);
    expect(filterSummaries(all, { text: 'picker', tags: [Tag('math')] })).toEqual([]);
  });

  it('preserves the input order of the surviving summaries', () => {
    const list = [b, a];
    expect(filterSummaries(list, EMPTY_QUERY)).toEqual([b, a]);
  });
});
