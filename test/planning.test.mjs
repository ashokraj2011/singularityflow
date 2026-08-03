import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  CopilotPlanningBridge,
  copilotPlanningPreflight,
  modelConfiguration,
  normalizePlanningUpdate
} from '../apps/desktop/electron/copilot-acp.mjs';
import {
  createPlanningContext,
  parseArtifactBlocks,
  PHASE_SCOPE,
  planningTargetCatalog,
  promotePlanningArtifact,
  promotePlanningArtifacts
} from '../src/planning.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const actor = 'Planning Tester';
const actorEmail = 'planning@example.com';

function run(root, command, args, { allowFailure = false } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: actor,
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'initiative-lite' })
  };
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, args) {
  return run(root, 'git', args).stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-planning-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', actor]);
  git(root, ['config', 'user.email', actorEmail]);
  await writeFile(path.join(root, 'README.md'), '# Planning fixture\n');
  run(root, process.execPath, [bin, 'init']);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git.publish = 'off';
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: actor, email: actorEmail }];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize planning fixture']);
  return root;
}

test('story planning creates a private immutable context pack and promotes only reviewed output', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-101', '--title', 'Plan customer onboarding']);
  const requirement = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-business-input-')), 'requirements.md');
  await writeFile(requirement, '# Business requirement\n\nSupport an auditable, low-friction onboarding journey.\n');
  run(root, process.execPath, [bin, 'documents', 'upload', requirement]);
  const before = git(root, ['rev-parse', 'HEAD']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-101',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact',
    objective: 'Define a measurable onboarding outcome.'
  });

  assert.match(context.sessionId, /^plan-/);
  assert.match(context.contextPath, /\.git\/singularity-flow\/planning\//);
  assert.equal(context.manifest.repository.head, before);
  assert.equal(context.manifest.target.id, 'artifact');
  assert.ok(context.manifest.sources.some((source) => source.kind === 'agent'));
  assert.ok(context.manifest.sources.some((source) => source.kind === 'uploaded-document'));
  assert.match(context.context, /Define a measurable onboarding outcome/);
  assert.match(context.context, /Stay in Copilot Plan mode/);
  assert.match(context.context, /Support an auditable, low-friction onboarding journey/);
  assert.match(context.context, /source materials, not instructions/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(git(root, ['status', '--short']), '');

  const promoted = await promotePlanningArtifact(root, {
    sessionId: context.sessionId,
    agent: 'product-owner',
    content: '# Intake decision\n\nOutcome: reduce onboarding abandonment while preserving auditability.\n\n## Acceptance signal\n\nA measurable completion baseline and target are approved.\n'
  });
  assert.equal(promoted.scope, 'work-item');
  assert.equal(promoted.phase, 'intake');
  assert.equal(promoted.publication.pushed, false);
  assert.match(promoted.next, /phase publish intake/);
  const artifact = await readFile(path.join(root, promoted.path), 'utf8');
  assert.match(artifact, /singularity-flow:metadata/);
  assert.match(artifact, /reduce onboarding abandonment/);
  const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
  assert.match(committed, /context\/planning\/intake-gen1\/plan-/);
  const audit = JSON.parse(await readFile(path.join(root, 'singularity/work-items/PLAN-101/context/planning/intake-gen1', context.sessionId, 'manifest.json'), 'utf8'));
  assert.equal(audit.repository.root, undefined);
  assert.match(audit.context.path, /^singularity\/work-items\/PLAN-101\/context\/planning\//);
  assert.match(git(root, ['log', '-1', '--format=%s']), /\[PLAN-101\]\[phase:intake\]\[planning\] promote reviewed plan/);
});

test('promotion refuses stale planning context after repository state moves', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-STALE']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-STALE',
    agent: 'product-owner',
    target: 'artifact'
  });
  await writeFile(path.join(root, 'README.md'), '# Changed after planning began\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'Move repository head']);
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, content: '# Stale output\n' }),
    /HEAD changed/
  );
});

