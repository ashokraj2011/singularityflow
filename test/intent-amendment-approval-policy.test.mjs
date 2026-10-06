import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { approvalRequirementsMet } from '../src/approval-authority.mjs';
import { recordSha256 } from '../src/records.mjs';
import { publishedGenerationCommit } from '../src/generation-publication-store.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const WORK = 'AMEND-POLICY-1';

function specification(value) {
  return [
    `# ${WORK} — Specification`, '',
    '## Agent brief', '', `Return exactly ${value} with executable proof.`, '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '', `Given a ready application, when a user reads it, then ${value} is displayed.`, '',
    '## Failure and empty states', '', 'A missing value is rejected.', '',
    '## Permissions', '', 'Reading requires no special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer is exposed.', '',
    '## Requirements', '',
    `- Return exactly ${value}. [${WORK}:REQ-001]`,
    `- The user sees ${value}. [${WORK}:AC-001]`, '',
    '## Boundary and non-functional requirements', '', 'Invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns without network access.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '',
    '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n');
}

test('amendments honor required groups, retain all reviewers and let a prior reviewer reject a stale proposal', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-amendment-policy-'));
  const root = path.join(directory, 'repository');
  const remote = path.join(directory, 'origin.git');
  const candidate = path.join(directory, 'candidate.md');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let actor = 'a';
  const run = (command, args, { allowFailure = false, cwd = root } = {}) => {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', timeout: 45_000,
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor,
        SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
    });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run('git', ['init', '-q', '-b', 'main', root], { cwd: directory });
  const git = (...args) => run('git', args).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args]);
  const reviewer = (name) => {
    actor = name;
    git('config', 'user.name', name);
    git('config', 'user.email', `${name}@example.com`);
  };
  reviewer('a');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true,
    scripts: { test: 'node --test' } }));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc', autoEnrollNewIdentities: false };
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const group of Object.values(config.approvalAuthorities)) group.allowAnyGitIdentity = true;
  config.approvalAuthorities['product-approvers'] = { label: 'Product', allowAnyGitIdentity: false,
    members: ['a', 'b', 'c'].map((name) => ({ email: `${name}@example.com` })) };
  config.approvalAuthorities['quality-reviewers'] = { label: 'Quality', allowAnyGitIdentity: false,
    members: [{ email: 'b@example.com' }] };
  config.phases.specification.approval = { authorities: ['product-approvers', 'quality-reviewers'],
    requiredAuthorities: ['quality-reviewers'], minimum: 2, allowSelfApproval: true, rejectTo: ['specification'] };
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.');
  git('commit', '-qm', 'Initialize multi-authority amendment fixture');
  run('git', ['init', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-code-test-loop',
    '--title', 'Validate a value', '--description', 'Return the approved value.');
  const item = path.join(root, 'singularity/work-items', WORK);
  const specPath = path.join(item, 'artifacts/specification/spec.md');
  const workflowPath = path.join(item, 'workflow.json');
  const state = async () => JSON.parse(await readFile(workflowPath, 'utf8'));
  await writeFile(specPath, specification(1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  reviewer('b');
  cli('approve', 'specification', '--yes');
  reviewer('a');
  const propose = async (value) => {
    await writeFile(candidate, specification(value));
    return JSON.parse(cli('story', 'intent-amendment', 'propose', '--file', candidate,
      '--reason', 'The human requested a new value.', '--authored', 'human', '--external-ai', 'assisted',
      '--change-origin', 'mixed', '--json').stdout).proposal;
  };
  const decide = (id, decision, allowFailure = false) => run(process.execPath,
    [CLI, '--no-model', 'story', 'intent-amendment', 'decide', id, '--decision', decision,
      '--confirm', id, '--json'], { allowFailure });
  const scopeBefore = await readFile(specPath, 'utf8');
  const stale = await propose(2);
  assert.equal(JSON.parse(decide(stale.id, 'approve').stdout).transition.applied, false);
  const duplicate = decide(stale.id, 'approve', true);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stdout + duplicate.stderr, /already decided/);
  await writeFile(path.join(root, 'source-moved.mjs'), 'export const moved = true;\n');
  git('add', 'source-moved.mjs');
  git('commit', '-qm', 'Source changes after partial amendment review');
  const moved = decide(stale.id, 'approve', true);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stdout + moved.stderr, /INTENT_AMENDMENT_SOURCE_STALE/);
  const rejected = JSON.parse(decide(stale.id, 'reject').stdout).transition;
  assert.equal(rejected.applied, false);
  assert.equal(rejected.proposal.status, 'rejected');
  assert.deepEqual(rejected.proposal.decisions.map((entry) => entry.decision), ['approved', 'rejected']);
  assert.ok(rejected.proposal.decisions.every((entry) => entry.actor.email === 'a@example.com'));
  assert.equal(await readFile(specPath, 'utf8'), scopeBefore);
  assert.equal((await state()).phases.specification.generation, 1);
  // Restore only this fixture's synthetic source edit. Downstream preparation must test amendment
  // inputs, not the independent refusal to adopt application edits before a Code generation.
  await rm(path.join(root, 'source-moved.mjs'));
  git('add', '-u');
  git('commit', '-qm', 'Restore fixture source before the replacement amendment');

  const proposal = await propose(3);
  assert.equal(JSON.parse(decide(proposal.id, 'approve').stdout).transition.applied, false);
  reviewer('c');
  const withoutQuality = JSON.parse(decide(proposal.id, 'approve').stdout).transition;
  assert.equal(withoutQuality.applied, false, 'minimum headcount does not waive a required group');
  assert.equal(withoutQuality.reached, false);
  assert.deepEqual(withoutQuality.proposal.approvals, { reached: 2, required: 2,
    missingAuthorities: ['quality-reviewers'] });
  assert.equal((await state()).phases.specification.generation, 1);
  assert.equal(await readFile(specPath, 'utf8'), scopeBefore);
  reviewer('b');
  const applied = JSON.parse(decide(proposal.id, 'approve').stdout).transition;
  assert.equal(applied.applied, true);
  const amendedWorkflow = await state();
  const scope = amendedWorkflow.phases.specification;
  const approvals = scope.approvals.filter((entry) => !entry.invalidatedAt);
  assert.equal(scope.generation, 2);
  assert.deepEqual(approvals.map((entry) => [entry.actor.email, entry.authorityGroup, entry.generation]), [
    ['a@example.com', 'product-approvers', 2],
    ['c@example.com', 'product-approvers', 2],
    ['b@example.com', 'quality-reviewers', 2]
  ]);
  assert.equal(approvalRequirementsMet(scope.approvalPolicy, approvals), true);
  const origin = scope.generationPublications.at(-1).origin;
  assert.equal(origin.decisionSha256, recordSha256(approvals.at(-1)), 'publication remains bound to the final authority decision');
  assert.equal(publishedGenerationCommit(root, amendedWorkflow, scope), git('rev-parse', 'HEAD'),
    'retaining earlier reviewers must not make the exact amendment publication unverifiable');
  assert.deepEqual(applied.proposal.approvals, { reached: 3, required: 2, missingAuthorities: [] });
  const authorship = scope.authorship.at(-1);
  assert.equal(authorship.actor.email, 'a@example.com', 'the last reviewer is not the author');
  assert.equal(authorship.producer, 'human');
  assert.deepEqual(authorship.externalAiUse, { value: 'assisted', status: 'self-reported' });
  assert.deepEqual(authorship.changeOrigins, ['mixed']);
  assert.equal(authorship.source.sha256, proposal.specification.proposedSha256);
  assert.equal(decide(proposal.id, 'reject', true).status, 1, 'terminal proposals cannot be reopened by rejection');
  cli('story', 'intent-amendment', 'acknowledge', proposal.id);
  assert.match(cli('prepare', 'implementation').stdout, /implementation is ready to author/);
});
