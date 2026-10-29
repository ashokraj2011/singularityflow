/**
 * SDA M0 inventory (docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md §15 Stage 0): every module that
 * starts Git or writes files has a storage class, so a new persistence path is classified when it is
 * written, and the scanner reads Git verbs, writes, YAML reads and lifetimes the way the inventory says.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { baseline, scanSource, summarize } from '../scripts/sda-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLASSES = ['shared-state', 'source-control', 'local-authored', 'local-operational', 'artifact', 'projection', 'installation', 'surface'];

test('every module that starts Git or writes files has an SDA storage class', async () => {
  const modules = await scanSource(root);
  const summary = summarize(modules);
  assert.deepEqual(summary.unclassified, [], 'Add a rule or an override with its reason in scripts/sda-inventory.mjs');
  for (const entry of modules.filter((item) => item.git.length || item.writes)) assert.ok(CLASSES.includes(entry.class), entry.module);
  // The modules SDA names keep the role it describes.
  const classOf = (name) => modules.find((entry) => entry.module === name)?.class;
  assert.equal(classOf('ledger.mjs'), 'shared-state');
  assert.equal(classOf('publication-journal.mjs'), 'local-authored');
  assert.equal(classOf('transport-intents.mjs'), 'local-authored');
  assert.equal(classOf('sgos/operational-store.mjs'), 'local-authored');
  assert.equal(classOf('story-index.mjs'), 'projection');
  assert.equal(classOf('git-execution.mjs'), 'source-control');
  assert.ok(summary.gitSites.remote > 0 && summary.directLocalGitSitesOutsideGitModules > summary.gitSites.remote);
});

test('the scanner reads Git verbs past options, mixed verbs by their argument, writes, YAML reads and lifetimes', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-inventory-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'src/commands'), { recursive: true });
  await writeFile(path.join(fixture, 'src/ledger-probe.mjs'), [
    "import YAML from 'yaml';",
    "run('git', ['-c', 'protocol.version=2', 'fetch', 'origin']);",
    "git(['rev-parse', 'HEAD']);",
    "git(['branch', '--show-current']);",
    "git(['branch', '-D', name]);",
    "git(['update-ref', ref, next, previous]);",
    "git(args);",
    "runRemoteGit(['push', 'origin', ref]);",
    "executeGitQuery(root, 'repository.tracked-paths');",
    "writeAtomic(file, text);",
    "YAML.parse(text);",
    'const CACHE_TTL_MS = 15 * 60_000;',
    'const OPERATION_TIMEOUT_MS = 30_000;',
    'const RECORD_MAX_BYTES = 1_048_576;',
    ''
  ].join('\n'));
  await writeFile(path.join(fixture, 'src/commands/probe.mjs'), "writeFile(target, 'x');\n");
  await writeFile(path.join(fixture, 'src/mystery-module.mjs'), "spawnSync('git', ['status']);\n");
  const modules = await scanSource(fixture);
  const ledger = modules.find((entry) => entry.module === 'ledger-probe.mjs');
  assert.deepEqual(ledger.git.map((site) => [site.form, site.verb, site.kind]), [
    ['direct', 'fetch', 'remote'], ['wrapper', 'rev-parse', 'read'], ['wrapper', 'branch', 'read'], ['wrapper', 'branch', 'write'],
    ['wrapper', 'update-ref', 'write'], ['remote-boundary', 'push', 'remote'], ['named-read', 'repository.tracked-paths', 'read']
  ]);
  assert.equal(ledger.class, 'shared-state');
  assert.equal(ledger.writes, 1);
  assert.equal(ledger.yamlReads, 1);
  assert.deepEqual(ledger.lifetimes.map((item) => [item.name, item.value, item.kind]),
    [['CACHE_TTL_MS', 900_000, 'lifetime'], ['OPERATION_TIMEOUT_MS', 30_000, 'timeout']]);
  assert.equal(modules.find((entry) => entry.module === 'commands/probe.mjs').class, 'surface');
  // A persistence path that matches no rule is reported, never silently given a class.
  assert.deepEqual(summarize(modules).unclassified, ['mystery-module.mjs']);
  // The committed form has counts and no line numbers.
  const committed = baseline(modules).modules.find((entry) => entry.module === 'ledger-probe.mjs');
  assert.deepEqual(committed.git, { read: 3, write: 2, remote: 2 });
  assert.equal(JSON.stringify(committed).includes('"line"'), false);
});
