/** Bounded native-host completion for admitted workflow tasks, preserving real owner boundaries. */
import { recordSha256 } from './records.mjs';
import { readSourceReviewDraft } from './source-review-progress.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { CLARIFICATION_RESPONSE_FORMAT } from './phase-staging-paths.mjs';
import { reviewCompletionTurn, workflowCompletionTurn, nativeFileReadCalls, nativeReadFailureRecovery, saveReviewCompletionTurn } from './copilot-mutation-guard.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

// Copilot says why a turn ended. VS Code's Local chat calls its Stop hook only once the model has
// finished and sends no reason, so requiring one meant these checks never ran in that chat.
const turnFinished = (payload) => (payload.stopReason ?? payload.stop_reason ?? 'end_turn') === 'end_turn'
  && payload.stop_hook_active !== true && payload.stopHookActive !== true;
// The person's answers are in, so waiting on them no longer explains a stop. Each has its own one
// continuation, and neither spends the task's budget, which belongs to the authoring that follows.
const ANSWER_STATES = Object.freeze(['record-answers', 'refresh-entry']);

async function reserveTaskContinuation(value, operation) {
  if (!operation.operationId) return true; // Compatibility with older issued prompts.
  const { reserveWorkflowTaskContinuation } = await import('./workflow-task-store.mjs');
  const reserved = await reserveWorkflowTaskContinuation(value.contract.repositoryRoot, operation.operationId, {
    workId: operation.workId, phaseId: operation.phaseId, generation: operation.generation,
    role: operation.kind === 'phase-authoring' ? 'author' : 'source-reviewer'
  });
  return reserved.allowed;
}

function failureDetails(error, payload = {}) {
  const message = typeof error === 'string' ? error : error?.permissionDecisionReason ?? error?.message ?? '';
  let args = payload.toolArgs ?? payload.tool_input;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
  const readPaths = [...new Set(nativeFileReadCalls(payload).flatMap(call => call.paths))];
  const attemptedPath = [error?.path, ...(readPaths.length === 1 ? readPaths : []), args?.path, args?.file_path,
    args?.filePath].find(value => typeof value === 'string');
  return { code: String(error?.code ?? message.match(/^([A-Z][A-Z0-9_]+):/u)?.[1] ?? 'TOOL_FAILURE').slice(0, 100),
    message: redactDiagnosticText(message).slice(0, 2000),
    ...(attemptedPath ? { path: redactDiagnosticText(attemptedPath).slice(0, 4096) } : {}),
    ...(readPaths.length > 1 ? { attemptedPaths: readPaths.slice(0, 10).map(value => redactDiagnosticText(value).slice(0, 4096)) } : {}) };
}

function issuedReadCorrections(payload, error) {
  const paths = nativeFileReadCalls(payload).flatMap(call => call.paths);
  const corrections = error?.pathCorrections;
  return Array.isArray(corrections) && corrections.length > 0 && corrections.every(correction =>
    correction?.operation === 'read' && paths.includes(correction.attemptedPath)
    && typeof correction.issuedPath === 'string' && correction.issuedPath.length > 0
    && correction.issuedPath !== correction.attemptedPath) ? corrections : null;
}

/** Size/range constraints and exact issued-path corrections resume reads, not the whole entry. */
export function recoverableWorkflowReadFailure(payload, error) {
  const details = failureDetails(error);
  if (['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(details.code)
      || /\b(?:ENOENT|EACCES|EPERM)\b|permission denied|access denied|(?:file|path) (?:was )?(?:not found|does not exist)/iu.test(details.message)) return false;
  const named = /^(?:FILE_READ_TOO_LONG|FILE_READ_RANGE_INVALID|INVALID_LINE_RANGE|LINE_RANGE_OUT_OF_BOUNDS|CLI_ISSUED_PATH_MISMATCH)$/u.test(details.code)
    || details.code === 'PHASE_MUTATION_STAGING_PATH_MISMATCH' && Boolean(issuedReadCorrections(payload, error));
  const calls = payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name, args: payload.toolArgs ?? payload.tool_input }];
  const reader = nativeFileReadCalls(payload).length > 0;
  if (error?.permissionDecision === 'deny' && !named) return false;
  // Old source-review prompts may carry only the installed guard's stable size code.
  return (named && (reader || !calls.some(call => call.name ?? call.toolName ?? call.tool_name)))
    || (reader && /(?:File too large to read at once|Output truncated|invalid (?:line )?range|line range .*out of (?:bounds|range))/iu.test(details.message)
      && !/\bdenied\b|\brefused\b|not found|does not exist/iu.test(details.message));
}

