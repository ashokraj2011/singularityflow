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

export async function reportCliFailure(error, argv = []) {
  const result = commandResultOf(error);
  let json = false;
  try { json = optionBoolean(parseArgs(argv).options, 'json'); }
  catch { /* parsing may itself be the refusal */ }

  const structuredBeside = !json && process.env.SINGULARITY_FLOW_REFUSAL_ENVELOPE === 'stderr-v1';
  if (result) {
    if (json) console.error(renderCommandResultJson(result));
    else {
      console.error(`\n${error?.message ?? String(error)}`);
      console.error(`\n${renderCommandResult(result)}`);
      if (structuredBeside) console.error(`\n${REFUSAL_ENVELOPE_MARKER}\n${JSON.stringify(JSON.parse(renderCommandResultJson(result)))}`);
    }
  } else {
    const envelope = refusalEnvelope(error, argv);
    if (json) console.error(JSON.stringify(envelope, null, 2));
    else {
      console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
      console.error(`\n${renderRefusalPlan(envelope.remediationPlan)}`);
      if (structuredBeside) console.error(`\n${REFUSAL_ENVELOPE_MARKER}\n${JSON.stringify(envelope)}`);
    }
  }
  if (!json && process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
