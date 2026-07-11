import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactObjectKey, hydrateStoredDoc } from '../src/storage/index.js';
import { isNotFound } from '../src/storage/fsErrors.js';
import type { CatalogDoc, VersionId } from '../src/storage/index.js';

// THE COMMONS MIGRATION — carries the locally-seeded commons into the edge stores (R2 + D1) at
// launch. The seeded playgrounds live only in the local dev data dir (.tinkerpad-data/); production
// starts EMPTY and the first edge deploy runs generation DISABLED (no provider), so the briefs
// cannot be re-driven at the edge. The only path to a populated production commons is to MIGRATE the
// local data, and this is the one tool that does it.
//
// It is faithful BY CONSTRUCTION rather than by a bespoke transform: the local and edge backends
// share the storage SEAM (src/storage), so the on-disk representation and the edge representation are
// the same document. The catalog is one JSON document (makeD1Catalog stores it as row id=1); every
// artifact is one immutable html object keyed `<versionId>.html` (makeR2ArtifactStore). This tool
// only moves those exact bytes to those exact keys — no reinterpretation that could drift from the
// adapters. Fidelity is then VERIFIED end-to-end by reading a migrated playground back through the
// real edge adapters under `wrangler dev` (see design-docs/deploy-cloudflare.md). [LAW:one-source-of-truth]
// [LAW:single-enforcer] [LAW:verifiable-goals]

export interface ArtifactRef {
  readonly versionId: VersionId;
  // The R2 object key AND the local file basename — both derived from artifactObjectKey, the single
  // owner of the `<versionId>.html` convention in the storage seam, so this cannot drift from what the
  // edge R2 adapter reads. [LAW:one-source-of-truth]
  readonly key: string;
}

// The exact edge writes the local commons implies: one catalog document and the distinct set of
// artifact versions the catalog references. A pure value — no fs, no wrangler, no process — so the
// transform is unit-testable in isolation and the effects live only in the executor. [LAW:effects-at-boundaries]
export interface CommonsMigrationPlan {
  // Compact JSON, byte-for-byte what makeD1Catalog.write(doc) would store in the `doc` column: the
  // hydrated document re-serialized with JSON.stringify (no indentation), so a fresh edge read
  // hydrate(parse(...)) yields the same catalog the local file yields. [LAW:one-source-of-truth]
  readonly catalogDoc: string;
  // Distinct versions referenced by any turn, in first-seen order. Only referenced versions are
  // migrated — an on-disk file no turn points at is dead and would never be read back.
  readonly artifacts: readonly ArtifactRef[];
  readonly playgroundCount: number;
}

// Pure transform: local catalog JSON → the exact edge writes. hydrateStoredDoc applies the same
// forward-compatible shape upgrade the edge read applies, so the re-serialized doc is canonical.
export const planCommonsMigration = (catalogJson: string): CommonsMigrationPlan => {
  const doc: CatalogDoc = hydrateStoredDoc(JSON.parse(catalogJson));
  const seen = new Set<string>();
  const artifacts: ArtifactRef[] = [];
  for (const playground of doc.playgrounds) {
    for (const turn of playground.session.turns) {
      const versionId = turn.version;
      if (seen.has(versionId)) continue;
      seen.add(versionId);
      artifacts.push({ versionId, key: artifactObjectKey(versionId) });
    }
  }
  return { catalogDoc: JSON.stringify(doc), artifacts, playgroundCount: doc.playgrounds.length };
};

// A SQLite single-quoted string literal. Standard SQLite escapes ONLY the quote (doubled); backslashes
// and newlines are literal inside the literal, so this is the complete escaping for a --file statement.
// A NUL byte cannot survive the CLI's C-string argv/stdin, so its presence is a real corruption that
// must fail loudly rather than silently truncate the catalog. [LAW:no-silent-failure]
export const sqlStringLiteral = (value: string): string => {
  if (value.includes('\0')) throw new Error('catalog document contains a NUL byte; refusing to build corrupt SQL');
  return `'${value.replace(/'/g, "''")}'`;
};

