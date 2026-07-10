import { describe, expect, it } from 'vitest';
import { Subject } from '../identity/index.js';
import {
  DEFAULT_QUOTA_LIMITS,
  makeGenerationQuota,
  parseQuotaLimits,
  QuotaExceededError,
} from './generationQuota.js';
import type { QuotaDenial } from './generationQuota.js';

// The quota's contract asserted as OBSERVABLE behavior: how many reservations it admits per
// identity before refusing, that releasing frees a concurrent slot, that the daily window resets
// at UTC midnight while an in-flight reservation does not, and that a refusal names the binding
// limit. Never how it counts internally. [LAW:behavior-not-structure]

const SUBJECT = Subject('u');
const OTHER = Subject('v');

// A controllable clock: tests advance time explicitly, so the daily window is deterministic and the
// quota's counting core stays pure with respect to the real clock. [LAW:no-ambient-temporal-coupling]
const clockFrom = (start: number): { now: () => number; set: (t: number) => void } => {
  let t = start;
  return { now: () => t, set: (next) => (t = next) };
};

// A concrete instant and the UTC midnight that follows it, used by the daily-window tests.
const NOON_2026_07_10 = Date.UTC(2026, 6, 10, 12);
const MIDNIGHT_2026_07_11 = Date.UTC(2026, 6, 11);

// Capture the denial a reserve throws, or fail if it unexpectedly admits.
const denialOf = (reserve: () => void): QuotaDenial => {
  try {
    reserve();
  } catch (error) {
    if (error instanceof QuotaExceededError) return error.denial;
    throw error;
  }
  throw new Error('expected the reserve to be refused, but it was admitted');
};

describe('GenerationQuota — concurrent cap', () => {
  it('admits up to the concurrent limit, then refuses loudly naming that limit', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 2, maxDaily: 100 }, now: () => 0 });
    quota.reserve(SUBJECT);
    quota.reserve(SUBJECT);
    const denial = denialOf(() => quota.reserve(SUBJECT));
    expect(denial).toEqual({ kind: 'concurrent', limit: 2 });
  });

  it('releasing an in-flight reservation frees a concurrent slot', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    const held = quota.reserve(SUBJECT);
    // At the cap: a second reservation is refused while the first is held.
    expect(() => quota.reserve(SUBJECT)).toThrow(QuotaExceededError);
    held.release();
    // The freed slot admits the next one.
    expect(() => quota.reserve(SUBJECT)).not.toThrow();
  });

  it('release is idempotent — releasing twice frees exactly one slot', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: () => 0 });
    const held = quota.reserve(SUBJECT);
    held.release();
    held.release(); // a second release must not over-credit the concurrent count
    quota.reserve(SUBJECT); // the one real slot
    // With maxConcurrent 1 and one slot now held, the next reserve is refused — proving the double
    // release did not leak a phantom slot.
    expect(() => quota.reserve(SUBJECT)).toThrow(QuotaExceededError);
  });

  it('caps are per-identity — one subject at its cap does not block another', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 1 }, now: () => 0 });
    quota.reserve(SUBJECT);
    expect(() => quota.reserve(OTHER)).not.toThrow();
  });
});

describe('GenerationQuota — daily cap', () => {
  it('admits up to the daily limit across a day, then refuses even when nothing is in flight', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 100, maxDaily: 2 }, now: () => NOON_2026_07_10 });
    // Release each so the CONCURRENT budget never binds — this isolates the daily wall.
    quota.reserve(SUBJECT).release();
    quota.reserve(SUBJECT).release();
    const denial = denialOf(() => quota.reserve(SUBJECT));
    expect(denial).toEqual({ kind: 'daily', limit: 2, resetsAt: MIDNIGHT_2026_07_11 });
  });

  it('resets the daily budget at the next UTC midnight', () => {
    const clock = clockFrom(NOON_2026_07_10);
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 100, maxDaily: 1 }, now: clock.now });
    quota.reserve(SUBJECT).release();
    expect(() => quota.reserve(SUBJECT)).toThrow(QuotaExceededError); // out of today's budget
    clock.set(MIDNIGHT_2026_07_11); // a new UTC day
    expect(() => quota.reserve(SUBJECT)).not.toThrow();
  });

  it('does not reset the CONCURRENT count at the day boundary — an in-flight turn spans midnight', () => {
    const clock = clockFrom(NOON_2026_07_10);
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 100 }, now: clock.now });
    quota.reserve(SUBJECT); // held, not released — a turn still running
    clock.set(MIDNIGHT_2026_07_11);
    // The held reservation still occupies the one concurrent slot after the day rolls over.
    const denial = denialOf(() => quota.reserve(SUBJECT));
    expect(denial.kind).toBe('concurrent');
  });

  it('reports the DAILY wall first when both budgets are exhausted', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 1, maxDaily: 1 }, now: () => NOON_2026_07_10 });
    quota.reserve(SUBJECT); // held: now concurrent 1/1 AND daily 1/1
    const denial = denialOf(() => quota.reserve(SUBJECT));
    expect(denial.kind).toBe('daily');
  });
});

describe('QuotaExceededError — message states the limit and when it resets', () => {
  it('the concurrent message names the limit', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 3, maxDaily: 100 }, now: () => 0 });
    quota.reserve(SUBJECT);
    quota.reserve(SUBJECT);
    quota.reserve(SUBJECT);
    try {
      quota.reserve(SUBJECT);
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(QuotaExceededError);
      expect((error as QuotaExceededError).message).toContain('3');
      expect((error as QuotaExceededError).message.toLowerCase()).toContain('progress');
    }
  });

  it('the daily message names the limit and the reset instant', () => {
    const quota = makeGenerationQuota({ limits: { maxConcurrent: 100, maxDaily: 5 }, now: () => NOON_2026_07_10 });
    for (let i = 0; i < 5; i += 1) quota.reserve(SUBJECT).release();
    try {
      quota.reserve(SUBJECT);
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(QuotaExceededError);
      const message = (error as QuotaExceededError).message;
      expect(message).toContain('5');
      expect(message).toContain(new Date(MIDNIGHT_2026_07_11).toISOString());
    }
  });
});

describe('parseQuotaLimits', () => {
  it('falls back to the documented defaults when unset', () => {
    expect(parseQuotaLimits({ maxConcurrent: undefined, maxDaily: undefined })).toEqual(DEFAULT_QUOTA_LIMITS);
  });

  it('parses valid positive integers', () => {
    expect(parseQuotaLimits({ maxConcurrent: '5', maxDaily: '200' })).toEqual({ maxConcurrent: 5, maxDaily: 200 });
  });

  it('fails loudly on a set-but-invalid value rather than silently defaulting', () => {
    expect(() => parseQuotaLimits({ maxConcurrent: 'lots', maxDaily: undefined })).toThrow(
      /TINKERPAD_MAX_CONCURRENT_GENERATIONS/,
    );
    expect(() => parseQuotaLimits({ maxConcurrent: undefined, maxDaily: '0' })).toThrow(
      /TINKERPAD_MAX_DAILY_GENERATIONS/,
    );
  });
});
