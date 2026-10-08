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

const KEEP_ENTRIES = 12;
const ANALYZER_SOURCES = ['./analyze.mjs', './producers.mjs', './items.mjs', './source.mjs',
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
export async function buildKnowledge(root, { area = null, history = true, refresh = false } = {}) {
  const started = performance.now();
  const source = await readKnowledgeSource(root, { area });
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
