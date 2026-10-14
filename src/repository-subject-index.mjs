import path from 'node:path';
import { readdir } from 'node:fs/promises';
import YAML from 'yaml';
import { refHead } from './git-execution.mjs';
import { withFreshGitFacts } from './git-fact-cache.mjs';
import { readObjectsBatch, readRefTreeResult, treeEntries } from './git-ref-tree.mjs';
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

function isSubjectRecord(file, roots) {
  const directChild = (root, leaf) => {
    const prefix = `${root}/`;
    if (!file.startsWith(prefix)) return false;
    const suffix = file.slice(prefix.length);
    return suffix.endsWith(`/${leaf}`) && suffix.split('/').length === 2;
  };
  return directChild(roots.workRoot, 'workflow.json')
    || directChild(roots.initiativeRoot, 'state.json');
}
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
      GIT_NO_REPLACE_OBJECTS: '1',
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

/**
 * Every ref's subjects in a constant number of Git processes instead of about seven per ref.
 *
 * Discovery reads, for each ref, its two configuration files (to learn where its state lives), the
 * listing of each state root, and each record. One process per read made the cost grow with the
 * branch count: 68 remote branches cost 630 processes for one `session candidates`. Here every
 * ref's heads, configuration files, state-root trees and records are each read in one batch, with
 * shared objects read once. The answer per ref is exactly what `rootsForRef` and
 * `readRefTreeResult` give: direct child records only, the same fallbacks and the same
 * diagnostics. Returns null when Git fails as a whole, and the caller then reads ref by ref.
 */
