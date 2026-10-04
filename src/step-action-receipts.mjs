/**
 * Receipts for after-step actions: the shared record of what was delivered.
 *
 * The outbox says what this machine sent, and it stays on this machine. A receipt is the record
 * everyone sees: one immutable file per delivery under the Story's evidence/step-actions/,
 * committed by `singularity-flow integrations record` in one external-synchronized commit. It binds
 * the delivery key, the transition commit that caused the delivery, the event that was sent and
 * the pinned target (both by hash), and the delivered outcome.
 *
 * Only a delivery that matches what the Story pinned becomes a receipt: its key derives from the
 * Story, step, generation, trigger and action; its action and target are the pinned ones; and its
 * transition commit is in this branch's history. Receipts are never committed while a step awaits
 * approval, because any commit during review makes that step's submission stale.
 *
 * An action pinned with `required: true` holds the Story after its step: preparing any later step,
 * and finalizing after the last one, waits until the step's approved delivery of that action has a
 * committed receipt.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { commitIsAncestor, exactFileAtObject, head } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { readDeliveredStepActions, readStepActionDelivery } from './step-action-delivery.mjs';
import { stepActionDeliveryKey, storyRequiresStepActions } from './step-actions.mjs';
import { SingularityFlowError, writeAtomicExclusive } from './util.mjs';

export const STEP_ACTION_RECEIPT_FAMILY = 'step-action-receipt';
const RECEIPT_FILE = /^(sad_[0-9a-f]{40})\.json$/;

/** The Story's receipt directory, relative to the repository. */
export function stepActionReceiptDirectory(config, workId) {
  return path.posix.join(config.workItemRoot ?? 'singularity/work-items', workId, 'evidence', 'step-actions');
}

/** The receipt a delivered outbox record becomes. Pure: the same record always gives the same receipt. */
export function stepActionReceipt(record, { recordedAt, recordedBy = null }) {
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  const last = attempts.at(-1) ?? {};
  return {
    schemaVersion: currentSchemaVersion(STEP_ACTION_RECEIPT_FAMILY),
    deliveryKey: record.key,
    workId: record.workId,
    phaseId: record.phaseId,
    generation: record.generation,
    trigger: record.trigger,
    action: { id: record.action.id, target: record.action.target, kind: record.action.targetSpec.kind, send: record.action.send ?? 'event' },
    targetSha256: recordSha256(record.action.targetSpec),
    transitionCommit: record.commit,
    eventSha256: recordSha256(record.event),
    artifact: record.action.send === 'artifact' ? { path: record.artifact?.path ?? null, sha256: record.artifact?.sha256 ?? null } : null,
    delivered: { at: record.deliveredAt ?? last.at ?? null, attempts: attempts.length, status: last.status ?? null, detail: last.detail ?? null },
    recordedAt,
    recordedBy
  };
}

