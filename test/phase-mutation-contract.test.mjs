import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { deriveMutationContract, mutationContractPresentation, mutationPathDecision, mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { recordRepositoryBoundaryTurn, endRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard, mutationPostToolGuard, issueMutationStaging, issueImportTeamStaging, issueBuildStaging, issueFixWorkflowStaging, refreshMutationContracts, endMutationDecisionTurns } from '../src/copilot-mutation-guard.mjs';
import { createHash } from 'node:crypto';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { assertPhaseSequence } from '../src/sequence.mjs';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';
import { renderPlatformCommand } from '../src/safe-command-guidance.mjs';
import { readCopilotStoryFollow } from '../src/copilot-story-follow.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { recordCopilotSession } from '../src/session.mjs';
import { boundedAgentOutput, boundedAgentText } from '../src/agent-output.mjs';

test('all generated context, JSON, catalog, refusal and text files get exact read-only hints in linked worktrees', async t => {
  const f = await fixture(t);
  const checkout = path.join(path.dirname(f.root), 'Story Ω with spaces');
  f.git(['worktree', 'add', '-qb', 'issued-output-story', checkout, 'HEAD']);
  const payload = { cwd: checkout, sessionId: 'issued-output-review', prompt: '/sf-phase' };
  const capture = (payload, record) => captureMutationTurn(payload, record,
    { resolveRoot: async () => checkout, load: async () => f.accepted });
  await recordRepositoryBoundaryTurn(payload, { captureMutation: capture });
  const prose = Array.from({ length: 350 }, (_, i) => `Line ${i}: exact pinned context Ω.`).join('\n');
  // Parallel responses must not lose each other's issued paths.
  const views = await Promise.all(['sflow-phase-entry', 'source-review-agent-context', 'session-open', 'catalog', 'refusal']
    .map(async resultType => JSON.parse(await boundedAgentOutput(JSON.stringify({
      resultType, repositoryPath: checkout, workId: 'PMC-1', context: { text: prose },
      artifact: { text: prose }, reviewer: { instructions: prose }
    }), { cwd: checkout }))));
  const files = [];
  for (const view of views) {
    const full = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
    files.push(view.agentOutput.path, full.context.text.textFile, full.artifact.text.textFile, full.reviewer.instructions.textFile);
  }
  const textOutput = await boundedAgentText(prose, { cwd: checkout, kind: 'diagnostic' });
  const textPath = textOutput.match(/The complete output is (.+) \(/u)[1];
  files.push(textPath);
  for (const exact of files) {
    for (const prefix of [checkout, path.join(checkout, '.git')]) {
      const wrong = path.join(prefix, 'singularity-flow', 'agent-results', path.basename(exact));
      const decision = await mutationToolGuard({ ...payload, toolName: 'Read', toolArgs: { path: wrong, view_range: [121, 225] } });
      assert.equal(decision.permissionDecision, 'deny', wrong);
      assert.match(decision.permissionDecisionReason, /^CLI_ISSUED_PATH_MISMATCH/u);
      assert.deepEqual(decision.pathCorrections, [{ attemptedPath: wrong, issuedPath: exact, operation: 'read' }]);
      assert.deepEqual(decision.next, []);
      await assert.rejects(readFile(wrong), error => ['ENOENT', 'ENOTDIR'].includes(error.code));
    }
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { path: exact } }), {});
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'view', toolArgs: { path: pathToFileURL(exact).href } }), {});
    assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: exact } })).permissionDecision, 'deny');
  }
  const missing = `${files[0]}.missing`;
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read', toolArgs: { path: missing } }), {});
  await assert.rejects(readFile(missing), { code: 'ENOENT' });
  const wrong = path.join(checkout, 'singularity-flow/agent-results', path.basename(files[0]));
  assert.deepEqual(await mutationToolGuard({ ...payload, sessionId: 'different-chat', toolName: 'read', toolArgs: { path: wrong } }), {});
  await recordRepositoryBoundaryTurn(payload, { captureMutation: capture });
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read', toolArgs: { path: wrong } }), {}, 'new turns cannot inherit old output hints');
  const paused = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  await setCopilotPaused(true);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read', toolArgs: { path: wrong } }), {});
  assert.ok(paused);
});

test('generated output hints work in every phase and custom author/review/session turn without granting writes', async t => {
  const f = await fixture(t);
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-intake', 'custom-repair']) {
    f.workflow.currentPhase = id;
    f.workflow.phaseOrder = [id];
    f.workflow.phases = { [id]: { ...f.phase, id } };
    await writeFile(f.workflowFile, JSON.stringify(f.workflow));
    const payload = await f.enter(id === 'planning' ? '/sf-review-source' : id === 'custom-intake' ? '/sf-session' : '/sf-phase', id);
    const view = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'sflow-phase-entry', repositoryPath: f.root,
      workId: 'PMC-1', phase: id, context: { text: 'Exact context.\n'.repeat(800) } }), { cwd: f.root }));
    const full = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
    const exact = full.context.text.textFile;
    const wrong = path.join(f.root, 'singularity-flow/agent-results', path.basename(exact));
    const decision = await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { filePath: wrong } });
    assert.equal(decision.pathCorrections[0].issuedPath, exact, id);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { filePath: exact } }), {}, id);
  }
});

