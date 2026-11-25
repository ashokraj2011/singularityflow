/** Explicit-turn discovery and mutation interception; not a filesystem sandbox. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat as fileStat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codePageSafeJson } from './code-page-safe-json.mjs';
import { copilotModeFile, copilotTurnDirectory, hookCliLine, mentionsHookCli, readCopilotMode, TURN_WINDOW_MS, turnWindowStart, withTurnRenewal } from './copilot-mode.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { nearestNames, platformPathWithin, sentenceList } from './util.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { copilotHome } from './copilot-home.mjs';
import { AUTHORING_SKILL_DECLARATION } from './authoring-skills.mjs';
import { confirmCodesIn, resolveConfirmCode } from './confirm-code.mjs';
import { noteActivity } from './machine-activity.mjs';
import { noteHookSession } from './copilot-chat-hooks.mjs';
import { ASKED_FOR_SKILLS, TASK_COMPLETION_ALIASES } from './writing-aliases.mjs';

const FAMILY = 'copilot-repository-boundary';
/**
 * Left in the boundary directory by plugin/hook-launcher.mjs when it cannot load the runtime. The
 * shell launcher answers guards without Node only while that directory is empty, so a runtime
 * that could not record a turn keeps failing closed until a working one handles the next prompt.
 */
export const RUNTIME_UNAVAILABLE_MARKER = 'runtime-unavailable';
const MAX_AGE_MS = TURN_WINDOW_MS;
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
  if (typeof prompt !== 'string') return null;
  // A long prompt (a pasted log after /sf-code) is still that skill's turn: its start names it.
  if (prompt.length > 256 * 1024) prompt = prompt.slice(0, 256 * 1024);
  // Host-expanded skill context is authoritative for invocation, not a substring in ordinary prose.
  return prompt.match(/<skill-context\s+name=["']((?:sf|sflow)-[a-z0-9-]+)["']/u)?.[1]
    ?? prompt.trim().match(/^\/((?:sf|sflow)-[a-z0-9-]+)(?=\s|$)/u)?.[1] ?? null;
}

/**
 * A typed `/sf-<word>` no skill has: never a turn under the typo's name, which started a read turn for /sf-mext and sent
 * the model to the gateway [owner, 2026-11-20, hardening C]. Says so, with the nearest SFlow skill names to type again.
 *
 * Held only when the name is in none of the places Copilot loads a skill, prompt or agent from for this repository and
 * person (skillSources): SFlow's own skills, the repository's (.github/skills, .github/prompts, .github/agents,
 * singularity/agents, skills/ and every `.<tool>/skills`), the person's (Copilot's skills folder with SFlow's direct
 * aliases, every `~/.<tool>/skills`, and VS Code's own User prompts with the folders its settings add) and every installed
 * plugin's. A team's own `/sf-team-thing` is a turn as before. Any place
 * that exists but cannot be read fails open: nothing is held. A host-expanded skill (the host found it) is never held.
 */
export function unknownSkillReason(prompt, skill, { skillsRoot = path.join(PACKAGE_ROOT, 'plugin', 'skills'), cwd = process.cwd(), env = process.env,
  homeDirectory = os.homedir(), platform = process.platform } = {}) {
  if (!skill || /<skill-context\s/u.test(String(prompt ?? ''))) return null;
  const word = skill.replace(/^(?:sf|sflow)-/u, '');
  const own = namesIn(skillsRoot, { folders: true });
  if (!own || !own.length) return null;
  const sflow = own.filter((name) => name.startsWith('sflow-')).map((name) => name.slice('sflow-'.length));
  if (sflow.includes(word)) return null;
  // The rare case only: an SFlow skill's name was not typed, so every other place is read before anything is held.
  const wanted = new Set([skill, `sf-${word}`, `sflow-${word}`]);
  const sources = skillSources({ cwd, env, homeDirectory, platform });
  if (!sources) return null;
  for (const directory of sources) {
    const names = namesIn(directory, { folders: true, files: true });
    if (names === null || names.some((name) => wanted.has(name))) return null;
  }
  const near = nearestNames(word, sflow).map((name) => `/sf-${name}`);
  return `No SFlow command /${skill}.${near.length ? ` Did you mean ${sentenceList(near)}?` : ' /sf-help lists them.'} Type it again with the right name; nothing was run.`;
}

/** The repository the prompt came from: the nearest folder above `cwd` with a `.git`, else `cwd` itself. */
function repositoryFolder(cwd) {
  for (let folder = path.resolve(cwd); ; folder = path.dirname(folder)) {
    if (existsSync(path.join(folder, '.git'))) return folder;
    if (path.dirname(folder) === folder) return path.resolve(cwd);
  }
}

/** A folder's entries; [] when it is not there; null when it is there but cannot be read (the caller fails open). */
function entriesOf(directory) {
  try { return readdirSync(directory, { withFileTypes: true }); }
  catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? [] : null; }
}

/**
 * Every folder Copilot loads a skill, prompt or agent from, besides SFlow's own: the repository's, the person's and plugins'.
 * Null when one that holds them cannot be listed.
 */
