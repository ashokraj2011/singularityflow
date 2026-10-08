/**
 * Build knowledge once per exact source and keep it on this machine.
 *
 * Deterministic knowledge is a pure function of the committed source and the analyzer version, so
 * any machine can rebuild it in seconds and nothing needs publishing: the cache is keyed by the
 * content it was built from and lives beside the repository's other machine-local state, under
 * the shared Git directory (so every Story worktree of a repository shares it). A cache entry is
 * never authority; it is only reused when its key matches exactly.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { repositoryGitPath } from '../git-directory.mjs';
import { recentCommitFileSets } from '../git.mjs';
import { analyzeKnowledge, KNOWLEDGE_ANALYZER_VERSION } from './analyze.mjs';
import { sha256 } from './items.mjs';
import { readKnowledgeSource } from './source.mjs';
import { inArea } from '../code-intelligence/generated/code-explainer-model.mjs';
import { focusStems, stemOf } from './render.mjs';

const KEEP_ENTRIES = 12;
const ANALYZER_SOURCES = ['./analyze.mjs', './producers.mjs', './items.mjs', './source.mjs', './requirements.mjs',
  '../code-intelligence/generated/code-explainer-model.mjs', '../code-intelligence/generated/code-explainer-lenses.mjs'];
let analyzerIdentity = null;

/**
 * The analyzer's own identity: a digest of the code that produces items. A cache entry built by
 * other code is a miss, so changing a reader can never serve knowledge the new reader would not
 * produce. Falls back to the version number where the sources cannot be read (a bundled build).
 */
function analyzerSourceIdentity() {
  if (analyzerIdentity) return analyzerIdentity;
  try {
    analyzerIdentity = sha256(ANALYZER_SOURCES.map((relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')).join('\0'));
  } catch {
    analyzerIdentity = `version-${KNOWLEDGE_ANALYZER_VERSION}`;
  }
  return analyzerIdentity;
}

function cacheDirectory(root) {
  return repositoryGitPath(root, 'singularity-flow', 'knowledge');
}

async function prune(directory) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json'));
  if (names.length <= KEEP_ENTRIES) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const entry of dated.sort((a, b) => b.at - a.at).slice(KEEP_ENTRIES)) await rm(path.join(directory, entry.name), { force: true });
}

/**
 * The knowledge for HEAD (or one area of it). Reads the committed source, reuses an exact cache
 * entry when there is one, and otherwise analyses and stores the result.
 */
export async function buildKnowledge(root, { area = null, ownOnly = false, history = true, refresh = false, limits = undefined } = {}) {
  const started = performance.now();
  const source = await readKnowledgeSource(root, { area, ownOnly, ...(limits ? { limits } : {}) });
  if (source.status !== 'ok') {
    return {
      status: source.status, reason: source.reason, commit: source.commit, area, areas: source.areas ?? [],
      codeFiles: source.codePaths, knowledge: null, cache: 'none', durationMs: Math.round(performance.now() - started)
    };
  }
  const key = sha256(JSON.stringify([source.key, KNOWLEDGE_ANALYZER_VERSION, analyzerSourceIdentity(), history]));
  const directory = cacheDirectory(root);
  const file = path.join(directory, `${key}.json`);
  if (!refresh) {
    const cached = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (cached?.key === key && cached.knowledge?.analyzerVersion === KNOWLEDGE_ANALYZER_VERSION) {
      return { status: 'ok', reason: null, commit: source.commit, area, knowledge: cached.knowledge, cache: 'hit', key, durationMs: Math.round(performance.now() - started) };
    }
  }
  // One history read gives both how often each file changed and which files change together.
  let churn = null;
  let commits = null;
  if (history) {
    commits = recentCommitFileSets(root, { paths: source.roots });
    const counts = new Map();
    for (const entry of commits) for (const file of entry.files) counts.set(file, (counts.get(file) ?? 0) + 1);
    churn = counts.size ? counts : null;
    if (!commits.length) commits = null;
  }
  const knowledge = analyzeKnowledge(source, { churn, commits });
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ key, builtAt: new Date().toISOString(), knowledge }));
  await rename(temporary, file);
  await prune(directory);
  return { status: 'ok', reason: null, commit: source.commit, area, knowledge, cache: 'miss', key, durationMs: Math.round(performance.now() - started) };
}