test('setup turns without a Story can correct generated reads, while real missing files and ended turns stay native', async t => {
  const f = await fixture(t);
  const payload = { cwd: f.root, sessionId: 'setup-output', prompt: '/sf-session' };
  await recordRepositoryBoundaryTurn(payload, { captureMutation: (payload, record) => captureMutationTurn(payload, record, {
    resolveRoot: async () => f.root, load: async () => { throw new Error('No Story selected'); }
  }) });
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'session-open', repositoryPath: f.root,
    context: { text: 'Read-only setup.\n'.repeat(800) } }), { cwd: f.root }));
  const full = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
  const exact = full.context.text.textFile;
  const wrong = path.join(f.root, 'singularity-flow/agent-results', path.basename(exact));
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'Read', toolArgs: { path: wrong } })).pathCorrections[0].issuedPath, exact);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'Read', toolArgs: { path: path.join(f.root, 'docs', path.basename(exact)) } }), {});
  await unlink(exact);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'Read', toolArgs: { path: exact } }), {});
  await assert.rejects(readFile(exact), { code: 'ENOENT' });
  await endRepositoryBoundaryTurn(payload);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'Read', toolArgs: { path: wrong } }), {});
  const issuedCache = path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries',
    `${createHash('sha256').update(payload.sessionId).digest('hex')}.mutation.json.issued`);
  await assert.rejects(readdir(issuedCache), { code: 'ENOENT' });
});

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

