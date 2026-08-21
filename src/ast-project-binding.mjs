import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { posix, run, SingularityFlowError } from './util.mjs';

export const AST_PROJECT_BINDING_SCHEMA_VERSION = currentSchemaVersion('ast-project-binding');
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_PROJECT_FILES = 500;

const BUILD_FILE = /(^|\/)(?:pom\.xml|settings\.gradle(?:\.kts)?|build\.gradle(?:\.kts)?|gradle\.properties|gradle\/libs\.versions\.toml|AndroidManifest\.xml|pyproject\.toml|setup\.cfg|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile\.lock|Package\.swift|Package\.resolved|project\.pbxproj)$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rootFor(relative) {
  if (relative.endsWith('/pom.xml') || relative === 'pom.xml') return path.posix.dirname(relative);
  if (/(?:settings|build)\.gradle(?:\.kts)?$/.test(relative)) return path.posix.dirname(relative);
  if (relative.endsWith('gradle/libs.versions.toml')) return path.posix.dirname(path.posix.dirname(relative));
  if (relative.endsWith('gradle.properties')) return path.posix.dirname(relative);
  if (relative.endsWith('AndroidManifest.xml') && relative.includes('/src/')) return relative.slice(0, relative.indexOf('/src/')) || '.';
  if (/(?:pyproject\.toml|setup\.cfg|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile\.lock)$/.test(relative)) return path.posix.dirname(relative);
  if (relative.endsWith('/Package.swift') || relative === 'Package.swift' || relative.endsWith('/Package.resolved') || relative === 'Package.resolved') return path.posix.dirname(relative);
  const marker = relative.indexOf('.xcodeproj/');
  return marker >= 0 ? path.posix.dirname(relative.slice(0, marker)) : '.';
}

function projectKind(relative) {
  if (relative.endsWith('pom.xml')) return 'maven';
  if (/settings\.gradle(?:\.kts)?$/.test(relative)) return 'gradle';
  if (/build\.gradle(?:\.kts)?$/.test(relative)) return 'gradle';
  if (/(?:gradle\.properties|gradle\/libs\.versions\.toml)$/.test(relative)) return 'gradle';
  if (relative.endsWith('AndroidManifest.xml')) return 'gradle-android';
  if (/(?:pyproject\.toml|setup\.cfg|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile\.lock)$/.test(relative)) return 'python';
  if (relative.endsWith('Package.swift') || relative.endsWith('Package.resolved')) return 'swiftpm';
  if (relative.endsWith('project.pbxproj')) return 'xcode';
  return null;
}

function assertRelative(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split('/').includes('..')) {
    throw new SingularityFlowError(`${label} must be a repository-relative path.`);
  }
}

export function projectBindingSha256(value) {
  const { projectModelSha256: _project, ...content } = structuredClone(value);
  return recordSha256(content);
}

