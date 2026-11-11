import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AUTHORING_SKILL_DECLARATION } from '../src/authoring-skills.mjs';
import { phaseTaskCompletion, phaseTaskHeldForAnswers } from '../src/phase-authoring-progress.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { captureMutationTurn, recordPhaseTaskAnswers, recordPhaseTaskProgress, recordPhaseTaskCheck, refreshMutationContracts } from '../src/copilot-mutation-guard.mjs';
import { recordRepositoryBoundaryTurn, repositoryAgentStop, repositoryToolGuard, repositoryToolFailure,
  workflowTaskCompletionRequested, endRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { recoverableWorkflowReadFailure } from '../src/copilot-review-completion.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { fileURLToPath } from 'node:url';
import { CLI, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';
import { completeAgentResult } from '../src/agent-output.mjs';
import { enterPhase } from '../src/phase-entry.mjs';

async function fixture(t, { phaseId = 'planning', skill = '/sf-phase', code = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-task-completion-'));
  const directory = await realpath(temporary);
  const root = path.join(directory, 'Story Ω with spaces');
  await mkdir(root);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Task Tester'); git('config', 'user.email', 'task@example.test');
  const phase = { id: phaseId, status: 'in_progress', generation: 0, writeScope: code ? 'source-and-artifact' : 'artifact-only',
    requiredArtifact: { path: `artifacts/${phaseId}/report.md` },
    generationPolicy: { task: code ? 'code' : 'document', requirement: 'required' },
    ...(code ? { generationIntent: { status: 'open', generation: 1 } } : {}) };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  const workflow = { status: 'in_progress', workItem: { id: 'TASK-1' }, currentPhase: phaseId,
    phaseOrder: [phaseId], phases: { [phaseId]: phase }, resolution: {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'TASK-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', 'Initialize task fixture');
  const accepted = { definition, workflow };
  const payload = { cwd: root, sessionId: 'task-completion', prompt: skill };
  const captureMutation = (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => root, load: async () => accepted });
  const entry = { resultType: 'sflow-phase-entry', ready: true, workId: 'TASK-1', phase: phaseId,
    authoringAllowed: true, contextAdmission: { allowed: true }, authoring: { entry: { status: 'authoring-entry' } },
    authoringProgress: { generation: 1, next: safeCommandGuidance({ argv: ['prepare', phaseId] }) } };
  const start = async (prompt = skill) => recordRepositoryBoundaryTurn({ ...payload, prompt }, { captureMutation });
  const arm = async (value = entry) => {
    await repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: {
      command: `singularity-flow phase enter ${phaseId} --for-agent --json`
    } });
    const taskCompletion = phaseTaskCompletion(value);
    return recordPhaseTaskProgress(root, { ...taskCompletion, ...phaseTaskHeldForAnswers({ ...value, taskCompletion }) });
  };
  const mutationFile = path.join(directory, 'machine/copilot-boundaries', `${createHash('sha256').update(payload.sessionId).digest('hex')}.mutation.json`);
  const stop = extra => repositoryAgentStop({ ...payload, stopReason: 'end_turn', ...extra });
  await start();
  return { root, git, phase, workflow, workflowFile, accepted, payload, entry, start, arm, stop, mutationFile };
}

test('completion covers registered phase authors and delegates, excluding explicit single steps and human decisions', () => {
  for (const source of Object.keys(AUTHORING_SKILL_DECLARATION)) {
    assert.equal(workflowTaskCompletionRequested(`/${source.replace(/^sflow-/u, 'sf-')} custom-scope`), true);
  }
  for (const skill of ['sf-call', 'sf-implement', 'sf-specify', 'sf-plan', 'sf-verify', 'sf-scenario-repair']) {
    assert.equal(workflowTaskCompletionRequested(`/${skill}`), true);
  }
  assert.equal(workflowTaskCompletionRequested('<skill-context name="sf-phase">Old prompt\nARGUMENTS: custom-release\n</skill-context>'), true);
  for (const step of ['context', 'stage', 'check', 'status', 'show', 'preview', 'prepare', 'publish']) {
    assert.equal(workflowTaskCompletionRequested(`/sf-phase ${step} planning`), false);
  }
  for (const prompt of ['/sf-approve', '/sf-submit', '/sf-decide', '/sf-publish', '/sf-code-docs', '/sf-review-source', 'Please explain /sf-code']) {
    assert.equal(workflowTaskCompletionRequested(prompt), false, prompt);
  }
});

test('a turn cannot end on a person\'s answers: after the question returns, and after they are recorded', async t => {
  for (const options of [{ phaseId: 'specification' }, { phaseId: 'implementation', skill: '/sf-code', code: true }, { phaseId: 'verification' }, { phaseId: 'release', skill: '/sf-release' }]) await t.test(options.phaseId, async t => {
    const f = await fixture(t, options);
    const record = `singularity-flow clarification record ${options.phaseId} --response-file /issued/responses.json --for-agent --json`;
    await f.arm({ ...f.entry, status: 'clarification-required', authoringAllowed: false,
      clarification: { checkpoint: { recordAction: { commandGuidance: { command: record } } } } });
    assert.deepEqual(await f.stop(), {}, 'questions shown in chat with no question tool still wait on the person');
    await repositoryToolGuard({ ...f.payload, toolName: 'ask_user', toolArgs: { question: 'Which?' } });
    const asked = await f.stop();
    assert.equal(asked.decision, 'block');
    assert.match(asked.reason, /^SFLOW_WORKFLOW_TASK_INCOMPLETE:/u);
    assert.ok(asked.reason.includes(record), asked.reason);
    assert.match(asked.reason, /phase enter --compose --for-agent --json once/u);
    assert.match(asked.reason, /left a question open, say which and stop; never answer for them/u);
    assert.deepEqual(await f.stop(), {}, 'told once, never a loop');
    const continuation = await recordRepositoryBoundaryTurn({ ...f.payload, prompt: asked.reason });
    assert.match(continuation.additionalContext, /same admitted workflow task/, 'a host that sends the reason as a prompt keeps the turn');
    await recordPhaseTaskAnswers(f.root, { workId: 'TASK-1', phaseId: options.phaseId, generation: 1, completed: true });
    const recorded = await f.stop();
    assert.equal(recorded.decision, 'block');
    assert.match(recorded.reason, /The answers are recorded\./u);
    assert.match(recorded.reason, new RegExp(`phase enter ${options.phaseId} --work-id TASK-1 --compose --for-agent --json`));
    assert.deepEqual(await f.stop(), {});
    await f.arm();
    const authoring = await f.stop();
    assert.equal(authoring.decision, 'block', 'the authoring keeps its own continuation');
    assert.match(authoring.reason, /Reuse the current exact paths/);
  });
  await t.test('VS Code asks with its own tool and sends no stop reason', async t => {
    const f = await fixture(t, { phaseId: 'specification' });
    await f.arm({ ...f.entry, status: 'clarification-required', authoringAllowed: false,
      clarification: { checkpoint: { recordAction: { commandGuidance: { command: 'singularity-flow clarification record specification --response-file /issued/r.json --for-agent --json' } } } } });
    await repositoryToolGuard({ cwd: f.root, session_id: 'task-completion', hook_event_name: 'PreToolUse', tool_name: 'vscode_askQuestions', tool_input: { questions: [] } });
    const stop = await repositoryAgentStop({ cwd: f.root, session_id: 'task-completion', hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(stop.decision, 'block');
    assert.deepEqual(await repositoryAgentStop({ cwd: f.root, session_id: 'task-completion', hook_event_name: 'Stop', stop_hook_active: true }), {});
  });
  await t.test('answers still open keep the wait, and so does a hold that is not about answers', async t => {
    const f = await fixture(t, { phaseId: 'specification' });
    await f.arm({ ...f.entry, status: 'clarification-required', authoringAllowed: false,
      clarification: { checkpoint: { recordAction: { commandGuidance: { command: 'singularity-flow clarification record specification --response-file /issued/r.json --for-agent --json' } } } } });
    await recordPhaseTaskAnswers(f.root, { workId: 'TASK-1', phaseId: 'specification', generation: 1, completed: false });
    assert.deepEqual(await f.stop(), {});
    const other = await fixture(t, { phaseId: 'specification' });
    await other.arm({ ...other.entry, authoringAllowed: false });
    await repositoryToolGuard({ ...other.payload, toolName: 'ask_user', toolArgs: { question: 'Which?' } });
    assert.deepEqual(await other.stop(), {});
  });
});

test('a real Story carries on after a person\'s answers, through the real commands', async t => {
  const f = await startedSpecificationStory(t, 'TASK-ANSWERS');
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(f.directory, 'machine', 'mode.json');
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
  });
  const hook = { cwd: f.root, sessionId: 'real-answers', prompt: '/sf-phase' };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record,
    { resolveRoot: async () => f.root }) });
  const stop = () => repositoryAgentStop({ ...hook, stopReason: 'end_turn' });
  const enter = async () => {
    await repositoryToolGuard({ ...hook, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --compose --for-agent --json' } });
    return completeAgentResult(f.cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  };
  const entry = await enter();
  assert.equal(entry.status, 'clarification-required', JSON.stringify(entry.taskCompletion));
  assert.equal(entry.taskCompletion.held, undefined, 'the result does not grow with what only the hook reads');
  assert.deepEqual(await stop(), {}, 'nobody has answered yet');

  await repositoryToolGuard({ ...hook, toolName: 'ask_user', toolArgs: { question: 'Is this interpretation complete?' } });
  const action = entry.clarification.checkpoint.recordAction.commandGuidance;
  const asked = await stop();
  assert.equal(asked.decision, 'block', 'the question returned and the turn ended');
  assert.ok(asked.reason.includes(action.command), asked.reason);

  await mkdir(path.dirname(entry.clarification.responseStagingPath), { recursive: true });
  await writeFile(entry.clarification.responseStagingPath, JSON.stringify({ responses: [{ question: 'Is this interpretation complete?', answer: 'Yes.' }] }));
  const allowed = await repositoryToolGuard({ ...hook, toolName: 'bash', toolArgs: { command: action.command } });
  assert.notEqual(allowed.permissionDecision, 'deny', allowed.permissionDecisionReason);
  const recorded = completeAgentResult(f.cli(...action.argv).stdout);
  assert.match(recorded.act.said, /phase enter --compose --for-agent --json once more now/u, JSON.stringify(recorded));
  // Through the packaged hook, as VS Code's Local chat calls it: no stop reason, and it reads the answer from hookSpecificOutput.
  const vsCodeStop = spawnSync(process.execPath, [fileURLToPath(new URL('../plugin/hook-launcher.mjs', import.meta.url)), 'boundary-stop', CLI], {
    cwd: f.root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SINGULARITY_FLOW_BUNDLE: 'off' },
    input: JSON.stringify({ timestamp: new Date().toISOString(), hook_event_name: 'Stop', session_id: hook.sessionId, cwd: f.root, stop_hook_active: false }) });
  assert.equal(vsCodeStop.status, 0, vsCodeStop.stderr);
  const answered = JSON.parse(vsCodeStop.stdout).hookSpecificOutput;
  assert.equal(answered?.decision, 'block', vsCodeStop.stdout);
  assert.match(answered.reason, /The answers are recorded\./u);
  assert.match(answered.reason, /phase enter specification --work-id TASK-ANSWERS --compose --for-agent --json/u);

  const admitted = await enter();
  assert.equal(admitted.act.state, 'author');
  assert.equal(admitted.authoringAllowed, true);
  const authoring = await stop();
  assert.equal(authoring.decision, 'block', 'the entry is refreshed and nothing is written');
  assert.match(authoring.reason, /Reuse the current exact paths/);
  assert.deepEqual(await stop(), {}, 'and that is the last nudge in this turn');
});

