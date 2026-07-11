import type { PlaygroundId } from '../storage/index.js';

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
  `${contentOrigin}/?id=${encodeURIComponent(id)}`;
