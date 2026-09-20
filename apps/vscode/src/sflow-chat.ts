/** Explicit, model-free `@sflow` Copilot participant. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';

import { resolveHelp } from '../../../src/help-service.mjs';
import { recordHelpMetric } from './support-runtime-client.ts';
import { PACKAGE_ROOT } from '../../../src/package-root.mjs';
import { planDeveloperConversation } from '../../../src/gateway/conversation.mjs';
import { activeRepositoryContext, gatewaySession, type GatewayRepositoryContext } from './gateway-runtime-client.ts';
import { commandGuidance } from './copilot-command.ts';
import { commandClass, resolveCli, SingularityFlowClient } from './cli/client.ts';
import { CliError } from './cli/runner.ts';
import {
  PARTICIPANT_COMMANDS, PARTICIPANT_COMMAND_BY_ID, matchParticipantCommand,
  participantRuntimeArgv, type ParticipantCommandDefinition
} from './participant-command-table.ts';
import {
  ChatAttachmentConfirmations, ChatAttachmentRemovals, chatAttachmentAction,
  chatAttachmentStatusSets, chatFilePreviewInput, matchesChatAttachmentReceipt,
  matchesChatRemovalPlan, matchesChatRemovalReceipt,
  type PendingChatAttachment, type PendingChatAttachmentRemoval
} from './chat-file-references.ts';
import { buildResultCard } from './views/result-card-model.ts';

const PARTICIPANT_ID = 'singularity-flow.sflow';

type CurrentWork = { id: string; kind?: string | null } | null;
type Followup = { prompt: string; label: string; command?: string };
type SflowChatMetadata = {
  intent: string;
  topicId: string | null;
  followups: Followup[];
};

type AttachmentPreviewEnvelope = {
  data?: {
    planId?: string;
    preview?: {
      workId?: string;
      phaseId?: string;
      phaseGeneration?: number;
      loopStatus?: string;
      attachments?: Array<{
        displayName?: string;
        mediaType?: string;
        bytes?: number;
        originalSha256?: string;
        selected?: boolean;
        extractionStatus?: string;
        modelReadable?: boolean;
      }>;
    };
  };
};

type AttachmentRegistrationEnvelope = {
  data?: {
    kind?: string;
    workId?: string;
    phaseId?: string;
    phaseGeneration?: number;
    importPlanSha256?: string;
    attachmentSetSha256?: string;
    attachments?: Array<{
      originalSha256?: string;
      displayName?: string;
      mediaType?: string;
      bytes?: number;
    }>;
  };
};

function safeMarkdown(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}

function sameRealRepository(first: string, second: string): boolean {
  const normalize = (value: string) => {
    const canonical = path.normalize(value);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  return normalize(first) === normalize(second);
}

async function activeAttachmentSession(
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork,
  signal?: AbortSignal
): Promise<{ client: SingularityFlowClient; editorRoot: string; workId: string; phaseId: string }> {
  const active = activeRepositoryContext();
  const selectedWork = getCurrentWork();
  if (!active?.root || !selectedWork?.id) throw new Error('No selected Story worktree.');
  const settings = vscode.workspace.getConfiguration('singularityFlow');
  const client = new SingularityFlowClient({
    location: resolveCli({
      configuredCli: settings.get<string>('cliPath'),
      configuredNode: settings.get<string>('nodePath'),
      extensionPath: context.extensionPath
    }),
    repository: active.root
  });
  const session = await client.run<{
    ready?: boolean; repositoryPath?: string; workId?: string; phase?: string; status?: string;
  }>(['session', 'current', '--json'], signal);
  const [editorRoot, sessionRoot] = await Promise.all([
    realpath(active.root), session.repositoryPath ? realpath(session.repositoryPath) : Promise.resolve(null)
  ]);
  if (!session.ready || !sessionRoot || !sameRealRepository(editorRoot, sessionRoot)
      || session.workId !== selectedWork.id || !session.phase || session.status !== 'in_progress') {
    throw new Error('The selected repository and ready Story session do not match.');
  }
  return { client, editorRoot, workId: session.workId, phaseId: session.phase };
}

async function statusChatAttachments(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork
): Promise<void> {
  try {
    const active = await activeAttachmentSession(context, getCurrentWork);
    if (token.isCancellationRequested) return;
    const envelope = await active.client.run<{
      subject?: { kind?: string; id?: string };
      outcome?: { slots?: { phaseId?: string } };
      data?: { sets?: unknown }
    }>([
      'revision', 'attachments', 'status', '--json'
    ]);
    if (token.isCancellationRequested) return;
    const sets = chatAttachmentStatusSets(envelope.data?.sets);
    if (!sets || envelope.subject?.kind !== 'story' || envelope.subject.id !== active.workId
        || envelope.outcome?.slots?.phaseId !== active.phaseId) {
      throw new Error('Attachment status response is not bound to the selected Story phase.');
    }
    stream.markdown(`### Feedback attachment sets · ${safeMarkdown(active.workId)} / ${safeMarkdown(active.phaseId)}\n\n`);
    if (!sets.length) {
      stream.markdown('No registered feedback attachment sets in this Story phase.\n');
      return;
    }
    for (const set of sets) stream.markdown(`- ${set.status}: \`${set.attachmentSetSha256}\`\n`);
    stream.markdown('\nRevoked sets are excluded from future routing; their original evidence remains in the private append-only store. To stage an exclusion, use `@sflow /attachments remove sha256:<exact set digest>`.\n');
  } catch {
    stream.markdown('Attachment status could not be verified for the selected Story worktree. Check `/sf-session` and retry. No attachment set was changed.\n');
  }
}

async function previewChatAttachmentRemoval(
  attachmentSetSha256: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork,
  removals: ChatAttachmentRemovals
): Promise<void> {
  try {
    const active = await activeAttachmentSession(context, getCurrentWork);
    if (token.isCancellationRequested) return;
    const envelope = await active.client.run<{
      data?: { plan?: unknown; registeredEvidencePreserved?: unknown }
    }>([
      'revision', 'attachments', 'remove-preview', '--attachment-set', attachmentSetSha256, '--json'
    ]);
    if (token.isCancellationRequested) return;
    const plan = envelope.data?.plan;
    if (envelope.data?.registeredEvidencePreserved !== true
        || !matchesChatRemovalPlan(plan, {
          workId: active.workId, phaseId: active.phaseId, attachmentSetSha256
        })) {
      throw new Error('The exact removal plan could not be verified.');
    }
    const pending: PendingChatAttachmentRemoval = {
      repositoryRoot: active.editorRoot,
      workId: active.workId,
      phaseId: active.phaseId,
      phaseGeneration: plan.phaseGeneration,
      attachmentSetSha256,
      planSha256: plan.planSha256
    };
    const handle = removals.issue(pending);
    stream.markdown('### Staged attachment-set exclusion\n\n');
    stream.markdown(`- Exact set: \`${attachmentSetSha256}\`\n`);
    stream.markdown(`- Story/phase: ${safeMarkdown(active.workId)} / ${safeMarkdown(active.phaseId)} generation ${plan.phaseGeneration}\n`);
    stream.markdown(`- Exact removal plan: \`${plan.planSha256}\`\n\n`);
    stream.markdown('Nothing was revoked yet. Confirming will exclude this set from future revision routing, but will not delete its registered original evidence. The button opens a separate modal confirmation.\n');
    stream.button({
      command: 'singularityFlow.removeFeedbackAttachmentFromChat',
      title: 'Review exclusion of this exact attachment set',
      arguments: [handle]
    });
  } catch {
    stream.markdown('The exact attachment set could not be staged for exclusion. Check `@sflow /attachments status`, the selected Story, and the set digest. No attachment set was revoked.\n');
  }
}

async function removeChatAttachment(
  pending: PendingChatAttachmentRemoval,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork
): Promise<void> {
  const action = 'Exclude this attachment set';
  const decision = await vscode.window.showWarningMessage(
    `Exclude exact feedback attachment set ${pending.attachmentSetSha256} from future revision routing?`,
    {
      modal: true,
      detail: `Story/phase: ${pending.workId}/${pending.phaseId} generation ${pending.phaseGeneration}\n`
        + `Exact removal plan: ${pending.planSha256}\n`
        + 'This appends a revocation. It does not delete registered original evidence, undo a past use, or start a revision.'
    },
    action
  );
  if (decision !== action) return;
  let removalAttempted = false;
  try {
    const active = await activeAttachmentSession(context, getCurrentWork);
    if (!sameRealRepository(active.editorRoot, pending.repositoryRoot)
        || active.workId !== pending.workId || active.phaseId !== pending.phaseId) {
      await vscode.window.showWarningMessage('The selected Story worktree or phase changed. Stage removal again; no attachment set was revoked.');
      return;
    }
    removalAttempted = true;
    const envelope = await active.client.run<{
      data?: { revocation?: unknown; registeredEvidencePreserved?: unknown }
    }>(['revision', 'attachments', 'remove', '--confirm', pending.planSha256, '--json']);
    if (envelope.data?.registeredEvidencePreserved !== true
        || !matchesChatRemovalReceipt(envelope.data?.revocation, pending)) {
      throw new Error('The exact revocation could not be verified.');
    }
    await vscode.window.showInformationMessage(
      `Feedback attachment set ${pending.attachmentSetSha256} is excluded from future routing. Registered original evidence was preserved.`
    );
  } catch {
    await vscode.window.showWarningMessage(
      removalAttempted
        ? 'The exact exclusion outcome could not be verified. Check `@sflow /attachments status` before retrying.'
        : 'The selected Story could not be verified. Stage removal again; no attachment set was revoked.'
    );
  }
}

async function previewChatAttachment(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork,
  confirmations: ChatAttachmentConfirmations
): Promise<void> {
  const input = chatFilePreviewInput(
    request.prompt, request.references, (value) => value instanceof vscode.Uri
  );
  if (input.kind === 'unavailable') {
    stream.markdown(`**${input.code}:** ${input.reason}\n\nAttach one to five local file references or use \`/sf-revision-attachments\` with explicit local paths. No document was registered.\n`);
    return;
  }
  const active = activeRepositoryContext();
  const selectedWork = getCurrentWork();
  if (!active?.root || !selectedWork?.id) {
    stream.markdown('Select and attach the active Story worktree before previewing feedback. Use `/sf-session`, then retry with the local file reference. No document was registered.\n');
    return;
  }
  try {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    const client = new SingularityFlowClient({
      location: resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      }),
      repository: active.root
    });
    // `session current` may resolve a workspace-selected worktree different from the editor's
    // selected repository. Never let the host silently ingest a file for that other checkout.
    const session = await client.run<{
      ready?: boolean; repositoryPath?: string; workId?: string; phase?: string; status?: string;
    }>(['session', 'current', '--json']);
    if (token.isCancellationRequested) return;
    const [editorRoot, sessionRoot] = await Promise.all([
      realpath(active.root), session.repositoryPath ? realpath(session.repositoryPath) : Promise.resolve(null)
    ]);
    if (!session.ready || !sessionRoot || !sameRealRepository(editorRoot, sessionRoot)
        || typeof session.workId !== 'string' || session.workId !== selectedWork.id
        || !session.phase || session.status !== 'in_progress') {
      stream.markdown('The selected editor repository does not match the ready Story session/worktree. Use `/sf-session` to attach the intended Story, refresh the editor, and retry. No document was registered.\n');
      return;
    }
    stream.progress('Validating all selected original local file bytes in the Story worktree…');
    const sourceArgs = input.paths.flatMap((file, index) => [
      '--file', file, '--select', String(index + 1)
    ]);
    const envelope = await client.runWithInput<AttachmentPreviewEnvelope>([
      'revision', 'attachments', 'preview', ...sourceArgs,
      '--feedback-stdin', '--json'
    ], input.feedback);
    if (token.isCancellationRequested) return;
    const preview = envelope.data?.preview;
    const attachments = preview?.attachments;
    const planId = envelope.data?.planId;
    const phaseGeneration = preview?.phaseGeneration;
    if (!preview || !attachments || attachments.length !== input.paths.length
        || preview.workId !== session.workId || preview.phaseId !== session.phase
        || typeof phaseGeneration !== 'number' || !Number.isSafeInteger(phaseGeneration)
        || phaseGeneration < 0
        || attachments.some((attachment) => attachment.selected !== true
          || typeof attachment.bytes !== 'number' || !Number.isSafeInteger(attachment.bytes)
          || attachment.bytes < 1 || attachment.extractionStatus !== 'complete'
          || attachment.modelReadable !== true || typeof attachment.displayName !== 'string'
          || typeof attachment.mediaType !== 'string'
          || !/^sha256:[a-f0-9]{64}$/.test(attachment.originalSha256 ?? ''))
        || typeof planId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(planId)) {
      throw new Error('The attachment preview did not return a complete, bound receipt.');
    }
    stream.markdown(`### Staged feedback attachment preview · all ${attachments.length} files selected whole\n\n`);
    attachments.forEach((attachment, index) => {
      stream.markdown(`- ${index + 1}. ${safeMarkdown(attachment.displayName!)} · ${safeMarkdown(attachment.mediaType!)} · ${attachment.bytes} original bytes · \`${attachment.originalSha256}\`\n`);
    });
    stream.markdown(`- Story/phase: ${safeMarkdown(preview.workId ?? '')} / ${safeMarkdown(preview.phaseId ?? '')} generation ${preview.phaseGeneration ?? 'unknown'}\n`);
    stream.markdown(`- Exact preview plan: \`${planId}\`\n\n`);
    const handle = confirmations.issue({
      repositoryRoot: editorRoot,
      workId: session.workId,
      phaseId: session.phase,
      phaseGeneration,
      localPaths: input.paths,
      feedback: input.feedback,
      planSha256: planId,
      attachments: attachments.map((attachment) => ({
        originalSha256: attachment.originalSha256!,
        displayName: attachment.displayName!,
        mediaType: attachment.mediaType!,
        bytes: attachment.bytes!
      }))
    });
    stream.markdown('This is a private staged plan, **not a registered document or an open Revision Loop**. Every displayed file is selected whole; there is no partial chat selection. The button opens a separate confirmation; clicking it alone does not approve or publish anything. Nothing was sent to a model or added to Story documents. PDF/DOCX/image registration is disabled until approved scanning and extraction are available. Copilot may have processed the initial chat attachments before SFlow ran.\n');
    stream.button({
      command: 'singularityFlow.registerFeedbackAttachmentFromChat',
      title: 'Review and register all selected feedback documents',
      arguments: [handle]
    });
    stream.button({
      command: 'workbench.action.chat.open', title: 'Prepare registration review',
      arguments: [{ query: '/sf-revision-attachments ', isPartialQuery: true }]
    });
  } catch {
    stream.markdown('The selected Story attachment could not be previewed safely. Check `/sf-session` and use `/sf-revision-attachments` with the same local file. No attachment set was registered.\n');
  }
}

async function registerChatAttachment(
  pending: PendingChatAttachment,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork
): Promise<void> {
  const action = 'Register evidence';
  const decision = await vscode.window.showWarningMessage(
    `Register all ${pending.attachments.length} selected files as private feedback evidence for ${pending.workId}/${pending.phaseId}?`,
    {
      modal: true,
      detail: `${pending.attachments.map((item, index) =>
        `${index + 1}. ${item.displayName} · ${item.mediaType} · ${item.bytes} bytes · ${item.originalSha256}`
      ).join('\n')}\nPlan: ${pending.planSha256}\n`
        + 'Registration does not start a revision, approve intent, publish a phase, or send content to a model.'
    },
    action
  );
  if (decision !== action) return;
  const active = activeRepositoryContext();
  const selectedWork = getCurrentWork();
  if (!active?.root || selectedWork?.id !== pending.workId) {
    await vscode.window.showWarningMessage('The selected Story changed. Preview the attachment again; nothing was registered.');
    return;
  }
  let registrationAttempted = false;
  try {
    const editorRoot = await realpath(active.root);
    if (!sameRealRepository(editorRoot, pending.repositoryRoot)) {
      await vscode.window.showWarningMessage('The selected repository changed. Preview the attachment again; nothing was registered.');
      return;
    }
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    const client = new SingularityFlowClient({
      location: resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      }),
      repository: active.root
    });
    const session = await client.run<{
      ready?: boolean; repositoryPath?: string; workId?: string; phase?: string; status?: string;
    }>(['session', 'current', '--json']);
    const sessionRoot = session.repositoryPath ? await realpath(session.repositoryPath) : null;
    if (!session.ready || !sessionRoot || !sameRealRepository(editorRoot, sessionRoot)
        || session.workId !== pending.workId || session.phase !== pending.phaseId
        || session.status !== 'in_progress') {
      await vscode.window.showWarningMessage('The active Story session or phase changed. Preview the attachment again; nothing was registered.');
      return;
    }
    registrationAttempted = true;
    const sourceArgs = pending.localPaths.flatMap((file, index) => [
      '--file', file, '--select', String(index + 1)
    ]);
    const envelope = await client.runWithInput<AttachmentRegistrationEnvelope>([
      'revision', 'attachments', 'register', ...sourceArgs,
      '--feedback-stdin', '--confirm', pending.planSha256, '--json'
    ], pending.feedback);
    const receipt = envelope.data;
    const attachmentSetSha256 = receipt?.attachmentSetSha256;
    if (!matchesChatAttachmentReceipt(receipt, pending) || typeof attachmentSetSha256 !== 'string') {
      throw new Error('Attachment registration did not return the exact selected receipt.');
    }
    await vscode.window.showInformationMessage(
      `All ${pending.attachments.length} feedback files were registered as private evidence: ${attachmentSetSha256}. No revision was started.`
    );
  } catch {
    await vscode.window.showWarningMessage(
      registrationAttempted
        ? 'The exact registration outcome could not be verified. Check revision attachments list before retrying. No revision was started.'
        : 'The selected Story could not be verified. Preview the attachment again; nothing was registered.'
    );
  }
}

function route(): GatewayRepositoryContext {
  return activeRepositoryContext() ?? {
    root: null,
    workspaceId: null,
    workspaceName: null,
    repositoryId: null,
    origin: 'chat-rootless'
  };
}

function questionFor(command: string | undefined, prompt: string): string {
  const value = prompt.trim();
  if (command === 'why') return value ? `Why is ${value}` : '';
  if (command === 'how') return value ? `How do I ${value}` : '';
  if (command === 'recover') return value ? `How do I recover from ${value}` : '';
  return value;
}

function outcomeOf(status: string): 'resolved' | 'ambiguous' | 'no-match' | 'unavailable' {
  if (status === 'resolved' || status === 'index') return 'resolved';
  if (status === 'ambiguous') return 'ambiguous';
  if (status === 'not-found') return 'no-match';
  return 'unavailable';
}

async function metric(input: Parameters<typeof recordHelpMetric>[1]): Promise<void> {
  const root = activeRepositoryContext()?.root;
  if (!root) return;
  await recordHelpMetric(root, input).catch(() => {});
}

async function readiness(question: string, getCurrentWork: () => CurrentWork): Promise<ReturnType<typeof buildResultCard> | null> {
  const active = activeRepositoryContext();
  const current = getCurrentWork();
  if (!active || !current?.id) return null;
  const conversation = planDeveloperConversation(question);
  if (conversation.route?.operationId !== 'work.readiness') return null;
  try {
    const { kernel } = gatewaySession(active);
    const resolution = await kernel.resolve({
      goalHint: 'work.readiness',
      arguments: { workId: current.id, ...(current.kind ? { workKind: current.kind } : {}) }
    });
    const envelope = resolution.kind === 'read' && resolution.next.length === 1
      ? await kernel.read({ resolutionId: resolution.next[0].handle }) : resolution;
    return buildResultCard(envelope);
  } catch {
    return null;
  }
}

function renderReadiness(stream: vscode.ChatResponseStream, card: ReturnType<typeof buildResultCard> | null): void {
  if (!card) return;
  stream.markdown(`### Current Story\n\n${card.headline}\n\n`);
  for (const row of card.checklist.filter((entry) => entry.state !== 'met').slice(0, 6)) {
    stream.markdown(`- **${row.label}**${row.detail ? ` — ${row.detail}` : ''}\n`);
  }
  stream.markdown('\n');
}

type RevisionChatAction =
  | { kind: 'guide' }
  | { kind: 'status' }
  | { kind: 'card'; intervalId: string | null }
  | { kind: 'show'; intervalId: string }
  | { kind: 'prepare'; feedback: string }
  | { kind: 'unavailable'; reason: string };

const REVISION_INTERVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REVISION_PREFILL_BYTES = 8_192;

/** Exact local routing only; feedback is opaque data and never becomes CLI argv here. */
function revisionChatAction(prompt: string): RevisionChatAction {
  const value = prompt.trim();
  if (!value) return { kind: 'guide' };
  if (value.toLowerCase() === 'status') return { kind: 'status' };
  if (value.toLowerCase() === 'card') return { kind: 'card', intervalId: null };
  if (value.toLowerCase() === 'show') {
    return { kind: 'unavailable', reason: '`show` requires one exact interval ID.' };
  }
  const inspection = /^(card|show)\s+(.+)$/i.exec(value);
  if (inspection) {
    const intervalId = inspection[2]!.trim();
    if (!REVISION_INTERVAL_ID.test(intervalId)) {
      return { kind: 'unavailable', reason: 'The interval ID is invalid or exceeds its bounded length.' };
    }
    return inspection[1]!.toLowerCase() === 'card'
      ? { kind: 'card', intervalId }
      : { kind: 'show', intervalId };
  }
  if (/^resume(?:\s|$)/i.test(value)) {
    return {
      kind: 'unavailable',
      reason: 'The participant exposes status/card/show reads only. Use `/sf-revise resume [INTERVAL-ID]` for guarded local pointer repair; an incomplete opening has no interval ID, and resume reruns no attempt or external effect.'
    };
  }
  if (/^abandon(?:\s|$)/i.test(value)) {
    return {
      kind: 'unavailable',
      reason: 'Recovery mutations are not executed by the participant. Use `/sf-revise abandon <LOOP-ID|INTERVAL-ID>` so the exact loop or selected interval and recovery confirmation are reviewed.'
    };
  }
  if (Buffer.byteLength(value) > MAX_REVISION_PREFILL_BYTES) {
    return { kind: 'unavailable', reason: 'Feedback exceeds the participant prefill limit; use `/sf-revise` with a bounded local feedback document.' };
  }
  return { kind: 'prepare', feedback: value };
}

