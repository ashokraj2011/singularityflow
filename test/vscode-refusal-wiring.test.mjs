/**
 * Refusals reach the reader as cards. `[UXH:CON-007]` `[UXH:AC-003]`
 *
 * Two halves: the adapter that turns whatever the CLI returned into a card, and a ratchet on the
 * call sites. The ratchet is the part that lasts — the conversion is easy to do once and easy to
 * undo one `showErrorMessage` at a time, which is how a codebase drifts back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOccurrences } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const { fidelityNote, refusalFor } = await import(view('refusal.ts'));
const { resultCardHtml } = await import(view('result-card-page.ts'));
const { commandGuidance } = await import(path.join(root, 'apps', 'vscode', 'src', 'copilot-command.ts'));

function expectedGuidance(command, argv, skill, copilotCommand = skill) {
  const rendered = ['singularity-flow', ...argv].map((entry) => `'${entry}'`).join(' ');
  return {
    command,
    executable: 'singularity-flow',
    argv,
    skill,
    copilotCommand,
    copyable: true,
    platformCommands: {
      darwin: rendered,
      linux: rendered,
      win32: `& ${rendered}`
    }
  };
}

const cliError = (message, stderr = '', exitCode = 1) =>
  Object.assign(new Error(message), { stderr, exitCode, name: 'CliError' });

const V1 = JSON.stringify({
  schemaVersion: 1,
  resultType: 'command-result',
  operation: { id: 'story.submit', classification: 'mutation' },
  subject: { kind: 'story', id: 'PAY-1187' },
  outcome: { status: 'refused', messageId: 'submit.refused', slots: {} },
  effects: { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false },
  why: [{ code: 'work.blocked.approvals-outstanding', source: 'lifecycle', slots: {} }],
  next: [{
    label: 'Check readiness', command: 'sflow status --work-id PAY-1187',
    skill: '/sf-status', reasonCode: 'work.check-readiness'
  }],
  restState: null,
  data: {}
});

test('no refusal site shows a bare error toast', async () => {
  /**
   * The ratchet. Every one of the 37 sites was `showErrorMessage(error.message)`, which is a dead
   * end: no reason, no statement of what survived, nothing to do but dismiss it.
   *
   * `showErrorMessage` is not banned outright — `result-panel.ts` keeps one as the last resort for a
   * failure to render a failure, and that is the only place it belongs.
   */
  const offenders = [];
  for (const file of ['extension.ts', 'actions.ts']) {
    const source = await readFile(path.join(root, 'apps', 'vscode', 'src', file), 'utf8');
    if (source.includes('showErrorMessage')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these still toast refusals: ${offenders.join(', ')}`);

  /**
   * `navigate.ts` keeps its toast, and the exemption is the interesting part.
   *
   * It reports that a *view could not be opened*. Answering that by opening a webview panel is
   * asking the thing that just failed to do it again — and if it fails the same way, the reader is
   * told nothing at all. A toast is the correct surface for a failure of the surface.
   */
  const navigate = await readFile(path.join(root, 'apps', 'vscode', 'src', 'views', 'navigate.ts'), 'utf8');
  assert.equal(navigate.split('showErrorMessage').length - 1, 1);
  assert.match(navigate, /Could not open the Singularity Flow view/);

  // Calls, not mentions: the panel's own docblock names the thing it replaces.
  const panel = await readFile(view('result-panel.ts'), 'utf8');
  assert.equal(codeOccurrences(panel, 'showErrorMessage('), 1,
    'the panel keeps exactly one last-resort toast, for a failure to render a failure');
});

test('a v1 command-result becomes a card, with preservation derived from its effects', () => {
  const { view: card, fidelity } = refusalFor(cliError('Submit refused.', V1));
  assert.equal(fidelity, 'command-result-v1');
  assert.equal(card.tone, 'refusal');
  assert.equal(card.why[0].label, 'Approvals are outstanding');
  /**
   * v1 has no `preserved[]` — the field regressed out of v2 and was restored by this work — so the
   * statement is computed from the declared effects record rather than written next to a throw.
   */
  assert.equal(card.preserved.length, 1);
  assert.match(card.preserved[0].label, /Nothing was carried out/);
  assert.equal(card.actions[0].command, 'sflow status --work-id PAY-1187');
  assert.equal(card.actions[0].copilotCommand, '/sf-status');
  assert.equal(card.actions[0].emphasis, 'primary');
});

test('a v1 result that did change something makes no preservation claim', () => {
  // The check that keeps the derivation honest: a half-applied command must not be described as
  // having left everything alone `[DHR:CON-060]`.
  const changed = JSON.parse(V1);
  changed.effects.filesChanged = true;
  const { view: card } = refusalFor(cliError('Failed midway.', JSON.stringify(changed)));
  assert.deepEqual(card.preserved, []);
  assert.equal(card.details.effects, 'filesChanged');
});

test('an error with no structured result claims nothing about preservation', () => {
  /**
   * The most tempting place to lie. "Your work is untouched" is almost always true and is exactly
   * what a refused reader wants to read — and nothing in a bare error message says so.
   */
  const { view: card, fidelity } = refusalFor(cliError('Something went wrong.', 'stack trace here'));
  assert.equal(fidelity, 'message-only');
  assert.deepEqual(card.preserved, []);
  assert.equal(card.why[0].label, 'Something went wrong.');
  assert.match(fidelityNote(fidelity), /no statement here about what was preserved/);
});

test('a deterministic refusal plan becomes safe reviewable VS Code actions', () => {
  const planned = JSON.stringify({
    schemaVersion: 1,
    resultType: 'sflow-refusal-plan',
    status: 'failed',
    error: { code: 'AUTO_DISABLED', message: 'Auto mode is disabled by repository policy.' },
    remediationPlan: {
      schemaVersion: 1, status: 'blocked', code: 'AUTO_DISABLED',
      steps: [
        { id: 'explain', label: 'Understand Auto policy.', command: 'singularity-flow explain auto-mode' },
        { id: 'unsafe', label: 'Never expose this.', command: 'singularity-flow retry --token office-secret' }
      ],
      retry: { label: 'Retry after policy is reviewed.', automatic: false }
    }
  });
  const { view: card, fidelity } = refusalFor(cliError('blocked', planned));
  assert.equal(fidelity, 'refusal-plan-v1');
  assert.equal(card.tone, 'refusal');
  assert.deepEqual(card.preserved, []);
  assert.equal(card.actions.length, 1);
  assert.equal(card.actions[0].command, 'singularity-flow explain auto-mode');
  assert.equal(card.actions[0].skill, '/sf-docs');
  assert.equal(card.actions[0].copilotCommand, '/sf-docs');
  const html = resultCardHtml(card);
  assert.match(html, /Shell:.*singularity-flow explain auto-mode/s);
  assert.match(html, /Copilot:.*\/sf-docs/s);
  assert.equal(card.actions[0].executable, false);
  assert.match(card.actions[0].detail, /never runs/);
  assert.doesNotMatch(JSON.stringify(card), /office-secret/);
  assert.match(fidelityNote(fidelity), /never run them automatically/);
});

test('VS Code derives paired shell and Copilot routes without exposing credential-shaped commands', () => {
  assert.deepEqual(commandGuidance('singularity-flow workspace doctor --network --json'),
    expectedGuidance(
      'singularity-flow workspace doctor --network --json',
      ['workspace', 'doctor', '--network', '--json'],
      '/sf-workspace-bootstrap'
    ));
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow process inspect process.json --json',
    skill: '/sf-sgos',
    copilotCommand: '/sf-sgos process inspect process.json --json'
  }), expectedGuidance(
    'singularity-flow process inspect process.json --json',
    ['process', 'inspect', 'process.json', '--json'],
    '/sf-sgos',
    '/sf-sgos process inspect process.json --json'
  ));
  assert.equal(commandGuidance('singularity-flow retry --token office-secret'), null);
  assert.equal(commandGuidance('git status'), null);
});

test('VS Code accepts only canonical registered command and skill pairs', () => {
  assert.deepEqual(commandGuidance('singularity-flow --help'),
    expectedGuidance('singularity-flow --help', ['--help'], '/sf-help'));
  assert.deepEqual(commandGuidance('singularity-flow status --json'),
    expectedGuidance('singularity-flow status --json', ['status', '--json'], '/sf-status'),
    'a missing producer skill is derived from the closed crosswalk');
  assert.equal(commandGuidance('singularity-flow definitely-unknown --json'), null);
  assert.equal(commandGuidance({
    command: 'singularity-flow status --json', skill: '/sf-does-not-exist'
  }), null);
  assert.equal(commandGuidance({
    command: 'singularity-flow status --json', skill: '/sf-docs'
  }), null);
  assert.equal(commandGuidance({
    command: 'singularity-flow status --json', copilotCommand: '/sf-docs'
  }), null);
  for (const command of [
    'singularity-flow status; touch escaped',
    'singularity-flow status && touch escaped',
    'singularity-flow status | cat',
    'singularity-flow status `touch escaped`',
    'singularity-flow status $(touch escaped)',
    'singularity-flow status > escaped'
  ]) assert.equal(commandGuidance(command), null, command);
});

test('VS Code preserves arguments only for canonical SGOS and Auto relays', () => {
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow process status --json',
    skill: '/sf-sgos',
    copilotCommand: '/sf-sgos process status --json'
  }), expectedGuidance(
    'singularity-flow process status --json',
    ['process', 'status', '--json'],
    '/sf-sgos',
    '/sf-sgos process status --json'
  ));
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow auto pause AFL-1 --json',
    skill: '/sf-auto',
    copilotCommand: '/sf-auto pause AFL-1 --json'
  }), expectedGuidance(
    'singularity-flow auto pause AFL-1 --json',
    ['auto', 'pause', 'AFL-1', '--json'],
    '/sf-auto',
    '/sf-auto pause AFL-1 --json'
  ));
  assert.equal(commandGuidance({
    command: 'singularity-flow process status --json',
    copilotCommand: '/sf-sgos process inspect process.json --json'
  }), null);
  assert.equal(commandGuidance({
    command: 'singularity-flow status --json', copilotCommand: '/sf-status --json'
  }), null);
});

test('VS Code accepts a registered policy-selected generation skill without widening command families', () => {
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow prepare implementation',
    skill: '/sf-code',
    copilotCommand: '/sf-code'
  }), expectedGuidance(
    'singularity-flow prepare implementation',
    ['prepare', 'implementation'],
    '/sf-code'
  ));
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow phase publish convergence --authored deterministic',
    skill: '/sf-converge',
    copilotCommand: '/sf-converge'
  }), expectedGuidance(
    'singularity-flow phase publish convergence --authored deterministic',
    ['phase', 'publish', 'convergence', '--authored', 'deterministic'],
    '/sf-converge'
  ));
  assert.equal(commandGuidance({
    command: 'singularity-flow status --json',
    skill: '/sf-code',
    copilotCommand: '/sf-code'
  }), null);
  assert.equal(commandGuidance({
    command: 'singularity-flow prepare planning', skill: '/sf-code', copilotCommand: '/sf-code'
  }), null);
  assert.equal(commandGuidance({
    command: 'singularity-flow phase publish intake', skill: '/sf-verify', copilotCommand: '/sf-verify'
  }), null);
});

test('VS Code rejects cross-subcommand route escalation and keeps placeholders display-only', () => {
  for (const [command, skill] of [
    ['singularity-flow story adjudicate WRK-1', '/sf-story-start'],
    ['singularity-flow documents view DOC-1', '/sf-upload'],
    ['singularity-flow capability tree --json', '/sf-capability-add'],
    ['singularity-flow workspace list --json', '/sf-workspace-bootstrap'],
    ['singularity-flow jira status', '/sf-jira-update']
  ]) assert.equal(commandGuidance({ command, skill }), null, command);

  const placeholder = commandGuidance(
    'singularity-flow story adjudicate <work-id> --disposition <rework|dismissed> --reason <reason>'
  );
  assert.equal(placeholder?.skill, '/sf-converge');
  assert.equal(placeholder?.copyable, false);
  assert.equal(commandGuidance(
    'singularity-flow story intent-amendment decide amendment-1 --decision approve|reject'
  ), null, 'a raw shell pipe is never presented as an actionable command');
  assert.equal(commandGuidance(
    'singularity-flow story intent-amendment decide amendment-1 --decision <approve|reject>'
  )?.copyable, false, 'a bounded alternative is visible but requires a user choice');
  assert.equal(commandGuidance('singularity-flow status foo<phase>bar'), null);
});

test('a caller headline is used only when the result named nothing itself', () => {
  const plain = refusalFor(cliError('boom'), { headline: 'Could not switch workspace' });
  assert.equal(plain.view.headline, 'Could not switch workspace');

  // A structured result names its own outcome from the catalog; a caller's summary of its own
  // intent must not replace that fact with a paraphrase.
  const structured = refusalFor(cliError('boom', V1), { headline: 'Could not switch workspace' });
  assert.notEqual(structured.view.headline, 'Could not switch workspace');
});

test('a structured result is found even when stderr also carries prose', () => {
  // The CLI prints human lines and JSON in either order depending on the failure.
  const noisy = `Singularity Flow error: submit refused\n${V1}\nSee the log for details.`;
  assert.equal(refusalFor(cliError('x', noisy)).fidelity, 'command-result-v1');
});

test('unparseable stderr degrades to message-only rather than throwing', () => {
  const { fidelity } = refusalFor(cliError('x', '{ not json at all }'));
  assert.equal(fidelity, 'message-only');
});

test('the fidelity of a card is stated, never implied', () => {
  // A reader who can see that a refusal carried no structured result knows why it is thinner than
  // the last one, instead of concluding the product is inconsistent.
  assert.equal(fidelityNote('sflow-result-v2'), null);
  assert.match(fidelityNote('command-result-v1'), /older result contract/);
  assert.match(fidelityNote('refusal-plan-v1'), /deterministic recovery plan/);
  assert.match(fidelityNote('message-only'), /did not report a structured result/);
});
