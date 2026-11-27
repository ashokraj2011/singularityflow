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
import { head, withEnvironmentFilesRegistry } from '../git.mjs';
import { normalizeSourceRoots } from '../source-scope.mjs';
import { SingularityFlowError } from '../util.mjs';
import { pathAliases, resolvedImports } from './producers.mjs';
import { readApprovedRequirements } from './requirements.mjs';
import { isRuleFile } from './rule-files.mjs';
import { codeAreas, isCodeLanguage, languageOf } from '../code-intelligence/generated/code-explainer-model.mjs';

/**
 * `maximumAreaFiles` and `maximumAreaLines`: an area a Story's brief reads is read whole up to this many code files and
 * lines; above either, only the part the Story needs (`areaPart`), within both. Measured on SFlow's own repository
 * (WMR §11): the cost follows the lines more than the files and grows faster than either. Analysing 212 files of 44,000
 * lines takes 0.7 s cold, 338 of 117,000 lines 3.5 s, src/'s own 1,089 files of 389,000 lines 27 s; the part of src/
 * around its most imported file, 1.3 s at 40,000 lines, 1.8 s at 60,000, 2.8 s at 80,000 and 3.9 s at 100,000.
 */
export const KNOWLEDGE_SOURCE_LIMITS = Object.freeze({
  maximumCodeFiles: 4000,
  maximumFileBytes: 512 * 1024,
  maximumTotalBytes: 48 * 1024 * 1024,
  maximumAreaFiles: 300,
  maximumAreaLines: 60_000
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

/** `worldModel.excludedRoots` as exact prefixes, sorted. */
function excludedRoots(definition) {
  return (Array.isArray(definition.worldModel?.excludedRoots) ? definition.worldModel.excludedRoots : [])
    .filter((entry) => typeof entry === 'string' && entry.trim() && !/[*?[\]{}]/u.test(entry))
    .map((entry) => entry.trim().replace(/\/+$/u, '')).sort();
}

/**
 * Paths no build reads: `worldModel.excludedRoots` prefixes, and environment-local files (secrets,
 * machine settings) the repository declares. A declaration that cannot be read stops the read
 * rather than risk reading what it would have excluded.
 */
function excludedSource(root, definition) {
  let declaration;
  try {
    declaration = withEnvironmentFilesRegistry(root, loadEnvironmentDeclarationSync(root, { optional: true }));
  } catch (error) {
    throw new SingularityFlowError(`singularity/environments.yml could not be read, so no source was read: ${error.message}`, {
      code: 'KNOWLEDGE_SCOPE_INVALID'
    });
  }
  const prefixes = excludedRoots(definition);
  return (relative) => prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))
    || Boolean(matchEnvironmentLocalPath(declaration, relative));
}

/**
 * The part of a large area a Story needs [WMR:§11]: its own files there (`story`: changed, planned or named by its
 * words), then the files they import, then the files that import them, within `maximum` files and `lines` lines (the
 * Story's own files always). Imports are read from every file's text, unmasked so it is quick (a commented-out import
 * only adds a file to the part); only the part is analysed. `importers` lists, for each of the Story's files, every
 * other file of the area that imports it: read from the whole area, so a brief may still say how many import it.
 * `importersRead` names the Story's files whose importers are all in the part.
 */
function areaPart(files, manifests, story, maximum, lines) {
  const known = new Set(files.map((file) => file.path));
  const aliases = pathAliases(manifests, [...known]);
  const importsOf = new Map();
  const importersOf = new Map();
  for (const file of files) {
    for (const edge of resolvedImports({ ...file, masked: file.lines }, known, aliases)) {
      if (!importsOf.has(file.path)) importsOf.set(file.path, new Set());
      importsOf.get(file.path).add(edge.to);
      if (!importersOf.has(edge.to)) importersOf.set(edge.to, new Set());
      importersOf.get(edge.to).add(file.path);
    }
  }
  const own = [...new Set(story)].filter((relative) => known.has(relative)).sort();
  const chosen = new Set(own);
  const length = new Map(files.map((file) => [file.path, file.lines.length]));
  let total = own.reduce((sum, relative) => sum + length.get(relative), 0);
  const take = (list) => {
    for (const relative of list) {
      if (chosen.has(relative) || chosen.size >= maximum || total + length.get(relative) > lines) continue;
      chosen.add(relative);
      total += length.get(relative);
    }
  };
  for (const relative of own) take([...(importsOf.get(relative) ?? [])].sort());
  for (const relative of own) take([...(importersOf.get(relative) ?? [])].sort());
  return { story: own, chosen, importers: Object.fromEntries(own.map((relative) => [relative, [...(importersOf.get(relative) ?? [])].filter((importer) => !own.includes(importer)).sort()])),
    importersRead: own.filter((relative) => [...(importersOf.get(relative) ?? [])].every((importer) => chosen.has(importer))) };
}

