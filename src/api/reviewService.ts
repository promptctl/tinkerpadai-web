import type { Catalog, Listing, Playground, PlaygroundId, Report, ReportReader } from '../storage/index.js';

// THE MODERATION REVIEW SERVICE — the enforcement half of moderation (moderation-5g7.2), sibling to
// the report intake service (reportService, moderation-5g7.1). Intake COLLECTS the signal; this
// service lets a human reviewer READ that signal grouped by playground and ACT on it by setting a
// playground's visibility. The two halves converge here on ONE store (reportStore) and ONE state
// (the catalog's listing): the report button, a /copyright takedown, and a /terms abuse report all
// resolve to the same unlist/relist this service performs — never a parallel channel.
// [LAW:decomposition] [LAW:single-enforcer]

// One row of the review queue: a REPORTED playground joined to the current state a reviewer needs to
// decide on it — its title, whether it is already unlisted, and every report raised against it. The
// queue is keyed by playground (the ticket "lists reported playgrounds"), not by report, so a
// playground flagged five times is one row carrying five reports, and the reviewer acts on the
// playground once. [LAW:decomposition]
export interface ReviewItem {
  readonly id: PlaygroundId;
  // The playground's original describe (turns[0].prompt) — what the reviewer is looking at. The one
  // human-readable identity the commons already shows as a title; the generation SessionId never
  // crosses into this view any more than it crosses into the public read path. [LAW:one-source-of-truth]
  readonly title: string;
  // Its CURRENT visibility, so the reviewer sees whether it is already actioned — an unlisted item
  // offers relist, a listed one offers unlist. The action is chosen by this value, never guessed.
  readonly listing: Listing;
  // Every report against this playground, in the order they were raised. Carries the reporter and
  // reason — private signal the trusted reviewer acts on, never surfaced on the public read path.
  readonly reports: readonly Report[];
}

export interface ReviewService {
  // The review queue: reported playgrounds, each joined to its current catalog state, most-reported
  // context intact. An empty report store yields an empty queue — data flow, not a special case.
  // [LAW:dataflow-not-control-flow]
  queue(): Promise<readonly ReviewItem[]>;

  // Enact a moderation decision: set a playground 'unlisted' (takedown) or 'listed' (put-back). Unlist
  // and relist are ONE call parameterized by the target state. An unknown id fails loudly with the
  // catalog's PlaygroundNotFoundError (the admin surface maps it to an honest notice), never a silent
  // no-op. [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
  setListing(id: PlaygroundId, listing: Listing): Promise<Playground>;
}

export interface ReviewServiceDeps {
  // Read-only access to the collected reports, typed as ReportReader (just list()) so the type FORBIDS
  // this service forging a report — the mirror of how reportService is scoped to a catalog it cannot
  // write. The invariant lives in the type, not a comment. [LAW:types-are-the-program] [LAW:decomposition]
  readonly reports: ReportReader;
  // The catalog — read to resolve each reported playground's title and current visibility, and WRITTEN
  // to enact the listing decision. The full Catalog, not CatalogReader: moderation legitimately owns
  // visibility, so the write capability is real here (exactly what CatalogReader denies the report
  // path). [LAW:decomposition]
  readonly catalog: Catalog;
}

export const makeReviewService = (deps: ReviewServiceDeps): ReviewService => {
  const { reports, catalog } = deps;
  return {
    async queue(): Promise<readonly ReviewItem[]> {
      // Group reports by playground, preserving the order each playground was FIRST reported — a
      // deterministic queue order without a second sort key, mirroring the catalog's insertion-order
      // discipline. The Map both dedupes the target (so the catalog is read once per distinct
      // reported playground, not once per report) and accumulates every report against it.
      // [LAW:dataflow-not-control-flow]
      const byPlayground = new Map<PlaygroundId, Report[]>();
      for (const report of await reports.list()) {
        const existing = byPlayground.get(report.playgroundId);
        if (existing === undefined) byPlayground.set(report.playgroundId, [report]);
        else existing.push(report);
      }
      // Resolve each reported playground's current state. getPlayground resolves an UNLISTED
      // playground too (existence is monotonic), so an already-taken-down item still appears in the
      // queue with its listing shown — which is what lets the reviewer relist it. A reported id that
      // does not resolve is a real inconsistency (impossible under the current no-hard-delete model,
      // which is why the report intake proves existence at record time); it throws loudly rather than
      // being silently dropped. [LAW:no-silent-failure] [LAW:no-defensive-null-guards]
      return Promise.all(
        [...byPlayground.entries()].map(async ([id, itemReports]) => {
          const playground = await catalog.getPlayground(id);
          return { id, title: playground.session.turns[0].prompt, listing: playground.listing, reports: itemReports };
        }),
      );
    },

    setListing(id: PlaygroundId, listing: Listing): Promise<Playground> {
      return catalog.setListing(id, listing);
    },
  };
};