test('a chat whose shell starts outside the checkout is told where to run git, and only that chat', async t => {
  const f = await fixture(t);
  const outside = { ...f.payload, cwd: path.dirname(f.root) };
  const told = await recordRepositoryBoundaryTurn(outside, { captureMutation: (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => f.root, load: async () => f.accepted }) });
  assert.ok(told.additionalContext.includes(`run git and anything else in the repository as cd '${f.root}' && <command>.`), told.additionalContext);
  const allowed = await repositoryToolGuard({ ...outside, toolName: 'bash', toolArgs: { command: `cd '${f.root}' && git status --short && git diff --name-status` } });
  assert.notEqual(allowed.permissionDecision, 'deny', allowed.permissionDecisionReason);
  assert.doesNotMatch((await f.start()).additionalContext, /shell starts outside/u);
  const nested = path.join(f.root, 'singularity');
  const below = await recordRepositoryBoundaryTurn({ ...f.payload, cwd: nested }, { captureMutation: (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => f.root, load: async () => f.accepted }) });
  assert.doesNotMatch(below.additionalContext, /shell starts outside/u);
});

test('a host that sends no stop reason gets the end-of-turn check, and a reason other than the end of a turn does not', async t => {
  const f = await fixture(t);
  await f.arm();
  assert.deepEqual(await f.stop({ stopReason: 'max_tokens' }), {});
  assert.equal((await f.stop({ stopReason: undefined })).decision, 'block');
});

