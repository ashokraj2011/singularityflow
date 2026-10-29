/**
 * Reading what `apm install` recorded in `apm.lock.yaml`, and checking a deployed file against it
 * [APM A1/A3, 2026-10-29]. Offline and light: no Git, no process, no network, so a step can check
 * its APM agent at entry. apm-project.mjs builds `apm status` on these.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { SingularityFlowError } from './util.mjs';

export const APM_MANIFEST = 'apm.yml';
export const APM_LOCKFILE = 'apm.lock.yaml';
export const FILE_MAX_BYTES = 16 * 1024 * 1024;
export { normalizeApmConfiguration } from './apm-configuration.mjs';

const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function finding(code, message, extra = {}) {
  return { code, message, ...extra };
}

export function list(value) {
  return Array.isArray(value) ? value : [];
}

/** A lock path APM may have written: relative, portable, never leaving the repository. */
export function deployedPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0')
      || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return null;
  const directory = value.endsWith('/');
  const segments = (directory ? value.slice(0, -1) : value).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return { path: value, segments, directory };
}

export function expectedHash(value) {
  const hex = String(value ?? '').trim().toLowerCase().replace(/^sha256:/u, '');
  return SHA256.test(hex) ? hex : null;
}

/**
 * Whether `bytes` match the lock's hash. APM hashes text after CRLF becomes LF and binary files as
 * they are; both readings are tried, so a checkout with CRLF line endings is not reported changed.
 */
export function bytesMatch(bytes, expected) {
  const raw = createHash('sha256').update(bytes).digest('hex');
  if (raw === expected) return true;
  if (bytes.includes(0)) return false;
  const text = bytes.toString('latin1');
  if (!text.includes('\r\n')) return false;
  return createHash('sha256').update(Buffer.from(text.replaceAll('\r\n', '\n'), 'latin1')).digest('hex') === expected;
}

/** apm.yml or apm.lock.yaml as a mapping, or why it cannot be read; `{ present: false }` when absent. */
export async function readApmDocument(root, relative, label) {
  const file = path.join(root, relative);
  const info = await lstat(file).catch(() => null);
  if (!info) return { present: false };
  if (!info.isFile()) return { present: true, problem: finding(`${label}-unreadable`, `${relative} is not a regular file.`, { path: relative }) };
  if (info.size > DOCUMENT_MAX_BYTES) {
    return { present: true, problem: finding(`${label}-unreadable`, `${relative} is larger than ${DOCUMENT_MAX_BYTES} bytes.`, { path: relative }) };
  }
  try {
    const value = YAML.parse(await readFile(file, 'utf8'), { maxAliasCount: 100, uniqueKeys: true });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { present: true, problem: finding(`${label}-unreadable`, `${relative} is not a YAML mapping.`, { path: relative }) };
    }
    return { present: true, value };
  } catch (error) {
    const line = error?.linePos?.[0]?.line;
    return { present: true, problem: finding(`${label}-unreadable`, `${relative} is not valid YAML${line ? ` (line ${line})` : ''}: ${String(error?.message ?? error).split('\n')[0]}`, { path: relative }) };
  }
}

/** What a deployed path is: an agent, skill, instruction or prompt, and for which target directory. */
export function primitiveOf(relative) {
  const parts = relative.split('/');
  const target = parts[0];
  const kind = parts[1];
  const name = (suffix) => (parts.length === 3 && parts[2].endsWith(suffix) ? parts[2].slice(0, -suffix.length) : null);
  if (kind === 'agents') { const agent = name('.agent.md') ?? name('.md'); if (agent) return { kind: 'agent', name: agent, target }; }
  if (kind === 'skills' && parts.length === 4 && parts[3] === 'SKILL.md') return { kind: 'skill', name: parts[2], target };
  if (kind === 'instructions') { const instruction = name('.instructions.md'); if (instruction) return { kind: 'instruction', name: instruction, target }; }
  if (kind === 'prompts') { const prompt = name('.prompt.md'); if (prompt) return { kind: 'prompt', name: prompt, target }; }
  return null;
}

/**
 * One deployed path's state against its expected hash: ok, unhashed, directory, missing, modified,
 * not-regular (a symbolic link is never followed) or too-large. Returns the bytes it read when asked.
 */
export async function inspectDeployedPath(root, entry, expected, { keepBytes = false } = {}) {
  let cursor = root;
  for (const [index, segment] of entry.segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch(() => null);
    if (!info) return { state: 'missing' };
    if (info.isSymbolicLink()) return { state: 'not-regular' };
    if (index < entry.segments.length - 1 && !info.isDirectory()) return { state: 'missing' };
    if (index === entry.segments.length - 1) {
      // APM 0.35 lists a directory it deployed (a skill's folder) with no hash and no trailing slash.
      if (info.isDirectory() && (entry.directory || !expected)) return { state: 'directory' };
      if (entry.directory) return { state: 'missing' };
      if (!info.isFile()) return { state: 'not-regular' };
      if (!expected) return { state: 'unhashed' };
      if (info.size > FILE_MAX_BYTES) return { state: 'too-large' };
    }
  }
  const bytes = await readFile(cursor);
  return { state: bytesMatch(bytes, expected) ? 'ok' : 'modified', ...(keepBytes ? { bytes } : {}) };
}

