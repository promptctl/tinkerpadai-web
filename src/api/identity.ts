// THE IDENTITY SEAM. The single concern of "who is making this request" expressed as one
// boundary: a function from a Request to an Identity, or null when there is none. The
// MECHANISM behind it — a dev cookie today, a real session provider later — lives entirely on
// the far side of this type, so it can be swapped without touching the write-path enforcer
// that consumes it (httpHandler). This is the foundational seam every later auth slice
// composes onto. [LAW:locality-or-seam] [LAW:decomposition]

// Branded, matching the provider seam's id convention — a bare `string` would let a Subject be
// passed where any other id is expected. [LAW:types-are-the-program]
type Brand<T, B extends string> = T & { readonly __brand: B };

// The stable id of an authenticated principal. Minted only through the constructor below, so
// foreign input becomes a Subject at exactly one place rather than via scattered casts.
// [LAW:single-enforcer]
export type Subject = Brand<string, 'Subject'>;
export const Subject = (raw: string): Subject => raw as Subject;

// The authenticated principal of a write-path request. `subject` is all the domain knows today
// — the stable id later slices thread into attribution and lineage (who generated/forked a
// playground). No speculative fields: it carries exactly what is real now. [LAW:carrying-cost]
export interface Identity {
  readonly subject: Subject;
}

// The seam itself. Resolving an Identity reads request state (a cookie, a header) — an effect
// confined to the resolver's far side; the enforcer that calls this stays pure, branching on
// the returned VALUE (Identity | null), never on how it was obtained. `null` is the honest
// representation of "no identity", a value the guard matches rather than a thrown special
// case. [LAW:effects-at-boundaries] [LAW:dataflow-not-control-flow]
export type IdentityResolver = (request: Request) => Identity | null;

// The default mechanism for the single-user local thread: the operator IS the one principal,
// so every request resolves to the same fixed identity and the write path is open in local
// dev. It is honest, not a bypass — there genuinely is one local user — and it is a VALUE the
// composition root wires in, so the session-backed resolver (a later slice) swaps it here
// without the enforcer ever changing. [LAW:one-type-per-behavior] [LAW:no-silent-failure]
const LOCAL_SUBJECT = Subject('local');
export const localIdentityResolver: IdentityResolver = () => ({ subject: LOCAL_SUBJECT });
