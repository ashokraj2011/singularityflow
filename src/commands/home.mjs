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
import { gatewayPlanners } from '../gateway/planners/index.mjs';
import { developerHome, homeRepository } from '../developer-home.mjs';
import { primaryAction } from '../gateway/result.mjs';
import { optionBoolean, optionString } from '../util.mjs';

function render(envelope, projection) {
  const { context, actor, briefing, choices, notices } = projection;
  console.log(`Singularity Flow home — ${context.workspace.name}`);
  console.log(`Actor: ${actor.name}${actor.email ? ` <${actor.email}>` : ''}`);
  console.log(`Repository: ${context.repository.repositoryId} · ${context.repository.branch} @ ${(context.repository.head ?? 'unavailable').slice(0, 12)}`);
  console.log(`Freshness: ${context.freshness.capturedAt} · local only`);
  console.log(`\n${briefing.headline}`);

  /**
   * The one legal next action, named as one thing `[UXH:REQ-023]`.
   *
   * Printed above the menu and not inside it, because the menu is a set of goals the reader may
   * choose between and this is the step the kernel computed. Collapsing them into one numbered list
   * would put a computed answer and six equal options at the same weight.
   */
  const leads = primaryAction(envelope);
  if (leads) console.log(`\nNext: ${leads.label}${leads.fallback?.command ? `  (${leads.fallback.command})` : ''}`);

  console.log('\nWhat is on your mind today?');
  choices.forEach((choice, index) => console.log(`${index + 1}. ${choice.label} — ${choice.detail}`));
  if (notices.length) console.log(`\nNotices:\n- ${notices.join('\n- ')}`);
}

export async function run(_argv, { options }) {
  const workspaceReference = optionString(options, 'workspace');
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
    return console.log(JSON.stringify({ ...envelope, data: { ...envelope.data, home: projection } }, null, 2));
  }
  render(envelope, projection);
}
