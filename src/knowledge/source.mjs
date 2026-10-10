/**
 * The source a knowledge build reads: the committed tree at HEAD, never the working files.
 *
 * Reading the commit makes a build reproducible on any machine with the same commit and lets the
 * cache be keyed by content. Files are read through the bounded tree reader, which never fetches
 * a missing object, so a sparse or partial checkout reads only what it has. Singularity Flow's own
 * records and Git metadata are not code to explain and are never read, and neither is anything under
 * `worldModel.excludedRoots` or declared environment-local in `singularity/environments.yml`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { comprehensionDefinition, comprehensionPathContext, isExplainedPath } from '../comprehension/code-scope.mjs';
import { loadEnvironmentDeclarationSync, matchEnvironmentLocalPath } from '../environment-declaration.mjs';
import { readRefTreeResult } from '../git-ref-tree.mjs';
import { head } from '../git.mjs';
import { normalizeSourceRoots } from '../source-scope.mjs';
import { SingularityFlowError } from '../util.mjs';
import { readApprovedRequirements } from './requirements.mjs';
import { isRuleFile } from './rule-files.mjs';
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
  // A build script such as build.gradle.kts is a manifest first, whatever its extension says.
  if (MANIFEST.test(relative)) return false;
  if (BUILD_OUTPUT.test(relative) || GENERATED.test(relative)) return false;
  return isCodeLanguage(languageOf(relative));
}

/**
 * Paths no build reads: `worldModel.excludedRoots` prefixes, and environment-local files (secrets,
 * machine settings) the repository declares. A declaration that cannot be read stops the read
 * rather than risk reading what it would have excluded.
 */
function excludedSource(root, definition) {
  let declaration;
  try {
    declaration = loadEnvironmentDeclarationSync(root, { optional: true });
  } catch (error) {
    throw new SingularityFlowError(`singularity/environments.yml could not be read, so no source was read: ${error.message}`, {
      code: 'KNOWLEDGE_SCOPE_INVALID'
    });
  }
  const prefixes = (Array.isArray(definition.worldModel?.excludedRoots) ? definition.worldModel.excludedRoots : [])
    .filter((entry) => typeof entry === 'string' && entry.trim() && !/[*?[\]{}]/u.test(entry))
    .map((entry) => entry.trim().replace(/\/+$/u, ''));
  return (relative) => prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))
    || Boolean(matchEnvironmentLocalPath(declaration, relative));
}

/**
 * Read the code and manifests at HEAD under the configured source roots (or `area`).
 *
 * Over the file limit nothing is read: the result names the areas a reader can build one at a
 * time instead, because a partial repository presented as the whole one would mislead.
 */
export async function readKnowledgeSource(root, { area = null, ownOnly = false, limits = KNOWLEDGE_SOURCE_LIMITS, listOnly = false, ref = 'HEAD' } = {}) {
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
  const excluded = excludedSource(root, definition);
  // Another branch or commit is read from Git's objects, never checked out.
  const commit = ref === 'HEAD' ? head(root) : ref;
  const listed = [];
  const listing = readRefTreeResult(root, ref === 'HEAD' ? 'HEAD' : commit, roots, {
    pathFilter: (relative, entry) => {
      // An area's own files are those directly in its folder; its subfolders are areas of their own.
      if (ownOnly && area && path.posix.dirname(relative) !== roots[0]) return false;
      if (excluded(relative)) return false;
      if (entry.type === 'blob' && (isCandidateSource(relative, pathContext) || MANIFEST.test(relative)
        || (isRuleFile(relative) && isExplainedPath(relative, pathContext) && !BUILD_OUTPUT.test(relative)))) listed.push(relative);
      return false;
    }
  });
  if (listing.status !== 'ok') {
    throw new SingularityFlowError(`The committed tree could not be listed: ${listing.errors[0]?.message ?? listing.status}`, {
      code: 'KNOWLEDGE_SOURCE_UNAVAILABLE'
    });
  }
  const codePaths = listed.filter((relative) => isCandidateSource(relative, pathContext));
  const base = { commit, area, ownOnly, roots, codePaths: codePaths.length };
  if (listOnly || codePaths.length > limits.maximumCodeFiles) {
    return {
      ...base, status: listOnly ? 'listed' : 'insufficient', reason: listOnly ? null : 'too-many-files', files: [], manifests: [], skipped: [],
      ...(listOnly ? { paths: listed } : {}),
      // Areas of about a quarter of the limit, so each one builds on its own with room to spare.
      areas: codeAreas(codePaths, { target: Math.max(1, Math.floor(limits.maximumCodeFiles / 4)), maxAreas: 60 })
    };
  }
  const wanted = new Set(listed);
  const skipped = [];
  let total = 0;
  const read = readRefTreeResult(root, ref === 'HEAD' ? 'HEAD' : commit, roots, {
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
  // Rules kept as data (JSON/YAML in rule folders): read for their rules, never as configuration keys.
  const ruleFiles = [];
  for (const [relative, text] of [...read.contents].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (text.includes('\u0000')) { skipped.push({ path: relative, reason: 'binary' }); continue; }
    const entry = {
      path: relative,
      language: languageOf(relative),
      lines: text.split(/\r?\n/u),
      sha256: digest(text)
    };
    if (isCandidateSource(relative, pathContext)) files.push(entry);
    else if (isRuleFile(relative) && !MANIFEST.test(relative)) ruleFiles.push(entry);
    else manifests.push(entry);
  }
  // What the code was asked to do: clauses of approved Story specifications, read at the same commit.
  const requirements = readApprovedRequirements(root, definition, { ref: ref === 'HEAD' ? 'HEAD' : commit });
  const key = digest(JSON.stringify([commit, roots, ownOnly, files.map((file) => [file.path, file.sha256]),
    manifests.map((file) => [file.path, file.sha256]), requirements.documents.map((document) => [document.path, document.sha256]),
    ruleFiles.map((file) => [file.path, file.sha256])]));
  return { ...base, status: 'ok', reason: null, key, files, manifests, ruleFiles, skipped, bytes: total, name: path.basename(root),
    documents: requirements.documents, requirements: requirements.clauses, requirementSkipped: requirements.skipped };
}