// The one INSERT that writes the whole catalog document as the single row id=1, upserting so a re-run
// replaces rather than duplicates — the migration is idempotent and safe to re-run to convergence.
export const buildCatalogSql = (catalogDoc: string): string =>
  `INSERT INTO catalog (id, doc) VALUES (1, ${sqlStringLiteral(catalogDoc)}) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc;`;

// WHERE the writes land — one axis with three values, not three code paths. 'dry-run' computes the
// plan and touches nothing (the safe DEFAULT); 'local' writes to the miniflare persistence
// `wrangler dev` reads (account-free verification); 'remote' writes to the real Cloudflare account
// (the launch step). The value selects the wrangler flag; the plan is identical for all three.
// [LAW:dataflow-not-control-flow] [LAW:no-mode-explosion]
export type MigrationSink = 'dry-run' | 'local' | 'remote';

export interface MigrationConfig {
  readonly sink: MigrationSink;
  readonly dataDir: string;
  readonly d1Database: string;
  readonly r2Bucket: string;
}

export class UsageError extends Error {}

// The sink a flag names, or undefined if the flag is not a sink flag. A total function over strings
// keeps the type honest — `a in record` cannot narrow `a` to a key — so the mapped result carries its
// own optionality and no index access can be undefined-by-surprise. [LAW:types-are-the-program]
const sinkOf = (flag: string): MigrationSink | undefined =>
  flag === '--dry-run' ? 'dry-run' : flag === '--local' ? 'local' : flag === '--remote' ? 'remote' : undefined;

// Parse argv into config. The sink flags are mutually exclusive; absent means the safe 'dry-run'
// default. Unknown flags are rejected loudly rather than ignored (a typo'd --remotte must not
// silently degrade to a no-op dry run right when the operator meant to publish). [LAW:no-silent-failure]
export const resolveConfig = (argv: readonly string[], env: NodeJS.ProcessEnv): MigrationConfig => {
  const args = argv.slice(2);
  const sinks = args.map(sinkOf).filter((s): s is MigrationSink => s !== undefined);
  if (sinks.length > 1) throw new UsageError(`choose at most one of --dry-run/--local/--remote, got: ${args.filter((a) => sinkOf(a) !== undefined).join(' ')}`);
  // Reject BOTH unknown --flags and bare positional args: the tool takes only sink flags, so anything
  // else is a mistake (e.g. `migrate remote` instead of `--remote`) that must not silently degrade to
  // a no-op dry run. [LAW:no-silent-failure]
  const unexpected = args.filter((a) => sinkOf(a) === undefined);
  if (unexpected.length > 0) throw new UsageError(`unexpected argument(s): ${unexpected.join(' ')} — accepts only --dry-run/--local/--remote`);
  const [only] = sinks;
  return {
    // Absence (no sink flag) is genuine optionality, defaulted here — not a guard placating the type.
    sink: only ?? 'dry-run',
    dataDir: env.TINKERPAD_DATA_DIR ?? '.tinkerpad-data',
    d1Database: env.TINKERPAD_D1_DATABASE ?? 'tinkerpad',
    r2Bucket: env.TINKERPAD_R2_BUCKET ?? 'tinkerpad-artifacts',
  };
};

// The seam by which the executor reaches the outside world: run a command to completion. Injecting it
// (rather than calling spawn inline) lets a test assert the EXACT wrangler commands the migration
// issues without spawning anything, and keeps the write path's command contract pinned. [LAW:effects-at-boundaries]
export type CommandRunner = (command: string, args: readonly string[]) => Promise<void>;

// The real runner: spawn the command, inheriting stderr so wrangler's own diagnostics reach the
// operator. A non-zero exit is a real failure that aborts the whole migration — never swallowed. [LAW:no-silent-failure]
export const spawnRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
  });

