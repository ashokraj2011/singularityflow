/**
 * Plain-chat routing, P1 and P2 (docs/SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md): in a repository that uses SFlow every
 * prompt is kept, redacted; a prompt holding what looks like a secret is refused; and a plain chat's change is
 * refused with the line to type, recorded, or let through, as the capability that owns it says.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { localAskedFor, needsAccount, noteAskedFor, redactedWords } from '../src/asked-for.mjs';
import { accountWords, appendableAskedFor, instructionAccounting, instructionWords } from '../src/asked-for-records.mjs';
import { foldCapabilityPolicy, PLAIN_CHAT_EDITS_DEFAULT, validateCapabilities } from '../src/capabilities.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { plainChatChangeGuard, plainChatEditsPolicy } from '../src/copilot-plain-chat.mjs';
import { endRepositoryBoundaryTurn, hookAnswerForEveryHost, recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { proposeProgressiveCapabilityChange } from '../src/organisation.mjs';
import { promptSecret, readPromptLog } from '../src/plain-chat-prompts.mjs';
import { removeTemporaryTree, run } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { repository as envRepository } from './helpers/environment-files-fixture.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
// Made up for these tests: the shapes of credentials, never real ones.
const TOKEN = `ghp_${'PCRTESTFAKE'}${'Q'.repeat(29)}`;
const ACCESS_KEY = `AKIA${'PCRTESTFAKE1234Z'.slice(0, 16)}`;
const refused = (decision) => decision?.permissionDecision === 'deny';
const reason = (decision) => decision?.permissionDecisionReason ?? '';

/**
 * A clone that uses SFlow, its machine state in its own folder. `story` puts it on a Story's branch with the Story's
 * file and session record, at `phase` (a code step unless named otherwise); `policy` writes the repository's map.
 */
async function clone(t, { story = null, phase = 'implement', policy = null, sflow = true } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-pcr-')));
  const root = path.join(directory, 'shop');
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  await mkdir(path.join(root, 'src'), { recursive: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Routing Tester'); git('config', 'user.email', 'routing@example.test');
  await writeFile(path.join(root, 'src/retry.js'), 'export const timeout = 5;\n');
  if (sflow) {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 2\n');
  }
  if (policy) {
    await writeFile(path.join(root, 'singularity/capabilities.yml'), YAML.stringify({ version: 1, capabilities: {
      'repository-root': { kind: 'delivery', repository: 'shop', policy: { plainChatEdits: policy } } } }));
  }
  git('add', '-A'); git('commit', '-qm', 'baseline');
  if (story) {
    git('switch', '-q', '-c', story);
    const phases = {
      intake: { id: 'intake', label: 'Intake', status: 'approved', generation: 1 },
      implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 0, generationPolicy: { task: 'code', requirement: 'required' },
        generationIntent: { status: 'open', generation: 1 } }
    };
    const workflow = { workItem: { id: story, branch: story }, status: 'in_progress', currentPhase: phase, phaseOrder: ['intake', 'implement'], phases, resolution: {} };
    if (phase === 'intake') phases.intake = { ...phases.intake, status: 'in_progress', generationIntent: { status: 'open', generation: 2 } };
    await mkdir(path.join(root, 'singularity/work-items', story), { recursive: true });
    await writeFile(path.join(root, 'singularity/work-items', story, 'workflow.json'), JSON.stringify(workflow));
    git('add', '-A'); git('commit', '-qm', 'story');
    await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
    await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ workId: story }));
  }
  const prompt = (sessionId, text, extra = {}) => recordRepositoryBoundaryTurn({ sessionId, cwd: root, timestamp: Date.now(), prompt: text, ...extra },
    { captureMutation: async () => ({}) });
  const call = (sessionId, toolName, toolArgs, extra = {}) => repositoryToolGuard({ sessionId, cwd: root, toolName, toolArgs, ...extra });
  return { directory, root, git, prompt, call, machine: path.join(directory, 'machine') };
}

const edit = (file = 'src/retry.js') => ['edit', { path: file, old_str: '5', new_str: '10' }];

/** `fn` with SFlow paused on this test's own machine state only, unpaused after whatever happens. */
async function paused(repo, fn) {
  const mode = path.join(repo.machine, 'mode.json');
  await setCopilotPaused(true, mode);
  try { return await fn(); } finally { await setCopilotPaused(false, mode); }
}

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-001, REQ-002] Every prompt in a repository that uses SFlow is kept, redacted; nothing elsewhere.

