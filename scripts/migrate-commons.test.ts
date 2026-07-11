import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { hydrateStoredDoc } from '../src/storage/index.js';
import type { CommandRunner, CommonsMigrationPlan, MigrationConfig } from './migrate-commons.js';
import { buildCatalogSql, planCommonsMigration, resolveConfig, runMigration, sqlStringLiteral, UsageError } from './migrate-commons.js';

// A minimal catalog document in the on-disk shape. Two playgrounds; the second reuses a version the
// first already referenced, so dedup and referenced-only selection are both exercised.
const sharedVersion = '11111111-1111-1111-1111-111111111111';
const catalog = {
  playgrounds: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      session: {
        sessionId: 'session-a',
        providerId: 'claude-code-tmux',
        lineage: null,
        author: "d'ev:local",
        turns: [
          { turnId: 'turn-a1', prompt: "it's a counter", version: sharedVersion },
          { turnId: 'turn-a2', prompt: 'add reset', version: '22222222-2222-4222-2222-222222222222' },
        ],
        tags: [],
      },
      listing: 'listed',
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      session: {
        sessionId: 'session-b',
        providerId: 'claude-code-tmux',
        lineage: null,
        author: 'someone',
        turns: [{ turnId: 'turn-b1', prompt: 'reuse', version: sharedVersion }],
        tags: [],
      },
      listing: 'unlisted',
    },
  ],
};

describe('planCommonsMigration', () => {
  it('selects distinct referenced versions in first-seen order, keyed <versionId>.html', () => {
    const plan = planCommonsMigration(JSON.stringify(catalog));
    expect(plan.playgroundCount).toBe(2);
    expect(plan.artifacts.map((a) => a.versionId)).toEqual([sharedVersion, '22222222-2222-4222-2222-222222222222']);
    expect(plan.artifacts.every((a) => a.key === `${a.versionId}.html`)).toBe(true);
  });

  it('migrates unlisted playgrounds too — existence is monotonic, visibility is a separate filter', () => {
    const plan = planCommonsMigration(JSON.stringify(catalog));
    // Both playgrounds' versions are present even though one is unlisted.
    expect(plan.artifacts).toHaveLength(2);
  });

  it('produces the catalog document the way the D1 adapter stores it: compact and faithful', () => {
    const raw = JSON.stringify(catalog);
    const plan = planCommonsMigration(raw);
    // Compact, not pretty-printed — the D1 adapter serializes without indentation, unlike the file
    // backend. JSON escapes any in-value newline as \n, so a literal newline means indentation leaked in.
    expect(plan.catalogDoc).not.toContain('\n');
    // Faithful: a fresh edge read hydrate(parse(...)) recovers the same document the source describes.
    expect(hydrateStoredDoc(JSON.parse(plan.catalogDoc))).toEqual(hydrateStoredDoc(JSON.parse(raw)));
  });
});

describe('sqlStringLiteral', () => {
  it('doubles single quotes and wraps in quotes', () => {
    expect(sqlStringLiteral("it's a {\"json\": true}")).toBe("'it''s a {\"json\": true}'");
  });

  it('refuses a NUL byte rather than emitting a truncated literal', () => {
    expect(() => sqlStringLiteral('bad\0doc')).toThrow(/NUL/);
  });
});

describe('buildCatalogSql', () => {
  it('is a single-row upsert so a re-run replaces rather than duplicates', () => {
    const sql = buildCatalogSql('{"playgrounds":[]}');
    expect(sql).toBe(`INSERT INTO catalog (id, doc) VALUES (1, '{"playgrounds":[]}') ON CONFLICT(id) DO UPDATE SET doc = excluded.doc;`);
  });
});

