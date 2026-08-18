/** `sflow recommend` — the canonical, read-only developer recommendation. */
import { randomUUID } from 'node:crypto';

import { createHostGateway } from '../gateway/host.mjs';
import { gatewayPlanners } from '../gateway/planners/index.mjs';
import { developerRepository } from '../gateway/home-context.mjs';
import {
  action, because, commandResult, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString } from '../util.mjs';

function continuation(envelope) {
  const recommendation = envelope.data?.guidance?.recommendation ?? null;
  if (!recommendation?.command) return [];
  return [action({
    id: 'developer-recommendation',
    label: envelope.next?.[0]?.label ?? 'Continue with the next governed step',
    command: recommendation.command,
    rank: 'NOW',
    kind: 'workflow',
    modelPolicy: 'never'
  })];
}

export function recommendationNarration(envelope) {
  const guidance = envelope.data?.guidance ?? {};
  const recommendation = guidance.recommendation ?? null;
  const name = envelope.data?.personalization?.replyName ?? null;
  const next = continuation(envelope);
  return commandResult({
    operation: { id: 'recommend', classification: 'read' },
    subject: guidance.workId ? { kind: 'story', id: guidance.workId } : null,
    outcome: succeeded(next.length ? 'recommend.ready' : 'recommend.no-current-work', {
      name,
      workId: guidance.workId ?? 'No current work',
      phase: guidance.currentPhase ?? 'none',
      action: next[0]?.label ?? 'Start or resume governed work'
    }),
    effects: noEffects(),
    why: [because('recommend.from-durable-state', 'evidence', {
      ref: guidance.workId ?? envelope.data?.workspace?.id ?? null,
      slots: { source: guidance.stateSource ?? 'durable-records' },
      topic: 'nextsteps'
    })],
    next,
    restState: next.length ? null : 'informational',
    data: {
      /** Preserve the complete grounded Home projection for conversational renderers. */
      home: envelope.data ?? null,
      guidance,
      personalization: envelope.data?.personalization ?? null,
      workspace: envelope.data?.workspace ?? null,
      repository: envelope.data?.repository ?? null,
      currentWork: envelope.data?.currentWork ?? null,
      attentionWork: envelope.data?.attentionWork ?? null,
      warnings: envelope.warnings ?? [],
      alternatives: (envelope.next ?? []).slice(1).map((entry) => ({
        id: entry.id,
        label: entry.label,
        command: entry.fallback?.command ?? null,
        skill: entry.fallback?.skill ?? null
      }))
    }
  });
}

export async function run(_argv, { options }) {
  const workspaceReference = optionString(options, 'workspace');
  const { root, context, selected } = await developerRepository(workspaceReference);
  const { kernel } = createHostGateway({
    root,
    hostSessionId: `cli_${randomUUID()}`,
    workspaceId: context.workspaceId ?? null,
    planners: gatewayPlanners(),
    plannerContext: {
      workspace: { id: context.workspaceId, name: context.workspaceName },
      repositoryId: selected.id,
      branch: selected.branch,
      storyId: context.storyId ?? null,
      repository: {
        id: selected.id,
        path: root,
        branch: selected.branch,
        head: selected.head ?? null,
        resolvedFrom: workspaceReference ? 'workspace-option' : 'active-workspace'
      }
    }
  });
  const resolution = kernel.resolve({ utterance: 'what should I do next' });
  const envelope = resolution.kind === 'read' && resolution.next.length === 1
    ? await kernel.read({ resolutionId: resolution.next[0].handle })
    : resolution;
  emitCommandResult(recommendationNarration(envelope), {
    json: optionBoolean(options, 'json'),
    restStateWhenIdle: 'informational'
  });
}
