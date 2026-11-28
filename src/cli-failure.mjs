/** One error boundary shared by the public CLI and its convenience launchers. */
// Inspect an attached result without importing the output boundary's workflow planner.
import { commandResultOf } from './narration/command-result.mjs';
import { renderCommandResultJson } from './narration/render-json.mjs';
import { renderCommandResult } from './narration/render-terminal.mjs';
import { optionBoolean, parseArgs, SingularityFlowError } from './util.mjs';
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

/**
 * Node refuses to build a string over about 512 MB (ERR_STRING_TOO_LONG, or "Invalid string length"
 * for concatenation). Reported raw, that named neither the input nor where SFlow read it, so a
 * person could only guess. Name the SFlow file and line that tried, and say nothing was changed.
 */
export function oversizedTextRefusal(error) {
  const tooLong = error?.code === 'ERR_STRING_TOO_LONG'
    || (error instanceof RangeError && /Invalid string length/u.test(error.message ?? ''));
  if (!tooLong) return null;
  const frame = String(error.stack ?? '').split('\n')
    .map((line) => /((?:src|bundle)\/[^\s():]+\.m?js):(\d+)/u.exec(line)).find(Boolean);
  const origin = frame ? `${frame[1]}:${frame[2]}` : null;
  return new SingularityFlowError(`An input was larger than SFlow can hold as text (Node's 512 MB limit)${origin ? ` while reading in ${origin}` : ''}. `
    + 'Nothing was published, committed or pushed. Report this location; rerun with SINGULARITY_FLOW_DEBUG=1 for the full stack.',
  { code: 'INPUT_TOO_LARGE_FOR_TEXT', details: { origin }, cause: error });
}

/**
 * A confirmation copied with a slip, in the person's own terminal: one Yes runs the same command with the exact value, never
 * a refusal to copy again [owner, 2026-11-28]. Anywhere else the refusal carries that filled command as its next action.
 * Returns whether it ran.
 */
async function offerExactConfirmation(error, argv) {
  const retry = error?.details?.retryArgv;
  if (!/_MISTYPED$/u.test(String(error?.code ?? '')) || !Array.isArray(retry) || !retry.length || retry.join('\u0000') === argv.join('\u0000')) return false;
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true || argv.includes('--json')) return false;
  const readline = await import('node:readline/promises');
  const io = readline.createInterface({ input: process.stdin, output: process.stdout });
  let yes = false;
  try { yes = /^(?:y|yes)$/iu.test((await io.question(`${error.message}\nRun it with the exact value? [y/N] `)).trim()); } finally { io.close(); }
  if (!yes) return false;
  // The same command again, in this process: the refusal changed nothing, and its own failure is reported as any other.
  process.exitCode = undefined;
  const { main } = await import('./cli-entry.mjs');
  try { await main(retry); } catch (again) { await reportCliFailure(again, retry); }
  return true;
}

export async function reportCliFailure(error, argv = []) {
  error = oversizedTextRefusal(error) ?? error;
  if (await offerExactConfirmation(error, argv).catch(() => false)) return;
  // In a test run: a refusal's route is never the refused command again (story-invariants.mjs).
  if (globalThis.__SFLOW_CLI_BUNDLE__ !== true && globalThis.__SFLOW_EXTENSION_HOST__ !== true && process.env.SINGULARITY_FLOW_INVARIANTS) {
    await (await import('./invariant-checks.mjs')).withStoryInvariants((checks) => checks.reportViolations(checks.refusalViolations(argv, error)));
  }
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
  // Either way it is code-page safe: Windows PowerShell decodes captured output in the console's
  // code page (code-page-safe-json.mjs).
  const printJson = async (text) => {
    const kept = globalThis.__SFLOW_AGENT_RESULT_RUN;
    const governed = forAgent && (await import('./agent-output.mjs'));
    const { agentViewOrOutput } = await import('./cli-json-output.mjs');
    const { codePageSafeJson } = await import('./code-page-safe-json.mjs');
    const shown = governed && governed.agentOutputGoverned() ? (await agentViewOrOutput(governed.boundedAgentOutput, text)).trimEnd() : text;
    // Kept with the view the agent is shown, for a host that shows it nothing (unread-result.mjs).
    if (kept) (await import('./agent-result-keeper.mjs')).keepAgentResult(kept, text, { view: shown });
    console.log(codePageSafeJson(shown));
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
    // Only a phase refusal escalates. Of the refusals that name a stop (workflow-task-outcome.mjs refusalStop), only a test
    // failure can wait on a person or the environment, so only it loads the phase outcomes: any refusal loading them put
    // the cold phases chunk under every refused command, `phase show` of a missing Story among them.
    const plain = relayed?.resultType === 'sflow-refusal-plan' && relayed.remediationPlan ? null : refusalEnvelope(error, argv);
    const envelope = !plain ? relayed : plain.remediationPlan?.context?.scope !== 'phase' ? plain
      : (await import('./finding-escalation.mjs')).escalateRefusalEnvelope(plain, error, process.cwd(), {
        waits: error?.code === 'CODE_TEST_FAILED'
          && ['waiting-person', 'waiting-environment'].includes((await import('./workflow-task-outcome.mjs')).refusalOutcome(error)) });
    // A Story step's refusal is a lesson's source when it keeps coming back [LRN:REQ-001]; kept on this machine.
    if (plain?.remediationPlan?.context?.scope === 'phase') await (await import('./lesson-refusals.mjs')).rememberRefusal(process.cwd(), error, plain.remediationPlan);
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
