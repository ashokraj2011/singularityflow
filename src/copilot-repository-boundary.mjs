/** Opt-in discovery guard, not a filesystem sandbox or lifecycle authority. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copilotModeFile, readCopilotMode } from './copilot-mode.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

const FAMILY = 'copilot-repository-boundary';
const MAX_AGE_MS = 30 * 60 * 1000;
const SEARCH_TOOLS = new Set(['grep', 'rg', 'glob', 'search_code_subagent']);
const BUNDLED_AGENTS = new Set(['sflow-workflow', 'sflow-utility', 'sflow-source-reviewer']);
const SEARCH_VALUE_FLAGS = new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not',
  '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context',
  '--max-depth', '--encoding', '--sort', '--sortr']);

function sessionId(payload) {
  const id = payload.sessionId ?? payload.session_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(id) ? id : null;
}

function recordPath(payload) {
  const id = sessionId(payload);
  return id ? path.join(path.dirname(copilotModeFile()), 'copilot-boundaries',
    `${createHash('sha256').update(id).digest('hex')}.json`) : null;
}

export function explicitSflowSkill(prompt) {
  if (typeof prompt !== 'string' || prompt.length > 256 * 1024) return null;
  // Host-expanded skill context is authoritative for invocation, not a substring in ordinary prose.
  return prompt.match(/<skill-context\s+name=["']((?:sf|sflow)-[a-z0-9-]+)["']/u)?.[1]
    ?? prompt.trim().match(/^\/((?:sf|sflow)-[a-z0-9-]+)(?=\s|$)/u)?.[1] ?? null;
}

export function boundaryBootstrap(skill) {
  const name = skill?.replace(/^sflow-/u, 'sf-');
  if (['sf-code', 'sf-phase'].includes(name)) return 'singularity-flow phase enter --for-agent --json';
  if (name === 'sf-next') return 'singularity-flow nextsteps --for-agent --json';
  if (name === 'sf-inputs') return 'singularity-flow inputs --dry-run --for-agent --json';
  if (name === 'sf-review-source') return 'singularity-flow review-source context --for-agent --json';
  return 'singularity-flow workspace current --json';
}

async function removeRecord(file) {
  if (file) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

/** Reset on EVERY prompt, including native turns; never retain the prompt or its attachments. */
export async function recordRepositoryBoundaryTurn(payload = {}, { now = Date.now() } = {}) {
  const file = recordPath(payload);
  if (!file) return {};
  const mode = readCopilotMode();
  const skill = mode.paused ? null : explicitSflowSkill(payload.prompt);
  if (!skill || ['sf-pause', 'sflow-pause'].includes(skill)) { await removeRecord(file); return {}; }
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return {};
  const record = { schemaVersion: currentSchemaVersion(FAMILY), sessionId: sessionId(payload), skill,
    recordedAt: now, modeChangedAt: mode.changedAt };
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await removeRecord(temporary); }
  return {};
}

export async function endRepositoryBoundaryTurn(payload = {}) {
  await removeRecord(recordPath(payload));
  return {};
}

async function currentTurn(payload, now = Date.now()) {
  const mode = readCopilotMode();
  if (mode.paused) return null;
  const file = recordPath(payload);
  if (!file) return null;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const record = readRecord(FAMILY, await readFile(file)).record;
    if (record.sessionId !== sessionId(payload) || typeof record.skill !== 'string'
        || explicitSflowSkill(`/${record.skill}`) !== record.skill
        || record.modeChangedAt !== mode.changedAt || !Number.isFinite(record.recordedAt)
        || now < record.recordedAt || now - record.recordedAt > MAX_AGE_MS) return null;
    return record;
  } catch { return null; }
}

/** A valid caller Git root wins. Only an explicit SFlow turn/agent may fall back to selection. */
export async function resolveCopilotHookRoot(payload = {}, {
  resolveSelected = selectedContext,
  rootFor = cwd => repoRootFor(cwd)
} = {}) {
  if (readCopilotMode().paused) return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  try { return await rootFor(cwd); } catch { /* An SDK chat folder is deliberately not a repository. */ }
  if (!BUNDLED_AGENTS.has(payload.agentName ?? payload.agent_name) && !await currentTurn(payload)) return null;
  const selected = await resolveSelected(cwd);
  return selected?.selectionStatus === 'ready' && selected.repositoryPath ? selected.repositoryPath : null;
}

async function repoRootFor(cwd) { return (await import('./git.mjs')).repoRoot(cwd); }

async function selectedContext(cwd) {
  const context = await import('./workspace-context.mjs');
  return context.resolveWorkspaceExecutionContext(context.activeWorkspaceFile(), context.workspaceRegistryFile(), { cwd });
}