test('prompt submission announces the exact code prerequisite before a denied edit; kernel turns never gain authoring', async t => {
  const f = await fixture(t, { writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code', requirement: 'required' } });
  const capture = (payload, record) => captureMutationTurn(payload, record, {
    resolveRoot: async () => f.root, load: async () => f.accepted
  });
  const payload = { cwd: f.root, sessionId: 'before-code', prompt: '/sf-code' };
  const announcement = await recordRepositoryBoundaryTurn(payload, { captureMutation: capture });
  assert.match(announcement.additionalContext, /Code authoring ready: false/);
  assert.match(announcement.additionalContext, /Before source edits: singularity-flow phase begin custom-step --json/);
  assert.match(announcement.additionalContext, /never auto-adopt or discard edits/);
  const edit = { ...payload, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } };
  assert.equal((await mutationToolGuard(edit)).permissionDecision, 'deny');
  f.phase.generationHighWatermark = 2;
  f.phase.generationIntent = { status: 'open', generation: 3 };
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await refreshMutationContracts(f.root, f.accepted);
  assert.deepEqual(await mutationToolGuard(edit), {});
  const fresh = await recordRepositoryBoundaryTurn({ ...payload, sessionId: 'open-code' }, { captureMutation: capture });
  assert.match(fresh.additionalContext, /Code authoring ready: true/);
  assert.doesNotMatch(fresh.additionalContext, /Before source edits:/);
  const nextPayload = { ...payload, sessionId: 'next-only', prompt: '/sf-next' };
  const next = await recordRepositoryBoundaryTurn(nextPayload, { captureMutation: capture });
  assert.match(next.additionalContext, /kernel-only.*no direct repository edits/);
  assert.match(next.additionalContext, /Do not inline \/sf-code/);
  assert.equal((await mutationToolGuard({ ...edit, sessionId: 'next-only' })).permissionDecision, 'deny');
});

test('native Copilot binds its launch window to the accepted Story without changing the profile', async t => {
  const f = await fixture(t);
  const origin = path.dirname(f.root);
  const payload = { cwd: origin, sessionId: 'follow-window', prompt: '/sf-phase' };
  const capture = (value, record) => captureMutationTurn(value, record, {
    resolveRoot: async () => f.root, load: async () => f.accepted
  });
  for (const record of [null,
    { sessionId: 'another-window', workId: 'PMC-1', workItemSelectionRequired: false },
    { sessionId: payload.sessionId, workId: 'PMC-1', workItemSelectionRequired: true },
    { sessionId: payload.sessionId, workId: 'OTHER-1', workItemSelectionRequired: false }]) {
    if (record) await recordCopilotSession(f.root, record);
    await recordRepositoryBoundaryTurn(payload, { captureMutation: capture });
    assert.equal(await readCopilotStoryFollow(origin), null, 'a candidate or another chat cannot select this window');
  }
  await recordCopilotSession(f.root, {
    sessionId: payload.sessionId, workId: 'PMC-1', workItemSelectionRequired: false
  });
  const result = await recordRepositoryBoundaryTurn(payload, { captureMutation: capture });
  assert.match(result.additionalContext, /SFlow turn boundary/);
  const notice = await readCopilotStoryFollow(origin);
  assert.equal(notice?.repositoryPath, process.platform === 'win32' ? f.root.toLowerCase() : f.root);
  assert.equal(notice?.workId, 'PMC-1');
  await recordRepositoryBoundaryTurn({ ...payload, prompt: '/sf-session' }, { captureMutation: capture });
  assert.equal((await readCopilotStoryFollow(origin))?.eventId, notice.eventId,
    'a chooser turn cannot follow a previous Story before the human selects one');
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
  const f = await fixture(t);
  // The step defines the scope, so it has a source review whatever it is called.
  f.workflow.resolution.obligationGraph = { nodes: [{ id: 'custom-step', responsibilities: ['scope'] }] };
  const payload = await f.enter('/sf-review-source');
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
  // The host's saved copy of a long result is outside the workspace: the refusal names the agent
  // view to run again instead of telling the agent to use a file tool that cannot open it.
  for (const command of [`jq '{status, workId, open: {ready: .open.ready}}' /var/folders/_j/yp8z/T/1792062996841-copilot-tool-output-80389-8c9dd931.txt`,
    'Get-Content C:\\Users\\dev\\AppData\\Local\\Temp\\1792-copilot-tool-output-1.txt | ConvertFrom-Json']) {
    const refusal = await shell(command);
    assert.match(refusal.permissionDecisionReason, /PHASE_MUTATION_TOOL_PROTOCOL: that file is the host's saved copy of a long result, outside the workspace/u);
    assert.match(refusal.permissionDecisionReason, /Run the same SFlow command again, standalone, with --for-agent --json/u);
    assert.doesNotMatch(refusal.permissionDecisionReason, /use native file-read tools/u);
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

test('/sf-decide turns permit only the bound decision commands its skill runs', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-decide PMC-1');
  assert.equal(mutationTurnMode('sf-decide'), 'decision-only');
  assert.equal(mutationTurnMode('sflow-decide'), 'decision-only');
  assert.equal(f.contract('decision-only').allow.application, false);
  assert.deepEqual(f.contract('decision-only').allow.artifacts, []);
  assert.equal(f.contract('decision-only').next[0].command, 'singularity-flow decision show PMC-1 --json');
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const choose = 'singularity-flow decision choose PMC-1 --fetch --option ship --reason "The person chose to ship." --expected k1';
  for (const command of ['singularity-flow decision show PMC-1 --json', 'singularity-flow evidence scope PMC-1 --json',
    choose,
    'singularity-flow decision choose PMC-1 --fetch --to release --reason "Skip ahead." --expected k1',
    'singularity-flow decision applicability PMC-1 --fetch --responsibility scope --reason "Covered by the parent."',
    'singularity-flow decision scope PMC-1 --fetch --item S-1 --as excluded --reason "Out of scope."',
    `singularity-flow decision completeness PMC-1 --fetch --confirm ${'b'.repeat(64)} --article completeness=satisfied --reason "Reviewed."`,
    'singularity-flow decision plan PMC-1 --fetch --add-location PMC-1:AC-001=src/App.jsx --reason "Belongs to AC-001."',
    'singularity-flow upstream-issue list --work-id PMC-1 --open --json',
    'singularity-flow upstream-issue decide UPI-001 --work-id PMC-1 --outcome dismiss --reason "The person dismissed it."']) {
    assert.deepEqual(await shell(command), {}, command);
  }
  for (const command of [choose.replace('PMC-1', 'OTHER'), `${choose} --work-id OTHER`, `${choose} && echo unsafe`,
    'singularity-flow decision witness PMC-1 --slot test:unit --reason "x"',
    'singularity-flow decision risk PMC-1 --reason "x"',
    'singularity-flow upstream-issue decide UPI-001 --outcome dismiss --reason "No Story bound to it."',
    'singularity-flow upstream-issue decide UPI-001 --work-id OTHER --outcome dismiss --reason "Another Story."',
    'singularity-flow upstream-issue raise --work-id PMC-1 --phase intake --about x --problem "Not a decision turn action."',
    'singularity-flow approve custom-step', 'singularity-flow reject custom-step --reason x',
    'singularity-flow submit custom-step', 'singularity-flow prepare custom-step', 'singularity-flow next']) {
    assert.equal((await shell(command)).permissionDecision, 'deny', command);
  }
  for (const target of ['src/App.jsx', 'singularity/work-items/PMC-1/artifacts/custom-step/doc.md', f.workflowFile]) {
    assert.equal((await mutationToolGuard({ ...payload, toolArgs: { path: target } })).permissionDecision, 'deny');
  }
  // A failed approval does not end a decision turn, and a failed decision does not end an approval turn.
  const approve = async sessionId => ({ ...(await f.enter('/sf-approve', sessionId)), toolName: 'bash',
    toolArgs: { command: 'singularity-flow approve custom-step --work-id PMC-1', cwd: f.root } });
  await approve('approver-1');
  await endMutationDecisionTurns(f.root);
  assert.deepEqual(await shell(choose), {}, 'a failed approval ended the decision turn');
  const approval = await approve('approver-2');
  await endMutationDecisionTurns(f.root, { modes: ['decision-only'] });
  const ended = await shell(choose);
  assert.equal(ended.permissionDecision, 'deny', 'a refused decision did not end the /sf-decide turn');
  assert.match(ended.permissionDecisionReason, /PHASE_MUTATION_DECISION_TURN_ENDED/);
  assert.deepEqual(await shell('singularity-flow decision show PMC-1 --json'), {}, 'reads stay available');
  assert.deepEqual(await mutationToolGuard(approval), {}, 'a failed decision ended an approval turn');
  // The CLI boundary ends the turn when a decision command is refused.
  const fresh = await f.enter('/sf-decide PMC-1', 'decider-2');
  const freshChoose = () => mutationToolGuard({ ...fresh, toolName: 'bash', toolArgs: { command: choose, cwd: f.root } });
  assert.deepEqual(await freshChoose(), {});
  const refused = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url)), '--no-model',
    'decision', 'choose', 'PMC-1', '--option', 'ship', '--reason', 'The person chose to ship.', '--expected', 'k1'],
  { cwd: f.root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match((await freshChoose()).permissionDecisionReason ?? '', /PHASE_MUTATION_DECISION_TURN_ENDED/,
    `${refused.stdout}\n${refused.stderr}`);
});

test('a /sf-decide turn records only the decision list\'s upstream-issue options; a reuse or test-run risk is the person\'s own terminal step', async t => {
  const f = await fixture(t);
  const digest = `sha256:${'c'.repeat(64)}`;
  const decide = await f.enter('/sf-decide PMC-1', 'list-decider');
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  for (const command of ['singularity-flow decisions PMC-1 --json', 'singularity-flow decisions PMC-1 --choose d1=reuse --json',
    `singularity-flow decisions record PMC-1 --choose d1=accept-risk --expires d1=2026-11-18 --confirm ${digest} --json`,
    `singularity-flow decisions record PMC-1 --choose d1=dismiss --choose d2=return --reason "d1=Not a defect in what was delivered." --confirm ${digest}`]) {
    assert.deepEqual(await shell(decide, command), {}, command);
  }
  for (const command of [`singularity-flow decisions record PMC-1 --choose d1=reuse --confirm ${digest}`,
    `singularity-flow decisions record PMC-1 --choose d1=dismiss --choose d2=accept-test-risk --confirm ${digest}`,
    `singularity-flow decisions record OTHER --choose d1=dismiss --confirm ${digest}`,
    'singularity-flow decisions record PMC-1 --choose d1=dismiss',
    'singularity-flow decisions record PMC-1 --answers answers.json',
    `singularity-flow decisions record PMC-1 --choose d1=dismiss --confirm ${digest} --fetch`]) {
    const denied = await shell(decide, command);
    assert.equal(denied.permissionDecision, 'deny', command);
  }
  const reuse = await shell(decide, `singularity-flow decisions record PMC-1 --choose d1=reuse --confirm ${digest}`);
  assert.match(reuse.permissionDecisionReason, /recording the decision list is the person's own step: they run the exact decisions record command in their own terminal/u);
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-recover', 'kernel'], ['/sf-approve', 'approver']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    assert.deepEqual(await shell(payload, 'singularity-flow decisions PMC-1 --json'), {}, `${skill} may read the list`);
    const denied = await shell(payload, `singularity-flow decisions record PMC-1 --choose d1=dismiss --confirm ${digest}`);
    assert.equal(denied.permissionDecision, 'deny', skill);
  }
});

test('an authoring turn may raise an upstream issue but never decide one', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-phase');
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.deepEqual(await shell('singularity-flow upstream-issue raise --phase intake --about AC-001 --problem "The intake omits the error case entirely."'), {});
  assert.deepEqual(await shell('singularity-flow upstream-issue raise --from-artifact --json'), {});
  assert.deepEqual(await shell('singularity-flow upstream-issue list --open --json'), {});
  assert.deepEqual(await shell('singularity-flow upstream-issue propose-amendment --phase intake --file singularity/work-items/PMC-1/artifacts/custom-step/intake-draft.md --reason "The intake omits the error case entirely."'), {});
  for (const command of ['singularity-flow upstream-issue decide-amendment FAM-001 --decision approve --reason "Agent approving." --confirm FAM-001',
    'singularity-flow upstream-issue revalidate design --amendment FAM-001 --outcome unchanged --reason "Agent revalidating."']) {
    assert.equal((await shell(command)).permissionDecision, 'deny', command);
  }
  const decided = await shell('singularity-flow upstream-issue decide UPI-001 --outcome dismiss --reason "The agent thinks it is fine."');
  assert.equal(decided.permissionDecision, 'deny');
  assert.match(decided.permissionDecisionReason, /PHASE_MUTATION_OPERATION_NOT_ALLOWED: an upstream issue or amendment is decided by the earlier step's approvers/);
  const kernel = await f.enter('/sf-recover', 'kernel');
  const kernelDecide = await mutationToolGuard({ ...kernel, toolName: 'bash', toolArgs: {
    command: 'singularity-flow upstream-issue decide UPI-001 --outcome dismiss --reason "Not an agent decision at all."', cwd: f.root } });
  assert.equal(kernelDecide.permissionDecision, 'deny');
});

test('no agent turn accepts that a step\'s tests cannot run here or decides spec drift; the refusal says whose decision it is', async t => {
  const f = await fixture(t);
  const accept = 'singularity-flow decision test-risk PMC-1 --phase custom-step --command module-tests --cause "The Maven repository is unreachable." --reason "CI runs these tests before merge." --expires 2026-11-01';
  const revoke = 'singularity-flow decision test-risk PMC-1 --revoke TRR-001 --reason "The repository is reachable again from here."';
  const drift = 'singularity-flow spec drift decide TOY-001:AC-001 --accept --reason "The louder greeting is intended."';
  // Reusing an earlier step's recorded run for a step is that step's approvers' decision too.
  const reuse = 'singularity-flow decision evidence-reuse PMC-1 --phase custom-step --from-attempt TA-0123456789abcdef0123 --reason "Implementation recorded this run on the same source."';
  const unreuse = 'singularity-flow decision evidence-reuse PMC-1 --revoke ERU-001 --reason "Verification records its own run now."';
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-recover', 'kernel'], ['/sf-decide PMC-1', 'decider-3']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow spec drift --json', cwd: f.root } }), {},
      'reading drift is allowed');
    for (const command of [accept, revoke, drift, reuse, unreuse]) {
      const denied = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.equal(denied.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /decided by a person who approves that step, in their own terminal, not by this turn/u, skill);
    }
  }
});

