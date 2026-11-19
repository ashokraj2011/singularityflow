/**
 * `story approvers refresh`: add to a running Story's approval groups the people its approved
 * configuration now lists in them (2026-10-29).
 *
 * The groups are fixed when a Story starts, so a group that was empty then, or whose only approver
 * left, could never gain anyone and the Story could not finish. The configuration change itself is
 * governed (a people/approvals proposal merged into the configuration branch); the refresh only
 * carries its added members into the Story, as one accepted snapshot revision
 * (approver-refresh-contracts.mjs), after a person in one of the refreshed groups reviews the exact
 * additions in their own terminal. Removals and every other policy change are never applied.
 *
 * A refresh changes the policy digest that phase appeals and quality-risk decisions bind, so it is
 * refused while one of those would still be checked: an undecided appeal of the current open
 * generation (deciding it re-derives the binding), or a quality risk, finding dispute or artifact
 * risk that is neither revoked nor expired (the gates re-check each one against the current policy).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { matchApprovalAuthority } from './approval-authority.mjs';
import { captureTerminalActionAuthorization, consumeActionAuthorization } from './action-authorization.mjs';
import { approverRefreshAdditions, applyApproverRefresh, approverRefreshDigest, approverRefreshPolicyDigest,
  approverRefreshSummary } from './approver-refresh-contracts.mjs';
import { approvedStoryApprovalAuthorities } from './configuration-branch.mjs';
import { workDirRelative } from './story-paths.mjs';
import { head, identity } from './git.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { canonicalJson } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { adoptConfigurationWithoutAncestry, captureSkillConfigurationAncestry } from './skp-amendment-audit.mjs';
import { actorKey, transactStory } from './state-stores.mjs';
import { prospectiveTestCommandAmendments as PROSPECTIVE } from './test-command-amendment-contracts.mjs';
import { approverRefreshDecisionPath, captureWorkflowApproverRefresh, verifyWorkflowSnapshot } from './workflow-snapshots.mjs';
import { nowIso, secureRepositoryPath, SingularityFlowError, writeText } from './util.mjs';
import { mkdir } from 'node:fs/promises';

const fail = (message, code = 'APR_REFRESH_REFUSED', details = undefined) => {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
};
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

/** The appeal, risk and dispute records a refresh would make stale, each with its way out. */
async function staleningRecords(root, config, workflow, at) {
  const records = [];
  if (workflow.phaseAppeals?.length) {
    const { phaseAppealStatus } = await import('./phase-appeals.mjs');
    for (const appeal of (await phaseAppealStatus(root, config, workflow)).items) {
      if (appeal.relevant && !appeal.decision) {
        records.push({ id: appeal.id, kind: 'phase-appeal', command: `singularity-flow appeal show ${appeal.id} --json`,
          words: `appeal ${appeal.id} is waiting for a decision; decide it first` });
      }
    }
  }
  const decisions = workflow.qualityRiskDecisions ?? [];
  const revoked = new Set(decisions.filter((entry) => entry.revokes).map((entry) => entry.revokes));
  for (const entry of decisions) {
    if (entry.revokes || revoked.has(entry.id) || Date.parse(entry.expiresAt) <= Date.parse(at)) continue;
    // The revocation confirms the record it ends: the same digest `appeal risk-revoke` checks (phase-quality-risk.mjs).
    const decision = `sha256:${createHash('sha256').update(canonicalJson(entry)).digest('hex')}`;
    records.push({ id: entry.id, kind: 'quality-risk', command: `singularity-flow appeal risk-revoke ${entry.id} --confirm ${decision} --reason "<why>"`,
      words: `${entry.id} (${entry.gate ?? 'accepted risk'}) is still in force until ${String(entry.expiresAt).slice(0, 10)}; revoke it or let it lapse` });
  }
  return records;
}

// Ancestry refusals an approver answers by adopting the configuration without ancestry (D9).
const ADOPTABLE = new Map([['SKP_AMENDMENT_ANCESTRY_REWRITTEN', 'sflow-config-rewritten'],
  ['SKP_AMENDMENT_ANCESTRY_LIMIT', 'ancestry-beyond-proof-limit']]);
