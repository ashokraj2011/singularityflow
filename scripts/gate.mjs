#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { SingularityFlowError } from '../src/util.mjs';

try {
  await main(['gate', ...process.argv.slice(2)]);
} catch (error) {
  console.error(error instanceof SingularityFlowError ? error.message : error.stack);
  process.exitCode = error.exitCode ?? 1;
}