export function skillSources({ cwd = process.cwd(), env = process.env, homeDirectory = os.homedir(), platform = process.platform } = {}) {
  const repository = repositoryFolder(cwd);
  const top = entriesOf(repository);
  if (!top) return null;
  const tools = top.filter((entry) => entry.isDirectory() && entry.name.startsWith('.') && !['.git', '.sflow'].includes(entry.name))
    .flatMap((entry) => ['skills', 'prompts', 'agents'].map((kind) => path.join(repository, entry.name, kind)));
  const copilot = copilotHome({ env, homeDirectory });
  // Copilot's personal skills, where `plugin install` writes SFlow's /sf- aliases too (direct-skills.mjs copilotSkillsDirectory).
  const personal = String(env.SINGULARITY_FLOW_COPILOT_SKILLS_DIR ?? '').trim() ? path.resolve(env.SINGULARITY_FLOW_COPILOT_SKILLS_DIR) : path.join(copilot, 'skills');
  // Every installed plugin's skills: Copilot's installed-plugins/<source>/<plugin>/skills.
  const plugins = [];
  const installed = path.join(copilot, 'installed-plugins');
  const sourcesOf = entriesOf(installed);
  if (!sourcesOf) return null;
  for (const source of sourcesOf.filter((entry) => entry.isDirectory())) {
    const each = entriesOf(path.join(installed, source.name));
    if (!each) return null;
    for (const plugin of each.filter((entry) => entry.isDirectory())) plugins.push(path.join(installed, source.name, plugin.name, 'skills'));
  }
  // Every coding tool's own skills in the person's home (`~/.<tool>/skills`), as in the repository.
  const homeEntries = entriesOf(homeDirectory);
  if (!homeEntries) return null;
  const homeTools = homeEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith('.')).map((entry) => path.join(homeDirectory, entry.name, 'skills'));
  const editor = editorPromptFolders({ env, homeDirectory, platform, repository });
  if (!editor) return null;
  return [...new Set([path.join(repository, 'skills'), path.join(repository, 'singularity', 'agents'), ...tools,
    personal, path.join(copilot, 'prompts'), path.join(copilot, 'agents'), ...homeTools, ...plugins, ...editor])];
}

// VS Code, its Insiders build and VSCodium: each keeps a person's prompt files in its User folder's `prompts`.
const EDITOR_PRODUCTS = Object.freeze(['Code', 'Code - Insiders', 'VSCodium']);

/**
 * The person's own VS Code prompt files: each editor's `User/prompts` (macOS ~/Library/Application Support, Windows
 * %APPDATA%, Linux $XDG_CONFIG_HOME or ~/.config), and the folders its User settings.json adds in
 * `chat.promptFilesLocations` (relative ones are the workspace's). Null when a settings file there cannot be read or parsed.
 */
function editorPromptFolders({ env, homeDirectory, platform, repository }) {
  const base = platform === 'darwin' ? path.join(homeDirectory, 'Library', 'Application Support')
    : platform === 'win32' ? String(env.APPDATA ?? '').trim() || path.join(homeDirectory, 'AppData', 'Roaming')
      : String(env.XDG_CONFIG_HOME ?? '').trim() || path.join(homeDirectory, '.config');
  const folders = [];
  for (const product of EDITOR_PRODUCTS) {
    const user = path.join(base, product, 'User');
    folders.push(path.join(user, 'prompts'));
    let text;
    try { text = readFileSync(path.join(user, 'settings.json'), 'utf8'); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error?.code)) continue; return null; }
    let settings;
    // settings.json is JSON with comments and trailing commas: only those are removed; anything else that fails to parse
    // fails open.
    try { settings = JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (match) => (match.startsWith('"') ? match : ''))
      .replace(/,(\s*[}\]])/gu, '$1')); } catch { return null; }
    const locations = settings?.['chat.promptFilesLocations'];
    const named = Array.isArray(locations) ? locations : locations && typeof locations === 'object'
      ? Object.entries(locations).filter(([, on]) => on).map(([folder]) => folder) : [];
    for (const folder of named.filter((value) => typeof value === 'string' && value.trim())) {
      const value = folder.trim().replace(/^~(?=$|[\\/])/u, homeDirectory);
      folders.push(path.isAbsolute(value) ? value : path.join(repository, value));
    }
  }
  return folders;
}

/**
 * The names one folder offers: each folder's name and its SKILL.md `name:`, each file's name without `.prompt.md`,
 * `.agent.md`, `.chatmode.md` or `.md`. An empty list when the folder is not there; null when it is there but cannot be read.
 */
function namesIn(directory, { folders = false, files = false } = {}) {
  const entries = entriesOf(directory);
  if (!entries) return null;
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && folders) {
      names.push(entry.name);
      if (!files) continue;
      let text = null;
      try { text = readFileSync(path.join(directory, entry.name, 'SKILL.md'), 'utf8'); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return null; }
      const declared = text?.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/mu)?.[1];
      if (declared) names.push(declared.trim());
    } else if ((entry.isFile() || entry.isSymbolicLink()) && files && /\.md$/u.test(entry.name)) {
      names.push(entry.name.replace(/(?:\.(?:prompt|agent|chatmode))?\.md$/u, ''));
    }
  }
  return names;
}

/** Only the complete review invocation opts into completion; explicit stage/check/status are single steps. */
export function sourceReviewCompletionRequested(prompt) {
  if (!['sf-review-source', 'sflow-review-source'].includes(explicitSflowSkill(prompt))) return false;
  const args = prompt.trim().startsWith('/') ? prompt.trim().replace(/^\/\S+\s*/u, '')
    : prompt.match(/\bARGUMENTS:\s*([^]*?)\s*<\/skill-context>/u)?.[1];
  return typeof args === 'string' && !/^(?:context|stage|check|submit|status|decide|decision-context)(?:\s|$)/u.test(args);
}

/**
 * Opt in full authoring tasks by capability, never by a workflow's phase names: the authoring catalog's skills and the
 * writing aliases whose turn completes the step's task (writing-aliases.mjs, the one table that names them).
 */
export function workflowTaskCompletionRequested(prompt) {
  const skill = explicitSflowSkill(prompt)?.replace(/^sf-/u, 'sflow-');
  if (!skill || !(AUTHORING_SKILL_DECLARATION[skill] || TASK_COMPLETION_ALIASES.includes(skill))) return false;
  const args = prompt.trim().startsWith('/') ? prompt.trim().replace(/^\/\S+\s*/u, '')
    : prompt.match(/\bARGUMENTS:\s*([^]*?)\s*<\/skill-context>/u)?.[1];
  return typeof args === 'string' && !/^(?:context|stage|check|status|show|preview|prepare|publish)(?:\s|$)/u.test(args);
}

