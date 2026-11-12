import { SingularityFlowError } from '../foundation/failures.mjs';

/** Called at the existing native decision point, after actor authority has been verified. */
export function rejectionTarget(workflow, phase, target, upstreamIssue = null) {
  if (upstreamIssue && workflow.phaseOrder.indexOf(target) >= workflow.phaseOrder.indexOf(phase.id)) {
    throw new SingularityFlowError(`${upstreamIssue.id} returns to an earlier step, not '${target}'.`, { code: 'UPSTREAM_ISSUE_NOT_EARLIER' });
  }
  const targetId = target ?? phase.id;
  if (!upstreamIssue && !phaseCorrectionTargets(phase).includes(targetId)) {
    throw new SingularityFlowError(`Phase '${phase.id}' cannot be rejected to '${targetId}'. Allowed: ${phaseCorrectionTargets(phase).join(', ')}.`);
  }
  const targetIndex = workflow.phaseOrder.indexOf(targetId);
  if (targetIndex < 0 || targetIndex > workflow.phaseOrder.indexOf(phase.id)) throw new SingularityFlowError(`Invalid rejection target '${targetId}'.`);
  return { targetId, targetIndex };
}

export function assertRejectionComment(phase, reason, testingRepair) {
  if ((testingRepair || phase.approvalPolicy.changeRequests?.commentRequired !== false) && !reason?.trim()) {
    throw new SingularityFlowError('A change-request comment is required.');
  }
}

/** Keep the public selector normalization independent of host path syntax. */
export function phaseRejectionMembers(values){return [...new Set(values.map(value=>value.trim().replaceAll('\\','/')).filter(Boolean))];}
/** Bind only lifecycle identity. Native ports retain sequence, presence and actor admission. */
export function phaseRejectionSelection(workflow, inputs) {
  const id = inputs.phaseId ?? workflow?.currentPhase, phase = workflow?.phases?.[id];
  const generation = Number(phase?.generation ?? 0);
  if (typeof workflow?.workItem?.id !== 'string' || !workflow.workItem.id || !phase || phase.id !== id
    || !Number.isSafeInteger(generation) || generation < 0
    || inputs.workId != null && inputs.workId !== workflow.workItem.id) {
    throw new SingularityFlowError('The rejection port did not bind the requested Story and phase.', { code: 'ENGINE_PORT_RESULT_INVALID' });
  }
  return { workId: workflow.workItem.id, phase: phase.id, generation,
    target: inputs.target ?? phase.id, clauseIds: [...new Set(inputs.clauseIds ?? [])],
    members: phaseRejectionMembers(inputs.members??[]),
    reason: inputs.reason?.trim() || 'Changes requested.' };
}

export function phaseRejectionResult(binding, facts) {
  const text = value => typeof value === 'string' && value.length > 0;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  const fields = ['workId','phase','generation','revision','pushed','currentPhase','changeRequest','repairBudget'];
  const record = facts?.changeRequest, budget = facts?.repairBudget;
  if (!exact(facts, fields) || facts.workId !== binding.workId || facts.phase !== binding.phase
    || facts.generation !== binding.generation || facts.currentPhase !== binding.target || !text(facts.revision)
    || typeof facts.pushed !== 'boolean'
    || !exact(record, ['id','status','sourcePhase','sourceGeneration','targetPhase','clauseIds','members','reason','actorId','authorityGroup','reviewPacket'])
    || !text(record.id) || record.status !== 'open' || record.sourcePhase !== binding.phase
    || record.sourceGeneration !== binding.generation || record.targetPhase !== binding.target
    || record.reason !== binding.reason || !text(record.actorId) || !text(record.authorityGroup)
    || !Array.isArray(record.clauseIds) || record.clauseIds.length !== binding.clauseIds.length
    || record.clauseIds.some((id, index) => id !== binding.clauseIds[index])
    || !Array.isArray(record.members) || record.members.length !== binding.members.length
    || record.members.some((member, index) => member !== binding.members[index])
    || record.reviewPacket !== null && !text(record.reviewPacket)
    || budget !== null && (!exact(budget, ['consumed','maximum']) || !count(budget.consumed) || !count(budget.maximum)
      || budget.consumed < 1 || budget.consumed > budget.maximum)) {
    throw new SingularityFlowError('The rejection port returned invalid or differently bound decision facts.', { code: 'ENGINE_PORT_RESULT_INVALID' });
  }
  return { schemaVersion: 1, contract: 'sflow-engine/v1', operation: 'phase.reject', status: 'recorded',
    subject: { kind: 'story', id: binding.workId }, phase: binding.phase, generation: binding.generation,
    revision: facts.revision, effects: { committed: true, pushed: facts.pushed }, currentPhase: facts.currentPhase,
    changeRequest: record, repairBudget: budget };
}

