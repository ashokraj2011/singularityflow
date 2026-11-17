/**
 * VS Code's decisions card is a consent surface, as the Copilot CLI card is (docs/osa/stage4.md section 6): a step's next
 * version waiting for the person's yes is asked first, with the proposal's own question, and a yes is kept by the engine's
 * own command (`decisions record --version-consent <confirmation> --expect <digest>`), bound to the exact proposal digest,
 * so the step's confirmation turns it into the same VersionOpeningConsent/v1 receipt (surface `decisions-card`)
 * [D3, OSA:REQ-030]. The card writes no record itself, never sends anything to a chat and never touches its input
 * [OSA:REQ-050, REQ-051].
 *
 * The card runs here against a `vscode` stub, as in vscode-decide-card-summary-note.test.mjs, with a client that runs the
 * real CLI on an isolated quick-fix Story with a local bare remote (test/helpers/route-follower.mjs journeyRepository):
 * the yes, "Not now", a stale proposal digest and a switched Story.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { journeyRepository, startStory } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { NOT_NOW as CLI_NOT_NOW, START_VERSION as CLI_START_VERSION } from '../plugin/extensions/decisions/card.mjs';

const panels = [];
const executed = [];
const terminals = [];
globalThis.__decideVersionOpeningVscode = {
  ViewColumn: { Active: 1, Beside: 2 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  commands: { executeCommand: async (id) => { executed.push(id); }, getCommands: async () => [] },
  env: { clipboard: { writeText: async () => undefined }, openExternal: async () => true },
  workspace: { workspaceFolders: [{ uri: { fsPath: os.tmpdir() } }], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {
    createWebviewPanel: (viewType, title) => {
      let receive = () => {};
      let disposed = () => {};
      const panel = {
        viewType, title, visible: true,
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        reveal() {}, dispose() { if (!panel.visible) return; panel.visible = false; disposed(); }
      };
      panels.push(panel);
      return panel;
    },
    createTerminal: (options) => { terminals.push(options); return { show() {}, sendText() {} }; },
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
    showErrorMessage: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__decideVersionOpeningVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
// The card's module graph holds a class Node's type stripping cannot load, so it is bundled first, `vscode` left to the stub.
const bundled = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-opening-bundle-'));
test.after(() => rm(bundled, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL('../apps/vscode/src/views/decide-card.ts', import.meta.url))], bundle: true, platform: 'node',
  format: 'esm', external: ['vscode'], outfile: path.join(bundled, 'decide-card.mjs'), logLevel: 'silent' });
const { reviewDecisions } = await import(pathToFileURL(path.join(bundled, 'decide-card.mjs')).href);
const page = await import('../apps/vscode/src/views/decide-card-page.ts');
const model = await import('../apps/vscode/src/views/decision-list-model.ts');

const W = 'VSC-1';
const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (ran) => JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null');
const pageText = (html) => html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
/** The grant the engine keeps for a proposal digest (src/story-version-consent.mjs), by its file name. */
const grantFile = (story, digest) => path.join(story.root, '.git', 'singularity-flow', 'version-consents',
  `${createHash('sha256').update(digest).digest('hex').slice(0, 40)}.grant.json`);
const consentRuns = (client) => client.runs.filter((argv) => argv.includes('--version-consent'));
/** Nothing went to a chat: no chat command, no prefill, no terminal [OSA:REQ-050, REQ-051]. */
const nothingSent = () => {
  assert.deepEqual(executed.filter((id) => /chat|prefill|sendToTerminal|type$/iu.test(id)), [], executed.join(', '));
  assert.deepEqual(terminals, []);
};

/** A quick fix whose intake is published, and the person asked for a change: its next version is previewed. */
async function previewedSuccessor(t, workId = W) {
  const story = await journeyRepository(t);
  startStory(story, workId, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(workId));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const preview = json(story.raw(['phase', 'rollover', 'intake', '--reason', 'Name the callers that read the value.', '--json']));
  assert.equal(preview.toGeneration, 2);
  return { story, preview };
}

