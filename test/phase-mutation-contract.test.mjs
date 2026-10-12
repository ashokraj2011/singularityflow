import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { deriveMutationContract, mutationPathDecision, mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { recordRepositoryBoundaryTurn, endRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard, mutationPostToolGuard, issueMutationStaging, refreshMutationContracts, endMutationDecisionTurns } from '../src/copilot-mutation-guard.mjs';
import { createHash } from 'node:crypto';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { assertPhaseSequence } from '../src/sequence.mjs';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';

async function fixture(t, phaseOverrides = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-pmc-'));
  const directory = await realpath(temporary);
  const root = path.join(directory, 'repository');
  await mkdir(root);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.name', 'PMC Tester']); git(['config', 'user.email', 'pmc@example.test']);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  const phase = { id: 'custom-step', status: 'in_progress', generation: 0, writeScope: 'artifact-only',
    generationPolicy: { task: 'document', requirement: 'required' }, ...phaseOverrides };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git(['add', 'src', 'singularity']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const enter = async (skill, sessionId = 'author') => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (payload, record) => captureMutationTurn(payload, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return { ...payload, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } };
  };
  return { root, git, phase, definition, workflow, workflowFile, accepted, enter,
    contract: turnMode => deriveMutationContract({ root, definition, workflow, turnMode }) };
}

test('permissions follow pinned output policy, not names, and testing is not code generation', async t => {
  const f = await fixture(t, { id: 'planning', writeScope: 'source-and-artifact' });
  assert.equal(f.contract('authoring').policy.requiresOpenGeneration, false);
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, false, 'no earlier approved code owner');
  f.workflow.phaseOrder.unshift('earlier-code');
  f.workflow.phases['earlier-code'] = { id: 'earlier-code', status: 'approved', generationPolicy: { task: 'code' } };
  f.phase.sourceBoundary = 'test-automation';
  const testing = f.contract('authoring');
  assert.equal(testing.policy.requiresOpenGeneration, false);
  assert.equal(mutationPathDecision(testing, 'src/new.test.jsx').allowed, true);
  assert.equal(mutationPathDecision(testing, 'src/App.jsx').allowed, false);
  f.phase.generationPolicy.task = 'code'; f.phase.sourceBoundary = 'unrestricted';
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, false);
  f.phase.generationIntent = { status: 'open', generation: 1 };
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, true);
  assert.equal(mutationPathDecision(f.contract('authoring'), '.GIT/config').allowed, false);
  const rootStat = await import('node:fs').then(fs => fs.lstatSync(f.root));
  const alternateStat = await import('node:fs').then(fs => {
    try { return fs.lstatSync(path.join(path.dirname(f.root), 'REPOSITORY')); } catch { return null; }
  });
  if (alternateStat?.ino === rootStat.ino && alternateStat.dev === rootStat.dev) {
    assert.equal(f.contract('authoring').ownership.caseInsensitivePaths, true);
    assert.equal(mutationPathDecision(f.contract('authoring'), 'Singularity/WORK-ITEMS/PMC-1/workflow.json').allowed, false);
  }
  f.phase.generation = 1; f.phase.generationIntent.status = 'consumed';
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, false);
});

test('artifact edits and creation work, protected/state/other-repository paths do not', async t => {
  const f = await fixture(t);
  const contract = f.contract('authoring');
  assert.equal(mutationPathDecision(contract, 'singularity/work-items/PMC-1/artifacts/custom-step/new.md').allowed, true);
  assert.equal(mutationPathDecision(contract, pathToFileURL(path.join(f.root, 'singularity/work-items/PMC-1/artifacts/custom-step/new.md')).href).allowed, true);
  assert.equal(mutationPathDecision(contract, pathToFileURL(path.join(f.root, 'src/App.jsx')).href).allowed, false);
  for (const target of ['src/App.jsx', 'policy/new.yml', '.git/config', 'singularity/work-items/PMC-1/workflow.json',
    'singularity/work-items/OTHER/artifacts/custom-step/spec.md', '../outside.txt']) assert.equal(mutationPathDecision(contract, target).allowed, false, target);
  await symlink(path.join(f.root, 'src'), path.join(f.root, 'singularity/work-items/PMC-1/artifacts'));
  assert.equal(mutationPathDecision(contract, 'singularity/work-items/PMC-1/artifacts/custom-step/new.md').allowed, false);
});

