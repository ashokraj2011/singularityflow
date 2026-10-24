/**
 * `repository.query`: the typed Git question set, and nothing that is not a question. `[INT:IFC-040]`
 *
 * Fourteen queries, each a closed shape over a registered repository: list, status, branches, tags,
 * log, commit, path history, blame, diff, merge base, containment, exact text search, version to
 * commit, and build to commit. There is no argv anywhere in the input — a query names what it wants
 * and the schema types every value — so the gateway exposes typed reads and never Git itself
 * `[INT:CON-081]`. The Git reads live in `src/git-access.mjs` with a timeout, no lazy fetch and literal
 * pathspecs; this planner chooses among them and shapes the evidence.
 *
 * Containment is by construction rather than by checking afterwards `[INT:CON-080]`:
 *
 *   - the repository is the host-bound root, or a repository the selected workspace registers; an
 *     unregistered path cannot be named at all, and a registered one that is not on this machine is
 *     answered with attach or materialize guidance, never by looking around `[INT:REQ-154]`;
 *   - paths are repository-relative by schema and literal by pathspec;
 *   - every read is at an explicit revision of the object store, so a symlink is its link text and
 *     never the file it points at, and nothing outside the repository is opened;
 *   - search skips binaries in Git, drops blobs over a size bound afterwards, and excludes secret,
 *     generated and vendored paths by pathspec, reporting each exclusion that applied `[INT:CON-082]`.
 *
 * Every fact keeps its repository, exact commit, path and line where there is one, the retrieval
 * time, and an evidence handle — the content address of the answer `[INT:REQ-081]`. Which tree a
 * fact came from is named, because "the code" can mean the working tree, the index, HEAD or a
 * released build, and those disagree exactly when someone is investigating `[INT:REQ-082]`.
 */
import { createHash } from 'node:crypto';

import {
  typedBlame, typedChangedPaths, typedCommit, typedGrep, typedLog, typedMergeBase, typedPatch, typedRefs,
  typedRevision, typedStatus, typedSubmodules, typedVersionCommit
} from '../../git-access.mjs';
import { canonicalJson } from '../../specifications.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';

export const REPOSITORY_QUERIES = Object.freeze([
  'repositories', 'status', 'branches', 'tags', 'log', 'commit', 'path-history', 'blame', 'diff',
  'merge-base', 'contains', 'search', 'version-commit', 'build-commit'
]);

/**
 * What search never looks inside. Secrets, generated output, vendored trees and lockfiles: the first
 * because a match would put a credential in a result, the rest because a match there is noise that
 * hides the match that matters.
 */
export const SEARCH_EXCLUSIONS = Object.freeze([
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*',
  '**/secrets/**', '**/.git-credentials', '**/.npmrc', '**/node_modules/**', '**/vendor/**', '**/dist/**',
  '**/build/**', '**/*.min.js', '**/*.generated.*', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock'
]);

const MAX_SEARCH_BLOB_BYTES = 1024 * 1024;

function evidenceHandle(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function refusal(code, slots, { restState = 'blocked', source = 'deterministic' } = {}) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'repository.query', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots },
    effects: noEffects(),
    why: [{ code, source, slots }],
    preserved: preservedAll('repository.explore.nothing-was-carried-out'),
    restState
  });
}