export function validateProjectBinding(value, source = 'ProjectBindingV1') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${source} must be a ProjectBindingV1 object.`);
  }
  value = readRecord('ast-project-binding', value).record;
  if (!/^[a-z][a-z0-9-]*$/.test(value.projectKind ?? '')) throw new SingularityFlowError(`${source}.projectKind is invalid.`);
  assertRelative(value.root === '.' ? './project-root' : `${value.root}/project-root`, `${source}.root`);
  for (const field of ['modules', 'sourceSets']) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string' || !item)) {
      throw new SingularityFlowError(`${source}.${field} must be a string array.`);
    }
  }
  if (!Array.isArray(value.buildFiles) || value.buildFiles.some((item) => {
    try { assertRelative(item?.path, `${source}.buildFiles.path`); } catch { return true; }
    return !DIGEST.test(item?.sha256 ?? '');
  })) throw new SingularityFlowError(`${source}.buildFiles is invalid.`);
  if (!Array.isArray(value.lockfiles) || value.lockfiles.some((item) => !item?.path || !DIGEST.test(item.sha256 ?? ''))) {
    throw new SingularityFlowError(`${source}.lockfiles is invalid.`);
  }
  if (value.toolchain != null && (!value.toolchain.kind || !value.toolchain.version || !DIGEST.test(value.toolchain.identitySha256 ?? ''))) {
    throw new SingularityFlowError(`${source}.toolchain is invalid.`);
  }
  for (const field of ['projectModelSha256', 'dependencyGraphSha256', 'configurationSha256']) {
    if (!DIGEST.test(value[field] ?? '')) throw new SingularityFlowError(`${source}.${field} must be a SHA-256 digest.`);
  }
  if (value.projectModelSha256 !== projectBindingSha256(value)) {
    throw new SingularityFlowError(`${source}.projectModelSha256 does not bind the project model.`);
  }
  return structuredClone(value);
}

function modulesFor(kind, files, root, repositoryPaths = []) {
  if (kind === 'gradle' || kind === 'gradle-android') {
    const modules = repositoryPaths.filter((file) => /(?:build\.gradle(?:\.kts)?|AndroidManifest\.xml)$/.test(file))
      .map((file) => path.posix.relative(root, file.endsWith('AndroidManifest.xml')
        ? file.slice(0, file.indexOf('/src/')) : path.posix.dirname(file)))
      .filter((value) => value && value !== '.' && !value.startsWith('../') && !value.startsWith('gradle/'));
    return [...new Set(modules)].sort();
  }
  return [];
}

function sourceSetsFor(kind, files, repositoryPaths = []) {
  if (kind === 'gradle-android') {
    const values = repositoryPaths.flatMap((file) => [...file.matchAll(/\/src\/([^/]+)\//g)].map((match) => match[1]));
    return [...new Set(values.length ? values : ['main'])].sort();
  }
  if (kind === 'gradle') {
    const values = repositoryPaths.flatMap((file) => [...file.matchAll(/\/src\/([^/]+)\//g)].map((match) => match[1]));
    return [...new Set(values)].sort();
  }
  return [];
}

function dependencyDigest(files) {
  const locks = files.filter((file) => /(?:\.lock|Package\.resolved|libs\.versions\.toml)$/.test(file.path));
  return recordSha256(locks.map(({ path: filePath, sha256: digest }) => ({ path: filePath, sha256: digest })));
}

/**
 * Existing-only project discovery: Git supplies names and the checkout supplies only the bounded
 * metadata bytes already present. No build tool, package manager, IDE, network, or repository
 * script is invoked.
 */
export async function discoverProjectBindings(root, { paths = null, maxFiles = MAX_PROJECT_FILES, includeWarm = true } = {}) {
  const repositoryPaths = run('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).stdout
    .split('\0').filter(Boolean).map(posix);
  const listed = repositoryPaths.filter((relative) => BUILD_FILE.test(relative));
  const relevant = paths?.length
    ? listed.filter((relative) => {
      const projectRoot = rootFor(relative) || '.';
      return paths.some((prefix) => projectRoot === '.' || prefix === projectRoot
        || prefix.startsWith(`${projectRoot}/`) || projectRoot.startsWith(`${prefix}/`));
    })
    : listed;
  const truncated = relevant.length > maxFiles;
  const metadata = [];
  for (const relative of relevant.slice(0, maxFiles)) {
    const bytes = await readFile(path.join(root, relative)).catch(() => null);
    if (!bytes) continue;
    metadata.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length, kind: projectKind(relative), root: rootFor(relative) || '.' });
  }
  const groups = new Map();
  const gradleRoots = metadata.filter((entry) => /(?:^|\/)settings\.gradle(?:\.kts)?$/.test(entry.path))
    .map((entry) => entry.root).sort((left, right) => right.length - left.length);
  for (const file of metadata.filter((entry) => entry.kind)) {
    const isGradle = file.kind === 'gradle' || file.kind === 'gradle-android';
    const resolvedRoot = isGradle
      ? gradleRoots.find((candidate) => candidate === '.' || file.path === candidate || file.path.startsWith(`${candidate}/`)) ?? file.root
      : file.root;
    const key = `${isGradle ? 'gradle' : file.kind}\0${resolvedRoot}`;
    const group = groups.get(key) ?? { kind: file.kind, root: resolvedRoot, files: [] };
    if (file.kind === 'gradle-android') group.kind = 'gradle-android';
    group.files.push(file);
    groups.set(key, group);
  }
  const coveredJava = [...groups.values()].some((group) => ['maven', 'gradle', 'gradle-android'].includes(group.kind));
  const selectedJava = repositoryPaths.some((relative) => relative.endsWith('.java') && (!paths?.length
    || paths.some((prefix) => prefix === relative || relative.startsWith(`${prefix}/`) || prefix.startsWith(`${path.posix.dirname(relative)}/`))));
  if (selectedJava && !coveredJava) groups.set('java-standalone\0.', { kind: 'java-standalone', root: '.', files: [] });
  const bindings = [];
  for (const group of [...groups.values()].sort((left, right) => `${left.root}\0${left.kind}`.localeCompare(`${right.root}\0${right.kind}`))) {
    const files = group.files.map(({ path: filePath, sha256: digest }) => ({ path: filePath, sha256: digest })).sort((a, b) => a.path.localeCompare(b.path));
    const lockfiles = files.filter((file) => /(?:\.lock|Package\.resolved|libs\.versions\.toml)$/.test(file.path));
    const binding = {
      schemaVersion: AST_PROJECT_BINDING_SCHEMA_VERSION,
      projectKind: group.kind,
      root: group.root,
      modules: modulesFor(group.kind, group.files, group.root, repositoryPaths),
      sourceSets: sourceSetsFor(group.kind, group.files, repositoryPaths),
      profile: null,
      buildFiles: files.filter((file) => !lockfiles.some((lock) => lock.path === file.path)),
      lockfiles,
      toolchain: null,
      projectModelSha256: '',
      dependencyGraphSha256: dependencyDigest(files),
      configurationSha256: recordSha256({ projectKind: group.kind, root: group.root, files }),
      complete: false,
      unavailable: ['explicit-toolchain-binding', 'module-profile-binding']
    };
    binding.projectModelSha256 = projectBindingSha256(binding);
    const validated = validateProjectBinding(binding);
    if (includeWarm) {
      const { readAstSemanticBinding } = await import('./ast-semantic-warm.mjs');
      bindings.push(await readAstSemanticBinding(root, validated) ?? validated);
    } else bindings.push(validated);
  }
  return {
    schemaVersion: 1,
    mode: 'existing-only',
    bindings,
    truncated,
    selectedMetadataFiles: metadata.length,
    digest: recordSha256(bindings),
    diagnostics: truncated ? [{ code: 'AST_PROJECT_DISCOVERY_BUDGET', count: relevant.length - maxFiles }] : []
  };
}

export function bindingForFile(bindings, relative, projectKinds = []) {
  const compatible = bindings.filter((binding) => (!projectKinds.length || projectKinds.includes(binding.projectKind))
    && (binding.root === '.' || relative === binding.root || relative.startsWith(`${binding.root}/`)))
    .sort((left, right) => right.root.length - left.root.length || left.projectKind.localeCompare(right.projectKind));
  return compatible[0] ?? null;
}

export function projectBindingCanonicalJson(binding) {
  return canonicalJson(validateProjectBinding(binding));
}
