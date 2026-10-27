import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { decidableUpstreamStep, raiseUpstreamIssue } from '../src/upstream-issues.mjs';
import { discardPreparedStoryWorktree, preparedStoryWorktreePath, prepareStoryWorktree } from '../src/story-worktree.mjs';
import { phaseExplicitlyReopened } from '../src/sequence.mjs';
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';
import { classifyStoryGateFailures } from '../src/gate-recovery.mjs';
import { terminalRecoveryActions } from '../src/evidence/terminal.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { selectStartEntry } from '../src/application-run.mjs';
import { unavailableStoriesError } from '../src/session-story-discovery.mjs';
import { inspectLifecycleWorktree } from '../src/lifecycle-worktree.mjs';
import { modelOffCause } from '../src/operation-context.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';

// Each refusal here used to leave its reader with prose or a route that refused again (blocker
// audit 2026-10-27, batch 4 and 5). Each now names a command that works from where it stands.

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const AT = '2026-10-27T00:00:00.000Z';

function story() {
  return { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['specification', 'planning', 'implementation'],
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
      planning: { id: 'planning', status: 'approved', generation: 1, approvalPolicy: {} },
      implementation: { id: 'implementation', status: 'in_progress', generation: 1 }
    } };
}

test('an issue against a step without approvers is refused with the nearest step that can decide it', () => {
  const workflow = story();
  assert.equal(decidableUpstreamStep(workflow, 'planning'), 'specification');
  assert.equal(decidableUpstreamStep(workflow, 'specification'), 'specification');
  let refusal;
  assert.throws(() => raiseUpstreamIssue(workflow, { phase: 'planning', about: 'AC-001',
    problem: 'The plan has no row for AC-001, so nothing tests it.', raisedBy: 'dev@example.test', at: AT }), (error) => {
    refusal = error;
    return error.code === 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE' && error.details.decidableStep === 'specification';
  });
  assert.equal(workflow.upstreamIssues, undefined, 'nothing was raised');
  const [first] = refusalRemediationPlan(refusal, ['upstream-issue', 'raise', '--phase', 'planning']).steps;
  assert.equal(first.id, 'raise-at-decidable-step');
  assert.match(first.command, /^singularity-flow upstream-issue raise --phase specification /u);

  // An issue already open there is superseded at the decidable step; its approvers dismiss both.
  const supersede = 'singularity-flow upstream-issue raise --work-id DEAD-1 --phase specification --supersedes UPI-001 --about <ID|SECTION> --problem <TEXT>';
  const open = Object.assign(new Error('planning has no approval group'), { code: 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE',
    details: { issue: 'UPI-001', phase: 'planning', decidableStep: 'specification', nextAction: { command: supersede } } });
  const [route] = refusalRemediationPlan(open, ['upstream-issue', 'decide', 'UPI-001']).steps;
  assert.equal(route.id, 'supersede-upstream-issue');
  assert.equal(route.command, supersede);
});

