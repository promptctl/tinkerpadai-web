import type { Subject } from '../identity/index.js';

// THE GENERATION QUOTA — the single part that answers "may this identity start another
// generation right now?" and nothing else. It knows only subjects and counts: no provider,
// no turn, no catalog. The generation service composes it in, calling reserve() at a turn's
// start and releasing the returned Reservation when that turn settles. Keeping accounting a
// separate part from turn lifecycle is what lets the service stay the one owner of turns while
// this stays the one owner of per-identity budgets. [LAW:decomposition] [LAW:single-enforcer]
//
// Two budgets per identity, both from the same abuse concern (one user must not monopolize or
// weaponize the generation provider): a CONCURRENT cap on in-flight generations, and a DAILY
// cap on generations started per UTC day. Exceeding either is a loud, typed refusal naming the
// limit and when it resets — never a silent queue. [LAW:no-silent-failure]

// The caps. Deploy-tunable config (a rate limiter is tuned against observed cost/abuse), so the
// composition roots read them from the environment and fall back to the defaults below.
export interface QuotaLimits {
  // Maximum generations an identity may have in flight at once. The provider spawns real work
  // per turn, so this bounds a single identity's simultaneous load on it.
  readonly maxConcurrent: number;
  // Maximum generations an identity may START within one UTC day. Resets at UTC midnight.
  readonly maxDaily: number;
}

// The defaults: generous enough for a real user's session, low enough to blunt weaponization.
// A deploy overrides them via TINKERPAD_MAX_CONCURRENT_GENERATIONS / _MAX_DAILY_GENERATIONS.
export const DEFAULT_QUOTA_LIMITS: QuotaLimits = { maxConcurrent: 3, maxDaily: 50 };

// Parse one positive-integer cap from an optional env string. Mirrors serverConfig's parsePort:
// an explicitly-SET but non-integer/non-positive value fails LOUDLY at boot, because silently
// falling back to a default would let an abuser past the cap the operator believed they set. An
// UNSET value is the honest "use the default" and takes the fallback. [LAW:no-silent-failure]
const parseLimit = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a positive integer`);
  }
  return n;
};

// The one parser both composition roots read the quota caps through, so "how the env becomes
// limits" is defined once and cannot drift between the Node and edge deploys — exactly as
// parseAdminSubjects does for the admin allowlist. [LAW:one-source-of-truth]
export const parseQuotaLimits = (env: {
  readonly maxConcurrent: string | undefined;
  readonly maxDaily: string | undefined;
}): QuotaLimits => ({
  maxConcurrent: parseLimit(env.maxConcurrent, 'TINKERPAD_MAX_CONCURRENT_GENERATIONS', DEFAULT_QUOTA_LIMITS.maxConcurrent),
  maxDaily: parseLimit(env.maxDaily, 'TINKERPAD_MAX_DAILY_GENERATIONS', DEFAULT_QUOTA_LIMITS.maxDaily),
});

// The TYPED reason a generation was refused. Discriminated so the message and the HTTP status
// dispatch on the KIND, never on parsing a string. Each member carries exactly what its message
// needs: the concurrent wall frees when a running turn finishes (no fixed clock time), so it
// carries only the limit; the daily wall carries the instant it resets (next UTC midnight).
// [LAW:types-are-the-program]
export type QuotaDenial =
  | { readonly kind: 'concurrent'; readonly limit: number }
  | { readonly kind: 'daily'; readonly limit: number; readonly resetsAt: number };

// The one place a denial becomes its human message — the SAME string the HTTP layer returns in
// { error } and the create UI surfaces verbatim. Stating the limit and when it resets is the
// ticket's contract; centralizing it here keeps that wording one source of truth. [LAW:one-source-of-truth]
const quotaMessage = (denial: QuotaDenial): string => {
  switch (denial.kind) {
    case 'concurrent':
      return `You already have ${denial.limit} generations in progress, the maximum allowed. Wait for one to finish before starting another.`;
    case 'daily':
      return `You've reached your daily limit of ${denial.limit} generations. Your limit resets at ${new Date(denial.resetsAt).toISOString()}.`;
    default: {
      const unreachable: never = denial;
      return unreachable;
    }
  }
};

