/**
 * The VS Code Decide card and approval page under SF Guard [owner, 2026-11-19]: the confirmation is SF Guard's card as
 * the engine renders it for these very answers (`guard card decisions`), its button records and signs, and the record
 * carries the card's digest; nowhere does it hand the person a terminal. An engine with no card, or a Story SF Guard does
 * not require, keeps today's confirmation, with the one offer line where the engine gives it.
 *
 * The card runs against a `vscode` stub with a client that answers as the CLI does, as in
 * vscode-decide-card-summary-note.test.mjs. Nothing signs here: the record's answer is the client's.
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const panels = [];
globalThis.__decideSfGuardVscode = {
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
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
    showErrorMessage: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__decideSfGuardVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));
const bundled = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-sfg-bundle-'));
test.after(() => rm(bundled, { recursive: true, force: true }));
for (const name of ['decide-card', 'approval-review']) {
  await build({ entryPoints: [fileURLToPath(new URL(`../apps/vscode/src/views/${name}.ts`, import.meta.url))], bundle: true, platform: 'node',
    format: 'esm', external: ['vscode'], outfile: path.join(bundled, `${name}.mjs`), logLevel: 'silent' });
}
const { reviewDecisions } = await import(pathToFileURL(path.join(bundled, 'decide-card.mjs')).href);
const { sfGuardReviewHtml } = await import(pathToFileURL(path.join(bundled, 'approval-review.mjs')).href);
const model = await import('../apps/vscode/src/views/sf-guard-model.ts');

const W = 'SFG-1';
const LIST = `sha256:${'7'.repeat(64)}`;
const CARD = `sha256:${'c'.repeat(64)}`;
const SUMMARY = 'd1. Approve AMD-001: Approve. Records: the amendment, approved.';
const REASON = 'The clause now says what the review asked for.';

const packet = () => ({
  schemaVersion: 1, resultType: 'sflow-decisions', revision: 'decision-list-v1', workId: W, phase: 'specification', phaseLabel: 'Specification',
  status: 'decisions-needed', headline: '1 decision needed.', rule: 'Keep the honest verdict.',
  items: [{
    id: 'd1', kind: 'intent-amendment', title: 'Approve AMD-001', why: 'The specification changes.', guardSigns: true,
    options: [{ id: 'approve', label: 'Approve', recommended: true, words: 'Approves the amendment.', effects: [{ kind: 'intent-amendment-decision' }],
      needs: { reason: { default: REASON, minimum: 10, maximum: 1000 } },
      decidedBy: { groups: ['product'], labels: ['Product'], allowed: true, words: 'You may decide this.' } }],
    decidedBy: { groups: ['product'], labels: ['Product'], allowed: true, words: 'You may decide this.' }
  }],
  packetSha256: LIST,
  record: { form: `singularity-flow decisions record ${W} --choose <ITEM>=<OPTION> --confirm ${LIST}`, recommended: null,
    interactive: `singularity-flow decisions record ${W}`, share: `/sf-decide ${W}` }
});

const signing = { schemaVersion: 1, resultType: 'sflow-guard', action: 'card', kind: 'decisions', workId: W, required: true, signs: true,
  keyId: 'SHA256:testkey', cardSha256: CARD, surface: 'vscode-card',
  card: { title: `record a decision on ${W}`, lines: [SUMMARY], keyId: 'SHA256:testkey', rule: 'Touch the sensor only for a command you started yourself, right after its card. A prompt you did not start is an agent asking: decline it.' } };
const recorded = { resultType: 'command-result', data: { recorded: [{ item: 'd1', kind: 'intent-amendment-decision', record: 'AMD-001' }],
  decided: [{ item: 'd1', words: 'Approve' }], refused: [], remaining: [], packetSha256: null } };

function client(guardCard) {
  const runs = [];
  const answers = [];
  return {
    runs, answers, repository: os.tmpdir(), invalidateReads() {},
    run: async (argv) => {
      runs.push(argv);
      if (argv[0] === 'guard' && argv[1] === 'card') {
        answers.push(JSON.parse(await readFile(argv[argv.indexOf('--answers') + 1], 'utf8')));
        if (guardCard instanceof Error) throw guardCard;
        return guardCard;
      }
      return argv.includes('record') ? recorded : { resultType: 'command-result', data: packet() };
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function decide(cli) {
  panels.length = 0;
  const result = reviewDecisions(cli, { workId: W }, async () => undefined, { askedInChat: true });
  await settle();
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.decide');
  assert.ok(card, 'the card opened');
  card.post({ type: 'decide.review', rows: [{ item: 'd1', option: 'approve', reason: REASON, title: 'Approve AMD-001' }] });
  // The answers file is written and the card read first: real file I/O, so wait on the page, not a number of ticks.
  for (const started = Date.now(); Date.now() - started < 5_000 && !panels.some((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation');
  assert.ok(confirmation, 'the person confirms on a page');
  return { result, card, confirmation };
}

test('on a Story SF Guard requires, the confirmation is its card for these answers, and the record carries its digest', async () => {
  const cli = client(signing);
  const { result, confirmation } = await decide(cli);
  assert.equal(confirmation.title, `Record and sign your decisions on ${W}`);
  assert.match(confirmation.webview.html, new RegExp(`SF Guard: record a decision on ${W}`, 'u'));
  assert.match(confirmation.webview.html, /Approve AMD-001: Approve\. Records: the amendment, approved\./u, 'the engine\'s own words');
  assert.match(confirmation.webview.html, /Signing key: SHA256:testkey/u);
  assert.match(confirmation.webview.html, /Touch the sensor only for a command you started yourself/u);
  assert.match(confirmation.webview.html, />Record and sign with Touch ID</u);
  assert.doesNotMatch(confirmation.webview.html, /own terminal/u, 'no terminal hop');
  confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  const answer = await result;
  assert.equal(answer.status, 'recorded');
  const card = cli.runs.find((argv) => argv[0] === 'guard');
  const record = cli.runs.find((argv) => argv.includes('record'));
  assert.deepEqual(card.slice(0, 4), ['guard', 'card', 'decisions', W]);
  assert.equal(card[card.indexOf('--answers') + 1], record[record.indexOf('--answers') + 1], 'the card was read for the very answers recorded');
  assert.deepEqual(record.slice(record.indexOf('--presence-card')), ['--presence-card', 'vscode-card', '--card-sha256', CARD]);
  assert.deepEqual(cli.answers[0].confirm, LIST);
});

test('an engine with no card keeps today\'s confirmation and record; a Story without SF Guard shows the offer line, never forced', async () => {
  const older = client(Object.assign(new Error('Unknown guard action \'card\'.'), { name: 'CliError' }));
  const first = await decide(older);
  assert.equal(first.confirmation.title, `Record 1 decision on ${W}`);
  assert.match(first.confirmation.webview.html, />Record these decisions</u);
  first.confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  await first.result;
  assert.equal(older.runs.find((argv) => argv.includes('record')).includes('--presence-card'), false);

  const offer = 'SF Guard is off here, so this is recorded without your Touch ID. To turn it on for this repository, run in your own terminal: singularity-flow guard setup';
  const off = client({ schemaVersion: 1, resultType: 'sflow-guard', action: 'card', kind: 'decisions', workId: W, required: false, signs: false, state: 'off', offer });
  const second = await decide(off);
  assert.match(second.confirmation.webview.html, /SF Guard is off here, so this is recorded without your Touch ID/u);
  second.confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  await second.result;
  assert.equal(off.runs.find((argv) => argv.includes('record')).includes('--presence-card'), false);
});

test('the engine\'s card is read strictly: a card with no digest, no surface or no lines never starts a signing record', () => {
  assert.deepEqual(model.presenceCardArgs(model.guardCardFrom(signing)), ['--presence-card', 'vscode-card', '--card-sha256', CARD]);
  for (const broken of [{ ...signing, cardSha256: 'sha256:short' }, { ...signing, surface: 'chat' }, { ...signing, card: { ...signing.card, lines: [] } },
    { ...signing, resultType: 'command-result' }, { ...signing, signs: false }]) {
    assert.deepEqual(model.presenceCardArgs(model.guardCardFrom(broken)), [], JSON.stringify(broken).slice(0, 80));
  }
  assert.equal(model.guardCardFrom({ ...signing, required: true, signs: false, offer: 'x' }).offer, null, 'no offer where SF Guard is required');
  assert.deepEqual(model.guardCardApproveArgv(W, 'specification'), ['guard', 'card', 'approve', W, '--phase', 'specification', '--json']);
});

test('the approval page shows what Touch ID signs, a bypass in its own words, or the offer, and nothing for a Story without either', () => {
  const card = model.guardCardFrom({ ...signing, kind: 'approve', surface: 'vscode-approval',
    card: { ...signing.card, title: `approve ${W} / specification`, lines: ['Step: Specification, generation 1', 'Decision: approved'] } });
  const html = sfGuardReviewHtml({ summary: null, labels: [], approvals: [], card });
  assert.match(html, /What Touch ID signs/u);
  assert.match(html, /SF Guard: approve SFG-1 \/ specification\n {2}Step: Specification, generation 1\n {2}Decision: approved\n {2}Signing key: SHA256:testkey/u);
  assert.match(html, /Record approval signs this card: Touch ID asks right after you click/u);
  assert.doesNotMatch(html, /own terminal/u);
  const bypass = sfGuardReviewHtml({ summary: null, labels: [], approvals: [], card: model.guardCardFrom({ ...signing, signs: false, card: undefined,
    bypass: 'EXC-001', reason: 'recorded unsigned, labelled "bypass: per-person exception EXC-001"' }) });
  assert.match(bypass, /bypass: per-person exception EXC-001/u);
  const offered = sfGuardReviewHtml({ summary: null, labels: [], approvals: [], card: model.guardCardFrom({ ...signing, required: false, signs: false, offer: 'SF Guard is off here.' }) });
  assert.match(offered, /data-sfg-offer>SF Guard is off here\.</u);
  const windows = sfGuardReviewHtml({ summary: null, labels: [], approvals: [], card: model.guardCardFrom({ ...signing, signs: false, card: undefined,
    code: 'PSS_SIGNER_UNAVAILABLE', reason: 'presence signing needs macOS' }) });
  assert.match(windows, /data-sfg-unsigned>SF Guard cannot sign this here: presence signing needs macOS\.</u);
  assert.equal(sfGuardReviewHtml({ summary: null, labels: [], approvals: [], card: null }), '');
});