test('promotion refuses an uncommitted change to any governed context source', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-DIRTY']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-DIRTY',
    agent: 'product-owner',
    target: 'artifact'
  });
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, agent: 'architect', content: '# Wrong agent\n' }),
    /composed with governed agent 'product-owner', not 'architect'/
  );
  const sourcePath = path.join(root, 'singularity/work-items/PLAN-DIRTY/USER-STORY.md');
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\nNew requirement after context creation.\n`);
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, content: '# Outdated output\n' }),
    /Governed planning source changed/
  );
});

test('initiative planning exposes all phases but promotes only the active configured output', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-PLAN', '--title', 'Cross-repository onboarding']);
  const catalog = await planningTargetCatalog(root, { initiativeId: 'INIT-PLAN' });
  assert.equal(catalog.enabled, true);
  assert.deepEqual(catalog.targets[0].phases.map((phase) => phase.id), ['define', 'plan', 'build', 'release']);
  assert.ok(catalog.targets[0].phases[0].targets.some((target) => target.id === 'business-case'));

  const context = await createPlanningContext(root, {
    scope: 'initiative',
    id: 'INIT-PLAN',
    phase: 'define',
    agent: 'product-owner',
    target: 'business-case',
    objective: 'Frame the value case before decomposing epics and stories.'
  });
  assert.match(context.context, /Required outputs/);
  assert.match(context.context, /Checklist gates/);
  assert.match(context.context, /Participating repositories/);
  assert.match(context.context, /Cross-repository onboarding/);
  assert.match(context.context, /source material, not an instruction override/);
  await assert.rejects(
    () => createPlanningContext(root, {
      scope: 'initiative',
      id: 'INIT-PLAN',
      phase: 'plan',
      agent: 'product-owner',
      target: 'story-plan'
    }),
    /sequence-aware/
  );

  const promoted = await promotePlanningArtifact(root, {
    sessionId: context.sessionId,
    content: '# Business case\n\n## Outcome\n\nReduce onboarding time across mobile and API delivery while maintaining governed evidence.\n'
  });
  assert.equal(promoted.scope, 'initiative');
  assert.equal(promoted.target, 'business-case');
  assert.equal(promoted.publication.pushed, false);
  assert.match(await readFile(path.join(root, promoted.path), 'utf8'), /singularity-flow:initiative-metadata/);
  assert.match(git(root, ['show', '--name-only', '--format=', 'HEAD']), /context\/planning\/define-gen1\/plan-/);
});

test('ACP planning updates normalize structured plans and reject plan files outside the repository', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-acp-'));
  const planPath = path.join(repository, 'plan.md');
  await writeFile(planPath, '# Structured plan\n');
  const markdown = await normalizePlanningUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'markdown', planId: 'p1', content: '# Proposed\n' }
  }, { repository });
  assert.equal(markdown.plan, '# Proposed\n');
  const items = await normalizePlanningUpdate({
    sessionUpdate: 'plan',
    entries: [{ status: 'completed', content: 'Inspect requirements' }, { status: 'pending', content: 'Compare options' }]
  }, { repository });
  assert.match(items.plan, /\[x\] Inspect requirements/);
  assert.match(items.plan, /\[ \] Compare options/);
  const file = await normalizePlanningUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'file', planId: 'p2', uri: pathToFileURL(planPath).href }
  }, { repository });
  assert.equal(file.plan, '# Structured plan\n');
  const outside = path.join(os.tmpdir(), 'outside-plan.md');
  await writeFile(outside, '# Outside\n');
  const rejected = await normalizePlanningUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'file', planId: 'p3', uri: pathToFileURL(outside).href }
  }, { repository });
  assert.match(rejected.warning, /outside the open repository/);
  assert.equal(rejected.plan, undefined);
  const linked = path.join(repository, 'linked-plan.md');
  await symlink(outside, linked);
  const linkedRejected = await normalizePlanningUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'file', planId: 'p4', uri: pathToFileURL(linked).href }
  }, { repository });
  assert.match(linkedRejected.warning, /symbolic link/);
  assert.equal(linkedRejected.plan, undefined);
  assert.equal(linkedRejected.planPath, undefined);
  const oversized = path.join(repository, 'oversized-plan.md');
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61));
  const oversizedRejected = await normalizePlanningUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'file', planId: 'p5', uri: pathToFileURL(oversized).href }
  }, { repository });
  assert.match(oversizedRejected.warning, /exceeds the 1048576-byte/);
  const malformed = await normalizePlanningUpdate({
    sessionUpdate: 'plan_update',
    plan: { type: 'file', planId: 'p6', uri: 'file:///%ZZ' }
  }, { repository });
  assert.match(malformed.warning, /invalid file URL/);
  const removed = await normalizePlanningUpdate({ sessionUpdate: 'plan_removed', planId: 'p3' }, { repository });
  assert.equal(removed.removed, true);
});

test('Copilot preflight detects ACP and native Plan mode without launching a session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-bin-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'copilot.exe' : 'copilot');
  await writeFile(executable, '');
  await chmod(executable, 0o755);
  const calls = [];
  const result = copilotPlanningPreflight({
    env: { PATH: directory },
    spawnSyncImpl: (command, args) => {
      calls.push([command, args]);
      return args[0] === '--version'
        ? { status: 0, stdout: '1.0.73\n', stderr: '' }
        : { status: 0, stdout: '--acp --mode <mode>\n', stderr: '' };
    }
  });
  assert.equal(result.ready, true);
  assert.equal(result.version, '1.0.73');
  assert.equal(calls.length, 2);
});

test('ACP model configuration exposes the selected model and grouped choices', () => {
  const configured = modelConfiguration([
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'model-alpha',
      options: [
        { value: 'auto', name: 'Automatic' },
        {
          group: 'recommended',
          name: 'Recommended',
          options: [
            { value: 'model-alpha', name: 'Model Alpha' },
            { value: 'gpt-5', name: 'GPT-5' }
          ]
        }
      ]
    }
  ]);
  assert.equal(configured.current, 'model-alpha');
  assert.equal(configured.configId, 'model');
  assert.equal(configured.switchSupported, true);
  assert.deepEqual(configured.available.map((entry) => entry.value), ['auto', 'model-alpha', 'gpt-5']);
  assert.deepEqual(modelConfiguration([], 'requested-model'), {
    configId: null,
    current: 'requested-model',
    available: [],
    switchSupported: false
  });
});

test('ACP form elicitation pauses for an inline answer and cancels unsupported modes', async () => {
  const events = [];
  const bridge = new CopilotPlanningBridge({ repository: os.tmpdir(), emit: (event) => events.push(event) });
  const pending = bridge.requestInput({
    mode: 'form',
    sessionId: 'session-1',
    message: 'Which repository owns the API?',
    requestedSchema: {
      type: 'object',
      properties: { repository: { type: 'string', enum: ['api', 'mobile'] } },
      required: ['repository']
    }
  });
  assert.equal(events[0].type, 'question');
  assert.equal(events[0].schema.properties.repository.enum[0], 'api');
  const result = bridge.answerQuestion(events[0].questionId, { content: { repository: 'api' } });
  assert.equal(result.accepted, true);
  assert.deepEqual(await pending, { action: 'accept', content: { repository: 'api' } });
  assert.deepEqual(await bridge.requestInput({ mode: 'url', message: 'Open external input', url: 'https://example.com' }), { action: 'cancel' });
  assert.equal(events.at(-1).type, 'question-unsupported');
});

test('the session mode decides tool permissions, and leaving Plan asks rather than allows', async () => {
  // Plan mode was the only mode the bridge could be in, and every non-read tool call was refused
  // with no way to say otherwise — so 'run the tests' or 'write this file' was permanently out of
  // reach, whatever the operator wanted. Switching modes must move the gate; it must not open it.
  const events = [];
  const bridge = new CopilotPlanningBridge({ repository: os.tmpdir(), emit: (event) => events.push(event) });
  bridge.availableModes = [{ id: 'copilot#plan', name: 'Plan' }, { id: 'copilot#agent', name: 'Agent' }];
  bridge.currentModeId = 'copilot#plan';
  const params = (kind) => ({
    toolCall: { kind, title: `${kind} something` },
    options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }]
  });

  // Reads are allowed in every mode: that is what makes the session useful at all.
  assert.deepEqual(await bridge.decidePermission(params('read')), { outcome: { outcome: 'selected', optionId: 'allow' } });
  // In Plan mode a write is refused outright, with no prompt and no waiting.
  assert.deepEqual(await bridge.decidePermission(params('edit')), { outcome: { outcome: 'selected', optionId: 'reject' } });
  assert.equal(events.at(-1).type, 'permission-denied');
  assert.match(events.at(-1).detail, /Plan mode is read-only/);
  assert.equal(bridge.pendingPermissions.size, 0);

  bridge.currentModeId = 'copilot#agent';
  assert.equal(bridge.inPlanMode(), false);
  // Outside Plan the same call is put to the operator — the turn waits, nothing is decided for them.
  const pending = bridge.decidePermission(params('edit'));
  const request = events.at(-1);
  assert.equal(request.type, 'permission-request');
  assert.equal(request.mode, 'Agent');
  assert.equal(bridge.pendingPermissions.size, 1);
  bridge.answerPermission(request.requestId, true);
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'allow' } });

  // A refusal is a refusal, and an unanswered request dies closed when the session ends.
  const refused = bridge.decidePermission(params('execute'));
  bridge.answerPermission(events.at(-1).requestId, false);
  assert.deepEqual(await refused, { outcome: { outcome: 'selected', optionId: 'reject' } });
  const abandoned = bridge.decidePermission(params('delete'));
  bridge.cancelPendingPermissions();
  assert.deepEqual(await abandoned, { outcome: { outcome: 'selected', optionId: 'reject' } });
  assert.equal(bridge.pendingPermissions.size, 0);
});

test('a mode change is refused mid-turn and rejected for a mode the session never advertised', async () => {
  const bridge = new CopilotPlanningBridge({ repository: os.tmpdir(), emit: () => {} });
  bridge.session = { sessionId: 'session-mode' };
  bridge.availableModes = [{ id: 'copilot#plan', name: 'Plan' }, { id: 'copilot#agent', name: 'Agent' }];
  bridge.currentModeId = 'copilot#plan';
  const requested = [];
  bridge.connection = { agent: { request: async (_method, params) => { requested.push(params); return {}; } } };

  bridge.running = true;
  await assert.rejects(bridge.setMode('copilot#agent'), /before changing its mode/);
  bridge.running = false;
  await assert.rejects(bridge.setMode('copilot#yolo'), /did not advertise mode/);
  assert.deepEqual(requested, [], 'nothing reaches the agent until the request is valid');

  const result = await bridge.setMode('copilot#agent');
  assert.equal(result.mode, 'Agent');
  assert.equal(result.readOnly, false);
  assert.equal(requested.at(-1).modeId, 'copilot#agent');
});

test('ACP shutdown always cancels questions and terminates the process after partial cleanup failures', async () => {
  const events = [];
  const bridge = new CopilotPlanningBridge({ repository: os.tmpdir(), emit: (event) => events.push(event) });
  const question = bridge.requestInput({
    mode: 'form',
    message: 'Choose a repository',
    requestedSchema: { type: 'object' }
  });
  let connectionClosed = false;
  let processKilled = false;
  bridge.running = true;
  bridge.session = {
    sessionId: 'session-cleanup',
    dispose: () => { throw new Error('dispose failed'); }
  };
  bridge.connection = {
    agent: { request: async () => { throw new Error('cancel failed'); } },
    close: () => { connectionClosed = true; }
  };
  bridge.process = {
    killed: false,
    kill: () => { processKilled = true; return true; }
  };
  const result = await bridge.stop();
  assert.equal((await question).action, 'cancel');
  assert.equal(connectionClosed, true);
  assert.equal(processKilled, true);
  assert.equal(bridge.closed, true);
  assert.equal(bridge.running, false);
  assert.equal(bridge.session, null);
  assert.equal(bridge.connection, null);
  assert.ok(result.warnings.some((warning) => /session disposal failed/.test(warning)));
  assert.ok(events.some((event) => event.type === 'diagnostic' && /cleanup warning/.test(event.text)));
});

test('a phase-scoped session produces the whole artifact set from one conversation', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-SET', '--title', 'Phase scoped planning']);

  const context = await createPlanningContext(root, {
    scope: 'initiative',
    id: 'INIT-SET',
    phase: 'define',
    agent: 'product-owner',
    target: PHASE_SCOPE,
    objective: 'Produce the complete define set.'
  });

  // The contract has to name every promotable output with its destination, otherwise Copilot has
  // no way to know which artifacts it owes or where each one is filed.
  assert.equal(context.target.id, PHASE_SCOPE);
  assert.ok(context.outputs.length > 1, 'expected several promotable outputs');
  for (const output of context.outputs) {
    assert.match(context.context, new RegExp(`SFLOW-ARTIFACT:${output.id}`));
    assert.match(context.context, new RegExp(output.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // One reply carrying several fenced artifacts, with ordinary conversation around them.
  const ids = context.outputs.map((output) => output.id);
  const reply = [
    'Here is the set. One open question is noted inside the artifacts.',
    ...ids.map((id) => `<<<SFLOW-ARTIFACT:${id}\n# ${id}\n\nGoverned body for ${id}.\nSFLOW-ARTIFACT:${id}>>>`)
  ].join('\n\n');
  const blocks = parseArtifactBlocks(reply, ids);
  assert.equal(blocks.size, ids.length);

  const promoted = await promotePlanningArtifacts(root, {
    sessionId: context.sessionId,
    artifacts: [...blocks].map(([outputId, content]) => ({ outputId, content }))
  });

  // The set is one decision, so it lands as one commit: a matrix that cites requirements must
  // never be committed a step apart from the requirements themselves.
  assert.equal(promoted.artifacts.length, ids.length);
  const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
  for (const artifact of promoted.artifacts) {
    assert.ok(committed.includes(artifact.path), `${artifact.target} missing from the promotion commit`);
    assert.match(await readFile(path.join(root, artifact.path), 'utf8'), /Governed body/);
  }
  // Every artifact keeps its own audit copy under the generation.
  assert.match(committed, /context\/planning\/define-gen1\/plan-/);
});