test('no agent turn sets held changes aside; it shows the person the command', async t => {
  const f = await fixture(t);
  const setAside = `singularity-flow recover PMC-1 --phase custom-step --set-aside --confirm sha256:${'a'.repeat(64)} --json`;
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-recover', 'kernel'], ['/sf-decide PMC-1', 'decider-3']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash',
      toolArgs: { command: 'singularity-flow recover PMC-1 --phase custom-step --json', cwd: f.root } }), {}, 'inspecting recovery is allowed');
    const denied = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: setAside, cwd: f.root } });
    assert.equal(denied.permissionDecision, 'deny', skill);
    assert.match(denied.permissionDecisionReason, /the person who looked at them runs it in their own terminal/u, skill);
  }
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
      for (const turnMode of ['read-only-review', 'review-decision-only', 'decision-only', 'publish-only', 'read', 'approval-only', 'kernel-only']) {
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
  const future = { workItem: { id: 'FUTURE' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase },
    resolution: { obligationGraph: { nodes: [{ id: phase.id, responsibilities: ['scope'] }] } } };
  const contract = deriveMutationContract({ definition: {}, workflow: future, turnMode: 'read-only-review' });
  assert.equal(contract.next[0].copilotCommand, '/sf-review-source team-invented-scope');
  // A step that neither defines the scope nor plans the claims has no review to route to.
  future.resolution.obligationGraph.nodes[0].responsibilities = ['review'];
  assert.equal(deriveMutationContract({ definition: {}, workflow: future, turnMode: 'read-only-review' }).next[0].copilotCommand, '/sf-nextsteps');
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

test('every active authoring phase advertises and admits local tests and app sessions, not only SFlow commands', async t => {
  const f = await fixture(t);
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-check', 'custom-repair']) {
    f.phase = { ...f.phase, id };
    f.workflow.currentPhase = id;
    f.workflow.phaseOrder = [id];
    f.workflow.phases = { [id]: f.phase };
    await writeFile(f.workflowFile, JSON.stringify(f.workflow));
    const payload = await f.enter('/sf-phase', `verification-${id}`);
    const view = mutationContractPresentation(deriveMutationContract({ root: f.root, ...f.accepted, phase: f.phase }));
    assert.equal(view.toolProtocol.localVerification.allowed, true, id);
    assert.match(view.toolProtocol.terminal, /not a standalone-SFlow-only terminal/u);
    assert.match(view.toolProtocol.localVerification.guidance, /VS Code task is optional/u);
    assert.match(view.toolProtocol.localVerification.guidance, /stop only the process\/session you started/u);
    assert.match(view.toolProtocol.localVerification.guidance, /do not replace the fresh publication\/submission tests/u);
    for (const toolName of ['bash', 'powershell', 'run_in_terminal', 'exec_command']) {
      for (const command of ['npm test -- --run', 'npm run dev -- --host 127.0.0.1', 'node --test local.test.mjs']) {
        const call = { ...payload, toolName, toolArgs: { command, cwd: f.root } };
        assert.deepEqual(await mutationToolGuard(call), {}, `${id}/${toolName}/${command}`);
        assert.deepEqual(await mutationPostToolGuard(call), {}, `${id}/${toolName}/post`);
      }
    }
    const stop = { ...payload, toolName: 'write_stdin', toolArgs: { session_id: 'owned-app-session', chars: '\u0003' } };
    assert.deepEqual(await mutationToolGuard(stop), {}, id);
    assert.deepEqual(await mutationPostToolGuard(stop), {}, `${id}/stop`);
  }
});