/**
 * The areas worth building for one piece of work in a repository too large to build whole: those
 * holding the files it changed, then those whose folder names match its words. Pure, so a prompt
 * and a test choose the same areas.
 */
export function selectKnowledgeAreas(areas, { changedPaths = [], focus = null, limit = 3 } = {}) {
  const stems = focusStems(focus);
  const scored = areas.map((area) => {
    const changed = changedPaths.filter((file) => inArea(file, { path: area.path === '.' ? '' : area.path, own: area.own })).length;
    const words = String(area.path).toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
    const named = stems.filter((stem) => words.some((word) => stemOf(word) === stem || (word.length >= 4 && (word.startsWith(stem) || stem.startsWith(word))))).length;
    return { area, score: changed * 10 + named * 3 };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.area.path.localeCompare(b.area.path, 'en'))
    .slice(0, limit).map((entry) => entry.area);
}

/**
 * Knowledge for several areas (paths, or `{ path, own }` from an area listing), each built and cached
 * on its own, merged into one model. Used when a
 * repository is too large to build whole: the result says which areas it covers, so no reader
 * mistakes it for the whole repository.
 */
export async function buildKnowledgeForAreas(root, areaPaths, { history = true, refresh = false, limits = undefined } = {}) {
  const started = performance.now();
  const built = [];
  for (const entry of areaPaths) {
    const area = typeof entry === 'string' ? entry : entry.path;
    const result = await buildKnowledge(root, { area, ownOnly: typeof entry === 'object' && Boolean(entry.own), history, refresh, limits });
    if (result.status === 'ok') built.push(result);
  }
  if (!built.length) return { status: 'insufficient', reason: 'no-area-built', knowledge: null, cache: 'none', key: null, durationMs: Math.round(performance.now() - started) };
  if (built.length === 1) return built[0];
  const knowledges = built.map((result) => result.knowledge);
  const first = knowledges[0];
  const items = [...new Map(knowledges.flatMap((knowledge) => knowledge.items).map((item) => [item.id, item])).values()];
  const rank = { ready: 2, thin: 1, insufficient: 0 };
  const levels = Object.fromEntries(Object.keys(first.levels).map((level) => {
    const best = knowledges.map((knowledge) => knowledge.levels[level]).sort((a, b) => rank[b.status] - rank[a.status])[0];
    return [level, best];
  }));
  const sum = (pick) => knowledges.reduce((total, knowledge) => total + (pick(knowledge) ?? 0), 0);
  const byKind = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  const knowledge = {
    ...first,
    repository: {
      ...first.repository,
      area: areaPaths.map((entry) => (typeof entry === 'string' ? entry : entry.path)).join(', '),
      roots: areaPaths.map((entry) => (typeof entry === 'string' ? entry : entry.path)),
      files: sum((entry) => entry.repository.files),
      frameworks: [...new Set(knowledges.flatMap((entry) => entry.repository.frameworks))].sort(),
      partial: true
    },
    areas: knowledges.flatMap((entry) => entry.areas),
    levels,
    metrics: {
      items: items.length, byKind,
      byLevel: Object.fromEntries(Object.keys(first.metrics.byLevel).map((level) => [level, items.filter((item) => item.level === level).length])),
      citations: items.reduce((total, item) => total + item.citations.length, 0),
      invalidCitations: sum((entry) => entry.metrics.invalidCitations),
      calls: sum((entry) => entry.metrics.calls),
      callsMatchedByName: sum((entry) => entry.metrics.callsMatchedByName),
      imports: sum((entry) => entry.metrics.imports)
    },
    graph: { imports: knowledges.flatMap((entry) => entry.graph.imports), calls: knowledges.flatMap((entry) => entry.graph.calls) },
    items
  };
  return {
    status: 'ok', reason: null, commit: first.repository.commit, area: knowledge.repository.area, knowledge,
    cache: built.every((result) => result.cache === 'hit') ? 'hit' : 'miss',
    key: sha256(JSON.stringify(built.map((result) => result.key))),
    durationMs: Math.round(performance.now() - started)
  };
}
