/**
 * A step's clarification answers are its approvers' to give, and an approver on another machine
 * had to borrow the author's checkout under a swapped Git identity to give them (2026-10-28). Now
 * they answer in their own clone and the author's checkout imports what it can verify.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const W = 'CLR-1';
const AUTHOR = { name: 'Author Person', email: 'author.person@example.com' };
const APPROVER = { name: 'Approver One', email: 'approver.one@example.com' };
const OUTSIDER = { name: 'Outside Person', email: 'outside.person@example.com' };

function execute(command, args, cwd, { as = AUTHOR, allowFailure = false, input } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: as.name,
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'classic-delivery', agent: 'product-owner' }),
    GIT_COMMITTER_NAME: as.name, GIT_COMMITTER_EMAIL: as.email, GIT_AUTHOR_NAME: as.name, GIT_AUTHOR_EMAIL: as.email };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, '--no-model', ...args], cwd, options);
const git = (cwd, args, options) => execute('git', args, cwd, options).stdout.trim();

test('an approver answers a step\'s question from their own clone, and the author\'s checkout records only what it can verify', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-clarification-remote-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const author = path.join(base, 'author');
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(base, ['init', '-q', '-b', 'main', author]);
  git(author, ['config', 'user.name', AUTHOR.name]);
  git(author, ['config', 'user.email', AUTHOR.email]);
  git(author, ['remote', 'add', 'origin', remote]);
  await writeFile(path.join(author, 'README.md'), '# value\n');
  flow(author, ['init']);
  const configPath = path.join(author, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'team', allowSelfApproval: true, autoEnrollNewIdentities: false };
  for (const group of Object.values(config.approvalAuthorities)) Object.assign(group, { allowAnyGitIdentity: false, members: [APPROVER] });
  await writeFile(configPath, YAML.stringify(config));
  git(author, ['add', '.']);
  git(author, ['commit', '-q', '-m', 'Initialize the clarification fixture']);
  git(author, ['push', '-q', '-u', 'origin', 'main']);
  const readiness = JSON.parse(flow(author, ['precheck', '--run', '--scope', 'dependency-test', '--json']).stdout).data.plan;
  flow(author, ['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json']);
  flow(author, ['start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.']);
  flow(author, ['prepare', 'intake']);
  flow(author, ['wm', 'compose', '--phase', 'intake']);
  const question = 'Is 2 the approved value?';

  // The author cannot answer: the intake's approvers decide, and the refusal names their way.
  const refused = flow(author, ['clarification', 'record', 'intake', '--question', question, '--answer', 'Yes.'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /singularity-flow clarification answer intake/u);
  assert.match(refused.stdout + refused.stderr, /singularity-flow clarification import intake/u);

  // The approver answers in their own clone, under their own identity; the Story branch is untouched.
  const approver = path.join(base, 'approver');
  git(base, ['clone', '-q', '--branch', W, remote, approver], { as: APPROVER });
  git(approver, ['config', 'user.name', APPROVER.name]);
  git(approver, ['config', 'user.email', APPROVER.email]);
  const branchBefore = git(author, ['ls-remote', 'origin', `refs/heads/${W}`]);
  const outsider = flow(approver, ['clarification', 'answer', 'intake', '--question', question, '--answer', 'No.'], { as: OUTSIDER, allowFailure: true });
  assert.notEqual(outsider.status, 0, 'a person outside the approval groups cannot answer');
  flow(approver, ['clarification', 'answer', 'intake', '--question', question, '--answer', 'Yes, 2 is approved.'], { as: APPROVER });
  assert.equal(git(author, ['ls-remote', 'origin', `refs/heads/${W}`]), branchBefore, 'nothing changed on the Story branch');

  // A forged packet: it names the approver but an outsider committed it.
  const forged = { kind: 'clarification-answer', version: 1, workId: W, phase: 'intake', generation: 1, question: 'Is 3 fine too?',
    questionSha256: (await import('node:crypto')).createHash('sha256').update('Is 3 fine too?').digest('hex'),
    answer: 'Yes.', answeredBy: APPROVER, authorityGroup: null, identityAssurance: null, at: new Date().toISOString() };
  const blob = git(approver, ['hash-object', '-w', '--stdin'], { as: OUTSIDER, input: JSON.stringify(forged) });
  const tree = git(approver, ['mktree'], { as: OUTSIDER, input: `100644 blob ${blob}\tanswer.json\n` });
  const commit = git(approver, ['commit-tree', tree, '-m', 'forged'], { as: OUTSIDER });
  git(approver, ['push', '-q', 'origin', `${commit}:refs/sflow-clarifications/${W}/intake/gen1/${forged.questionSha256.slice(0, 16)}`], { as: OUTSIDER });

  const imported = flow(author, ['clarification', 'import', 'intake']);
  assert.match(imported.stdout, /Recorded 1 answer from approver\.one@example\.com for intake generation 1/u);
  assert.match(imported.stdout, /Not recorded: .*committed by outside\.person@example\.com, not by the person it names/u);
  const status = JSON.parse(flow(author, ['clarification', 'status', 'intake', '--json']).stdout);
  const record = status.data?.record ?? status.record;
  assert.equal(record.responses.length, 1);
  assert.equal(record.responses[0].answer, 'Yes, 2 is approved.');
  assert.equal(record.recordedBy.email, APPROVER.email, 'the approver is the record\'s human actor');
  assert.match(record.responses[0].owner, /answered in another clone/u);
  // Importing again records nothing new.
  assert.match(flow(author, ['clarification', 'import', 'intake']).stdout, /Recorded 1 answer/u);
});