function firstRevisionScalar(objects: JsonObject[], keys: string[]): string | number | boolean | null {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if ((typeof value === 'string' && value !== '')
          || typeof value === 'number' || typeof value === 'boolean') return value;
    }
  }
  return null;
}

/** Render only bounded identifiers/status; the full structured record remains available from Shell. */
function renderRevisionInspection(value: unknown, action: 'status' | 'card' | 'show', intervalId: string | null): string {
  const envelope = jsonObject(value) ?? {};
  const data = jsonObject(envelope.data) ?? {};
  const active = jsonObject(data.active) ?? {};
  const activeSubject = jsonObject(active.subject) ?? {};
  const state = jsonObject(data.state) ?? {};
  const status = jsonObject(data.status) ?? {};
  const scope = jsonObject(status.scope) ?? {};
  const head = jsonObject(status.head) ?? {};
  const loop = jsonObject(data.loop) ?? {};
  const interval = jsonObject(data.interval) ?? {};
  const card = jsonObject(data.card) ?? {};
  const cardCandidate = jsonObject(card.candidate) ?? {};
  const candidate = jsonObject(data.candidate) ?? jsonObject(data.selectedCandidate) ?? {};
  const precheck = jsonObject(data.precheck) ?? jsonObject(candidate.precheck) ?? {};
  const subject = jsonObject(envelope.subject) ?? {};
  const outcome = jsonObject(envelope.outcome) ?? {};
  const outcomeSlots = jsonObject(outcome.slots) ?? {};
  const objects = [activeSubject, active, state, status, scope, head, loop, interval,
    cardCandidate, candidate, precheck, card, subject, outcomeSlots, outcome, data];
  const row = (label: string, keys: string[], sources = objects) => {
    const found = firstRevisionScalar(sources, keys);
    return found == null ? '' : `- ${label}: **${markdownValue(found, 300)}**\n`;
  };
  let markdown = `### Revision ${action}${intervalId ? ` · ${safeMarkdown(intervalId)}` : ''}\n\n`;
  markdown += row('Story', ['workId', 'id'], [activeSubject, subject, state, data]);
  markdown += row('Phase', ['phaseId', 'phase'], [activeSubject, active, scope, state, outcomeSlots, data]);
  markdown += row('Phase status', ['phaseStatus'], [active, data]);
  markdown += row('Loop state', ['loopStatus', 'status'], [status, loop, state, data]);
  markdown += row('Interval', ['intervalId'], [interval, state, status, data]);
  markdown += row('Selected Candidate', ['selectedCandidateId', 'candidateId', 'id'],
    [head, cardCandidate, candidate, precheck, state, data]);
  markdown += row('Parent Candidate', ['parentCandidateId'], [state, interval, candidate, data]);
  markdown += row('Precheck', ['precheckStatus', 'verdict', 'result', 'publicationEligible'],
    [precheck, card, state, data]);
  const message = firstRevisionScalar([outcome, data], ['message', 'messageId', 'reason']);
  if (message != null) markdown += `\n${markdownValue(message, 1_000)}\n`;
  if (markdown.split('\n').length <= 4) {
    markdown += 'The bounded read completed. Use the Shell command below for its complete structured record.\n';
  }
  return markdown;
}

