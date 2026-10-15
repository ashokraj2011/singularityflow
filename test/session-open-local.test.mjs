import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
test('thin local session entry preserves the original selector and protocol refusals', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [['--table'], ['--repository', 'unselected'], ['--repository-url', 'https://example.invalid/repo.git'],
    ['--configuration-url', 'https://example.invalid/config.git'], ['--workspace', 'unselected', '--repository-url', 'https://example.invalid/repo.git']]) {
    const results = [];
    for (const mode of ['legacy', 'shared']) {
      const result = spawnSync(process.execPath, [cli, '--no-model', 'session', 'open-local', 'LOCAL-1', ...args, '--json'], {
        cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, SINGULARITY_FLOW_BUNDLE: 'off',
          SINGULARITY_FLOW_SESSION_READS: mode, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
          SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'registry.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'active.json'),
          SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, 'mode.json') }
      });
      assert.notEqual(result.status, 0);
      results.push(JSON.parse(result.stdout).error);
    }
    assert.deepEqual(results[1], results[0], args.join(' '));
  }
});
