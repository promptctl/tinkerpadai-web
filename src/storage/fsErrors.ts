// The one place that decides "this fs error means the file is absent" — used by the
// file adapters to treat a missing file as a legitimate empty/initial state, while
// every OTHER error propagates loudly. Distinguishing the two is what keeps an absent
// catalog from masking a real IO failure. [LAW:no-silent-failure] [LAW:single-enforcer]
export const isNotFound = (err: unknown): boolean =>
  err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
