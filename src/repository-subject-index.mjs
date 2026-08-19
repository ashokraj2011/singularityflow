import path from 'node:path';
import { readdir } from 'node:fs/promises';
import YAML from 'yaml';
import { fileAtRef, refHead } from './git.mjs';
import { SingularityFlowError, exists, readJson, run } from './util.mjs';
import { readRecord } from './schema-migrations.mjs';

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function storyEntry(state, location) {
  const id = String(state?.workItem?.id ?? '').trim();
  if (!id || !state?.phases || !Array.isArray(state?.phaseOrder)) return null;
  const canonicalBranch = String(state.lineage?.canonicalBranch ?? state.workItem?.branch ?? id).trim();
  const branches = unique([
    state.workItem?.branch,
    canonicalBranch,
    ...(state.lineage?.childBranches ?? []).map((entry) => entry?.name)
  ]);
  const aliases = unique([
    id,
    state.lineage?.planId,
    state.lineage?.jiraIssueId,
    state.lineage?.initialJiraKey,
    state.lineage?.currentJiraKey,
    ...(state.lineage?.aliases ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.value ?? entry?.key)
  ]);
  return { kind: 'story', id, canonicalBranch, branches, aliases, state, location };
}

function initiativeEntry(state, location) {
  const id = String(state?.initiative?.id ?? '').trim();
  if (!id || !state?.phases || !Array.isArray(state?.phaseOrder)) return null;
  const canonicalBranch = String(state.initiative?.branch ?? id).trim();
  const branches = unique([canonicalBranch, ...(state.lineage?.branches ?? [])]);
  const aliases = unique([
    id,
    state.initiative?.jiraIssueId,
    state.initiative?.initialJiraKey,
    state.initiative?.currentJiraKey,
    ...(state.lineage?.aliases ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.value ?? entry?.key)
  ]);
  return { kind: 'initiative', id, canonicalBranch, branches, aliases, state, location };
}

function parseEntry(relative, content, location) {
  let state;
  try { state = typeof content === 'string' ? JSON.parse(content) : content; } catch { return null; }
  if (relative.endsWith('/workflow.json')) return storyEntry(readRecord('story-workflow', state).record, { ...location, path: relative });
  if (relative.endsWith('/state.json')) return initiativeEntry(readRecord('initiative-state', state).record, { ...location, path: relative });
  return null;
}

function preferredLocation(entry, location) {
  if (!entry.location) return location;
  /*
   * The directory named for the subject is its canonical home, whatever any other directory's
   * contents claim. Two working-tree locations for one id used to be settled by `readdir` order,
   * because neither branch clause can match when both have `branch: null` and both are
   * working-tree — so "first seen" won.
   *
   * That is a read/modify/write across two different files: `loadWorkflow` reads the location the
   * index chose while `saveWorkflow` always writes the id-derived path. Copy a work-item directory
   * aside before an experiment — the copy still says `"id": "STORY-1"` — and an approval could load
   * the stale copy and write the result over the live one, destroying every approval recorded since
   * the copy was taken.
   */
  const canonical = (candidate) => candidate.directory != null && candidate.directory === entry.id;
  if (canonical(location) !== canonical(entry.location)) {
    return canonical(location) ? location : entry.location;
  }
  if (location.branch === entry.canonicalBranch && entry.location.branch !== entry.canonicalBranch) return location;
  if (location.source === 'working-tree' && entry.location.source !== 'working-tree') return location;
  return entry.location;
}

export class RepositorySubjectIndex {
  constructor() {
    this.subjects = [];
    /** State files that exist but could not be read, so a lookup miss can say why. */
    this.unreadable = [];
  }

  add(candidate) {
    if (!candidate) return;
    const candidateLocation = { ...candidate.location, state: candidate.state };
    const existing = this.subjects.find((entry) => entry.kind === candidate.kind && entry.id === candidate.id);
    if (!existing) {
      this.subjects.push({ ...candidate, location: candidateLocation, locations: [candidateLocation] });
      return;
    }
    existing.branches = unique([...existing.branches, ...candidate.branches]);
    existing.aliases = unique([...existing.aliases, ...candidate.aliases]);
    existing.locations.push(candidateLocation);
    const selected = preferredLocation(existing, candidateLocation);
    if (selected === candidateLocation) {
      existing.location = candidateLocation;
      existing.state = candidate.state;
      existing.canonicalBranch = candidate.canonicalBranch;
    }
  }

  list(kind = null) {
    return this.subjects.filter((entry) => !kind || entry.kind === kind)
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  }

  matches(reference, { kind = null } = {}) {
    const requested = String(reference ?? '').trim();
    if (!requested) return [];
    return this.list(kind).filter((entry) => [entry.id, ...entry.aliases, ...entry.branches].includes(requested));
  }
}

