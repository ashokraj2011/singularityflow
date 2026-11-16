/**
 * Whether a person was removed from an approval group by an approved change [SCF:REQ-012, finding ER-F3].
 *
 * "Removed" is read from `sflow/config`'s own history: the person was a member of the group in a version
 * an approval landed, and is not one now. Nothing new is recorded for it, so a removal approved by an older
 * build, or merged on the Git host, counts the same. Story start never adds such a person back, and an
 * approval that would add its own approver back is refused: someone else decides.
 */
import YAML from 'yaml';
import { executeGitQuery } from './git-query.mjs';
import { sourceFileAt } from './source-inspection.mjs';

const FILES = Object.freeze({ story: 'singularity/workflow.yml', initiative: 'singularity/portfolio.yml' });
const MEMBERSHIP_ROOT = Object.freeze({ story: 'approvalAuthorities', initiative: 'approvalAuthorities' });

const lower = (value) => String(value ?? '').trim().toLowerCase();

/** Whether `identity` ({ email, githubLogin }) is listed in `members`. A login counts only in Story groups. */
export function listsMember(members, identity, scope) {
  const email = lower(identity?.email);
  const login = lower(identity?.githubLogin ?? identity?.login);
  return (Array.isArray(members) ? members : []).some((entry) => (email && lower(entry?.email) === email)
    || (scope === 'story' && login && lower(entry?.githubLogin ?? entry?.login) === login));
}

function groupMembers(text, scope, group) {
  try {
    const value = YAML.parse(text ?? '', { maxAliasCount: 100 }) ?? {};
    return value?.[MEMBERSHIP_ROOT[scope]]?.[group]?.members ?? null;
  } catch { return null; }
}

/**
 * Which of `groups` (`[{ scope: 'story' | 'initiative', id }]`) `identity` was a member of in an earlier
 * version of `sflow/config` at `commit`, read in `root` (a repository holding that history). The caller
 * names only groups the person is not in now. `{ status: 'known', removed: [{ scope, id, commit }] }`, or
 * `{ status: 'unknown' }` when the history could not be read: the caller then never lets the person
 * approve their own membership.
 */
export function removedApprovalMemberships(root, commit, identity, groups, { env = process.env } = {}) {
  const wanted = (groups ?? []).filter((group) => FILES[group?.scope] && group?.id);
  if (!wanted.length) return { status: 'known', removed: [] };
  const needles = [lower(identity?.email), lower(identity?.githubLogin ?? identity?.login)].filter(Boolean);
  if (!needles.length) return { status: 'unknown' };
  const candidates = new Set();
  for (const needle of needles) {
    let listed;
    try { listed = executeGitQuery(root, 'configuration.member-history', { commit, needle }, { env }); }
    catch { return { status: 'unknown' }; }
    if (!listed) return { status: 'unknown' };
    for (const entry of listed) candidates.add(entry);
  }
  const removed = [];
  const remaining = new Map(wanted.map((group) => [`${group.scope}:${group.id}`, group]));
  for (const candidate of candidates) {
    if (!remaining.size) break;
    for (const scope of new Set([...remaining.values()].map((group) => group.scope))) {
      const shown = sourceFileAt(root, candidate, FILES[scope], { env, maxBytes: 8 * 1024 * 1024 });
      if (shown.status === 'unavailable') return { status: 'unknown' };
      if (shown.status !== 'present') continue;
      for (const [key, group] of remaining) {
        if (group.scope !== scope) continue;
        if (listsMember(groupMembers(shown.value, scope, group.id), identity, scope)) {
          removed.push({ scope, id: group.id, commit: candidate });
          remaining.delete(key);
        }
      }
    }
  }
  return { status: 'known', removed };
}

/**
 * The members a landed change adds, per group: `[{ scope, id, member }]`, from each file's text before and
 * after. Only the people files are read; any other path adds nobody.
 */
export function addedApprovalMembers(before, after) {
  const added = [];
  for (const scope of Object.keys(FILES)) {
    const parse = (text) => { try { return YAML.parse(text ?? '', { maxAliasCount: 100 }) ?? {}; } catch { return {}; } };
    const old = parse(before?.[FILES[scope]])?.[MEMBERSHIP_ROOT[scope]] ?? {};
    const next = parse(after?.[FILES[scope]])?.[MEMBERSHIP_ROOT[scope]] ?? {};
    for (const [id, group] of Object.entries(next ?? {})) {
      for (const member of Array.isArray(group?.members) ? group.members : []) {
        if (!listsMember(old?.[id]?.members, member, scope)) added.push({ scope, id, member });
      }
    }
  }
  return added;
}

export const PEOPLE_FILES = FILES;
