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
import { storyPublicationPreflightError } from '../src/story-publication-preflight.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const { fidelityNote, refusalFor } = await import(view('refusal.ts'));
const { resultCardHtml } = await import(view('result-card-page.ts'));
const { commandGuidance } = await import(path.join(root, 'apps', 'vscode', 'src', 'copilot-command.ts'));
const { terminalCommand } = await import(path.join(root, 'apps', 'vscode', 'src', 'cli', 'runner.ts'));

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

test('the card reads the parsed result, not stderr cut short for display', () => {
  // A refusal that carries its findings can outgrow the display bound on stderr; the runner keeps
  // the complete parsed object on CliError.result.
  const truncated = `${V1.slice(0, 120)}… (truncated)`;
  const error = Object.assign(cliError('Submit refused.', truncated), { result: JSON.parse(V1) });
  const { view: card, fidelity } = refusalFor(error);
  assert.equal(fidelity, 'command-result-v1');
  assert.equal(card.why[0].label, 'Approvals are outstanding');
  assert.equal(refusalFor(Object.assign(cliError('x', V1), { result: { resultType: 'unknown' } })).fidelity, 'command-result-v1',
    'an unrecognised parsed result falls back to the text');
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
  assert.deepEqual(card.actions.map(({ command, copilotCommand }) => ({ command, copilotCommand })), [
    { command: 'singularity-flow doctor --json', copilotCommand: '/sf-doctor' },
    { command: 'singularity-flow recommend --json', copilotCommand: '/sf-recommend' }
  ]);
  assert.equal(card.rest, null);
  assert.match(fidelityNote(fidelity), /no statement here about what was preserved/);
});

test('a native authority error keeps safe diagnostics and omits raw provider details', () => {
  const error = Object.assign(new Error(
    'Cannot read Story configuration authority. Run workspace doctor --network and inspect Git access outside SFlow before retrying.'
  ), {
    code: 'REMOTE_UNKNOWN',
    details: {
      classification: 'unknown',
      retryable: false,
      remote: 'https://example.invalid/RuleEngineUI.git',
      diagnostic: 'https://credential-user:office-secret@example.invalid/private.git'
    }
  });
  const { view: card, fidelity } = refusalFor(error, { headline: 'Could not read the Story configuration authority' });
  assert.equal(fidelity, 'message-only');
  assert.equal(card.headline, 'Could not read the Story configuration authority');
  assert.deepEqual(card.preserved, []);
  assert.deepEqual(card.actions.map(({ command, copilotCommand }) => ({ command, copilotCommand })), [
    {
      command: 'singularity-flow workspace doctor --network --repository https://example.invalid/RuleEngineUI.git --json',
      copilotCommand: '/sf-workspace-bootstrap'
    }
  ]);
  assert.doesNotMatch(JSON.stringify(card.actions), /wm doctor/);
  assert.equal(card.rest, null);
  assert.equal(card.details.code, 'REMOTE_UNKNOWN');
  assert.equal(card.details.classification, 'unknown');
  assert.equal(card.details.retryable, 'false');
  assert.doesNotMatch(JSON.stringify(card), /office-secret|credential-user/);
  assert.doesNotMatch(resultCardHtml(card), /There is no step you can take here right now/);
});

