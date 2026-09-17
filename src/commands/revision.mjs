/** Bounded REV feedback-attachment intake; this command does not run a revision. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { head, repoRoot } from '../git.mjs';
import { loadSession, validAgentSession } from '../session.mjs';
import { loadConfig, loadStoryAggregate } from '../state-stores.mjs';
import { sourceTreeHash } from '../state.mjs';
import { recordSha256 } from '../records.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { action as nextAction, commandResult, effects, noEffects, noop, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  previewFeedbackAttachments, registerFeedbackAttachments, feedbackAttachmentDefaults,
  feedbackAttachmentFormats
} from '../revision/feedback-attachments.mjs';
import { createFeedbackAttachmentStore } from '../revision/feedback-attachment-store.mjs';
import { revisionRuntimeCapabilities } from '../revision/runtime.mjs';

function refuse(code, message) { throw new SingularityFlowError(message, { code }); }

function emit(operation, subject, outcome, declaredEffects, data, options, {
  next = [], restState = 'informational'
} = {}) {
  return emitCommandResult(commandResult({
    operation, subject, outcome, effects: declaredEffects, next, restState, data
  }), { json: optionBoolean(options, 'json') });
}

async function activeStory(root) {
  const session = await loadSession(root);
  const config = await loadConfig(root);
  // Omit the ID deliberately: the Story loader then verifies that the selected Story belongs
  // to this checkout's registered branch. Loading by session.workId would skip that check.
  const workflow = await loadStoryAggregate(root, config);
  const phaseId = workflow.currentPhase;
  const phase = workflow.phases?.[phaseId];
  if (workflow.status !== 'in_progress' || !phase || !['in_progress', 'rework'].includes(phase.status)) {
    refuse('REV_ATTACHMENT_CONTEXT', 'Feedback attachment intake requires an active Story phase. No revision or document upload was started.');
  }
  if (!validAgentSession(config, session, workflow.workItem.id, null, phaseId)) {
    refuse('REV_ATTACHMENT_CONTEXT', `Local session does not match ${workflow.workItem.id}/${phaseId}; resume that Story phase before attaching feedback.`);
  }
  return { config, workflow, session, phaseId, phaseGeneration: phase.generation };
}

async function revisionBinding(root, active) {
  return {
    headCommit: head(root),
    sourceTreeSha256: await sourceTreeHash(root, active.config, active.workflow),
    configSha256: `sha256:${recordSha256(active.config)}`,
    workflowSha256: `sha256:${recordSha256(active.workflow)}`
  };
}

async function feedbackContext(root, active, feedbackText) {
  return {
    repositoryRoot: root,
    workId: active.workflow.workItem.id,
    phaseId: active.phaseId,
    phaseGeneration: active.phaseGeneration,
    loopId: null,
    loopRevision: null,
    active: true,
    feedbackText,
    ...await revisionBinding(root, active)
  };
}

function contextMatches(root) {
  return async (expected) => {
    try {
      const latest = await activeStory(root);
      const binding = await revisionBinding(root, latest);
      return latest.workflow.workItem.id === expected.workId
        && latest.phaseId === expected.phaseId
        && latest.phaseGeneration === expected.phaseGeneration
        && binding.headCommit === expected.headCommit
        && binding.sourceTreeSha256 === expected.sourceTreeSha256
        && binding.configSha256 === expected.configSha256
        && binding.workflowSha256 === expected.workflowSha256;
    } catch { return false; }
  };
}

function optionValues(options, key) {
  const value = options?.[key];
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function localSources(options) {
  const supplied = optionValues(options, 'file');
  if (!supplied.length || supplied.length > feedbackAttachmentDefaults.maximumFilesPerFeedback
    || supplied.some((value) => typeof value !== 'string' || !value.trim())) {
    refuse('REV_ATTACHMENT_SOURCE', `Provide 1–${feedbackAttachmentDefaults.maximumFilesPerFeedback} explicit --file <local-file> operands. Chat-visible attachments without verifiable bytes cannot be registered.`);
  }
  return supplied.map((value) => ({ source: 'local-file', path: path.resolve(value) }));
}

function selectedFiles(options, sourceCount) {
  const requested = optionValues(options, 'select');
  const rangeOptions = optionValues(options, 'line-range');
  if (rangeOptions.length && !requested.length) {
    refuse('REV_ATTACHMENT_SELECTION', 'Use one-based --select <file-number> with each --line-range <file-number>:<start>-<end>.');
  }
  const indexes = requested.length ? requested.map((value) => {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
      refuse('REV_ATTACHMENT_SELECTION', 'Selected file numbers must be one-based positive integers.');
    }
    const index = Number(value) - 1;
    if (!Number.isSafeInteger(index) || index >= sourceCount) {
      refuse('REV_ATTACHMENT_SELECTION', 'Selected file number is outside the explicit --file list.');
    }
    return index;
  }) : Array.from({ length: sourceCount }, (_, index) => index);
  if (new Set(indexes).size !== indexes.length) {
    refuse('REV_ATTACHMENT_SELECTION', 'A file may be selected only once.');
  }
  const ranges = new Map();
  for (const value of rangeOptions) {
    const match = typeof value === 'string' && /^([1-9][0-9]*):([1-9][0-9]*)-([1-9][0-9]*)$/.exec(value);
    if (!match) refuse('REV_ATTACHMENT_SELECTION', 'Line range must be <one-based-file-number>:<start-line>-<end-line>.');
    const index = Number(match[1]) - 1;
    const startLine = Number(match[2]);
    const endLine = Number(match[3]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || !indexes.includes(index) || endLine < startLine) {
      refuse('REV_ATTACHMENT_SELECTION', 'Line range must name a selected file and ascending one-based lines.');
    }
    ranges.set(index, [...(ranges.get(index) ?? []), { startLine, endLine }]);
  }
  return indexes.sort((a, b) => a - b).map((index) => ranges.has(index)
    ? { index, lineRanges: ranges.get(index).sort((a, b) => a.startLine - b.startLine) }
    : index);
}

async function feedback(options) {
  if (optionBoolean(options, 'feedback-stdin')) {
    if (Object.hasOwn(options, 'feedback')) {
      refuse('REV_ATTACHMENT_FEEDBACK_CONFLICT', 'Use either --feedback-stdin or --feedback, not both.');
    }
    if (process.stdin.isTTY) {
      refuse('REV_ATTACHMENT_FEEDBACK', 'Pipe feedback into --feedback-stdin; interactive stdin is not accepted.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) {
        refuse('REV_FEEDBACK_TOO_LARGE', 'Feedback from stdin exceeds the 8192-byte limit.');
      }
      chunks.push(bytes);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { refuse('REV_ATTACHMENT_FEEDBACK', 'Feedback from stdin must be valid UTF-8.'); }
    if (!text.trim()) refuse('REV_ATTACHMENT_FEEDBACK', 'Feedback from stdin is empty.');
    return text;
  }
  const text = optionString(options, 'feedback');
  if (!text?.trim()) refuse('REV_ATTACHMENT_FEEDBACK', 'Provide --feedback-stdin or --feedback "<text>" to bind the exact attachment to feedback.');
  return text;
}

function explicitRead(sources, expectedContext) {
  const allowedPaths = new Set(sources.map((source) => source.path));
  // Canonicalize the parent because macOS may resolve /var to /private/var; do not resolve the
  // basename. A symlinked file must not silently redirect a reviewed file name to other bytes.
  return async ({ context, requestedPath, resolvedPath }) => {
    if (context !== expectedContext || !allowedPaths.has(path.resolve(requestedPath))) return false;
    try {
      const parent = await realpath(path.dirname(requestedPath));
      return path.join(parent, path.basename(requestedPath)) === path.resolve(resolvedPath);
    } catch { return false; }
  };
}

function storeFor(root, active) {
  return createFeedbackAttachmentStore(root, {
    workId: active.workflow.workItem.id,
    phaseId: active.phaseId,
    phaseGeneration: active.phaseGeneration,
    assertCurrentContext: contextMatches(root)
  });
}

const CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  kind: 'revision-feedback-attachment-capabilities',
  profile: 'staged-local-evidence-only',
  revisionLoopAvailable: false,
  registeredAttachmentExecutionAvailable: false,
  execution: revisionRuntimeCapabilities,
  localFile: { available: true, formats: feedbackAttachmentFormats },
  selection: { multipleFiles: true, lineRanges: true },
  revocation: { available: true, appendOnly: true, privateLocal: true },
  localVsCodeFileUriBridge: {
    available: true, maximumFiles: feedbackAttachmentDefaults.maximumFilesPerFeedback,
    selection: 'all-whole-files', requiresSeparateConfirmation: true
  },
  copilotHostAttachment: {
    verifiableBytesAvailable: false,
    code: 'REV_CHAT_ATTACHMENT_UNAVAILABLE',
    reason: 'Opaque Copilot uploads do not expose original bytes to SFlow. A genuine local VS Code file URI can be read and verified through the local-file bridge.'
  },
  selectedTextRenditionBytesMaximum: feedbackAttachmentDefaults.maximumSelectedRenditionBytes,
  originalBytesPerFileMaximum: feedbackAttachmentDefaults.maximumOriginalBytesPerFile,
  fallback: 'singularity-flow revision attachments preview --file <LOCAL_FILE> --feedback-stdin'
});

export async function run(_argv, { positionals, options } = {}) {
  if (positionals?.[1] !== 'attachments') {
    refuse('UNKNOWN_SUBCOMMAND', 'Use: singularity-flow revision attachments capabilities|preview|register|list|status|remove-preview|remove.');
  }
  const action = positionals[2];
  if (action === 'capabilities') {
    return emit(
      { id: 'revision.attachments.capabilities', classification: 'read' }, null,
      succeeded('revision.attachments-capabilities-reported', {}), noEffects(), CAPABILITIES, options,
      { next: [nextAction({
        id: 'revision.attachments.preview', label: 'Preview a local feedback document',
        command: 'singularity-flow revision attachments preview --file <PATH> --feedback-stdin',
        skill: 'sf-revision-attachments', kind: 'review'
      })], restState: null }
    );
  }
  if (!['preview', 'register', 'list', 'status', 'remove-preview', 'remove'].includes(action)) {
    refuse('UNKNOWN_SUBCOMMAND', `Unknown revision attachment action '${action ?? ''}'. Use capabilities, preview, register, list, status, remove-preview, or remove.`);
  }
  const root = repoRoot();
  const active = await activeStory(root);
  const store = storeFor(root, active);
  const subject = { kind: 'story', id: active.workflow.workItem.id };
  if (action === 'list') {
    const receipts = await store.list();
    return emit(
      { id: 'revision.attachments.list', classification: 'read' }, subject,
      succeeded('revision.attachments-listed', { count: receipts.length, phaseId: active.phaseId }),
      noEffects(), { receipts }, options
    );
  }
  if (action === 'status') {
    const sets = await store.listStatus();
    return emit(
      { id: 'revision.attachments.status', classification: 'read' }, subject,
      succeeded('revision.attachments-status-reported', { count: sets.length, phaseId: active.phaseId }),
      noEffects(), { sets }, options
    );
  }
  if (action === 'remove-preview') {
    const attachmentSetSha256 = optionString(options, 'attachment-set');
    if (!attachmentSetSha256) refuse('REV_ATTACHMENT_SET_UNKNOWN', 'Provide --attachment-set <registered-set-sha256>.');
    const receipt = await store.read(attachmentSetSha256);
    if (!receipt) refuse('REV_ATTACHMENT_SET_UNKNOWN', 'Attachment set is not registered in this Story phase.');
    const plan = await store.planRevocation({ attachmentSetSha256, expectedContext: receipt });
    return emit(
      { id: 'revision.attachments.remove-preview', classification: 'mutation' }, subject,
      succeeded('revision.attachments-removal-preview-staged', { planId: plan.planSha256 }),
      effects({ stateChanged: true, filesChanged: true }),
      { plan, registeredEvidencePreserved: true }, options,
      { next: [nextAction({
        id: 'revision.attachments.remove', label: 'Confirm exclusion of this exact attachment set',
        command: `singularity-flow revision attachments remove --confirm ${plan.planSha256}`,
        skill: 'sf-revision-attachments', kind: 'review'
      })], restState: null }
    );
  }
  if (action === 'remove') {
    const confirm = optionString(options, 'confirm');
    if (!confirm) refuse('REV_ATTACHMENT_CONFIRMATION', 'Remove requires --confirm <exact removal preview plan ID>.');
    const plan = await store.readRevocationPlan(confirm);
    if (!plan) refuse('REV_ATTACHMENT_PLAN_STALE', 'The exact removal preview plan was not found; preview removal again.');
    const idempotencyKey = optionString(options, 'idempotency-key') ?? confirm;
    const prior = await store.readRevocation(plan.attachmentSetSha256);
    const revocation = await store.revoke({
      planSha256: confirm, confirm, idempotencyKey, expectedContext: plan
    });
    const replayed = prior?.revocationSha256 === revocation.revocationSha256;
    return emit(
      { id: 'revision.attachments.remove', classification: 'mutation' }, subject,
      (replayed ? noop : succeeded)(replayed ? 'revision.attachments-already-removed' : 'revision.attachments-removed', {
        attachmentSetSha256: revocation.attachmentSetSha256
      }), replayed ? noEffects() : effects({ stateChanged: true, filesChanged: true }),
      { revocation, registeredEvidencePreserved: true }, options
    );
  }
  const sources = localSources(options);
  const selection = selectedFiles(options, sources.length);
  const feedbackText = await feedback(options);
  const context = await feedbackContext(root, active, feedbackText);
  const authorizeRead = explicitRead(sources, context);
  if (action === 'preview') {
    const proposed = await previewFeedbackAttachments({ context, sources, selection, authorizeRead });
    await store.savePlan(proposed.plan);
    const planId = proposed.plan.planSha256;
    return emit(
      { id: 'revision.attachments.preview', classification: 'mutation' }, subject,
      succeeded('revision.attachments-preview-staged', {
        name: proposed.preview.attachments[0].displayName, planId
      }), effects({ stateChanged: true, filesChanged: true }),
      { planId, ...proposed, stagedPrivatePlan: true }, options,
      { next: [nextAction({
        id: 'revision.attachments.register', label: 'Confirm this exact feedback attachment plan',
        command: `singularity-flow revision attachments register --file <PATH> --feedback-stdin --confirm ${planId}`,
        skill: 'sf-revision-attachments', kind: 'review'
      })], restState: null }
    );
  }
  const confirm = optionString(options, 'confirm');
  if (!confirm) refuse('REV_ATTACHMENT_CONFIRMATION', 'Register requires --confirm <exact preview plan ID>.');
  const plan = await store.readPlan(confirm);
  if (!plan) refuse('REV_ATTACHMENT_PLAN_STALE', 'The exact preview plan was not found for this Story phase; preview the attachment again.');
  const idempotencyKey = optionString(options, 'idempotency-key') ?? confirm;
  const prior = await store.findByIdempotencyKey(idempotencyKey);
  const receipt = await registerFeedbackAttachments({
    plan, context, sources, selection, confirm, idempotencyKey,
    authorizeRead, assertCurrentContext: contextMatches(root), store
  });
  const replayed = prior?.receipt?.attachmentSetSha256 === receipt.attachmentSetSha256;
  return emit(
    { id: 'revision.attachments.register', classification: 'mutation' }, subject,
    (replayed ? noop : succeeded)(replayed ? 'revision.attachments-already-registered' : 'revision.attachments-registered', {
      attachmentSetSha256: receipt.attachmentSetSha256, count: receipt.attachments.length
    }), replayed ? noEffects() : effects({ stateChanged: true, filesChanged: true }), receipt, options
  );
}
