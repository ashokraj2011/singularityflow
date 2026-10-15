import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarizeSamples } from '../src/dx-performance.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const legacy = new URL('../src/commands/legacy.mjs', import.meta.url).href;

test('isolated logs entry retains legacy results without loading the general dispatcher', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-logs-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_NO_NETWORK: '1',
    SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_LOG_LEVEL: 'off', SINGULARITY_FLOW_LOG_CONSOLE: 'off',
    SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'registry.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json') };
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: directory, env }).status, 0);
  const args = ['logs', '--level', 'error', '--tail', '20', '--json'];
  const baselineCli = process.env.SINGULARITY_FLOW_BENCHMARK_BASE_CLI;
  const command = mode => mode === 'isolated' ? [cli, ...args] : baselineCli ? [baselineCli, ...args] : ['--input-type=module', '-e',
    `try { (await import('node:module')).enableCompileCache?.(); } catch {}\n`
      + `await (await import(${JSON.stringify(legacy)})).run(${JSON.stringify(args)});`];
  const invoke = (mode, hook = []) => {
    const started = performance.now();
    const result = spawnSync(process.execPath, [...hook, ...command(mode)], { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return { stdout: result.stdout, durationMs: performance.now() - started };
  };
  const expected = invoke('legacy');
  assert.equal(invoke('isolated').stdout, expected.stdout);
  // Runtime loading is measured separately; the logging loader is never used for latency samples.
  const loader = path.join(directory, 'loader.mjs');
  const hook = path.join(directory, 'hook.mjs');
  await writeFile(loader, `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) { const value = await next(url, context); if (url.startsWith('file:')) appendFileSync(${JSON.stringify(path.join(directory, 'modules.jsonl'))}, JSON.stringify(url) + '\\n'); return value; }`);
  await writeFile(hook, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`);
  const { readFile } = await import('node:fs/promises');
  const modules = {};
  for (const mode of ['legacy', 'isolated']) {
    await writeFile(path.join(directory, 'modules.jsonl'), '');
    invoke(mode, ['--import', hook]);
    const observed = (await readFile(path.join(directory, 'modules.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    modules[mode] = observed.length;
    if (mode === 'isolated') assert.ok(!observed.some(url => /\/src\/(?:cli|commands\/legacy)\.mjs$/u.test(url)), 'logs must not reach the general dispatcher');
  }
  assert.ok(modules.isolated < modules.legacy, JSON.stringify(modules));
  const samples = Number(process.env.SINGULARITY_FLOW_LOGS_BENCHMARK ?? 0);
  if (Number.isSafeInteger(samples) && samples > 0 && samples <= 100) {
    const timings = { legacy: [], isolated: [] };
    for (let sample = 0; sample < samples + 5; sample++) for (const mode of sample % 2 ? ['isolated', 'legacy'] : ['legacy', 'isolated']) {
      const value = invoke(mode); assert.equal(value.stdout, expected.stdout);
      if (sample >= 5) timings[mode].push(value.durationMs);
    }
    t.diagnostic(JSON.stringify({ resultType: 'sflow-logs-entry-qualification', fixture: 'local-repository-without-activity',
      reference: baselineCli ? 'Exact local source baseline ' + (process.env.SINGULARITY_FLOW_BENCHMARK_BASE_COMMIT ?? 'unreported') + '; not an installed build.'
        : 'Same frozen source handler via original heavyweight dispatcher; not a historical or installed build.',
      packageMode: 'source', samples, warmups: 5, platform: process.platform, architecture: process.arch, node: process.version,
      compilation: 'Both routes request the same CLI compile cache when supported; warm samples, not cold module compilation.',
      modules, identityPreserved: true, modelsInvoked: 0,
      summaries: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, summarizeSamples(values)])), timings }));
  }
});
