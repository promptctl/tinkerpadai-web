// THE GENERATION POLICY — the two deliberate knobs that bound one generation: how long a
// single attempt may run before it is a loud failure (timeoutMs), and how many attempts a
// request may make before its failure is surfaced (maxAttempts). Both are DEPLOY policy, so
// the composition roots state them here rather than inheriting a silent default buried in the
// driver — the exact trap quality-ppu.2 found, where production ran on the tmux driver's
// hardcoded 5-minute fallback while real briefs need 5-11 minutes. Mirrors QuotaLimits: a
// typed policy, a documented default, one parser both roots read the environment through.
// [LAW:one-source-of-truth] [LAW:decomposition]

export interface GenerationPolicy {
  // The per-attempt deadline the provider enforces: past it, one attempt fails loudly rather
  // than hanging forever. It bounds a SINGLE attempt — the whole request's ceiling is this
  // times maxAttempts, which the seeding client's liveness backstop must stay above.
  // [LAW:no-silent-failure]
  readonly timeoutMs: number;
  // Total attempts one request may make, INCLUDING the first (so 1 = no retry, the prior
  // behavior). A failed provider attempt (timeout, crash, empty file) is retried from the
  // same brief until this budget is spent, then the failure is surfaced. >= 1 always.
  readonly maxAttempts: number;
}

// The default policy. 15 minutes covers the observed real-brief distribution (lean briefs
// ~1-4 min, rich briefs up to ~11 min with a tail past 10) with margin; 2 attempts gives one
// retry as a backstop for transient failures without unbounding a request's cost. A deploy
// overrides either via TINKERPAD_GENERATION_TIMEOUT_MS / TINKERPAD_MAX_GENERATION_ATTEMPTS.
export const DEFAULT_GENERATION_POLICY: GenerationPolicy = {
  timeoutMs: 15 * 60 * 1000,
  maxAttempts: 2,
};

// Parse one positive-integer policy value from an optional env string. Mirrors parseQuotaLimits'
// parseLimit exactly: an explicitly-SET but non-integer/below-minimum value fails LOUDLY at boot
// (a silent fallback would run production on a deadline/retry the operator did not choose), while
// an UNSET value is the honest "use the default". [LAW:no-silent-failure]
const parsePositiveInt = (value: string | undefined, name: string, min: number, fallback: number): number => {
  if (value === undefined) return fallback;
  // A plain decimal integer only. Number() alone would silently accept 0x10 → 16, 0o10 → 8, 0b10 → 2,
  // 1e3 → 1000 — all pass Number.isSafeInteger, so an operator's hex/scientific typo becomes a
  // wrong-but-accepted value. Reject anything but base-ten digits at the boundary, then bound it (the
  // isSafeInteger guard still catches a decimal string past MAX_SAFE_INTEGER). [LAW:no-silent-failure]
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < min) {
    throw new Error(`${name}=${JSON.stringify(value)} is not an integer >= ${min}`);
  }
  return n;
};

// The single-value parser for the retry budget, split out so a root that consumes ONLY the retry
// budget — the edge Worker, which has no driver and so no deadline to enforce — can validate it
// without also validating a deadline it never uses (an invalid inert deadline should not brick the
// whole edge). It is the ONE source of how TINKERPAD_MAX_GENERATION_ATTEMPTS becomes a number, reused
// by parseGenerationPolicy below so the two cannot drift. [LAW:one-source-of-truth] [LAW:decomposition]
export const parseMaxGenerationAttempts = (value: string | undefined): number =>
  parsePositiveInt(value, 'TINKERPAD_MAX_GENERATION_ATTEMPTS', 1, DEFAULT_GENERATION_POLICY.maxAttempts);

// The parser the roots WITH a driver (both Node entries) read the full policy through, so "how the
// env becomes the policy" is defined once and cannot drift between deploys — exactly as
// parseQuotaLimits does for the rate-limit caps. [LAW:one-source-of-truth]
export const parseGenerationPolicy = (env: {
  readonly timeoutMs: string | undefined;
  readonly maxAttempts: string | undefined;
}): GenerationPolicy => ({
  timeoutMs: parsePositiveInt(env.timeoutMs, 'TINKERPAD_GENERATION_TIMEOUT_MS', 1, DEFAULT_GENERATION_POLICY.timeoutMs),
  maxAttempts: parseMaxGenerationAttempts(env.maxAttempts),
});
