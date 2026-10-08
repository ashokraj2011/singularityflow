import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyGitRemoteFailure, gitFailureDiagnostic } from '../src/git-remote-diagnostics.mjs';
import { probeStoryBranchPublication, storyPublicationPreflightError } from '../src/story-publication-preflight.mjs';
import { capturePushWorktree, observePublicationHookEffects, publicationFailureMessage } from '../src/git-hook-effects.mjs';
import { publicationPushOutcome, pushCommitToBranchAsync, refHead } from '../src/git.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { reportCliFailure } from '../src/cli-failure.mjs';
import { run } from '../src/util.mjs';

const failed = (stderr, stdout = '') => ({ status: 1, stdout, stderr });

test('local hook failures identify the missing tool and runtime without blaming Git authentication', () => {
  for (const tool of ['pm', 'npm', 'pnpm', 'yarn', 'node', 'npm.cmd']) {
    const failure = classifyGitRemoteFailure(failed(`.husky/pre-push: line 7: ${tool}: command not found\nerror: failed to push some refs`));
    assert.equal(failure.classification, 'local-hook-tool-unavailable');
    assert.equal(failure.hook.tool, tool);
    assert.equal(failure.hook.line, 7);
    assert.equal(failure.hook.environment, 'calling-process');
    assert.equal(failure.hook.runtimeFamily, tool === 'pm' ? 'not-determined' : 'node-package-manager');
    assert.equal(failure.retryable, false);
  }
  const windows = classifyGitRemoteFailure(failed('C:\\repo\\.husky\\pre-push: 7: pnpm: not found'));
  assert.equal(windows.hook.tool, 'pnpm');
  const windowsCmd = classifyGitRemoteFailure(failed("'npm' is not recognized as an internal or external command\nhusky - pre-push script failed (code 1)"));
  assert.equal(windowsCmd.hook.tool, 'npm');
  assert.equal(classifyGitRemoteFailure(failed('husky - pre-push script failed (code 1)')).classification, 'local-hook-failed');
  assert.equal(classifyGitRemoteFailure(failed('remote: .husky/pre-push: line 7: pnpm: command not found\nremote: pre-receive hook declined')).classification, 'policy-rejected');
  assert.equal(classifyGitRemoteFailure(failed('fatal: Authentication failed')).classification, 'authentication-required');
});

test('hook recovery has a concrete human repair and no generic workspace-help dead end', () => {
  const result = failed('.husky/pre-push: line 7: pnpm: command not found');
  const error = storyPublicationPreflightError(result, { branch: 'news-filter-e2e', remote: 'origin', repository: 'bond-r1' });
  const envelope = refusalEnvelope(error, ['workspace', 'start']);
  assert.equal(envelope.error.remoteFailure.hook.tool, 'pnpm');
  assert.match(envelope.remediationPlan.steps[0].label, /pre-push.*line 7.*pnpm/);
  assert.match(envelope.remediationPlan.steps[1].label, /IDE.*Husky/);
  assert.ok(!envelope.remediationPlan.steps.some((step) => step.command?.includes('workspace --help')));
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  assert.match(envelope.remediationPlan.retry.label, /runtime has changed/);
  assert.equal(envelope.error.details.publicationPreflight.localHooks, 'not-run');
  assert.equal(envelope.error.details.publicationPreflight.remotePolicyVerified, false);
  assert.doesNotMatch(error.message, /Nothing was changed/);
});

test('both Git output streams are bounded and redacted before presentation', () => {
  const token = `ghp_${'x'.repeat(30)}`;
  const diagnostic = gitFailureDiagnostic(failed('fatal: hook failed\n' + 'x'.repeat(10000),
    `Tests failed before push\nhttps://user:private-password@git.example.test/team.git\n${token}`));
  assert.match(diagnostic, /stdout:.*Tests failed/s);
  assert.match(diagnostic, /stderr:.*hook failed/s);
  assert.doesNotMatch(diagnostic, /private-password|ghp_/);
  assert.ok(diagnostic.length < 8250);
});

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-publish-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'checkout');
  const remote = path.join(base, 'origin.git');
  const git = (cwd, ...args) => run('git', args, { cwd });
  git(base, 'init', '--bare', '--initial-branch=main', remote);
  git(base, 'clone', '--quiet', remote, root);
  git(root, 'config', 'user.name', 'Hook fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(root, 'source.txt'), 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'push', '--quiet', 'origin', 'main');
  return { root, remote, hook: path.join(root, '.git/hooks/pre-push') };
}

