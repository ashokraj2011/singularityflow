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
import { loadSession, setAgentSession } from '../src/session.mjs';
import { recordClarificationResponses } from '../src/clarifications.mjs';
import { snapshot } from '../src/util.mjs';
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
async function publishedSpecificationStory(t, { copied = false, humanAnswers = false } = {}) {
  const workType = copied ? 'review-copy' : 'spec-driven-standard';
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
  if (humanAnswers) authored.worldModel.grounding = 'off';
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
      { op: 'workflow.create', id: workType, label: 'Review copy', copyOf: 'spec-driven-standard', phases: steps },
      { op: 'phase.create', id: 'specification-spec-driven-standard', label: 'Specification (Spec-Driven Standard)', copyOf: 'specification', copyFromWorkflow: 'spec-driven-standard' },
      { op: 'workflow.update', id: workType, phases: steps.map((id) => (id === 'specification' ? 'specification-spec-driven-standard' : id)) }
    ] }, { write: true });
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initialize governed review fixture');
  git(root, 'switch', '-c', WORK_ID);

  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, workType);
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
    baseBranch: 'main', workType, agent: authorAgent, resolved
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
  const clarificationFiles = [];
  if (humanAnswers) {
    const promptPath = `singularity/work-items/${WORK_ID}/context/prompts/${phaseId}-gen1.md`;
    const groundingPath = `singularity/work-items/${WORK_ID}/context/${phaseId}-gen1.json`;
    await mkdir(path.dirname(path.join(root, promptPath)), { recursive: true });
    await writeFile(path.join(root, promptPath), '# Governed fixture prompt\nConfirm the evidence scope.\n');
    await writeFile(path.join(root, groundingPath), JSON.stringify({ promptPath,
      renderedSha256: (await snapshot(path.join(root, promptPath))).sha256, agent: authorAgent }));
    const checkpoint = await recordClarificationResponses(root, config, workflow, phase, {
      actor: ACTOR, agent: authorAgent, generation: 1,
      responses: [{ id: 'Q-005', question: 'What evidence satisfies test cases?',
        answer: 'One desktop screenshot and one automated positive-value test.' }]
    });
    clarificationFiles.push(promptPath, groundingPath, checkpoint.path);
  }
  const authorship = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions(humanAnswers
      ? { producer: 'governed-agent', channel: 'copilot-host' }
      : { producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
    actor: ACTOR, governedAgentContext: authorAgent, source: null
  });
  await withOperationContext({
    operation: { id: 'test.source-review-publish', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test'
  }, () => commitAndPublish(root, config, workflow,
    { type: 'artifact-generated', phaseId, generation: 1 },
    `[${WORK_ID}][phase:${phaseId}][generated:1] publish`,
    [...phase.artifacts.map((entry) => entry.path), ...clarificationFiles], {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
        phaseId, authorship, persist: false,
        publicationTransaction: { publicationEvent,
          transactionId: transactionContext.transactionId,
          expectedHead: transactionContext.expectedHead }
      })
    }));
  return { root, phaseId, authorAgent, workType };
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