const quotedReason = (reason) => `"${reason.replaceAll('"', '\\"')}"`;

/**
 * The refresh's configuration ancestry: proven, or, when sflow/config was rewritten outside SFlow and
 * the approver confirmed adopting it (`--adopt-without-ancestry`, part of the plan they confirm),
 * recorded as adopted without ancestry, confirmed by that approver (D9).
 */
async function refreshAncestry(candidate, snapshot, source) {
  try {
    return await captureSkillConfigurationAncestry(snapshot, source);
  } catch (error) {
    const cause = ADOPTABLE.get(error?.code);
    if (!cause || !candidate.adoptWithoutAncestry) {
      if (cause) {
        error.details = { ...(error.details ?? {}), nextAction: { command: adoptionCommand(candidate, { confirm: false }),
          label: 'An approver adopts it without ancestry, in their own terminal' } };
      }
      throw error;
    }
    return adoptConfigurationWithoutAncestry(snapshot, source, { cause, confirmedBy: candidate.actor });
  }
}

/** The refresh as previewed, confirmed in the person's own terminal: the whole command, its plan filled. */
const refreshCommand = (candidate) => `singularity-flow story approvers refresh ${candidate.workId} --reason ${quotedReason(candidate.reason)}`
  + `${candidate.adoptWithoutAncestry ? ' --adopt-without-ancestry' : ''} --confirm ${candidate.planSha256}`;
/** Who the refresh adds, by name: "a@x.test and b@x.test to developers". */
const additionWords = (additions) => Object.entries(additions ?? {}).map(([group, members]) => `${members
  .map((member) => member?.email ?? member?.githubLogin ?? 'a member').join(', ')} to ${group}`).join('; ');

function adoptionCommand(candidate, { confirm = true } = {}) {
  return `singularity-flow story approvers refresh ${candidate.workId} --reason ${quotedReason(candidate.reason)} --adopt-without-ancestry`
    + (confirm ? ` --confirm ${candidate.adoptionPlanSha256}` : '');
}

