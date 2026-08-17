/**
 * `sflow home` — the first command served by the gateway kernel.
 *
 * Two shapes come back from one read, and the relationship between them is the point `[UXH:C2]`:
 * `sflow-result` v2 is the transport, `home.overview` is the operation, and the developer-home
 * projection is a thin adapter carried in `data`. Neither of the two bespoke spec types is
 * introduced as a second envelope — a surface that wants the rich briefing reads `data.briefing`,
 * and a surface that only knows the envelope still gets `outcome`, `why[]`, `preserved[]` and
 * `next[]` and can render something honest without knowing what a home is.
 *
 * The human render deliberately reads the *envelope* for its next action rather than the projection,
 * so the one legal next step on the terminal is the same field the sidebar's filled button will
 * read `[UXH:AC-002]`. Two surfaces computing "what leads" independently is how they come to
 * disagree, and the disagreement is invisible until someone screenshots both.
 */
import { randomUUID } from 'node:crypto';

import { createHostGateway } from '../gateway/host.mjs';
import { planDeveloperConversation } from '../gateway/conversation.mjs';
import { gatewayPlanners } from '../gateway/planners/index.mjs';
import { developerHome, homeRepository } from '../developer-home.mjs';
import { message } from '../gateway/messages.mjs';
import { primaryAction } from '../gateway/result.mjs';
import { optionBoolean, optionString } from '../util.mjs';

function renderConversation(conversation, projection) {
  if (!conversation) return;
  const current = projection.context.activeStory;
  console.log('\nI found');
  console.log(current
    ? `${current.id}${current.title ? ` — ${current.title}` : ''}${current.phase ? ` · ${current.phase}` : ''}`
    : `${projection.context.workspace.name} · no current governed work on this branch`);

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

function render(envelope, projection, conversation = null) {
  const { context, actor, briefing, choices, notices } = projection;
  console.log(`Singularity Flow home — ${context.workspace.name}`);
  console.log(`Actor: ${actor.name}${actor.email ? ` <${actor.email}>` : ''}`);
  console.log(`Repository: ${context.repository.repositoryId} · ${context.repository.branch} @ ${(context.repository.head ?? 'unavailable').slice(0, 12)}`);
  console.log(`Freshness: ${context.freshness.capturedAt} · local only`);
  if (projection.personalization?.replyName) console.log(`\nHello, ${projection.personalization.replyName}.`);
  console.log(`\n${briefing.headline}`);
  renderConversation(conversation, projection);

  /**
   * The one legal next action, named as one thing `[UXH:REQ-023]`.
   *
   * Printed above the menu and not inside it, because the menu is a set of goals the reader may
   * choose between and this is the step the kernel computed. Collapsing them into one numbered list
   * would put a computed answer and six equal options at the same weight.
   */
  const leads = primaryAction(envelope);
  if (leads) {
    const route = leads.fallback?.skill ?? leads.fallback?.command;
    console.log(`\nNext: ${leads.label}${route ? `  (${route})` : ''}`);
  }

  /**
   * The menu comes from the envelope; the projection supplies the detail line. `[UXH:AC-002]`
   *
   * This printed `projection.choices` — four items — directly below the kernel's own six, which is
   * two independent answers to "what can I do", rendered one above the other, in the command whose
   * whole purpose is to show that a surface reads the kernel rather than deriving in parallel.
   *
   * The fix is not to pick a winner: both computations had something. The envelope decides *which*
   * choices exist and in what order — that is `home-overview` and `[DHR:REQ-070]`'s ordering — and
   * the projection is consulted for what each one says about this repository right now. A choice
   * the projection knows nothing about still renders, from its own reason code, because a menu that
   * silently drops the kernel's entries is the disagreement wearing a different hat.
   */
  const detail = new Map(choices.map((choice) => [choice.id.replaceAll(':', '.'), choice.detail]));
  const menu = envelope.next.filter((action) => action.id !== leads?.id);
  console.log('\nWhat is on your mind today?');
  menu.forEach((action, index) => {
    /**
     * The projection's sentence when it has one for this choice, the catalog's when it does not.
     *
     * The two carry different things: the projection knows "0 visible governed work item(s)" about
     * *this* repository right now, and the catalog knows what the choice means in general. Neither
     * is a fallback for the other being broken — a choice with no projection entry is a choice the
     * projection does not track, which is a fact about coverage rather than a failure.
     */
    const goal = action.id.replace(/^home:/, '');
    const route = action.fallback?.skill ?? action.fallback?.command;
    console.log(`${index + 1}. ${action.label} — ${detail.get(goal) ?? message(action.reasonCode).label}${route ? ` · ${route}` : ''}`);
  });
  if (notices.length) console.log(`\nNotices:\n- ${notices.join('\n- ')}`);
}

export async function run(_argv, { options }) {
  const workspaceReference = optionString(options, 'workspace');
  const request = optionString(options, 'request');
  const conversation = request ? planDeveloperConversation(request) : null;
  const projection = await developerHome({
    workspaceReference,
    hostSession: optionString(options, 'host-session')
  });
  // The same resolution the projection used, for the one field it is not allowed to carry.
  const { root } = await homeRepository(workspaceReference);

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
      // Personalization is specifically local `git config user.name`; authority still uses the
      // full resolved actor carried separately by the projection and gateway binding.
      actor: { ...projection.actor, name: projection.personalization?.displayName ?? null },
      workspace: projection.context.workspace,
      repositoryId: projection.context.repository.repositoryId,
      branch: projection.context.repository.branch,
      storyId: projection.context.activeStory?.id ?? null
    },
    workspaceId: projection.context.workspace.id ?? null
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
  const envelope = resolution.next.length === 1 && resolution.kind === 'read'
    ? await kernel.read({ resolutionId: resolution.next[0].handle })
    : resolution;

  if (optionBoolean(options, 'json')) {
    // The envelope is the document; the projection rides inside it rather than beside it.
    return console.log(JSON.stringify({
      ...envelope,
      data: { ...envelope.data, home: projection, ...(conversation ? { conversation } : {}) }
    }, null, 2));
  }
  render(envelope, projection, conversation);
}
