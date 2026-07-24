import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  add, branch, checkout, commit, fetchRemote, fileAtRef, hasRemote, pushBranch, refExists, remoteBranches
} from './git.mjs';
import {
  ensureDir, exists, nowIso, posix, run, SingularityFlowError, writeJson
} from './util.mjs';

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identityPattern(prefix, pad, { scoped = false } = {}) {
  const suffix = scoped ? `(\\d{${pad},})-(\\d{${pad},})` : `(\\d{${pad},})`;
  return new RegExp(`^${escaped(prefix)}-${suffix}$`);
}

function localPolicy(portfolio) {
  const policy = portfolio?.identity?.local;
  if (!policy) throw new SingularityFlowError('Portfolio local identity policy is unavailable.');
  return policy;
}

function branchId(value) {
  const normalized = String(value ?? '').replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '');
  const segments = normalized.split('/');
  return segments.at(-1);
}

async function directoryNames(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function collectBreakdownIds(parsed, target) {
  for (const epic of parsed?.epics ?? []) {
    if (epic?.planId) target.push(String(epic.planId));
    if (epic?.id) target.push(String(epic.id));
    if (epic?.workId) target.push(String(epic.workId));
    for (const story of epic?.stories ?? []) {
      if (story?.planId) target.push(String(story.planId));
      if (story?.id) target.push(String(story.id));
      if (story?.workId) target.push(String(story.workId));
    }
  }
}

async function workingTreeBreakdownIds(root, portfolio) {
  const values = [];
  const initiativeRoot = path.join(root, portfolio.initiativeRoot);
  for (const id of await directoryNames(initiativeRoot)) {
    const file = path.join(initiativeRoot, id, 'breakdown.yml');
    if (!await exists(file)) continue;
    try { collectBreakdownIds(YAML.parse(await readFile(file, 'utf8')), values); } catch {
      // Invalid breakdowns are reported by the normal governance gate. Identity
      // scanning ignores their contents but still reserves the initiative ID.
    }
  }
  return values;
}

function remoteBreakdownIds(root, portfolio, remote, branches) {
  const values = [];
  for (const name of branches) {
    const id = branchId(name);
    const text = fileAtRef(root, `refs/remotes/${remote}/${name}`, posix(path.join(portfolio.initiativeRoot, id, 'breakdown.yml')));
    if (!text) continue;
    try { collectBreakdownIds(YAML.parse(text), values); } catch {
      // The branch remains visible to the normal initiative gate. Do not let a
      // malformed remote document prevent allocation from inspecting others.
    }
  }
  return values;
}

export async function scanLocalIdentities(root, portfolio, {
  remote = portfolio.git?.remote ?? 'origin',
  fetch = false
} = {}) {
  if (fetch && hasRemote(root, remote)) fetchRemote(root, remote);
  const localRefs = run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root }).stdout
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const remotes = remoteBranches(root, remote);
  const initiatives = await directoryNames(path.join(root, portfolio.initiativeRoot));
  const breakdownIds = [
    ...await workingTreeBreakdownIds(root, portfolio),
    ...remoteBreakdownIds(root, portfolio, remote, remotes)
  ];
  const values = [...initiatives, ...localRefs.map(branchId), ...remotes.map(branchId), ...breakdownIds];
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return {
    values: [...new Set(values)].sort(),
    duplicates: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({ id, count }))
  };
}

export async function nextLocalEpicId(root, portfolio, options = {}) {
  const policy = localPolicy(portfolio);
  const scan = await scanLocalIdentities(root, portfolio, options);
  const pattern = identityPattern(policy.epicPrefix, policy.pad);
  let maximum = 0;
  for (const value of scan.values) {
    const match = pattern.exec(value);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  const sequence = maximum + 1;
  return {
    id: `${policy.epicPrefix}-${String(sequence).padStart(policy.pad, '0')}`,
    sequence,
    scan
  };
}

export function assignLocalStoryIds(breakdown, initiative, portfolio) {
  const authority = initiative?.resolution?.identity?.authority;
  if (authority !== 'local') return breakdown;
  const policy = initiative.resolution.identity.local ?? localPolicy(portfolio);
  const epicMatch = identityPattern(policy.epicPrefix, policy.pad).exec(initiative.initiative.id);
  if (!epicMatch) {
    throw new SingularityFlowError(
      `Local Epic '${initiative.initiative.id}' does not match the pinned prefix '${policy.epicPrefix}'.`
    );
  }
  const epicSequence = String(Number(epicMatch[1])).padStart(policy.pad, '0');
  const existing = new Set();
  let ordinal = 0;
  for (const epic of breakdown.epics) {
    for (const story of epic.stories) {
      ordinal += 1;
      const expected = policy.scopeStoriesByEpic
        ? `${policy.storyPrefix}-${epicSequence}-${String(ordinal).padStart(policy.pad, '0')}`
        : `${policy.storyPrefix}-${String(ordinal).padStart(policy.pad, '0')}`;
      if (story.workId && story.workId !== story.id && story.workId !== expected) {
        const pattern = identityPattern(policy.storyPrefix, policy.pad, { scoped: policy.scopeStoriesByEpic });
        if (!pattern.test(story.workId)) {
          throw new SingularityFlowError(`Story '${story.id}' Work ID '${story.workId}' does not match the pinned local identity policy.`);
        }
      } else {
        story.workId = expected;
      }
      if (existing.has(story.workId)) throw new SingularityFlowError(`Local Story ID '${story.workId}' is duplicated.`);
      existing.add(story.workId);
      story.idAuthority = 'local';
    }
  }
  breakdown.stories = breakdown.epics.flatMap((epic) => epic.stories);
  return breakdown;
}

export async function reserveLocalEpicBranch(root, portfolio, {
  base = 'main',
  actor,
  remote = portfolio.git?.remote ?? 'origin',
  maxAttempts = 5
} = {}) {
  if (branch(root) !== base) {
    throw new SingularityFlowError(`Local Epic allocation must start on base branch '${base}', not '${branch(root)}'.`);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const allocation = await nextLocalEpicId(root, portfolio, { remote, fetch: true });
    const id = allocation.id;
    checkout(root, id, { base, remote });
    const relative = posix(path.join('singularity', 'identity-reservations', `${id}.json`));
    const absolute = path.join(root, relative);
    await ensureDir(path.dirname(absolute));
    await writeJson(absolute, {
      schemaVersion: 1,
      id,
      kind: 'epic',
      authority: 'local',
      reservedAt: nowIso(),
      reservedBy: actor ?? null
    });
    add(root, [relative]);
    const reservationCommit = commit(root, `[${id}][identity:reserve] Reserve local Epic ID`);
    if (portfolio.git?.publish === 'off') {
      return { id, reservationCommit, pushed: false, attempt };
    }
    if (!hasRemote(root, remote)) {
      throw new SingularityFlowError(
        `Local Epic reservation ${id} was committed but publication is required and remote '${remote}' is unavailable.`
      );
    }
    const pushed = pushBranch(root, remote, id);
    if (pushed.status === 0) return { id, reservationCommit, pushed: true, attempt };

    fetchRemote(root, remote);
    if (!refExists(root, `refs/remotes/${remote}/${id}`)) {
      throw new SingularityFlowError(
        `Local Epic reservation ${id} was committed but could not be pushed: ${(pushed.stderr || pushed.stdout).trim()}`
      );
    }
    run('git', ['switch', base], { cwd: root });
    run('git', ['branch', '-D', id], { cwd: root });
  }
  throw new SingularityFlowError(`Unable to reserve a unique local Epic ID after ${maxAttempts} concurrent attempts.`);
}
