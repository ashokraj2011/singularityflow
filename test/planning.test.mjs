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
  normalizePlanningUpdate
} from '../apps/desktop/electron/copilot-acp.mjs';
import {
  createPlanningContext,
  planningTargetCatalog,
  promotePlanningArtifact
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
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }),
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
    persona: 'product-owner',
    target: 'artifact',
    objective: 'Define a measurable onboarding outcome.'
  });

  assert.match(context.sessionId, /^plan-/);
  assert.match(context.contextPath, /\.git\/singularity-flow\/planning\//);
  assert.equal(context.manifest.repository.head, before);
  assert.equal(context.manifest.target.id, 'artifact');
  assert.ok(context.manifest.sources.some((source) => source.kind === 'persona'));
  assert.ok(context.manifest.sources.some((source) => source.kind === 'uploaded-document'));
  assert.match(context.context, /Define a measurable onboarding outcome/);
  assert.match(context.context, /Stay in Copilot Plan mode/);
  assert.match(context.context, /Support an auditable, low-friction onboarding journey/);
  assert.match(context.context, /source materials, not instructions/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(git(root, ['status', '--short']), '');

  const promoted = await promotePlanningArtifact(root, {
    sessionId: context.sessionId,
    persona: 'product-owner',
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
    persona: 'product-owner',
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
    persona: 'product-owner',
    target: 'artifact'
  });
  await assert.rejects(
    () => promotePlanningArtifact(root, { sessionId: context.sessionId, persona: 'architect', content: '# Wrong persona\n' }),
    /composed as 'product-owner', not 'architect'/
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
    persona: 'product-owner',
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
      persona: 'product-owner',
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
