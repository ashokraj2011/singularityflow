/** Bounded REV feedback-attachment intake; this command does not run a revision. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { head, repoRoot } from '../git.mjs';
import { loadSession, validAgentSession } from '../session.mjs';
import { loadConfig, loadStoryAggregate, sourceTreeHash } from '../state-stores.mjs';
import { recordSha256 } from '../records.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { action as nextAction, commandResult, effects, noEffects, noop, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  previewFeedbackAttachments, registerFeedbackAttachments, feedbackAttachmentDefaults,
  feedbackAttachmentFormats
} from '../revision/feedback-attachments.mjs';
import { createFeedbackAttachmentStore } from '../revision/feedback-attachment-store.mjs';
import { inspectRevisionPilotActivation, revisionRuntimeCapabilities } from '../revision/runtime.mjs';
import { producerIdentity } from '../revision/product-context.mjs';
import { createRevisionLoopStore } from '../revision/loop-store.mjs';
import {
  confirmInteractiveAbandon, confirmInteractiveCapture, inspectInteractiveRevision,
  previewInteractiveAbandon, previewInteractiveCapture, renderRevisionCard,
  replayInteractiveAbandonConfirmation,
  resumeInteractiveRevision, showInteractiveInterval
} from '../revision/interactive-service.mjs';
import {
  confirmPublicRevisionBrowserCheckRun, inspectPublicRevisionBrowserCheckResult,
  inspectPublicRevisionBrowserCheckStatus, planPublicRevisionBrowserChecks,
  revisionBrowserCheckCapabilities
} from '../revision/browser-check-service.mjs';

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

async function feedbackContext(root, active, feedbackText) {
  const loop = await attachmentLoop(root, active);
  return {
    repositoryRoot: root,
    workId: active.workflow.workItem.id,
    phaseId: active.phaseId,
    phaseGeneration: active.phaseGeneration,
    loopId: loop?.loopId ?? null,
    loopRevision: loop?.revision ?? null,
    active: true,
    feedbackText,
    ...await revisionBinding(root, active)
  };
}

async function revisionBinding(root, active) {
  return {
    headCommit: head(root),
    sourceTreeSha256: await sourceTreeHash(root, active.config, active.workflow),
    configSha256: `sha256:${recordSha256(active.config)}`,
    workflowSha256: `sha256:${recordSha256(active.workflow)}`
  };
}

async function attachmentLoop(root, active) {
  const store = createRevisionLoopStore({
    root, workId: active.workflow.workItem.id, phaseId: active.phaseId,
    phaseGeneration: active.phaseGeneration, producer: producerIdentity(),
    assertCurrentContext: async () => false,
    verifyRetainedCandidate: async () => false,
    verifyCurrentPrecheck: async () => false
  });
  return store.read();
}

function contextMatches(root) {
  return async (context, planned = null) => {
    try {
      const expected = planned ?? context;
      const latest = await activeStory(root);
      const loop = await attachmentLoop(root, latest);
      const binding = await revisionBinding(root, latest);
      return latest.workflow.workItem.id === expected.workId
        && latest.phaseId === expected.phaseId
        && latest.phaseGeneration === expected.phaseGeneration
        && (loop?.loopId ?? null) === expected.loopId
        && (loop?.revision ?? null) === expected.loopRevision
        && (loop?.status ?? 'not-available')
          === (expected.loopStatus ?? (expected.loopId == null ? 'not-available' : 'open'))
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
  profile: 'guarded-local-revision-evidence',
  revisionLoopAvailable: true,
  registeredAttachmentExecutionAvailable: true,
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

function interactiveSubject(value) {
  return { kind: 'story', id: value.active.subject.workId };
}

function exactPlan(options, generated, action) {
  const supplied = optionString(options, 'plan');
  const confirmation = optionString(options, 'confirm');
  if (!supplied || !confirmation) {
    refuse('REV_CONFIRMATION_REQUIRED',
      `${action} requires --plan <preview-plan-sha256> and --confirm <same-preview-plan-sha256>.`);
  }
  if (supplied !== generated.planSha256) {
    refuse('REV_PLAN_STALE', `${action} plan does not match the exact current preview.`);
  }
  return confirmation;
}

function intervalId(positionals, action) {
  const value = positionals?.[2];
  if (!value) refuse('REV_INTERVAL_REQUIRED', `${action} requires one exact interval ID.`);
  return value;
}

function abandonTargetId(positionals) {
  const value = positionals?.[2];
  if (!value) {
    refuse('REV_INTERVAL_REQUIRED',
      'Abandon requires one exact loop or interval ID. Use the loop ID before the first interval is captured.');
  }
  return value;
}

/**
 * The durable feedback and packet records are intentionally private sidecars.  A read command may
 * expose their integrity metadata, but never the original developer feedback bytes.  Keep the
 * redaction at the public command boundary so recovery and validation continue to use the exact
 * private records internally.
 */
