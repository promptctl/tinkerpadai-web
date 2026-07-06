import { readManifest, resolveConfig, runSeed, UsageError } from './seed-wave.js';

// THE SEEDING ENTRY POINT — the one effect boundary of the seeding driver. It reads
// argv/env, runs the wave through the importable core, and translates the outcome into
// a process exit code. All logic lives in seed-wave.ts, which this shell composes; the
// core never reads a process global, so it stays testable without one.
// [LAW:effects-at-boundaries] [LAW:locality-or-seam]
//
// Exit codes are the contract: 2 = the invocation itself was wrong (bad args/env),
// 1 = the wave ran but at least one brief failed, or a mid-run fault; 0 = every brief
// became a playground. [LAW:no-silent-failure]

// Set process.exitCode and return rather than calling process.exit(): process.exit()
// force-exits and can truncate block-buffered stdout (a piped or CI log), losing the wave
// summary this script exists to print. Letting the process exit naturally on an empty
// event loop flushes stdout first. [LAW:no-silent-failure]
const main = async (): Promise<void> => {
  const config = resolveConfig(process.argv, process.env);
  process.exitCode = await runSeed(config, process.env, readManifest);
};

// The failure's exit code is a VALUE derived from its type, applied once — no fallthrough
// to reason about. A bad invocation (UsageError) is exit 2 with just its usage message;
// any other fault is exit 1 with the surfaced error. Same natural-exit discipline: set the
// code, do not force-exit. [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
main().catch((error: unknown) => {
  const failure =
    error instanceof UsageError
      ? { message: error.message, code: 2 }
      : { message: `seed wave failed: ${String(error instanceof Error ? error.stack ?? error.message : error)}`, code: 1 };
  console.error(failure.message);
  process.exitCode = failure.code;
});
