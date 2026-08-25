import { SingularityFlowError } from './util.mjs';

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
    if (!registry[authorityId]) {
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

export function remainingRequiredAuthorities(policy, approvals = []) {
  const decided = new Set((approvals ?? [])
    .filter((item) => !item.invalidatedAt && item.decision === 'approved')
    .map((item) => item.authorityGroup));
  return (policy?.requiredAuthorities ?? []).filter((authorityId) => !decided.has(authorityId));
}

export function approvalRequirementsMet(policy, approvals = []) {
  const active = (approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved');
  const identities = new Set(active.map((item) => normalizedLogin(item.actor?.login)
    || normalizedEmail(item.actor?.email)
    || String(item.actor?.name ?? '').trim().toLowerCase()).filter(Boolean));
  return identities.size >= (policy?.minimum ?? 1)
    && remainingRequiredAuthorities(policy, active).length === 0;
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
    const authority = registry[authorityId];
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

export function requireApprovalAuthority(authorities, policy, actor, options = {}) {
  const match = matchApprovalAuthority(authorities, policy, actor, options);
  if (!match.authorized) throw new SingularityFlowError(match.reason);
  return match;
}
