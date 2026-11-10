/** Explicit-turn discovery and mutation interception; not a filesystem sandbox. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, stat as fileStat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { codePageSafeJson } from './code-page-safe-json.mjs';
import { copilotModeFile, hookCliLine, mentionsHookCli, readCopilotMode } from './copilot-mode.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { platformPathWithin } from './util.mjs';
import { AUTHORING_SKILL_DECLARATION } from './authoring-skills.mjs';

const FAMILY = 'copilot-repository-boundary';
/**
 * Left in the boundary directory by plugin/hook-launcher.mjs when it cannot load the runtime. The
 * shell launcher answers guards without Node only while that directory is empty, so a runtime
 * that could not record a turn keeps failing closed until a working one handles the next prompt.
 */
export const RUNTIME_UNAVAILABLE_MARKER = 'runtime-unavailable';
const MAX_AGE_MS = 30 * 60 * 1000;
const SEARCH_TOOLS = new Set(['grep', 'rg', 'glob', 'search_code_subagent']);
const BUNDLED_AGENTS = new Set(['sflow-workflow', 'sflow-utility', 'sflow-source-reviewer']);
// The turns whose typed words are kept as what the person asked for (asked-for.mjs ASKED_FOR_SKILLS).
const ASKED_FOR_SKILLS = new Set(['sf-code', 'sflow-code', 'sf-phase', 'sflow-phase']);
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

/** Only the complete review invocation opts into completion; explicit stage/check/status are single steps. */
export function sourceReviewCompletionRequested(prompt) {
  if (!['sf-review-source', 'sflow-review-source'].includes(explicitSflowSkill(prompt))) return false;
  const args = prompt.trim().startsWith('/') ? prompt.trim().replace(/^\/\S+\s*/u, '')
    : prompt.match(/\bARGUMENTS:\s*([^]*?)\s*<\/skill-context>/u)?.[1];
  return typeof args === 'string' && !/^(?:context|stage|check|submit|status|decide|decision-context)(?:\s|$)/u.test(args);
}

/** Opt in full authoring tasks by capability, never by a workflow's phase names. */
export function workflowTaskCompletionRequested(prompt) {
  const skill = explicitSflowSkill(prompt)?.replace(/^sf-/u, 'sflow-');
  if (!skill || !(AUTHORING_SKILL_DECLARATION[skill]
      || ['sflow-call', 'sflow-implement', 'sflow-specify', 'sflow-plan', 'sflow-verify', 'sflow-scenario-repair'].includes(skill))) return false;
  const args = prompt.trim().startsWith('/') ? prompt.trim().replace(/^\/\S+\s*/u, '')
    : prompt.match(/\bARGUMENTS:\s*([^]*?)\s*<\/skill-context>/u)?.[1];
  return typeof args === 'string' && !/^(?:context|stage|check|status|show|preview|prepare|publish)(?:\s|$)/u.test(args);
}

/**
 * The one reviewed digest a /sf-confirm prompt carries, or null when it carries none or several.
 * Only this value is kept, never the prompt: it binds the turn to the command the person confirmed.
 */
