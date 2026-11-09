/**
 * SF Guard attribution recorder [SPEC-SFG-v1 G1, REQ-020 to REQ-024], driven by the hooks SFlow
 * already registers. Only when SF Guard is on in the repository does it record, for every Copilot
 * edit and shell call, the Copilot session, the agent and skill it came from and the Story it
 * belongs to: plain and paused prompts too, not only explicit SFlow turns.
 *
 * Allow but label: nothing here changes a hook's answer, refuses, prints, or leaves the machine.
 * Callers swallow every error; failures are kept as gaps. No Git process runs: the repository, its
 * HEAD and its index are read from their own files. Like the XPL2 recorder it extends, the hook
 * bundle loads this file from source (node: imports only), so the hook chunks do not carry it.
 *
 * Identity comes from what Copilot reports (§1 of the spec): a subagent's calls carry its
 * `agentType`; a skill load is a `skill` tool call, or VS Code's `<skill-context>` prompt; the
 * top-level agent is never in a payload and is known only from a declared agent's stamping hook
 * (`singularity-flow hook agent-stamp`), matched to the prompt or call it fired for. Where none
 * applies the agent is `none`, never a guess. Records are strong evidence, not proof (CON-002).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureToolWrites, settleToolWrites } from './observed-write-recorder.mjs';

const FORMAT = 'sfg-attribution@1';
const SESSION_FORMAT = 'sfg-session@1';
const LIMIT = Object.freeze({
  stamps: 64, stampBytes: 32 * 1024, shell: 32, segmentBytes: 1 << 20, retentionDays: 14, mapBytes: 64 * 1024,
  idleMs: 12 * 60 * 60 * 1000, stampSkewMs: 10_000, gapBytes: 16 * 1024, walk: 64, policyBytes: 4 << 20
});
export { FORMAT as SFG_ATTRIBUTION_FORMAT, LIMIT as SFG_ATTRIBUTION_LIMITS };

const SHELLS = new Set(['bash', 'powershell', 'run_in_terminal', 'execute', 'exec_command']);
const BUNDLED_AGENTS = new Set(['sflow-workflow', 'sflow-utility', 'sflow-source-reviewer']);
const SFLOW_SKILL = /^(?:sf|sflow)-[a-z0-9-]+$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const DAY = 864e5;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const short = (value) => sha(String(value)).slice(0, 16);
const name = (value) => (typeof value === 'string' && NAME.test(value) ? value : null);

function sessionIdOf(payload) {
  const id = payload?.sessionId ?? payload?.session_id;
  return typeof id === 'string' && id && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id) ? id : null;
}

/** The boundary directory copilot-mode.mjs names (mirrored: this file imports node: only). */
export function sfGuardBoundaryDirectory(env = process.env, home = os.homedir()) {
  const mode = path.resolve(env.SINGULARITY_FLOW_COPILOT_MODE_FILE || path.join(home, '.singularity-flow', 'copilot-mode.json'));
  return path.join(path.dirname(mode), 'copilot-boundaries');
}

function files(directory, id) {
  const base = path.join(directory, sha(id));
  return { map: `${base}.attribution.json`, stamps: `${base}.attribution-stamps.jsonl`, shell: `${base}.attribution-shell.json`,
    pending: `${base}.pending-writes.json` };
}