test('the shipped edit guard denies direct and batched source patches with three-surface remedies', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-phase');
  const refused = await mutationToolGuard(payload);
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /Copilot:.*Shell:.*Model-free:/u);
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'apply_patch', toolArgs: {
    patch: '*** Begin Patch\n*** Add File: singularity/work-items/PMC-1/artifacts/custom-step/plan.md\n+x\n*** End Patch' }
  })).permissionDecision, undefined);
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'apply_patch', toolArgs: {
    patch: '*** Begin Patch\n*** Update File: src/App.jsx\n+x\n*** End Patch' }
  })).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'move_file', toolArgs: {
    source: 'src/App.jsx', destination: 'singularity/work-items/PMC-1/artifacts/custom-step/app.jsx' }
  })).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard({ ...payload, toolArgs: {} })).permissionDecision, 'deny');
});

test('parallel turns do not share permissions, and approval remains locked after phase advance', async t => {
  const f = await fixture(t, { writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, generationIntent: { status: 'open', generation: 1 } });
  const author = await f.enter('/sf-code', 'author'); const approver = await f.enter('/sf-approve', 'approver');
  assert.equal((await mutationToolGuard(author)).permissionDecision, undefined);
  assert.equal((await mutationToolGuard(approver)).permissionDecision, 'deny');
  f.workflow.currentPhase = 'next-code'; f.workflow.phaseOrder.push('next-code');
  f.workflow.phases['next-code'] = { ...f.phase, id: 'next-code' };
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await refreshMutationContracts(f.root, f.accepted, { decisionEnded: true });
  assert.equal((await mutationToolGuard(approver)).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(author)).permissionDecision, 'deny', 'another session cannot promote this author turn to the next phase');
});

test('issued reviewer staging is allowed without granting artifact/source writes', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-review-source');
  const staging = path.join(f.root, '.git', 'singularity-flow', 'source-reviews', 'PMC-1-custom-step-gen1.json');
  await issueMutationStaging(f.root, staging, 'source-review');
  await writeFile(staging, '{"draft":true}', 'utf8');
  assert.equal((await mutationToolGuard({ ...payload, toolArgs: { path: staging } })).permissionDecision, undefined);
  assert.equal((await mutationToolGuard({ ...payload, toolArgs: { path: `${staging}.other` } })).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
});

test('review tool protocol recovers in the same turn; standalone check/stage/retain remain permitted', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-review-source');
  const staging = path.join(f.root, '.git/singularity-flow/source-reviews/PMC-1-custom-step-gen1.json');
  await issueMutationStaging(f.root, staging, 'source-review');
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  for (const command of [`jq . output.json`, `printf '{}' > '${staging}'`,
    `singularity-flow review-source check custom-step --report-file '${staging}' --json && echo done`]) {
    const refusal = await shell(command);
    assert.match(refusal.permissionDecisionReason, /PHASE_MUTATION_TOOL_PROTOCOL/);
    assert.doesNotMatch(refusal.permissionDecisionReason, /PHASE_MUTATION_TURN_READ_ONLY/);
    assert.match(refusal.permissionDecisionReason, /\/sf-review-source custom-step/);
  }
  const reportJson = JSON.stringify({ binding: { phase: 'custom-step' }, rows: [], rationale: 'literal [data] > not a redirect', detail: 'x'.repeat(4000) });
  assert.deepEqual(await shell(`singularity-flow review-source stage custom-step --report-json '${reportJson}' --json`), {});
  const quoted = JSON.stringify({ rows: [], rationale: "Story's literal [data] > $HOME; `not executed`; FILE <input> ...", detail: 'x'.repeat(4000) });
  for (const platform of ['darwin', 'win32']) {
    const command = renderPlatformCommand(['singularity-flow', 'review-source', 'stage', 'custom-step', '--report-json', quoted, '--json'], platform);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: platform === 'win32' ? 'powershell' : 'bash', toolArgs: { command, cwd: f.root } }), {});
  }
  for (const operation of ['check', 'submit']) {
    const command = `singularity-flow review-source ${operation} custom-step --report-file '${staging}' --json`;
    assert.deepEqual(await shell(command), {});
    const powershell = `& 'singularity-flow' 'review-source' '${operation}' 'custom-step' '--report-file' '${staging}' '--json'`;
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'powershell', toolArgs: { command: powershell, cwd: f.root } }), {});
  }
  for (const command of ['singularity-flow review-source submit other-step --report-file x',
    'singularity-flow review-source submit custom-step --report-file x --work-id OTHER',
    'singularity-flow review-source decide custom-step --finding F1 --reason accepted',
    'singularity-flow phase publish custom-step --authored governed-agent --channel copilot-host']) {
    const refusal = await shell(command);
    assert.equal(refusal.permissionDecision, 'deny');
    assert.match(refusal.permissionDecisionReason, /PHASE_MUTATION_OPERATION_NOT_ALLOWED/);
  }
  for (const command of [`singularity-flow review-source stage custom-step --report-json '${quoted}' && echo unsafe`,
    `singularity-flow status --json --long '${'x'.repeat(4000)}'`,
    'singularity-flow review-source stage <PHASE> --report-json \'{"finding":"..."}\' --json']) {
    assert.equal((await shell(command)).permissionDecision, 'deny', command);
  }
  assert.deepEqual(await mutationToolGuard({ ...payload, toolArgs: { path: staging } }), {});
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
});

