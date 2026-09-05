import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeGitDiagnosticReference } from '../src/git-remote-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(absolute, output);
    else if (/\.(?:mjs|js|ts)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

test('remote Git cannot bypass the bounded non-interactive execution boundary', async () => {
  const files = await sourceFiles(path.join(root, 'src'));
  const allowedLocalCopies = new Set([
    // Each source is a verified local path or scratch repository, not a network authority.
    'configuration-branch.mjs:fetch',
    'configuration-people.mjs:fetch',
    'first-run-guide.mjs:clone',
    'workspace-impact.mjs:clone',
    // The refresh cache copies from its already-validated local disposable checkout; it never
    // addresses a transport authority and apply re-observes the exact remote SHAs independently.
    'workspace-configuration-refresh.mjs:clone'
  ]);
  const violations = [];
  const direct = /run\('git',\s*\[\s*['"](ls-remote|fetch|push|pull|clone)['"]/g;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(direct)) {
      const key = `${path.basename(file)}:${match[1]}`;
      if (!allowedLocalCopies.has(key)) violations.push(key);
    }
  }
  assert.deepEqual(violations, [],
    'remote Git must use runRemoteGit/runRemoteGitAsync so it has timeouts and no hidden prompts');

  const boundary = await readFile(path.join(root, 'src/git-execution.mjs'), 'utf8');
  assert.match(boundary, /GIT_TERMINAL_PROMPT:\s*'0'/);
  assert.match(boundary, /GCM_INTERACTIVE:\s*'Never'/);
  assert.match(boundary, /SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS/);
  assert.match(boundary, /SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS/);
  assert.match(boundary, /SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS/);
});

test('the VS Code authority repair uses the same non-interactive office-safe contract', async () => {
  const runner = await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8');
  assert.match(runner, /function nonInteractiveGitEnvironment/);
  assert.match(runner, /GIT_TERMINAL_PROMPT:\s*'0'/);
  assert.match(runner, /GCM_INTERACTIVE:\s*'Never'/);
  assert.match(runner, /timeout:\s*30_000/);
  assert.match(runner, /timeout:\s*120_000/);
});

test('interactive onboarding and refresh never use the synchronous remote Git boundary', async () => {
  for (const relative of [
    'src/bootstrap.mjs',
    'src/configuration-people.mjs',
    'src/configuration-proposal.mjs',
    'src/organisation.mjs',
    'src/workspace-bootstrap.mjs',
    'src/workspace-configuration-refresh.mjs'
  ]) {
    const source = await readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /\brunRemoteGit\(/,
      `${relative} can block the UI/CLI event loop and cannot supervise a descendant process tree`);
  }
});

test('post-clone Git diagnostics retain correlation without disclosing helper output', () => {
  const secret = 'Authorization: Bearer office-secret-must-not-leak';
  const message = safeGitDiagnosticReference({
    status: 1,
    stdout: '',
    stderr: `credential helper failed: ${secret}`
  }, 'Sparse checkout failed');
  assert.match(message, /^Sparse checkout failed \(exit 1; diagnostic sha256:[0-9a-f]{16}\)$/);
  assert.doesNotMatch(message, /office-secret|Authorization|credential helper/);
});
