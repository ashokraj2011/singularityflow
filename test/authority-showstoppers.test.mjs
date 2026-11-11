import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// Two shapes that left nobody who could decide, so a Story could never get out (2026-10-28
// unhappy-paths audit): a closed Story whose last step has no approvers, and an end that leaves a
// responsibility out while naming an approval group with nobody in it.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const REASON = 'This fixture specifies work and builds nothing at all.';

function run(command, args, cwd, { fail = false, selection = null } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Authority Tester',
    ...(selection ? { SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify(selection) } : {}) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A repository with one document-only workflow, `body`, and `mutate` applied to its configuration. */
async function repository(t, body, mutate = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-authority-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(`${root}.git`, { recursive: true, force: true })]));
  const git = (...args) => run('git', args, root);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Authority Tester');
  git('config', 'user.email', 'authority@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# authority\n');
  run(process.execPath, [bin, 'init'], root);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: its Story is unreviewed on purpose (every step's review: review-every-step-cli.test.mjs).
  config.workTypes['doc-only'] = { sourceReview: { mode: 'off' }, ...body };
  mutate(config);
  await writeFile(configPath, YAML.stringify(config));
  git('add', '-A');
  git('commit', '-m', 'init');
  run('git', ['init', '--bare', '-b', 'main', `${root}.git`], root);
  git('remote', 'add', 'origin', `${root}.git`);
  git('push', '-u', 'origin', 'main');
  const flow = (args, options = {}) => run(process.execPath, [bin, ...args], root,
    { ...options, selection: { workType: 'doc-only', agent: 'product-owner' } });
  const state = (id) => readFile(path.join(root, 'singularity/work-items', id, 'workflow.json'), 'utf8').then(JSON.parse);
  const work = async (id, phaseId) => {
    const before = await state(id);
    if (phaseId !== before.phaseOrder[0]) flow(['prepare', phaseId]);
    const file = path.join(root, 'singularity/work-items', id, (await state(id)).phases[phaseId].requiredArtifact.path);
    const text = (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, 'Matched evidence for AC-001 with exact file references and complete operational detail.')
      .replace(/\bTODO\b/gu, 'matched evidence');
    await writeFile(file, `${text}\nRound note for ${phaseId}.\n`);
    flow(['resume', id]);
    flow(['phase', 'publish', phaseId, '--authored', 'human', '--channel', 'manual-in-place']);
    flow(['submit']);
  };
  return { root, flow, state, work };
}

const omits = ['implement', 'verify'].map((responsibility) => ({ responsibility, reason: REASON, authority: 'product-approvers' }));

test('a closed Story whose last step has no approvers is reopened by the nearest earlier step\'s approvers', async (t) => {
  const { flow, state, work } = await repository(t, {
    label: 'Document only', phases: ['intake', 'requirements'], omits,
    phaseOverrides: { requirements: { inputs: ['intake'], approval: 'none' } }
  });
  const id = 'REOPEN-1';
  flow(['start', id, '--from-branch', 'main']);
  for (const responsibility of ['implement', 'verify']) flow(['decision', 'applicability', '--responsibility', responsibility, '--reason', REASON]);
  await work(id, 'intake');
  flow(['approve', 'intake', '--work-id', id, '--yes']);
  await work(id, 'requirements');
  assert.equal((await state(id)).status, 'closed', 'the last step needs no approval, so submitting it closed the Story');

  // Before: "not a member of: no configured authority group", for everyone, for ever.
  const reopened = flow(['reopen', id, '--to', 'requirements', '--reason', 'A reviewer found a wrong requirement after closure.']);
  assert.match(reopened.stdout, /Reopened REOPEN-1 at requirements/u);
  const after = await state(id);
  assert.equal(after.status, 'in_progress');
  assert.equal(after.currentPhase, 'requirements');
  assert.equal(after.changeRequests.at(-1).authorityGroup, 'product-approvers', 'intake\'s approvers decided it');
});

test('an end that leaves a responsibility out to a group with nobody in it is named before any Story starts', async (t) => {
  const { flow } = await repository(t, {
    label: 'Document only', phases: ['intake', 'requirements'],
    omits: omits.map((entry) => ({ ...entry, authority: 'empty-approvers' }))
  }, (config) => {
    config.approvalSecurity = { profile: 'poc', autoEnrollNewIdentities: false };
    config.approvalAuthorities['empty-approvers'] = { label: 'Empty approvers', members: [], allowAnyGitIdentity: false };
  });
  const report = JSON.parse(flow(['workflow', 'validate', 'doc-only', '--json'], { fail: true }).stdout);
  const findings = (report.data?.workflows ?? report.workflows ?? []).flatMap((entry) => entry.findings ?? []);
  const blocked = findings.filter((entry) => entry.code === 'CHECK_GROUP_BLOCKED' && entry.subject?.group === 'empty-approvers');
  // A route with no code step implements through its own steps, so only verify waits on the group.
  assert.deepEqual(blocked.map((entry) => entry.title), ['Nobody can decide that verify does not apply']);
  assert.match(blocked[0].fix?.text ?? blocked[0].fix, /Add people to Empty approvers/u);
});

// One plan for two code steps: every row without a Steps entry was owed by both, so the second code
// step had to deliver every row again, and nothing said so before a Story started (MC-1, 2026-10-28).
test('one plan shared by two code steps is named before any Story starts', async (t) => {
  const { flow } = await repository(t, {
    label: 'Two code steps', phases: ['intake', 'implementation', 'implementation-ui'],
    plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake', 'implementation-ui': 'intake' } },
    phaseOverrides: { intake: { artifact: { kind: 'requirements' } } }
  }, (config) => {
    config.phases['implementation-ui'] = { ...config.phases.implementation, label: 'UI implementation',
      artifact: { ...config.phases.implementation.artifact, path: 'artifacts/implementation-ui/implementation-summary.md' },
      approval: { ...config.phases.implementation.approval, rejectTo: ['implementation-ui'] } };
  });
  const result = flow(['workflow', 'validate', 'doc-only', '--json'], { fail: true });
  const report = JSON.parse(result.stdout);
  const findings = (report.data?.workflows ?? report.workflows ?? []).flatMap((entry) => entry.findings ?? []);
  const shared = findings.filter((entry) => entry.code === 'CHECK_PLAN_SHARED_BY_CODE_STEPS');
  assert.equal(shared.length, 1, JSON.stringify(findings.map((entry) => entry.code)));
  assert.match(shared[0].title, /plans 2 code steps/u);
  assert.match(shared[0].fix?.text ?? shared[0].fix, /Steps column/u);
});