/** The repositories the selected workspace registers, read from its manifest. Never a directory scan. */
async function registeredRepositories(context, env) {
  const workspaceId = context.workspace?.id ?? null;
  if (!workspaceId) return null;
  const [{ readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath }, { workspaceRegistryFile }] = await Promise.all([
    import('../../workspace-manifest.mjs'), import('../../workspace-context.mjs')
  ]);
  const entry = (await readWorkspaceRegistry(workspaceRegistryFile(env))).find((item) => item.id === workspaceId && !item.archivedAt);
  if (!entry) return null;
  const workspace = await readWorkspace(entry.path);
  const { existsSync } = await import('node:fs');
  return Object.entries(workspace.repositories ?? {}).map(([id, repository]) => {
    const location = workspaceRepositoryPath(workspace, id);
    return { id, capabilities: [...(repository.capabilities ?? [])], onThisMachine: Boolean(location && existsSync(location)) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function identifiesRoot(root, requested, context) {
  if (!requested) return true;
  return [root, context.repositoryId, context.repository?.id].filter(Boolean).map(String).includes(String(requested));
}

function exact(root, revision, label) {
  const commit = typedRevision(root, revision);
  if (!commit) throw Object.assign(new Error(label), { refusal: ['repository.query.revision-unresolved', { revision: String(revision) }] });
  return commit;
}

/** Answer one typed query from the bound repository. Returns `{ tree, facts, extra }`. */
function answer(root, args) {
  const max = args.max ?? 50;
  const revision = args.revision ?? 'HEAD';
  switch (args.query) {
    case 'status': {
      const status = typedStatus(root, { max });
      return { tree: 'working-tree-and-index', facts: status.entries, extra: { total: status.total, truncated: status.truncated } };
    }
    case 'branches': case 'tags': {
      const refs = typedRefs(root, { kind: args.query === 'tags' ? 'tag' : 'branch', max });
      return { tree: 'refs', facts: refs.refs, extra: { truncated: refs.truncated } };
    }
    case 'log': case 'path-history': {
      if (args.query === 'path-history' && !args.path) throw Object.assign(new Error('path'), { refusal: ['repository.query.needs', { field: 'path' }] });
      const commit = exact(root, revision, 'revision');
      const log = typedLog(root, { revision: commit, path: args.path ?? null, max, exclude: args.base ? exact(root, args.base, 'base') : null });
      return { tree: 'commit-history', commit, facts: log.commits, extra: { truncated: log.truncated } };
    }
    case 'commit': {
      const commit = exact(root, revision, 'revision');
      return { tree: 'commit', commit, facts: [typedCommit(root, commit, { maxPaths: max })] };
    }
    case 'blame': {
      if (!args.path) throw Object.assign(new Error('path'), { refusal: ['repository.query.needs', { field: 'path' }] });
      const commit = exact(root, revision, 'revision');
      const blame = typedBlame(root, { revision: commit, path: args.path, start: args.lineStart ?? 1, end: args.lineEnd ?? null, maxLines: Math.min(max, 200) });
      return { tree: 'commit', commit, facts: blame.lines.map((line) => ({ ...line, path: args.path })), extra: { range: blame.range } };
    }
    case 'diff': {
      const commit = exact(root, revision, 'revision');
      const base = args.base ? exact(root, args.base, 'base') : typedCommit(root, commit, { maxPaths: 1 })?.parents?.[0];
      if (!base) throw Object.assign(new Error('base'), { refusal: ['repository.query.needs', { field: 'base' }] });
      const changed = typedChangedPaths(root, base, commit, { paths: args.path ? [args.path] : [], max });
      const patch = args.path ? typedPatch(root, base, commit, args.path) : null;
      return { tree: 'commit-range', commit, facts: changed.entries.map((entry) => ({ ...entry, base, commit })),
        extra: { base, total: changed.total, truncated: changed.truncated, patch } };
    }
    case 'merge-base': {
      if (!args.base) throw Object.assign(new Error('base'), { refusal: ['repository.query.needs', { field: 'base' }] });
      const left = exact(root, args.base, 'base');
      const right = exact(root, revision, 'revision');
      return { tree: 'commit-graph', commit: right, facts: [{ left, right, mergeBase: typedMergeBase(root, left, right) }] };
    }
    case 'contains': {
      const commit = exact(root, revision, 'revision');
      return { tree: 'refs', commit, facts: [
        ...typedRefs(root, { kind: 'branch', contains: commit, max }).refs.map((ref) => ({ ...ref, kind: 'branch' })),
        ...typedRefs(root, { kind: 'tag', contains: commit, max }).refs.map((ref) => ({ ...ref, kind: 'tag' }))
      ] };
    }
    case 'search': {
      if (!args.text) throw Object.assign(new Error('text'), { refusal: ['repository.query.needs', { field: 'text' }] });
      const commit = exact(root, revision, 'revision');
      const found = typedGrep(root, { revision: commit, text: args.text, paths: args.path ? [args.path] : [],
        excludes: SEARCH_EXCLUSIONS, max, maxBlobBytes: MAX_SEARCH_BLOB_BYTES });
      return { tree: 'commit', commit, facts: found.matches.map((match) => ({ ...match, commit })),
        extra: { truncated: found.truncated, excludedPatterns: [...SEARCH_EXCLUSIONS], oversized: found.oversized } };
    }
    case 'version-commit': {
      const mapped = typedVersionCommit(root, args.version);
      if (!mapped) throw Object.assign(new Error('version'), { refusal: ['repository.query.version-unmapped', { version: String(args.version ?? '') }] });
      return { tree: 'refs', commit: mapped.commit, facts: [{ version: args.version, tag: mapped.tag, commit: mapped.commit, mapping: 'exact-tag' }] };
    }
    default:
      throw new SingularityFlowError(`'${args.query}' is not a repository query.`, { code: 'REPOSITORY_QUERY_UNKNOWN' });
  }
}

export async function repositoryQuery({ arguments: args = {}, subject = null, root = null, context = {}, env = process.env, now = () => new Date(), runs = null } = {}) {
  if (!root) throw new SingularityFlowError('repository.query requires the repository root it should read.', { code: 'REPOSITORY_QUERY_NO_ROOT' });
  const retrievedAt = now().toISOString();
  if (args.query === 'repositories') {
    const registered = await registeredRepositories(context, env);
    const facts = registered ?? [{ id: context.repositoryId ?? 'this-repository', capabilities: [], onThisMachine: true }];
    return result({ args, root, context, subject, retrievedAt, tree: 'workspace-manifest', facts,
      warnings: registered ? [] : [{ code: 'repository.query.no-workspace-selected', source: 'unavailable', slots: {} }] });
  }
  if (!identifiesRoot(root, args.repositoryId, context)) {
    // A repository this session is not bound to. If the workspace registers it, say how to reach
    // it; either way, look nowhere else `[INT:REQ-154]`.
    const registered = (await registeredRepositories(context, env))?.find((repository) => repository.id === args.repositoryId);
    return refusal(registered ? 'repository.query.switch-to-repository' : 'repository.query.not-registered',
      { repository: String(args.repositoryId), onThisMachine: String(registered?.onThisMachine ?? false) });
  }
  if (args.query === 'build-commit') {
    // Only a configured read-only provider can map a build to a commit, and only through the exact
    // commit it reports; repository evidence alone would be the guess `[INT:CON-093]` forbids.
    const { readBuilds } = await import('../build-provenance.mjs');
    const read = await readBuilds(root, { repositoryId: context.repositoryId ?? null, env, now, runs });
    if (read.gap) {
      return refusal('repository.query.build-provider-unavailable', { buildId: String(args.buildId ?? ''), gap: read.gap },
        { restState: 'unavailable', source: 'unavailable' });
    }
    const build = read.builds.find((entry) => entry.buildId === String(args.buildId ?? ''));
    if (!build?.sourceCommit) {
      return refusal('repository.query.build-unmapped', { buildId: String(args.buildId ?? '') }, { source: 'provider' });
    }
    return result({ args, root, context, subject, retrievedAt, tree: 'build-provider', commit: build.sourceCommit,
      facts: [{ ...build, relation: 'built-from', language: 'built from this commit' }] });
  }
  let answered;
  try { answered = answer(root, args); } catch (error) {
    if (error.refusal) return refusal(...error.refusal);
    throw error;
  }
  const submodules = answered.commit ? typedSubmodules(root, answered.commit) : [];
  return result({ args, root, context, subject, retrievedAt, ...answered, submodules });
}

function result({ args, root, context, subject, retrievedAt, tree, commit = null, facts, extra = {}, submodules = [], warnings = [] }) {
  const repositoryId = args.repositoryId ?? context.repositoryId ?? root;
  const evidence = { repository: repositoryId, query: args.query, commit, tree, facts };
  const handle = evidenceHandle(evidence);
  return sflowResult({
    kind: 'read',
    operation: { id: 'repository.query', classification: 'read' },
    subject: subjectWith(subject, { kind: 'repository', id: repositoryId, revision: { sourceCommit: commit } }),
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { query: args.query, facts: String(facts.length) } },
    effects: noEffects(),
    why: [{ code: 'repository.query.typed-read', source: 'deterministic', reference: handle,
      slots: { query: args.query, tree, commit: commit ?? 'none' } }],
    warnings: [
      ...warnings,
      ...(extra.truncated ? [{ code: 'repository.query.truncated', source: 'deterministic', slots: { shown: String(facts.length) } }] : []),
      ...(submodules.length ? [{ code: 'repository.query.submodules-not-descended', source: 'deterministic',
        slots: { count: String(submodules.length) } }] : []),
      ...(extra.oversized?.length ? [{ code: 'repository.query.large-files-skipped', source: 'deterministic',
        slots: { count: String(extra.oversized.length) } }] : [])
    ],
    preserved: preservedAll('repository.explore.nothing-was-carried-out', { reference: repositoryId }),
    restState: 'informational',
    data: {
      repository: repositoryId,
      query: args.query,
      // `[INT:REQ-082]`: which of the trees a reader might mean this was read from.
      tree,
      commit,
      retrievedAt,
      evidenceHandle: handle,
      facts,
      ...extra,
      submodules
    }
  });
}
