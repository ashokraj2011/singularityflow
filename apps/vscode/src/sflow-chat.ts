/** Explicit, model-free `@sflow` Copilot participant. */
import path from 'node:path';
import * as vscode from 'vscode';

import { resolveHelp } from '../../../src/help-service.mjs';
import { recordHelpMetric } from '../../../src/help-metrics.mjs';
import { PACKAGE_ROOT } from '../../../src/package-root.mjs';
import { planDeveloperConversation } from '../../../src/gateway/conversation.mjs';
import { activeRepositoryContext, gatewaySession, type GatewayRepositoryContext } from './gateway-session.ts';
import { buildResultCard } from './views/result-card-model.ts';

const PARTICIPANT_ID = 'singularity-flow.sflow';

type CurrentWork = { id: string; kind?: string | null } | null;
type Followup = { prompt: string; label: string; command?: string };
type SflowChatMetadata = {
  intent: string;
  topicId: string | null;
  followups: Followup[];
};

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
    const resolution = kernel.resolve({
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
  stream.markdown('Ask a question about Singularity Flow. This participant reads reviewed offline topics and does not call a model.\n\n');
  stream.markdown('- `@sflow /why can’t I submit?`\n- `@sflow /how start a Story`\n- `@sflow /recover interrupted implementation`\n- `@sflow /topics`\n');
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
      stream.button({
        command: 'singularityFlow.copyHelpCommand',
        title: 'Copy command',
        arguments: [answer.handoff.command, topic.id]
      });
      stream.button({
        command: 'singularityFlow.prefillHelpAction',
        title: `Prepare ${answer.handoff.skill}`,
        arguments: [answer.handoff.skill, topic.id]
      });
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