async function readJson(file, maxBytes) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** The checkout containing `cwd`, from its `.git` entry alone: `{ root, gitDir, commonDir }` or null. */
export async function sfGuardRepository(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let directory = path.resolve(cwd);
  for (let depth = 0; depth < LIMIT.walk; depth += 1) {
    const dotGit = path.join(directory, '.git');
    const info = await lstat(dotGit).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) return { root: directory, gitDir: dotGit, commonDir: dotGit };
    if (info?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, 'utf8').catch(() => ''))?.[1]?.trim();
      if (!pointer) return null;
      const gitDir = path.resolve(directory, pointer);
      const common = (await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '.')).trim() || '.';
      return { root: directory, gitDir, commonDir: path.resolve(gitDir, common) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

const stateFile = (repo) => path.join(repo.commonDir, 'singularity-flow', 'guard', 'state.json');
const policyFile = (repo) => path.join(repo.root, 'singularity', 'presence.json');
const statSignature = async (file) => {
  const info = await lstat(file).catch(() => null);
  return info?.isFile() ? `${info.ino}:${info.size}:${info.mtimeMs}` : 'absent';
};

/**
 * Whether SF Guard is on for `repo`: the last `enable` or `disable` in the checkout's policy file, or
 * the state a verified `guard` command left on this machine (state.json). Either one turns
 * recording on. No signature is checked here: an unsigned "on" only records more, never less, and
 * the signed policy decides everything that matters (part 1). `cached` skips both reads when the two
 * files are unchanged.
 */
export async function sfGuardOn(repo, cached = null) {
  const signature = `${await statSignature(policyFile(repo))}|${await statSignature(stateFile(repo))}`;
  if (cached?.signature === signature) return { on: Boolean(cached.on), signature };
  let on = false;
  const policy = await readJson(policyFile(repo), LIMIT.policyBytes);
  if (Array.isArray(policy?.events)) {
    const last = [...policy.events].reverse().find((event) => event?.kind === 'enable' || event?.kind === 'disable');
    on = last?.kind === 'enable';
  }
  const state = await readJson(stateFile(repo), 4096);
  if (state?.enabled === true) on = true;
  return { on, signature };
}

/** Left by the `guard` command after it read the verified policy, so the hooks need no Git read. */
export async function writeSfGuardLocalState(cwd, enabled, { now = Date.now() } = {}) {
  const repo = await sfGuardRepository(cwd);
  if (!repo) return;
  await writeJson(stateFile(repo), { format: 'sfg-local-state@1', enabled: Boolean(enabled), at: new Date(now).toISOString() });
}

/** Keep a failure as a gap (REQ-023): bounded, and never an error of its own. */
async function recordGap(repo, code, now = Date.now()) {
  if (!repo) return;
  const file = path.join(repo.commonDir, 'singularity-flow', 'guard', 'gaps.jsonl');
  const info = await lstat(file).catch(() => null);
  if (info && (!info.isFile() || info.size > LIMIT.gapBytes)) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(() => {});
  await appendFile(file, `${JSON.stringify({ at: new Date(now).toISOString(), code: String(code).slice(0, 80) })}\n`, { mode: 0o600 }).catch(() => {});
}

/** The last gaps this checkout recorded (for `guard status`), newest last. */
export async function readSfGuardGaps(cwd) {
  const repo = await sfGuardRepository(cwd);
  if (!repo) return [];
  const text = await readFile(path.join(repo.commonDir, 'singularity-flow', 'guard', 'gaps.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).slice(-20).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/** The Story and step this checkout is bound to (`session.json`), or the whole repository. */
async function boundSubject(repo) {
  const session = await readJson(path.join(repo.gitDir, 'singularity-flow', 'session.json'), 64 * 1024);
  return typeof session?.workId === 'string' && session.workId
    ? { workId: session.workId, phase: typeof session.phaseId === 'string' ? session.phaseId : null, generation: null,
      binding: name(session.agent) }
    : { scope: 'repository', binding: null };
}

/** HEAD's commit and the index's stat, read from Git's own files (REQ-021). */
async function fingerprint(repo) {
  const head = (await readFile(path.join(repo.gitDir, 'HEAD'), 'utf8').catch(() => '')).trim();
  let commit = /^[0-9a-f]{40,64}$/u.test(head) ? head : null;
  const ref = /^ref: (refs\/\S+)$/u.exec(head)?.[1];
  if (ref) {
    const loose = (await readFile(path.join(repo.commonDir, ref), 'utf8').catch(() => '')).trim();
    commit = /^[0-9a-f]{40,64}$/u.test(loose) ? loose
      : ((await readFile(path.join(repo.commonDir, 'packed-refs'), 'utf8').catch(() => '')).split('\n')
        .find((line) => line.endsWith(` ${ref}`)) ?? '').split(' ')[0] || null;
  }
  return { head: commit, ref: ref ?? null, index: await statSignature(path.join(repo.gitDir, 'index')) };
}

function toolCalls(payload) {
  const list = payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name, args: payload.toolArgs ?? payload.tool_input }];
  return (Array.isArray(list) ? list : []).slice(0, 64).map((call) => {
    const raw = call?.args ?? call?.toolArgs ?? {};
    let args = raw;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { patch: args }; } }
    let tool = String(call?.name ?? call?.toolName ?? '').toLowerCase().split(/[.:]/u).at(-1);
    if (tool === 'str_replace_editor') tool = args?.command === 'view' ? 'view' : 'edit';
    return { name: tool, args: args && typeof args === 'object' ? args : {}, key: callKey(call?.name ?? call?.toolName, raw) };
  });
}