async function handleChatRevision(
  prompt: string,
  referenceCount: number,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork
): Promise<'resolved' | 'unavailable'> {
  const action = revisionChatAction(prompt);
  if (action.kind === 'guide') {
    stream.markdown('### Bounded Candidate revision\n\nUse `@sflow /revise status`, `@sflow /revise card [INTERVAL-ID]`, or `@sflow /revise show <INTERVAL-ID>` for read-only inspection. Enter authored feedback after `/revise` to prefill `/sf-revise`; the skill performs a separate preview, displays the exact Candidate/criteria/plan binding, and waits for explicit confirmation. The participant never starts, publishes, submits, or approves a revision.\n');
    stream.button({
      command: 'workbench.action.chat.open', title: 'Revision status',
      arguments: [{ query: '@sflow /revise status', isPartialQuery: true }]
    });
    stream.button({
      command: 'workbench.action.chat.open', title: 'Candidate card',
      arguments: [{ query: '@sflow /revise card', isPartialQuery: true }]
    });
    stream.button({
      command: 'workbench.action.chat.open', title: 'Prepare /sf-revise',
      arguments: [{ query: '/sf-revise ', isPartialQuery: true }]
    });
    return 'resolved';
  }
  if (action.kind === 'unavailable') {
    stream.markdown(`### Revision action unavailable\n\n${action.reason}\n\nNothing was executed.\n`);
    stream.button({
      command: 'workbench.action.chat.open', title: 'Prepare /sf-revise',
      arguments: [{ query: '/sf-revise ', isPartialQuery: true }]
    });
    return 'unavailable';
  }
  if (action.kind === 'prepare') {
    if (referenceCount > 0) {
      stream.markdown('### Register feedback documents first\n\n`@sflow /revise` does not silently convert chat references into governed evidence. Use `@sflow /attachments` with genuine local file references, confirm the returned attachment set, then invoke `/sf-revise` with that exact set digest. Opaque uploads remain unavailable because their original bytes cannot be verified. Nothing was executed.\n');
      stream.button({
        command: 'workbench.action.chat.open', title: 'Prepare @sflow /attachments',
        arguments: [{ query: '@sflow /attachments ', isPartialQuery: true }]
      });
      return 'unavailable';
    }
    stream.markdown('### Revision preview prepared for review\n\nThe feedback remains unexecuted. Continue in `/sf-revise`, which will bind it to the exact current Candidate, classify it, show criteria/specification disposition and the full preview digest, then wait for a separate exact confirmation. This button only prefills Copilot Chat. It does not send the prompt or run a lifecycle command.\n');
    stream.button({
      command: 'workbench.action.chat.open', title: 'Review with /sf-revise',
      arguments: [{ query: `/sf-revise ${action.feedback}`, isPartialQuery: true }]
    });
    return 'resolved';
  }

  const cancellation = chatAbortSignal(token);
  try {
    const active = await activeAttachmentSession(context, getCurrentWork, cancellation.signal);
    const argv = ['revision', action.kind];
    const intervalId = action.kind === 'status' ? null : action.intervalId;
    if (intervalId) argv.push(intervalId);
    argv.push('--json');
    if (commandClass(argv) !== 'read') {
      throw new Error('The requested revision inspection is not classified as read-only.');
    }
    stream.progress(`Reading model-free revision ${action.kind}…`);
    const value = await active.client.run(argv, cancellation.signal);
    if (token.isCancellationRequested) return 'resolved';
    stream.markdown(renderRevisionInspection(value, action.kind, intervalId));
    const shell = `singularity-flow ${argv.join(' ')}`;
    stream.markdown(`\n**Shell:** ${inlineCode(shell)}\n\n**Copilot:** ${inlineCode(`/sf-revise ${action.kind}${intervalId ? ` ${intervalId}` : ''}`)}\n`);
    stream.button({
      command: 'singularityFlow.copyParticipantCommand', title: 'Copy Shell',
      arguments: [shell, 'revise']
    });
    return 'resolved';
  } catch {
    stream.markdown('### Revision inspection unavailable\n\nThe selected editor repository, ready Story session, or requested REV record could not be verified. Use `/sf-session`, then retry `/sf-revise status`. Nothing was changed.\n');
    return 'unavailable';
  } finally {
    cancellation.dispose();
  }
}