export function confirmedDigest(prompt) {
  if (typeof prompt !== 'string' || prompt.length > 256 * 1024) return null;
  const found = new Set([...prompt.matchAll(/--confirm(?:-plan)?[\s=]+(sha256:[a-f0-9]{64}|[a-z]{2,12}-[a-f0-9]{16,64}|[a-f0-9]{64})(?![\w:-])/gu)]
    .map(match => match[1]));
  return found.size === 1 ? [...found][0] : null;
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

async function removeMutationRecord(file) {
  if (!file) return;
  const mutation = file.replace(/\.json$/u, '.mutation.json');
  await removeRecord(mutation);
  await removeRecord(file.replace(/\.json$/u, '.answers.json'));
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
  const answer = await recordTurn(payload, options);
  const line = hookCliLine();
  return line && explicitSflowSkill(payload.prompt) && answer.decision !== 'block'
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

async function recordTurn(payload, { now = Date.now(), captureMutation = null }) {
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
  await attribute(payload, (recorder, directory) => recorder.sfGuardNotePrompt(payload, { directory, paused: mode.paused,
    explicitSkill: explicitSflowSkill(payload.prompt), now }), { always: true });
  const skill = mode.paused ? null : explicitSflowSkill(payload.prompt);
  const noted = await notePlainChatPrompt(payload, { skill, paused: mode.paused, now });
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
  const confirm = ['sf-confirm', 'sflow-confirm'].includes(skill) ? confirmedDigest(payload.prompt) : null;
  const record = { schemaVersion: currentSchemaVersion(FAMILY), sessionId: sessionId(payload), skill, turnId: randomUUID(),
    recordedAt: now, modeChangedAt: mode.changedAt, ...(confirm ? { confirmDigest: confirm } : {}),
    ...(sourceReviewCompletionRequested(payload.prompt) ? { reviewCompletionRequested: true } : {}),
    ...(workflowTaskCompletionRequested(payload.prompt) ? { taskCompletionRequested: true } : {}) };
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await removeRecord(temporary); }
  // What a person typed after /sf-code or /sf-phase, redacted [SCS:REQ-040]: handed to the Story's own
  // local record once the turn's Story is known, never kept in this turn record.
  const typed = ASKED_FOR_SKILLS.has(skill)
    ? await import('./asked-for.mjs').then((module) => module.typedInstruction(payload, skill)).catch(() => null) : null;
  const turn = typed ? { ...record, typed } : record;
  const captured = captureMutation ? await captureMutation(payload, turn)
    : await (await import('./copilot-mutation-guard.mjs')).captureMutationTurn(payload, turn);
  return captured ?? {};
}

export async function endRepositoryBoundaryTurn(payload = {}) {
  await settleObservedEdits(payload).catch(() => {});
  await attribute(payload, (recorder, directory) => recorder.sfGuardEndSession(payload, { directory }));
  await removeRecord(promptCopyPath(payload)).catch(() => {});
  await removeRecord(recordPath(payload));
  const file = recordPath(payload);
  await removeMutationRecord(file);
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
  const explicitTurn = await hasBoundaryTurn(payload);
  const decision = await secretInPrompt(payload) ?? (explicitTurn ? await turnToolGuard(payload) : await plainChatGuard(payload));
  if (explicitTurn && decision.permissionDecision === 'deny') await (await import('./copilot-review-completion.mjs'))
    .noteTaskCompletionFailure(payload, decision).catch(() => {});
  await attribute(payload, (recorder, directory) => recorder.sfGuardNoteToolCall(payload, decision, { directory, explicitTurn }));
  return decision;
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
  await attribute(payload, (recorder, directory) => recorder.sfGuardNoteToolResult(payload, { directory }));
  if (!(await hasBoundaryTurn(payload))) return {};
  try { return await (await import('./copilot-mutation-guard.mjs')).mutationPostToolGuard(payload); }
  catch { const refusal = boundaryGuardUnavailable(); return { ...refusal, continue: false, additionalContext: refusal.permissionDecisionReason }; }
}

export async function repositoryAgentStop(payload = {}) {
  return (await import('./copilot-review-completion.mjs')).workflowTaskAgentStop(payload);
}

export async function repositoryToolFailure(payload = {}) {
  return (await import('./copilot-review-completion.mjs')).noteTaskCompletionFailure(payload);
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
    const handler = { 'boundary-turn': recordRepositoryBoundaryTurn,
      'boundary-guard': repositoryToolGuard, 'boundary-end': endRepositoryBoundaryTurn,
      'boundary-after': repositoryPostToolGuard, 'boundary-stop': repositoryAgentStop,
      'boundary-failure': repositoryToolFailure }[event];
    // A Windows hook launcher passes this through PowerShell, which decodes it in the console's code page.
    return console.log(codePageSafeJson(JSON.stringify(hookAnswerForEveryHost(event, await handler(payload)))));
  } catch { return console.log('{}'); }
}
