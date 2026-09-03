#!/usr/bin/env node
globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
const { main } = await import('../src/cli-entry.mjs');

main(process.argv.slice(2)).catch(async (error) => {
  // A refusal that carries a structured result is narrated rather than dumped as a message. That is
  // what makes its reassurance derived from declared effects instead of a sentence someone wrote
  // next to the throw, and what gives it a real next action instead of a Copilot skill name.
  const { commandResultOf } = await import('../src/narration/emit.mjs');
  const result = commandResultOf(error);
  let json = false;
  try {
    const { optionBoolean, parseArgs } = await import('../src/util.mjs');
    json = optionBoolean(parseArgs(process.argv.slice(2)).options, 'json');
  } catch {
    // If parsing the original command is itself the failure, fall back to the human-safe envelope.
  }
  if (result) {
    if (json) {
      const { renderCommandResultJson } = await import('../src/narration/render-json.mjs');
      console.error(renderCommandResultJson(result));
    } else {
      const { renderCommandResult } = await import('../src/narration/render-terminal.mjs');
      console.error(`\n${error.message}`);
      console.error(`\n${renderCommandResult(result)}`);
    }
  } else {
    if (json) {
      const diagnosticAction = error?.details?.diagnosticAction;
      const remoteFailure = error?.details?.remoteFailure;
      console.error(JSON.stringify({
        schemaVersion: 1,
        status: 'failed',
        error: {
          code: error?.code ?? 'SINGULARITY_FLOW_ERROR',
          message: error?.message ?? String(error),
          ...(diagnosticAction?.command ? { diagnosticAction: {
            command: diagnosticAction.command,
            skill: diagnosticAction.skill ?? null
          } } : {}),
          ...(remoteFailure ? { remoteFailure } : {})
        }
      }, null, 2));
    } else {
      console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
      if (error?.details?.diagnosticAction?.command) {
        console.error(`Diagnose: ${error.details.diagnosticAction.command}`);
      }
    }
  }
  if (!json && process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
