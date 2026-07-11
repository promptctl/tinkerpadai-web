import type { PlaygroundId, VersionId } from '../storage/index.js';

// The ONE normalization of the content origin before a path is joined onto it — strip any trailing
// slash so a configured `https://content.example/` cannot produce a `//?id=…` double-slash pathname the
// content handler routes as 404. Both URL builders below concatenate a path onto the origin, so the strip
// lives HERE, once, rather than being repeated in each builder — a single enforcer for "what a canonical
// origin looks like", so the two builders can never disagree about it. [LAW:single-enforcer]
// [FRAMING:representation]
const originBase = (contentOrigin: string): string => contentOrigin.replace(/\/+$/, '');

// THE ONE FORMULA for a playground's URL on the content origin — the secure, https, CSP-wrapped page that
// serves its current version's raw html. It has TWO consumers that MUST agree: the player frames it as the
// sandbox iframe src (siteHandler), and the render pipeline shoots it to derive the thumbnail
// (render-dax.3). If they could drift, a thumbnail would show a different URL than the one users actually
// run — a representation that lies. Deriving both from here makes that divergence unrepresentable.
// [LAW:one-source-of-truth] [FRAMING:representation]
//
// It resolves by playground id to the CURRENT version (contentHandler serves currentVersionOf), so the
// pipeline keying its thumbnail by that same current version renders exactly the bytes the URL serves.
export const playgroundContentUrl = (contentOrigin: string, id: PlaygroundId): string =>
  `${originBase(contentOrigin)}/?id=${encodeURIComponent(id)}`;

// THE ONE FORMULA for a playground's preview-thumbnail URL on the content origin — the derived PNG the
// commons card frames as an <img>. Its TWO consumers MUST agree, exactly as with the content URL above:
// the serve route (contentHandler's /thumb) answers this URL, and every card surface (the shared server
// playgroundCard and the client teaser) points its image slot at it. Deriving both from here makes a
// drift between "the URL a card requests" and "the URL the route serves" unrepresentable.
// [LAW:one-source-of-truth] [FRAMING:representation]
//
// It carries the CURRENT version as a `v` cache-buster so a re-rendered thumbnail refreshes the instant
// the version advances (the URL changes, so the browser refetches) — the route itself resolves the
// current version server-side and ignores `v`, which is purely the client's cache key. That is why the
// card keys off PlaygroundSummary.currentVersion: not to select bytes (the route owns that), but to make
// the derived cache self-refreshing without any invalidation logic. [LAW:no-ambient-temporal-coupling]
export const playgroundThumbnailUrl = (contentOrigin: string, id: PlaygroundId, version: VersionId): string =>
  `${originBase(contentOrigin)}/thumb?id=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}`;
