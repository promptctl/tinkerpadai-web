// The data types of the two persistence seams — ArtifactStore (immutable files
// keyed by version) and Catalog (the source of truth for what playgrounds exist).
// As with the provider seam, these types ARE the program: the adapter bodies are
// residue once the shapes are right. See design-docs/PROJECT.md for why the commons
// is the single source of truth and why a playground's file is "just a file".

import type { Subject } from '../identity/index.js';
import type { ProviderId, SessionHandle, SessionId } from '../provider/index.js';

// Branded identifiers minted by THIS layer. The provider seam owns Session/Turn
// identity; persistence owns Version and Playground identity. A bare `string` would
// let one be passed where another is expected; branding makes that unrepresentable.
// [LAW:types-are-the-program] [LAW:one-source-of-truth]
type Brand<T, B extends string> = T & { readonly __brand: B };

// The immutable identity of one stored artifact. Minted by the ArtifactStore on
// put — a provider produces a file, it does not own version identity.
export type VersionId = Brand<string, 'VersionId'>;

// The public, browsable identity of a playground in the commons. Minted by the
// Catalog; distinct from the SessionId that generated it, because "a published
// artifact you discover and run" and "a generation interaction with a provider" are
// different concerns with different lifecycles. [LAW:decomposition]
export type PlaygroundId = Brand<string, 'PlaygroundId'>;

// The single place that mints these brands — callers go through these rather than
// scattering `as` casts. [LAW:single-enforcer]
export const VersionId = (raw: string): VersionId => raw as VersionId;
export const PlaygroundId = (raw: string): PlaygroundId => raw as PlaygroundId;

// A normalized topic tag — one facet of the commons' discoverability (math, css, tools, design,
// interactive…). Branded like the ids above, but with a difference that earns its keep: minting a
// Tag NORMALIZES it. 'CSS' and 'css' both become the one tag `css`, and ' Data Viz ' becomes
// `data-viz` — so the commons' tag facets never fragment on case or spacing. Normalization lives at
// this one boundary, so an un-normalized Tag is unrepresentable everywhere downstream.
// [LAW:types-are-the-program]
export type Tag = Brand<string, 'Tag'>;

// The single normalizer: lowercase, replace every run of non-alphanumerics with one hyphen, trim
// hyphens. So spaces and punctuation between words become hyphens ('Data Viz' → `data-viz`), never
// collapse away ('C.S.S' → `c-s-s`, not `css`). The one home for tag normalization — both minters
// below derive from it, so a Tag() result and a tryTag() result for the same input are identical
// wherever both are defined. A pure-punctuation input normalizes to the empty string, which is the
// "not a tag at all" value the two minters treat differently (throw vs null). [LAW:single-enforcer]
// [LAW:one-source-of-truth]
const normalizeTag = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// The strict minter, for our OWN inputs (the curated vocabulary and already-normalized stored
// values). A raw string that normalizes to empty is not a tag at all; minting one would be a silent
// lie, so it throws — and since the only callers are trusted, this fires at module load if the
// vocabulary is malformed, never on a hot path. [LAW:no-silent-failure]
export const Tag = (raw: string): Tag => {
  const normalized = normalizeTag(raw);
  if (normalized === '') throw new Error(`not a valid tag: ${JSON.stringify(raw)}`);
  return normalized as Tag;
};

// The non-throwing minter, for TRUST BOUNDARIES — a user-supplied tag from a URL query, where a
// hand-edited '?tag=' or '?tag=!!!' must not fault the whole page. It returns null for input with no
// valid tag token, so the caller DROPS it as a constraint (it could match nothing anyway) rather
// than crash. Same normalizer as Tag(), so the two agree wherever both produce a value; the ONLY
// difference is how they represent "no tag here" — an exception vs a null the caller handles.
// [LAW:single-enforcer] [LAW:no-defensive-null-guards]
export const tryTag = (raw: string): Tag | null => {
  const normalized = normalizeTag(raw);
  return normalized === '' ? null : (normalized as Tag);
};

