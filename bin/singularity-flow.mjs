#!/usr/bin/env node
globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
const { main } = await import('../src/cli-entry.mjs');

// Keep the process alive until the dispatcher and every acquired mutation lease settle. Relying on
// incidental filesystem or worker handles made a fast command able to exit 0 while `main()` was
// still awaiting lock readiness, so callers (including VS Code) observed success with no result.
await main(process.argv.slice(2)).catch(async (error) => {
  const { reportCliFailure } = await import('../src/cli-failure.mjs');
  await reportCliFailure(error, process.argv.slice(2));
});
