import type { Subject } from '../identity/index.js';
import type { Catalog, PlaygroundId, Report, ReportStore } from '../storage/index.js';

// THE REPORT SERVICE — the one boundary that records a moderation signal, wiring the catalog (to
// prove the target exists) and the report store (to persist). It is the signal-collection half of
// moderation (moderation-5g7): it records reports and does NOT act on them — unlisting and review are
// the sibling ticket's concern (moderation-5g7.2). Thin by design, mirroring how the generation
// service fronts its own seams: the HTTP boundary parses/authenticates and calls this; the invariant
// ("a report names a playground that actually exists") lives here, once. [LAW:decomposition]
// [LAW:single-enforcer]
export interface ReportService {
  // Record a report raised by an authenticated reporter against a playground. The playground must
  // exist — a report against nothing is meaningless signal — so an unknown id fails LOUDLY with the
  // catalog's PlaygroundNotFoundError (the HTTP boundary maps it to 404, exactly as continue/fork
  // do), never a silently stored orphan. [LAW:no-silent-failure]
  report(input: { readonly playgroundId: PlaygroundId; readonly reason: string; readonly reporter: Subject }): Promise<Report>;
}

export interface ReportServiceDeps {
  // The read seam used ONLY to prove the reported playground exists. The report path never mutates
  // the catalog — reporting is not a catalog concern — so it takes the read surface and nothing more.
  readonly catalog: Catalog;
  // Where the signal is persisted. The store mints the report's id and timestamp; this service only
  // supplies the resolved reporter, target, and reason. [LAW:one-source-of-truth]
  readonly reports: ReportStore;
}

export const makeReportService = (deps: ReportServiceDeps): ReportService => {
  const { catalog, reports } = deps;
  return {
    async report({ playgroundId, reason, reporter }): Promise<Report> {
      // Prove existence before recording. getPlayground throws PlaygroundNotFoundError for an unknown
      // id — a loud, typed failure the HTTP layer already maps to 404 — so an orphan report is
      // unrepresentable rather than defended against after the fact. [LAW:no-silent-failure]
      //
      // Existence is proven at CHECK time, not atomically with the record write across the two stores.
      // That window is unreachable under the current model: the Catalog has no delete path
      // (createPlayground/appendTurn/getPlayground/listPlaygrounds — nothing removes a playground), and
      // moderation's unlist (5g7.2) is a STATE change, not a deletion, so getPlayground stays truthful
      // for the report's whole lifetime. Playground existence is monotonic, so the check is sufficient;
      // a cross-store transaction for a delete that cannot happen would be carrying cost with no payoff.
      // Should a hard-delete path ever land, the two writes must move behind one transactional boundary.
      // [LAW:carrying-cost]
      await catalog.getPlayground(playgroundId);
      return reports.record({ playgroundId, reporter, reason });
    },
  };
};
