/**
 * Copilot never reads or edits an environment file (docs/SPEC-ENVIRONMENT-FILES-v1.md, "Protection").
 *
 * An environment file holds secrets: a declared `localFiles` path or glob, a `neverCommit` pattern, a
 * path in this machine's environment-file registry, the private store, a linked real file, or a
 * workspace folder for an environment. In an explicit SFlow turn, a file tool, a search tool or a shell
 * command that names one is refused, whatever the turn mode. The `env files` reads and
 * `env files create --from-template` / `place` stay allowed: they print locations, never contents.
 *
 * Cheap on purpose: the guard runs before every tool call of an explicit turn. A repository with no
 * `singularity/environments.yml`, no registry and no workspace-level state costs a few `lstat` calls
 * and loads nothing else (its one local import, copilot-mode.mjs, every hook has loaded already).
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asSflowCommand } from './copilot-mode.mjs';

const DECLARATION = path.join('singularity', 'environments.yml');
const TERMINALS = new Set(['bash', 'powershell', 'run_in_terminal', 'execute', 'exec_command', 'write_stdin']);
const SEARCH_TOOLS = new Set(['grep', 'rg', 'glob', 'search_code_subagent']);
const MAXIMUM_RECORD_BYTES = 262_144;
// `env files` subcommands Copilot may run: they print paths and statuses, or create from a template.
const ALLOWED_ENV_FILES = new Set(['', 'list', 'path', 'suggest', 'create', 'place']);
const KNOWN_ENV_FILES = Object.freeze(['list', 'path', 'suggest', 'create', 'place', 'link', 'unlink', 'adopt', 'add', 'remove', 'root']);

function exists(file) { try { return lstatSync(file); } catch { return null; } }
function canonical(file) { try { return realpathSync(file); } catch { return path.resolve(file); } }
function within(directory, target) {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** The repository containing `cwd` and its Git common directory, or null. */
function repositoryOf(cwd) {
  let directory = path.resolve(cwd || process.cwd());
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(directory, '.git');
    const info = exists(dotGit);
    if (info?.isDirectory()) return { root: directory, common: dotGit };
    if (info?.isFile()) {
      try {
        const gitdir = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/mu)?.[1]?.trim();
        if (!gitdir) return null;
        const worktreeGit = path.resolve(directory, gitdir);
        const common = exists(path.join(worktreeGit, 'commondir'))
          ? path.resolve(worktreeGit, readFileSync(path.join(worktreeGit, 'commondir'), 'utf8').trim()) : worktreeGit;
        return { root: directory, common };
      } catch { return null; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

/** Machine-local workspace-level state, as environment-files.mjs workspaceFilesBase() places it. */
export function workspaceEnvironmentFilesBase(env = process.env) {
  const registry = env.SINGULARITY_FLOW_WORKSPACE_REGISTRY || path.join(os.homedir(), '.singularity-flow', 'workspaces.json');
  return path.join(path.dirname(path.resolve(registry)), 'environment-files', 'v1');
}

function readJson(file) {
  const info = exists(file);
  if (!info?.isFile() || info.size > MAXIMUM_RECORD_BYTES) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * What is protected for the repository at `cwd`, or null when nothing is: relative path matching
 * (declaration plus registry) and absolute locations (store, linked files, workspace folders).
 * A registry or declaration that cannot be read fails closed: every path under the store counts.
 */
export async function environmentFileProtection(cwd, { env = process.env } = {}) {
  const repository = repositoryOf(cwd);
  const store = repository ? path.join(repository.common, 'singularity-flow', 'environment-files') : null;
  const registryFile = store ? path.join(store, 'v1', 'registry.json') : null;
  const declarationFile = repository ? path.join(repository.root, DECLARATION) : null;
  const workspaceBase = workspaceEnvironmentFilesBase(env);
  const hasDeclaration = Boolean(declarationFile && exists(declarationFile));
  const hasRegistry = Boolean(registryFile && exists(registryFile));
  const hasWorkspace = Boolean(exists(workspaceBase));
  if (!hasDeclaration && !hasRegistry && !hasWorkspace) return null;

  const locations = [];
  if (store) locations.push(canonical(store));
  if (hasWorkspace) locations.push(canonical(workspaceBase));
  const environmentFiles = {};
  if (hasRegistry) {
    const record = readJson(registryFile);
    for (const entry of Array.isArray(record?.entries) ? record.entries : []) {
      if (typeof entry?.environment === 'string' && typeof entry?.path === 'string') {
        (environmentFiles[entry.environment] ??= []).push(entry.path);
      }
      if (typeof entry?.linkedPath === 'string') locations.push(canonical(entry.linkedPath));
    }
  }
  if (hasWorkspace) {
    const roots = readJson(path.join(workspaceBase, 'roots.json'));
    const visit = (value) => {
      if (typeof value === 'string' && path.isAbsolute(value)) locations.push(canonical(value));
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(roots?.workspaces ?? roots?.roots ?? roots);
  }
  let declaration = null;
  let match = null;
  if (repository && (hasDeclaration || Object.keys(environmentFiles).length)) {
    const environment = await import('./environment-declaration.mjs');
    match = environment.matchEnvironmentLocalPath;
    try { declaration = hasDeclaration ? environment.loadEnvironmentDeclarationSync(repository.root) : null; }
    catch { declaration = null; }
  }
  const policies = [declaration, Object.keys(environmentFiles).length
    ? { neverCommit: [], environments: {}, environmentFiles } : null].filter(Boolean);
  return { root: repository?.root ?? null, locations: [...new Set(locations)], policies, match, environmentFiles };
}

/** Whether an absolute or cwd-relative target is an environment file or inside a protected location. */
export function protectedTarget(protection, target, cwd) {
  if (!protection || typeof target !== 'string' || !target) return null;
  let absolute;
  try { absolute = path.resolve(cwd || protection.root || process.cwd(), target.startsWith('file:') ? fileURLToPath(target) : target); }
  catch { return null; }
  const resolved = canonical(absolute);
  for (const location of protection.locations) {
    if (within(location, absolute) || within(location, resolved)) return target;
  }
  if (protection.root && protection.match && within(protection.root, absolute)) {
    const relative = path.relative(protection.root, absolute).split(path.sep).join('/');
    if (relative && protection.policies.some((policy) => protection.match(policy, relative))) return relative;
  }
  return null;
}

function callsOf(payload) {
  return (payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name, args: payload.toolArgs ?? payload.tool_input }])
    .map((call) => {
      let args = call.args ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { patch: args }; } }
      let name = String(call.name ?? '').toLowerCase().split(/[.:]/u).at(-1);
      if (name === 'str_replace_editor') name = 'edit';
      return { name, args };
    });
}

