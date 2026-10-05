import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import {
  commitAndPublish, createWorkflow, loadConfig, publishGeneration, scanArtifacts
} from '../src/state.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin/singularity-flow.mjs');
const WORK_ID = 'REVIEW-1';
const ACTOR = { name: 'Review Driver', email: 'review-driver@example.test' };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function cli(root, ...args) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

/**
 * A spec-driven Story whose scope step has a published specification awaiting its independent
 * source review. With `copied`, the step is the workflow's own copy, made in Workflow Studio under
 * a name of its own.
 */
async function publishedSpecificationStory(t, { copied = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-source-cli-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Review fixture\n');
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const authored = YAML.parse(await readFile(workflowFile, 'utf8'));
  authored.git.publish = 'off';
  for (const authority of Object.values(authored.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  for (const phase of Object.values(authored.phases ?? {})) {
    if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  }
  await writeFile(workflowFile, YAML.stringify(authored));
  if (copied) {
    const { planStudioChangeSet } = await import('../src/workflow-studio.mjs');
    const steps = authored.workTypes['spec-driven-standard'].phases;
    await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: [
      { op: 'phase.create', id: 'specification-spec-driven-standard', label: 'Specification (Spec-Driven Standard)', copyOf: 'specification', copyFromWorkflow: 'spec-driven-standard' },
      { op: 'workflow.update', id: 'spec-driven-standard', phases: steps.map((id) => (id === 'specification' ? 'specification-spec-driven-standard' : id)) }
    ] }, { write: true });
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize governed review fixture');
  git(root, 'switch', '-c', WORK_ID);

  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'spec-driven-standard');
  const phaseId = resolved.phases[0].id;
  const authorAgent = resolved.phases[0].defaultAgent;
  await setAgentSession(root, config, ACTOR, authorAgent, WORK_ID,
    { phaseId, source: 'test' });
  const workflow = await withOperationContext({
    operation: { id: 'test.source-review-cli', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test'
  }, () => createWorkflow(root, config, {
    id: WORK_ID, title: 'Save a draft',
    source: { type: 'manual', key: WORK_ID, title: 'Save a draft',
      description: 'Save a draft and show saved status.',
      acceptanceCriteria: ['Saving persists the draft and displays saved status.'],
      notes: 'Export is out of scope.' },
    baseBranch: 'main', workType: 'spec-driven-standard', agent: authorAgent, resolved
  }));
  const phase = workflow.phases[phaseId];
  const artifact = path.join(root, 'singularity/work-items', WORK_ID, phase.requiredArtifact.path);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, `# Specification — ${WORK_ID}
## Agent brief
Members can save drafts and see persisted status. Export is excluded.
## Actors
Member
## User scenarios
### S1 — Save a draft
- Given a draft, when saved, then it persists and shows saved status.
## Failure and empty states
An empty draft may be saved; a failed save reports failure.
## Permissions
The member can save their own draft.
## Boundary conditions
The draft must fit the configured maximum size.
## Requirements
- Persist a saved draft. (S1) [${WORK_ID}:REQ-001]
- Display saved status after persistence. (S1) [${WORK_ID}:AC-001]
## Non-functional requirements
No additional non-functional target is asserted.
## Assumptions
Storage is available.
## Out of scope
Export.
`);
  await scanArtifacts(root, config, workflow, phaseId);
  const authorship = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
    actor: ACTOR, governedAgentContext: authorAgent, source: null
  });
  await withOperationContext({
    operation: { id: 'test.source-review-publish', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test'
  }, () => commitAndPublish(root, config, workflow,
    { type: 'artifact-generated', phaseId, generation: 1 },
    `[${WORK_ID}][phase:${phaseId}][generated:1] publish`,
    phase.artifacts.map((entry) => entry.path), {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
        phaseId, authorship, persist: false,
        publicationTransaction: { publicationEvent,
          transactionId: transactionContext.transactionId,
          expectedHead: transactionContext.expectedHead }
      })
    }));
  return { root, phaseId, authorAgent };
}

/** The reviewer's report on the published specification: two covered statements and one exclusion. */
function reviewReport(packet) {
  const story = packet.sources.find((entry) => entry.id === 'story');
  const lines = story.text.split(/\r?\n/u);
  const coveredLine = lines.findIndex((line) => line.includes('Save a draft and show saved status.')) + 1;
  const excludedLine = lines.findIndex((line) => line.includes('Export is out of scope.')) + 1;
  // Every requirement statement needs its own row: the acceptance criterion is one [D-14].
  const criterionLine = lines.findIndex((line) => line.includes('Saving persists the draft and displays saved status.')) + 1;
  assert.ok(coveredLine > 0 && excludedLine > 0 && criterionLine > 0);
  return {
    ...packet.reportTemplate,
    rows: [
      { id: 'save-draft', sourceId: 'story', line: coveredLine,
        quote: 'Save a draft and show saved status.', outcome: 'covered', scenarioId: 'S1',
        clauseIds: [`${WORK_ID}:REQ-001`, `${WORK_ID}:AC-001`] },
      { id: 'save-criterion', sourceId: 'story', line: criterionLine,
        quote: 'Saving persists the draft and displays saved status.', outcome: 'covered', scenarioId: 'S1',
        clauseIds: [`${WORK_ID}:AC-001`] },
      { id: 'export-exclusion', sourceId: 'story', line: excludedLine,
        quote: 'Export is out of scope.', outcome: 'excluded',
        reason: 'Explicitly outside this Story.' }
    ]
  };
}

