import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { deriveMutationContract, mutationContractPresentation, mutationPathDecision, mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { hookAnswerForEveryHost, recordRepositoryBoundaryTurn, endRepositoryBoundaryTurn, repositoryPostToolGuard, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { ANSWER_BOUND_TURNS, answerOfQuestion, wordsOfCommand } from '../src/copilot-answer-binding.mjs';
import { ANSWER_BOUND_SKILLS, captureMutationTurn, mutationToolGuard, mutationPostToolGuard, issueMutationStaging, issueImportTeamStaging, issueBuildStaging, issueFixWorkflowStaging, issueSpecStudioStaging, issueRunAppDraftStaging, issueDraftStaging, epicSourceTextDraftPath, refreshMutationContracts, endMutationDecisionTurns } from '../src/copilot-mutation-guard.mjs';
import { createHash } from 'node:crypto';
import { copilotModeFile } from '../src/copilot-mode.mjs';
import { hookCliLine, setCopilotPaused, setHookCli } from '../src/copilot-mode.mjs';
import { assertPhaseSequence } from '../src/sequence.mjs';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';
import { CLI_PATH_CONTRACT, CLI_PATH_REFERENCE, renderPlatformCommand, safeCommandGuidance, validateSafeSflowCommand, validateSflowExecutionCommand } from '../src/safe-command-guidance.mjs';
import { readCopilotStoryFollow } from '../src/copilot-story-follow.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { recordCopilotSession } from '../src/session.mjs';
import { boundedAgentOutput, boundedAgentText } from '../src/agent-output.mjs';
import { commandLineWithoutSkill, OWN_TERMINAL_STEPS, ownTerminalStep, skillForCommandLine } from '../src/command-skills.mjs';
import { clarificationStagingPath, phaseStagingPaths, sourceReviewStagingPath } from '../src/phase-staging-paths.mjs';

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
    // Every file is in the checkout's output folder: one ID, the checkout's own, in every path.
    assert.equal(path.dirname(exact), path.join(checkout, '.sflow', 'out'), exact);
    // The older Git-directory spelling, and the folder guessed inside .git, are corrected to it.
    for (const wrong of [path.join(checkout, 'singularity-flow', 'agent-results', path.basename(exact)),
      path.join(checkout, '.git', 'singularity-flow', 'agent-results', path.basename(exact)),
      path.join(checkout, '.git', '.sflow', 'out', path.basename(exact))]) {
      const decision = await mutationToolGuard({ ...payload, toolName: 'Read', toolArgs: { path: wrong, view_range: [121, 225] } });
      assert.equal(decision.permissionDecision, 'deny', wrong);
      assert.match(decision.permissionDecisionReason, /^CLI_ISSUED_PATH_MISMATCH/u);
      assert.deepEqual(decision.pathCorrections, [{ attemptedPath: wrong, issuedPath: exact, operation: 'read' }]);
      assert.deepEqual(decision.next, []);
      await assert.rejects(readFile(wrong), error => ['ENOENT', 'ENOTDIR'].includes(error.code));
    }
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { path: exact, start_line: 1, end_line: 10 } }), {});
    // A range one file read shows; a longer whole read is turned back with its ranges (below).
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'view', toolArgs: { path: pathToFileURL(exact).href, view_range: [1, 1] } }), {});
    assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: exact } })).permissionDecision, 'deny');
  }
  // The clone's info/exclude covers its linked worktrees: nothing SFlow wrote shows as a change.
  assert.equal(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: checkout, encoding: 'utf8' }).stdout, '');
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
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'read_file', toolArgs: { filePath: exact, startLine: 1, endLine: 10 } }), {}, id);
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
  assert.match(next.additionalContext, /Never inline an authoring skill/);
  assert.match(next.additionalContext, /Step author: \/sf-code\./, 'a code step names its own author');
  // The kernel skill's own steps run: a kernel turn is never told to stop (a /sf-submit that obeyed
  // "return the configured authoring skill and stop" submitted nothing, 2026-10-26).
  assert.match(next.additionalContext, /Carry out the invoked skill's steps in this turn\./);
  assert.doesNotMatch(next.additionalContext, /\bstop\b/i);
  assert.equal((await mutationToolGuard({ ...edit, sessionId: 'next-only' })).permissionDecision, 'deny');
});

test('a kernel turn on an unwritten plan names the plan\'s own author, never /sf-code', async t => {
  // A /sf-submit on a plan step at generation 0 offered /sf-code: the only skill its turn rules
  // named (2026-10-26). The step's author is named in every turn; code readiness only on code steps.
  const f = await fixture(t, { id: 'planning' });
  const capture = (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => f.root, load: async () => f.accepted });
  const { additionalContext } = await recordRepositoryBoundaryTurn({ cwd: f.root, sessionId: 'plan-submit', prompt: '/sf-submit' },
    { captureMutation: capture });
  assert.match(additionalContext, /kernel-only turn, PMC-1 step planning generation 0\. Step author: \/sf-phase\./);
  assert.match(additionalContext, /Carry out the invoked skill's steps in this turn\./);
  assert.doesNotMatch(additionalContext, /\/sf-code|Code authoring ready|\bstop\b/i);
});

