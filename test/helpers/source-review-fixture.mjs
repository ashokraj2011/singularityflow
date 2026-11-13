import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../../src/config.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../../src/manual-authorship.mjs';
import { withOperationContext } from '../../src/operation-context.mjs';
import { loadSession, setAgentSession } from '../../src/session.mjs';
import { recordClarificationResponses } from '../../src/clarifications.mjs';
import { snapshot } from '../../src/util.mjs';
import {
  commitAndPublish, createWorkflow, loadConfig, publishGeneration, scanArtifacts
} from '../../src/state.mjs';

const WORK_ID = 'REVIEW-1';
const ACTOR = { name: 'Review Driver', email: 'review-driver@example.test' };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

/**
 * A spec-driven Story whose scope step has a published specification awaiting its independent
 * source review. With `copied`, the step is the workflow's own copy, made in Workflow Studio under
 * a name of its own.
 */
export async function publishedSpecificationStory(t, { copied = false, humanAnswers = false, notes = 'Export is out of scope.' } = {}) {
  const workType = copied ? 'review-copy' : 'spec-driven-standard';
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-source-cli-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.longpaths', 'true');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Review fixture\n');
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const authored = YAML.parse(await readFile(workflowFile, 'utf8'));
  authored.git.publish = 'off';
  authored.session.workItemSelection = 'reuse';
  if (humanAnswers) authored.worldModel.grounding = 'off';
  for (const authority of Object.values(authored.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  for (const phase of Object.values(authored.phases ?? {})) {
    if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  }
  await writeFile(workflowFile, YAML.stringify(authored));
  if (copied) {
    const { planStudioChangeSet } = await import('../../src/workflow-studio.mjs');
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
      notes },
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
## Scenario coverage
| Clause | Scenario | Outcome |
|---|---|---|
| ${WORK_ID}:REQ-001 | S1 | success |
| ${WORK_ID}:AC-001 | S1 | success |
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
export function reviewReport(packet) {
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