/**
 * The one reviewed digest a /sf-confirm prompt carries, or null when it carries none or several.
 * Only this value is kept, never the prompt: it binds the turn to the command the person confirmed.
 */
export function confirmedDigest(prompt) {
  return confirmedTurn(prompt)?.digest ?? null;
}

/**
 * What a /sf-confirm prompt confirms: `{ digest, code }`. The person types the short code a route gave
 * (`/sf-confirm K7Q2-M8DX`, confirm-code.mjs), which stands for one command kept on this machine, and its
 * digest binds the turn; a whole command with its digest still binds it as before. Null for none or several.
 */
export function confirmedTurn(prompt) {
  if (typeof prompt !== 'string' || prompt.length > 256 * 1024) return null;
  const found = new Set([...prompt.matchAll(/--confirm(?:-plan)?[\s=]+(sha256:[a-f0-9]{64}|[a-z]{2,12}[-_][a-f0-9]{16,64}|[a-f0-9]{64}|[a-f0-9]{40})(?![\w:-])/gu)]
    .map(match => match[1]));
  if (found.size) return found.size === 1 ? { digest: [...found][0], code: null } : null;
  const codes = confirmCodesIn(prompt).map(code => resolveConfirmCode(code)).filter(Boolean);
  return codes.length === 1 ? { digest: codes[0].value, code: codes[0].code } : null;
}

export function boundaryBootstrap(skill) {
  const name = skill?.replace(/^sflow-/u, 'sf-');
  if (['sf-code', 'sf-phase'].includes(name)) return 'singularity-flow phase enter --for-agent --json';
  if (name === 'sf-next') return 'singularity-flow nextsteps --for-agent --json';
  if (name === 'sf-inputs') return 'singularity-flow inputs --dry-run --for-agent --json';
  if (name === 'sf-review-source') return 'singularity-flow review-source context --for-agent --json';
  if (name === 'sf-publish') return 'singularity-flow session current --for-agent --json';
  return 'singularity-flow workspace current --json';
}

/**
 * SF Guard attribution [SPEC-SFG-v1 G1]: a session map exists only where SF Guard is on, so every
 * other session pays one lstat. The recorder loads from source and never changes a hook's answer.
 */
function attributionMap(payload) {
  const id = sessionId(payload);
  return id ? path.join(path.dirname(copilotModeFile()), 'copilot-boundaries', `${createHash('sha256').update(id).digest('hex')}.attribution.json`) : null;
}

async function attribute(payload, note, { always = false } = {}) {
  try {
    const map = attributionMap(payload);
    if (!map || (!always && !await lstat(map).then(() => true, () => false))) return;
    // A literal specifier: the hook bundle loads this module from source (scripts/build-cold-cli-bundle.mjs).
    await note(await import('./comprehension/xpl2/sf-guard-recorder.mjs'), path.dirname(map));
  } catch { /* recording never touches the hook's answer */ }
}

