/**
 * Measure the dependency boundary being extracted into the engine foundation.
 * Fresh-process imports have the Node compile cache disabled. The OS file cache is not cleared;
 * these are component import measurements, not cold-machine or complete-command latency claims.
 * Run before and after an extraction: node scripts/engine-foundation-benchmark.mjs --samples=9
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { run } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = ['src/sda/shared-state-contract.mjs', 'src/sda/lifecycle-authority-contract.mjs'];
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

export async function measureEngineFoundation({ packageRoot = root, samples = 9 } = {}) {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 50) {
    throw new TypeError('Samples must be an integer from 1 to 50.');
  }
  const measurements = [];
  for (const entry of entries) {
    const { metafile } = await build({
      absWorkingDir: packageRoot, entryPoints: [entry], bundle: true, write: false,
      format: 'esm', platform: 'node', packages: 'external', metafile: true, logLevel: 'silent'
    });
    const inputs = Object.values(metafile.inputs);
    const builtinDependencies = [...new Set(inputs.flatMap(input => input.imports
      .filter(dependency => dependency.path.startsWith('node:')).map(dependency => dependency.path)))].sort();
    const url = pathToFileURL(path.join(packageRoot, entry)).href;
    const probe = `
      const start = performance.now();
      await import(${JSON.stringify(url)});
      const fresh = performance.now() - start;
      const repeated = performance.now();
      await import(${JSON.stringify(url)});
      console.log(JSON.stringify({ fresh, repeated: performance.now() - repeated }));
    `;
    const runs = Array.from({ length: samples }, () => JSON.parse(run(process.execPath,
      ['--input-type=module', '--eval', probe], {
        cwd: packageRoot, timeoutMs: 15_000,
        env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', SINGULARITY_FLOW_NO_NETWORK: '1' }
      }).stdout));
    measurements.push({
      entry, modules: inputs.length, inputBytes: inputs.reduce((sum, input) => sum + input.bytes, 0),
      builtinDependencies,
      freshProcessImportMedianMs: median(runs.map(run => run.fresh)),
      repeatedImportMedianMs: median(runs.map(run => run.repeated))
    });
  }
  return { node: process.versions.node, platform: process.platform, samples, compileCache: 'disabled',
    osFileCache: 'not-cleared', measurements };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sampleArgument = process.argv.slice(2).find(value => value.startsWith('--samples='));
  const samples = sampleArgument == null ? 9 : Number(sampleArgument.slice('--samples='.length));
  console.log(JSON.stringify(await measureEngineFoundation({ samples }), null, 2));
}
