/**
 * `story target-origin`: pin the authorized browser target origin to a Story started without one.
 *
 *   singularity-flow story target-origin [WORK-ID] --url AUTHORIZED-URL [--fetch] [--json]
 *   singularity-flow story target-origin [WORK-ID] --url AUTHORIZED-URL --reason TEXT --confirm sha256:DIGEST [--json]
 *
 * Story start pins this origin from --target-url (src/state.mjs), and a step whose MCP policy requires
 * a live smoke can never be prepared, published or submitted without it (assertMcpPhaseReadiness).
 * The preview changes nothing and names the digest of exactly what would be pinned, from this exact
 * Story revision. Confirming that digest records the origin for every server those steps smoke-check,
 * with who pinned it, through which approval group and why, in one Story commit.
 *
 * The origin is a security boundary, so this only fills one the Story lacks: a pinned origin is never
 * replaced or widened, and a pin that would make already recorded browser evidence invalid is refused.
 * The person confirming must be in a group that approves one of those steps, and the Copilot guard
 * refuses the confirmation in every turn, like approve: an agent may preview it, never pin it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { head, repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { verifyMcpEvidence } from '../mcp-evidence.mjs';
import { authorizedMcpOrigins, mcpTargetOriginSteps, normalizeMcpTargetOrigin } from '../mcp-target.mjs';
import { action as narrationAction, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { loadSession } from '../session.mjs';
import { workDir } from '../story-paths.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { testRunRiskAuthorities } from '../test-run-risk.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';

const OPTIONS = Object.freeze(['url', 'reason', 'confirm', 'work-id', 'fetch', 'json']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** The Story with `servers` authorized for `origin` by `record`, every other authorization unchanged. */
function withPins(workflow, servers, record) {
  return { ...workflow, mcpAuthorizations: {
    ...(workflow.mcpAuthorizations ?? {}),
    ...Object.fromEntries(servers.map((server) => [server, structuredClone(record)]))
  } };
}

/**
 * What pinning `url` to this Story would record, and the digest a person confirms it by. Refuses a
 * Story with no step that needs an origin, and any server already authorized for another origin.
 */
export function targetOriginPlan(workflow, url, { revision }) {
  const id = workflow.workItem.id;
  const origin = normalizeMcpTargetOrigin(url, { required: true, label: 'The authorized target URL' });
  const steps = mcpTargetOriginSteps((workflow.phaseOrder ?? []).map((phaseId) => workflow.phases?.[phaseId]).filter(Boolean));
  if (!steps.length) {
    throw new SingularityFlowError(`No step of Story ${id} smoke-checks a browser against an authorized origin, so it has no target origin to pin.`,
      { code: 'STORY_TARGET_ORIGIN_NOT_NEEDED' });
  }
  const servers = [...new Set(steps.flatMap((step) => step.servers))];
  const pinned = Object.fromEntries(servers.map((server) => [server, authorizedMcpOrigins(workflow, server)]));
  const other = servers.find((server) => pinned[server].length && !pinned[server].includes(origin));
  if (other) {
    throw new SingularityFlowError(
      `Story ${id} already authorizes ${pinned[other].join(', ')} for MCP server '${other}'. A pinned origin is never replaced or widened; start a new Story with --target-url to test a different target.`,
      { code: 'STORY_TARGET_ORIGIN_ALREADY_PINNED' });
  }
  const missing = servers.filter((server) => !pinned[server].length);
  if (!missing.length) {
    throw new SingularityFlowError(`Story ${id} already authorizes ${origin} for ${servers.join(', ')}; there is nothing to pin.`,
      { code: 'STORY_TARGET_ORIGIN_ALREADY_PINNED' });
  }
  const authorities = [...new Set(steps.flatMap((step) => testRunRiskAuthorities(workflow, step.phase)))].sort();
  const plan = { workId: id, origin, servers: missing, steps: steps.map((step) => step.phase), authorities, revision };
  return { ...plan, planSha256: `sha256:${recordSha256(plan)}` };
}

/** Errors a pin would add to the Story's recorded MCP evidence: none, or the pin is refused. */
async function evidenceConflicts(root, config, workflow, servers, record) {
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const before = new Set((await verifyMcpEvidence(root, workflow, { itemDirectory })).errors);
  return (await verifyMcpEvidence(root, withPins(workflow, servers, record), { itemDirectory })).errors
    .filter((error) => !before.has(error));
}

function confirmCommand(plan) {
  return `singularity-flow story target-origin ${plan.workId} --url ${plan.origin} --reason <REASON> --confirm ${plan.planSha256}`;
}

