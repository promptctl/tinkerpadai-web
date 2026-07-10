import { randomUUID } from 'node:crypto';
import type { Artifact } from '../provider/index.js';
import { findSelfContainmentViolation, SelfContainmentError } from './selfContainment.js';
import type { VersionId } from './types.js';
import { VersionId as mkVersionId } from './types.js';

// THE ARTIFACT SEAM. Holds immutable self-contained HTML files, each keyed by the
// version the store mints on write. There is deliberately NO operation that takes an
// existing version and replaces its bytes — immutability is structural, not a guard:
// "never overwrite" is true because overwriting is unrepresentable, not because we
// check for it. [LAW:types-are-the-program]
export interface ArtifactStore {
  // Store a file, minting and returning its version. Every put yields a fresh
  // VersionId — two generations producing byte-identical html are still two distinct
  // versions, never a dedup that silently collapses them.
  put(artifact: Artifact): Promise<VersionId>;

  // The file for a version. An unknown version fails loudly rather than returning an
  // empty file a caller would mistake for a real one. [LAW:no-silent-failure]
  get(versionId: VersionId): Promise<Artifact>;
}

// The swap point beneath the seam: dumb keyed byte storage. This is the part that
// varies across environments (local dir now; R2/KV later) — isolating it here is
// what lets one ArtifactStore run everywhere by swapping the backend, never by
// branching on environment. It takes a key it is given; it does not mint identity or
// know about immutability — those invariants live in the store above. `read` returns
// undefined for a genuinely absent key (optionality the store turns into a loud
// error). [LAW:decomposition] [LAW:dataflow-not-control-flow]
export interface BlobStore {
  write(versionId: VersionId, artifact: Artifact): Promise<void>;
  read(versionId: VersionId): Promise<Artifact | undefined>;
}

// The single implementation of the ArtifactStore invariants — enforce self-containment, mint a fresh
// version, and turn an absent key into a loud failure — over any BlobStore. The three adapters (memory,
// file, R2) supply only the backend and ALL compose through here, so self-containment is enforced at
// exactly one seam for every environment: nothing at a composition root can forget to wrap it, and no
// caller of put can slip an external-referencing artifact past. Self-containment is an ArtifactStore
// invariant (what is allowed to be stored) — the mechanism lives here; the POLICY (what counts as
// self-contained) lives in selfContainment.ts, composed in as a value. [LAW:single-enforcer] [LAW:decomposition]
export const makeArtifactStore = (blobs: BlobStore): ArtifactStore => ({
  async put(artifact: Artifact): Promise<VersionId> {
    // Reject before minting a version or writing a byte: a non-self-contained artifact never enters
    // storage, so nothing half-written is later mistaken for a real playground. The refusal is loud
    // and typed — the generation service routes SelfContainmentError to the failed-turn path so the
    // author gets an actionable message and a retry, not a silent bad file. [LAW:no-silent-failure]
    const violation = findSelfContainmentViolation(artifact);
    if (violation !== null) {
      throw new SelfContainmentError(violation);
    }
    const versionId = mkVersionId(randomUUID());
    await blobs.write(versionId, artifact);
    return versionId;
  },
  async get(versionId: VersionId): Promise<Artifact> {
    const artifact = await blobs.read(versionId);
    if (artifact === undefined) {
      throw new Error(`unknown version: ${versionId}`);
    }
    return artifact;
  },
});
