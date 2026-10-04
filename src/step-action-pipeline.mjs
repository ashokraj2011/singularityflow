/**
 * Delivering after-step actions from a pipeline: `singularity-flow integrations deliver --commit`.
 *
 * A target marked `deliverFrom: pipeline` is not delivered by the machine that moves the Story;
 * that machine writes the delivery as the pipeline's. A pipeline holding the organisation's
 * credentials runs on each pushed lifecycle commit, rebuilds the deliveries that commit calls for
 * from the commit itself (its event, its Story state and its artifact bytes), and delivers them
 * under the same delivery keys, so a receiver can deduplicate retries.
 *
 * The pipeline trusts nothing a Story branch can change. It delivers an action only when the target
 * the Story pinned is exactly the target the approved workflow configuration declares on a trusted
 * ref: the remote's default branch, unless --trusted-ref names another. A commit on a Story branch
 * can therefore never send the pipeline's secrets to an address of its choosing. The event is the
 * one the commit binds by hash in its Singularity-Flow-Event-SHA256 trailer.
 */
import YAML from 'yaml';

import {
  checkedOutBranch, commitChangedPaths, commitIsAncestor, committedFileBytes, committedFileText, governedCommitIdentity,
  refCommit, remoteDefaultBranchName
} from './git.mjs';
import { recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { deliverStepActions, enqueueStepActions, postDelivery } from './step-action-delivery.mjs';
import {
  actionsForTrigger, normalizeIntegrations, stepActionDeliveryKey, stepActionTriggers
} from './step-actions.mjs';
import { SingularityFlowError } from './util.mjs';

const WORKFLOW_CONFIGURATION = 'singularity/workflow.yml';
/** A pipeline waits for its deliveries longer than a person does at a transition. */
export const PIPELINE_DELIVERY_BUDGET_MS = 120_000;

/** The ref whose reviewed configuration a pipeline trusts, and the commit it names. */
export function trustedConfigurationRef(root, requested = null) {
  const ref = requested ?? `refs/remotes/origin/${remoteDefaultBranchName(root, {}, 'origin') ?? 'main'}`;
  const commit = refCommit(root, ref);
  if (!commit) {
    throw new SingularityFlowError(
      `${ref} is not in this checkout, so there is no approved configuration to check targets against. Fetch it, or name the reviewed branch with --trusted-ref.`,
      { code: 'STEP_ACTION_TRUSTED_REF_MISSING', details: { ref } }
    );
  }
  return { ref, commit };
}

/** The targets the approved configuration declares on the trusted commit, normalized like any other. */
function trustedTargets(root, commit) {
  const text = committedFileText(root, commit, WORKFLOW_CONFIGURATION);
  if (!text) return {};
  try { return normalizeIntegrations(YAML.parse(text)?.integrations).targets; } catch { return {}; }
}

/**
 * The Story and event a lifecycle commit records: the workflow state the commit wrote whose
 * projection holds the event the commit binds by hash. Null when the commit is not a lifecycle
 * commit of any Story.
 */
export function lifecycleOf(root, identity) {
  const candidates = commitChangedPaths(root, identity.commit).filter((file) => /\/workflow\.json$/u.test(file));
  for (const file of candidates) {
    const bytes = committedFileBytes(root, identity.commit, file);
    if (!bytes) continue;
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { continue; }
    const projection = (raw?.publicationProjections ?? []).find((entry) => entry?.event
      && `sha256:${recordSha256(entry.event)}` === identity.eventSha256);
    if (!projection) continue;
    let workflow;
    try { workflow = readRecord('story-workflow', bytes).record; } catch { workflow = raw; }
    return { file, workflow, event: projection.event };
  }
  return null;
}

/**
 * What a pipeline would deliver for one commit: every action of a pipeline target its transition
 * fires, each marked trusted or not, with its delivery key. Never sends anything.
 */
export function pipelineDeliveriesFor(root, commit, { trustedRef = null } = {}) {
  const identity = governedCommitIdentity(root, commit);
  if (!identity) throw new SingularityFlowError(`${commit} is not a commit in this checkout.`, { code: 'STEP_ACTION_COMMIT_UNKNOWN' });
  const empty = { commit: identity.commit, lifecycle: false, workId: null, event: null, triggers: [], actions: [], trusted: null };
  if (!identity.eventSha256) return empty;
  const lifecycle = lifecycleOf(root, identity);
  if (!lifecycle) return empty;
  const { workflow, event } = lifecycle;
  const phase = workflow.phases?.[event.phaseId];
  const triggers = stepActionTriggers(event.type, phase);
  const resolved = (workflow.resolution?.phases ?? []).find((entry) => entry.id === event.phaseId);
  const generation = Number.isSafeInteger(event.generation) ? event.generation : (Number.isSafeInteger(phase?.generation) ? phase.generation : 0);
  const chosen = triggers.flatMap((trigger) => actionsForTrigger(resolved, trigger)
    .filter((action) => action.targetSpec?.deliverFrom === 'pipeline')
    .map((action) => ({ action, trigger })));
  const base = {
    ...empty, lifecycle: true, workId: workflow.workItem?.id ?? null, branch: workflow.workItem?.branch ?? event.subject?.branch ?? null,
    event: { type: event.type, phaseId: event.phaseId, generation }, triggers, workflow, rawEvent: event
  };
  if (!chosen.length) return base;
  const trusted = trustedConfigurationRef(root, trustedRef);
  const approved = trustedTargets(root, trusted.commit);
  return {
    ...base,
    trusted,
    actions: chosen.map(({ action, trigger }) => {
      const key = stepActionDeliveryKey({ workId: base.workId, phaseId: event.phaseId, generation, trigger, actionId: action.id });
      const declared = approved[action.target];
      const match = Boolean(declared) && recordSha256(declared) === recordSha256(action.targetSpec);
      return {
        key, action: action.id, target: action.target, kind: action.targetSpec.kind, trigger, trusted: match,
        reason: match ? null : declared
          ? `The target ${action.target} the Story pinned differs from the approved configuration on ${trusted.ref}, so the pipeline does not deliver it.`
          : `The approved configuration on ${trusted.ref} declares no target ${action.target}, so the pipeline does not deliver it.`
      };
    })
  };
}

/**
 * Deliver what one pushed lifecycle commit calls for from a pipeline, and with `record` commit
 * the receipts when the Story's branch is checked out here and no step awaits approval.
 */
export async function deliverFromPipeline(root, {
  commit, trustedRef = null, record = false, env = process.env, clock = Date.now, post = postDelivery, logger = null,
  budgetMs = PIPELINE_DELIVERY_BUDGET_MS
} = {}) {
  const plan = pipelineDeliveriesFor(root, commit, { trustedRef });
  const { workflow, rawEvent, ...summary } = plan;
  const result = { ...summary, report: null, receipts: null };
  const trusted = plan.actions.filter((entry) => entry.trusted);
  if (!trusted.length) return result;
  const keys = new Set(trusted.map((entry) => entry.key));
  await enqueueStepActions(root, workflow, {
    event: rawEvent, commit: plan.commit, published: true, clock, deliverer: 'pipeline', fromCommit: true,
    include: (action, trigger) => keys.has(stepActionDeliveryKey({
      workId: plan.workId, phaseId: plan.event.phaseId, generation: plan.event.generation, trigger, actionId: action.id
    }))
  });
  result.report = await deliverStepActions(root, { keys: [...keys], env, clock, post, logger, budgetMs });
  if (record) result.receipts = await recordFromPipeline(root, plan);
  return result;
}

/** Commit receipts for what this run delivered, when this checkout can: the Story's branch, holding the commit. */
async function recordFromPipeline(root, plan) {
  const branch = checkedOutBranch(root);
  if (!plan.branch || branch !== plan.branch) {
    return { recorded: false, reason: `Check out ${plan.branch ?? 'the Story branch'} to record receipts; this checkout is ${branch ? `on ${branch}` : 'detached'}.` };
  }
  if (!commitIsAncestor(root, plan.commit, 'HEAD')) return { recorded: false, reason: `${plan.branch} here does not contain ${plan.commit.slice(0, 12)}; fetch it first.` };
  const [{ loadConfig, loadStoryAggregate }, { commitStepActionReceipts }, { stepAwaitingApproval }] = await Promise.all([
    import('./state-stores.mjs'), import('./step-action-recording.mjs'), import('./step-action-receipts.mjs')
  ]);
  const config = await loadConfig(root);
  const story = await loadStoryAggregate(root, config);
  if (story.workItem.id !== plan.workId) return { recorded: false, reason: `This checkout holds ${story.workItem.id}, not ${plan.workId}.` };
  const waiting = stepAwaitingApproval(story);
  if (waiting) return { recorded: false, reason: `${waiting} is awaiting approval; the receipts are recorded after the decision.` };
  try {
    const { written, publication } = await commitStepActionReceipts(root, config, story);
    return { recorded: true, count: written.length, commit: publication.sha, pushed: Boolean(publication.pushed) };
  } catch (error) {
    if (error?.code === 'STEP_ACTION_RECEIPTS_ALREADY_RECORDED') return { recorded: false, reason: 'Every delivery here already has its receipt.' };
    throw error;
  }
}