const toolNames = (payload = {}) => [payload.toolName, payload.tool_name, ...(Array.isArray(payload.toolCalls) ? payload.toolCalls : [])
  .map((call) => call?.name ?? call?.toolName ?? call?.tool_name)].filter((name) => typeof name === 'string');
// The host's own file-edit tools: apply_patch, edit/str_replace forms, insert/replace/create/write file.
const EDIT_TOOL = /^(?:apply_patch|str_replace\w*|multi_?edit|edit|write|create)$|(?:patch|edit|replace|insert|write|create)_?\w*file|file_?(?:edit|write)/iu;
// An edit that did not land because its expected text did not match the file as it is now.
const EDIT_MISS = /failed to find (?:the )?expected lines|could not (?:find|locate) (?:the )?(?:expected|old|search|original)|no (?:exact )?match(?:es)? (?:found|for)|not found in (?:the )?file|(?:old_?str(?:ing)?|search (?:string|text)|expected (?:text|content|lines))\b[^.]{0,80}\b(?:not found|did not match|does not match|no match)|(?:appears|occurs|found) (?:more than once|multiple times)|not unique|multiple (?:matches|occurrences)|(?:has been|was) (?:modified|changed) since|patch (?:failed|does not apply|could not be applied)|hunk \S* ?failed/iu;
// What a turn cannot repair by itself: a permission, a protected or out-of-scope path, a missing input.
const REAL_BLOCKER = /\bdenied\b|\brefused\b|permission|\bEACCES\b|\bEPERM\b|\bENOENT\b|protected|not admitted|read-only|no such file/iu;
// Refusals whose own text says to correct the tool form in this turn; they do not invalidate the phase.
const TOOL_FORM_CODES = new Set(['PHASE_MUTATION_TOOL_PROTOCOL', 'PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED']);

/**
 * A failure this turn repairs by itself, or null: an edit of its own that missed the file's current lines, or a
 * refused tool form. Never an explicit blocker (Story anu-bin, 2026-11-11: an apply_patch "Failed to find expected
 * lines" in a code review ended the turn as a TOOL_FAILURE blocker). Permissions, missing inputs and a person's
 * steps keep their blocker.
 */
export function ownToolRepair(payload = {}, error = payload.error) {
  const details = failureDetails(error, payload);
  if (TOOL_FORM_CODES.has(details.code)) return `${details.code}: the tool form was refused, nothing else. Correct it as the refusal says and continue this admitted task in this turn; this is not a blocker and does not invalidate the phase.`;
  if (!toolNames(payload).some((name) => EDIT_TOOL.test(name)) || !EDIT_MISS.test(details.message) || REAL_BLOCKER.test(details.message)) return null;
  return `The edit${details.path ? ` of ${details.path}` : ''} did not apply: its expected lines do not match the file as it is now. This is this turn's own repair, not a blocker. Read the current file again, then retry with a changed edit whose lines match it exactly (never the same edit again), and continue the admitted task; nothing was recorded or lost.`;
}

