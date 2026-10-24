/**
 * `sync`: the one command for "finish what was not published" [SPEC-OAP M3, owner decision 5].
 *
 * `sync [WORK-ID]` publishes the Story's retained commit (or recovers an interrupted pre-commit
 * publication), then retries every push this repository saved before a Story existed that can still
 * land: workflow proposals, approval-group enrollment, configuration changes and setup pushes.
 * `sync <INTENT-ID>` retries exactly that one, as the push command's retry subcommand did; that
 * subcommand stays as its alias. The person running sync carries the same authority as that retry,
 * so a push stopped for a cause only a person can clear is tried again here. `--replay` is unchanged.
 */
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { isTransportIntentId, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';

const SYNC_OPERATION = Object.freeze({ id: 'sync', classification: 'mutation' });
/** Saved pushes a retry can still land. A succeeded one landed; a remote-diverged one never can. */
const RETRYABLE = new Set(['pending', 'pushing', 'outcome-unknown', 'needs-user', 'attempt-budget-exhausted']);
/** Refusals a later retry can get past once their cause is fixed; any other refusal says why no retry lands. */
const RETRY_AFTER_FIX = new Set(['TRANSPORT_REMOTE_DRIFTED', 'TRANSPORT_INTENT_BUSY']);
const KINDS = Object.freeze([
  [/^sflow\.configuration\.people\./u, 'approval-group enrollment'],
  [/^sflow\.configuration\.workflow\./u, 'workflow proposal'],
  [/^sflow\.configuration\.editor\./u, 'configuration change'],
  [/^sflow\.configuration\.initialize$/u, 'configuration setup'],
  [/^sflow\.initialize$/u, 'repository setup']
]);

/** The command log, harness record and soft-gate overrides the legacy dispatcher gave sync. */
export async function run(argv, { positionals, options, operation }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => syncCommand(positionals, options, { operation })));
}

/**
 * `retryTransports: false` publishes only the Story: `next` runs sync on the person's behalf, and an
 * automatic caller never gets the authority to retry a push a person must clear first.
 */
export async function syncCommand(positionals = [], options = {}, { operation = SYNC_OPERATION, retryTransports = true } = {}) {
  const json = optionBoolean(options, 'json');
  if (isTransportIntentId(positionals[1])) {
    const { retryIntentCommand } = await import('./push.mjs');
    return retryIntentCommand(positionals[1], { operation, json });
  }
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  if (optionBoolean(options, 'replay')) {
    const { config, requestedId } = await storySelection(root, positionals[1] ?? null);
    return syncReplayCommand(root, config, requestedId, options);
  }
  const say = output(json);
  const story = await publishStory(root, positionals[1] ?? null, options, say);
  if (!story.workId) say.text('No Story publication is pending here.');
  const transports = retryTransports ? await retrySavedPushes(root, say) : { retried: [], skipped: [] };
  if (!story.workId && !transports.retried.length && !transports.error) say.text('Nothing else is waiting to be published.');
  if (json) return emitSyncResult(operation, story, transports, say.routes);
  return { story, transports };
}

/** Lines in the terminal as they happen; nothing when the caller asked for JSON. */
function output(json) {
  return {
    routes: [],
    text(line) { if (!json) console.log(line); },
    route(command, { label, skill = null, indent = '', detail = label } = {}) {
      this.routes.push({ command, label: detail, skill });
      if (!json) printCommandRoutes(command, { label, skill, indent });
    }
  };
}

async function storySelection(root, explicit) {
  const [{ loadConfig }, { branch }, { workIdForBranch }] = await Promise.all([
    import('../state-stores.mjs'), import('../git.mjs'), import('../story-branch-name.mjs')
  ]);
  const config = await loadConfig(root);
  return { config, requestedId: explicit ?? await workIdForBranch(root, config, branch(root)) ?? branch(root) };
}