export function publicRevisionRecordChain(chain) {
  const { text: _feedbackText, ...feedback } = chain.feedback ?? {};
  const { text: _packetFeedbackText, ...packetFeedback } = chain.packet?.feedback ?? {};
  const attachments = (chain.packet?.attachments ?? []).map(({ text: _attachmentText, ...item }) =>
    item);
  return Object.freeze({
    packet: chain.packet == null ? null : {
      ...chain.packet,
      feedback: packetFeedback,
      attachments
    },
    feedback,
    criteriaBinding: chain.binding,
    specificationDisposition: chain.disposition,
    hunkClaimSet: chain.claims,
    attempts: chain.attempts,
    restorations: chain.restorations,
    precheckInput: chain.precheckInput
  });
}

async function intervalProjection(root, id, { includeRecordChain = false } = {}) {
  const inspected = await inspectInteractiveRevision(root);
  const shown = await showInteractiveInterval(root, id);
  const projection = {
    ...inspected,
    interval: shown.interval,
    precheck: shown.precheck,
    card: renderRevisionCard({
      status: inspected.status, precheck: shown.precheck, state: inspected.state,
      historical: true, freshness: inspected.freshness?.status ?? 'current'
    }),
    headSnapshot: shown.headSnapshot, loop: shown.loop,
    journal: shown.journal
  };
  if (includeRecordChain) projection.recordChain = publicRevisionRecordChain(shown);
  return projection;
}

async function assertAbandonTarget(root, id) {
  const inspected = await inspectInteractiveRevision(root);
  const known = new Set([
    inspected.state?.loopId,
    inspected.status?.headIntervalId,
    inspected.interval?.intervalId
  ].filter(Boolean));
  if (!known.has(id)) {
    refuse('REV_INTERVAL_UNKNOWN',
      `Revision loop or interval '${id}' is not the active local loop or selected interval.`);
  }
  return inspected;
}

function abandonTargetSlots(inspected, id) {
  return {
    targetId: id,
    targetKind: inspected.state?.loopId === id ? 'loop' : 'interval'
  };
}

