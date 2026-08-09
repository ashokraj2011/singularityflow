#!/usr/bin/env node
globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
const { main } = await import('../src/cli-entry.mjs');

main(process.argv.slice(2)).catch(async (error) => {
  // A refusal that carries a structured result is narrated rather than dumped as a message. That is
  // what makes its reassurance derived from declared effects instead of a sentence someone wrote
  // next to the throw, and what gives it a real next action instead of a Copilot skill name.
  const { commandResultOf } = await import('../src/narration/emit.mjs');
  const result = commandResultOf(error);
  if (result) {
    const { renderCommandResult } = await import('../src/narration/render-terminal.mjs');
    console.error(`\n${error.message}`);
    console.error(`\n${renderCommandResult(result)}`);
  } else {
    console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
  }
  if (process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
