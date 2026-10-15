import { hookBenchmarkSampleCount, runCopilotHookBenchmark } from '../src/copilot-hook-benchmark.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--samples' || !/^\d+$/u.test(args[1]))) {
    throw new Error('Use [--samples <1-300>].');
  }
  const samples = hookBenchmarkSampleCount(args.length ? Number(args[1]) : 30);
  console.log(JSON.stringify(await runCopilotHookBenchmark({ samples }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