test('human review-disposition turns allow only exact bound decisions; reviewers remain read-only', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-review-decide custom-step');
  assert.equal(mutationTurnMode('sf-review-decide'), 'review-decision-only');
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const argv = ['singularity-flow', 'review-source', 'decide', 'custom-step', '--work-id', 'PMC-1',
    '--finding', 'not-applicable:PMC-1:AC-004', '--reason', "The human's visual-test exception.", '--confirm', 'a'.repeat(64), '--json'];
  for (const platform of ['darwin', 'win32']) assert.deepEqual(await mutationToolGuard({ ...payload,
    toolName: platform === 'win32' ? 'powershell' : 'bash', toolArgs: { cwd: f.root,
      command: renderPlatformCommand(argv, platform) } }), {});
  const command = renderPlatformCommand(argv, 'darwin');
  for (const changed of [command.replace('PMC-1', 'OTHER'), command.replace('custom-step', 'other-step'),
    command.replace('decide', 'submit'), command.replace('decide', 'stage'),
    command.replace('a'.repeat(64), 'stale'), `${command} --yes`, `${command} && echo unsafe`,
    'singularity-flow approve custom-step', 'singularity-flow prepare custom-step']) {
    assert.equal((await shell(changed)).permissionDecision, 'deny', changed);
  }
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
  const reviewer = await f.enter('/sf-review-source custom-step', 'reviewer');
  assert.equal((await mutationToolGuard({ ...reviewer, toolName: 'bash', toolArgs: { command, cwd: f.root } })).permissionDecision, 'deny');
  await endMutationDecisionTurns(f.root);
  assert.equal((await shell(command)).permissionDecision, 'deny', 'a finished decision cannot be replayed in this turn');
});

test('publish-only permits one bound publication, never authoring or lifecycle decisions', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-publish custom-step');
  assert.equal(mutationTurnMode('sf-publish'), 'publish-only');
  assert.equal(f.contract('publish-only').allow.application, false);
  assert.deepEqual(f.contract('publish-only').allow.artifacts, []);
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  for (const command of ['singularity-flow phase prepublish custom-step --for-agent --json',
    'singularity-flow phase publish custom-step --authored governed-agent --channel copilot-host']) {
    assert.deepEqual(await shell(command), {});
  }
  for (const command of ['singularity-flow prepare custom-step', 'singularity-flow phase begin custom-step',
    'singularity-flow clarification record custom-step --question Q --answer A',
    'singularity-flow phase publish other-step --authored governed-agent --channel copilot-host',
    'singularity-flow submit custom-step', 'singularity-flow approve custom-step']) {
    const refusal = await shell(command);
    assert.equal(refusal.permissionDecision, 'deny', command);
    assert.match(refusal.permissionDecisionReason, /PHASE_MUTATION_OPERATION_NOT_ALLOWED/);
  }
  for (const target of ['src/App.jsx', 'singularity/work-items/PMC-1/artifacts/custom-step/doc.md', f.workflowFile]) {
    assert.equal((await mutationToolGuard({ ...payload, toolArgs: { path: target } })).permissionDecision, 'deny');
  }
});