test('PCR REQ-002: a prompt in a repository that uses SFlow is kept, redacted and bounded, in the clone\'s own log', async (t) => {
  const repo = await clone(t);
  assert.deepEqual(await repo.prompt('person', 'make the timeout 10s'), {});
  await repo.prompt('person', '/sf-next and push with the usual key');
  const log = await readPromptLog(path.join(repo.root, '.git'));
  assert.deepEqual(log.map((entry) => [entry.kind, entry.skill, entry.text]), [['skill', 'sf-next', '/sf-next and push with the usual key'], ['plain', null, 'make the timeout 10s']]);
  assert.ok(log.every((entry) => /^[a-f0-9]{16}$/u.test(entry.session) && entry.repository === repo.root && entry.workId === null));
  assert.ok(!JSON.stringify(log).includes('person'), 'the session is named by its key, never its ID');
  // A long prompt is cut once redacted, and a subagent's task is no person's prompt.
  await repo.prompt('person', 'x'.repeat(5000));
  await repo.prompt('person', 'rename the module', { agentId: 'subagent-1' });
  const [latest] = await readPromptLog(path.join(repo.root, '.git'));
  assert.equal(latest.text.length, 2000);
  assert.equal(latest.truncated, true);
});

test('PCR REQ-001: a repository that does not use SFlow, or no repository, keeps nothing and refuses nothing', async (t) => {
  const repo = await clone(t, { sflow: false });
  assert.deepEqual(await repo.prompt('person', `make the timeout 10s with ${TOKEN}`), {});
  assert.deepEqual(await repo.call('person', ...edit()), {});
  assert.equal(existsSync(path.join(repo.root, '.git/singularity-flow')), false);
  assert.equal(existsSync(path.join(repo.machine, 'copilot-prompts')), false);
  const outside = path.join(repo.directory, 'notes');
  await mkdir(outside);
  assert.deepEqual(await recordRepositoryBoundaryTurn({ sessionId: 'person', cwd: outside, prompt: TOKEN }), {});
});

test('PCR REQ-002: in a Story checkout a plain prompt joins the Story\'s "Asked for", marked plain chat; it waits for no account until its turn changes something', async (t) => {
  const repo = await clone(t, { story: 'QF-1' });
  await repo.prompt('person', 'what does retry.js do?');
  const subject = { workId: 'QF-1', phase: 'implement', generation: 1 };
  let local = await localAskedFor(path.join(repo.root, '.git'), subject);
  assert.deepEqual(local.turns.map((entry) => [entry.text, entry.plainChat, entry.changed ?? false, entry.skill]), [['what does retry.js do?', true, false, null]]);
  assert.equal(needsAccount(local.turns[0]), false, 'a question changed nothing');
  const [logged] = await readPromptLog(path.join(repo.root, '.git'), { workId: 'QF-1' });
  assert.deepEqual([logged.workId, logged.phase], ['QF-1', 'implement']);
  // Under the default, record, an edit goes ahead and marks its turn's prompt.
  await repo.prompt('person', 'make the timeout 10s');
  assert.deepEqual(await repo.call('person', 'view', { path: 'src/retry.js' }), {});
  assert.deepEqual(await repo.call('person', ...edit()), {});
  assert.deepEqual(await repo.call('person', 'bash', { command: 'npm test' }), {});
  local = await localAskedFor(path.join(repo.root, '.git'), subject);
  assert.deepEqual(local.turns.map((entry) => [entry.text, entry.changed ?? false]), [['what does retry.js do?', false], ['make the timeout 10s', true]]);
  assert.equal(needsAccount(local.turns[1]), true);
  // The Story's copy keeps both marks, and only the changed one waits.
  const workflow = { askedFor: appendableAskedFor({ askedFor: [] }, 'implement', 1, local.turns) };
  const accounted = instructionAccounting(workflow, 'implement');
  assert.deepEqual(accounted.map((entry) => [entry.instruction, entry.plainChat, entry.account?.as ?? null]), [[1, true, 'plain-chat'], [2, true, null]]);
  assert.equal(instructionWords(accounted[1]), '(2) "make the timeout 10s" (plain chat)');
  assert.match(accountWords(accounted[0].account), /changed nothing/u);
});