test('native authoring verification runs a real test and starts/stops only its own loopback app', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'local.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('local diagnostic',()=>assert.equal(255..toString(16),'ff'));\n");
  await writeFile(path.join(f.root, 'dev-server.mjs'), "import {createServer} from 'node:http'; createServer((req,res)=>res.end('local-app')).listen(0,'127.0.0.1',function(){console.log(this.address().port)});\n");
  f.git(['add', 'local.test.mjs', 'dev-server.mjs']); f.git(['commit', '-qm', 'repository verification commands']);
  const payload = await f.enter('/sf-code');
  const check = { ...payload, toolName: 'bash', toolArgs: { command: 'node --test local.test.mjs', cwd: f.root } };
  assert.deepEqual(await mutationToolGuard(check), {});
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  // Name the reporter: Node 23 made spec the default even when stdout is not a terminal.
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'local.test.mjs'], { cwd: f.root, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# pass 1/u);
  assert.deepEqual(await mutationPostToolGuard(check), {});
  const start = { ...payload, toolName: 'run_in_terminal', toolArgs: { command: 'node dev-server.mjs', cwd: f.root, isBackground: true } };
  assert.deepEqual(await mutationToolGuard(start), {});
  const child = spawn(process.execPath, ['dev-server.mjs'], { cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const port = Number(String((await once(child.stdout, 'data'))[0]).trim());
  assert.ok(port > 0);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'local-app');
  assert.deepEqual(await mutationPostToolGuard(start), {});
  const stop = { ...payload, toolName: 'write_stdin', toolArgs: { session_id: String(child.pid), chars: '\u0003' } };
  assert.deepEqual(await mutationToolGuard(stop), {});
  const exited = once(child, 'exit');
  child.kill(); // Exact test-owned child only; portable on Windows, never kill by process name/port.
  await exited;
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  assert.deepEqual(await mutationPostToolGuard(stop), {});
});

test('local verification does not widen review, publication, decision, read or kernel-only turns', async t => {
  const f = await fixture(t);
  for (const skill of ['/sf-review-source', '/sf-publish', '/sf-approve', '/sf-next', '/sf-inspect']) {
    const payload = await f.enter(skill, `restricted-${skill}`);
    const contract = deriveMutationContract({ root: f.root, ...f.accepted, turnMode: mutationTurnMode(skill) });
    const protocol = mutationContractPresentation(contract).toolProtocol;
    assert.equal(protocol.localVerification.allowed, false, skill);
    assert.match(protocol.terminal, /one standalone registered SFlow command/u);
    for (const command of ['npm test', 'npm run dev', 'node dev-server.mjs']) {
      assert.equal((await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } })).permissionDecision, 'deny', `${skill}/${command}`);
    }
  }
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
  assert.equal(mutationTurnMode('sf-import-team'), 'import-team');
  assert.equal(mutationTurnMode('sf-build-workflow'), 'build-workflow');
  assert.equal(mutationTurnMode('sf-fix-workflow'), 'fix-workflow');
});