test('all seeded and example phases plus future custom phases share explicit restricted-mode protocols', () => {
  let checked = 0;
  for (const file of ['../templates/workflow.yml', '../examples/workflow-with-quality-gates.yml']) {
    const definition = YAML.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const workType of Object.keys(definition.workTypes)) for (const resolved of resolveWorkType(definition, workType).phases) {
      const phase = { ...resolved, generationPolicy: resolved.generation, status: 'in_progress', generation: 1 };
      const workflow = { workItem: { id: 'MATRIX-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase } };
      for (const turnMode of ['read-only-review', 'review-decision-only', 'publish-only', 'read', 'approval-only', 'kernel-only']) {
        const contract = deriveMutationContract({ definition, workflow, turnMode });
        assert.equal(contract.allow.application, false, `${workType}/${phase.id}/${turnMode}`);
        assert.deepEqual(contract.allow.artifacts, []);
        assert.ok(contract.next.length);
        assert.ok(contract.next.every(action => action.commandGuidance?.copilotCommand));
      }
      checked++;
    }
  }
  assert.ok(checked >= 50);
  const phase = { id: 'team-invented-scope', status: 'in_progress', generation: 3, generationPolicy: { task: 'document' } };
  const contract = deriveMutationContract({ definition: {}, workflow: { workItem: { id: 'FUTURE' },
    currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase } }, turnMode: 'read-only-review' });
  assert.equal(contract.next[0].copilotCommand, '/sf-review-source team-invented-scope');
});

test('workflow/ref changes refuse edits until a verified refresh', async t => {
  const f = await fixture(t, { writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, generationIntent: { status: 'open', generation: 1 } });
  const payload = await f.enter('/sf-code');
  await writeFile(f.workflowFile, JSON.stringify({ ...f.workflow, changed: true }));
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
  await refreshMutationContracts(f.root, f.accepted);
  assert.equal((await mutationToolGuard(payload)).permissionDecision, undefined);
  f.git(['checkout', '-qb', 'other']);
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
});

test('post-shell content checks detect edits to a path that was already dirty; unchanged dirt is preserved', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-phase');
  await writeFile(path.join(f.root, 'src/App.jsx'), 'existing human draft');
  const shell = { ...payload, toolName: 'bash', toolArgs: { command: 'sed -i source-change src/App.jsx' } };
  assert.equal((await mutationToolGuard(shell)).permissionDecision, undefined);
  assert.deepEqual(await mutationPostToolGuard(shell), {});
  await mutationToolGuard(shell);
  await writeFile(path.join(f.root, 'src/App.jsx'), 'changed again, same porcelain status');
  const result = await mutationPostToolGuard(shell);
  assert.equal(result.continue, false); assert.match(result.stopReason, /src\/App.jsx/u);
  assert.match(result.additionalContext, /Stop this SFlow authoring turn/);
  assert.equal((await mutationToolGuard(shell)).permissionDecision, 'deny');
  assert.equal(await readFile(path.join(f.root, 'src/App.jsx'), 'utf8'), 'changed again, same porcelain status');
});

test('native, pause, session end are inert; explicit missing contracts are not an edit permission', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-approve');
  await setCopilotPaused(true);
  assert.deepEqual(await mutationToolGuard(payload), {});
  await setCopilotPaused(false);
  assert.deepEqual(await mutationToolGuard(payload), {});
  const fresh = await f.enter('/sf-phase');
  await endRepositoryBoundaryTurn(fresh);
  assert.deepEqual(await mutationToolGuard(fresh), {});
  await recordRepositoryBoundaryTurn(fresh, { captureMutation: async () => {} });
  assert.equal((await mutationToolGuard(fresh)).permissionDecision, 'deny');
});

