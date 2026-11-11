/**
 * Show-stoppers from the unhappy-path audit (2026-10-28): Stories no route could finish.
 *
 * A workflow with no code step under `spec.mode: enforce` asked every clause for a planned test it
 * could never have, so its final check always refused. A Story branch rebased onto a moved main and
 * force-pushed lost the commits SFlow recorded, and approval listed every rewritten commit as new
 * with nothing naming the cause.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false, selection = { workType: 'chore', agent: 'developer' } } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Evidence Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify(selection) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
const git = (cwd, ...args) => execute('git', args, cwd).stdout.trim();

async function repository(t, configure = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-show-stoppers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Evidence Tester');
  git(root, 'config', 'user.email', 'evidence.tester@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalSecurity = { profile: 'poc' };
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configure(config);
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

async function complete(root, workId, phaseId) {
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  const file = path.join(root, 'singularity/work-items', workId, workflow.phases[phaseId].requiredArtifact.path);
  const text = (await readFile(file, 'utf8'))
    .replace(/^\| `([^`]+:AC-\d{3})` \|.*$/gmu, '| `$1` | The ledger outcome holds | `README.md` | Checked by inspection in verification | matched | none |')
    .replace(/^TODO: Map each qualified acceptance[^\n]*$/mu, `${workId}:AC-001 holds: README.md was inspected. Not applicable: a documentation outcome carries no test tags.`)
    .replace(/TODO:[^\n]*/g, 'Checked the ledger outcome with complete operational detail and exact references.')
    .replace(/\bTODO\b/g, 'checked');
  await writeFile(file, text);
}

async function stepThrough(root, workId, phaseId) {
  if (phaseId !== 'intake') flow(root, ['prepare', phaseId]);
  await complete(root, workId, phaseId);
  flow(root, ['phase', 'publish', phaseId]);
  flow(root, ['submit']);
  return flow(root, ['approve', '--yes'], { allowFailure: true });
}

test('a workflow with no code step ends under enforced specifications; its clauses are not owed planned tests', slowLane({ timeout: 600_000 }), async (t) => {
  const root = await repository(t, (config) => { config.workTypes.chore.spec = { mode: 'enforce' }; });
  const workId = 'NC-1';
  flow(root, ['start', workId, '--from-branch', 'main', '--title', 'Tidy the ledger', '--description', 'Maintenance only.']);
  for (const phaseId of ['intake', 'implementation', 'verification']) {
    const approved = await stepThrough(root, workId, phaseId);
    assert.equal(approved.status, 0, `${phaseId}\n${approved.stdout}\n${approved.stderr}`);
  }
  const last = await stepThrough(root, workId, 'conformance');
  assert.doesNotMatch(last.stdout + last.stderr, /has no planned test/u);
  assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  assert.equal(workflow.status, 'closed');
});

test('a Story branch rebased and force-pushed during review is named as rewritten, and the named route restores it', slowLane({ timeout: 600_000 }), async (t) => {
  const root = await repository(t);
  const workId = 'S1-1';
  flow(root, ['start', workId, '--from-branch', 'main', '--title', 'Tidy the ledger', '--description', 'Maintenance only.']);
  await complete(root, workId, 'intake');
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit']);
  const recordedTip = git(root, 'rev-parse', 'HEAD');
  // main moves on, and the Story branch is rebased onto it and force-pushed.
  git(root, 'switch', '-q', 'main');
  await writeFile(path.join(root, 'NOTES.md'), 'main moved on\n');
  git(root, 'add', 'NOTES.md');
  git(root, 'commit', '-q', '-m', 'main moves on');
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'switch', '-q', workId);
  git(root, 'rebase', '-q', 'main');
  git(root, 'push', '-q', '--force', 'origin', workId);

  const refused = flow(root, ['approve', '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  const result = JSON.parse(refused.stdout);
  assert.equal(result.error.code, 'STORY_HISTORY_REWRITTEN', refused.stdout);
  assert.match(result.error.message, /was rewritten \(a rebase or force-push\)/u);
  assert.match(result.error.message, new RegExp(`git reset --keep ${recordedTip.slice(0, 12)}`, 'u'), 'the last tip that holds the recorded history');
  // Which recorded commits the rebase still carries as the same change, and that the records match.
  assert.match(result.error.message, /now carries the same change for (\d+) of \1 recorded commit/u, result.error.message);
  assert.doesNotMatch(result.error.message, /no matching change|records differ/u);
  assert.match(result.error.message, /SFlow still reads only the recorded commit IDs/u);
  const steps = result.remediationPlan.steps.map((entry) => entry.label).join('\n');
  assert.match(steps, new RegExp(`git reset --keep ${recordedTip}`, 'u'), 'the recovery plan shows the restore, not help or doctor alone');
  assert.match(steps, new RegExp(`git push --force-with-lease origin ${workId}`, 'u'));

  // The named route: the recorded history back, locally and on the remote; then the approval holds.
  git(root, 'reset', '--keep', recordedTip);
  git(root, 'push', '--force-with-lease', 'origin', workId);
  flow(root, ['approve', '--yes']);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.intake.status, 'approved');
  // main comes in by a merge, which keeps every recorded commit.
  git(root, 'merge', '-q', '--no-edit', 'origin/main');
  assert.equal(execute('git', ['merge-base', '--is-ancestor', recordedTip, 'HEAD'], root, { allowFailure: true }).status, 0);
});
