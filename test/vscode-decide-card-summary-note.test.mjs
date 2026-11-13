/**
 * The VS Code Decide card says what the terminal and the Copilot CLI card say after a pin or plan amendment changed the
 * open code step after its summary was written: update the summary before prepublishing [owner, 2026-11-13].
 *
 * The card runs here against a `vscode` stub, as in vscode-sf-guard.test.mjs, with a client that answers the list and
 * the record the way `decisions record --json` does. The note's words come from the engine's own
 * summaryUpdateAfterDecision on a checkout whose summary predates the pin, so the card and the CLI cannot drift apart.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { summaryUpdateAfterDecision } from '../src/summary-step-changes.mjs';

const panels = [];
const shown = [];
globalThis.__decideSummaryNoteVscode = {
  ViewColumn: { Active: 1, Beside: 2 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  commands: { executeCommand: async () => undefined, getCommands: async () => [] },
  env: { clipboard: { writeText: async () => undefined } },
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
    showInformationMessage: async (message) => { shown.push(message); },
    setStatusBarMessage: () => ({ dispose() {} }),
    showErrorMessage: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__decideSummaryNoteVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
// The card's module graph holds a class Node's type stripping cannot load, so it is bundled first, `vscode` left to the stub.
const bundled = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-card-bundle-'));
test.after(() => rm(bundled, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL('../apps/vscode/src/views/decide-card.ts', import.meta.url))], bundle: true, platform: 'node',
  format: 'esm', external: ['vscode'], outfile: path.join(bundled, 'decide-card.mjs'), logLevel: 'silent' });
const { reviewDecisions } = await import(pathToFileURL(path.join(bundled, 'decide-card.mjs')).href);
const model = await import('../apps/vscode/src/views/decision-list-model.ts');

const W = 'W-1';
const DIGEST = `sha256:${'7'.repeat(64)}`;
const SUMMARY = 'singularity/work-items/W-1/artifacts/implementation/implementation-summary.md';
const REASON = 'The Vitest suite needs Node 22; the code does not change.';

// The open code step whose summary (minute 5) predates the person's pin (minute 10), as in summary-step-changes.test.mjs.
async function summaryUpdate(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-note-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = Date.parse('2026-11-13T10:00:00.000Z');
  const at = (minutes) => new Date(started + minutes * 60_000);
  const write = async (relative, text, minutes) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
    await utimes(path.join(root, relative), at(minutes), at(minutes));
  };
  await write(SUMMARY, '# Implementation summary\n\nNo `.nvmrc` was added.\n', 5);
  await write('.nvmrc', '22\n', 10);
  const workflow = { workItem: { id: W }, currentPhase: 'implementation',
    planAmendments: [{ id: 'PAM-001', at: at(10).toISOString(), reason: REASON,
      changes: [{ kind: 'add-supporting', path: '.nvmrc', class: 'build-configuration', reason: REASON }] }],
    phases: { implementation: { id: 'implementation', status: 'in_progress', generation: 0, generationPolicy: { task: 'code' },
      requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md' },
      generationIntent: { status: 'open', generation: 1, startedAt: at(0).toISOString() } } } };
  const update = await summaryUpdateAfterDecision(root, {}, workflow);
  assert.ok(update, 'the engine asks for the summary update');
  return update;
}

const packet = () => ({
  schemaVersion: 1, resultType: 'sflow-decisions', revision: 'decision-list-v1', workId: W, phase: 'implementation', phaseLabel: 'Code',
  status: 'decisions-needed', headline: "Code can't be approved yet: 1 decision needed.", rule: 'Keep the honest verdict.',
  items: [{
    id: 'd1', kind: 'node-pin', title: 'The tests failed on Node 26.1.0',
    why: 'package.json asks for Node >=20 <25. It passes on Node 22.14.0.',
    options: [{ id: 'pin-node', label: 'Pin Node 22: create .nvmrc and amend the plan', recommended: true,
      words: 'Creates .nvmrc holding 22 in this checkout and lists it in the plan as a supporting change.',
      effects: [{ kind: 'node-pin', version: '22' }], needs: { reason: { default: REASON, minimum: 20, maximum: 1000 } },
      decidedBy: { groups: ['engineering-reviewers'], labels: ['Engineering reviewers'], allowed: true, words: 'You may decide this.' } }],
    decidedBy: { groups: ['engineering-reviewers'], labels: ['Engineering reviewers'], allowed: true, words: 'You may decide this.' }
  }],
  packetSha256: DIGEST,
  record: { form: `singularity-flow decisions record ${W} --choose <ITEM>=<OPTION> --confirm ${DIGEST}`, recommended: null,
    interactive: `singularity-flow decisions record ${W}`, share: `/sf-decide ${W}` }
});

// What `decisions record --json` returns after the pin, with the engine's own summaryUpdate (src/commands/decisions.mjs).
const recordedWith = (update) => ({ resultType: 'command-result', data: {
  recorded: [{ item: 'd1', kind: 'node-pin', record: 'PAM-001' }], decided: [{ item: 'd1', words: 'Pin Node 22' }], refused: [], remaining: [],
  summaryUpdate: update, agentInstruction: update.words, packetSha256: null } });

function client(update) {
  const runs = [];
  return {
    runs, repository: os.tmpdir(), invalidateReads() {},
    run: async (argv) => {
      runs.push(argv);
      return argv.includes('record') ? recordedWith(update) : { resultType: 'command-result', data: packet() };
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the record\'s summary note reaches the person and the chat\'s agent', async (t) => {
  const update = await summaryUpdate(t);
  const outcome = model.decisionRecordOutcome(recordedWith(update)).outcome;
  assert.equal(outcome.summaryUpdate, update.words);
  assert.ok(outcome.message.endsWith(` ${update.words}`), outcome.message);
  // Without the note, the outcome is as before: no field, no words.
  const plain = model.decisionRecordOutcome({ data: { recorded: [{ item: 'd1', kind: 'node-pin', record: 'PAM-001' }], refused: [], remaining: [] } }).outcome;
  assert.equal('summaryUpdate' in plain, false);
  assert.equal(plain.message, 'Recorded 1 record from your choices.');
});

test('the Decide card returns the summary note to the chat after recording a pin', async (t) => {
  const update = await summaryUpdate(t);
  const cli = client(update);
  panels.length = 0;
  const result = reviewDecisions(cli, { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  assert.ok(card, 'the card opened');
  assert.match(card.webview.html, /Pin Node 22: create \.nvmrc and amend the plan/u);
  card.post({ type: 'decide.review', rows: [{ item: 'd1', option: 'pin-node', reason: REASON, title: 'The tests failed on Node 26.1.0' }] });
  await settle();
  const confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');
  assert.ok(confirmation, 'the person confirms what is recorded');
  confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  const answer = await result;
  assert.ok(cli.runs.some((argv) => argv.includes('record')), 'recorded through the CLI');
  assert.equal(answer.status, 'recorded');
  assert.equal(answer.summaryUpdate, update.words, 'the chat\'s agent is told to update the summary');
  assert.match(answer.message, /^1 decision recorded\. Pin Node 22\. All decided\. This changed implementation after its summary was written \(PAM-001: \.nvmrc\)\./u);
  assert.equal(answer.message.split(update.words).length, 2, 'said once');
});