test('prompt context sends its stable rules once per conversation and keeps the volatile part under 400 bytes', async t => {
  // `[OUT:REQ-032]` `[OUT:AC-033]`
  const f = await fixture(t, { writeScope: 'source-and-artifact', generationPolicy: { task: 'code', requirement: 'required' } });
  const capture = (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => f.root, load: async () => f.accepted });
  const turn = (prompt, sessionId = 'stable-rules') => recordRepositoryBoundaryTurn({ cwd: f.root, sessionId, prompt }, { captureMutation: capture });
  const rules = (text) => text.match(/Turn rules (?:unchanged \()?(sha256:[a-f0-9]{16})/u)?.[1];
  const volatile = (text) => text.slice(0, text.indexOf(' Turn rules unchanged'));
  const first = (await turn('/sf-code')).additionalContext;
  assert.match(first, /Before source edits: singularity-flow phase begin custom-step --json/);
  assert.match(first, /never auto-adopt or discard edits/);
  assert.ok(first.includes(CLI_PATH_REFERENCE) && !first.includes(CLI_PATH_CONTRACT), 'the skill states the full path rule; the hook names it');
  const again = (await turn('/sf-code')).additionalContext;
  assert.match(again, /Turn rules unchanged \(sha256:[a-f0-9]{16}\): given in full earlier in this conversation\./);
  assert.equal(rules(again), rules(first));
  assert.match(again, /Before source edits: singularity-flow phase begin custom-step --json/, 'what changes per turn is always sent');
  assert.doesNotMatch(again, /never auto-adopt or discard edits/);
  assert.ok(Buffer.byteLength(volatile(again)) <= 400, `${Buffer.byteLength(volatile(again))} volatile bytes`);
  // Other rules (a kernel-only turn), a native prompt in between, or another chat: sent whole again.
  const kernel = (await turn('/sf-next')).additionalContext;
  assert.match(kernel, /Never inline an authoring skill/);
  assert.notEqual(rules(kernel), rules(first));
  await turn('explain this file');
  assert.match((await turn('/sf-next')).additionalContext, /Never inline an authoring skill/);
  assert.match((await turn('/sf-code', 'another-chat')).additionalContext, /never auto-adopt or discard edits/);
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
  assert.match(refused.permissionDecisionReason, /\n- Copilot: [^\n]+\n- Shell: [^\n]+\n- VS Code \(model-free\):/u);
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

test('document upload skills use kernel operations and exact restore works in read-only review turns', async t => {
  const f = await fixture(t);
  for (const skill of ['/sf-documents', '/sf-upload']) {
    assert.equal(mutationTurnMode(skill), 'kernel-only');
    const payload = await f.enter(skill, skill);
    assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny', 'upload skills cannot edit application files');
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: {
      command: 'singularity-flow documents upload original.png --name "Original screen" --store local', cwd: f.root } }), {});
  }
  const payload = await f.enter('/sf-review-source', 'restore-review');
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.deepEqual(await shell('singularity-flow documents restore DOC-001 --work-id PMC-1 --file "original screen.png" --json'), {});
  for (const command of [
    'singularity-flow documents restore DOC-001 --work-id OTHER --file original.png --json',
    'singularity-flow documents restore DOC-001 --file original.png --store git',
    'singularity-flow documents restore DOC-001 DOC-002 --file original.png',
    'singularity-flow documents upload original.png --name "New source"'
  ]) assert.equal((await shell(command)).permissionDecision, 'deny', command);
  for (const skill of ['/sf-approve', '/sf-publish', '/sf-session']) {
    const bound = await f.enter(skill, `restore-${skill}`);
    assert.deepEqual(await mutationToolGuard({ ...bound, toolName: 'bash', toolArgs: {
      command: 'singularity-flow documents restore DOC-001 --work-id PMC-1 --file original.png --json', cwd: f.root } }), {}, skill);
  }
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
    assert.match(refusal.permissionDecisionReason, /Run singularity-flow result last --wait --for-agent --json, standalone: it returns that command's kept result[^.]*without running the command again/u);
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

test('/sf-confirm turns run only the command carrying the digest the person typed, once', async t => {
  const f = await fixture(t);
  const digest = `sha256:${'c'.repeat(64)}`;
  const confirmed = `singularity-flow phase rollover custom-step --work-id PMC-1 --confirm ${digest}`;
  const payload = await f.enter(`/sf-confirm ${confirmed.replace('singularity-flow ', '')}`, 'confirmer');
  assert.equal(mutationTurnMode('sf-confirm'), 'confirm');
  assert.equal(mutationTurnMode('sflow-confirm'), 'confirm');
  assert.equal(f.contract('confirm').allow.application, false);
  assert.deepEqual(f.contract('confirm').allow.artifacts, []);
  const shell = (command, value = payload) => mutationToolGuard({ ...value, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.deepEqual(await shell(confirmed), {}, 'the reviewed command the person confirmed runs');
  assert.deepEqual(await shell('singularity-flow nextsteps --json'), {}, 'reads stay available');
  for (const command of [confirmed.replace(digest, `sha256:${'d'.repeat(64)}`),
    'singularity-flow phase rollover custom-step --work-id PMC-1',
    confirmed.replace('--work-id PMC-1', '--work-id OTHER'), `${confirmed} && echo unsafe`,
    `singularity-flow approve custom-step --work-id PMC-1 --confirm ${digest}`,
    `singularity-flow decision evidence-reuse PMC-1 --phase custom-step --confirm ${digest}`,
    `singularity-flow upstream-issue decide UPI-001 --work-id PMC-1 --outcome dismiss --reason x --confirm ${digest}`,
    'singularity-flow submit custom-step', 'singularity-flow next']) {
    assert.equal((await shell(command)).permissionDecision, 'deny', command);
  }
  for (const target of ['src/App.jsx', 'singularity/work-items/PMC-1/artifacts/custom-step/doc.md']) {
    assert.equal((await mutationToolGuard({ ...payload, toolArgs: { path: target } })).permissionDecision, 'deny', target);
  }
  // The host may expand the skill before the person's arguments; only the typed digest binds the turn.
  const expanded = await f.enter(`<skill-context name="sflow-confirm">Carry --confirm sha256:<DIGEST>.</skill-context>\n${confirmed}`, 'expanded');
  assert.deepEqual(await shell(confirmed, expanded), {});
  const none = await f.enter('/sf-confirm phase rollover custom-step', 'no-digest');
  assert.equal((await shell(confirmed, none)).permissionDecision, 'deny', 'a confirmation without a digest runs nothing');
  const two = await f.enter(`/sf-confirm ${confirmed} --confirm-plan sha256:${'e'.repeat(64)}`, 'two-digests');
  assert.equal((await shell(confirmed, two)).permissionDecision, 'deny', 'two digests bind nothing');
  // The decision list's own record command: only the options a /sf-decide turn may record.
  const record = `singularity-flow decisions record PMC-1 --choose d1=dismiss --confirm ${digest}`;
  const listed = await f.enter(`/sf-confirm ${record.replace('singularity-flow ', '')}`, 'list-confirmer');
  assert.deepEqual(await shell(record, listed), {});
  for (const command of [record.replace('d1=dismiss', 'd1=reuse'), record.replace('PMC-1', 'OTHER'),
    record.replace(digest, `sha256:${'f'.repeat(64)}`)]) {
    assert.equal((await shell(command, listed)).permissionDecision, 'deny', command);
  }
  // After a command changed the checkout, the confirmation has run: the same command is refused.
  await refreshMutationContracts(f.root, f.accepted, { advanceBaseline: true });
  const ended = await shell(confirmed);
  assert.equal(ended.permissionDecision, 'deny');
  assert.match(ended.permissionDecisionReason, /PHASE_MUTATION_DECISION_TURN_ENDED/u);
});

test('/sf-run-app and /sf-test turns run the declared application and tests; no turn binds environment values', async t => {
  const f = await fixture(t);
  assert.equal(mutationTurnMode('sf-run-app'), 'run-and-test');
  assert.equal(mutationTurnMode('sflow-test'), 'run-and-test');
  assert.equal(mutationTurnMode('sflow-outcome'), 'run-and-test');
  assert.equal(f.contract('run-and-test').allow.application, false);
  assert.deepEqual(f.contract('run-and-test').allow.artifacts, []);
  for (const skill of ['/sf-run-app web', '/sf-test', '/sf-outcome PMC-1']) {
    const payload = await f.enter(skill, `runner-${skill}`);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    for (const command of ['singularity-flow app plan --json', 'singularity-flow app start web --environment qa',
      'singularity-flow app status --json', 'singularity-flow app stop web', 'singularity-flow tests run --environment dev --json',
      'singularity-flow tests run --work-id PMC-1 --phase custom-step --command integration-tests --json',
      'singularity-flow tests summary --run RUN-001 --json']) {
      assert.deepEqual(await shell(command), {}, `${skill}: ${command}`);
    }
    for (const command of ['singularity-flow env bind qa --stdin', 'singularity-flow env unbind qa',
      'singularity-flow submit custom-step', 'singularity-flow approve custom-step', 'singularity-flow prepare custom-step',
      'npm run dev', 'singularity-flow app start web && echo unsafe']) {
      assert.equal((await shell(command)).permissionDecision, 'deny', `${skill}: ${command}`);
    }
    assert.equal((await mutationToolGuard({ ...payload, toolArgs: { path: 'src/App.jsx' } })).permissionDecision, 'deny', 'no file edits');
  }
  // Suggested start entries: the turn writes only the draft `app suggest` issued and proposes exactly it.
  const suggest = await f.enter('/sf-run-app suggest', 'suggester');
  const draft = path.join(path.dirname(f.root), 'drafts', 'web.application.yml');
  const other = path.join(path.dirname(f.root), 'drafts', 'other.application.yml');
  const suggestShell = command => mutationToolGuard({ ...suggest, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const edit = target => mutationToolGuard({ ...suggest, toolName: 'edit', toolArgs: { path: target } });
  assert.equal((await edit(draft)).permissionDecision, 'deny', 'nothing is issued before app suggest');
  // Every live /sf-run-app or /sf-test turn for this repository receives it: the two above and this one.
  assert.equal(await issueRunAppDraftStaging(draft, { root: f.root }), 4);
  assert.deepEqual(await edit(draft), {});
  for (const target of [other, 'src/App.jsx', 'singularity/capabilities.yml']) assert.equal((await edit(target)).permissionDecision, 'deny', target);
  for (const command of [`singularity-flow capability set web --application-file ${draft} --json`,
    `singularity-flow app config save-local --application-file ${draft} --capability web --json`,
    `singularity-flow capability edit web --lead https://example.invalid/lead.git --application-file ${draft} --mode set --json`]) {
    assert.deepEqual(await suggestShell(command), {}, command);
  }
  for (const command of [`singularity-flow capability set web --application-file ${other}`,
    `singularity-flow app config save-local --application-file ${other} --json`,
    `singularity-flow app config save-local --application-file ${draft} --force`,
    `singularity-flow capability set web --application-file ${draft} --name Other`,
    `singularity-flow capability edit web --lead https://example.invalid/lead.git --application-file ${draft} --mode remove`,
    `singularity-flow capability edit web --application-file ${draft} --mode set`, 'singularity-flow capability add web']) {
    assert.equal((await suggestShell(command)).permissionDecision, 'deny', command);
  }
  // An authoring turn may start the app and run tests, but never binds values either.
  const author = await f.enter('/sf-phase', 'author-env');
  const shell = command => mutationToolGuard({ ...author, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.deepEqual(await shell('singularity-flow app start web'), {});
  assert.deepEqual(await shell('singularity-flow tests run --json'), {});
  const bind = await shell('singularity-flow env bind qa --stdin');
  assert.equal(bind.permissionDecision, 'deny');
  assert.match(bind.permissionDecisionReason, /bound and removed only by the person.*env bind <ENV> --stdin.*env unbind <ENV> --json/u);
  // Removing a binding is the person's too, with the command they run named.
  const unbind = await shell('singularity-flow env unbind qa --json');
  assert.equal(unbind.permissionDecision, 'deny');
  assert.match(unbind.permissionDecisionReason, /OPERATION_NOT_ALLOWED: environment values are bound and removed only by the person.*env unbind <ENV> --json/u);
});

/** The person answered in this turn, as Copilot CLI and VS Code's agent host hand it to the post-tool hook. */
const personSaid = (payload, ...words) => mutationPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs: { question: 'Why?' },
  toolResult: { textResultForLlm: `User responded: ${words.join(', ')}`, resultType: 'success' } });

test('/sf-decide turns permit only the bound decision commands its skill runs', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-decide PMC-1');
  await personSaid(payload, 'The person chose to ship', 'Skip ahead', 'Covered by the parent', 'Out of scope', 'Reviewed', 'Belongs to AC-001', 'The test script needs it', 'The test script needs this entry', 'The person dismissed it', 'The tests are the whole delivery');
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
    // The other choice a plan-accounting item offers, as its `chat.command` writes it.
    'singularity-flow decision plan PMC-1 --fetch --add-supporting package.json=build-configuration --supporting-reason "The test script needs it." --reason "The test script needs this entry."',
    // One choice for a whole test setup, as its `chat.command` writes it.
    'singularity-flow decision plan PMC-1 --fetch --add-supporting package-lock.json=dependency-lock --supporting-reason "The browser runner needs it." --add-location PMC-1:AC-001=src/test/setup.js --reason "The browser runner needs it."',
    'singularity-flow upstream-issue list --work-id PMC-1 --open --json',
    'singularity-flow upstream-issue decide UPI-001 --work-id PMC-1 --outcome dismiss --reason "The person dismissed it."',
    // The route a final check names for an earlier step's defect (2026-10-28), with the person's words.
    'singularity-flow upstream-issue raise --work-id PMC-1 --phase intake --about PMC-1:REQ-001 --problem "Tests are the whole delivery."',
    // A plan correction's preview; recording one is the plan approver's own terminal step.
    'singularity-flow decision plan PMC-1 --set-fulfillment PMC-1:REQ-001=test-only --reason "The tests are the whole delivery." --dry-run']) {
    assert.deepEqual(await shell(command), {}, command);
  }
  for (const command of [choose.replace('PMC-1', 'OTHER'), `${choose} --work-id OTHER`, `${choose} && echo unsafe`,
    'singularity-flow decision witness PMC-1 --slot test:unit --reason "x"',
    'singularity-flow decision risk PMC-1 --reason "x"',
    'singularity-flow upstream-issue decide UPI-001 --outcome dismiss --reason "No Story bound to it."',
    'singularity-flow upstream-issue decide UPI-001 --work-id OTHER --outcome dismiss --reason "Another Story."',
    'singularity-flow upstream-issue raise --work-id OTHER --phase intake --about x --problem "Another Story."',
    'singularity-flow upstream-issue raise --work-id PMC-1 --phase intake --about x',
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
  await personSaid(fresh, 'The person chose to ship.');
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
  await personSaid(decide, 'Yes, record it', 'Not a defect in what was delivered.');
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
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-recover', 'kernel']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    assert.deepEqual(await shell(payload, 'singularity-flow decisions PMC-1 --json'), {}, `${skill} may read the list`);
    const denied = await shell(payload, `singularity-flow decisions record PMC-1 --choose d1=dismiss --confirm ${digest}`);
    assert.equal(denied.permissionDecision, 'deny', skill);
  }
  // /sf-approve opens the list in its own turn: the same issue-only rule, until the approval turn has ended.
  const approve = await f.enter('/sf-approve', 'approver');
  const issueOnly = `singularity-flow decisions record PMC-1 --choose d1=dismiss --confirm ${digest}`;
  assert.deepEqual(await shell(approve, issueOnly), {});
  assert.equal((await shell(approve, `singularity-flow decisions record PMC-1 --choose d1=reuse --confirm ${digest}`)).permissionDecision, 'deny');
  await endMutationDecisionTurns(f.root);
  assert.equal((await shell(approve, issueOnly)).permissionDecision, 'deny', 'an ended approval turn records nothing');
  assert.deepEqual(await shell(approve, 'singularity-flow decisions PMC-1 --json'), {}, 'reading stays available');
});

test('an approval in a chat turn carries only the upstream-issue options a chat turn may record, and /sf-decide continues into it [SPEC-OAP M4]', async t => {
  const f = await fixture(t);
  const digest = `sha256:${'d'.repeat(64)}`;
  const token = '11111111-1111-4111-8111-111111111111';
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const approve = (extra = '') => `singularity-flow approve custom-step --work-id PMC-1 --fetch --selection-receipt ${token} --for-agent --json${extra}`;
  const approval = await f.enter('/sf-approve', 'chat-approver');
  for (const command of [approve(), approve(` --choose d1=dismiss --reason "d1=Not a defect in what was delivered." --decisions ${digest}`),
    approve(` --choose d1=accept-risk --expires d1=2026-12-01 --decisions ${digest}`)]) {
    assert.deepEqual(await shell(approval, command), {}, command);
  }
  for (const command of [approve(` --choose d1=reuse --decisions ${digest}`), approve(` --choose d1=return --decisions ${digest}`),
    approve(' --choose d1=dismiss'), approve(` --decisions ${digest}`)]) {
    assert.equal((await shell(approval, command)).permissionDecision, 'deny', command);
  }
  const decide = await f.enter('/sf-decide PMC-1', 'chat-decider');
  for (const command of ['singularity-flow choices begin approve PMC-1 --fetch --for-agent --json --review-packet',
    `singularity-flow choices answer ${token} phase-confirmation custom-step --json`, approve(),
    approve(` --choose d1=dismiss --decisions ${digest}`)]) {
    assert.deepEqual(await shell(decide, command), {}, command);
  }
  for (const command of [approve(` --choose d1=reuse --decisions ${digest}`),
    'singularity-flow approve custom-step --work-id PMC-1 --yes', `singularity-flow approve custom-step --work-id OTHER --selection-receipt ${token}`,
    'singularity-flow reject custom-step --work-id PMC-1 --reason "Not this one."']) {
    assert.equal((await shell(decide, command)).permissionDecision, 'deny', command);
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

test('no agent turn accepts that a step\'s tests cannot run here or ran narrowed, or decides spec drift; the refusal says whose decision it is', async t => {
  const f = await fixture(t);
  const accept = 'singularity-flow decision test-risk PMC-1 --phase custom-step --command module-tests --cause "The Maven repository is unreachable." --reason "CI runs these tests before merge." --expires 2026-11-01';
  const revoke = 'singularity-flow decision test-risk PMC-1 --revoke TRR-001 --reason "The repository is reachable again from here."';
  const drift = 'singularity-flow spec drift decide TOY-001:AC-001 --accept --reason "The louder greeting is intended."';
  // So is accepting that a step's tests ran narrowed [TCE:REQ-023].
  const narrowed = 'singularity-flow decision test-narrowing PMC-1 --phase custom-step --command module-tests --reason "The skipped case needs a device this team lacks."';
  const unnarrowed = 'singularity-flow decision test-narrowing PMC-1 --revoke TNR-001 --reason "The device case runs on CI again."';
  // Reusing an earlier step's recorded run for a step is that step's approvers' decision too.
  const reuse = 'singularity-flow decision evidence-reuse PMC-1 --phase custom-step --from-attempt TA-0123456789abcdef0123 --reason "Implementation recorded this run on the same source."';
  const unreuse = 'singularity-flow decision evidence-reuse PMC-1 --revoke ERU-001 --reason "Verification records its own run now."';
  // So is saying one of a visual step's screen sizes does not apply to the Story.
  const notApplicable = 'singularity-flow decision visual-profile PMC-1 --phase custom-step --profile tablet-834x1194 --not-applicable --reason "This app ships to phones only, with no tablet layout."';
  const applicable = 'singularity-flow decision visual-profile PMC-1 --revoke VPD-001 --reason "The tablet layout ships in this release after all."';
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-recover', 'kernel'], ['/sf-decide PMC-1', 'decider-3']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow spec drift --json', cwd: f.root } }), {},
      'reading drift is allowed');
    for (const command of [accept, revoke, drift, reuse, unreuse, notApplicable, applicable, narrowed, unnarrowed]) {
      const denied = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.equal(denied.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /decided by a person who approves that step, in their own terminal, not by this turn/u, skill);
    }
  }
});

test('no agent turn decides an intent amendment; reading and acknowledging it stay where they were', async t => {
  const f = await fixture(t);
  const decide = 'singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001 --work-id PMC-1';
  for (const [skill, session] of [['/sf-phase', 'author'], ['/sf-code', 'code'], ['/sf-recover', 'kernel'], ['/sf-reject', 'reject'], ['/sf-decide PMC-1', 'decider']]) {
    const payload = await f.enter(skill, session);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    assert.deepEqual(await shell('singularity-flow story intent-amendment status --work-id PMC-1 --json'), {}, `${skill}: reading is allowed`);
    for (const command of [decide, decide.replace('reject', 'approve')]) {
      const denied = await shell(command);
      assert.equal(denied.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /an intent amendment is decided by a person who approves the scope, in their own terminal, not by this turn/u, skill);
    }
  }
  // An authoring turn may still acknowledge an approved amendment at the contributor's explicit choice.
  const author = await f.enter('/sf-phase', 'author-ack');
  assert.deepEqual(await mutationToolGuard({ ...author, toolName: 'bash', toolArgs: {
    command: 'singularity-flow story intent-amendment acknowledge AMD-001 --work-id PMC-1', cwd: f.root } }), {});
});

test('no agent turn confirms what a business rule means or reviews a knowledge item; listing and drafting stay allowed', async t => {
  const f = await fixture(t);
  for (const [skill, session] of [['/sf-phase', 'author'], ['/sf-recover', 'kernel'], ['/sf-worldmodel', 'wm']]) {
    const payload = await f.enter(skill, session);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    for (const command of ['singularity-flow wm rules list --json', 'singularity-flow wm rules propose --json']) {
      assert.deepEqual(await shell(command), {}, `${skill}: ${command}`);
    }
    for (const command of ['singularity-flow wm rules confirm R-0123456789ab --json',
      'singularity-flow wm rules confirm R-0123456789ab --condition "an order has no lines" --outcome "it is refused"',
      'singularity-flow wm knowledge confirm K-rule-0123456789abcdef', 'singularity-flow wm knowledge reject K-rule-0123456789abcdef --note "Not a rule."',
      // The registry's alias for wm reaches the same command; the guard reads it under its canonical name.
      'singularity-flow world-model rules confirm R-0123456789ab --json', 'singularity-flow world-model knowledge confirm K-rule-0123456789abcdef']) {
      const denied = await shell(command);
      assert.equal(denied.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /confirmed by a person who knows the code, in their own terminal/u, `${skill}: ${command}`);
    }
  }
});

test('an agent may request a Story-only test command, but only a person who approves the step accepts or revokes it', async t => {
  const f = await fixture(t);
  const request = `singularity-flow decision test-command PMC-1 --phase custom-step --id module-tests --argv '["npx","nx","run","shop-e2e:e2e"]' `
    + '--working-directory . --affected-root apps/shop --adapter playwright-json --report out.json --reason "The Nx Playwright run tests this module."';
  const accept = 'singularity-flow decision test-command PMC-1 --accept TCD-001';
  const revoke = 'singularity-flow decision test-command PMC-1 --revoke TCD-001 --reason "The repository configures this runner now."';
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-recover', 'kernel']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    const asked = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: request, cwd: f.root } });
    assert.notEqual(asked.permissionDecision, 'deny', `${skill}: ${asked.permissionDecisionReason}`);
    for (const command of [accept, revoke]) {
      const denied = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.equal(denied.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /decided by a person who approves that step, in their own terminal, not by this turn/u, skill);
    }
  }
});

test('an agent may change which tests its Story runs, unlike a narrowing it would have to ask a person to accept', async t => {
  const f = await fixture(t);
  // Owner, 2026-11-06: the open setting is anyone's, and the reviewer reads the reason [TCE:REQ-090].
  const change = 'singularity-flow story test-policy scope PMC-1 --to new-and-changed --reason "Only the tests this Story adds matter."';
  for (const [skill, mode] of [['/sf-phase', null], ['/sf-test-scope', null], ['/sf-recover', 'kernel']]) {
    const payload = await f.enter(skill, mode ?? undefined);
    const allowed = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: change, cwd: f.root } });
    assert.notEqual(allowed.permissionDecision, 'deny', `${skill}: ${allowed.permissionDecisionReason}`);
    const narrowing = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow decision test-narrowing PMC-1 --phase custom-step --command unit --reason "Fine."', cwd: f.root } });
    assert.equal(narrowing.permissionDecision, 'deny', skill);
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

test('every step only a person takes in their own terminal is refused in every turn and routed to no skill', async t => {
  const f = await fixture(t);
  const digest = `sha256:${'c'.repeat(64)}`;
  // A /sf-decide route to one of these only previewed it again and pointed back to /sf-decide: an
  // accepted test command and its decision-list record (2026-10-27). Each OWN_TERMINAL_STEPS entry
  // names its commands here, so a new entry is held to both sides.
  const steps = {
    witness: ['singularity-flow decision witness PMC-1 --criterion PMC-1:AC-001 --slot screen --file evidence/screen.png --confirm states-the-outcome --reason "Looked at the screen."'],
    risk: ['singularity-flow decision risk PMC-1 --obligation OBL-001 --category evidence --expires 2099-01-01 --reason "Accepted until the device lab returns."'],
    'witness-exception-renewal': [`singularity-flow decision witness-exception PMC-1 --phase custom-step --mapping sha256:${'a'.repeat(64)} --expires 2099-01-01 --reason "The device lab is still down."`],
    'test-run-risk': ['test-risk --phase custom-step --cause "No browser here." --expires 2099-01-01', 'test-narrowing --phase custom-step',
      'evidence-reuse --phase custom-step --from-attempt TA-001', 'visual-profile --phase custom-step --profile tablet --not-applicable']
      .map((rest) => `singularity-flow decision ${rest.replace(/^(\S+)/u, '$1 PMC-1')} --reason "Decided by the approver."`),
    'test-command-decision': ['singularity-flow decision test-command PMC-1 --accept TCD-001',
      'singularity-flow decision test-command PMC-1 --revoke TCD-001 --reason "The repository configures this runner now."'],
    'decision-list-record': [`singularity-flow decisions record PMC-1 --answers /tmp/card-answers.json --json`,
      `singularity-flow decisions record PMC-1 --choose d1=accept-test-command --confirm ${digest}`,
      `singularity-flow decisions record PMC-1 --choose d1=dismiss --choose d2=accept-test-command --confirm ${digest}`],
    'set-aside': [`singularity-flow recover PMC-1 --phase custom-step --set-aside --confirm ${digest} --json`],
    'publication-set-aside': [`singularity-flow sync PMC-1 --set-aside --confirm ${'a'.repeat(40)}`,
      `singularity-flow initiative sync INIT-1 --set-aside --confirm ${'a'.repeat(40)}`],
    'workflow-delete': [`singularity-flow workflow delete team-flow --confirm ${digest}`],
    'target-origin-pin': [`singularity-flow story target-origin PMC-1 --url https://staging.example.test --reason "Approved staging target." --confirm ${digest}`],
    'intent-amendment-decision': ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001'],
    'knowledge-confirmation': ['singularity-flow wm rules confirm R-0123456789ab --json', 'singularity-flow wm knowledge reject K-rule-0123456789abcdef --note "Not a rule."'],
    'spec-drift-decision': ['singularity-flow spec drift decide PMC-1:REQ-001 --accept --reason "The code is right."'],
    'spec-library-decision': ['singularity-flow spec author decide SPEC-CHK-004 GAP-001 --option O1 --reason "Strictly above."',
      'singularity-flow spec author settle SPEC-CHK-004 --all-articles satisfied', 'singularity-flow spec author publish SPEC-CHK-004 --reviewed',
      'singularity-flow spec author discard SPEC-CHK-004'],
    'spec-slice-change': ['singularity-flow spec attach PMC-1 --drop SPEC-CHK-004:REQ-001 --reason "Delivered by another Story."'],
    'spec-split-publication': ['singularity-flow spec split SPEC-CHK-004@1 --publish'],
    'upstream-amendment-decision': ['singularity-flow upstream-issue decide-amendment FAM-001 --decision approve --reason "The amendment is right." --confirm FAM-001',
      'singularity-flow upstream-issue revalidate custom-step --amendment FAM-001 --outcome unchanged --reason "Still holds."'],
    'environment-binding': ['singularity-flow env bind staging --stdin', 'singularity-flow env unbind staging --json'],
    'apm-install': ['singularity-flow apm install acme/review-pack', 'singularity-flow apm install --dev ../local-pack --json',
      'singularity-flow apm update', 'singularity-flow apm update reviewer@acme-catalog --json'],
    'apm-organisation': ['singularity-flow apm publish reviewer --marketplace ../acme-catalog',
      'singularity-flow apm marketplace init --name acme-catalog --owner "Platform Team" --json',
      'singularity-flow apm policy init --marketplace acme/acme-catalog'],
    'lock-release': ['singularity-flow lock release publication PMC-1 --confirm 0123456789abcdef',
      'singularity-flow lock release-file /tmp/workspaces.json.lock --confirm 0123456789abcdef --json'],
    'configuration-approve': ['singularity-flow configuration approve sflow/config-change/workflow/studio-x --yes',
      'singularity-flow configuration approve --json'],
    'approval-evidence-confirmation': ['singularity-flow approve custom-step --work-id PMC-1 --confirm-evidence'],
    'adjudication-answers': ['singularity-flow story adjudicate --answers /tmp/a.json --expect sha256:abc --work-id PMC-1'],
    // The whole table asks a person at their own terminal; no chat turn answers it, /sf-converge included.
    'adjudication-table': ['singularity-flow story adjudicate --work-id PMC-1', 'singularity-flow story adjudicate'],
    'clarification-answer': ['singularity-flow clarification answer custom-step --question "Is 2 right?" --answer "Yes."'],
    'plan-correction': ['singularity-flow decision plan PMC-1 --set-fulfillment PMC-1:REQ-001=test-only --reason "The tests are the whole delivery."',
      'singularity-flow decision plan PMC-1 --replace-location PMC-1:AC-001=src/a.mjs:src/b.mjs --reason "The plan named the wrong module."'],
    // A live-terminal review: a Copilot turn admitted it, then the terminal review refused the agent (2026-10-28).
    'live-terminal-review': [`singularity-flow appeal decide APL-001 --work-id PMC-1 --decision account-scope --reason "Reviewed the exact diff." --confirm ${digest}`,
      `singularity-flow appeal risk-accept --work-id PMC-1 --phase custom-step --reason "Accepted until the lab returns." --expires 2099-01-01 --confirm ${digest}`,
      `singularity-flow appeal risk-revoke PQR-001 --work-id PMC-1 --reason "The lab is back." --confirm ${digest}`,
      `singularity-flow appeal evidence-accept --work-id PMC-1 --phase custom-step --confirm ${digest}`,
      `singularity-flow story test-policy accept-risk PMC-1 --phase custom-step --apply --confirm ${digest}`,
      `singularity-flow story test-policy amend PMC-1 --phase custom-step --reason "The runner moved." --apply --confirm ${digest}`,
      `singularity-flow story test-policy baseline-admission PMC-1 --phase custom-step --apply --confirm ${digest}`,
      `singularity-flow story test-policy confirm PMC-1 --phase custom-step --confirm ${digest}`,
      `singularity-flow story approvers refresh PMC-1 --reason "The reviewer joined the group." --confirm ${digest}`],
    // SF Guard: each action but status takes the person's Touch ID (SPEC-PSS-v1).
    'sf-guard-person-step': ['singularity-flow guard register', 'singularity-flow guard register --key SHA256:abc --propose --json',
      'singularity-flow guard rotate --key SHA256:abc', 'singularity-flow guard recover --key SHA256:abc',
      'singularity-flow guard revoke approver-0123456789ab --reason "Left the team."', 'singularity-flow guard enable --remote-check sf-guard-verify',
      'singularity-flow guard disable --reason "Moving to another signer."', 'singularity-flow guard exception add approver-0123456789ab',
      'singularity-flow guard exception revoke EXC-001 --reason "Now on a Mac."']
  };
  assert.deepEqual(Object.keys(steps).sort(), OWN_TERMINAL_STEPS.map((step) => step.id).sort());
  for (const [id, commands] of Object.entries(steps)) {
    for (const command of commands) {
      assert.deepEqual([ownTerminalStep(command), skillForCommandLine(command), commandLineWithoutSkill(command)], [id, null, true], command);
    }
  }
  // Their previews stay open to a turn, and so does the browser review /sf-appeal opens for the person.
  for (const command of ['singularity-flow appeal risk-prepare --work-id PMC-1 --phase custom-step --reason "Preview the risk."',
    `singularity-flow appeal evidence-accept --work-id PMC-1 --phase custom-step --review-ui --confirm ${digest}`,
    'singularity-flow story test-policy accept-risk PMC-1 --phase custom-step',
    'singularity-flow apm install acme/review-pack --dry-run',
    'singularity-flow apm update --dry-run',
    'singularity-flow apm publish reviewer --marketplace ../acme-catalog --dry-run',
    'singularity-flow apm marketplace init --name acme-catalog --owner acme --dry-run',
    'singularity-flow apm policy init --marketplace acme/acme-catalog --dry-run',
    'singularity-flow story test-policy amend PMC-1 --phase custom-step --reason "Preview the amendment."']) {
    assert.equal(ownTerminalStep(command), null, command);
  }
  const allowed = [];
  // Each is refused for what it is, with the person's exact terminal line as the route: a generic
  // turn-mode or tool-form refusal pointed a lock release at "no chains or wrappers" (E5/D2, 2026-10-31).
  const generic = /PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED|not permitted by the bound turn mode|PHASE_MUTATION_TOOL_PROTOCOL|PHASE_MUTATION_DECISION_TURN_ENDED/u;
  const unrouted = [];
  // Every turn mode, and a plain follow-up prompt with no turn at all: the hook's own entry (S4 live run,
  // 2026-11-01: only a /sf- prompt recorded a turn, so a plain one ran `spec author publish` and `approve` unchecked).
  for (const [skill, session] of [['/sf-phase', 'author'], ['/sf-recover', 'kernel'], ['/sf-decide PMC-1', 'own-terminal-decider'],
    ['/sf-spec-author', 'own-spec-studio'], ['/sf-build-workflow', 'own-build'], ['/sf-import-team', 'own-import'],
    ['/sf-fix-workflow', 'own-fix'], ['/sf-test', 'own-run-and-test'], ['Thanks. Now take care of the rest.', 'own-plain']]) {
    const payload = await f.enter(skill, session);
    for (const command of Object.values(steps).flat()) {
      // run-and-test keeps its own refusal for an environment binding, which names the command in its text.
      if (skill === '/sf-test' && steps['environment-binding'].includes(command)) continue;
      const decision = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      if (decision.permissionDecision !== 'deny') allowed.push(`${skill}: ${command}`);
      else if (generic.test(decision.permissionDecisionReason) || !(decision.next ?? []).some((route) =>
        JSON.stringify(route.argv) === JSON.stringify(safeCommandGuidance({ command })?.argv))) {
        unrouted.push(`${skill}: ${command} -> ${decision.permissionDecisionReason.split('.')[0]} | ${JSON.stringify((decision.next ?? []).map((route) => route.command))}`);
      }
    }
  }
  assert.deepEqual(allowed, []);
  assert.deepEqual(unrouted, [], 'every own-terminal step is refused for what it is and routed to its exact command');
  // An authoring agent ran under the person's Git identity, so a witness from it was the person's sign-off.
  const author = await f.enter('/sf-phase', 'author');
  for (const command of [...steps.witness, ...steps.risk]) {
    const denied = await mutationToolGuard({ ...author, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    assert.match(denied.permissionDecisionReason, /an agent never signs off its own work/u, command);
  }
  // What a /sf-decide turn may record keeps its route there; asking for a test command stays the agent's.
  const decide = await f.enter('/sf-decide PMC-1', 'own-terminal-decider');
  await personSaid(decide, 'Yes, record it', 'Already handled.');
  const chat = `singularity-flow decisions record PMC-1 --choose d1=dismiss --choose d2=return --confirm ${digest}`;
  const issue = 'singularity-flow upstream-issue decide UPI-001 --work-id PMC-1 --outcome dismiss --reason "Already handled."';
  for (const command of [chat, issue]) {
    assert.deepEqual([ownTerminalStep(command), skillForCommandLine(command)], [null, 'sf-decide'], command);
  }
  // A test command is requested by the code step's author in its own turn; /sf-decide's turn refused it.
  const request = 'singularity-flow decision test-command PMC-1 --phase custom-step --id module-tests --reason "The Nx run tests this module."';
  assert.deepEqual([ownTerminalStep(request), skillForCommandLine(request)], [null, 'sf-code'], request);
  // The /sf-decide turn itself runs the first two (the record needs the list's real digest to succeed).
  for (const command of [chat, issue]) {
    assert.notEqual((await mutationToolGuard({ ...decide, toolName: 'bash', toolArgs: { command, cwd: f.root } })).permissionDecision, 'deny', command);
  }
});

test('a plain prompt keeps native behaviour except a person\'s own step, in any spelling, which names its exact command', async t => {
  const f = await fixture(t);
  const plain = await f.enter('Looks good, go ahead and finish it.', 'plain-follow-up');
  const guard = (toolName, toolArgs) => repositoryToolGuard({ ...plain, toolName, toolArgs });
  const shell = command => guard('bash', { command });
  const approve = 'singularity-flow approve custom-step --work-id PMC-1';
  const publish = 'singularity-flow spec author publish SPEC-CHK-004 --reviewed';
  // Each spelling a shell runs: alone, chained, through an alias, env, a package runner, a path, a shell's -c, quotes.
  for (const [command, person] of [
    [`${approve} --yes`, approve], [`cd ${f.root} && ${approve} --yes`, approve], [`sflow approve custom-step --work-id PMC-1 --yes`, approve],
    [`env CI=1 ${approve} --yes --for-agent --json`, `${approve} --json`], [`CI=1 npx --yes ${approve}`, approve],
    [`/usr/local/bin/${publish}`, publish], [`bash -lc "${publish}"`, publish], [`'singularity-flow' spec author publish SPEC-CHK-004 --reviewed`, publish],
    [`${publish} 2>&1 | tee publish.log`, publish], [`out=$(${publish})`, publish], [`echo "$(${publish})"`, publish],
    [`node bin/singularity-flow.mjs spec author publish SPEC-CHK-004 --reviewed`, publish],
    ['singularity-flow guard enable --remote-check sf-guard-verify', 'singularity-flow guard enable --remote-check sf-guard-verify'],
    ['singularity-flow reject custom-step --work-id PMC-1 --to custom-step --reason "Wrong."', 'singularity-flow reject custom-step --work-id PMC-1 --to custom-step --reason Wrong.'],
    ['singularity-flow decisions record PMC-1 --choose d1=dismiss --confirm sha256:' + 'c'.repeat(64), null],
    ['singularity-flow upstream-issue decide UPI-001 --work-id PMC-1 --outcome dismiss --reason "Handled."', null]]) {
    const refused = await shell(command);
    assert.equal(refused.permissionDecision, 'deny', command);
    assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: /u, command);
    if (person) assert.equal(refused.next[0].command, person, command);
    else assert.equal(refused.next.length, 1, command);
  }
  // Approving and returning keep their Copilot route, where the person is asked; --yes is never part of the person's line.
  const approval = await shell(`${approve} --yes`);
  assert.equal(approval.next[0].copilotCommand.split(' ')[0], '/sf-approve');
  assert.match(approval.permissionDecisionReason, /never an agent's, in any chat/u);
  assert.doesNotMatch(approval.next[0].command, /--yes/u);
  // PowerShell's call operator and -Command, and text typed into a running shell.
  assert.equal((await guard('powershell', { command: `& 'singularity-flow' approve custom-step --work-id PMC-1 --yes` })).permissionDecision, 'deny');
  assert.equal((await guard('powershell', { command: `pwsh -NoProfile -Command "${publish}"` })).permissionDecision, 'deny');
  assert.equal((await guard('write_bash', { shellId: '1', input: `${publish}\n` })).next[0].command, publish);
  // A plan's action runs its stored command; issuing its one-time authorization is the person's yes to it.
  const plans = path.join(f.root, '.git', 'singularity-flow', 'action-plans');
  await mkdir(plans, { recursive: true });
  await writeFile(path.join(plans, 'abcdef012345.json'), JSON.stringify({ planId: 'abcdef012345',
    actions: [{ actionId: 'act-1', executable: true, argv: ['approve', 'custom-step', '--work-id', 'PMC-1', '--yes'] }] }));
  for (const command of ['singularity-flow action authorize abcdef012345 --action act-1 --confirm act-1 --json',
    'singularity-flow action execute abcdef012345 --action act-1 --authorization 00000000-0000-4000-8000-000000000000']) {
    assert.equal((await shell(command)).next[0].command, approve, command);
  }
  // Everything else is unchanged: reads, other SFlow commands, previews, mentions in text, edits and other tools.
  for (const command of ['singularity-flow status', 'singularity-flow guard status --json', 'singularity-flow spec author status SPEC-CHK-004 --json', `${approve} --help`,
    'singularity-flow spec split SPEC-CHK-004@1 --propose --file plan.json', 'singularity-flow apm install acme/pack --dry-run',
    `echo "${approve} --yes"`, 'grep -rn "sflow approve" docs', 'npm test', 'rm -rf build']) {
    assert.deepEqual(await shell(command), {}, command);
  }
  assert.deepEqual(await guard('create_file', { path: path.join(f.root, 'src', 'new.js'), file_text: 'x' }), {});
  assert.deepEqual(await guard('edit', { path: 'src/App.jsx' }), {});
  // Paused, SFlow stays out of the way, still never as the person.
  await setCopilotPaused(true);
  try {
    assert.equal((await shell(`${approve} --yes`)).permissionDecision, 'deny');
    assert.deepEqual(await shell('singularity-flow status'), {});
    assert.deepEqual(await mutationToolGuard({ ...plain, toolName: 'bash', toolArgs: { command: publish } }).then(value => value.next?.[0]?.command), publish);
  } finally { await setCopilotPaused(false); }
  // An SFlow turn's own refusals are unchanged: /sf-approve keeps its approval route for its own Story.
  const approving = await f.enter('/sf-approve', 'plain-then-approve');
  const own = await repositoryToolGuard({ ...approving, toolName: 'bash', toolArgs: { command: `${approve} --yes` } });
  assert.doesNotMatch(own.permissionDecisionReason ?? '', /never an agent's, in any chat/u);
});

test('a person\'s decision is refused in every turn but the one they start for it, and in a plain prompt', async t => {
  const f = await fixture(t);
  // Inside /sf-phase, /sf-recover and /sf-next each of these passed the hook: a turn admits a standalone
  // SFlow command, and the CLI's authority check reads the Git identity the agent runs under (2026-11-01).
  const decisions = {
    'story-decision': ['singularity-flow decision scope PMC-1 --item SRI-0123456789ab --as excluded --reason "Out of scope."',
      'singularity-flow decision applicability PMC-1 --clause PMC-1:REQ-001 --as not-applicable --reason "No UI."',
      'singularity-flow decision completeness PMC-1 --reason "Complete."', 'singularity-flow decision choose PMC-1 --choice O1 --reason "Simpler."',
      'singularity-flow decision plan PMC-1 --add-location PMC-1:AC-001=src/a.mjs --reason "Also here."'],
    'story-reopen': ['singularity-flow reopen PMC-1 --to custom-step --reason "Found a defect."'],
    'convergence-adjudication': ['singularity-flow story adjudicate PMC-1 --finding F-1 --as dismissed --reason "Not a defect."'],
    'source-review-decision': ['singularity-flow review-source decide custom-step --finding F-1 --reason "Accepted."'],
    'constitution-exception': ['singularity-flow constitution except ART-1 --work-id PMC-1 --reason "Waived for the spike."'],
    'repair-authorization': [`singularity-flow repair authorize RPR-001 --confirm sha256:${'a'.repeat(64)} --open --json`],
    'telemetry-consent': ['singularity-flow telemetry enable --confirm "ENABLE LOCAL USAGE" --json'],
    'epic-approval': ['singularity-flow initiative approve phase --confirm define:phase --acknowledge-self-approval',
      'singularity-flow epic approve phase --confirm define:phase'],
    'epic-story-decision': [`singularity-flow epic review approve S-1 --epic E-1 --packet ${'b'.repeat(64)}`,
      `singularity-flow initiative review reject S-1 --epic E-1 --packet ${'b'.repeat(64)} --reason "Wrong scope."`],
    'epic-completion': ['singularity-flow epic complete E-1 --confirm E-1'],
    'goal-plan-approval': ['singularity-flow goal plan approve GEX-1 --confirm GEX-1'],
    'sgos-ratification': ['singularity-flow intent ratify INT-1 --confirm INT-1', 'singularity-flow intent confirm INT-1',
      'singularity-flow program approve PRG-1 --confirm PRG-1'],
    'capability-break-glass': ['singularity-flow capabilities lease grant CAP-1 --confirm CAP-1 --reason "Incident."'],
    'host-policy-assertion': ['singularity-flow ledger deployment-check --confirm-protected --authority leads'],
    'agent-trust': ['singularity-flow agents lock local-agent']
  };
  const owners = { 'story-decision': '/sf-decide PMC-1', 'story-reopen': '/sf-reject', 'convergence-adjudication': '/sf-converge',
    'source-review-decision': '/sf-review-decide', 'constitution-exception': '/sf-constitution', 'repair-authorization': '/sf-fix',
    'telemetry-consent': '/sf-telemetry', 'epic-approval': '/sf-initiative-approve', 'epic-story-decision': '/sf-epic-review-decision',
    'epic-completion': '/sf-epic-complete' };
  const ownDenial = /this is a person's decision, recorded under their approval group, never an agent's, in any chat/u;
  const turns = [['/sf-phase', 'author'], ['/sf-recover', 'kernel'], ['/sf-next', 'next'], ['/sf-decide PMC-1', 'decider'],
    ['/sf-spec-author', 'studio'], ['/sf-reject', 'rejecter'], ['/sf-initiative-approve', 'epic-approver'],
    ['/sf-epic-review-decision', 'epic-reviewer'], ['Thanks. Now take care of the rest.', 'plain']];
  const wrong = [];
  for (const [skill, session] of turns) {
    const payload = await f.enter(skill, session);
    for (const [id, commands] of Object.entries(decisions)) {
      for (const command of commands) {
        const decision = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
        const own = owners[id] === skill;
        const refusedAsPerson = decision.permissionDecision === 'deny' && ownDenial.test(decision.permissionDecisionReason);
        if (own === refusedAsPerson) wrong.push(`${skill}: ${command} -> ${decision.permissionDecisionReason?.split('.')[0] ?? 'allowed'}`);
        if (!own && refusedAsPerson && JSON.stringify(decision.next[0]?.argv) !== JSON.stringify(safeCommandGuidance({ command })?.argv)) wrong.push(`${skill}: ${command} names ${decision.next[0]?.command}`);
      }
    }
  }
  assert.deepEqual(wrong, [], 'each decision is refused outside its own turn, with the person\'s exact command, and only there');
  // The refusal names the turn the person starts for it, or only their terminal.
  const plain = await f.enter('Looks fine, finish it.', 'plain-decider');
  const shell = command => repositoryToolGuard({ ...plain, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.match((await shell(decisions['epic-story-decision'][0])).permissionDecisionReason, /they run \/sf-epic-review-decision, which asks them/u);
  // The route under the refusal is that same turn, where a turn owns the step; none says none.
  const accounted = await shell(decisions['story-decision'][4]);
  assert.match(accounted.next[0].copilotCommand, /^\/sf-decide\b/u);
  assert.doesNotMatch(accounted.permissionDecisionReason, /no verified equivalent/u);
  assert.match((await shell(decisions['convergence-adjudication'][0])).next[0].copilotCommand, /^\/sf-converge\b/u);
  assert.match((await shell(decisions['agent-trust'][0])).permissionDecisionReason, /no verified equivalent/u);
  // The decisions page is a tool that takes a Story ID; the person answers on it, so no turn is refused it.
  for (const toolName of ['singularityFlow_adjudicate', 'sflowAdjudicate', 'sflow_adjudicate']) {
    const opening = await repositoryToolGuard({ ...await f.enter('/sf-converge', 'page-opener'), toolName, toolArgs: { workId: 'PMC-1' } });
    assert.notEqual(opening.permissionDecision, 'deny', toolName);
  }
  for (const toolName of ['singularityFlow_decide', 'sflowDecide', 'sflow_decide']) {
    const opening = await repositoryToolGuard({ ...await f.enter('/sf-decide PMC-1', 'card-opener'), toolName, toolArgs: { workId: 'PMC-1' } });
    assert.notEqual(opening.permissionDecision, 'deny', toolName);
  }
  // A chain in the turn that owns the decision keeps the person's answers: run them one at a time.
  const chain = 'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "Not a defect." && singularity-flow story adjudicate CF-2 --disposition dismissed --reason "Nor this."';
  const converging = await f.enter('/sf-converge', 'converger');
  await personSaid(converging, 'Not a defect.');
  const inOwnTurn = await repositoryToolGuard({ ...converging, toolName: 'bash', toolArgs: { command: chain, cwd: f.root } });
  assert.equal(inOwnTurn.permissionDecision, 'deny', 'a chain is still refused, so each command is checked alone');
  assert.match(inOwnTurn.permissionDecisionReason, /nothing was recorded because these commands were chained/u);
  assert.match(inOwnTurn.permissionDecisionReason, /with the answers the person already gave/u);
  assert.doesNotMatch(inOwnTurn.permissionDecisionReason, /do not retry/u);
  assert.notEqual((await repositoryToolGuard({ ...converging, toolName: 'bash', toolArgs: { command: decisions['convergence-adjudication'][0], cwd: f.root } })).permissionDecision, 'deny');
  const elsewhere = await repositoryToolGuard({ ...plain, toolName: 'bash', toolArgs: { command: chain, cwd: f.root } });
  assert.match(elsewhere.permissionDecisionReason, ownDenial, 'any other turn keeps the person\'s refusal');
  assert.match((await shell(decisions['agent-trust'][0])).permissionDecisionReason, /in their own terminal, and no turn runs it/u);
  // Its previews stay open.
  for (const command of ['singularity-flow decision plan PMC-1 --add-location PMC-1:AC-001=src/a.mjs --dry-run',
    'singularity-flow epic complete E-1 --dry-run --json', 'singularity-flow program approve PRG-1', 'singularity-flow decision show PMC-1']) {
    assert.deepEqual(await shell(command), {}, command);
  }
  // The test suite's switches never stand in for a person, in a plain prompt or a turn, in any spelling.
  const author = await f.enter('/sf-phase', 'switched-author');
  for (const command of ['NODE_ENV=test singularity-flow approve custom-step --work-id PMC-1 --yes',
    'env SINGULARITY_FLOW_TEST_IDENTITY="Other Approver" singularity-flow status',
    'export NODE_ENV=test; singularity-flow initiative approve phase', 'NODE_ENV="test" sflow decisions record PMC-1']) {
    for (const payload of [plain, author]) {
      const refused = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.match(refused.permissionDecisionReason ?? '', /NODE_ENV=test or a SINGULARITY_FLOW_TEST_ variable set is refused in every chat/u, command);
    }
  }
  assert.match((await repositoryToolGuard({ ...plain, toolName: 'powershell',
    toolArgs: { command: "$env:SINGULARITY_FLOW_TEST_IDENTITY='Other'; singularity-flow status" } })).permissionDecisionReason ?? '',
  /SINGULARITY_FLOW_TEST_ variable/u);
  // A test run that starts no SFlow command keeps its native behaviour.
  assert.deepEqual(await shell('NODE_ENV=test node --test test/app.test.mjs'), {});
});

test('no agent publishes its draft as a person\'s writing, an external tool\'s output or with no author, in any turn or a plain prompt', async t => {
  const f = await fixture(t);
  // As --authored human an agent's draft skipped its clarification record and session proof; with the
  // kernel's model off, prepublish itself offered that route to Copilot (live reruns, 2026-11-01).
  const claims = ['singularity-flow phase publish custom-step --authored human --channel manual-in-place --no-model',
    'singularity-flow phase publish custom-step --authored human --channel manual-import --from draft.md',
    `cd ${f.root} && sflow phase publish custom-step`, 'singularity-flow phase publish custom-step --authored legacy-unspecified --channel legacy',
    'singularity-flow phase publish custom-step --authored governed-agent --channel manual-in-place',
    // SFlow records no external tool's run: as external-tool an agent's draft skipped the same checks.
    'singularity-flow phase publish custom-step --authored external-tool --channel external-tool',
    'singularity-flow phase publish custom-step --authored external-tool --channel external-tool --from draft.md',
    'singularity-flow phase publish custom-step --authored governed-agent --channel external-tool'];
  const own = ['singularity-flow phase publish custom-step --authored governed-agent --channel copilot-host --no-model',
    'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator',
    'singularity-flow phase prepublish custom-step --for-agent --json --publish-if-ready', 'singularity-flow phase publish custom-step --help'];
  for (const [skill, session] of [['/sf-phase', 'publisher'], ['/sf-recover', 'recoverer'], ['/sf-next', 'next-publisher'], ['Publish it now.', 'plain-publisher']]) {
    const payload = await f.enter(skill, session);
    for (const command of claims) {
      const refused = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.match(refused.permissionDecisionReason ?? '', /an agent records its own publication as governed-agent, never as a person's writing, an external tool's output or with no author, in any chat/u, `${skill}: ${command}`);
      // Its own route first, then the person's line for their own terminal, with no skill.
      assert.equal(refused.next[0].command, 'singularity-flow phase prepublish custom-step --for-agent --json --publish-if-ready', `${skill}: ${command}`);
      assert.deepEqual([refused.next[1].copilotCommand, refused.next[1].skill], [null, null], `${skill}: ${command}`);
    }
    for (const command of own) {
      const decision = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.doesNotMatch(decision.permissionDecisionReason ?? '', /never as a person's writing/u, `${skill}: ${command}`);
    }
  }
});

test('no agent records its upstream issue or scope proposal as a person\'s, except the person\'s own words in /sf-decide (SFG G2)', async t => {
  const f = await fixture(t);
  const claims = ['singularity-flow upstream-issue raise --phase custom-step --about AC-001 --problem "The criterion has no boundary." --authored human',
    'singularity-flow story intent-amendment propose --work-id PMC-1 --file amended.md --reason "Scope moved." --authored human',
    'singularity-flow story intent-amendment propose --work-id PMC-1 --file amended.md --reason "Scope moved." --authored governed-agent --channel manual-import'];
  const own = ['singularity-flow upstream-issue raise --phase custom-step --about AC-001 --problem "The criterion has no boundary."',
    'singularity-flow upstream-issue raise --phase custom-step --about AC-001 --problem "The criterion has no boundary." --authored governed-agent',
    'singularity-flow story intent-amendment propose --work-id PMC-1 --file amended.md --reason "Scope moved." --authored governed-agent --channel copilot-host'];
  for (const [skill, session] of [['/sf-phase', 'raiser'], ['/sf-next', 'next-raiser'], ['Raise it now.', 'plain-raiser']]) {
    const payload = await f.enter(skill, session);
    for (const command of claims) {
      const refused = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.match(refused.permissionDecisionReason ?? '', /an agent records its own upstream issue or scope proposal as governed-agent, never as a person's/u, `${skill}: ${command}`);
      // Its own record first: the same command as the agent's, then the person's line for their own terminal.
      assert.match(refused.next[0].command, /--authored governed-agent$/u, `${skill}: ${command}`);
      assert.doesNotMatch(refused.next[0].command, /--authored human|--channel/u, `${skill}: ${command}`);
      assert.deepEqual([refused.next[1].copilotCommand, refused.next[1].skill], [null, null], `${skill}: ${command}`);
    }
    for (const command of own) {
      const decision = await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      assert.doesNotMatch(decision.permissionDecisionReason ?? '', /never as a person's/u, `${skill}: ${command}`);
    }
  }
  // In the person's own /sf-decide the agent records their words: a raise there stays theirs.
  const decide = await f.enter('/sf-decide', 'decider-raise');
  const theirs = await repositoryToolGuard({ ...decide, toolName: 'bash', toolArgs: { command: claims[0], cwd: f.root } });
  assert.doesNotMatch(theirs.permissionDecisionReason ?? '', /never as a person's/u);
});

test('no agent turn pins a Story\'s authorized browser target origin; its preview stays a read', async t => {
  const f = await fixture(t);
  const digest = `sha256:${'b'.repeat(64)}`;
  const preview = 'singularity-flow story target-origin PMC-1 --url https://staging.example.test --json';
  const pin = `singularity-flow story target-origin PMC-1 --url https://staging.example.test --reason "Approved staging target." --confirm ${digest}`;
  const typed = await f.enter(`/sf-confirm ${pin.replace('singularity-flow ', '')}`, 'origin-confirmer');
  for (const [skill, payload] of [['/sf-phase', await f.enter('/sf-phase')], ['/sf-recover', await f.enter('/sf-recover', 'kernel')],
    ['/sf-mcp', await f.enter('/sf-mcp', 'mcp')], ['/sf-confirm with the typed digest', typed]]) {
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: preview, cwd: f.root } }), {},
      `${skill}: previewing the pin is allowed`);
    const denied = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: pin, cwd: f.root } });
    assert.equal(denied.permissionDecision, 'deny', skill);
    assert.match(denied.permissionDecisionReason, /authorized browser target origin is a security boundary; a person who approves the step that smoke-checks it confirms the pin in their own terminal/u, skill);
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

test('a command that only reads needs no shell baseline, even when its pre-tool hook timed out; an unknown one is still stopped', async t => {
  const f = await fixture(t);
  // Copilot ran these after their pre-tool hook timed out, so no pre-tool baseline was saved.
  const quiet = await f.enter('/sf-phase', 'timed-out-read');
  for (const command of ['git status --short && git --no-pager diff -- singularity/work-items/PMC-1/workflow.json src/App.jsx',
    'git log --oneline -5', 'git show --stat HEAD', 'pwd']) {
    const call = { ...quiet, toolName: 'bash', toolArgs: { command, cwd: f.root } };
    assert.deepEqual(await mutationPostToolGuard(call), {}, command);
  }
  for (const command of ['git diff --output=patch.txt', 'git status > status.txt', 'git status | tee status.txt', 'sh ./outside.sh']) {
    const changed = await f.enter('/sf-phase', `timed-out-${command.length}`);
    const result = await mutationPostToolGuard({ ...changed, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    assert.match(result.stopReason ?? '', /PHASE_MUTATION_BASELINE_UNAVAILABLE/u, command);
  }
  // A read takes no snapshot before it runs, so a busy hook does less.
  const pre = await f.enter('/sf-phase', 'read-no-snapshot');
  assert.deepEqual(await mutationToolGuard({ ...pre, toolName: 'bash', toolArgs: { command: 'git status --short', cwd: f.root } }), {});
  const record = JSON.parse(await readFile((await readdir(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), { recursive: true }))
    .map(name => path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), name))
    .filter(name => name.endsWith('.mutation.json')).find(name => readFileSync(name, 'utf8').includes('read-no-snapshot')), 'utf8'));
  assert.equal(record.baseline, null);
});

test('a routing decision that moves the step is not stopped afterwards by the read-only turn it made [audit 1]', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-decide PMC-1', 'decide-moves');
  await personSaid(payload, 'The person chose to ship.');
  const choose = { ...payload, toolName: 'bash', toolArgs: { cwd: f.root,
    command: 'singularity-flow decision choose PMC-1 --option ship --reason "The person chose to ship." --expected k1' } };
  assert.deepEqual(await mutationToolGuard(choose), {});
  // The decision moved the Story to its next step; the CLI refreshes the turn at its boundary.
  const moved = { ...f.workflow, currentPhase: 'next-step', phaseOrder: ['custom-step', 'next-step'],
    phases: { 'custom-step': { ...f.phase, status: 'approved' }, 'next-step': { ...f.phase, id: 'next-step', status: 'in_progress' } } };
  await writeFile(f.workflowFile, JSON.stringify(moved));
  await refreshMutationContracts(f.root, { ...f.accepted, workflow: moved }, { advanceBaseline: true });
  assert.deepEqual(await mutationPostToolGuard(choose), {}, 'judged by the turn it ran in');
  assert.equal((await mutationToolGuard(choose)).permissionDecision, 'deny', 'the moved turn runs no more decisions');
});

test('a person staging or editing during an authoring turn is not blamed on the next SFlow read [audit 6]', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-phase', 'person-stages');
  await writeFile(path.join(f.root, 'notes.txt'), 'the person writes this in their editor');
  f.git(['add', 'notes.txt']);
  const status = { ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow status PMC-1 --json', cwd: f.root } };
  assert.deepEqual(await mutationToolGuard(status), {});
  assert.deepEqual(await mutationPostToolGuard(status), {}, 'a kernel read the turn allowed is not judged by outside changes');
});

test('an approval that ends its own turn is not stopped afterwards for want of a shell baseline', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-approve', 'approval-ends');
  const approve = { ...payload, toolName: 'bash', toolArgs: { cwd: f.root,
    command: 'singularity-flow approve custom-step --work-id PMC-1 --fetch --selection-receipt 11111111-1111-4111-8111-111111111111 --for-agent --json' } };
  assert.deepEqual(await mutationToolGuard(approve), {});
  // The CLI ends the decision turn at its own boundary after a successful approval.
  await refreshMutationContracts(f.root, f.accepted, { decisionEnded: true });
  assert.deepEqual(await mutationPostToolGuard(approve), {}, 'the approval is judged by the turn it ran in');
  assert.equal((await mutationToolGuard(approve)).permissionDecision, 'deny', 'the ended turn runs nothing more');
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

test('native diagnostic reports survive successful and failing test processes without ending authoring', async t => {
  const f = await fixture(t);
  const report = '.sflow/results/node-tests.json';
  await writeFile(path.join(f.root, 'diagnostic.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const failed = process.argv[2] === 'fail';
try { assert.equal(failed ? 0 : 1, 1); } catch { process.exitCode = 1; }
mkdirSync('.sflow/results',{recursive:true});
writeFileSync('${report}',JSON.stringify({numTotalTests:1,numPassedTests:failed?0:1,numFailedTests:failed?1:0}));
`);
  f.git(['add', 'diagnostic.mjs']); f.git(['commit', '-qm', 'diagnostic runner']);
  const payload = await f.enter('/sf-phase', 'native-report-continuation');
  const workflowBytes = await readFile(f.workflowFile, 'utf8');
  for (const outcome of ['fail', 'pass']) {
    const call = { ...payload, toolName: 'bash', toolArgs: { command: `node diagnostic.mjs ${outcome}`, cwd: f.root } };
    assert.deepEqual(await mutationToolGuard(call), {});
    const run = spawnSync(process.execPath, ['diagnostic.mjs', outcome], { cwd: f.root, encoding: 'utf8' });
    assert.equal(run.status, outcome === 'fail' ? 1 : 0, run.stderr);
    assert.deepEqual(await mutationPostToolGuard(call), {}, 'the exit/result is diagnostic, not a forbidden file edit');
    assert.equal(JSON.parse(await readFile(path.join(f.root, report), 'utf8')).numFailedTests, outcome === 'fail' ? 1 : 0);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: {
      path: 'singularity/work-items/PMC-1/artifacts/custom-step/summary.md'
    } }), {}, 'continue repairing the admitted draft in the same turn');
    assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: report } })).permissionDecision,
      'deny', 'post-command output classification grants no report file-edit permission');
  }
  assert.equal(await readFile(f.workflowFile, 'utf8'), workflowBytes, 'diagnostics never retain evidence or advance a phase');
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: {
    command: 'singularity-flow phase prepublish custom-step --json'
  } }), {});
});

test('all authoring phases preserve untracked runner output through creation, replacement and cleanup', async t => {
  const f = await fixture(t);
  const outputs = ['.sflow/results/node-tests.json', 'packages/ui/.sflow/results/junit.xml',
    'packages/ui/test-results/.last-run.json', 'playwright-report/index.html', 'blob-report/report.zip'];
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-check', 'custom-repair']) {
    f.workflow.currentPhase = id;
    f.workflow.phaseOrder = [id];
    f.workflow.phases = { [id]: { ...f.phase, id } };
    await writeFile(f.workflowFile, JSON.stringify(f.workflow));
    const payload = await f.enter('/sf-phase', `runner-output-${id}`);
    const call = { ...payload, toolName: 'run_in_terminal', toolArgs: { command: 'npm test', cwd: f.root } };
    for (const mode of ['create', 'replace', 'remove']) {
      assert.deepEqual(await mutationToolGuard(call), {}, `${id}/${mode}/pre`);
      for (const file of outputs) {
        const absolute = path.join(f.root, file);
        if (mode === 'remove') await unlink(absolute);
        else {
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(absolute, `${mode}: ${id}\n`);
        }
      }
      assert.deepEqual(await mutationPostToolGuard(call), {}, `${id}/${mode}/post`);
    }
  }
});

test('runner output exceptions preserve tracked, linked, protected and retained-state boundaries', async t => {
  for (const kind of ['tracked', 'staged', 'hardlink', 'symlink', 'protected', 'retained', 'unknown-output']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const relative = kind === 'retained' ? 'singularity/work-items/PMC-1/artifacts/earlier/test-results/report.json'
        : kind === 'unknown-output' ? 'coverage/unknown.json' : '.sflow/results/node-tests.json';
      const absolute = path.join(f.root, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      if (kind === 'tracked') {
        await writeFile(absolute, 'original\n');
        f.git(['add', relative]); f.git(['commit', '-qm', 'retained report']);
      }
      if (kind === 'protected') f.definition.governance.protectedPaths.push('.sflow/results');
      const payload = await f.enter('/sf-phase', `report-boundary-${kind}`);
      const call = { ...payload, toolName: 'bash', toolArgs: { command: 'npm test', cwd: f.root } };
      assert.deepEqual(await mutationToolGuard(call), {});
      if (kind === 'symlink') await symlink(path.join(f.root, 'src', 'App.jsx'), absolute);
      else if (kind === 'hardlink') await link(path.join(f.root, 'src', 'App.jsx'), absolute);
      else await writeFile(absolute, 'changed\n');
      if (kind === 'staged') f.git(['add', relative]);
      const refusal = await mutationPostToolGuard(call);
      assert.equal(refusal.continue, false, kind);
      assert.match(refusal.stopReason, /PHASE_MUTATION_SHELL_CHANGE_DETECTED/u);
      assert.ok(refusal.stopReason.includes(relative), kind);
      assert.equal((await mutationToolGuard(call)).permissionDecision, 'deny', 'real findings stay latched');
      assert.equal(await readFile(path.join(f.root, 'src', 'App.jsx'), 'utf8'), 'export const value = 1;\n');
    });
  }
});

test('older report-only hook findings heal in the same live turn without clearing real findings', async t => {
  const f = await fixture(t);
  const report = '.sflow/results/node-tests.json';
  const payload = await f.enter('/sf-phase', 'old-report-latch');
  const call = { ...payload, toolName: 'bash', toolArgs: { command: 'npm test', cwd: f.root } };
  await mutationToolGuard(call);
  await mkdir(path.join(f.root, '.sflow', 'results'), { recursive: true });
  await writeFile(path.join(f.root, report), '{"passed":1}\n');
  const recordPath = path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries',
    `${createHash('sha256').update(payload.sessionId).digest('hex')}.mutation.json`);
  async function oldFinding(findings) {
    const { integritySha256: ignored, ...content } = JSON.parse(await readFile(recordPath, 'utf8'));
    delete content.baseline.disposableOutputs;
    content.findings = findings;
    await writeFile(recordPath, JSON.stringify({ ...content,
      integritySha256: createHash('sha256').update(JSON.stringify(content)).digest('hex') }));
  }
  const artifact = { ...payload, toolName: 'edit', toolArgs: {
    path: 'singularity/work-items/PMC-1/artifacts/custom-step/summary.md'
  } };
  await oldFinding([report]);
  assert.deepEqual(await mutationToolGuard(artifact), {});
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')).findings, []);
  await oldFinding([report, 'policy/rules.yml', '[HEAD/index changed outside a recorded kernel operation]']);
  assert.equal((await mutationToolGuard(artifact)).permissionDecision, 'deny');
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')).findings,
    ['policy/rules.yml', '[HEAD/index changed outside a recorded kernel operation]']);
  assert.equal(await readFile(path.join(f.root, report), 'utf8'), '{"passed":1}\n');
});

test('a delegation skill takes the turn of the skill it delegates to, so the delegated run is not refused', async t => {
  const { skills } = YAML.parse(readFileSync(new URL('../plugin/skills/registry.yml', import.meta.url), 'utf8'));
  const delegations = Object.entries(skills).filter(([, rule]) => rule.class === 'delegation');
  assert.ok(delegations.some(([id]) => id === 'sflow-call'));
  for (const [id, rule] of delegations) assert.equal(mutationTurnMode(id), mutationTurnMode(rule.delegatesTo), `${id} delegates to ${rule.delegatesTo}`);
  // A live /sf-call ran /sf-code through a sub-agent, which a read turn refused (PHASE_MUTATION_DELEGATION_NOT_ALLOWED).
  const f = await fixture(t);
  for (const skill of ['/sf-call', '/sf-scenario-repair']) {
    const payload = await f.enter(skill, `delegate-${skill}`);
    const decision = await mutationToolGuard({ ...payload, toolName: 'task', toolArgs: { prompt: 'Run /sf-code once for the current step.' } });
    assert.doesNotMatch(JSON.stringify(decision), /DELEGATION_NOT_ALLOWED/u, skill);
  }
});

// The registry-wide check below reads every skill's own SFlow commands, fills their placeholders,
// and asks the guard whether that skill's turn admits each one. A command is skipped when the guard
// itself names it the person's or another turn's: a kernel-only turn refuses it with one of its specific
// OPERATION_NOT_ALLOWED reasons (binding or removing environment values, a decision-list record, a
// workflow-delete confirmation, a set-aside, a test-risk or evidence-reuse decision, a target-origin pin,
// a host hook), never with its generic "not permitted by the bound turn mode" or a planned action it
// would not run (the fixture plan's one action is `sync`), or it is listed below with its reason.
// Anything else the turn refuses fails, so a skill can no longer get a turn that refuses its own steps.
const PERSON_OR_OTHER_TURN = /OPERATION_NOT_ALLOWED: (?!this standalone command is not permitted by the bound turn mode|action execute runs its planned command)/u;
const SKILL_COMMAND_RECEIPT = '8232baec-10cb-4dd1-a8af-066d1fb06841';
// `action execute <PLAN-ID> --action <ACTION-ID>` resolves to this fixture plan, whose one action is `sync`.
const SKILL_COMMAND_PLAN = '0123456789abcdef01234567';
const SKILL_COMMAND_ACTION = 'fedcba9876543210fedcba98';
const LEGACY_PLACEHOLDER = /^(?:FILE|URL|PATH|PHASE|TYPE|TEXT|ID|SHA|SHA256|REVISION|PROFILE|SLICE|LEVEL|ASSURANCE|VERSION|STATUS|SOURCE|ENV|SECONDS|BYTES|WORK-ID|GOAL-ID|BOOTSTRAP-ID)$/u;
function skillPlaceholderValue(name, root) {
  const key = name.toUpperCase();
  if (/^(?:WORK-ID|STORY-KEY|STORY-ID|JIRA-ID|JIRA-KEY|ID\|NAME)$/u.test(key)) return 'PMC-1';
  if (/^(?:TYPED-PHASE|PHASE|PHASE-ID|EARLIER-PHASE|STEP|EARLIER-STEP|OWNING-STEP)$/u.test(key)) return 'custom-step';
  if (key === 'TOKEN') return SKILL_COMMAND_RECEIPT;
  if (key === 'PLAN-ID') return SKILL_COMMAND_PLAN;
  if (key === 'ACTION-ID') return SKILL_COMMAND_ACTION;
  if (key === 'UPI-ID') return 'UPI-001';
  if (/SHA|HASH|DIGEST|COMMIT/u.test(key)) return 'a'.repeat(64);
  if (/URL/u.test(key)) return 'https://example.test/x';
  if (/FILE|PATH|DIRECTORY|^DIR$|^OUT$|^XML$|^PNG$|CHECKOUT/u.test(key)) return path.join(root, 'notes.md');
  return 'x1';
}
/** One named command with placeholders filled, optional groups dropped and `a|b` choices expanded. */
function expandSkillCommand(raw, root) {
  const text = raw.replace(/\s+/gu, ' ').trim().replace(/'?\$ARGUMENTS'?/gu, ' ').replace(/\[[^\]]*\]/gu, ' ')
    .replace(/\.{3}|…/gu, ' ').replace(/<([^<>]+)>/gu, (_, name) => skillPlaceholderValue(name, root));
  const words = text.split(' ').filter(Boolean).map(word => LEGACY_PLACEHOLDER.test(word) ? skillPlaceholderValue(word, root) : word);
  const choice = words.findIndex(word => /^[a-z][a-z-]*(?:\|[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(word));
  return choice < 0 ? [words.join(' ')] : words[choice].split('|').flatMap(option =>
    expandSkillCommand([...words.slice(0, choice), option, ...words.slice(choice + 1)].join(' '), root));
}
/** Every SFlow command a skill body names: inline code spans and the lines of fenced blocks. */
function skillBodyCommands(body) {
  const spans = [...body.replace(/```[\s\S]*?```/gu, ' ').matchAll(/`((?:singularity-flow|sflow) [^`]+)`/gu)].map(match => match[1]);
  const fenced = [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)].flatMap(match => match[1].replace(/\\\n\s*/gu, ' ').split('\n'))
    .map(line => line.replace(/\s+#.*$/u, '').trim()).filter(line => /^(?:singularity-flow|sflow) /u.test(line));
  return [...new Set([...spans, ...fenced].map(command => command.replace(/\s+/gu, ' ').trim()))];
}
/** Commands a skill names but hands to the person, offers as another skill's route, or only describes. */
const NOT_RUN_BY_THIS_TURN = Object.freeze({
  'sflow-advise': [[/^workspace reinitialize\b/u, 'advisory only: offers /sf-admin reinitialize and never runs it']],
  'sflow-build-workflow': [[/^configuration approve\b/u, 'the reviewer approves in their own terminal']],
  'sflow-fix-workflow': [[/^configuration approve\b/u, 'the reviewer approves in their own terminal'],
    [/^workflow studio apply\b.*--propose\b/u, 'proposes only the change set `workflow validate` issued to the turn (its own test)']],
  'sflow-run-app': [[/^(?:capability (?:edit|set)|app config save-local)\b/u, 'saves or proposes only the application draft `app suggest` issued to the turn (its own test)']],
  'sflow-spec-author': [[/^spec author propose\b/u, 'stages only the proposal file `spec author status` issued to the turn (its own test)'],
    [/^spec author new\b/u, 'describes new-draft creation by the person in Spec Studio or their own terminal; this skill proposes to an existing draft']],
  'sflow-reinstall': [[/^plugin verify\b/u, 'the installer\'s own verification, which `singularity-flow reinstall` runs and reports']],
  'sflow-revision-checks': [[/^revision checks run\b/u, 'displayed for separate Shell review; never run from this skill']],
  'sflow-initiative-checklist': [[/^initiative evidence add\b/u, 'shown as an example; registration is /sf-initiative-evidence']],
  'sflow-jira-work': [[/^start PMC-1 --jira\b/u, 'the Shell form of the /sf-start route it offers']],
  'sflow-nextsteps': [[/^sync$/u, 'lists the returned actions; /sf-next runs them']],
  'sflow-reject': [[/^story intent-amendment propose$/u, 'names the nextsteps action; its full command is checked']],
  'sflow-decide': [[/^upstream-issue decide$/u, 'names the family in its turn boundary; its full `upstream-issue decide <UPI-ID> --work-id` step is checked'],
    [/^upstream-issue raise$/u, 'names the returned route it runs; the full raise with --work-id, --phase, --about and --problem is checked in the /sf-decide turn test']],
  'sflow-workflow-rules': [[/^approve$/u, 'says who may approve; an approval is recorded only in an /sf-approve turn']],
  'sflow-sgos-create': [[/^(?:process (?:start|step|run)|intent (?:ratify|compile))\b/u, 'named only as commands it never runs']],
  'sflow-auto': [[/^auto flight-step\b/u, 'named only as a command it never invokes directly']],
  'sflow-integrations': [[/^integrations deliver\b/u, 'for pipelines; not run from chat']]
});
/** Commands of a skill that needs no Story which act on a bound Story, so only a Story-bound turn runs them. */
const NEEDS_A_STORY = Object.freeze({
  'sflow-documents': [[/^documents restore\b/u, 'rehydrates a bound Story\'s pinned document']],
  'sflow-test-setup': [[/^story test-policy amend\b/u, 'previews an active Story\'s test-policy amendment']],
  'sflow-start': [[/^resume PMC-1\b/u, 'the route to an existing Story it offers']],
  'sflow-ready': [[/^start PMC-1\b/u, 'the Shell form of its /sf-start handoff']],
  'sflow-return': [[/^resume\b/u, 'named only as the command it must not substitute']],
  'sflow-push': [[/^sync$/u, 'named only as the Story publication command it must not substitute']],
  'sflow-prompt-log': [[/^wm compose$/u, 'describes which handoffs capture prompts']],
  'sflow-quickstart': [[/^(?:init|bootstrap)\b/u, 'the next step it offers for the person\'s own repository']]
});
/** Skills whose registry boundary needs no Story but whose steps are Story work. */
const STORY_WORK_SKILLS = Object.freeze({
  'sflow-workflow-rules': 'its steps start from a ready Story session (`session current`) and act on its phases'
});

test('every registry skill\'s turn admits the SFlow commands its own body runs, with and without a bound Story', async t => {
  const { skills } = YAML.parse(readFileSync(new URL('../plugin/skills/registry.yml', import.meta.url), 'utf8'));
  const { commandDefinition } = await import('../src/command-registry.mjs');
  const { parseArgs } = await import('../src/util.mjs');
  const f = await fixture(t);
  await mkdir(path.join(gitDir(f.root), 'singularity-flow', 'action-plans'), { recursive: true });
  await writeFile(path.join(gitDir(f.root), 'singularity-flow', 'action-plans', `${SKILL_COMMAND_PLAN}.json`),
    JSON.stringify({ kind: 'governed-action-plan', actions: [{ actionId: SKILL_COMMAND_ACTION, executable: true, argv: ['sync'] }] }));
  const bare = async (skill, sessionId) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
    return payload;
  };
  const kernel = await f.enter('/sf-next', 'registry-kernel');
  const listed = (table, id, argv) => (table[id] ?? []).some(([pattern]) => pattern.test(argv));
  const failures = [];
  let checked = 0;
  for (const [id, rule] of Object.entries(skills)) {
    const skill = `/${id.replace(/^sflow-/u, 'sf-')}`;
    const body = readFileSync(new URL(`../plugin/skills/${id}/SKILL.md`, import.meta.url), 'utf8');
    const bound = await f.enter(skill, `registry-${id}`);
    const unbound = (rule.executionBoundary ?? 'story') !== 'story' && !STORY_WORK_SKILLS[id] ? await bare(skill, `registry-bare-${id}`) : null;
    for (const named of skillBodyCommands(body)) for (const command of expandSkillCommand(named, f.root)) {
      const argv = command.replace(/^(?:singularity-flow|sflow) ?/u, '');
      const first = parseArgs(argv.split(' ').filter(Boolean)).positionals[0];
      // `singularity-flow <action>` or `$ARGUMENTS` alone describes the CLI form; it names no command.
      try { if (!first) continue; commandDefinition(first); } catch { continue; }
      if (listed(NOT_RUN_BY_THIS_TURN, id, argv)) continue;
      const shell = payload => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
      const personOnly = async () => {
        const decision = await shell(kernel);
        return decision.permissionDecision === 'deny' && PERSON_OR_OTHER_TURN.test(decision.permissionDecisionReason ?? '');
      };
      checked += 1;
      const decision = await shell(bound);
      if (decision.permissionDecision === 'deny' && !(await personOnly())) {
        failures.push(`${id} (${mutationTurnMode(id)} turn, Story bound) refuses: ${command} — ${decision.permissionDecisionReason?.split('.')[0]}`);
      }
      if (unbound && !listed(NEEDS_A_STORY, id, argv)) {
        const before = await shell(unbound);
        if (before.permissionDecision === 'deny' && !(await personOnly())) {
          failures.push(`${id} (${mutationTurnMode(id)} turn, no Story yet) refuses: ${command} — ${before.permissionDecisionReason?.split('.')[0]}`);
        }
      }
    }
  }
  assert.ok(checked > 900, `${checked} skill commands checked`);
  assert.deepEqual(failures, []);
  // Every listed exception still names a command its skill has, so the lists cannot go stale.
  for (const table of [NOT_RUN_BY_THIS_TURN, NEEDS_A_STORY]) for (const [id, entries] of Object.entries(table)) {
    const commands = skillBodyCommands(readFileSync(new URL(`../plugin/skills/${id}/SKILL.md`, import.meta.url), 'utf8'))
      .flatMap(named => expandSkillCommand(named, f.root)).map(command => command.replace(/^(?:singularity-flow|sflow) ?/u, ''));
    for (const [pattern, reason] of entries) assert.ok(commands.some(command => pattern.test(command)), `${id}: ${pattern} (${reason}) matches none of its commands`);
  }
});

test('/sf-test-setup may propose the exact test command it previewed, its JSON argv quoted, with or without a Story', async t => {
  const f = await fixture(t);
  const bare = { cwd: f.root, sessionId: 'test-setup-bare', prompt: '/sf-test-setup' };
  await recordRepositoryBoundaryTurn(bare, { captureMutation: (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
  const bound = await f.enter('/sf-test-setup', 'test-setup-bound');
  // The line `capability test-setup` prints as its confirmCommand, with --json added.
  const command = `singularity-flow capability test-setup --step implementation --id shop-e2e-junit --argv '["npx","nx","run","shop-e2e:e2e"]' `
    + `--working-directory . --affected-root apps/shop-e2e --adapter junit-xml --report coverage/e2e/shop-e2e/junit-results.xml --confirm sha256:${'a'.repeat(64)} --json`;
  // A command read from the team's instructions is confirmed by its candidate ID [TCE:REQ-063].
  const written = `singularity-flow capability test-setup --step implementation --use npx-playwright-test-project-chromium --confirm sha256:${'a'.repeat(64)} --json`;
  for (const payload of [bare, bound]) for (const line of [command, written]) {
    const decision = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: line, cwd: f.root } });
    assert.notEqual(decision.permissionDecision, 'deny', `${payload.sessionId}: ${decision.permissionDecisionReason}`);
  }
  for (const payload of [bare, bound]) {
    // The same turn still edits no file itself.
    const edit = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'printf x > singularity/workflow.yml', cwd: f.root } });
    assert.equal(edit.permissionDecision, 'deny', payload.sessionId);
  }
});

test('skills that run their own kernel steps get a kernel-only turn; /sf-inbox only attaches; reads stay read', () => {
  for (const skill of ['/sf-finalize', '/sf-pr', '/sf-push', '/sf-story-start', '/sf-refresh-branch', '/sf-cancel', '/sf-return',
    '/sf-assign', '/sf-mcp', '/sf-ready', '/sf-epic-start', '/sf-epic-sync', '/sf-jira-update', '/sf-upload', '/sf-test-setup']) {
    assert.equal(mutationTurnMode(skill), 'kernel-only', skill);
  }
  for (const skill of ['/sf-inbox', '/sf-stories', '/sf-workspace-session']) assert.equal(mutationTurnMode(skill), 'session-only', skill);
  // Reads stay read: their commands are reads, and what they hand on is another skill's route.
  for (const skill of ['/sf-nextsteps', '/sf-check', '/sf-doctor', '/sf-epic-status', '/sf-jira-assigned', '/sf-initiative-status', '/sf-harness']) {
    assert.equal(mutationTurnMode(skill), 'read', skill);
  }
  // /sf-converge authors the step at a model-generation checkpoint; a deterministic step still grants no edits.
  assert.equal(mutationTurnMode('/sf-converge'), 'authoring');
  const deterministic = { id: 'convergence', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'document', requirement: 'required', allowedProducers: ['deterministic'] } };
  const contract = deriveMutationContract({ root: null, definition: { workItemRoot: 'singularity/work-items' },
    workflow: { workItem: { id: 'PMC-1' }, currentPhase: 'convergence', phaseOrder: ['convergence'], phases: { convergence: deterministic }, resolution: {} },
    turnMode: mutationTurnMode('/sf-converge') });
  assert.deepEqual(contract.allow.artifacts, []);
  assert.equal(contract.allow.application, false);
});

test('a /sf-reject turn proposes an amendment, reopens and rolls forward the bound Story only, and drafts only the issued file', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-reject', 'reject-routes');
  const shell = (value, command) => mutationToolGuard({ ...value, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const draft = path.join(gitDir(f.root), 'singularity-flow', 'intent-amendment-drafts', 'PMC-1.md');
  for (const command of [
    'singularity-flow reject custom-step --work-id PMC-1 --fetch --to custom-step --reason "Scope changed."',
    'singularity-flow reopen PMC-1 --fetch --to custom-step --reason "A closed Story needs a fix."',
    `singularity-flow story intent-amendment propose --work-id PMC-1 --file "${draft}" --reason "Scope changed." --authored governed-agent --channel copilot-host --json`,
    'singularity-flow story rework roll-forward --work-id PMC-1 --change-request CR-001 --json',
    `singularity-flow story rework roll-forward --work-id PMC-1 --change-request CR-001 --confirm ${'a'.repeat(64)} --json`
  ]) assert.deepEqual(await shell(payload, command), {}, command);
  for (const command of [
    'singularity-flow reopen OTHER-1 --fetch --to custom-step --reason "x"',
    `singularity-flow story intent-amendment propose --work-id OTHER-1 --file "${draft}" --reason x`,
    `singularity-flow story intent-amendment propose --file "${draft}" --reason x`,
    'singularity-flow story intent-amendment decide FAM-001 --decision approve --confirm FAM-001 --work-id PMC-1',
    'singularity-flow story rework roll-forward --work-id OTHER-1 --change-request CR-001 --json',
    'singularity-flow submit custom-step --work-id PMC-1'
  ]) assert.equal((await shell(payload, command)).permissionDecision, 'deny', command);
  // The amendment draft is the one file this turn may write, and its rules name it.
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: draft } }), {});
  assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: path.join(f.root, 'amended-scope.md') } })).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny', 'no application edits');
  const record = JSON.parse(await readFile(path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries',
    `${createHash('sha256').update('reject-routes').digest('hex')}.mutation.json`), 'utf8'));
  assert.match(record.contract.summary, new RegExp(`issued file ${draft.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  // An approval turn gains none of it.
  const approve = await f.enter('/sf-approve', 'approve-routes');
  assert.equal((await shell(approve, 'singularity-flow reopen PMC-1 --fetch --to custom-step --reason "x"')).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard({ ...approve, toolName: 'edit', toolArgs: { path: draft } })).permissionDecision, 'deny');
});

test('no-Story setup skills run their own command families before a Story exists, and nothing else', async t => {
  const f = await fixture(t);
  const bare = async (skill, sessionId) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
    return payload;
  };
  const shell = (value, command) => mutationToolGuard({ ...value, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const start = await bare('/sf-story-start', 'story-start-bare');
  for (const command of ['singularity-flow jira assigned --type Story --json', 'singularity-flow jira pull PROJ-1 --json',
    'singularity-flow workspace branches --entry --intake --work-id PROJ-1 --for-agent --json',
    'singularity-flow story start PROJ-1 --fetch --from-branch main --readiness-baseline defer --test-execution-mode changed-and-affected --gate-mode hard',
    `singularity-flow story start PROJ-1 --fetch --selection-receipt ${SKILL_COMMAND_RECEIPT}`]) {
    assert.deepEqual(await shell(start, command), {}, command);
    assert.deepEqual(await mutationPostToolGuard({ ...start, toolName: 'bash', toolArgs: { command, cwd: f.root } }), {}, command);
  }
  for (const command of ['singularity-flow epic start EPIC-1 --selection-receipt ' + SKILL_COMMAND_RECEIPT, 'singularity-flow approve custom-step',
    'singularity-flow factory-reset --confirm "RESET" --json', 'git status --short']) {
    assert.equal((await shell(start, command)).permissionDecision, 'deny', command);
  }
  assert.equal((await mutationToolGuard({ ...start, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } })).permissionDecision, 'deny');
  const epic = await bare('/sf-epic-start', 'epic-start-bare');
  assert.deepEqual(await shell(epic, `singularity-flow epic start EPIC-1 --selection-receipt ${SKILL_COMMAND_RECEIPT}`), {});
  assert.equal((await shell(epic, 'singularity-flow story start PROJ-1 --fetch')).permissionDecision, 'deny');
  // A read skill before a Story still reads only.
  const status = await bare('/sf-epic-status', 'epic-status-bare');
  assert.deepEqual(await shell(status, 'singularity-flow epic status EPIC-1 --json'), {});
  assert.equal((await shell(status, 'singularity-flow epic sync EPIC-1 --json')).permissionDecision, 'deny');
});

test('/sf-continue executes an authorized planned action only when its own turn would run that action', async t => {
  const f = await fixture(t);
  const plans = path.join(gitDir(f.root), 'singularity-flow', 'action-plans');
  await mkdir(plans, { recursive: true });
  const action = 'a'.repeat(24);
  const plan = (id, argv, extra = {}) => writeFile(path.join(plans, `${id}.json`), JSON.stringify({ kind: 'governed-action-plan',
    actions: [{ actionId: action, executable: true, argv, ...extra }] }));
  const ids = Object.fromEntries(['sync', 'approve', 'risk', 'bind', 'nested', 'later', 'missing'].map((name, index) => [name, String(index + 1).repeat(24)]));
  await plan(ids.sync, ['sync']);
  await plan(ids.approve, ['approve', 'custom-step', '--work-id', 'PMC-1']);
  await plan(ids.risk, ['decision', 'test-risk', 'PMC-1', '--reason', 'x']);
  await plan(ids.bind, ['env', 'bind', 'qa', '--stdin']);
  await plan(ids.nested, ['action', 'execute', ids.sync, '--action', action]);
  await plan(ids.later, ['sync'], { executable: false });
  const execute = (id, token = SKILL_COMMAND_RECEIPT) => `singularity-flow action execute ${id} --action ${action.slice(0, 10)} --authorization ${token}`;
  const payload = await f.enter('/sf-continue', 'continue-execute');
  const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  // The token `action authorize` issued is a one-time receipt, not a credential: valid only on `action execute`, as a UUID.
  assert.ok(validateSflowExecutionCommand(execute(ids.sync)));
  assert.equal(validateSafeSflowCommand(execute(ids.sync)), null, 'never reusable display guidance');
  assert.deepEqual(await shell(execute(ids.sync)), {});
  assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: execute(ids.sync), cwd: f.root } }), {});
  assert.deepEqual(await shell(`singularity-flow action authorize ${ids.sync} --action ${action} --confirm ${action} --json`), {});
  // An approval, a person's own decision, an environment value, a nested plan, a later or missing action: refused, named.
  for (const id of [ids.approve, ids.risk, ids.bind, ids.nested, ids.later, ids.missing]) {
    const refusal = await shell(execute(id));
    assert.equal(refusal.permissionDecision, 'deny', id);
    assert.match(refusal.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: action execute runs its planned command/u, id);
  }
  for (const command of [execute(ids.sync, 'not-a-receipt'), `singularity-flow sync --authorization ${SKILL_COMMAND_RECEIPT}`,
    `${execute(ids.sync)} --authorization ${SKILL_COMMAND_RECEIPT}`]) {
    assert.equal((await shell(command)).permissionDecision, 'deny', command);
  }
  // A read turn runs no planned mutation at all.
  const read = await f.enter('/sf-nextsteps', 'continue-read');
  assert.equal((await mutationToolGuard({ ...read, toolName: 'bash', toolArgs: { command: execute(ids.sync), cwd: f.root } })).permissionDecision, 'deny');
});

test('a read turn answers through the four SFlow read tools, and sflow_run is refused in it', async t => {
  // Read skills (/sf-recommend, /sf-home, /sf-advise) call sflow_resolve and sflow_read when the host offers them.
  const f = await fixture(t);
  const tool = (payload, toolName, toolArgs = {}) => mutationToolGuard({ ...payload, toolName, toolArgs });
  for (const skill of ['/sf-recommend', '/sf-home', '/sf-advise', '/sf-status']) {
    const read = await f.enter(skill, `gateway-${skill.slice(4)}`);
    assert.equal(mutationTurnMode(skill), 'read', skill);
    // VS Code names the language-model tool; an MCP host may prefix its server name.
    for (const name of ['sflow_resolve', 'sflow_read', 'sflow_next', 'sflow_explain', 'singularity-flow-sflow_read', 'mcp__singularity-flow__sflow_next']) {
      assert.deepEqual(await tool(read, name, { utterance: 'what should I do next' }), {}, `${skill} ${name}`);
    }
    for (const name of ['sflow_run', 'singularity-flow-sflow_run', 'mcp__singularity-flow__sflow_run']) {
      const refused = await tool(read, name, { planId: 'pln_x' });
      assert.equal(refused.permissionDecision, 'deny', `${skill} ${name}`);
      assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: sflow_run carries out a plan, and this read-only turn carries out none/u);
      // The refusal names the reads and the skill's own CLI read: the turn keeps answering.
      assert.match(refused.permissionDecisionReason, /Answer with sflow_resolve, sflow_read, sflow_next or sflow_explain, or this skill's own CLI read/u);
    }
    // One sflow_run in a batch refuses the batch, as any refused call does.
    assert.equal((await mutationToolGuard({ ...read, toolName: undefined, toolArgs: undefined,
      toolCalls: [{ name: 'sflow_read', args: {} }, { name: 'sflow_run', args: {} }] })).permissionDecision, 'deny');
  }
  // A turn that may run kernel actions leaves sflow_run to the host's own confirmation dialog.
  const kernel = await f.enter('/sf-next', 'gateway-next');
  assert.equal(mutationTurnMode('/sf-next'), 'kernel-only');
  assert.deepEqual(await tool(kernel, 'sflow_run', { planId: 'pln_x' }), {});
  assert.deepEqual(await tool(kernel, 'sflow_resolve', { utterance: 'home' }), {});
  // Outside an explicit SFlow turn nothing is recorded, so the guard has nothing to say.
  assert.deepEqual(await tool({ cwd: f.root, sessionId: 'native-chat' }, 'sflow_run', { planId: 'pln_x' }), {});
});

test('Epic, Initiative and repair drafting turns edit exactly the files their SFlow commands issued, with or without a Story', async t => {
  const f = await fixture(t);
  const bare = async (skill, sessionId) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    const context = await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
    return { payload, context };
  };
  const edit = (payload, target, cwd = f.root) => mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: target, cwd } });
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const outputs = path.join(f.root, 'singularity', 'initiatives', 'EPIC-1', 'artifacts', 'epic-planning');
  await mkdir(outputs, { recursive: true });
  const plan = path.join(outputs, 'story-plan.yml');
  const parent = path.join(outputs, 'parent-spec.md');
  await writeFile(plan, 'version: 1\n'); await writeFile(parent, '# Parent\n');
  const { payload: draft, context } = await bare('/sf-epic-story-draft', 'epic-draft');
  const status = (await bare('/sf-epic-status', 'epic-status')).payload;
  const sync = (await bare('/sf-epic-sync', 'epic-sync')).payload;
  // Before its command issues anything, the turn may write only the source-text draft its rules name.
  const sourceText = epicSourceTextDraftPath(gitDir(f.root));
  assert.ok(context.additionalContext.includes(sourceText), context.additionalContext);
  assert.match(context.additionalContext, /no Story\. Edit only the exact files this turn's SFlow commands issue/u);
  assert.deepEqual(await edit(draft, sourceText), {});
  const before = await edit(draft, plan);
  assert.equal(before.permissionDecision, 'deny');
  assert.match(before.permissionDecisionReason, /^DRAFT_PATH_DENIED: .*initiative phase draft-check <PHASE> --json/u);
  // `initiative phase` prepare or draft-check issue the step's authored outputs to the live drafting turns only.
  assert.equal(await issueDraftStaging('initiative', [plan, parent], { root: f.root }), 1);
  assert.deepEqual(await edit(draft, plan), {});
  assert.deepEqual(await edit(draft, path.relative(f.root, parent)), {}, 'a path relative to the bound checkout is the same file');
  for (const target of [path.join(outputs, 'other.yml'), path.join(outputs, 'stories', 'STORY-001', 'story-spec.md'), 'src/App.jsx',
    path.join(f.root, 'singularity', 'initiatives', 'EPIC-1', 'initiative.json')]) {
    const refusal = await edit(draft, target);
    assert.equal(refusal.permissionDecision, 'deny', target);
    assert.match(refusal.permissionDecisionReason, /^DRAFT_PATH_DENIED/u, target);
  }
  for (const payload of [status, sync]) {
    assert.equal((await edit(payload, plan)).permissionDecision, 'deny');
    assert.equal((await edit(payload, sourceText)).permissionDecision, 'deny');
  }
  // In a batch, the issued edit passes and every other call is judged as it is alone.
  const batch = calls => mutationToolGuard({ ...draft, toolCalls: calls });
  assert.deepEqual(await batch([{ name: 'edit', args: { path: plan } }, { name: 'bash', args: { command: 'singularity-flow epic planning publish', cwd: f.root } }]), {});
  assert.equal((await batch([{ name: 'edit', args: { path: plan } }, { name: 'bash', args: { command: 'git status --short', cwd: f.root } }])).permissionDecision, 'deny');
  assert.equal((await batch([{ name: 'edit', args: { path: plan } }, { name: 'edit', args: { path: 'src/App.jsx' } }])).permissionDecision, 'deny');
  // A Story-bound drafting turn receives the same exact grant and nothing else.
  const bound = await f.enter('/sf-initiative-phase', 'initiative-bound');
  assert.equal(await issueDraftStaging('initiative', [plan], { root: f.root }), 2);
  assert.deepEqual(await edit(bound, plan), {});
  assert.equal((await edit(bound, 'src/App.jsx')).permissionDecision, 'deny');
  assert.equal((await edit(bound, sourceText)).permissionDecision, 'deny', '/sf-initiative-phase records no Epic source text');
  // A repair's patch file: only /sf-fix turns, issued by `repair authorize|status`; its own commands need no Story.
  const fix = (await bare('/sf-fix', 'fix-bare')).payload;
  const patch = path.join(gitDir(f.root), 'singularity-flow', 'fault-repair', 'patch-drafts', 'RPR-1.patch');
  assert.match((await edit(fix, patch)).permissionDecisionReason, /^DRAFT_PATH_DENIED: .*repair status <REPAIR-ID> --json/u);
  assert.equal(await issueDraftStaging('repair', [patch], { root: f.root }), 1);
  assert.deepEqual(await edit(fix, patch), {});
  assert.equal((await edit(draft, patch)).permissionDecision, 'deny');
  for (const command of ['singularity-flow fault show FLT-1 --json', 'singularity-flow fix FLT-1 --diagnose-only --json',
    `singularity-flow repair attempt RPR-1 --patch ${patch} --json`]) assert.deepEqual(await shell(fix, command), {}, command);
  assert.equal((await shell(fix, 'singularity-flow sync')).permissionDecision, 'deny');
  // A paused Copilot issues nothing.
  await setCopilotPaused(true);
  assert.equal(await issueDraftStaging('initiative', [plan], { root: f.root }), 0);
});

test('guided run, documentation of changed code and the reinstall preview get the turn their skills need; hooks stay the host\'s', async t => {
  const f = await fixture(t);
  assert.equal(mutationTurnMode('/sf-code-docs'), 'authoring');
  assert.equal(mutationTurnMode('/sf-run'), 'authoring');
  assert.equal(mutationTurnMode('/sf-reinstall'), 'kernel-only');
  assert.equal(mutationTurnMode('/sf-hook'), 'read');
  const run = await f.enter('/sf-run', 'guided-run');
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  for (const command of ['singularity-flow run', 'singularity-flow run --yes']) assert.deepEqual(await shell(run, command), {}, command);
  // `run --repair-on-fault` runs the command it wraps unchecked, and a hook records host decisions: no turn runs either.
  for (const skill of ['/sf-run', '/sf-next', '/sf-phase', '/sf-hook']) {
    const payload = await f.enter(skill, `host-only-${skill}`);
    assert.equal((await shell(payload, 'singularity-flow run --repair-on-fault -- npm test')).permissionDecision, 'deny', skill);
    for (const command of ['singularity-flow hook turn-intent', 'singularity-flow hook agent-guard']) {
      const refusal = await shell(payload, command);
      assert.equal(refusal.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(refusal.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: a lifecycle hook records the host's own decisions/u, `${skill}: ${command}`);
    }
    // The gateway server carries out plans a person confirms in their host's own UI; started from a
    // turn, the agent would claim that UI and answer the confirmation itself. No turn starts it.
    for (const command of ['singularity-flow gateway serve', 'sflow gateway serve --transport stdio', 'singularity-flow gateway serve --transport=stdio']) {
      const refusal = await shell(payload, command);
      assert.equal(refusal.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(refusal.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: the gateway server carries out plans/u, `${skill}: ${command}`);
    }
    assert.deepEqual(await shell(payload, 'singularity-flow gateway tools --json'), {}, `${skill}: gateway tools`);
    // Showing or resetting conversational context changes no work, plan, workspace selection or
    // lifecycle record, so any turn may `[INT:REQ-101]`; switching the selected workspace stays the person's.
    for (const command of ['singularity-flow gateway session --json', 'singularity-flow gateway session reset']) {
      assert.deepEqual(await shell(payload, command), {}, `${skill}: ${command}`);
    }
  }
  const reinstall = { cwd: f.root, sessionId: 'reinstall-bare', prompt: '/sf-reinstall' };
  await recordRepositoryBoundaryTurn(reinstall, { captureMutation: (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
  for (const command of ['singularity-flow reinstall --checkout /tmp/source --dry-run',
    'singularity-flow reinstall --checkout /tmp/source --confirm "REINSTALL abc"']) assert.deepEqual(await shell(reinstall, command), {}, command);
  for (const command of ['sf-reinstall --checkout /tmp/source --dry-run', 'singularity-flow factory-reset --confirm RESET']) {
    assert.equal((await shell(reinstall, command)).permissionDecision, 'deny', command);
  }
  // Before any Story is bound too: a kernel-only turn with no contract never starts the gateway server.
  const unbound = await shell(reinstall, 'singularity-flow gateway serve --transport stdio');
  assert.equal(unbound.permissionDecision, 'deny');
  assert.match(unbound.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: the gateway server carries out plans/u);
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
  assert.equal(mutationTurnMode('sf-spec-author'), 'spec-studio');
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
      'ls ../team', 'singularity-flow workflow import-team compile --session tis-1 --out a.json && rm -rf src']) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /IMPORT_TEAM_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    // A person's own step is refused for what it is, with their exact command, not this turn's generic sentence.
    for (const [command, person] of [['singularity-flow approve custom-step --yes', 'singularity-flow approve custom-step']]) {
      const refused = await shell(command);
      assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: /u, `${label}: ${command}`);
      assert.equal(refused.next[0].command, person, `${label}: ${command}`);
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
      'ls ../team', 'singularity-flow workflow build finish --build wb_0123456789abcdef --propose && rm -rf src']) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /BUILD_WORKFLOW_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    // A person's own step is refused for what it is, with their exact command, not this turn's generic sentence.
    for (const [command, person] of [['singularity-flow approve custom-step --yes', 'singularity-flow approve custom-step']]) {
      const refused = await shell(command);
      assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: /u, `${label}: ${command}`);
      assert.equal(refused.next[0].command, person, `${label}: ${command}`);
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
    assert.match((await shell(propose)).permissionDecisionReason ?? '', /FIX_WORKFLOW_DRAFT_NOT_ISSUED: .*workflow validate --json/u, `${label}: nothing is issued yet`);
    assert.match((await edit(draft)).permissionDecisionReason, /no change set draft is issued/u, label);
    assert.equal(await issueFixWorkflowStaging(draft, { root: f.root }), 1, label);
    assert.deepEqual(await edit(draft), {}, label);
    assert.deepEqual(await shell(propose), {}, `${label}: the issued draft can be proposed`);
    assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: propose } }), {});
    for (const command of [`singularity-flow workflow studio apply --change-set ${draft}`, `singularity-flow workflow studio apply --change-set ${draft}.other --propose`,
      'singularity-flow workflow studio apply --change-set - --propose', `${propose} && rm -rf src`]) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /FIX_WORKFLOW_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    // A person's own step is refused for what it is, with their exact command, not this turn's generic sentence.
    for (const [command, person] of [['singularity-flow approve custom-step --yes', 'singularity-flow approve custom-step'], ['singularity-flow configuration approve sflow/config-change/x --yes', 'singularity-flow configuration approve sflow/config-change/x --yes']]) {
      const refused = await shell(command);
      assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: /u, `${label}: ${command}`);
      assert.equal(refused.next[0].command, person, `${label}: ${command}`);
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

test('a spec-author turn reads, collects research, edits only the issued proposal file and stages only it; the person takes each proposal (SPA:AC-006, AC-022)', async t => {
  const f = await fixture(t);
  const enter = async (skill, sessionId, load, now = Date.now()) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load }) });
    return payload;
  };
  const noStory = async () => { throw new Error('No Story yet'); };
  for (const [label, load] of [['without a Story', noStory], ['with a bound Story', async () => f.accepted]]) {
    const payload = await enter('/sf-spec-author', `spec-${label}`, load);
    const shell = command => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } });
    const edit = target => mutationToolGuard({ ...payload, toolName: 'create_file', toolArgs: { filePath: target } });
    const file = path.join(path.dirname(f.root), 'state', 'spec-proposals', `r-${label.length}`, 'SPEC-CHK-004.proposal.json');
    const propose = `singularity-flow spec author propose SPEC-CHK-004 --file ${file} --json`;
    for (const command of ['singularity-flow spec author status SPEC-CHK-004 --json', 'singularity-flow spec author list --json',
      'singularity-flow spec author gaps SPEC-CHK-004 GAP-001 --json', 'singularity-flow spec author check SPEC-CHK-004 --json',
      'singularity-flow spec author research SPEC-CHK-004 --path src/pricing.mjs --json', 'singularity-flow spec author research SPEC-CHK-004 --symbol orderDiscount']) {
      assert.deepEqual(await shell(command), {}, `${label}: ${command}`);
      assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } }), {}, `${label} after: ${command}`);
    }
    assert.match((await shell(propose)).permissionDecisionReason ?? '', /SPEC_STUDIO_PROPOSAL_NOT_ISSUED: .*spec author status <SPEC-ID> --json/u, `${label}: nothing is issued yet`);
    assert.match((await edit(file)).permissionDecisionReason, /no proposal file is issued/u, label);
    assert.equal(await issueSpecStudioStaging(file, { root: f.root }), 1, label);
    assert.deepEqual(await edit(file), {}, label);
    assert.deepEqual(await shell(propose), {}, `${label}: the issued file can be staged`);
    assert.deepEqual(await mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: propose } }), {});
    for (const command of [`singularity-flow spec author propose SPEC-CHK-004 --file ${file}.other`,
      'singularity-flow spec author edit SPEC-CHK-004 --file x.md --expected-seq 1', 'singularity-flow spec author research SPEC-CHK-004 --fact F --source Me',
      `${propose} && rm -rf src`]) {
      assert.match((await shell(command)).permissionDecisionReason ?? '', /SPEC_STUDIO_OPERATION_NOT_ALLOWED/u, `${label}: ${command}`);
    }
    // The person's own steps are refused for what they are, with the person's exact command, IDs and all
    // (a generic sentence and no route left the person to work the command out, S4 live run 2026-11-01).
    for (const command of ['singularity-flow spec author accept SPEC-CHK-004 P-001', 'singularity-flow spec author reject SPEC-CHK-004 P-001 --reason No.',
      'singularity-flow spec author decide SPEC-CHK-004 GAP-001 --option O1 --reason Agreed.',
      'singularity-flow spec author settle SPEC-CHK-004 --finding A-001=dismissed --reason No.', 'singularity-flow spec author publish SPEC-CHK-004 --reviewed']) {
      const refused = await shell(command);
      assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: taking or turning down Copilot's proposals/u, `${label}: ${command}`);
      assert.deepEqual(refused.next.map(route => [route.command, route.copilotCommand]), [[command, null]], `${label}: ${command}`);
      assert.match(refused.permissionDecisionReason, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `${label}: ${command}`);
    }
    assert.match((await edit(path.join(f.root, 'docs', 'spec.md'))).permissionDecisionReason, /SPEC_STUDIO_PATH_DENIED.*SPEC-CHK-004\.proposal\.json/u);
    assert.match((await mutationToolGuard({ ...payload, toolName: 'task', toolArgs: { prompt: 'draft it' } })).permissionDecisionReason, /SPEC_STUDIO_DELEGATION/u);
    await endRepositoryBoundaryTurn(payload);
  }
  // Taking a proposal is the person's own step in every other turn too.
  const kernel = await f.enter('/sf-next', 'spec-kernel');
  assert.equal((await mutationToolGuard({ ...kernel, toolName: 'bash', toolArgs: { command: 'singularity-flow spec author accept SPEC-CHK-004 P-001' } })).permissionDecision, 'deny');
  // A build-workflow turn never receives a proposal file.
  const building = await enter('/sf-build-workflow', 'spec-build-turn', noStory);
  const late = path.join(path.dirname(f.root), 'state', 'spec-proposals', 'late', 'SPEC-X.proposal.json');
  assert.equal(await issueSpecStudioStaging(late, { root: f.root }), 0);
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
  // Expiry says so and names the turn's own skill: no shell command renews a Copilot turn.
  assert.match(receiptRefusal.permissionDecisionReason, /^PHASE_MUTATION_TURN_EXPIRED: .*Invoke \/sf-approve again/u);
  assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --for-agent --json' } }), {});
  const refusal = await mutationToolGuard(payload);
  assert.match(refusal.permissionDecisionReason, /^PHASE_MUTATION_TURN_EXPIRED: [^\n]*\n\n- Copilot: \/sf-approve\n- Shell: not available for this action\n- VS Code \(model-free\): not available for this action$/u);
  assert.deepEqual(refusal.next, []);
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

test('a /sf-submit command scoped to the checkout runs, and a refused tool form names its fix, not a lifecycle route', async t => {
  // fact-01, 2026-10-26: `env -C <story worktree> singularity-flow status … --submit-if-ready` was refused,
  // and the refusal sent the turn to /sf-recover although nothing needed recovering.
  const f = await fixture(t, { id: 'planning', generation: 2, status: 'in_progress' });
  const payload = await f.enter('/sf-submit', 'submit-scoped');
  const shell = command => ({ ...payload, toolName: 'bash', toolArgs: { command } });
  const readiness = 'singularity-flow status PMC-1 --submission-readiness --for-agent --json --submit-if-ready';
  assert.deepEqual(await mutationToolGuard(shell(`env -C ${f.root} ${readiness}`)), {});
  assert.deepEqual(await mutationToolGuard(shell(`cd '${f.root}' && ${readiness}`)), {});
  const refused = await mutationToolGuard(shell(`env -C ${path.dirname(f.root)} ${readiness}`));
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /PHASE_MUTATION_TOOL_PROTOCOL/);
  assert.ok(refused.permissionDecisionReason.includes(`(${f.root}) with \`cd <it> && …\` or \`env -C <it> …\``));
  assert.match(refused.permissionDecisionReason, /from a non-Git folder such as a chat folder it runs as is \(SFlow finds the bound checkout\)/);
  assert.doesNotMatch(refused.permissionDecisionReason, /\/sf-recover|Copilot: \/sf-|phase enter/);
  assert.deepEqual(refused.next, []);
});

