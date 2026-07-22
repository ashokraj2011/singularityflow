import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

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
  const configPath = path.join(root, '.singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.git.publish = 'off'; config.worldModel.grounding = 'off'; await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', '.singularity'], root); execute('git', ['commit', '-m', 'initial'], root); return root;
}

async function completeArtifact(root, workflow, phaseId) {
  const phase = workflow.phases[phaseId]; const file = path.join(root, '.singularity/work-items', workflow.workItem.id, phase.requiredArtifact.path);
  let text = await readFile(file, 'utf8');
  text = text.replace(/TODO:[^\n]*/g, 'matched evidence for AC-001 and SPEC-001 with exact file references and complete operational detail.');
  text = text.replace(/\bTODO\b/g, 'matched evidence');
  if (phaseId === 'conformance') text += '\nSelf approvals: intake, requirements, design, implementation-spec, implementation, verification by singularity.flow.test@example.com.\n';
  await writeFile(file, text); return file;
}

function selection(workType, persona) { return { workType, persona }; }

test('start refuses non-interactive selection without a test or UI selection', async () => {
  const root = await repository();
  const result = execute(process.execPath, [bin, 'start', 'NO-SELECT'], root, { allowFailure: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /requires an interactive terminal/);
});

test('persona selection changes only the local session and persists for later actions', async () => {
  const root = await repository(); const workId = 'PERSONA-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const before = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const result = flow(root, ['persona', workId], { selection: selection('feature', 'architect'), actor: 'Session Architect' });
  assert.match(result.stdout, /Active persona: Architect \(architect\)/);
  assert.match(result.stdout, /selection is local to this checkout/);
  const session = JSON.parse(await readFile(path.join(root, '.git/singularity-flow/session.json'), 'utf8'));
  assert.equal(session.persona, 'architect');
  assert.equal(session.workId, workId);
  assert.equal(session.actor.name, 'Session Architect');
  assert.equal(execute('git', ['rev-parse', 'HEAD'], root).stdout.trim(), before);
  assert.equal(execute('git', ['status', '--short'], root).stdout.trim(), '');
});

test('artifact-only phases reject source changes', async () => {
  const root = await repository(); const workId = 'SCOPE-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, '.singularity/work-items', workId, 'workflow.json'); const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  await completeArtifact(root, workflow, 'intake'); await mkdir(path.join(root, 'src'), { recursive: true }); await writeFile(path.join(root, 'src/not-allowed.mjs'), 'export const changedTooEarly = true;\n');
  const result = flow(root, ['phase', 'publish', 'intake'], { allowFailure: true, selection: selection('feature', 'product-owner') });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /artifact-only/);
});