async function scanDirectory(index, root, base, suffix, parser, family) {
  if (!(await exists(base))) return;
  // Sorted, so which of two candidates is seen first is never the filesystem's decision to make.
  const entries = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(base, entry.name, suffix);
    if (!(await exists(absolute))) continue;
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    try {
      index.add(parser(readRecord(family, await readJson(absolute)).record, {
        source: 'working-tree', path: relative, directory: entry.name, branch: null, ref: null, commit: null
      }));
    } catch (error) {
      /*
       * Recorded rather than discarded. The comment here said governance reports invalid state, and
       * it does not — this index is the only lookup path, so a `workflow.json` left holding conflict
       * markers made the Story disappear: `resume` said no such Story existed, and `doctor` reported
       * "skip" because it could not associate the branch with any work item. The one command written
       * to find broken state silently declined to look at it.
       */
      index.unreadable.push({ path: relative, reason: error.message });
    }
  }
}

export async function buildRepositorySubjectIndex(root, { definition = {}, portfolio = null } = {}) {
  const index = new RepositorySubjectIndex();
  await scanDirectory(index, root, path.join(root, definition.workItemRoot ?? 'singularity/work-items'), 'workflow.json', storyEntry, 'story-workflow');
  await scanDirectory(index, root, path.join(root, portfolio?.initiativeRoot ?? 'singularity/initiatives'), 'state.json', initiativeEntry, 'initiative-state');
  return index;
}

function refFiles(root, ref, roots) {
  const result = run('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', ...roots], { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter((file) => file.endsWith('/workflow.json') || file.endsWith('/state.json'));
}

function safeRefRoot(value, fallback) {
  const candidate = String(value ?? fallback).trim().replace(/\/$/, '');
  if (!candidate || candidate.startsWith(':') || path.posix.isAbsolute(candidate)
      || path.posix.normalize(candidate) !== candidate
      || candidate.split('/').includes('..') || candidate.includes('\\') || candidate.includes('\0')) {
    return fallback;
  }
  return candidate;
}

/**
 * State roots belong to the lifecycle branch that carries the state.
 *
 * Using the currently checked-out definition for every remote ref made an older Story disappear
 * as soon as a later configuration revision moved `workItemRoot`. Each Story already carries the
 * exact definition it was created under, so discovery reads only these two path settings from that
 * ref and still falls back to the caller's definition for legacy branches without a snapshot.
 */
function rootsForRef(root, ref, { workRoot, initiativeRoot }) {
  let definition = null;
  try { definition = YAML.parse(fileAtRef(root, ref, 'singularity/workflow.yml') ?? ''); } catch {}
  let portfolio = null;
  try { portfolio = YAML.parse(fileAtRef(root, ref, 'singularity/portfolio.yml') ?? ''); } catch {}
  return {
    workRoot: safeRefRoot(definition?.workItemRoot, workRoot),
    initiativeRoot: safeRefRoot(portfolio?.initiativeRoot, initiativeRoot)
  };
}

export async function buildRepositorySubjectIndexFromRefs(root, {
  definition = {},
  portfolio = null,
  refs = []
} = {}) {
  const index = new RepositorySubjectIndex();
  const workRoot = String(definition.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '');
  const initiativeRoot = String(portfolio?.initiativeRoot ?? 'singularity/initiatives').replace(/\/$/, '');
  for (const item of refs) {
    const ref = typeof item === 'string' ? item : item.ref;
    const branch = typeof item === 'string' ? item.split('/').slice(1).join('/') : item.branch;
    const roots = rootsForRef(root, ref, { workRoot, initiativeRoot });
    for (const relative of refFiles(root, ref, [roots.workRoot, roots.initiativeRoot])) {
      const content = fileAtRef(root, ref, relative);
      const candidate = content && parseEntry(relative, content, {
        source: 'ref', ref, branch, commit: refHead(root, ref)
      });
      index.add(candidate);
    }
  }
  return index;
}

function candidateText(candidates) {
  return candidates.map((entry) => `${entry.kind}:${entry.id} (${entry.canonicalBranch})`).join(', ');
}

export function resolveContext(index, {
  reference,
  kind = null,
  required = true,
  creation = false
} = {}) {
  const requested = String(reference ?? '').trim();
  if (!requested) {
    if (!required) return null;
    throw new SingularityFlowError('Enter a Story, Initiative, canonical branch, or registered child branch reference.');
  }
  const candidates = index.matches(requested, { kind });
  if (candidates.length > 1) {
    throw new SingularityFlowError(`Subject reference '${requested}' is ambiguous. Choose one of: ${candidateText(candidates)}.`);
  }
  if (!candidates.length) {
    if (creation) return { kind, id: requested, canonicalBranch: requested, selectedBranch: requested, source: 'creation-fallback', state: null };
    if (!required) return null;
    throw new SingularityFlowError(`No governed ${kind ?? 'subject'} matches '${requested}'.`);
  }
  const resolved = candidates[0];
  const selectedBranch = resolved.branches.includes(requested) ? requested : resolved.canonicalBranch;
  const selectedLocation = resolved.locations.find((location) => location.branch === selectedBranch)
    ?? resolved.locations.find((location) => location.branch === resolved.canonicalBranch)
    ?? resolved.location;
  return {
    ...resolved,
    location: selectedLocation,
    state: selectedLocation?.state ?? resolved.state,
    selectedBranch,
    source: selectedLocation?.source ?? 'working-tree'
  };
}