export async function storyTargetOriginCommand(positionals, options) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.includes(key));
  if (unknown.length || positionals.length > 3) {
    throw new SingularityFlowError('Use: singularity-flow story target-origin [WORK-ID] --url AUTHORIZED-URL [--reason TEXT --confirm sha256:DIGEST] [--json]',
      { code: 'STORY_TARGET_ORIGIN_USAGE' });
  }
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  // The Story's own branch, which need not be named after its ID.
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; a target origin is pinned while it is in progress.`, { code: 'STORY_TARGET_ORIGIN_STORY_CLOSED' });
  }
  const url = optionString(options, 'url');
  if (!url) throw new SingularityFlowError('Name the authorized target with --url AUTHORIZED-URL: HTTPS, or HTTP on this machine (loopback).', { code: 'STORY_TARGET_ORIGIN_USAGE' });
  const plan = targetOriginPlan(workflow, url, { revision: head(root) });
  const confirm = optionString(options, 'confirm') ?? null;
  const json = optionBoolean(options, 'json');
  if (!confirm) {
    const conflicts = await evidenceConflicts(root, config, workflow, plan.servers, { origins: [plan.origin] });
    if (!json) {
      console.log(`Preview: pin ${plan.origin} to Story ${id} for MCP server ${plan.servers.join(', ')}, which ${plan.steps.join(', ')} smoke-checks.`);
      console.log(plan.authorities.length
        ? `Who confirms it: a person in ${plan.authorities.join(' or ')}, in their own terminal. Plan: ${plan.planSha256}`
        : 'Nobody can confirm it: no step that needs it, nor any later step, has an approval group.');
      if (conflicts.length) console.log(`It would be refused: recorded browser evidence would become invalid:\n- ${conflicts.join('\n- ')}`);
      else if (plan.authorities.length) console.log(`Confirm: ${confirmCommand(plan)}`);
    }
    const confirmable = !conflicts.length && plan.authorities.length > 0;
    emitCommandResult(commandResult({
      operation: { id: 'story.target-origin.preview', classification: 'read' },
      subject: { kind: 'story', id },
      outcome: succeeded('story.target-origin.previewed', { origin: plan.origin }),
      effects: noEffects(),
      next: confirmable ? [narrationAction({
        id: 'story.target-origin.confirm', command: confirmCommand(plan), rank: 'NOW', kind: 'review',
        label: `A person in ${plan.authorities.join(' or ')} confirms the pin, with their reason, in their own terminal.`
      })] : [],
      data: { ...plan, evidenceConflicts: conflicts, confirmCommand: confirmable ? confirmCommand(plan) : null }
    }), { json, postState: workflow });
    return;
  }
  if (!DIGEST.test(confirm)) throw new SingularityFlowError('--confirm takes the preview\'s plan digest: sha256:<64 hexadecimal characters>.', { code: 'STORY_TARGET_ORIGIN_USAGE' });
  if (confirm !== plan.planSha256) {
    throw new SingularityFlowError(`This pin is not the one previewed, or the Story changed since. Run singularity-flow story target-origin ${id} --url ${plan.origin} again and confirm the digest it names.`,
      { code: 'STORY_TARGET_ORIGIN_CONFIRMATION_STALE', details: { supplied: confirm, expected: plan.planSha256,
        recoveryCommand: `singularity-flow story target-origin ${id} --url ${plan.origin}` } });
  }
  const reason = String(optionString(options, 'reason') ?? '').trim();
  if (!reason || reason.length > 2000) {
    throw new SingularityFlowError('Say why this origin is the authorized target with --reason TEXT (at most 2000 characters).', { code: 'STORY_TARGET_ORIGIN_USAGE' });
  }
  if (!plan.authorities.length) {
    throw new SingularityFlowError(`No step of Story ${id} that needs a target origin, nor any later step, has an approval group, so nobody can pin one.`,
      { code: 'STORY_TARGET_ORIGIN_AUTHORITY_UNAVAILABLE' });
  }
  const actor = actionActor(root);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: plan.authorities, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const at = nowIso();
  const record = {
    schemaVersion: currentSchemaVersion('mcp-authorization'),
    origins: [plan.origin], source: 'story-target-origin', pinnedAt: at,
    pinnedBy: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, reason, planSha256: plan.planSha256
  };
  const conflicts = await evidenceConflicts(root, config, workflow, plan.servers, record);
  if (conflicts.length) {
    throw new SingularityFlowError(`Pinning ${plan.origin} would make this Story's recorded browser evidence invalid, so nothing was pinned:\n- ${conflicts.join('\n- ')}`,
      { code: 'STORY_TARGET_ORIGIN_EVIDENCE_CONFLICT', details: { errors: conflicts } });
  }
  const { publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'target-origin' }
    },
    `[${id}][target-origin] ${plan.origin}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'pin an authorized target origin');
      aggregate.mcpAuthorizations = withPins(aggregate, plan.servers, record).mcpAuthorizations;
      aggregate.history.push({
        at, actor: record.pinnedBy, agent, event: 'mcp_target_origin_pinned', phase: aggregate.currentPhase ?? null,
        detail: `${plan.origin} authorized for ${plan.servers.join(', ')} (${plan.steps.join(', ')}), pinned through ${record.authorityGroup}. ${reason}`
      });
      return record;
    },
    {
      eventFromResult: () => ({
        actor, agent, authorityGroup: record.authorityGroup, identityAssurance: record.identityAssurance,
        payload: { decision: 'target-origin', origin: plan.origin, servers: plan.servers, reviewPacketSha256: null }
      })
    }
  );
  if (!json) {
    console.log(`Pinned ${plan.origin} to Story ${id} for ${plan.servers.join(', ')}, through ${record.authorityGroup}. Smoke receipts and browser evidence for any other origin are refused.`);
    console.log(publication.pushed
      ? `Committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'story.target-origin', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('story.target-origin.pinned', { origin: plan.origin }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    next: [
      ...plan.servers.map((server, index) => narrationAction({
        id: `story.target-origin.smoke.${index + 1}`, command: `singularity-flow mcp smoke ${server} --url ${plan.origin}`,
        rank: index === 0 ? 'NOW' : 'SOON', kind: 'remediation',
        label: `Run a live smoke of ${server} against the pinned origin before ${plan.steps.join(', ')}.`
      })),
      narrationAction({ id: 'story.target-origin.next', command: `singularity-flow nextsteps ${id}`, rank: 'SOON',
        label: 'See what the Story needs next.' })
    ],
    data: { commit: publication.sha, pushed: publication.pushed, record, servers: plan.servers }
  }), { json, postState: workflow });
}
