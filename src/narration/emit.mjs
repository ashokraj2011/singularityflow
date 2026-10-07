/**
 * The output boundary. The only place a command result becomes bytes.
 *
 * A handler returns data; this decides whether the caller wanted words or JSON, attaches the
 * continuation from post-command state, and prints. Nothing upstream of here formats anything.
 */
import { attachContinuation } from './continuation.mjs';
import { assertContinuation, validateCommandResult } from './command-result.mjs';
import { renderCommandResult } from './render-terminal.mjs';
import { renderCommandResultJson } from './render-json.mjs';
import { markCommandFeedback } from '../dx-timing-context.mjs';
import { resolvePersonalization } from '../personalization.mjs';
import { operationContext } from '../operation-context.mjs';

export function emitCommandResult(result, { json = false, postState = null, publicationPending = false, modelMode, restStateWhenIdle = null, stepActionHold = null } = {}) {
  // Presentation is attached only at delivery, after planning/confirmation digests were computed.
  // A paused or failed pause preference must not load SFlow personalization or query Git.
  if (result.data?.paused !== true) {
    const existing = result.data?.personalization;
    const personalization = resolvePersonalization({
      actor: existing?.source === 'git-identity' ? { name: existing.displayName } : null,
      root: operationContext()?.root ?? null,
      allowGit: !result.operation?.id.startsWith('copilot.')
    });
    result = { ...result, data: { ...result.data, personalization } };
  }
  const complete = assertContinuation(validateCommandResult(
    attachContinuation(result, { postState, publicationPending, modelMode, restStateWhenIdle, stepActionHold }),
    { requireEnvelope: true }
  ));
  markCommandFeedback();
  console.log(json ? renderCommandResultJson(complete) : renderCommandResult(complete));
  return complete;
}

/**
 * Carry a command result on an error so the CLI's error boundary can narrate it.
 *
 * Refusals travel as exceptions throughout the existing code, and rewriting every throw site is a
 * migration, not a change. Attaching the structured result lets a refusal be narrated properly
 * today — effects-derived reassurance, reason codes, planner continuation — while the throw keeps
 * its exit code and its place in the control flow.
 */
export function withCommandResult(error, result) {
  Object.defineProperty(error, 'commandResult', { value: result, enumerable: false, configurable: true });
  return error;
}

export function commandResultOf(error) {
  return error?.commandResult ?? null;
}