// A playground's topic tags — a bounded, priority-ordered list of normalized Tags for the commons'
// facets and the player chrome. Possibly EMPTY: a playground stored before tagging existed carries
// none, and that is a value (no chips), never an error — so this is `readonly Tag[]`, not a
// non-empty tuple, because a non-empty tuple would be a theorem the legacy-empty case falsifies.
// New playgrounds are populated with a non-empty list at creation (the generation service's
// extraction step, deriveTags); the count is a property of that producer, not a type invariant.
// [LAW:types-are-the-program] [LAW:dataflow-not-control-flow]
export type Tags = readonly Tag[];

// Fork lineage — the remix axis, kept deliberately SEPARATE from version history.
// `forkedFromVersion` points at a version belonging to ANOTHER session (the parent);
// a playground's own version history lives on its turns. Conflating the two is the
// exact mistake this ticket calls out, so they are different fields that never bleed
// into each other. [LAW:one-source-of-truth]
export interface Lineage {
  readonly parentSession: SessionId;
  readonly forkedFromVersion: VersionId;
}

// One recorded turn: the prompt that drove it and the version it produced. The
// catalog records turns that produced versions — a failed generation produces no
// version and no playground, so it is surfaced to the user (p0v.4), not stored here
// as an empty turn. Every recorded turn therefore has a version, with no nullable to
// guard. [LAW:no-defensive-null-guards]
export interface TurnRecord {
  readonly turnId: SessionHandle['turnId'];
  readonly prompt: string;
  readonly version: VersionId;
}

// A generation session: which provider produced it, its optional fork lineage, and
// its turns in order. `turns` is a non-empty tuple because a session enters the
// catalog only once its first turn has produced a version — the empty-session state
// is unrepresentable, so `turns[0]` (the original describe) is always present.
// [LAW:types-are-the-program]
export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly providerId: ProviderId;
  readonly lineage: Lineage | null;
  // WHO authored this playground — the authenticated principal who generated or forked it,
  // recorded once at the create write and never re-derived. A property of the session as a
  // whole, parallel to lineage: a session has exactly one author (its creator), so it is not
  // null and is not per-turn. A follow-up turn appends a version, never a new author; a fork
  // mints a new session whose author is the forker. The generation SessionId never crosses into
  // the read projection, but the author does, as visible attribution. [LAW:one-source-of-truth]
  readonly author: Subject;
  // WHAT this playground is ABOUT — its normalized topic tags, classified once at the create write
  // (the generation service's extraction step) and never re-derived, exactly parallel to author.
  // A property of the session as a whole: a follow-up turn appends a version, never re-tags; a fork
  // classifies afresh. Stored (not derived on read) because a tag is a DURABLE classification — if
  // it were recomputed each read, improving the extractor would silently re-tag every existing
  // playground and shift the facets discovery is built on. The single source of truth for this
  // playground's tags is here; the summary projects it. [LAW:one-source-of-truth]
  readonly tags: Tags;
  readonly turns: readonly [TurnRecord, ...TurnRecord[]];
}

// A playground: the browsable unit of the commons, backed by the session that
// generates its versions. Its "current version" is NOT stored — it is derived from
// the session's turns (see currentVersionOf), so a second copy can never drift.
// [LAW:one-source-of-truth]
export interface Playground {
  readonly id: PlaygroundId;
  readonly session: SessionRecord;
}

// A browsable reference to a parent playground — its public id and its original describe
// (the title the commons shows). Both come from the SAME parent playground when it is
// resolved, so they cannot disagree; the parent's generation identity (its SessionId)
// never crosses into the read path. [LAW:decomposition]
export interface ParentRef {
  readonly id: PlaygroundId;
  readonly prompt: string;
}

// Fork lineage PROJECTED for the read path — the visible half of the remix. A playground
// either is a fork or it is not (the whole value is null when it is not, so non-forks are a
// value, never a special case). When it is a fork, `parent` is the browsable parent where it
// still resolves in the commons, or null when the parent has left — the fork FACT is durable
// even when the parent is gone. This is the fork axis only: "forked from another playground's
// version", never this playground's own turn/version history, which the two never conflate.
// A derivation of Lineage over the catalog, never a stored second copy. [LAW:one-source-of-truth]
export interface ForkAttribution {
  readonly parent: ParentRef | null;
}