/** How a package is named to a person: name@marketplace, `name (local)` or repository[/path]. */
export function packageLabel(lock) {
  if (lock.marketplace_plugin_name && lock.discovered_via) return `${lock.marketplace_plugin_name}@${lock.discovered_via}`;
  // A local package is locked as `_local/<folder>`; its own name reads better.
  if (lock.source === 'local') return `${lock.name ?? path.posix.basename(String(lock.local_path ?? lock.repo_url))} (local)`;
  const repository = String(lock.repo_url ?? '');
  return lock.virtual_path ? `${repository}/${String(lock.virtual_path).replace(/^\/+/u, '')}` : repository;
}

/**
 * Every path the lock says APM deployed, with the package that owns it and its expected hash: the
 * locked packages first, then this project's own. Null when there is no readable lock.
 */
export function apmDeployedIndex(lock) {
  if (!lock || typeof lock !== 'object') return null;
  const index = new Map();
  const owners = [
    ...list(lock.dependencies).filter((entry) => entry && typeof entry === 'object' && entry.repo_url)
      .map((entry) => ({ files: entry.deployed_files, hashes: entry.deployed_file_hashes, package: packageLabel(entry), commit: entry.resolved_commit ?? null, version: entry.version ?? null })),
    { files: lock.local_deployed_files, hashes: lock.local_deployed_file_hashes, package: 'this project', commit: null, version: null }
  ];
  for (const owner of owners) {
    const hashes = owner.hashes && typeof owner.hashes === 'object' && !Array.isArray(owner.hashes) ? owner.hashes : {};
    for (const relative of list(owner.files)) {
      if (typeof relative !== 'string' || index.has(relative) || !deployedPath(relative)) continue;
      index.set(relative, Object.freeze({ package: owner.package, commit: owner.commit, version: owner.version, sha256: expectedHash(hashes[relative]) }));
    }
  }
  return index;
}

/** An agent's text against the hash APM recorded for it: intact, modified, or unhashed. */
export function agentTextState(text, sha256) {
  if (!sha256) return 'unhashed';
  return bytesMatch(Buffer.from(String(text ?? ''), 'utf8'), sha256) ? 'intact' : 'modified';
}

/** The refusal for an agent APM deployed whose file is not the one apm install wrote [APM A3]. */
export function apmAgentNotIntact(agent, where) {
  const { path: file, package: owner, state } = agent.apm;
  const why = state === 'unhashed' ? `${APM_LOCKFILE} records no hash for ${file}, so it cannot be checked; install it again with a current APM CLI`
    : `${file} no longer matches ${APM_LOCKFILE}; run apm install to restore it, or make the change in the package and install it again`;
  return new SingularityFlowError(`Agent '${agent.id}' was installed by APM (${owner}) and ${where} uses it only as APM wrote it: ${why}.`,
    { code: 'APM_AGENT_NOT_INTACT', details: { agentId: agent.id, path: file, package: owner, state, nextAction: 'apm install' } });
}

/**
 * The Copilot agent `name` that APM deployed (`.github/agents/<name>.agent.md`), checked against the
 * lock, offline. `state` is intact, modified, missing, not-regular, too-large, unhashed, not-locked
 * (no locked package or this project deployed it) or no-lock; `text` is the agent file when intact.
 */
export async function apmLockedAgent(root, name) {
  if (!AGENT_NAME.test(String(name ?? ''))) return { name, state: 'not-locked', path: null, package: null };
  const lockRead = await readApmDocument(root, APM_LOCKFILE, 'lock');
  if (!lockRead.present || lockRead.problem) return { name, state: 'no-lock', path: null, package: null, problem: lockRead.problem?.message ?? null };
  const index = apmDeployedIndex(lockRead.value);
  const relative = [`.github/agents/${name}.agent.md`, `.github/agents/${name}.md`].find((candidate) => index.has(candidate));
  if (!relative) return { name, state: 'not-locked', path: null, package: null };
  const owner = index.get(relative);
  const inspected = await inspectDeployedPath(root, deployedPath(relative), owner.sha256, { keepBytes: true });
  const state = inspected.state === 'ok' ? 'intact' : inspected.state;
  return {
    name, state, path: relative, ...owner,
    apmVersion: lockRead.value.apm_version == null ? null : String(lockRead.value.apm_version),
    ...(state === 'intact' ? { text: inspected.bytes.toString('utf8') } : {})
  };
}