test('a failed decision locks only approval operations, never granting authoring or raw-shell permission', async t => {
  const f = await fixture(t); const payload = await f.enter('/sf-approve');
  const shell = command => ({ ...payload, toolName: 'bash', toolArgs: { command } });
  assert.deepEqual(await mutationToolGuard(shell('singularity-flow approve custom-step --work-id PMC-1 --for-agent --json')), {});
  assert.deepEqual(await mutationToolGuard(shell(`cd '${f.root}' && 'singularity-flow' 'approve' 'custom-step' '--work-id' 'PMC-1' '--for-agent' '--json'`)), {});
  assert.equal((await mutationToolGuard(shell(`cd '${path.dirname(f.root)}' && singularity-flow approve custom-step --work-id PMC-1`))).permissionDecision, 'deny');
  assert.equal((await mutationToolGuard(shell(`cd '${f.root}' && singularity-flow approve custom-step --work-id PMC-1 && npm test`))).permissionDecision, 'deny');
  // A shell that cannot set its cwd (a VS Code agent-host chat) scopes the command with `env -C`, to
  // exactly the bound checkout like `cd <root> &&` (2026-10-26).
  assert.deepEqual(await mutationToolGuard(shell(`env -C ${f.root} singularity-flow approve custom-step --work-id PMC-1 --for-agent --json`)), {});
  assert.deepEqual(await mutationToolGuard(shell(`env --chdir='${f.root}' singularity-flow approve custom-step --work-id PMC-1 --for-agent --json`)), {});
  for (const command of [`env -C ${path.dirname(f.root)} singularity-flow approve custom-step --work-id PMC-1`,
    `env -C ${f.root} FOO=1 singularity-flow approve custom-step --work-id PMC-1`, `env -C ${f.root} npm test`]) {
    const refused = await mutationToolGuard(shell(command));
    assert.equal(refused.permissionDecision, 'deny', command);
  }
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

test('an overlapping contract refresh cannot revoke a just-issued clarification staging path', async t => {
  const f = await fixture(t);
  for (const [skill, purpose] of [['/sf-phase', 'clarification'], ['/sf-review-source', 'source-review']]) {
    const payload = await f.enter(skill);
    for (let attempt = 0; attempt < 8; attempt++) {
      const staging = path.join(gitDir(f.root), 'singularity-flow', purpose, `custom-step-gen1-${attempt}.json`);
      await Promise.all([refreshMutationContracts(f.root, f.accepted, { advanceBaseline: true }),
        issueMutationStaging(f.root, staging, purpose)]);
      assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'create', toolArgs: { path: staging } }), {},
        'background bookkeeping must not overwrite an exact file grant');
      assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: staging + '.other' } })).permissionDecision, 'deny');
      assert.equal((await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } })).permissionDecision, 'deny');
    }
  }
});