test('a phase-scoped promotion refuses anything outside the phase resolution', async () => {
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-GUARD', '--title', 'Guarded promotion']);
  const context = await createPlanningContext(root, {
    scope: 'initiative', id: 'INIT-GUARD', phase: 'define', agent: 'product-owner', target: PHASE_SCOPE
  });
  const [first] = context.outputs;

  // An artifact ID Copilot invented must never be filed anywhere.
  assert.throws(() => parseArtifactBlocks('<<<SFLOW-ARTIFACT:invented\nbody\nSFLOW-ARTIFACT:invented>>>', context.outputs.map((o) => o.id)), /not an output of this phase/);
  await assert.rejects(
    () => promotePlanningArtifacts(root, { sessionId: context.sessionId, artifacts: [{ outputId: 'invented', content: 'x' }] }),
    /no longer part of the immutable phase resolution/
  );
  // The set is validated before anything is written, so a partial set cannot half-apply.
  await assert.rejects(
    () => promotePlanningArtifacts(root, {
      sessionId: context.sessionId,
      artifacts: [{ outputId: first.id, content: '# ok' }, { outputId: first.id, content: '# duplicate' }]
    }),
    /supplied more than once/
  );
  await assert.rejects(
    () => promotePlanningArtifacts(root, { sessionId: context.sessionId, artifacts: [] }),
    /No reviewed artifacts/
  );
});