/** One call's identity, the same in the plugin's hook and a declared agent's stamping hook. */
export function callKey(toolName, toolArgs) {
  return short(`${String(toolName ?? '')}\n${typeof toolArgs === 'string' ? toolArgs : JSON.stringify(toolArgs ?? null)}`);
}

const isEdit = (tool) => /(?:patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename).*?(?:file|directory)|^(?:patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename|apply_patch)$/u.test(tool);
const commandOf = (args) => String(args.command ?? args.cmd ?? args.script ?? '');
const PUBLISHES = /\b(?:singularity-flow|sflow)\b[^\n;&|]*\b(?:phase\s+(?:publish|submit)|submit\b|prepublish\b[^\n;&|]*--(?:publish|submit)-if-ready)/u;

function pathTargets(args) {
  const found = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [field, child] of Object.entries(value)) {
      if (/^(?:path|file_path|filePath|filepath|file|source|destination|old_path|new_path|oldPath|newPath|uri|fileName|filename)$/u.test(field)) {
        if (typeof child === 'string') found.push(child);
      } else if (field === 'paths' && Array.isArray(child)) found.push(...child.filter((item) => typeof item === 'string'));
      else if (child && typeof child === 'object') { if (Array.isArray(child)) child.forEach(visit); else visit(child); }
    }
  };
  visit(args);
  const patch = args.patch ?? args.input ?? args.text;
  if (typeof patch === 'string') for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu)) found.push(match[1]);
  return [...new Set(found)];
}

async function readStamps(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).slice(-LIMIT.stamps).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/**
 * The agent of a call (REQ-020, REQ-024): a subagent's own `agentType`, else a declared agent's
 * stamp for this call or this prompt, else the Story binding inside an SFlow skill, else none.
 */
function agentOf(payload, map, stamps, call, skill) {
  const subagentType = name(payload.agentType ?? payload.agent_type);
  const stamped = stamps.filter((entry) => entry.key === call || (map?.prompt?.key && entry.key === map.prompt.key
    && entry.at >= map.prompt.at - LIMIT.stampSkewMs));
  const stamp = stamped.find((entry) => entry.key === call) ?? stamped.at(-1);
  if (stamp) return { agent: stamp.agent, agentSource: 'agent-hook' };
  if (subagentType) return { agent: subagentType, agentSource: 'subagent' };
  if (skill?.name && SFLOW_SKILL.test(skill.name) && map?.binding) return { agent: map.binding, agentSource: 'binding' };
  return { agent: null, agentSource: 'none' };
}

/** The skill of a call: one loaded this prompt, the prompt's own, the SFlow turn it continues, or its parent's. */
function skillOf(map) {
  if (map?.currentSkill?.prompt === map?.prompt?.key && map?.currentSkill?.name) return { name: map.currentSkill.name, skillSource: map.currentSkill.source };
  if (map?.prompt?.explicit) return { name: map.prompt.explicit, skillSource: 'prompt' };
  if (map?.prompt?.continued && map.lastExplicit?.skill) return { name: map.lastExplicit.skill, skillSource: 'continued' };
  if (map?.inherited?.skill) return { name: map.inherited.skill, skillSource: 'parent' };
  return { name: null, skillSource: 'none' };
}

/**
 * The provisional class a record carries until G2 checks it against the declared set (§4): a stamped
 * agent or an SFlow skill is declared; plain Copilot, an unstamped agent and an undeclared subagent
 * are outside the workflow (D1); a declared agent using another skill waits for G2.
 */
export function sfGuardClassification({ agentSource, agent }, { name: skill }) {
  const sflowSkill = Boolean(skill && SFLOW_SKILL.test(skill));
  if (agentSource === 'agent-hook' || agentSource === 'binding' || (agentSource === 'subagent' && BUNDLED_AGENTS.has(agent))) {
    return !skill || sflowSkill ? 'declared' : 'pending';
  }
  if (agentSource === 'subagent') return 'outside-workflow';
  return sflowSkill ? 'declared' : 'outside-workflow';
}

