import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { prepareTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { captureTrpIntakeBaseline } from '../src/test-recovery-runtime.mjs';
import { prepareStoryWorktree, storyWorktreePath } from '../src/story-worktree.mjs';

const workId = 'ISOLATED-BASELINE-PREVIEW';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');

async function treeDigest(root) {
  const manifest = [];
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name); const stat = await lstat(absolute);
      assert.equal(stat.isSymbolicLink(), false, `fixture unexpectedly contains a symlink: ${relative}`);
      manifest.push([relative, stat.mode, stat.mtimeMs, stat.isFile() ? sha(await readFile(absolute)) : null]);
      if (stat.isDirectory()) await visit(absolute, relative);
    }
  }
  await visit(root);
  return sha(JSON.stringify(manifest));
}

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-isolated-baseline-preview-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Baseline Reviewer');
  git(root, 'config', 'user.email', 'baseline@example.invalid');
  await initializeDefinition(root); await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), '.sflow/results/\n');
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/service.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('baseline assertion',()=>assert.equal(2,3)); test('smoke',()=>assert.equal(1,1));\n");
  const filename = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(filename, 'utf8'));
  definition.git.publish = 'off';
  definition.approvalAuthorities['risk-reviewers'] = { label: 'Exact reviewers', allowAnyGitIdentity: false,
    members: [{ name: 'Baseline Reviewer', email: 'baseline@example.invalid', githubLogin: null }] };
  definition.testRecovery = { enabled: true, riskAuthorities: ['risk-reviewers'], enabledRiskCategories: ['known-test-failure'],
    allowEvidenceReuse: true, maxRiskDays: 7, caseInventory: [{ phaseId: 'implementation', commandId: 'native-tests',
      dependencyScope: 'repository-and-node-builtins-only', baselineMutableRoots: ['src'], tests: [
        { id: 'baseline', name: 'baseline assertion', path: 'test/service.test.mjs' },
        { id: 'smoke', name: 'smoke', path: 'test/service.test.mjs' }] }] };
  definition.workTypes.feature = { label: 'Feature', phases: ['implementation'],
    plannedClaims: { mode: 'opt-out', reason: 'Native isolated baseline preview fixture.' }, spec: { acceptance: 'off' } };
  Object.assign(definition.phases.implementation, { inputs: [], clarification: { mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] },
    qualityCommands: [{ id: 'native-tests', kind: 'test', modelPolicy: 'never',
      argv: [process.execPath, '--test', '--test-reporter=junit', 'test/service.test.mjs'],
      workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'junit-xml', path: '.sflow/results/baseline.xml', minimumDiscovered: 2, minimumPassed: 1 } }] });
  await writeFile(filename, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Independently approved exact native baseline');
  const baseCommit = git(root, 'rev-parse', 'HEAD'); const config = await loadDefinition(root);
  const identity = { workId, workType: 'feature', phaseId: 'implementation', repositoryId: 'lifecycle', baseCommit };
  const sourceBaseline = await captureTrpIntakeBaseline(root, config, identity);
  const choices = { baselineDisposition: 'accept-known-failures', executionMode: 'all-configured', baselineScope: 'reuse',
    reason: 'Review only the exact genuine native pre-feature failure in its own Story checkout.',
    followUpOwner: 'test-maintainer', remediationRef: 'REPAIR-BASELINE', expiresAt: new Date(Date.now() + 86400000).toISOString() };
  function args(definition, recordSha256, isolatedWorktree) {
    return { definition, workId, workType: 'feature', isolatedWorktree,
      repositories: [{ id: 'lifecycle', root, baseCommit, baseBranch: 'main' }], repositoryReadiness: { repositories: {} },
      phaseDefinitions: resolveWorkType(definition, 'feature').phases,
      choices: { ...choices, baselineRecords: [recordSha256] } };
  }
  return { parent, root, config, identity, sourceBaseline, baseCommit, args };
}

test('isolated baseline preview never creates a missing target or falls back to launch-checkout evidence', async t => {
  const value = await fixture(t);
  const before = await treeDigest(value.parent);
  const preview = await prepareTestRecoveryIntake(value.root, value.args(value.config, value.sourceBaseline.recordSha256, true));
  assert.equal(preview.ready, false);
  assert.ok(preview.blockers.some(message => /--isolated-worktree first/u.test(message)), JSON.stringify(preview.blockers));
  assert.equal(await treeDigest(value.parent), before, 'read-only preview cannot mutate launch, Git journal, or create a target');
  await assert.rejects(async () => lstat(await storyWorktreePath(value.root, workId)), { code: 'ENOENT' });
});

test('isolated baseline preview authenticates target-native evidence with the identical child intake plan', async t => {
  const value = await fixture(t);
  const prepared = await prepareStoryWorktree(value.root, workId, { base: value.baseCommit });
  const child = await realpath(prepared.repositoryPath); const childConfig = await loadDefinition(child);
  const captured = await captureTrpIntakeBaseline(child, childConfig, value.identity);
  assert.equal(captured.observedOutcome, 'failed'); assert.equal(captured.counts.failed, 1);
  let before = await treeDigest(value.parent);
  const sourcePreview = await prepareTestRecoveryIntake(value.root, value.args(value.config, captured.recordSha256, true));
  const childPreview = await prepareTestRecoveryIntake(child, value.args(childConfig, captured.recordSha256, false));
  assert.equal(sourcePreview.ready, true, JSON.stringify(sourcePreview.blockers));
  assert.equal(childPreview.ready, true, JSON.stringify(childPreview.blockers));
  assert.equal(sourcePreview.planDigest, childPreview.planDigest, 'source and child review exactly the same target-native evidence');
  assert.equal(await treeDigest(value.parent), before, 'both native evidence previews are read-only');
  const substituted = await prepareTestRecoveryIntake(value.root, value.args(value.config, value.sourceBaseline.recordSha256, true));
  assert.equal(substituted.ready, false, 'source native HMAC/report provenance cannot replace child native provenance');
  assert.equal(await treeDigest(value.parent), before);
  git(child, 'commit', '--allow-empty', '-qm', 'Moved target after baseline capture');
  before = await treeDigest(value.parent);
  const moved = await prepareTestRecoveryIntake(value.root, value.args(value.config, captured.recordSha256, true));
  assert.equal(moved.ready, false); assert.ok(moved.blockers.some(message => /exact requested pre-feature base/u.test(message)), JSON.stringify(moved.blockers));
  assert.equal(await treeDigest(value.parent), before, 'moved-target preview cannot reset or recapture anything');
});