async function removeRecord(file) {
  if (file) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

/**
 * The session's open-turn marker (copilotTurnDirectory): the launchers write it at a prompt in a repository that
 * uses SFlow and remove it at a stop they answer without Node. A stop answered here removes it unless the answer
 * continues the turn, and so does the session's end; a sub-agent's or a reviewer's stop leaves the author's turn
 * open. One unlink; never Git or network.
 */
async function closeTurnMarker(payload, own = payload) {
  const id = sessionId(payload);
  if (!id || sessionId(own) !== id || [payload.agentId, payload.agent_id].some((value) => value != null && value !== '')) return;
  await removeRecord(path.join(copilotTurnDirectory(), createHash('sha256').update(id).digest('hex'))).catch(() => {});
}

async function removeMutationRecord(file) {
  if (!file) return;
  const mutation = file.replace(/\.json$/u, '.mutation.json');
  await removeRecord(mutation);
  await removeRecord(file.replace(/\.json$/u, '.answers.json'));
  await removeRecord(file.replace(/\.json$/u, '.renewal.json'));
  // A scanner holding an advisory hint must not block native chat or reopen an ended turn.
  // The authority record is already gone; the next explicit capture retries this cleanup.
  await rm(`${mutation}.issued`, { recursive: true, force: true }).catch(() => {});
}

/** XPL2: a turn's noted edits are settled for good before its records go. One lstat when none wait. */
async function settleObservedEdits(payload) {
  const pending = recordPath(payload)?.replace(/\.json$/u, '.pending-writes.json');
  if (pending && await lstat(pending).then(() => true, () => false)) {
    await (await import('./copilot-mutation-guard.mjs')).settleObservedEdits(payload).catch(() => {});
  }
}

/**
 * Reset on EVERY prompt, including native turns; never retain the prompt or its attachments as sent. In a
 * repository that uses SFlow each prompt is kept redacted (copilot-plain-chat.mjs [PCR:REQ-002]), and the redacted
 * words a person typed after /sf-code or /sf-phase go to their Story [SCS:REQ-040]. A prompt
 * naming an SFlow skill, paused or not, also gets the CLI's verified invocation while the CLI is off
 * PATH: that skill's first command would otherwise fail with `command not found`.
 */
export async function recordRepositoryBoundaryTurn(payload = {}, options = {}) {
  // The review's own prompt, sent under the author's session by a host that names no sub-agent (review-subagent.mjs),
  // is the reviewer's turn beside the author's; any other prompt ends a reviewer still launched there.
  let note = null;
  if (!options.reviewerSubagent) {
    const framed = await reviewerFrame(payload, 'prompt');
    payload = framed.payload;
    if (framed.reviewer) options = { ...options, reviewerSubagent: true };
    // VS Code's runSubagent names no sub-agent: SFlow says so to the review, as subagentStart does on the Copilot CLI.
    if (framed.reviewer) note = (await import('./review-subagent.mjs')).REVIEWER_SUBAGENT_NOTE;
  }
  const answer = await recordTurn(payload, options);
  const cli = hookCliLine();
  const line = [note, cli && explicitSflowSkill(payload.prompt) ? cli : null].filter(Boolean).join(' ');
  return line && answer.decision !== 'block'
    ? { ...answer, additionalContext: answer.additionalContext ? `${answer.additionalContext} ${line}` : line } : answer;
}

/** Where the session's copy of its last prompt lives (plain-chat-prompts.mjs): one lstat says whether to look. */
function promptCopyPath(payload) {
  const id = sessionId(payload);
  return id ? path.join(path.dirname(copilotModeFile()), 'copilot-prompts', `${createHash('sha256').update(id).digest('hex')}.json`) : null;
}

/**
 * Plain-chat routing's part of the prompt hook (copilot-plain-chat.mjs): in a repository that uses SFlow every
 * prompt is kept, redacted [PCR:REQ-002], and one that holds what looks like a secret is blocked [PCR:REQ-003].
 * Paused, nothing is kept. Keeping a prompt never stops it: a failure here answers nothing.
 */
async function notePlainChatPrompt(payload, { skill, paused, now }) {
  try {
    if (paused) {
      const copy = promptCopyPath(payload);
      if (copy) await rm(copy, { force: true });
      return null;
    }
    return await (await import('./copilot-plain-chat.mjs')).notePrompt(payload, { skill, now });
  } catch { return null; }
}

async function recordTurn(payload, { now = Date.now(), captureMutation = null, reviewerSubagent = false }) {
  await removeRecord(path.join(path.dirname(copilotModeFile()), 'copilot-boundaries', RUNTIME_UNAVAILABLE_MARKER))
    .catch(() => {});
  await settleObservedEdits(payload).catch(() => {});
  // Some hosts deliver a stop continuation through the prompt hook again. Keep the already issued
  // live scope for that one continuation; the marker alone cannot create or widen permissions.
  if (typeof payload.prompt === 'string' && payload.prompt.startsWith('SFLOW_SOURCE_REVIEW_INCOMPLETE:')) {
    const value = await (await import('./copilot-mutation-guard.mjs')).reviewCompletionTurn(payload);
    if (value?.reviewOperation?.continued && !value.reviewOperation.complete && !value.reviewOperation.blocked) {
      return { additionalContext: 'Continue the same admitted source review using its existing exact paths and pinned inputs; no new entry or authority was granted.' };
    }
  }
  if (typeof payload.prompt === 'string' && payload.prompt.startsWith('SFLOW_WORKFLOW_TASK_INCOMPLETE:')) {
    const value = await (await import('./copilot-mutation-guard.mjs')).workflowCompletionTurn(payload);
    if (value?.taskOperation?.continued && !value.taskOperation.complete && !value.taskOperation.blocked) {
      return { additionalContext: 'Continue the same admitted workflow task with its exact input paths and existing scope. No new entry, permissions or human decisions were granted.' };
    }
  }
  const file = recordPath(payload);
  if (!file) return {};
  const mode = readCopilotMode();
  // A reviewer sub-agent's own turn (review-subagent.mjs) is recorded by SFlow, not typed: no prompt of it is noted.
  if (!reviewerSubagent) await attribute(payload, (recorder, directory) => recorder.sfGuardNotePrompt(payload, { directory, paused: mode.paused,
    explicitSkill: explicitSflowSkill(payload.prompt), now }), { always: true });
  // A sub-agent's task text is written by the turn that started it: it never starts, replaces or ends that turn. A
  // sub-agent with a session of its own (hosts name the author's as parentAgentId) records its own turn as usual.
  if ([payload.agentId, payload.agent_id].some((value) => value != null && value !== '')
      && [payload.parentAgentId, payload.parent_agent_id, sessionId(payload)].filter(Boolean)[0] === sessionId(payload)) return {};
  const skill = mode.paused ? null : explicitSflowSkill(payload.prompt);
  // A typo of a skill's name is said back to the person, never run as a turn of its own.
  const unknown = reviewerSubagent ? null : unknownSkillReason(payload.prompt, skill, { cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd() });
  if (unknown) {
    await removeRecord(file);
    await removeMutationRecord(file);
    return { decision: 'block', reason: unknown };
  }
  const noted = reviewerSubagent ? null : await notePlainChatPrompt(payload, { skill, paused: mode.paused, now });
  if (noted?.decision === 'block') {
    // The prompt never reaches the model (Copilot CLI and VS Code): no turn of it, and none left from before.
    await removeRecord(file);
    await removeMutationRecord(file);
    return noted;
  }
  if (!skill || ['sf-pause', 'sflow-pause'].includes(skill)) {
    await removeRecord(file);
    await removeMutationRecord(file);
    // A plain prompt where SFlow is used gets its one line naming the route [PCR:REQ-040].
    return !skill && noted?.additionalContext ? { additionalContext: noted.additionalContext } : {};
  }
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return {};
  const confirm = ['sf-confirm', 'sflow-confirm'].includes(skill) ? confirmedTurn(payload.prompt) : null;
  // /sf-task with no words takes the turn of what the Story needs next (task-turn.mjs) [ITW:REQ-008]: the approval, the
  // decision or the step's own work, each under its own skill's rules. The prompt is still kept as /sf-task.
  const turnSkill = ['sf-task', 'sflow-task'].includes(skill)
    ? await (await import('./task-turn.mjs')).taskTurnSkill(payload).catch(() => null) ?? skill : skill;
  const record = { schemaVersion: currentSchemaVersion(FAMILY), sessionId: sessionId(payload), skill: turnSkill, turnId: randomUUID(),
    ...(turnSkill !== skill ? { typedSkill: skill } : {}),
    recordedAt: now, modeChangedAt: mode.changedAt, ...(confirm ? { confirmDigest: confirm.digest } : {}),
    ...(confirm?.code ? { confirmCode: confirm.code } : {}),
    ...(sourceReviewCompletionRequested(payload.prompt) ? { reviewCompletionRequested: true } : {}),
    ...(workflowTaskCompletionRequested(payload.prompt) ? { taskCompletionRequested: true } : {}) };
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await removeRecord(temporary); }
  // What a person typed after a step's writer (/sf-code, /sf-phase or a configured author), redacted [SCS:REQ-040]: handed to the Story's own
  // local record once the turn's Story is known, never kept in this turn record. The turns are the alias table's.
  const typed = ASKED_FOR_SKILLS.includes(skill)
    ? await import('./asked-for.mjs').then((module) => module.typedInstruction(payload, skill)).catch(() => null) : null;
  const turn = typed ? { ...record, typed } : record;
  const captured = captureMutation ? await captureMutation(payload, turn)
    : await (await import('./copilot-mutation-guard.mjs')).captureMutationTurn(payload, turn);
  return captured ?? {};
}

