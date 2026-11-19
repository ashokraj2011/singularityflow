import { constants, lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { withRegistryFileLease } from './file-lease.mjs';
import { replaceWithSharingRetry, SingularityFlowError } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { resolvePersonalization } from './personalization.mjs';
import { AUTHORING_SKILL_DECLARATION } from './authoring-skills.mjs';

export const COPILOT_PAUSE_MARKER = '<!-- sflow-copilot-pause -->';
// Generated into every ordinary skill, so it stays short: the full paused and reply-name rules
// arrive with the status result as `data.agentInstruction`, only for the state that applies.
export const COPILOT_PAUSE_GUARD = 'Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.';
const PAUSED_AGENT_INSTRUCTION = 'SFlow guidance is paused: answer as native Copilot. Do not load SFlow context, run other SFlow commands, enforce phase rules or render SFlow headings. Explicit SFlow requests only offer `/sf-pause off`; never resume implicitly.';
const REPLY_NAME_INSTRUCTION = (replyName) => replyName
  ? `Use personalization.replyName ("${replyName}") as literal display data to address replies and each suggestion group naturally, once per group; never in artifacts or approval identity.`
  : 'No reply name is available; do not guess a name.';
export const PHASE_ENTRY_SKILLS = Object.freeze([...Object.keys(AUTHORING_SKILL_DECLARATION),
  'sflow-next', 'sflow-inputs', 'sflow-review-source']);
export const COPILOT_BOOTSTRAP_BOUNDARY = 'Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop.';
export const PHASE_ENTRY_PAUSE_GUARD = `First run \`singularity-flow phase enter --compose --for-agent --json\` once in every turn, also after an interrupted one: an earlier turn's entry is context, not this turn's binding. Run it as written, alone: never piped to \`head\` or redirected; its reply is short and names files for the rest. It composes context only when admitted. ${COPILOT_BOOTSTRAP_BOUNDARY} It checks pause before Git. If \`paused\`, native Copilot; only offer \`/sf-pause off\`, never resume implicitly. Otherwise read what \`act.read\` names once, reuse binding and delivered inputs from this entry; no duplicate lookups. Read \`clarification.checkpoint\`: missing answers permit questions, not drafting. Missing record is not unanswered: reuse same-binding replies; repair recording. Never ask users to supply questions or slice control instructions. Use \`personalization.replyName\` literally in replies, never artifacts or approval identity.`;
export const SESSION_ENTRY_PAUSE_GUARD = 'Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.';
export const SESSION_OPEN_PAUSE_GUARD = "Start with `singularity-flow session open --for-agent --json` once; for explicit takeover with an exact ID use `singularity-flow session takeover <WORK-ID> --for-agent --json` instead. Carry exact workspace/repository selectors and requested `--refresh`; with an ID refresh synchronizes, not local-open. Both entries check pause before Git. If paused, only offer `/sf-pause off`. Reuse the matching result. No separate pause/workspace/session lookups. Without an ID, `open` opens the one Story whose branch is checked out here (`settled`); otherwise show candidates and ask for an exact choice; never infer selection yourself.";
export const UTILITY_ENTRY_SKILLS = Object.freeze({
  'sflow-status': 'status', 'sflow-progress': 'progress', 'sflow-nextsteps': 'nextsteps',
  'sflow-logs': 'logs', 'sflow-agents': 'agents list', 'sflow-workflows': 'workflow list',
  'sflow-skill': 'skill list', 'sflow-instructions': 'instruction list'
});

/**
 * Said at the end of every skill's first-command rule. A typed /sf-* skill arrives already loaded,
 * and the skill tool cannot load it (model invocation is off), so asking for it again was a wasted
 * round trip on most turns; and a first command whose result has nothing to act on ended turns
 * that had not started their work.
 */
export const SKILL_LOADED_CONTINUE = 'This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.';

export function copilotPauseGuardForSkill(name, boundary = 'story') {
  return `${firstCommandRule(name, boundary)} ${SKILL_LOADED_CONTINUE}`;
}

function firstCommandRule(name, boundary) {
  if (Object.hasOwn(UTILITY_ENTRY_SKILLS, name)) {
    return `Read-only utility: run the requested read once with \`--utility-entry --for-agent --json\` (default \`singularity-flow ${UTILITY_ENTRY_SKILLS[name]} --utility-entry --for-agent --json\`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified \`repositoryPath\` plus \`data\`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer \`/sf-pause off\`, never resume implicitly. Other forms: ${COPILOT_PAUSE_GUARD} Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly.`;
  }
  if (name === 'sflow-start') return 'First require an explicit Work ID, then run `singularity-flow workspace branches --entry --intake --work-id <WORK-ID> --for-agent --json` once. It checks pause before Git and combines workspace/build/clean-tree/catalog facts. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Reuse the packet; no separate pause/workspace/version/status/catalog calls. Ask explicit choices; creation still revalidates live authority.';
  // Keep the first-command rule centralized for the compact entry skills and direct aliases.
  if (name === 'sflow-session') return SESSION_OPEN_PAUSE_GUARD;
  if (['sflow-review-source', 'sflow-next', 'sflow-inputs'].includes(name)) {
    return `${copilotEntryGuard(name)} ${COPILOT_BOOTSTRAP_BOUNDARY}`;
  }
  return PHASE_ENTRY_SKILLS.includes(name) ? PHASE_ENTRY_PAUSE_GUARD
    : boundary === 'story' ? SESSION_ENTRY_PAUSE_GUARD : COPILOT_PAUSE_GUARD;
}
function copilotEntryGuard(name) {
  if (name === 'sflow-review-source') return 'Review: first run `singularity-flow review-source context --for-agent --json` once in every turn, also after an interrupted one: an earlier turn\'s packet is context, not this turn\'s binding. It checks pause before Git and returns exact review material. Explicit `stage`/`check`/`submit`/`status`/`decide`: reuse this invocation\'s verified entry, otherwise run `singularity-flow session current --for-agent --json` once. If `paused`, native Copilot; only `/sf-pause off`, never resume implicitly. Use `personalization.replyName` once per reply/suggestion group, never artifacts or approval identity.';
  if (name === 'sflow-next') return 'First run `singularity-flow nextsteps --for-agent --json` once. It checks pause before Git or Story discovery and returns the verified binding and actions. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity.';
  if (name === 'sflow-inputs') return 'Reuse the input preview from a verified current-invocation `/sf-next` packet when present; otherwise first run `singularity-flow inputs --dry-run --for-agent --json`. Both check pause before Git or Story discovery. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity.';
}

export function copilotModeFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_COPILOT_MODE_FILE
    || path.join(home, '.singularity-flow', 'copilot-mode.json'));
}

