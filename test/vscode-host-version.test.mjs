/**
 * An older VS Code is told plainly what does not work for SFlow there, and that updating VS Code fixes it (owner,
 * 2026-11-12: an office runs VS Code 1.114). A warning only, from `singularity-flow doctor` and from the extension
 * as it activates (vscode-host.test.mjs); 1.141 and later get none.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { answerOfQuestion } from '../src/copilot-answer-binding.mjs';
import { vscodeVersionCheck } from '../src/doctor.mjs';
import { vscodeEditorVersion, vscodeVersionLimits, vscodeVersionWarning } from '../src/vscode-host-version.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('a VS Code older than 1.141 is told what does not work there and that updating fixes it', () => {
  const office = vscodeVersionWarning('1.114.0');
  assert.match(office, /^VS Code 1\.114\.0 is older than 1\.141/u);
  assert.match(office, /agent plugins are still a preview \(setting chat\.plugins\.enabled\)/u);
  assert.match(office, /Chat hooks are not told where SFlow's plugin is[^]*singularity-flow plugin install[^]*every tool call in an SFlow chat is refused/u);
  assert.match(office, /checked on VS Code 1\.145/u);
  assert.match(office, /Fix: Update VS Code/u);
  // Before agent plugins and chat hooks, nothing of SFlow's loads in the chat at all.
  assert.match(vscodeVersionWarning('1.105.1'), /agent plugins and chat hooks are not available yet[^]*the SFlow panels and Copilot CLI still work/u);
  assert.match(vscodeVersionWarning('1.140.9-insider'), /older than 1\.141/u);
  assert.match(vscodeVersionLimits('1.114.0').summary, /^VS Code 1\.114\.0 is older than 1\.141[^]*Update VS Code, then reload the window\.$/u);
});

test('VS Code 1.141 and later, or a version that cannot be read, gets no warning', () => {
  for (const version of ['1.141.0', '1.141.0-insider', '1.145.2', '1.146.0', '2.0.0', '', 'unknown', null, undefined]) {
    assert.equal(vscodeVersionWarning(version), null, String(version));
    assert.equal(vscodeVersionLimits(version), null, String(version));
  }
});

test('the VS Code version comes from its own terminal, else the code command, else nowhere', () => {
  assert.equal(vscodeEditorVersion({ env: { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.114.0' } }), '1.114.0');
  const calls = [];
  const execute = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '1.146.0\n0123abcd\narm64\n' }; };
  assert.equal(vscodeEditorVersion({ env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5' }, exists: () => true, execute }), '1.146.0');
  assert.deepEqual(calls, [['code', '--version']]);
  assert.equal(vscodeEditorVersion({ env: {}, exists: () => false, execute }), null, 'no code command, no version');
  assert.equal(vscodeEditorVersion({ env: {}, exists: () => true, execute: () => ({ status: 1, stdout: '' }) }), null);
});

test('doctor warns on a VS Code older than 1.141, passes a newer one, and says nothing without one', async (t) => {
  const old = await vscodeVersionCheck('1.114.0');
  assert.equal(old.id, 'vscode-version');
  assert.equal(old.status, 'warn');
  assert.match(old.message, /^VS Code 1\.114\.0 is older than 1\.141[^]*chat\.plugins\.enabled[^]*singularity-flow plugin install/u);
  assert.match(old.fix, /^Update VS Code/u);
  const current = await vscodeVersionCheck('1.146.0');
  assert.deepEqual([current.status, current.message, current.fix], ['pass', 'VS Code 1.146.0.', null]);
  assert.equal(await vscodeVersionCheck(null), null);

  // The command, run from VS Code's own terminal: a warning, never a failure of its own.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', directory]);
  spawnSync('git', ['-c', 'user.name=Doctor Test', '-c', 'user.email=doctor@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: directory });
  const doctor = (version) => {
    const result = spawnSync(process.execPath, [cli, '--no-model', 'doctor', '--offline', '--json'], { cwd: directory, encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: version }, timeout: childTimeout(120_000) });
    return JSON.parse(result.stdout).checks.find((entry) => entry.id === 'vscode-version');
  };
  assert.equal(doctor('1.114.0').status, 'warn');
  assert.equal(doctor('1.146.0').status, 'pass');
});

test('on another VS Code than 1.145, a question\'s answer in another shape is still read by the person\'s own words', () => {
  // Read as JSON text, its escaping made the person's own words read as not theirs: "\\"retry\\"" is not "retry".
  const words = 'rework: the "retry" path\nis wrong';
  assert.deepEqual(answerOfQuestion({ tool_name: 'vscode_askQuestions', tool_response: JSON.stringify({ 'Which way?': { answer: words, skipped: false } }) }),
    { canned: false, texts: ['rework: the "retry" path is wrong'] });
  // VS Code 1.145's own shape, and Copilot CLI's text, read as before.
  assert.deepEqual(answerOfQuestion({ tool_response: JSON.stringify({ answers: { A: { selected: ['Yes'], freeText: 'Because.', skipped: false } } }) }),
    { texts: ['yes', 'because'], canned: false });
  assert.deepEqual(answerOfQuestion({ toolResult: { textResultForLlm: 'User responded: rework' } }), { texts: ['rework'], canned: false });
});