/**
 * A reviewer the author's turn launched under the author's own session (review-subagent.mjs): where an event of that
 * session belongs, and the reviewer's turn ended once the author's side shows again. One lstat when none was launched;
 * mirrors frameFile() there.
 */
async function reviewerFrame(payload, event) {
  const id = sessionId(payload ?? {});
  if (!id || [payload.agentId, payload.agent_id].some((value) => value != null && value !== '')) return { payload };
  const boundaries = path.join(path.dirname(copilotModeFile()), 'copilot-boundaries');
  if (!await lstat(path.join(boundaries, `${createHash('sha256').update(id).digest('hex')}.subagent.json`)).then(() => true, () => false)) return { payload };
  const framed = await (await import('./review-subagent.mjs')).reviewerFramePayload(payload, boundaries, event).catch(() => ({ payload }));
  if (framed.ended) await endRepositoryBoundaryTurn({ sessionId: framed.ended }).catch(() => {});
  return framed;
}

/** A reviewer sub-agent started in an author's chat is checked under its own review turn (review-subagent.mjs). */
async function ownTurnPayload(payload, event = 'tool') {
  if (!payload) return payload;
  if ([payload.agentId, payload.agent_id].every((value) => value == null || value === '')) return (await reviewerFrame(payload, event)).payload;
  return (await import('./review-subagent.mjs')).reviewerSubagentPayload(payload, path.join(path.dirname(copilotModeFile()), 'copilot-boundaries'));
}

export async function endRepositoryBoundaryTurn(payload = {}) {
  await reviewerFrame(payload, 'stop');
  await settleObservedEdits(payload).catch(() => {});
  await attribute(payload, (recorder, directory) => recorder.sfGuardEndSession(payload, { directory }));
  await removeRecord(promptCopyPath(payload)).catch(() => {});
  await removeRecord(recordPath(payload));
  const file = recordPath(payload);
  await removeMutationRecord(file);
  await closeTurnMarker(payload);
  return {};
}

/**
 * File permissions and discovery share explicit-turn opt-in. Outside a turn (a plain prompt, or a paused
 * session) a person's own step is refused, because no prompt makes it an agent's, and so, unless SFlow is
 * paused, is a file that holds secrets, and in a repository that uses SFlow a change its capability sends
 * through an /sf- skill (policy.plainChatEdits [PCR:REQ-010]). A turn whose prompt held what looks like a
 * secret runs nothing [PCR:REQ-003].
 */
export async function repositoryToolGuard(payload = {}) {
  payload = await ownTurnPayload(payload, 'tool');
  const explicitTurn = await hasBoundaryTurn(payload);
  const decision = await secretInPrompt(payload) ?? (explicitTurn ? await turnToolGuard(payload) : await plainChatGuard(payload));
  if (explicitTurn && decision.permissionDecision === 'deny') await (await import('./copilot-review-completion.mjs'))
    .noteTaskCompletionFailure(payload, decision).catch(() => {});
  // The author's own turn starting its step's reviewer with the host's sub-agent tool (review-subagent.mjs).
  if (explicitTurn && decision.permissionDecision !== 'deny' && !payload.authorSessionId
      && /subagent|task/iu.test(JSON.stringify([payload.toolName ?? payload.tool_name ?? null, ...(payload.toolCalls ?? []).map((call) => call?.name ?? null)]))) {
    await (await import('./review-subagent.mjs')).noteReviewerLaunch(payload, path.join(path.dirname(copilotModeFile()), 'copilot-boundaries')).catch(() => {});
  }
  await attribute(payload, (recorder, directory) => recorder.sfGuardNoteToolCall(payload, decision, { directory, explicitTurn }));
  if (decision.permissionDecision !== 'deny') await noteAgentCalls(payload);
  return decision;
}

/**
 * Each SFlow `--for-agent` command an allowed call is about to run, noted, so its post-tool hook never takes a result
 * kept before it for this call's (unread-result.mjs) [owner, 2026-11-20]. A failure here never changes the answer.
 */
async function noteAgentCalls(payload) {
  try {
    const text = JSON.stringify(payload.toolCalls ?? payload.toolArgs ?? payload.tool_input ?? '');
    if (!/(?:singularity-flow|sflow)\b/u.test(text) || !text.includes('--for-agent') || readCopilotMode().paused) return;
    (await import('./unread-result.mjs')).noteAgentCalls(payload);
  } catch { /* Best effort. */ }
}