test('real Story CLI retains pinned reviewer report and separate human disposition before submission', async (t) => {
  const { root, authorAgent } = await publishedSpecificationStory(t);
  const packet = JSON.parse(cli(root, 'review-source', 'context', 'specification', '--json'));
  assert.equal(packet.requiredReviewerAgentId, 'sflow-source-reviewer');
  assert.equal(packet.binding.generation, 1);
  const report = reviewReport(packet);
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  cli(root, 'agent', '--agent', 'sflow-source-reviewer');
  const submitted = JSON.parse(cli(root, 'review-source', 'submit', 'specification',
    '--report-file', packet.stagingPath, '--json'));
  assert.equal(submitted.status, 'correction-required');
  assert.deepEqual(submitted.pendingDispositions.map((entry) => entry.id), ['exclusion:export-exclusion']);
  const pending = JSON.parse(cli(root, 'review-source', 'status', 'specification', '--json'));
  assert.equal(pending.reportSha256, submitted.reportSha256);
  const reviewerDecision = spawnSync(process.execPath, [executable, 'review-source', 'decide',
    'specification', '--finding', 'exclusion:export-exclusion',
    '--reason', 'The reviewer cannot approve this exclusion.', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.notEqual(reviewerDecision.status, 0,
    'the selected read-only reviewer cannot record its own human disposition');
  assert.match(`${reviewerDecision.stderr}\n${reviewerDecision.stdout}`,
    /read-only source reviewer.*cannot record a human source review decision/u);
  assert.equal(JSON.parse(cli(root, 'review-source', 'status', 'specification', '--json')).status,
    'correction-required');
  cli(root, 'agent', '--agent', authorAgent);
  const decided = JSON.parse(cli(root, 'review-source', 'decide', 'specification',
    '--finding', 'exclusion:export-exclusion', '--reason', 'Confirmed outside requested scope.', '--json'));
  assert.equal(decided.status, 'ready');
  assert.equal(JSON.parse(cli(root, 'review-source', 'status', 'specification', '--json')).status, 'ready');
  cli(root, 'agent', '--agent', 'sflow-source-reviewer');
  const reviewerSubmit = spawnSync(process.execPath, [executable, 'submit', 'specification'], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.notEqual(reviewerSubmit.status, 0, 'the selected read-only reviewer cannot submit the phase');
  assert.match(`${reviewerSubmit.stderr}\n${reviewerSubmit.stdout}`, /read-only source reviewer/);
  assert.equal(git(root, 'status', '--short'), '');

  // Submission rewrites the specification's managed metadata (status, commits). The review was bound
  // to what the author wrote, so it still describes the artifact and approval can proceed.
  cli(root, 'agent', '--agent', authorAgent);
  cli(root, 'submit', 'specification', '--skip-checks');
  const approval = spawnSync(process.execPath, [executable, 'approve', 'specification', '--yes'], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.equal(approval.status, 0, `approval after a ready review failed:\n${approval.stderr}\n${approval.stdout}`);
  assert.doesNotMatch(`${approval.stderr}\n${approval.stdout}`, /source review is stale/);
});

test('a specification copied in Workflow Studio is reviewed for what it does, so its review is accepted [E2G-001]', async (t) => {
  const { root, phaseId, authorAgent } = await publishedSpecificationStory(t, { copied: true });
  assert.equal(phaseId, 'specification-spec-driven-standard');
  const packet = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
  // The report template once carried the step's name as its kind, which the evaluator compares with
  // what the step does, so every review of a renamed step was refused as an invalid contract.
  assert.equal(packet.kind, 'specification');
  assert.equal(packet.reportTemplate.kind, 'specification');
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, `${JSON.stringify(reviewReport(packet), null, 2)}\n`);
  cli(root, 'agent', '--agent', 'sflow-source-reviewer');
  const submitted = JSON.parse(cli(root, 'review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--json'));
  assert.equal(submitted.status, 'correction-required');
  assert.deepEqual(submitted.pendingDispositions.map((entry) => entry.id), ['exclusion:export-exclusion']);
  cli(root, 'agent', '--agent', authorAgent);
  const decided = JSON.parse(cli(root, 'review-source', 'decide', phaseId,
    '--finding', 'exclusion:export-exclusion', '--reason', 'Confirmed outside requested scope.', '--json'));
  assert.equal(decided.status, 'ready');
});

test('legacy/off-policy Story status does not demand a reviewer or published generation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-source-off-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Off-policy review fixture\n');
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const authored = YAML.parse(await readFile(workflowFile, 'utf8'));
  authored.git.publish = 'off';
  for (const authority of Object.values(authored.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  await writeFile(workflowFile, YAML.stringify(authored));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize off-policy fixture');
  git(root, 'switch', '-c', 'OFF-1');
  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'spec-code-test-loop');
  const authorAgent = resolved.phases[0].defaultAgent;
  await setAgentSession(root, config, ACTOR, authorAgent, 'OFF-1',
    { phaseId: 'specification', source: 'test' });
  await withOperationContext({
    operation: { id: 'test.source-review-off', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test'
  }, () => createWorkflow(root, config, {
    id: 'OFF-1', title: 'Off policy',
    source: { type: 'manual', key: 'OFF-1', title: 'Off policy',
      description: 'No source review policy is pinned.' },
    baseBranch: 'main', workType: 'spec-code-test-loop', agent: authorAgent, resolved
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Accept off-policy Story');
  const status = JSON.parse(cli(root, 'review-source', 'status', 'specification', '--json'));
  assert.equal(status.status, 'not-required');
  assert.equal(status.mode, 'off');
  assert.deepEqual(status.findings, []);
});