function examples(stream: vscode.ChatResponseStream): SflowChatMetadata {
  stream.markdown('Ask about Singularity Flow or choose a declared command. Deterministic commands are local/CLI reads and never call a model. Human decisions open a separate guarded flow.\n\n');
  for (const command of PARTICIPANT_COMMANDS) {
    stream.markdown(`- \`@sflow /${command.id}\` — ${command.description}\n`);
  }
  stream.markdown('\nFree text routes only on an exact declared keyword; unmatched text shows this list instead of guessing.\n');
  return {
    intent: 'concept', topicId: null,
    followups: [
      { label: 'How do phases work?', prompt: 'How do phases work?', command: 'help' },
      { label: 'Why is work blocked?', prompt: 'Why is my Story blocked?', command: 'why' },
      { label: 'How does recovery work?', prompt: 'an interrupted phase', command: 'recover' }
    ]
  };
}

type JsonObject = Record<string, unknown>;
type ParticipantRendered = {
  markdown: string;
  shell?: string | null;
  shellCopyable?: boolean;
  copilot?: string | null;
  openApproval?: boolean;
};

function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function bounded(value: unknown, maximum = 600): string {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function inlineCode(value: unknown, maximum = 1200): string {
  const text = bounded(value, maximum);
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter}${text}${delimiter}`;
}

function markdownValue(value: unknown, maximum = 600): string {
  return safeMarkdown(bounded(value, maximum));
}

function participantClient(context: vscode.ExtensionContext): SingularityFlowClient {
  const active = activeRepositoryContext();
  if (!active?.root) throw new Error('Open or select a Singularity Flow repository before using this command.');
  const settings = vscode.workspace.getConfiguration('singularityFlow');
  return new SingularityFlowClient({
    location: resolveCli({
      configuredCli: settings.get<string>('cliPath'),
      configuredNode: settings.get<string>('nodePath'),
      extensionPath: context.extensionPath
    }),
    repository: active.root
  });
}

function chatAbortSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const subscription = token.onCancellationRequested?.(() => controller.abort());
  return { signal: controller.signal, dispose: () => subscription?.dispose() };
}

function renderedCommand(value: unknown): Pick<ParticipantRendered, 'shell' | 'shellCopyable' | 'copilot'> {
  const guidance = commandGuidance(value);
  return guidance
    ? {
        shell: bounded(guidance.command, 1200), shellCopyable: guidance.copyable,
        copilot: bounded(guidance.copilotCommand, 200)
      }
    : { shell: null, shellCopyable: false, copilot: null };
}

function renderNextAction(value: unknown): ParticipantRendered {
  const result = jsonObject(value) ?? {};
  const actions = jsonArray(result.actions).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  const action = actions.find((entry) => entry.timing === 'now') ?? actions[0] ?? null;
  let markdown = `### Next legal action\n\n- Story: **${markdownValue(result.workId ?? 'not selected')}**\n`;
  markdown += `- Current phase: **${markdownValue(result.currentPhase ?? 'unavailable')}**\n`;
  if (!action) return { markdown: `${markdown}- No currently available action was returned.\n` };
  markdown += `- Why: ${markdownValue(action.reason ?? 'No reason returned.', 1000)}\n`;
  markdown += `- Availability: ${markdownValue(action.availability ?? 'unknown')}\n`;
  const commands = renderedCommand(action);
  if (commands.shell) markdown += `\n**Shell:** ${inlineCode(commands.shell)}\n`;
  if (commands.copilot) markdown += `\n**Copilot:** ${inlineCode(commands.copilot)}\n`;
  markdown += '\nNothing was executed. Review or prefill the returned action.\n';
  return { markdown, ...commands };
}

