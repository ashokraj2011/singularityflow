/**
 * A repository's APM project, read the way the APM CLI leaves it [APM A1, 2026-10-29].
 *
 * APM (Microsoft's Agent Package Manager) owns packages: `apm.yml` declares them, `apm install`
 * resolves each to one commit, writes its agents, skills, instructions and prompts into the targets
 * (`.github/` for Copilot) and records every file it wrote, with its SHA-256, in `apm.lock.yaml`.
 * The repository commits all three, so every clone and every Story uses the same agents.
 *
 * SFlow never resolves or fetches here. It reads the two files and checks the deployed files against
 * the lock: missing, changed, not committed. Nothing runs and nothing is written; the only process
 * is an optional `apm --version`, which says which APM CLI this machine has.
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APM_LOCKFILE, APM_MANIFEST, FILE_MAX_BYTES, apmLockedAgent, deployedPath, expectedHash, finding, inspectDeployedPath, list, packageLabel,
  normalizeApmConfiguration, primitiveOf, readApmDocument
} from './apm-lock.mjs';
import { parseAgentDependencies } from './agent-document-parser.mjs';
import { trackedPaths } from './git.mjs';
import { parseYamlText } from './yaml-parse-cache.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';

export { APM_LOCKFILE, APM_MANIFEST, bytesMatch, deployedPath, primitiveOf } from './apm-lock.mjs';
export const APM_STATUS_RESULT = 'sflow-apm-status';

const MAX_FILES = 5000;

function repositoryKey(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/^(?:https?|ssh):\/\//u, '').replace(/^git@([^:/]+):/u, '$1/').replace(/^[^@/]+@/u, '')
    .replace(/^github\.com\//u, '').replace(/\.git$/u, '').replace(/\/+$/u, '');
}

/**
 * One `dependencies.apm` entry as something a lock entry can be matched to. `confident` is false for
 * forms whose lock identity this reader cannot predict (other hosts, Azure DevOps); those are never
 * reported as missing from the lock.
 */
export function declaredDependency(entry) {
  if (typeof entry === 'string') {
    const value = entry.trim();
    if (/^(?:\.{1,2}\/|\/|~\/)/u.test(value)) return { kind: 'local', label: value, path: value, confident: true };
    const market = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)(?:#.*)?$/u.exec(value);
    if (market) return { kind: 'marketplace', label: value, name: market[1], marketplace: market[2], confident: true };
    if (/^(?:[a-z+]+:\/\/|git@)/iu.test(value)) return { kind: 'git', label: value, repository: repositoryKey(value.split('#')[0]), virtualPath: '', confident: false };
    const [spec, ref = null] = value.split('#');
    const segments = spec.split('/').filter(Boolean);
    if (segments.length < 2 || segments[0].includes('.') || segments[0].includes(':')) {
      return { kind: 'git', label: value, repository: repositoryKey(spec), virtualPath: '', ref, confident: false };
    }
    return { kind: 'github', label: value, repository: repositoryKey(segments.slice(0, 2).join('/')), virtualPath: segments.slice(2).join('/'), ref, confident: true };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'unknown', label: String(entry), confident: false };
  if (entry.marketplace) {
    return { kind: 'marketplace', label: `${entry.name}@${entry.marketplace}`, name: String(entry.name ?? ''), marketplace: String(entry.marketplace), confident: Boolean(entry.name) };
  }
  if (entry.id) return { kind: 'registry', label: String(entry.id), repository: repositoryKey(entry.id), virtualPath: String(entry.path ?? ''), confident: true };
  if (entry.git) {
    const repository = repositoryKey(entry.git);
    const github = /^[^./:]+\/[^/]+$/u.test(repository);
    return { kind: github ? 'github' : 'git', label: String(entry.git), repository, virtualPath: String(entry.path ?? '').replace(/^\/+|\/+$/gu, ''), ref: entry.ref ?? null, confident: github };
  }
  if (entry.path) return { kind: 'local', label: String(entry.path), path: String(entry.path), confident: true };
  return { kind: 'unknown', label: JSON.stringify(entry), confident: false };
}

function locks(entry, lock) {
  const same = (left, right) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
  if (entry.kind === 'marketplace') return same(lock.marketplace_plugin_name, entry.name) && same(lock.discovered_via, entry.marketplace);
  if (entry.kind === 'local') return lock.source === 'local' && path.posix.normalize(String(lock.local_path ?? '')) === path.posix.normalize(entry.path);
  if (entry.kind === 'unknown') return false;
  return repositoryKey(lock.repo_url) === entry.repository && String(lock.virtual_path ?? '').replace(/^\/+|\/+$/gu, '') === (entry.virtualPath ?? '');
}

