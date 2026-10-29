/**
 * Closed records for an approver refresh: people the approved configuration added to a group a
 * running Story already uses (2026-10-29).
 *
 * A Story's approval groups are fixed when it starts and bound into its accepted workflow snapshot,
 * so a group that was empty then, or whose only approver left, could never gain anyone. A refresh is
 * one accepted snapshot revision that changes exactly one thing: members appended to existing groups,
 * taken from the approved configuration at a descendant commit of the Story's own. Removals, new or
 * renamed groups, labels and identity rules are never applied, so every earlier approval still
 * verifies against the membership it was made under, and only ever gains approvers. Pure.
 */
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const APPROVER_REFRESH_DIALECT = 'approver-refresh/v1';
export const APPROVER_REFRESH_ID = /^APR-[0-9]{3,6}$/u;
const QUALIFIED_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAXIMUM_ADDITIONS = 64;

function fail(message, code = 'APR_REFRESH_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export const approverRefreshDigest = (value) => `sha256:${recordSha256(value)}`;

/** The resolution's own policy digest, as resolutionPolicySha256 computes it. */
export function approverRefreshPolicyDigest(resolution) {
  const value = structuredClone(resolution ?? {});
  delete value.policySha256;
  return approverRefreshDigest(value);
}

const memberKey = (member) => canonicalJson({
  email: String(member?.email ?? '').trim().toLowerCase() || null,
  githubLogin: String(member?.githubLogin ?? '').trim().toLowerCase() || null
});

/**
 * What the approved configuration adds to the groups this Story already has, and what it would
 * change that a refresh never applies. `candidate` is the approved configuration's groups.
 */
export function approverRefreshAdditions(current = {}, candidate = {}) {
  const additions = {};
  const ignored = [];
  for (const [group, authority] of Object.entries(current ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const next = candidate?.[group];
    if (!next) { ignored.push({ group, change: 'removed-group' }); continue; }
    const held = new Set((authority.members ?? []).map(memberKey));
    const offered = new Set((next.members ?? []).map(memberKey));
    const added = (next.members ?? []).filter((member) => !held.has(memberKey(member)));
    if (added.length) additions[group] = structuredClone(added);
    const removed = (authority.members ?? []).filter((member) => !offered.has(memberKey(member)));
    if (removed.length) ignored.push({ group, change: 'removed-members', count: removed.length });
    const { members: _held, ...heldRule } = authority;
    const { members: _offered, ...offeredRule } = next;
    if (canonicalJson(heldRule) !== canonicalJson(offeredRule)) ignored.push({ group, change: 'group-rule' });
  }
  for (const group of Object.keys(candidate ?? {}).sort()) {
    if (!Object.hasOwn(current ?? {}, group)) ignored.push({ group, change: 'new-group' });
  }
  return { additions, ignored };
}

/** The groups with `additions` appended to their members, in order, and nothing else changed. */
export function applyApproverRefresh(authorities, additions) {
  const next = structuredClone(authorities ?? {});
  for (const [group, members] of Object.entries(additions ?? {})) {
    if (!next[group]) fail(`Approval group '${group}' is not one of this Story's groups.`);
    next[group].members = [...(next[group].members ?? []), ...structuredClone(members)];
  }
  return next;
}

/**
 * Throws unless `next` differs from `previous` only by `decision.additions` appended to existing
 * groups, its configuration commit and its own digest. Replayed for every accepted refresh.
 */
export function assertApproverRefreshScope(previous, next, decision) {
  const additions = decision?.additions;
  if (!additions || typeof additions !== 'object' || Array.isArray(additions) || !Object.keys(additions).length) {
    fail('An approver refresh adds at least one member.');
  }
  const count = Object.values(additions).reduce((sum, members) => sum + (Array.isArray(members) ? members.length : MAXIMUM_ADDITIONS + 1), 0);
  if (count > MAXIMUM_ADDITIONS) fail(`An approver refresh adds at most ${MAXIMUM_ADDITIONS} members.`);
  const expected = applyApproverRefresh(previous?.approvalAuthorities, additions);
  if (canonicalJson(next?.approvalAuthorities) !== canonicalJson(expected)) {
    fail('The refreshed groups are not the accepted groups with exactly the recorded members added.');
  }
  for (const [group, members] of Object.entries(additions)) {
    const held = new Set((previous.approvalAuthorities[group].members ?? []).map(memberKey));
    if (members.some((member) => held.has(memberKey(member)) || (!member?.email && !member?.githubLogin))) {
      fail(`Approver refresh for '${group}' repeats a member or names one with no email or login.`);
    }
  }
  const oldSource = structuredClone(previous?.configurationSource ?? null);
  const nextSource = structuredClone(next?.configurationSource ?? null);
  if (!oldSource || !nextSource || oldSource.repository !== nextSource.repository
      || !OBJECT_ID.test(nextSource.commit ?? '') || oldSource.commit === nextSource.commit) {
    fail('An approver refresh needs a newer approved configuration commit at the same authority.');
  }
  delete oldSource.commit; delete nextSource.commit;
  delete oldSource.filesSha256; delete nextSource.filesSha256;
  if (canonicalJson(oldSource) !== canonicalJson(nextSource)) fail('An approver refresh changed configuration authority semantics.');
  const strip = (value) => {
    const copy = structuredClone(value);
    delete copy.policySha256; delete copy.configurationSource; delete copy.approvalAuthorities;
    return copy;
  };
  if (canonicalJson(strip(previous)) !== canonicalJson(strip(next))) {
    fail('An approver refresh changed Story policy beyond group membership.');
  }
  if (next.policySha256 !== approverRefreshPolicyDigest(next)) fail('The refreshed policy digest does not match its policy.');
}

const isString = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());

/** The decision record's closed shape; its binding to a revision is checked by the snapshot chain. */
export function validateApproverRefreshDecisionRecord(decision) {
  try { readRecord('approver-refresh-decision', decision); }
  catch { fail('The approver refresh decision record has an unsupported version.', 'WFA_AMENDMENT_INVALID'); }
  const ok = exactKeys(decision, ['schemaVersion', 'kind', 'id', 'workId', 'status', 'approvedAt', 'reason',
    'from', 'to', 'additions', 'actor', 'authorityGroup', 'identityAssurance', 'authorizationId', 'reviewAssurance',
    'configurationAncestry'])
    && decision.kind === 'approver-refresh-decision'
    && APPROVER_REFRESH_ID.test(decision.id ?? '') && isString(decision.workId) && decision.status === 'approved'
    && !Number.isNaN(Date.parse(decision.approvedAt)) && isString(decision.reason, 2000)
    && exactKeys(decision.from, ['revision', 'snapshotHash', 'policySha256', 'configurationCommit'])
    && Number.isSafeInteger(decision.from.revision) && decision.from.revision >= 1
    && QUALIFIED_SHA256.test(decision.from.snapshotHash ?? '') && QUALIFIED_SHA256.test(decision.from.policySha256 ?? '')
    && OBJECT_ID.test(decision.from.configurationCommit ?? '')
    && exactKeys(decision.to, ['revision', 'policySha256', 'configurationCommit'])
    && decision.to.revision === decision.from.revision + 1 && QUALIFIED_SHA256.test(decision.to.policySha256 ?? '')
    && OBJECT_ID.test(decision.to.configurationCommit ?? '')
    && decision.additions && typeof decision.additions === 'object' && !Array.isArray(decision.additions)
    && isString(decision.actor) && isString(decision.authorityGroup)
    && ['configured-local', 'github-authenticated', null].includes(decision.identityAssurance ?? null)
    && isString(decision.authorizationId) && decision.reviewAssurance === 'live-terminal-exact-refresh-review'
    && decision.configurationAncestry && typeof decision.configurationAncestry === 'object';
  if (!ok) fail('The approver refresh decision record is malformed.', 'WFA_AMENDMENT_INVALID');
  return decision;
}

/** The append-only summary a refresh leaves on the Story, derived from its decision. */
export function approverRefreshSummary(decision, { decisionPath, decisionSha256 }) {
  return { schemaVersion: currentSchemaVersion('approver-refresh-summary'), kind: 'approver-refresh-summary', id: decision.id, status: 'approved',
    decisionPath, decisionSha256, from: structuredClone(decision.from), to: structuredClone(decision.to),
    additions: structuredClone(decision.additions), decidedAt: decision.approvedAt };
}

export function validateApproverRefreshSummary(summary) {
  try { readRecord('approver-refresh-summary', summary); }
  catch { fail('An approver refresh summary has an unsupported version.', 'WFA_AMENDMENT_INVALID'); }
  const ok = exactKeys(summary, ['schemaVersion', 'kind', 'id', 'status', 'decisionPath', 'decisionSha256', 'from', 'to', 'additions', 'decidedAt'])
    && summary.kind === 'approver-refresh-summary' && APPROVER_REFRESH_ID.test(summary.id ?? '')
    && summary.status === 'approved' && isString(summary.decisionPath) && QUALIFIED_SHA256.test(summary.decisionSha256 ?? '')
    && Number.isSafeInteger(summary.from?.revision) && summary.to?.revision === summary.from.revision + 1;
  if (!ok) fail('An approver refresh summary is malformed.', 'WFA_AMENDMENT_INVALID');
  return summary;
}
