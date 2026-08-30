import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  importKnowledgeSeedManifest, KNOWLEDGE_SEED_LIMITS
} from '../src/knowledge-seed-import.mjs';
import { readKnowledge } from '../src/knowledge.mjs';
import { run, snapshot } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-knowledge-seed-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Seed Reviewer']);
  git(root, ['config', 'user.email', 'seed-reviewer@example.com']);
  const artifactRelative = 'singularity/work-items/SEED-1/artifacts/verification/report.md';
  const artifactPath = path.join(root, artifactRelative);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, '# Approved verification\n\nThe retry ceiling is three.\n');
  const artifact = await snapshot(artifactPath);
  await writeFile(path.join(root, 'singularity/work-items/SEED-1/workflow.json'), JSON.stringify({
    workItem: { id: 'SEED-1' },
    phases: {
      verification: {
        id: 'verification', status: 'approved', generation: 3,
        artifacts: [{ path: 'artifacts/verification/report.md', sha256: artifact.sha256, size: artifact.size }]
      }
    }
  }));
  await writeFile(path.join(root, 'README.md'), '# seed importer\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'approved source']);
  return {
    root,
    provenance: [{
      workId: 'SEED-1', artifact: 'artifacts/verification/report.md',
      sha256: artifact.sha256, approvedRevision: 3
    }]
  };
}

function entry(provenance, changes = {}) {
  return {
    type: 'constraint',
    text: 'Retry no more than three times.',
    provenance,
    scope: { repositories: ['seed-fixture'] },
    status: 'active',
    ...changes
  };
}

async function manifest(root, value, name = 'reviewed-seeds.json') {
  const detached = JSON.parse(JSON.stringify(value));
  await writeFile(path.join(root, name), name.endsWith('.json') ? JSON.stringify(detached) : YAML.stringify(detached));
  return name;
}

test('dry-run preflights all approved provenance, import is idempotent, and YAML is accepted', async () => {
  const { root, provenance } = await repository();
  const file = await manifest(root, {
    schemaVersion: 1,
    entries: [
      entry(provenance),
      entry(provenance, { type: 'insight', text: 'The verified retry ceiling is operationally sufficient.' })
    ]
  }, 'reviewed-seeds.yaml');

  const preview = await importKnowledgeSeedManifest(root, file, { dryRun: true });
  assert.equal(preview.validated, 2);
  assert.equal(preview.wouldCreate, 2);
  assert.equal((await readKnowledge(root)).length, 0, 'dry-run creates no records');

  const imported = await importKnowledgeSeedManifest(root, file);
  assert.equal(imported.created, 2);
  assert.equal((await readKnowledge(root)).length, 2);

  const repeated = await importKnowledgeSeedManifest(root, file);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.skipped, 2);
  assert.equal((await readKnowledge(root)).length, 2);
});

test('every entry and approved source is preflighted before the first record write', async () => {
  const { root, provenance } = await repository();
  const file = await manifest(root, {
    schemaVersion: 1,
    entries: [
      entry(provenance),
      entry([{ ...provenance[0], approvedRevision: 99 }], { text: 'This source was not approved.' })
    ]
  });

  await assert.rejects(() => importKnowledgeSeedManifest(root, file), /is not an approved artifact revision/);
  assert.equal((await readKnowledge(root)).length, 0, 'a late preflight failure leaves the store untouched');
});

test('schema, unknown keys, cardinality, text, and control-character bounds are strict', async () => {
  const { root, provenance } = await repository();
  const cases = [
    [{ schemaVersion: 1, entries: [entry(provenance)], extra: true }, /unknown key: extra/],
    [{ schemaVersion: 1, entries: [{ ...entry(provenance), extra: true }] }, /unknown key: extra/],
    [{ schemaVersion: 1, entries: [entry(provenance, { text: `x\u0000y` })] }, /control character/],
    [{ schemaVersion: 1, entries: [entry(provenance, { text: 'x'.repeat(KNOWLEDGE_SEED_LIMITS.textBytes + 1) })] }, /byte limit/],
    [{
      schemaVersion: 1,
      entries: [entry(provenance, {
        scope: { paths: Array.from({ length: KNOWLEDGE_SEED_LIMITS.scopeValuesPerEntry + 1 }, (_, index) => `src/${index}`) }
      })]
    }, /value limit/],
    [{
      schemaVersion: 1,
      entries: Array.from({ length: KNOWLEDGE_SEED_LIMITS.entries + 1 }, (_, index) => entry(provenance, { text: `claim ${index}` }))
    }, /entry limit/]
  ];
  for (const [value, expected] of cases) {
    const file = await manifest(root, value);
    await assert.rejects(() => importKnowledgeSeedManifest(root, file), expected);
  }
  assert.equal((await readKnowledge(root)).length, 0);
});

test('manifest reads reject traversal, symlinks, duplicate YAML keys, and aliases', async () => {
  const { root, provenance } = await repository();
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.yaml`);
  await writeFile(outside, YAML.stringify({ schemaVersion: 1, entries: [entry(provenance)] }));
  await assert.rejects(() => importKnowledgeSeedManifest(root, `../${path.basename(outside)}`), /outside the repository/);

  await symlink(outside, path.join(root, 'linked.yaml'));
  await assert.rejects(() => importKnowledgeSeedManifest(root, 'linked.yaml'), /cannot be a symbolic link/);

  await writeFile(path.join(root, 'duplicate.yaml'), 'schemaVersion: 1\nschemaVersion: 1\nentries: []\n');
  await assert.rejects(() => importKnowledgeSeedManifest(root, 'duplicate.yaml'), /Map keys must be unique/);

  await writeFile(path.join(root, 'yaml-disguised-as.json'), 'schemaVersion: 1\nentries: []\n');
  await assert.rejects(() => importKnowledgeSeedManifest(root, 'yaml-disguised-as.json'), /parsed as JSON/);

  await writeFile(path.join(root, 'alias.yaml'), [
    'schemaVersion: 1',
    'entries:',
    `  - &claim ${YAML.stringify(entry(provenance)).trim().replaceAll('\n', '\n    ')}`,
    '  - *claim',
    ''
  ].join('\n'));
  await assert.rejects(() => importKnowledgeSeedManifest(root, 'alias.yaml'), /Alias resolution is disabled/);
});

test('the CLI creates one knowledge commit for all new records and none on re-import', async () => {
  const { root, provenance } = await repository();
  await manifest(root, {
    schemaVersion: 1,
    entries: [
      entry(provenance),
      entry(provenance, { type: 'decision', text: 'Use the approved three-attempt retry policy.' })
    ]
  });
  git(root, ['add', 'reviewed-seeds.json']);
  git(root, ['commit', '-m', 'reviewed manifest']);
  const before = Number(git(root, ['rev-list', '--count', 'HEAD']));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Seed Reviewer'
  };

  const first = spawnSync(process.execPath, [cli, 'knowledge', 'import', 'reviewed-seeds.json', '--json'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.created, 2);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD'])), before + 1);
  assert.equal(git(root, ['show', '--format=', '--name-only', 'HEAD']).split('\n').filter(Boolean).length, 2);

  const second = spawnSync(process.execPath, [cli, 'knowledge', 'import', 'reviewed-seeds.json'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Imported 0 entries/);
  assert.equal(Number(git(root, ['rev-list', '--count', 'HEAD'])), before + 1, 'the no-op import creates no commit');
});