/** The extension's client, running the real CLI in the Story's checkout; a refusal arrives as CliError does, with its result. */
function engine(story, { before = null } = {}) {
  const runs = [];
  return {
    runs, repository: story.root, invalidateReads() {},
    run: async (argv) => {
      runs.push(argv);
      await before?.(argv);
      const ran = story.raw(argv);
      let value = null;
      try { value = json(ran); } catch { value = null; }
      if (ran.status !== 0) throw Object.assign(new Error(value?.error?.message ?? `exit ${ran.status}`), { result: value });
      return value;
    }
  };
}

/** Opens the card for `workId` as the chat's tool does, and returns its page and the pending result. */
async function openCard(client, workId = W) {
  panels.length = 0; executed.length = 0; terminals.length = 0;
  let settled = null;
  const result = reviewDecisions(client, { workId }, async () => undefined, { askedInChat: true }).then((value) => { settled = value; return value; });
  for (let index = 0; index < 50 && !panels.length && !settled; index += 1) await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  assert.ok(card, `the card opened: ${JSON.stringify(settled)}`);
  return { card, result, settled: () => settled };
}
const waitFor = async (condition) => { for (let index = 0; index < 400 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 25)); };
const digestOn = (html) => /data-version="yes" data-digest="(sha256:[a-f0-9]{64})"/u.exec(html)?.[1] ?? null;

test('the card asks the waiting next version with the proposal\'s own question, in the Copilot CLI card\'s words, preselecting nothing', () => {
  const opening = { workId: W, phase: 'intake', version: 2, question: 'Start version 3 of Implementation to fix the review\'s findings? Published version 2 and its recorded tests will stay unchanged.',
    confirmation: `sha256:${'c'.repeat(64)}`, digest: `sha256:${'d'.repeat(64)}` };
  const packet = { resultType: 'sflow-decisions', workId: W, phase: 'intake', phaseLabel: 'Scope and plan', status: 'nothing-to-decide', headline: 'Nothing waits.',
    items: [], packetSha256: `sha256:${'a'.repeat(64)}`, versionOpening: opening };
  assert.deepEqual([page.START_VERSION, page.NOT_NOW], [CLI_START_VERSION, CLI_NOT_NOW]);
  const html = page.decideHtml(packet);
  assert.match(pageText(html), /Start version 3 of Implementation to fix the review's findings\? Published version 2 and its recorded tests will stay unchanged\. Your yes is kept for this exact proposal; the step's work command then opens it\. Nothing starts on "Not now"\./u);
  assert.match(html, new RegExp(`<button type="button" data-version="yes" data-digest="${opening.digest}">Yes, start it</button>`, 'u'));
  assert.match(html, new RegExp(`<button type="button" class="secondary" data-version="no" data-digest="${opening.digest}">Not now</button>`, 'u'));
  assert.doesNotMatch(html, /<table/u, 'no empty table of decisions beside it');
  assert.match(page.decideHtml(packet, { busy: true }), /data-version="yes"[^>]* disabled/u);
  assert.equal(page.versionOpeningHtml(packet, { declined: opening.digest }), '', '"Not now" on this page is not asked again here');
  assert.match(page.DECIDE_SCRIPT, /closest\('\[data-version\]'\)[\s\S]*type: 'decide\.version', answer: version\.dataset\.version, digest: version\.dataset\.digest/u);
  // Only the list's own Story, in the engine's shape, is asked; the argv is the engine's command and nothing else.
  assert.equal(model.versionOpeningOf({ ...packet, versionOpening: { ...opening, workId: 'OTHER-1' } }), null, 'another Story\'s proposal is never asked');
  assert.equal(model.versionOpeningOf({ ...packet, versionOpening: { ...opening, digest: 'sha256:short' } }), null);
  assert.equal(model.versionOpeningOf({ ...packet, versionOpening: { ...opening, confirmation: '$(touch x)' } }), null);
  assert.deepEqual(model.versionConsentArgv(opening), ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest, '--json']);
  assert.throws(() => model.versionConsentArgv({ ...opening, confirmation: '--yes' }), /cannot be answered here/u);
  assert.deepEqual(model.versionConsentOutcome(null, { message: 'x', result: { error: { code: 'VERSION_OPENING_STALE', message: 'The Story moved since version 2 of intake was proposed; nothing was recorded.' } } }),
    { kind: 'stale', code: 'VERSION_OPENING_STALE', message: 'The Story moved since version 2 of intake was proposed; nothing was recorded.', next: null });
  // The bundled card carries no record writer: the engine's command is the only way a yes is kept.
  const source = readFileSync(path.join(bundled, 'decide-card.mjs'), 'utf8');
  for (const writer of ['version-consents', 'grantConsent', '.grant.json', 'version-opening-grant']) assert.ok(!source.includes(writer), writer);
});