/**
 * The Story half: the retained commit, or an interrupted pre-commit publication. Named explicitly, a
 * Story that cannot be read still fails as before. Unnamed, a checkout with no Story (no SFlow
 * configuration yet, or a branch no Story owns) has no Story publication, and the saved pushes are
 * still tried.
 */
async function publishStory(root, explicit, options, say) {
  let selection;
  try { selection = await storySelection(root, explicit); }
  catch (error) {
    if (!explicit && error?.code === 'WORKFLOW_CONFIGURATION_MISSING') return { workId: null, status: 'none' };
    throw error;
  }
  const { config, requestedId } = selection;
  const { recoverPreparedPublicationBySubject } = await import('../publication-pending.mjs');
  const direct = await recoverPreparedPublicationBySubject(root, { kind: 'story', id: requestedId });
  if (direct.status === 'active') {
    throw new SingularityFlowError(
      `Story '${requestedId}' has an active publication command (PID ${direct.active.pid}). `
      + 'Return to that terminal and complete or interrupt it; recovery never rolls back a live owner.'
    );
  }
  if (direct.status === 'recovered') {
    say.text(`Rolled back the interrupted pre-commit publication for ${requestedId} to its exact durable pre-transaction state.`);
    if (direct.rescuePath) say.text(`Preserved the interrupted partial bytes at ${direct.rescuePath}.`);
    say.route(`singularity-flow nextsteps ${requestedId}`, { label: 'Before retrying' });
    return { workId: requestedId, status: 'rolled-back', rescuePath: direct.rescuePath ?? null };
  }
  if (direct.status === 'manual') {
    throw new SingularityFlowError(
      `Story '${requestedId}' has an interrupted pre-commit publication that cannot be restored automatically. `
      + 'Its journal was retained; run singularity-flow doctor --json and inspect the reported recovery evidence.',
      { code: 'STORY_PUBLICATION_RECOVERY_MANUAL', details: { workId: requestedId, nextAction: 'singularity-flow doctor --json' } }
    );
  }
  const [{ loadStoryAggregate }, { syncPublication }] = await Promise.all([
    import('../story-aggregate-read.mjs'), import('../state-stores.mjs')
  ]);
  let workflow;
  try { workflow = await loadStoryAggregate(root, config, requestedId); }
  catch (error) {
    if (!explicit && error?.code === 'STORY_NOT_FOUND') return { workId: null, status: 'none' };
    throw error;
  }
  const workId = workflow.workItem.id;
  let result;
  try {
    result = await syncPublication(root, config, workflow, { rebindRemote: optionString(options, 'rebind-remote') });
  } catch (error) {
    throw await explainLostPublicationRace(root, config, workflow, error);
  }
  let status;
  if (result.recoveredPrepared && result.restoredPrepared) {
    status = 'rolled-back';
    say.text(`Rolled back the interrupted pre-commit publication for ${workId} to its exact durable pre-transaction state.`);
    if (result.rescuePath) say.text(`Preserved the interrupted partial bytes at ${result.rescuePath}.`);
    say.route(`singularity-flow nextsteps ${workId}`, { label: 'Before retrying' });
  } else if (result.recoveredPrepared) {
    status = 'cleared';
    say.text(`Cleared the interrupted pre-commit publication for ${workId}; HEAD and the working tree already matched its exact baseline. Retry the original command.`);
  } else if (result.noOp) {
    status = 'no-op';
    say.text(`Story ${workId} has no pending publication; nothing was pushed.`);
  } else {
    status = 'pushed';
    say.text(`Pushed ${result.pushed.slice(0, 8)} to ${result.remote}/${result.branch}.`);
  }
  if (result.stepActions?.delivered?.length) {
    const { recordRequiredReceiptsAfterTransition } = await import('./shared/record-required-receipts-after-transition.mjs');
    const receiptsLine = await recordRequiredReceiptsAfterTransition(root, workflow);
    if (receiptsLine) say.text(receiptsLine);
  }
  return {
    workId, status, rescuePath: result.rescuePath ?? null,
    ...(status === 'pushed' ? { commit: result.pushed, remote: result.remote, branch: result.branch } : {})
  };
}

