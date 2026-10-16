import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig, preparePhaseInputs } from '../src/state.mjs';
import { buildSpecIndex } from '../src/specifications.mjs';
import { setAgentSession, restoreAgentSession } from '../src/session.mjs';
import { resolveOperation, operationCatalog } from '../src/command-registry.mjs';
import { phaseAgentResult } from '../src/phase-agent-result.mjs';
import { snapshot } from '../src/util.mjs';
import { validatePhaseEntryRequest } from '../src/commands/phase.mjs';
import { validateAgentEntryRequest } from '../src/agent-entry-options.mjs';
import { phaseContextAdmission, phaseAdmissionActions } from '../src/phase-entry-admission.mjs';
import { agentPacketPresentation } from '../src/agent-packet-presentation.mjs';
import { completeAgentResult, withAgentRoutes } from '../src/agent-output.mjs';
import { librarySkillText } from '../src/skill-library.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, { planningInputs = false, customPhase = null, clarificationActor = false, attachedSkill = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Phase Entry Tester');
  git(root, 'config', 'user.email', 'entry@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Entry fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const source = YAML.parse(await readFile(file, 'utf8'));
  source.workItemRoot = 'team/stories';
  source.session.workItemSelection = 'reuse';
  if (clarificationActor) source.approvalAuthorities['product-approvers'].members = [{ email: 'entry@example.invalid' }];
  if (planningInputs) source.workTypes['spec-driven-standard'].phaseOverrides.planning.inputs = [
    { phase: 'specification', projection: 'full' }
  ];
  if (customPhase) {
    source.phases[customPhase] = {
      ...structuredClone(source.phases.specification), artifactSet: undefined,
      specificationQuality: undefined, label: 'Team-owned discovery',
      artifact: { path: `artifacts/${customPhase}/discovery.md`, kind: 'requirements', minimumBytes: 100 },
      approval: { authorities: ['product-approvers'], minimum: 1, rejectTo: [customPhase] }
    };
    source.workTypes['team-owned-workflow'] = {
      label: 'Team-owned workflow', phases: [customPhase],
      omits: ['scope', 'plan', 'implement', 'verify'].map(responsibility => ({ responsibility,
        reason: 'A conversation-only fixture with no repository delivery.', authority: 'product-approvers' }))
    };
    const agentFile = path.join(root, '.github/agents/product-owner.agent.md');
    await writeFile(agentFile, (await readFile(agentFile, 'utf8'))
      .replace('sflow-phases: "intake,', `sflow-phases: "${customPhase},intake,`)
      .replace('sflow-default-for: "intake,', `sflow-default-for: "${customPhase},intake,`));
  }
  if (attachedSkill) {
    // The step's default agent attaches a skill from the skill master: the first step, or planning.
    const [agent, step] = customPhase ? ['product-owner', customPhase] : ['architect', 'planning'];
    const agentFile = path.join(root, `.github/agents/${agent}.agent.md`);
    await writeFile(agentFile, `${await readFile(agentFile, 'utf8')}\n## Attached skills\n\n| Skill | Phases | When to use it |\n|---|---|---|\n| ${attachedSkill} | ${step} | Before drafting the step |\n`);
    await mkdir(path.join(root, 'singularity/skill-library', attachedSkill), { recursive: true });
    await writeFile(path.join(root, 'singularity/skill-library', attachedSkill, 'SKILL.md'), librarySkillText({ id: attachedSkill,
      description: 'Lists what a step must settle before drafting.', instructions: '1. Name the system under test.\n2. List the risks.' }));
  }
  await writeFile(file, YAML.stringify(source));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture authority');
  git(root, 'switch', '-c', 'ENTRY-1');
  const config = await loadConfig(root);
  const workType = customPhase ? 'team-owned-workflow' : 'spec-driven-standard';
  const resolved = resolveWorkType(config, workType);
  const workflow = await createWorkflow(root, config, {
    id: 'ENTRY-1', title: 'Bundle verified phase context', baseBranch: 'main',
    workType, agent: 'product-owner', resolved,
    source: { type: 'manual', key: 'ENTRY-1', title: 'Bundle verified phase context',
      description: 'Preserve phase checks while reducing repeated tool calls.',
      acceptanceCriteria: ['The phase entry operation never advances the Story.'] }
  });
  if (planningInputs) {
    // Internal fixture state, not an approval operation: tests start at an approved input boundary.
    const producer = workflow.phases.specification;
    const relative = `team/stories/ENTRY-1/${producer.requiredArtifact.path}`;
    await writeFile(path.join(root, relative), '# Approved specification\n\n[ENTRY-1:REQ-001] Preserve exact input identity.\n');
    Object.assign(producer, { status: 'approved', generation: 1,
      artifacts: [{ path: relative, status: 'approved', ...await snapshot(path.join(root, relative)) }] });
    workflow.currentPhase = 'planning';
    workflow.phases.planning.status = 'in_progress';
    await writeFile(path.join(root, 'team/stories/ENTRY-1/workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
  }
  await setAgentSession(root, config, { name: 'Phase Entry Tester', email: 'entry@example.invalid' },
    workflow.phases[workflow.currentPhase].defaultAgent, 'ENTRY-1', {
      phaseId: workflow.currentPhase, source: 'test'
    });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accepted Story closure');
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, '.git/mode-not-set.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/no-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/no-registry.json') };
  // These tests assert model-mode routes; the no-model case passes --no-model itself. An inherited
  // SINGULARITY_FLOW_NO_MODEL=1 (a no-model test runner, or a developer's shell) turned preparation
  // into a human import and failed three of them.
  delete env.SINGULARITY_FLOW_NO_MODEL;
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000
  });
  return { root, workflow, config, invoke };
}

test('CLI preparation is an unpublished authoring checkpoint, not a completed template or publication', async t => {
  const item = await fixture(t, { customPhase: 'team-discovery' });
  const before = git(item.root, 'rev-parse', 'HEAD');
  const prepared = item.invoke('prepare', 'team-discovery', '--json');
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const result = completeAgentResult(prepared.stdout);
  assert.equal(result.data.preparation.stage, 'prepared');
  assert.equal(result.data.preparation.producer, 'governed-agent');
  assert.equal(result.data.preparation.authoringRequired, true);
  assert.match(result.data.preparation.instruction, /native file-edit tool/);
  assert.equal(result.effects.publicationCreated, false);
  // Preparation already ran; its terminal route checks the draft once it is written, never prepares again.
  assert.equal(result.next[0].command, 'singularity-flow phase prepublish team-discovery');
  assert.equal(result.next[0].copilotCommand, '/sf-phase');
  const draftPath = path.join(item.root, result.data.preparation.path);
  const draft = await readFile(draftPath, 'utf8');
  assert.match(draft, /TODO|<requirement>/);
  const checked = item.invoke('phase', 'prepublish', 'team-discovery', '--for-agent', '--json');
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const check = completeAgentResult(checked.stdout);
  assert.equal(check.status, 'correction-required');
  assert.equal(check.commands.publish, null);
  const state = JSON.parse(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'));
  assert.equal(state.phases['team-discovery'].generation, 0);
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before, 'no commit or publication is implied');
  assert.equal(await readFile(draftPath, 'utf8'), draft, 'readiness inspection preserves draft bytes');
});