test('the refresh after recorded answers turns the end-of-turn check on, for every kind of step', async t => {
  for (const options of [{ phaseId: 'specification' }, { phaseId: 'implementation', skill: '/sf-code', code: true }, { phaseId: 'verification' }, { phaseId: 'release', skill: '/sf-release' }]) await t.test(options.phaseId, async t => {
    const f = await fixture(t, options);
    await f.arm({ ...f.entry, status: 'clarification-required', authoringAllowed: false, contextAdmission: { allowed: true } });
    assert.deepEqual(await f.stop(), {}, 'waiting on the person is a real place to stop');
    await f.arm();
    assert.equal((await f.stop()).decision, 'block', 'once the answers are recorded and the entry refreshed, stopping is not');
  });
});

test('planning, code, verification, release and custom tasks cannot finish at input reads or scaffolding', async t => {
  for (const options of [
    { phaseId: 'planning' }, { phaseId: 'implementation', skill: '/sf-code', code: true },
    { phaseId: 'verification' }, { phaseId: 'release', skill: '/sf-release' },
    { phaseId: 'copied-review-output' }, { phaseId: 'team-framework-build', skill: '/sf-call', code: true }
  ]) await t.test(options.phaseId, async t => {
    const f = await fixture(t, options);
    assert.deepEqual(await f.stop(), {}, 'a prompt without admitted entry does not authorize continuation');
    await f.arm();
    const before = await readFile(f.workflowFile);
    const head = f.git('rev-parse', 'HEAD');
    let answers;
    const executablePath = process.env.PATH;
    try {
      process.env.PATH = path.join(f.root, 'no-executables');
      answers = await Promise.all([f.stop(), f.stop()]);
    } finally { process.env.PATH = executablePath; }
    assert.equal(answers.filter(result => result.decision === 'block').length, 1);
    const answer = answers.find(result => result.decision === 'block');
    assert.match(answer.reason, /^SFLOW_WORKFLOW_TASK_INCOMPLETE:/u);
    assert.match(answer.reason, /Reuse the current exact paths/);
    assert.match(answer.reason, new RegExp(`phase prepublish ${options.phaseId}`));
    assert.match(answer.reason, /one automatic continuation only/);
    assert.match(answer.reason, /result last --wait --command "<the cut command's words>" --for-agent --json/);
    assert.doesNotMatch(answer.reason, /singularity-flow (?:submit|approve) /u);
    const continuation = await recordRepositoryBoundaryTurn({ ...f.payload, prompt: answer.reason });
    assert.match(continuation.additionalContext, /same admitted workflow task/);
    assert.deepEqual(await f.stop(), {}, 'a second callback cannot spin or reset the attempt');
    assert.ok(before.equals(await readFile(f.workflowFile)));
    assert.equal(f.git('rev-parse', 'HEAD'), head, 'completion changes no lifecycle state');
  });
});

