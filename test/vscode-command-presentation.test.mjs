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