async function refreshCandidate(root, config, workflow, { approvedConfigurationSnapshot, reason, adoptWithoutAncestry = false } = {}) {
  const { storyPublicationPending } = await import('./state.mjs');
  if (await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false })) {
    fail('Publish or set aside the waiting Story commit before refreshing its approvers.', 'APR_PUBLICATION_PENDING');
  }
  if (workflow.status !== 'in_progress') {
    fail(`Story '${workflow.workItem.id}' is ${workflow.status}; only a running Story's approvers are refreshed.`, 'APR_STORY_NOT_RUNNING');
  }
  const text = String(reason ?? '').trim();
  if (text.length < 15 || text.length > 2000 || /[\x00-\x1f\x7f]/u.test(text)) {
    fail('Give a substantive --reason of 15–2000 ordinary characters for this refresh.', 'APR_REASON_REQUIRED');
  }
  const accepted = await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true, retainBytes: true });
  if (!accepted.enrolled || !same(accepted.policy, workflow.resolution)) fail('The current Story policy is not its exact accepted snapshot.', 'APR_REFRESH_STALE');
  const source = workflow.resolution.configurationSource;
  // One repository key (SCF:REQ-019): a clone reached by another spelling (ssh, https, a path) is the same authority.
  if (!approvedConfigurationSnapshot || !(await import('./git-repository-identity.mjs')).sameRepository(approvedConfigurationSnapshot.authority?.remote, source?.repository)) {
    fail('The approved configuration is not at the Story\'s own configuration authority.', 'APR_AUTHORITY_CHANGED');
  }
  if (approvedConfigurationSnapshot.sourceCommit === source?.commit) {
    fail('The approved configuration has not changed since this Story started, so it adds nobody. Propose the people first (singularity-flow configuration add-current-identity --target story:<group>), get it approved, then refresh.', 'APR_NOTHING_TO_ADD');
  }
  const { additions, ignored } = approverRefreshAdditions(workflow.resolution.approvalAuthorities,
    approvedStoryApprovalAuthorities(approvedConfigurationSnapshot));
  if (!Object.keys(additions).length) {
    fail('The approved configuration adds nobody to this Story\'s groups; removals and other changes are never applied to a running Story.', 'APR_NOTHING_TO_ADD', { ignored });
  }
  const at = nowIso();
  const blockers = await staleningRecords(root, config, workflow, at);
  const proposed = structuredClone(workflow.resolution);
  proposed.approvalAuthorities = applyApproverRefresh(workflow.resolution.approvalAuthorities, additions);
  proposed.configurationSource = { ...structuredClone(source), commit: approvedConfigurationSnapshot.sourceCommit, filesSha256: null };
  proposed.policySha256 = approverRefreshPolicyDigest(proposed);
  const live = identity(root);
  if (!actorKey(live)) fail('Refreshing approvers needs a configured Git email or login.', 'APR_IDENTITY_REQUIRED');
  const groups = Object.keys(proposed.approvalAuthorities);
  const match = matchApprovalAuthority(proposed.approvalAuthorities, { authorities: groups }, live);
  if (!match.authorized) {
    fail(`${actorKey(live)} is not in any of this Story's approval groups, even after the refresh, so cannot record it.`, 'APR_AUTHORITY_REQUIRED');
  }
  const from = { revision: workflow.workflowSnapshot.revision, snapshotHash: workflow.workflowSnapshot.snapshotHash,
    policySha256: workflow.resolution.policySha256, configurationCommit: source.commit };
  const to = { revision: from.revision + 1, policySha256: proposed.policySha256, configurationCommit: approvedConfigurationSnapshot.sourceCommit };
  const id = `APR-${String((workflow.approverRefreshes ?? []).length + 1).padStart(3, '0')}`;
  const core = { id, workId: workflow.workItem.id, from, to, additions, actor: actorKey(live), authorityGroup: match.authorityGroup,
    sourceHead: head(root), reason: text };
  // Adopting without ancestry is part of what the approver confirms, so it has its own plan digest (D9).
  const adoptionPlanSha256 = approverRefreshDigest({ ...core, adoption: 'without-ancestry' });
  return { ...core, planSha256: adoptWithoutAncestry ? adoptionPlanSha256 : approverRefreshDigest(core), adoptionPlanSha256,
    adoptWithoutAncestry: Boolean(adoptWithoutAncestry), ignored, blockers, proposed, match, at };
}

function preview(candidate, ancestry = null) {
  const blocked = candidate.blockers.length > 0;
  // Ancestry the apply would not find: the approver adopts the configuration without it, or the team upgrades first.
  const adopt = !blocked && ancestry?.adoptable && !candidate.adoptWithoutAncestry;
  const held = !blocked && ancestry && !ancestry.adoptable;
  const status = blocked || held ? 'blocked' : adopt ? 'needs-adoption' : 'ready';
  return { schemaVersion: 1, resultType: 'approver-refresh-preview', status,
    refreshId: candidate.id, workId: candidate.workId, planSha256: candidate.planSha256,
    additions: candidate.additions, notApplied: candidate.ignored, blockers: candidate.blockers,
    ...(ancestry ? { ancestry: { code: ancestry.code, cause: ancestry.cause ?? null, message: ancestry.message } } : {}),
    ...(candidate.adoptWithoutAncestry ? { adoptWithoutAncestry: true } : {}),
    from: candidate.from, to: candidate.to, recordedBy: { actor: candidate.actor, authorityGroup: candidate.authorityGroup },
    executed: false, stateChanged: false,
    legalActions: blocked ? candidate.blockers.map((entry) => ({ id: `resolve-${entry.id}`, command: entry.command, label: entry.words }))
      : held ? [{ id: 'upgrade-first', command: ancestry.nextAction?.command ?? null, label: ancestry.nextAction?.label ?? ancestry.message }]
      : adopt ? [{ id: 'adopt-without-ancestry', command: adoptionCommand(candidate),
        label: 'After reviewing the additions: adopt it without ancestry' }]
      : [{ id: 'refresh-approvers', command: refreshCommand(candidate),
        label: 'In your own terminal, after reviewing the added members: record the refresh' }] };
}

