import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATION_POLICY, parseGenerationPolicy, parseMaxGenerationAttempts } from './generationPolicy.js';

// parseGenerationPolicy is the one seam the composition roots read the generation policy through.
// Its contract mirrors parseQuotaLimits: unset takes the documented default, a set-but-invalid value
// fails LOUDLY at boot rather than silently running production on a policy the operator never chose.
// [LAW:no-silent-failure] [LAW:one-source-of-truth]

describe('parseGenerationPolicy', () => {
  it('takes the documented defaults when both values are unset', () => {
    expect(parseGenerationPolicy({ timeoutMs: undefined, maxAttempts: undefined })).toEqual(DEFAULT_GENERATION_POLICY);
  });

  it('reads valid explicit values', () => {
    expect(parseGenerationPolicy({ timeoutMs: '600000', maxAttempts: '3' })).toEqual({
      timeoutMs: 600000,
      maxAttempts: 3,
    });
  });

  it('defaults each value independently of the other', () => {
    expect(parseGenerationPolicy({ timeoutMs: '900000', maxAttempts: undefined })).toEqual({
      timeoutMs: 900000,
      maxAttempts: DEFAULT_GENERATION_POLICY.maxAttempts,
    });
  });

  it('defaults timeoutMs while reading an explicit maxAttempts — the symmetric direction', () => {
    expect(parseGenerationPolicy({ timeoutMs: undefined, maxAttempts: '3' })).toEqual({
      timeoutMs: DEFAULT_GENERATION_POLICY.timeoutMs,
      maxAttempts: 3,
    });
  });

  it('rejects non-decimal notations Number would otherwise accept (hex, scientific)', () => {
    // 0x10 → 16 and 1e3 → 1000 both pass Number.isSafeInteger; the decimal guard rejects them so an
    // operator's typo is a loud failure, not a silently-wrong deadline. [LAW:no-silent-failure]
    expect(() => parseGenerationPolicy({ timeoutMs: '0x10', maxAttempts: undefined })).toThrow(
      'TINKERPAD_GENERATION_TIMEOUT_MS',
    );
    expect(() => parseGenerationPolicy({ timeoutMs: '1e3', maxAttempts: undefined })).toThrow(
      'TINKERPAD_GENERATION_TIMEOUT_MS',
    );
  });

  it('fails loudly on a non-integer deadline rather than silently defaulting', () => {
    expect(() => parseGenerationPolicy({ timeoutMs: 'soon', maxAttempts: undefined })).toThrow(
      'TINKERPAD_GENERATION_TIMEOUT_MS',
    );
  });

  it('fails loudly on a zero or negative attempt budget — 1 is the minimum (no retry)', () => {
    expect(() => parseGenerationPolicy({ timeoutMs: undefined, maxAttempts: '0' })).toThrow(
      'TINKERPAD_MAX_GENERATION_ATTEMPTS',
    );
  });

  it('fails loudly on a fractional value, which Number would otherwise slip past', () => {
    expect(() => parseGenerationPolicy({ timeoutMs: '1.5', maxAttempts: undefined })).toThrow(
      'TINKERPAD_GENERATION_TIMEOUT_MS',
    );
  });
});

// parseMaxGenerationAttempts is the single-value seam a root with NO driver (the edge Worker) uses to
// validate the retry budget alone, without also validating a deadline it never consumes. It shares the
// same parse core as parseGenerationPolicy, so the two agree by construction. [LAW:one-source-of-truth]
describe('parseMaxGenerationAttempts', () => {
  it('takes the default when unset', () => {
    expect(parseMaxGenerationAttempts(undefined)).toBe(DEFAULT_GENERATION_POLICY.maxAttempts);
  });

  it('reads a valid explicit value', () => {
    expect(parseMaxGenerationAttempts('4')).toBe(4);
  });

  it('agrees with parseGenerationPolicy on the same input', () => {
    expect(parseMaxGenerationAttempts('3')).toBe(parseGenerationPolicy({ timeoutMs: undefined, maxAttempts: '3' }).maxAttempts);
  });

  it('fails loudly on an invalid value rather than silently defaulting', () => {
    expect(() => parseMaxGenerationAttempts('0')).toThrow('TINKERPAD_MAX_GENERATION_ATTEMPTS');
  });

  it('rejects a non-integer string, driving that path through this parser specifically', () => {
    expect(() => parseMaxGenerationAttempts('soon')).toThrow('TINKERPAD_MAX_GENERATION_ATTEMPTS');
  });

  it('rejects a fractional value', () => {
    expect(() => parseMaxGenerationAttempts('1.5')).toThrow('TINKERPAD_MAX_GENERATION_ATTEMPTS');
  });
});
