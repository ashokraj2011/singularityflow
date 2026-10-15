/** One error boundary shared by the public CLI and its convenience launchers. */
import { commandResultOf } from './narration/emit.mjs';
import { renderCommandResultJson } from './narration/render-json.mjs';
import { renderCommandResult } from './narration/render-terminal.mjs';
import { optionBoolean, parseArgs } from './util.mjs';
import { refusalEnvelope, renderRefusalPlan } from './refusal-remediation.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

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
  let forAgent = false;
  try {
    const { options } = parseArgs(argv);
    json = optionBoolean(options, 'json');
    forAgent = (await import('./cli-json-output.mjs')).agentViewRequested(options);
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
  // A command made of steps (cli-steps.mjs) relays the failed step's own JSON result as it is.
  const relayed = error?.relayedResult;
  // An agent's refusal is bounded and starts with `act` like any agent result (agent-output.mjs).
  const printJson = async (text) => {
    const governed = forAgent && (await import('./agent-output.mjs'));
    console.log(governed && governed.agentOutputGoverned() ? (await governed.boundedAgentOutput(text)).trimEnd() : text);
  };
  if (relayed && json) {
    await printJson(JSON.stringify(relayed, null, 2));
  } else if (result) {
    if (json) await printJson(renderCommandResultJson(result));
    else {
      console.error(`\n${redactDiagnosticText(error?.message ?? String(error), { multiline: true })}`);
      console.error(`\n${redactDiagnosticText(renderCommandResult(result), { multiline: true })}`);
      if (structuredBeside) console.error(`\n${REFUSAL_ENVELOPE_MARKER}\n${JSON.stringify(JSON.parse(renderCommandResultJson(result)))}`);
    }
  } else {
    // A phase refusal that keeps returning unchanged says to stop and hand it on [recoverable-findings M3].
    const envelope = relayed?.resultType === 'sflow-refusal-plan' && relayed.remediationPlan ? relayed
      : (await import('./finding-escalation.mjs')).escalateRefusalEnvelope(refusalEnvelope(error, argv), error);
    if (json) await printJson(JSON.stringify(envelope, null, 2));
    else {
      console.error(`\nSingularity Flow error: ${redactDiagnosticText(error?.message ?? String(error), { multiline: true })}`);
      // A broken workflow.yml names every problem, located and with its fix, not just the first.
      const problems = Array.isArray(error?.details?.configurationProblems) ? error.details.configurationProblems : [];
      if (problems.length) {
        const { formatConfigurationProblems } = await import('./configuration-diagnostics.mjs');
        console.error(`\n${redactDiagnosticText(formatConfigurationProblems(problems).join('\n'), { multiline: true })}`);
      }
      console.error(`\n${renderRefusalPlan(envelope.remediationPlan)}`);
      if (structuredBeside) console.error(`\n${REFUSAL_ENVELOPE_MARKER}\n${JSON.stringify(envelope)}`);
    }
  }
  if (!json && process.env.SINGULARITY_FLOW_DEBUG === '1' && error?.stack) console.error(redactDiagnosticText(error.stack));
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
