/** One error boundary shared by the public CLI and its convenience launchers. */
import { commandResultOf } from './narration/emit.mjs';
import { renderCommandResultJson } from './narration/render-json.mjs';
import { renderCommandResult } from './narration/render-terminal.mjs';
import { optionBoolean, parseArgs } from './util.mjs';
import { refusalEnvelope, renderRefusalPlan } from './refusal-remediation.mjs';

export async function reportCliFailure(error, argv = []) {
  const result = commandResultOf(error);
  let json = false;
  try { json = optionBoolean(parseArgs(argv).options, 'json'); }
  catch { /* parsing may itself be the refusal */ }

  if (result) {
    if (json) console.error(renderCommandResultJson(result));
    else {
      console.error(`\n${error?.message ?? String(error)}`);
      console.error(`\n${renderCommandResult(result)}`);
    }
  } else {
    const envelope = refusalEnvelope(error, argv);
    if (json) console.error(JSON.stringify(envelope, null, 2));
    else {
      console.error(`\nSingularity Flow error: ${error?.message ?? String(error)}`);
      console.error(`\n${renderRefusalPlan(envelope.remediationPlan)}`);
    }
  }
  if (!json && process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