test('authority recovery remains bound to the exact repository when copied from VS Code', () => {
  const error = Object.assign(new Error(
    'Cannot read Story configuration authority. Inspect the exact authority and retry.'
  ), {
    code: 'REMOTE_UNKNOWN',
    details: {
      classification: 'unknown', retryable: false,
      remote: 'https://example.invalid/RuleEngineUI.git'
    }
  });
  const repositoryRoot = path.join(root, 'fixtures', 'RuleEngineUI');
  const { view: card } = refusalFor(error, { repositoryRoot });
  assert.deepEqual(card.actions.map(({ command }) => command), [
    terminalCommand(repositoryRoot, [
      'workspace', 'doctor', '--network', '--repository',
      'https://example.invalid/RuleEngineUI.git', '--json'
    ])
  ]);
  assert.match(card.actions[0].detail, /exact repository/);
  assert.match(card.actions[0].detail, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.doesNotMatch(card.actions[0].command, /singularity-platform/);
});

test('an authority refusal without a validated remote never diagnoses unrelated bootstrap remotes', () => {
  const error = Object.assign(new Error('Cannot read Story configuration authority.'), {
    code: 'REMOTE_UNKNOWN',
    details: { classification: 'unknown', retryable: false }
  });
  const { view: card } = refusalFor(error, {
    repositoryRoot: '/Users/example/RuleEngineUI'
  });
  assert.match(card.actions[0].command, /'singularity-flow' 'doctor' '--json'$/);
  assert.doesNotMatch(card.actions[0].command, /workspace' 'doctor/);
});

test('a credential-shaped authority is never copied into exact recovery guidance', () => {
  const error = Object.assign(new Error('Cannot read Story configuration authority.'), {
    code: 'REMOTE_UNKNOWN',
    details: {
      classification: 'unknown', retryable: false,
      remote: 'https://credential-user:office-secret@example.invalid/private.git'
    }
  });
  const { view: card } = refusalFor(error, {
    repositoryRoot: '/Users/example/RuleEngineUI'
  });
  assert.match(card.actions[0].command, /'singularity-flow' 'doctor' '--json'$/);
  assert.doesNotMatch(JSON.stringify(card), /office-secret|credential-user/);
});

test('a World Model failure offers the Repository brief, never wm doctor, and bounds native metadata', () => {
  const failures = [
    Object.assign(new Error('World Model rejected an unsupported view.'), {
      code: 'WMB_VIEW_UNKNOWN',
      details: { classification: 'office-secret-class', retryable: true }
    }),
    Object.assign(new Error(
      "World-model view 'arch.contracts' was refused: Model execution requires a registered Singularity Flow operation context."
    ), { code: 'MODEL_CONTEXT_MISSING' })
  ];
  for (const error of failures) {
    const { view: card } = refusalFor(error, { headline: 'Could not read the World Model' });
    assert.deepEqual(card.actions.map(({ command }) => command), [
      'singularity-flow wm brief --phase <phase>',
      'singularity-flow recommend --json'
    ], error.message);
    assert.doesNotMatch(JSON.stringify(card.actions), /wm doctor|registered-v4/);
    assert.equal(card.details.classification, undefined);
    assert.doesNotMatch(JSON.stringify(card), /office-secret-class/);
  }
  assert.equal(refusalFor(failures[0]).view.details.code, 'WMB_VIEW_UNKNOWN');
  const repositoryRoot = '/Users/example/RuleEngineUI';
  assert.deepEqual(refusalFor(failures[0], { repositoryRoot }).view.actions.map(({ command }) => command), [
    terminalCommand(repositoryRoot, ['wm', 'brief', '--phase', '<phase>']),
    terminalCommand(repositoryRoot, ['recommend', '--json'])
  ], 'the brief is copied bound to the exact repository');
});

function modelBudgetRefusal(modelBudget) {
  const error = Object.assign(new Error(
    'Provider reported 64001 total tokens, exceeding its 64000-token invocation budget.'
  ), { code: 'MODEL_TOKEN_BUDGET_EXCEEDED', details: { modelBudget } });
  return Object.assign(cliError(error.message), { result: refusalEnvelope(error, ['wm', 'brief', '--phase', 'design']) });
}

test('a model-budget refusal plan shows actual usage and omits raw provider details', () => {
  const { view: card, fidelity } = refusalFor(modelBudgetRefusal({
    logicalPromptTokensEstimate: 7426, maximumPromptTokensEstimate: 8000,
    maximumOutputBytes: 5600, maximumTotalTokens: 64000, observedTotalTokens: 64001,
    providerInputTokens: 63000, providerOutputTokens: 1001,
    providerTranscript: 'office-secret', providerOverheadTokens: 55555
  }), { repositoryRoot: '/Users/example/calc' });
  assert.equal(fidelity, 'refusal-plan-v1');
  assert.equal(card.details.observedTotalTokens, 64001);
  assert.equal(card.details.maximumTotalTokens, 64000);
  assert.equal(card.details.providerInputTokens, 63000);
  assert.equal(card.details.providerOutputTokens, 1001);
  assert.equal(card.details.logicalPromptTokensEstimate, 7426);
  assert.equal(card.details.maximumOutputBytes, 5600);
  assert.ok(card.actions.every(action => action.executable === false));
  assert.deepEqual(card.preserved, []);
  assert.doesNotMatch(JSON.stringify(card), /office-secret|55555|providerOverheadTokens/);
});

test('unavailable provider usage stays absent rather than becoming zero or inferred overhead', () => {
  const { view: card } = refusalFor(modelBudgetRefusal({ providerTranscript: 'office-secret' }));
  assert.equal(card.details.observedTotalTokens, undefined);
  assert.equal(card.details.providerInputTokens, undefined);
  assert.equal(card.details.maximumTotalTokens, undefined);
  assert.doesNotMatch(JSON.stringify(card), /office-secret/);
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

test('missing Story configuration has exact-repository recovery actions and a manual setup route', async () => {
  const error = Object.assign(new Error('No approved configuration could be loaded.'), {
    code: 'STORY_CONFIGURATION_AUTHORITY_MISSING'
  });
  const envelope = refusalEnvelope(error, ['start', 'RECOVER-1', '--json']);
  const repositoryRoot = path.join(root, 'fixtures', 'missing configuration');
  const { view: card, fidelity } = refusalFor(
    Object.assign(cliError(error.message), { result: envelope }), { repositoryRoot }
  );
  assert.equal(fidelity, 'refusal-plan-v1');
  assert.deepEqual(card.actions.map(entry => entry.command), [
    terminalCommand(repositoryRoot, ['workspace', 'doctor', '--network', '--json']),
    terminalCommand(repositoryRoot, ['workspace', 'reinitialize', '--dry-run', '--json'])
  ]);
  assert.ok(card.actions.every(entry => entry.executable === false && entry.copilotCommand?.startsWith('/sf-')));
  assert.match(card.warnings[0].label, /Map a capability.*same Story ID/u);
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  const html = resultCardHtml(card);
  assert.match(html, /Copilot:.*\/sf-workspace-bootstrap/su);
  assert.doesNotMatch(html, /There is no step you can take here right now/u);
  assert.deepEqual(card.preserved, [], 'guidance must not invent an effects receipt');

  const intake = await readFile(view('intake-panel.ts'), 'utf8');
  assert.match(intake, /const startRepository = this\.client\.repository/u);
  assert.match(intake, /this\.disposed \|\| this\.client\.repository !== startRepository/u);
  assert.match(intake, /showRefusal\(failure, \{\s*headline: 'Story intake needs recovery', repositoryRoot: startRepository/su);
});

test('manual recovery instructions render without crowding safe actions out of the VS Code card', () => {
  const planned = {
    schemaVersion: 1, resultType: 'sflow-refusal-plan', status: 'failed',
    error: { code: 'RECOVERY_AUTOMATIC_ACTION_UNAVAILABLE' }, remediationPlan: { steps: [
      { id: 'manual', label: 'Have the repository owner review the preserved README changes.', command: null },
      { id: 'unsafe', label: 'Unsafe command.', command: 'singularity-flow status; touch escaped' },
      { id: 'read-status', label: 'Read status.', command: 'singularity-flow status --json' },
      { id: 'read-phase', label: 'Inspect the phase.', command: 'singularity-flow phase show implementation --json' },
      { id: 'read-logs', label: 'Read logs.', command: 'singularity-flow logs --tail 20' }
    ] }
  };
  const { view: card } = refusalFor(cliError('No automatic action', JSON.stringify(planned)));
  assert.equal(card.actions.length, 3);
  assert.equal(card.actions[0].emphasis, 'primary');
  assert.ok(card.actions.every(entry => entry.executable === false));
  assert.deepEqual(card.warnings, [{ label: planned.remediationPlan.steps[0].label }]);
  assert.match(resultCardHtml(card), /repository owner review the preserved README/);
  assert.doesNotMatch(JSON.stringify(card), /touch escaped/);
  assert.deepEqual(card.preserved, [], 'guidance is not an effects receipt');
  planned.remediationPlan.steps = [planned.remediationPlan.steps[0]];
  const manual = refusalFor(cliError('Human review needed', JSON.stringify(planned))).view;
  assert.equal(manual.actions.length, 0);
  assert.match(resultCardHtml(manual), /repository owner review the preserved README/,
    'no executable command does not mean no recovery instruction');
  planned.remediationPlan.steps.push(null);
  assert.doesNotThrow(() => refusalFor(cliError('Human review needed', JSON.stringify(planned))));
});

test('local hook recovery instructions reach the VS Code card without offering a hook bypass', () => {
  const error = storyPublicationPreflightError({ status: 1, stdout: '',
    stderr: '.husky/pre-push: line 7: pnpm: command not found' }, { branch: 'STORY-HOOK', remote: 'origin' });
  const envelope = refusalEnvelope(error, ['start', 'STORY-HOOK']);
  const { view: card } = refusalFor(cliError(error.message, JSON.stringify(envelope)));
  const html = resultCardHtml(card);
  assert.match(html, /pre-push.*line 7.*pnpm/);
  assert.match(html, /IDE.*Husky/);
  assert.match(html, /Preserve|preserve/);
  assert.ok(card.actions.every((entry) => entry.executable === false));
  assert.doesNotMatch(JSON.stringify(card.actions), /--no-verify|core\.hooksPath|workspace --help/);
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
  // A step's name confers no authority and `/sf-code` re-reads the step's verified route, so any
  // step may present it: a step called convergence may deliver code, as one called anything may converge.
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow prepare planning', skill: '/sf-code', copilotCommand: '/sf-code'
  }), expectedGuidance('singularity-flow prepare planning', ['prepare', 'planning'], '/sf-code'));
  assert.deepEqual(commandGuidance({
    command: 'singularity-flow prepare convergence', skill: '/sf-code', copilotCommand: '/sf-code'
  }), expectedGuidance('singularity-flow prepare convergence', ['prepare', 'convergence'], '/sf-code'));
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