test('intake probe skips local hooks; actual publication enforces them and retains generated files', async (t) => {
  const { root, remote, hook } = await repository(t);
  await writeFile(hook, '#!/bin/sh\nprintf "retained report\\n" > hook-report.txt\nsflow_missing_hook_tool_for_test\n');
  await chmod(hook, 0o755);
  const before = capturePushWorktree(root);
  const probe = await probeStoryBranchPublication(root, remote, 'HEAD', 'refs/heads/news-filter-e2e');
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(capturePushWorktree(root).fingerprint, before.fingerprint);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/news-filter-e2e'], { cwd: remote, allowFailure: true }).status, 1);

  const result = await pushCommitToBranchAsync(root, 'origin', refHead(root, 'HEAD'), 'news-filter-e2e', { expectedRemoteSha: null, transportRemote: remote });
  assert.notEqual(result.status, 0);
  assert.equal(result.failure.classification, 'local-hook-tool-unavailable');
  assert.equal(result.hookWorktree.status, 'changed');
  assert.deepEqual(result.hookWorktree.changedPaths, ['hook-report.txt']);
  assert.match(result.stderr, /All files were retained/);
  assert.equal((publicationFailureMessage(result).match(/Repair the command named/g) ?? []).length, 1,
    'legacy callers must not render the same hook guidance twice');
  assert.equal(await readFile(path.join(root, 'hook-report.txt'), 'utf8'), 'retained report\n');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/news-filter-e2e'], { cwd: remote, allowFailure: true }).status, 1);

  await writeFile(hook, '#!/bin/sh\nexit 0\n');
  const retry = await pushCommitToBranchAsync(root, 'origin', refHead(root, 'HEAD'), 'news-filter-e2e', { expectedRemoteSha: null, transportRemote: remote });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(refHead(remote, 'refs/heads/news-filter-e2e'), refHead(root, 'HEAD'));
  assert.equal(await readFile(path.join(root, 'hook-report.txt'), 'utf8'), 'retained report\n');
});

test("Git's ignored-hook hint is not a hook failure and keeps a lost push response indeterminate", async (t) => {
  const hint = "hint: The '.git/hooks/pre-push' hook was ignored because it's not set as executable.\n"
    + 'hint: You can disable this warning with `git config set advice.ignoredHook false`.\n';
  const lost = { status: 128, stdout: '', stderr: `${hint}fatal: the remote end hung up unexpectedly\n` };
  assert.equal(classifyGitRemoteFailure(lost).classification, 'network-transient');
  assert.equal(classifyGitRemoteFailure(lost).hook, undefined);
  assert.equal(publicationPushOutcome(lost), 'transport-indeterminate',
    'a response lost after the remote may have accepted the update must stay reconcilable');
  assert.equal(classifyGitRemoteFailure(failed(`${hint}fatal: Authentication failed`)).classification, 'authentication-required');

  const { root, hook } = await repository(t);
  await writeFile(hook, '#!/bin/sh\nexit 0\n');
  await chmod(hook, 0o644);
  run('git', ['config', 'advice.ignoredHook', 'true'], { cwd: root });
  await writeFile(path.join(root, 'source.txt'), 'changed\n');
  run('git', ['commit', '-qam', 'second'], { cwd: root });
  // A lease that expects `main` to be absent is stale: a definite rejection that names no hook.
  const result = await pushCommitToBranchAsync(root, 'origin', refHead(root, 'HEAD'), 'main', { expectedRemoteSha: null });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hooks[\\/]pre-push' hook was ignored/);
  assert.equal(result.failure.hook, undefined);
  assert.doesNotMatch(result.failure.classification, /^local-hook/);
});

test('observation unavailable is never asserted to mean unchanged', async () => {
  const result = await observePublicationHookEffects('/absent', async () => failed('hook failed'), { capture: () => null });
  assert.equal(result.hookWorktree.status, 'unavailable');
  assert.equal(result.hookWorktree.filesDiscarded, false);
});

test('terminal and JSON error presentation both redact hook secrets', async () => {
  const original = { error: console.error, log: console.log, exitCode: process.exitCode };
  const token = `ghp_${'y'.repeat(30)}`;
  const error = Object.assign(new Error(`.husky/pre-push: line 7: npm: command not found ${token}`), { code: 'STORY_PUBLICATION_PREFLIGHT_FAILED' });
  try {
    for (const argv of [[], ['--json']]) {
      const lines = [];
      console.error = (value) => lines.push(String(value));
      console.log = (value) => lines.push(String(value));
      await reportCliFailure(error, argv);
      assert.doesNotMatch(lines.join('\n'), /ghp_/);
      assert.match(lines.join('\n'), /pre-push/);
    }
  } finally {
    console.error = original.error; console.log = original.log; process.exitCode = original.exitCode;
  }
});
