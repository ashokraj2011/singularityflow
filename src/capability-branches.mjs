/**
 * One base branch, across every repository in a capability.
 *
 * A Story is one unit of work, but a capability is usually several repositories, and starting work
 * on the wrong line in one of them is the kind of mistake nobody notices until integration. Until
 * now `sflow start --base` set the base for the repository the command ran in and said nothing about
 * its siblings, so keeping five repositories on `release/24.3` was five separate acts of discipline.
 *
 * This module answers two questions and decides nothing else:
 *
 *   - which branches could be chosen — the branches actually published in the capability's
 *     repositories, with how many of them have each one
 *   - whether a chosen branch can be used — and if not, exactly which repositories lack it and what
 *     they do have instead
 *
 * It never clones, checks out, or writes. The caller does that, after the answer is complete, so a
 * refusal happens before the first repository is touched rather than halfway through the set
 * `[CAP:CON-001]`.
 *
 * Refusing is the deliberate choice. Falling back to each repository's own default branch would let
 * `--from-branch release/24.3` silently produce a Story based on `main` in two repositories out of
 * five, and the evidence trail would record a base that was never asked for. An override is
 * available and explicit — `--from-branch notifications=main` — so the escape hatch exists, is
 * typed by a person, and is visible in the receipt.
 */
import { SingularityFlowError } from './util.mjs';

/**
 * The repositories a capability owns, in manifest order.
 *
 * Matching is exact on the capability id. The manifest validates ids as lower-case kebab-case, so
 * there is no case folding to do here and doing it anyway would make `Payments` silently work in one
 * place and fail in another.
 */
export function capabilityRepositories(workspace, capability) {
  const id = String(capability ?? '').trim();
  if (!id) throw new SingularityFlowError('A capability id is required to resolve its repositories.', { code: 'CAPABILITY_BRANCH_INVALID' });
  const all = Object.values(workspace?.repositories ?? {});
  const owned = all.filter((repository) => (repository.capabilities ?? []).includes(id));
  if (!owned.length) {
    const known = [...new Set(all.flatMap((repository) => repository.capabilities ?? []))].sort();
    throw new SingularityFlowError(
      `No repository in this workspace declares capability '${id}'.`
      + (known.length ? ` The workspace has: ${known.join(', ')}.` : ' The workspace declares no capabilities.'),
      { code: 'CAPABILITY_BRANCH_INVALID' }
    );
  }
  return owned;
}

/** Parse `git ls-remote --heads` output into branch names. */
export function parseRemoteHeads(output) {
  return [...new Set(String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] ?? '')
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .filter(Boolean))].sort();
}

/**
 * The branches on offer, most widely published first.
 *
 * `repositories` is `{ repositoryId: string[] }`. A branch present everywhere is what a reader
 * usually wants, so the ordering puts those first; a branch in three repositories out of five is
 * still listed, because choosing it and being told which two are missing is a reasonable next step
 * and hiding it would make the refusal message the first the reader hears of it.
 */
export function branchChoices(repositories) {
  const total = Object.keys(repositories).length;
  const counts = new Map();
  for (const branches of Object.values(repositories)) {
    for (const name of new Set(branches)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([branch, present]) => Object.freeze({
      branch,
      present,
      total,
      everywhere: present === total,
      missingFrom: Object.entries(repositories)
        .filter(([, branches]) => !branches.includes(branch))
        .map(([id]) => id)
        .sort()
    }))
    .sort((left, right) => right.present - left.present || left.branch.localeCompare(right.branch));
}

/**
 * Read `--from-branch` into a base for every repository.
 *
 * Accepts a bare branch (`release/24.3`) that applies to all of them, and `repository=branch` pairs
 * that override one. Later values win over earlier ones so a per-repository override can follow the
 * general one on the same command line, which is the order a person writes it in.
 */
export function parseBaseSelection(values = []) {
  let all = null;
  const overrides = new Map();
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const separator = value.indexOf('=');
    if (separator === -1) { all = value; continue; }
    const repository = value.slice(0, separator).trim();
    const branch = value.slice(separator + 1).trim();
    if (!repository || !branch) {
      throw new SingularityFlowError(
        `--from-branch '${value}' must be a branch name, or repository=branch for one repository.`,
        { code: 'CAPABILITY_BRANCH_INVALID' }
      );
    }
    overrides.set(repository, branch);
  }
  return { all, overrides: Object.freeze(Object.fromEntries(overrides)) };
}

/**
 * Resolve the per-repository base, or explain why it cannot be resolved.
 *
 * Always returns a complete answer rather than throwing on the first problem: a reader who has to
 * re-run the command once per missing repository learns the shape of their capability the slow way.
 */
