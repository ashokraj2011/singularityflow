#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(['persona', ...process.argv.slice(2)]).catch((error) => {
  console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
  if (process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