test('publication commits sanitized Copilot telemetry under the work item and reports provider cost', async () => {
  const root = await repository(); const workId = 'TELEMETRY-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, '.singularity/work-items', workId, 'workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const completedAt = new Date().toISOString();
  const span = {
    name: 'chat claude-sonnet-4.6',
    startTime: new Date(Date.now() - 1000).toISOString(),
    endTime: completedAt,
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'claude-sonnet-4.6',
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
  assert.equal(usage.source, 'copilot-otel'); assert.equal(usage.model, 'claude-sonnet-4.6');
  assert.equal(usage.totalTokens, 1500); assert.equal(usage.providerCost, 0.0123);
  const context = published.phases.intake.telemetry[0];
  assert.equal(context.status, 'exact'); assert.deepEqual(context.models, ['claude-sonnet-4.6']);
  const telemetryRecord = JSON.parse(await readFile(path.join(root, context.path), 'utf8'));
  assert.equal(telemetryRecord.workId, workId); assert.equal(telemetryRecord.rawTraceCommitted, false);
  assert.equal(telemetryRecord.usage[0].providerCost, 0.0123);
  assert.doesNotMatch(JSON.stringify(telemetryRecord), /local-conversation-id/);
  const report = JSON.parse(flow(root, ['report', workId, '--format', 'json']).stdout);
  assert.equal(report.phases[0].models[0], 'claude-sonnet-4.6'); assert.equal(report.cost, 0.0123); assert.equal(report.costStatus, 'exact');
  const committed = execute('git', ['show', '--name-only', '--format=', 'HEAD'], root).stdout;
  assert.match(committed, /\.singularity\/work-items\/TELEMETRY-1\/telemetry\/intake-gen1\.json/);
  assert.doesNotMatch(committed, /copilot-otel\.jsonl/);
  assert.equal(flow(root, ['gate']).status, 0);
});

test('next executes one valid lifecycle action at a time', async () => {
  const root = await repository(); const workId = 'NEXT-AUTO-1';
  flow(root, ['start', workId], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, '.singularity/work-items', workId, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const prepared = flow(root, ['next', '--task', 'Capture automatic intake'], { selection: selection('feature', 'product-owner') });
  assert.match(prepared.stdout, /Next step prepared: generate 'intake'/);
  assert.match(flow(root, ['nextsteps']).stdout, /Automatic next action: sflow-next/);
  await completeArtifact(root, workflow, 'intake');
  flow(root, ['phase', 'publish', 'intake'], { selection: selection('feature', 'product-owner') });

  const submitted = flow(root, ['next'], { selection: selection('feature', 'product-owner') });
  assert.match(submitted.stdout, /Next step: submit published phase 'intake'/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.status, 'awaiting_approval');

  const approved = flow(root, ['next', '--yes'], { selection: selection('feature', 'product-owner'), actor: 'Next Reviewer' });
  assert.match(approved.stdout, /Approval decision committed [0-9a-f]{8} locally/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(execute('git', ['log', '-1', '--format=%s'], root).stdout.trim(), `[${workId}][phase:intake][approve] product-owner`);
});

test('feature profile publishes generations, records tokens, approvals, and conformance', async () => {
  const root = await repository(); const workId = 'FEATURE-101';
  flow(root, ['start', workId, '--title', 'Configurable workflow'], { selection: selection('feature', 'product-owner') });
  const workflowFile = path.join(root, '.singularity/work-items', workId, 'workflow.json');
  const personas = { intake: 'product-owner', requirements: 'product-owner', design: 'architect', 'implementation-spec': 'architect', implementation: 'developer', verification: 'qa', conformance: 'qa' };
  for (const phaseId of ['intake', 'requirements', 'design', 'implementation-spec', 'implementation', 'verification', 'conformance']) {
    let workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.currentPhase, phaseId); flow(root, ['prepare', phaseId], { selection: selection('feature', personas[phaseId]) });
    flow(root, ['resume', workId], { selection: selection('feature', personas[phaseId]) });
    await completeArtifact(root, workflow, phaseId);
    if (phaseId === 'implementation') {
      await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'tests'), { recursive: true });
      await writeFile(path.join(root, 'src/feature.mjs'), 'export const feature = true; // SPEC-001\n'); await writeFile(path.join(root, 'tests/feature.test.mjs'), '// @ac:AC-001 SPEC-001\n');
    }
    const usagePath = path.join(root, '.git/usage.json'); await writeFile(usagePath, JSON.stringify({ provider: 'test', model: 'test-model', inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    flow(root, ['phase', 'publish', phaseId, '--usage-json', usagePath], { selection: selection('feature', personas[phaseId]) });
    flow(root, ['submit'], { selection: selection('feature', personas[phaseId]) });
    flow(root, ['approve', '--yes'], { selection: selection('feature', personas[phaseId]) });
  }
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.status, 'complete'); assert.equal(workflow.usage.totalTokens, 105);
  assert.equal(workflow.usage.byWorkType.feature.totalTokens, 105); assert.equal(workflow.usage.byWorkItem[workId].records, 7);
  assert.equal(workflow.usage.byPersona.architect.totalTokens, 30); assert.equal(workflow.usage.byPhase.verification.totalTokens, 15);
  assert.equal(workflow.usage.exactRecords, 7); assert.equal(workflow.usage.unavailableRecords, 0);
  assert.match(workflow.phases.design.generationCommit, /^[0-9a-f]{40}$/); assert.equal(workflow.phases.design.publicationCommit, workflow.phases.design.generationCommit);
  assert.match(workflow.resolution.sourceSha256, /^[0-9a-f]{64}$/);
  const designArtifact = await readFile(path.join(root, '.singularity/work-items', workId, workflow.phases.design.requiredArtifact.path), 'utf8');
  assert.match(designArtifact, /"generationCommit": "[0-9a-f]{40}"/); assert.match(designArtifact, /"publicationCommit": "[0-9a-f]{40}"/);
  assert.ok(workflow.phases.design.approvals[0].selfApproval); assert.equal(workflow.workItem.workType, 'feature'); assert.ok(workflow.resolution.templates['implementation-spec'].sha256);
  assert.equal(workflow.resolution.inputsMode, 'record');
  const designInputRecord = JSON.parse(await readFile(path.join(root, '.singularity/work-items', workId, 'context/inputs-design-gen1.json'), 'utf8'));
  assert.equal(designInputRecord.inputs[0].phase, 'requirements'); assert.equal(designInputRecord.inputs[0].status, 'captured');
  assert.match(designArtifact, /singularity-flow:inputs:start/);
  const report = JSON.parse(flow(root, ['report', workId, '--format', 'json']).stdout); assert.equal(report.workItem.id, workId); assert.equal(report.workItem.status, 'complete'); assert.equal(report.tokens.total, 105); assert.equal(report.phases.length, 7); assert.equal(report.cost, null);
  assert.match(flow(root, ['report', workId]).stdout, /wall-clock elapsed time/);
  const htmlReport = path.join(root, '.git', 'workflow-report.html'); flow(root, ['report', workId, '--format', 'html', '--out', htmlReport]); assert.match(await readFile(htmlReport, 'utf8'), /<svg/);
  assert.equal(flow(root, ['gate', '--terminal']).status, 0);
});

test('bugfix profile is immutable and rejection reopens an allowed earlier phase', async () => {
  const root = await repository(); const workId = 'BUG-101';
  flow(root, ['start', workId], { selection: selection('bugfix', 'qa') });
  const workflowFile = path.join(root, '.singularity/work-items', workId, 'workflow.json'); let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(workflow.phaseOrder, ['intake', 'reproduction', 'fix-design', 'fix-spec', 'implementation', 'verification', 'conformance']); assert.equal(workflow.workItem.workType, 'bugfix');
  await completeArtifact(root, workflow, 'intake'); flow(root, ['phase', 'publish', 'intake'], { selection: selection('bugfix', 'product-owner') }); flow(root, ['submit'], { selection: selection('bugfix', 'product-owner') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.usage.unavailableRecords, 1); assert.equal(workflow.phases.intake.usage[0].status, 'unavailable');
  flow(root, ['approve', '--yes'], { selection: selection('bugfix', 'product-owner') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); flow(root, ['prepare', 'reproduction'], { selection: selection('bugfix', 'qa') }); await completeArtifact(root, workflow, 'reproduction');
  flow(root, ['resume', workId], { selection: selection('bugfix', 'qa') }); flow(root, ['phase', 'publish', 'reproduction'], { selection: selection('bugfix', 'qa') }); flow(root, ['submit'], { selection: selection('bugfix', 'qa') });
  flow(root, ['reject', '--to', 'intake', '--reason', 'Need stronger impact evidence'], { selection: selection('bugfix', 'qa') });
  workflow = JSON.parse(await readFile(workflowFile, 'utf8')); assert.equal(workflow.currentPhase, 'intake'); assert.equal(workflow.phases.intake.rejectionReason, 'Need stronger impact evidence'); assert.equal(workflow.workItem.workType, 'bugfix');
  assert.equal(workflow.phases.intake.approvals[0].invalidatedAt != null, true); assert.equal(workflow.phases.reproduction.status, 'not_started');
  workflow.workItem.workType = 'feature'; await writeFile(workflowFile, JSON.stringify(workflow, null, 2));
  const tampered = flow(root, ['validate'], { allowFailure: true, selection: selection('bugfix', 'qa') }); assert.notEqual(tampered.status, 0); assert.match(tampered.stderr, /immutable profile snapshot/);
});

test('multi-approval threshold requires distinct identities while allowing persona selection', async () => {
  const root = await repository(); const configPath = path.join(root, '.singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.phases.intake.approval.minimum = 2; await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', configPath], root); execute('git', ['commit', '-m', 'require two intake approvals'], root);
  const workId = 'MULTI-1'; flow(root, ['start', workId], { selection: selection('feature', 'product-owner'), actor: 'Generator' }); const workflowFile = path.join(root, '.singularity/work-items', workId, 'workflow.json'); let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
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