// Absence is false; any OTHER access failure (EACCES, ELOOP, …) is a real IO fault that surfaces as
// itself rather than being misreported as "missing". isNotFound is the single owner of "this fs error
// means absent", shared with the file adapters. [LAW:no-silent-failure] [LAW:single-enforcer]
const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
};

// The wrangler flag that selects the persistence target. 'local' and 'remote' are real writes; there
// is no wrangler flag for 'dry-run' because the executor never calls wrangler in that mode.
const wranglerTargetFlag = (sink: 'local' | 'remote'): string => (sink === 'local' ? '--local' : '--remote');

// THE EFFECT BOUNDARY: given the pure plan and a config, perform the writes. The catalog goes first as
// one D1 upsert; then every referenced artifact is put to R2. Before any write, every referenced
// artifact file must exist on disk — a missing file is a real gap that aborts the migration rather
// than shipping a catalog whose /play would 404. [LAW:no-silent-failure]
export const runMigration = async (
  plan: CommonsMigrationPlan,
  config: MigrationConfig,
  log: (line: string) => void,
  run: CommandRunner = spawnRunner,
): Promise<void> => {
  const missing: string[] = [];
  for (const artifact of plan.artifacts) {
    if (!(await fileExists(join(config.dataDir, 'artifacts', artifact.key)))) missing.push(artifact.key);
  }
  if (missing.length > 0) {
    throw new Error(`${missing.length} referenced artifact file(s) missing under ${config.dataDir}/artifacts: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  }

  log(`plan: ${plan.playgroundCount} playgrounds, ${plan.artifacts.length} artifact versions → D1 ${config.d1Database} + R2 ${config.r2Bucket}`);

  if (config.sink === 'dry-run') {
    log('dry-run: no writes performed. Re-run with --local (miniflare) or --remote (Cloudflare account).');
    return;
  }

  const flag = wranglerTargetFlag(config.sink);

  // Artifacts FIRST, catalog LAST. The catalog is the index of what exists; publishing it only after
  // every artifact it references is in R2 means a partial failure leaves the catalog untouched (danglers
  // impossible) rather than pointing /play at objects not yet uploaded. On a re-run the artifact puts
  // are idempotent overwrites and the catalog upsert converges. [LAW:no-silent-failure]
  let done = 0;
  for (const artifact of plan.artifacts) {
    // --force skips r2 object put's data-catalog validation prompt: spawnRunner ignores stdin, so a
    // prompt would EOF-fail mid-upload. Non-interactive, matching the D1 command's --yes. [LAW:no-silent-failure]
    await run('wrangler', ['r2', 'object', 'put', `${config.r2Bucket}/${artifact.key}`, '--file', join(config.dataDir, 'artifacts', artifact.key), flag, '--force']);
    done += 1;
    if (done % 20 === 0 || done === plan.artifacts.length) log(`  uploaded ${done}/${plan.artifacts.length} artifacts`);
  }

  // The SQL file is scratch — written, handed to wrangler, then removed on both success and failure so
  // repeated runs don't accumulate temp dirs (the tool is idempotent and meant to be re-run). [LAW:no-silent-failure]
  const sqlDir = await mkdtemp(join(tmpdir(), 'tinkerpad-migrate-'));
  try {
    const sqlPath = join(sqlDir, 'catalog.sql');
    await writeFile(sqlPath, buildCatalogSql(plan.catalogDoc), 'utf8');
    log(`publishing catalog document → D1 ${config.d1Database} (${flag})`);
    await run('wrangler', ['d1', 'execute', config.d1Database, '--file', sqlPath, flag, '--yes']);
  } finally {
    await rm(sqlDir, { recursive: true, force: true });
  }
  log(`done: ${plan.artifacts.length} artifacts + catalog written to ${config.sink}.`);
};
