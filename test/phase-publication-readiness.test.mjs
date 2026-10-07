import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { validateDefinition, resolveWorkType } from '../src/config.mjs';
import { recordClarificationResponses } from '../src/clarifications.mjs';
import { phasePrepublish } from '../src/phase-prepublish.mjs';
import { inspectPhaseRecovery } from '../src/recovery-plan.mjs';
import { assertPhasePublicationReadiness, inspectPhasePublicationReadiness } from '../src/phase-publication-readiness.mjs';
import { snapshot } from '../src/util.mjs';
import { setAgentSession } from '../src/session.mjs';
import { publishGeneration } from '../src/state.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { applyRecovery, recoveryPlan, recoveryText } from '../src/collaboration.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

async function fixture(t, id = 'planning') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Readiness Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const itemRelative = 'singularity/work-items/READY-1';
  const itemDirectory = path.join(root, itemRelative);
  const relative = `artifacts/${id}/document.md`;
  const absolute = path.join(itemDirectory, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, '# Reviewed work\n\nThe approved scope and verification approach are documented for this phase.\n');
  git('add', '.'); git('commit', '-qm', 'fixture baseline');
  const phase = { id, status: 'in_progress', generation: 0, artifacts: [],
    generationPolicy: { defaultProducer: 'governed-agent', allowedProducers: ['governed-agent', 'human'] },
    requiredArtifact: { path: relative, minimumBytes: 20,
      validation: { requiredHeadings: ['Reviewed work'], forbiddenPlaceholders: [] } } };
  const workflow = { workItem: { id: 'READY-1', branch: 'main' }, currentPhase: id, phaseOrder: [id],
    resolution: { phases: [], artifactSets: {}, worldModelGrounding: 'off' }, phases: { [id]: phase } };
  const config = { workItemRoot: 'singularity/work-items', spec: { mode: 'off' } };
  const session = { workId: 'READY-1', phaseId: id, agent: 'architect' };
  return { root, config, workflow, phase, session, itemDirectory, itemRelative, absolute, git };
}

async function tree(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await tree(root, file));
    else files.push([file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]);
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

async function expectBlocked(f, category, code) {
  const before = await tree(f.root);
  const preview = await phasePrepublish(f.root, f.config, f.workflow, f.phase, { session: f.session });
  const recovery = await inspectPhaseRecovery(f.root, f.config, f.workflow, f.phase);
  assert.equal(preview.status, 'correction-required');
  assert.equal(preview.commands.publish, null);
  assert.equal(preview.correction.sameTurn, false);
  assert.ok(preview.findings.some(entry => entry.category === category));
  assert.ok(recovery.blockers.some(entry => entry.category === category));
  assert.ok(recovery.actions.some(entry => entry.command === preview.commands.next));
  assert.ok(recovery.actions.every(entry => entry.automatic === false));
  await assert.rejects(assertPhasePublicationReadiness(f.root, f.config, f.workflow, f.phase), error => {
    assert.equal(error.code, code);
    const envelope = refusalEnvelope(error, ['phase', 'publish', f.phase.id, '--json']);
    assert.ok(envelope.remediationPlan.steps.some(step => step.command === preview.commands.next),
      'the CLI/VS Code refusal preserves the exact dependency repair route');
    return true;
  });
  assert.deepEqual(await tree(f.root), before, 'includes .git: no receipt, outbox, artifact or recovery state was written');
  return preview;
}

test('required human clarification blocks preview, recovery and publication, even with an unfinished draft', async t => {
  const f = await fixture(t, 'specification');
  f.phase.clarification = { mode: 'required' };
  const preview = await expectBlocked(f, 'clarification', 'PHASE_CLARIFICATION_NOT_READY');
  assert.equal(preview.correction.class, 'human-input');
  assert.equal(preview.commands.next, 'singularity-flow clarification status specification --json');
  const recovered = await inspectPhaseRecovery(f.root, f.config, f.workflow, f.phase);
  assert.match(recoveryText({ ...recovered, workId: 'READY-1', branch: 'main', targetBranch: 'main', planId: 'test' }),
    /clarification response is missing for specification generation 1/);
  await writeFile(f.absolute, '# Reviewed work\n\nTODO describe scope.\n');
  const unfinished = await expectBlocked(f, 'clarification', 'PHASE_CLARIFICATION_NOT_READY');
  assert.equal(unfinished.correction.class, 'human-input', 'answer first; do not automatically draft unknown scope');
});

