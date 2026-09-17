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
import { resolveCli, SingularityFlowClient } from './cli/client.ts';
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
  getCurrentWork: () => CurrentWork
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
  }>(['session', 'current', '--json']);
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

function examples(stream: vscode.ChatResponseStream): SflowChatMetadata {
  stream.markdown('Ask a question about Singularity Flow. This participant reads reviewed offline topics and does not call a model. Its attachment preview also stays model-free.\n\n');
  stream.markdown('- `@sflow /why can’t I submit?`\n- `@sflow /how start a Story`\n- `@sflow /recover interrupted implementation`\n- `@sflow /attachments` with feedback and one to five local file references\n- `@sflow /attachments status`\n- `@sflow /attachments remove sha256:<exact set digest>`\n- `@sflow /topics`\n');
  return {
    intent: 'concept', topicId: null,
    followups: [
      { label: 'How do phases work?', prompt: 'How do phases work?', command: 'help' },
      { label: 'Why is work blocked?', prompt: 'Why is my Story blocked?', command: 'why' },
      { label: 'How does recovery work?', prompt: 'an interrupted phase', command: 'recover' }
    ]
  };
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
        surface: 'chat', intent: 'command-discovery', outcome: 'resolved', topicId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'command-copied'
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
        surface: 'chat', intent: 'procedure', outcome: 'resolved', topicId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'command-prefilled'
      });
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.openHelpTopicFromChat', async (topicId: string) => {
      if (!topicId) return;
      await vscode.commands.executeCommand('singularityFlow.explainTopic', { id: `help:topic:${topicId}` });
      await metric({
        surface: 'chat', intent: 'concept', outcome: 'resolved', topicId,
        matchedBy: 'action', latencyMs: 0, answerBytes: 0, actionCategory: 'topic-opened'
      });
    }
  ));

  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    if (token.isCancellationRequested) return;
    if (request.command === 'attachments') {
      const action = chatAttachmentAction(request.prompt, request.references?.length ?? 0);
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
      return { metadata: { intent: 'procedure', topicId: null, followups: [] } satisfies SflowChatMetadata };
    }
    if (request.command === 'topics') {
      const index = await resolveHelp('');
      stream.markdown('### Reviewed Singularity Flow topics\n\n');
      stream.markdown(index.topics.map((topic) => `- **${topic.title}** — \`${topic.id}\``).join('\n'));
      await metric({
        surface: 'chat', intent: 'concept', outcome: 'resolved', topicId: null,
        matchedBy: 'index', latencyMs: index.latencyMs, answerBytes: 0, actionCategory: null
      });
      return { metadata: { intent: 'concept', topicId: null, followups: [] } satisfies SflowChatMetadata };
    }

    const question = questionFor(request.command, request.prompt);
    if (!question) return { metadata: examples(stream) };
    stream.progress('Reading reviewed Singularity Flow documentation…');
    const [answer, current] = await Promise.all([
      resolveHelp(question, { maxBytes: 4000 }),
      readiness(question, getCurrentWork)
    ]);
    if (token.isCancellationRequested) return;

    await metric({
      surface: 'chat', intent: answer.helpIntent, outcome: outcomeOf(answer.status),
      topicId: answer.topic?.id ?? null, matchedBy: answer.matchedBy,
      latencyMs: answer.latencyMs, answerBytes: answer.served?.bytes ?? 0, actionCategory: null
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
      return { metadata: { intent: answer.helpIntent, topicId: null, followups } satisfies SflowChatMetadata };
    }

    const topic = answer.topic;
    const served = answer.served;
    if (!topic || !served || !answer.citation) {
      stream.markdown('The reviewed help topic could not be served by this build. Reinstall Singularity Flow and try again.');
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
        stream.markdown(`\n**Shell:** \`${guidance.command}\`\n\n**Copilot:** \`${guidance.copilotCommand}\`\n`);
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