test('a start checkout left at an older base names its own commit, and discarding it with that commit works', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-dead-end-start-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repository'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Dead End Tester'); git(root, 'config', 'user.email', 'dead-end@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'first base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'First base');
  const oldBase = git(root, 'rev-parse', 'HEAD');
  const prepared = await prepareStoryWorktree(root, 'STALE-1', { base: oldBase });
  git(root, 'commit', '--allow-empty', '-qm', 'The base branch moved on');
  const newBase = git(root, 'rev-parse', 'HEAD');

  let refusal;
  await assert.rejects(() => preparedStoryWorktreePath(root, 'STALE-1', { baseCommit: newBase }), (error) => {
    refusal = error;
    return error.code === 'STORY_WORKTREE_RECOVERY_REQUIRED';
  });
  assert.equal(refusal.details.preparedBase, oldBase);
  assert.equal(refusal.details.requestedBase, newBase);
  assert.equal(await realpath(refusal.details.checkoutPath), await realpath(prepared.repositoryPath));
  const command = `singularity-flow story discard-worktree --work-id STALE-1 --prepared-base ${oldBase}`;
  assert.equal(refusal.details.nextAction.command, command);
  assert.equal(refusalRemediationPlan(refusal, ['story', 'prepare-worktree', '--work-id', 'STALE-1']).steps[0].command, command);

  // The named command's own operation removes the unchanged checkout.
  assert.equal((await discardPreparedStoryWorktree(root, 'STALE-1', { baseCommit: oldBase })).status, 'removed');
  assert.equal(await preparedStoryWorktreePath(root, 'STALE-1', { baseCommit: newBase }), null);

  // A commit made inside the prepared checkout is not in the base: no discard is offered for it.
  const own = await prepareStoryWorktree(root, 'STALE-2', { base: newBase });
  git(own.repositoryPath, 'commit', '--allow-empty', '-qm', 'Work inside the prepared checkout');
  await assert.rejects(() => preparedStoryWorktreePath(root, 'STALE-2', { baseCommit: newBase }), (error) => {
    assert.equal(error.code, 'STORY_WORKTREE_RECOVERY_REQUIRED');
    assert.equal(error.details.nextAction, undefined);
    assert.match(error.message, /holds a commit the base does not have/u);
    return true;
  });
});

test('a code step a skill amendment reopened is prepared again, not rolled over', () => {
  const code = { id: 'implementation', status: 'in_progress', generation: 2, generationPolicy: { task: 'code' },
    generationIntent: { id: 'GI-2', status: 'consumed', generation: 2 },
    skillAmendmentRevalidation: { id: 'SAM-001', state: 'affected', generationAtAdoption: 2 } };
  const workflow = { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['implementation'], phases: { implementation: code } };
  assert.equal(phaseExplicitlyReopened(workflow, code), true);
  const entry = phaseAuthoringEntry(workflow, code);
  assert.equal(entry.reason, 'code-rework-preparation-required');
  assert.equal(entry.actions[0].command, 'singularity-flow prepare implementation');
  assert.match(entry.actions[0].reason, /reopened by a skill amendment/u);
  // Once the next generation is published the amendment no longer reopens it.
  assert.equal(phaseExplicitlyReopened(workflow, { ...code, generation: 3 }), false);
});

test('a document whose original is gone offers the detach preview beside choosing the file again', () => {
  const error = Object.assign(new Error('The selected file is not the original for DOC-003.'), {
    code: 'DOCUMENT_RESTORE_HASH_MISMATCH', details: { documentId: 'DOC-003', expectedSha256: 'a'.repeat(64), actualSha256: 'b'.repeat(64) } });
  const steps = refusalRemediationPlan(error, ['documents', 'restore', 'DOC-003', '--work-id', 'DEAD-1', '--file', 'x.pdf']).steps;
  assert.deepEqual(steps.slice(0, 2).map((entry) => [entry.id, entry.command]), [
    ['choose-original-again', 'singularity-flow documents restore DOC-003 --work-id DEAD-1 --file <LOCAL-FILE> --json'],
    ['preview-detach', 'singularity-flow documents detach DOC-003 --work-id DEAD-1 --dry-run --json']
  ]);
});