test('staging receipts cannot cross a generation, phase, mode or turn boundary', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-phase');
  const staging = path.join(gitDir(f.root), 'singularity-flow', 'clarification-responses', 'custom-step-gen1.json');
  await issueMutationStaging(f.root, staging, 'clarification');
  const edit = () => mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: staging } });
  assert.deepEqual(await edit(), {});
  f.phase.generation = 1;
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await refreshMutationContracts(f.root, f.accepted);
  assert.equal((await edit()).permissionDecision, 'deny', 'previous generation grant is not recovered');
  f.workflow.currentPhase = 'next-phase';
  f.workflow.phases['next-phase'] = { ...f.phase, id: 'next-phase' };
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await refreshMutationContracts(f.root, f.accepted);
  assert.equal((await edit()).permissionDecision, 'deny', 'phase changes never carry a grant');
  const otherTurn = await f.enter('/sf-approve');
  assert.equal((await mutationToolGuard({ ...otherTurn, toolName: 'edit', toolArgs: { path: staging } })).permissionDecision, 'deny');
  const newAuthor = await f.enter('/sf-phase');
  assert.equal((await mutationToolGuard({ ...newAuthor, toolName: 'edit', toolArgs: { path: staging } })).permissionDecision, 'deny',
    'a new turn must obtain its own issuer receipt');
});

