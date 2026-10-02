import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { commandGuidanceHtml, commandGuidanceText, safeCommandPair } = await import(
  path.join(root, 'apps', 'vscode', 'src', 'views', 'command-guidance.ts'));

test('shared VS Code continuation presentation renders and copies both validated routes', () => {
  const html = commandGuidanceHtml({
    command: 'singularity-flow workspace doctor --json',
    skill: 'sflow-workspace-bootstrap'
  });
  assert.match(html, /Shell/);
  assert.match(html, /singularity-flow workspace doctor --json/);
  assert.match(html, /Copilot/);
  assert.match(html, /\/sf-workspace-bootstrap/);
  assert.match(html, /Copy Shell/);
  assert.match(html, /Copy Copilot/);
  assert.equal(commandGuidanceText('singularity-flow doctor --json'),
    'Shell: singularity-flow doctor --json\nCopilot: /sf-doctor');
});

test('placeholder routes remain visible but cannot be copied as executable commands', () => {
  const html = commandGuidanceHtml('singularity-flow story adjudicate <work-id> --disposition <rework|dismissed> --reason <reason>');
  assert.match(html, /Shell/);
  assert.match(html, /Copilot/);
  assert.match(html, /\/sf-converge/);
  assert.match(html, /Replace the shown placeholders/);
  assert.doesNotMatch(html, /Copy Shell|Copy Copilot/);
});

test('approval presentation pins the phase and Story in the validated Copilot handoff', () => {
  const command = 'singularity-flow approve poc-review-v2 --work-id STORY-17 --fetch';
  const expected = '/sf-approve poc-review-v2 --work-id STORY-17';
  const guidance = safeCommandPair({
    argv: ['approve', 'poc-review-v2', '--work-id', 'STORY-17']
  });
  assert.equal(guidance?.copilotCommand, expected);
  assert.equal(commandGuidanceText(command), `Shell: ${command}\nCopilot: ${expected}`);
  assert.match(commandGuidanceHtml({ command, copilotCommand: expected }), /\/sf-approve poc-review-v2 --work-id STORY-17/);
  assert.equal(safeCommandPair({ command, copilotCommand: '/sf-approve' }), null,
    'an asserted route cannot discard the reviewed phase or Story');
  assert.equal(safeCommandPair({
    command, copilotCommand: '/sf-approve poc-review-v2 --work-id WRONG-1'
  }), null);
  assert.equal(safeCommandPair({
    argv: ['approve', 'poc-review-v2; touch /tmp/pwned', '--work-id', 'STORY-17']
  })?.copilotCommand, '/sf-approve', 'unsafe selectors cannot enter a Copilot invocation');
});

test('legacy bare placeholder routes remain visible but cannot be copied', () => {
  const guidance = safeCommandPair('singularity-flow impact start plan-1 --work-id WORK-ID --work-type TYPE --confirm plan-1');
  assert.ok(guidance);
  assert.equal(guidance.copyable, false);
  assert.equal(guidance.platformCommands, null);
  const html = commandGuidanceHtml(guidance);
  assert.match(html, /Shell:/);
  assert.match(html, /Copilot:/);
  assert.doesNotMatch(html, /data-copy-command/);
});

test('shared VS Code continuation presentation fails closed for hostile and mismatched routes', () => {
  assert.equal(commandGuidanceHtml('singularity-flow doctor --json; touch /tmp/pwned'), '');
  assert.equal(commandGuidanceText({
    command: 'singularity-flow doctor --json',
    skill: 'sflow-submit'
  }), null);
  assert.equal(commandGuidanceHtml({
    command: 'singularity-flow not-a-command --json',
    copilotCommand: '/sf-doctor'
  }), '');
});