/** Match phase-entry routing, including a selected Story outside the launch Git checkout. */
export async function resolveCopilotDiscoveryRoot(payload = {}, {
  resolveSelected = selectedContext, rootFor = repoRootFor
} = {}) {
  if (readCopilotMode().paused) return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const selected = await resolveSelected(cwd);
  if (selected) return selected.selectionStatus === 'ready' && selected.repositoryPath ? selected.repositoryPath : null;
  try { return await rootFor(cwd); } catch { return null; }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function searchTargets(call) {
  let args = call.args ?? call.toolArgs ?? call.tool_input ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return []; } }
  const name = call.name ?? call.toolName ?? call.tool_name;
  if (SEARCH_TOOLS.has(name)) {
    const values = args.paths ?? args.path ?? args.cwd ?? '.';
    const targets = (Array.isArray(values) ? values : [values]).filter(value => typeof value === 'string');
    if (typeof args.pattern === 'string' && /^(?:\/|~|\$|\.\.)/u.test(args.pattern)) targets.push(args.pattern);
    return targets.map(target => ({ target }));
  }
  if (!['bash', 'powershell', 'run_in_terminal', 'execute'].includes(name)) return [];
  const command = args.command ?? args.cmd ?? args.script ?? '';
  if (typeof command !== 'string' || command.length > 32768) return [];
  const targets = [];
  function scoped(target, at) {
    const prefix = command.slice(0, at);
    const directories = [...prefix.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?=&&|;)/gu)]
      .map(match => match[1].replace(/^['"]|['"]$/gu, ''));
    return { target, directories };
  }
  // Recognize discovery in compound shells too. No arbitrary command execution or shell expansion.
  for (const match of command.matchAll(/(?:^|[;&|\n]\s*|\s)(find|Get-ChildItem|gci)\s+([^;&|\n]+)/gu)) {
    const words = match[2].match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [];
    const operands = [];
    for (const word of words) {
      if (['-H', '-L', '-P', '--'].includes(word)) continue;
      if (word.startsWith('-')) break;
      operands.push(word.replace(/^['"]|['"]$/gu, ''));
    }
    const at = match.index + match[0].indexOf(match[1]);
    targets.push(...(operands.length ? operands : ['.']).map(target => scoped(target, at)));
  }
  // Literal rg/grep/ls operands, not search patterns; allow exact tool-output file inspection.
  // This is deliberately a small command recognizer, not a general shell interpreter.
  for (const match of command.matchAll(/(?:^|[;&|\n]\s*|\s)(rg|grep|ls)\s+([^;&|\n]+)/gu)) {
    const words = match[2].match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [];
    const operands = [];
    let pattern = match[1] !== 'ls' && !words.includes('--files');
    let literal = false;
    for (let index = 0; index < words.length; index++) {
      const word = words[index].replace(/^['"]|['"]$/gu, '');
      if (!literal && word === '--') { literal = true; continue; }
      if (!literal && ['-e', '--regexp', '-f', '--file'].includes(word)) { pattern = false; index++; continue; }
      if (!literal && SEARCH_VALUE_FLAGS.has(word)) { index++; continue; }
      if (!literal && word.startsWith('-')) continue;
      if (/^\d*(?:>|<)/u.test(word)) continue;
      if (pattern) { pattern = false; continue; }
      operands.push(word);
    }
    const at = match.index + match[0].indexOf(match[1]);
    targets.push(...(operands.length ? operands : ['.']).map(target => scoped(target, at)));
  }
  return targets;
}

/** Reject only discovery outside the verified repository, never lifecycle/file/test commands. */
export async function repositoryDiscoveryGuard(payload = {}, { now = Date.now(),
  resolveRoot = resolveCopilotDiscoveryRoot } = {}) {
  const turn = await currentTurn(payload, now);
  if (!turn) return {};
  const calls = payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name,
    args: payload.toolArgs ?? payload.tool_input }];
  const targets = calls.slice(0, 64).flatMap(searchTargets);
  if (!targets.length) return {};
  const root = await resolveRoot(payload).catch(() => null);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  for (const { target, directories = [] } of targets) {
    const base = directories.reduce((current, directory) => path.resolve(current, directory), cwd);
    const normalized = target.replaceAll('\\', '/');
    if (/^(?:~|\$\{?HOME\}?|\/Users\/?$|\/home\/?$|\/\*|\/$)/u.test(normalized)
        || !root || !inside(path.resolve(root), path.resolve(base, target))) {
      // Exact temporary tool-output files remain readable; this is a directory-discovery guard.
      const stat = await lstat(path.resolve(base, target)).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) continue;
      return { permissionDecision: 'deny', permissionDecisionReason:
        `This explicit SFlow turn must not discover a repository by searching home/parent directories. Run ${boundaryBootstrap(turn.skill)} from the current scratch folder; it resolves the selected workspace without filesystem search. Use its ready/workId/repositoryPath binding as cwd. If selection is unavailable, use /sf-session or /sf-workspaces; do not widen the search. Native Copilot and pause mode are unaffected.` };
    }
  }
  return {};
}

/** Host hooks always answer JSON, even with malformed input; they must work outside Git. */
export async function runRepositoryBoundaryHook(event, input = process.stdin) {
  try {
    let text = '';
    for await (const chunk of input) {
      text += chunk.toString();
      if (text.length > 1024 * 1024) return console.log('{}');
    }
    const payload = JSON.parse(text || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return console.log('{}');
    const handler = { 'boundary-turn': recordRepositoryBoundaryTurn,
      'boundary-guard': repositoryDiscoveryGuard, 'boundary-end': endRepositoryBoundaryTurn }[event];
    return console.log(JSON.stringify(await handler(payload)));
  } catch { return console.log('{}'); }
}