function writerFor(payload, map, stamps, call) {
  const skill = skillOf(map);
  const agent = agentOf(payload, map, stamps, call, skill);
  const subagent = name(payload.agentType ?? payload.agent_type) && (payload.agentId ?? payload.agent_id)
    ? { agentId: short(payload.agentId ?? payload.agent_id), parent: payload.parentAgentId ? short(payload.parentAgentId) : null } : null;
  return {
    session: map.session, sessionStart: map.startedAt, prompt: map.prompt?.key ?? null, call,
    skill: skill.name, skillSource: skill.skillSource, agent: agent.agent, agentSource: agent.agentSource,
    ...(subagent ? { subagent } : {}), ...(map.prompt?.paused ? { paused: true } : {}),
    ...(skill.skillSource === 'continued' ? { continued: true } : {}), ...(map.prompt?.plainChat && skill.skillSource === 'none' ? { plainChat: true } : {}),
    ...(map.agentFilesChanged?.length ? { agentFilesChanged: map.agentFilesChanged } : {}),
    classification: sfGuardClassification(agent, skill), provisional: true
  };
}

async function loadMap(directory, payload) {
  const id = sessionIdOf(payload);
  if (!id) return null;
  const paths = files(directory, id);
  const map = await readJson(paths.map, LIMIT.mapBytes);
  return map?.format === SESSION_FORMAT ? { map, paths } : { map: null, paths };
}

async function forget(paths) {
  for (const file of [paths.map, paths.stamps, paths.shell]) await unlink(file).catch(() => {});
}

/** Session maps nobody touched for `idleMs` (a crashed host never sent sessionEnd). */
async function pruneIdle(directory, now) {
  for (const entry of await readdir(directory).catch(() => [])) {
    if (!entry.endsWith('.attribution.json')) continue;
    const file = path.join(directory, entry);
    const info = await lstat(file).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > LIMIT.idleMs) {
      const base = file.slice(0, -'.attribution.json'.length);
      for (const suffix of ['.attribution.json', '.attribution-stamps.jsonl', '.attribution-shell.json']) await unlink(`${base}${suffix}`).catch(() => {});
    }
  }
}

/**
 * userPromptSubmitted: start or continue the session's map when SF Guard is on (REQ-022, REQ-024).
 * `explicitSkill` is the SFlow skill the prompt names (also while paused); a prompt carrying
 * `agentId` is a subagent's task, written by its parent model, never a person's prompt.
 */
export async function sfGuardNotePrompt(payload = {}, { directory = sfGuardBoundaryDirectory(), paused = false, explicitSkill = null, now = Date.now() } = {}) {
  const loaded = await loadMap(directory, payload);
  if (!loaded) return;
  const { paths } = loaded;
  const repo = await sfGuardRepository(payload.cwd);
  const state = repo ? await sfGuardOn(repo, loaded.map?.repo === repo.root ? loaded.map.on : null) : { on: false };
  if (!state.on) { if (loaded.map) await forget(paths); return; }
  await pruneIdle(directory, now).catch(() => {});
  const subject = await boundSubject(repo).catch(() => ({ scope: 'repository', binding: null }));
  const map = loaded.map?.repo === repo.root ? loaded.map : {
    format: SESSION_FORMAT, session: short(sessionIdOf(payload)), startedAt: new Date(now).toISOString(), repo: repo.root,
    gitDir: repo.gitDir, commonDir: repo.commonDir, lastExplicit: null, closed: false
  };
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.slice(0, 256 * 1024) : '';
  const person = !(payload.agentId ?? payload.agent_id);
  const context = name(/<skill-context\s+name=["']([^"']{1,80})["']/u.exec(prompt)?.[1]);
  if (person && explicitSkill) { map.lastExplicit = { skill: explicitSkill, at: now }; map.closed = false; }
  // SF Guard agrees with the guard [PCR:REQ-042]: a person's plain prompt ends the /sf- turn before it, so it is a plain
  // chat, however soon it follows. Only a host's own stop continuation goes on with the turn, as the guard keeps it.
  const stopContinuation = /^SFLOW_[A-Z_]+_INCOMPLETE:/u.test(prompt);
  const continued = Boolean(person && !explicitSkill && stopContinuation && map.lastExplicit && !map.closed);
  const plainChat = Boolean(person && !explicitSkill && !stopContinuation);
  map.prompt = { key: short(prompt), id: randomUUID(), at: now, person, explicit: explicitSkill || null, continued,
    ...(plainChat ? { plainChat: true } : {}), ...(paused ? { paused: true } : {}) };
  map.currentSkill = context ? { name: context, source: 'prompt', prompt: map.prompt.key } : null;
  if (!person && !map.inherited) {
    const parentId = payload.parentAgentId ?? payload.parent_agent_id;
    const parent = typeof parentId === 'string' ? (await loadMap(directory, { sessionId: parentId }))?.map : null;
    const inherited = parent ? skillOf(parent) : null;
    map.inherited = inherited?.name ? { skill: inherited.name, from: parent.session } : null;
  }
  map.binding = subject.binding;
  map.subject = subject.workId ? { workId: subject.workId, phase: subject.phase, generation: null } : { scope: 'repository' };
  map.on = state;
  map.agentFilesChanged = person ? await changedStampedAgents(repo).catch(() => null) : map.agentFilesChanged ?? null;
  map.lastSeenAt = now;
  await writeJson(paths.map, map);
}