function manifestSummary(manifest) {
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  const development = manifest.devDependencies && typeof manifest.devDependencies === 'object' ? manifest.devDependencies : {};
  const targets = manifest.targets ?? manifest.target ?? null;
  const marketplace = manifest.marketplace && typeof manifest.marketplace === 'object' ? manifest.marketplace : null;
  return {
    name: manifest.name == null ? null : String(manifest.name),
    version: manifest.version == null ? null : String(manifest.version),
    description: manifest.description == null ? null : String(manifest.description),
    targets: targets == null ? [] : (Array.isArray(targets) ? targets : [targets]).map(String),
    apm: [...list(dependencies.apm), ...list(development.apm)].map(declaredDependency),
    mcp: list(dependencies.mcp).length + list(development.mcp).length,
    marketplace: marketplace ? { owner: marketplace.owner == null ? null : String(marketplace.owner?.name ?? marketplace.owner), packages: list(marketplace.packages).length } : null,
    extensions: Object.keys(manifest).filter((key) => /^x-[a-z][a-z0-9-]*$/u.test(key))
  };
}

const FILE_WORDS = Object.freeze({
  missing: 'is missing',
  modified: 'changed since apm install wrote it',
  'not-regular': 'is not a regular file (APM writes regular files)',
  'too-large': `is larger than ${FILE_MAX_BYTES} bytes and was not checked`
});

async function inspectDeployment(root, owner, files, hashes, budget, findings) {
  const result = { total: 0, ok: 0, unhashed: 0, missing: 0, modified: 0, notRegular: 0, tooLarge: 0, primitives: [], present: [], named: [] };
  const hashMap = hashes && typeof hashes === 'object' && !Array.isArray(hashes) ? hashes : {};
  for (const value of list(files)) {
    const entry = deployedPath(value);
    if (!entry) {
      findings.push(finding('lock-path-refused', `${APM_LOCKFILE} names a deployed path SFlow will not read: ${JSON.stringify(value).slice(0, 200)}.`, { owner }));
      continue;
    }
    if (budget.files >= MAX_FILES) { budget.skipped += 1; continue; }
    budget.files += 1;
    result.total += 1;
    result.named.push(value);
    const { state } = await inspectDeployedPath(root, entry, expectedHash(hashMap[value]));
    // A file that is there, intact or not, is one Git should track; Git tracks no directories.
    if (['ok', 'unhashed', 'modified', 'too-large'].includes(state)) result.present.push(value);
    if (state === 'ok' || state === 'unhashed' || state === 'directory') result[state === 'directory' ? 'ok' : state] += 1;
    else {
      result[state === 'not-regular' ? 'notRegular' : state === 'too-large' ? 'tooLarge' : state] += 1;
      findings.push(finding(`deployed-${state}`, `${value} ${FILE_WORDS[state]}.`, { path: value, owner }));
    }
    const primitive = entry.directory || state === 'directory' ? null : primitiveOf(value);
    if (primitive) result.primitives.push({ ...primitive, path: value });
  }
  return result;
}

