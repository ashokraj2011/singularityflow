import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// A commit during review that changes nothing the review saw made the submission stale anyway: a
// document offered only to later steps, or a child-branch link (unhappy paths S8, 2026-10-28).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { fail = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Reviewer',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
// No detached automatic maintenance: it would still be writing objects/pack when the test removes
// the directory (Git 2.54, test/git-automatic-maintenance.test.mjs).
const git = (root, ...args) => run('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], root).stdout.trim();

/** A Story whose first step is submitted and awaits approval. */
async function submitted(t, id) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-safe-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  for (const [key, value] of [['user.name', 'Reviewer'], ['user.email', 'reviewer@example.com']]) git(root, 'config', key, value);
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# review-safe commits\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, 'push', '-u', 'origin', 'main');
  flow(root, ['start', id, '--from-branch', 'main']);
  const item = path.join(root, `singularity/work-items/${id}`);
  const artifact = path.join(item, 'artifacts/intake/intake.md');
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'Review this intake as submitted.'));
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit', 'intake']);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.intake.status, 'awaiting_approval');
  return { base, root, item, later: workflow.phaseOrder[1] };
}

test('a document offered only to later steps leaves the submission reviewable; one offered to it does not', async (t) => {
  const { base, root, item, later } = await submitted(t, 'DOCS-1');
  const notes = path.join(base, 'notes.md');
  await writeFile(notes, '# Notes for the next step\n');
  flow(root, ['documents', 'upload', notes, '--name', 'Later notes', '--phases', later]);
  flow(root, ['approve', 'intake', '--yes']);
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.intake.status, 'approved');

  const second = await submitted(t, 'DOCS-2');
  const offered = path.join(second.base, 'offered.md');
  await writeFile(offered, '# Notes for this step\n');
  flow(second.root, ['documents', 'upload', offered, '--name', 'Intake notes', '--phases', 'intake', '--confirm-override', 'continue:phaseStatus']);
  // Offered to the step under review, the upload is the soft gate's call: overriding it withdraws the submission.
  assert.equal(JSON.parse(await readFile(path.join(second.item, 'workflow.json'), 'utf8')).phases.intake.status, 'in_progress');
  const refused = flow(second.root, ['approve', 'intake', '--yes'], { fail: true });
  assert.notEqual(refused.status, 0, 'a document offered to the step under review needs a fresh submission');
});

test('a child-branch link made during review is its exact record change, and nothing more passes', async (t) => {
  const { root } = await submitted(t, 'LINK-1');
  git(root, 'switch', '-q', '-c', 'LINK-1-child');
  flow(root, ['story', 'branch', 'attach', '--parent', 'LINK-1']);
  const link = git(root, 'rev-parse', 'HEAD');
  const { loadDefinition } = await import('../src/config.mjs');
  const { loadWorkflow } = await import('../src/state.mjs');
  const { reviewSafeBranchLinks, reviewSafeDocumentAdditions } = await import('../src/approval-check.mjs');
  const config = await loadDefinition(root);
  const workflow = await loadWorkflow(root, config, 'LINK-1');
  assert.deepEqual(await reviewSafeBranchLinks(root, config, workflow, [link]), [link]);
  assert.deepEqual(await reviewSafeDocumentAdditions(root, config, workflow, workflow.phases.intake, [link]), [],
    'a link is not a document addition');
  // The same commit with one more file is not the link's exact change.
  await writeFile(path.join(root, 'EXTRA.md'), 'not part of a link\n');
  git(root, 'add', 'EXTRA.md');
  git(root, 'commit', '-q', '--amend', '--no-edit');
  assert.deepEqual(await reviewSafeBranchLinks(root, config, workflow, [git(root, 'rev-parse', 'HEAD')]), []);
});
