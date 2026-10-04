/** One error boundary shared by the public CLI and its convenience launchers. */
import { commandResultOf } from './narration/emit.mjs';
import { renderCommandResultJson } from './narration/render-json.mjs';
import { renderCommandResult } from './narration/render-terminal.mjs';
import { optionBoolean, parseArgs } from './util.mjs';
import { refusalEnvelope, renderRefusalPlan } from './refusal-remediation.mjs';

/**
 * Where the structured result begins when a reader asks for it beside the prose: with
 * SINGULARITY_FLOW_REFUSAL_ENVELOPE=stderr-v1, a failure printed for people also carries its
 * machine record after this line, so VS Code shows the same reasons and actions as the CLI
 * [E2G criterion 16].
 */
export const REFUSAL_ENVELOPE_MARKER = '--- singularity-flow structured refusal v1 ---';
const loggedFailures = new WeakSet();
export function markCliFailureLogged(error) {
  if (error && typeof error === 'object') loggedFailures.add(error);
}

export async function reportCliFailure(error, argv = []) {
  const result = commandResultOf(error);
  let json = false;
  let verbose = false;
  try {
    const { options } = parseArgs(argv);
    json = optionBoolean(options, 'json');
    verbose = optionBoolean(options, 'verbose');
  }
  catch { /* parsing may itself be the refusal */ }

  // Root-dispatch/input failures precede the legacy command logger. Honor explicit diagnostics
  // there too, through the same redactor, without duplicating a handler's already-written event.
  if (!json && (verbose || process.env.SINGULARITY_FLOW_DEBUG === '1') && !loggedFailures.has(error)) {
    const { createLogger, resolveLogging } = await import('./logging.mjs');
    const logging = resolveLogging(null, { ...process.env, SINGULARITY_FLOW_DEBUG: '1' });
    createLogger({ level: logging.level, consoleLevel: logging.console, consoleDetail: logging.consoleDetail })
      .error('command.failed', error?.message, { error });
  }

  const structuredBeside = !json && process.env.SINGULARITY_FLOW_REFUSAL_ENVELOPE === 'stderr-v1';
  if (result) {
    if (json) console.log(renderCommandResultJson(result));
    else {
      console.error(`\n${error?.message ?? String(error)}`);
      console.error(`\n${renderCommandResult(result)}`);
      if (structuredBeside) console.error(`\n${REFUSAL_ENVELOPE_MARKER}\n${JSON.stringify(JSON.parse(renderCommandResultJson(result)))}`);
    }
  } else {
    const envelope = refusalEnvelope(error, argv);
    if (json) console.log(JSON.stringify(envelope, null, 2));
    else {
      console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
      console.error(`\n${renderRefusalPlan(envelope.remediationPlan)}`);
      if (structuredBeside) console.error(`\n${REFUSAL_ENVELOPE_MARKER}\n${JSON.stringify(envelope)}`);
    }
  }
  if (!json && process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