async function runInteractive(positionals, options) {
  const action = positionals[1];
  const root = repoRoot();
  if (action === 'status') {
    const inspected = await inspectInteractiveRevision(root);
    return emit(
      { id: 'revision.status', classification: 'read' }, interactiveSubject(inspected),
      succeeded('revision.status-reported', {
        state: inspected.state?.status ?? inspected.status.state,
        intervalSequence: inspected.status.intervalSequence
      }), noEffects(), inspected, options, { restState: 'informational' }
    );
  }
  if (action === 'card') {
    const id = positionals[2];
    const inspected = id
      ? await intervalProjection(root, id)
      : await inspectInteractiveRevision(root);
    return emit(
      { id: 'revision.card', classification: 'read' }, interactiveSubject(inspected),
      succeeded('revision.card-reported', {
        candidateId: inspected.card.candidate?.id ?? inspected.card.candidate?.candidateId ?? 'none',
        publicationEligible: inspected.card.publicationEligible
      }), noEffects(), inspected, options, { restState: 'informational' }
    );
  }
  if (action === 'show') {
    const id = intervalId(positionals, action[0].toUpperCase() + action.slice(1));
    const inspected = await intervalProjection(root, id, { includeRecordChain: true });
    return emit(
      { id: `revision.${action}`, classification: 'read' }, interactiveSubject(inspected),
      succeeded('revision.interval-reported', { intervalId: id, state: inspected.status.state }),
      noEffects(), inspected, options, { restState: 'informational' }
    );
  }
  if (action === 'resume') {
    if (positionals.length > 3) refuse('UNKNOWN_SUBCOMMAND', 'Use: revision resume [INTERVAL-ID].');
    const id = positionals[2] ?? null;
    const result = await resumeInteractiveRevision(root, id);
    const inspected = await inspectInteractiveRevision(root);
    return emit(
      { id: 'revision.resume', classification: 'mutation' }, interactiveSubject(inspected),
      (result.replayed ? noop : succeeded)(result.replayed
        ? 'revision.resume-already-completed' : result.recovered
          ? 'revision.resume-completed' : 'revision.resume-recovery-required', {
        intervalId: id ?? 'opening', state: result.state.status
      }), result.replayed ? noEffects() : effects({ stateChanged: true, filesChanged: false }),
      { ...inspected, result }, options, { restState: 'informational' }
    );
  }
  if (action === 'capture') {
    const preview = optionBoolean(options, 'preview');
    const captureOptions = {
      note: optionString(options, 'note'),
      savedBuffersConfirmed: optionBoolean(options, 'saved-buffers-confirmed')
    };
    const plan = await previewInteractiveCapture(root, captureOptions);
    const before = await inspectInteractiveRevision(root);
    if (preview) {
      if (optionString(options, 'plan') || optionString(options, 'confirm')) {
        refuse('REV_CONFIRMATION_CONFLICT', 'Capture --preview cannot be combined with --plan or --confirm.');
      }
      return emit(
        { id: 'revision.capture.preview', classification: 'read' }, interactiveSubject(before),
        succeeded('revision.capture-previewed', { planSha256: plan.planSha256 }),
        noEffects(), { ...before, plan }, options, { next: [nextAction({
          id: 'revision.capture',
          label: 'Confirm this exact capture plan with the same note and saved-buffer assertion',
          command: `singularity-flow revision capture --note <SAME-NOTE> --saved-buffers-confirmed --plan ${plan.planSha256} --confirm ${plan.planSha256}`,
          skill: 'sf-revise', kind: 'review'
        })], restState: null }
      );
    }
    const result = await confirmInteractiveCapture(root, {
      plan, confirmation: exactPlan(options, plan, 'Capture'), ...captureOptions
    });
    const inspected = await inspectInteractiveRevision(root);
    return emit(
      { id: 'revision.capture', classification: 'mutation' }, interactiveSubject(inspected),
      (result.replayed ? noop : succeeded)(
        result.replayed ? 'revision.capture-already-completed' : 'revision.capture-completed', {
          candidateId: result.state.resultCandidateId,
          publicationEligible: result.card?.publicationEligible ?? inspected.card.publicationEligible
        }),
      result.replayed ? noEffects() : effects({ stateChanged: true, filesChanged: false }),
      { ...inspected, result, plan }, options, { restState: 'informational' }
    );
  }
  if (action === 'abandon') {
    const id = abandonTargetId(positionals);
    if (!optionBoolean(options, 'preview')) {
      const confirmation = optionString(options, 'confirm');
      const replay = await replayInteractiveAbandonConfirmation(root, {
        confirmation, targetId: id
      });
      if (replay) {
        const inspected = await inspectInteractiveRevision(root);
        return emit(
          { id: 'revision.abandon', classification: 'mutation' }, interactiveSubject(inspected),
          noop('revision.abandon-already-completed', {
            ...abandonTargetSlots(inspected, id), loopId: replay.state.loopId
          }), noEffects(),
          { ...inspected, result: replay }, options, { restState: 'informational' }
        );
      }
    }
    const before = await assertAbandonTarget(root, id);
    const plan = await previewInteractiveAbandon(root);
    if (optionBoolean(options, 'preview')) {
      if (optionString(options, 'plan') || optionString(options, 'confirm')) {
        refuse('REV_CONFIRMATION_CONFLICT', 'Abandon --preview cannot be combined with --plan or --confirm.');
      }
      return emit(
        { id: 'revision.abandon.preview', classification: 'read' }, interactiveSubject(before),
        succeeded('revision.abandon-previewed', {
          ...abandonTargetSlots(before, id), planSha256: plan.planSha256
        }),
        noEffects(), { ...before, plan }, options, { next: [nextAction({
          id: 'revision.abandon',
          label: 'Confirm this exact abandonment plan',
          command: `singularity-flow revision abandon ${id} --plan ${plan.planSha256} --confirm ${plan.planSha256}`,
          skill: 'sf-revise', kind: 'review'
        })], restState: null }
      );
    }
    const result = await confirmInteractiveAbandon(root, {
      plan, confirmation: exactPlan(options, plan, 'Abandon')
    });
    const inspected = await inspectInteractiveRevision(root);
    return emit(
      { id: 'revision.abandon', classification: 'mutation' }, interactiveSubject(inspected),
      succeeded('revision.abandoned', {
        ...abandonTargetSlots(before, id), loopId: result.state.loopId
      }),
      effects({ stateChanged: true, filesChanged: false }),
      { ...inspected, result, plan }, options, { restState: 'informational' }
    );
  }
  return null;
}

function assertBrowserCheckOptions(action, options, permitted = []) {
  const allowed = new Set(['json', ...permitted]);
  const unknown = Object.keys(options ?? {}).filter((name) => !allowed.has(name));
  if (unknown.length) {
    refuse('REV_BROWSER_CHECK_OPTION_INVALID',
      `revision checks ${action} does not accept --${unknown[0]}. Commands, Candidates, URLs, adapters, and environments are resolved only from approved current state.`);
  }
}