/** The delivery keys that already have a receipt in this checkout. */
export async function recordedStepActionKeys(root, config, workId) {
  let names;
  try { names = await readdir(path.join(root, stepActionReceiptDirectory(config, workId))); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return names.map((name) => RECEIPT_FILE.exec(name)?.[1]).filter(Boolean).sort();
}

/** Every receipt the Story holds, read through the record family. */
export async function readStepActionReceipts(root, config, workId) {
  const directory = path.join(root, stepActionReceiptDirectory(config, workId));
  const receipts = [];
  for (const key of await recordedStepActionKeys(root, config, workId)) {
    receipts.push(readRecord(STEP_ACTION_RECEIPT_FAMILY, await readFile(path.join(directory, `${key}.json`))).record);
  }
  return receipts;
}

/** Why a delivered record cannot become one of this Story's receipts, or null when it can. */
export function stepActionReceiptProblem(root, workflow, record) {
  let expected = null;
  try {
    expected = stepActionDeliveryKey({
      workId: workflow.workItem.id, phaseId: record.phaseId, generation: record.generation, trigger: record.trigger, actionId: record.action?.id
    });
  } catch { expected = null; }
  if (record.key !== expected) return 'Its key does not match its Story, step, generation, trigger and action.';
  const pinned = (workflow.resolution?.phases ?? []).find((phase) => phase.id === record.phaseId)?.afterStep?.find((action) => action.id === record.action.id);
  if (!pinned) return `The Story did not pin an action '${record.action.id}' for ${record.phaseId}.`;
  if (recordSha256(pinned) !== recordSha256(record.action)) return `Action '${record.action.id}' differs from what the Story pinned for ${record.phaseId}.`;
  const phase = workflow.phases?.[record.phaseId];
  if (!phase || !Number.isSafeInteger(phase.generation) || record.generation > phase.generation) return `${record.phaseId} has no generation ${record.generation}.`;
  if (typeof record.commit !== 'string' || !commitIsAncestor(root, record.commit, 'HEAD')) return 'Its transition commit is not in this branch\'s history.';
  return null;
}

/**
 * What `integrations record` would commit: every delivered delivery of this Story without a
 * receipt that matches what the Story pinned, and why any other delivered one is left out.
 */
export async function planStepActionReceipts(root, config, workflow) {
  const workId = workflow.workItem.id;
  const recorded = new Set(await recordedStepActionKeys(root, config, workId));
  const pending = [];
  const skipped = [];
  for (const record of await readDeliveredStepActions(root, { workId })) {
    if (recorded.has(record.key)) continue;
    const reason = stepActionReceiptProblem(root, workflow, record);
    if (reason) skipped.push({ key: record.key, phaseId: record.phaseId, trigger: record.trigger, action: record.action?.id ?? null, reason });
    else pending.push(record);
  }
  return { workId, recorded: recorded.size, pending, skipped };
}

/** The step a commit now would make stale, or null. */
export function stepAwaitingApproval(workflow) {
  return (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).find((id) => workflow.phases?.[id]?.status === 'awaiting_approval') ?? null;
}

/** Refuse to record while a step awaits approval: the commit would require resubmitting it. */
export function assertReceiptsMayBeRecorded(workflow) {
  const phaseId = stepAwaitingApproval(workflow);
  if (!phaseId) return;
  throw new SingularityFlowError(
    `${phaseId} is awaiting approval, and a commit now would require submitting it again. `
    + `Record the receipts after it is approved or sent back: singularity-flow integrations record.`,
    { code: 'STEP_ACTION_RECEIPTS_DURING_REVIEW', details: { workId: workflow.workItem.id, phaseId } }
  );
}

/**
 * Write one receipt per record into the Story's evidence. A receipt that already exists is kept
 * as it is, never replaced. Returns the receipts written, with their repository-relative paths.
 */
export async function writeStepActionReceipts(root, config, workflow, records, { recordedAt, recordedBy = null }) {
  const relative = stepActionReceiptDirectory(config, workflow.workItem.id);
  const written = [];
  for (const record of records) {
    const receipt = stepActionReceipt(record, { recordedAt, recordedBy });
    const file = path.posix.join(relative, `${record.key}.json`);
    try {
      await writeAtomicExclusive(path.join(root, file), `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    written.push({ path: file, receipt });
  }
  return written;
}

export { storyRequiresStepActions };

/** The approved deliveries the Story's required actions call for, one per approved step and action. Pure. */
export function requiredStepActionDeliveries(workflow) {
  const deliveries = [];
  for (const resolved of workflow?.resolution?.phases ?? []) {
    const actions = (resolved?.afterStep ?? []).filter((action) => action?.required === true);
    const state = workflow.phases?.[resolved.id];
    if (!actions.length || state?.status !== 'approved' || !Number.isSafeInteger(state.generation)) continue;
    for (const action of actions) {
      deliveries.push({
        phaseId: resolved.id, generation: state.generation, trigger: 'approved', action: action.id, target: action.target,
        key: stepActionDeliveryKey({ workId: workflow.workItem.id, phaseId: resolved.id, generation: state.generation, trigger: 'approved', actionId: action.id })
      });
    }
  }
  return deliveries;
}

/**
 * The required deliveries without a committed receipt. A receipt counts only when HEAD holds it
 * and it names exactly that delivery: a file someone wrote but did not commit holds nothing up.
 */
export async function missingRequiredStepActionReceipts(root, config, workflow) {
  const required = requiredStepActionDeliveries(workflow);
  if (!required.length) return [];
  const commit = head(root);
  const directory = stepActionReceiptDirectory(config, workflow.workItem.id);
  return required.filter((entry) => {
    const bytes = exactFileAtObject(root, commit, `${directory}/${entry.key}.json`);
    if (!bytes) return true;
    try {
      const receipt = readRecord(STEP_ACTION_RECEIPT_FAMILY, bytes).record;
      return !(receipt.deliveryKey === entry.key && receipt.workId === workflow.workItem.id && receipt.phaseId === entry.phaseId
        && receipt.generation === entry.generation && receipt.trigger === 'approved' && receipt.action?.id === entry.action);
    } catch { return true; }
  });
}

const HELD_BECAUSE = Object.freeze({
  delivered: 'It was delivered from this machine; record its receipt',
  pending: 'It has not been delivered yet and is retried automatically; deliver it now',
  failed: 'Its delivery failed and waits for a person; fix the target, then deliver it',
  waiting: 'It waits for the step\'s commit to be published; publish it',
  pipeline: 'A pipeline delivers it and records its receipt; once it has, bring that receipt here',
  tampered: 'This machine\'s record of it no longer matches its seal and is never sent; deliver and record it from the machine that approved the step',
  absent: 'This machine has no delivery record; reconstruct it from the committed approval, review the unknown prior outcome, then explicitly retry'
});

/** What to run for one missing receipt, from what this machine's outbox knows about the delivery. */
function nextForMissing(entry) {
  if (entry.here === 'delivered') return 'singularity-flow integrations record';
  if (entry.here === 'pending' || entry.here === 'failed' || entry.here === 'absent') return `singularity-flow integrations retry ${entry.key}`;
  if (entry.here === 'waiting') return 'singularity-flow sync';
  if (entry.here === 'pipeline') return 'singularity-flow refresh-branch';
  return null;
}

/**
 * What holds the Story now: each required delivery without a committed receipt, with what this
 * machine's outbox knows about it, and the one command this machine can run about the first. Null
 * when nothing holds the Story. Planners show it; prepare, publish, submit and finalize refuse on it.
 */
export async function requiredStepActionHold(root, config, workflow) {
  if (!storyRequiresStepActions(workflow)) return null;
  const missing = await missingRequiredStepActionReceipts(root, config, workflow);
  if (!missing.length) return null;
  const described = [];
  for (const entry of missing) {
    const record = await readStepActionDelivery(root, entry.key).catch(() => null);
    described.push({ ...entry, here: record?.tampered ? 'tampered' : record?.status ?? 'absent',
      ...(record?.recovery?.priorOutcome === 'unknown' && record.status === 'failed' ? { reconstructed: true } : {}) });
  }
  const first = described[0];
  const nextAction = nextForMissing(first);
  const list = described.map((entry) => `${entry.action} → ${entry.target} (${entry.phaseId} generation ${entry.generation}, approved)`).join(', ');
  return {
    missing: described,
    nextAction,
    what: `${described.length === 1 ? 'the required after-step action' : `${described.length} required after-step actions`} ${list} ${described.length === 1 ? 'has' : 'have'} no receipt in the Story`,
    because: first.reconstructed
      ? 'The delivery record was reconstructed, but its prior outcome is unknown; check the receiver before explicitly retrying'
      : HELD_BECAUSE[first.here] ?? HELD_BECAUSE.absent
  };
}

/** One sentence a planner shows for a hold; the planner shows the command beside it. */
export function stepActionHoldSentence(hold) {
  return hold ? `The next step waits: ${hold.what}. ${hold.because}.` : null;
}

/**
 * Refuse while a required delivery of an approved step has no committed receipt. `held` names what
 * waits, such as "implement cannot be prepared" or "the Story cannot be finalized".
 */
export async function assertRequiredStepActionsRecorded(root, config, workflow, held) {
  const hold = await requiredStepActionHold(root, config, workflow);
  if (!hold) return;
  throw new SingularityFlowError(`${held} yet: ${hold.what}. ${hold.because}${hold.nextAction ? `: ${hold.nextAction}` : ''}.`, {
    code: 'STEP_ACTION_REQUIRED_UNRECORDED', details: { workId: workflow.workItem.id, missing: hold.missing, nextAction: hold.nextAction }
  });
}