function renderStatus(value: unknown): ParticipantRendered {
  const result = jsonObject(value) ?? {};
  const work = jsonObject(result.workItem) ?? {};
  const phaseId = typeof result.currentPhase === 'string' ? result.currentPhase : '';
  const phases = jsonObject(result.phases) ?? {};
  const phase = jsonObject(phases[phaseId]) ?? {};
  const generation = Number.isSafeInteger(phase.generation) ? phase.generation : 0;
  const artifacts = jsonArray(phase.artifacts);
  const checks = jsonArray(phase.checks).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  const approvals = jsonArray(phase.approvals).map(jsonObject)
    .filter((entry): entry is JsonObject => Boolean(entry))
    .filter((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  const approvalPolicy = jsonObject(phase.approvalPolicy) ?? {};
  const minimum = Number.isSafeInteger(approvalPolicy.minimum) ? Number(approvalPolicy.minimum) : 0;
  const authorities = jsonArray(approvalPolicy.authorities).slice(0, 8).map((entry) => bounded(entry, 80));
  const passed = checks.filter((entry) => ['pass', 'passed'].includes(String(entry.status))).length;
  const failed = checks.filter((entry) => ['fail', 'failed', 'blocked'].includes(String(entry.status))).length;
  return { markdown: `### Story status\n\n`
    + `- Story: **${markdownValue(work.id ?? 'not selected')}** — ${markdownValue(work.title ?? 'untitled')}\n`
    + `- Workflow: ${markdownValue(work.workTypeLabel ?? work.workType ?? 'unavailable')}\n`
    + `- Lifecycle: ${markdownValue(result.status ?? 'unavailable')}\n`
    + `- Phase: **${markdownValue(phase.label ?? (phaseId || 'unavailable'))}** · ${markdownValue(phase.status ?? 'unavailable')} · generation ${generation}\n`
    + `- Agent: ${markdownValue(phase.defaultAgent ?? 'unassigned')}\n`
    + `- Evidence: ${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} · checks ${passed} passed / ${failed} failed / ${checks.length} total\n`
    + `- Approvals: ${approvals.length}/${minimum}${approvals.length < minimum && authorities.length ? ` · waiting on ${safeMarkdown(authorities.join(', '))}` : ''}\n` };
}

function renderChecks(value: unknown): ParticipantRendered {
  const result = jsonObject(value) ?? {};
  const data = jsonObject(result.data) ?? {};
  const precheck = jsonObject(data.precheck) ?? {};
  const checks = jsonArray(precheck.checks).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  const important = checks.filter((entry) => entry.status !== 'pass');
  const displayed = (important.length ? important : checks).slice(0, 10);
  let markdown = `### Quick readiness checks\n\nOverall: **${markdownValue(precheck.status ?? 'unavailable')}**\n\n`;
  if (!displayed.length) markdown += 'No check rows were returned.\n';
  for (const check of displayed) {
    markdown += `- **${markdownValue(check.id ?? 'check')}** · ${markdownValue(check.status ?? 'unknown')}`;
    if (check.reason) markdown += ` — ${markdownValue(check.reason)}`;
    markdown += '\n';
  }
  return { markdown };
}

function renderRouter(value: unknown): ParticipantRendered {
  const result = jsonObject(value) ?? {};
  const rendered = jsonObject(result.rendered) ?? {};
  const outcome = jsonObject(result.outcome) ?? {};
  const next = jsonArray(result.next).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry))[0] ?? null;
  let markdown = `### Deterministic router\n\n${markdownValue(rendered.headline ?? outcome.status ?? 'Router completed.')}\n`;
  if (!next) return { markdown: `${markdown}\nNo next action was returned.\n` };
  markdown += `\n- ${markdownValue(next.label ?? next.id ?? 'Next action', 1000)}\n`;
  const commands = renderedCommand(next);
  if (commands.shell) markdown += `\n**Shell:** ${inlineCode(commands.shell)}\n`;
  if (commands.copilot) markdown += `\n**Copilot:** ${inlineCode(commands.copilot)}\n`;
  markdown += '\nThe returned action was not executed.\n';
  return { markdown, ...commands };
}

