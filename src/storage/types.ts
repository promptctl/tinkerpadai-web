// The data types of the two persistence seams — ArtifactStore (immutable files
// keyed by version) and Catalog (the source of truth for what playgrounds exist).
// As with the provider seam, these types ARE the program: the adapter bodies are
// residue once the shapes are right. See design-docs/PROJECT.md for why the commons
// is the single source of truth and why a playground's file is "just a file".

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

// The derived, cheap view for rendering the commons list (p0v.6). `prompt` is the
// original describe (the first turn); `currentVersion` is the latest version to run.
// A projection of Playground, never stored alongside it.
export interface PlaygroundSummary {
  readonly id: PlaygroundId;
  readonly prompt: string;
  readonly providerId: ProviderId;
  readonly currentVersion: VersionId;
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