test('size and exact-path recovery applies to native read aliases, never real access failures', async t => {
  const f = await fixture(t);
  await f.arm();
  const file = path.join(f.root, 'inputs.md');
  const text = Array.from({ length: 500 }, (_, i) => `Line ${i}: a requirement and the evidence that would verify its observable outcome. Ω`).join('\n');
  await writeFile(file, text);
  for (const [toolName, range] of [
    ['view', { view_range: [1, -1] }], ['Read', { view_range: [1, -1] }],
    ['read_file', { start_line: 1, end_line: 500 }], ['mcp__filesystem__read_file', { startLine: 1, endLine: 500 }],
    ['read_text_file', {}], ['get_file', {}]
  ]) {
    const decision = await repositoryToolGuard({ ...f.payload, toolName, toolArgs: { path: file, ...range } });
    assert.equal(decision.code, 'FILE_READ_TOO_LONG', toolName);
    assert.equal(decision.recoverable, true);
    assert.equal(decision.readRanges[0].path, file);
    for (const request of decision.readRequests) {
      assert.deepEqual(await repositoryToolGuard({ ...f.payload, toolName: request.tool, toolArgs: request.args }), {});
    }
  }
  assert.deepEqual(await repositoryToolGuard({ ...f.payload, toolName: 'read_file', toolArgs: { path: file, offset: 0, limit: 20 } }), {},
    'unknown native range conventions are never reinterpreted or forced into a whole-read loop');
  const small = path.join(f.root, 'three-lines.md');
  await writeFile(small, 'first\nsecond\nthird\n');
  const badRange = await repositoryToolGuard({ ...f.payload, toolName: 'Read', toolArgs: { path: small, view_range: [2, 500] } });
  assert.equal(badRange.code, 'FILE_READ_RANGE_INVALID');
  assert.deepEqual(badRange.readRequests, [{ tool: 'Read', args: { path: small, view_range: [2, 3] } }]);
  assert.deepEqual(await repositoryToolGuard({ ...f.payload, toolName: 'Read', toolArgs: badRange.readRequests[0].args }), {});
  // A result SFlow issued is read to its end: naming only the asked-for lines lost the rest of a real chat's read plan.
  const issued = path.join(f.root, '.sflow', 'out', 'context-text-1.txt');
  await mkdir(path.dirname(issued), { recursive: true });
  await writeFile(issued, Array.from({ length: 400 }, (_, line) => `line ${line + 1} ${'x'.repeat(90)}`).join('\n'));
  const partial = await repositoryToolGuard({ ...f.payload, toolName: 'view', toolArgs: { path: issued, view_range: [1, 200] } });
  assert.equal(partial.code, 'FILE_READ_TOO_LONG');
  assert.equal(partial.readRanges[0].ranges.at(-1)[1], 400, 'the plan runs to the end of the file');
  for (const request of partial.readRequests) assert.deepEqual(await repositoryToolGuard({ ...f.payload, toolName: request.tool, toolArgs: request.args }), {});
  // VS Code's read_file stops at the last line, so an end past it is no error there. A start past it still reads nothing.
  assert.deepEqual(await repositoryToolGuard({ ...f.payload, toolName: 'read_file', toolArgs: { filePath: small, startLine: 1, endLine: 500 } }), {});
  assert.equal((await repositoryToolGuard({ ...f.payload, toolName: 'read_file', toolArgs: { filePath: small, startLine: 40, endLine: 50 } })).code, 'FILE_READ_RANGE_INVALID');
  const pdf = path.join(f.root, 'reference.pdf');
  await writeFile(pdf, `%PDF-1.7\n${'a readable PDF stream\n'.repeat(600)}`);
  assert.deepEqual(await repositoryToolGuard({ ...f.payload, toolName: 'get_file', toolArgs: { path: pdf } }), {},
    'binary/container readers retain native behavior even when the bytes happen to be ASCII');
  const recover = await repositoryToolFailure({ ...f.payload, toolName: 'read_file', toolArgs: { path: file },
    error: { code: 'FILE_READ_TOO_LONG', message: 'File too large to read at once' } });
  assert.match(recover.additionalContext, /continue the admitted task/u);
  assert.match(recover.additionalContext, /Smaller native read windows/);
  const offsetRecovery = await repositoryToolFailure({ ...f.payload, toolName: 'read_file',
    toolArgs: { path: file, offset: 120, limit: 25 }, error: 'Output truncated' });
  assert.ok(offsetRecovery.additionalContext.includes('"offset":120,"limit":12'));
  assert.ok(offsetRecovery.additionalContext.includes('"offset":132,"limit":13'));
  assert.equal((await f.stop()).decision, 'block', 'recoverable reader constraints leave the task resumable');
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    await f.start(); await f.arm();
    const failure = await repositoryToolFailure({ ...f.payload, toolName: 'read', toolArgs: { path: file },
      error: { code, message: `${code}: original file error` } });
    assert.match(failure.additionalContext, new RegExp(code));
    assert.ok(failure.additionalContext.includes(file));
    assert.match(failure.additionalContext, /singularity-flow recover TASK-1 --phase planning/);
    assert.deepEqual(await f.stop(), {}, 'real access failures do not force another read');
  }
  assert.equal(recoverableWorkflowReadFailure({ toolName: 'edit' }, { code: 'EACCES', message: 'File too large: permission denied' }), false);
  assert.equal(recoverableWorkflowReadFailure({ toolCalls: [{ toolName: 'edit' }] }, { code: 'FILE_READ_TOO_LONG' }), false);
  assert.equal(recoverableWorkflowReadFailure({ toolName: 'Read' }, { permissionDecision: 'deny', code: 'PHASE_MUTATION_PATH_DENIED',
    permissionDecisionReason: 'Output truncated; permission denied by the hook.' }), false);
  // An edit of its own that missed the file's current lines, or a refused tool form, is this turn's repair and the task
  // continues (Story anu-bin, 2026-11-11: apply_patch "Failed to find expected lines" ended a code review as a blocker).
  for (const [toolName, error] of [['apply_patch', { message: 'Failed to find expected lines in src/App.jsx:\n  const x = 1;' }],
    ['replace_string_in_file', { message: 'Could not find the old string in file src/App.jsx' }],
    ['bash', { permissionDecision: 'deny', permissionDecisionReason: 'PHASE_MUTATION_TOOL_PROTOCOL: use native file-read tools for output. Correct the tool form in this turn' }]]) {
    await f.start(); await f.arm();
    const failure = await repositoryToolFailure({ ...f.payload, toolName, toolArgs: { path: file }, error });
    assert.match(failure.additionalContext, /not a blocker/u, toolName);
    assert.doesNotMatch(failure.additionalContext, /explicit blocker/u, toolName);
    assert.equal((await f.stop()).decision, 'block', `${toolName}: the task stays continuable`);
  }
  // The same edit refused for permission keeps its blocker.
  await f.start(); await f.arm();
  const refused = await repositoryToolFailure({ ...f.payload, toolName: 'apply_patch', toolArgs: { path: file },
    error: { code: 'EACCES', message: 'EACCES: permission denied, open src/App.jsx' } });
  assert.match(refused.additionalContext, /explicit blocker/u);
  assert.deepEqual(await f.stop(), {});
  await f.start(); await f.arm();
  const human = await repositoryToolFailure({ ...f.payload, toolName: 'bash', error: {
    code: 'HUMAN_APPROVAL_REQUIRED', message: 'Only the authorized person can decide.',
    nextAction: { argv: ['decisions', 'TASK-1', '--for-agent', '--json'] }
  } });
  assert.match(human.additionalContext, /sf-decide TASK-1/);
  assert.doesNotMatch(human.additionalContext, /singularity-flow recover/);
  assert.deepEqual(await f.stop(), {});
});