function renderDocuments(value: unknown): ParticipantRendered {
  const documents = jsonArray(value).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  let markdown = `### Active governed documents\n\n${documents.length} document${documents.length === 1 ? '' : 's'} returned.\n\n`;
  for (const document of documents.slice(0, 20)) {
    const digest = typeof document.sha256 === 'string' ? document.sha256.slice(0, 12) : 'unavailable';
    markdown += `- **${markdownValue(document.label ?? document.id ?? 'Document')}**`;
    if (document.phase) markdown += ` · ${markdownValue(document.phase)}`;
    markdown += ` · \`${markdownValue(digest)}\`\n`;
  }
  if (documents.length > 20) markdown += `- …and ${documents.length - 20} more. Open Documents for the complete list.\n`;
  return { markdown };
}

function renderWorkflows(value: unknown): ParticipantRendered {
  const workflows = jsonArray(value).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  let markdown = `### Story workflows\n\n${workflows.length} workflow${workflows.length === 1 ? '' : 's'} returned.\n\n`;
  for (const workflow of workflows.slice(0, 20)) {
    const phases = jsonArray(workflow.phases).map((phase) => bounded(phase, 40)).join(' → ');
    markdown += `- **${markdownValue(workflow.label ?? workflow.id ?? 'Workflow')}** · ${markdownValue(workflow.status ?? 'unknown')}`;
    if (phases) markdown += ` · ${safeMarkdown(phases)}`;
    markdown += '\n';
  }
  if (workflows.length > 20) markdown += `- …and ${workflows.length - 20} more.\n`;
  return { markdown };
}

function renderApprovalReview(value: unknown): ParticipantRendered {
  const result = jsonObject(value) ?? {};
  const documents = jsonArray(result.documents).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  let markdown = `### Approval context\n\n`
    + `- Story: **${markdownValue(result.workId ?? 'unavailable')}**\n`
    + `- Phase: **${markdownValue(result.phaseLabel ?? result.phase ?? 'unavailable')}**\n`
    + `- Status: ${markdownValue(result.status ?? 'unavailable')} · generation ${markdownValue(result.generation ?? 0)}\n`;
  for (const document of documents.slice(0, 8)) {
    const digest = typeof document.sha256 === 'string' ? document.sha256.slice(0, 12) : 'unavailable';
    markdown += `- Artifact: ${markdownValue(document.label ?? document.id ?? 'document')} · \`${markdownValue(digest)}\`\n`;
  }
  markdown += '\nApproval was **not** recorded. Open the guarded Approvals form to review the exact checklist and receipt-bound decision.\n';
  return { markdown, copilot: '/sf-approve', openApproval: true };
}

function renderInputs(value: unknown, phaseId: string): ParticipantRendered {
  const result = jsonObject(value) ?? {};
  const data = jsonObject(result.data) ?? {};
  const rendered = jsonObject(result.rendered) ?? {};
  const inputRows = jsonArray(result.records ?? result.inputs ?? data.inputs).map(jsonObject)
    .filter((entry): entry is JsonObject => Boolean(entry));
  let markdown = `### ${markdownValue(phaseId)} input preview\n\n`;
  if (rendered.headline) markdown += `${markdownValue(rendered.headline, 1000)}\n\n`;
  if (!inputRows.length) markdown += 'The dry-run completed without exposing a writable input record.\n';
  for (const input of inputRows.slice(0, 12)) {
    markdown += `- **${markdownValue(input.id ?? input.phase ?? input.name ?? 'input')}** · ${markdownValue(input.status ?? 'captured')}\n`;
  }
  markdown += '\nNo managed input record was written.\n';
  return { markdown };
}

function renderParticipantResult(
  command: ParticipantCommandDefinition, value: unknown, phaseId: string
): ParticipantRendered {
  if (command.template === 'next-action') return renderNextAction(value);
  if (command.template === 'status') return renderStatus(value);
  if (command.template === 'checks') return renderChecks(value);
  if (command.template === 'router') return renderRouter(value);
  if (command.template === 'documents') return renderDocuments(value);
  if (command.template === 'workflows') return renderWorkflows(value);
  if (command.template === 'approval-review') return renderApprovalReview(value);
  if (command.template === 'inputs') return renderInputs(value, phaseId);
  if (command.template === 'validation') {
    return { markdown: `### Workflow validation\n\n${markdownValue(value, 4000)}\n` };
  }
  return { markdown: 'The deterministic command completed. Its full internal payload was intentionally not rendered.\n' };
}

function renderParticipantRefusal(error: unknown): ParticipantRendered {
  const cli = error instanceof CliError ? error : null;
  const result = jsonObject(cli?.result);
  const plan = jsonObject(result?.remediationPlan);
  const steps = jsonArray(plan?.steps).map(jsonObject).filter((entry): entry is JsonObject => Boolean(entry));
  let markdown = `### Command unavailable\n\n${markdownValue(cli?.message ?? (error as Error)?.message ?? 'The command could not be completed.', 1800)}\n`;
  if (steps.length) markdown += '\n**Safe remediation plan**\n\n';
  for (const step of steps.slice(0, 3)) {
    markdown += `- ${markdownValue(step.label ?? step.id ?? 'Review the blocker.', 800)}\n`;
    const commands = renderedCommand(step);
    if (commands.shell) markdown += `  - Shell: ${inlineCode(commands.shell)}\n`;
    if (commands.copilot) markdown += `  - Copilot: ${inlineCode(commands.copilot)}\n`;
  }
  const first = steps[0];
  return { markdown, ...renderedCommand(first) };
}