test('fallback staging requires an intact issuer receipt with every live binding unchanged', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-phase');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const cache = path.join(path.dirname(process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries',
    `${hash(payload.sessionId)}.mutation.json`);
  const before = await readFile(cache, 'utf8');
  const suffix = path.join('singularity-flow', 'clarification-responses', 'custom-step-gen1.json');
  const staging = path.join(gitDir(f.root), suffix);
  await issueMutationStaging(f.root, staging, 'clarification');
  await writeFile(cache, before); // Deterministic model of the overlapping stale contract writer.
  const receiptFile = path.join(`${cache}.issued`, hash(JSON.parse(before).turnId), `${hash(`staging:${suffix}`)}.json`);
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  const edit = () => mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: staging } });
  assert.deepEqual(await edit(), {});
  for (const field of ['root', 'turnId', 'workId', 'phaseId', 'generation', 'mode', 'kind']) {
    const { integritySha256, ...changed } = { ...receipt, [field]: field === 'generation' ? 99 : 'different' };
    await writeFile(receiptFile, JSON.stringify({ ...changed, integritySha256: hash(JSON.stringify(changed)) }));
    assert.equal((await edit()).permissionDecision, 'deny', field);
  }
  await writeFile(receiptFile, JSON.stringify({ ...receipt, integritySha256: '0'.repeat(64) }));
  assert.equal((await edit()).permissionDecision, 'deny', 'corrupt integrity never grants access');
  await writeFile(receiptFile, JSON.stringify(receipt));
  assert.deepEqual(await edit(), {});
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
  for (const command of ['singularity-flow status --json && singularity-flow phase publish custom-step --authored governed-agent --channel copilot-host',
    'bash -c "singularity-flow phase publish custom-step --authored governed-agent --channel copilot-host"', 'singularity-flow clarification record custom-step --answer "$(touch src/App.jsx)"',
    'singularity-flow phase publish custom-step --authored governed-agent --channel copilot-host > output.json']) {
    const refused = await mutationToolGuard(shell(command));
    assert.equal(refused.permissionDecision, 'deny');
    assert.match(refused.permissionDecisionReason, /PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED/);
    assert.doesNotMatch(refused.permissionDecisionReason, /PHASE_MUTATION_TURN_READ_ONLY/);
  }
  // A person's own step behind a wrapper is read through it: refused for what it is, with its exact command.
  const wrapped = await mutationToolGuard(shell('bash -c "singularity-flow approve custom-step"'));
  assert.match(wrapped.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: approving a step/u);
  assert.equal(wrapped.next[0].command, 'singularity-flow approve custom-step');
});