/** Real errors retain their cause and a read-only owner/recovery route; no automatic retry. */
export async function noteTaskCompletionFailure(payload, error = payload.error) {
  const value = await workflowCompletionTurn(payload);
  const operation = value?.taskOperation ?? value?.reviewOperation;
  if (!operation) return {};
  if (recoverableWorkflowReadFailure(payload, error)) {
    const corrections = issuedReadCorrections(payload, error);
    const supplied = Object.fromEntries(['readRanges', 'readRequests'].filter(key => Array.isArray(error?.[key])
      && error[key].length > 0).map(key => [key, error[key]]));
    const suppliedPlan = Object.keys(supplied).length > 0;
    // An installed guard already supplied its plan. Native-host failures need a smaller plan,
    // because replaying the same prescribed range can exceed a different host's lower limit.
    const recovery = suppliedPlan || corrections ? null
      : await nativeReadFailureRecovery(payload).catch(() => null);
    // A known reader at its smallest safe window cannot make progress by being continued again.
    // Older hook prompts without a tool identity still use their already-issued stable read hint.
    if (suppliedPlan || corrections || recovery || nativeFileReadCalls(payload).length === 0) {
      return { additionalContext: 'Recover the file read in this task using the issued exact path and bounded readRanges/readRequests. Use only parameters supported by the native reader. Finish the remaining input ranges, then continue the admitted task; do not reload context or treat input reading as completion. This grants no writes or decisions.'
      + (corrections ? ` Exact read-only path corrections: ${JSON.stringify(corrections)}` : '')
      + (recovery ? ` Smaller native read windows: ${JSON.stringify(recovery)}`
        : ' Follow the existing read/path correction. If this reader cannot safely narrow the content, preserve its exact error and use the task\'s owner/recovery route; never repeat an unchanged failed range.') };
    }
  }
  // The turn's own edit or tool form: repaired now, so the task stays continuable.
  const ownRepair = ownToolRepair(payload, error);
  if (ownRepair) return { additionalContext: ownRepair };
  operation.blocked = true;
  operation.failure = failureDetails(error, payload);
  const candidates = [error?.nextAction, error?.details?.nextAction,
    ...(Array.isArray(error?.next) ? error.next : []), error?.recoveryCommand, error?.details?.recoveryCommand];
  const ownerRoutes = candidates.filter(Boolean).map(action => safeCommandGuidance(action?.commandGuidance ?? action)).filter(Boolean);
  const actions = ownerRoutes.length ? ownerRoutes : [operation.recovery ?? safeCommandGuidance({ argv: ['recover', value.contract.workId,
    '--phase', value.contract.phaseId, '--for-agent', '--json'] })];
  operation.failure.recovery = actions;
  await saveReviewCompletionTurn(payload, value);
  return { additionalContext: `The workflow task has an explicit blocker (${operation.failure.code}): ${operation.failure.message}.${operation.failure.path ? ` Attempted path: ${operation.failure.path}.` : operation.failure.attemptedPaths ? ` Attempted paths: ${JSON.stringify(operation.failure.attemptedPaths)}.` : ''} Preserve the exact attempted path, existing draft and original error. Do not retry unchanged access, recreate a missing input or bypass a human decision. ${ownerRoutes.length ? 'Preserve the original returned owner route:' : 'Read-only inspection is available:'}\n\n${actions.map(action => formatCommandRouteLines(action).join('\n')).join('\n\n')}` };
}

/** Real permission/tool failures remain visible; a recoverable oversized read is not a write refusal. */
export async function noteReviewCompletionFailure(payload, error = payload.error) {
  await noteTaskCompletionFailure(payload, error);
  return {};
}

/** Full tasks stop at their observed terminal checkpoint, or yield to an explicit owner blocker. */
export async function workflowTaskAgentStop(payload = {}) {
  if (!turnFinished(payload)) return {};
  const value = await workflowCompletionTurn(payload);
  if (value?.reviewOperation) return sourceReviewAgentStop(payload);
  const operation = value?.taskOperation;
  if (!operation || operation.continued || operation.blocked || operation.complete
      || operation.kind !== 'phase-authoring' || operation.workId !== value.contract.workId
      || operation.phaseId !== value.contract.phaseId || operation.generation !== Number(value.contract.generation) + 1) return {};
  const answers = ANSWER_STATES.includes(operation.state);
  const next = answers || ['publish-ready', 'prepare-successor', 'load-context', 'validate-draft', 'open-code-generation'].includes(operation.state) ? safeCommandGuidance(operation.nextAction)
    : safeCommandGuidance(operation.recheck);
  if (!next) return {};
  operation.continued = true;
  if (!await saveReviewCompletionTurn(payload, value, { once: true, ...(answers ? { claim: `task-completion-${operation.state}` } : {}) })
    || !answers && !await reserveTaskContinuation(value, operation)) return {};
  return { decision: 'block', reason: `SFLOW_WORKFLOW_TASK_INCOMPLETE: ${operation.workId} ${operation.phaseId} generation ${operation.generation} has no verified completed publication from this task. `
    + 'If an issued command is still running, cut off or not yet observed complete, first run singularity-flow result last --wait --command "<the cut command\'s words>" --for-agent --json and follow that result; never replay the command. Otherwise: '
    + (operation.state === 'record-answers' ? `The person has answered and nothing is recorded yet. Stage their answers as ${CLARIFICATION_RESPONSE_FORMAT}, one entry per question, at the --response-file path and run ${next.command} alone, then run singularity-flow phase enter --compose --for-agent --json once and do this step's own work from what it returns. If they declined or left a question open, say which and stop; never answer for them. `
      : operation.state === 'refresh-entry' ? `The answers are recorded. Run ${next.command} once, then do this step's own work from what it returns. `
      : operation.state === 'load-context' ? `The admitted entry did not compose context. Run ${next.command} once, then use its delivered inputs and complete the current task. `
      : operation.state === 'prepare-successor' ? `Run only the returned successor preparation, ${next.command}; preserve prior publications and private drafts, then refresh phase entry once before authoring. `
      : operation.state === 'publish-ready' ? `Run only the returned publication command, ${next.command}, under its existing fresh checks. `
      : operation.state === 'validate-draft' ? `Preserve the authored draft and run its returned validation, ${next.command}; repair only current-scope findings and publish only when fresh checks permit it. `
      : operation.state === 'open-code-generation' ? `Open only the returned code generation with ${next.command} before any application edit, then follow the admitted authoring contract. `
      : `Reuse the current exact paths, prompt and already read inputs. Finish the configured deliverables and required verification inside the current mutation contract; repair only current-scope findings. Then run ${next.command}. `)
    + 'Input reads, preparation, an authored draft and diagnostic tests are not task completion. Continue this existing task in this turn; never reload unchanged context, restart implementation, change protected files, submit, approve or start a new phase. '
    + 'This is one automatic continuation only. If a real missing-file, permission, tool, human-approval or owner blocker remains, preserve the draft and report the exact error and returned recovery route. Never infer success or make a decision for a person.' };
}