function addParticipantButtons(
  stream: vscode.ChatResponseStream,
  command: ParticipantCommandDefinition,
  rendered: ParticipantRendered
): void {
  if (rendered.shell && rendered.shellCopyable !== false) {
    stream.button({
      command: 'singularityFlow.copyParticipantCommand', title: 'Copy Shell',
      arguments: [rendered.shell, command.id]
    });
  }
  if (rendered.copilot) {
    stream.button({
      command: 'singularityFlow.prefillParticipantAction', title: `Prepare ${rendered.copilot}`,
      arguments: [rendered.copilot, command.id]
    });
  }
  if (rendered.openApproval) {
    stream.button({ command: 'singularityFlow.openApprovals', title: 'Open guarded approval form' });
  }
}

function zeroModelFooter(stream: vscode.ChatResponseStream, startedAt: number, effect = 'read'): void {
  stream.markdown(`\n_0 model calls · ${Math.max(0, Date.now() - startedAt)} ms · ${effect}_\n`);
}

async function recordLocalParticipantMetric(
  command: string,
  startedAt: number,
  outcome: 'resolved' | 'unavailable' = 'resolved'
): Promise<void> {
  await metric({
    surface: 'participant', intent: 'command-discovery', outcome, topicId: command,
    matchedBy: 'declared-command', latencyMs: Math.max(0, Date.now() - startedAt),
    answerBytes: 0, actionCategory: null, command, commandClass: 'deterministic',
    modelInvocations: 0, inputTokens: 0, outputTokens: 0
  });
}

async function executeParticipantCommand(
  command: ParticipantCommandDefinition,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  context: vscode.ExtensionContext,
  getCurrentWork: () => CurrentWork
): Promise<SflowChatMetadata> {
  const startedAt = Date.now();
  const cancellation = chatAbortSignal(token);
  let rendered: ParticipantRendered;
  let outcome: 'resolved' | 'unavailable' = 'resolved';
  try {
    if (command.class !== 'deterministic' || command.effect === 'mutation') {
      throw new Error(`Participant command '/${command.id}' is not enabled by the zero-model dispatcher.`);
    }
    let client: SingularityFlowClient;
    let phaseId = '';
    if (command.requiresSession) {
      const active = await activeAttachmentSession(context, getCurrentWork, cancellation.signal);
      client = active.client;
      phaseId = active.phaseId;
    } else {
      client = participantClient(context);
    }
    const argv = participantRuntimeArgv(command, { prompt, phase: phaseId });
    if (!argv) throw new Error(`Participant command '${command.id}' has no CLI route.`);
    if (commandClass(argv) !== 'read') {
      throw new Error(`Participant command '/${command.id}' does not resolve to a read-only CLI operation.`);
    }
    stream.progress(`Running model-free /${command.id}…`);
    const value = command.transport === 'cli-text'
      ? await client.runText(argv, { signal: cancellation.signal })
      : await client.run(argv, cancellation.signal);
    if (token.isCancellationRequested) return {
      intent: 'command-discovery', topicId: command.id, followups: []
    };
    rendered = renderParticipantResult(command, value, phaseId);
  } catch (error) {
    outcome = 'unavailable';
    rendered = renderParticipantRefusal(error);
  } finally {
    cancellation.dispose();
  }
  const elapsed = Math.max(0, Date.now() - startedAt);
  const footer = `\n_0 model calls · ${elapsed} ms · ${command.effect}_\n`;
  stream.markdown(`${rendered.markdown}${footer}`);
  addParticipantButtons(stream, command, rendered);
  await metric({
    surface: 'participant', intent: 'command-discovery', outcome, topicId: command.id,
    matchedBy: 'declared-command', latencyMs: elapsed,
    answerBytes: Math.min(65_536, Buffer.byteLength(rendered.markdown + footer)),
    actionCategory: null, command: command.id, commandClass: command.class,
    modelInvocations: 0, inputTokens: 0, outputTokens: 0
  });
  return { intent: 'command-discovery', topicId: command.id, followups: [] };
}

