/**
 * Update SFlow's step intents screen in VS Code (step intents Stage 5): once per build, each repository whose own
 * workflows can say what each step is for is offered its one screen. Review… shows it, asks each question from its
 * choices and confirms on one modal; Not now, or closing a question, writes nothing. A screen that changed meanwhile
 * is one Review away; any other refusal names the workflow build that settles it.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openConfigurationReviews } from '../apps/vscode/src/product-alignment.ts';
import {
  confirmArgs, offerStepIntents, questionsOf, reviewStepIntents, screenArgs, screenDetail, STEP_INTENTS_OFFERED_KEY
} from '../apps/vscode/src/step-intents-upgrade.ts';

const BUILD = 'abc1234 2026-11-21T10:00Z';

const pass = (overrides = {}) => ({
  code: 'a1b2c3',
  counts: { workflows: 1, steps: 3, kept: 1, open: 1, held: 0 },
  workflows: [{
    workflow: 'team', label: 'Team delivery', status: 'needs-answer', reason: null,
    rows: [
      { step: 'build', label: 'Build it', intent: 'code', intentLabel: 'Changes the code', badge: 'sure', badgeText: 'SFlow is sure', why: 'its generation task is code' },
      { step: 'check', label: 'Run checks', intent: 'test', intentLabel: 'Runs the tests', badge: 'sure', badgeText: 'SFlow is sure', why: 'its output kind is test-evidence',
        kept: [{ setting: 'approval.automatic', today: 'a person approves it', intent: 'SFlow approves it when clean' }] },
      { step: 'wrap', label: 'Wrap up', intent: 'review', intentLabel: 'Checks the change', badge: 'needs-answer', badgeText: 'Your answer needed', why: 'only its place',
        question: { question: 'What does "Wrap up" do?', choices: [{ intent: 'review', text: 'Checks the change against every requirement (review)' },
          { intent: 'release', text: 'Prepares the release (release)' }, { intent: 'document', text: 'Something else (document)' }] } }
    ]
  }],
  ...overrides
});

function host({ choice = 'Review…', pick = 'release', confirm = true, responses = {} } = {}) {
  const state = new Map();
  const events = [];
  return {
    events, state,
    run: async (args) => {
      events.push(['run', args.join(' ')]);
      const response = args.includes('--dry-run') ? responses.screen : responses.confirm;
      const value = typeof response === 'function' ? response() : response;
      if (value instanceof Error) throw value;
      return { data: { results: [{ repository: 'payments', intentPass: value }] } };
    },
    progress: async (title, task) => { events.push(['progress', title]); return task(); },
    inform: async (message, ...actions) => { events.push(['inform', message, actions]); return actions.length ? choice : undefined; },
    warn: async (message, ...actions) => { events.push(['warn', message, actions]); return undefined; },
    confirm: async (message, detail, action) => { events.push(['confirm', message, detail, action]); return confirm; },
    pick: async (title, choices) => { events.push(['pick', title, choices.map((entry) => entry.intent)]); return pick ?? undefined; },
    log: (line) => events.push(['log', line]),
    remembered: (key) => state.get(key),
    remember: async (key, value) => { state.set(key, value); }
  };
}

const offer = { repository: 'payments', code: 'a1b2c3', summary: 'Step intents: …', counts: pass().counts };

test('the screen\'s commands: the dry-run that shows it and the confirmation with each answer', () => {
  assert.deepEqual(screenArgs('payments'), ['workspace', 'refresh-configuration', '--repository', 'payments', '--dry-run', '--json']);
  assert.deepEqual(confirmArgs('payments', 'a1b2c3', { wrap: 'release', build: 'code' }), ['workspace', 'refresh-configuration', '--repository', 'payments',
    '--confirm-intents', 'a1b2c3', '--intent', 'build=code', '--intent', 'wrap=release', '--json']);
  assert.deepEqual(questionsOf(pass()).map((row) => row.step), ['wrap']);
  const detail = screenDetail(pass(), { wrap: 'release' });
  assert.match(detail, /^Team delivery: each step says what it is for$/mu);
  assert.match(detail, /^ {2}Wrap up: release \(your answer\)$/mu);
  assert.match(detail, /^ {4}keeps a person approves it$/mu);
  assert.match(detail, /Every workflow runs exactly as before/u);
});

test('Review… asks the one question, confirms on one modal and writes it; once per build and screen', async () => {
  const item = host({ responses: { screen: pass(), confirm: { ...pass(), confirmation: 'written', summary: 'Step intents: 3 steps of 1 workflow now say what they are for.' } } });
  assert.deepEqual(await offerStepIntents(item, [offer], { loadedBuild: BUILD }), ['written']);
  const kinds = item.events.map(([kind]) => kind);
  assert.deepEqual(kinds.filter((kind) => ['inform', 'pick', 'confirm', 'run'].includes(kind)), ['inform', 'run', 'pick', 'confirm', 'run', 'inform']);
  assert.deepEqual(item.events.find(([kind]) => kind === 'pick')[2], ['review', 'release', 'document'], 'its two or three choices, never free text');
  assert.equal(item.events.filter(([kind]) => kind === 'run')[1][1],
    'workspace refresh-configuration --repository payments --confirm-intents a1b2c3 --intent wrap=release --json');
  assert.match(item.events.at(-1)[1], /now says what it is for; every workflow runs as before/u);
  assert.deepEqual(item.state.get(STEP_INTENTS_OFFERED_KEY), { payments: `${BUILD}:a1b2c3` });
  assert.deepEqual(await offerStepIntents(item, [offer], { loadedBuild: BUILD }), ['offered-before'], 'not asked twice for the same screen');
});

test('Not now, a closed question or a declined modal writes nothing', async () => {
  const notNow = host({ choice: 'Not now', responses: { screen: pass() } });
  assert.deepEqual(await offerStepIntents(notNow, [offer], { loadedBuild: BUILD }), ['not-now']);
  assert.equal(notNow.events.filter(([kind]) => kind === 'run').length, 0);
  const closed = host({ pick: null, responses: { screen: pass() } });
  assert.equal(await reviewStepIntents(closed, 'payments'), 'not-now');
  assert.equal(closed.events.filter(([kind]) => kind === 'run').length, 1, 'only the screen was read');
  const declined = host({ confirm: false, responses: { screen: pass() } });
  assert.equal(await reviewStepIntents(declined, 'payments'), 'not-now');
  assert.equal(declined.events.filter(([kind]) => kind === 'run').length, 1);
});

test('a screen that changed meanwhile is one Review away; any other refusal names the build that settles it', async () => {
  const stale = host({ responses: { screen: pass(), confirm: { ...pass(), confirmation: 'stale', problems: ['Code a1b2c3 names a screen that has changed.'] } } });
  assert.equal(await reviewStepIntents(stale, 'payments'), 'not-written');
  const warned = stale.events.find(([kind]) => kind === 'warn');
  assert.deepEqual(warned[2], ['Review…']);
  const refused = host({ responses: { screen: pass(), confirm: { ...pass(), confirmation: 'refused', problems: ['The confirmed intents did not load as planned; nothing was written.'] } } });
  assert.equal(await reviewStepIntents(refused, 'payments'), 'not-written');
  const named = refused.events.find(([kind]) => kind === 'warn');
  assert.deepEqual(named[2], [], 'no way back to the same confirmation');
  assert.match(named[1], /singularity-flow workflow build start --intents team$/u);
  const failing = host({ responses: { screen: new Error('offline') } });
  assert.equal(await reviewStepIntents(failing, 'payments'), 'failed');
  assert.match(failing.events.find(([kind]) => kind === 'warn')[1], /singularity-flow workspace refresh-configuration --repository payments --dry-run/u);
});

test('the update\'s configuration pass hands its step intents screens to the window, without waiting for them', async (t) => {
  const extensionPath = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-intents-'));
  t.after(() => rm(extensionPath, { recursive: true, force: true }));
  await mkdir(path.join(extensionPath, 'cli'), { recursive: true });
  await writeFile(path.join(extensionPath, 'cli', 'package.json'), '{"name":"singularity-flow"}');
  const offers = [];
  const state = new Map();
  const item = {
    extensionPath, run: async () => ({ data: { status: 'ran', outcome: 'current', reviews: [], stepIntents: [offer] } }),
    log: () => {}, progress: async (_title, task) => task(), inform: async () => undefined, warn: async () => undefined, reload: async () => {},
    remembered: (key) => state.get(key), remember: async (key, value) => { state.set(key, value); },
    // The person may take their time over the screen: the window's checks go on without it.
    offerStepIntents: (list) => { offers.push(list); return new Promise(() => {}); }
  };
  assert.equal(await openConfigurationReviews(item, { loadedBuild: BUILD }), 'current');
  assert.deepEqual(offers, [[offer]]);
  assert.equal(await openConfigurationReviews(item, { loadedBuild: BUILD }), 'skipped-recent');
  assert.equal(offers.length, 1, 'once per build');
});
