#!/usr/bin/env node
globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
// Where the person ran the command: the CLI may move into the selected workspace before it runs.
globalThis.__SINGULARITY_FLOW_INVOCATION_DIRECTORY ??= process.cwd();
// Reuse V8's compiled code for the engine's modules across runs (Node 22.1+). Node checks every
// entry against its source and honours NODE_DISABLE_COMPILE_CACHE=1; a failure only skips it.
try { (await import('node:module')).enableCompileCache?.(); } catch { /* an acceleration only */ }
// An installed build runs its bundle: one file where the sources are about 480 (src/bundled-cli.mjs).
const { bundledCliUrl } = await import('../src/bundled-cli.mjs');
const { fileURLToPath } = await import('node:url');
const bundle = bundledCliUrl(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length === 3 && process.argv[2] === '--warm-runtime') {
  const { prewarmRuntime } = await import('../src/runtime-prewarm.mjs');
  console.log(JSON.stringify(await prewarmRuntime(fileURLToPath(new URL('..', import.meta.url)))));
} else {
  const bundled = bundle ? await import(bundle) : null;
  const { main } = bundled ?? await import('../src/cli-entry.mjs');

// Keep the process alive until the dispatcher and every acquired mutation lease settle. Relying on
// incidental filesystem or worker handles made a fast command able to exit 0 while `main()` was
// still awaiting lock readiness, so callers (including VS Code) observed success with no result.
  const bootstrapMs = Number(process.hrtime.bigint() - globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT) / 1e6;
  try {
    await main(process.argv.slice(2)).catch(async (error) => {
      const { reportCliFailure } = bundled ?? await import('../src/cli-failure.mjs');
      await reportCliFailure(error, process.argv.slice(2));
    });
  } finally {
    // Node normally writes newly compiled bytecode at exit, after the command's terminal timing.
    // Attribute that first-request cost explicitly when requested, without changing stdout or
    // enabling a cache the host disabled. Ordinary invocations retain Node's original exit path.
    if (process.argv.includes('--timings')) {
      const started = process.hrtime.bigint();
      try { (await import('node:module')).flushCompileCache?.(); } catch { /* acceleration only */ }
      const flushMs = Number(process.hrtime.bigint() - started) / 1e6;
      process.stderr.write(`[sflow startup] bootstrap=${bootstrapMs.toFixed(1)}ms compile-cache-flush=${flushMs.toFixed(1)}ms\n`);
    }
  }
}