const stampedFile = (repo) => path.join(repo.commonDir, 'singularity-flow', 'guard', 'stamped-agents.json');

/** Left by `guard` when it stamps or reads the declared agents' files: each file's path and digest. */
export async function writeSfGuardStampedAgents(cwd, agents, { now = Date.now() } = {}) {
  const repo = await sfGuardRepository(cwd);
  if (!repo) return;
  await writeJson(stampedFile(repo), { format: 'sfg-stamped-agents@1', at: new Date(now).toISOString(),
    agents: agents.slice(0, LIMIT.stamps).map(({ id, path: file, sha256 }) => ({ id, path: file, sha256 })) });
}

/**
 * The stamped agent files `guard` left (`[{ id, path, sha256 }]`), or null when there is no manifest
 * here [SPEC-SFG-v1 AC-011, G4]. Paths stay inside the checkout.
 */
export async function readSfGuardStampedAgents(cwd) {
  const repo = await sfGuardRepository(cwd);
  const manifest = repo ? await readJson(stampedFile(repo), LIMIT.mapBytes) : null;
  if (manifest?.format !== 'sfg-stamped-agents@1' || !Array.isArray(manifest.agents)) return null;
  return manifest.agents.slice(0, LIMIT.stamps).filter((entry) => name(entry?.id) && typeof entry.path === 'string'
    && !entry.path.split('/').includes('..') && !path.isAbsolute(entry.path) && typeof entry.sha256 === 'string')
    .map(({ id, path: file, sha256 }) => ({ id, path: file, sha256, root: repo.root }));
}

/** The Story this checkout is bound to (`{ workId, phase }`), or null for the whole repository [G4]. */
export async function sfGuardCheckoutStory(cwd) {
  const repo = await sfGuardRepository(cwd);
  const subject = repo ? await boundSubject(repo).catch(() => null) : null;
  return subject?.workId ? { workId: subject.workId, phase: subject.phase } : null;
}

/**
 * The declared agents whose files changed since `guard` stamped them [SPEC-SFG-v1 CON-002, AC-011]:
 * a removed or edited stamping hook, or any other change, could let another agent stamp itself as
 * one. Checked once per person's prompt, from bytes on disk.
 */
async function changedStampedAgents(repo) {
  const manifest = await readJson(stampedFile(repo), LIMIT.mapBytes);
  if (manifest?.format !== 'sfg-stamped-agents@1' || !Array.isArray(manifest.agents)) return null;
  const changed = [];
  for (const entry of manifest.agents.slice(0, LIMIT.stamps)) {
    if (typeof entry?.path !== 'string' || entry.path.split('/').includes('..') || path.isAbsolute(entry.path)) continue;
    const bytes = await readFile(path.join(repo.root, entry.path)).catch(() => null);
    if (!bytes || sha(bytes) !== entry.sha256) changed.push(name(entry.id) ?? 'unknown');
  }
  return changed.length ? changed : null;
}

/** The writer fields an explicit SFlow turn's observed write gains while SF Guard records (or null). */
export async function sfGuardWriterFields(payload = {}, { directory = sfGuardBoundaryDirectory(), call = null } = {}) {
  const loaded = await loadMap(directory, payload);
  if (!loaded?.map) return null;
  const fields = writerFor(payload, loaded.map, await readStamps(loaded.paths.stamps), call);
  delete fields.session;
  return fields;
}

/**
 * preToolUse, after the hook has decided (`decision`): note a skill load, a shell call's "before"
 * fingerprint, and (outside an explicit turn, whose own recorder notes them) each edit. A denied
 * call never runs, so it records nothing.
 */
