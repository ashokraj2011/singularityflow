/**
 * Copilot never reads or edits an environment file (docs/SPEC-ENVIRONMENT-FILES-v1.md, "Protection").
 *
 * An environment file holds secrets: a declared `localFiles` path or glob, a `neverCommit` pattern, a
 * path in this machine's environment-file registry, the private store, a linked real file, or a
 * workspace folder for an environment. A file tool, a search tool or a shell command that names one is
 * refused, in any turn mode and in a plain chat unless its capability allows it. The `env files` reads and
 * `env files create --from-template` / `place` stay allowed: they print locations, never contents.
 *
 * Two kinds need no setup at all (docs/SPEC-ENVIRONMENT-FILES-v2.md): a file with an always-local name,
 * and a shared config file holding what looks like a real value, until the value is moved out.
 *
 * Cheap on purpose: the guard runs before every tool call that could name one. A repository with no
 * `singularity/environments.yml`, no registry and no workspace-level state costs a few `lstat` calls,
 * and only a call that names a config file reads that file and loads the scanner.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asSflowCommand } from './copilot-mode.mjs';
import { alwaysLocalName, classifiedShared, configShapedPath } from './local-config-policy.mjs';

const DECLARATION = path.join('singularity', 'environments.yml');
const TERMINALS = new Set(['bash', 'powershell', 'run_in_terminal', 'execute', 'exec_command', 'write_stdin', 'write_bash']);
const SEARCH_TOOLS = new Set(['grep', 'rg', 'glob', 'search_code_subagent', 'grep_search']);
// A search for one of these words may print the line that holds a credential (copilot-search-exposure.mjs). The launchers test the same words.
const CREDENTIAL_WORD = /pass|pwd|secret|credential|token|key|auth/iu;
const SHELL_SEARCH = /(?:^|[\s/;&|('"])(?:e?f?grep|rg|ag|ack)(?:[\s'"]|$)/u;
const MAXIMUM_RECORD_BYTES = 262_144;
const MAXIMUM_SCANNED_BYTES = 262_144;
// `env files` subcommands Copilot may run: they print paths and statuses, or create from a template.
const ALLOWED_ENV_FILES = new Set(['', 'list', 'path', 'suggest', 'create', 'place', 'override']);
const KNOWN_ENV_FILES = Object.freeze(['list', 'path', 'suggest', 'override', 'create', 'place', 'link', 'unlink', 'adopt', 'add', 'remove', 'root', 'classify']);

function exists(file) { try { return lstatSync(file); } catch { return null; } }
// What does not exist yet keeps its names below the nearest directory that does, spelled as the
// filesystem spells it (a Windows 8.3 short name expanded), as util.mjs canonicalPathSync.
function canonical(file) {
  const missing = [];
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { return path.join(realpathSync.native(current), ...missing.reverse()); }
    catch { if (path.dirname(current) === current) return path.resolve(file); missing.push(path.basename(current)); }
  }
}
function within(directory, target) {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** The repository containing `cwd`, its checkout's Git directory and its Git common directory, or null. */
export function repositoryOf(cwd) {
  let directory = path.resolve(cwd || process.cwd());
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(directory, '.git');
    const info = exists(dotGit);
    if (info?.isDirectory()) return { root: directory, gitDir: dotGit, common: dotGit };
    if (info?.isFile()) {
      try {
        const gitdir = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/mu)?.[1]?.trim();
        if (!gitdir) return null;
        const worktreeGit = path.resolve(directory, gitdir);
        const common = exists(path.join(worktreeGit, 'commondir'))
          ? path.resolve(worktreeGit, readFileSync(path.join(worktreeGit, 'commondir'), 'utf8').trim()) : worktreeGit;
        return { root: directory, gitDir: worktreeGit, common };
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
  // As spelled, and as the filesystem spells both: the target can name the repository by a Windows 8.3 short name.
  const spellings = protection.root && protection.match ? [[protection.root, absolute], [canonical(protection.root), resolved]] : [];
  for (const [root, candidate] of spellings) {
    if (!within(root, candidate)) continue;
    const relative = path.relative(root, candidate).split(path.sep).join('/');
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
    for (const match of text.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |\+\+\+ (?:b\/)?|--- (?:a\/)?)([^\t\n]+)/gmu)) found.push(match[1].trim());
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

function absoluteOf(target, cwd) {
  try { return path.resolve(cwd || process.cwd(), target.startsWith('file:') ? fileURLToPath(target) : target); }
  catch { return null; }
}

// A glob that would take in one of these names: `.env*`, `.env.*`.
function globTakesLocalName(target) {
  const name = String(target).replaceAll('\\', '/').split('/').at(-1);
  // Only a glob that starts with a dot takes a dotfile: `**` or `src/*` in a search does not name one.
  if (!/[*?[]/u.test(name) || !name.startsWith('.')) return false;
  try {
    const glob = new RegExp(`^${name.replace(/[.+^${}()|\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'u');
    return ['.env', '.env.local'].some((candidate) => glob.test(candidate));
  } catch { return true; }
}

async function trackedInGit(absolute) {
  const repository = repositoryOf(path.dirname(absolute));
  if (!repository) return false;
  try {
    const relative = path.relative(canonical(repository.root), canonical(absolute)).split(path.sep).join('/');
    return (await import('./git.mjs')).trackedPaths(repository.root, [relative]).length > 0;
  } catch { return false; }
}

/**
 * An always-local name, or a link to one. A file the team already tracks is in Git for anyone to read, and
 * a person may have classified one as shared, so both are judged by their values like any shared config.
 */
async function alwaysLocalTarget(target, cwd) {
  if (typeof target !== 'string' || target.startsWith('-')) return null;
  const absolute = absoluteOf(target, cwd);
  const named = alwaysLocalName(target) || globTakesLocalName(target) || (absolute && alwaysLocalName(canonical(absolute)));
  if (!named) return null;
  if (!absolute || !exists(absolute)) return target;
  if (await trackedInGit(absolute)) return null;
  try { return statSync(absolute).size <= MAXIMUM_SCANNED_BYTES && classifiedShared(readFileSync(absolute, 'utf8')) ? null : target; }
  catch { return target; }
}

// What a shell line shows of a file: nothing, for these. Their words are text or a question about the file.
const SHOWS_NOTHING = new Set(['echo', 'printf', 'ls', 'stat', 'test', '[', 'true', 'false', 'mkdir']);
const SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const SEARCH_PATH_OPTIONS = new Set(['-g', '--glob', '--iglob', '--include', '--exclude', '-f', '--file']);
const quoteless = (word) => word.replace(/^['"]|['"]$/gu, '');

// What a search leaves out it does not open: `--exclude=x`, `--exclude x`, `-g '!x'`, `':!x'`.
function excludedBySearch(words, index) {
  const word = quoteless(words[index]);
  const before = quoteless(words[index - 1] ?? '');
  return /^--exclude(?:-dir)?=/u.test(word) || /^--exclude(?:-dir)?$/u.test(word) || /^--exclude(?:-dir)?$/u.test(before)
    || /^(?:--i?glob=)?!/u.test(word) || word.startsWith(':!') || word.startsWith(':(exclude)');
}

/** The words one simple shell command could open, split so `HEAD:.env`, `if=.env` and `open('.env')` show their paths. */
function openedTokens(simple) {
  const words = simple.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  const start = words.findIndex((word) => !/^[A-Za-z_]\w*=/u.test(word));
  const verb = start >= 0 ? quoteless(words[start]).split('/').at(-1) : null;
  const redirected = [...simple.matchAll(/>>?\s*(["']?)([^\s"'&|;]+)\1/gu)].map((match) => match[2]);
  let operands = words;
  if (SHOWS_NOTHING.has(verb)) return redirected;
  if (verb === 'git' && (['status', 'check-ignore'].includes(words[start + 1]) || (words[start + 1] === 'rm' && words.includes('--cached')))) return redirected;
  const search = SEARCHES.has(verb) ? start : verb === 'git' && words[start + 1] === 'grep' ? start + 1 : -1;
  if (search >= 0) {
    // A search's first plain word is what it looks for, and the rest are where it looks.
    let pattern = -1;
    for (let index = search + 1; index < words.length; index += 1) {
      if (['-e', '--regexp'].includes(words[index])) { pattern = index + 1; break; }
      if (SEARCH_PATH_OPTIONS.has(words[index])) { index += 1; continue; }
      if (!words[index].startsWith('-')) { pattern = index; break; }
    }
    operands = words.filter((word, index) => index !== pattern && !excludedBySearch(words, index));
  }
  return [...operands.flatMap((word) => word.split(/[\s'"`=:(),;&|<>]+/u)), ...redirected].filter(Boolean);
}

