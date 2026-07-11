import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planCommonsMigration, resolveConfig, runMigration, UsageError } from './migrate-commons.js';

// THE MIGRATION ENTRY POINT — the one effect boundary of the commons migration. It reads argv/env,
// loads the local catalog, runs the pure plan through the executor, and translates the outcome into a
// process exit code. All logic lives in migrate-commons.ts; this shell composes it. [LAW:effects-at-boundaries]
//
// Exit codes are the contract: 2 = the invocation itself was wrong (bad flags), 1 = the migration ran
// but a write or a precondition failed, 0 = the commons was written. [LAW:no-silent-failure]
const main = async (): Promise<void> => {
  const config = resolveConfig(process.argv, process.env);
  const catalogJson = await readFile(join(config.dataDir, 'catalog.json'), 'utf8');
  const plan = planCommonsMigration(catalogJson);
  await runMigration(plan, config, (line) => console.log(line));
};

// Set process.exitCode rather than process.exit() so block-buffered stdout flushes before exit,
// preserving the migration summary this script exists to print. [LAW:no-silent-failure]
main().catch((error: unknown) => {
  const failure =
    error instanceof UsageError
      ? { message: error.message, code: 2 }
      : { message: `commons migration failed: ${String(error instanceof Error ? (error.stack ?? error.message) : error)}`, code: 1 };
  console.error(failure.message);
  process.exitCode = failure.code;
});