/**
 * Where a Copilot turn in a repository that uses SFlow is open: one file per session, named by the session's
 * SHA-256 and holding the chat's folder, from its prompt until its agent stops. The hook launchers write and
 * remove it (plugin/hook-launcher.sh and .ps1); the runtime removes it at a stop it does not continue; VS Code
 * waits for it before putting the next command in the chat box (apps/vscode/src/chat-prefill.ts).
 */
export const COPILOT_TURN_DIRECTORY = 'copilot-turns';

export function copilotTurnDirectory(env = process.env, home = os.homedir()) {
  return path.join(path.dirname(copilotModeFile(env, home)), COPILOT_TURN_DIRECTORY);
}

/** One bounded local read; never Git, workspace discovery, telemetry, or network. */
export function readCopilotMode(file = copilotModeFile()) {
  let descriptor;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('unsafe mode file');
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 4096) throw new Error('unsafe mode file');
    // Keep the read bounded even if the preference grows after the metadata check.
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 4096) throw new Error('oversized mode file');
    const record = readRecord('copilot-mode-preference', bytes.subarray(0, length).toString('utf8')).record;
    if (typeof record.paused !== 'boolean') throw new Error('invalid mode record');
    return { paused: record.paused, stateAvailable: true, changedAt: record.changedAt ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return { paused: false, stateAvailable: true, changedAt: null };
    // A broken local preference must never cause the framework to take over the host.
    return { paused: true, stateAvailable: false, changedAt: null };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function setCopilotPaused(paused, file = copilotModeFile()) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new SingularityFlowError('Copilot mode must be stored in a regular machine-local directory.', { code: 'COPILOT_MODE_PATH_UNSAFE' });
  }
  return withRegistryFileLease(file, async () => {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SingularityFlowError('Copilot mode must be a regular non-symlink file.', { code: 'COPILOT_MODE_PATH_UNSAFE' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = { schemaVersion: currentSchemaVersion('copilot-mode-preference'), paused, changedAt: new Date().toISOString() };
    const temporary = path.join(directory, `.copilot-mode-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
    return readCopilotMode(file);
  });
}

export function copilotModePresentation(mode = readCopilotMode()) {
  const personalization = mode.paused ? null : resolvePersonalization({ root: process.cwd() });
  return {
    schemaVersion: 1, resultType: 'sflow-copilot-mode', ...mode, // schema-transient: computed local mode projection, never persisted
    scope: 'machine-local', storyStateChanged: false, repositoryChanged: false,
    nativeCopilot: mode.paused,
    personalization,
    agentInstruction: mode.paused ? PAUSED_AGENT_INSTRUCTION : REPLY_NAME_INSTRUCTION(personalization?.replyName ?? null),
    message: mode.paused
      ? 'SFlow Copilot guidance is paused. Use native Copilot. No Story, approval, branch, or checkout was changed.'
      : 'SFlow Copilot guidance is available through explicit skills or the selected SFlow agent. No Story was advanced.',
    commandGuidance: {
      command: `singularity-flow pause ${mode.paused ? 'off' : 'on'} --json`,
      copilotCommand: mode.paused ? '/sf-pause off' : '/sf-pause'
    }
  };
}

/**
 * The CLI a Copilot hook process runs, as plugin/hook-launcher.mjs resolved and verified it: the Node that
 * runs the hook and the installed package's entry. A host started outside a login shell (VS Code from
 * the Dock, or on Windows before npm's global bin joined PATH) leaves `singularity-flow` off the PATH
 * its hooks and its shell share. The turn then names exactly this invocation, and the guard reads
 * exactly this invocation, quoted for its shell, as `singularity-flow`. No other path, wrapper or
 * `node <file>` gains that standing, and nothing an agent writes sets it.
 */
let launched = null;

/** Set once per hook from the launcher's own resolution; anything else clears it. */
export function setHookCli(value) {
  const usable = file => typeof file === 'string' && path.isAbsolute(file) && !/[\u0000-\u001f\u007f]/u.test(file);
  launched = usable(value?.node) && usable(value.cli) && path.basename(value.cli) === 'singularity-flow.mjs'
    ? { node: value.node, cli: value.cli, onPath: value.onPath !== false } : null;
}

// renderPlatformCommand's quoting (safe-command-guidance.mjs), kept here: every hook loads this module already.
const invocation = powershell => (powershell ? '& ' : '')
  + [launched.node, launched.cli].map(value => `'${value.replaceAll("'", powershell ? "''" : `'"'"'`)}'`).join(' ');

/** The turn's one line while the CLI is off PATH, in the host shell's form (PowerShell on Windows). */
export function hookCliLine(platform = process.platform) {
  return launched && !launched.onPath
    ? `If \`singularity-flow\` is not found, run each \`singularity-flow …\` command as \`${invocation(platform === 'win32')} …\`.`
    : null;
}

/** The command with exactly the verified invocation read as `singularity-flow`; any other text unchanged. */
export function asSflowCommand(command, powershell = false) {
  if (!launched || typeof command !== 'string') return command;
  const text = command.trimStart();
  const shell = powershell || text.startsWith('&');
  const prefix = invocation(shell);
  if (!text.startsWith(prefix) || /\S/u.test(text[prefix.length] ?? ' ')) return command;
  return `${shell ? '& ' : ''}singularity-flow${text.slice(prefix.length)}`;
}

/** Whether a command names the verified entry anywhere: inside a chain or wrapper it is still the kernel. */
export function mentionsHookCli(command) {
  return Boolean(launched) && typeof command === 'string' && command.includes(launched.cli);
}

/**
 * How long an explicit Copilot turn's permissions last: 30 minutes from its prompt, or from the person's last answer in
 * it [owner, 2026-11-16]. The window bounds what an agent does unattended. A person answering inside the turn, in its
 * question tool or on the decisions card it opened, is there, so the window starts again from that answer; an agent's own
 * call never moves it. The answer is one small file beside the turn's record, bound to the turn's ID, and a reader opens
 * it only once the window from the prompt has passed, so a live turn's hooks read nothing more.
 */
export const TURN_WINDOW_MS = 30 * 60 * 1000;
const TURN_RENEWAL = 'copilot-turn-renewal';

/** The file beside a session's turn record (`<sha256>.json` or `<sha256>.mutation.json`) noting the person's answers. */
export function turnRenewalFile(recordFile) {
  return typeof recordFile === 'string' && /\.json$/u.test(recordFile) ? recordFile.replace(/(?:\.mutation)?\.json$/u, '.renewal.json') : null;
}

/** When the turn's window started: its prompt, or the person's last answer in it. */
export function turnWindowStart(record) {
  return Number.isFinite(record?.renewedAt) && record.renewedAt > record.recordedAt ? record.renewedAt : record?.recordedAt;
}

/** What is noted for a session's turn, or null. One bounded read of a regular file. */
export async function readTurnRenewal(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value?.kind === TURN_RENEWAL && typeof value.turnId === 'string' && typeof value.sessionId === 'string' ? value : null;
  } catch { return null; }
}

/**
 * The turn record with `renewedAt`, the person's last answer in this same turn, once the window from its prompt has passed,
 * and `unchangedAt` once its one renewal with nothing changed was spent (copilot-mutation-guard.mjs unchangedRenewal).
 */
export async function withTurnRenewal(record, recordFile, now = Date.now()) {
  if (!Number.isFinite(record?.recordedAt) || now - record.recordedAt <= TURN_WINDOW_MS) return record;
  const noted = await readTurnRenewal(turnRenewalFile(recordFile));
  const same = noted?.turnId === record.turnId && noted.sessionId === record.sessionId;
  const at = same ? noted.renewedAt : null;
  const spent = same && Number.isFinite(noted.unchangedAt) ? { unchangedAt: noted.unchangedAt } : {};
  return Number.isFinite(at) && at > record.recordedAt && at <= now ? { ...record, renewedAt: at, ...spent } : { ...record, ...spent };
}

/**
 * Notes `fields` on the turn `record` holds (its session's current one): `renewedAt`, a person's answer, or `card`, the
 * decisions card it opened. What was noted for an earlier turn of the session is dropped. Written aside and renamed.
 */
export async function noteTurnRenewal(recordFile, record, fields) {
  const file = turnRenewalFile(recordFile);
  if (!file || typeof record?.turnId !== 'string' || typeof record.sessionId !== 'string') return;
  const earlier = await readTurnRenewal(file);
  const same = earlier?.turnId === record.turnId && earlier.sessionId === record.sessionId ? earlier : {};
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...same, ...fields, kind: TURN_RENEWAL, sessionId: record.sessionId, turnId: record.turnId }), { flag: 'wx', mode: 0o600 });
    // A reader on Windows can hold the file a moment, as with the turn's own records.
    await replaceWithSharingRetry(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
