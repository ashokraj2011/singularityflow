/**
 * `decision finding-risk`: a person accepts one lint, static-analysis or security finding a code step
 * keeps (a vulnerable package the Story added among them), or a scanner that cannot run here, which blocks
 * nothing but may be recorded as accepted, or revokes such a decision [CQF:REQ-047, REQ-052].
 * See src/finding-risk.mjs.
 *
 *   singularity-flow decision finding-risk [WORK-ID] --phase PHASE --finding F-ID [--fingerprint sha256:... --rule RULE --tool TOOL [--tool-version V] [--kind KIND]] --reason TEXT --expires YYYY-MM-DD
 *   singularity-flow decision finding-risk [WORK-ID] --revoke FRK-001 --reason TEXT
 *
 * The finding is the one this checkout's latest run reported, or the step's recorded findings; on
 * another checkout the refusal's command names its fingerprint, rule, tool and version instead. The
 * Copilot guard refuses this command, like test-risk: an agent may name the route, never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { findingRiskAuthorities, recordFindingRisk, recordFindingRiskRevocation } from '../finding-risk.mjs';
import { FINDING_KINDS } from '../findings/model.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';

const FINDING_ID = /^F-[0-9a-f]{16}$/u;

/** The finding named `findingId` on `phaseId`: the latest run here, else the step's recorded evidence, else the scanners' own. */
async function knownFinding(root, workflow, phaseId, findingId) {
  const { stepFindingRuns } = await import('../findings/runs.mjs');
  const runs = await stepFindingRuns(root, workflow.workItem.id, phaseId);
  for (const run of [...runs].reverse()) {
    const found = (run.findings ?? []).find((finding) => finding.id === findingId);
    if (found) return found;
  }
  const evidence = workflow.phases?.[phaseId]?.deliveryEvidence ?? {};
  for (const record of [evidence.submittedFindings, evidence.qualityFindings]) {
    const found = (record?.findings ?? []).find((finding) => finding.id === findingId);
    if (found) return found;
  }
  const { loopFindingCommands, scannerUnavailableFinding } = await import('../findings/code-step.mjs');
  const { normalizeExternalCommand, findingCommand } = await import('../external-command-policy.mjs');
  const commands = [...loopFindingCommands(workflow.phases?.[phaseId]?.qualityCommands ?? []),
    ...(workflow.phases?.[phaseId]?.qualityCommands ?? []).map((command, index) => { try { return normalizeExternalCommand(command, index); } catch { return null; } })
      .filter((command) => command && findingCommand(command) && command.sonarqube)];
  return commands.map(scannerUnavailableFinding).find((finding) => finding.id === findingId) ?? null;
}

/** The finding as the options name it on another checkout: its id must be the fingerprint's. */
function namedFinding(findingId, options) {
  const fingerprint = optionString(options, 'fingerprint') ?? null;
  if (!fingerprint) return null;
  if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint) || `F-${fingerprint.slice(7, 23)}` !== findingId) {
    throw new SingularityFlowError('--fingerprint takes the sha256:... digest the refusal named, and must belong to --finding.', { code: 'FINDING_RISK_INVALID' });
  }
  const bounded = (name, maximum) => { const value = optionString(options, name) ?? null; return value == null ? null : value.slice(0, maximum); };
  const rule = bounded('rule', 256);
  const tool = bounded('tool', 128);
  const kind = bounded('kind', 32);
  if (!tool) throw new SingularityFlowError('Name the tool the refusal gave with --tool, beside --fingerprint.', { code: 'FINDING_RISK_INVALID' });
  if (kind && !FINDING_KINDS.includes(kind)) throw new SingularityFlowError(`--kind is one of ${FINDING_KINDS.join(', ')}.`, { code: 'FINDING_RISK_INVALID' });
  return { id: findingId, fingerprint, rule: rule === 'none' ? null : rule, tool, toolVersion: bounded('tool-version', 64), kind };
}

/**
 * One finding risk decision, or the revocation named by `revoke`, ready to write into a transaction:
 * checked for its finding and for authority.
 */
