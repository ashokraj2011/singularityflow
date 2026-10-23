/** Inspect and retry exact pre-Story transport intents. */
import {
  listTransportIntents, readTransportIntent, retryTransportIntent, transportCheckoutMissing, transportFaultSummary, transportIntentsForRepository
} from '../transport-intents.mjs';
import {
  action, commandResult, effects, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

/** Why a publication has not landed, when Git said: its class, Git's own line and the fix. */
function faultSlots(intent) {
  return transportFaultSummary(intent) ?? {};
}

/**
 * The way on, chosen from the intent's status, never from its stored action (which can name
 * `push status` itself, or a raw `git fetch`): the retry while one can land the commit, nothing once
 * it landed or the branch moved past it (the advice says to repeat the operation).
 */
function nextActions(intent) {
  // Its checkout is gone: nothing can run there (the advice says to repeat the operation).
  if (transportCheckoutMissing(intent)) return [];
  const retry = `singularity-flow push retry ${intent?.intentId}`;
  if (['pending', 'pushing', 'outcome-unknown'].includes(intent?.status)) {
    return [action({ id: 'transport-next-action', label: 'Retry this preserved publication', command: retry, kind: 'remediation' })];
  }
  // A refusal only a person can clear: once they have, the retry publishes the same commit.
  if (['needs-user', 'attempt-budget-exhausted'].includes(intent?.status)) {
    return [action({ id: 'transport-next-action', label: 'Retry after fixing the cause', command: retry, kind: 'remediation' })];
  }
  return [];
}

function result(operation, outcome, { intent = null, intents = null, changed = false } = {}) {
  return commandResult({
    operation: { id: operation.id, classification: operation.classification },
    subject: intent ? { kind: 'repository', id: intent.repositoryRootFingerprint } : null,
    outcome,
    effects: changed ? effects({ stateChanged: true, filesChanged: true }) : noEffects(),
    next: intent ? nextActions(intent) : [],
    restState: intent?.status === 'succeeded' ? 'complete' : 'informational',
    data: intent ? { intent } : { intents }
  });
}

export async function run(_argv, { positionals, options, operation }) {
  const action = positionals[1] ?? 'status';
  const intentId = positionals[2] ?? null;
  const json = optionBoolean(options, 'json');
  if (action === 'status') {
    // --repository <PATH>: only this repository's uploads, from any of its checkouts on this computer.
    const repository = optionString(options, 'repository');
    const result = intentId
      ? await readTransportIntent(intentId)
      : repository
        ? await transportIntentsForRepository(repository, { includeSucceeded: optionBoolean(options, 'all') })
        : await listTransportIntents({ includeSucceeded: optionBoolean(options, 'all') });
    const intent = Array.isArray(result) ? null : result;
    return emitCommandResult(commandResult({
      operation: { id: operation.id, classification: operation.classification },
      subject: intent ? { kind: 'repository', id: intent.repositoryRootFingerprint } : null,
      outcome: succeeded('transport.reported', intent
        ? {
            intentId: intent.intentId, status: intent.status,
            commit: intent.sourceCommit.slice(0, 12), ...faultSlots(intent)
          }
        : { count: result.length }),
      effects: noEffects(),
      next: intent ? nextActions(intent) : [],
      restState: intent?.status === 'succeeded' ? 'complete' : 'informational',
      data: intent ? { intent } : { intents: result }
    }), { json });
  }
  if (action === 'retry') {
    if (!intentId) throw new SingularityFlowError('push retry requires an intent ID.', {
      code: 'TRANSPORT_INTENT_ID_REQUIRED'
    });
    // This command is the explicit user retry after credentials, trust, proxy, or permissions were
    // corrected outside SFlow. Automatic callers do not receive this authority.
    const intent = await retryTransportIntent(intentId, { allowNeedsUser: true });
    return emitCommandResult(result(operation, succeeded('transport.retry-completed', {
      intentId: intent.intentId, status: intent.status, ...faultSlots(intent)
    }), { intent, changed: true }), { json });
  }
  throw new SingularityFlowError(`Unknown push subcommand '${action}'. Available: status, retry.`, {
    code: 'UNKNOWN_SUBCOMMAND'
  });
}