export async function sourceReviewAgentStop(payload = {}) {
  if (!turnFinished(payload)) return {};
  const value = await reviewCompletionTurn(payload);
  const operation = value?.reviewOperation;
  if (!operation || operation.continued || operation.blocked || operation.complete
      || !['author-report', 'repair-report', 'retain-report', 'review-changed-inputs'].includes(operation.state)
      || operation.workId !== value.contract.workId || operation.phaseId !== value.contract.phaseId
      || operation.generation !== value.contract.generation
      || !value.contract.allow.staging.includes(operation.stagingPath)) return {};
  let draft;
  try { draft = await readSourceReviewDraft(operation.stagingPath, value.binding.gitDir); }
  catch { return {}; }
  // An independently changed binding needs a fresh entry, never a transplanted judgment.
  if (draft?.report?.binding && recordSha256(draft.report.binding) !== operation.bindingSha256
      && operation.state !== 'review-changed-inputs') return {};
  const check = safeCommandGuidance({ argv: ['review-source', 'check', operation.phaseId,
    '--report-file', operation.stagingPath, '--for-agent', '--json'] });
  const next = operation.state === 'review-changed-inputs'
    ? `The current context is fresh and the old draft was preserved. Independently review the current pinned inputs and author a replacement from the current reportTemplate at ${operation.stagingPath}; never reuse stale bindings or judgments. Then run ${check.command} and retain when retentionReady.`
    : draft && !draft.error && operation.state !== 'repair-report' ? `Run ${check.command} now, then follow its repair or retention route.`
    : `${draft ? 'Repair the existing JSON' : 'Author the independent report from the issued template and already read pinned inputs'} at ${operation.stagingPath}. Then run ${check.command} and retain when retentionReady.`;
  operation.continued = true;
  if (!await saveReviewCompletionTurn(payload, value, { once: true }) || !await reserveTaskContinuation(value, operation)) return {};
  return { decision: 'block', reason: `SFLOW_SOURCE_REVIEW_INCOMPLETE: ${operation.workId} ${operation.phaseId} generation ${operation.generation} has no completed retained review from this operation. ${next} `
    + 'If an issued command is still running, cut off or not yet observed complete, first run singularity-flow result last --wait --command "<the cut command\'s words>" --for-agent --json and follow that result; never replay the command. '
    + 'Continue the existing operation in this turn; do not reload context or repeat the input reads. Preserve exact bindings and independent judgments. Honest semantic gaps may be retained as correction-required findings. Never approve, decide for a human, publish an artifact or advance the phase. '
    + 'This is one automatic continuation only. If a real tool/authority/input blocker remains, preserve the draft and report its exact error and recovery route.' };
}