export const DEFAULT_APPROVAL_AUTHORITY = 'git-contributors';
export const APPROVAL_SECURITY_PROFILES = Object.freeze(['poc', 'team', 'regulated']);

export function normalizeApprovalSecurity(value = {}) {
  const source = typeof value === 'string' ? { profile: value } : (value ?? {});
  const profile = source.profile ?? 'team';
  if (!APPROVAL_SECURITY_PROFILES.includes(profile)) {
    throw new SingularityFlowError(`approvalSecurity.profile must be ${APPROVAL_SECURITY_PROFILES.join(', ')}.`);
  }
  for (const field of ['allowSelfApproval', 'autoEnrollNewIdentities']) {
    if (source[field] != null && typeof source[field] !== 'boolean') {
      throw new SingularityFlowError(`approvalSecurity.${field} must be boolean.`);
    }
  }
  return {
    profile,
    allowAnyGitIdentity: profile === 'poc',
    // Team work starts usable for a lone developer. Regulated repositories retain the conservative
    // default unless an administrator explicitly enables either behavior in approved configuration.
    allowSelfApproval: source.allowSelfApproval ?? profile !== 'regulated',
    autoEnrollNewIdentities: source.autoEnrollNewIdentities ?? profile !== 'regulated',
    requireNamedMembers: profile === 'regulated'
  };
}

function normalizedEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizedLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeApprovalAuthorities(value = null, securityValue = {}) {
  const security = normalizeApprovalSecurity(securityValue);
  const source = value ?? {
    [DEFAULT_APPROVAL_AUTHORITY]: {
      label: 'Git contributors',
      allowAnyGitIdentity: security.allowAnyGitIdentity,
      members: []
    }
  };
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length) {
    throw new SingularityFlowError('approvalAuthorities must define at least one authority group.');
  }
  const result = {};
  for (const [id, authority] of Object.entries(source)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new SingularityFlowError(`Approval authority '${id}' must be lower-case kebab-case.`);
    }
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
      throw new SingularityFlowError(`Approval authority '${id}' must be an object.`);
    }
    if (authority.allowAnyGitIdentity != null && typeof authority.allowAnyGitIdentity !== 'boolean') {
      throw new SingularityFlowError(`Approval authority '${id}'.allowAnyGitIdentity must be boolean.`);
    }
    const members = authority.members ?? [];
    if (!Array.isArray(members)) throw new SingularityFlowError(`Approval authority '${id}'.members must be an array.`);
    const githubTeams = authority.githubTeams ?? [];
    if (!Array.isArray(githubTeams) || githubTeams.some((team) => typeof team !== 'string' || !/^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(team))) {
      throw new SingularityFlowError(`Approval authority '${id}'.githubTeams must contain @organization/team values.`);
    }
    const seen = new Set();
    result[id] = {
      label: authority.label?.trim() || id,
      allowAnyGitIdentity: authority.allowAnyGitIdentity ?? security.allowAnyGitIdentity,
      githubTeams: [...new Set(githubTeams)],
      members: members.map((member, index) => {
        if (!member || typeof member !== 'object' || Array.isArray(member)) {
          throw new SingularityFlowError(`Approval authority '${id}' member ${index + 1} must be an object.`);
        }
        const email = normalizedEmail(member.email);
        const githubLogin = normalizedLogin(member.githubLogin);
        if ((!email || !email.includes('@')) && !githubLogin) {
          throw new SingularityFlowError(`Approval authority '${id}' member ${index + 1} requires a valid Git email or GitHub login.`);
        }
        const key = email ? `email:${email}` : `github:${githubLogin}`;
        if (seen.has(key)) throw new SingularityFlowError(`Approval authority '${id}' lists identity '${email || githubLogin}' more than once.`);
        seen.add(key);
        return { name: member.name?.trim() || null, email: email || null, githubLogin: githubLogin || null };
      })
    };
    if (security.requireNamedMembers && !result[id].allowAnyGitIdentity && !result[id].members.length) {
      throw new SingularityFlowError(`Regulated approval authority '${id}' must list named members.`);
    }
  }
  return result;
}

