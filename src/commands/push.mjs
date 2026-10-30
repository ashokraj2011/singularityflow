/**
 * Inspect and retry exact pre-Story transport intents. `sync <INTENT-ID>` is the one way to retry one
 * [SPEC-OAP M3]; the retry subcommand here stays as its alias, for scripts that call it.
 */
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
/** The review branch a configuration proposal's upload published, when the intent is one. */
function configurationProposalBranch(intent) {
  if (!String(intent?.scope?.operation ?? '').startsWith('sflow.configuration.workflow.')) return null;
  const branch = /^refs\/heads\/(sflow\/config-change\/.+)$/u.exec(String(intent?.targetRef ?? ''))?.[1];
  return branch ?? null;
}

function nextActions(intent) {
  // Its checkout is gone: nothing can run there (the advice says to repeat the operation).
  if (transportCheckoutMissing(intent)) return [];
  const retry = `singularity-flow sync ${intent?.intentId}`;
  // An uploaded configuration proposal is not finished: approving it is (SDA sweep C5).
  const proposal = intent?.status === 'succeeded' ? configurationProposalBranch(intent) : null;
  if (proposal) {
    return [action({ id: 'configuration-approve', label: 'Read what the proposal changes and approve it',
      command: `singularity-flow configuration approve ${proposal}`, kind: 'remediation' })];
  }
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
    restState: intent?.status === 'succeeded' && !configurationProposalBranch(intent) ? 'complete' : 'informational',
    data: intent ? { intent } : { intents }
  });
}

/**
 * The person's own retry of one saved push: `sync <INTENT-ID>`, and the retry subcommand above as its alias.
 * It is the explicit retry after credentials, trust, proxy, or permissions were corrected outside
 * SFlow, so it carries the authority automatic callers never get.
 */
export async function retryIntentCommand(intentId, { operation, json = false }) {
  const intent = await retryTransportIntent(intentId, { allowNeedsUser: true });
  return emitCommandResult(result(operation, succeeded('transport.retry-completed', {
    intentId: intent.intentId, status: intent.status, ...faultSlots(intent)
  }), { intent, changed: true }), { json });
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
      restState: intent?.status === 'succeeded' && !configurationProposalBranch(intent) ? 'complete' : 'informational',
      data: intent ? { intent } : { intents: result }
    }), { json });
  }
  if (action === 'retry') {
    if (!intentId) throw new SingularityFlowError('Name the saved push to retry: singularity-flow sync <INTENT-ID>. '
      + 'singularity-flow push status lists them.', {
      code: 'TRANSPORT_INTENT_ID_REQUIRED', details: { nextAction: 'singularity-flow push status' }
    });
    return retryIntentCommand(intentId, { operation, json });
  }
  throw new SingularityFlowError(`Unknown push subcommand '${action}'. Available: status, retry.`, {
    code: 'UNKNOWN_SUBCOMMAND'
  });
}