export function resolveCapabilityBase({ repositories, selection, defaults = {} } = {}) {
  if (!repositories || !Object.keys(repositories).length) {
    throw new SingularityFlowError('Resolving a base branch needs at least one repository.', { code: 'CAPABILITY_BRANCH_INVALID' });
  }
  const { all, overrides } = selection ?? { all: null, overrides: {} };

  /** An override naming a repository outside the capability is a typo, and a silent one. */
  const unknown = Object.keys(overrides).filter((id) => !(id in repositories)).sort();

  const resolved = {};
  const missing = [];
  for (const [id, published] of Object.entries(repositories)) {
    // Precedence: an explicit per-repository override, then the branch asked for across the
    // capability, then whatever that repository already treats as its base.
    const requested = overrides[id] ?? all ?? defaults[id] ?? null;
    if (!requested) {
      missing.push({ repository: id, requested: null, published: [...published].sort(), reason: 'no base branch' });
      continue;
    }
    if (published.includes(requested)) {
      resolved[id] = { branch: requested, source: overrides[id] ? 'override' : all ? 'requested' : 'default' };
      continue;
    }
    missing.push({
      repository: id,
      requested,
      published: [...published].sort(),
      reason: overrides[id] ? 'override branch not published' : 'branch not published'
    });
  }

  return Object.freeze({
    resultType: 'capability-base-branch',
    schemaVersion: 1,
    requested: all,
    overrides,
    resolved: Object.freeze(resolved),
    missing: Object.freeze(missing.sort((left, right) => left.repository.localeCompare(right.repository))),
    unknownOverrides: Object.freeze(unknown),
    // The one thing every caller checks. Named rather than derived so no surface has to decide for
    // itself what "usable" means.
    usable: missing.length === 0 && unknown.length === 0
  });
}

/**
 * Why the start was refused, in the words a reader can act on.
 *
 * Lists every repository — the ones that are fine as well as the ones that are not — because "three
 * of five are ok" is the fact that tells someone whether they picked the wrong branch or are looking
 * at the wrong capability. Ends with the exact command that would work.
 */
export function baseRefusalReport(resolution, { capability = null } = {}) {
  if (resolution.usable) return null;
  const lines = [];
  if (resolution.unknownOverrides.length) {
    lines.push(
      `--from-branch names ${resolution.unknownOverrides.length === 1 ? 'a repository' : 'repositories'} `
      + `outside${capability ? ` capability '${capability}'` : ' this capability'}: ${resolution.unknownOverrides.join(', ')}.`
    );
  }
  if (resolution.missing.length) {
    const total = Object.keys(resolution.resolved).length + resolution.missing.length;
    const branch = resolution.requested;
    lines.push(branch
      ? `Refused: '${branch}' does not exist in ${resolution.missing.length} of ${total} capability repositories.`
      : `Refused: ${resolution.missing.length} of ${total} capability repositories have no base branch to start from.`);
    for (const [id, entry] of Object.entries(resolution.resolved)) {
      lines.push(`  ${id} — ${entry.branch}${entry.source === 'override' ? ' (override)' : ''}`);
    }
    for (const entry of resolution.missing) {
      const has = entry.published.length ? `has ${entry.published.slice(0, 6).join(', ')}` : 'has no published branches';
      lines.push(`  ${entry.repository} — missing, ${has}`);
    }
    if (branch) {
      const example = resolution.missing[0];
      lines.push(
        '', 'Re-run with a branch published in all of them, or name a base for the ones that differ:',
        `  --from-branch ${branch}` + resolution.missing
          .map((entry) => ` --from-branch ${entry.repository}=${entry.published[0] ?? '<branch>'}`)
          .join(''),
        ...(example.published.length ? [] : [`  ${example.repository} publishes no branches; check its remote before starting.`])
      );
    }
  }
  return lines.join('\n');
}

/**
 * What gets written onto the work item.
 *
 * The resolved base is evidence: it says what this Story was built on top of, per repository, and
 * whether a human overrode anything. Recording only the branch the person typed would lose the
 * distinction between "all five on release/24.3" and "four on it, one overridden to main".
 */
export function baseBranchRecord(resolution, { capability = null, selectedAt = null } = {}) {
  if (!resolution.usable) throw new SingularityFlowError('An unusable base resolution is never recorded.', { code: 'CAPABILITY_BRANCH_INVALID' });
  return Object.freeze({
    schemaVersion: 1,
    capability: capability ?? null,
    requested: resolution.requested,
    selectedAt,
    repositories: Object.freeze(Object.fromEntries(
      Object.entries(resolution.resolved)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, entry]) => [id, Object.freeze({ branch: entry.branch, source: entry.source })])
    ))
  });
}
