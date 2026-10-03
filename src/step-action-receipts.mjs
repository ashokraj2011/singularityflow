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
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { commitIsAncestor } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { readDeliveredStepActions } from './step-action-delivery.mjs';
import { stepActionDeliveryKey } from './step-actions.mjs';
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