test('explicit recovery inspects an unpublished active phase without making ordinary status reads heavier', async t => {
  const f = await fixture(t, 'specification');
  f.phase.clarification = { mode: 'required' };
  const before = await tree(f.root);
  const lightweight = await recoveryPlan(f.root, f.config, f.workflow);
  assert.equal(lightweight.phaseId, null);
  assert.deepEqual(lightweight.blockers, []);
  const plan = await recoveryPlan(f.root, f.config, f.workflow, { inspectActivePhase: true });
  assert.equal(plan.phaseId, 'specification');
  assert.equal(plan.phaseRepairRequired, true);
  assert.equal(plan.requiresRecovery, false, 'open draft authoring is still permitted; this is not a consumed-generation hold');
  assert.ok(plan.blockers.some(entry => entry.category === 'clarification'));
  assert.ok(plan.actions.some(entry => entry.command === 'singularity-flow clarification status specification --json'));
  assert.ok(!plan.actions.some(entry => entry.id === 'none'));
  assert.equal(plan.applyCommand, null);
  await assert.rejects(applyRecovery(f.root, f.config, f.workflow, plan, { confirm: plan.planId }), error => {
    assert.equal(error.code, 'RECOVERY_AUTOMATIC_ACTION_UNAVAILABLE');
    assert.equal(error.details.workId, 'READY-1');
    assert.equal(error.details.phase, 'specification');
    const refused = refusalEnvelope(error, ['recover', 'READY-1', '--apply', '--json']);
    const route = refused.remediationPlan.steps.find(entry => entry.command === 'singularity-flow clarification status specification --json');
    assert.ok(route, 'a mistaken --apply must retain the guided repair instead of sending the user back into recover');
    assert.equal(route.label, plan.actions.find(entry => entry.command === route.command).detail);
    assert.equal(refused.remediationPlan.retry.automatic, false);
    return true;
  });
  assert.deepEqual(await tree(f.root), before);
});

test('automatic recovery guidance keeps the exact explicitly selected phase in its hash-confirmed apply command', () => {
  const plan = { workId: 'READY-1', phaseId: 'custom-step', branch: 'main', targetBranch: 'main',
    planId: `sha256:${'a'.repeat(64)}`, actions: [{ id: 'publish', safe: true, automatic: true,
      command: 'singularity-flow sync', detail: 'Retry retained publication.' }] };
  assert.match(recoveryText(plan), /recover READY-1 --phase custom-step --apply --confirm sha256:a{64}/);
  assert.match(recoveryText({ ...plan, modelEnabled: false }), /--confirm sha256:a{64} --no-model/);
});

test('JSON recovery exposes the exact automatic command with its reviewed inspection options', async t => {
  const f = await fixture(t, 'custom-step');
  f.git('branch', 'tracked-base');
  f.git('branch', '--set-upstream-to=tracked-base');
  const plan = await recoveryPlan(f.root, f.config, f.workflow, {
    inspectActivePhase: true, fetch: true, modelEnabled: false
  });
  assert.equal(plan.applyCommand,
    `singularity-flow recover READY-1 --phase custom-step --apply --confirm ${plan.planId} --fetch --no-model`);
  assert.ok(safeCommandGuidance({ command: plan.applyCommand, skill: '/sf-recover' }));
  assert.equal(plan.modelEnabled, false);
});

test('the actual publication entry refuses missing clarification before managed input or generation writes', async t => {
  const f = await fixture(t, 'specification');
  f.phase.clarification = { mode: 'required' };
  const actor = { name: 'Reviewer', email: 'reviewer@example.test' };
  f.config.agents = { architect: { label: 'Architect', phases: ['specification'], defaultFor: [] } };
  await setAgentSession(f.root, f.config, actor, 'architect', 'READY-1', { phaseId: 'specification' });
  const before = await tree(f.root);
  const state = JSON.stringify(f.workflow);
  await assert.rejects(publishGeneration(f.root, f.config, f.workflow, {
    phaseId: 'specification', authorship: { producer: 'governed-agent', channel: 'copilot-host', actor }
  }), { code: 'PHASE_CLARIFICATION_NOT_READY' });
  assert.equal(JSON.stringify(f.workflow), state);
  assert.deepEqual(await tree(f.root), before);
});