test('an import-team turn runs its own commands and edits only the issued candidate file, with or without a Story', async t => {
  const f = await fixture(t);
  const enter = async (skill, sessionId, load, now = Date.now()) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load }) });
    return payload;
  };
  const noStory = async () => { throw new Error('No Story yet'); };
  for (const [label, load] of [['without a Story', noStory], ['with a bound Story', async () => f.accepted]]) {
    const payload = await enter('/sf-import-team', `import-${label}`, load);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } });
    const edit = target => mutationToolGuard({ ...payload, toolName: 'create_file', toolArgs: { filePath: target } });
    const candidate = path.join(path.dirname(f.root), 'state', 'team-imports', `tis-${label.length}`, 'candidate.json');
    for (const command of ['singularity-flow workflow import-team inspect ./team --json',
      'singularity-flow workflow import-team compile --session tis-1 --dry-run --json',
      'singularity-flow workflow import-team compile --session tis-1 --out team.sflow-workflows.json --json',
      'singularity-flow workflow import-team status --json', 'singularity-flow nextsteps --json']) {
      assert.deepEqual(await shell(command), {}, `${label}: ${command}`);
      // The after-tool hook must not tell an import-team turn to stop: it has no contract to go stale.
      assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } }), {}, `${label} after: ${command}`);
    }
    for (const command of ['singularity-flow workflow import team.json --confirm abc --json', 'singularity-flow workflow create custom --json',
      'singularity-flow approve custom-step --yes', 'ls ../team', 'singularity-flow workflow import-team compile --session tis-1 --out a.json && rm -rf src']) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /IMPORT_TEAM_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    assert.match((await edit(candidate)).permissionDecisionReason, /no candidate file is issued/u, label);
    assert.equal(await issueImportTeamStaging(candidate, { root: f.root }), 1, label);
    assert.deepEqual(await edit(candidate), {}, label);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'create_file', toolArgs: { filePath: pathToFileURL(candidate).href } }), {});
    assert.match((await edit(path.join(f.root, 'src', 'App.jsx'))).permissionDecisionReason, /IMPORT_TEAM_PATH_DENIED.*candidate\.json/u);
    assert.match((await edit(`${candidate}.bak`)).permissionDecisionReason, /IMPORT_TEAM_PATH_DENIED/u);
    assert.match((await mutationToolGuard({ ...payload, toolName: 'task', toolArgs: { prompt: 'convert it' } })).permissionDecisionReason, /DELEGATION/u);
    await endRepositoryBoundaryTurn(payload);
  }
  // Another skill's turn, and an expired import turn, never receive the path.
  const other = await enter('/sf-workflows', 'workflows-turn', noStory);
  await enter('/sf-import-team', 'expired-import', noStory, Date.now() - 31 * 60_000);
  const late = path.join(path.dirname(f.root), 'state', 'team-imports', 'tis-late', 'candidate.json');
  assert.equal(await issueImportTeamStaging(late, { root: f.root }), 0);
  assert.equal((await mutationToolGuard({ ...other, toolName: 'create_file', toolArgs: { filePath: late } })).permissionDecision, 'deny');
});

test('a build-workflow turn runs the build commands and edits only the issued proposal file, with or without a Story', async t => {
  const f = await fixture(t);
  const enter = async (skill, sessionId, load, now = Date.now()) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load }) });
    return payload;
  };
  const noStory = async () => { throw new Error('No Story yet'); };
  for (const [label, load] of [['without a Story', noStory], ['with a bound Story', async () => f.accepted]]) {
    const payload = await enter('/sf-build-workflow', `build-${label}`, load);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } });
    const edit = target => mutationToolGuard({ ...payload, toolName: 'create_file', toolArgs: { filePath: target } });
    const proposal = path.join(path.dirname(f.root), 'state', 'workflow-builds', `wb-${label.length}`, 'proposal.json');
    for (const command of ['singularity-flow workflow build start --folder ./team --json',
      'singularity-flow workflow build status --build wb_0123456789abcdef --json',
      `singularity-flow workflow build propose --build wb_0123456789abcdef --proposal ${proposal} --json`,
      'singularity-flow workflow build decide --build wb_0123456789abcdef --proposal p-1 --accept --json',
      'singularity-flow workflow build answer --build wb_0123456789abcdef --question q-1 --choice leads --json',
      'singularity-flow workflow build check --build wb_0123456789abcdef --json',
      'singularity-flow workflow build finish --build wb_0123456789abcdef --propose --json', 'singularity-flow nextsteps --json']) {
      assert.deepEqual(await shell(command), {}, `${label}: ${command}`);
      assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } }), {}, `${label} after: ${command}`);
    }
    for (const command of ['singularity-flow workflow studio apply --change-set x.json --propose', 'singularity-flow workflow import team.json --confirm abc --json',
      'singularity-flow approve custom-step --yes', 'ls ../team', 'singularity-flow workflow build finish --build wb_0123456789abcdef --propose && rm -rf src']) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /BUILD_WORKFLOW_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    assert.match((await edit(proposal)).permissionDecisionReason, /no proposal file is issued/u, label);
    assert.equal(await issueBuildStaging(proposal, { root: f.root }), 1, label);
    assert.deepEqual(await edit(proposal), {}, label);
    assert.match((await edit(path.join(f.root, 'singularity', 'workflow.yml'))).permissionDecisionReason, /BUILD_WORKFLOW_PATH_DENIED.*proposal\.json/u);
    assert.match((await mutationToolGuard({ ...payload, toolName: 'task', toolArgs: { prompt: 'build it' } })).permissionDecisionReason, /BUILD_WORKFLOW_DELEGATION/u);
    await endRepositoryBoundaryTurn(payload);
  }
  // A team-import turn never receives a build's proposal file, and a build turn never a candidate.
  const importing = await enter('/sf-import-team', 'import-turn', noStory);
  const late = path.join(path.dirname(f.root), 'state', 'workflow-builds', 'wb-late', 'proposal.json');
  assert.equal(await issueBuildStaging(late, { root: f.root }), 0);
  assert.equal((await mutationToolGuard({ ...importing, toolName: 'create_file', toolArgs: { filePath: late } })).permissionDecision, 'deny');
});

