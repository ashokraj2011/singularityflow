#!/usr/bin/env node
globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
const { main } = await import('../src/cli-entry.mjs');

main(process.argv.slice(2)).catch(async (error) => {
  const { reportCliFailure } = await import('../src/cli-failure.mjs');
  await reportCliFailure(error, process.argv.slice(2));
});