export async function findingRiskDecisionPart(root, config, workflow, { phaseId, revoke = null, finding = null, reason = '', expires = null }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const target = revoke ? (workflow.findingRisks ?? []).find((entry) => !entry.revokes && entry.id === revoke) ?? null : null;
  const groups = findingRiskAuthorities(workflow, phaseId, revoke ? { kind: target?.kind ?? null, feed: target?.security ? 'security' : null } : finding);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can accept its findings.`, { code: 'RISK_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke ? recordFindingRiskRevocation(aggregate, { riskId: revoke, ...common })
    : recordFindingRisk(aggregate, { phaseId, finding, expires, ...common });
  decide(structuredClone(workflow));
  return {
    decision: 'finding-risk', phaseId, authority,
    message: `[${id}][finding-risk:${revoke ? 'revoke' : 'accept'}] ${revoke ?? `${phaseId} ${finding.id}`}`,
    write(aggregate) {
      const recorded = decide(aggregate);
      aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'risk_decided', phase: phaseId,
        detail: recorded.revokes ? `${recorded.revokes} on ${recorded.phase} revoked. ${recorded.reason}`
          : `${recorded.id} accepts ${recorded.tool} ${recorded.rule ?? ''} finding ${recorded.findingId ?? recorded.fingerprint}${recorded.file ? ` in ${recorded.file}` : ''} for ${recorded.phase} until ${recorded.expiresAt.slice(0, 10)}. ${recorded.reason}` });
      return recorded;
    }
  };
}

export async function decisionFindingRiskCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; risks are decided while it is in progress.`, { code: 'RISK_STORY_CLOSED' });
  }
  const revoke = optionString(options, 'revoke') ?? null;
  const requestedPhase = optionString(options, 'phase') ?? null;
  if (!revoke === !requestedPhase) {
    throw new SingularityFlowError('Name the step with --phase PHASE and the finding with --finding F-..., or a decision to revoke with --revoke FRK-...', { code: 'FINDING_RISK_INVALID' });
  }
  const target = revoke ? (workflow.findingRisks ?? []).find((entry) => !entry.revokes && entry.id === revoke) ?? null : null;
  if (revoke && !target) throw new SingularityFlowError(`This Story has no finding risk decision ${revoke}.`, { code: 'FINDING_RISK_UNKNOWN' });
  const phaseId = revoke ? target.phase : requestedPhase;
  if (!workflow.phases?.[phaseId]) throw new SingularityFlowError(`Story ${id} has no step ${phaseId}.`, { code: 'FINDING_RISK_INVALID' });
  let finding = null;
  if (!revoke) {
    const findingId = optionString(options, 'finding') ?? '';
    if (!FINDING_ID.test(findingId)) throw new SingularityFlowError('Name the finding with --finding F-... as its refusal or review gave it.', { code: 'FINDING_RISK_INVALID' });
    // What this checkout recorded of the finding wins over what the options say of it, so a kind given
    // on the command line can never move a security finding away from its security reviewers [decision 10].
    const named = namedFinding(findingId, options);
    finding = await knownFinding(root, workflow, phaseId, findingId) ?? named;
    if (!finding) {
      throw new SingularityFlowError(`No finding ${findingId} is recorded for ${phaseId} in this checkout. Run the command its refusal gave, with --fingerprint, --rule and --tool.`,
        { code: 'FINDING_RISK_NOT_FOUND' });
    }
  }
  const actor = actionActor(root);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const part = await findingRiskDecisionPart(root, config, workflow, { phaseId, revoke, finding,
    reason: optionString(options, 'reason') ?? '', expires: optionString(options, 'expires') ?? null }, { actor, agent });
  const { value: record, publication } = await transactStory(root, config, workflow,
    { type: LIFECYCLE_EVENT.DECISION_MADE, phaseId, generation: null, actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'finding-risk' } },
    part.message,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a finding risk decision');
      return part.write(aggregate);
    },
    { eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'finding-risk', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null } }) });
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes ? `Revoked ${record.revokes} on ${record.phase}.`
      : `Recorded ${record.id}: ${record.phase} may keep ${record.tool} ${record.rule ?? ''} finding ${record.findingId ?? record.fingerprint} until ${record.expiresAt.slice(0, 10)}, accepted through ${record.authorityGroup}. The same finding from another rule, tool or tool version is not covered.`);
    console.log(publication.pushed ? `Decision committed and pushed.`
      : `Decision committed locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.finding-risk', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.finding-risk.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
