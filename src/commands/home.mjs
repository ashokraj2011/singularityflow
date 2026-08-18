/**
 * `sflow home` — the first command served by the gateway kernel.
 *
 * `sflow-result` v2 is the only state projection this command computes. The terminal renderer and
 * JSON consumer both read the same `home.overview` envelope that VS Code receives, including its
 * sealed choices, recovery classification and authority-aware counts `[UXH:C2]` `[UXH:AC-002]`.
 */
import { randomUUID } from 'node:crypto';

import { createHostGateway } from '../gateway/host.mjs';
import { planDeveloperConversation } from '../gateway/conversation.mjs';
import { gatewayPlanners } from '../gateway/planners/index.mjs';
import { homeRepository } from '../gateway/home-context.mjs';
import { message } from '../gateway/messages.mjs';
import { primaryAction } from '../gateway/result.mjs';
import { optionBoolean, optionString } from '../util.mjs';
import { identity, localGitDisplayName } from '../git.mjs';

function renderConversation(conversation, homeEnvelope) {
  if (!conversation) return;
  const current = homeEnvelope.data?.currentWork ?? homeEnvelope.data?.activeWork;
  console.log('\nI found');
  console.log(current
    ? `${current.id}${current.title ? ` — ${current.title}` : ''}${current.phase ? ` · ${current.phase}` : ''}`
    : `${homeEnvelope.data?.workspace?.name ?? 'This workspace'} · no current governed work on this branch`);

  console.log('\nNext');
  if (conversation.route) {
    console.log(`${conversation.route.label} (${conversation.route.recommendedSkill})`);
  } else if (conversation.choices.length) {
    console.log(conversation.choices.map((choice) => choice.label).join(' · '));
  } else {
    console.log('Choose a Home action or describe the work, state, blocker, or recovery you need.');
  }

  console.log('\nI need from you');
  if (!conversation.route) {
    console.log(conversation.choices.length ? 'Choose one of the proposed directions.' : 'Clarify what you want to do.');
  } else if (conversation.route.confirmation === 'none') {
    console.log('Nothing. This is a read-only request.');
  } else if (conversation.route.confirmation === 'ceremony') {
    console.log('Open the governed decision and provide the required human identity and decision.');
  } else {
    console.log('Confirm the proposed action before any governed state changes.');
  }

  console.log('\nThis will change');
  console.log('Nothing yet. Conversation planning is read-only; mutations run only after explicit confirmation.');
}

function render(homeEnvelope, answerEnvelope, { context, selected, actor }, conversation = null) {
  const active = homeEnvelope.data?.currentWork ?? homeEnvelope.data?.activeWork ?? null;
  console.log(`Singularity Flow home — ${context.workspaceName ?? 'local setup'}`);
  console.log(`Actor: ${actor.name}${actor.email ? ` <${actor.email}>` : ''}`);
  console.log(selected
    ? `Repository: ${selected.id} · ${selected.branch} @ ${(selected.head ?? 'unavailable').slice(0, 12)}`
    : 'Repository: none selected');
  console.log(`Freshness: ${new Date().toISOString()} · local only`);
  if (homeEnvelope.data?.personalization?.replyName) console.log(`\nHello, ${homeEnvelope.data.personalization.replyName}.`);
  console.log(`\n${active
    ? `${active.id} is in ${active.phase ?? 'its workflow'}.`
    : `${context.workspaceName ?? 'Local setup'} has ${homeEnvelope.outcome.slots.active ?? 0} active governed work item(s).`}`);
  renderConversation(conversation, homeEnvelope);
  if (answerEnvelope) {
    console.log('\nAnswer');
    console.log(message(answerEnvelope.outcome.messageId, answerEnvelope.outcome.slots).label);
    for (const finding of answerEnvelope.why ?? []) {
      console.log(`- ${message(finding.code, finding.slots).label}`);
    }
    if (answerEnvelope.checklist?.length) {
      console.log('\nChecklist');
      for (const item of answerEnvelope.checklist) {
        console.log(`- [${item.state}] ${message(item.labelCode, item.slots).label}`);
      }
    }
  }

  /**
   * The one legal next action, named as one thing `[UXH:REQ-023]`.
   *
   * Printed above the menu and not inside it, because the menu is a set of goals the reader may
   * choose between and this is the step the kernel computed. Collapsing them into one numbered list
   * would put a computed answer and six equal options at the same weight.
   */
  const leads = primaryAction(answerEnvelope ?? homeEnvelope);
  if (leads) {
    const route = leads.fallback?.skill ?? leads.fallback?.command;
    console.log(`\nNext: ${leads.label}${route ? `  (${route})` : ''}`);
  }

  /** The menu and every detail line come from the one gateway envelope `[UXH:AC-002]`. */
  const menu = homeEnvelope.next.filter((action) => answerEnvelope || action.id !== leads?.id);
  console.log('\nWhat is on your mind today?');
  menu.forEach((action, index) => {
    const route = action.fallback?.skill ?? action.fallback?.command;
    console.log(`${index + 1}. ${action.label} — ${message(action.reasonCode).label}${route ? ` · ${route}` : ''}`);
  });
  const warnings = [...homeEnvelope.warnings, ...(answerEnvelope?.warnings ?? [])];
  if (answerEnvelope?.why?.some((entry) => entry.code === 'work.not-in-this-repository')) {
    warnings.push({ code: 'home.selection-stale', slots: { work: active?.id ?? 'unknown' } });
  }
  if (warnings.length) {
    console.log(`\nNotices:\n- ${warnings.map((entry) => message(entry.code, entry.slots).label).join('\n- ')}`);
  }
}