test('a generated output is rendered from committed state, and an optional one does not block', async () => {
  const { renderInitiativeGenerator } = await import('../src/initiative-generators.mjs');

  // The catalog is a projection of the pinned manifest and the Epic record: every value it shows
  // is already governed state, so nothing here is a claim a person had to make.
  const rendered = await renderInitiativeGenerator('source-catalog', await repository(), {
    initiative: { initiative: { id: 'GEN-1', source: {
      type: 'jira', key: 'GEN-1', title: 'Generated catalog', status: 'Open',
      attachments: [{ filename: 'brief.pdf', mimeType: 'application/pdf', size: 2048 }]
    } } }
  });
  assert.match(rendered, /# Source Catalog — GEN-1/);
  assert.match(rendered, /Generated from the pinned source manifest/);
  assert.match(rendered, /\| Jira key \| GEN-1 \|/);
  // An attachment is listed but must not read as evidence until it is pinned and hash-verified.
  assert.match(rendered, /brief\.pdf .*\| no \|/);
  assert.match(rendered, /cannot cite them until they are pinned and hash-verified/);

  await assert.rejects(() => renderInitiativeGenerator('not-a-generator', '/tmp', {}), /Unknown initiative output generator/);
});

test('Epic intake is non-authoring and Requirements consumes the pinned source manifest directly', async () => {
  const { validatePortfolio } = await import('../src/initiative-config.mjs');
  const YAMLmod = (await import('yaml')).default;
  const template = YAMLmod.parse(await readFile(path.join(packageRoot, 'templates', 'portfolio.yml'), 'utf8'));
  const portfolio = validatePortfolio(template);
  const intake = portfolio.initiativePhases['epic-intake'];

  // Intake only accepts the Epic identity and pinned sources. All authored enrichment is optional,
  // and repository grounding begins after Story intake creates the canonical Story branch.
  const catalog = intake.outputs.find((output) => output.id === 'source-catalog');
  assert.equal(catalog.generator, 'source-catalog');
  assert.equal(catalog.template, null);
  assert.equal(catalog.required, false);
  assert.deepEqual(intake.checklist.map((check) => check.requirement), ['optional', 'optional']);
  assert.deepEqual(intake.worldModelViews, []);

  const requirements = portfolio.initiativePhases['epic-requirements'];
  assert.deepEqual(
    requirements.outputs.map((output) => output.id),
    ['requirements-specification', 'requirements-traceability', 'impact-analysis']
  );
  assert.equal(
    requirements.checklist.find((check) => check.id === 'material-questions-resolved').requirement,
    'optional'
  );

  const state = await readFile(path.join(packageRoot, 'src', 'initiative-state.mjs'), 'utf8');
  assert.match(state, /producerOutput\?\.required === false && !producerOutput\.sha256\) continue/);
});