test('already-approved refusal ends the approval turn and offers inspection, not next-phase authoring', async t => {
  const f = await fixture(t); f.phase.status = 'approved'; f.phase.approvedBy = 'reviewer'; f.phase.approvedAt = '2026-10-11';
  await assert.rejects(assertPhaseSequence(f.root, f.workflow, 'approve', { requestedPhase: f.phase.id }), error => {
    assert.equal(error.code, 'PHASE_ALREADY_APPROVED');
    assert.equal(error.commandResult.data.turnBoundary, 'end');
    assert.equal(error.commandResult.next[0].modelFreeCommand, '@sflow /next');
    assert.doesNotMatch(JSON.stringify(error.commandResult.next), /prepare|publish|sf-code/u);
    return true;
  });
});

test('turn modes do not infer authority from custom phase names', () => {
  assert.equal(mutationTurnMode('sf-approve'), 'approval-only');
  assert.equal(mutationTurnMode('sflow-code'), 'authoring');
  assert.equal(mutationTurnMode('sf-review-source'), 'read-only-review');
  assert.equal(mutationTurnMode('sf-unrecognised'), 'read');
});

test('custom required artifacts and deterministic phases retain the pinned boundary', async t => {
  const f = await fixture(t, { requiredArtifact: { path: 'deliverables/design.md' } });
  assert.equal(mutationPathDecision(f.contract('authoring'), 'singularity/work-items/PMC-1/deliverables/design.md').allowed, true);
  assert.equal(mutationPathDecision(f.contract('authoring'), 'singularity/work-items/PMC-1/deliverables/other.md').allowed, false);
  f.phase.generationPolicy.allowedProducers = ['deterministic'];
  assert.equal(mutationPathDecision(f.contract('authoring'), 'singularity/work-items/PMC-1/deliverables/design.md').allowed, false);
});

test('corrupt explicit-turn and mutation records fail closed instead of releasing edits', async t => {
  const f = await fixture(t, { writeScope: 'source-and-artifact', generationPolicy: { task: 'code' }, generationIntent: { status: 'open', generation: 1 } });
  const payload = await f.enter('/sf-code');
  const id = createHash('sha256').update(payload.sessionId).digest('hex');
  const base = path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries', id);
  await writeFile(`${base}.json`, '{invalid');
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
  await f.enter('/sf-code');
  const value = JSON.parse(await readFile(`${base}.mutation.json`, 'utf8'));
  value.contract.allow.application = false;
  await writeFile(`${base}.mutation.json`, JSON.stringify(value));
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
});

test('expired explicit permission cannot authorize an edit or approval; diagnostics remain available', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-approve');
  await recordRepositoryBoundaryTurn(payload, { now: Date.now() - 31 * 60_000,
    captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => f.root, load: async () => f.accepted }) });
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow approve custom-step --yes' } })).permissionDecision, 'deny');
  const receiptRefusal = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: {
    command: 'singularity-flow approve custom-step --work-id PMC-1 --selection-receipt 8232baec-10cb-4dd1-a8af-066d1fb06841 --for-agent --json' } });
  assert.equal(receiptRefusal.permissionDecision, 'deny');
  assert.match(receiptRefusal.permissionDecisionReason, /PHASE_MUTATION_CONTRACT_REQUIRED/);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --for-agent --json' } }), {});
  const refusal = await mutationToolGuard(payload);
  assert.match(refusal.permissionDecisionReason, /new explicit turn/);
  assert.match(refusal.next[0].detail, /new turn/);
});

test('missing Story setup and session attach retain kernel routes but never file-edit permissions', async t => {
  const f = await fixture(t);
  const enter = async skill => {
    const payload = { cwd: f.root, sessionId: 'setup', prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
    return payload;
  };
  let payload = await enter('/sf-session');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow session attach PMC-1 --json' } }), {});
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: `cd '${f.root}' && singularity-flow session attach PMC-1 --json` } }), {});
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } })).permissionDecision, 'deny');
  payload = await enter('/sf-workflows');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow workflow create custom --json' } }), {});
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: 'singularity/workflow.yml' } })).permissionDecision, 'deny');
});