async function turnToolGuard(payload) {
  try {
    // Environment files hold secrets: no turn mode reads, searches or edits them (SPEC-ENVIRONMENT-FILES).
    const environmentFile = await (await import('./copilot-environment-files-guard.mjs')).environmentFilesToolGuard(payload);
    if (environmentFile) return environmentFile;
    const mutation = await (await import('./copilot-mutation-guard.mjs')).mutationToolGuard(payload);
    // Awaited here, so a failing discovery guard denies like any other guard failure instead of
    // escaping this catch to the hook's outer handler, which answers with no decision.
    return mutation.permissionDecision === 'deny' ? mutation : await repositoryDiscoveryGuard(payload);
  } catch { return boundaryGuardUnavailable(); }
}

export async function repositoryPostToolGuard(payload = {}) {
  const launched = await reviewerLaunchEnded(payload);
  payload = await ownTurnPayload(payload, 'after');
  await attribute(payload, (recorder, directory) => recorder.sfGuardNoteToolResult(payload, { directory }));
  const unread = await unreadResult(payload);
  if (!(await hasBoundaryTurn(payload))) return unread ? unread.withUnreadResult({}, unread.context) : {};
  let answer;
  try { answer = await (await import('./copilot-mutation-guard.mjs')).mutationPostToolGuard(payload); }
  catch { const refusal = boundaryGuardUnavailable(); answer = { ...refusal, continue: false, additionalContext: refusal.permissionDecisionReason }; }
  answer = withReviewerFallback(answer, launched);
  return unread ? unread.withUnreadResult(answer, unread.context) : answer;
}

/**
 * The author's launch of its step's reviewer that failed or was cancelled (review-subagent.mjs reviewDelegationAfter): the
 * review stays pending, and the author is told the supported way on, never to review it itself [OSA:REQ-052, AC-018].
 * Loaded only for a sub-agent tool's event; a failure here changes no answer.
 */
async function reviewerLaunchEnded(payload, options = {}) {
  if (!/subagent|task/iu.test(JSON.stringify([payload?.toolName ?? payload?.tool_name ?? null, ...(payload?.toolCalls ?? []).map((call) => call?.name ?? null)]))) return null;
  try { return (await import('./review-subagent.mjs')).reviewDelegationAfter(payload, options); } catch { return null; }
}

function withReviewerFallback(answer, launched) {
  if (!launched?.additionalContext) return answer;
  return { ...answer, additionalContext: [answer?.additionalContext, launched.additionalContext].filter(Boolean).join(' ') };
}

/**
 * An SFlow `--for-agent` result the host never showed, from what the CLI kept (unread-result.mjs). The module loads
 * only for a call that names one; a paused SFlow adds nothing, and a failure here never changes the hook's answer.
 */
async function unreadResult(payload) {
  try {
    const text = JSON.stringify(payload.toolCalls ?? payload.toolArgs ?? payload.tool_input ?? '');
    if (!/(?:singularity-flow|sflow)\b/u.test(text) || !text.includes('--for-agent') || readCopilotMode().paused) return null;
    const module = await import('./unread-result.mjs');
    const context = await module.unreadResultContext(payload);
    return context ? { context, withUnreadResult: module.withUnreadResult } : null;
  } catch { return null; }
}

export async function repositoryAgentStop(payload = {}) {
  const own = await ownTurnPayload(payload, 'stop');
  const answer = await (await import('./copilot-review-completion.mjs')).workflowTaskAgentStop(own);
  // A blocking answer continues the turn; any other ends it.
  if (answer?.decision !== 'block') await closeTurnMarker(payload, own);
  return answer;
}

export async function repositoryToolFailure(payload = {}) {
  const launched = await reviewerLaunchEnded(payload, { failure: true });
  payload = await ownTurnPayload(payload, 'after');
  const unread = await unreadResult(payload);
  // A file path one copy slip off a path SFlow returned: its correction, never a blocker [owner, 2026-11-20].
  const slip = await pathSlip(payload);
  const answer = slip ?? withReviewerFallback(await (await import('./copilot-review-completion.mjs')).noteTaskCompletionFailure(payload), launched);
  return unread ? unread.withUnreadResult(answer, unread.context) : answer;
}

/** The correction for a failed native file call whose path was a copy slip of one SFlow returned (path-slip.mjs), or null. */
async function pathSlip(payload) {
  try {
    const guard = await import('./copilot-mutation-guard.mjs');
    const calls = guard.nativeFileCalls(payload).filter((call) => call.paths.length);
    if (!calls.length) return null;
    const returned = await guard.turnReturnedPaths(payload);
    return returned?.length ? (await import('./path-slip.mjs')).pathSlipAnswer(calls, returned, { cwd: payload.cwd }) : null;
  } catch { return null; }
}

/**
 * A turn whose prompt held what looks like a secret runs nothing [PCR:REQ-003], whichever kind of turn it is:
 * the host sent that prompt on. One lstat when the session kept no prompt; a failure lets the call through.
 */
async function secretInPrompt(payload) {
  if (readCopilotMode().paused) return null;
  const copy = promptCopyPath(payload);
  if (!copy || !await lstat(copy).then(() => true, () => false)) return null;
  try { return await (await import('./copilot-plain-chat.mjs')).secretInPromptDenial(payload); }
  catch { return null; }
}

async function plainChatGuard(payload) {
  const step = await personStepGuard(payload);
  if (step.permissionDecision === 'deny' || readCopilotMode().paused) return step;
  // A plain chat is someone's ordinary work: these checks failing are no reason to stop it [PCR:REQ-017].
  try {
    const secrets = await (await import('./copilot-environment-files-guard.mjs')).plainChatEnvironmentFilesGuard(payload);
    if (secrets) return secrets;
  } catch { /* the change check still runs */ }
  // A change outside an /sf- skill, as the capability that owns its path says [PCR:REQ-010 to REQ-013].
  try { return await (await import('./copilot-plain-chat.mjs')).plainChatChangeGuard(payload) ?? step; }
  catch { return step; }
}

