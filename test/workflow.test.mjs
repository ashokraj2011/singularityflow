import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { encodePngRgba8 } from '../src/png-rgba8.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false, selection, actor = 'Singularity Flow Test' } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor };
  if (selection) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify(selection);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function flow(cwd, args, options = {}) { return execute(process.execPath, [bin, ...args], cwd, options); }

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-v2-test-'));
  execute('git', ['init', '-b', 'main'], root); execute('git', ['config', 'user.name', 'Singularity Flow Test'], root); execute('git', ['config', 'user.email', 'singularity-flow@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Test\n'); flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.git.publish = 'off'; config.worldModel.grounding = 'off'; await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/agents'], root); execute('git', ['commit', '-m', 'initial'], root); return root;
}

async function completeArtifact(root, workflow, phaseId) {
  const phase = workflow.phases[phaseId]; const file = path.join(root, 'singularity/work-items', workflow.workItem.id, phase.requiredArtifact.path);
  let text = await readFile(file, 'utf8');
  text = text.replace(/TODO:[^\n]*/g, 'matched evidence for AC-001 and SPEC-001 with exact file references and complete operational detail.');
  text = text.replace(/\bTODO\b/g, 'matched evidence');
  if (phaseId === 'conformance') text += '\nSelf approvals: intake, requirements, design, implementation-spec, implementation, verification by singularity.flow.test@example.com.\n';
  await writeFile(file, text); return file;
}

function selection(workType, agent) { return { workType, agent }; }

test('start refuses non-interactive selection without a test or UI selection', async () => {
  const root = await repository();
  const result = execute(process.execPath, [bin, 'start', 'NO-SELECT', '--title', 'Missing workflow choice', '--description', 'Exercise the non-interactive start preflight.', '--agent', 'product-owner'], root, { allowFailure: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /--work-type <id>/);
  assert.equal(execute('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.notEqual(execute('git', ['show-ref', '--verify', '--quiet', 'refs/heads/NO-SELECT'], root, { allowFailure: true }).status, 0);
});

test('failed start restores the caller branch and both previous local sessions', async () => {
  const root = await repository();
  const sessionFile = path.join(root, '.git/singularity-flow/session.json');
  const copilotSessionFile = path.join(root, '.git/singularity-flow/copilot-session.json');
  const previousSession = {
    schemaVersion: 2,
    agent: 'architect',
    workId: 'EXISTING-1',
    phaseId: 'design',
    selectedAt: '2026-08-05T00:00:00.000Z'
  };
  const previousCopilotSession = {
    schemaVersion: 1,
    sessionId: 'copilot-before-failed-start',
    workId: 'SESSION-ROLLBACK',
    selectionRequired: true,
    selectedAgent: null
  };
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify(previousSession, null, 2)}\n`);
  await writeFile(copilotSessionFile, `${JSON.stringify(previousCopilotSession, null, 2)}\n`);

  const workId = 'SESSION-ROLLBACK';
  const seedFile = path.join(root, 'singularity/seeds', `${workId}.yml`);
  await mkdir(path.dirname(seedFile), { recursive: true });
  await writeFile(seedFile, YAML.stringify({
    version: 1,
    story: {
      workId: 'DIFFERENT-STORY',
      title: 'Reject the mismatched seed',
      description: 'Reach governed-agent activation, then fail seed ownership validation.',
      acceptanceCriteria: ['The failed start leaves the existing session untouched.'],
      suggestedWorkType: 'feature'
    }
  }));
  execute('git', ['add', 'singularity/seeds'], root);
  execute('git', ['commit', '-m', 'Add mismatched Story seed fixture'], root);

  const result = flow(root, ['start', workId, '--agent', 'product-owner'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not belong to Work ID 'SESSION-ROLLBACK'/);
  assert.equal(execute('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.notEqual(execute('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workId}`], root, { allowFailure: true }).status, 0);
  assert.deepEqual(JSON.parse(await readFile(sessionFile, 'utf8')), previousSession);
  assert.deepEqual(JSON.parse(await readFile(copilotSessionFile, 'utf8')), previousCopilotSession);
  assert.equal(execute('git', ['status', '--short'], root).stdout.trim(), '');
});