test('entry and nextsteps resume an authored custom draft at prepublish without repeating preparation', async t => {
  const item = await fixture(t, { customPhase: 'team-resume' });
  const prepared = item.invoke('prepare', 'team-resume', '--json');
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const draft = path.join(item.root, completeAgentResult(prepared.stdout).data.preparation.path);
  const existing = await readFile(draft, 'utf8');
  await writeFile(draft, existing + '\n## Authored outcome\nThe current discovery records the user request and remaining verification obligations.\n');
  const entry = item.invoke('phase', 'enter', '--for-agent', '--json');
  assert.equal(entry.status, 0, entry.stderr || entry.stdout);
  const packet = completeAgentResult(entry.stdout);
  assert.equal(packet.authoringProgress.stage, 'validate-existing-draft');
  assert.equal(packet.codeAuthoringReady, false, 'a document phase has no product-source permission');
  assert.equal(packet.authoringProgress.next.command, 'singularity-flow phase prepublish team-resume --for-agent --json');
  const steps = item.invoke('nextsteps', '--for-agent', '--json');
  assert.equal(steps.status, 0, steps.stderr || steps.stdout);
  const next = completeAgentResult(steps.stdout);
  assert.equal(next.authoringProgress.stage, packet.authoringProgress.stage);
  assert.equal(next.mutationContract.toolProtocol.mode, 'kernel-only');
  assert.equal(next.mutationContract.codeAuthoringReady, false);
  assert.ok(next.actions.some(action => action.timing === 'now'
    && action.command === packet.authoringProgress.next.command));
  assert.equal(await readFile(draft, 'utf8'), existing + '\n## Authored outcome\nThe current discovery records the user request and remaining verification obligations.\n');
});

test('no-model preparation retains human ownership instead of instructing native agent edits', async t => {
  const item = await fixture(t, { customPhase: 'team-manual' });
  const prepared = item.invoke('prepare', 'team-manual', '--no-model', '--json');
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const result = completeAgentResult(prepared.stdout);
  assert.equal(result.data.preparation.stage, 'prepared');
  assert.equal(result.data.preparation.producer, 'human');
  assert.equal(result.data.preparation.authoringRequired, true);
  assert.match(result.data.preparation.instruction, /configured human or external-tool producer owns completion/);
  assert.doesNotMatch(result.data.preparation.instruction, /native file-edit tool/);
  assert.equal(result.effects.publicationCreated, false);
});

test('preparing a new plan scaffolds verified clauses while repeat preparation preserves the authored draft and prior approval', async t => {
  const item = await fixture(t, { planningInputs: true });
  const producer = item.workflow.phases.specification;
  const sourceRelative = `team/stories/ENTRY-1/${producer.requiredArtifact.path}`;
  const sourcePath = path.join(item.root, sourceRelative);
  const approvedText = '# Approved specification\n\n[ENTRY-1:REQ-001]\nPreserve exact input identity.\n\n[ENTRY-1:AC-001]\nThe approved result is returned.\n';
  await writeFile(sourcePath, approvedText);
  producer.artifacts = [{ path: sourceRelative, status: 'approved', ...await snapshot(sourcePath) }];
  const indexPath = 'team/stories/ENTRY-1/context/spec-indexes/specification-gen1.json';
  const index = await buildSpecIndex(item.root, sourceRelative, { workId: 'ENTRY-1', phase: 'specification',
    generation: 1, outputPath: indexPath, policy: item.workflow.resolution.spec });
  producer.specIndex = { generation: 1, path: indexPath, clauses: index.clauses.length,
    indexSha256: index.indexSha256, sourceSha256: index.source.sha256 };
  const approval = structuredClone(producer);
  const result = await preparePhaseInputs(item.root, item.config, item.workflow, 'planning');
  const file = path.join(item.root, result.path);
  const first = await readFile(file, 'utf8');
  for (const id of ['ENTRY-1:REQ-001', 'ENTRY-1:AC-001']) assert.ok(first.includes(`| [${id}] | - | TODO | - | TODO |`));
  const privateDraft = first.replace('| [ENTRY-1:REQ-001] | - | TODO | - | TODO |',
    '| [ENTRY-1:REQ-001] | `src/pay.js` | `test/pay.test.js` | modified | Preserves exact identity. |');
  await writeFile(file, privateDraft);
  await preparePhaseInputs(item.root, item.config, item.workflow, 'planning');
  assert.ok((await readFile(file, 'utf8')).includes('`src/pay.js`'));
  assert.equal(await readFile(sourcePath, 'utf8'), approvedText);
  assert.deepEqual(producer, approval);
  await writeFile(sourcePath, `${approvedText}\nAn unauthorized edit.\n`);
  // A changed immutable input remains an integrity failure, not a waiver of prior approvals.
  await assert.rejects(preparePhaseInputs(item.root, item.config, item.workflow, 'planning'), /hash|changed|approved|fingerprint/iu);
});

test('phase entry is a model-free read; composition is an explicit registered mutation', () => {
  for (const compose of [false, true]) {
    const operation = resolveOperation({ requestedCommand: 'phase', positionals: ['phase', 'enter'], options: { compose } });
    assert.equal(operation.id, compose ? 'phase.enter.compose' : 'phase.enter');
    assert.equal(operation.modelPolicy, 'never');
    assert.equal(operation.classification, compose ? 'mutation' : 'read');
    assert.deepEqual(operationCatalog().find(entry => entry.id === operation.id), operation);
  }
  assert.throws(() => validatePhaseEntryRequest({ positionals: ['phase', 'enter'],
    options: { 'allow-dirty': true } }), { code: 'PHASE_ENTRY_OPTIONS_INVALID' });
  assert.throws(() => validatePhaseEntryRequest({ positionals: ['phase', 'enter'],
    options: { compose: 'false' } }), /boolean flag/);
});

test('compact entry flags cannot bypass gates or accept ambiguous identities', () => {
  for (const command of ['inputs', 'nextsteps']) {
    const valid = { positionals: [command], options: { 'for-agent': true, json: true } };
    assert.doesNotThrow(() => validateAgentEntryRequest(command, valid));
    for (const options of [{ 'for-agent': true }, { 'for-agent': 'false', json: true },
      { ...valid.options, 'allow-dirty': true }, { ...valid.options, approve: true }]) {
      assert.throws(() => validateAgentEntryRequest(command, { ...valid, options }),
        { code: `${command.toUpperCase()}_OPTIONS_INVALID` });
    }
    assert.throws(() => validateAgentEntryRequest(command, { ...valid,
      positionals: [command, 'one', 'two'] }), /only one optional identity/);
  }
});