export async function sfGuardNoteToolCall(payload = {}, decision = {}, { directory = sfGuardBoundaryDirectory(), explicitTurn = false, now = Date.now() } = {}) {
  if (decision?.permissionDecision === 'deny') return;
  const loaded = await loadMap(directory, payload);
  if (!loaded?.map) return;
  const { map, paths } = loaded;
  const repo = { root: map.repo, gitDir: map.gitDir, commonDir: map.commonDir };
  try {
    const state = await sfGuardOn(repo, map.on);
    if (!state.on) return await forget(paths);
    const calls = toolCalls(payload);
    const stamps = await readStamps(paths.stamps);
    let changed = false;
    const shell = [];
    const edits = [];
    for (const call of calls) {
      if (call.name === 'skill' && name(call.args.skill)) {
        map.currentSkill = { name: call.args.skill, source: 'skill-call', prompt: map.prompt?.key ?? null };
        changed = true;
      } else if (SHELLS.has(call.name)) shell.push(call);
      else if (isEdit(call.name) && !explicitTurn) edits.push(call);
    }
    if (changed) { map.lastSeenAt = now; await writeJson(paths.map, map); }
    if (shell.length) {
      const pending = (await readJson(paths.shell, LIMIT.mapBytes))?.calls ?? [];
      const before = await fingerprint(repo);
      for (const call of shell) {
        pending.push({ call: call.key, at: now, commandSha256: sha(commandOf(call.args)), cwd: relativeCwd(repo, payload.cwd),
          before, publishes: PUBLISHES.test(commandOf(call.args)), writer: copilotSessionWriter(map, writerFor(payload, map, stamps, call.key)) });
      }
      await writeJson(paths.shell, { format: FORMAT, calls: pending.slice(-LIMIT.shell) });
    }
    if (edits.length) {
      await settleToolWrites(paths.pending).catch(() => {});
      const key = edits.length === 1 ? edits[0].key : short(edits.map((edit) => edit.key).join(','));
      await captureToolWrites({ pendingFile: paths.pending, root: repo.root, cwd: typeof payload.cwd === 'string' ? payload.cwd : repo.root,
        calls: edits.map((call) => ({ name: call.name, args: call.args, targets: pathTargets(call.args) })), gitDirectory: repo.gitDir,
        writer: copilotSessionWriter(map, writerFor(payload, map, stamps, key)),
        subject: map.subject?.workId ? map.subject : null, now });
    }
  } catch (error) { await recordGap(repo, error?.code ?? 'SFG_RECORD_FAILED', now); }
}

/** A plain or paused prompt's writer: XPL2's shape (explain reads kind, session, turn, skill, agent) plus the attribution. */
function copilotSessionWriter(map, fields) {
  const { session, ...attribution } = fields;
  return { kind: 'copilot-session', session, turn: map.prompt?.id ?? null, skill: fields.skill, agent: fields.agent, attribution };
}

function relativeCwd(repo, cwd) {
  if (typeof cwd !== 'string') return '.';
  const relative = path.relative(repo.root, path.resolve(cwd));
  return !relative ? '.' : relative.startsWith('..') || path.isAbsolute(relative) ? 'outside' : relative.split(path.sep).join('/');
}