/** What a saved push was, from the operation that made it, and where it goes. */
function pushLabel(intent) {
  const operation = String(intent.scope?.operation ?? '');
  const kind = KINDS.find(([pattern]) => pattern.test(operation))?.[1]
    ?? (intent.scope?.bootstrapId ? 'workspace setup push' : 'saved push');
  return `${kind} to ${String(intent.targetRef ?? '').replace(/^refs\/heads\//u, '')}`;
}

/**
 * The transport half: every saved push of this repository (this checkout, or another checkout of the
 * same push remote) that a retry can still land, oldest first, each tried once. One that does not
 * land says its one cause and the fix; one that can no longer land is listed only in --json.
 */
async function retrySavedPushes(root, say) {
  const transport = await import('../transport-intents.mjs');
  let saved;
  try { saved = await transport.transportIntentsForRepository(root, { includeSucceeded: false }); }
  catch (error) {
    say.text(`The saved pushes of this repository could not be read: ${error.message}`);
    return { retried: [], skipped: [], error: { code: error.code ?? null, message: error.message } };
  }
  const landable = (intent) => RETRYABLE.has(intent.status) && !transport.transportCheckoutMissing(intent);
  const skipped = saved.filter((intent) => !landable(intent)).map((intent) => ({
    intentId: intent.intentId, kind: pushLabel(intent), status: intent.status,
    ...(transport.transportFaultSummary(intent) ?? {})
  }));
  const retried = [];
  for (const intent of saved.filter(landable).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
    const label = pushLabel(intent);
    const where = `${label} (commit ${intent.sourceCommit.slice(0, 12)}, ${intent.intentId})`;
    let after = intent;
    let failure = null;
    try { after = await transport.retryTransportIntent(intent.intentId, { allowNeedsUser: true }); }
    catch (error) {
      failure = error;
      after = await transport.readTransportIntent(intent.intentId).catch(() => intent);
    }
    const published = !failure && after.status === 'succeeded';
    const summary = failure ? { reason: failure.message } : transport.transportFaultSummary(after) ?? {};
    const retry = !failure ? transport.transportRetryAction(after)
      : failure.details?.nextAction ?? (RETRY_AFTER_FIX.has(failure.code) ? transport.transportRetryAction(after) : null);
    const nextAction = published || !retry ? null : typeof retry === 'string' ? { command: retry, skill: null } : retry;
    retried.push({
      intentId: intent.intentId, kind: label, targetRef: intent.targetRef, commit: intent.sourceCommit,
      status: after.status, published, ...summary,
      ...(failure ? { error: { code: failure.code ?? null } } : {}), nextAction
    });
    if (published) { say.text(`Published the ${where}.`); continue; }
    say.text(failure
      ? `Did not publish the ${where}: ${failure.message}`
      : `Did not publish the ${where}: it is ${after.status}.${transport.transportFaultSentence(after)}`);
    if (nextAction) {
      say.route(nextAction.command, {
        label: 'Once that is fixed, retry it', detail: `Retry the ${label} once its cause is fixed`,
        skill: nextAction.skill ?? null, indent: '  '
      });
    }
  }
  return { retried, skipped };
}