test('commits only the person can send are named with the exact Git commands, never sync', () => {
  const workflow = { workItem: { id: 'DEAD-1' }, currentPhase: null, phaseOrder: ['implementation'], phases: {} };
  for (const [state, pattern] of [['ahead', /git log --oneline origin\/DEAD-1\.\.HEAD`.*git push origin HEAD:DEAD-1`/u],
    ['diverged', /git log --oneline --left-right HEAD\.\.\.origin\/DEAD-1`/u]]) {
    const [finding] = classifyStoryGateFailures(workflow, [{ code: 'gate.publication.remote-missing', message: `not published (${state})`,
      publication: { state, remote: 'origin', branch: 'DEAD-1' } }], { publicationPending: false });
    assert.equal(finding.recovery.command, null);
    assert.match(finding.recovery.detail, pattern);
    assert.doesNotMatch(finding.recovery.detail, /git push --force|singularity-flow sync/u);
  }
});

test('the final gate is a read, and an open Story\'s ending names the decision list rather than gate --terminal', () => {
  assert.equal(resolveOperation({ requestedCommand: 'gate', positionals: ['gate'], options: { terminal: true } }).classification, 'read');
  const actions = terminalRecoveryActions('DEAD-1', { decision: { gate: 'pass' }, rows: [] },
    { errors: ['terminal: phase planning is not approved'], findings: [] });
  assert.deepEqual(actions, ['singularity-flow decisions DEAD-1']);
});

test('an application with no start entry names app suggest', () => {
  let refusal;
  assert.throws(() => selectStartEntry({ capabilityId: 'web-app', application: { start: [] } }), (error) => {
    refusal = error;
    return error.code === 'APP_START_NOT_DECLARED';
  });
  assert.equal(refusalRemediationPlan(refusal, ['app', 'start']).steps[0].command,
    'singularity-flow app suggest --capability web-app --json');
});

test('unreadable state records name the ledger doctor, and a newer build\'s records keep their upgrade code', () => {
  const generic = unavailableStoriesError([{ code: 'SUBJECT_STATE_UNAVAILABLE', claimedId: 'OLD-1', sourceCode: 'SESSION_STORY_INVALID', reason: 'no summary' }]);
  assert.equal(generic.code, 'SESSION_STATE_INDEX_UNAVAILABLE');
  assert.equal(generic.details.nextAction.command, 'singularity-flow ledger doctor --json');
  const newer = unavailableStoriesError([{ code: 'SUBJECT_STATE_UNAVAILABLE', claimedId: 'NEW-1', sourceCode: 'SCHEMA_VERSION_FUTURE', reason: 'Written by a newer build.' }]);
  assert.equal(newer.code, 'SCHEMA_VERSION_FUTURE');
  assert.deepEqual(newer.details.workIds, ['NEW-1']);
});

test('an interrupted SFlow write inside the Story\'s folder never holds a lifecycle decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dead-end-temp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  const temp = 'workflow.json.tmp-4242-0f8fad5b-d9cb-469f-a165-70867728950e';
  await mkdir(path.join(root, 'singularity/work-items/DEAD-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/DEAD-1', temp), '{}');
  await writeFile(path.join(root, temp), '{}');
  const inspection = inspectLifecycleWorktree(root, { workItemRoot: 'singularity/work-items' }, { workItem: { id: 'DEAD-1' } });
  assert.deepEqual(inspection.disposableUntrackedPaths, [`singularity/work-items/DEAD-1/${temp}`]);
  // Outside the Story's folder the same name could be anyone's, so it stays for review.
  assert.deepEqual(inspection.entries.map((entry) => entry.path.value), [temp]);
});

test('a model-only step with the model off says how to turn the model back on', () => {
  assert.match(modelOffCause({ source: 'environment' }), /SINGULARITY_FLOW_NO_MODEL is set/u);
  assert.match(modelOffCause({ source: 'cli' }), /passed --no-model/u);
  const workflow = { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'design', phaseOrder: ['design'],
    phases: { design: { id: 'design', label: 'Design', status: 'in_progress', generation: 0,
      generationPolicy: { allowedProducers: ['governed-agent'], defaultProducer: 'governed-agent' } } } };
  const [blocked] = workflowNextSteps(workflow, { modelMode: { enabled: false, source: 'environment' } });
  assert.equal(blocked.availability, 'blocked');
  assert.equal(blocked.command, 'singularity-flow nextsteps DEAD-1', 'asking again with --no-model only returns this block');
  assert.match(blocked.reason, /no configured model-free producer\. The model is off because SINGULARITY_FLOW_NO_MODEL/u);
});