test('an unsplittable native read preserves its error and yields instead of forcing another attempt', async t => {
  for (const phaseId of ['planning', 'verification', 'release', 'custom-inspection']) await t.test(phaseId, async t => {
    const f = await fixture(t, { phaseId });
    const file = path.join(f.root, 'single-line.json');
    const content = JSON.stringify({ value: 'x'.repeat(12000) });
    await writeFile(file, content);
    const head = f.git('rev-parse', 'HEAD');
    for (const range of [{ start_line: 1, end_line: 1 }, { offset: 0, limit: 1 }]) {
      await f.start(); await f.arm();
      const failure = await repositoryToolFailure({ ...f.payload, toolName: 'read_file', toolArgs: { path: file, ...range },
        error: { code: 'FILE_READ_TOO_LONG', message: 'File too large to read at once' } });
      assert.match(failure.additionalContext, /FILE_READ_TOO_LONG/);
      assert.ok(failure.additionalContext.includes(file));
      assert.match(failure.additionalContext, new RegExp(`singularity-flow recover TASK-1 --phase ${phaseId}`));
      assert.deepEqual(await f.stop(), {}, 'an unchanged failed read must not trigger completion retries');
    }
    assert.equal(await readFile(file, 'utf8'), content);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
  });
});

test('only an explicit read-only staging correction continues the current read task', async t => {
  const f = await fixture(t);
  const attemptedPath = path.join(f.root, 'singularity-flow/source-reviews/report.json');
  const issuedPath = path.join(f.root, '.git/singularity-flow/source-reviews/report.json');
  const correction = { permissionDecision: 'deny',
    permissionDecisionReason: `PHASE_MUTATION_STAGING_PATH_MISMATCH: read the issued staging file at exactly ${issuedPath}.`,
    pathCorrections: [{ attemptedPath, issuedPath, operation: 'read' }] };
  const payload = { ...f.payload, toolName: 'Read', toolArgs: { path: attemptedPath } };
  assert.equal(recoverableWorkflowReadFailure(payload, correction), true);
  await f.arm();
  const result = await repositoryToolFailure({ ...payload, error: correction });
  assert.ok(result.additionalContext.includes(issuedPath), 'the correction must carry the actual issued path');
  assert.equal((await f.stop()).decision, 'block');
  for (const operation of ['write', 'unknown']) {
    const denied = { ...correction, pathCorrections: [{ ...correction.pathCorrections[0], operation }] };
    assert.equal(recoverableWorkflowReadFailure(payload, denied), false);
  }
  assert.equal(recoverableWorkflowReadFailure({ ...payload, toolName: 'edit' }, correction), false);
  assert.equal(recoverableWorkflowReadFailure(payload, { ...correction, pathCorrections: [] }), false);
});