/**
 * Read the code and manifests at HEAD under the configured source roots (or `area`).
 *
 * Over the file limit nothing is read: the result names the areas a reader can build one at a
 * time instead, because a partial repository presented as the whole one would mislead.
 *
 * `scope` is the source scope a Story pinned ({ sourceRoots, sharedRoots, excludedRoots }), which compose already
 * applies [WMR:REQ-009]: it replaces the live approved configuration's, so a capability Story reads its own folders.
 *
 * `storyPaths` are a Story's files (changed, planned or named by its words). Given with an `area` that has more than
 * `limits.maximumAreaFiles` code files or `limits.maximumAreaLines` lines, only the part the Story needs is read
 * (`areaPart`), and the result's `part` says so; an area that large holding none of them is not read
 * (`area-too-large`) [WMR:§11].
 */
export async function readKnowledgeSource(root, { area = null, ownOnly = false, limits = KNOWLEDGE_SOURCE_LIMITS, listOnly = false, ref = 'HEAD', scope = null, storyPaths = null } = {}) {
  const approved = await comprehensionDefinition(root);
  const definition = scope ? { ...approved, worldModel: { ...(approved.worldModel ?? {}),
    sourceRoots: scope.sourceRoots ?? [], sharedRoots: scope.sharedRoots ?? [], excludedRoots: scope.excludedRoots ?? [] } } : approved;
  const pathContext = await comprehensionPathContext(root);
  let roots;
  let scoped;
  try {
    scoped = [...normalizeSourceRoots(definition.worldModel?.sourceRoots, 'worldModel.sourceRoots'),
      ...normalizeSourceRoots(definition.worldModel?.sharedRoots, 'worldModel.sharedRoots')];
    roots = area ? normalizeSourceRoots([area], '--area') : scoped;
  } catch (error) {
    throw new SingularityFlowError(error.message, { code: 'KNOWLEDGE_SCOPE_INVALID' });
  }
  // An area of a Story's scope stays inside it: nothing outside its roots is read.
  const outsideScope = (relative) => Boolean(area && scope && scoped.length) && !scoped.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
  const excluded = excludedSource(root, definition);
  // Another branch or commit is read from Git's objects, never checked out.
  const commit = ref === 'HEAD' ? head(root) : ref;
  const listed = [];
  const listing = readRefTreeResult(root, ref === 'HEAD' ? 'HEAD' : commit, roots, {
    pathFilter: (relative, entry) => {
      // An area's own files are those directly in its folder; its subfolders are areas of their own.
      if (ownOnly && area && path.posix.dirname(relative) !== roots[0]) return false;
      if (excluded(relative) || outsideScope(relative)) return false;
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
      ...(listOnly ? { paths: listed } : { codeFilePaths: codePaths }),
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
  let files = [];
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
  // A large area is read in part for a Story: its files and their direct imports and importers [WMR:§11].
  const maximumAreaFiles = limits.maximumAreaFiles ?? KNOWLEDGE_SOURCE_LIMITS.maximumAreaFiles;
  const maximumAreaLines = limits.maximumAreaLines ?? KNOWLEDGE_SOURCE_LIMITS.maximumAreaLines;
  let part = null;
  if (area && storyPaths && (files.length > maximumAreaFiles || files.reduce((sum, file) => sum + file.lines.length, 0) > maximumAreaLines)) {
    const chosen = areaPart(files, manifests, storyPaths, maximumAreaFiles, maximumAreaLines);
    if (!chosen.story.length) {
      return { ...base, status: 'insufficient', reason: 'area-too-large', files: [], manifests: [], skipped: [], areas: [], codeAreaFiles: files.length };
    }
    part = { area: roots[0], own: Boolean(ownOnly), files: files.length, read: chosen.chosen.size, story: chosen.story, importers: chosen.importers,
      importersRead: chosen.importersRead };
    files = files.filter((file) => chosen.chosen.has(file.path));
  }
  // What the code was asked to do: clauses of approved Story specifications, read at the same commit.
  const requirements = readApprovedRequirements(root, definition, { ref: ref === 'HEAD' ? 'HEAD' : commit });
  // What was read, never which commit it was read at: a commit that changes none of it (a Story's own records, for
  // one) keeps the same key, so nothing is analysed again [WMR:REQ-017]. History is keyed apart (store.mjs).
  const key = digest(JSON.stringify([roots, ownOnly, excludedRoots(definition), scope ? scoped : null, files.map((file) => [file.path, file.sha256]),
    manifests.map((file) => [file.path, file.sha256]), requirements.documents.map((document) => [document.path, document.sha256]),
    ruleFiles.map((file) => [file.path, file.sha256]), ...(part ? [part] : [])]));
  return { ...base, status: 'ok', reason: null, key, files, manifests, ruleFiles, skipped, bytes: total, name: path.basename(root),
    documents: requirements.documents, requirements: requirements.clauses, requirementSkipped: requirements.skipped, ...(part ? { part } : {}) };
}
