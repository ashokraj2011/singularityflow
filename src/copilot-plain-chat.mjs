/**
 * Plain-chat routing in a repository that uses SFlow (docs/SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md, P1 and P2).
 *
 *   notePrompt              the prompt hook's part: every prompt kept, redacted [PCR:REQ-002]; one that holds what
 *                           looks like a secret is blocked where the host reads the answer, Copilot CLI [PCR:REQ-003]
 *   secretInPromptDenial    every tool call of a turn whose prompt held one is refused, for the host that sent it on
 *   plainChatChangeGuard    a plain chat's change is refused with the line to type, recorded, or let through, as the
 *                           capability that owns the path says (`policy.plainChatEdits`) [PCR:REQ-010 to REQ-013]
 *
 * Decided from files alone [PCR:REQ-014]: the repository's marker, the session's copy of its prompt, and the
 * checkout's session record and Story file. No network, no Git process, no full Story load; the approved capability
 * map is read only for a change, and only where it could say something other than the default. A failure of this
 * check lets the call through [PCR:REQ-017]. People decide: nothing here answers, approves or runs a skill for anyone.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { environmentFileProtection, repositoryOf, usesSflow } from './copilot-environment-files-guard.mjs';
import { notePromptLog, promptSecret, readSessionCopy, sessionKey, writeSessionCopy } from './plain-chat-prompts.mjs';

// capabilities.mjs PLAIN_CHAT_EDITS_DEFAULT (decision 8), here so a guard that reads no map loads no capability code.
const DEFAULT_EDITS = 'record';
const STORY_FILE_BYTES = 16 * 1024 * 1024;
const SMALL_FILE_BYTES = 256 * 1024;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// The person's words on a refusal's line: one line, and short enough to read.
const LINE_WORDS = 300;
// Every tool name copilot-mutation-guard.mjs plainChatChanges can judge a change: its edit words, its terminals, sflow_run.
const MAY_CHANGE = /patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename|bash|powershell|terminal|execute|exec_command|stdin|sflow_run/iu;

function small(file, limit = SMALL_FILE_BYTES) {
  try {
    const info = lstatSync(file);
    return info.isFile() && info.size <= limit ? readFileSync(file, 'utf8') : null;
  } catch { return null; }
}

const canonical = (value) => { try { return realpathSync.native(value); } catch { return path.resolve(value); } };

/** The repository that uses SFlow holding `target` (a folder, or a file that may not exist yet), or null. */
export function sflowRepositoryAt(target) {
  if (typeof target !== 'string' || !target) return null;
  let directory = path.resolve(target);
  // A file the call would create is judged by the folder it lands in.
  for (let depth = 0; depth < 64; depth += 1) {
    try { if (lstatSync(directory).isDirectory()) break; } catch { /* not there yet */ }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  const repository = repositoryOf(directory);
  return repository && usesSflow(repository) ? repository : null;
}

function storyBranches(state) {
  return [state?.workItem?.branch, state?.lineage?.canonicalBranch, ...(state?.lineage?.childBranches ?? []).map((entry) => entry?.name)].filter(Boolean);
}

/**
 * The Story this checkout holds, from its own files: the session record's Work ID, else the branch's name, and
 * that Story's workflow.json naming this branch. Null outside one, or for a Story that is not in progress.
 */
export async function checkoutStory(repository) {
  const head = small(path.join(repository.gitDir, 'HEAD'))?.trim() ?? '';
  const branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  if (!branch) return null;
  let session = null;
  try { session = JSON.parse(small(path.join(repository.gitDir, 'singularity-flow', 'session.json')) ?? 'null'); } catch { /* no session */ }
  const definition = small(path.join(repository.root, 'singularity', 'workflow.yml'), STORY_FILE_BYTES);
  const workItemRoot = definition && /^workItemRoot\s*:/mu.test(definition)
    ? (await import('./work-item-location.mjs')).workItemRootFromDefinitionText(definition) : 'singularity/work-items';
  const { readRecord } = await import('./schema-migrations.mjs');
  for (const id of [...new Set([session?.workId, branch])]) {
    if (typeof id !== 'string' || !WORK_ID.test(id)) continue;
    const text = small(path.join(repository.root, ...workItemRoot.split('/'), id, 'workflow.json'), STORY_FILE_BYTES);
    if (!text) continue;
    let state;
    try { state = readRecord('story-workflow', Buffer.from(text)).record; } catch { continue; }
    if (state?.workItem?.id !== id || !storyBranches(state).includes(branch) || state.status !== 'in_progress') continue;
    const phase = state.phases?.[state.currentPhase];
    if (!phase) return null;
    const [{ askedForGeneration, typedFocusOff }, { phaseRequiresCodeDelivery }] = await Promise.all([
      import('./asked-for.mjs'), import('./code-delivery-policy.mjs')]);
    let code = false;
    try { code = phaseRequiresCodeDelivery(phase); } catch { /* an unreadable step is no code step */ }
    return { workId: id, phase: phase.id, label: phase.label ?? phase.id, code, generation: askedForGeneration(phase),
      typedFocusOff: typedFocusOff(state), gitDir: repository.gitDir };
  }
  return null;
}

const ENVIRONMENT_FILE_BYTES = 64 * 1024;
// A setting's value as an environment file writes it: `KEY=value`, `export KEY="value"`, `key: value`.
const SETTING = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*(.*?)\s*$/u;

/**
 * The values the repository's declared environment files hold that are long and random enough to be secrets
 * [PCR:REQ-003]: the files this machine registered and the declaration's plain localFiles paths, read here only
 * to be compared with a prompt. None is ever written, printed or kept.
 */
async function environmentFileValues(repository) {
  const protection = await environmentFileProtection(repository.root).catch(() => null);
  if (!protection) return [];
  const files = new Set(Object.values(protection.environmentFiles ?? {}).flat().filter((file) => typeof file === 'string'));
  for (const policy of protection.policies ?? []) {
    for (const environment of Object.values(policy?.environments ?? {})) {
      for (const file of environment?.localFiles ?? []) if (typeof file === 'string' && !/[*?[{]/u.test(file)) files.add(file);
    }
  }
  const { entropy } = await import('./secrets.mjs');
  const values = new Set();
  for (const file of [...files].slice(0, 32)) {
    let text;
    try {
      const absolute = path.resolve(repository.root, file);
      if (!statSync(absolute).isFile() || statSync(absolute).size > ENVIRONMENT_FILE_BYTES) continue;
      text = readFileSync(absolute, 'utf8');
    } catch { continue; }
    for (const line of text.split(/\r?\n/u)) {
      if (/^\s*[#;]/u.test(line)) continue;
      const value = line.match(SETTING)?.[1]?.replace(/^(['"])(.*)\1$/u, '$2');
      if (value && value.length >= 8 && !/\s/u.test(value) && !/^\$\{?[A-Z_]/u.test(value) && entropy(value) >= 3) values.add(value);
    }
  }
  return [...values];
}

/** What a skill turn keeps of its prompt: the skill and the words typed after it, never its expanded text. */
async function promptWords(prompt, skill) {
  const { redactedWords, typedArguments } = await import('./asked-for.mjs');
  if (!skill) return redactedWords(prompt.slice(0, 256 * 1024));
  const typed = typedArguments(prompt);
  return redactedWords(`/${skill}${typed ? ` ${typed}` : ''}`);
}

function blockReason(kind) {
  return `SECRET_IN_PROMPT: this prompt held what looks like a ${kind} and was not sent. Remove it and send it again. `
    + 'SFlow kept only the redacted form; Copilot CLI\'s own session log still holds what was typed. If it is no secret, /sf-pause turns this check off.';
}

/**
 * The prompt hook's part, for every prompt [PCR:REQ-002]: the session's copy is replaced, and in a repository that
 * uses SFlow the prompt is kept in the clone's log, and a plain one in the Story's "Asked for" too, marked plain
 * chat. A subagent's task is no person's prompt and is not kept. Returns the block a secret earns, or null.
 */
export async function notePrompt(payload, { skill = null, now = Date.now() } = {}) {
  const { subagentPayload, typedArguments } = await import('./asked-for.mjs');
  // A subagent's task shares its session: the person's own copy, and any secret it marks, stay.
  if (subagentPayload(payload)) return null;
  await writeSessionCopy(payload, null);
  if (typeof payload.prompt !== 'string') return null;
  const repository = sflowRepositoryAt(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  if (!repository) return null;
  // A skill's turn is judged by what the person typed after it, never by the skill text a host expanded.
  const values = await environmentFileValues(repository);
  const secret = await promptSecret(skill ? typedArguments(payload.prompt) ?? '' : payload.prompt, { values });
  // An environment file's value is taken out before the words are redacted and cut, so no part of it is kept.
  const words = await promptWords(values.reduce((text, value) => text.split(value).join('[REDACTED]'), payload.prompt), skill);
  const story = await checkoutStory(repository).catch(() => null);
  const turnId = randomUUID();
  const at = new Date(now).toISOString();
  await writeSessionCopy(payload, { turnId, at, plain: !skill, skill, ...(words ?? { text: '' }), secret, root: repository.root, story, changed: false });
  await notePromptLog(repository.common, { session: sessionKey(payload)?.slice(0, 16) ?? null, turn: turnId,
    kind: skill ? 'skill' : 'plain', skill, text: words?.text ?? '', ...(words?.truncated ? { truncated: true } : {}),
    repository: repository.root, workId: story?.workId ?? null, phase: story?.phase ?? null, ...(secret ? { secret } : {}) }, { at: now }).catch(() => {});
  if (!skill && story && !story.typedFocusOff && words?.text && !secret) {
    await (await import('./asked-for.mjs')).noteAskedFor(story.gitDir, { workId: story.workId, phase: story.phase, generation: story.generation,
      text: words.text, truncated: words.truncated === true, skill: null, turnId, at, plainChat: true }).catch(() => {});
  }
  return secret ? { decision: 'block', reason: blockReason(secret) } : null;
}

/**
 * A turn whose prompt held what looks like a secret runs nothing [PCR:REQ-003]. Copilot CLI blocked that prompt
 * before any model call; VS Code sent it on, so its turn's tool calls are refused until the next prompt.
 */
export async function secretInPromptDenial(payload) {
  const copy = await readSessionCopy(payload);
  if (!copy?.secret) return null;
  return { permissionDecision: 'deny', next: [], permissionDecisionReason:
    `SECRET_IN_PROMPT: the prompt held what looks like a ${copy.secret}; it reached the model, so rotate it. Nothing in this turn runs. `
    + 'SFlow kept only the redacted form. Send the prompt again without it. Do not retry it' };
}

/**
 * The capability's answer for a path, from the approved map on this machine, with no network [PCR:REQ-013]. Only a
 * map that names the setting, or an approved `sflow/config` map, can say anything but the default, so the rest
 * read no map. Anything unreadable keeps the default.
 */
export async function plainChatEditsPolicy(root, subjectPath) {
  try {
    const map = small(path.join(root, 'singularity', 'capabilities.yml'), STORY_FILE_BYTES) ?? '';
    const repository = repositoryOf(root);
    const approved = repository && [['refs', 'heads', 'sflow', 'config'], ['refs', 'remotes', 'origin', 'sflow', 'config']]
      .some((parts) => { try { return lstatSync(path.join(repository.common, ...parts)).isFile(); } catch { return false; } })
      || /\srefs\/(?:heads|remotes\/[^/\s]+)\/sflow\/config\s/u.test(`${small(path.join(repository?.common ?? root, 'packed-refs'), STORY_FILE_BYTES) ?? ''}\n`);
    if (!approved && !map.includes('plainChatEdits')) return DEFAULT_EDITS;
    const [{ withApprovedConfigurationRead }, { resolveLifecycleCapability }] = await Promise.all([
      import('./approved-configuration-reader.mjs'), import('./capability-context.mjs')]);
    const capability = await withApprovedConfigurationRead(root, () => resolveLifecycleCapability(root, { subjectPath, offline: true }),
      { preferAuthority: true, refreshAuthority: false });
    return capability?.policy?.plainChatEdits ?? DEFAULT_EDITS;
  } catch { return DEFAULT_EDITS; }
}

const sameRoot = (left, right) => Boolean(left && right) && (path.resolve(left) === path.resolve(right) || canonical(left) === canonical(right));

/** The `/sf-` line the person types for this change [PCR:REQ-011], with their own words from the session's copy. */
function lineToType(story, words, root) {
  const asked = words ? ` ${words}` : ' <what to change>';
  if (story?.code) return `/sf-code ${story.workId}${asked}`;
  if (story) return `/sf-phase ${story.workId}${asked}`;
  const quickFix = /^\s{2}quick-fix\s*:/mu.test(small(path.join(root, 'singularity', 'workflow.yml'), STORY_FILE_BYTES) ?? '');
  return `/sf-start <NEW-ID>${asked}${quickFix ? ' (its quick-fix workflow suits a small change)' : ''}`;
}

function changeRefusal(change, line, relative) {
  const what = change.kind === 'command' ? 'this command' : change.kind === 'run' ? 'this SFlow plan' : `this edit${relative ? ` to ${relative}` : ''}`;
  return { permissionDecision: 'deny', next: [], permissionDecisionReason:
    `PLAIN_CHAT_CHANGE_REFUSED: in this repository a change goes through an /sf- skill (policy.plainChatEdits: refuse), and this chat named none, so ${what} did not run. `
    + `Reading, searching, read-only git and questions stay free. To make the change, the person types: ${line}. Do not retry it` };
}

/**
 * A plain chat's change in a repository that uses SFlow [PCR:REQ-010 to REQ-013]. Each change is judged by the
 * capability that owns its path (a command, by the repository's own): `refuse` refuses it with the line to type,
 * `record` lets it through and marks the turn's "Asked for" entry as one that changed the work, so a code step's
 * approval waits for it [SCS:REQ-042], and `allow` lets it through. Null lets the call through.
 */
export async function plainChatChangeGuard(payload, { policyFor = plainChatEditsPolicy } = {}) {
  // A batch of reads, searches and questions loads no classifier: only these names can be a change.
  const names = (payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name }]).map((call) => String(call?.name ?? call?.toolName ?? call?.tool_name ?? ''));
  if (!names.some((name) => MAY_CHANGE.test(name))) return null;
  const rootOf = (cwd) => { const repository = typeof cwd === 'string' ? repositoryOf(cwd) : null; return repository ? canonical(repository.root) : null; };
  const changes = (await import('./copilot-mutation-guard.mjs')).plainChatChanges(payload, { rootOf });
  if (!changes.length) return null;
  const recorded = [];
  for (const change of changes) {
    const base = typeof change.cwd === 'string' ? change.cwd : process.cwd();
    const places = change.targets.length ? change.targets.slice(0, 16).map((target) => path.resolve(base, target)) : [base];
    for (const place of places) {
      const repository = sflowRepositoryAt(place);
      if (!repository) continue;
      const relative = change.targets.length ? path.relative(repository.root, place).split(path.sep).join('/') : '';
      const policy = await policyFor(repository.root, relative);
      if (policy === 'allow') continue;
      if (policy !== 'refuse') { recorded.push(repository); continue; }
      const copy = await readSessionCopy(payload);
      const own = copy?.plain && sameRoot(copy.root, repository.root) ? copy : null;
      const story = own ? own.story : await checkoutStory(repository).catch(() => null);
      const words = copy?.plain && !copy.secret ? String(copy.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, LINE_WORDS) : '';
      return changeRefusal(change, lineToType(story, words, repository.root), relative);
    }
  }
  if (recorded.length) await noteRecordedChange(payload, recorded).catch(() => {});
  return null;
}

/** Under `record`, the turn's prompt in a Story's code step now waits to be accounted for [PCR:REQ-012]. Once a turn. */
async function noteRecordedChange(payload, repositories) {
  const copy = await readSessionCopy(payload);
  if (!copy?.plain || copy.changed || !copy.story?.code || !repositories.some((repository) => sameRoot(repository.root, copy.root))) return;
  const { markAskedForChanged } = await import('./asked-for.mjs');
  await markAskedForChanged(copy.story.gitDir, { workId: copy.story.workId, phase: copy.story.phase, generation: copy.story.generation }, copy.turnId);
  await writeSessionCopy(payload, { ...copy, changed: true });
}