/**
 * The preview proves the ancestry the apply records, so it never says ready for a refresh the apply
 * would refuse (CH-F2). Only a refusal that is about ancestry changes the preview; a fetch that fails
 * leaves it to the apply, which checks again.
 */
async function previewAncestry(candidate, options, source) {
  if (candidate.blockers.length) return null;
  try { await captureSkillConfigurationAncestry(options.approvedConfigurationSnapshot, source); return null; }
  catch (error) {
    const cause = ADOPTABLE.get(error?.code);
    if (cause) {
      // Recording the adoption needs the newer proof format that the repository's minimum build must read.
      const adoptable = error.code !== 'SKP_AMENDMENT_ANCESTRY_REWRITTEN' || error.details?.v2Readable !== false;
      return { code: error.code, cause, message: error.message, adoptable,
        ...(adoptable ? {} : { nextAction: { command: 'singularity-flow workspace refresh-configuration',
          label: 'Upgrade this repository to this build, then preview again' } }) };
    }
    if (error?.code === 'SKP_AMENDMENT_ANCESTRY_UPGRADE_REQUIRED') {
      return { code: error.code, message: error.message, adoptable: false, nextAction: error.details?.nextAction ?? null };
    }
    return null;
  }
}

export async function previewStoryApproverRefresh(root, config, workflow, options = {}) {
  const candidate = await refreshCandidate(root, config, workflow, options);
  return preview(candidate, await previewAncestry(candidate, options, workflow.resolution.configurationSource));
}

async function writeOnce(root, relative, record) {
  const safe = await secureRepositoryPath(root, relative, { label: 'Immutable approver refresh decision', type: 'file' });
  if (safe.exists) fail('The immutable approver refresh decision already exists. Recover its pending transaction instead.', 'APR_REFRESH_CONFLICT');
  await mkdir(path.dirname(safe.absolute), { recursive: true });
  await writeText(safe.absolute, canonicalJson(record));
}