test('a yes on the card is kept by the engine\'s command, bound to the exact proposal; the step\'s confirmation opens it with the decisions-card receipt', { timeout: 300_000 }, async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  const client = engine(story);
  const { card, result, settled } = await openCard(client);
  const opening = json(story.raw(['decisions', W, '--json'])).data.versionOpening;
  assert.match(pageText(card.webview.html), /Start version 2 of Scope and plan\? Published version 1 will stay unchanged\./u);
  // The headline counts the version question it sits above (real-app check, 2026-11-17: it said "Nothing waits on you now.").
  assert.match(pageText(card.webview.html), /One question for you\./u);
  assert.doesNotMatch(pageText(card.webview.html), /Nothing waits on you now/u);
  assert.equal(digestOn(card.webview.html), opening.digest);
  assert.equal(existsSync(grantFile(story, opening.digest)), false, 'nothing is kept before the person answers');
  card.post({ type: 'decide.version', answer: 'yes', digest: opening.digest });
  await waitFor(settled);
  assert.ok(settled(), `${pageText(card.webview.html)}\n${JSON.stringify(client.runs)}`);
  const answer = await result;
  assert.deepEqual(consentRuns(client), [['decisions', 'record', W, '--version-consent', preview.confirmation, '--expect', opening.digest, '--json']]);
  assert.equal(answer.status, 'recorded');
  assert.deepEqual(answer.recorded, ['version-opening']);
  assert.match(answer.message, /^Your yes to start version 2 of Scope and plan is kept for 30 minutes\./u);
  // The toast says what really happens next, and the step it names opens the version: the work command, never /sf-submit (review, 2026-11-17).
  assert.match(answer.message, /Next, \/sf-phase intake starts it with this yes, without asking you again, and makes the change\.$/u);
  assert.deepEqual(answer.next, { command: 'singularity-flow phase rollover intake --json', skill: '/sf-phase' });
  assert.equal(existsSync(grantFile(story, opening.digest)), true, 'the engine kept the grant');
  assert.equal(json(story.raw(['decisions', W, '--json'])).data.versionOpening, undefined, 'a yes given is not asked again');
  nothingSent();
  // The step's own confirmation opens version 2 with the receipt the card's yes made.
  const opened = json(story.raw(['phase', 'rollover', 'intake', '--confirm', preview.confirmation, '--json']));
  assert.equal(opened.mutates, true, JSON.stringify(opened).slice(0, 2000));
  const record = JSON.parse(await readFile(path.join(story.root, story.item, 'context/version-openings/intake-v2.json'), 'utf8'));
  assert.deepEqual({ schema: record.consent.schema, digest: record.consent.proposalDigest, surface: record.consent.response.surface, assurance: record.consent.principal.assurance },
    { schema: 'version-opening-consent/v1', digest: opening.digest, surface: 'decisions-card', assurance: 'host-card' });
  assert.deepEqual(record.consent.binding, { workId: W, phase: 'intake', version: 2, from: 1, confirmation: preview.confirmation });
});

test('"Not now" records nothing: the version is not started, and the next card asks it again', { timeout: 300_000 }, async (t) => {
  const { story } = await previewedSuccessor(t);
  const client = engine(story);
  const { card, result } = await openCard(client);
  const digest = digestOn(card.webview.html);
  card.post({ type: 'decide.version', answer: 'no', digest });
  const answer = await result;
  assert.equal(answer.status, 'cancelled');
  assert.equal(answer.message, 'Version 2 of intake was not started. No decision was recorded.');
  assert.deepEqual(consentRuns(client), []);
  assert.equal(existsSync(grantFile(story, digest)), false);
  assert.equal(json(story.raw(['decisions', W, '--json'])).data.versionOpening.digest, digest, 'still waiting for the person');
  nothingSent();
});

