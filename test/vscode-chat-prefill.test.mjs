/**
 * The next SFlow command, put in Copilot Chat's input box (apps/vscode/src/chat-prefill.ts).
 *
 * The model reads the journey's next action from a snapshot; the controller decides when to fill.
 * Both run here against a stub host with a hand-driven clock, so every guard is pinned: a fill per
 * changed state and no repeat, nothing for a terminal-only or someone else's step, the setting,
 * the button, typing, the person's own text in the chat box, an @sflow answer still running and
 * a prompt the extension sent itself. vscode-host.test.mjs drives the shipped bundle end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  CHAT_INPUT_SCHEMES, ChatPrefill, copilotTurnOpen, isChatRoute, nextChatPrefill, TURN_STALE_MS, participantRequestEnded, participantRequestStarted, PREFILL_COMMAND, PREFILL_SETTING
} = await import(pathToFileURL(path.join(packageRoot, 'apps', 'vscode', 'src', 'chat-prefill.ts')).href);

const phase = (id, label, status, generation) => ({ id, label, status, generation, artifacts: [], approvals: [] });
const BASE = { lifecycleReady: false, draftExists: false, draftModified: false, publicationRecorded: false, currentGeneration: 0, publishedGeneration: null };

function story({ id = 'STORY-1', current = 'code', status = 'in_progress', generation = 0, readiness = {}, workflow = {} } = {}) {
  return {
    included: ['repository', 'lifecycle'],
    workflow: {
      workItem: { id, title: 'Prefill', branch: id }, currentPhase: current, phaseOrder: [current],
      phases: { [current]: phase(current, current[0].toUpperCase() + current.slice(1), status, generation) },
      status: 'in_progress', ...workflow
    },
    submissionReadiness: { ...BASE, phaseId: current, ...readiness }
  };
}

const generation = (extra = {}) => story({ readiness: {
  classification: 'generation-required', reasonCode: 'PHASE_GENERATION_REQUIRED', nextSkill: '/sf-code', nextCommand: 'singularity-flow prepare code'
}, ...extra });
const submit = () => story({ generation: 1, readiness: {
  lifecycleReady: true, publicationRecorded: true, publishedGeneration: 1, currentGeneration: 1, classification: 'ready-to-attempt',
  reasonCode: 'SUBMISSION_READY', nextSkill: '/sf-submit', nextCommand: 'singularity-flow submit code --work-id STORY-1'
} });
const awaiting = (sheet) => story({ status: 'awaiting_approval', generation: 1, readiness: {
  publicationRecorded: true, classification: 'already-submitted', reasonCode: 'PHASE_ALREADY_SUBMITTED',
  nextCommand: 'singularity-flow approve code --work-id STORY-1 --fetch', nextSkill: '/sf-approve', sheet
} });
const terminalOnly = () => story({ generation: 1, readiness: {
  publicationRecorded: true, classification: 'publication-record-missing', reasonCode: 'PHASE_PUBLICATION_RECORD_MISSING',
  nextCommand: 'singularity-flow doctor --json', nextSkill: null
} });

test('the next command comes from the journey and the engine crosswalk, never from a guess', () => {
  const code = nextChatPrefill(generation());
  assert.equal(code.command, '/sf-code');
  assert.equal(code.head, '/sf-code');
  assert.equal(code.freshChat, false);
  assert.match(code.label, /Generate and publish/);
  const submission = nextChatPrefill(submit());
  assert.equal(submission.command, '/sf-submit');
  assert.equal(submission.freshChat, true, 'submission reads its own packet: the button says a new chat costs less');
  assert.notEqual(submission.stateKey, code.stateKey, 'a new step state is a new key');
  const approval = nextChatPrefill(awaiting({
    next: { effect: 'approves', available: true, where: { copilot: '/sf-approve code --work-id STORY-1' } }, waitingFor: null
  }));
  assert.equal(approval.command, '/sf-approve code --work-id STORY-1', 'the person may approve now, and a chat takes it');
  assert.equal(approval.head, '/sf-approve');
});

test('nothing is filled for a terminal-only step, someone else\'s step, or no Story', () => {
  assert.equal(nextChatPrefill(terminalOnly()), null, 'a step whose only route is the terminal');
  assert.equal(nextChatPrefill(awaiting({
    next: { effect: 'approves', available: true, where: { copilot: null, terminal: true } }, waitingFor: null
  })), null, 'an approval signed in the person\'s own terminal');
  assert.equal(nextChatPrefill(awaiting({
    next: { effect: 'reads', available: true, where: { copilot: '/sf-decide STORY-1' } }, waitingFor: { words: 'The approvers' }
  })), null, 'the approval is someone else\'s');
  assert.equal(nextChatPrefill(story({ generation: 1, readiness: {
    classification: 'decisions-required', reasonCode: 'DECISIONS_REQUIRED', nextCommand: 'singularity-flow decisions STORY-1',
    sheet: { next: { effect: 'reads', available: true, where: { copilot: null, terminal: true, vscode: 'singularityFlow.decisions' } }, waitingFor: null }
  } })), null, 'the decision list\'s step that only the terminal or the card takes');
  assert.equal(nextChatPrefill(null), null);
  assert.equal(nextChatPrefill({ workflow: null }), null);
  assert.equal(nextChatPrefill({ ...generation(), included: ['repository'] }), null, 'a snapshot without the lifecycle says nothing');
  const ended = generation();
  ended.workflow.currentPhase = null;
  assert.equal(nextChatPrefill(ended), null, 'a Story with no current step');
});

test('only a /sf- skill or an @sflow command with plain arguments is a chat route', () => {
  for (const route of ['/sf-code', '/sf-approve code --work-id STORY-1', '/sf-confirm K7Q2-M8DX', '@sflow /next', '/sf-decide STORY-1']) {
    assert.equal(isChatRoute(route), true, route);
  }
  for (const route of ['singularity-flow submit code', '/sf-code; rm -rf /', '/sf-code\nsend', '@other /next', '/sf-code $(id)', '', null, `/sf-${'a'.repeat(300)}`]) {
    assert.equal(isChatRoute(route), false, String(route));
  }
});

/** A host whose clock, timers, chat inputs and setting the test moves by hand. */
function harness({ enabled = true, inputs = undefined, memento = new Map() } = {}) {
  let now = 1_000;
  const timers = [];
  const state = { snapshot: null, enabled, inputs, chatDisabled: false, turnUntil: null };
  const executed = [];
  const shown = [];
  const said = [];
  const host = {
    executeCommand: async (id, ...args) => { executed.push({ id, args }); },
    enabled: () => state.enabled,
    chatDisabled: () => state.chatDisabled,
    chatInputs: () => (state.inputs === undefined ? null : state.inputs),
    // A Copilot turn open until state.turnUntil, as copilotTurnOpen reads its marker.
    turnOpen: async () => (state.turnUntil !== null && state.turnUntil > now ? { open: true, until: state.turnUntil } : { open: false, until: null }),
    current: () => (state.snapshot ? { snapshot: state.snapshot, repository: '/work/repo' } : null),
    memento: { get: (key) => memento.get(key), update: async (key, value) => { memento.set(key, value); } },
    status: { show: (action) => shown.push(action.head), hide: () => shown.push(null) },
    inform: (message) => said.push(message),
    now: () => now,
    setTimer: (callback, ms) => { const timer = { callback, at: now + ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); }
  };
  const prefill = new ChatPrefill(host, { settleMs: 500, quietMs: 4_000 });
  const advance = async (ms) => {
    now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  const show = async (snapshot) => { state.snapshot = snapshot; prefill.observe(); await advance(500); };
  const fills = () => executed.filter((entry) => entry.id === 'workbench.action.chat.open').map((entry) => entry.args[0]);
  return { prefill, state, executed, shown, said, memento, advance, show, fills, now: () => now };
}

test('a changed next action is filled once, never sent, and not again for the same state', async () => {
  const run = harness();
  await run.show(generation());
  assert.deepEqual(run.fills(), [{ query: '/sf-code ', isPartialQuery: true }]);
  assert.equal(run.prefill.last, 'filled');
  assert.deepEqual(run.shown, ['/sf-code'], 'the Next button shows the command');
  await run.show(generation());
  await run.show(generation());
  assert.equal(run.fills().length, 1, 'the same Story state is filled once');
  await run.show(submit());
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-code ', '/sf-submit '], 'a new state fills its own command');
  assert.equal(run.executed.some((entry) => entry.id === 'workbench.action.chat.newChat'), false,
    'the automatic fill never replaces the chat, which may still be answering');

  // A reloaded window reads what it filled from workspace state.
  const reloaded = harness({ memento: run.memento });
  await reloaded.show(submit());
  assert.deepEqual(reloaded.fills(), [], 'no fill after a reload for a state already filled');
  assert.equal(reloaded.prefill.last, 'same');
});

test('a terminal-only next step fills nothing and hides the button', async () => {
  const run = harness();
  await run.show(terminalOnly());
  assert.deepEqual(run.fills(), []);
  assert.deepEqual(run.shown, [null]);
  await run.prefill.fillNow();
  assert.deepEqual(run.fills(), [], 'the button has nothing to fill either');
  assert.match(run.said.at(-1), /no next command for Copilot Chat/);
});

test('the setting off stops the automatic fill; the button still fills', async () => {
  const run = harness({ enabled: false });
  await run.show(generation());
  assert.deepEqual(run.fills(), []);
  assert.equal(run.prefill.last, 'off');
  assert.deepEqual(run.shown, ['/sf-code'], 'the button is still offered');
  assert.equal(await run.prefill.fillNow(), true);
  assert.deepEqual(run.fills(), [{ query: '/sf-code ', isPartialQuery: true }]);
  assert.equal(PREFILL_SETTING, 'chat.prefillNextCommand');
  assert.deepEqual(CHAT_INPUT_SCHEMES, ['chatSessionInput', 'sessions-chat'], 'the chat input documents VS Code 1.146 gives extensions');
  assert.equal(PREFILL_COMMAND, 'singularityFlow.prefillNextCommand');
});

test('the button fills again after an automatic fill, in the chat the person used last', async () => {
  const run = harness();
  await run.show(generation());
  await run.prefill.fillNow();
  await run.prefill.fillNow();
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-code ', '/sf-code ', '/sf-code ']);
  await run.show(submit());
  run.executed.length = 0;
  await run.prefill.fillNow();
  // VS Code's New Chat can start another kind of session than the person's Copilot CLI one: the
  // fill goes to their own chat, and a cheaper new chat is only advice (the button's tooltip).
  assert.deepEqual(run.executed.map((entry) => entry.id), ['workbench.action.chat.open']);
  assert.equal(nextChatPrefill(submit()).freshChat, true);
});

test('the fill waits while the person types, and fills once they stop', async () => {
  const run = harness();
  run.prefill.noteActivity();
  await run.show(generation());
  assert.deepEqual(run.fills(), [], 'no fill a moment after a keystroke');
  assert.equal(run.prefill.last, 'typing');
  await run.advance(2_000);
  run.prefill.noteActivity();
  await run.advance(3_000);
  assert.deepEqual(run.fills(), [], 'typing again keeps it waiting');
  await run.advance(1_500);
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-code ']);
});

test('text the person wrote in the chat box is never replaced; the fill\'s own text is', async () => {
  const run = harness({ inputs: ['What does this step do?'] });
  await run.show(generation());
  assert.deepEqual(run.fills(), []);
  assert.equal(run.prefill.last, 'composing');
  run.state.inputs = [''];
  await run.show(generation());
  assert.deepEqual(run.fills(), [], 'that state is left to the button once the person had text there');

  const own = harness({ inputs: [''] });
  await own.show(generation());
  own.state.inputs = ['/sf-code '];
  own.prefill.noteChatInput('/sf-code ');
  await own.show(submit());
  assert.deepEqual(own.fills().map((fill) => fill.query), ['/sf-code ', '/sf-submit '],
    'the fill replaced its own unsent text, and its own change was not counted as typing');
});

test('no chat open, or chat turned off, fills nothing automatically', async () => {
  const closed = harness({ inputs: [] });
  await closed.show(generation());
  assert.deepEqual(closed.fills(), []);
  assert.equal(closed.prefill.last, 'no-chat');
  const off = harness();
  off.state.chatDisabled = true;
  await off.show(generation());
  assert.deepEqual(off.fills(), []);
});

test('an @sflow answer still running holds the fill until it ends', async () => {
  const run = harness();
  participantRequestStarted();
  try {
    await run.show(generation());
    assert.deepEqual(run.fills(), []);
    assert.equal(run.prefill.last, 'busy');
  } finally { participantRequestEnded(); }
  await run.advance(0);
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-code ']);
  run.prefill.dispose();
});

test('a prompt the extension sent itself keeps its state unfilled; the next state fills', async () => {
  const run = harness();
  run.prefill.noteRequestSent();
  await run.show(generation());
  assert.deepEqual(run.fills(), [], 'the handoff\'s chat is not filled over');
  assert.equal(run.prefill.last, 'held');
  await run.show(submit());
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-submit ']);
});

test('a step published mid-turn waits for the turn to end, then fills the state the turn ended on', async () => {
  const run = harness();
  run.state.turnUntil = run.now() + TURN_STALE_MS;
  await run.show(generation());
  assert.deepEqual(run.fills(), [], 'Copilot is still answering: an Enter now would steer or queue into its turn');
  assert.equal(run.prefill.last, 'turn');
  await run.show(submit());
  assert.deepEqual(run.fills(), [], 'the state changed again during the turn');
  run.state.turnUntil = null;
  run.prefill.turnChanged();
  await run.advance(500);
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-submit '], 'the turn ended: only the state it ended on is filled');
  run.state.turnUntil = run.now() + TURN_STALE_MS;
  run.prefill.turnChanged();
  await run.advance(500);
  assert.equal(run.fills().length, 1, 'a new turn on the same state fills nothing more');
});

test('a turn marker that goes stale stops holding the fill, with no event needed', async () => {
  const run = harness();
  run.state.turnUntil = run.now() + 60_000;
  await run.show(generation());
  assert.equal(run.prefill.last, 'turn');
  await run.advance(59_000);
  assert.deepEqual(run.fills(), [], 'held while the marker counts');
  await run.advance(2_000);
  assert.deepEqual(run.fills().map((fill) => fill.query), ['/sf-code '], 'a crashed turn never blocks the fill for good');
});

test('the open-turn reader counts a fresh marker for this repository only, and never a stale one', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-chat-turns-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const turns = path.join(base, 'copilot-turns');
  const repository = path.join(base, 'work', 'app');
  const other = path.join(base, 'work', 'other');
  await mkdir(repository, { recursive: true });
  await mkdir(other, { recursive: true });
  const hash = (seed) => seed.repeat(64).slice(0, 64);
  const marker = async (seed, folder, ageMs = 0) => {
    await mkdir(turns, { recursive: true });
    const file = path.join(turns, hash(seed));
    await writeFile(file, `${folder}\n`);
    const at = (Date.now() - ageMs) / 1000;
    await utimes(file, at, at);
    return file;
  };
  assert.deepEqual(await copilotTurnOpen(turns, repository), { open: false, until: null }, 'no folder, no turn');
  await marker('a', other);
  assert.equal((await copilotTurnOpen(turns, repository)).open, false, 'another repository\'s turn');
  const fresh = await marker('b', repository);
  const open = await copilotTurnOpen(turns, repository);
  assert.equal(open.open, true);
  assert.ok(open.until > Date.now() + TURN_STALE_MS - 60_000 && open.until <= Date.now() + TURN_STALE_MS + 1_000);
  await rm(fresh);
  await marker('c', path.join(base, 'work'));
  assert.equal((await copilotTurnOpen(turns, repository)).open, true, 'a chat started in a folder holding the repository');
  await rm(path.join(turns, hash('c')));
  await marker('d', repository, TURN_STALE_MS + 1_000);
  assert.equal((await copilotTurnOpen(turns, repository)).open, false, 'a turn that never stopped stops counting');
  await writeFile(path.join(turns, 'not-a-marker'), `${repository}\n`);
  await writeFile(path.join(turns, `.${hash('e')}.123`), `${repository}\n`);
  assert.equal((await copilotTurnOpen(turns, repository)).open, false, 'only a session\'s marker counts, not a write in flight');
});

test('the setting and the command are contributed, and the setting is documented', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
  const setting = manifest.contributes.configuration.properties['singularityFlow.chat.prefillNextCommand'];
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, true, 'on unless the person turns it off');
  assert.match(setting.description, /without sending it/);
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === PREFILL_COMMAND));
  const topic = await readFile(path.join(packageRoot, 'docs', 'topics', 'copilot-and-surfaces.md'), 'utf8');
  assert.match(topic, /singularityFlow\.chat\.prefillNextCommand/);
});
