import { cp, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, writeJson } from './util.mjs';

export const AST_PACK_REGISTRY_SCHEMA_VERSION = currentSchemaVersion('ast-pack-registry');

export function astPackRoot(environment = process.env) {
  return environment.SINGULARITY_FLOW_AST_PACK_ROOT
    ? path.resolve(environment.SINGULARITY_FLOW_AST_PACK_ROOT)
    : path.join(os.homedir(), '.singularity-flow', 'ast-packs');
}

function registryPath(environment = process.env) {
  return path.join(astPackRoot(environment), 'registry.json');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertSafeRoot(root) {
  const info = await lstat(root).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
    throw new SingularityFlowError('AST pack root must be a real directory, not a file or symbolic link.', { code: 'AST_PACK_ROOT_UNSAFE' });
  }
  if (info) await realpath(root);
}

function emptyRegistry() {
  return { schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION, entries: [] };
}

export async function readAstPackRegistry(environment = process.env) {
  const root = astPackRoot(environment);
  await assertSafeRoot(root);
  let registry;
  try { registry = readRecord('ast-pack-registry', await readFile(registryPath(environment))).record; }
  catch (error) {
    if (error?.code === 'ENOENT') return { ...emptyRegistry(), root, path: registryPath(environment) };
    throw error;
  }
  if (!Array.isArray(registry.entries)) throw new SingularityFlowError('AST pack registry entries must be an array.', { code: 'AST_PACK_REGISTRY_INVALID' });
  const seen = new Set();
  for (const entry of registry.entries) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry?.id ?? '') || seen.has(entry.id)
      || typeof entry.manifestPath !== 'string' || path.isAbsolute(entry.manifestPath)
      || entry.manifestPath.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(entry.manifestSha256 ?? '')) {
      throw new SingularityFlowError('AST pack registry contains an invalid or duplicate entry.', { code: 'AST_PACK_REGISTRY_INVALID' });
    }
    seen.add(entry.id);
  }
  return { ...structuredClone(registry), root, path: registryPath(environment) };
}

export async function registeredAstManifestPaths(environment = process.env) {
  const registry = await readAstPackRegistry(environment);
  const paths = [];
  for (const entry of registry.entries) {
    const manifestPath = path.join(registry.root, entry.manifestPath);
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch { throw new SingularityFlowError(`Installed AST pack '${entry.id}' manifest is unreadable.`, { code: 'AST_PACK_MANIFEST_INVALID' }); }
    if (manifest?.implementation?.manifestSha256 !== entry.manifestSha256) {
      throw new SingularityFlowError(`Installed AST pack '${entry.id}' no longer matches its registry digest.`, { code: 'AST_PACK_MANIFEST_MISMATCH' });
    }
    paths.push(manifestPath);
  }
  return paths;
}

function installPhrase(manifest) {
  return `INSTALL AST PACK ${manifest.id}@${manifest.packVersion} ${manifest.implementation.manifestSha256.slice(0, 12)}`;
}

function removePhrase(entry) {
  return `REMOVE AST PACK ${entry.id}@${entry.packVersion} ${entry.manifestSha256.slice(0, 12)}`;
}

export async function planAstPackInstall(sourceManifest, manifest, environment = process.env) {
  const registry = await readAstPackRegistry(environment);
  if (registry.entries.some((entry) => entry.id === manifest.id)) {
    throw new SingularityFlowError(`AST pack '${manifest.id}' is already installed. Remove it before installing another version.`, { code: 'AST_PACK_ALREADY_INSTALLED' });
  }
  const sourceRoot = path.dirname(path.resolve(sourceManifest));
  const sourceFiles = manifest.implementation.files?.length
    ? manifest.implementation.files.map((file) => path.isAbsolute(file.path) ? file.path : path.resolve(sourceRoot, file.path))
    : [...manifest.argv].filter((item) => path.isAbsolute(item) && inside(sourceRoot, item));
  const files = [...new Set(sourceFiles)].sort();
  if (!files.length) throw new SingularityFlowError('AST pack manifest does not identify any installable local artifacts.', { code: 'AST_PACK_ARTIFACTS_MISSING' });
  if (new Set(files.map((file) => path.basename(file))).size !== files.length) {
    throw new SingularityFlowError('AST pack artifacts must have unique filenames for a collision-free local installation.', { code: 'AST_PACK_ARTIFACT_NAME_COLLISION' });
  }
  for (const file of files) {
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || !inside(sourceRoot, file)) {
      throw new SingularityFlowError('AST pack artifacts must be real files beneath the source manifest directory.', { code: 'AST_PACK_SOURCE_UNSAFE' });
    }
  }
  const targetRelative = path.posix.join('installed', `${manifest.id}-${manifest.packVersion}-${manifest.implementation.manifestSha256.slice(0, 12)}`);
  return {
    schemaVersion: 1,
    action: 'install', pack: manifest.id, packVersion: manifest.packVersion,
    source: path.resolve(sourceManifest), sourceRoot, target: path.join(registry.root, targetRelative),
    targetRelative, files, confirmation: installPhrase(manifest), manifest,
    supportedPlatforms: [...new Set(Object.values(manifest.languageDefinitions).flatMap((entry) => entry.platforms ?? []))].sort(),
    requiredProjectKinds: [...new Set(Object.values(manifest.languageDefinitions).flatMap((entry) => entry.projectKinds ?? []))].sort(),
    licenses: structuredClone(manifest.licenses),
    restartRequired: false
  };
}

