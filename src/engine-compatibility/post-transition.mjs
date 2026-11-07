/** Native post-transition effects. Presentation and recovery command rendering belong to hosts. */
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

async function notify(notice, event) {
  try { await notice(event); return null; }
  catch (error) { return error; }
}

/** An accepted transition is never undone because its local projection or observer failed. */
export async function postPublicationStep(task, workId, operation, {notice = () => {}} = {}) {
  try { return {ok: true, value: await operation()}; }
  catch (error) {
    const noticeError = await notify(notice, {code: 'transition.tail-failed', task, workId, error});
    return {ok: false, value: null, error, ...(noticeError ? {noticeError} : {})};
  }
}

/** Record delivered required actions through their existing native writer; return facts, not text. */
export async function collectRequiredReceiptsAfterTransition(root, workflow, {notice = () => {}} = {}) {
  const {storyRequiresStepActions} = await import('../step-actions.mjs');
  if (!storyRequiresStepActions(workflow)) return null;
  try {
    const {recordRequiredReceiptsAfterDelivery} = await import('../step-action-recording.mjs');
    return {recorded: await recordRequiredReceiptsAfterDelivery(root, {workId: workflow.workItem.id})};
  } catch (error) {
    const noticeError = await notify(notice, {code: 'transition.receipts-failed', workId: workflow.workItem.id, error});
    return {recorded: null, error, ...(noticeError ? {noticeError} : {})};
  }
}

/** Preserve the existing specification claim/delivery policy and exact state-branch usage writer. */
export async function collectSpecUsageAfterTransition(root, config, workflow,
  {phase = null, ended = false, notice = () => {}} = {}) {
  if (phase && phase !== workflow.phaseOrder?.[0] && !ended) return null;
  const workId = workflow.workItem.id;
  const file = path.join(root, config.workItemRoot ?? 'singularity/work-items', workId, 'source.json');
  let source = null;
  try { source = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
  if (!Array.isArray(source?.specification) || !source.specification.length) return null;
  const {publishUsage, usageRecords} = await import('../spec-library/usage.mjs');
  try {
    const {loadAcceptedStoryExecution} = await import('../accepted-story-execution.mjs');
    const accepted = await loadAcceptedStoryExecution(root, workId);
    const records = usageRecords(accepted.workflow, source);
    if (!records.length) return null;
    const result = await publishUsage(root, accepted.definition, records);
    const noticeError = result.differing.length ? await notify(notice,
      {code: 'transition.usage-differs', workId, paths: result.differing}) : null;
    return {records, result, ...(noticeError ? {noticeError} : {})};
  } catch (error) {
    const noticeError = await notify(notice,
      {code: 'transition.usage-failed', workId, specifications: source.specification, error});
    return {records: [], result: null, error, ...(noticeError ? {noticeError} : {})};
  }
}