async function emitSyncResult(operation, story, transports, routes) {
  const [{ action, commandResult, effects, noEffects, noop, succeeded }, { emitCommandResult }] = await Promise.all([
    import('../narration/command-result.mjs'), import('../narration/emit.mjs')
  ]);
  const published = transports.retried.filter((entry) => entry.published).length;
  const unpublished = transports.retried.length - published;
  const storyChanged = ['pushed', 'rolled-back', 'cleared'].includes(story.status);
  const changed = storyChanged || transports.retried.length > 0;
  const slots = {
    workId: story.workId, story: story.status, commit: story.commit?.slice(0, 8) ?? null,
    retried: transports.retried.length, published, unpublished
  };
  const next = routes.map((route, index) => action({
    id: `sync-next-${index + 1}`, label: route.label, command: route.command,
    ...(route.skill ? { skill: route.skill } : {}), kind: 'remediation'
  }));
  return emitCommandResult(commandResult({
    operation: { id: operation.id, classification: operation.classification },
    subject: story.workId ? { kind: 'story', id: story.workId } : null,
    outcome: changed ? succeeded('sync.completed', slots) : noop('sync.completed', slots),
    effects: changed
      ? effects({ stateChanged: true, filesChanged: true, publicationCreated: story.status === 'pushed' || published > 0 })
      : noEffects(),
    next,
    restState: unpublished || story.status === 'rolled-back' || transports.error ? 'informational' : 'complete',
    data: { story, transports: { retried: transports.retried, skipped: transports.skipped, ...(transports.error ? { error: transports.error } : {}) } }
  }), { json: true });
}

/**
 * A push refused because another clone published to the Story first leaves a retained commit that
 * sync can only retry. When that commit is a document upload, say how to replay it.
 */
async function explainLostPublicationRace(root, config, workflow, error) {
  let plan = null;
  try {
    const { planDocumentReplay } = await import('../document-replay.mjs');
    plan = await planDocumentReplay(root, config, workflow);
  } catch { return error; }
  if (plan?.replayable) {
    return new SingularityFlowError(
      `Another clone published to ${workflow.workItem.id} first, so its retained document upload (commit ${plan.commit.slice(0, 8)}) cannot be pushed as it is. `
      + 'Replay it onto the published Story with singularity-flow sync --replay (preview with --dry-run): the same documents are added again and take the next free IDs. Nothing was changed.',
      { code: 'STORY_PUBLICATION_RACE_LOST', details: { commit: plan.commit, remoteTip: plan.remoteTip, documents: plan.documents, nextAction: 'singularity-flow sync --replay --dry-run' } }
    );
  }
  if (plan?.reason === 'name-taken') {
    const { documentReplayReason } = await import('../document-replay.mjs');
    return new SingularityFlowError(
      `Another clone published to ${workflow.workItem.id} first, and its retained document upload cannot be replayed: ${documentReplayReason(plan)}. `
      + 'Nothing was changed.', { code: 'STORY_PUBLICATION_RACE_LOST', details: { commit: plan.commit, collisions: plan.collisions } }
    );
  }
  return error;
}

async function syncReplayCommand(root, config, requestedId, options) {
  const [{ documentReplayReason, replayPendingDocumentUpload }, { loadStoryAggregate }] = await Promise.all([
    import('../document-replay.mjs'), import('../story-aggregate-read.mjs')
  ]);
  const workflow = await loadStoryAggregate(root, config, requestedId);
  const dryRun = optionBoolean(options, 'dry-run');
  const result = await replayPendingDocumentUpload(root, config, workflow, { dryRun });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  if (dryRun) {
    if (!result.replayable) {
      console.log(`Nothing to replay: ${documentReplayReason(result)}.`);
      return;
    }
    console.log(`Would replay commit ${result.commit.slice(0, 8)} onto ${result.remote}/${result.branch} at ${result.remoteTip.slice(0, 8)}:`);
    for (const document of result.documents) console.log(`  ${document.id} — ${document.name} (gets the next free ID)`);
    console.log('Dry run: no state changed.');
    return;
  }
  console.log(`Replayed commit ${result.from.slice(0, 8)} onto the published Story; it is kept at ${result.preservedRef}.`);
  for (const document of result.documents) console.log(`  ${document.previousId} → ${document.id ?? '?'} — ${document.name}`);
  console.log(`Commit: ${result.publication.sha.slice(0, 8)}${result.publication.pushed ? ' pushed' : ' retained locally'}`);
  if (!result.publication.pushed) printCommandRoutes('singularity-flow sync', { label: 'Publish the retained commit' });
}
