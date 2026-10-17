/** Disposable session-listing qualification. No real workspace, model or approval is touched. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createStoryReadinessFixture } from './story-readiness-benchmark.mjs';
import { initializeLedger } from '../src/ledger.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function createSessionListingFixture({ cliRoot = packageRoot } = {}) {
  const fixture = await createStoryReadinessFixture({ files: 1 });
  try {
    fixture.git(fixture.remote, 'config', 'uploadpack.allowFilter', 'true');
    fixture.git(fixture.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const file = path.join(fixture.source, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    definition.ledger.enabled = true;
    await writeFile(file, YAML.stringify(definition));
    fixture.git(fixture.source, 'add', '.'); fixture.git(fixture.source, 'commit', '--quiet', '-m', 'enable fixture ledger');
    fixture.git(fixture.source, 'push', '--quiet', 'origin', 'main', 'main:refs/heads/sflow/config');
    fixture.git(fixture.original, 'pull', '--quiet', '--ff-only');
    fixture.git(fixture.original, 'fetch', '--quiet', 'origin', 'refs/heads/sflow/config:refs/remotes/origin/sflow/config');
    await initializeLedger(fixture.source, { ...definition.ledger, pinTransport: 'none' });
    Object.assign(fixture.env, { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'cached',
      SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES: '30', SINGULARITY_FLOW_AGENT_OUTPUT: 'raw' });
    const invoke = async ({ extra = {}, options = [], command = ['session', 'candidates'], selectors = true } = {}) => {
      const started = performance.now();
      const child = spawnSync(process.execPath, [path.join(cliRoot, 'bin/singularity-flow.mjs'), ...command,
        ...(selectors ? ['--workspace', path.join(fixture.directory, 'workspace'), '--repository', 'app'] : []),
        ...(command[1] === 'candidates' ? ['--diagnostics'] : []), '--json', '--timings', ...options], {
        cwd: fixture.original, env: { ...fixture.env, ...extra }, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024
      });
      const ms = Math.round(performance.now() - started);
      let packet = null; try { packet = JSON.parse(child.stdout); } catch { /* Retain the native diagnostic. */ }
      const lines = (await readFile(path.join(fixture.original, '.git/singularity-flow/dx/timings.jsonl'), 'utf8')
        .catch(() => '')).trim().split('\n');
      let timing = {}; try { timing = JSON.parse(lines.at(-1)); } catch { /* Early refusals need no timing log. */ }
      return { child, packet, metrics: { ms, gitProcesses: timing.gitSpawns ?? null,
        remoteOperations: timing.gitSpawns == null ? null : timing.counters?.['git.remote.total'] ?? 0,
        snapshot: packet?.listingSnapshot?.source ?? null } };
    };
    return { ...fixture, definition, invoke };
  } catch (error) { await fixture.cleanup(); throw error; }
}

export async function benchmarkSessionListing({ cliRoot = packageRoot } = {}) {
  const fixture = await createSessionListingFixture({ cliRoot });
  try {
    const rows = [];
    for (const [name, mode, options] of [['first', 'cached', []], ['repeat', 'cached', []], ['repeat', 'cached', []],
      ['refresh', 'cached', ['--refresh']], ['always', 'always', []]]) {
      const result = await fixture.invoke({ extra: { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: mode }, options });
      assert.equal(result.child.status, 0, result.child.stderr + result.child.stdout);
      rows.push({ name, ...result.metrics });
    }
    return { platform: process.platform, node: process.version, rows,
      scope: 'Fresh processes, local bare remotes, OS caches not flushed. Empty ledger; no Story, model or approval in measured commands.' };
  } finally { await fixture.cleanup(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const result = await benchmarkSessionListing({ cliRoot: option('--cli-root') ?? packageRoot });
  if (option('--output')) await writeFile(option('--output'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
