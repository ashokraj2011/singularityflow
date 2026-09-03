import path from 'node:path';
import { readdir } from 'node:fs/promises';
import YAML from 'yaml';
import { refHead } from './git.mjs';
import { readRefTreeResult } from './git-ref-tree.mjs';
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
    state.lineage?.sourceStableId,
    state.workItem?.source?.stableId,
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
  const state = typeof content === 'string' ? JSON.parse(content) : content;
  if (relative.endsWith('/workflow.json')) return storyEntry(readRecord('story-workflow', state).record, { ...location, path: relative });
  if (relative.endsWith('/state.json')) return initiativeEntry(readRecord('initiative-state', state).record, { ...location, path: relative });
  return null;
}

function stateDiagnostic({ code = 'SUBJECT_STATE_UNREADABLE', path: relative, location = {}, reason, candidate = null }) {
  return Object.freeze({
    code,
    path: relative,
    ref: location.ref ?? null,
    branch: location.branch ?? null,
    commit: location.commit ?? null,
    family: relative?.endsWith('/workflow.json') ? 'story-workflow'
      : relative?.endsWith('/state.json') ? 'initiative-state' : null,
    claimedId: candidate?.id ?? (relative ? canonicalDirectory(relative) : null),
    reason
  });
}

function canonicalDirectory(relative) {
  return path.posix.basename(path.posix.dirname(relative));
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
    /** Identity conflicts are retained even when one valid canonical record can still be shown. */
    this.conflicts = [];
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
      const candidate = parser(readRecord(family, await readJson(absolute)).record, {
        source: 'working-tree', path: relative, directory: entry.name, branch: null, ref: null, commit: null
      });
      if (candidate?.id !== entry.name) {
        index.unreadable.push(stateDiagnostic({
          code: 'SUBJECT_STATE_NONCANONICAL', path: relative, location: candidate?.location,
          candidate,
          reason: `${candidate?.kind ?? 'subject'} '${candidate?.id ?? 'unknown'}' is stored in directory '${entry.name}' instead of its canonical directory.`
        }));
        continue;
      }
      index.add(candidate);
    } catch (error) {
      /*
       * Recorded rather than discarded. The comment here said governance reports invalid state, and
       * it does not — this index is the only lookup path, so a `workflow.json` left holding conflict
       * markers made the Story disappear: `resume` said no such Story existed, and `doctor` reported
       * "skip" because it could not associate the branch with any work item. The one command written
       * to find broken state silently declined to look at it.
       */
      index.unreadable.push(stateDiagnostic({ path: relative, reason: error.message }));
    }
  }
}

export async function buildRepositorySubjectIndex(root, { definition = {}, portfolio = null } = {}) {
  const index = new RepositorySubjectIndex();
  await scanDirectory(index, root, path.join(root, definition.workItemRoot ?? 'singularity/work-items'), 'workflow.json', storyEntry, 'story-workflow');
  await scanDirectory(index, root, path.join(root, portfolio?.initiativeRoot ?? 'singularity/initiatives'), 'state.json', initiativeEntry, 'initiative-state');
  return index;
}

const isSubjectRecord = (file) => file.endsWith('/workflow.json') || file.endsWith('/state.json');
const REF_SUBJECT_CACHE_LIMIT = 128;
const refSubjectCache = new Map();