test('PCR REQ-002: a plain chat\'s prompts have their own 20 a generation, so questions never crowd out a typed instruction', async (t) => {
  const repo = await clone(t, { story: 'QF-1' });
  const gitDir = path.join(repo.root, '.git');
  const subject = { workId: 'QF-1', phase: 'implement', generation: 1 };
  for (let turn = 0; turn < 25; turn += 1) {
    await noteAskedFor(gitDir, { ...subject, text: `question ${turn}`, skill: null, turnId: `plain-${turn}`, at: 'now', plainChat: true });
  }
  await noteAskedFor(gitDir, { ...subject, text: 'make the timeout 10s', skill: 'sf-code', turnId: 'typed-1', at: 'now' });
  const local = await localAskedFor(gitDir, subject);
  assert.equal(local.turns.filter((entry) => entry.plainChat).length, 20);
  assert.equal(local.omitted, 5);
  assert.ok(local.turns.some((entry) => entry.turnId === 'typed-1'));
  const copied = appendableAskedFor({ askedFor: [] }, 'implement', 1, local.turns);
  assert.equal(copied.length, 21);
});

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-003] A secret in a prompt.

test('PCR REQ-003: what looks like a secret is found by its kind, never its value, and prose is not', async () => {
  assert.equal(await promptSecret(`push with ${TOKEN}`), 'GitHub token');
  assert.equal(await promptSecret(`the key is ${ACCESS_KEY}`), 'AWS access key ID');
  assert.equal(await promptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n'), 'private key');
  assert.equal(await promptSecret(`token ghp_${'A'.repeat(24)}`), 'access token', 'the redactor\'s shorter token shape');
  for (const prose of ['make the timeout 10s', 'use Bearer authentication everywhere', 'why does token: expired fail?', 'password = "changeme"']) {
    assert.equal(await promptSecret(prose), null, prose);
  }
  // What the gate's rules find, the kept words never hold, even where the diagnostic redactor alone let it through.
  const kept = await redactedWords(`use ${ACCESS_KEY} and ${TOKEN}`);
  assert.ok(!kept.text.includes(ACCESS_KEY) && !kept.text.includes(TOKEN), kept.text);
});

test('PCR REQ-003: a prompt holding a secret is blocked for Copilot CLI, kept only redacted, and its turn runs nothing until the next prompt', async (t) => {
  const repo = await clone(t, { story: 'QF-1' });
  // An earlier /sf- turn's record goes with the blocked prompt.
  const turn = path.join(repo.machine, 'copilot-boundaries', `${createHash('sha256').update('person').digest('hex')}.json`);
  await mkdir(path.dirname(turn), { recursive: true });
  await writeFile(turn, '{}');
  const answer = await repo.prompt('person', `make the timeout 10s and push with ${TOKEN}`);
  assert.equal(existsSync(turn), false);
  assert.equal(answer.decision, 'block');
  assert.match(answer.reason, /^SECRET_IN_PROMPT: this prompt held what looks like a GitHub token and was not sent\. Remove it and send it again\./u);
  assert.match(answer.reason, /session log still holds/u);
  assert.ok(!answer.reason.includes(TOKEN));
  const [logged] = await readPromptLog(path.join(repo.root, '.git'));
  assert.equal(logged.secret, 'GitHub token');
  assert.ok(!JSON.stringify(logged).includes(TOKEN) && logged.text.includes('[REDACTED]'));
  // Nothing of it reaches the Story's record.
  assert.deepEqual((await localAskedFor(path.join(repo.root, '.git'), { workId: 'QF-1', phase: 'implement', generation: 1 })).turns, []);
  for (const name of await readdir(path.join(repo.machine, 'copilot-prompts'))) {
    assert.ok(!(await readFile(path.join(repo.machine, 'copilot-prompts', name), 'utf8')).includes(TOKEN));
  }
  // VS Code sent the prompt on: each tool call of that turn is refused, a read too, with the advice to rotate.
  for (const [toolName, toolArgs] of [['view', { path: 'src/retry.js' }], edit()]) {
    const decision = await repo.call('person', toolName, toolArgs);
    assert.ok(refused(decision));
    assert.match(reason(decision), /^SECRET_IN_PROMPT: the prompt held what looks like a GitHub token; it reached the model, so rotate it\. Nothing in this turn runs\..*Do not retry it$/u);
  }
  // Another session is untouched, and the next prompt ends it.
  assert.deepEqual(await repo.call('other', 'view', { path: 'src/retry.js' }), {});
  await repo.prompt('person', 'make the timeout 10s');
  assert.deepEqual(await repo.call('person', 'view', { path: 'src/retry.js' }), {});
  // A /sf- prompt is checked the same way, and paused nothing is.
  assert.equal((await repo.prompt('person', `/sf-code QF-1 use ${TOKEN}`)).decision, 'block');
  await paused(repo, async () => {
    assert.deepEqual(await repo.prompt('person', `use ${TOKEN}`), {});
    assert.deepEqual(await repo.call('person', 'view', { path: 'src/retry.js' }), {});
  });
});

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-010 to REQ-013] Every change through a skill, as the repository's setting says.