test('terminal agent routing retains completion actions without needing a drafting agent', async t => {
  const item = await fixture(t);
  const statePath = path.join(item.root, 'team/stories/ENTRY-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.currentPhase = null;
  state.status = 'completed';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await restoreAgentSession(item.root, null);
  const before = await readFile(statePath, 'utf8');
  const result = item.invoke('nextsteps', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packet = completeAgentResult(result.stdout);
  assert.equal(packet.ready, true);
  assert.equal(packet.phase, null);
  assert.equal(packet.inputs, null);
  assert.equal(packet.actions.find(action => action.timing === 'now').command,
    'singularity-flow gate --terminal');
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('entry bundles a custom-root Story without changing files, HEAD, index or lifecycle', async t => {
  const item = await fixture(t);
  const before = { head: git(item.root, 'rev-parse', 'HEAD'), status: git(item.root, 'status', '--porcelain=v1'),
    workflow: await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8') };
  const result = item.invoke('phase', 'enter', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = completeAgentResult(result.stdout);
  assert.equal(entry.resultType, 'sflow-phase-entry');
  assert.equal(entry.ready, true);
  assert.equal(entry.workId, 'ENTRY-1');
  assert.equal(entry.workItemRoot, 'team/stories');
  assert.equal(entry.repositoryPath, git(item.root, 'rev-parse', '--show-toplevel'));
  assert.equal(entry.phase, item.workflow.currentPhase);
  assert.equal(entry.phaseAgent.valid, true);
  assert.equal(entry.context, null);
  assert.equal(entry.contextComposition, 'not-requested');
  assert.equal(entry.contextAdmission.allowed, true);
  assert.deepEqual(entry.contextAdmission.blockers, []);
  assert.equal(entry.modelInvocations, 0);
  assert.equal(entry.effects.testsRun, false);
  assert.equal(entry.effects.storyAdvanced, false);
  assert.equal(entry.continuationReview.readOnly, true);
  assert.match(entry.continuationReview.commandGuidance.copilotCommand, /^\/sf-appeal resolve --work-id ENTRY-1/u);
  assert.match(entry.build.description, /^0\.9\.0/u);
  assert.ok(entry.recovery.planId);
  assert.ok(entry.authoring.policyVerified);
  assert.equal(entry.references.status, 'not-configured');
  assert.ok(['off', 'when-needed', 'required'].includes(entry.clarification.mode));
  assert.equal(entry.authoringAllowed, false, 'required answers remain mandatory before drafting');
  assert.equal(entry.clarification.checkpoint.stage, 'derive-questions');
  assert.equal(entry.clarification.checkpoint.questioningAllowed, true);
  assert.equal(entry.clarification.checkpoint.contextRequired, true);
  assert.equal(entry.clarification.checkpoint.recordAction, null, 'context must be reviewed before answer recording');
  assert.equal(entry.clarification.checkpoint.missingRecordMeansUnanswered, false);
  assert.equal(entry.next[0].agentAction, 'load-context');
  assert.equal(entry.next[0].copilotCommand, '/sf-phase');
  assert.equal(entry.next[0].command, 'singularity-flow phase enter specification --work-id ENTRY-1 --compose --for-agent --json');
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), before.status);
  assert.equal(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'), before.workflow);
});

test('a future user-created workflow composes a question-only checkpoint for its own phase name', async t => {
  const item = await fixture(t, { customPhase: 'team-discovery' });
  const statePath = path.join(item.root, 'team/stories/ENTRY-1/workflow.json');
  const before = await readFile(statePath, 'utf8');
  const result = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = completeAgentResult(result.stdout);
  assert.equal(entry.phase, 'team-discovery');
  assert.equal(entry.contextComposition, 'delivered');
  assert.equal(entry.authoringAllowed, false);
  assert.equal(entry.clarification.checkpoint.questioningAllowed, true);
  // Unanswered questions are this skill's own next step, not a hold it relays and stops on.
  assert.equal(entry.status, 'clarification-required');
  assert.match(entry.agentGuide.instruction, /Never relay the skill you are running as a next action/u);
  // One top-level field per line, so a host that saves a long result to a file can page it.
  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.length > 10, 'the agent packet pages by line');
  assert.ok(lines.includes('"status":"clarification-required",'), 'control fields are their own lines');
  assert.equal(entry.next[0].agentAction, 'derive-and-ask');
  assert.equal(entry.next[0].copilotCommand, '/sf-phase');
  assert.equal(entry.next[0].commandGuidance.copilotCommand, '/sf-phase');
  assert.equal(entry.next[0].commandGuidance.command, null, 'asking has no fabricated shell answer');
  assert.equal(entry.next[0].commandGuidance.copyable, false);
  assert.equal(entry.clarification.checkpoint.answerBinding.workId, 'ENTRY-1');
  assert.equal(entry.clarification.checkpoint.answerBinding.phase, 'team-discovery');
  assert.equal(entry.clarification.checkpoint.answerBinding.generation, entry.context.generation);
  // Answers bind to the composed prompt a clarification record keeps, not the personalized delivery.
  assert.equal(entry.clarification.checkpoint.answerBinding.promptSha256, entry.context.renderedSha256);
  assert.equal(entry.context.renderedSha256, entry.context.file.sha256);
  assert.ok(entry.context.file.path.endsWith(`/prompts/team-discovery-gen${entry.context.generation}.md`), entry.context.file.path);
  const recordAction = entry.clarification.checkpoint.recordAction;
  assert.equal(recordAction.requiresActualHumanReplies, true);
  assert.equal(recordAction.automatic, false);
  assert.deepEqual(recordAction.commandGuidance.argv, ['clarification', 'record', 'team-discovery',
    '--response-file', entry.clarification.responseStagingPath, '--for-agent', '--json'], 'the agent records replies through a bounded route');
  assert.equal(recordAction.commandGuidance.copilotCommand, '/sf-phase');
  assert.match(entry.context.text, /Formulating evidence-grounded questions is permitted/);
  assert.equal(await readFile(statePath, 'utf8'), before);
  assert.equal(entry.effects.testsRun, false);
  assert.equal(entry.effects.storyAdvanced, false);
});

test('CLI recording retries preserve the receipt and re-entry does not restart clarification', async t => {
  for (const customPhase of [null, 'team-discovery']) await t.test(customPhase ?? 'specification', async t => {
    const item = await fixture(t, { customPhase, clarificationActor: true });
    const invokeJson = (...args) => {
      const result = item.invoke(...args, '--json');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return completeAgentResult(result.stdout);
    };
    const entry = invokeJson('phase', 'enter', '--compose', '--for-agent');
    assert.equal(entry.authoringAllowed, false);
    const staging = entry.clarification.responseStagingPath;
    const replies = [{ question: 'Is this interpretation complete?', answer: 'Yes; preserve the existing work.' }];
    await mkdir(path.dirname(staging), { recursive: true });
    await writeFile(staging, JSON.stringify({ responses: replies }));
    const args = entry.clarification.checkpoint.recordAction.commandGuidance.argv.filter(arg => arg !== '--json');
    const first = invokeJson(...args);
    assert.equal(first.data.reused, false);
    assert.equal(first.effects.filesChanged, true);
    const receipt = path.join(item.root, first.data.path);
    const bytes = await readFile(receipt, 'utf8');
    const retry = invokeJson(...args);
    assert.equal(retry.data.reused, true);
    assert.equal(retry.effects.filesChanged, false);
    assert.equal(retry.data.sha256, first.data.sha256);
    assert.equal(await readFile(receipt, 'utf8'), bytes);
    const resumed = invokeJson('phase', 'enter', '--compose', '--for-agent');
    assert.equal(resumed.authoringAllowed, true);
    assert.equal(resumed.clarification.checkpoint.stage, 'complete');
    assert.equal(resumed.clarification.checkpoint.questioningAllowed, false);
    assert.equal(resumed.clarification.checkpoint.recordAction, null);
    assert.equal(resumed.context.deliveredSha256, entry.context.deliveredSha256);
    await writeFile(staging, JSON.stringify({ responses: [{ ...replies[0], answer: 'Different scope.' }] }));
    const conflict = item.invoke(...args, '--json');
    assert.notEqual(conflict.status, 0);
    assert.equal(completeAgentResult(conflict.stdout).error.code, 'CLARIFICATION_RESPONSE_CONFLICT');
    assert.equal(await readFile(receipt, 'utf8'), bytes);
    assert.match(await readFile(staging, 'utf8'), /Different scope/);
  });
});

test('a question that arises after the checkpoint joins the same record until the step\'s limit', async t => {
  const item = await fixture(t, { clarificationActor: true });
  const invokeJson = (...args) => {
    const result = item.invoke(...args, '--json');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return completeAgentResult(result.stdout);
  };
  const entry = invokeJson('phase', 'enter', '--compose', '--for-agent');
  const staging = entry.clarification.responseStagingPath;
  const stage = async (question) => {
    await mkdir(path.dirname(staging), { recursive: true });
    await writeFile(staging, JSON.stringify({ responses: [{ question, answer: `Answered: ${question}` }] }));
  };
  assert.equal(entry.clarification.checkpoint.newQuestionAction, null, 'the first questions use the checkpoint itself');
  await stage('Is this interpretation complete?');
  invokeJson(...entry.clarification.checkpoint.recordAction.commandGuidance.argv.filter(arg => arg !== '--json'));

  let resumed = invokeJson('phase', 'enter', '--compose', '--for-agent');
  const { maxQuestions } = resumed.clarification.checkpoint;
  assert.ok(maxQuestions >= 2, 'the fixture step allows a later question');
  for (let recorded = 1; recorded < maxQuestions; recorded += 1) {
    const checkpoint = resumed.clarification.checkpoint;
    assert.equal(checkpoint.stage, 'complete');
    assert.equal(checkpoint.questioningAllowed, false, 'settled questions are not asked again');
    assert.equal(checkpoint.recordAction, null);
    assert.equal(checkpoint.remainingQuestions, maxQuestions - recorded);
    assert.equal(checkpoint.newQuestionAction.requiresActualHumanReplies, true);
    assert.deepEqual(checkpoint.newQuestionAction.commandGuidance.argv,
      ['clarification', 'record', 'specification', '--response-file', staging, '--for-agent', '--json']);
    await stage(`Later question ${recorded}?`);
    const added = invokeJson(...checkpoint.newQuestionAction.commandGuidance.argv.filter(arg => arg !== '--json'));
    assert.equal(added.outcome.slots.responses, recorded + 1, 'earlier answers are kept');
    resumed = invokeJson('phase', 'enter', '--compose', '--for-agent');
  }
  assert.equal(resumed.authoringAllowed, true, 'a later question never reopens the checkpoint');
  assert.equal(resumed.clarification.checkpoint.remainingQuestions, 0);
  assert.equal(resumed.clarification.checkpoint.newQuestionAction, null, 'at the limit the route is upstream, not another question');
});

test('session agent entry retains the verified custom-root binding with no Story mutation', async t => {
  const item = await fixture(t);
  const original = await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8');
  const before = git(item.root, 'rev-parse', 'HEAD');
  const full = item.invoke('session', 'current', '--json');
  const agent = item.invoke('session', 'current', '--for-agent', '--json');
  assert.equal(agent.status, 0, agent.stdout + agent.stderr);
  const packet = completeAgentResult(agent.stdout);
  for (const [key, value] of Object.entries(completeAgentResult(full.stdout))) assert.deepEqual(packet[key], value, key);
  assert.equal(packet.resultType, 'sflow-session-entry');
  assert.equal(packet.paused, false);
  assert.equal(packet.workItemRoot, 'team/stories');
  assert.equal(packet.workId, 'ENTRY-1');
  assert.match(packet.agentInstruction, /Operation-specific readiness and human confirmations remain required/);
  assert.match(packet.agentInstruction, /literally[^.]*never in artifacts or approval identity/);
  assert.equal(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'), original);
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('entry never interprets an explicit other Story or historical phase as selection', async t => {
  const item = await fixture(t);
  for (const [args, code] of [
    [['phase', 'enter', '--work-id', 'OTHER-1', '--compose', '--json'], 'ACTIVE_SUBJECT_MISMATCH'],
    [['phase', 'enter', 'release', '--compose', '--json'], 'PHASE_DRAFT_NOT_ACTIVE']
  ]) {
    const result = item.invoke(...args);
    assert.notEqual(result.status, 0);
    const refusal = completeAgentResult(result.stdout);
    assert.equal(refusal.error.code, code, result.stderr || result.stdout);
  }
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('nextsteps agent entry returns one verified binding without changing the custom-root Story', async t => {
  const item = await fixture(t);
  const before = await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8');
  const result = item.invoke('nextsteps', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packet = completeAgentResult(result.stdout);
  assert.equal(packet.resultType, 'sflow-nextsteps');
  assert.equal(packet.ready, true);
  assert.equal(packet.phaseAgent.valid, true);
  assert.equal(packet.repositoryPath, git(item.root, 'rev-parse', '--show-toplevel'));
  assert.equal(packet.workItemRoot, 'team/stories');
  assert.equal(packet.actions.find(action => action.timing === 'now').copilotCommand, '/sf-phase');
  assert.equal(packet.actions.some(action => action.timing === 'then'), false);
  assert.equal(packet.continuation, undefined, 'the initial router must not duplicate its action list');
  assert.equal(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'), before);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
  const mismatch = item.invoke('nextsteps', 'OTHER-1', '--for-agent', '--json');
  assert.notEqual(mismatch.status, 0);
  assert.equal(completeAgentResult(mismatch.stdout).error.code, 'ACTIVE_SUBJECT_MISMATCH');
});

test('inputs agent preview and recording return exact artifacts and canonical continuation without publication', async t => {
  const item = await fixture(t);
  const before = git(item.root, 'rev-parse', 'HEAD');
  const preview = item.invoke('inputs', '--dry-run', '--for-agent', '--json');
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const inspected = completeAgentResult(preview.stdout);
  assert.equal(inspected.ready, true);
  assert.equal(inspected.phaseGeneration, 0);
  assert.equal(inspected.generation, 1);
  assert.equal(inspected.artifact.status, 'not-written');
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
  const result = item.invoke('inputs', inspected.phase, '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const recorded = completeAgentResult(result.stdout);
  assert.equal(recorded.phaseGeneration, 0);
  assert.equal(recorded.generation, 1);
  assert.equal(recorded.artifact.status, 'rendered');
  assert.equal(recorded.artifact.managedBlock.matchesRendered, true);
  assert.match(recorded.artifact.path, /^team\/stories\/ENTRY-1\/artifacts\//);
  const next = item.invoke('nextsteps', '--for-agent', '--json');
  assert.equal(next.status, 0, next.stderr || next.stdout);
  assert.deepEqual(recorded.continuation.nextAction, completeAgentResult(next.stdout).actions.find(action => action.timing === 'now'));
  assert.equal(recorded.continuation.actions.some(action => action.timing === 'then'), false);
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before);
  const state = JSON.parse(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'));
  assert.equal(state.phases[inspected.phase].generation, 0);
  assert.equal(state.phases[inspected.phase].status, 'in_progress');
});

test('inputs agent entry cannot write historical phases or operate without its active agent', async t => {
  const item = await fixture(t);
  const historical = item.invoke('inputs', 'release', '--for-agent', '--json');
  assert.notEqual(historical.status, 0);
  assert.equal(completeAgentResult(historical.stdout).error.code, 'PHASE_DRAFT_NOT_ACTIVE');
  await restoreAgentSession(item.root, null);
  const result = item.invoke('inputs', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(completeAgentResult(result.stdout).ready, false);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('enforced inputs go straight to authoring, whose prepare renders them; direct recording keeps exact custom-root paths', async t => {
  const item = await fixture(t, { planningInputs: true });
  const before = git(item.root, 'rev-parse', 'HEAD');
  const initial = item.invoke('nextsteps', '--for-agent', '--json');
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  const packet = completeAgentResult(initial.stdout);
  // Preparation renders and records the same inputs, so a separate input turn would add nothing.
  assert.ok(packet.actions.some(action => action.timing === 'now' && action.command === 'singularity-flow prepare planning'));
  assert.equal(packet.actions.some(action => action.command === 'singularity-flow inputs planning'), false);
  assert.equal(packet.inputs, null);
  const dryRun = item.invoke('inputs', 'planning', '--dry-run', '--json');
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  const previewed = completeAgentResult(dryRun.stdout);
  assert.equal(previewed.records[0].status, 'captured');
  assert.equal(previewed.records[0].repositoryPath,
    'team/stories/ENTRY-1/artifacts/specification/spec.md');
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
  const recorded = item.invoke('inputs', 'planning', '--for-agent', '--json');
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
  const result = completeAgentResult(recorded.stdout);
  assert.equal(result.artifact.managedBlock.matchesRendered, true);
  assert.equal(result.audit.path, 'team/stories/ENTRY-1/context/inputs-planning-gen1.json');
  assert.equal(result.continuation.nextAction.copilotCommand, '/sf-phase');
  assert.equal(result.phaseGeneration, 0);
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before);
  const full = item.invoke('nextsteps', '--json');
  const preview = item.invoke('inputs', 'planning', '--dry-run', '--json');
  assert.equal(full.status, 0, full.stderr || full.stdout);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.deepEqual(completeAgentResult(preview.stdout).continuation.nextAction,
    completeAgentResult(full.stdout).actions.find(action => action.timing === 'now'));
});

test('an input preview never authorizes stale approved bytes, at recording or at preparation', async t => {
  const item = await fixture(t, { planningInputs: true });
  const initial = item.invoke('inputs', 'planning', '--dry-run', '--json');
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  assert.equal(completeAgentResult(initial.stdout).records[0].status, 'captured');
  await writeFile(path.join(item.root, 'team/stories/ENTRY-1/artifacts/specification/spec.md'), '# Unreviewed edit\n');
  const before = await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8');
  const result = item.invoke('inputs', 'planning', '--for-agent', '--json');
  assert.notEqual(result.status, 0);
  assert.match(completeAgentResult(result.stdout).error.message, /approved hash|inputs are not ready/);
  const prepared = item.invoke('prepare', 'planning', '--json');
  assert.notEqual(prepared.status, 0, 'preparation renders the same inputs and refuses the same stale bytes');
  assert.match(prepared.stdout + prepared.stderr, /approved hash|inputs are not ready/);
  assert.equal(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'), before);
});

test('a missing session only returns its verified attach route, never composes context', async t => {
  const item = await fixture(t);
  await restoreAgentSession(item.root, null);
  const result = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = completeAgentResult(result.stdout);
  assert.equal(entry.status, 'binding-required');
  assert.equal(entry.ready, false);
  assert.equal(entry.authoringAllowed, false);
  assert.equal(entry.contextAdmission.blockers[0].code, 'PHASE_CONTEXT_BINDING_REQUIRED');
  assert.equal(entry.context, null);
  assert.equal(entry.phaseAgent.valid, false);
  assert.equal(entry.phaseAgent.reason, 'active-session-missing');
  assert.equal(entry.next.length, 1);
  assert.equal(entry.next[0].command, entry.phaseAgent.handoff.command);
  assert.ok(Object.hasOwn(entry.next[0], 'copilotCommand'), 'entry exposes verified command routing instead of making the model guess');
  assert.equal(entry.next[0].command, 'singularity-flow session attach ENTRY-1 --json');
  assert.equal(entry.next[0].copilotCommand, '/sf-session');
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('manual worktree review prevents composition while preserving changes and exact actions', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, 'README.md'), '# Unrelated native work\n');
  const result = item.invoke('phase', 'enter', '--compose', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = completeAgentResult(result.stdout);
  assert.equal(entry.authoringAllowed, false);
  assert.equal(entry.context, null);
  assert.equal(entry.contextComposition, 'not-admitted');
  assert.equal(entry.contextAdmission.allowed, false);
  assert.equal(entry.clarification.checkpoint.questioningAllowed, false,
    'missing answers cannot override a worktree/integrity admission boundary');
  assert.equal(entry.clarification.checkpoint.nextAction, null);
  assert.equal(entry.clarification.checkpoint.recordAction, null, 'a recording route cannot override failed admission');
  assert.deepEqual(entry.contextAdmission.blockers.map(item => item.code), ['PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED']);
  assert.deepEqual(entry.contextAdmission.blockers[0].paths, ['README.md']);
  // The person's routes lead: what is held, then setting it aside; the read-only inspection follows.
  assert.equal(entry.next[0].id, 'working-tree');
  assert.equal(entry.next[1].id, 'set-aside-worktree');
  assert.match(entry.next[1].command, /--set-aside --confirm sha256:[0-9a-f]{64}/);
  const inspection = entry.next.at(-1);
  assert.equal(inspection.scope, 'read-only');
  assert.equal(inspection.copilotCommand, `/sf-appeal resolve --work-id ENTRY-1 --phase ${item.workflow.currentPhase} --json`);
  assert.ok(entry.recovery.actions.some(action => action.id === 'working-tree' && action.confirmation === 'human-authority'));
  assert.equal(await readFile(path.join(item.root, 'README.md'), 'utf8'), '# Unrelated native work\n');
});

test('composition admission distinguishes repairable draft findings from the real human boundary', () => {
  const authoring = { entry: { status: 'authoring-entry' }, policyVerified: true, effectiveAuthoringSkill: '/sf-code' };
  const recovery = { requiresRecovery: false, blockers: [{ code: 'code.delivery.incomplete' }], actions: [
    { id: 'complete-code-delivery:custom-build', confirmation: 'none' },
    { id: 'working-tree', confirmation: 'human-authority', unexpectedPaths: ['team/stories/E/evidence/screen.png'] },
    { id: 'review-evidence-contract:custom-build:screen.png', command: 'review exact contract' },
    { id: 'commit-reviewed-worktree' }
  ] };
  const admission = phaseContextAdmission({ authoring, recovery });
  assert.deepEqual(admission.blockers.map(item => item.code), ['PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED']);
  assert.deepEqual(admission.blockers[0].paths, ['team/stories/E/evidence/screen.png']);
  assert.deepEqual(phaseAdmissionActions(recovery.actions, admission, { authoring, recovery }).map(action => action.id),
    ['review-evidence-contract:custom-build:screen.png', 'working-tree', 'complete-code-delivery:custom-build', 'commit-reviewed-worktree']);
  const owned = { ...recovery, actions: [{ id: 'working-tree', confirmation: 'none' }] };
  assert.equal(phaseContextAdmission({ authoring, recovery: owned }).allowed, true, 'incomplete owned drafts can be composed for repair');
  assert.equal(recovery.actions[0].id, 'complete-code-delivery:custom-build', 'presentation never changes the recovery plan');
});

test('admission diagnostics preserve every existing composition guard for arbitrary phases', () => {
  for (const bits of Array.from({ length: 64 }, (_, index) => index)) {
    const entry = Boolean(bits & 1), deterministic = Boolean(bits & 2), verified = Boolean(bits & 4);
    const recoveryRequired = Boolean(bits & 8), decision = Boolean(bits & 16), referencesBlocked = Boolean(bits & 32);
    const authoring = { entry: { status: entry ? 'authoring-entry' : 'retained-generation' },
      policyVerified: verified, effectiveAuthoringSkill: '/sf-code' };
    const recovery = { requiresRecovery: recoveryRequired, actions: decision
      ? [{ id: 'working-tree', confirmation: 'human-authority' }] : [] };
    const actual = phaseContextAdmission({ authoring, recovery, deterministic,
      references: { status: referencesBlocked ? 'blocked' : 'not-configured' } });
    assert.equal(actual.allowed, entry && !deterministic && verified && !recoveryRequired && !decision && !referencesBlocked);
    assert.equal(actual.allowed, actual.blockers.length === 0);
  }
  assert.equal(phaseContextAdmission({ authoring: { entry: { status: 'authoring-entry' }, policyVerified: true } }).allowed, false);
});

test('pending evidence permits draft composition only, never recovery or authority bypass', () => {
  const authoring = { entry: { status: 'authoring-entry' }, policyVerified: true, effectiveAuthoringSkill: '/sf-code' };
  const continuation = { allowed: true, status: 'draft-only', evidenceAccepted: false,
    publicationReviewRequired: true, heldEvidence: [{ path: 'team/stories/E/evidence/screen.png' }] };
  const recovery = { requiresRecovery: false, actions: [{ id: 'working-tree', confirmation: 'human-authority',
    authoringContinuation: continuation }] };
  const admitted = phaseContextAdmission({ authoring, recovery });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.pendingEvidence, continuation);
  for (const overrides of [{ authoring: { ...authoring, policyVerified: false } },
    { authoring: { ...authoring, entry: { status: 'retained-generation' } } },
    { recovery: { ...recovery, requiresRecovery: true } }, { references: { status: 'blocked' } },
    { deterministic: true }]) assert.equal(phaseContextAdmission({ authoring, recovery, ...overrides }).allowed, false);
});

test('explicit entry composition returns the governed prompt once and reuses immutable bytes', async t => {
  const item = await fixture(t);
  const before = git(item.root, 'rev-parse', 'HEAD');
  const result = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = completeAgentResult(result.stdout);
  assert.equal(entry.contextComposition, 'delivered', JSON.stringify(entry.recovery));
  assert.equal(entry.authoringAllowed, false);
  assert.equal(entry.clarification.checkpoint.questioningAllowed, true);
  assert.equal(entry.clarification.checkpoint.contextRequired, false);
  assert.equal(entry.next[0].agentAction, 'derive-and-ask');
  assert.equal(entry.next[0].command, null, 'asking questions is not a fabricated shell command');
  assert.equal(entry.next[0].copilotCommand, '/sf-phase');
  assert.equal(entry.next[0].modelFreeCommand, null);
  assert.match(entry.context.text, /Bundle verified phase context/);
  const promptPath = path.join(item.root, 'team/stories/ENTRY-1/context/prompts', `${entry.phase}-gen1.md`);
  const initial = await readFile(promptPath, 'utf8');
  const again = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(again.status, 0, again.stderr || again.stdout);
  const reused = completeAgentResult(again.stdout);
  assert.equal(reused.contextComposition, 'delivered', JSON.stringify(reused.recovery));
  assert.equal(reused.context.text, entry.context.text);
  assert.equal(await readFile(promptPath, 'utf8'), initial);
  assert.match(again.stderr, /Grounding composition reused/);
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before);
  const workflow = JSON.parse(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'));
  assert.equal(workflow.phases[entry.phase].generation, 0);
  assert.equal(workflow.phases[entry.phase].status, 'in_progress');
  assert.equal(reused.effects.testsRun, false);
});

// Composing for an agent that attaches a skill also writes the skills audit (context/agents-<step>-gen<N>.json).
// Re-entry read it as somebody else's work and held the step for human review before any authoring.
test('a step whose agent attaches a skill re-enters its own composed context without a review hold', async t => {
  for (const [label, options] of [['first step', { customPhase: 'qa-intake' }], ['later step', { planningInputs: true }]]) await t.test(label, async t => {
    const item = await fixture(t, { ...options, attachedSkill: 'qa-checklist' });
    const composed = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
    assert.equal(composed.contextComposition, 'delivered', JSON.stringify(composed.contextAdmission));
    assert.equal(composed.phase, options.customPhase ?? 'planning');
    assert.match(composed.context.text, /qa-checklist/);
    const audit = `team/stories/ENTRY-1/context/agents-${composed.phase}-gen1.json`;
    assert.match(git(item.root, 'status', '--porcelain=v1', '--untracked-files=all'), new RegExp(audit.replaceAll('.', '\\.')));
    for (const args of [['phase', 'enter', '--for-agent', '--json'], ['phase', 'enter', '--compose', '--for-agent', '--json']]) {
      const result = item.invoke(...args);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const entry = completeAgentResult(result.stdout);
      assert.deepEqual(entry.contextAdmission.blockers, [], args.join(' '));
      const worktree = entry.recovery.actions.find(action => action.id === 'working-tree');
      assert.deepEqual(worktree?.unexpectedPaths ?? [], []);
      assert.ok(worktree.expectedPaths.includes(audit));
    }
    // An audit that does not belong to this composition stays with a person.
    const record = JSON.parse(await readFile(path.join(item.root, audit), 'utf8'));
    await writeFile(path.join(item.root, audit), `${JSON.stringify({ ...record, agent: 'developer' }, null, 2)}\n`);
    const held = completeAgentResult(item.invoke('phase', 'enter', '--for-agent', '--json').stdout);
    assert.deepEqual(held.contextAdmission.blockers.map(entry => entry.code), ['PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED']);
    assert.deepEqual(held.contextAdmission.blockers[0].paths, [audit]);
  });
});

// Reported from real use after 5a271098: only the skills audit was untracked. Its prompt pair had been
// committed, or composition stopped after the audit and before the prompt; the hold then refused the
// composition that would have rewritten them, so the Story could not continue on its own.
test('a skills audit left alone does not hold its step, whether its prompt was committed or never written', async t => {
  for (const scenario of ['prompt committed', 'prompt never written']) await t.test(scenario, async t => {
    const item = await fixture(t, { customPhase: 'qa-intake', attachedSkill: 'qa-checklist' });
    assert.equal(completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout).contextComposition, 'delivered');
    const context = 'team/stories/ENTRY-1/context';
    const pair = [`${context}/qa-intake-gen1.json`, `${context}/prompts/qa-intake-gen1.md`];
    if (scenario === 'prompt committed') {
      git(item.root, 'add', '--', ...pair);
      git(item.root, 'commit', '-qm', 'prompt pair only');
    } else {
      for (const relative of pair) await unlink(path.join(item.root, relative));
    }
    const audit = `${context}/agents-qa-intake-gen1.json`;
    assert.equal(git(item.root, 'status', '--porcelain=v1', '--untracked-files=all'), `?? ${audit}`);
    const entry = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
    assert.deepEqual(entry.contextAdmission.blockers, []);
    assert.equal(entry.contextComposition, 'delivered');
    assert.match(entry.context.text, /qa-checklist/);
  });
});

// Composition writes the prompt record and its snapshot as a pair. A session stopped between the two
// leaves one half; composition is the repair (it keeps the half only when its fresh candidate matches),
// but the half was held for a person and that hold refused the composition.
test('an interrupted prompt pair goes back to composition instead of a person', async t => {
  for (const missing of ['snapshot', 'receipt']) await t.test(missing, async t => {
    const item = await fixture(t, { customPhase: 'qa-intake' });
    assert.equal(completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout).contextComposition, 'delivered');
    const record = 'team/stories/ENTRY-1/context/qa-intake-gen1.json';
    const prompt = 'team/stories/ENTRY-1/context/prompts/qa-intake-gen1.md';
    const before = { record: await readFile(path.join(item.root, record), 'utf8'), prompt: await readFile(path.join(item.root, prompt), 'utf8') };
    await unlink(path.join(item.root, missing === 'snapshot' ? prompt : record));
    const entry = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
    assert.deepEqual(entry.contextAdmission.blockers, []);
    assert.equal(entry.contextComposition, 'delivered');
    assert.equal(await readFile(path.join(item.root, prompt), 'utf8'), before.prompt, 'the repaired snapshot is the composed bytes');
    assert.equal(JSON.parse(await readFile(path.join(item.root, record), 'utf8')).renderedSha256, JSON.parse(before.record).renderedSha256);
  });
});

// A change request (or new documents or inputs) recomposes the prompt; the recorded answers stay bound to
// the earlier one. Recovery held the record for a person, and entry stopped at inspect-binding with no
// action. Now the record is the step's own and entry asks the person to re-bind the answers.
test('answers recorded before a recomposition are re-bound by the person, not held', async t => {
  const item = await fixture(t, { customPhase: 'qa-intake', clarificationActor: true });
  const invokeJson = (...args) => {
    const result = item.invoke(...args, '--json');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return completeAgentResult(result.stdout);
  };
  const entry = invokeJson('phase', 'enter', '--compose', '--for-agent');
  const staging = entry.clarification.responseStagingPath;
  const replies = [{ question: 'Which page has the filter?', answer: 'Research and Markets.' }];
  await mkdir(path.dirname(staging), { recursive: true });
  await writeFile(staging, JSON.stringify({ responses: replies }));
  invokeJson(...entry.clarification.checkpoint.recordAction.commandGuidance.argv.filter(arg => arg !== '--json'));
  const statePath = path.join(item.root, 'team/stories/ENTRY-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.changeRequests = [...(state.changeRequests ?? []), { id: 'CR-1', status: 'open', targetPhase: 'qa-intake',
    comment: 'Also cover the empty category.', clauseIds: [], requestedAt: '2026-10-16T00:00:00.000Z' }];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const recomposed = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.match(recomposed.stderr, /Recomposing qa-intake generation 1/);
  const stale = completeAgentResult(recomposed.stdout);
  assert.deepEqual(stale.contextAdmission.blockers, []);
  assert.equal(stale.clarification.checkpoint.stage, 'inspect-binding');
  assert.equal(stale.authoringAllowed, false);
  const rebind = stale.next[0];
  assert.equal(rebind.id, 'rebind-clarification:qa-intake');
  assert.equal(rebind.requiresActualHumanReplies, true);
  assert.ok(rebind.commandGuidance.argv.includes('--replace'));
  // A later entry, after recovery has seen the recomposed pair, holds nothing and routes the same way.
  const again = invokeJson('phase', 'enter', '--for-agent');
  assert.deepEqual(again.contextAdmission.blockers, []);
  assert.equal(again.next[0].id, 'rebind-clarification:qa-intake');
  assert.equal(again.next[0].agentAction, 'load-context');
  await writeFile(staging, JSON.stringify({ responses: replies }));
  invokeJson(...rebind.commandGuidance.argv.filter(arg => arg !== '--json'));
  const resumed = invokeJson('phase', 'enter', '--for-agent');
  assert.equal(resumed.clarification.checkpoint.stage, 'complete');
  assert.equal(resumed.authoringAllowed, true);
});

// The POC intake template tells the person to run mcp scaffold before approving intake. It writes
// .vscode/mcp.json, which publication never registers, so the hold it caused would last for every step.
test('editor configuration written by mcp scaffold does not hold a document step', async t => {
  const item = await fixture(t, { customPhase: 'qa-intake' });
  const scaffold = item.invoke('mcp', 'scaffold', 'playwright');
  assert.equal(scaffold.status, 0, scaffold.stderr || scaffold.stdout);
  assert.match(git(item.root, 'status', '--porcelain=v1', '--untracked-files=all'), /\.vscode\/mcp\.json/);
  const entry = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  assert.deepEqual(entry.contextAdmission.blockers, []);
  assert.equal(entry.contextComposition, 'delivered');
});

// A document step held for changes recovery cannot attribute had no command a person could run: the
// read-only inspection and a code-step-only commit. Now the person keeps them (commits them) or sets
// them aside, after a private recovery copy, and the step continues.
test('a person sets aside changes that hold a document step, keeping a recovery copy', async t => {
  const item = await fixture(t, { customPhase: 'qa-intake' });
  const stray = 'team/stories/ENTRY-1/context/notes.json';
  await mkdir(path.dirname(path.join(item.root, stray)), { recursive: true });
  await writeFile(path.join(item.root, stray), '{"draft":"not from SFlow"}\n');
  await writeFile(path.join(item.root, 'README.md'), '# Edited by hand\n');
  const held = completeAgentResult(item.invoke('phase', 'enter', '--for-agent', '--json').stdout);
  assert.deepEqual(held.contextAdmission.blockers.map(entry => entry.code), ['PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED']);
  const route = held.next.find(action => action.id === 'set-aside-worktree');
  assert.ok(route, JSON.stringify(held.next.map(action => action.id)));
  assert.equal(held.next.findIndex(action => action.id === 'set-aside-worktree') < held.next.findIndex(action => action.id === 'inspect-continuation:qa-intake'), true,
    'the person\'s route leads the read-only inspection');
  assert.deepEqual(new Set(route.paths), new Set([stray, 'README.md']));
  assert.match(route.command, /^singularity-flow recover ENTRY-1 --phase qa-intake --set-aside --confirm sha256:[0-9a-f]{64} --json$/);
  const stale = item.invoke('recover', 'ENTRY-1', '--set-aside', '--confirm', `sha256:${'0'.repeat(64)}`, '--json');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /RECOVERY_PLAN_STALE/);
  const result = item.invoke(...route.command.split(' ').slice(1));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const setAside = JSON.parse(result.stdout).setAside;
  assert.deepEqual(setAside.removed, [stray]);
  assert.deepEqual(setAside.restored, ['README.md']);
  assert.match(setAside.checkpoint, /^PCP-[0-9a-f]{64}$/);
  assert.equal(await readFile(path.join(item.root, 'README.md'), 'utf8'), '# Entry fixture\n');
  assert.equal(git(item.root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  const shown = completeAgentResult(item.invoke('appeal', 'checkpoint-show', setAside.checkpoint, '--work-id', 'ENTRY-1', '--phase', 'qa-intake', '--json').stdout);
  assert.ok(JSON.stringify(shown).includes(stray), 'the recovery copy keeps the set-aside file');
  const entry = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  assert.deepEqual(entry.contextAdmission.blockers, []);
});

test('changes held while a step awaits approval can be set aside by the person', async t => {
  const item = await fixture(t, { customPhase: 'qa-intake' });
  const statePath = path.join(item.root, 'team/stories/ENTRY-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.phases['qa-intake'].status = 'awaiting_approval';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  git(item.root, 'add', '-A'); git(item.root, 'commit', '-qm', 'fixture: submitted');
  await writeFile(path.join(item.root, 'notes.txt'), 'scratch\n');
  const plan = JSON.parse(item.invoke('recover', 'ENTRY-1', '--json').stdout);
  const route = plan.actions.find(action => action.id === 'set-aside-worktree');
  assert.deepEqual(route?.paths, ['notes.txt'], JSON.stringify(plan.actions.map(action => action.id)));
  const result = item.invoke(...route.command.split(' ').slice(1));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).setAside.removed, ['notes.txt']);
  assert.equal(git(item.root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
});

// A half left by an interrupted composition, and then the Story changed before the next one: the fresh
// candidate can never match the half, and composition refused it on every attempt.
test('a lone prompt half the Story has since outgrown is moved aside and composition continues', async t => {
  const item = await fixture(t, { customPhase: 'qa-intake' });
  assert.equal(completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout).contextComposition, 'delivered');
  const context = 'team/stories/ENTRY-1/context';
  await unlink(path.join(item.root, context, 'prompts/qa-intake-gen1.md'));
  const statePath = path.join(item.root, 'team/stories/ENTRY-1/workflow.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.changeRequests = [...(state.changeRequests ?? []), { id: 'CR-1', status: 'open', targetPhase: 'qa-intake',
    comment: 'Also cover the empty category.', clauseIds: [], requestedAt: '2026-10-16T00:00:00.000Z' }];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const entry = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  assert.deepEqual(entry.contextAdmission.blockers, []);
  assert.equal(entry.contextComposition, 'delivered');
  assert.match(entry.context.text, /Also cover the empty category/);
  const aside = path.join(item.root, context, 'superseded');
  const [directory] = (await readdir(aside)).filter(name => name.includes('-interrupted-'));
  assert.ok(directory, 'the outgrown receipt is kept with its reason');
  assert.match(JSON.parse(await readFile(path.join(aside, directory, 'reason.json'), 'utf8')).reason, /did not match a fresh composition/);
  const again = completeAgentResult(item.invoke('phase', 'enter', '--for-agent', '--json').stdout);
  assert.deepEqual(again.contextAdmission.blockers, [], 'the moved half and its reason are this step\'s own');
});

// A step writes more than its primary artifact: the other members of its artifact set (review notes,
// task maps, evidence folders) and files below its own artifact directory, which publication
// registers and commits. Entry read them as somebody else's work and held the step for a person.
test('a step\'s own artifact-set files are its draft, another step\'s artifacts still need a person', async t => {
  const item = await fixture(t);
  const composed = completeAgentResult(item.invoke('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  assert.equal(composed.phase, 'specification');
  const own = 'team/stories/ENTRY-1/artifacts/specification/checklists/requirements.md';
  await mkdir(path.dirname(path.join(item.root, own)), { recursive: true });
  await writeFile(path.join(item.root, own), '# Review notes\n\nThe reviewer checks each article.\n');
  const entry = completeAgentResult(item.invoke('phase', 'enter', '--for-agent', '--json').stdout);
  assert.deepEqual(entry.contextAdmission.blockers, []);
  assert.ok(entry.recovery.actions.find(action => action.id === 'working-tree').expectedPaths.includes(own));
  // Not a declared member, but below the step's own artifact directory: publication registers it.
  const notes = 'team/stories/ENTRY-1/artifacts/specification/notes/interview.md';
  await mkdir(path.dirname(path.join(item.root, notes)), { recursive: true });
  await writeFile(path.join(item.root, notes), '# Interview notes\n');
  const noted = completeAgentResult(item.invoke('phase', 'enter', '--for-agent', '--json').stdout);
  assert.deepEqual(noted.contextAdmission.blockers, []);
  assert.ok(noted.recovery.actions.find(action => action.id === 'working-tree').expectedPaths.includes(notes));
  const other = 'team/stories/ENTRY-1/artifacts/planning/plan.md';
  await mkdir(path.dirname(path.join(item.root, other)), { recursive: true });
  await writeFile(path.join(item.root, other), '# A plan nobody prepared\n');
  const held = completeAgentResult(item.invoke('phase', 'enter', '--for-agent', '--json').stdout);
  assert.deepEqual(held.contextAdmission.blockers.map(blocker => blocker.code), ['PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED']);
  assert.deepEqual(held.contextAdmission.blockers[0].paths, [other]);
});

test('compact checks preserve every finding, risk choice, command guard and fresh-test requirement', () => {
  const full = { resultType: 'sflow-phase-prepublish', phase: 'custom-code', status: 'correction-required',
    artifact: { path: 'team/stories/E/artifacts/code.md', sha256: 'abc', preview: 'x'.repeat(16_000) },
    findings: [{ code: 'scope.outside', message: 'Review the exact extra path.', path: 'src/extra.js' }],
    resolution: { issues: [{ code: 'scope.outside', choices: [{ kind: 'appeal', command: 'review exact packet' }] }] },
    repairLoop: { protocol: { maximumAttempts: 3 } },
    correction: { sameTurn: false, class: 'phase-recovery' },
    commands: { publish: null, next: 'singularity-flow recover E --phase custom-code --json' },
    commandGuidance: { publish: null },
    testExecution: { status: 'not-run', commands: [{ id: 'qualityCommands[0]', argv: null,
      availability: 'ready', argvWithheld: true, argvSource: 'approved-configuration' }],
    handoff: { runnerStatus: 'ready', configurationRequired: false,
      executionOwner: 'publication', onSuccess: 'continue-publication', command: null } },
    coverage: { status: 'incomplete', unclaimed: 1, blocking: true, paths: Array(100).fill('observations') },
    warnings: ['An authority pin is unavailable.'] };
  const compact = phaseAgentResult(full);
  for (const key of ['status', 'findings', 'resolution', 'repairLoop', 'correction', 'commands', 'commandGuidance', 'testExecution', 'warnings']) assert.deepEqual(compact[key], full[key]);
  assert.equal(compact.coverage.blocking, true);
  assert.equal(compact.artifact.sha256, 'abc');
  assert.ok(compact.projection.omitted.includes('artifact.preview'));
  assert.equal(compact.projection.fullCommand, 'singularity-flow phase prepublish custom-code --json');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 4);
  assert.equal(full.artifact.preview.length, 16_000, 'projection cannot mutate kernel results');
});

test('CLI compact prepublish keeps the kernel findings and next actions; full JSON is unchanged', async t => {
  const item = await fixture(t);
  const fullResult = item.invoke('phase', 'prepublish', '--json');
  assert.equal(fullResult.status, 0, fullResult.stderr || fullResult.stdout);
  const full = completeAgentResult(fullResult.stdout);
  assert.equal(full.projection, undefined);
  const agentResult = item.invoke('phase', 'prepublish', '--for-agent', '--json');
  assert.equal(agentResult.status, 0, agentResult.stderr || agentResult.stdout);
  const compact = completeAgentResult(agentResult.stdout);
  assert.equal(compact.projection.kind, 'agent');
  // The same kernel results; the routes an agent runs carry --for-agent.
  for (const key of ['status', 'findings', 'advisories', 'commands', 'commandGuidance', 'testExecution', 'correction']) {
    assert.deepEqual(compact[key], await withAgentRoutes(agentPacketPresentation(full[key])), key);
  }
  assert.deepEqual(compact.resolution, await withAgentRoutes(agentPacketPresentation(full.resolution)));
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('all authoring skills use a single prepublish validator pass and entry has one maintained boundary', async () => {
  for (const name of ['code', 'phase', 'design', 'requirements', 'release', 'plan', 'specify', 'verify', 'converge', 'review', 'scenario-check', 'document-intake', 'workflow-rules']) {
    const skill = await readFile(path.join(packageRoot, 'plugin/skills', `sflow-${name}`, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /draft-check[^\n]*(?:then| and )[^\n]*prepublish/);
    assert.match(skill, /phase prepublish .*--for-agent --json/);
    assert.equal([...skill.matchAll(/<!-- sflow-execution-boundary -->/g)].length, 1, name);
    if (['code', 'phase', 'design', 'requirements', 'release', 'scenario-check', 'document-intake'].includes(name)) {
      assert.match(skill, /phase enter --compose --for-agent --json/);
      assert.doesNotMatch(skill, /singularity-flow (?:pause status|session current|status --json|clarification status|story references verify)/);
    }
  }
});
