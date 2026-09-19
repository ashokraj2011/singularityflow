import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_ROOT } from '../package-root.mjs';

function absolutePath(item) {
  if (typeof item.path === 'string') return path.resolve(item.path);
  if (item.url instanceof URL) return fileURLToPath(item.url);
  throw new TypeError('Implementation digest entries require an absolute path or file URL.');
}

function filesBelow(directory, prefix) {
  const values = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const label = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) values.push(...filesBelow(absolute, label));
    else if (entry.isFile()) values.push({ absolute, label });
  }
  return values;
}

/**
 * Hash reviewed implementation bytes under stable package-relative labels.
 *
 * Durable WMB identities must change when executable/schema bytes change. Hashing a version label
 * merely asks maintainers to remember to invalidate caches; hashing the packaged bytes makes that
 * invalidation mechanical and independent of the installation directory.
 */
export function implementationSourceSha256({ directories = [], files = [] } = {}) {
  const entries = [];
  for (const item of directories) {
    entries.push(...filesBelow(absolutePath(item), item.label));
  }
  for (const item of files) {
    entries.push({ absolute: absolutePath(item), label: item.label });
  }
  entries.sort((left, right) => left.label.localeCompare(right.label));
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.label, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(entry.absolute));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function manifestFailure(message, code, details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = details;
  throw error;
}

function normalizedPackagePath(value, label) {
  const candidate = String(value ?? '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(candidate);
  if (!candidate || normalized !== candidate || normalized.startsWith('../')
      || normalized.startsWith('/') || normalized.includes('\0')) {
    manifestFailure(`${label} is not a safe package-relative path.`,
      'WMP_IMPLEMENTATION_SOURCE_PATH_INVALID', { path: candidate || null });
  }
  return normalized;
}

function regularFile(packageRoot, relative, label) {
  const absolute = path.join(packageRoot, ...relative.split('/'));
  let stats;
  try { stats = lstatSync(absolute); }
  catch (error) {
    manifestFailure(`${label} does not resolve to a packaged source file.`,
      'WMP_IMPLEMENTATION_IMPORT_UNRESOLVED', { path: relative, cause: error.code ?? null });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    manifestFailure(`${label} must be an ordinary packaged source file.`,
      'WMP_IMPLEMENTATION_SOURCE_PATH_INVALID', { path: relative });
  }
  return absolute;
}

/**
 * Materialize an explicit append-only source manifest. The build-time TypeScript-AST auditor owns
 * closure discovery and requires exact equality with these lists; runtime code only verifies and
 * hashes the reviewed ordinary files, so production packages do not need a parser dependency.
 */
export function reviewedImplementationSourceManifest({
  packageRoot = PACKAGE_ROOT,
  id = 'reviewed-implementation',
  version = 1,
  entries = [],
  reviewedFiles = [],
  reviewedBuiltins = [],
  reviewedPackages = [],
  resources = []
} = {}) {
  const normalizedEntries = [...new Set(entries.map((entry) => (
    normalizedPackagePath(entry, 'Implementation entry')
  )))].sort();
  const files = [...new Set(reviewedFiles.map((entry) => (
    normalizedPackagePath(entry, 'Reviewed implementation file')
  )))].sort();
  if (!normalizedEntries.length || !files.length) {
    manifestFailure('Reviewed implementation source manifest cannot be empty.',
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID');
  }
  const reviewed = new Set(files);
  for (const entry of normalizedEntries) {
    if (!reviewed.has(entry)) manifestFailure(`Implementation entry '${entry}' is not reviewed.`,
      'WMP_IMPLEMENTATION_IMPORT_UNREVIEWED', { entry });
  }
  const declaredBuiltins = [...new Set(reviewedBuiltins)].sort();
  const declaredPackages = [...new Set(reviewedPackages)].sort();
  const descriptions = new Map();
  for (const file of files) {
    const absolute = regularFile(packageRoot, file, 'Reviewed implementation file');
    const bytes = readFileSync(absolute);
    descriptions.set(file, Object.freeze({
      path: file,
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      localImports: Object.freeze([])
    }));
  }
  const resourceDescriptions = [...new Set(resources.map((entry) => (
    normalizedPackagePath(entry, 'Reviewed implementation resource')
  )))].sort().map((resource) => {
    const bytes = readFileSync(regularFile(packageRoot, resource, 'Reviewed implementation resource'));
    return Object.freeze({
      path: resource,
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    });
  });
  const manifest = {
    kind: 'wmp/reviewed-implementation-source-manifest',
    id,
    version,
    entrypoints: normalizedEntries,
    modules: files.map((file) => descriptions.get(file)),
    builtins: declaredBuiltins,
    packages: declaredPackages,
    resources: resourceDescriptions
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  return Object.freeze({
    ...manifest,
    sourceSha256: implementationSourceSha256({
      files: [
        ...files.map((file) => ({
        label: file, path: path.join(packageRoot, ...file.split('/'))
        })),
        ...resourceDescriptions.map((resource) => ({
          label: resource.path, path: path.join(packageRoot, ...resource.path.split('/'))
        }))
      ]
    }),
    manifestSha256: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`
  });
}

export const WMB_V4_KERNEL_SOURCE_SHA256 = implementationSourceSha256({
  directories: [{
    label: 'src/world-model', path: path.join(PACKAGE_ROOT, 'src', 'world-model')
  }],
  files: [
    {
      label: 'src/repository-facts.mjs',
      path: path.join(PACKAGE_ROOT, 'src', 'repository-facts.mjs')
    },
    {
      label: 'schemas/world-model-composition-candidate.schema.json',
      path: path.join(PACKAGE_ROOT, 'schemas', 'world-model-composition-candidate.schema.json')
    }
  ]
});

export const WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256 = implementationSourceSha256({
  files: [{
    label: 'schemas/world-model-composition-candidate.schema.json',
    path: path.join(PACKAGE_ROOT, 'schemas', 'world-model-composition-candidate.schema.json')
  }]
});