test('PCR REQ-010, REQ-011: under refuse, a code step\'s edit and writing command are refused with the /sf-code line; reads stay free', async (t) => {
  const repo = await clone(t, { story: 'QF-1', policy: 'refuse' });
  await repo.prompt('person', 'make the timeout 10s');
  for (const [toolName, toolArgs] of [['view', { path: 'src/retry.js' }], ['grep', { pattern: 'timeout', path: 'src' }],
    ['bash', { command: 'git diff' }], ['bash', { command: 'git status --short && git log --oneline -5' }], ['bash', { command: `cd ${repo.root} && git diff --stat` }],
    ['bash', { command: 'ls src' }], ['bash', { command: 'singularity-flow status --json' }], ['bash', { command: 'singularity-flow phase enter --json' }],
    ['sflow_read', { subject: 'QF-1' }], ['web_fetch', { url: 'https://example.test' }]]) {
    assert.deepEqual(await repo.call('person', toolName, toolArgs), {}, `${toolName} ${JSON.stringify(toolArgs)}`);
  }
  for (const [toolName, toolArgs] of [edit(), ['create', { path: 'src/new.js', file_text: 'x' }], ['bash', { command: 'npm test' }],
    ['bash', { command: "sed -i '' s/5/10/ src/retry.js" }], ['bash', { command: 'git commit -am fix' }], ['run_in_terminal', { command: 'echo 10 > src/retry.js' }],
    ['apply_patch', '*** Begin Patch\n*** Update File: src/retry.js\n@@\n-5\n+10\n*** End Patch\n'], ['write_bash', { input: 'rm src/retry.js\n' }],
    ['bash', { command: 'singularity-flow phase prepare implement --json' }], ['sflow_run', { plan: 'abc' }]]) {
    const decision = await repo.call('person', toolName, toolArgs);
    assert.ok(refused(decision), `${toolName} ${JSON.stringify(toolArgs)}`);
    assert.match(reason(decision), /^PLAIN_CHAT_CHANGE_REFUSED: .*the person types: \/sf-code QF-1 make the timeout 10s\. Do not retry it$/u);
    assert.equal(hookAnswerForEveryHost('boundary-guard', decision).hookSpecificOutput?.permissionDecision, 'deny', 'VS Code reads it under hookSpecificOutput');
  }
  assert.match(reason(await repo.call('person', ...edit())), /this edit to src\/retry\.js did not run/u);
  // Nothing was written into the Story's record by a refused turn but its prompt.
  const local = await localAskedFor(path.join(repo.root, '.git'), { workId: 'QF-1', phase: 'implement', generation: 1 });
  assert.deepEqual(local.turns.map((entry) => entry.changed ?? false), [false]);
});

test('PCR REQ-011: another step names /sf-phase, no Story names /sf-start, and the words are the session\'s own last prompt', async (t) => {
  const step = await clone(t, { story: 'QF-2', phase: 'intake', policy: 'refuse' });
  await step.prompt('person', 'add the retry limit to the scope');
  assert.match(reason(await step.call('person', ...edit())), /the person types: \/sf-phase QF-2 add the retry limit to the scope\. Do not retry it$/u);
  const none = await clone(t, { policy: 'refuse' });
  await none.prompt('person', 'make the timeout 10s');
  assert.match(reason(await none.call('person', ...edit())), /the person types: \/sf-start <NEW-ID> make the timeout 10s\. Do not retry it$/u);
  // Another session's words never fill this one's line.
  assert.match(reason(await none.call('stranger', ...edit())), /\/sf-start <NEW-ID> <what to change>\./u);
});

test('PCR REQ-012, REQ-013: allow lets a change through untracked; a /sf- turn and a paused machine are governed as before', async (t) => {
  const repo = await clone(t, { story: 'QF-1', policy: 'allow' });
  await repo.prompt('person', 'make the timeout 10s');
  assert.deepEqual(await repo.call('person', ...edit()), {});
  const local = await localAskedFor(path.join(repo.root, '.git'), { workId: 'QF-1', phase: 'implement', generation: 1 });
  assert.equal(local.turns[0].changed, undefined, 'allow keeps the prompt and marks nothing');
  const strict = await clone(t, { policy: 'refuse' });
  await paused(strict, async () => assert.deepEqual(await strict.call('person', ...edit()), {}, '/sf-pause turns this off'));
});