function cachedRefSubjects(key, load) {
  if (refSubjectCache.has(key)) {
    const value = refSubjectCache.get(key);
    refSubjectCache.delete(key);
    refSubjectCache.set(key, value);
    return value;
  }
  const value = load();
  refSubjectCache.set(key, value);
  while (refSubjectCache.size > REF_SUBJECT_CACHE_LIMIT) {
    refSubjectCache.delete(refSubjectCache.keys().next().value);
  }
  return value;
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
function localConfigurationAtRef(root, ref, relative, env = process.env) {
  const observed = run('git', ['show', `${ref}:${relative}`], {
    cwd: root,
    allowFailure: true,
    env: {
      ...env,
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never'
    }
  });
  if (observed.status === 0) return { status: 'ok', content: observed.stdout };
  if (/path .* does not exist|exists on disk, but not in|not exist in/i.test(observed.stderr ?? '')) {
    return { status: 'missing', content: null };
  }
  return {
    status: 'unavailable',
    content: null,
    reason: observed.timedOut ? 'local configuration read timed out'
      : observed.error?.code === 'ENOBUFS' ? 'local configuration output exceeded its bound'
        : 'required configuration object is unavailable locally'
  };
}

function rootsForRef(root, ref, { workRoot, initiativeRoot, env = process.env }) {
  const definitionSource = localConfigurationAtRef(
    root, ref, 'singularity/workflow.yml', env
  );
  const portfolioSource = localConfigurationAtRef(
    root, ref, 'singularity/portfolio.yml', env
  );
  const unavailable = [definitionSource, portfolioSource].find((entry) => entry.status === 'unavailable');
  if (unavailable) return { status: 'unavailable', reason: unavailable.reason };
  try {
    const definition = definitionSource.content ? YAML.parse(definitionSource.content) : null;
    const portfolio = portfolioSource.content ? YAML.parse(portfolioSource.content) : null;
    return {
      status: 'ok',
      workRoot: safeRefRoot(definition?.workItemRoot, workRoot),
      initiativeRoot: safeRefRoot(portfolio?.initiativeRoot, initiativeRoot)
    };
  } catch (error) {
    return { status: 'unavailable', reason: `configuration root could not be parsed: ${error.message}` };
  }
}

export async function buildRepositorySubjectIndexFromRefs(root, {
  definition = {},
  portfolio = null,
  refs = [],
  env = process.env,
  fresh = false
} = {}) {
  const index = new RepositorySubjectIndex();
  const workRoot = String(definition.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '');
  const initiativeRoot = String(portfolio?.initiativeRoot ?? 'singularity/initiatives').replace(/\/$/, '');
  for (const item of refs) {
    const ref = typeof item === 'string' ? item : item.ref;
    const branch = typeof item === 'string' ? item.split('/').slice(1).join('/') : item.branch;
    const commit = refHead(root, ref, { env });
    const cacheKey = JSON.stringify([
      path.resolve(root), commit, workRoot, initiativeRoot,
      env === process.env ? 'ambient' : 'explicit-environment'
    ]);
    const load = () => {
      const roots = rootsForRef(root, ref, { workRoot, initiativeRoot, env });
      const observed = roots.status === 'ok'
        ? readRefTreeResult(root, ref, [roots.workRoot, roots.initiativeRoot], {
          filter: isSubjectRecord, env
        })
        : null;
      return { roots, observed };
    };
    // Destructive-readiness checks explicitly request a fresh scan so neither stale branch bytes
    // nor an earlier caller's environment-specific cache entry can authorize local deletion.
    const cached = fresh ? load() : cachedRefSubjects(cacheKey, load);
    const { roots, observed } = cached;
    if (roots.status !== 'ok') {
      index.unreadable.push(stateDiagnostic({
        code: 'SUBJECT_STATE_UNAVAILABLE', path: null,
        location: { ref, branch, commit },
        reason: roots.reason
      }));
      continue;
    }
    /**
     * Two subprocesses per ref, where this was two per subject **per** ref.
     *
     * `git show` once per file and `refHead` once per file made the cost branches × Stories, and
     * `refHead` does not even vary per file — it is a property of the ref, asked once for every
     * record found on it. Measured on twelve branches and forty Stories: 966 subprocesses for one
     * `snapshot --json`, 960 of them from this loop. `readRefTree` reads the whole set in one
     * `ls-tree` and one `cat-file --batch`, which is what `ledger.mjs` already did next door for
     * the same reason.
     */
    if (observed.status !== 'ok') {
      index.unreadable.push(stateDiagnostic({
        code: observed.status === 'partial' ? 'SUBJECT_STATE_PARTIAL' : 'SUBJECT_STATE_UNAVAILABLE',
        path: null,
        location: { ref, branch, commit },
        reason: observed.errors.map((error) => error.message).join(' ') || `State at '${ref}' is ${observed.status}.`
      }));
      continue;
    }
    const claims = new Map();
    for (const [relative, content] of observed.contents) {
      const location = {
        source: 'ref', ref, branch, commit, path: relative, directory: canonicalDirectory(relative)
      };
      let candidate;
      try {
        candidate = content && parseEntry(relative, content, location);
      } catch (error) {
        index.unreadable.push(stateDiagnostic({ path: relative, location, reason: error.message }));
        continue;
      }
      if (!candidate) continue;
      const claim = `${candidate.kind}:${candidate.id}`;
      const previous = claims.get(claim);
      if (previous && previous !== relative) {
        index.conflicts.push(stateDiagnostic({
          code: 'SUBJECT_STATE_DUPLICATE', path: relative, location, candidate,
          reason: `${candidate.kind} '${candidate.id}' is claimed by both '${previous}' and '${relative}' on '${ref}'.`
        }));
      } else claims.set(claim, relative);
      if (candidate.location.directory !== candidate.id) {
        index.unreadable.push(stateDiagnostic({
          code: 'SUBJECT_STATE_NONCANONICAL', path: relative, location, candidate,
          reason: `${candidate.kind} '${candidate.id}' is stored in directory '${candidate.location.directory}' instead of its canonical directory.`
        }));
        continue;
      }
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
  const preferred = (locations) => locations.reduce((selected, location) => {
    if (!selected) return location;
    return preferredLocation({ ...resolved, location: selected }, location);
  }, null);
  const selectedLocation = preferred(resolved.locations.filter((location) => location.branch === selectedBranch))
    ?? preferred(resolved.locations.filter((location) => location.branch === resolved.canonicalBranch))
    ?? resolved.location;
  return {
    ...resolved,
    location: selectedLocation,
    state: selectedLocation?.state ?? resolved.state,
    selectedBranch,
    source: selectedLocation?.source ?? 'working-tree'
  };
}