// The read-path projection of a session's turns: the ordered prompts that built the
// playground — the describe->refine story made visible (layer A of the history epic).
// Derived from turns (the single source of truth for version history), never stored.
// Non-empty because turns is non-empty: every playground has at least its original
// describe at recipe[0] (the same value PlaygroundSummary.prompt projects). Each step is
// only its prompt — the human-readable recipe; the turnId is generation identity that
// never crosses into the read path, and the version is the store's concern, with no
// read-path consumer to justify exposing an opaque id. [LAW:one-source-of-truth]
// [LAW:types-are-the-program]
export type Recipe = readonly [string, ...string[]];

// The derived, cheap view for rendering the commons list (p0v.6). `prompt` is the
// original describe (the first turn); `currentVersion` is the latest version to run;
// `forkedFrom` is the fork-axis attribution (null when this playground is not a fork);
// `recipe` is the ordered prompts that built it. A projection of Playground, never stored
// alongside it.
export interface PlaygroundSummary {
  readonly id: PlaygroundId;
  readonly prompt: string;
  readonly providerId: ProviderId;
  readonly currentVersion: VersionId;
  readonly forkedFrom: ForkAttribution | null;
  // The iteration recipe — the ordered prompts that built this playground, projected for the
  // read path so a viewer/remixer can see HOW it was made. A derivation of the session's turns,
  // never a second copy; recipe[0] is the same describe that `prompt` projects, from the same
  // source, so the two cannot drift. [LAW:one-source-of-truth]
  readonly recipe: Recipe;
  // The principal who made this playground, projected for the read path as "by <author>" chrome
  // alongside the fork attribution. The author (not the generation SessionId, which stays off
  // this summary) is the public half of provenance. A derivation of the stored author, never a
  // second copy. [LAW:one-source-of-truth]
  readonly author: Subject;
  // The topic tags for this playground, projected for the read path as the chip row the commons
  // card and player chrome render (and the facets discovery filters on). A pass-through of the
  // stored tags — like `author`, never a second copy and never re-classified here — so tags read
  // identically wherever a playground is listed. Empty for a playground that predates tagging;
  // non-empty for every new one. [LAW:one-source-of-truth]
  readonly tags: Tags;
}

// What p0v.4 hands the catalog on a succeeded turn: the provider's turn handle
// (carrying providerId/sessionId/turnId), the prompt that produced it, the stored
// artifact's version, and optional fork lineage (null in the one-shot steel thread,
// set on remix). The catalog mints the PlaygroundId; the caller owns none of the
// identity here except what the provider already minted. [LAW:one-source-of-truth]
export interface NewPlayground {
  readonly handle: SessionHandle;
  readonly prompt: string;
  readonly version: VersionId;
  readonly lineage: Lineage | null;
  // The authenticated principal creating this playground (the generation service resolves it at
  // the gated write — the one place identity exists). Required: a playground with no author is
  // not a representable state. A follow-up turn (NewTurn) has no author — appending never
  // re-authors. [LAW:types-are-the-program]
  readonly author: Subject;
  // The topic tags classified for this playground by the generation service's extraction step, the
  // producer THIS seam is the join for. The catalog stores what it is given and never knows the
  // taxonomy, so a richer future classifier (the agent emitting semantic tags) swaps the producer
  // behind this one field, touching neither the catalog nor the read path. Required: like author, a
  // create records tags; a follow-up (NewTurn) carries none — appending never re-tags.
  // [LAW:decomposition] [LAW:locality-or-seam]
  readonly tags: Tags;
}

// What a succeeded FOLLOW-UP turn hands the catalog to extend an existing playground
// (iterate): the continued turn's handle, the follow-up prompt, and the stored version.
// No lineage — appending a turn is the VERSION-HISTORY axis, never the fork axis; the two
// stay separate. The handle's sessionId/providerId must match the target playground's
// session (the catalog enforces it), so a follow-up cannot be stitched onto a foreign
// session. [LAW:one-source-of-truth]
export interface NewTurn {
  readonly handle: SessionHandle;
  readonly prompt: string;
  readonly version: VersionId;
}

// The whole persisted catalog document — the unit a CatalogStore reads and writes.
// Playgrounds are kept in insertion order so the commons lists them deterministically.
export interface CatalogDoc {
  readonly playgrounds: readonly Playground[];
}