test('a fix-workflow turn reads, edits only the issued change set draft, and proposes only that draft, with or without a Story', async t => {
  const f = await fixture(t);
  const enter = async (skill, sessionId, load, now = Date.now()) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load }) });
    return payload;
  };
  const noStory = async () => { throw new Error('No Story yet'); };
  for (const [label, load] of [['without a Story', noStory], ['with a bound Story', async () => f.accepted]]) {
    const payload = await enter('/sf-fix-workflow', `fix-${label}`, load);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } });
    const edit = target => mutationToolGuard({ ...payload, toolName: 'create_file', toolArgs: { filePath: target } });
    const draft = path.join(path.dirname(f.root), 'state', 'workflow-fixes', `r-${label.length}`, 'team-flow.change-set.json');
    const propose = `singularity-flow workflow studio apply --change-set ${draft} --propose --json`;
    for (const command of ['singularity-flow workflow validate team-flow --for-start --json',
      `singularity-flow workflow check team-flow --change-set ${draft} --json`,
      `singularity-flow workflow studio apply --change-set ${draft} --dry-run --json`, 'singularity-flow nextsteps --json']) {
      assert.deepEqual(await shell(command), {}, `${label}: ${command}`);
      assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } }), {}, `${label} after: ${command}`);
    }
    assert.match((await shell(propose)).permissionDecisionReason ?? '', /FIX_WORKFLOW_OPERATION_NOT_ALLOWED/u, `${label}: nothing is issued yet`);
    assert.match((await edit(draft)).permissionDecisionReason, /no change set draft is issued/u, label);
    assert.equal(await issueFixWorkflowStaging(draft, { root: f.root }), 1, label);
    assert.deepEqual(await edit(draft), {}, label);
    assert.deepEqual(await shell(propose), {}, `${label}: the issued draft can be proposed`);
    assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: propose } }), {});
    for (const command of [`singularity-flow workflow studio apply --change-set ${draft}`, `singularity-flow workflow studio apply --change-set ${draft}.other --propose`,
      'singularity-flow workflow studio apply --change-set - --propose', 'singularity-flow configuration approve sflow/config-change/x --yes',
      'singularity-flow approve custom-step --yes', `${propose} && rm -rf src`]) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /FIX_WORKFLOW_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    assert.match((await edit(path.join(f.root, 'singularity', 'workflow.yml'))).permissionDecisionReason, /FIX_WORKFLOW_PATH_DENIED.*team-flow\.change-set\.json/u);
    assert.match((await mutationToolGuard({ ...payload, toolName: 'task', toolArgs: { prompt: 'fix it' } })).permissionDecisionReason, /FIX_WORKFLOW_DELEGATION/u);
    await endRepositoryBoundaryTurn(payload);
  }
  // A build-workflow turn never receives a fix draft.
  const building = await enter('/sf-build-workflow', 'build-turn', noStory);
  const late = path.join(path.dirname(f.root), 'state', 'workflow-fixes', 'late', 'all-workflows.change-set.json');
  assert.equal(await issueFixWorkflowStaging(late, { root: f.root }), 0);
  assert.equal((await mutationToolGuard({ ...building, toolName: 'create_file', toolArgs: { filePath: late } })).permissionDecision, 'deny');
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
  // Before a Story is bound there is no contract to go stale: admitted kernel commands get no
  // after-tool "refresh the binding" finding; anything the pre-tool guard would refuse still does.
  assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow session attach PMC-1 --json' } }), {});
  assert.match((await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'ls -la' } })).additionalContext ?? '', /PHASE_MUTATION_CONTRACT_STALE/u);
  payload = await enter('/sf-workflows');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow workflow create custom --json' } }), {});
  assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow workflow create custom --json' } }), {});
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: 'singularity/workflow.yml' } })).permissionDecision, 'deny');
  // Before a Story is bound /sf-decide has nothing to decide: reads pass, a decision is denied, and
  // neither throws.
  payload = await enter('/sf-decide');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow decision show PMC-1 --json' } }), {});
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow decision choose PMC-1 --option a --reason "Because the person chose it."' } })).permissionDecision, 'deny');
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

test('a rebuilt staging path is refused with the exact issued path, not the phase routes', async t => {
  // Copilot saw only the tail of the issued path (its search shortened the long line), rebuilt it
  // under the linked worktree, was refused with "prepare" routes, and stopped before recording.
  const f = await fixture(t); const payload = await f.enter('/sf-phase');
  const staging = path.join(f.root, '.git', 'singularity-flow', 'clarification-responses', 'specification-gen1.json');
  await issueMutationStaging(f.root, staging, 'clarification');
  const guessed = path.join(f.root, 'singularity-flow', 'clarification-responses', 'specification-gen1.json');
  const patch = `*** Begin Patch\n*** Add File: ${guessed}\n+{"responses":[]}\n*** End Patch`;
  const decision = await mutationToolGuard({ sessionId: payload.sessionId, cwd: payload.cwd,
    toolCalls: [{ id: 'c1', name: 'apply_patch', args: patch }] });
  assert.equal(decision.permissionDecision, 'deny', 'a near miss is never granted');
  assert.match(decision.permissionDecisionReason, /^PHASE_MUTATION_STAGING_PATH_MISMATCH/u);
  assert.ok(decision.permissionDecisionReason.includes(`write the issued staging file at exactly ${staging}.`));
  assert.doesNotMatch(decision.permissionDecisionReason, /prepare/u);
  assert.deepEqual(await mutationToolGuard({ sessionId: payload.sessionId, cwd: payload.cwd,
    toolCalls: [{ id: 'c2', name: 'apply_patch', args: patch.replace(guessed, staging) }] }), {});
});