/** Record the exact previewed refresh once the person confirms its plan digest in a live terminal. */
export async function applyStoryApproverRefresh(root, config, workflow, options = {}, {
  capture = captureTerminalActionAuthorization, consume = consumeActionAuthorization
} = {}) {
  const initial = await refreshCandidate(root, config, workflow, options);
  if (initial.blockers.length) {
    fail(`Refreshing approvers would make ${initial.blockers.length === 1 ? 'a record' : 'records'} it binds stale: ${initial.blockers.map((entry) => entry.words).join('; ')}.`,
      'APR_REFRESH_BLOCKED', { blockers: initial.blockers });
  }
  // A confirmation of another plan (an older preview, or a changed configuration): the refresh as it stands, filled in.
  if (options.confirm !== initial.planSha256) {
    fail(`That confirmation is not this refresh as it stands now. It adds ${additionWords(initial.additions)}; if that is right, confirm it in your own terminal.`,
      'APR_CONFIRMATION_REQUIRED', { workId: initial.workId, nextAction: { command: refreshCommand(initial),
        label: 'Confirm the refresh as it stands now, in your own terminal' } });
  }
  const card = { plan: { planId: initial.id, planHash: initial.planSha256, reviewer: initial.actor,
    subject: { workId: initial.workId, phaseId: workflow.currentPhase ?? null }, revision: initial.sourceHead,
    additions: initial.additions, reason: initial.reason, testsWaived: false, phaseApproved: false },
  action: { actionId: initial.id, confirmation: { required: true } } };
  const grant = await capture(root, card.plan, card.action, { label: 'Refresh approvers', presenceInRecord: true });
  if (!grant) return { status: 'cancelled', applied: false, stateChanged: false };
  // Exactly the files the refresh writes: its decision, the new snapshot manifest and the refreshed
  // policy's content-addressed blob. Nothing else in the work item, such as an open draft, is swept in.
  const item = workDirRelative(config, initial.workId);
  const policyBlob = createHash('sha256').update(Buffer.from(canonicalJson(initial.proposed))).digest('hex');
  const exactWorkItemPaths = [approverRefreshDecisionPath(config, initial.workId, initial.id),
    `${item}/config/wfa/snapshots/${String(initial.to.revision).padStart(6, '0')}/manifest.json`,
    `${item}/config/wfa/blobs/.gitattributes`, `${item}/config/wfa/blobs/sha256/${policyBlob}`];
  try {
    const { value, publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor: identity(root), agent: null, authorityGroup: initial.authorityGroup, payload: { decision: 'approver-refresh' }
    }, `[${initial.workId}][approvers:refresh] ${initial.id}`, async (current) => {
      const fresh = await refreshCandidate(root, config, current, options);
      if (fresh.planSha256 !== initial.planSha256 || fresh.blockers.length) fail('The Story or its approved configuration changed during review. Preview the refresh again.', 'APR_REFRESH_STALE');
      const authorization = await consume(root, grant.token, card.plan, card.action, { requireTerminalPresentation: true });
      const configurationAncestry = await refreshAncestry(fresh, options.approvedConfigurationSnapshot, current.resolution.configurationSource);
      const adopted = configurationAncestry.adoptedWithoutAncestry ? ' Adopted without ancestry: sflow/config was rewritten outside SFlow, confirmed by this approver.' : '';
      const decision = { schemaVersion: currentSchemaVersion('approver-refresh-decision'), kind: 'approver-refresh-decision', id: fresh.id, workId: fresh.workId, status: 'approved',
        approvedAt: fresh.at, reason: fresh.reason, from: fresh.from, to: fresh.to, additions: fresh.additions,
        actor: fresh.actor, authorityGroup: fresh.authorityGroup, identityAssurance: fresh.match.identityAssurance ?? null,
        authorizationId: authorization.authorizationId, reviewAssurance: 'live-terminal-exact-refresh-review', configurationAncestry };
      const decisionPath = approverRefreshDecisionPath(config, fresh.workId, fresh.id);
      const decisionSha256 = approverRefreshDigest(decision);
      await writeOnce(root, decisionPath, decision);
      const prior = structuredClone(current);
      current.resolution = fresh.proposed;
      current.approverRefreshes ??= [];
      current.approverRefreshes.push(approverRefreshSummary(decision, { decisionPath, decisionSha256 }));
      const reference = await captureWorkflowApproverRefresh(root, config, prior, current, {
        approvedConfigurationSnapshot: options.approvedConfigurationSnapshot, refreshDecision: { path: decisionPath, sha256: decisionSha256 } });
      current.workflowSnapshot = reference;
      // The refreshed revision is this transaction's own until its commit is accepted (validateWorkflow).
      PROSPECTIVE.set(current, { reference: structuredClone(reference), policySha256: current.resolution.policySha256 });
      const added = Object.entries(fresh.additions).map(([group, members]) => `${members.length} to ${group}`).join(', ');
      current.history.push({ at: fresh.at, actor: fresh.actor, agent: null, event: 'approvers_refreshed', phase: current.currentPhase ?? null,
        detail: `${fresh.id}: added ${added} from configuration ${fresh.to.configurationCommit.slice(0, 12)}; snapshot revision ${reference.revision}.${adopted} ${fresh.reason}` });
      return { refreshId: fresh.id, additions: fresh.additions, workflowSnapshot: reference,
        ...(adopted ? { adoptedWithoutAncestry: configurationAncestry.adoptedWithoutAncestry } : {}) };
    }, { exactWorkItemPaths });
    return { schemaVersion: 1, resultType: 'approver-refresh', status: publication.pushed === false ? 'publication-pending' : 'applied',
      applied: true, stateChanged: true, ...value, publication };
  } finally { PROSPECTIVE.delete(workflow); }
}