/** A shell line's refusal, or null. It reads what the line says, not what an expansion or a script would open. */
async function shellLineRefusal(command, cwd, scope) {
  for (const simple of command.split(/&&|\|\||[;|\n]/u)) {
    for (const token of openedTokens(simple)) {
      const refusal = await namedFileRefusal(token, cwd, scope);
      if (refusal) return refusal;
    }
  }
  return null;
}

/** The refusal for one word or path a call names, by its name and then by its values. */
async function namedFileRefusal(target, cwd, scope) {
  if (!scope.covers(target, cwd)) return null;
  const local = await alwaysLocalTarget(target, cwd);
  const held = local ? null : await heldValue(target, cwd);
  if ((!local && !held) || await scope.allows(target, cwd)) return null;
  return local ? alwaysLocalDenial(local) : valueDenial(held);
}

/** The first real value in a shared config file this call would open, or null. A file it cannot read is left to the other rules. */
async function heldValue(target, cwd) {
  if (typeof target !== 'string' || target.startsWith('-') || !configShapedPath(target)) return null;
  let content;
  try {
    const absolute = absoluteOf(target, cwd);
    const info = statSync(absolute);
    if (!info.isFile() || info.size > MAXIMUM_SCANNED_BYTES) return null;
    content = readFileSync(absolute, 'utf8');
  } catch { return null; }
  const { scanText } = await import('./secrets.mjs');
  const lines = content.split('\n');
  // A compose file's `postgres://postgres:postgres@db` names a service on its own network: the commit gate judges it, this does not hide the file.
  const onItsOwnNetwork = (entry) => entry.rule === 'url-credentials'
    && !/:\/\/[^\s/:@]*:[^\s/@]+@[^\s/:?#]*\./u.test(lines[entry.line - 1] ?? '');
  const findings = scanText(content, { path: target }).filter((entry) => !entry.waived && !onItsOwnNetwork(entry));
  return findings.length ? { target, finding: findings[0], findings, lines } : null;
}

function alwaysLocalDenial(target) {
  return {
    permissionDecision: 'deny', next: [],
    permissionDecisionReason: `ENVIRONMENT_FILE_PRIVATE: ${target} is named to stay on this laptop, so Copilot does not read or edit it. `
      + 'A template such as .env.example shows what it needs. Keep working without its contents, and tell the person anything that has to change in it. '
      + 'If it was committed by mistake, git rm --cached takes it out of Git and leaves their copy.'
  };
}

function valueDenial({ target, finding }) {
  return {
    permissionDecision: 'deny', next: [],
    permissionDecisionReason: `CONFIG_VALUE_PRIVATE: ${target} holds what looks like a real value (${finding.label}, line ${finding.line}), so Copilot does not read or edit it. `
      + 'Ask the person to move it out: replace it with ${NAME} and keep the value in an always-local file such as application-local.yml or .env. '
      + 'If it is only an example, the person puts the waiver marker sflow-allow-secret, a colon and why on that line or the line above it. Keep working without its contents.'
  };
}

function searchDenial({ file, finding }, cwd) {
  const shown = path.relative(cwd || process.cwd(), file) || file;
  const name = path.basename(file);
  const without = `Search without it: grep --exclude=${name}, rg -g '!${name}', or a narrower folder or include pattern. Keep working without its contents.`;
  return { permissionDecision: 'deny', next: [], permissionDecisionReason: finding
    ? `CONFIG_VALUE_PRIVATE: this search would show a real value in ${shown} (${finding.label}, line ${finding.line}), so it did not run. ${without}`
    : `ENVIRONMENT_FILE_PRIVATE: this search would show lines of ${shown}, which stays on this laptop, so it did not run. ${without}` };
}

/** The refusal for a search that would show a secret from a file it does not name. See copilot-search-exposure.mjs. */
async function searchRefusal(searches, cwd, scope, protection) {
  const judge = { covers: scope.covers, allows: scope.allows, heldValue, privateByName: alwaysLocalTarget,
    declared: protection ? (file) => Boolean(protectedTarget(protection, file, cwd)) : null };
  const { secretShownBySearch } = await import('./copilot-search-exposure.mjs');
  for (const search of searches) {
    const shown = await secretShownBySearch(search, cwd, judge);
    if (shown) return searchDenial(shown, cwd);
  }
  return null;
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

// A `/sf-` turn looks at every file a call names and excuses none.
const EVERY_FILE = Object.freeze({ covers: () => true, allows: async () => false });

/**
 * The refusal for the first tool call that touches an environment file, or null. `scope.covers` says
 * whether a file known only by its name or value is this guard's to judge; `scope.allows` excuses one it would refuse.
 */
export async function environmentFilesToolGuard(payload = {}, { env = process.env, scope = EVERY_FILE } = {}) {
  const protection = await environmentFileProtection(payload.cwd, { env });
  for (const call of callsOf(payload)) {
    const cwd = call.args?.cwd ?? payload.cwd;
    if (TERMINALS.has(call.name)) {
      // The launcher's verified Node + CLI entry reads as `singularity-flow` here too.
      const command = asSflowCommand(call.args.command ?? call.args.cmd ?? call.args.script ?? call.args.chars, call.name === 'powershell');
      if (typeof command !== 'string' || !command) continue;
      const allowed = environmentFilesCommandVerdict(command);
      if (allowed === true) continue;
      if (allowed === false) {
        if (await scope.allows('.', cwd)) continue;
        return denial('this env files command');
      }
      const words = command.match(/"[^"]*"|'[^']*'|[^\s;&|<>()`]+/gu) ?? [];
      for (const word of words) {
        const spelled = word.replace(/^['"]|['"]$/gu, '');
        const hit = protectedTarget(protection, spelled, cwd);
        if (hit && !await scope.allows(spelled, cwd)) return denial(hit);
      }
      const refused = await shellLineRefusal(command, cwd, scope);
      if (refused) return refused;
      if (CREDENTIAL_WORD.test(command) && SHELL_SEARCH.test(command)) {
        const { searchesInCommand } = await import('./copilot-search-exposure.mjs');
        const searches = searchesInCommand(command, cwd).filter((search) => search.anything || CREDENTIAL_WORD.test(search.pattern ?? ''));
        const shown = searches.length ? await searchRefusal(searches, cwd, scope, protection) : null;
        if (shown) return shown;
      }
      continue;
    }
    const targets = SEARCH_TOOLS.has(call.name)
      ? [call.args.path, call.args.paths, call.args.cwd, call.args.include, call.args.glob, call.args.includePattern].flat().filter((value) => typeof value === 'string')
      : pathArguments(call.args);
    for (const target of targets) {
      const hit = protectedTarget(protection, target, cwd);
      if (hit) {
        if (await scope.allows(target, cwd)) continue;
        return denial(hit);
      }
      const refusal = await namedFileRefusal(target, cwd, scope);
      if (refusal) return refusal;
    }
    if (SEARCH_TOOLS.has(call.name) && CREDENTIAL_WORD.test(String(call.args.pattern ?? call.args.query ?? call.args.regex ?? ''))) {
      const { searchOfTool } = await import('./copilot-search-exposure.mjs');
      const search = searchOfTool(call.name, call.args);
      const shown = search ? await searchRefusal([search], cwd, scope, protection) : null;
      if (shown) return shown;
    }
  }
  return null;
}

/** What SFlow leaves in a clone that uses it. Files only: an ordinary refusal should not start Git. */
export function usesSflow({ root, common }) {
  if (['workflow.yml', 'capabilities.yml', 'environments.yml'].some((file) => exists(path.join(root, 'singularity', file)))) return true;
  if ([['singularity-flow'], ['refs', 'heads', 'sflow'], ['refs', 'remotes', 'origin', 'sflow']].some((parts) => exists(path.join(common, ...parts)))) return true;
  try { return /\srefs\/(?:heads|remotes\/[^/\s]+)\/sflow\/config\s/u.test(`${readFileSync(path.join(common, 'packed-refs'), 'utf8')}\n`); }
  catch { return false; }
}

/** The capability's answer, from the approved map on this machine. No network, and anything unreadable leaves the refusal standing. */
export async function plainChatSecretsPolicy(root, subjectPath) {
  try {
    const [{ withApprovedConfigurationRead }, { resolveLifecycleCapability }] = await Promise.all([
      import('./approved-configuration-reader.mjs'), import('./capability-context.mjs')]);
    const capability = await withApprovedConfigurationRead(root, () => resolveLifecycleCapability(root, { subjectPath, offline: true }),
      { preferAuthority: true, refreshAuthority: false });
    return capability?.policy?.plainChatSecrets ?? 'refuse';
  } catch { return 'refuse'; }
}

/**
 * The same refusals for a plain chat (docs/SPEC-ENVIRONMENT-FILES-v2.md, "Plain chats"), with two ways
 * out a `/sf-` turn does not have: a file known only by its name or value, in no repository that uses
 * SFlow, is not SFlow's to judge, and a capability may say `allow`. Neither opens a config file, and
 * capabilities are read only for a call that would be refused.
 */
export async function plainChatEnvironmentFilesGuard(payload = {}, { env = process.env, policyFor = plainChatSecretsPolicy } = {}) {
  const repositoryFor = (target, cwd) => { const absolute = absoluteOf(target, cwd); return absolute ? repositoryOf(absolute) : null; };
  const answers = new Map();
  const covers = (target, cwd) => {
    const repository = repositoryFor(target, cwd);
    if (!repository) return false;
    if (!answers.has(repository.root)) answers.set(repository.root, usesSflow(repository));
    return answers.get(repository.root);
  };
  const allows = async (target, cwd) => {
    const repository = repositoryFor(target, cwd);
    return Boolean(repository) && await policyFor(repository.root, path.relative(repository.root, absoluteOf(target, cwd)).split(path.sep).join('/')) === 'allow';
  };
  return environmentFilesToolGuard(payload, { env, scope: { covers, allows } });
}