test('real and copied workflow preparation returns authoring instead of reviewing a retained generation', async t => {
  for (const copied of [false, true]) await t.test(copied ? 'copied scope' : 'seeded scope', async t => {
    const { root, phaseId } = await publishedSpecificationStory(t, { copied });
    const old = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
    await mkdir(path.dirname(old.stagingPath), { recursive: true });
    await writeFile(old.stagingPath, JSON.stringify(reviewReport(old)));
    const head = git(root, 'rev-parse', 'HEAD');
    const artifactBefore = await readFile(path.join(root, old.artifact.path), 'utf8');
    cli(root, 'prepare', phaseId, '--no-model', '--json');
    const packet = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
    assert.equal(packet.canReview, false);
    assert.equal(packet.generation, 1, 'preparation is not publication');
    assert.equal(packet.binding, null);
    assert.equal(packet.stagingPath, null);
    assert.equal(packet.continuation.targetGeneration, 2);
    assert.equal(packet.continuation.nextCommand, `singularity-flow prepare ${phaseId}`);
    assert.ok(packet.continuation.copilotCommand);
    const status = JSON.parse(cli(root, 'review-source', 'status', phaseId, '--json'));
    assert.equal(status.status, 'successor-publication-required');
    assert.deepEqual(status.continuation, packet.continuation);
    assert.match(cli(root, 'review-source', 'context', phaseId), /generation 2 publication/);
    assert.match(cli(root, 'review-source', 'context', phaseId), new RegExp(`prepare ${phaseId}`));
    for (const action of ['check', 'submit']) {
      const refused = spawnSync(process.execPath, [executable, 'review-source', action, phaseId,
        '--report-file', old.stagingPath, '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
      assert.notEqual(refused.status, 0);
      assert.equal(JSON.parse(refused.stdout).error.code, 'SOURCE_REVIEW_SUCCESSOR_UNPUBLISHED');
    }
    const fast = JSON.parse(cli(root, 'specify', '--json'));
    assert.equal(fast.data.fastPath.next[0].command, `singularity-flow prepare ${phaseId}`);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'no Story publication or review was retained');
    assert.equal(await readFile(path.join(root, old.artifact.path), 'utf8'), artifactBefore,
      'the published document is not replaced or edited by preparation');
    // Only a real governed successor publication restores a reviewable packet. It does not
    // borrow a review, approval or human disposition from the retained generation.
    cli(root, 'phase', 'publish', phaseId, '--authored', 'human', '--channel', 'manual-in-place',
      '--external-ai', 'none', '--no-model', '--json');
    const successor = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
    assert.equal(successor.generation, 2);
    assert.equal(successor.canReview, true);
    assert.equal(successor.binding.generation, 2);
    assert.match(successor.stagingPath, /gen2\.json$/);
    assert.equal(successor.continuation.nextSkill, '/sf-review-source');
    assert.notEqual(git(root, 'rev-parse', 'HEAD'), head);
  });
});

test('real Story CLI retains pinned reviewer report and separate human disposition before submission', async (t) => {
  const { root, authorAgent } = await publishedSpecificationStory(t);
  const packet = JSON.parse(cli(root, 'review-source', 'context', 'specification', '--json'));
  assert.equal(packet.requiredReviewerAgentId, 'sflow-source-reviewer');
  assert.equal(packet.binding.generation, 1);
  assert.equal(packet.reviewer.setupRequired, false);
  assert.equal(packet.reviewer.activation, 'automatic');
  assert.equal(packet.artifact.sha256Domain, 'authored-content');
  assert.equal(packet.artifact.integrity.registeredFileMatches, true);
  assert.match(packet.reviewer.instructions, /Source-grounded reviewer/);
  const report = reviewReport(packet);
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  const beforeCheck = git(root, 'rev-parse', 'HEAD');
  const checked = JSON.parse(cli(root, 'review-source', 'check', 'specification', '--report-file', packet.stagingPath, '--json'));
  assert.equal(checked.format.status, 'ready');
  assert.equal(checked.retentionReady, true);
  assert.equal(checked.status, 'correction-required', 'a preflight never grants the pending human decision');
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeCheck);
  assert.equal(git(root, 'status', '--short'), '');
  const authorSession = await loadSession(root);
  const submitted = JSON.parse(cli(root, 'review-source', 'submit', 'specification',
    '--report-file', packet.stagingPath, '--json'));
  assert.equal(submitted.status, 'correction-required');
  assert.deepEqual(await loadSession(root), authorSession, 'review retention changed the shared phase author');
  assert.deepEqual(submitted.pendingDispositions.map((entry) => entry.id), ['exclusion:export-exclusion']);
  const pending = JSON.parse(cli(root, 'review-source', 'status', 'specification', '--json'));
  assert.equal(pending.reportSha256, submitted.reportSha256);
  cli(root, 'agent', '--agent', 'sflow-source-reviewer');
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
  // A repository refresh changes today's authoring resources, not this Story's accepted ones.
  const file = path.join(root, 'singularity/workflow.yml');
  const current = YAML.parse(await readFile(file, 'utf8'));
  current.phases.specification.template = 'unavailable-new-spec.md';
  current.workTypes['spec-driven-standard'].templateOverrides.specification = 'unavailable-new-spec.md';
  await writeFile(file, YAML.stringify(current));
  await writeFile(path.join(root, '.github/agents/product-owner.agent.md'), '---\ninvalid: [\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'Refresh live authoring resources before Story submission');
  cli(root, 'submit', 'specification', '--skip-checks');
  const approval = spawnSync(process.execPath, [executable, 'approve', 'specification', '--yes'], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.equal(approval.status, 0, `approval after a ready review failed:\n${approval.stderr}\n${approval.stdout}`);
  assert.doesNotMatch(`${approval.stderr}\n${approval.stdout}`, /source review is stale/);
});

test('real CLI review requires acknowledgement of the human answers retained by generation publication', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t, { copied: true, humanAnswers: true });
  const packet = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
  assert.equal(packet.clarifications[0].phase, phaseId);
  assert.equal(packet.clarifications[0].responses[0].id, 'Q-005');
  assert.match(packet.clarifications[0].responses[0].answer, /one automated positive-value test/i);
  assert.equal(packet.binding.clarifications[0].sha256, packet.clarifications[0].sha256);
  const report = reviewReport(packet);
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, JSON.stringify(report));
  const before = git(root, 'rev-parse', 'HEAD');
  const refused = JSON.parse(cli(root, 'review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--json'));
  assert.equal(refused.retentionReady, false);
  assert.ok(refused.findings.some((entry) => entry.code === 'clarifications-not-all-reviewed'));
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  report.clarificationsReviewed = packet.clarifications.map((entry) => entry.id);
  await writeFile(packet.stagingPath, JSON.stringify(report));
  assert.equal(JSON.parse(cli(root, 'review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--json')).retentionReady, true);
  cli(root, 'review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--json');
  const retained = JSON.parse(cli(root, 'review-source', 'status', phaseId, '--json'));
  assert.deepEqual(retained.report.clarificationsReviewed, report.clarificationsReviewed);
  assert.deepEqual(retained.binding.clarifications, packet.binding.clarifications);
  assert.equal(retained.status, 'correction-required', 'reading an answer must not waive the separate exclusion');
  const decided = JSON.parse(cli(root, 'review-source', 'decide', phaseId,
    '--finding', 'exclusion:export-exclusion', '--reason', 'Confirmed outside requested scope.', '--json'));
  assert.equal(decided.status, 'ready');
  cli(root, 'submit', phaseId, '--skip-checks');
  const afterSubmission = JSON.parse(cli(root, 'review-source', 'status', phaseId, '--json'));
  assert.equal(afterSubmission.status, 'ready', 'submission metadata must preserve the clarification-bound review');
  assert.deepEqual(afterSubmission.binding.clarifications, packet.binding.clarifications);
  const approval = spawnSync(process.execPath, [executable, 'approve', phaseId, '--yes'], {
    cwd: root, encoding: 'utf8', timeout: 30000
  });
  assert.equal(approval.status, 0, `approval with pinned answers failed:\n${approval.stderr}\n${approval.stdout}`);
  assert.doesNotMatch(`${approval.stderr}\n${approval.stdout}`, /source review is stale/);
});