test('the launcher\'s verified Node and CLI entry, quoted for the shell, meet every guard check as the CLI; no other form does', async t => {
  const f = await fixture(t);
  // What a host started outside a login shell gets named when `singularity-flow` is off PATH
  // (setHookCli in src/copilot-mode.mjs). Paths with spaces, as under Program Files.
  const node = path.join(path.dirname(f.root), 'Node runtime', 'bin', 'node');
  const entry = path.join(path.dirname(f.root), 'npm prefix', 'lib', 'node_modules', 'singularity-flow', 'bin', 'singularity-flow.mjs');
  const posix = renderPlatformCommand([node, entry], 'linux'), powershell = renderPlatformCommand([node, entry], 'win32');
  setHookCli({ node, cli: entry, onPath: false });
  t.after(() => setHookCli(null));
  const shell = (payload, command, toolName = 'bash') => mutationToolGuard({ ...payload, toolName, toolArgs: { command } });
  const after = (payload, command) => mutationPostToolGuard({ ...payload, toolName: 'bash', toolArgs: { command } });
  // The session turn bound to a Story (the 2026-10-25 chat-folder shape): its rules, then the one line.
  const context = (await recordRepositoryBoundaryTurn({ cwd: f.root, sessionId: 'verified-cli-context', prompt: '/sf-session' },
    { captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => f.root, load: async () => f.accepted }) })).additionalContext;
  assert.match(context, /^SFlow turn boundary \(sf-session\): session-only turn, PMC-1 step custom-step/u);
  assert.ok(context.includes('with cwd=repositoryPath, or as is from a non-Git folder such as a chat folder (SFlow finds the bound checkout; `cd <it> && …` or `env -C <it> …` also sets it); no pipes'), context);
  assert.ok(context.endsWith(` Turn rules ${context.match(/Turn rules (sha256:[a-f0-9]{16})/u)[1]}. ${hookCliLine()}`), context);
  f.workflow.resolution.obligationGraph = { nodes: [{ id: 'custom-step', responsibilities: ['scope'] }] };
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  const report = `--report-json '${JSON.stringify({ rows: [], detail: 'x'.repeat(4000) })}' --json`;
  // Turn modes, read lists, host-only commands, decisions, `cd <root> &&` scoping and the long staging form.
  const rests = ['session open PMC-1 --for-agent --json', 'status --json', 'approve custom-step', 'hook boundary-turn',
    'phase publish custom-step --authored governed-agent --channel copilot-host', 'decision test-risk custom-step --work-id PMC-1', `review-source stage custom-step ${report}`];
  for (const skill of ['/sf-session', '/sf-status', '/sf-phase', '/sf-approve', '/sf-review-source']) {
    const payload = await f.enter(skill, `verified-cli${skill.replace('/', '-')}`);
    for (const rest of rests) {
      const bare = await shell(payload, `singularity-flow ${rest}`);
      assert.deepEqual(await shell(payload, `${posix} ${rest}`), bare, `${skill}: ${rest}`);
      assert.deepEqual(await shell(payload, `cd '${f.root}' && ${posix} ${rest}`), await shell(payload, `cd '${f.root}' && singularity-flow ${rest}`), `${skill}: cd ${rest}`);
      assert.deepEqual(await shell(payload, `${powershell} ${rest}`, 'powershell'), await shell(payload, `& singularity-flow ${rest}`, 'powershell'), `${skill}: ${rest}`);
    }
  }
  assert.deepEqual(await shell(await f.enter('/sf-review-source', 'stage'), `${posix} review-source stage custom-step ${report}`), {});
  const session = await f.enter('/sf-session', 'verified-cli-only');
  assert.deepEqual(await shell(session, `${posix} session open PMC-1 --for-agent --json`), {});
  assert.deepEqual(await after(session, `${posix} session open PMC-1 --for-agent --json`), {}, 'nothing to detect after an admitted command');
  // Exactly that pair, quoted for its shell: another Node or entry, `node <entry>`, a wrapper or a chain is not the CLI.
  for (const command of [`'${node}' '/opt/other/singularity-flow.mjs' session open PMC-1 --for-agent --json`,
    `'/opt/other/node' '${entry}' session open PMC-1 --for-agent --json`, `node '${entry}' session open PMC-1 --for-agent --json`,
    `"${node}" "${entry}" session open PMC-1 --for-agent --json`, `bash -c "${posix} session open PMC-1"`,
    `${posix} session open PMC-1 --for-agent --json && echo done`, `cd /tmp && ${posix} session open PMC-1 --for-agent --json`]) {
    assert.equal((await shell(session, command)).permissionDecision, 'deny', command);
  }
  assert.equal((await shell(session, `${posix} session open PMC-1 --for-agent --json`, 'powershell')).permissionDecision, 'deny',
    'PowerShell runs it only with its call operator');
  assert.match((await after(session, `'/opt/other/node' '${entry}' session open PMC-1 --for-agent --json`)).additionalContext ?? '',
    /PHASE_MUTATION_BASELINE_UNAVAILABLE/u);
  // In an authoring turn the pair inside a chain is still the kernel, never an ordinary shell command.
  const authoring = await f.enter('/sf-phase', 'verified-cli-chain');
  assert.match((await shell(authoring, `echo start && ${posix} phase publish custom-step --authored governed-agent --channel copilot-host`)).permissionDecisionReason, /PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED/u);
  // A person's own step through it is read as the CLI too, and refused for what it is.
  assert.equal((await shell(authoring, `echo start && ${posix} approve custom-step`)).next[0].command, 'singularity-flow approve custom-step');
  // Before a Story is bound: a setup skill's own family and a session attach, as with the bare CLI.
  const setup = async skill => {
    const payload = { cwd: f.root, sessionId: `verified-cli-setup-${skill}`, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
    return payload;
  };
  const workflows = await setup('/sf-workflows');
  assert.deepEqual(await shell(workflows, `${posix} workflow create custom --json`), {});
  assert.deepEqual(await after(workflows, `${posix} workflow create custom --json`), {});
  assert.deepEqual(await shell(await setup('/sf-session'), `${posix} session attach PMC-1 --json`), {});
  // With no launcher pair (a terminal run, an older plugin) the absolute form is an unverified command as before.
  setHookCli(null);
  assert.equal((await shell(session, `${posix} session open PMC-1 --for-agent --json`)).permissionDecision, 'deny');
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

// Copilot 1.0.100 shows about 8 KB per file read: a longer read came back cut ("Output truncated") or
// refused ("File too large to read at once"), and agents read it again in slices or gave up. Any file a
// turn reads counts, including the artifacts a custom workflow defines, not only what SFlow names.
test('a file read longer than one view is turned back with the exact ranges to request together', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-phase');
  const write = async (relative, content) => {
    await mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
    await writeFile(path.join(f.root, relative), content);
    return relative;
  };
  const rows = Array.from({ length: 400 }, (_, index) => `  - id: RISK-${index}\n    note: owner, likelihood and the check that proves it`);
  const custom = await write('team/outputs/risk-register.yaml', `risks:\n${rows.join('\n')}\n`);
  const view = args => mutationToolGuard({ ...payload, toolName: 'view', toolArgs: args });
  const whole = await view({ path: custom });
  assert.equal(whole.permissionDecision, 'deny');
  assert.match(whole.permissionDecisionReason, /^FILE_READ_TOO_LONG: .*Nothing was read\. Request these view_range values together in one response: \[1, \d+\], /u);
  const lines = (await readFile(path.join(f.root, custom), 'utf8')).split('\n');
  const [{ ranges }] = whole.readRanges;
  assert.equal(ranges[0][0], 1);
  assert.equal(ranges.at(-1)[1], lines.length - 1, 'the ranges cover the whole file');
  for (const [start, end] of ranges) {
    assert.ok(Buffer.byteLength(lines.slice(start - 1, end).join('\n')) <= 7_000, `${start}-${end}`);
    assert.deepEqual(await view({ path: custom, view_range: [start, end] }), {}, 'each named range passes');
  }
  // A range too long for one read is split the same way, from where it starts.
  const ranged = await view({ path: custom, view_range: [301, -1] });
  assert.equal(ranged.readRanges[0].ranges[0][0], 301);
  // Short files (up to what one read shows), images and a single line no range can split read as before.
  assert.deepEqual(await view({ path: await write('team/outputs/short.md', '# Short\n') }), {});
  assert.deepEqual(await view({ path: await write('team/outputs/just-fits.md', `${'- a line of notes for the step\n'.repeat(240)}`) }), {}, '7.4 KB fits one read');
  assert.deepEqual(await view({ path: await write('team/outputs/shot.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.alloc(9_000, 1)])) }), {});
  assert.deepEqual(await view({ path: await write('team/outputs/one-line.json', JSON.stringify({ rows })) }), {});
  assert.deepEqual(await view({ path: 'team/outputs/missing.md' }), {});
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

// SPEC-STAGING-PERMISSIONS: a step's own staging file outlives the turn that printed it.
const addFile = (target, body = '{"responses":[]}') => `*** Begin Patch\n*** Add File: ${target}\n+${body}\n*** End Patch\n`;
const asPatch = (payload, target) => ({ ...payload, toolName: 'apply_patch', toolArgs: addFile(target) });

test('a step\'s clarification staging file is writable in every turn bound to it, after an interrupted turn and in a new chat', async t => {
  const f = await fixture(t, { clarification: { mode: 'required' } });
  const staging = clarificationStagingPath(gitDir(f.root), f.workflow, f.phase);
  // Turn 1 enters the step (phase enter issues the file) and is interrupted before writing it.
  await f.enter('/sf-phase');
  await issueMutationStaging(f.root, staging, 'clarification');
  // Turn 2 reuses the earlier entry without entering again: the incident. It may write the file.
  const second = await f.enter('/sf-phase');
  await stat(path.dirname(staging));
  for (const payload of [
    asPatch(second, staging),
    { ...second, toolName: 'create', toolArgs: { path: staging, file_text: '{"responses":[]}' } },
    { ...second, toolName: 'edit', toolArgs: { path: pathToFileURL(staging).href, old_str: 'a', new_str: 'b' } },
    { ...second, toolName: undefined, toolArgs: undefined, toolCalls: [{ name: 'apply_patch', args: addFile(staging) }] }
  ]) assert.deepEqual(await mutationToolGuard(payload), {}, JSON.stringify(payload.toolArgs ?? payload.toolCalls).slice(0, 80));
  // A new chat on the same Story and step, which never ran phase enter.
  assert.deepEqual(await mutationToolGuard(asPatch(await f.enter('/sf-phase', 'new-chat'), staging)), {});
  // The grant is that one file: the checkout's application and artifact rules are unchanged.
  assert.equal((await mutationToolGuard(second)).permissionDecision, 'deny');
});

test('other generations, checkouts and turn modes are refused with the command that issues the file', async t => {
  const f = await fixture(t, { clarification: { mode: 'required' } });
  const staging = clarificationStagingPath(gitDir(f.root), f.workflow, f.phase);
  const authoring = await f.enter('/sf-phase');

  const otherGeneration = path.join(path.dirname(staging), 'custom-step-gen99.json');
  const mismatch = await mutationToolGuard(asPatch(authoring, otherGeneration));
  assert.match(mismatch.permissionDecisionReason, /^PHASE_MUTATION_STAGING_PATH_MISMATCH: write the step author's clarification-response staging file at exactly /u);
  assert.ok(mismatch.permissionDecisionReason.includes(staging));
  assert.deepEqual(mismatch.pathCorrections, [{ attemptedPath: otherGeneration, issuedPath: staging, operation: 'write' }]);
  await assert.rejects(stat(otherGeneration), { code: 'ENOENT' });

  const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-other-checkout-')));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const foreignDirectory = path.join(elsewhere, '.git', 'singularity-flow', 'clarification-responses');
  // The same file name in another checkout: the existing correction names this checkout's file.
  const sameName = await mutationToolGuard(asPatch(authoring, path.join(foreignDirectory, path.basename(staging))));
  assert.match(sameName.permissionDecisionReason, /^PHASE_MUTATION_STAGING_PATH_MISMATCH: write the issued staging file at exactly /u);
  assert.equal(sameName.pathCorrections[0].issuedPath, staging);
  // Another checkout's own file: refused as not this turn's, with the binding route.
  const foreign = await mutationToolGuard(asPatch(authoring, path.join(foreignDirectory, 'other-step-gen1.json')));
  assert.match(foreign.permissionDecisionReason, /^PHASE_MUTATION_STAGING_NOT_ISSUED: .* belongs to another checkout's Git directory/u);
  assert.deepEqual(foreign.next[0].argv, ['session', 'current', '--for-agent', '--json']);

  const reviewFile = sourceReviewStagingPath(gitDir(f.root), f.workflow, f.phase);
  const reviewInAuthoring = await mutationToolGuard(asPatch(authoring, reviewFile));
  assert.match(reviewInAuthoring.permissionDecisionReason, /^PHASE_MUTATION_STAGING_NOT_ISSUED: .*the source reviewer's report staging file, issued only in a read-only-review turn by singularity-flow review-source context --for-agent --json \(\/sf-review-source\)/u);
  assert.equal(reviewInAuthoring.next[0].skill, '/sf-review-source');

  for (const skill of ['/sf-review-source', '/sf-approve']) {
    const refused = await mutationToolGuard(asPatch(await f.enter(skill, `turn-${skill}`), staging));
    assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_STAGING_NOT_ISSUED: .*the step author's clarification-response staging file, issued only in a authoring turn by singularity-flow phase enter --compose --for-agent --json \(\/sf-phase\)/u, skill);
    assert.deepEqual(refused.next[0].argv, ['phase', 'enter', '--compose', '--for-agent', '--json']);
    assert.ok(refused.next[0].commandGuidance ?? refused.next[0].command, 'three-surface route');
  }
});

test('a step with no clarification checkpoint derives no file, and nothing around the file widens', async t => {
  const off = await fixture(t);
  const staging = clarificationStagingPath(gitDir(off.root), off.workflow, off.phase);
  assert.deepEqual(phaseStagingPaths({ gitDirectory: gitDir(off.root), definition: off.definition, workflow: off.workflow, turnMode: 'authoring' }), []);
  const refused = await mutationToolGuard(asPatch(await off.enter('/sf-phase'), staging));
  assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_STAGING_NOT_ISSUED: .*this step has no open clarification checkpoint for this turn\. Run singularity-flow phase enter --compose --for-agent --json standalone/u);

  const f = await fixture(t, { clarification: { mode: 'when-needed' } });
  const file = clarificationStagingPath(gitDir(f.root), f.workflow, f.phase);
  const payload = await f.enter('/sf-phase');
  for (const [target, code] of [
    [path.dirname(file), 'PHASE_MUTATION_PATH_DENIED'],
    [path.join(path.dirname(path.dirname(file)), 'other.json'), 'PHASE_MUTATION_PATH_DENIED'],
    [`${file}.other`, 'PHASE_MUTATION_STAGING_PATH_MISMATCH']
  ]) assert.match((await mutationToolGuard(asPatch(payload, target))).permissionDecisionReason, new RegExp(`^${code}`, 'u'), target);
  // A link planted at the derived file is refused as a link, never offered back as the file to write.
  await mkdir(path.dirname(file), { recursive: true });
  await symlink(path.join(f.root, 'src', 'App.jsx'), file);
  const linked = await mutationToolGuard(asPatch(await f.enter('/sf-phase', 'after-link'), file));
  assert.match(linked.permissionDecisionReason, /^PHASE_MUTATION_PATH_DENIED/u);
  assert.equal(readFileSync(path.join(f.root, 'src', 'App.jsx'), 'utf8'), 'export const value = 1;\n');
});

test('/sf-specify, /sf-plan, /sf-verify and /sf-implement author the current step like /sf-phase', async t => {
  const f = await fixture(t);
  for (const skill of ['/sf-specify', '/sf-plan', '/sf-verify', '/sf-implement']) {
    assert.equal(mutationTurnMode(skill.slice(1)), 'authoring', skill);
    const payload = await f.enter(skill, `author-${skill.slice(4)}`);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolArgs: { path: 'singularity/work-items/PMC-1/artifacts/custom-step/plan.md' } }), {}, skill);
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: 'singularity-flow prepare custom-step' } }), {}, skill);
    // Still bound to the step's own policy: an artifact-only step edits no application code.
    assert.equal((await mutationToolGuard(payload)).permissionDecision, 'deny', skill);
  }
});

test('an expired turn says so and names its own skill, never an issuer or shell route that cannot renew it', async t => {
  const f = await fixture(t, { clarification: { mode: 'required' } });
  const enterAt = async (skill, sessionId, now) => {
    const payload = { cwd: f.root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => f.accepted }) });
    return payload;
  };
  const past = Date.now() - 31 * 60_000;
  const staging = clarificationStagingPath(gitDir(f.root), f.workflow, f.phase);
  const author = await enterAt('/sf-code', 'expired-author', past);
  for (const payload of [asPatch(author, staging), { ...author, toolName: 'edit', toolArgs: { path: 'singularity/work-items/PMC-1/artifacts/custom-step/a.md' } }]) {
    assert.match((await mutationToolGuard(payload)).permissionDecisionReason,
      /^PHASE_MUTATION_TURN_EXPIRED: [^\n]*Invoke \/sf-code again to continue[^\n]*\n\n- Copilot: \/sf-code\n- Shell: not available for this action\n- VS Code \(model-free\): not available for this action$/u);
  }
  const draft = path.join(path.dirname(f.root), 'drafts', 'web.application.yml');
  const runApp = await enterAt('/sf-run-app suggest', 'expired-run', past);
  assert.match((await mutationToolGuard({ ...runApp, toolName: 'edit', toolArgs: { path: draft } })).permissionDecisionReason,
    /^PHASE_MUTATION_TURN_EXPIRED: .*Invoke \/sf-run-app again/u);
  // A live turn on the same step is unaffected.
  assert.deepEqual(await mutationToolGuard(asPatch(await enterAt('/sf-phase', 'live-author', Date.now()), staging)), {});
  // An expired turn without a Story binding kept its mutations through the setup fallback (2026-10-28):
  // only its reads remain.
  const session = await enterAt('/sf-session', 'expired-session', past);
  const bash = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.deepEqual(await bash(session, 'singularity-flow session current --for-agent --json'), {});
  assert.match((await bash(session, 'singularity-flow session attach PMC-1')).permissionDecisionReason,
    /^PHASE_MUTATION_TURN_EXPIRED: .*Invoke \/sf-session again/u);
});