test('PCR REQ-013: the capability that owns the changed path decides; the map is read only where it can say something', async (t) => {
  const repo = await clone(t);
  assert.equal(await plainChatEditsPolicy(repo.root, 'src/retry.js'), 'record', 'no map names it: the default, with no map read');
  assert.equal(PLAIN_CHAT_EDITS_DEFAULT, 'record');
  await writeFile(path.join(repo.root, 'singularity/capabilities.yml'), YAML.stringify({ version: 1, capabilities: {
    'repository-root': { kind: 'delivery', repository: 'shop', policy: { plainChatEdits: 'record' } },
    payments: { kind: 'delivery', repository: 'shop', parent: 'repository-root', sourceRoots: ['services/payments'], policy: { plainChatEdits: 'refuse' } } } }));
  assert.equal(await plainChatEditsPolicy(repo.root, 'services/payments/charge.js'), 'refuse');
  assert.equal(await plainChatEditsPolicy(repo.root, 'src/retry.js'), 'record');
  await repo.prompt('person', 'make the charge idempotent');
  assert.ok(refused(await repo.call('person', 'create', { path: 'services/payments/charge.js', file_text: 'x' })), 'a file the call would create');
  assert.deepEqual(await repo.call('person', ...edit()), {});
  // A map that cannot be read keeps the default, and a failing check lets the call through [PCR:REQ-017].
  await writeFile(path.join(repo.root, 'singularity/capabilities.yml'), 'version: 1\ncapabilities:\n  a: { kind: nonsense, policy: { plainChatEdits: refuse } }\n');
  assert.equal(await plainChatEditsPolicy(repo.root, 'src/retry.js'), 'record');
  assert.equal(await plainChatChangeGuard({ sessionId: 'person', cwd: repo.root, toolName: 'edit', toolArgs: { path: 'src/retry.js' } },
    { policyFor: async () => { throw new Error('unreadable'); } }).catch(() => 'threw'), 'threw', 'the guard itself throws');
  assert.deepEqual(await repositoryToolGuard({ sessionId: 'person', cwd: repo.root, toolName: 'edit', toolArgs: { path: 'src/retry.js' } }), {},
    'and the hook lets the call through');
});

test('PCR REQ-010: the call\'s own path decides, never the chat\'s opening folder', async (t) => {
  const repo = await clone(t, { policy: 'refuse' });
  const elsewhere = path.join(repo.directory, 'notes');
  await mkdir(elsewhere);
  await recordRepositoryBoundaryTurn({ sessionId: 'person', cwd: elsewhere, prompt: 'make the timeout 10s' });
  assert.ok(refused(await repositoryToolGuard({ sessionId: 'person', cwd: elsewhere, toolName: 'edit', toolArgs: { path: path.join(repo.root, 'src/retry.js') } })));
  assert.ok(refused(await repositoryToolGuard({ sessionId: 'person', cwd: elsewhere, toolName: 'bash', toolArgs: { command: 'npm test', cwd: repo.root } })));
  assert.deepEqual(await repositoryToolGuard({ sessionId: 'person', cwd: repo.root, toolName: 'edit', toolArgs: { path: path.join(elsewhere, 'todo.md') } }), {});
});

