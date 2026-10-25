import { readCopilotMode, copilotModePresentation } from './copilot-mode.mjs';
import { resolvePersonalization } from './personalization.mjs';
import { SingularityFlowError } from './util.mjs';

/** Validate the read-only form before checking pause; never resolve Git while paused. */
export function sessionAgentEntryGuard(positionals, options) {
  // The `--workspace`/`--repository` selectors `session open` returns may ride along: a chat outside
  // the checkout carries them. They only name the binding to read (session-current.mjs checks it).
  const allowed = new Set(['for-agent', 'json', 'no-model', 'timings', 'timing', 'workspace', 'repository']);
  if (options['for-agent'] !== true || options.json !== true
      || positionals.length !== 2 || positionals[1] !== 'current'
      || Object.keys(options).some(key => !allowed.has(key))
      || ['workspace', 'repository'].some(key => key in options && typeof options[key] !== 'string')) {
    throw new SingularityFlowError('Use session current --for-agent --json, with only the returned --workspace and --repository, without mutation or other selection options.', {
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
    // One sentence each, under 200 bytes: every skill turn starts with this result, and the skills that
    // read it carry the full personalization and binding rules. `[OUT:REQ-031]`
    agentInstruction: 'Use personalization.replyName literally (no name if absent), never in artifacts or approval identity; reuse this binding, not its lookups. Readiness and human confirmations remain required.' };
}
