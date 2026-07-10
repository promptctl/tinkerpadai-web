import { makeGenerationQuota } from '../generationQuota.js';
import type { GenerationQuota } from '../generationQuota.js';

// A generous, real-clock quota for tests whose subject is NOT rate limiting: the caps are set high
// enough that no incidental generation trips them, so these tests exercise their real concern
// (generation orchestration, sessions, routing) without threading a limit. Tests OF the quota build
// their own with tight caps and a controllable clock (generationQuota.test.ts).
export const makeTestQuota = (): GenerationQuota =>
  makeGenerationQuota({ limits: { maxConcurrent: 1000, maxDaily: 1000 }, now: () => Date.now() });