/** One context-preserving payload for JSON, Copilot, and editor adapters. */
export function compositeHomeEnvelope(homeEnvelope, answerEnvelope = null, conversation = null) {
  const envelope = answerEnvelope ?? homeEnvelope;
  const currentWork = homeEnvelope.data?.currentWork ?? homeEnvelope.data?.activeWork ?? null;
  const selectedSubject = currentWork
    ? { kind: currentWork.kind ?? 'story', id: currentWork.id }
    : null;
  const selectionStale = answerEnvelope?.why?.some((entry) => entry.code === 'work.not-in-this-repository')
    ? { code: 'HOME_SELECTION_STALE', subject: selectedSubject }
    : null;
  return {
    ...envelope,
    data: {
      ...envelope.data,
      home: homeEnvelope.data,
      answer: answerEnvelope?.data ?? null,
      selectedSubject,
      ...(selectionStale ? { selectionStale } : {}),
      ...(conversation ? { conversation } : {})
    }
  };
}

export async function run(_argv, { options }) {
  const workspaceReference = optionString(options, 'workspace');
  const request = optionString(options, 'request');
  const conversation = request ? planDeveloperConversation(request) : null;
  const selection = await homeRepository(workspaceReference, { allowMissing: !workspaceReference });
  const root = selection?.root ?? null;
  const context = selection?.context ?? { workspaceId: null, workspaceName: null, storyId: null };
  const selected = selection?.selected ?? null;
  const identityRoot = root ?? process.cwd();
  const resolvedActor = identity(identityRoot, { offline: true });
  const actor = { ...resolvedActor, name: localGitDisplayName(identityRoot) ?? resolvedActor.name };
  const bootstrap = root ? null : await import('../workspace-bootstrap.mjs')
    .then(({ latestWorkspaceBootstrap }) => latestWorkspaceBootstrap())
    .catch(() => null);

  /**
   * One session ID for this invocation, and it is not reused.
   *
   * Handles are session-bound. A CLI process is a session that ends when it exits, so a fresh ID
   * per run is the honest binding — a stable one would let a handle printed by one `sflow home`
   * verify against a later one, in a different working tree, minutes apart.
   */
  const hostSessionId = optionString(options, 'host-session') ?? `cli_${randomUUID()}`;
  const { kernel } = createHostGateway({
    root,
    hostSessionId,
    // The CLI is the host that has all of them.
    planners: gatewayPlanners(),
    plannerContext: {
      // Personalization and authority remain separate inside the host binding.
      workspace: context.workspaceId ? { id: context.workspaceId, name: context.workspaceName } : null,
      repositoryId: selected?.id ?? null,
      branch: selected?.branch ?? null,
      storyId: context.storyId ?? null,
      workId: context.storyId ?? null,
      workKind: context.storyId ? 'story' : null,
      repository: {
        id: selected?.id ?? null,
        path: root,
        branch: selected?.branch ?? null,
        head: selected?.head ?? null,
        resolvedFrom: workspaceReference ? 'workspace-option' : 'active-workspace'
      },
      bootstrap
    },
    workspaceId: context.workspaceId ?? null
  });

  /**
   * Resolve, then read the handle resolution issued — the whole path, not a shortcut into it.
   *
   * Calling the planner directly would produce the same content and prove nothing: the point of
   * wiring the gateway is that a surface asks in words, gets back an opaque handle bound to the
   * world it was computed against, and hands that handle back to be revalidated before anything is
   * served `[INT:REQ-032]` `[INT:REQ-036]`. This is the first place in the product that happens.
   *
   * The utterance rather than `goalHint: 'home'`: three operations claim the `home` goal, so a goal
   * hint alone is honestly ambiguous and comes back as candidates. A phrase match is not — which is
   * `[INT:CON-036]` working as designed rather than an inconvenience to route around.
   */
  const resolution = await kernel.resolve({ utterance: 'home' });
  const homeEnvelope = resolution.next.length === 1 && resolution.kind === 'read'
    ? await kernel.read({ resolutionId: resolution.next[0].handle })
    : resolution;

  /**
   * Read-only conversational routes may be answered immediately.
   *
   * The route still goes back through resolve/read with the active Work ID from durable Home. A
   * mutation-shaped request remains a proposal in `data.conversation`; natural language never
   * becomes mutation consent.
   */
  let answerEnvelope = null;
  if (request && conversation?.route?.automatic) {
    const selectedWork = homeEnvelope.data?.activeWork ?? null;
    const workId = selectedWork?.id
      ?? homeEnvelope.next.find((entry) => entry.slots?.work)?.slots?.work
      ?? null;
    const workOperations = new Set(['work.continue', 'work.return', 'work.readiness']);
    const routed = kernel.resolve({
      utterance: request,
      arguments: workOperations.has(conversation.route.operationId) && workId
        ? { workId, ...(selectedWork?.kind ? { workKind: selectedWork.kind } : {}) }
        : {}
    });
    answerEnvelope = routed.next.length === 1 && routed.kind === 'read'
      ? await kernel.read({ resolutionId: routed.next[0].handle })
      : routed;
  }

  const envelope = compositeHomeEnvelope(homeEnvelope, answerEnvelope, conversation);

  if (optionBoolean(options, 'json')) {
    return console.log(JSON.stringify({
      ...envelope
    }, null, 2));
  }
  render(homeEnvelope, answerEnvelope, { context, selected, actor }, conversation);
}
