import { SingularityFlowError } from './util.mjs';

export const DEFAULT_APPROVAL_AUTHORITY = 'git-contributors';

function normalizedEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizedLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeApprovalAuthorities(value = null) {
  const source = value ?? {
    [DEFAULT_APPROVAL_AUTHORITY]: {
      label: 'Git contributors',
      allowAnyGitIdentity: true,
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
      allowAnyGitIdentity: authority.allowAnyGitIdentity === true,
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
    if (!result[id].allowAnyGitIdentity && !result[id].members.length) {
      throw new SingularityFlowError(`Approval authority '${id}' must list members or set allowAnyGitIdentity: true.`);
    }
  }
  return result;
}

export function normalizeApprovalPolicy(value = {}, authorities, phaseId) {
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
  const rejectTo = [...new Set(value.rejectTo ?? [phaseId])];
  return { authorities: authorityIds, minimum, rejectTo };
}

export function matchApprovalAuthority(authorities, policy, actor) {
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
  for (const authorityId of policy?.authorities ?? []) {
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

export function requireApprovalAuthority(authorities, policy, actor) {
  const match = matchApprovalAuthority(authorities, policy, actor);
  if (!match.authorized) throw new SingularityFlowError(match.reason);
  return match;
}