test('PCR REQ-013: policy.plainChatEdits folds one way across three values', () => {
  assert.equal(foldCapabilityPolicy({}, {}).plainChatEdits, undefined, 'unset stays unset, so a pinned policy digest does not move');
  assert.equal(foldCapabilityPolicy({ plainChatEdits: 'allow' }, { plainChatEdits: 'record' }).plainChatEdits, 'record');
  assert.equal(foldCapabilityPolicy({ plainChatEdits: 'record' }, { plainChatEdits: 'refuse' }).plainChatEdits, 'refuse');
  assert.equal(foldCapabilityPolicy({ plainChatEdits: 'record' }, {}).plainChatEdits, 'record');
  for (const [parent, child] of [['refuse', 'record'], ['refuse', 'allow'], ['record', 'allow']]) {
    assert.throws(() => foldCapabilityPolicy({ plainChatEdits: parent }, { plainChatEdits: child }), { code: 'CAPABILITY_POLICY_LOOSENED' }, `${child} under ${parent}`);
  }
  assert.throws(() => foldCapabilityPolicy({}, { plainChatEdits: 'off' }), (error) => error.code === 'CAPABILITY_POLICY_INVALID' && /refuse, record or allow/u.test(error.message));
  const map = (top, bottom) => ({ version: 1, capabilities: {
    top: { kind: 'collection', policy: top }, middle: { kind: 'collection', parent: 'top' }, bottom: { kind: 'delivery', repository: 'x', parent: 'middle', policy: bottom } } });
  assert.throws(() => validateCapabilities(map({ plainChatEdits: 'record' }, { plainChatEdits: 'allow' })),
    (error) => error.code === 'CAPABILITY_POLICY_LOOSENED' && error.details.ancestorId === 'top' && /to allow under 'top', which sets it record/u.test(error.message));
  assert.doesNotThrow(() => validateCapabilities(map({ plainChatEdits: 'allow' }, { plainChatEdits: 'refuse' })));
  // The two-value fields keep their old answers.
  assert.throws(() => foldCapabilityPolicy({ plainChatSecrets: 'refuse' }, { plainChatSecrets: 'allow' }), { code: 'CAPABILITY_POLICY_LOOSENED' });
});

test('PCR REQ-013: capability set --plain-chat-edits writes the working-tree map, and capability show says what applies', async (t) => {
  const repo = await envRepository(t, { declaration: null, files: { 'singularity/workflow.yml': 'version: 2\n',
    'singularity/capabilities.yml': 'version: 1\ncapabilities:\n  shop: { kind: delivery, repository: shop, parent: null }\n' } });
  const environment = { ...repo.env, HOME: repo.base, SINGULARITY_FLOW_HOME: path.join(repo.base, 'home') };
  const set = (value) => repo.sflow(['capability', 'set', 'shop', '--plain-chat-edits', value, '--json'], { env: environment });
  const map = () => YAML.parse(readFileSync(path.join(repo.root, 'singularity/capabilities.yml'), 'utf8')).capabilities.shop.policy;
  assert.equal(set('refuse').status, 0);
  assert.equal(map().plainChatEdits, 'refuse');
  assert.equal(await plainChatEditsPolicy(repo.root, 'src/a.js'), 'refuse');
  assert.equal(set('inherit').status, 0);
  assert.equal(map()?.plainChatEdits, undefined);
  const wrong = set('sometimes');
  assert.notEqual(wrong.status, 0);
  assert.match(`${wrong.stdout}${wrong.stderr}`, /--plain-chat-edits must be inherit, refuse, record, or allow/u);
  assert.equal(set('allow').status, 0);
  // capability show reads a whole workflow definition.
  await rm(path.join(repo.root, 'singularity/workflow.yml'));
  await initializeDefinition(repo.root);
  const shown = repo.json(['capability', 'show', '.'], { env: environment });
  assert.equal(shown.value.plainChatEdits, 'allow');
  assert.match(repo.sflow(['capability', 'show', '.'], { env: environment }).stdout, /Changes in a plain Copilot chat:\n {2}go ahead/u);
});

test('PCR REQ-013: capability plain-chat proposes --edits for review, and leaves the setting it was not given as it is', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-pcr-proposal-')));
  t.after(() => removeTemporaryTree(base));
  const lead = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(base, 'leads.json');
  t.after(() => { if (lead === undefined) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY; else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = lead; });
  const bare = path.join(base, 'platform.git');
  const seed = path.join(base, 'seed');
  run('git', ['init', '-q', '-b', 'main', '--bare', bare], { cwd: base });
  run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: seed });
  run('git', ['config', 'user.name', 'A B'], { cwd: seed });
  await writeFile(path.join(seed, 'README.md'), '# platform\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'Initial'], { cwd: seed });
  run('git', ['push', '-q', bare, 'main:main'], { cwd: seed });
  // A team's capability, reviewed in first, as a capability proposal is.
  const review = path.join(base, 'review');
  run('git', ['clone', '-q', '--no-local', bare, review]);
  const merge = (proposal) => {
    run('git', ['fetch', '-q', 'origin'], { cwd: review });
    run('git', ['switch', '-q', proposal.baseBranch], { cwd: review });
    run('git', ['reset', '-q', '--hard', `origin/${proposal.baseBranch}`], { cwd: review });
    run('git', ['merge', '-q', '--ff-only', `origin/${proposal.branch}`], { cwd: review });
    run('git', ['push', '-q', 'origin', `HEAD:${proposal.baseBranch}`], { cwd: review });
  };
  merge(await proposeProgressiveCapabilityChange(bare, { operation: 'add', capabilityId: 'payments', name: 'Payments', ownership: 'services/payments/**' }));
  const proposed = async (change) => {
    const proposal = await proposeProgressiveCapabilityChange(bare, { operation: 'plain-chat', capabilityId: 'payments', ...change });
    return { proposal, policy: YAML.parse(run('git', ['show', `${proposal.commit}:singularity/capabilities.yml`], { cwd: bare }).stdout).capabilities.payments.policy ?? {} };
  };
  const both = await proposed({ plainChatEdits: 'refuse', plainChatSecrets: 'allow' });
  assert.equal(both.proposal.reviewRequired, true);
  assert.deepEqual([both.policy.plainChatEdits, both.policy.plainChatSecrets], ['refuse', 'allow']);
  assert.equal(both.proposal.receipt.parameters.plainChatEdits, 'refuse');
  merge(both.proposal);
  const edits = await proposed({ plainChatEdits: 'record' });
  assert.deepEqual([edits.policy.plainChatEdits, edits.policy.plainChatSecrets], ['record', 'allow']);
  assert.equal('plainChatSecrets' in edits.proposal.receipt.parameters, false, 'only what was named is in the receipt');
  await assert.rejects(proposeProgressiveCapabilityChange(bare, { operation: 'plain-chat', capabilityId: 'payments' }), { code: 'CAPABILITY_POLICY_INVALID' });
});

