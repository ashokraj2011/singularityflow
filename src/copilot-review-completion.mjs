/** One bounded native-host continuation for an admitted source review that stopped after reading. */
import { recordSha256 } from './records.mjs';
import { readSourceReviewDraft } from './source-review-progress.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { reviewCompletionTurn, saveReviewCompletionTurn } from './copilot-mutation-guard.mjs';

/** Real permission/tool failures remain visible; a recoverable oversized read is not a write refusal. */
export async function noteReviewCompletionFailure(payload, error = payload.error) {
  if (typeof error === 'string' && error.includes('FILE_READ_TOO_LONG')) return {};
  const value = await reviewCompletionTurn(payload);
  if (value?.reviewOperation) {
    value.reviewOperation.blocked = true;
    await saveReviewCompletionTurn(payload, value);
  }
  return {};
}

export async function sourceReviewAgentStop(payload = {}) {
  if ((payload.stopReason ?? payload.stop_reason) !== 'end_turn'
      || payload.stop_hook_active === true || payload.stopHookActive === true) return {};
  const value = await reviewCompletionTurn(payload);
  const operation = value?.reviewOperation;
  if (!operation || operation.continued || operation.blocked || operation.complete
      || !['author-report', 'repair-report', 'retain-report'].includes(operation.state)
      || operation.workId !== value.contract.workId || operation.phaseId !== value.contract.phaseId
      || operation.generation !== value.contract.generation
      || !value.contract.allow.staging.includes(operation.stagingPath)) return {};
  let draft;
  try { draft = await readSourceReviewDraft(operation.stagingPath, value.binding.gitDir); }
  catch { return {}; }
  // An independently changed binding needs a fresh entry, never a transplanted judgment.
  if (draft?.report?.binding && recordSha256(draft.report.binding) !== operation.bindingSha256) return {};
  const check = safeCommandGuidance({ argv: ['review-source', 'check', operation.phaseId,
    '--report-file', operation.stagingPath, '--for-agent', '--json'] });
  const next = draft && !draft.error ? `Run ${check.command} now, then follow its repair or retention route.`
    : `${draft ? 'Repair the existing JSON' : 'Author the independent report from the issued template and already read pinned inputs'} at ${operation.stagingPath}. Then run ${check.command} and retain when retentionReady.`;
  operation.continued = true;
  if (!await saveReviewCompletionTurn(payload, value, { once: true })) return {};
  return { decision: 'block', reason: `SFLOW_SOURCE_REVIEW_INCOMPLETE: ${operation.workId} ${operation.phaseId} generation ${operation.generation} has no completed retained review from this operation. ${next} `
    + 'Continue the existing operation in this turn; do not reload context or repeat the input reads. Preserve exact bindings and independent judgments. Honest semantic gaps may be retained as correction-required findings. Never approve, decide for a human, publish an artifact or advance the phase. '
    + 'This is one automatic continuation only. If a real tool/authority/input blocker remains, preserve the draft and report its exact error and recovery route.' };
}
