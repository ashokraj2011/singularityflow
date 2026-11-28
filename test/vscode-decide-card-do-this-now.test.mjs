/**
 * A row's own step runs from the Decide card on "Do this now" [owner, 2026-11-28: terminal-only steps move to the card], and the
 * card records on one press. Before, a row such as "Return Implementation for changes first" or a held package's acceptance said
 * "This one stays in your terminal": the person put it in a terminal, pressed Enter there and came back to the chat.
 *
 * The step runs from the list as read, with the person's reason and date as values of their own (never through a shell), only
 * while the row still offers that exact step. One that must ask in the person's own terminal (SF Guard's Touch ID, a terminal
 * card) opens there typed in, with one line saying why. The card runs against a `vscode` stub, as vscode-decide-card-sf-guard.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { ownStepArgv, ownTerminalWords, RUN_WORDS, decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';

const panels = [];
const terminals = [];
globalThis.__decideDoItNowVscode = {
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
    createTerminal: (options) => { const terminal = { options, sent: [], show() {}, sendText(text, enter) { terminal.sent.push([text, enter]); } }; terminals.push(terminal); return terminal; },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
    showErrorMessage: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__decideDoItNowVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
const bundled = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-run-bundle-'));
test.after(() => rm(bundled, { recursive: true, force: true }));
const views = fileURLToPath(new URL('../apps/vscode/src/views/', import.meta.url));
await build({ stdin: { contents: "export { reviewDecisions } from './decide-card.ts'; export { CliError } from '../cli/runner.ts';", resolveDir: views, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', external: ['vscode'], outfile: path.join(bundled, 'card.mjs'), logLevel: 'silent' });
const { reviewDecisions, CliError } = await import(pathToFileURL(path.join(bundled, 'card.mjs')).href);

const W = 'RUN-1';
const RETURN = `singularity-flow reject implementation --work-id ${W} --reason "<why>"`;
const REASON = 'The pinned command still runs the old suite.';
const list = ({ command = RETURN } = {}) => ({
  schemaVersion: 1, resultType: 'sflow-decisions', revision: 'decision-list-v1', workId: W, phase: 'implementation', phaseLabel: 'Implementation',
  status: 'decisions-needed', headline: '1 decision needed.', rule: 'Keep the honest verdict.', repositoryPath: os.tmpdir(),
  items: [{ id: 'd1', kind: 'test-command', title: 'Run npm test as Implementation\'s tests for this Story', why: 'Implementation awaits approval.',
    options: [{ id: 'return-step-first', label: 'Return Implementation for changes first', recommended: false, words: 'It returns the step first.',
      effects: [], needs: {}, recordable: false, action: { command, alternativeCommands: [] },
      decidedBy: { groups: ['eng'], labels: ['Engineers'], allowed: true, words: 'You decide this.' } }],
    decidedBy: { groups: ['eng'], labels: ['Engineers'], allowed: true, words: 'You decide this.' } }],
  packetSha256: `sha256:${'7'.repeat(64)}`,
  record: { form: `singularity-flow decisions record ${W}`, recommended: null, interactive: `singularity-flow decisions record ${W}`, share: `/sf-decide ${W}` }
});

function client({ lists = [list(), list(), { ...list(), items: [] }], refuse = null } = {}) {
  const runs = [];
  let read = 0;
  return {
    runs, repository: os.tmpdir(), invalidateReads() {},
    run: async (argv) => { runs.push(argv); return { resultType: 'command-result', data: lists[Math.min(read++, lists.length - 1)] }; },
    runText: async (argv) => { runs.push(['text', ...argv]); if (refuse) throw refuse; return 'done'; }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const until = async (test, what) => {
  for (const started = Date.now(); Date.now() - started < 5_000;) { const value = test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error(`timed out waiting for ${what}`);
};

test('the row\'s own step as argv: the person\'s reason and date are values of their own; a blank or a shell character is never run', () => {
  assert.deepEqual(ownStepArgv(RETURN, { reason: REASON }), { argv: ['reject', 'implementation', '--work-id', W, '--reason', REASON] });
  // Words a shell would read are only words here.
  assert.deepEqual(ownStepArgv(RETURN, { reason: 'It is $(wrong); `still`' }).argv.at(-1), 'It is $(wrong); `still`');
  assert.deepEqual(ownStepArgv(RETURN, { reason: '' }), { missing: 'reason' });
  const risk = `singularity-flow decision finding-risk ${W} --phase implementation --finding F-1 --reason "<why the step may keep it>" --expires <YYYY-MM-DD>`;
  assert.deepEqual(ownStepArgv(risk, { reason: REASON, expires: '2026-12-28' }).argv.slice(-4), ['--reason', REASON, '--expires', '2026-12-28']);
  assert.deepEqual(ownStepArgv(risk, { reason: REASON }), { missing: 'expires' });
  // The forward amendment's old route, with a shell pipe for the person to resolve, is never run.
  assert.deepEqual(ownStepArgv(`singularity-flow upstream-issue decide-amendment FAM-001 --work-id ${W} --decision approve|reject --reason "<why>" --confirm FAM-001`, { reason: REASON }),
    { missing: 'value' });
  assert.deepEqual(ownStepArgv(`singularity-flow decision witness ${W} --criterion <CLAUSE>`, {}), { missing: 'value' });
  assert.deepEqual(ownStepArgv('git push --force', {}), { missing: 'value' }, 'only an SFlow command');
});

test('the card offers "Do this now" on every own step, says what it does, and records on one press', () => {
  const html = decideHtml(list());
  assert.match(html, new RegExp(`${RUN_WORDS.replace(/[.;]/gu, '.')}[\\s\\S]*<button type="button" data-run="return-step-first">Do this now</button>[\\s\\S]*data-terminal="return-step-first"`, 'u'));
  assert.doesNotMatch(html, /This one stays in your terminal/u);
  assert.match(html, /Nothing is recorded until you press Record what I chose; Not now records nothing\./u);
});

test('Do this now runs the row\'s own step with the person\'s reason, once, and the card ends when nothing is left', async () => {
  panels.length = 0; terminals.length = 0;
  const cli = client();
  const result = reviewDecisions(cli, { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  card.post({ type: 'decide.run', item: 'd1', option: 'return-step-first', reason: REASON, expires: '', rows: [] });
  const answer = await result;
  assert.deepEqual(cli.runs.filter((argv) => argv[0] === 'text'), [['text', 'reject', 'implementation', '--work-id', W, '--reason', REASON]]);
  assert.equal(answer.status, 'recorded');
  assert.match(answer.message, /^Done\. All decided\./u);
  assert.equal(terminals.length, 0, 'no terminal');
  assert.equal(panels.some((panel) => panel.viewType === 'singularityFlow.reviewConfirmation'), false, 'no second page');
});

test('a step that changed since the card showed it does not run; one SF Guard signs opens the person\'s terminal typed in, with why', async () => {
  panels.length = 0; terminals.length = 0;
  const moved = client({ lists: [list(), list({ command: `singularity-flow reject plan --work-id ${W} --reason "<why>"` })] });
  void reviewDecisions(moved, { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  let card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  card.post({ type: 'decide.run', item: 'd1', option: 'return-step-first', reason: REASON, rows: [] });
  await until(() => card.webview.html.includes('This step changed since the page showed it, so nothing ran.'), 'the changed step');
  assert.equal(moved.runs.some((argv) => argv[0] === 'text'), false, 'nothing ran');
  card.post({ type: 'decide.cancel' });

  panels.length = 0;
  const signed = client({ lists: [list()], refuse: new CliError('SF Guard needs your own terminal.', 1, '', { error: { code: 'PSS_CARD_NOT_SHOWN' } }) });
  void reviewDecisions(signed, { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  card.post({ type: 'decide.run', item: 'd1', option: 'return-step-first', reason: REASON, rows: [] });
  await until(() => terminals.length, 'the terminal');
  assert.deepEqual(terminals[0].sent, [[`singularity-flow reject implementation --work-id ${W} --reason '${REASON}'`, false]], 'typed in, never run for them');
  await until(() => card.webview.html.includes('This one runs in your own terminal'), 'the why line');
  assert.ok(card.webview.html.includes(ownTerminalWords('PSS_CARD_NOT_SHOWN').replace(/'/gu, '&#39;')) || card.webview.html.includes(ownTerminalWords('PSS_CARD_NOT_SHOWN')));
  card.post({ type: 'decide.cancel' });
});
