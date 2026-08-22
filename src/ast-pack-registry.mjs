import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const AST_PACK_REGISTRY_SCHEMA_VERSION = currentSchemaVersion('ast-pack-registry');
export function astPackRoot(env = process.env) { return env.SINGULARITY_FLOW_AST_PACK_ROOT ? path.resolve(env.SINGULARITY_FLOW_AST_PACK_ROOT) : path.join(os.homedir(), '.singularity-flow', 'ast-packs'); }
const registryPath = (env) => path.join(astPackRoot(env), 'registry.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashFile = async (file) => sha(await readFile(file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function error(message, code, details) { throw new SingularityFlowError(message, { code, details }); }
function inside(root, target) { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
async function safeRoot(root) { const info = await lstat(root).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e)); if (info?.isSymbolicLink() || (info && !info.isDirectory())) error('AST pack root is unsafe.', 'AST_PACK_ROOT_UNSAFE'); if (info) await realpath(root); }
function validateRegistry(value) {
  if (!Array.isArray(value.entries)) error('AST pack registry is invalid.', 'AST_PACK_REGISTRY_INVALID');
  const ids = new Set();
  for (const e of value.entries) {
    if (!/^[a-z][a-z0-9-]*$/.test(e?.id ?? '') || ids.has(e.id) || typeof e.manifestPath !== 'string' || path.isAbsolute(e.manifestPath) || e.manifestPath.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(e.manifestSha256 ?? '')) error('AST pack registry contains an invalid entry.', 'AST_PACK_REGISTRY_INVALID');
    ids.add(e.id);
  }
  return value;
}
export async function readAstPackRegistry(env = process.env) {
  const root = astPackRoot(env); await safeRoot(root); let value;
  try { value = readRecord('ast-pack-registry', await readFile(registryPath(env))).record; } catch (e) { if (e.code === 'ENOENT') return { schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION, entries: [], root, path: registryPath(env) }; throw e; }
  return { ...structuredClone(validateRegistry(value)), root, path: registryPath(env) };
}
function syncDir(dir) { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true }); const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`); const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); syncDir(path.dirname(file)); } catch (e) { await rm(temp, { force: true }); throw e; }
}
function alive(owner) { if (owner?.hostname !== os.hostname() || !Number.isInteger(owner?.pid)) return null; try { process.kill(owner.pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : null; } }
async function lock(env, transactionId) {
  const root = astPackRoot(env), file = path.join(root, 'registry.lock'), start = Date.now(); await mkdir(root, { recursive: true }); await safeRoot(root);
  while (true) try {
    const handle = await open(file, 'wx', 0o600); await handle.writeFile(`${JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), transactionId })}\n`); await handle.sync(); await handle.close();
    return async () => { const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')); if (current.transactionId === transactionId) { await rm(file, { force: true }); syncDir(root); } };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e; let owner; try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { error('Registry lock ownership is uncertain.', 'AST_PACK_REGISTRY_LOCK_UNCERTAIN'); }
    const state = alive(owner); if (state === false) { await rm(file, { force: true }); continue; } if (state == null) error('Registry lock ownership is uncertain.', 'AST_PACK_REGISTRY_LOCK_UNCERTAIN'); if (Date.now() - start > 10000) error('Registry is busy.', 'AST_PACK_REGISTRY_LOCKED'); await sleep(20);
  }
}
export async function registeredAstManifestPaths(env = process.env) {
  const registry = await readAstPackRegistry(env), result = [];
  for (const entry of registry.entries) { const file = path.join(registry.root, entry.manifestPath); let manifest; try { manifest = JSON.parse(await readFile(file, 'utf8')); } catch { error(`Installed AST pack '${entry.id}' manifest is unreadable.`, 'AST_PACK_MANIFEST_INVALID'); } if (manifest?.implementation?.manifestSha256 !== entry.manifestSha256) error(`Installed AST pack '${entry.id}' digest mismatches.`, 'AST_PACK_MANIFEST_MISMATCH'); result.push(file); }
  return result;
}
function token(plan) { const bound = recordSha256({ planVersion: plan.planVersion, packId: plan.packId, packVersion: plan.packVersion, packSchemaVersion: plan.packSchemaVersion, manifestSha256: plan.manifestSha256, artifacts: plan.artifacts.map(({ path: p, sha256, size }) => ({ path: p, sha256, size })), target: plan.targetRelative }); return `INSTALL AST PACK ${plan.packId}@${plan.packVersion} ${bound}`; }
const removeToken = (e) => `ASTPACK-REMOVE:${recordSha256({ id: e.id, packVersion: e.packVersion, manifestSha256: e.manifestSha256, manifestPath: e.manifestPath })}`;
export async function planAstPackInstall(sourceManifest, manifest, env = process.env) {
  const registry = await readAstPackRegistry(env), sourceRoot = path.dirname(path.resolve(sourceManifest));
  const files = [...new Set((manifest.implementation.files?.length ? manifest.implementation.files.map((f) => f.path) : manifest.argv.filter(path.isAbsolute)).map((f) => path.isAbsolute(f) ? path.resolve(f) : path.resolve(sourceRoot, f)))].sort();
  if (!files.length) error('AST pack has no local artifacts.', 'AST_PACK_ARTIFACTS_MISSING'); const artifacts = [];
  for (const file of files) { const info = await lstat(file).catch(() => null); if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !inside(sourceRoot, file)) error('AST pack source is unsafe.', 'AST_PACK_SOURCE_UNSAFE'); const relative = path.relative(sourceRoot, file).split(path.sep).join('/'); artifacts.push({ path: relative, source: file, sha256: await hashFile(file), size: info.size }); }
  const targetRelative = path.posix.join('installed', `${manifest.id}-${manifest.packVersion}-${manifest.implementation.manifestSha256.slice(0, 12)}`);
  const plan = {
    planVersion: 1,
    schemaVersion: 1, // schema-transient: confirmation preview passed in memory, never persisted
    action: 'install', pack: manifest.id, packId: manifest.id, packVersion: manifest.packVersion,
    packSchemaVersion: manifest.protocolVersion, manifestSha256: sha(await readFile(sourceManifest)),
    artifacts, files, source: path.resolve(sourceManifest), sourceRoot, targetRelative,
    target: path.join(registry.root, targetRelative), createdAt: new Date().toISOString(),
    manifest: structuredClone(manifest),
    supportedPlatforms: [...new Set(Object.values(manifest.languageDefinitions).flatMap((e) => e.platforms ?? []))].sort(),
    requiredProjectKinds: [...new Set(Object.values(manifest.languageDefinitions).flatMap((e) => e.projectKinds ?? []))].sort(),
    licenses: structuredClone(manifest.licenses), restartRequired: false
  };
  plan.confirmationToken = token(plan); plan.confirmation = plan.confirmationToken; return plan;
}
async function verifySources(plan) { if (await hashFile(plan.source) !== plan.manifestSha256) error('Manifest changed after preview.', 'AST_PACK_SOURCE_CHANGED_AFTER_PREVIEW'); for (const a of plan.artifacts) { const s = await lstat(a.source).catch(() => null); if (!s?.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size !== a.size || await hashFile(a.source) !== a.sha256) error(`Artifact '${a.path}' changed after preview.`, 'AST_PACK_SOURCE_CHANGED_AFTER_PREVIEW'); } }
function installedManifest(plan, finalTarget) { const source = plan.manifest; const m = source.protocolVersion === 1 ? { protocolVersion: 1, id: source.id, languages: structuredClone(source.languages), assurance: source.legacyClaimedAssurance ?? 'syntax', argv: structuredClone(source.argv), extractorVersion: source.extractorVersion, capabilities: structuredClone(source.capabilities), implementation: structuredClone(source.implementation) } : { protocolVersion: source.protocolVersion, id: source.id, packVersion: source.packVersion, extractorVersion: source.extractorVersion, stage: source.stage, argv: structuredClone(source.argv), capabilities: structuredClone(source.capabilities), languages: structuredClone(source.languageDefinitions), assurance: source.assurance, licenses: structuredClone(source.licenses), conformance: structuredClone(source.conformance), implementation: structuredClone(source.implementation) }; const mapping = new Map(plan.artifacts.map((a) => [path.resolve(a.source), path.join(finalTarget, a.path)])); m.argv = m.argv.map((v) => mapping.get(path.isAbsolute(v) ? path.resolve(v) : path.resolve(plan.sourceRoot, v)) ?? v); m.implementation.files = m.implementation.files.map((f) => ({ ...f, path: mapping.get(path.isAbsolute(f.path) ? path.resolve(f.path) : path.resolve(plan.sourceRoot, f.path)) ?? f.path })); m.implementation.manifestSha256 = ''; return m; }
export async function applyAstPackInstall(plan, { confirm, environment: env = process.env } = {}) {
  if (confirm !== plan.confirmationToken || token(plan) !== plan.confirmationToken) error(`AST pack installation requires --confirm '${plan.confirmationToken}'.`, 'AST_PACK_CONFIRMATION_INVALID'); const tx = `tx-${randomUUID()}`, release = await lock(env, tx); let staging, finalTarget, published = false;
  try {
    const registry = await readAstPackRegistry(env), existing = registry.entries.find((e) => e.id === plan.packId);
    if (existing) { if (existing.packVersion === plan.packVersion && existing.sourceManifestSha256 === plan.manifestSha256) return { schemaVersion: 1, action: 'install', status: 'already-installed', installed: false, pack: existing, root: registry.root }; error('AST pack version conflicts with installed bytes.', 'AST_PACK_VERSION_CONFLICT'); }
    await verifySources(plan); staging = path.join(registry.root, '.staging', tx); finalTarget = path.join(registry.root, plan.targetRelative); await mkdir(path.dirname(staging), { recursive: true }); await mkdir(staging, { recursive: false });
    await atomicJson(path.join(staging, 'transaction.json'), { transactionId: tx, operation: 'install', packId: plan.packId, state: 'PLANNED', manifestSha256: plan.manifestSha256, targetRelative: plan.targetRelative, createdAt: new Date().toISOString() });
    for (const a of plan.artifacts) { const target = path.join(staging, a.path); if (!inside(staging, target)) error('Artifact escaped staging.', 'AST_PACK_SOURCE_UNSAFE'); await mkdir(path.dirname(target), { recursive: true }); await copyFile(a.source, target, 1); if (await hashFile(target) !== a.sha256 || (await stat(target)).size !== a.size) error('Staged hash mismatch.', 'AST_PACK_STAGED_HASH_MISMATCH'); }
    const stored = installedManifest(plan, finalTarget), { astAdapterManifestSha256 } = await import('./ast-adapter-contract.mjs'); stored.implementation.manifestSha256 = astAdapterManifestSha256(stored); await atomicJson(path.join(staging, 'manifest.json'), stored);
    await atomicJson(path.join(staging, 'transaction.json'), { transactionId: tx, operation: 'install', packId: plan.packId, state: 'VERIFIED', manifestSha256: plan.manifestSha256, targetRelative: plan.targetRelative, createdAt: new Date().toISOString() });
    await mkdir(path.dirname(finalTarget), { recursive: true }); await rename(staging, finalTarget); staging = null; published = true; syncDir(path.dirname(finalTarget)); for (const a of plan.artifacts) if (await hashFile(path.join(finalTarget, a.path)) !== a.sha256) error('Destination hash mismatch.', 'AST_PACK_DESTINATION_HASH_MISMATCH');
    const entry = { id: stored.id, packVersion: stored.packVersion, manifestPath: path.posix.join(plan.targetRelative, 'manifest.json'), manifestSha256: stored.implementation.manifestSha256, sourceManifestSha256: plan.manifestSha256, artifacts: plan.artifacts.map(({ path: p, sha256, size }) => ({ path: p, sha256, size })), installedAt: new Date().toISOString() };
    await atomicJson(registry.path, {
      schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION,
      entries: [...registry.entries, entry].sort((a, b) => a.id.localeCompare(b.id))
    });
    await rm(path.join(finalTarget, 'transaction.json'), { force: true });
    return { schemaVersion: 1, action: 'install', status: 'installed', installed: true, pack: entry, root: registry.root };
  } catch (e) { if (staging) await rm(staging, { recursive: true, force: true }); if (published) await rm(finalTarget, { recursive: true, force: true }); throw e; } finally { await release(); }
}
export async function planAstPackRemove(id, env = process.env) { const registry = await readAstPackRegistry(env), pack = registry.entries.find((e) => e.id === id); if (!pack) error(`AST pack '${id}' is not installed.`, 'AST_PACK_NOT_INSTALLED'); const target = path.dirname(path.join(registry.root, pack.manifestPath)), confirmationToken = removeToken(pack); return { schemaVersion: 1, action: 'remove', pack, target, confirmationToken, confirmation: confirmationToken }; }
export async function applyAstPackRemove(plan, { confirm, environment: env = process.env } = {}) {
  if (confirm !== plan.confirmationToken || removeToken(plan.pack) !== plan.confirmationToken) error('AST pack removal confirmation is invalid.', 'AST_PACK_CONFIRMATION_INVALID'); const tx = `tx-${randomUUID()}`, release = await lock(env, tx); let trash;
  try {
    const registry = await readAstPackRegistry(env), current = registry.entries.find((e) => e.id === plan.pack.id);
    if (!current) return { schemaVersion: 1, action: 'remove', status: 'already-removed', removed: false, pack: plan.pack, root: registry.root };
    if (removeToken(current) !== plan.confirmationToken) error('Registry changed after preview.', 'AST_PACK_SOURCE_CHANGED_AFTER_PREVIEW');
    trash = path.join(registry.root, '.staging', tx); await mkdir(path.dirname(trash), { recursive: true });
    await rename(plan.target, trash);
    await atomicJson(path.join(trash, 'transaction.json'), { transactionId: tx, operation: 'remove', packId: current.id, state: 'STAGED', createdAt: new Date().toISOString() });
    await atomicJson(registry.path, {
      schemaVersion: AST_PACK_REGISTRY_SCHEMA_VERSION,
      entries: registry.entries.filter((e) => e.id !== current.id)
    });
    await rm(trash, { recursive: true, force: true }); trash = null;
    return { schemaVersion: 1, action: 'remove', status: 'removed', removed: true, pack: current, root: registry.root };
  } catch (e) {
    if (trash) {
      const r = await readAstPackRegistry(env).catch(() => null);
      if (r?.entries.some((x) => x.id === plan.pack.id)) await rename(trash, plan.target).catch(() => {});
    }
    throw e;
  } finally { await release(); }
}
export async function inspectAstPackRegistry(env = process.env, { repair = false } = {}) {
  const release = repair ? await lock(env, `doctor-${randomUUID()}`) : null; try { const registry = await readAstPackRegistry(env), report = { schemaVersion: 1, action: 'doctor', installed: registry.entries.length, valid: 0, missing: 0, hashMismatch: 0, orphaned: 0, transactions: 0, registry: 'healthy', diagnostics: [] }, referenced = new Set();
    for (const entry of registry.entries) { const target = path.dirname(path.join(registry.root, entry.manifestPath)); referenced.add(path.resolve(target)); const info = await lstat(target).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) { report.missing++; report.diagnostics.push({ code: 'AST_PACK_MISSING', pack: entry.id }); continue; } let valid = true; for (const a of entry.artifacts ?? []) if (await hashFile(path.join(target, a.path)).catch(() => null) !== a.sha256) valid = false; if (valid) report.valid++; else { report.hashMismatch++; report.diagnostics.push({ code: 'AST_PACK_HASH_MISMATCH', pack: entry.id }); } }
    const installed = path.join(registry.root, 'installed'); for (const name of await readdir(installed).catch(() => [])) if (!referenced.has(path.resolve(path.join(installed, name)))) { report.orphaned++; report.diagnostics.push({ code: 'AST_PACK_ORPHANED', path: path.join(installed, name) }); }
    const staging = path.join(registry.root, '.staging'); for (const name of await readdir(staging).catch(() => [])) { report.transactions++; const target = path.join(staging, name); let journal; try { journal = JSON.parse(await readFile(path.join(target, 'transaction.json'), 'utf8')); } catch {} if (repair && journal && !['PUBLISHED', 'REGISTERED'].includes(journal.state)) { await rm(target, { recursive: true, force: true }); report.transactions--; } else report.diagnostics.push({ code: journal ? 'AST_PACK_STALE_TRANSACTION' : 'AST_PACK_RECOVERY_REQUIRED', transaction: name }); }
    if (report.missing || report.hashMismatch || report.orphaned || report.transactions) report.registry = 'inconsistent'; return report; } finally { await release?.(); }
}
export function astPackPlanDigest(plan) { return recordSha256(JSON.parse(canonicalJson({ ...plan, manifest: undefined }))); }