// The loud refusal. Typed (not a bare Error) so the HTTP route maps it to 429 the way
// PlaygroundNotFoundError maps to 404 — a distinct, client-actionable status, never a 500 that
// misreads a rate limit as a server fault. Its message IS the verbatim UI string. [LAW:no-silent-failure]
export class QuotaExceededError extends Error {
  constructor(public readonly denial: QuotaDenial) {
    super(quotaMessage(denial));
    this.name = 'QuotaExceededError';
  }
}

// A held generation slot. Its sole capability is to free the CONCURRENT slot once the generation
// it guards settles — or fails to ever start. The DAILY budget is deliberately not freed: a
// generation that was admitted counts against the day even if it later fails, so an abuser cannot
// retry-storm a failing provider for free. release() is idempotent by construction — a reservation
// is a slot held at most once, so releasing a freed one is a no-op, not a double-decrement.
// [LAW:types-are-the-program]
export interface Reservation {
  release(): void;
}

export interface GenerationQuota {
  // Admit one generation for this subject, or refuse loudly. On admission it counts the
  // generation against BOTH budgets and returns the Reservation that frees the concurrent slot
  // when the turn settles. Over either cap it throws QuotaExceededError — the daily wall checked
  // first because it is the binding one (a freed concurrent slot cannot help an identity that is
  // out of daily budget). [LAW:no-silent-failure] [LAW:dataflow-not-control-flow]
  reserve(subject: Subject): Reservation;
}

// The per-identity accounting, owned entirely by the closure below: no ambient global, one API
// (reserve), documented invariant (daily resets at the UTC day boundary; concurrent only ever
// moves by reserve/release, never by the clock, so a turn spanning midnight stays counted).
// [LAW:no-shared-mutable-globals]
interface Budget {
  concurrent: number;
  daily: number;
  // The UTC day (YYYY-MM-DD) `daily` is counted within. A reserve on a later day resets `daily`.
  day: string;
}

const utcDayKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

const nextUtcMidnight = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export interface GenerationQuotaDeps {
  readonly limits: QuotaLimits;
  // The world's clock, injected so the daily window is deterministic in tests and the counting
  // core stays pure with respect to time. [LAW:effects-at-boundaries] [LAW:no-ambient-temporal-coupling]
  readonly now: () => number;
}

// The in-memory quota. Same steel-thread limitation as the service's in-flight turn map: the
// counts live in process memory and reset on restart. That is correct where generation runs today
// (the single Node process); a multi-isolate edge that enables public generation (providers-u1h)
// will supply a durable implementation behind this same GenerationQuota seam, changing nothing in
// the service. [LAW:no-shared-mutable-globals]
export const makeGenerationQuota = (deps: GenerationQuotaDeps): GenerationQuota => {
  const { limits, now } = deps;
  const budgets = new Map<Subject, Budget>();

  const budgetFor = (subject: Subject, today: string): Budget => {
    const existing = budgets.get(subject);
    // A first-seen subject, or one whose last generation was on an earlier UTC day: start today
    // at zero daily. Concurrent is NOT reset — an in-flight turn from yesterday is still running.
    if (existing === undefined) {
      const fresh: Budget = { concurrent: 0, daily: 0, day: today };
      budgets.set(subject, fresh);
      return fresh;
    }
    if (existing.day !== today) {
      existing.daily = 0;
      existing.day = today;
    }
    return existing;
  };

  return {
    reserve(subject: Subject): Reservation {
      const nowMs = now();
      const budget = budgetFor(subject, utcDayKey(nowMs));

      // Daily first: it is the binding wall. If the identity is out of today's budget, freeing a
      // concurrent slot would not let them generate anyway, so the honest refusal is the daily one.
      if (budget.daily >= limits.maxDaily) {
        throw new QuotaExceededError({ kind: 'daily', limit: limits.maxDaily, resetsAt: nextUtcMidnight(nowMs) });
      }
      if (budget.concurrent >= limits.maxConcurrent) {
        throw new QuotaExceededError({ kind: 'concurrent', limit: limits.maxConcurrent });
      }

      budget.concurrent += 1;
      budget.daily += 1;

      // The reservation frees the concurrent slot exactly once. It closes over this identity's
      // budget, so a release always credits the same account it debited, even across day
      // rollovers (the record persists; only its `daily`/`day` fields roll). [LAW:one-source-of-truth]
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          budget.concurrent -= 1;
        },
      };
    },
  };
};