function pathArguments(args) {
  const found = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [field, child] of Object.entries(value)) {
      if (/^(?:path|paths|file_path|filePath|filepath|file|files|source|destination|old_path|new_path|oldPath|newPath|from|to|uri|fileName|filename|cwd|directory|dir|include)$/u.test(field)) {
        if (typeof child === 'string') found.push(child);
        else if (Array.isArray(child)) found.push(...child.filter((item) => typeof item === 'string'));
      } else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(args);
  // A patch names its files in its headers: `*** Update File: x`, `+++ b/x`, `--- a/x`.
  for (const text of [args.patch, args.input].filter((value) => typeof value === 'string')) {
    for (const match of text.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File: |\+\+\+ b\/|--- a\/)(.+)$/gmu)) found.push(match[1].trim());
  }
  return found;
}

/**
 * An `env files` command: true when Copilot may run it (a list, `path`, `suggest`, `place`, or
 * `create --from-template`), false when it is the person's own (`link`, `unlink`, `adopt`, `add`,
 * `remove`, `root`, or anything chained), null when it is not an `env files` command at all.
 */
function environmentFilesCommandVerdict(command) {
  const words = command.trim().replace(/^(['"])(singularity-flow|sflow)\1/u, '$2').split(/\s+/u);
  if (!['singularity-flow', 'sflow'].includes(words[0]) || words[1] !== 'env' || words[2] !== 'files') return null;
  if (/[;&|`$<>\n]/u.test(command)) return false;
  const first = words[3] && !words[3].startsWith('-') ? words[3] : '';
  // `env files dev` names an environment: a list.
  const subcommand = KNOWN_ENV_FILES.includes(first) ? first : '';
  if (!ALLOWED_ENV_FILES.has(subcommand)) return false;
  return subcommand !== 'create' || words.includes('--from-template');
}

function denial(target) {
  return {
    permissionDecision: 'deny', next: [],
    permissionDecisionReason: `ENVIRONMENT_FILE_PRIVATE: ${target} is an environment file or holds one, and it can contain secrets. `
      + 'Copilot never reads, searches or edits it. To create one from its template run singularity-flow env files create <ENV> <PATH> '
      + '--from-template; the person edits it (VS Code: Singularity Flow: Environment Files) and links their own file with '
      + 'singularity-flow env files link in their own terminal. Keep working without its contents.'
  };
}

/** The refusal for the first tool call that touches an environment file, or null. */
export async function environmentFilesToolGuard(payload = {}, { env = process.env } = {}) {
  const protection = await environmentFileProtection(payload.cwd, { env });
  if (!protection) return null;
  for (const call of callsOf(payload)) {
    const cwd = call.args?.cwd ?? payload.cwd;
    if (TERMINALS.has(call.name)) {
      // The launcher's verified Node + CLI entry reads as `singularity-flow` here too.
      const command = asSflowCommand(call.args.command ?? call.args.cmd ?? call.args.script ?? call.args.chars, call.name === 'powershell');
      if (typeof command !== 'string' || !command) continue;
      const allowed = environmentFilesCommandVerdict(command);
      if (allowed === true) continue;
      if (allowed === false) return denial('this env files command');
      const words = command.match(/"[^"]*"|'[^']*'|[^\s;&|<>()`]+/gu) ?? [];
      for (const word of words) {
        const hit = protectedTarget(protection, word.replace(/^['"]|['"]$/gu, ''), cwd);
        if (hit) return denial(hit);
      }
      continue;
    }
    const targets = SEARCH_TOOLS.has(call.name)
      ? [call.args.path, call.args.paths, call.args.cwd, call.args.include].flat().filter((value) => typeof value === 'string')
      : pathArguments(call.args);
    for (const target of targets) {
      const hit = protectedTarget(protection, target, cwd);
      if (hit) return denial(hit);
    }
  }
  return null;
}