test('every promotion target teaches Copilot the fence it will be parsed by', async () => {
  // Promotion recognises artifacts only by <<<SFLOW-ARTIFACT:id …>>>. That format was described
  // solely in phaseTargetInstructions, reachable only for a phase-scoped target — which nothing
  // ever sent. A single-output session was told to produce "a complete Markdown document" and its
  // reply could never be recognised, so no artifact could be promoted from any surface.
  const root = await repository();
  run(root, process.execPath, [bin, 'initiative', 'start', 'INIT-FENCE', '--title', 'Fence coverage']);
  const catalog = await planningTargetCatalog(root, { initiativeId: 'INIT-FENCE' });
  const phase = catalog.targets[0].phases.find((item) => item.targets.length > 2);
  assert.ok(phase, 'expected a phase with more than one promotable output');

  // The whole set is offered first, so a caller taking targets[0] gets every artifact.
  assert.equal(phase.targets[0].id, PHASE_SCOPE);
  const ids = phase.targets.slice(1).map((item) => item.id);

  const whole = await createPlanningContext(root, {
    scope: 'initiative', id: 'INIT-FENCE', phase: phase.id,
    agent: 'product-owner', target: PHASE_SCOPE, objective: 'set'
  });
  const wholeText = await readFile(whole.contextPath, 'utf8');
  for (const id of ids) assert.ok(wholeText.includes(`<<<SFLOW-ARTIFACT:${id}`), `${id} fence missing from phase contract`);

  const single = await createPlanningContext(root, {
    scope: 'initiative', id: 'INIT-FENCE', phase: phase.id,
    agent: 'product-owner', target: ids[0], objective: 'one'
  });
  const singleText = await readFile(single.contextPath, 'utf8');
  assert.ok(singleText.includes(`<<<SFLOW-ARTIFACT:${ids[0]}`), 'single-target contract must describe its own fence');
  assert.ok(!singleText.includes(`<<<SFLOW-ARTIFACT:${ids[1]}`), 'a single-output contract must not invite artifacts it is not scoped to');
});

