/**
 * A configuration proposal (an imported workflow, a Studio publish) is committed on this computer
 * and uploaded in the background. That upload makes one attempt and never answers a sign-in prompt,
 * so on an office machine it often stopped, and the proposal, in no remote review list, could not
 * be found: the message pointed to a "Push recovery" view that VS Code does not have.
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTransportIntent, retryTransportIntent, transportIntentsForRepository
} from '../src/transport-intents.mjs';
import { run } from '../src/util.mjs';

const { WORKFLOW_STUDIO_SCRIPT, localProposalUploads } = await import('../apps/vscode/src/views/workflow-studio-page.ts');

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-uploads-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bare = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  run('git', ['init', '-q', '--bare', bare]);
  run('git', ['init', '-q', '-b', 'main', work]);
  run('git', ['config', 'user.name', 'Upload Tester'], { cwd: work });
  run('git', ['config', 'user.email', 'upload@example.invalid'], { cwd: work });
  await writeFile(path.join(work, 'README.md'), 'first\n');
  run('git', ['add', 'README.md'], { cwd: work });
  run('git', ['commit', '-qm', 'first'], { cwd: work });
  run('git', ['remote', 'add', 'origin', bare], { cwd: work });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
  const env = { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox') };
  return { base, bare, work, commit, env, options: { env, home: base } };
}

/** The remote refuses every push, as a server rule or a missing sign-in would. */
async function refusePushes(bare) {
  const hook = path.join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho "refused by the server" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  return () => rm(hook, { force: true });
}

test('a person retrying an upload always gets an attempt, even after the automatic budget is spent', async (t) => {
  const item = await fixture(t);
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config-change/workflow/import-workflows-demo-0123abcd'
  }, item.options);
  const allow = await refusePushes(item.bare);
  const explicit = { ...item.options, allowNeedsUser: true };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const failed = await retryTransportIntent(created.intentId, explicit);
    assert.notEqual(failed.status, 'succeeded');
    assert.equal(failed.attemptBudget.used, attempt);
  }
  await allow();
  // The budget (2) is spent. Before, this returned "attempt-budget-exhausted" without trying, and
  // the proposal could never be uploaded.
  const uploaded = await retryTransportIntent(created.intentId, explicit);
  assert.equal(uploaded.status, 'succeeded');
  assert.equal(uploaded.attemptBudget.used, 3);
  assert.equal(run('git', ['--git-dir', item.bare, 'rev-parse', created.targetRef]).stdout.trim(), item.commit);
});

test('an automatic retry still stops at the budget', async (t) => {
  const item = await fixture(t);
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config-change/workflow/import-workflows-demo-1123abcd'
  }, item.options);
  await refusePushes(item.bare);
  const explicit = { ...item.options, allowNeedsUser: true };
  await retryTransportIntent(created.intentId, explicit);
  const spent = await retryTransportIntent(created.intentId, explicit);
  assert.equal(spent.attemptBudget.used, 2);
  const automatic = await retryTransportIntent(created.intentId, item.options)
    .then((intent) => intent, (error) => ({ status: error.code }));
  assert.ok(['attempt-budget-exhausted', 'TRANSPORT_INTENT_NEEDS_USER'].includes(automatic.status), JSON.stringify(automatic));
});

test("a repository's uploads are found from any of its checkouts, and only its own", async (t) => {
  const item = await fixture(t);
  const created = await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config-change/workflow/import-workflows-demo-2123abcd'
  }, item.options);
  const worktree = path.join(item.base, 'story');
  run('git', ['worktree', 'add', '-q', '-b', 'STORY-1', worktree], { cwd: item.work });
  const other = await fixture(t);
  const ids = async (root, options) => (await transportIntentsForRepository(root, options)).map((intent) => intent.intentId);
  assert.deepEqual(await ids(item.work, item.options), [created.intentId]);
  assert.deepEqual(await ids(worktree, item.options), [created.intentId], 'a Story worktree pushes to the same remote');
  assert.deepEqual(await ids(other.work, item.options), [], 'another repository is not listed');
});

test('the extension shows only real, unfinished proposal uploads, and offers sign-in when that is what failed', () => {
  const intent = (fields) => ({
    intentId: 'psh_0123456789abcdef0123', targetRef: 'refs/heads/sflow/config-change/workflow/import-workflows-demo-0123abcd',
    status: 'needs-user', remote: 'origin', repositoryRoot: '/work/app', attemptBudget: { used: 1, maximum: 2 },
    fault: { classification: 'authentication-required', advice: 'Sign in to Git or configure its credential helper, then retry.' },
    createdAt: '2026-10-14T10:00:00.000Z', ...fields
  });
  const uploads = localProposalUploads({ data: { intents: [
    intent({}),
    intent({ intentId: 'psh_1123456789abcdef0123', status: 'succeeded' }),
    intent({ intentId: 'psh_2123456789abcdef0123', targetRef: 'refs/heads/main' }),
    intent({ intentId: 'not-an-intent' }),
    intent({ intentId: 'psh_3123456789abcdef0123', status: 'remote-diverged', fault: null })
  ] } });
  assert.deepEqual(uploads.map((upload) => [upload.intentId, upload.signIn, upload.retryable]), [
    ['psh_0123456789abcdef0123', true, true],
    ['psh_3123456789abcdef0123', false, false]
  ]);
  assert.equal(uploads[0].branch, 'sflow/config-change/workflow/import-workflows-demo-0123abcd');
  assert.deepEqual(localProposalUploads({ data: { intent: intent({}) } }).length, 1, 'a single retry result reads the same way');

  const window = { __sfVscode: { postMessage() {} }, addEventListener() {} };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, { getElementById: () => null });
  const view = window.__workflowStudio.uploadView(uploads[0]);
  assert.deepEqual([view.status, view.actions], ['Needs you', ['retry', 'sign-in']]);
  assert.match(view.reason, /Sign in to Git/u);
  const diverged = window.__workflowStudio.uploadView(uploads[1]);
  assert.deepEqual(diverged.actions, [], 'a changed remote branch cannot be retried; import again');
  assert.match(diverged.reason, /Import the bundle again/u);
});

test('the CLI names a proposal saved here but not uploaded, instead of saying nothing is waiting', async (t) => {
  const item = await fixture(t);
  await createTransportIntent({
    repositoryRoot: item.work, sourceCommit: item.commit,
    targetRef: 'refs/heads/sflow/config-change/workflow/import-workflows-demo-3123abcd'
  }, item.options);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'singularity-flow.mjs');
  const listed = run(process.execPath, [bin, '--no-model', 'workflow', 'proposals'], {
    cwd: item.work, env: { ...item.env, HOME: item.base, NODE_ENV: 'test' }, allowFailure: true
  });
  assert.match(listed.stdout, /Saved on this computer but not uploaded, so nobody can review them yet:/u);
  assert.match(listed.stdout, /sflow\/config-change\/workflow\/import-workflows-demo-3123abcd {2}pending/u);
  assert.match(listed.stdout, /Retry: singularity-flow push retry psh_/u);
});