export function registerSflowChat(
  context: vscode.ExtensionContext,
  { getCurrentWork = () => null }: { getCurrentWork?: () => CurrentWork } = {}
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') return;

  const confirmations = new ChatAttachmentConfirmations();
  const removals = new ChatAttachmentRemovals();
  context.subscriptions.push({ dispose: () => { confirmations.clear(); removals.clear(); } });
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.registerFeedbackAttachmentFromChat', async (handle: unknown) => {
      const pending = confirmations.take(handle);
      if (!pending) {
        await vscode.window.showWarningMessage('This attachment confirmation expired or was already used. Preview the file again.');
        return;
      }
      await registerChatAttachment(pending, context, getCurrentWork);
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.removeFeedbackAttachmentFromChat', async (handle: unknown) => {
      const pending = removals.take(handle);
      if (!pending) {
        await vscode.window.showWarningMessage('This attachment-set removal confirmation expired or was already used. Stage removal again.');
        return;
      }
      await removeChatAttachment(pending, context, getCurrentWork);
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.copyHelpCommand', async (command: string, topicId: string) => {
      if (!command) return;
      await vscode.env.clipboard.writeText(command);
      await metric({
        surface: 'participant', intent: 'command-discovery', outcome: 'resolved', topicId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'command-copied',
        command: 'help', commandClass: 'deterministic', modelInvocations: 0,
        inputTokens: 0, outputTokens: 0
      });
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.prefillHelpAction', async (skill: string, topicId: string) => {
      if (!skill) return;
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `${skill} `,
        isPartialQuery: true
      });
      await metric({
        surface: 'participant', intent: 'procedure', outcome: 'resolved', topicId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'command-prefilled',
        command: 'help', commandClass: 'deterministic', modelInvocations: 0,
        inputTokens: 0, outputTokens: 0
      });
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.openHelpTopicFromChat', async (topicId: string) => {
      if (!topicId) return;
      await vscode.commands.executeCommand('singularityFlow.explainTopic', { id: `help:topic:${topicId}` });
      await metric({
        surface: 'participant', intent: 'concept', outcome: 'resolved', topicId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'topic-opened',
        command: 'help', commandClass: 'deterministic', modelInvocations: 0,
        inputTokens: 0, outputTokens: 0
      });
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.copyParticipantCommand', async (command: string, commandId: string) => {
      if (!command) return;
      await vscode.env.clipboard.writeText(command);
      await metric({
        surface: 'participant', intent: 'command-discovery', outcome: 'resolved',
        topicId: commandId, matchedBy: 'action', latencyMs: 0, answerBytes: 0,
        actionCategory: 'command-copied', command: commandId, commandClass: 'deterministic',
        modelInvocations: 0, inputTokens: 0, outputTokens: 0
      });
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.prefillParticipantAction', async (skill: string, commandId: string) => {
      if (!skill) return;
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `${skill} `, isPartialQuery: true
      });
      await metric({
        surface: 'participant', intent: 'procedure', outcome: 'resolved', topicId: commandId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0,
        actionCategory: 'command-prefilled', command: commandId, commandClass: 'deterministic',
        modelInvocations: 0, inputTokens: 0, outputTokens: 0
      });
    }
  ));

  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    const participantStartedAt = Date.now();
    if (token.isCancellationRequested) return;
    const keywordMatch = request.command ? null : matchParticipantCommand(request.prompt);
    const declared = request.command
      ? PARTICIPANT_COMMAND_BY_ID.get(request.command)
      : keywordMatch?.command;
    const effectivePrompt = keywordMatch?.argument ?? request.prompt;
    if (!declared) {
      const metadata = examples(stream);
      await recordLocalParticipantMetric('help', participantStartedAt);
      zeroModelFooter(stream, participantStartedAt);
      return { metadata };
    }
    if (!declared.acceptsArguments && effectivePrompt.trim()) {
      stream.markdown(`### Command unavailable\n\n\`/${declared.id}\` does not accept free-text arguments. Remove the extra text and retry; nothing was executed.\n`);
      await recordLocalParticipantMetric(declared.id, participantStartedAt, 'unavailable');
      zeroModelFooter(stream, participantStartedAt, declared.effect);
      return {
        metadata: {
          intent: 'command-discovery', topicId: declared.id, followups: []
        } satisfies SflowChatMetadata
      };
    }
    if (declared.transport !== 'local') {
      const metadata = await executeParticipantCommand(
        declared, effectivePrompt, stream, token, context, getCurrentWork
      );
      return { metadata };
    }
    if (declared.id === 'attachments') {
      const action = chatAttachmentAction(effectivePrompt, request.references?.length ?? 0);
      if (action.kind === 'status') {
        await statusChatAttachments(stream, token, context, getCurrentWork);
      } else if (action.kind === 'remove') {
        await previewChatAttachmentRemoval(
          action.attachmentSetSha256, stream, token, context, getCurrentWork, removals
        );
      } else if (action.kind === 'unavailable') {
        stream.markdown(`${action.reason} No attachment set was changed.\n`);
      } else {
        await previewChatAttachment(request, stream, token, context, getCurrentWork, confirmations);
      }
      await recordLocalParticipantMetric(
        'attachments', participantStartedAt, action.kind === 'unavailable' ? 'unavailable' : 'resolved'
      );
      zeroModelFooter(stream, participantStartedAt, 'human-decision');
      return { metadata: { intent: 'procedure', topicId: null, followups: [] } satisfies SflowChatMetadata };
    }
    if (declared.id === 'revise') {
      const outcome = await handleChatRevision(
        effectivePrompt, request.references?.length ?? 0, stream, token, context, getCurrentWork
      );
      await recordLocalParticipantMetric('revise', participantStartedAt, outcome);
      zeroModelFooter(stream, participantStartedAt, 'human-decision');
      return {
        metadata: {
          intent: 'procedure', topicId: 'revision-loop', followups: []
        } satisfies SflowChatMetadata
      };
    }
    if (declared.id === 'topics') {
      const index = await resolveHelp('');
      stream.markdown('### Reviewed Singularity Flow topics\n\n');
      stream.markdown(index.topics.map((topic) => `- **${topic.title}** — \`${topic.id}\``).join('\n'));
      await metric({
        surface: 'participant', intent: 'concept', outcome: 'resolved', topicId: null,
        matchedBy: 'index', latencyMs: index.latencyMs, answerBytes: 0, actionCategory: null,
        command: 'topics', commandClass: 'deterministic', modelInvocations: 0,
        inputTokens: 0, outputTokens: 0
      });
      zeroModelFooter(stream, participantStartedAt);
      return { metadata: { intent: 'concept', topicId: null, followups: [] } satisfies SflowChatMetadata };
    }

    const question = questionFor(declared.id, effectivePrompt);
    if (!question) {
      const metadata = examples(stream);
      await recordLocalParticipantMetric(declared.id, participantStartedAt);
      zeroModelFooter(stream, participantStartedAt, declared.effect);
      return { metadata };
    }
    stream.progress('Reading reviewed Singularity Flow documentation…');
    const [answer, current] = await Promise.all([
      resolveHelp(question, { maxBytes: 4000 }),
      readiness(question, getCurrentWork)
    ]);
    if (token.isCancellationRequested) return;

    await metric({
      surface: 'participant', intent: answer.helpIntent, outcome: outcomeOf(answer.status),
      topicId: answer.topic?.id ?? null, matchedBy: answer.matchedBy,
      latencyMs: answer.latencyMs, answerBytes: answer.served?.bytes ?? 0, actionCategory: null,
      command: declared.id, commandClass: 'deterministic', modelInvocations: 0,
      inputTokens: 0, outputTokens: 0
    });

    renderReadiness(stream, current);
    if (answer.status !== 'resolved') {
      const heading = answer.status === 'ambiguous'
        ? 'That question matches more than one reviewed topic.'
        : 'The reviewed documentation does not answer that question yet.';
      stream.markdown(`### ${heading}\n\n`);
      for (const candidate of answer.candidates) {
        stream.markdown(`- **${candidate.title}** — \`${candidate.id}\`\n`);
        stream.button({
          command: 'singularityFlow.openHelpTopicFromChat',
          title: `Open ${candidate.title}`,
          arguments: [candidate.id]
        });
      }
      const followups = answer.candidates.slice(0, 3).map((candidate) => ({
        prompt: candidate.id, label: candidate.title, command: 'help'
      }));
      zeroModelFooter(stream, participantStartedAt);
      return { metadata: { intent: answer.helpIntent, topicId: null, followups } satisfies SflowChatMetadata };
    }

    const topic = answer.topic;
    const served = answer.served;
    if (!topic || !served || !answer.citation) {
      stream.markdown('The reviewed help topic could not be served by this build. Reinstall Singularity Flow and try again.');
      zeroModelFooter(stream, participantStartedAt);
      return { metadata: { intent: answer.helpIntent, topicId: null, followups: [] } satisfies SflowChatMetadata };
    }
    stream.markdown(`### ${topic.title}\n\n`);
    stream.markdown(`${served.text}\n\n${answer.citation}\n`);
    stream.reference(vscode.Uri.file(path.join(PACKAGE_ROOT, 'docs', 'topics', topic.file)));
    stream.button({
      command: 'singularityFlow.openHelpTopicFromChat',
      title: 'Open in Help Center',
      arguments: [topic.id]
    });
    if (answer.handoff) {
      const guidance = commandGuidance(answer.handoff);
      if (guidance) {
        stream.markdown(`\n**Shell:** ${inlineCode(guidance.command)}\n\n**Copilot:** ${inlineCode(guidance.copilotCommand)}\n`);
        if (guidance.copyable) {
          stream.button({
            command: 'singularityFlow.copyHelpCommand',
            title: 'Copy Shell',
            arguments: [guidance.command, topic.id]
          });
          stream.button({
            command: 'singularityFlow.copyHelpCommand',
            title: 'Copy Copilot',
            arguments: [guidance.copilotCommand, topic.id]
          });
          stream.button({
            command: 'singularityFlow.prefillHelpAction',
            title: `Prepare ${guidance.skill}`,
            arguments: [guidance.skill, topic.id]
          });
        } else {
          stream.markdown('\nReplace the shown placeholders before running this command.\n');
        }
      }
    }
    const followups = (answer.related ?? []).map((relatedTopic) => ({
      prompt: relatedTopic.id,
      label: relatedTopic.title,
      command: 'help'
    }));
    zeroModelFooter(stream, participantStartedAt);
    return {
      metadata: {
        intent: answer.helpIntent,
        topicId: topic.id,
        followups
      } satisfies SflowChatMetadata
    };
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg');
  participant.followupProvider = {
    provideFollowups(result) {
      const metadata = (result as vscode.ChatResult & { metadata?: SflowChatMetadata }).metadata;
      return metadata?.followups ?? [];
    }
  };
  context.subscriptions.push(participant);
}