// ---------------------------------------------------------------------------------------------------
// [PCR:REQ-015, REQ-016] The launchers: a repository that uses SFlow goes to Node, and a plain prompt ends a stale turn first.

async function launcherHost(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-pcr-launcher-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'host-bin');
  await mkdir(bin);
  const started = path.join(directory, 'node-started');
  const input = path.join(directory, 'node-input');
  await writeFile(path.join(bin, 'node'), `#!/bin/sh\ncat > '${input}'\necho started >> '${started}'\necho '{}'\n`, { mode: 0o755 });
  await symlink(path.join(packageRoot, 'bin/singularity-flow.mjs'), path.join(bin, 'singularity-flow'));
  const machine = path.join(directory, 'machine');
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/sbin`, SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(machine, 'mode.json'),
    SINGULARITY_FLOW_ENGINE_HOME: path.join(directory, 'no engine') };
  const starts = () => (existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter(Boolean).length : 0);
  // A clone that uses SFlow, a linked checkout of it, a clone that does not, and a folder in none.
  const sflowClone = path.join(directory, 'shop');
  spawnSync('git', ['init', '-q', '-b', 'main', sflowClone]);
  await mkdir(path.join(sflowClone, 'singularity'));
  await writeFile(path.join(sflowClone, 'singularity/workflow.yml'), 'version: 2\n');
  spawnSync('git', ['-C', sflowClone, '-c', 'user.name=L', '-c', 'user.email=l@example.test', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const linked = path.join(directory, 'shop-qf-1');
  spawnSync('git', ['-C', sflowClone, 'worktree', 'add', '-q', '-b', 'QF-1', linked]);
  await rm(path.join(linked, 'singularity'), { recursive: true, force: true });
  await mkdir(path.join(sflowClone, '.git/singularity-flow'), { recursive: true });
  const plainClone = path.join(directory, 'plain');
  spawnSync('git', ['init', '-q', '-b', 'main', plainClone]);
  return { directory, env, starts, machine, input, sflowClone, linked, plainClone };
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function assertLauncher(host, launch) {
  const sends = (payload) => { const before = host.starts(); launch('boundary-guard', JSON.stringify(payload)); return host.starts() > before; };
  const view = (cwd) => ({ sessionId: 'plain', cwd, toolName: 'view', toolArgs: { path: 'README.md' } });
  assert.ok(sends(view(host.sflowClone)), 'a clone that uses SFlow');
  assert.ok(sends(view(path.join(host.sflowClone, 'src', 'not-there-yet'))), 'a folder inside it');
  assert.ok(sends(view(host.linked)), 'a linked checkout, by its common Git directory');
  assert.ok(!sends(view(host.plainClone)), 'a clone that does not use SFlow starts no Node');
  assert.ok(!sends(view(path.join(host.directory, 'nowhere'))), 'nor a folder in no repository');
  // The prompt hook: a plain prompt ends the session's turn before Node starts; a skill prompt or a continuation is the runtime's.
  const key = sha256('chat-1');
  const records = [path.join(host.machine, 'copilot-boundaries', `${key}.json`), path.join(host.machine, 'copilot-boundaries', `${key}.mutation.json`)];
  const copy = path.join(host.machine, 'copilot-prompts', `${key}.json`);
  const other = path.join(host.machine, 'copilot-boundaries', `${sha256('chat-2')}.json`);
  const seed = async () => {
    await mkdir(path.dirname(copy), { recursive: true });
    await mkdir(path.dirname(other), { recursive: true });
    for (const file of [...records, copy, other]) await writeFile(file, '{}');
  };
  const present = () => [...records, copy, other].map((file) => existsSync(file));
  await seed();
  const plain = JSON.stringify({ sessionId: 'chat-1', cwd: host.sflowClone, prompt: 'make the timeout 10s' });
  launch('boundary-turn', plain);
  assert.deepEqual(present(), [false, false, false, true], 'the session\'s turn and copy go; another session\'s turn stays');
  assert.equal(readFileSync(host.input, 'utf8'), plain, 'Node reads the prompt as the host sent it');
  await seed();
  launch('boundary-turn', JSON.stringify({ sessionId: 'chat-1', cwd: host.sflowClone, prompt: '/sf-code QF-1 make the timeout 10s' }));
  assert.deepEqual(present(), [true, true, false, true], 'a skill prompt keeps its turn for the runtime');
  await seed();
  launch('boundary-turn', JSON.stringify({ sessionId: 'chat-1', cwd: host.sflowClone, prompt: 'SFLOW_SOURCE_REVIEW_INCOMPLETE: continue' }));
  assert.deepEqual(present(), [true, true, true, true], 'a continuation reads the turn it continues');
  launch('boundary-turn', JSON.stringify({ sessionId: 'chat-1', agentId: 'explore-1', cwd: host.sflowClone, prompt: 'look for the helper' }));
  assert.deepEqual(present(), [true, true, true, true], 'a subagent\'s task shares the person\'s session and ends nothing of it');
}

test('PCR REQ-015, REQ-016: the bash launcher sends a repository that uses SFlow to Node and ends a stale turn before Node starts', { skip: process.platform === 'win32' }, async (t) => {
  const host = await launcherHost(t);
  await assertLauncher(host, (action, input) => {
    const result = spawnSync('/bin/bash', [path.join(packageRoot, 'plugin/hook-launcher.sh'), action], { cwd: host.directory, env: host.env, input, encoding: 'utf8', timeout: childTimeout(30_000) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });
});

test('PCR REQ-015, REQ-016: the PowerShell launcher agrees', {
  skip: (process.platform === 'win32' || spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '1'], { encoding: 'utf8', timeout: childTimeout(15_000) }).status !== 0) && 'PowerShell host unavailable'
}, async (t) => {
  const host = await launcherHost(t);
  const pwsh = (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'pwsh')).find((file) => existsSync(file));
  await assertLauncher(host, (action, input) => {
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'plugin/hook-launcher.ps1'), action],
      { cwd: host.directory, env: host.env, input, encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)), {});
  });
});

test('PCR REQ-003: a subagent\'s task keeps the person\'s copy and its secret; a skill turn is judged by what was typed after it', async (t) => {
  const repo = await clone(t);
  await repo.prompt('person', `use ${TOKEN}`);
  await repo.prompt('person', 'look for the retry helper', { agentId: 'explore-1' });
  assert.ok(refused(await repo.call('person', 'view', { path: 'src/retry.js' })), 'the subagent\'s task left the secret standing');
  // A host's expanded skill text is the skill's, not the person's: only its ARGUMENTS are read for a secret.
  const expanded = `<skill-context name="sf-next">Run the next step. Example: password = "${'Xq7#mA2kL9pR4tW8'}"\nARGUMENTS: what next\n</skill-context>`;
  assert.deepEqual(await repo.prompt('person', expanded), {});
  assert.equal((await repo.prompt('person', `<skill-context name="sf-next">Run it.\nARGUMENTS: push with ${TOKEN}\n</skill-context>`)).decision, 'block');
});

test('PCR REQ-016: a session that ends takes its prompt copy with it', async (t) => {
  const repo = await clone(t);
  await repo.prompt('person', `use ${TOKEN}`);
  assert.equal((await readdir(path.join(repo.machine, 'copilot-prompts'))).length, 1);
  await endRepositoryBoundaryTurn({ sessionId: 'person', cwd: repo.root });
  assert.deepEqual(await readdir(path.join(repo.machine, 'copilot-prompts')), []);
});