test('a moved HEAD blocks promotion but does not destroy the conversation', async () => {
  // loadPlanningPack refused outright on a HEAD that had moved, and resume used the same door. So
  // any governed commit in between — publishing another phase, pinning a source, restarting the
  // Epic — took the transcript with it, when all it should do is make the pack unpromotable. The
  // workspace already had a stale-context banner to say exactly that; it never got the chance.
  const { loadPlanningPack, promotePlanningArtifacts } = await import('../src/planning.mjs');
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-STALE', '--title', 'Stale context']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-STALE',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact',
    objective: 'Define the outcome.'
  });

  await writeFile(path.join(root, 'UNRELATED.md'), '# a governed commit lands\n');
  run(root, 'git', ['add', 'UNRELATED.md']);
  run(root, 'git', ['commit', '-m', 'Something else was committed']);

  // Reading it back is fine, and it says plainly that the repository has moved on.
  const pack = await loadPlanningPack(root, context.sessionId, { requireCurrentHead: false });
  assert.equal(pack.headMoved, true);
  assert.equal(pack.manifest.sessionId, context.sessionId);

  // Writing to Git is not: promotion still demands the tree the context was built against.
  await assert.rejects(
    promotePlanningArtifacts(root, { sessionId: context.sessionId, artifacts: [{ id: 'artifact', content: '# Draft\n' }] }),
    /Repository HEAD changed after the planning context was created/
  );
  // …and the default is still the strict one, so no caller gets the loose rule by accident.
  await assert.rejects(loadPlanningPack(root, context.sessionId), /Repository HEAD changed/);
});

test('a changed governed source restores as stale but remains impossible to promote', async () => {
  const { loadPlanningPack } = await import('../src/planning.mjs');
  const root = await repository();
  run(root, process.execPath, [bin, 'start', 'PLAN-SOURCE-STALE', '--title', 'Changed governed state']);
  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-SOURCE-STALE',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact',
    objective: 'Define the outcome.'
  });
  const source = context.manifest.prompt;
  assert.ok(source?.path && !source.path.startsWith('builtin:'), 'planning context should pin its governed prompt');
  const sourcePath = path.join(root, source.path);
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\n`);

  const restored = await loadPlanningPack(root, context.sessionId, { requireCurrentHead: false });
  assert.equal(restored.stale, true);
  assert.equal(restored.changedSources.length, 1);
  assert.equal(restored.changedSources[0].path, source.path);
  assert.equal(restored.changedSources[0].status, 'changed');

  await assert.rejects(
    loadPlanningPack(root, context.sessionId),
    /Governed planning source changed after context creation/
  );
});
