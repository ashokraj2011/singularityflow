import { readCopilotMode, copilotModePresentation } from './copilot-mode.mjs';
import { resolvePersonalization } from './personalization.mjs';
import { SingularityFlowError } from './util.mjs';

/** Validate the read-only form before checking pause; never resolve Git while paused. */
export function sessionAgentEntryGuard(positionals, options) {
  const allowed = new Set(['for-agent', 'json', 'no-model', 'timings', 'timing']);
  if (options['for-agent'] !== true || options.json !== true
      || positionals.length !== 2 || positionals[1] !== 'current'
      || Object.keys(options).some(key => !allowed.has(key))) {
    throw new SingularityFlowError('Use session current --for-agent --json without mutation or selection options.', {
      code: 'SESSION_AGENT_OPTIONS_INVALID'
    });
  }
  const mode = readCopilotMode();
  return mode.paused ? copilotModePresentation(mode) : null;
}

/** Presentation only: retain the existing resolver's readiness, agent and selection checks. */
export function sessionAgentResult(result, workItemRoot) {
  return { schemaVersion: 1, resultType: 'sflow-session-entry', paused: false, ...result,
    workItemRoot, personalization: resolvePersonalization({ root: result.repositoryPath }),
    effects: { storyAdvanced: false, committed: false, pushed: false, testsRun: false },
    agentInstruction: 'Use personalization.replyName literally, once per reply/suggestion group, never in artifacts or approval identity; do not guess a missing name. Reuse this invocation binding. Do not repeat pause, session, status or repository lookups merely to discover the same fields. Operation-specific readiness and human confirmations remain required; re-enter after selection changes.' };
}