/** A tool call that names no SFlow command passes untouched; the guard loads only for one that does. */
async function personStepGuard(payload) {
  const text = JSON.stringify(payload.toolCalls ?? payload.toolArgs ?? payload.tool_input ?? '');
  if (!/singularity-flow|sflow/iu.test(text) && !mentionsHookCli(text)) return {};
  try { return (await import('./copilot-mutation-guard.mjs')).personStepDenial(payload) ?? {}; }
  catch {
    return { permissionDecision: 'deny', permissionDecisionReason: 'PHASE_MUTATION_GUARD_UNAVAILABLE: SFlow could not check whether this command is a person\'s own step, so it did not run. Preserve work; the person can run it in their own terminal, and singularity-flow doctor checks the installation.' };
  }
}

function boundaryGuardUnavailable() {
  return { permissionDecision: 'deny', permissionDecisionReason: `PHASE_MUTATION_GUARD_UNAVAILABLE: preserve work and refresh the exact boundary.\n${formatCommandRouteLines({ copilotCommand: '/sf-phase', command: 'singularity-flow phase enter --for-agent --json' }).join('\n')}` };
}

async function hasBoundaryTurn(payload) {
  if (readCopilotMode().paused) return false;
  const file = recordPath(payload);
  if (!file) return false;
  return Boolean(await lstat(file).catch(() => null)
    ?? await lstat(file.replace(/\.json$/u, '.mutation.json')).catch(() => null));
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
        || now < record.recordedAt) return null;
    // From its prompt, or from the person's last answer in it (copilot-mode.mjs TURN_WINDOW_MS).
    const renewed = await withTurnRenewal(record, file, now);
    return now - turnWindowStart(renewed) > MAX_AGE_MS ? null : renewed;
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
  const agent = payload.agentName ?? payload.agent_name;
  if (!(agent && BUNDLED_AGENTS.has((await import('./review-subagent.mjs')).ownAgentName(agent))) && !await currentTurn(payload)) return null;
  const selected = await resolveSelected(cwd);
  return selected?.selectionStatus === 'ready' && selected.repositoryPath ? selected.repositoryPath : null;
}

async function repoRootFor(cwd) { return (await import('./git.mjs')).repoRoot(cwd); }

async function selectedContext(cwd) {
  const context = await import('./workspace-context.mjs');
  // A retained session in this checkout is window-local selection, not another window's profile.
  // Validate its aggregate/ref before choosing it; a stale session on main remains only a hint.
  let root;
  try { root = await repoRootFor(cwd); } catch { /* Neutral host folder: use the profile below. */ }
  if (root) {
    const session = await (await import('./session.mjs')).loadSession(root, { required: false });
    if (session?.workId) {
      let accepted;
      try { accepted = await (await import('./accepted-story-execution.mjs')).loadAcceptedStoryExecution(root, session.workId); }
      catch (error) { if (error.code !== 'STORY_NOT_FOUND') throw error; }
      if (accepted && (await import('./story-paths.mjs')).workflowBranchAllowed(accepted.workflow,
        (await import('./git.mjs')).branch(root))) {
        const { withExecutionContextScope } = await import('./execution-context-scope.mjs');
        return withExecutionContextScope(root, () => context.resolveWorkspaceExecutionContext(
          context.activeWorkspaceFile(), context.workspaceRegistryFile(), { cwd: root }), { boundRoot: root });
      }
    }
  }
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
  // Copilot's directory keeps the spelling it was given (a Windows 8.3 short name), Git's root the stored one.
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    || platformPathWithin(target, root);
}

// One whole absolute path: no wildcard, expansion or quoting a shell could turn into many.
const EXACT_ABSOLUTE_PATH = /^\/[^\s*?[\]{}$~`'"()<>|;&!#]+$/u;
// The folders version managers install Node into: listing one finds a Node to run tests on, never a repository. On Story
// new-ash-graph the agent, refused `ls /opt/homebrew/opt/node@22/bin`, ran the tests on the wrong Node three times.
const NODE_INSTALL_FOLDER = /^\/(?:opt\/homebrew|usr\/local)\/(?:opt|Cellar)\/node(?:@\d{1,3})?(?:\/[^\s*?[\]{}$~`'"()<>|;&!#]*)?$/u;
const HOME_NODE_FOLDERS = ['.nvm/versions/node', '.volta/tools/image/node', '.fnm/node-versions', '.local/share/fnm/node-versions',
  '.asdf/installs/nodejs', '.local/share/mise/installs/node', '.nodenv/versions'];
function nodeInstallFolder(target) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const expanded = home ? target.replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/u, home) : target;
  if (/[*?[\]{}`'"()<>|;&!#]|\.\.(?:\/|$)/u.test(expanded) || !path.isAbsolute(expanded)) return false;
  if (NODE_INSTALL_FOLDER.test(expanded)) return true;
  return Boolean(home) && HOME_NODE_FOLDERS.some(folder => platformPathWithin(path.resolve(expanded), path.join(home, folder)));
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
  function scoped(target, at, named = false) {
    const prefix = command.slice(0, at);
    const directories = [...prefix.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?=&&|;)/gu)]
      .map(match => match[1].replace(/^['"]|['"]$/gu, ''));
    return { target, directories, named };
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
    targets.push(...(operands.length ? operands : ['.']).map(target => scoped(target, at, match[1] === 'ls')));
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
  for (const { target, directories = [], named = false } of targets) {
    const base = directories.reduce((current, directory) => path.resolve(current, directory), cwd);
    const normalized = target.replaceAll('\\', '/');
    if (named && nodeInstallFolder(normalized)) continue;
    if (/^(?:~|\$\{?HOME\}?|\/Users\/?$|\/home\/?$|\/\*|\/$)/u.test(normalized)
        || !root || !inside(path.resolve(root), path.resolve(base, target))) {
      // Exact temporary tool-output files remain readable; this is a directory-discovery guard.
      const stat = await lstat(path.resolve(base, target)).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink()) continue;
      // `ls -l /opt/homebrew/opt/node@22/bin/node` looks at one named path, which is no search (bin-opr2): an exact
      // absolute path that is not there, or a link to a file, shows nothing a search would. A directory still does.
      if (named && EXACT_ABSOLUTE_PATH.test(normalized) && (!stat || await fileStat(path.resolve(base, target)).then(entry => entry.isFile(), () => false))) continue;
      return { permissionDecision: 'deny', permissionDecisionReason:
        `This explicit SFlow turn must not discover a repository by searching home/parent directories. Run ${boundaryBootstrap(turn.skill)} from the current scratch folder; it resolves the selected workspace without filesystem search. Use its ready/workId/repositoryPath binding as cwd. If selection is unavailable, use /sf-session or /sf-workspaces; do not widen the search. Native Copilot and pause mode are unaffected.` };
    }
  }
  return {};
}

// Larger than any real tool call. A payload past it, or one that is not JSON, is not passed unchecked.
const HOOK_INPUT_LIMIT = 16 * 1024 * 1024;
const IDENTITY_HEAD = 64 * 1024;

/**
 * The session and folder of a payload too large or malformed to parse, read from its start (the
 * host writes them first), so an explicit SFlow turn is still answered for. Null when unreadable.
 */
function payloadIdentity(head) {
  const text = head.toString('utf8');
  const field = name => {
    const match = text.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,4096})"`, 'u'));
    try { return match ? JSON.parse(`"${match[1]}"`) : null; } catch { return null; }
  };
  const id = field('sessionId') ?? field('session_id');
  return id ? { sessionId: id, ...(field('cwd') ? { cwd: field('cwd') } : {}) } : null;
}