test('linked-worktree reads correct only the exact issued private path, never recreate or retarget it', async t => {
  const f = await fixture(t);
  const checkout = path.join(path.dirname(f.root), 'Story Ω checkout');
  f.git(['worktree', 'add', '-qb', 'linked-story', checkout, 'HEAD']);
  const payload = { cwd: checkout, sessionId: 'linked-review', prompt: '/sf-review-source' };
  await recordRepositoryBoundaryTurn(payload, { captureMutation: (payload, record) => captureMutationTurn(payload, record,
    { resolveRoot: async () => checkout, load: async () => f.accepted }) });
  const staging = path.join(gitDir(checkout), 'singularity-flow', 'source-reviews', 'PMC-1-custom-step-gen1.json');
  await issueMutationStaging(checkout, staging, 'source-review');
  await writeFile(staging, '{"review":"preserved"}');
  const guessed = path.join(checkout, 'singularity-flow', 'source-reviews', path.basename(staging));
  for (const toolName of ['read_file', 'Read', 'view', 'mcp.files.read_text_file']) {
    const read = toolArgs => mutationToolGuard({ ...payload, toolName, toolArgs });
    const correction = await read({ path: guessed });
    assert.equal(correction.permissionDecision, 'deny', toolName);
    assert.deepEqual(correction.pathCorrections, [{ attemptedPath: guessed, issuedPath: staging, operation: 'read' }]);
    assert.deepEqual(correction.next, [], 'no prepare/review restart loop');
    assert.deepEqual(await read({ filePath: staging }), {}, 'exact Git-private path remains readable');
    assert.deepEqual(await read({ path: pathToFileURL(staging).href }), {});
    assert.deepEqual(await read({ path: path.join(checkout, 'docs', path.basename(staging)) }), {}, 'same basename is not a private-path match');
    assert.deepEqual(await read({ path: `${staging}.missing` }), {}, 'native reader preserves real ENOENT errors');
  }
  await assert.rejects(readFile(guessed), { code: 'ENOENT' });
  assert.equal(await readFile(staging, 'utf8'), '{"review":"preserved"}');
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: `${staging}.other` } })).permissionDecision, 'deny');
  await endRepositoryBoundaryTurn(payload);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { path: guessed } }), {},
    'an ended SFlow turn must not intercept native Copilot reads');
});

test('issued clarification paths stay authoritative in every seeded and custom authoring phase', async t => {
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'team-intake', 'team-repair']) {
    const f = await fixture(t, { id });
    const payload = await f.enter('/sf-phase', id);
    const staging = path.join(gitDir(f.root), 'singularity-flow', 'clarification-responses', `${id}-gen1.json`);
    await issueMutationStaging(f.root, staging, 'clarification');
    const guessed = path.join(f.root, 'singularity-flow', 'clarification-responses', path.basename(staging));
    const correction = await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { filePath: guessed } });
    assert.equal(correction.pathCorrections[0].issuedPath, staging, id);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { path: staging } }), {}, id);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: staging } }), {}, id);
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

test('after a command that changed nothing, current contracts are not rebuilt and the Story is not reloaded', async t => {
  // This refresh runs after every command. It reloaded the whole Story to rebuild identical records,
  // about five seconds per read-only command on a Windows machine. The fixture is not a loadable
  // Story, so any reload here would reject.
  const f = await fixture(t);
  const payload = await f.enter('/sf-phase');
  const contracts = path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const recordPath = path.join(contracts, (await readdir(contracts)).find(name => name.endsWith('.mutation.json')));
  const before = await readFile(recordPath, 'utf8');
  await refreshMutationContracts(f.root, null);
  assert.equal(await readFile(recordPath, 'utf8'), before, 'nothing rebuilt or rewritten');

  // A changed Story file is rebuilt (with the accepted Story supplied, as the CLI would load it).
  f.workflow.phases[f.phase.id].generation = 1;
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await assert.rejects(refreshMutationContracts(f.root, null), 'a stale binding reloads the Story');
  await refreshMutationContracts(f.root, f.accepted);
  assert.notEqual(await readFile(recordPath, 'utf8'), before, 'rebuilt against the new Story file');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'view', toolArgs: { path: 'src/App.jsx' } }), {});

});

test('a deterministic code step lets its author write code; only its summary is kernel-built', async t => {
  // Quick-fix's implement step builds its summary deterministically from what changed. From
  // 2026-10-11 the contract refused every source edit there while every route offered /sf-code.
  const f = await fixture(t, { id: 'implement', writeScope: 'source-and-artifact',
    requiredArtifact: { path: 'artifacts/implement/implementation-summary.md' },
    generationPolicy: { task: 'code', requirement: 'required', producer: 'deterministic', allowedProducers: ['deterministic'] } });
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, false, 'only in an open generation');
  f.phase.generationIntent = { status: 'open', generation: 1 };
  const open = f.contract('authoring');
  assert.equal(mutationPathDecision(open, 'src/App.jsx').allowed, true);
  assert.equal(mutationPathDecision(open, 'singularity/work-items/PMC-1/artifacts/implement/implementation-summary.md').allowed, false,
    'the deterministic summary is never edited by hand');
  assert.match(open.summary, /summary is built by `singularity-flow prepare` from what changed, never edited by hand/u);
  // A deterministic step that delivers no code stays kernel-owned.
  f.phase.generationPolicy.task = 'analyze';
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, false);
});

test('the rule follows the step\'s pinned policy, never its name: a custom deterministic code step is coded too', async t => {
  const f = await fixture(t, { id: 'ship-fix', writeScope: 'source-and-artifact', generationIntent: { status: 'open', generation: 1 },
    generationPolicy: { task: 'code', requirement: 'required', producer: 'deterministic', allowedProducers: ['deterministic'] } });
  const { phaseKernelOwned } = await import('../src/code-delivery-policy.mjs');
  assert.equal(phaseKernelOwned(f.phase), false);
  assert.equal(mutationPathDecision(f.contract('authoring'), 'src/App.jsx').allowed, true);
  // Every starter workflow's deterministic step that delivers code is coded by its agent as well.
  const YAML = (await import('yaml')).default;
  const starter = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const deterministicCode = Object.entries(starter.phases ?? {}).filter(([, phase]) =>
    phase?.generation?.producer === 'deterministic' && phase.generation.task === 'code').map(([id]) => id);
  assert.ok(deterministicCode.includes('implement'), deterministicCode.join(','));
  for (const id of deterministicCode) {
    assert.equal(phaseKernelOwned({ id, generationPolicy: { task: 'code', producer: 'deterministic', allowedProducers: ['deterministic'] } }), false, id);
  }
});