test('a stale proposal digest keeps nothing: a proposal changed under the page, an old answer, and a Story that moved before the engine kept it', { timeout: 300_000 }, async (t) => {
  const { story } = await previewedSuccessor(t);
  let moveFirst = false;
  const client = engine(story, { before: (argv) => {
    // Between the card's read and its record, someone records on the Story: the engine refuses the stale yes.
    if (moveFirst && argv.includes('--version-consent')) story.git('commit', '-q', '--allow-empty', '-m', 'Another change on the Story');
  } });
  const { card, result } = await openCard(client);
  const first = digestOn(card.webview.html);
  // The step's preview is asked again with another reason: a new proposal, a new digest.
  json(story.raw(['phase', 'rollover', 'intake', '--reason', 'Also name where the value is logged.', '--json']));
  const second = json(story.raw(['decisions', W, '--json'])).data.versionOpening;
  assert.notEqual(second.digest, first);
  card.post({ type: 'decide.version', answer: 'yes', digest: first });
  await waitFor(() => digestOn(card.webview.html) === second.digest);
  assert.match(pageText(card.webview.html), /The proposal changed since the page showed it, so nothing was recorded\. This is the one waiting now\./u);
  assert.equal(digestOn(card.webview.html), second.digest, 'the page now asks the proposal waiting now');
  assert.deepEqual(consentRuns(client), [], 'the engine was never asked to keep the old one');
  // An answer naming a proposal this page does not show records nothing either.
  card.post({ type: 'decide.version', answer: 'yes', digest: `sha256:${'0'.repeat(64)}` });
  await waitFor(() => /This question changed since the page showed it/u.test(card.webview.html));
  assert.deepEqual(consentRuns(client), []);
  // The Story moves after the card's read: the engine itself refuses the yes, and its words are shown.
  moveFirst = true;
  card.post({ type: 'decide.version', answer: 'yes', digest: second.digest });
  await waitFor(() => /The Story moved since version 2 of intake was proposed; nothing was recorded\./u.test(pageText(card.webview.html)));
  assert.equal(consentRuns(client).length, 1);
  for (const digest of [first, second.digest]) assert.equal(existsSync(grantFile(story, digest)), false, digest);
  assert.equal(digestOn(card.webview.html), null, 'the moved proposal is no longer asked');
  nothingSent();
  card.post({ type: 'decide.cancel' });
  const answer = await result;
  assert.equal(answer.status, 'cancelled');
});

test('a switched Story keeps nothing: the card for one Story records no yes once its checkout holds another, and never switches it back', { timeout: 300_000 }, async (t) => {
  const { story } = await previewedSuccessor(t);
  const client = engine(story);
  const { card, result } = await openCard(client);
  const digest = digestOn(card.webview.html);
  // The person starts another Story in the same checkout.
  story.cli('start', 'VSC-2', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Another change', '--description', 'Another.');
  assert.equal(story.git('branch', '--show-current'), 'VSC-2');
  card.post({ type: 'decide.version', answer: 'yes', digest });
  await waitFor(() => /could not be read in this checkout now/u.test(card.webview.html));
  assert.match(pageText(card.webview.html), /The decisions for VSC-1 could not be read in this checkout now, so nothing was recorded\. If it holds another Story, open VSC-1's checkout and ask again\./u);
  assert.deepEqual(consentRuns(client), [], 'the record, which would switch the checkout back to VSC-1, never ran');
  assert.equal(story.git('branch', '--show-current'), 'VSC-2', 'the person\'s checkout stays on the Story they switched to');
  assert.equal(existsSync(grantFile(story, digest)), false);
  nothingSent();
  card.post({ type: 'decide.cancel' });
  assert.equal((await result).status, 'cancelled');
});
