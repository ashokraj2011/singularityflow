import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { parseModelFreeTarget } from '../src/model-free-commands.mjs';
import { decisionInputPrompt } from '../apps/vscode/src/decisions.ts';
import { unsavedRepositoryPaths } from '../apps/vscode/src/generation-guards.ts';

const source = await readFile(new URL('../apps/vscode/src/lifecycle-chat.ts', import.meta.url), 'utf8');
function action(argv, overrides = {}) {
  return { actionId: 'b'.repeat(24), timing: 'now', executable: true, argv,
    command: `singularity-flow ${argv.join(' ')}`, reason: 'Reviewed action', skill: null,
    confirmation: { required: true }, ...overrides };
}
function host({ kind = 'submit', cancel = false, moved = false, paused = false, fail = false, inputs = [], actions = null, dirty = false,
  convergence = null, reviewConfirmed = true, publicationReadiness = null } = {}) {
  const calls = [], markdown = [], warnings = [], approvalRequests = [], refreshes = [];
  const token = { isCancellationRequested: false };
  const controller = new AbortController();
  const defaultArgv = kind === 'publish'
    ? ['phase', 'publish', 'custom-build', '--authored', 'governed-agent', '--channel', 'copilot-host']
    : kind === 'approve' ? ['approve', 'custom-build', '--work-id', 'STORY-1', '--fetch'] : ['submit', 'custom-build'];
  let confirmed = false;
  const client = {
    repository: '/repo',
    async run(argv) {
      calls.push(argv);
      if (argv.includes('--submission-readiness')) return { phaseId: 'custom-build', lifecycleReady: true, decisionInputs: inputs };
      if (argv[0] === 'status') return { workItem: { id: 'STORY-1' }, currentPhase: 'custom-build', phases: { 'custom-build': { generation: 2 } } };
      if (argv[0] === 'nextsteps') return { actions: [{ command: 'singularity-flow status --json' }] };
      if (argv[1] === 'plan') return { planId: 'a'.repeat(24), subject: { kind: 'story', id: 'STORY-1' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: { head: 'c'.repeat(40) },
        publicationReadiness, actions: actions ?? [action(defaultArgv)] };
      if (argv[1] === 'authorize') return { token: 'private-one-time-token' };
      throw new Error(argv.join(' '));
    },
    async runText(argv) { calls.push(argv); if (fail) throw new Error('PLAN_STALE: repository bytes changed');
      if (argv[0] === 'story' && !argv.includes('--confirm')) return convergence ?? 'no digest';
      return 'completed'; }
  };
  const vscode = { workspace: { textDocuments: dirty ? [{ isDirty: true, uri: { scheme: 'file', fsPath: '/repo/code.js' } }] : [] },
    commands: { async executeCommand(id) { refreshes.push(id); } }, window: {
      async showQuickPick(items) { return items[0]; },
      async showInputBox() { return '90'; }
    } };
  const exports = {};
  const scope = vm.createContext({ exports, Date, Set, Object, Number, Error, require(name) {
    if (name === 'vscode') return vscode;
    if (name === './actions.ts') return { async approveWithReceipt(_client, request, _output, canContinue) {
      approvalRequests.push(request); confirmed = true;
      return !cancel && await canContinue();
    } };
    if (name === './copilot-command.ts') return { commandGuidance: safeCommandGuidance };
    if (name === './decisions.ts') return { decisionInputPrompt };
    if (name === './generation-guards.ts') return { unsavedRepositoryPaths };
    if (name === '../../../src/model-free-commands.mjs') return { parseModelFreeTarget };
    if (name === './compact-message.ts') return { async showCompactWarningMessage(...args) {
      warnings.push(args); confirmed = true; return cancel ? undefined : 'Run exact action';
    } };
    if (name === './views/review-confirmation.ts') return { collectReviewConfirmation: async () => {
      confirmed = true; return reviewConfirmed;
    } };
    throw new Error(name);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, scope);
  const session = async () => ({ client, editorRoot: moved && confirmed ? '/other' : '/repo', workId: 'STORY-1', phaseId: 'custom-build' });
  const run = (command = kind, prompt = '') => exports.runLifecycleChat(command, prompt, {
    markdown: (value) => markdown.push(value), progress() {}
  }, token, controller.signal, session, () => paused && confirmed, { appendLine() {} });
  return { ...exports, run, calls, markdown, warnings, approvalRequests, refreshes, token, controller };
}

test('model-free submit and publish use one exact plan, authorization and execution', async () => {
  for (const kind of ['submit', 'publish']) {
    const h = host({ kind });
    await h.run();
    assert.equal(h.warnings.length, 1);
    assert.equal(h.calls.filter(argv => argv[1] === 'authorize').length, 1);
    const execution = h.calls.find(argv => argv[1] === 'execute');
    assert.equal(execution[execution.indexOf('--authorization') + 1], 'private-one-time-token');
    assert.equal(h.calls.filter(argv => argv[1] === 'execute').length, 1);
    assert.match(h.markdown.join(''), /command completed/);
    assert.deepEqual(h.refreshes, ['singularityFlow.refresh']);
  }
});

test('approval uses the native exact human receipt flow, never generic action execute', async () => {
  const h = host({ kind: 'approve' });
  await h.run('approve', 'custom-build --work-id STORY-1');
  assert.equal(h.approvalRequests.length, 1);
  assert.equal(h.approvalRequests[0].expected, 'custom-build');
  assert.equal(h.calls.some(argv => ['authorize', 'execute'].includes(argv[1])), false);
});

test('cancellation, pause and workspace switches cannot authorize or execute', async () => {
  for (const option of ['cancel', 'paused', 'moved']) {
    const h = host({ [option]: true });
    await h.run();
    assert.equal(h.calls.some(argv => ['authorize', 'execute'].includes(argv[1])), false, option);
    assert.doesNotMatch(h.markdown.join(''), /command completed/);
  }
  const h = host(); h.token.isCancellationRequested = true;
  await h.run(); assert.equal(h.calls.length, 0);
});

test('mismatched target, arbitrary flags and unsaved buffers stop before any lifecycle write', async () => {
  for (const prompt of ['other-phase', 'custom-build --work-id OTHER', 'custom-build --allow-dirty']) {
    const h = host(); await assert.rejects(() => h.run('submit', prompt));
    assert.equal(h.calls.some(argv => argv[0] === 'action'), false);
  }
  const h = host({ dirty: true }); await assert.rejects(() => h.run(), /Save the edited repository buffers/);
  assert.equal(h.calls.length, 0);
});

test('continue only offers legal lifecycle actions, never authoring, waivers, or hidden bypass flags', async () => {
  const h = host({ actions: [action(['prepare', 'custom-build']), action(['submit', 'custom-build', '--skip-checks'])] });
  await h.run('continue');
  assert.match(h.markdown.join(''), /No currently executable/);
  assert.equal(h.calls.some(argv => ['authorize', 'execute'].includes(argv[1])), false);
  const valid = host(); await valid.run('continue');
  assert.equal(valid.calls.filter(argv => argv[1] === 'execute').length, 1);
});

test('custom-workflow decision values enter the hashed plan before review, and stale failure is not retried', async () => {
  const h = host({ fail: true, inputs: [{ name: 'pass', type: 'choice', values: ['yes', 'no'] }] });
  await assert.rejects(() => h.run(), /PLAN_STALE/);
  const plan = h.calls.find(argv => argv[1] === 'plan');
  assert.equal(plan[plan.indexOf('--decision') + 1], 'pass=yes');
  assert.equal(h.calls.filter(argv => argv[1] === 'execute').length, 1);
  assert.doesNotMatch(h.markdown.join(''), /command completed/);
});

test('custom phase selectors are exact and protected commands cannot be smuggled through a plan', () => {
  const h = host();
  for (const argv of [['submit', 'different'], ['approve', 'custom-build', '--work-id', 'OTHER'],
    ['phase', 'publish', 'custom-build', '--skip-checks'], ['appeal', 'risk-accept'], ['next'],
    ['submit', 'custom-build', '--work-id', 'OTHER']]) {
    assert.equal(h.lifecycleActionKind(action(argv), 'custom-build', 'STORY-1'), null);
  }
  assert.equal(h.lifecycleActionKind(action(['story', 'advance', '--work-id', 'STORY-1']), 'custom-build', 'STORY-1'), 'submit');
  assert.equal(h.lifecycleActionKind(action(['submit', 'custom-build'], { timing: 'then' }), 'custom-build', 'STORY-1'), null);
});

test('convergence submission requires one exact digest and human confirmation, without generic submit', async () => {
  const actions = [action(['story', 'advance', '--work-id', 'STORY-1'])];
  const digest = 'd'.repeat(64);
  const h = host({ actions, convergence: `Reviewed snapshot\nConfirmation digest: ${digest}\n` });
  await h.run();
  const writes = h.calls.filter(argv => argv[0] === 'story' && argv.includes('--confirm'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].at(-1), digest);
  assert.equal(h.calls.some(argv => argv[1] === 'execute' || argv[0] === 'submit'), false);
  for (const option of ['cancel', 'moved', 'paused', 'missing-digest']) {
    const rejected = host({ actions, convergence: option === 'missing-digest' ? 'absent' : `Confirmation digest: ${digest}\n`,
      reviewConfirmed: option !== 'cancel', moved: option === 'moved', paused: option === 'paused' });
    if (option === 'missing-digest') await assert.rejects(() => rejected.run(), /No exact convergence review digest/);
    else await rejected.run();
    assert.equal(rejected.calls.some(argv => argv[0] === 'story' && argv.includes('--confirm')), false, option);
  }
});

test('blocked publication shows exact findings and recheck routes without exposing test argv or authorizing a write', async () => {
  const h = host({ kind: 'publish', actions: [], publicationReadiness: {
    status: 'correction-required', findings: [{ code: 'artifact.placeholder.unresolved', message: 'Replace the unfinished summary.' }],
    commands: { recheck: 'singularity-flow phase prepublish custom-build --json' }
  } });
  await h.run();
  assert.match(h.markdown.join(''), /artifact.placeholder.unresolved/);
  assert.match(h.markdown.join(''), /phase prepublish custom-build/);
  assert.equal(h.calls.some(argv => ['authorize', 'execute'].includes(argv[1])), false);
  assert.equal(h.calls.some(argv => argv[0] === 'nextsteps'), false, 'do not replace exact publication findings with a generic authoring handoff');
});
