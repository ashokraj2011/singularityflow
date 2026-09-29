/**
 * Story start progress: the engine names each stage on stderr only when asked, and the extension
 * strips those lines as they arrive, so stderr is still shown and parsed exactly as before. `[perf]`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ProgressLineSplitter, startProgressLabel } from '../apps/vscode/src/cli/progress.ts';
import { CliError, invokeCli } from '../apps/vscode/src/cli/runner.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('progress lines are taken out of stderr wherever the chunks split them', () => {
  const steps = [];
  const splitter = new ProgressLineSplitter((step) => steps.push(step));
  let kept = '';
  for (const chunk of ['warning: before\n@@sflow-progress/v1 start.fe', 'tch\n@@sflow-progress/v1 st',
    'art.worktree\r\nnot @@sflow-progress/v1 start.fetch\n@@sflow-progress/v1 start.Evil\n', 'tail']) {
    kept += splitter.push(chunk);
  }
  kept += splitter.end();
  assert.deepEqual(steps, ['start.fetch', 'start.worktree']);
  assert.equal(kept, 'warning: before\nnot @@sflow-progress/v1 start.fetch\n@@sflow-progress/v1 start.Evil\ntail',
    'anything that is not exactly a progress line passes through untouched');
  assert.equal(startProgressLabel('start.publication'), 'Publishing the Story');
  assert.equal(startProgressLabel('start.unknown'), null, 'unknown stages are not shown');
  assert.equal(startProgressLabel('constructor'), null);
});

function chunkedSpawn(chunks, { code = 0, stdout = '' } = {}) {
  const seen = {};
  const spawnImpl = (_executable, _args, options) => {
    seen.env = options.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => true;
    setTimeout(() => {
      for (const chunk of chunks) child.stderr.emit('data', Buffer.from(chunk, 'utf8'));
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      child.emit('close', code);
    }, 5);
    return child;
  };
  return { spawnImpl, seen };
}

test('the runner asks for progress only when it will use it, and still parses a refusal on stderr', async () => {
  const refusal = JSON.stringify({ status: 'refused', code: 'STORY_BRANCH_EXISTS', message: 'Story branch exists.' });
  const steps = [];
  const { spawnImpl, seen } = chunkedSpawn([
    '@@sflow-progress/v1 start.intake-verification\n@@sflow-progress/v1 start.worktree\n', `${refusal}\n`
  ], { code: 2 });
  const outputs = [];
  await assert.rejects(invokeCli({
    executable: 'node', cli: '/cli.mjs', repository: '/repo', args: ['start', 'S'], spawnImpl,
    onProgress: (step) => steps.push(step), onOutput: (text) => outputs.push(text)
  }), (error) => error instanceof CliError && error.result?.code === 'STORY_BRANCH_EXISTS');
  assert.equal(seen.env.SINGULARITY_FLOW_PROGRESS, 'stderr-v1');
  assert.deepEqual(steps, ['start.intake-verification', 'start.worktree']);
  assert.ok(outputs.every((text) => !text.includes('@@sflow-progress')), 'progress never reaches the Output channel');

  const quiet = chunkedSpawn([], { stdout: '{"ok":true}' });
  await invokeCli({ executable: 'node', cli: '/cli.mjs', repository: '/repo', args: ['status'], spawnImpl: quiet.spawnImpl });
  assert.equal(quiet.seen.env.SINGULARITY_FLOW_PROGRESS, undefined, 'no progress without a listener');
});

test('the engine names start stages only when asked, and no child process inherits the request', () => {
  const probe = `
    const { measureCommandSpan } = await import(${JSON.stringify(path.join(root, 'src', 'dx-timing-context.mjs'))});
    await measureCommandSpan('start.fetch', async () => {});
    await measureCommandSpan('dispatch.requirements', async () => {});
    process.stdout.write(process.env.SINGULARITY_FLOW_PROGRESS ?? 'unset');
  `;
  const asked = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_PROGRESS: 'stderr-v1' }
  });
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(asked.stderr, '@@sflow-progress/v1 start.fetch\n', 'only the fixed start stages are named');
  assert.equal(asked.stdout, 'unset', 'the request is removed before anything can inherit it');
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_PROGRESS: '' }
  });
  assert.equal(plain.stderr, '');
});
