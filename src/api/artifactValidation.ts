import type { Artifact } from '../provider/index.js';

// THE FUNCTIONAL-VALIDATION SEAM. Self-containment (src/storage/selfContainment.ts) answers a STATIC
// question — does the file reference anything outside itself? — but a file can be perfectly self-
// contained and still be broken: an uncaught TypeError on load, a SyntaxError that kills a whole
// <script> block (wave-1 shipped exactly these — 2 of 24 artifacts — because the loop's only success
// criterion was "process exited 0 and the file is non-empty"). This seam answers the DYNAMIC question
// the static check cannot: does the artifact actually RUN? An ArtifactValidator loads the artifact in a
// real browser and REJECTS with FunctionalDefectError when the page throws an uncaught exception on
// load; it RESOLVES when the artifact loads clean.
//
// It is an EFFECT (it runs a browser), so — unlike the pure static validator that lives inside the
// store — it is INJECTED, and the service stays pure with respect to it. Crucially, running untrusted
// generated HTML in a browser is a second place hostile code executes, so WHERE and HOW ISOLATED that
// browser is must be a composition-root choice, never baked into the service: the local Node root wires
// a headless Chrome on the operator's own machine (the same trust context generation already occupies
// today, since public edge generation is disabled); when public generation turns on at the edge, an
// ISOLATED render sandbox — a sibling to the player iframe, never the trusted app server (see
// design-docs/proposals/thumbnails-rye.3.md) — swaps in behind this same seam. The seam is the thing
// that lets that swap happen without touching the generation service. [LAW:effects-at-boundaries]
// [LAW:decomposition] [LAW:single-enforcer]

// A functional defect: one or more UNCAUGHT exceptions observed while the artifact loaded, in order.
// The non-empty tuple makes "a defect with no error" unrepresentable — a defect always carries at least
// the one error that made it a defect. Each entry is the browser's error string (name + message).
// [LAW:types-are-the-program]
export type LoadErrors = readonly [string, ...string[]];

// The ONE refusal the functional gate raises. It is the exact sibling of the storage boundary's
// SelfContainmentError: a TYPED failure (so the generation service can route it to the failed-turn path
// and never mistake it for an infra fault) that renders itself to an actionable human message ONCE,
// here, beside the data it describes, so the message cannot drift from the errors it reports. A caller
// that only reads `.message` gets the actionable text; one that needs the raw errors reads `.errors`.
// [LAW:one-source-of-truth] [LAW:types-are-the-program]
export class FunctionalDefectError extends Error {
  constructor(public readonly errors: LoadErrors) {
    super(describeDefect(errors));
    this.name = 'FunctionalDefectError';
  }
}

// The single home for turning observed load errors into prose — so the wording lives once, beside the
// type it describes. [LAW:one-source-of-truth]
const describeDefect = (errors: LoadErrors): string => {
  const noun = errors.length === 1 ? 'error' : 'errors';
  const list = errors.map((error) => `"${truncate(error)}"`).join('; ');
  return `not functional: the playground throws ${errors.length} uncaught JavaScript ${noun} on load (${list}). A playground must load and run without uncaught errors — fix the script so it executes cleanly.`;
};

const truncate = (value: string, max = 200): string => (value.length <= max ? value : `${value.slice(0, max)}…`);

// The functional gate, as a value the composition root supplies. It RESOLVES when the artifact loads
// without an uncaught error and REJECTS with FunctionalDefectError when it does not. Any OTHER rejection
// is an infra fault (the validator's browser could not launch) and the service lets it propagate loudly
// — never relabelled as a quality failure — exactly as it treats a non-SelfContainmentError store fault.
// The type is the discriminator. [LAW:types-are-the-program] [LAW:no-silent-failure]
export type ArtifactValidator = (artifact: Artifact) => Promise<void>;

// The sanctioned "no functional gate here" value: a validator that always passes. The edge composition
// root supplies it because generation is disabled there (no provider is registered, so no turn is ever
// admitted and it is never called) — exactly as the edge supplies a no-op disposeTurn. It is also the
// default in tests that do not exercise the gate. A VALUE the composition root chooses, never a branch
// inside the service. [LAW:dataflow-not-control-flow]
export const passThroughValidator: ArtifactValidator = async () => undefined;
