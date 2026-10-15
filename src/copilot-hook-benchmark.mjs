/** Local synthetic hook transport benchmark; never runs Copilot, a model, or a user's Story. */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarizeSamples } from './dx-performance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = path.join(ROOT, 'plugin/hook-launcher.mjs');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');

export function hookBenchmarkSampleCount(value = 30) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300) throw new Error('Hook benchmark samples must be an integer from 1 to 300.');
  return value;
}

/** Alternate legacy/dedicated starts after warm-up; loader profiling is outside timing samples. */
export async function runCopilotHookBenchmark({ samples = 30, profileModules = true } = {}) {
  hookBenchmarkSampleCount(samples);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-benchmark-'));
  try {
    // A host can carry GIT_DIR/WORK_TREE or a selected Story. Never let those relocate this
    // synthetic fixture into a real checkout, or inherit Node preload/coverage output paths.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:GIT_|SINGULARITY_FLOW_)/iu.test(key)
      && !/^(?:NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|NODE_V8_COVERAGE|NODE_TEST_CONTEXT)$/iu.test(key)));
    const gitConfig = path.join(directory, 'empty-gitconfig');
    await writeFile(gitConfig, '');
    const env = { ...inherited, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(directory), GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
      SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_GIT_FACT_STORE: 'off',
      SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'registry.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(directory, 'leads.json') };
    const invoke = (mode, action, payload, imports = [], extra = {}) => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [...imports, LAUNCHER, action, CLI], {
        cwd: directory, env: { ...env, SINGULARITY_FLOW_HOOK_RUNTIME: mode, ...extra },
        input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
      });
      const durationMs = performance.now() - started;
      if (result.status !== 0 || result.error) throw new Error(`Hook benchmark ${mode}/${action} did not complete.`);
      let response;
      try { response = JSON.parse(result.stdout); } catch { throw new Error('Hook benchmark did not receive a JSON response.'); }
      return { durationMs, response };
    };
    let loader;
    if (profileModules && typeof nodeModule.register === 'function') {
      const source = `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:')) appendFileSync(process.env.SFLOW_HOOK_BENCH_MODULE_LOG, url + '\\n');
  return result;
}`;
      loader = path.join(directory, 'count.mjs');
      await writeFile(loader, `import { register } from 'node:module';\nregister(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)});\n`);
    }
    const binding = { sessionId: 'hook-benchmark', cwd: directory };
    const cases = [
      { id: 'unbound-boundary-guard', action: 'boundary-guard', payload: binding },
      { id: 'unbound-agent-start', action: 'agent-start', payload: { ...binding, agentName: 'unmapped-benchmark-agent' } },
      { id: 'active-missing-contract-guard', action: 'boundary-guard',
        payload: { ...binding, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } }, active: true }
    ];
    const scenarios = [];
    for (const scenario of cases) {
      if (scenario.active) invoke('legacy', 'boundary-turn', { ...binding, prompt: '/sf-code' });
      const expected = invoke('legacy', scenario.action, scenario.payload).response;
      if (scenario.active && expected.permissionDecision !== 'deny') throw new Error('Active fixture did not establish its required denial.');
      const run = (mode, imports, extra) => {
        const result = invoke(mode, scenario.action, scenario.payload, imports, extra);
        if (JSON.stringify(result.response) !== JSON.stringify(expected)) throw new Error(`Hook decision parity failed for ${scenario.id}/${mode}.`);
        return result;
      };
      run('dedicated');
      const timings = { legacy: [], dedicated: [] };
      for (let index = 0; index < samples; index++) {
        for (const mode of index % 2 ? ['dedicated', 'legacy'] : ['legacy', 'dedicated']) {
          timings[mode].push(run(mode).durationMs);
        }
      }
      const moduleCounts = {};
      if (loader) {
        for (const mode of ['legacy', 'dedicated']) {
          const log = path.join(directory, `${scenario.id}-${mode}.log`);
          run(mode, ['--import', pathToFileURL(loader).href], { SFLOW_HOOK_BENCH_MODULE_LOG: log });
          const modules = [...new Set((await readFile(log, 'utf8')).split('\n').filter(Boolean))];
          moduleCounts[mode] = { count: modules.length, loadedGeneralCli: modules.some(url =>
            /\/src\/(?:cli(?:-entry)?\.mjs|commands\/legacy\.mjs)$/u.test(url)) };
        }
      }
      const legacy = summarizeSamples(timings.legacy), dedicated = summarizeSamples(timings.dedicated);
      scenarios.push({ id: scenario.id, action: scenario.action, parityVerified: true, legacy, dedicated,
        p50ReductionPercent: (legacy.p50Ms - dedicated.p50Ms) / legacy.p50Ms * 100,
        p95ReductionPercent: (legacy.p95Ms - dedicated.p95Ms) / legacy.p95Ms * 100,
        moduleCounts: loader ? moduleCounts : null });
    }
    return { schemaVersion: 1, resultType: 'native-copilot-hook-benchmark', // schema-transient: synthetic local benchmark, not retained authority
      platform: process.platform, arch: process.arch, node: process.version, sampleCount: samples,
      recommendedSampleCountMet: samples >= 30, bundled: false, temperature: 'os-warm-new-node-process',
      scenarios, billedSavings: null,
      limitations: ['Synthetic isolated fixture; not a complete Story or native Copilot host trace.',
        'Timings include the child process and transport; loader profiling is excluded from timed samples.',
        'Inactive shell-launcher shortcuts already avoid Node; these timings exercise the Node launcher itself.',
        'No Windows latency, end-to-end user latency or billed savings is inferred from another platform.'] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