/** The APM CLI on this machine, by `apm --version` from the home directory; null when there is none. */
export function apmCliVersion({ run = spawnSync, environment = process.env } = {}) {
  try {
    const launch = resolvePlatformProcess('apm', ['--version'], { environment, cwd: os.homedir() });
    const result = run(launch.executable, launch.arguments, { cwd: os.homedir(), env: environment, encoding: 'utf8', timeout: 10_000, ...launch.spawnOptions });
    if (result.error || result.status !== 0) return null;
    return /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/u.exec(`${result.stdout ?? ''}`)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The steps workflow.yml `apm.agents` gives each APM agent, and every agent APM deployed that SFlow
 * cannot read as an agent (it is left out of SFlow's agents, never a reason configuration fails).
 */
async function agentUse(root, packages) {
  let bindings = {};
  const workflowText = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8').catch(() => '');
  try { bindings = normalizeApmConfiguration(parseYamlText(workflowText)?.apm).agents; } catch { bindings = {}; }
  const unusable = [];
  for (const entry of packages.flatMap((item) => item.files.primitives.filter((primitive) => primitive.kind === 'agent' && primitive.target === '.github')
    .map((primitive) => ({ ...primitive, package: item.label })))) {
    const text = await readFile(path.join(root, entry.path), 'utf8').catch(() => null);
    if (text == null) continue;
    try { parseAgentDependencies(text, { source: entry.path }); }
    catch (error) { unusable.push({ name: entry.name, path: entry.path, package: entry.package, reason: error.message }); }
  }
  // A binding applies only while its agent is installed exactly as APM wrote it; until then it waits
  // and the step keeps its workflow's own agent (agents.mjs).
  const states = {};
  for (const [id, binding] of Object.entries(bindings)) {
    const locked = await apmLockedAgent(root, id);
    const unreadable = unusable.find((entry) => entry.path === locked.path);
    const waiting = locked.state === 'no-lock' ? (locked.problem ? `${APM_LOCKFILE} cannot be read` : `there is no ${APM_LOCKFILE}`)
      : locked.state === 'not-locked' ? `APM did not deploy .github/agents/${id}.agent.md`
        : unreadable ? `SFlow cannot read ${locked.path}: ${unreadable.reason}`
          : locked.state !== 'intact' ? `${locked.path} ${FILE_WORDS[locked.state] ?? `has no hash in ${APM_LOCKFILE}`}`
            : null;
    states[id] = { ...binding, active: !waiting, ...(waiting ? { waiting } : {}) };
  }
  return { bindings: states, unusable };
}

async function unmanagedAgents(root, owned) {
  const directory = path.join(root, '.github', 'agents');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `.github/agents/${entry.name}`).filter((relative) => !owned.has(relative)).sort();
}

/**
 * The repository's APM project: what `apm.yml` declares, what `apm.lock.yaml` locked, and whether
 * every deployed file is still the one APM wrote and is committed. `cliVersion` is injected by tests;
 * pass false to skip the `apm --version` probe.
 */
export async function apmProjectStatus(root, { cliVersion = undefined } = {}) {
  const findings = [];
  const [manifestRead, lockRead] = await Promise.all([readApmDocument(root, APM_MANIFEST, 'manifest'), readApmDocument(root, APM_LOCKFILE, 'lock')]);
  for (const read of [manifestRead, lockRead]) if (read.problem) findings.push(read.problem);
  const manifest = manifestRead.value ? manifestSummary(manifestRead.value) : null;
  if (manifestRead.value) {
    for (const key of ['name', 'version']) {
      if (manifestRead.value[key] == null || manifestRead.value[key] === '') findings.push(finding('manifest-incomplete', `${APM_MANIFEST} has no ${key}; APM requires name and version.`, { path: APM_MANIFEST }));
    }
  }
  const lock = lockRead.value ?? null;
  const lockEntries = lock ? list(lock.dependencies).filter((entry) => entry && typeof entry === 'object' && entry.repo_url) : [];
  const budget = { files: 0, skipped: 0 };
  const packages = [];
  for (const entry of lockEntries) {
    const files = await inspectDeployment(root, packageLabel(entry), entry.deployed_files, entry.deployed_file_hashes, budget, findings);
    packages.push({
      label: packageLabel(entry),
      name: entry.name == null ? null : String(entry.name),
      repository: String(entry.repo_url),
      virtualPath: entry.virtual_path == null ? null : String(entry.virtual_path),
      ref: entry.resolved_ref == null ? null : String(entry.resolved_ref),
      commit: entry.resolved_commit == null ? null : String(entry.resolved_commit),
      version: entry.version == null ? null : String(entry.version),
      depth: Number.isInteger(entry.depth) ? entry.depth : 1,
      development: entry.is_dev === true,
      packageType: entry.package_type ?? null,
      marketplace: entry.discovered_via ?? null,
      source: entry.source ?? 'git',
      execStatus: entry.exec_status ?? null,
      files
    });
  }
  const local = lock ? await inspectDeployment(root, 'this project', lock.local_deployed_files, lock.local_deployed_file_hashes, budget, findings) : null;
  if (budget.skipped) findings.push(finding('deployed-not-checked', `${budget.skipped} more deployed files were not checked (the first ${MAX_FILES} were).`));

  // Declared but not locked, and locked directly but no longer declared.
  const declared = manifest?.apm ?? [];
  const unlocked = lock ? declared.filter((entry) => entry.confident && !lockEntries.some((candidate) => locks(entry, candidate))).map((entry) => entry.label) : [];
  for (const label of unlocked) findings.push(finding('declared-not-locked', `${APM_MANIFEST} declares ${label} but ${APM_LOCKFILE} does not lock it.`, { dependency: label }));
  const stale = lock && declared.every((entry) => entry.confident)
    ? packages.filter((entry, index) => entry.depth === 1 && !declared.some((candidate) => locks(candidate, lockEntries[index]))).map((entry) => entry.label) : [];
  for (const label of stale) findings.push(finding('locked-not-declared', `${APM_LOCKFILE} still locks ${label}, which ${APM_MANIFEST} no longer declares.`, { dependency: label }));
  if (manifest && !lock && !lockRead.problem && declared.length) {
    findings.push(finding('lock-missing', `${APM_MANIFEST} declares ${declared.length} package${declared.length === 1 ? '' : 's'} but there is no ${APM_LOCKFILE}.`));
  }

  // Committed: the manifest, the lock and every deployed file that is there.
  const present = [...packages.flatMap((entry) => entry.files.present), ...(local?.present ?? [])];
  const candidates = [...(manifestRead.present ? [APM_MANIFEST] : []), ...(lockRead.present ? [APM_LOCKFILE] : []), ...present];
  let tracked = null;
  try { tracked = new Set(trackedPaths(root, candidates)); } catch { tracked = null; }
  const uncommitted = tracked ? candidates.filter((relative) => !tracked.has(relative)) : [];
  if (uncommitted.length) {
    findings.push(finding('not-committed', `${uncommitted.length} APM file${uncommitted.length === 1 ? ' is' : 's are'} not committed: ${uncommitted.slice(0, 5).join(', ')}${uncommitted.length > 5 ? ', …' : ''}.`, { paths: uncommitted }));
  }

  const owned = new Set([...packages.flatMap((entry) => entry.files.named), ...(local?.named ?? [])]);
  const cli = cliVersion === false ? null : cliVersion !== undefined ? cliVersion : apmCliVersion();
  const codes = new Set(findings.map((entry) => entry.code));
  const state = !manifestRead.present && !lockRead.present ? 'absent'
    : [...codes].some((code) => code.endsWith('-unreadable')) ? 'unreadable'
      : [...codes].some((code) => /^deployed-(?:missing|modified|not-regular)$/u.test(code)) ? 'drifted'
        : codes.has('lock-missing') || codes.has('declared-not-locked') ? 'unlocked'
          : codes.has('not-committed') ? 'uncommitted' : 'intact';
  return {
    schemaVersion: 1,
    resultType: APM_STATUS_RESULT,
    state,
    manifest: manifestRead.present ? { path: APM_MANIFEST, ...(manifest ?? {}), apm: (manifest?.apm ?? []).map(({ kind, label }) => ({ kind, label })) } : null,
    lock: lockRead.present ? {
      path: APM_LOCKFILE,
      lockfileVersion: lock?.lockfile_version == null ? null : String(lock.lockfile_version),
      apmVersion: lock?.apm_version == null ? null : String(lock.apm_version),
      packages: packages.length,
      mcpServers: list(lock?.mcp_servers).length
    } : null,
    packages: packages.map(({ files, ...entry }) => ({ ...entry, files: fileCounts(files), primitives: files.primitives })),
    local: local ? { files: fileCounts(local), primitives: local.primitives } : null,
    unmanagedAgents: await unmanagedAgents(root, owned),
    agents: await agentUse(root, packages),
    cli: { found: cli, lockWrittenBy: lock?.apm_version == null ? null : String(lock.apm_version) },
    findings,
    nextActions: nextActions(state, codes, uncommitted)
  };
}

function fileCounts(files) {
  const { primitives: _primitives, present: _present, named: _named, ...counts } = files;
  return counts;
}

function nextActions(state, codes, uncommitted) {
  const actions = [];
  if (state === 'absent') actions.push({ command: 'apm init', why: 'Start an APM project in this repository; SFlow reads what APM writes.' });
  if (codes.has('lock-missing') || codes.has('declared-not-locked')) actions.push({ command: 'apm install', why: `Resolve every declared package to one commit and write ${APM_LOCKFILE}.` });
  if (codes.has('deployed-missing') || codes.has('deployed-modified') || codes.has('deployed-not-regular')) {
    actions.push({ command: 'apm install', why: 'Write the locked files again. A change worth keeping belongs in the package, not in its deployed copy.' });
  }
  if (codes.has('locked-not-declared')) actions.push({ command: 'apm prune', why: `Remove what ${APM_MANIFEST} no longer declares.` });
  if (uncommitted.length) {
    const roots = [...new Set(uncommitted.map((relative) => (relative.includes('/') ? `${relative.split('/')[0]}/` : relative)))].sort();
    actions.push({ command: `git add ${roots.join(' ')}`, why: `Commit ${APM_MANIFEST}, ${APM_LOCKFILE} and the deployed files together, so every clone and every Story uses the same agents.` });
  }
  return [...new Map(actions.map((action) => [action.command, action])).values()];
}
