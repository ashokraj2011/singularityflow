#!/usr/bin/env node
globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
const { main } = await import('../src/cli-entry.mjs');

main(['reinstall', ...process.argv.slice(2)]).catch(async (error) => {
  console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