test('human gates and permissions retain their route; ready is incomplete until publication is observed', async t => {
  const f = await fixture(t);
  const result = { resultType: 'sflow-phase-prepublish', workId: 'TASK-1', phase: 'planning', generation: 1,
    status: 'correction-required', correction: { sameTurn: false },
    commandGuidance: { next: safeCommandGuidance({ argv: ['decisions', 'TASK-1', '--for-agent', '--json'] }) } };
  await f.arm(); await recordPhaseTaskCheck(f.root, result);
  assert.deepEqual(await f.stop(), {});
  let saved = JSON.parse(await readFile(f.mutationFile));
  assert.equal(saved.taskOperation.nextAction.copilotCommand, '/sf-decide TASK-1');
  await f.start(); await f.arm();
  const denied = await repositoryToolGuard({ ...f.payload, toolName: 'edit', toolArgs: { path: f.workflowFile, old_str: 'x', new_str: 'y' } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.deepEqual(await f.stop(), {});
  await f.start(); await f.arm();
  await recordPhaseTaskCheck(f.root, { ...result, status: 'ready',
    commands: { publish: 'singularity-flow phase publish planning --authored human --channel manual-in-place' } });
  assert.deepEqual(await f.stop(), {}, 'the checkpoint cannot impersonate human authorship');
  // A real failure earlier in the turn is superseded by a later check that gives the author its own repair.
  await f.start(); await f.arm();
  await repositoryToolFailure({ ...f.payload, toolName: 'read', toolArgs: { path: f.workflowFile },
    error: { code: 'EACCES', message: 'EACCES: permission denied' } });
  await recordPhaseTaskCheck(f.root, { ...result, correction: { sameTurn: true },
    commandGuidance: { next: safeCommandGuidance({ argv: ['phase', 'prepublish', 'planning', '--for-agent', '--json'] }) } });
  saved = JSON.parse(await readFile(f.mutationFile));
  assert.deepEqual([saved.taskOperation.state, saved.taskOperation.blocked, saved.taskOperation.failure], ['repair-draft', false, undefined]);
  assert.equal((await f.stop()).decision, 'block', 'the author\'s own repair keeps the task continuable');
  await f.start(); await f.arm();
  const publication = 'singularity-flow phase publish planning --authored governed-agent --channel copilot-host';
  await recordPhaseTaskCheck(f.root, { ...result, workId: 'OTHER-STORY', status: 'ready', commands: { publish: publication } });
  assert.equal(JSON.parse(await readFile(f.mutationFile)).taskOperation.state, 'author-draft', 'another Story cannot complete this task');
  await recordPhaseTaskCheck(f.root, { ...result, status: 'ready', commands: { publish: publication } });
  saved = JSON.parse(await readFile(f.mutationFile));
  assert.equal(saved.taskOperation.complete, false, 'prepublish readiness is not completion');
  const stop = await f.stop();
  assert.ok(stop.reason.includes(publication));
  f.phase.generation = 1;
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await refreshMutationContracts(f.root, f.accepted);
  assert.equal(JSON.parse(await readFile(f.mutationFile)).taskOperation.complete, false, 'a generation number alone is not publication');
  f.phase.generationPublications = [{ generation: 1, record: { path: 'context/planning-gen1.json' } }];
  await writeFile(f.workflowFile, JSON.stringify(f.workflow));
  await refreshMutationContracts(f.root, f.accepted);
  assert.deepEqual(await f.stop(), {}, 'an observed completed generation ends the author task');
  assert.equal(JSON.parse(await readFile(f.mutationFile)).taskOperation.complete, true);
});

test('an authorized successor preparation stays in the task but cannot draft before refreshed admission', async t => {
  const f = await fixture(t);
  const successor = phaseTaskCompletion({ ...f.entry, status: 'successor-preparation-required',
    authoringAllowed: false, authoringProgress: null, authoring: { entry: { status: 'successor-preparation-required' } },
    successor: { targetGeneration: 1, preparation: safeCommandGuidance({ argv: ['prepare', 'planning'] }) } });
  assert.equal(successor.state, 'prepare-successor');
  await f.arm({ ...f.entry, status: 'successor-preparation-required',
    authoringAllowed: false, authoringProgress: null, authoring: { entry: { status: 'successor-preparation-required' } },
    successor: { targetGeneration: 1, preparation: safeCommandGuidance({ argv: ['prepare', 'planning'] }) } });
  const stopped = await f.stop();
  assert.match(stopped.reason, /returned successor preparation, singularity-flow prepare planning/);
  assert.match(stopped.reason, /refresh phase entry once before authoring/);
  assert.equal(JSON.parse(await readFile(f.mutationFile)).taskOperation.complete, false);
});

test('old prompts that entered without composition continue at their missing context step once', async t => {
  const f = await fixture(t);
  await f.arm({ ...f.entry, contextComposition: 'not-requested' });
  const stopped = await f.stop();
  assert.match(stopped.reason, /The admitted entry did not compose context/);
  assert.match(stopped.reason, /phase enter planning --work-id TASK-1 --compose/);
  assert.deepEqual(await f.stop(), {});
});

test('pause, cancellation, native prompts, expired or changed bindings and explicit steps are not continued', async t => {
  const f = await fixture(t);
  await f.arm();
  assert.deepEqual(await f.stop({ stopReason: 'cancelled' }), {});
  assert.deepEqual(await f.stop({ stop_hook_active: true }), {});
  await setCopilotPaused(true); assert.deepEqual(await f.stop(), {}); await setCopilotPaused(false);
  await f.start(); await f.arm();
  await writeFile(f.workflowFile, `${JSON.stringify(f.workflow)}\n`);
  assert.deepEqual(await f.stop(), {}, 'input changes need a fresh binding, never a guessed completion');
  await f.start('/sf-phase status planning'); await f.arm();
  assert.deepEqual(await f.stop(), {});
  await f.start('/sf-approve planning'); await f.arm();
  assert.deepEqual(await f.stop(), {});
  await f.start(); await f.arm();
  const stale = JSON.parse(await readFile(f.mutationFile));
  stale.recordedAt = Date.now() - 31 * 60_000;
  await writeFile(f.mutationFile, JSON.stringify(stale));
  assert.deepEqual(await f.stop(), {});
  await f.start('Ordinary native chat'); assert.deepEqual(await f.stop(), {});
  await endRepositoryBoundaryTurn(f.payload); assert.deepEqual(await f.stop(), {});
});

test('a real phase-entry command exports the same task checkpoint without running an author or model', async t => {
  const { cli } = await startedSpecificationStory(t, 'TASK-ENTRY');
  const value = completeAgentResult(cli('phase', 'enter', '--for-agent', '--json').stdout);
  assert.ok(value.taskCompletion, JSON.stringify({ ready: value.ready, status: value.status,
    authoring: value.authoring, authoringProgress: value.authoringProgress, phase: value.phase }));
  assert.equal(value.taskCompletion.revision, 'workflow-task-completion-v1');
  assert.equal(value.taskCompletion.workId, 'TASK-ENTRY');
  assert.equal(value.taskCompletion.generation, 1);
  assert.equal(value.taskCompletion.complete, false);
  assert.equal(value.effects.testsRun, false);
  assert.equal(value.effects.storyAdvanced, false);
});

test('a real author task survives CLI refresh and completes only after guarded publication', async t => {
  const id = 'TASK-PUBLISH';
  const f = await startedSpecificationStory(t, id, { configure(configuration) {
    configuration.phases.specification.clarification = { mode: 'off' };
  } });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(f.directory, 'machine', 'mode.json');
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
  });
  const hook = { cwd: f.root, sessionId: 'real-author-task', prompt: '/sf-phase' };
  const apiEntry = await enterPhase({ cwd: f.root });
  assert.equal(apiEntry.taskCompletion.state, 'load-context', 'direct API consumers receive the same checkpoint');
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record,
    { resolveRoot: async () => f.root }) });
  await repositoryToolGuard({ ...hook, toolName: 'bash', toolArgs: {
    command: 'singularity-flow phase enter --compose --for-agent --json'
  } });
  const entry = completeAgentResult(f.cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  assert.equal(entry.taskCompletion.state, 'author-draft', JSON.stringify(entry.taskCompletion));
  const stopped = await repositoryAgentStop({ ...hook, stopReason: 'end_turn' });
  assert.equal(stopped.decision, 'block');
  await writeFile(path.join(f.item, 'artifacts/specification/spec.md'), specification(id, 1));
  const published = completeAgentResult(f.cli('phase', 'prepublish', 'specification', '--for-agent', '--json', '--publish-if-ready').stdout);
  assert.equal(published.publishIfReady?.published, true, JSON.stringify(published.findings));
  assert.deepEqual(await repositoryAgentStop({ ...hook, stopReason: 'end_turn' }), {});
  const state = JSON.parse(await readFile(path.join(f.item, 'workflow.json')));
  assert.equal(state.currentPhase, 'specification', 'authoring never submits, approves or starts the next phase');
  assert.equal(state.phases.specification.generation, 1);
  assert.equal(state.phases.specification.approvals.length, 0);
});

test('another chat entering the same phase does not arm a task that never entered', async t => {
  const f = await fixture(t);
  const other = { ...f.payload, sessionId: 'other-author' };
  await recordRepositoryBoundaryTurn(other, { captureMutation: (payload, record) => captureMutationTurn(payload, record,
    { resolveRoot: async () => f.root, load: async () => f.accepted }) });
  await repositoryToolGuard({ ...other, toolName: 'bash', toolArgs: {
    command: 'singularity-flow phase enter planning --for-agent --json'
  } });
  await recordPhaseTaskProgress(f.root, phaseTaskCompletion(f.entry));
  assert.deepEqual(await f.stop(), {});
  assert.equal((await repositoryAgentStop({ ...other, stopReason: 'end_turn' })).decision, 'block');
});