test('a failed decision locks only approval operations, never granting authoring or raw-shell permission', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-approve');
  const shell = command => ({ ...payload, toolName: 'bash', toolArgs: { command } });
  assert.deepEqual(await mutationToolGuard(shell('singularity-flow approve custom-step --work-id PMC-1 --for-agent --json')), {});
  assert.deepEqual(await mutationToolGuard(shell(`cd '${f.root}' && 'singularity-flow' 'approve' 'custom-step' '--work-id' 'PMC-1' '--for-agent' '--json'`)), {});
  assert.equal((await mutationToolGuard(shell(`cd '${path.dirname(f.root)}' && singularity-flow approve custom-step --work-id PMC-1`))).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(shell(`cd '${f.root}' && singularity-flow approve custom-step --work-id PMC-1 && npm test`))).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(shell('singularity-flow approve custom-step --work-id OTHER'))).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(shell('singularity-flow choices begin start PMC-1 --json'))).permissionDecision, 'deny');
  await endMutationDecisionTurns(f.root);
  assert.equal((await mutationToolGuard(shell(`cd '${f.root}' && singularity-flow approve custom-step --work-id PMC-1`))).permissionDecision, 'deny');
  const ended = await mutationToolGuard(shell('singularity-flow approve custom-step --work-id PMC-1'));
  assert.equal(ended.permissionDecision, 'deny');
  assert.match(ended.permissionDecisionReason, /PHASE_MUTATION_DECISION_TURN_ENDED/);
  assert.doesNotMatch(ended.permissionDecisionReason, /Correct the tool form in this turn/);
  assert.equal((await mutationToolGuard(shell('npm test'))).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'task', toolArgs: { prompt: 'implement next phase' } })).permissionDecision, 'deny');
  assert.deepEqual(await mutationToolGuard(shell('singularity-flow nextsteps --json')), {});
});

test('receipt-backed approval crosses the tool guard for every seeded and future phase without widening authority', async t => {
  const definition = YAML.parse(readFileSync(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const phases = [...new Set(Object.keys(definition.workTypes).flatMap(workType => resolveWorkType(definition, workType).phases.map(phase => phase.id)))];
  phases.push('future-team-phase');
  const receipt = '8232baec-10cb-4dd1-a8af-066d1fb06841';
  const f = await fixture(t, { status: 'awaiting_approval', generation: 1 });
  for (const phase of phases) {
    f.phase.id = phase;
    f.workflow.currentPhase = phase;
    f.workflow.phaseOrder = [phase];
    f.workflow.phases = { [phase]: f.phase };
    await writeFile(f.workflowFile, JSON.stringify(f.workflow));
    const payload = await f.enter(`/sf-approve ${phase} --work-id PMC-1`);
    const argv = ['singularity-flow', 'approve', phase, '--work-id', 'PMC-1', '--fetch', '--selection-receipt', receipt, '--for-agent', '--json'];
    for (const platform of ['darwin', 'win32']) {
      const command = renderPlatformCommand(argv, platform);
      const call = { ...payload, toolName: platform === 'win32' ? 'powershell' : 'bash', toolArgs: { command, cwd: f.root } };
      assert.deepEqual(await mutationToolGuard(call), {}, `${phase}/${platform}`);
      assert.deepEqual(await mutationPostToolGuard(call), {});
    }
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    assert.deepEqual(await shell(argv.join(' ')), {}, phase);
    for (const command of [`singularity-flow approve other-phase --work-id PMC-1 --selection-receipt ${receipt}`,
      `singularity-flow approve ${phase} --work-id OTHER --selection-receipt ${receipt}`,
      `singularity-flow reject ${phase} --work-id PMC-1 --selection-receipt ${receipt}`,
      `singularity-flow prepare ${phase}`]) {
      assert.equal((await shell(command)).permissionDecision, 'deny', command);
    }
    assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } })).permissionDecision, 'deny');
    await endMutationDecisionTurns(f.root);
    const ended = await shell(argv.join(' '));
    assert.match(ended.permissionDecisionReason, /PHASE_MUTATION_DECISION_TURN_ENDED/);
    assert.doesNotMatch(ended.permissionDecisionReason, new RegExp(receipt), 'denials never disclose a receipt');
  }
  assert.ok(phases.length > 40);
});

