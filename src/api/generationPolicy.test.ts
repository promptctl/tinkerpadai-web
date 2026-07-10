import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATION_POLICY, parseGenerationPolicy } from './generationPolicy.js';

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