/**
 * During an explicit SFlow turn, a tool call the guard cannot read is refused rather than run
 * unchecked, and a shell call is still compared with the turn's baseline (its command unknown, so
 * with no baseline the turn stops). Outside such a turn nothing changes.
 */
async function unreadablePayload(event, identity) {
  if (!identity || !(await hasBoundaryTurn(identity))) return {};
  if (event === 'boundary-guard') return { permissionDecision: 'deny', permissionDecisionReason:
    'SFLOW_HOOK_PAYLOAD_UNREADABLE: this tool call is too large or malformed for the SFlow guard to check, so it was not run. Make smaller calls: one file per patch, or split the edit.' };
  if (event === 'boundary-after') return repositoryPostToolGuard({ ...identity, toolName: 'bash', toolArgs: { command: '' } });
  return {};
}

// The hook event each action answers, as VS Code names it.
const VSCODE_HOOK_EVENTS = Object.freeze({ 'boundary-guard': 'PreToolUse', 'boundary-after': 'PostToolUse', 'agent-start': 'SubagentStart', 'boundary-stop': 'Stop', 'boundary-failure': 'PostToolUseFailure' });
const VSCODE_HOOK_FIELDS = Object.freeze(['permissionDecision', 'permissionDecisionReason', 'additionalContext', 'decision', 'reason']);

/**
 * A hook's answer in a shape every host reads. Copilot CLI reads the top level. VS Code's own chat reads a
 * tool decision and added context only under `hookSpecificOutput` and ignores the rest without a word, so a
 * refusal left at the top level ran the tool anyway. Copilot CLI ignores the extra field.
 */
export function hookAnswerForEveryHost(action, answer) {
  const hookEventName = VSCODE_HOOK_EVENTS[action];
  if (!hookEventName || !answer || typeof answer !== 'object') return answer;
  const fields = VSCODE_HOOK_FIELDS.filter((field) => answer[field] !== undefined);
  if (!fields.length) return answer;
  return { ...answer, hookSpecificOutput: { hookEventName, ...Object.fromEntries(fields.map((field) => [field, answer[field]])) } };
}

/** Host hooks always answer JSON, even with malformed input; they must work outside Git. */
export async function runRepositoryBoundaryHook(event, input = process.stdin) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes <= HOOK_INPUT_LIMIT) chunks.push(buffer);
      bytes += buffer.length;
    }
    // Decoded once: a character split across two chunks decoded apart became U+FFFD, so a path in
    // a command or patch no longer matched. A leading byte-order mark is not JSON.
    const raw = Buffer.concat(chunks);
    let payload = null;
    if (bytes <= HOOK_INPUT_LIMIT) {
      try { payload = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, '') || '{}'); } catch { payload = null; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return console.log(codePageSafeJson(JSON.stringify(hookAnswerForEveryHost(event, await unreadablePayload(event, payloadIdentity(raw.subarray(0, IDENTITY_HEAD)))))));
    }
    // A prompt is a person at this laptop: automatic sharing and clean-up wait for an idle one (machine-activity.mjs).
    if (event === 'boundary-turn') noteActivity();
    // SFlow's hooks saw this chat, so a command it runs can tell a chat whose hooks never ran (copilot-chat-hooks.mjs).
    if (event === 'boundary-turn' || event === 'boundary-guard') noteHookSession(sessionId(payload));
    const handler = { 'boundary-turn': recordRepositoryBoundaryTurn,
      'boundary-guard': repositoryToolGuard, 'boundary-end': endRepositoryBoundaryTurn,
      'boundary-after': repositoryPostToolGuard, 'boundary-stop': repositoryAgentStop,
      'boundary-failure': repositoryToolFailure }[event];
    // A Windows hook launcher passes this through PowerShell, which decodes it in the console's code page.
    return console.log(codePageSafeJson(JSON.stringify(hookAnswerForEveryHost(event, await handler(payload)))));
  } catch { return console.log('{}'); }
}