test('documented Copilot edit aliases, string arguments, and VS Code-compatible payloads use the same path boundary', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-phase');
  for (const toolName of ['create', 'edit', 'str_replace_editor', 'functions.apply_patch']) {
    const toolArgs = toolName.endsWith('apply_patch') ? { input: '*** Begin Patch\n*** Update File: src/App.jsx\n+x\n*** End Patch' }
      : { command: 'str_replace', path: 'src/App.jsx' };
    assert.equal((await mutationToolGuard({ ...payload, toolName, toolArgs: JSON.stringify(toolArgs) })).permissionDecision, 'deny');
  }
  assert.deepEqual(await mutationToolGuard({ session_id: payload.sessionId, cwd: f.root,
    tool_name: 'Read', tool_input: { path: 'src/App.jsx' } }), {});
  assert.equal((await mutationToolGuard({ session_id: payload.sessionId, cwd: f.root,
    tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } })).permissionDecision, 'deny');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'str_replace_editor', toolArgs: { command: 'view', path: 'src/App.jsx' } }), {});
});

test('clarification staging paths are data in every authoring phase, not CLI executions', async t => {
  for (const [id, skill, code] of [['specification', '/sf-phase', false], ['planning', '/sf-phase', false],
    ['implementation', '/sf-code', true], ['verification', '/sf-phase', false],
    ['release', '/sf-release', false], ['team-custom', '/sf-phase', false]]) {
    await t.test(id, async t => {
      const f = await fixture(t, { id, ...(code ? { writeScope: 'source-and-artifact',
        generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } } : {}) });
      const payload = await f.enter(skill);
      const staging = path.join(f.root, '.git', 'singularity-flow', 'clarification-responses', `${id}-gen1.json`);
      await issueMutationStaging(f.root, staging, 'clarification');
      const shell = command => ({ ...payload, toolName: 'bash', toolArgs: { command } });
      assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'write_file', toolArgs: { path: staging } }), {});
      const writer = shell(`printf '%s' '{}' > '${staging}'`);
      assert.deepEqual(await mutationToolGuard(writer), {}, 'directory name is not an invocation');
      await writeFile(staging, '{"responses":[]}');
      assert.deepEqual(await mutationPostToolGuard(writer), {});
      assert.deepEqual(await mutationToolGuard(shell(`singularity-flow clarification record ${id} --response-file '${staging}' --json`)), {});
      assert.deepEqual(await mutationToolGuard(shell(`singularity-flow phase publish ${id} --authored governed-agent --channel copilot-host`)), {});
      assert.equal((await mutationToolGuard({ ...payload, toolName: 'write_file', toolArgs: { path: `${staging}.other` } })).permissionDecision, 'deny');
      if (!code) assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny', 'no application-edit permission was widened');
    });
  }
});

test('literal answer punctuation and PowerShell argv do not become shell operators', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-phase');
  const shell = (command, toolName = 'bash') => ({ ...payload, toolName, toolArgs: { command } });
  assert.deepEqual(await mutationToolGuard(shell('singularity-flow clarification record custom-step --question "Which input?" --answer "No negatives; lowercase & integer only."')), {});
  assert.deepEqual(await mutationToolGuard(shell("& 'singularity-flow' 'clarification' 'record' 'custom-step' '--question' 'What''s valid?' '--answer' 'Integers; lowercase & local.'", 'powershell')), {});
  for (const command of ['singularity-flow status --json && singularity-flow phase publish custom-step',
    'bash -c "singularity-flow approve custom-step"', 'singularity-flow clarification record custom-step --answer "$(touch src/App.jsx)"',
    'singularity-flow phase publish custom-step > output.json']) {
    const refused = await mutationToolGuard(shell(command));
    assert.equal(refused.permissionDecision, 'deny');
    assert.match(refused.permissionDecisionReason, /PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED/);
    assert.doesNotMatch(refused.permissionDecisionReason, /PHASE_MUTATION_TURN_READ_ONLY/);
  }
});