test('a copied specification is reviewed and rejected using its accepted contract after live resources change [E2G-001]', async (t) => {
  const { root, phaseId, authorAgent, workType } = await publishedSpecificationStory(t, { copied: true });
  assert.equal(phaseId, 'specification-spec-driven-standard');
  const packet = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
  // The report template once carried the step's name as its kind, which the evaluator compares with
  // what the step does, so every review of a renamed step was refused as an invalid contract.
  assert.equal(packet.kind, 'specification');
  assert.equal(packet.reportTemplate.kind, 'specification');
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, `${JSON.stringify(reviewReport(packet), null, 2)}\n`);
  assert.equal(JSON.parse(cli(root, 'review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--json')).retentionReady, true);
  const submitted = JSON.parse(cli(root, 'review-source', 'submit', phaseId, '--report-file', packet.stagingPath, '--json'));
  assert.equal(submitted.status, 'correction-required');
  assert.deepEqual(submitted.pendingDispositions.map((entry) => entry.id), ['exclusion:export-exclusion']);
  cli(root, 'agent', '--agent', authorAgent);
  const decided = JSON.parse(cli(root, 'review-source', 'decide', phaseId,
    '--finding', 'exclusion:export-exclusion', '--reason', 'Confirmed outside requested scope.', '--json'));
  assert.equal(decided.status, 'ready');
  const file = path.join(root, 'singularity/workflow.yml');
  const current = YAML.parse(await readFile(file, 'utf8'));
  current.phases[phaseId].defaultTemplate = 'unavailable-copy.md';
  current.workTypes[workType].templateOverrides ??= {};
  current.workTypes[workType].templateOverrides[phaseId] = 'unavailable-copy.md';
  await writeFile(file, YAML.stringify(current));
  await writeFile(path.join(root, '.github/agents/product-owner.agent.md'), '---\ninvalid: [\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'Refresh live copied-step resources before submission');
  cli(root, 'submit', phaseId, '--skip-checks');
  cli(root, 'reject', phaseId, '--to', phaseId, '--reason', 'Revise the agreed specification.');
});