test('failed first start leaves no local session or abandoned branch', async () => {
  const root = await repository();
  const workId = 'FIRST-ROLLBACK';
  const seedFile = path.join(root, 'singularity/seeds', `${workId}.yml`);
  await mkdir(path.dirname(seedFile), { recursive: true });
  await writeFile(seedFile, YAML.stringify({
    version: 1,
    story: {
      workId: 'SOMEONE-ELSE',
      title: 'Reject the mismatched seed',
      description: 'Fail after governed-agent activation without a prior local session.',
      acceptanceCriteria: ['No failed-session state remains.'],
      suggestedWorkType: 'feature'
    }
  }));
  execute('git', ['add', 'singularity/seeds'], root);
  execute('git', ['commit', '-m', 'Add first-start rollback fixture'], root);

  const result = flow(root, ['start', workId, '--agent', 'product-owner'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.equal(execute('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.notEqual(execute('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workId}`], root, { allowFailure: true }).status, 0);
  await assert.rejects(readFile(path.join(root, '.git/singularity-flow/session.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, '.git/singularity-flow/copilot-session.json')), { code: 'ENOENT' });
  assert.equal(execute('git', ['status', '--short'], root).stdout.trim(), '');
});

test('cancel requires an exact confirmation and archives work without deleting its artifacts', async () => {
  const root = await repository();
  const workId = 'CANCEL-101';
  flow(root, ['start', workId, '--work-type', 'feature', '--agent', 'product-owner', '--title', 'Stop obsolete work', '--description', 'A replacement Story supersedes this work.']);
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const artifactFile = path.join(root, 'singularity/work-items', workId, 'artifacts/intake/intake.md');
  const before = JSON.parse(await readFile(workflowFile, 'utf8'));

  const unconfirmed = flow(root, ['cancel', workId, '--reason', 'Superseded by CANCEL-102'], { allowFailure: true });
  assert.notEqual(unconfirmed.status, 0);
  assert.match(unconfirmed.stderr, /--confirm CANCEL-101/);
  assert.deepEqual(JSON.parse(await readFile(workflowFile, 'utf8')), before);

  const cancelled = flow(root, ['cancel', workId, '--reason', 'Superseded by CANCEL-102', '--confirm', workId]);
  assert.match(cancelled.stdout, /cancelled and moved to Archived|Story is now archived/i);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.status, 'cancelled');
  assert.equal(workflow.currentPhase, null);
  assert.equal(workflow.phases.intake.status, 'cancelled');
  assert.equal(workflow.cancellation.phase, 'intake');
  assert.equal(workflow.cancellation.reason, 'Superseded by CANCEL-102');
  assert.equal(workflow.cancellation.cancelledBy.email, 'singularity.flow.test@example.com');
  assert.equal(workflow.history.at(-1).event, 'work_cancelled');
  assert.equal(await readFile(artifactFile, 'utf8').then(() => true), true);
  assert.match(await readFile(path.join(root, 'singularity/work-items', workId, 'STATUS.md'), 'utf8'), /cancelled and archived/);
  assert.match(execute('git', ['log', '-1', '--format=%s'], root).stdout, /\[CANCEL-101\]\[cancel\] archive cancelled work/);
  const next = JSON.parse(flow(root, ['nextsteps', workId, '--json']).stdout);
  assert.equal(next.state, 'cancelled');
  assert.ok(next.actions.some((action) => action.command.includes('documents list CANCEL-101')));
});

test('CLI Story start pins configuration and world model from the refreshed configured remote', async () => {
  const source = await repository();
  const configPath = path.join(source, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.remote = 'company';
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'singularity/workflow.yml'], source);
  execute('git', ['commit', '-m', 'configure corporate remote'], source);

  const parent = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-cli-remote-'));
  const remote = path.join(parent, 'remote.git');
  const clone = path.join(parent, 'clone');
  execute('git', ['clone', '--bare', source, remote], parent);
  execute('git', ['clone', remote, clone], parent);
  execute('git', ['remote', 'rename', 'origin', 'company'], clone);
  execute('git', ['config', 'user.name', 'Singularity Flow Test'], clone);
  execute('git', ['config', 'user.email', 'singularity-flow@example.com'], clone);

  const current = YAML.parse(await readFile(configPath, 'utf8'));
  current.workTypes.chore.label = 'Remote governed chore';
  await writeFile(configPath, YAML.stringify(current));
  const worldModelPath = path.join(source, 'singularity/world-model/manifest.json');
  await mkdir(path.dirname(worldModelPath), { recursive: true });
  await writeFile(worldModelPath, JSON.stringify({ marker: 'remote-world-model' }, null, 2));
  execute('git', ['add', 'singularity/workflow.yml', 'singularity/world-model/manifest.json'], source);
  execute('git', ['commit', '-m', 'publish remote workflow and world model'], source);
  execute('git', ['push', remote, 'main'], source);

  flow(clone, ['start', 'WORK-CLI-REMOTE', '--fetch', '--title', 'Use remote state'], {
    selection: selection('chore', 'developer')
  });

  const workflow = JSON.parse(await readFile(path.join(clone, 'singularity/work-items/WORK-CLI-REMOTE/workflow.json'), 'utf8'));
  assert.equal(workflow.workItem.workTypeLabel, 'Remote governed chore');
  const inheritedModel = JSON.parse(await readFile(path.join(clone, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.equal(inheritedModel.marker, 'remote-world-model');
  assert.equal(execute('git', ['branch', '--show-current'], clone).stdout.trim(), 'WORK-CLI-REMOTE');
});

test('agent selection changes only the local session and persists for later actions', async () => {
  const root = await repository(); const workId = 'AGENT-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const before = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const result = flow(root, ['agent', workId, '--agent', 'architect'], { actor: 'Session Architect' });
  assert.match(result.stdout, /Active governed agent: Architect \(architect\)/);
  assert.match(result.stdout, /selection is local to this checkout/);
  const session = JSON.parse(await readFile(path.join(root, '.git/singularity-flow/session.json'), 'utf8'));
  assert.equal(session.agent, 'architect');
  assert.equal(session.workId, workId);
  assert.equal(session.actor.name, 'Session Architect');
  assert.equal(execute('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
  assert.equal(execute('git', ['status', '--short'], root).stdout.trim(), '');
});

test('artifact-only phases reject source changes', async () => {
  const root = await repository(); const workId = 'SCOPE-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json'); const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  await completeArtifact(root, workflow, 'intake'); await mkdir(path.join(root, 'src'), { recursive: true }); await writeFile(path.join(root, 'src/not-allowed.mjs'), 'export const changedTooEarly = true;\n');
  const result = flow(root, ['phase', 'publish', 'intake'], { allowFailure: true, selection: selection('feature', 'product-owner') });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /artifact-only/);
});

test('publication commits sanitized Copilot telemetry under the work item and reports provider cost', async () => {
  const root = await repository(); const workId = 'TELEMETRY-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const completedAt = new Date().toISOString();
  const span = {
    name: 'chat model-alpha-1',
    startTime: new Date(Date.now() - 1000).toISOString(),
    endTime: completedAt,
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'model-alpha-1',
      'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 300,
      'gen_ai.usage.cache_read.input_tokens': 200, 'github.copilot.cost': 0.0123,
      'gen_ai.conversation.id': 'local-conversation-id'
    }
  };
  await writeFile(path.join(root, '.git/singularity-flow/copilot-otel.jsonl'), `${JSON.stringify(span)}\n`);
  await completeArtifact(root, workflow, 'intake');
  flow(root, ['phase', 'publish', 'intake'], { selection: selection('feature', 'product-owner') });

  const published = JSON.parse(await readFile(workflowFile, 'utf8'));
  const usage = published.phases.intake.usage[0];
  assert.equal(usage.source, 'copilot-otel'); assert.equal(usage.model, 'model-alpha-1');
  assert.equal(usage.totalTokens, 1500); assert.equal(usage.providerCost, 0.0123);
  const context = published.phases.intake.telemetry[0];
  assert.equal(context.status, 'exact'); assert.deepEqual(context.models, ['model-alpha-1']);
  const telemetryRecord = JSON.parse(await readFile(path.join(root, context.path), 'utf8'));
  assert.equal(telemetryRecord.workId, workId); assert.equal(telemetryRecord.rawTraceCommitted, false);
  assert.equal(telemetryRecord.usage[0].providerCost, 0.0123);
  assert.doesNotMatch(JSON.stringify(telemetryRecord), /local-conversation-id/);
  const report = JSON.parse(flow(root, ['report', workId, '--format', 'json']).stdout);
  assert.equal(report.phases[0].models[0], 'model-alpha-1'); assert.equal(report.cost, 0.0123); assert.equal(report.costStatus, 'exact');
  const committed = execute('git', ['show', '--name-only', '--format=', 'HEAD'], root).stdout;
  assert.match(committed, /singularity\/work-items\/TELEMETRY-1\/telemetry\/intake-gen1\.json/);
  assert.doesNotMatch(committed, /copilot-otel\.jsonl/);
  assert.equal(flow(root, ['gate']).status, 0);
});

test('Copilot telemetry published before turn completion is reconciled and committed on submit', async () => {
  const root = await repository(); const workId = 'TELEMETRY-LATE-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  await completeArtifact(root, workflow, 'intake');
  const published = flow(root, ['phase', 'publish', 'intake'], { selection: selection('feature', 'product-owner') });
  assert.match(published.stdout, /Telemetry: pending/);
  assert.match(published.stdout, /reconciled automatically on the next submit action/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.telemetry[0].status, 'pending');
  assert.equal(workflow.phases.intake.usage[0].status, 'unavailable');
  assert.equal(JSON.parse(flow(root, ['report', workId, '--format', 'json']).stdout).costCoverage.pendingRecords, 1);

  const span = {
    name: 'chat gpt-5.4',
    startTime: new Date(Date.now() - 1000).toISOString(),
    endTime: new Date().toISOString(),
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.response.model': 'gpt-5.4', 'gen_ai.usage.input_tokens': 800,
      'gen_ai.usage.output_tokens': 200, 'github.copilot.cost': 0.01
    }
  };
  await writeFile(path.join(root, '.git/singularity-flow/copilot-otel.jsonl'), `${JSON.stringify(span)}\n`);
  const telemetryStatus = JSON.parse(flow(root, ['telemetry', 'status', '--json']).stdout);
  assert.equal(telemetryStatus.exists, true);
  assert.equal(telemetryStatus.ready, true);
  assert.equal(telemetryStatus.completedChatSpans, 1);
  assert.deepEqual(telemetryStatus.pending.map((item) => `${item.phase}@${item.generation}`), ['intake@1']);
  const submitted = flow(root, ['submit', '--phase', 'intake'], { selection: selection('feature', 'product-owner') });
  assert.match(submitted.stdout, /Reconciled intake generation 1 telemetry/);
  assert.match(submitted.stdout, /Models: gpt-5.4 \| Tokens: 1000 \| Provider cost: \$0.010000/);

  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.status, 'awaiting_approval');
  assert.equal(workflow.phases.intake.telemetry[0].status, 'exact');
  assert.equal(workflow.phases.intake.usage[0].totalTokens, 1000);
  assert.equal(workflow.phases.intake.usage[0].providerCost, 0.01);
  assert.equal(workflow.usage.totalTokens, 1000);
  assert.equal(workflow.usage.exactRecords, 1);
  assert.equal(workflow.usage.unavailableRecords, 0);
  assert.ok(workflow.history.some((item) => item.event === 'phase_telemetry_reconciled'));
  const subjects = execute('git', ['log', '-3', '--format=%s'], root).stdout;
  assert.match(subjects, /\[TELEMETRY-LATE-1\]\[phase:intake\]\[telemetry:1\] reconcile Copilot usage/);
});

test('next executes one valid lifecycle action at a time', async () => {
  const root = await repository(); const workId = 'NEXT-AUTO-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const prepared = flow(root, ['next', '--task', 'Capture automatic intake'], { selection: selection('feature', 'product-owner') });
  assert.match(prepared.stdout, /Next step prepared: generate 'intake'/);
  assert.match(flow(root, ['nextsteps']).stdout, /Automatic next action in Copilot: \/sf-next/);
  await completeArtifact(root, workflow, 'intake');
  flow(root, ['phase', 'publish', 'intake'], { selection: selection('feature', 'product-owner') });

  const unattendedRun = flow(root, ['run'], { allowFailure: true, selection: selection('feature', 'product-owner') });
  assert.notEqual(unattendedRun.status, 0);
  assert.match(unattendedRun.stderr, /interactive terminal or the explicit --yes flag/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.status, 'in_progress');

  const submitted = flow(root, ['next'], { selection: selection('feature', 'product-owner') });
  assert.match(submitted.stdout, /Next action in Copilot: \/sf-submit intake/);
  assert.match(submitted.stdout, /Run: singularity-flow submit intake/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.status, 'awaiting_approval');

  const approved = flow(root, ['next', '--yes'], { selection: selection('feature', 'product-owner'), actor: 'Next Reviewer' });
  assert.match(approved.stdout, /Approval decision committed [0-9a-f]{8} locally/);
  assert.match(approved.stdout, /Context boundary: new/);
  assert.match(approved.stdout, /1\. \/clear/);
  assert.match(approved.stdout, /2\. \/sf-next/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');
  assert.deepEqual(workflow.resolution.contextPolicy, { onApproval: 'new', onRejection: 'keep', phaseOverrides: {} });
  assert.equal(execute('git', ['log', '-1', '--format=%s'], root).stdout.trim(), `[${workId}][phase:intake][approve] product-approvers`);
});

test('next never launches a missing world-model agent unattended', async () => {
  const root = await repository();
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.grounding = 'enforce';
  await writeFile(definitionPath, YAML.stringify(definition));
  execute('git', ['add', 'singularity/workflow.yml'], root);
  execute('git', ['commit', '-m', 'enforce grounding'], root);
  flow(root, ['start', 'NEXT-CONSENT-1', '--work-type', 'feature', '--agent', 'product-owner', '--title', 'Consent test', '--description', 'Do not run a model unattended.']);

  const result = flow(root, ['next', '--task', 'Consent test'], { allowFailure: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Next step prerequisite:/);
  assert.match(result.stdout, /No model was started/);
  assert.match(result.stdout, /singularity-flow wm build/);
  assert.equal(execute('git', ['worktree', 'list', '--porcelain'], root).stdout.match(/^worktree /gm)?.length, 1);
  assert.equal(execute('git', ['status', '--short'], root).stdout.trim(), '');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/NEXT-CONSENT-1/workflow.json'), 'utf8'));
  assert.equal(workflow.phases.intake.generation, 0);
});

test('feature profile publishes generations, records tokens, approvals, and conformance', async () => {
  const root = await repository(); const workId = 'FEATURE-101';
  flow(root, ['start', workId, '--title', 'Configurable workflow'], { selection: selection('feature', 'product-owner') });
  flow(root, ['wm', 'light', '--views', 'business,architecture,development,testing,release,operations,security', '--local']);
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const agents = { intake: 'product-owner', requirements: 'product-owner', design: 'architect', 'implementation-spec': 'architect', implementation: 'developer', verification: 'qa', conformance: 'qa' };
  for (const phaseId of ['intake', 'requirements', 'design', 'implementation-spec', 'implementation', 'verification', 'conformance']) {
    let workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.currentPhase, phaseId); flow(root, ['prepare', phaseId], { selection: selection('feature', agents[phaseId]) });
    flow(root, ['resume', workId], { selection: selection('feature', agents[phaseId]) });
    await completeArtifact(root, workflow, phaseId);
    flow(root, ['wm', 'compose', '--phase', phaseId]);
    workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    if (workflow.resolution.phases.find((entry) => entry.id === phaseId)?.clarification?.mode === 'required') {
      flow(root, ['clarification', 'record', phaseId,
        '--question', `Are the governed ${phaseId} decisions complete and supported by the recorded evidence?`,
        '--answer', 'Yes. Use the pinned evidence and approved upstream artifacts; no additional assumption is authorized.'
      ]);
    }
    if (phaseId === 'implementation') {
      await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'tests'), { recursive: true });
      await writeFile(path.join(root, 'src/feature.mjs'), 'export const feature = true; // SPEC-001\n'); await writeFile(path.join(root, 'tests/feature.test.mjs'), '// @ac:AC-001 SPEC-001\n');
    }
    const usagePath = path.join(root, '.git/usage.json'); await writeFile(usagePath, JSON.stringify({ provider: 'test', model: 'test-model', inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    flow(root, ['phase', 'publish', phaseId, '--authored', 'governed-agent', '--channel', 'copilot-host', '--usage-json', usagePath], { selection: selection('feature', agents[phaseId]) });
    flow(root, ['submit'], { selection: selection('feature', agents[phaseId]) });
    flow(root, ['approve', '--yes'], { selection: selection('feature', agents[phaseId]) });
  }
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.status, 'complete'); assert.equal(workflow.usage.totalTokens, 105);
  assert.equal(workflow.usage.byWorkType.feature.totalTokens, 105); assert.equal(workflow.usage.byWorkItem[workId].records, 7);
  assert.equal(workflow.usage.byAgent.architect.totalTokens, 30); assert.equal(workflow.usage.byPhase.verification.totalTokens, 15);
  assert.equal(workflow.usage.exactRecords, 7); assert.equal(workflow.usage.unavailableRecords, 0);
  assert.match(workflow.phases.design.generationCommit, /^[0-9a-f]{40}$/); assert.equal(workflow.phases.design.publicationCommit, workflow.phases.design.generationCommit);
  assert.match(workflow.resolution.sourceSha256, /^[0-9a-f]{64}$/);
  const designArtifact = await readFile(path.join(root, 'singularity/work-items', workId, workflow.phases.design.requiredArtifact.path), 'utf8');
  assert.match(designArtifact, /^<!-- singularity-flow:metadata/);
  assert.match(designArtifact, /"generationCommit": "[0-9a-f]{40}"/); assert.match(designArtifact, /"publicationCommit": "[0-9a-f]{40}"/);
  assert.ok(workflow.phases.design.approvals[0].selfApproval); assert.equal(workflow.workItem.workType, 'feature'); assert.ok(workflow.resolution.templates['implementation-spec'].sha256);
  assert.equal(workflow.resolution.inputsMode, 'enforce');
  const designInputRecord = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'context/inputs-design-gen1.json'), 'utf8'));
  assert.equal(designInputRecord.inputs[0].phase, 'requirements'); assert.equal(designInputRecord.inputs[0].status, 'captured');
  const implementationInputRecord = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'context/inputs-implementation-gen1.json'), 'utf8'));
  assert.deepEqual(implementationInputRecord.inputs.map((input) => input.phase), ['design', 'implementation-spec']);
  assert.ok(implementationInputRecord.inputs.every((input) => input.status === 'captured'));
  assert.match(designArtifact, /singularity-flow:inputs:start/);
  const report = JSON.parse(flow(root, ['report', workId, '--format', 'json']).stdout); assert.equal(report.workItem.id, workId); assert.equal(report.workItem.status, 'complete'); assert.equal(report.tokens.total, 105); assert.equal(report.phases.length, 7); assert.equal(report.cost, null);
  assert.match(flow(root, ['report', workId]).stdout, /wall-clock elapsed time/);
  const htmlReport = path.join(root, '.git', 'workflow-report.html'); flow(root, ['report', workId, '--format', 'html', '--out', htmlReport]); assert.match(await readFile(htmlReport, 'utf8'), /<svg/);
  assert.equal(flow(root, ['gate', '--terminal']).status, 0);
});

test('figma-mobile completes the governed design-to-visual-conformance lifecycle', async () => {
  const root = await repository(); const workId = 'MOBILE-101';
  flow(root, ['start', workId, '--title', 'Build approved mobile screens'], { selection: selection('figma-mobile', 'product-designer') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const agents = {
    'design-intake': 'product-designer', 'design-inventory': 'product-designer',
    'component-mapping': 'mobile-architect', 'mobile-spec': 'mobile-architect',
    implementation: 'developer', 'visual-verification': 'qa', conformance: 'qa'
  };
  const phases = ['design-intake', 'design-inventory', 'component-mapping', 'mobile-spec', 'implementation', 'visual-verification', 'conformance'];
  for (const phaseId of phases) {
    let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    assert.equal(workflow.currentPhase, phaseId);
    flow(root, ['prepare', phaseId], { selection: selection('figma-mobile', agents[phaseId]) });
    flow(root, ['resume', workId], { selection: selection('figma-mobile', agents[phaseId]) });
    workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    await completeArtifact(root, workflow, phaseId);
    if (phaseId === 'design-intake') {
      await writeFile(path.join(root, 'figma-metadata.xml'), '<figma><frame id="1:3" name="Checkout" /></figma>\n');
      flow(root, ['mcp', 'record', 'figma', '--kind', 'design-source', '--tool', 'get_metadata', '--phase', phaseId,
        '--output', 'figma-metadata.xml', '--file-key', 'checkout-mobile', '--file-version', 'v1', '--node', '1:3'],
      { selection: selection('figma-mobile', agents[phaseId]) });
      await unlink(path.join(root, 'figma-metadata.xml'));
    }
    if (phaseId === 'implementation') {
      await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'tests'), { recursive: true });
      await writeFile(path.join(root, 'src/mobile.mjs'), 'export const mobile = true; // SPEC-001\n');
      await writeFile(path.join(root, 'tests/mobile.test.mjs'), '// @ac:AC-001 SPEC-001\n');
    }
    if (phaseId === 'visual-verification') {
      for (const profile of workflow.resolution.verification.profiles) {
        const width = profile.width * profile.deviceScaleFactor, height = profile.height * profile.deviceScaleFactor;
        const png = encodePngRgba8({ width, height, data: Buffer.alloc(width * height * 4, 255) });
        const output = `${profile.id}.png`; await writeFile(path.join(root, output), png);
        flow(root, ['mcp', 'record', 'playwright', '--kind', 'visual-artifact', '--tool', 'browser_take_screenshot',
          '--phase', phaseId, '--output', output, '--profile-id', profile.id, '--screen-id', 'checkout', '--state-id', 'default'],
        { selection: selection('figma-mobile', agents[phaseId]) });
        await unlink(path.join(root, output));
      }
    }
    flow(root, ['phase', 'publish', phaseId], { selection: selection('figma-mobile', agents[phaseId]) });
    flow(root, ['submit'], { selection: selection('figma-mobile', agents[phaseId]) });
    const approvalActors = ['Mobile Reviewer One', ...(phaseId === 'visual-verification' || phaseId === 'conformance' ? ['Mobile Reviewer Two'] : [])];
    for (const actor of approvalActors) {
      flow(root, ['approve', '--yes'], { actor, selection: selection('figma-mobile', agents[phaseId]) });
    }
  }
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.status, 'complete');
  assert.equal(workflow.phases['design-intake'].designSourceSets.length, 1);
  assert.equal(workflow.phases['design-intake'].approvals.at(-1).designSourceSet.records[0].fileVersion, 'v1');
  assert.equal(workflow.phases['visual-verification'].approvals.filter((approval) => approval.decision === 'approved').length, 2);
  assert.equal(flow(root, ['gate', '--terminal']).status, 0);
});

test('bugfix profile is immutable and rejection reopens an allowed earlier phase', async () => {
  const root = await repository(); const workId = 'BUG-101';
  flow(root, ['start', workId], { selection: selection('bugfix', 'qa') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json'); let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(workflow.phaseOrder, ['intake', 'reproduction', 'fix-design', 'fix-spec', 'implementation', 'verification', 'conformance']); assert.equal(workflow.workItem.workType, 'bugfix');
  await completeArtifact(root, workflow, 'intake'); flow(root, ['phase', 'publish', 'intake'], { selection: selection('bugfix', 'product-owner') }); flow(root, ['submit'], { selection: selection('bugfix', 'product-owner') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.usage.unavailableRecords, 1); assert.equal(workflow.phases.intake.usage[0].status, 'unavailable');
  flow(root, ['approve', '--yes'], { selection: selection('bugfix', 'product-owner') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); flow(root, ['prepare', 'reproduction'], { selection: selection('bugfix', 'qa') }); await completeArtifact(root, workflow, 'reproduction');
  flow(root, ['resume', workId], { selection: selection('bugfix', 'qa') }); flow(root, ['phase', 'publish', 'reproduction'], { selection: selection('bugfix', 'qa') }); flow(root, ['submit'], { selection: selection('bugfix', 'qa') });
  flow(root, ['reject', '--to', 'intake', '--reason', 'Need stronger impact evidence'], { selection: selection('bugfix', 'qa') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.currentPhase, 'intake'); assert.equal(workflow.phases.intake.rejectionReason, 'Need stronger impact evidence'); assert.equal(workflow.workItem.workType, 'bugfix');
  assert.deepEqual(workflow.changeRequests.map(({ id, status, sourcePhase, targetPhase, comment }) => ({ id, status, sourcePhase, targetPhase, comment })), [{
    id: 'CR-001', status: 'open', sourcePhase: 'reproduction', targetPhase: 'intake', comment: 'Need stronger impact evidence'
  }]);
  assert.equal(workflow.phases.reproduction.approvals.at(-1).changeRequestId, 'CR-001');
  assert.equal(workflow.phases.intake.approvals[0].invalidatedAt != null, true); assert.equal(workflow.phases.reproduction.status, 'not_started');
  flow(root, ['prepare', 'intake'], { selection: selection('bugfix', 'product-owner') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); await completeArtifact(root, workflow, 'intake');
  flow(root, ['phase', 'publish', 'intake'], { selection: selection('bugfix', 'product-owner') });
  flow(root, ['submit'], { selection: selection('bugfix', 'product-owner') });
  flow(root, ['approve', '--yes'], { selection: selection('bugfix', 'product-owner') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.changeRequests[0].status, 'resolved');
  assert.equal(workflow.changeRequests[0].resolution.phase, 'intake');
  assert.equal(workflow.changeRequests[0].resolution.generation, 2);
  assert.deepEqual(workflow.phases.intake.approvals.at(-1).resolvedChangeRequests, ['CR-001']);
  workflow.workItem.workType = 'feature'; await writeFile(workflowFile, JSON.stringify(workflow, null, 2));
  const tampered = flow(root, ['validate'], { allowFailure: true, selection: selection('bugfix', 'qa') }); assert.notEqual(tampered.status, 0); assert.match(tampered.stderr, /immutable profile snapshot/);
});

test('completed work can be reopened only through an authorized governed change request', async () => {
  const root = await repository(); const workId = 'REOPEN-1';
  flow(root, ['start', workId], { selection: selection('chore', 'developer') });
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  workflow.status = 'complete'; workflow.currentPhase = null;
  for (const phaseId of workflow.phaseOrder) workflow.phases[phaseId].status = 'approved';
  await writeFile(workflowFile, JSON.stringify(workflow, null, 2));
  execute('git', ['add', workflowFile], root); execute('git', ['commit', '-m', 'simulate completed story'], root);

  const result = flow(root, ['reopen', workId, '--to', 'implementation', '--reason', 'Production feedback requires safer rollback behavior']);
  assert.match(result.stdout, /Reopened REOPEN-1 at implementation with CR-001/);
  const reopened = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(reopened.status, 'in_progress'); assert.equal(reopened.currentPhase, 'implementation');
  assert.equal(reopened.phases.implementation.status, 'in_progress');
  assert.equal(reopened.phases.verification.status, 'not_started');
  assert.equal(reopened.changeRequests[0].status, 'open');
  assert.equal(reopened.changeRequests[0].comment, 'Production feedback requires safer rollback behavior');
  assert.equal(reopened.history.at(-1).event, 'workflow_reopened');
  assert.match(await readFile(path.join(root, 'singularity/work-items', workId, 'STATUS.md'), 'utf8'),
    /CR-001.*Production feedback requires safer rollback behavior/);
});

test('multi-approval threshold requires distinct identities while allowing agent selection', async () => {
  const root = await repository(); const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.phases.intake.approval.minimum = 2; await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', configPath], root); execute('git', ['commit', '-m', 'require two intake approvals'], root);
  const workId = 'MULTI-1'; flow(root, ['start', workId], { selection: selection('feature', 'product-owner'), actor: 'Generator' }); const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json'); let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  await completeArtifact(root, workflow, 'intake'); flow(root, ['phase', 'publish', 'intake'], { selection: selection('feature', 'product-owner'), actor: 'Generator' }); flow(root, ['submit'], { selection: selection('feature', 'product-owner'), actor: 'Generator' });
  const firstApproval = flow(root, ['approve', '--yes'], { selection: selection('feature', 'product-owner'), actor: 'Reviewer One' }); workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.currentPhase, 'intake'); assert.equal(workflow.phases.intake.status, 'awaiting_approval');
  assert.match(firstApproval.stdout, /Approval decision committed [0-9a-f]{8} locally/);
  const firstApprovalCommit = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const duplicate = flow(root, ['approve', '--yes'], { selection: selection('feature', 'product-owner'), actor: 'Reviewer One', allowFailure: true }); assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /already approved/);
  const secondApproval = flow(root, ['approve', '--yes'], { selection: selection('feature', 'product-owner'), actor: 'Reviewer Two' }); workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.currentPhase, 'requirements'); assert.equal(workflow.phases.intake.approvals.filter((item) => item.decision === 'approved').length, 2);
  assert.match(secondApproval.stdout, /Approval decision committed [0-9a-f]{8} locally/);
  const secondApprovalCommit = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assert.notEqual(secondApprovalCommit, firstApprovalCommit);
  assert.equal(execute('git', ['log', '--format=%s', '--grep', '\\[MULTI-1\\]\\[phase:intake\\]\\[approve\\]'], root).stdout.trim().split(/\r?\n/).filter(Boolean).length, 2);
});