test('valid human answers unblock readiness; when-needed answers are still checked for stale prompt bindings', async t => {
  const f = await fixture(t, 'requirements');
  f.phase.clarification = { mode: 'when-needed' };
  const context = path.join(f.itemDirectory, 'context');
  await mkdir(path.join(context, 'prompts'), { recursive: true });
  const promptPath = `${f.itemRelative}/context/prompts/requirements-gen1.md`;
  await writeFile(path.join(f.root, promptPath), '# Prompt\nConfirm the intended scope.\n');
  const prompt = await snapshot(path.join(f.root, promptPath));
  const groundingPath = path.join(context, 'requirements-gen1.json');
  await writeFile(groundingPath, JSON.stringify({ promptPath, renderedSha256: prompt.sha256, agent: 'architect' }));
  await recordClarificationResponses(f.root, f.config, f.workflow, f.phase, {
    responses: [{ question: 'Is this the intended scope?', answer: 'Yes, use the reviewed scope.' }],
    actor: { name: 'Reviewer', email: 'reviewer@example.test' }, agent: 'architect'
  });
  const preview = await phasePrepublish(f.root, f.config, f.workflow, f.phase, { session: f.session });
  assert.equal(preview.status, 'ready', JSON.stringify(preview.findings));
  await assertPhasePublicationReadiness(f.root, f.config, f.workflow, f.phase);
  await writeFile(path.join(f.root, promptPath), '# Different prompt\n');
  await expectBlocked(f, 'clarification', 'PHASE_CLARIFICATION_NOT_READY');
});

test('missing MCP evidence and a missing required host are actionable without starting any server', async t => {
  const f = await fixture(t, 'testing');
  f.phase.mcp = { requiredServers: [], evidence: [
    { server: 'playwright', tool: 'browser_snapshot', minimum: 1, outputRequired: true }
  ] };
  const evidence = await expectBlocked(f, 'external-evidence', 'MCP_EVIDENCE_REQUIRED');
  assert.match(evidence.correction.guidance, /this phase generation/);
  f.phase.mcp.requiredServers = ['not-installed'];
  const host = await expectBlocked(f, 'host', 'MCP_PHASE_NOT_READY');
  assert.equal(host.commands.next, 'singularity-flow mcp doctor --json');
});

test('approved inputs require both the file and its exact approved hash; optional and advisory inputs stay nonblocking', async t => {
  const f = await fixture(t);
  f.workflow.resolution.inputsMode = 'enforce';
  f.phase.inputs = [{ phase: 'specification', optional: false }];
  const relative = 'artifacts/specification/spec.md';
  const producer = { id: 'specification', status: 'approved', generation: 1, artifacts: [], requiredArtifact: { path: relative } };
  f.workflow.phases.specification = producer;
  f.workflow.phaseOrder = ['specification', 'planning'];
  const missing = await expectBlocked(f, 'inputs', 'PHASE_INPUTS_NOT_READY');
  assert.equal(missing.commands.next, 'singularity-flow inputs planning --dry-run --json');
  await mkdir(path.dirname(path.join(f.itemDirectory, relative)), { recursive: true });
  await writeFile(path.join(f.itemDirectory, relative), '# Accepted requirements\n');
  producer.artifacts = [{ path: `${f.itemRelative}/${relative}`, status: 'approved', ...(await snapshot(path.join(f.itemDirectory, relative))) }];
  assert.equal((await phasePrepublish(f.root, f.config, f.workflow, f.phase)).status, 'ready');
  await writeFile(path.join(f.itemDirectory, relative), '# Different requirements\n');
  await expectBlocked(f, 'inputs', 'PHASE_INPUTS_NOT_READY');
  f.workflow.resolution.inputsMode = 'record';
  const warning = await phasePrepublish(f.root, f.config, f.workflow, f.phase);
  assert.equal(warning.status, 'ready');
  assert.match(warning.warnings.join('\n'), /approved hash/);
  f.workflow.resolution.inputsMode = 'enforce';
  f.phase.inputs[0].optional = true;
  await rm(path.join(f.itemDirectory, relative));
  assert.equal((await phasePrepublish(f.root, f.config, f.workflow, f.phase)).status, 'ready');
});

test('required integration receipt is reported before publication without creating or sending a delivery', async t => {
  const f = await fixture(t);
  f.workflow.phases.intake = { id: 'intake', status: 'approved', generation: 1, artifacts: [] };
  f.workflow.phaseOrder = ['intake', 'planning'];
  f.workflow.resolution.phases = [{ id: 'intake', afterStep: [{
    id: 'audit', required: true, on: ['approved'], send: 'event', target: 'hook',
    targetSpec: { kind: 'webhook', url: 'https://hooks.example.test/audit' }
  }] }];
  const preview = await expectBlocked(f, 'integration', 'STEP_ACTION_REQUIRED_UNRECORDED');
  assert.match(preview.commands.next, /^singularity-flow integrations retry sad_/);
  assert.match(preview.correction.guidance, /unknown prior outcome/);
});