test('malformed reviewer packets are diagnosed read-only and cannot be committed by bypassing check', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const packet = JSON.parse(cli(root, 'review-source', 'context', phaseId, '--json'));
  const authorSession = await loadSession(root);
  const report = reviewReport(packet);
  report.findings = [{ id: 'review-gap', severity: 'high', explanation: 'A real gap should use blocking and message.' }];
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  const head = git(root, 'rev-parse', 'HEAD');
  const index = git(root, 'write-tree');
  const tracked = git(root, 'status', '--porcelain');
  const checked = JSON.parse(cli(root, 'review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--json'));
  assert.equal(checked.retentionReady, false);
  assert.ok(checked.findings.some((entry) => entry.field === 'findings[0].severity'));
  assert.ok(checked.findings.some((entry) => entry.field === 'findings[0].message'));
  const submit = spawnSync(process.execPath, [executable, 'review-source', 'submit', phaseId,
    '--report-file', packet.stagingPath, '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(submit.status, 0);
  const refusal = JSON.parse(submit.stdout);
  assert.equal(refusal.error.code, 'SOURCE_REVIEW_REPORT_INVALID');
  assert.match(submit.stdout, /findings\[0\]\.message/u);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'write-tree'), index);
  assert.equal(git(root, 'status', '--porcelain'), tracked);
  assert.deepEqual(await loadSession(root), authorSession, 'failed retention changed the phase author');
  assert.equal(JSON.parse(cli(root, 'review-source', 'status', phaseId, '--json')).status, 'missing');
});

test('reviewer cannot prepare or publish a phase under shared authorship, before any Git mutation', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t, { copied: true });
  cli(root, 'agent', '--agent', 'sflow-source-reviewer');
  const head = git(root, 'rev-parse', 'HEAD');
  const tracked = git(root, 'status', '--porcelain');
  for (const args of [['prepare', phaseId], ['phase', 'publish', phaseId,
    '--authored', 'governed-agent', '--channel', 'copilot-host']]) {
    const result = spawnSync(process.execPath, [executable, ...args, '--json'],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /read-only source reviewer/u);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.equal(git(root, 'status', '--porcelain'), tracked);
  }
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