export function normalizeApprovalPolicy(value = {}, authorities, phaseId, securityValue = {}) {
  const security = normalizeApprovalSecurity(securityValue);
  if (value === 'none' || value?.mode === 'none') {
    return {
      mode: 'none',
      authorities: [],
      requiredAuthorities: [],
      minimum: 0,
      rejectTo: [phaseId],
      allowSelfApproval: false,
      changeRequests: { commentRequired: true, reopenCompleted: true }
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval must be none or an approval policy object.`);
  }
  const mode = value.mode ?? 'required';
  if (!['required', 'policy'].includes(mode)) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.mode must be required, none, or policy.`);
  }
  const registry = normalizeApprovalAuthorities(authorities);
  const configured = value.authorities ?? [Object.keys(registry)[0]];
  if (!Array.isArray(configured) || !configured.length) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval must reference at least one authority group.`);
  }
  const authorityIds = [...new Set(configured)];
  for (const authorityId of authorityIds) {
    if (!Object.hasOwn(registry, authorityId)) {
      throw new SingularityFlowError(`Phase '${phaseId}' approval references unknown authority '${authorityId}'.`);
    }
  }
  const minimum = value.minimum ?? 1;
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.minimum must be a positive integer.`);
  }
  const required = value.requiredAuthorities ?? [];
  if (!Array.isArray(required) || new Set(required).size !== required.length) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.requiredAuthorities must be a unique array.`);
  }
  for (const authorityId of required) {
    if (!authorityIds.includes(authorityId)) {
      throw new SingularityFlowError(`Phase '${phaseId}' approval.requiredAuthorities references '${authorityId}', which is not listed in approval.authorities.`);
    }
  }
  if (minimum < required.length) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.minimum must be at least ${required.length} to cover every required authority group.`);
  }
  if (value.maximumChangedPaths != null && (!Number.isInteger(value.maximumChangedPaths) || value.maximumChangedPaths < 1)) {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.maximumChangedPaths must be a positive integer.`);
  }
  const rejectTo = [...new Set(value.rejectTo ?? [phaseId])];
  if (value.allowSelfApproval != null && typeof value.allowSelfApproval !== 'boolean') {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.allowSelfApproval must be boolean.`);
  }
  const changeRequests = value.changeRequests ?? {};
  if (changeRequests.commentRequired != null && typeof changeRequests.commentRequired !== 'boolean') {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.changeRequests.commentRequired must be boolean.`);
  }
  if (changeRequests.reopenCompleted != null && typeof changeRequests.reopenCompleted !== 'boolean') {
    throw new SingularityFlowError(`Phase '${phaseId}' approval.changeRequests.reopenCompleted must be boolean.`);
  }
  return {
    mode,
    policy: mode === 'policy' ? (value.policy?.trim() || null) : null,
    maximumChangedPaths: mode === 'policy' && value.maximumChangedPaths != null
      ? value.maximumChangedPaths
      : null,
    authorities: authorityIds,
    requiredAuthorities: [...required],
    minimum,
    rejectTo,
    allowSelfApproval: value.allowSelfApproval ?? security.allowSelfApproval,
    changeRequests: {
      commentRequired: changeRequests.commentRequired !== false,
      reopenCompleted: changeRequests.reopenCompleted !== false
    }
  };
}

// `counts` is SF Guard's predicate for a Story it requires (src/presence/person-records.mjs
// `presenceCounts`): only a verified or excepted record counts. Without it every record counts.
export function remainingRequiredAuthorities(policy, approvals = [], { counts = null } = {}) {
  const decided = new Set((approvals ?? [])
    .filter((item) => !item.invalidatedAt && item.decision === 'approved' && (!counts || counts(item)))
    .map((item) => item.authorityGroup));
  return (policy?.requiredAuthorities ?? []).filter((authorityId) => !decided.has(authorityId));
}

/**
 * What identifies a person on a record: each login and email it holds, or its name when it holds
 * neither. GitHub's noreply address names a login. A record holds a login only when `gh` was known,
 * so comparing one field made the same person two people.
 */
function personIdentifiers(actor) {
  const record = typeof actor === 'string' ? { login: actor, email: actor } : actor;
  const login = normalizedLogin(record?.login ?? record?.githubLogin);
  const email = normalizedEmail(record?.email);
  const noreply = /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/u.exec(email)?.[1];
  const held = [login && `login:${login}`, email && `email:${email}`, noreply && `login:${noreply}`].filter(Boolean);
  const name = String(record?.name ?? '').trim().toLowerCase();
  return new Set(held.length ? held : name ? [`name:${name}`] : []);
}

/** Whether two actors are one person: any identifier in common. An actor may be a recorded key. */
export function sameApprover(left, right) {
  const ids = personIdentifiers(left);
  return [...personIdentifiers(right)].some((id) => ids.has(id));
}

/** The distinct people among active approvals: records sharing any identifier are one person. */
function approverIdentities(active) {
  let people = [];
  for (const item of active) {
    const ids = personIdentifiers(item.actor);
    if (!ids.size) continue;
    const same = people.filter((person) => [...ids].some((id) => person.has(id)));
    people = [...people.filter((person) => !same.includes(person)), new Set([...ids, ...same.flatMap((person) => [...person])])];
  }
  return people;
}

export function approvalRequirementsMet(policy, approvals = [], { counts = null } = {}) {
  const active = (approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved' && (!counts || counts(item)));
  return approverIdentities(active).length >= (policy?.minimum ?? 1)
    && remainingRequiredAuthorities(policy, active).length === 0;
}

/** Shared human/quorum rules for an explicit-principal host, after immutable vote proofs are read. */
export function principalApprovalPlan(workflow,phase,reviewer,{author,active=[]}) {
  const actor=reviewer.actor;
  if(actor.actorKind!=='human')throw new SingularityFlowError('A phase approval requires an authenticated human reviewer.',{
    code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  const authorities=workflow.resolution.approvalAuthorities,policy=phase.approvalPolicy;
  const authority=requireApprovalAuthority(authorities,policy,actor.identity,
    {preferredAuthorities:remainingRequiredAuthorities(policy,active)});
  const key=actor.identity.email?.trim().toLowerCase()||actor.identity.login?.trim().toLowerCase();
  if(active.some(item=>item.principalId===actor.principalId||sameApprover(item.actor,actor.identity))) {
    throw new SingularityFlowError(`${key} already approved phase ${phase.id}; approvals require distinct identities.`,{
      code:'APPROVAL_IDENTITY_ALREADY_RECORDED',details:{workId:workflow.workItem.id,phase:phase.id}});
  }
  const selfApproval=author?.principalId===actor.principalId||sameApprover(phase.generatedBy??{},actor.identity)
    ||sameApprover(author?.identity??{},actor.identity);
  if(selfApproval&&policy.allowSelfApproval===false)throw new SingularityFlowError(
    `Capability and workflow policy prohibit self-approval for phase '${phase.id}'. Ask another authorized human to approve this generation.`,{
      code:'APPROVAL_SELF_APPROVAL_PROHIBITED',details:{workId:workflow.workItem.id,phase:phase.id}});
  const prospective={decision:'approved',actor:actor.identity,principalId:actor.principalId,authorityGroup:authority.authorityGroup};
  return {key,authorityGroup:authority.authorityGroup,selfApproval,reached:approvalRequirementsMet(policy,[...active,prospective])};
}

import { phaseCorrectionTargets } from './approval-fallback.mjs';

/**
 * One engine-computed view of where the approval of the phase awaiting it stands, so no surface
 * re-implements the rule: how many distinct people approved of how many, and which required groups
 * have not decided yet.
 */
export function storyApprovalView(workflow, { counts = null } = {}) {
  const phaseId = workflow?.currentPhase ?? null;
  const phase = phaseId ? workflow.phases?.[phaseId] : null;
  if (!phase || phase.status !== 'awaiting_approval') return null;
  const policy = phase.approvalPolicy ?? {};
  const active = (phase.approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved' && (!counts || counts(item)));
  return {
    phase: phaseId,
    correctionTargets: phaseCorrectionTargets(phase),
    minimum: policy.minimum ?? 1,
    distinct: approverIdentities(active).length,
    remainingAuthorities: remainingRequiredAuthorities(policy, active),
    met: approvalRequirementsMet(policy, active)
  };
}

function memberIdentity(member = {}) {
  const login = normalizedLogin(member.githubLogin ?? member.login);
  if (login) return `github:${login}`;
  const email = normalizedEmail(member.email);
  return email ? `email:${email}` : null;
}

// One recorded decision covers one authority group, and each actor can decide only once. A
// union count cannot prove that overlapping required groups have a distinct reviewer assignment.
// Use iterative augmenting paths so even a large, finite pinned registry needs no recursion.
function unmatchedRequiredAuthorities(registry, configured, required) {
  const allowed = new Set(configured);
  const groups = [...new Set(required)].sort();
  const candidates = new Map(groups.map((id) => {
    const authority = allowed.has(id) && Object.hasOwn(registry, id) ? registry[id] : null;
    // An any-identity group has an unlimited *structural* supply. This synthetic identity is not
    // a real actor, a membership assertion, or an approval; it never leaves this capacity check.
    const identities = authority?.allowAnyGitIdentity ? [`unbounded:${id}`]
      : [...new Set((authority?.members ?? []).map(memberIdentity).filter(Boolean))].sort();
    return [id, identities];
  }));
  const byIdentity = new Map();
  const byGroup = new Map();
  for (const initial of groups) {
    const queue = [initial];
    const visited = new Set(queue);
    const predecessor = new Map();
    let free = null;
    for (let index = 0; index < queue.length && free == null; index += 1) {
      const group = queue[index];
      for (const identity of candidates.get(group)) {
        if (predecessor.has(identity)) continue;
        predecessor.set(identity, group);
        const assigned = byIdentity.get(identity);
        if (assigned == null) { free = identity; break; }
        if (!visited.has(assigned)) { visited.add(assigned); queue.push(assigned); }
      }
    }
    while (free != null) {
      const group = predecessor.get(free);
      const previous = byGroup.get(group) ?? null;
      byIdentity.set(free, group);
      byGroup.set(group, free);
      free = previous;
    }
  }
  return groups.filter((id) => !byGroup.has(id));
}

/** Check static capacity of pinned configured identities; never assert current human availability. */
export function approvalPolicyCapacity(authorities, policy) {
  // Policy approvals may waive a phase only when their deterministic predicate succeeds. When it
  // does not, they fall back to ordinary human review and therefore need the same attainable
  // reviewer capacity as a required approval.
  if ((policy?.mode ?? 'required') === 'none') {
    return { attainable: true, unbounded: false, eligibleIdentities: 0, minimum: 0, missingAuthorities: [] };
  }
  const registry = normalizeApprovalAuthorities(authorities);
  const configured = policy?.authorities ?? [];
  const eligible = new Set();
  let unbounded = false;
  for (const authorityId of configured) {
    const authority = Object.hasOwn(registry, authorityId) ? registry[authorityId] : null;
    if (!authority) continue;
    if (authority.allowAnyGitIdentity) unbounded = true;
    for (const member of authority.members ?? []) {
      const key = memberIdentity(member);
      if (key) eligible.add(key);
    }
  }
  const missingAuthorities = unmatchedRequiredAuthorities(registry, configured,
    policy?.requiredAuthorities ?? []);
  const minimum = policy?.minimum ?? 1;
  return {
    attainable: missingAuthorities.length === 0 && (unbounded || eligible.size >= minimum),
    unbounded,
    eligibleIdentities: eligible.size,
    minimum,
    missingAuthorities
  };
}

/** `authorities` without the members `actor` is (by email or GitHub login): who could approve someone else's work. */
export function withoutApprovalIdentity(authorities, actor) {
  const email = normalizedEmail(actor?.email);
  const login = normalizedLogin(actor?.login ?? actor?.githubLogin);
  const registry = normalizeApprovalAuthorities(authorities);
  return Object.fromEntries(Object.entries(registry).map(([id, authority]) => [id, { ...authority,
    members: (authority.members ?? []).filter((member) => !(email && normalizedEmail(member.email) === email)
      && !(login && normalizedLogin(member.githubLogin ?? member.login) === login)) }]));
}

/**
 * Refuse a step nobody could ever approve. `creator` is who starts the Story and publishes its steps:
 * where the step forbids self-approval they cannot approve it, so they do not count (the workflow
 * simulation already counted it this way). A lone author used to start, write and submit, and only
 * then learn nobody could approve, with approval groups pinned for the life of the Story.
 */
export function assertApprovalPolicyAttainable(authorities, policy, phaseId, { creator = null } = {}) {
  const independent = policy?.allowSelfApproval === false && (creator?.email || creator?.login || creator?.githubLogin);
  const capacity = approvalPolicyCapacity(independent ? withoutApprovalIdentity(authorities, creator) : authorities, policy);
  if (capacity.attainable) return capacity;
  if (independent && approvalPolicyCapacity(authorities, policy).attainable) {
    const who = normalizedEmail(creator.email) || normalizedLogin(creator.login ?? creator.githubLogin);
    const groups = (policy?.authorities ?? []).join(', ') || 'its approval groups';
    throw new SingularityFlowError(
      `Phase '${phaseId}' forbids self-approval, and ${who}, who starts this Story and publishes its steps, is the only identity ${groups} lists, so nobody could approve it. Add another person to ${groups}, or allow self-approval for it, before starting the Story.`,
      { code: 'APPROVAL_POLICY_UNATTAINABLE', details: { phase: phaseId, ...capacity, selfApprovalExcluded: true, authorities: policy?.authorities ?? [] } }
    );
  }
  const reasons = [
    ...(!capacity.unbounded && capacity.eligibleIdentities < capacity.minimum
      ? [`requires ${capacity.minimum} distinct approval identities but only ${capacity.eligibleIdentities} are pinned`]
      : []),
    ...(capacity.missingAuthorities.length
      ? [`required authority groups cannot be assigned distinct eligible reviewers: ${capacity.missingAuthorities.join(', ')}`]
      : [])
  ];
  throw new SingularityFlowError(
    `Phase '${phaseId}' approval policy cannot complete: ${reasons.join('; ')}. Add reviewers to the approved configuration before starting the Story.`,
    { code: 'APPROVAL_POLICY_UNATTAINABLE', details: { phase: phaseId, ...capacity, authorities: policy?.authorities ?? [] } }
  );
}

export function matchApprovalAuthority(authorities, policy, actor, { preferredAuthorities = [] } = {}) {
  const registry = normalizeApprovalAuthorities(authorities);
  const email = normalizedEmail(actor?.email);
  const login = normalizedLogin(actor?.login);
  if (!email && !login) {
    return {
      authorized: false,
      authorityGroup: null,
      reason: 'Approval requires a configured local Git email or an authenticated GitHub login.'
    };
  }
  const configured = policy?.authorities ?? [];
  const ordered = [...new Set([
    ...preferredAuthorities.filter((authorityId) => configured.includes(authorityId)),
    ...configured
  ])];
  for (const authorityId of ordered) {
    const authority = Object.hasOwn(registry, authorityId) ? registry[authorityId] : null;
    if (!authority) continue;
    if (
      authority.allowAnyGitIdentity
      || authority.members.some((member) => (email && member.email === email) || (login && member.githubLogin === login))
    ) {
      return {
        authorized: true,
        authorityGroup: authorityId,
        authorityLabel: authority.label,
        identityAssurance: email ? 'configured-local' : 'github-authenticated',
        email: email || null,
        githubLogin: login || null
      };
    }
  }
  return {
    authorized: false,
    authorityGroup: null,
    reason: `Identity '${email || login}' is not a member of: ${(policy?.authorities ?? []).join(', ') || 'no configured authority group'}.`
  };
}

/**
 * Who else can make this decision: the policy's groups and up to `limit` members they list, never
 * `exclude` (the identity that was refused). A group that admits any Git identity lists nobody.
 */
export function eligibleApprovers(authorities, policy, { exclude = [], limit = 10 } = {}) {
  const groups = [...(policy?.authorities ?? [])];
  let registry;
  try { registry = normalizeApprovalAuthorities(authorities); } catch { return { authorities: groups, eligibleApprovers: [] }; }
  const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(normalizedEmail).filter(Boolean));
  const members = new Set();
  // A group that admits any Git identity has no list to name, yet anyone in it may decide.
  const unbounded = groups.some((id) => Object.hasOwn(registry, id) && registry[id].allowAnyGitIdentity === true);
  for (const id of groups) {
    for (const member of Object.hasOwn(registry, id) ? registry[id].members : []) {
      if ((member.email && skip.has(member.email)) || (member.githubLogin && skip.has(member.githubLogin))) continue;
      members.add(member.email || `github:${member.githubLogin}`);
    }
  }
  return { authorities: groups, eligibleApprovers: [...members].slice(0, limit), ...(unbounded ? { anyIdentity: true } : {}) };
}

export function requireApprovalAuthority(authorities, policy, actor, options = {}) {
  const match = matchApprovalAuthority(authorities, policy, actor, options);
  if (!match.authorized) {
    // Coded, so every surface can say who may decide instead and how to check this checkout's
    // identity. A refused identity is never a reason to reject the work under review.
    const identity = normalizedEmail(actor?.email) || normalizedLogin(actor?.login) || null;
    throw new SingularityFlowError(match.reason, {
      code: identity ? 'APPROVAL_IDENTITY_NOT_AUTHORIZED' : 'APPROVAL_IDENTITY_MISSING',
      details: { identity, ...eligibleApprovers(authorities, policy, { exclude: identity ?? [] }) }
    });
  }
  return match;
}

/** Exact submitted generation and review packet a human decision names; no terminal access. */
export function terminalReviewBinding(workflow, phase) {
  if (phase?.status !== 'awaiting_approval') return null;
  const packet = [...(workflow.lineage?.submissions ?? [])].reverse()
    .find((entry) => entry.phase === phase.id && entry.generation === phase.generation)?.packetSha256 ?? null;
  return packet ? { workId: workflow.workItem.id, phase: phase.id, generation: phase.generation, reviewPacketSha256: packet } : null;
}
export {terminalReviewBinding as submittedApprovalBinding};

/** A host must explicitly confirm the exact review that this operation loaded. */
export function assertApprovalReviewConfirmation(expected, confirmation) {
  if (!expected || confirmation == null) throw new SingularityFlowError(
    'Approval requires explicit confirmation of the exact submitted review packet.', {
      code:'ENGINE_APPROVAL_CONFIRMATION_REQUIRED',details:{review:expected ?? null}
    });
  if (confirmation.workId !== expected.workId || confirmation.phase !== expected.phase
    || confirmation.generation !== expected.generation || confirmation.reviewPacketSha256 !== expected.reviewPacketSha256) {
    throw new SingularityFlowError('The confirmed approval review no longer matches the submitted generation.', {
      code:'ENGINE_APPROVAL_CONFIRMATION_STALE',details:{expected,confirmed:confirmation}
    });
  }
}

/** Enroll into a private Story pin only; this does not publish membership or record approval. */
export function enrollPinnedApprovalIdentity(authorities, creator) {
    const email = String(creator.email ?? '').trim().toLowerCase();
    const githubLogin = String(creator.login ?? creator.githubLogin ?? '').trim();
    for (const authority of Object.values(authorities)) {
      authority.members ??= [];
      const enrolled = authority.members.some((member) =>
        (email && String(member.email ?? '').trim().toLowerCase() === email)
        || (githubLogin && String(member.githubLogin ?? '').trim().toLowerCase() === githubLogin.toLowerCase()));
      if (!enrolled && (email || githubLogin)) {
        authority.members.push({
          name: String(creator.name ?? '').trim() || null,
          email: email || null,
          githubLogin: githubLogin || null
        });
      }
    }
  return authorities;
}