test('a propose command naming a draft not issued to this turn names the command that issues the same file', async t => {
  const f = await fixture(t);
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const run = await f.enter('/sf-run-app suggest', 'run-propose');
  const draft = path.join(path.dirname(f.root), 'drafts', 'web.application.yml');
  const propose = `singularity-flow capability set web --application-file ${draft} --json`;
  assert.match((await shell(run, propose)).permissionDecisionReason,
    /^RUN_AND_TEST_DRAFT_NOT_ISSUED: .*web\.application\.yml is not issued to this turn\. Run singularity-flow app suggest --json standalone in this turn first: it issues the same draft file and leaves what is in it unchanged/u);
  // A command that is wrong for another reason keeps the ordinary refusal.
  assert.match((await shell(run, `singularity-flow capability set web --application-file ${draft} --name Other`)).permissionDecisionReason,
    /^RUN_AND_TEST_OPERATION_NOT_ALLOWED/u);
  await issueRunAppDraftStaging(draft, { root: f.root });
  assert.deepEqual(await shell(run, propose), {});

  const fix = await f.enter('/sf-fix-workflow', 'fix-propose');
  const changeSet = path.join(path.dirname(f.root), 'fixes', 'feature.change-set.json');
  const apply = `singularity-flow workflow studio apply --change-set ${changeSet} --propose --json`;
  assert.match((await shell(fix, apply)).permissionDecisionReason,
    /^FIX_WORKFLOW_DRAFT_NOT_ISSUED: .*Run singularity-flow workflow validate --json standalone in this turn first, for the same workflow/u);
  assert.match((await shell(fix, `singularity-flow workflow studio apply --change-set ${changeSet} --propose --approve`)).permissionDecisionReason,
    /^FIX_WORKFLOW_OPERATION_NOT_ALLOWED/u);
  await issueFixWorkflowStaging(changeSet, { root: f.root });
  assert.deepEqual(await shell(fix, apply), {});
});

