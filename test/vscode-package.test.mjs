import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_PAYLOAD, configureLocalDemoWorkflow, stageCli } from '../scripts/vscode-dev.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the installed VS Code CLI carries the canonical Help manual', async () => {
  assert.ok(CLI_PAYLOAD.includes('HELP.md'), 'HELP.md is part of the declared installed payload');

  const extension = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-package-'));
  const staged = await stageCli({ rootDir: root, extensionDir: extension });
  const result = spawnSync(process.execPath, [
    path.join(staged, 'bin', 'singularity-flow.mjs'), 'help', '--json'
  ], { cwd: extension, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manual = JSON.parse(result.stdout);
  assert.equal(manual.title, 'Singularity Flow Help');
  assert.ok(manual.topics.some((topic) => topic.id === 'story-intake'));
  assert.ok(manual.topics.some((topic) => topic.id === 'workspaces-and-capabilities'));
});

test('the local VS Code demo does not require a remote it deliberately omits', () => {
  const configured = configureLocalDemoWorkflow([
    'git:',
    '  remote: origin',
    '  publish: required',
    'worldModel:',
    '  grounding: warn'
  ].join('\n'));
  assert.match(configured, /publish: off/);
  assert.match(configured, /grounding: off/);
  assert.doesNotMatch(configured, /publish: required/);
});
