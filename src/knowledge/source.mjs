/**
 * The source a knowledge build reads: the committed tree at HEAD, never the working files.
 *
 * Reading the commit makes a build reproducible on any machine with the same commit and lets the
 * cache be keyed by content. Files are read through the bounded tree reader, which never fetches
 * a missing object, so a sparse or partial checkout reads only what it has. Singularity Flow's own
 * records and Git metadata are not code to explain and are never read.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { comprehensionDefinition, comprehensionPathContext, isExplainedPath } from '../comprehension/code-scope.mjs';
import { readRefTreeResult } from '../git-ref-tree.mjs';
import { head } from '../git.mjs';
import { normalizeSourceRoots } from '../source-scope.mjs';
import { SingularityFlowError } from '../util.mjs';
import { codeAreas, isCodeLanguage, languageOf } from '../code-intelligence/generated/code-explainer-model.mjs';

export const KNOWLEDGE_SOURCE_LIMITS = Object.freeze({
  maximumCodeFiles: 4000,
  maximumFileBytes: 512 * 1024,
  maximumTotalBytes: 48 * 1024 * 1024
});

/** Files that describe how a repository is built, run, tested and configured. */
const MANIFEST = /(?:^|\/)(?:package\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|pyproject\.toml|requirements(?:-[\w-]+)?\.txt|setup\.py|setup\.cfg|go\.mod|Cargo\.toml|Makefile|[\w.-]+\.csproj|AndroidManifest\.xml|application(?:-[\w-]+)?\.(?:properties|ya?ml)|\.env\.example|docker-compose\.ya?ml|Dockerfile|openapi\.(?:json|ya?ml))$/u;
const BUILD_OUTPUT = /(?:^|\/)(?:node_modules|dist|build|out|target|bin|obj|\.gradle|\.next|coverage|vendor)\//u;
const GENERATED = /(?:\.min\.js|\.bundle\.js|\.d\.ts|\.generated\.\w+|\.pb\.\w+)$/u;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Whether a path is application source this build reads. */
function isCandidateSource(relative, pathContext) {
  if (!isExplainedPath(relative, pathContext)) return false;
  if (BUILD_OUTPUT.test(relative) || GENERATED.test(relative)) return false;
  return isCodeLanguage(languageOf(relative));
}

/**
 * Read the code and manifests at HEAD under the configured source roots (or `area`).
 *
 * Over the file limit nothing is read: the result names the areas a reader can build one at a
 * time instead, because a partial repository presented as the whole one would mislead.
 */
export async function readKnowledgeSource(root, { area = null, limits = KNOWLEDGE_SOURCE_LIMITS } = {}) {
  const definition = await comprehensionDefinition(root);
  const pathContext = await comprehensionPathContext(root);
  let roots;
  try {
    roots = area
      ? normalizeSourceRoots([area], '--area')
      : [...normalizeSourceRoots(definition.worldModel?.sourceRoots, 'worldModel.sourceRoots'),
        ...normalizeSourceRoots(definition.worldModel?.sharedRoots, 'worldModel.sharedRoots')];
  } catch (error) {
    throw new SingularityFlowError(error.message, { code: 'KNOWLEDGE_SCOPE_INVALID' });
  }
  const commit = head(root);
  const listed = [];
  const listing = readRefTreeResult(root, 'HEAD', roots, {
    pathFilter: (relative, entry) => {
      if (entry.type === 'blob' && (isCandidateSource(relative, pathContext) || MANIFEST.test(relative))) listed.push(relative);
      return false;
    }
  });
  if (listing.status !== 'ok') {
    throw new SingularityFlowError(`The committed tree could not be listed: ${listing.errors[0]?.message ?? listing.status}`, {
      code: 'KNOWLEDGE_SOURCE_UNAVAILABLE'
    });
  }
  const codePaths = listed.filter((relative) => isCandidateSource(relative, pathContext));
  const base = { commit, area, roots, codePaths: codePaths.length };
  if (codePaths.length > limits.maximumCodeFiles) {
    return {
      ...base, status: 'insufficient', reason: 'too-many-files', files: [], manifests: [], skipped: [],
      areas: codeAreas(codePaths, { target: limits.maximumCodeFiles / 4 })
    };
  }
  const wanted = new Set(listed);
  const skipped = [];
  let total = 0;
  const read = readRefTreeResult(root, 'HEAD', roots, {
    pathFilter: (relative) => wanted.has(relative),
    filter: (relative, entry) => {
      if (entry.size > limits.maximumFileBytes) { skipped.push({ path: relative, reason: 'too-large', bytes: entry.size }); return false; }
      if (total + entry.size > limits.maximumTotalBytes) { skipped.push({ path: relative, reason: 'total-budget', bytes: entry.size }); return false; }
      total += entry.size;
      return true;
    },
    maxObjectBytes: limits.maximumFileBytes
  });
  if (read.status !== 'ok') {
    throw new SingularityFlowError(`The committed source could not be read: ${read.errors[0]?.message ?? read.status}`, {
      code: 'KNOWLEDGE_SOURCE_UNAVAILABLE'
    });
  }
  const files = [];
  const manifests = [];
  for (const [relative, text] of [...read.contents].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (text.includes('\u0000')) { skipped.push({ path: relative, reason: 'binary' }); continue; }
    const entry = {
      path: relative,
      language: languageOf(relative),
      lines: text.split(/\r?\n/u),
      sha256: digest(text)
    };
    if (isCandidateSource(relative, pathContext)) files.push(entry);
    else manifests.push(entry);
  }
  const key = digest(JSON.stringify([commit, roots, files.map((file) => [file.path, file.sha256]),
    manifests.map((file) => [file.path, file.sha256])]));
  return { ...base, status: 'ok', reason: null, key, files, manifests, skipped, bytes: total, name: path.basename(root) };
}