test('an import-team turn with no candidate issued names the route that continues an earlier session', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-import-team', 'import-continue');
  const candidate = path.join(path.dirname(f.root), 'state', 'team-imports', 'tis-1', 'candidate.json');
  const refused = await mutationToolGuard({ ...payload, toolArgs: { path: candidate } });
  assert.match(refused.permissionDecisionReason,
    /^IMPORT_TEAM_PATH_DENIED: no candidate file is issued to this turn\. To continue an earlier session, run singularity-flow workflow import-team status --session <SESSION-ID> --json in this turn: it issues that session's candidate file again and keeps its answers/u);
});

test('an agent turn may preview a workflow delete and propose an archive, but confirming a delete is the person\'s', async t => {
  // docs/SPEC-WORKFLOW-RETIREMENT-v1.md: the person confirms a delete in VS Code or their own terminal.
  const f = await fixture(t);
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const confirm = 'singularity-flow workflow delete mine --confirm sha256:' + 'a'.repeat(64) + ' --propose --json';
  for (const [label, payload] of [['with a Story', await f.enter('/sf-workflows', 'workflows-story')],
    ['without a Story', await (async () => {
      const value = { cwd: f.root, sessionId: 'workflows-setup', prompt: '/sf-workflows' };
      await recordRepositoryBoundaryTurn(value, { captureMutation: (item, record) => captureMutationTurn(item, record,
        { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story yet'); } }) });
      return value;
    })()]]) {
    assert.deepEqual(await shell(payload, 'singularity-flow workflow delete mine --dry-run --json'), {}, label);
    const refused = await shell(payload, confirm);
    assert.equal(refused.permissionDecision, 'deny', label);
    assert.match(refused.permissionDecisionReason, /confirming a workflow delete is the person's own step.*Workflow Studio → Delete…/u, label);
  }
});

// Route closure (2026-10-28): every route SFlow names must run where it is handed. A route's skill was
// picked from its command family, never checked against that skill's turn, so Copilot was sent to
// turns that refuse the command, and a person's own step got a Copilot route. Each exception names why.
const CLOSURE_EXCEPTIONS = new Map([
  // A bare family ID stands for its subcommands, each with its own exact route.
  ['capabilities -> /sf-capabilities', 'the family ID; its mutating subcommands are routed one by one'],
  ['jira -> /sf-jira-work', 'the family ID; every jira subcommand has its own route'],
  ['revision attachments -> /sf-revision', 'the family ID; each attachments subcommand has its own route'],
  ['cache -> /sf-doctor', 'the family ID; `cache clear` names no skill'],
  // /sf-revision-checks shows the exact run command for the person's own Shell review and never runs it.
  ['revision checks run -> /sf-revision-checks', 'a relay: its skill displays the command for the person\'s Shell review'],
  // The host runs a lifecycle hook itself, in every turn (copilot-mutation-guard.mjs HOOK_DENIAL).
  ['hook -> /sf-hook', 'host-only; /sf-hook explains the hook and never runs it']
]);
const fillPlaceholders = (command) => command
  .replace(/<(?:WORK-ID|work-id|WORK_ID)>/gu, 'PMC-1')
  .replace(/<(?:PHASE|phase|STEP|step|PHASE-ID)>/gu, 'custom-step')
  .replace(/"<[^>]*>"/gu, '"x"')
  .replace(/<[^>]*>/gu, 'x');

test('every route a refusal plan names runs in the turn it names, and a person\'s own step names no skill', async t => {
  const f = await fixture(t);
  const { refusalRemediationPlan, KNOWN_REFUSAL_CODES } = await import('../src/refusal-remediation.mjs');
  const { agentAct } = await import('../src/agent-output.mjs');
  const turns = new Map();
  const shell = async (skill, command) => {
    if (!turns.has(skill)) turns.set(skill, await f.enter(skill, `closure-${skill.replace(/\W/gu, '')}`));
    return mutationToolGuard({ ...turns.get(skill), toolName: 'bash', toolArgs: { command, cwd: f.root } });
  };
  const details = { workId: 'PMC-1', phase: 'custom-step', phaseId: 'custom-step', currentPhase: 'custom-step', documentId: 'DOC-001',
    decidableStep: 'custom-step', issue: 'UPI-001', workType: 'feature', upstreamPhases: ['custom-step'], producerPhase: 'custom-step',
    restorable: true, paths: ['a.txt'], errors: ['x'], authorities: ['product'], capabilityId: 'web-app', storyId: 'PMC-1', expectedWorkId: 'PMC-1' };
  const refusing = [['phase', 'prepublish', 'custom-step', '--work-id', 'PMC-1'], ['approve', 'custom-step', '--work-id', 'PMC-1'],
    ['submit', 'custom-step'], ['prepare', 'custom-step'], ['next', 'PMC-1']];
  const failures = new Set();
  for (const code of KNOWN_REFUSAL_CODES) for (const argv of refusing) {
    let plan;
    try { plan = refusalRemediationPlan(Object.assign(new Error('refused'), { code, details }), argv); } catch { continue; }
    for (const step of plan.steps ?? []) {
      if (!step.command || !step.copilotCommand) continue;
      const command = fillPlaceholders(step.command);
      const skill = step.copilotCommand.split(/\s+/u)[0];
      const key = `${code} ${step.id}: ${command.split(/\s+/u).slice(1, 3).join(' ')} -> ${skill}`;
      if (CLOSURE_EXCEPTIONS.has(key)) continue;
      if (ownTerminalStep(command)) { failures.add(`${key}: a person's own step has a Copilot route`); continue; }
      // /sf-confirm runs only the command carrying the digest the person typed.
      if (skill === '/sf-confirm') continue;
      const decision = await shell(skill, command);
      if (decision.permissionDecision === 'deny') failures.add(`${key}: refused there (${decision.permissionDecisionReason?.split('.')[0]})`);
    }
    const act = agentAct({ error: { code, message: 'refused', details }, remediationPlan: plan });
    const shellLine = act?.do?.shell ?? null;
    if (shellLine && ownTerminalStep(shellLine) && act.do.copilot) failures.add(`${code} act: a person's own step has a Copilot route`);
    if (shellLine && act.state === 'next' && !/^singularity-flow\s/u.test(shellLine)) failures.add(`${code} act: ${shellLine.split(/\s+/u).slice(0, 2).join(' ')} is not an SFlow command`);
  }
  assert.deepEqual([...failures].sort(), []);
});

test('no mutating command is routed to a skill whose turn only reads', async t => {
  const f = await fixture(t);
  const { operationCatalog } = await import('../src/command-registry.mjs');
  const failures = [];
  for (const operation of operationCatalog()) {
    if (operation.classification !== 'mutation') continue;
    const words = operation.id.split('.').filter((word) => !['preview', 'deterministic', 'model'].includes(word));
    const command = `singularity-flow ${words.join(' ')}`;
    const skill = skillForCommandLine(command);
    if (!skill || mutationTurnMode(skill) !== 'read' || CLOSURE_EXCEPTIONS.has(`${words.join(' ')} -> /${skill}`)) continue;
    const payload = await f.enter(`/${skill}`, `closure-read-${skill}`);
    const decision = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command: `${command} --work-id PMC-1`, cwd: f.root } });
    if (decision.permissionDecision === 'deny') failures.push(`${words.join(' ')} -> /${skill}`);
  }
  assert.deepEqual(failures, []);
});

test('a person\'s own step that a turn refuses shows that exact command for their terminal, not the turn\'s route', async t => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-recover', 'own-route');
  const command = 'singularity-flow decision witness PMC-1 --criterion PMC-1:AC-001 --slot screen --file evidence/screen.png --confirm states-the-outcome --reason "Looked at it."';
  const denied = await mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.equal(denied.next.length, 1);
  assert.equal(denied.next[0].copilotCommand, null);
  assert.match(denied.next[0].command, /^singularity-flow decision witness PMC-1 /u);
  assert.match(denied.permissionDecisionReason, /- Copilot: no verified equivalent\n- Shell: singularity-flow decision witness PMC-1/u);
});

// A chat decision carries what the person answered [study: decisions across surfaces, Stage 4].
const CHOOSE = 'singularity-flow decision choose PMC-1 --fetch --option ship --reason "The person chose to ship." --expected k1';
const ADJUDICATE = 'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "Not a defect."';
const AGENT_HOST_REPLY = 'The user is not available to answer your question. Choose a pragmatic option best aligned with the context of the request.';
const LOCAL_CHAT_REPLY = 'The user is not available to respond and will review your work later. Work autonomously and make good decisions.';
const UNBOUND = /^PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded\./u;

test('Copilot CLI and the agent host: a decision command carries what the person answered, in their words', async t => {
  const f = await fixture(t);
  const run = (payload, command) => repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  // No question asked: the model's own reason is nobody's word.
  const unasked = await f.enter('/sf-decide PMC-1', 'unasked');
  const refused = await run(unasked, CHOOSE);
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, UNBOUND);
  assert.match(refused.permissionDecisionReason, /No person answered a question in this turn/u);
  assert.match(refused.permissionDecisionReason, /sflowDecide or sflow_decide/u, 'the card is offered');
  assert.equal(refused.recoverable, true, 'the turn carries on');
  assert.equal(hookAnswerForEveryHost('boundary-guard', refused).hookSpecificOutput.permissionDecision, 'deny', 'VS Code reads a refusal only there');
  // Asked and answered: exactly their words pass, whatever the case or spacing or a closing full stop.
  await repositoryPostToolGuard({ ...unasked, toolName: 'ask_user', toolArgs: { message: 'Which route?' }, toolResult: { resultType: 'success', textResultForLlm: 'User responded: option=ship, reason=The person  chose to SHIP' } });
  assert.deepEqual(await run(unasked, CHOOSE), {});
  // The same words in a different turn are not an answer in this one.
  const later = await f.enter('/sf-decide PMC-1', 'unasked');
  assert.match((await run(later, CHOOSE)).permissionDecisionReason, UNBOUND);
  // Anything else is not what they said, and they need not be asked again.
  const answered = await f.enter('/sf-converge', 'converge-answered');
  await personSaid(answered, 'disposition=dismissed', 'reason=part of playright setup');
  const reworded = await run(answered, 'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "Part of the Playwright setup."');
  assert.match(reworded.permissionDecisionReason, /is not what the person answered\. Run it again with exactly their words; their answer stands/u);
  assert.match(reworded.permissionDecisionReason, /part of the playwright setup/u);
  assert.deepEqual(await run(answered, 'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "part of playright setup"'), {});
  // A chain is still refused for what it is, not for this.
  assert.match((await run(answered, `${ADJUDICATE} && ${ADJUDICATE}`)).permissionDecisionReason, /these commands were chained/u);
  // A rework needs no reason, and still a person's answer.
  const quiet = await f.enter('/sf-converge', 'converge-quiet');
  assert.match((await run(quiet, 'singularity-flow story adjudicate CF-1 --disposition rework')).permissionDecisionReason, UNBOUND);
  await personSaid(quiet, 'disposition=rework');
  assert.deepEqual(await run(quiet, 'singularity-flow story adjudicate CF-1 --disposition rework'), {});
});

test('the host\'s canned reply is refused, in a plain answer and in every field of a form', async t => {
  const f = await fixture(t);
  const run = (payload, command) => repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  for (const reply of [AGENT_HOST_REPLY, `User responded: reason=${AGENT_HOST_REPLY}, disposition=${AGENT_HOST_REPLY}`]) {
    const payload = await f.enter('/sf-converge', `canned-${reply.length}`);
    await repositoryPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs: {}, toolResult: { textResultForLlm: reply, resultType: 'success' } });
    for (const command of [ADJUDICATE, `singularity-flow story adjudicate CF-1 --disposition dismissed --reason "${AGENT_HOST_REPLY}"`]) {
      const refused = await run(payload, command);
      assert.match(refused.permissionDecisionReason, UNBOUND, command);
      assert.match(refused.permissionDecisionReason, /The host answered the question itself/u);
      assert.match(refused.permissionDecisionReason, /Do not choose for them/u);
    }
  }
  // A person answering after it is what counts.
  const payload = await f.enter('/sf-converge', 'canned-then-person');
  await repositoryPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs: {}, toolResult: { textResultForLlm: AGENT_HOST_REPLY, resultType: 'success' } });
  await personSaid(payload, 'Not a defect.');
  assert.deepEqual(await run(payload, ADJUDICATE), {});
});

test('what cannot be told apart refuses nothing: a question whose answer never arrived, and words the person typed with the skill', async t => {
  const f = await fixture(t);
  const run = (payload, command) => repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const asked = await f.enter('/sf-decide PMC-1', 'no-delivery');
  assert.notEqual((await repositoryToolGuard({ ...asked, toolName: 'ask_user', toolArgs: { question: 'Why?' } })).permissionDecision, 'deny');
  assert.deepEqual(await run(asked, CHOOSE), {}, 'it asked, and this hook never saw the answer');
  const typed = await f.enter('/sf-converge dismiss CF-1: Not a defect.', 'typed-with-skill');
  assert.deepEqual(await run(typed, ADJUDICATE), {});
  assert.match((await run(typed, 'singularity-flow story adjudicate CF-1 --disposition dismissed --reason "Something else entirely."')).permissionDecisionReason, UNBOUND);
});

test('VS Code\'s own chat: an answer that arrives binds the command, and with none it is left as it was', async t => {
  const f = await fixture(t);
  const local = (payload, fields) => ({ session_id: payload.sessionId, cwd: payload.cwd, hook_event_name: fields.tool_response === undefined ? 'PreToolUse' : 'PostToolUse', ...fields });
  const run = (payload, command) => repositoryToolGuard(local(payload, { tool_name: 'run_in_terminal', tool_input: { command, cwd: f.root } }));
  const said = (payload, answers) => repositoryPostToolGuard(local(payload, { tool_name: 'vscode_askQuestions', tool_input: { questions: [] }, tool_use_id: 't1', tool_response: JSON.stringify({ answers }) }));
  const nothing = await f.enter('/sf-decide PMC-1', 'local-none');
  assert.notEqual((await run(nothing, CHOOSE)).permissionDecision, 'deny', 'nothing shows this chat\'s hooks see its question tool, so no answer proves nothing');
  const answered = await f.enter('/sf-decide PMC-1', 'local-answered');
  await said(answered, { Route: { selected: ['ship'], freeText: null, skipped: false }, Reason: { selected: [], freeText: 'The person chose to ship.', skipped: false } });
  assert.notEqual((await run(answered, CHOOSE)).permissionDecision, 'deny');
  assert.match((await run(answered, 'singularity-flow decision choose PMC-1 --fetch --option ship --reason "My own idea." --expected k1')).permissionDecisionReason, UNBOUND);
  const canned = await f.enter('/sf-decide PMC-1', 'local-canned');
  await said(canned, { Reason: { selected: [], freeText: LOCAL_CHAT_REPLY, skipped: false } });
  assert.match((await run(canned, CHOOSE)).permissionDecisionReason, /The host answered the question itself/u);
  const skipped = await f.enter('/sf-decide PMC-1', 'local-skipped');
  await said(skipped, { Reason: { selected: [], freeText: null, skipped: true } });
  assert.match((await run(skipped, CHOOSE)).permissionDecisionReason, /No person answered/u);
});

test('only the turns that own these decisions are held to it, and only these commands', async t => {
  assert.deepEqual([...ANSWER_BOUND_SKILLS].sort(), [...ANSWER_BOUND_TURNS].sort());
  const f = await fixture(t);
  const run = (payload, command) => repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const decide = await f.enter('/sf-decide PMC-1', 'bound-reads');
  for (const command of ['singularity-flow decision show PMC-1 --json', 'singularity-flow decisions PMC-1 --for-agent --json', 'singularity-flow evidence scope PMC-1 --json']) {
    assert.deepEqual(await run(decide, command), {}, command);
  }
  // A typed /sf-approve keeps its own confirmation; nothing asks it for an ask_user answer.
  const approving = await f.enter('/sf-approve', 'bound-approve');
  assert.doesNotMatch(String((await run(approving, 'singularity-flow approve custom-step --work-id PMC-1 --fetch')).permissionDecisionReason), UNBOUND);
  // An ended turn leaves no answers behind.
  const ledgers = async () => (await readdir(path.join(path.dirname(copilotModeFile()), 'copilot-boundaries'))).filter((name) => name.endsWith('.answers.json')).length;
  const before = await ledgers();
  await endRepositoryBoundaryTurn(decide);
  assert.equal(await ledgers(), before - 1);
});

test('a question\'s answer reads the same however the host words it', () => {
  assert.deepEqual(answerOfQuestion({ toolResult: { textResultForLlm: 'User responded: disposition=accepted-deviation, reason=part of test setup' } }), { texts: ['disposition=accepted-deviation, reason=part of test setup'], canned: false });
  assert.deepEqual(answerOfQuestion({ toolResult: { textResultForLlm: 'User declined to answer' } }), { texts: [], canned: false });
  assert.deepEqual(answerOfQuestion({ tool_response: JSON.stringify({ answers: { A: { selected: ['Yes'], freeText: 'Because.', skipped: false }, B: { selected: [], freeText: null, skipped: true } } }) }), { texts: ['yes', 'because'], canned: false });
  assert.deepEqual(answerOfQuestion({ toolResult: { textResultForLlm: AGENT_HOST_REPLY } }), { texts: [], canned: true });
  assert.deepEqual(answerOfQuestion({ tool_response: JSON.stringify({ answers: { A: { selected: [], freeText: LOCAL_CHAT_REPLY, skipped: false } } }) }), { texts: [], canned: true });
  assert.equal(answerOfQuestion({}), null, 'no result: nothing arrived');
  assert.deepEqual(wordsOfCommand({ reason: ['d1=Not a defect.', 'd2=Nor this'], cause: 'd1=No browser here', 'supporting-reason': 'The test script.' }), ['not a defect', 'nor this', 'the test script', 'no browser here']);
});