test('no-model fallback keeps human authorship in the publication command and recovery retry', async t => {
  const f = await fixture(t);
  f.phase.clarification = { mode: 'required' };
  f.workflow.resolution.worldModelGrounding = 'enforce';
  const preview = await phasePrepublish(f.root, f.config, f.workflow, f.phase, { modelEnabled: false });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.producer, 'human');
  assert.equal(preview.grounding.status, 'not-applicable');
  assert.equal(preview.commands.publish, 'singularity-flow phase publish planning --authored human --channel manual-in-place --no-model');
  for (const key of ['recover', 'recheck', 'draftCheck']) assert.match(preview.commands[key], / --no-model$/);
  await assertPhasePublicationReadiness(f.root, f.config, f.workflow, f.phase, { modelEnabled: false });
  await writeFile(f.absolute, '# Reviewed work\n\nTODO complete the plan.\n');
  const recovery = await inspectPhaseRecovery(f.root, f.config, f.workflow, f.phase, { modelEnabled: false });
  assert.ok(!recovery.blockers.some(entry => ['grounding', 'clarification'].includes(entry.category)));
  assert.equal(recovery.actions.find(entry => entry.retry)?.retry.command, preview.commands.publish);
  assert.match(recovery.actions.find(entry => entry.retry)?.retry.beforeRetry, / --no-model$/);
});

test('grounding failure is visible in recovery without rewriting the retained receipt', async t => {
  const f = await fixture(t);
  f.workflow.resolution.worldModelGrounding = 'enforce';
  const file = path.join(f.itemDirectory, 'context/planning-gen1.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{invalid retained receipt');
  const preview = await expectBlocked(f, 'grounding', 'PHASE_GROUNDING_NOT_READY');
  assert.equal(preview.commands.next, 'singularity-flow wm doctor --json');
  assert.equal(await readFile(file, 'utf8'), '{invalid retained receipt');
});

test('recovery does not demand a new prompt for an already published document generation', async t => {
  const f = await fixture(t);
  f.phase.generation = 1;
  f.workflow.resolution.worldModelGrounding = 'enforce';
  const recovery = await inspectPhaseRecovery(f.root, f.config, f.workflow, f.phase);
  assert.ok(!recovery.blockers.some(entry => entry.category === 'grounding'));
  assert.ok(!recovery.actions.some(entry => entry.command?.includes('wm compose')));
});

test('a clean preview is never reused as publication authority after dependency bytes change', async t => {
  const f = await fixture(t);
  assert.equal((await phasePrepublish(f.root, f.config, f.workflow, f.phase)).status, 'ready');
  f.phase.clarification = { mode: 'required' };
  await assert.rejects(assertPhasePublicationReadiness(f.root, f.config, f.workflow, f.phase), {
    code: 'PHASE_CLARIFICATION_NOT_READY'
  });
});

test('all packaged workflow phase IDs use the same missing-input readiness contract', async t => {
  const definition = validateDefinition(YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8')));
  const seen = new Set();
  for (const id of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, id);
    for (const phase of resolved.phases) seen.add(phase.id);
  }
  assert.equal(Object.keys(definition.workTypes).length, 15);
  assert.equal(seen.size, 40);
  assert.deepEqual(resolveWorkType(definition, 'demo-web-e2e-testing').phases.map((phase) => phase.id),
    ['demo-web-intake', 'demo-web-check', 'demo-web-repair', 'demo-web-retest']);
  const f = await fixture(t);
  await writeFile(f.absolute, '# Reviewed work\n\nTODO complete the accepted scope.\n');
  for (const id of seen) {
    const phase = { ...f.phase, id, inputs: [{ phase: 'upstream', path: 'artifacts/upstream/missing.md' }] };
    const workflow = { ...f.workflow, currentPhase: id, phases: { [id]: phase },
      resolution: { ...f.workflow.resolution, inputsMode: 'enforce' } };
    const report = await inspectPhasePublicationReadiness(f.root, f.config, workflow, phase);
    assert.ok(report.blockers.some(entry => entry.category === 'inputs'), id);
    await assert.rejects(assertPhasePublicationReadiness(f.root, f.config, workflow, phase), { code: 'PHASE_INPUTS_NOT_READY' });
    const recovery = await recoveryPlan(f.root, f.config, workflow, { inspectActivePhase: true });
    assert.equal(recovery.phaseId, id);
    assert.ok(recovery.blockers.some(entry => entry.category === 'inputs'), id);
    assert.ok(recovery.actions.some(entry => entry.command === `singularity-flow inputs ${id} --dry-run --json`), id);
    assert.ok(!recovery.actions.some(entry => entry.id === 'none'), id);
    assert.ok(recovery.actions.some(entry => entry.id === `complete-artifact:${id}`), id);
    assert.ok(recovery.actions.every(entry => entry.command ? safeCommandGuidance(entry) : entry.detail?.trim()),
      `${id}: every recovery action must survive the closed Shell/Copilot crosswalk or explain its manual prerequisite`);
  }
});