export async function applyAstPackInstall(plan, { confirm, environment = process.env } = {}) {
  if (confirm !== plan.confirmation) throw new SingularityFlowError(`AST pack installation requires --confirm '${plan.confirmation}'.`);
  const registry = await readAstPackRegistry(environment);
  await mkdir(registry.root, { recursive: true });
  await assertSafeRoot(registry.root);
  const staging = path.join(registry.root, `.install-${process.pid}-${Date.now()}`);
  const finalTarget = path.join(registry.root, plan.targetRelative);
  if (!inside(registry.root, staging) || !inside(registry.root, finalTarget)) throw new SingularityFlowError('AST pack target escaped the machine-local pack root.');
  await mkdir(staging, { recursive: false });
  try {
    const installedFiles = [];
    for (const source of plan.files) {
      const target = path.join(staging, path.basename(source));
      await cp(source, target, { force: false, errorOnExist: true });
      installedFiles.push({ source, targetName: path.basename(source) });
    }
    const finalFiles = installedFiles.map((item) => path.join(finalTarget, item.targetName));
    const sourceToFinal = new Map(installedFiles.map((item, index) => [item.source, finalFiles[index]]));
    const storedV2 = {
      protocolVersion: plan.manifest.protocolVersion,
      id: plan.manifest.id,
      packVersion: plan.manifest.packVersion,
      extractorVersion: plan.manifest.extractorVersion,
      stage: plan.manifest.stage,
      argv: structuredClone(plan.manifest.argv),
      capabilities: structuredClone(plan.manifest.capabilities),
      languages: structuredClone(plan.manifest.languageDefinitions),
      assurance: plan.manifest.assurance,
      licenses: structuredClone(plan.manifest.licenses),
      conformance: structuredClone(plan.manifest.conformance),
      implementation: structuredClone(plan.manifest.implementation)
    };
    const stored = plan.manifest.protocolVersion === 1 ? {
      protocolVersion: 1,
      id: plan.manifest.id,
      languages: structuredClone(plan.manifest.languages),
      assurance: plan.manifest.legacyClaimedAssurance ?? 'syntax',
      argv: structuredClone(plan.manifest.argv),
      extractorVersion: plan.manifest.extractorVersion,
      capabilities: structuredClone(plan.manifest.capabilities),
      implementation: structuredClone(plan.manifest.implementation)
    } : storedV2;
    stored.argv = stored.argv.map((item) => sourceToFinal.get(path.isAbsolute(item) ? path.resolve(item) : path.resolve(plan.sourceRoot, item)) ?? item);
    stored.implementation.files = stored.implementation.files.map((file) => ({
      ...file, path: sourceToFinal.get(path.isAbsolute(file.path) ? path.resolve(file.path) : path.resolve(plan.sourceRoot, file.path)) ?? file.path
    }));
    stored.implementation.manifestSha256 = '';
    const { astAdapterManifestSha256 } = await import('./ast-adapter-contract.mjs');
    stored.implementation.manifestSha256 = astAdapterManifestSha256(stored);
    const manifestName = 'manifest.json';
    await writeJson(path.join(staging, manifestName), stored);
    const installedRoot = path.dirname(finalTarget);
    const installedInfo = await lstat(installedRoot).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (installedInfo?.isSymbolicLink() || (installedInfo && !installedInfo.isDirectory())) {
      throw new SingularityFlowError('AST pack installation directory must not be a file or symbolic link.', { code: 'AST_PACK_ROOT_UNSAFE' });
    }
    await mkdir(installedRoot, { recursive: true });
    await rename(staging, finalTarget);
    const entry = {
      id: stored.id, packVersion: stored.packVersion,
      manifestPath: path.posix.join(plan.targetRelative, manifestName),
      manifestSha256: stored.implementation.manifestSha256,
      installedAt: new Date().toISOString()
    };
    const next = { schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION, entries: [...registry.entries, entry].sort((a, b) => a.id.localeCompare(b.id)) };
    try { await writeJson(registry.path, next); }
    catch (error) {
      await rm(finalTarget, { recursive: true, force: true });
      throw error;
    }
    return { schemaVersion: 1, action: 'install', installed: true, pack: entry, root: registry.root };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function planAstPackRemove(id, environment = process.env) {
  const registry = await readAstPackRegistry(environment);
  const entry = registry.entries.find((item) => item.id === id);
  if (!entry) throw new SingularityFlowError(`AST pack '${id}' is not installed in the machine registry.`, { code: 'AST_PACK_NOT_INSTALLED' });
  const target = path.dirname(path.join(registry.root, entry.manifestPath));
  if (!inside(registry.root, target)) throw new SingularityFlowError('AST pack target escaped the pack root.', { code: 'AST_PACK_REGISTRY_INVALID' });
  return { schemaVersion: 1, action: 'remove', pack: entry, target, confirmation: removePhrase(entry) };
}

export async function applyAstPackRemove(plan, { confirm, environment = process.env } = {}) {
  if (confirm !== plan.confirmation) throw new SingularityFlowError(`AST pack removal requires --confirm '${plan.confirmation}'.`);
  const registry = await readAstPackRegistry(environment);
  const next = { schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION, entries: registry.entries.filter((entry) => entry.id !== plan.pack.id) };
  const staged = `${plan.target}.remove-${process.pid}-${Date.now()}`;
  await rename(plan.target, staged);
  try {
    await writeJson(registry.path, next);
    await rm(staged, { recursive: true, force: true });
  } catch (error) {
    await writeJson(registry.path, {
      schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION,
      entries: registry.entries
    }).catch(() => {});
    await rename(staged, plan.target).catch(() => {});
    throw error;
  }
  return { schemaVersion: 1, action: 'remove', removed: true, pack: plan.pack, root: registry.root };
}

export function astPackPlanDigest(plan) {
  return recordSha256(JSON.parse(canonicalJson({ ...plan, manifest: undefined })));
}
