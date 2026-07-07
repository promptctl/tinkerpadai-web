import type { PlaygroundSummary, Tag, Tags } from '../storage/index.js';
import { tryTag } from '../storage/index.js';

// THE COMMONS DISCOVERY MODEL — the query a browser asks of the commons, and the PURE operations
// that narrow the canonical playground list by it. Everything here is pure data-in / data-out: no
// catalog, no html, no effects. That is deliberate. The catalog stays the single source of truth
// for what playgrounds exist (design-docs/PROJECT.md); discovery is a projection LAYERED over the
// canonical summaries it returns, never a parallel index that could drift from them. Filtering the
// same list the cards render from is exactly "keep the source of truth in the catalog."
// [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
//
// Simple substring + normalized-tag matching first, as the epic stages it (a dedicated search
// engine only when catalog size justifies). When that day comes, a real backend pushes the predicate
// down to SQL/FTS; until then the whole doc is read once and narrowed here, so promising the catalog
// seam an efficiency it cannot deliver today would be a lie. [LAW:dataflow-not-control-flow]

// The narrowing the user asks for, carried as VALUES. `text` is free-text (empty = no text
// constraint); `tags` are normalized tags the result must ALL carry (empty = no tag constraint).
// The empty query — empty text, empty tags — is not a special "no filter" state: it is a value that
// matches every playground by the natural semantics below, so filtering ALWAYS runs and never
// branches on "is there a query". [LAW:dataflow-not-control-flow]
export interface CommonsQuery {
  readonly text: string;
  readonly tags: Tags;
}

// The empty query — the canonical "no narrowing" value. One definition, so "everything" has a single
// representation rather than a scatter of `undefined`/`{}` a caller might mint. [LAW:one-source-of-truth]
export const EMPTY_QUERY: CommonsQuery = { text: '', tags: [] };

// Is a query actually narrowing anything? A pure predicate over values, used to choose the
// empty-state message and whether to offer a "clear" affordance — never to gate filtering itself.
export const isActiveQuery = (query: CommonsQuery): boolean => query.text !== '' || query.tags.length > 0;

// One available tag with its playground count — the unit of the filter chip row. The count orders
// the chips (most populous facet first) and shows how much lives behind each. Derived from the
// summaries, never stored. [LAW:one-source-of-truth]
export interface TagFacet {
  readonly tag: Tag;
  readonly count: number;
}

// Parse the URL's discovery params into a query, at the trust boundary. `q` is the free text
// (trimmed); each repeated `tag` is minted through the NON-throwing tryTag so a hand-edited
// '?tag=' or '?tag=%21' drops out as "not a constraint" instead of faulting the page. Minting
// normalizes, so '?tag=CSS' matches the stored 'css'; duplicates collapse so the active set is
// canonical and round-trips with commonsHref. [LAW:no-defensive-null-guards] [LAW:single-enforcer]
export const parseCommonsQuery = (params: URLSearchParams): CommonsQuery => {
  const text = (params.get('q') ?? '').trim();
  const minted = params.getAll('tag').flatMap((raw) => {
    const tag = tryTag(raw);
    return tag === null ? [] : [tag];
  });
  return { text, tags: [...new Set(minted)] };
};

// Serialize a query back to a commons URL — the inverse of parseCommonsQuery, so the URL is the ONE
// representation of filter state both directions agree on (the page carries no separate client
// state to drift). Empty facets are omitted so the canonical "everything" query is a clean
// `/commons`, and the values are URL-encoded through URLSearchParams (the attribute-escaping is the
// renderer's concern, at its own boundary). [LAW:one-source-of-truth]
export const commonsHref = (query: CommonsQuery): string => {
  const params = new URLSearchParams();
  if (query.text !== '') params.set('q', query.text);
  for (const tag of query.tags) params.append('tag', tag);
  const qs = params.toString();
  return qs === '' ? '/commons' : `/commons?${qs}`;
};

// The query with one tag toggled — added when absent, removed when present. This is the chip's
// action expressed as data: a facet chip's link is simply commonsHref(withTagToggled(query, tag)),
// so clicking it flips exactly that facet while preserving the rest of the query. [LAW:dataflow-not-control-flow]
export const withTagToggled = (query: CommonsQuery, tag: Tag): CommonsQuery =>
  query.tags.includes(tag)
    ? { ...query, tags: query.tags.filter((t) => t !== tag) }
    : { ...query, tags: [...query.tags, tag] };

// The distinct tags across a list of summaries, each with its count, ordered by count (most
// populous first) then tag name for a stable, useful chip order. The filter chips' source — derived
// from the SAME summaries the cards render from, so the facets can never name a tag no playground
// carries. A tag-less playground contributes nothing (an empty tag list is a value, not a facet).
// [LAW:one-source-of-truth]
export const tagFacets = (summaries: readonly PlaygroundSummary[]): readonly TagFacet[] => {
  const counts = new Map<Tag, number>();
  for (const summary of summaries) {
    for (const tag of summary.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
};

// Does a summary satisfy the query? Text matches as a case-insensitive substring of ANY recipe step
// (the recipe's first step IS the original describe `prompt`, so this covers the title too, from one
// source). Tags match by normalized-token equality — EVERY queried tag must be present (each added
// tag narrows). The empty query matches everything for free: an empty needle is a substring of every
// string, and `[].every` is vacuously true — no guard, no special case. [LAW:dataflow-not-control-flow]
const matchesQuery = (summary: PlaygroundSummary, needle: string, tags: Tags): boolean =>
  summary.recipe.some((step) => step.toLowerCase().includes(needle)) &&
  tags.every((tag) => summary.tags.includes(tag));

// Narrow the canonical summary list to those matching the query, preserving the input order (the
// catalog's insertion order). The needle is lowercased ONCE here, not per summary. A pure
// projection: same summaries in, a subset out, no effects. [LAW:effects-at-boundaries]
export const filterSummaries = (
  summaries: readonly PlaygroundSummary[],
  query: CommonsQuery,
): readonly PlaygroundSummary[] => {
  const needle = query.text.toLowerCase();
  return summaries.filter((summary) => matchesQuery(summary, needle, query.tags));
};