async function appendRecord(gitDir, record, now) {
  const directory = path.join(gitDir, 'singularity-flow', 'attribution');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) return;
  const day = new Date(now).toISOString().slice(0, 10);
  const line = `${JSON.stringify({ kind: 'sfg-shell-call', format: FORMAT, id: `SA-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    recordedAt: new Date(now).toISOString(), ...record })}\n`;
  const segment = path.join(directory, `${day}.jsonl`);
  const existing = await lstat(segment).catch(() => null);
  if (existing && !existing.isFile()) return;
  if ((existing?.size ?? 0) + Buffer.byteLength(line) > LIMIT.segmentBytes) {
    await open(path.join(directory, `${day}.full`), 'wx', 0o600).then((handle) => handle.close(), () => {});
    return;
  }
  if (!existing) {
    const cutoff = new Date(now - LIMIT.retentionDays * DAY).toISOString().slice(0, 10);
    for (const entry of await readdir(directory)) if (/^\d{4}-\d\d-\d\d\./u.test(entry) && entry.slice(0, 10) < cutoff) await unlink(path.join(directory, entry)).catch(() => {});
  }
  await appendFile(segment, line, { mode: 0o600 });
}

/** postToolUse (shell tools): the call ran; record its fingerprints, and close a published step's continuation. */
export async function sfGuardNoteToolResult(payload = {}, { directory = sfGuardBoundaryDirectory(), now = Date.now() } = {}) {
  const loaded = await loadMap(directory, payload);
  if (!loaded?.map) return;
  const { map, paths } = loaded;
  const repo = { root: map.repo, gitDir: map.gitDir, commonDir: map.commonDir };
  try {
    const pending = (await readJson(paths.shell, LIMIT.mapBytes))?.calls ?? [];
    const keys = new Set(toolCalls(payload).map((call) => call.key));
    const done = pending.filter((entry) => keys.has(entry.call));
    if (!done.length) return;
    const after = await fingerprint(repo);
    for (const entry of done) {
      await appendRecord(repo.gitDir, { writer: entry.writer, subject: map.subject ?? null, call: entry.call,
        commandSha256: entry.commandSha256, cwd: entry.cwd, startedAt: new Date(entry.at).toISOString(), before: entry.before, after, ran: true,
        changed: entry.before.head !== after.head || entry.before.index !== after.index }, now);
    }
    await writeJson(paths.shell, { format: FORMAT, calls: pending.filter((entry) => !keys.has(entry.call)) });
    if (done.some((entry) => entry.publishes) && map.lastExplicit) { map.closed = true; await writeJson(paths.map, map); }
  } catch (error) { await recordGap(repo, error?.code ?? 'SFG_RECORD_FAILED', now); }
}

/**
 * sessionEnd: a shell call with no postToolUse never ran (it was skipped or refused by the person);
 * record it so. Over ACP every prompt ends with `reason: "complete"` and the session goes on, so
 * only another reason ends the map: VS Code reuses a session id after it, and the next prompt starts
 * a new map with its own start (REQ-022).
 */
export async function sfGuardEndSession(payload = {}, { directory = sfGuardBoundaryDirectory(), now = Date.now() } = {}) {
  const loaded = await loadMap(directory, payload);
  if (!loaded?.map) return;
  const { map, paths } = loaded;
  const repo = { root: map.repo, gitDir: map.gitDir, commonDir: map.commonDir };
  try {
    const pending = (await readJson(paths.shell, LIMIT.mapBytes))?.calls ?? [];
    for (const entry of pending) {
      await appendRecord(repo.gitDir, { writer: entry.writer, subject: map.subject ?? null, call: entry.call,
        commandSha256: entry.commandSha256, cwd: entry.cwd, before: entry.before, after: null, ran: false, changed: null }, now);
    }
    await unlink(paths.shell).catch(() => {});
  } catch (error) { await recordGap(repo, error?.code ?? 'SFG_RECORD_FAILED', now); }
  if ((payload.reason ?? 'complete') !== 'complete') await forget(paths);
}

/**
 * A declared agent's stamping hook (`singularity-flow hook agent-stamp <AGENT> <EVENT>`): note that
 * `agent` is the one this session's prompt or call runs as. Always answers `{}`; it records only
 * where SF Guard is on.
 */
export async function sfGuardStamp(agent, event, payload = {}, { directory = sfGuardBoundaryDirectory(), now = Date.now() } = {}) {
  const agentName = name(agent);
  const id = sessionIdOf(payload);
  if (!agentName || !id) return;
  const paths = files(directory, id);
  if (!await lstat(paths.map).catch(() => null)) {
    const repo = await sfGuardRepository(payload.cwd);
    if (!repo || !(await sfGuardOn(repo)).on) return;
  }
  const kind = String(event ?? '');
  const key = kind === 'userPromptSubmitted' && typeof payload.prompt === 'string' ? short(payload.prompt.slice(0, 256 * 1024))
    : ['preToolUse', 'postToolUse'].includes(kind) ? callKey(payload.toolName ?? payload.tool_name, payload.toolArgs ?? payload.tool_input)
      : kind === 'sessionStart' ? 'session' : null;
  if (!key) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(paths.stamps).catch(() => null);
  if (info && info.size > LIMIT.stampBytes) {
    const kept = (await readStamps(paths.stamps)).slice(-LIMIT.stamps / 2);
    await writeFile(paths.stamps, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
  }
  await appendFile(paths.stamps, `${JSON.stringify({ agent: agentName, event: kind.slice(0, 40), key, at: now })}\n`, { mode: 0o600 });
}

/** The CLI route of a stamping hook: read the host's payload, stamp, answer `{}` whatever happens. */
export async function runSfGuardStamp(agent, event, input = process.stdin) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1 << 20) break;
      chunks.push(buffer);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) await sfGuardStamp(agent, event, payload);
  } catch { /* a stamp never fails its host turn */ }
  console.log('{}');
}

/**
 * The agent-scoped hooks a declared agent's `.agent.md` frontmatter carries (D4): a stamp per prompt,
 * which also covers the agent run as a subagent. Each answers `{}` even where SFlow is not on PATH.
 * `command` (with VS Code's `windows`) is the key G0 saw fire in agent files on both hosts; `bash` and
 * `powershell` are the Copilot CLI hook file's own, carrying the same line.
 */
export function sfGuardStampingHooks(agent, { events = ['userPromptSubmitted'] } = {}) {
  const agentName = name(agent);
  if (!agentName) throw new TypeError('A stamping hook needs an agent name of letters, digits, dot, dash or underscore.');
  return Object.fromEntries(events.map((event) => {
    const posix = `command -v singularity-flow >/dev/null 2>&1 && singularity-flow hook agent-stamp ${agentName} ${event} || printf '%s\\n' '{}'`;
    const windows = `if (Get-Command singularity-flow -ErrorAction SilentlyContinue) { singularity-flow hook agent-stamp ${agentName} ${event} } else { Write-Output '{}' }`;
    return [event, [{ type: 'command', command: posix, windows, bash: posix, powershell: windows, timeoutSec: 10 }]];
  }));
}

/** Whether a hook entry is SF Guard's stamp for `agent` (written by sfGuardStampingHooks). */
export function isSfGuardStamp(entry, agent) {
  return Boolean(entry && typeof entry === 'object') && [entry.command, entry.bash].some((line) => typeof line === 'string'
    && line.includes(`singularity-flow hook agent-stamp ${agent} `));
}

/**
 * The writer of the newest Copilot shell call now running in this checkout, or null [G2]: a command
 * SFlow runs inside one (an agent's `upstream-issue raise`, say) is that agent's. Read from the
 * session maps' pending shell calls; null where SF Guard is off or nothing runs.
 */
export async function sfGuardRunningCall(cwd, { directory = sfGuardBoundaryDirectory(), now = Date.now(), withinMs = 10 * 60 * 1000 } = {}) {
  const repo = await sfGuardRepository(cwd);
  if (!repo) return null;
  let newest = null;
  for (const entry of (await readdir(directory).catch(() => [])).filter((file) => file.endsWith('.attribution-shell.json')).slice(0, 256)) {
    const base = path.join(directory, entry.slice(0, -'.attribution-shell.json'.length));
    const map = await readJson(`${base}.attribution.json`, LIMIT.mapBytes);
    if (map?.format !== SESSION_FORMAT || map.repo !== repo.root) continue;
    for (const call of (await readJson(`${base}.attribution-shell.json`, LIMIT.mapBytes))?.calls ?? []) {
      if (Number.isFinite(call?.at) && now - call.at <= withinMs && call.at <= now + 1000 && (!newest || call.at > newest.at)) newest = call;
    }
  }
  return newest?.writer ?? null;
}

/**
 * The authorship an SFlow record made with no `--authored` should carry: `governed-agent` while a
 * Copilot shell call of this checkout runs it, outside a person's own decision turn (/sf-decide
 * writes the person's words); else null, and the command keeps its default. Never throws.
 */
export async function sfGuardRunningAuthorship(cwd, options = {}) {
  const writer = await sfGuardRunningCall(cwd, options).catch(() => null);
  if (!writer) return null;
  return /^(?:sf|sflow)-decide$/u.test(String(writer.skill ?? '').replace(/^\//u, '')) ? null : { authored: 'governed-agent', agent: name(writer.agent) };
}

/** This checkout's shell-call records (G2 reconciles them with the observed writes). */
export async function readSfGuardShellRecords(cwd, { now = Date.now() } = {}) {
  const repo = await sfGuardRepository(cwd);
  if (!repo) return [];
  const directory = path.join(repo.gitDir, 'singularity-flow', 'attribution');
  const cutoff = new Date(now - LIMIT.retentionDays * DAY).toISOString().slice(0, 10);
  const records = [];
  for (const entry of (await readdir(directory).catch(() => [])).sort()) {
    if (!/^\d{4}-\d\d-\d\d\.jsonl$/u.test(entry) || entry.slice(0, 10) < cutoff) continue;
    for (const line of (await readFile(path.join(directory, entry), 'utf8').catch(() => '')).split('\n')) {
      if (!line.trim()) continue;
      try { const record = JSON.parse(line); if (record?.format === FORMAT) records.push(record); } catch { /* unreadable line */ }
    }
  }
  return records;
}