async function runBrowserChecks(positionals, options = {}) {
  const action = positionals[2];
  if (action === 'capabilities') {
    assertBrowserCheckOptions(action, options);
    if (positionals.length !== 3) {
      refuse('UNKNOWN_SUBCOMMAND', 'Use: singularity-flow revision checks capabilities --json.');
    }
    return emit(
      { id: 'revision.checks.capabilities', classification: 'read' }, null,
      succeeded('revision.checks-capabilities-reported', {
        profile: revisionBrowserCheckCapabilities.activationProfile,
        executor: revisionBrowserCheckCapabilities.unavailable.executor
      }), noEffects(), revisionBrowserCheckCapabilities, options, { restState: 'informational' }
    );
  }
  const root = repoRoot();
  if (action === 'plan') {
    assertBrowserCheckOptions(action, options);
    if (positionals.length !== 3) {
      refuse('UNKNOWN_SUBCOMMAND', 'Use: singularity-flow revision checks plan --json.');
    }
    const plan = await planPublicRevisionBrowserChecks(root);
    return emit(
      { id: 'revision.checks.plan', classification: 'read' },
      { kind: 'story', id: plan.subject.workId },
      succeeded('revision.checks-plan-reported', {
        status: plan.status, planSha256: plan.planSha256, reasonCode: plan.reasonCode
      }), noEffects(), plan, options, { restState: 'informational' }
    );
  }
  if (action === 'status') {
    assertBrowserCheckOptions(action, options);
    if (positionals.length > 4) {
      refuse('UNKNOWN_SUBCOMMAND', 'Use: singularity-flow revision checks status [RUN-ID] --json.');
    }
    const status = await inspectPublicRevisionBrowserCheckStatus(root, positionals[3] ?? null);
    return emit(
      { id: 'revision.checks.status', classification: 'read' },
      { kind: 'story', id: status.subject.workId },
      succeeded('revision.checks-status-reported', {
        state: status.state, runId: status.runId ?? 'none', reasonCode: status.reasonCode
      }), noEffects(), status, options, { restState: 'informational' }
    );
  }
  if (action === 'result') {
    assertBrowserCheckOptions(action, options);
    if (positionals.length !== 4) {
      refuse('REV_BROWSER_RUN_ID_REQUIRED',
        'Use: singularity-flow revision checks result <RUN-ID> --json.');
    }
    const result = await inspectPublicRevisionBrowserCheckResult(root, positionals[3]);
    return emit(
      { id: 'revision.checks.result', classification: 'read' },
      { kind: 'story', id: result.subject.workId },
      succeeded('revision.checks-result-reported', {
        status: result.status, runId: result.runId, reasonCode: result.reasonCode
      }), noEffects(), result, options, { restState: 'informational' }
    );
  }
  if (action === 'run') {
    assertBrowserCheckOptions(action, options, ['plan', 'confirm']);
    if (positionals.length !== 3) {
      refuse('UNKNOWN_SUBCOMMAND',
        'Use: singularity-flow revision checks run --plan <SHA256> --confirm <SHA256> --json.');
    }
    await confirmPublicRevisionBrowserCheckRun(root, {
      plan: optionString(options, 'plan'), confirmation: optionString(options, 'confirm')
    });
    refuse('REV_CODE_CHECK_EXECUTOR_UNAVAILABLE',
      'No approved browser-check runner completed; no run or authority was created.');
  }
  refuse('UNKNOWN_SUBCOMMAND',
    'Use: singularity-flow revision checks capabilities|plan|status|result|run. Cancel, retry, and recovery are not public in this slice.');
}

export async function run(_argv, { positionals, options } = {}) {
  if (positionals?.[1] === 'activation') {
    const report = await inspectRevisionPilotActivation({ repositoryRoot: repoRoot() });
    return emit(
      { id: 'revision.activation', classification: 'read' }, null,
      succeeded('revision.activation-reported', {
        activationProfile: report.activationProfile,
        blockerCount: report.blockers.length
      }), noEffects(), report, options, { restState: null }
    );
  }
  if (positionals?.[1] === 'capabilities') {
    return emit(
      { id: 'revision.capabilities', classification: 'read' }, null,
      succeeded('revision.capabilities-reported', {
        activationProfile: revisionRuntimeCapabilities.activationProfile
      }), noEffects(), revisionRuntimeCapabilities, options,
      { restState: null }
    );
  }
  if (['status', 'card', 'show', 'resume', 'capture', 'abandon'].includes(positionals?.[1])) {
    return runInteractive(positionals, options ?? {});
  }
  if (positionals?.[1] === 'checks') {
    return runBrowserChecks(positionals, options ?? {});
  }
  if (positionals?.[1] !== 'attachments') {
    refuse('UNKNOWN_SUBCOMMAND', 'Use: singularity-flow revision activation|capabilities|status|card|show|resume|capture|abandon, revision checks capabilities|plan|status|result|run, or revision attachments capabilities|preview|register|list|status|remove-preview|remove.');
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