function prefetchRefSubjects(root, refs, { workRoot, initiativeRoot, env }) {
  const read = (specs, options = {}) => readObjectsBatch(root, specs, { env, ...options });
  const names = refs.map((item) => (typeof item === 'string' ? item : item.ref));
  const heads = read(names.flatMap((name) => [`${name}^{commit}`, `${name}^{tree}`]), { checkOnly: true });
  if (!heads) return null;
  const commits = new Map(); const rootTrees = new Map();
  for (const name of names) {
    const commit = heads.get(`${name}^{commit}`); const tree = heads.get(`${name}^{tree}`);
    if (commit?.status !== 'ok' || commit.type !== 'commit' || tree?.status !== 'ok' || tree.type !== 'tree') continue;
    commits.set(name, commit.oid); rootTrees.set(commit.oid, tree.oid);
  }
  const distinct = [...new Set(commits.values())];
  const oidLength = distinct[0]?.length ?? 40;
  /*
   * Paths are resolved by walking tree objects, never as `<rev>:<path>`. In a blobless clone Git
   * answers a blob it does not have exactly as it answers a path that does not exist, and that
   * difference decides between "this ref has no Stories" and "this ref's Stories are unreadable
   * here". Trees are always local in such a clone; a blob read by its own ID that is missing is
   * plainly unavailable. Every level is one batch for every ref, and shared trees are read once.
   */
  const trees = new Map();
  const listTrees = (oids) => {
    const wanted = [...new Set(oids)].filter((oid) => !trees.has(oid));
    if (!wanted.length) return true;
    const answers = read(wanted);
    if (!answers) return false;
    for (const oid of wanted) {
      const answer = answers.get(oid);
      trees.set(oid, answer.status === 'ok' && answer.type === 'tree' ? treeEntries(answer.bytes, oidLength) ?? 'malformed' : 'unavailable');
    }
    return true;
  };
  const resolve = (requests) => {
    const out = new Map();
    let pending = requests.map((request) => ({ ...request, current: request.tree, index: 0 }));
    while (pending.length) {
      if (!listTrees(pending.map((entry) => entry.current))) return null;
      const next = [];
      for (const entry of pending) {
        const listed = trees.get(entry.current);
        if (listed === 'malformed') return null;
        if (listed === 'unavailable') { out.set(entry.key, { status: 'unavailable' }); continue; }
        const found = listed.find((child) => child.name === entry.parts[entry.index]);
        if (!found) { out.set(entry.key, { status: 'missing' }); continue; }
        if (entry.index === entry.parts.length - 1) { out.set(entry.key, { status: 'found', oid: found.oid, mode: found.mode }); continue; }
        if (found.mode !== '40000') { out.set(entry.key, { status: 'missing' }); continue; }
        next.push({ ...entry, current: found.oid, index: entry.index + 1 });
      }
      pending = next;
    }
    return out;
  };
  const blobs = (oids) => read([...new Set(oids)]);
  const configurationPaths = ['singularity/workflow.yml', 'singularity/portfolio.yml'];
  const initialPaths = [...new Set([...configurationPaths, workRoot, initiativeRoot])];
  const located = resolve(distinct.flatMap((commit) => initialPaths.map((relative) => (
    { key: `${commit}:${relative}`, tree: rootTrees.get(commit), parts: relative.split('/') }))));
  if (!located) return null;
  const specTreeOids = [...new Set([...located.values()]
    .filter((entry) => entry.status === 'found' && entry.mode === '40000' && !trees.has(entry.oid))
    .map((entry) => entry.oid))];
  const configBlobOids = [...new Set(distinct.flatMap((commit) => configurationPaths
    .map((relative) => located.get(`${commit}:${relative}`))
    .filter((entry) => entry?.status === 'found' && entry.mode !== '40000')
    .map((entry) => entry.oid)))];
  const configurationBlobs = blobs([...configBlobOids, ...specTreeOids]);
  if (!configurationBlobs) return null;
  for (const oid of specTreeOids) {
    const answer = configurationBlobs.get(oid);
    trees.set(oid, answer?.status === 'ok' && answer.type === 'tree' ? treeEntries(answer.bytes, oidLength) ?? 'malformed' : 'unavailable');
  }
  const parsed = new Map();
  const files = new Map();
  const roots = new Map();
  for (const commit of distinct) {
    const sources = configurationPaths.map((relative) => {
      const entry = located.get(`${commit}:${relative}`);
      if (entry.status !== 'found') return entry;
      const blob = configurationBlobs.get(entry.oid);
      return blob?.status === 'ok' && blob.type === 'blob' ? { status: 'ok', oid: entry.oid, bytes: blob.bytes } : { status: 'unavailable' };
    });
    if (sources.some((source) => source.status === 'unavailable')) {
      roots.set(commit, { status: 'unavailable', reason: 'required configuration object is unavailable locally' });
      continue;
    }
    if (sources[0].status === 'ok') files.set(`${commit}:singularity/workflow.yml`, sources[0].bytes.toString('utf8'));
    try {
      const [definition, portfolio] = sources.map((source) => {
        if (source.status !== 'ok') return null;
        if (!parsed.has(source.oid)) parsed.set(source.oid, YAML.parse(source.bytes.toString('utf8')));
        return parsed.get(source.oid);
      });
      roots.set(commit, { status: 'ok', workRoot: safeRefRoot(definition?.workItemRoot, workRoot), initiativeRoot: safeRefRoot(portfolio?.initiativeRoot, initiativeRoot) });
    } catch (error) {
      roots.set(commit, { status: 'unavailable', reason: `configuration root could not be parsed: ${error.message}` });
    }
  }
  const stateRoots = (value) => [[value.workRoot, 'workflow.json'], [value.initiativeRoot, 'state.json']];
  const ready = distinct.filter((commit) => roots.get(commit).status === 'ok');
  const directories = resolve(ready.flatMap((commit) => stateRoots(roots.get(commit)).map(([directory]) => (
    { key: `${commit}:${directory}`, tree: rootTrees.get(commit), parts: directory.split('/') }))));
  if (!directories) return null;
  // Each subject directory's own tree says whether it holds a record, without reading the record.
  const subjectDirectories = [];
  const failures = new Map();
  if (!listTrees([...directories.values()].filter((entry) => entry.status === 'found' && entry.mode === '40000').map((entry) => entry.oid))) return null;
  for (const commit of ready) {
    for (const [directory, leaf] of stateRoots(roots.get(commit))) {
      const entry = directories.get(`${commit}:${directory}`);
      if (entry.status === 'missing' || (entry.status === 'found' && entry.mode !== '40000')) continue;
      if (entry.status !== 'found') { failures.set(commit, true); continue; }
      const listed = trees.get(entry.oid);
      if (!Array.isArray(listed)) { failures.set(commit, true); continue; }
      for (const child of listed) if (child.mode === '40000') subjectDirectories.push({ commit, tree: child.oid, leaf, file: `${directory}/${child.name}/${leaf}` });
    }
  }
  const leaves = resolve(subjectDirectories.map((entry) => ({ key: `${entry.commit}:${entry.file}`, tree: entry.tree, parts: [entry.leaf] })));
  if (!leaves) return null;
  const recordBlobs = blobs([...leaves.values()].filter((entry) => entry.status === 'found').map((entry) => entry.oid));
  if (!recordBlobs) return null;
  const result = new Map();
  Object.defineProperty(result, 'files', { value: files, enumerable: false });
  for (const name of names) {
    const commit = commits.get(name);
    if (!commit) continue;
    const value = roots.get(commit);
    if (value.status !== 'ok') { result.set(name, { commit, roots: value, observed: null }); continue; }
    const errors = [];
    const contents = new Map();
    if (failures.has(commit)) errors.push({ code: 'REF_TREE_LIST_FAILED', message: `Git could not list governed state at '${name}'.`, ref: name });
    for (const { file } of failures.has(commit) ? [] : subjectDirectories.filter((entry) => entry.commit === commit)) {
      const entry = leaves.get(`${commit}:${file}`);
      if (entry.status === 'missing') continue;
      const blob = entry.status === 'found' ? recordBlobs.get(entry.oid) : null;
      if (blob?.status === 'too-large') {
        errors.push({ code: 'REF_TREE_OBJECT_TOO_LARGE', message: `${file} exceeds the governed-state object limit.`, path: file, bytes: blob.size });
      } else if (blob?.status !== 'ok' || blob.type !== 'blob') {
        errors.push({ code: 'REF_TREE_SIZE_INVALID', message: `Git returned an invalid governed-state object size at '${name}'.`, ref: name, path: file });
      } else {
        const text = blob.bytes.toString('utf8');
        contents.set(file, text);
        files.set(`${commit}:${file}`, text);
      }
    }
    result.set(name, {
      commit, roots: value,
      observed: errors.length ? { status: 'unavailable', contents: new Map(), errors } : { status: 'ok', contents, errors: [] }
    });
  }
  return result;
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
  // The batch answers the same questions; any Git failure keeps the exact per-ref reads below.
  const prefetched = refs.length > 1 && !fresh && env === process.env
    ? prefetchRefSubjects(root, refs, { workRoot, initiativeRoot, env }) : null;
  Object.defineProperty(index, 'refFiles', { value: prefetched?.files ?? new Map(), enumerable: false });
  // Where this index declines its own summary cache, it declines the Git answer cache too: a fresh
  // scan is an independent proof, and an explicit environment is caller-owned authority.
  const independent = fresh || env !== process.env;
  const ask = independent ? withFreshGitFacts : (read) => read();
  for (const item of refs) {
    const ref = typeof item === 'string' ? item : item.ref;
    const branch = typeof item === 'string' ? item.split('/').slice(1).join('/') : item.branch;
    const early = prefetched?.get(ref) ?? null;
    const commit = early?.commit ?? ask(() => refHead(root, ref, { env }));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit ?? '')) {
      index.unreadable.push(stateDiagnostic({ code: 'SUBJECT_STATE_UNAVAILABLE', path: null,
        location: { ref, branch, commit: null }, reason: 'required ref commit is unavailable locally' }));
      continue;
    }
    const cacheKey = JSON.stringify([
      path.resolve(root), commit, workRoot, initiativeRoot,
      env === process.env ? 'ambient' : 'explicit-environment'
    ]);
    const load = () => {
      if (early) return { roots: early.roots, observed: early.observed };
      // The cache key and every policy/blob read describe one immutable object, even if a fetch
      // advances the branch after refHead returned. Keep the original name only as location data.
      const roots = rootsForRef(root, commit, { workRoot, initiativeRoot, env });
      const observed = roots.status === 'ok'
        ? readRefTreeResult(root, commit, [roots.workRoot, roots.initiativeRoot], {
          // Filter by tree path before asking Git for blob sizes. A blobless workspace can have
          // every workflow.json locally while unrelated artifacts under the same root are absent.
          pathFilter: (file) => isSubjectRecord(file, roots), env
        })
        : null;
      return { roots, observed };
    };
    // Destructive-readiness checks explicitly request a fresh scan so neither stale branch bytes
    // nor an earlier caller's environment-specific cache entry can authorize local deletion.
    const cached = independent ? ask(load) : cachedRefSubjects(cacheKey, load);
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