describe('runMigration (executor guards)', () => {
  const planFor = (versionId: string): CommonsMigrationPlan => ({
    catalogDoc: '{"playgrounds":[]}',
    artifacts: [{ versionId: versionId as CommonsMigrationPlan['artifacts'][number]['versionId'], key: `${versionId}.html` }],
    playgroundCount: 1,
  });
  const configFor = (dataDir: string, sink: MigrationConfig['sink']): MigrationConfig => ({
    sink,
    dataDir,
    d1Database: 'tinkerpad',
    r2Bucket: 'tinkerpad-artifacts',
  });

  // Track every temp data dir this suite creates and remove them after each test — no /tmp accumulation.
  const tempDirs: string[] = [];
  const tempDataDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-test-'));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('dry-run performs no writes and returns after the plan (never invokes wrangler)', async () => {
    const version = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, 'artifacts'), { recursive: true });
    await writeFile(join(dataDir, 'artifacts', `${version}.html`), '<!doctype html>', 'utf8');
    const lines: string[] = [];
    // Would throw if it tried to spawn a real wrangler with a nonexistent DB; dry-run must not spawn.
    await expect(runMigration(planFor(version), configFor(dataDir, 'dry-run'), (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('dry-run'))).toBe(true);
  });

  it('aborts loudly when a referenced artifact file is missing — before any wrangler write', async () => {
    const version = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const dataDir = await tempDataDir();
    // No artifacts dir at all: the referenced file is missing, so the precondition must fail — with
    // sink 'local' this proves it aborts BEFORE any wrangler write rather than shipping a catalog
    // whose /play would 404.
    await expect(runMigration(planFor(version), configFor(dataDir, 'local'), () => {})).rejects.toThrow(/missing/);
  });

  it('issues the exact wrangler commands: every R2 put FIRST, then the D1 catalog upsert LAST, with the target flag', async () => {
    const version = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
    const dataDir = await tempDataDir();
    const artifactPath = join(dataDir, 'artifacts', `${version}.html`);
    await mkdir(join(dataDir, 'artifacts'), { recursive: true });
    await writeFile(artifactPath, '<!doctype html>', 'utf8');
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const record: CommandRunner = async (command, args) => {
      calls.push({ command, args });
    };

    await runMigration(planFor(version), configFor(dataDir, 'remote'), () => {}, record);

    expect(calls).toHaveLength(2);
    const [r2, db] = calls;
    if (r2 === undefined || db === undefined) throw new Error('expected exactly two wrangler calls');
    // Artifacts first: one R2 put keyed bucket/<versionId>.html from the local file, non-interactive.
    expect(r2.command).toBe('wrangler');
    expect(r2.args).toEqual(['r2', 'object', 'put', `tinkerpad-artifacts/${version}.html`, '--file', artifactPath, '--remote', '--force']);
    // Catalog last: the whole catalog as one D1 upsert, same flag, non-interactive --yes.
    expect(db.args.slice(0, 3)).toEqual(['d1', 'execute', 'tinkerpad']);
    expect(db.args).toContain('--remote');
    expect(db.args).toContain('--yes');
    expect(db.args[3]).toBe('--file');
  });

  it('selects --local for the local sink', async () => {
    const version = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, 'artifacts'), { recursive: true });
    await writeFile(join(dataDir, 'artifacts', `${version}.html`), '<!doctype html>', 'utf8');
    const flags = new Set<string>();
    const record: CommandRunner = async (_command, args) => {
      for (const f of ['--local', '--remote']) if (args.includes(f)) flags.add(f);
    };
    await runMigration(planFor(version), configFor(dataDir, 'local'), () => {}, record);
    expect([...flags]).toEqual(['--local']);
  });
});

describe('resolveConfig', () => {
  const argv = (...flags: string[]): string[] => ['node', 'migrate.ts', ...flags];

  it('defaults to the safe dry-run sink with no flags', () => {
    expect(resolveConfig(argv(), {}).sink).toBe('dry-run');
  });

  it('reads the explicit sink flags', () => {
    expect(resolveConfig(argv('--local'), {}).sink).toBe('local');
    expect(resolveConfig(argv('--remote'), {}).sink).toBe('remote');
  });

  it('rejects two sinks rather than silently picking one', () => {
    expect(() => resolveConfig(argv('--local', '--remote'), {})).toThrow(UsageError);
  });

  it('rejects an unknown flag rather than degrading to dry-run', () => {
    expect(() => resolveConfig(argv('--remotte'), {})).toThrow(UsageError);
  });

  it('rejects a bare positional arg (e.g. `migrate remote`) rather than silently dry-running', () => {
    expect(() => resolveConfig(argv('remote'), {})).toThrow(UsageError);
  });

  it('takes store names and data dir from the environment', () => {
    const config = resolveConfig(argv('--remote'), {
      TINKERPAD_DATA_DIR: '/data',
      TINKERPAD_D1_DATABASE: 'prod-db',
      TINKERPAD_R2_BUCKET: 'prod-bucket',
    });
    expect(config).toMatchObject({ dataDir: '/data', d1Database: 'prod-db', r2Bucket: 'prod-bucket' });
  });
});
