import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evidenceProvenance } from '../src/evidence/provenance.mjs';
import { run } from '../src/util.mjs';

test('matrix provenance distinguishes approval metadata, later source commits and uncommitted drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-matrix-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Evidence');
  git('config', 'user.email', 'evidence@example.test');
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'published candidate');
  const candidate = git('rev-parse', 'HEAD');
  const workflow = { phaseOrder: ['code'], phases: {
    code: { generation: 1, generationCommit: candidate, generationPolicy: { task: 'code' } }
  } };
  assert.deepEqual(evidenceProvenance(root, workflow, candidate).warnings, []);
  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity/approval.json'), '{}\n');
  git('add', '.');
  git('commit', '-qm', 'approval metadata');
  assert.deepEqual(evidenceProvenance(root, workflow, git('rev-parse', 'HEAD')).warnings, [],
    'later approval metadata alone does not imply changed application code');
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'later application change');
  const changed = evidenceProvenance(root, workflow, git('rev-parse', 'HEAD'));
  assert.equal(changed.worktree, 'clean');
  assert.match(changed.warnings.join(' '), /changed application path.*not covered/);
  assert.equal(changed.candidates[0].commit, candidate);
  assert.match(evidenceProvenance(root, workflow, candidate).warnings.join(' '), /HEAD moved/);
  await writeFile(path.join(root, 'source.mjs'), 'export const value = 3;\n');
  assert.match(evidenceProvenance(root, workflow, git('rev-parse', 'HEAD')).warnings.join(' '), /Uncommitted changes/);
});
