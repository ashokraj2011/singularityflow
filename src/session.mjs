import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './util.mjs';
import { SingularityFlowError, nowIso, run } from './util.mjs';
import { normalizeSessionPolicy } from './config.mjs';

function localGitDir(root) {
  const resolved = run('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, allowFailure: true });
  return resolved.status === 0 ? path.resolve(resolved.stdout.trim()) : path.join(root, '.git');
}

function sessionPath(root) {
  return path.join(localGitDir(root), 'singularity-flow/session.json');
}

function copilotSessionPath(root) {
  return path.join(localGitDir(root), 'singularity-flow/copilot-session.json');
}

function copilotTurnIntentPath(root, sessionId) {
  const key = encodeURIComponent(sessionId || 'unknown');
  return path.join(localGitDir(root), `singularity-flow/copilot-turn-${key}.json`);
}

async function writeLocalJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

/**
 * @param {string|null} nonInteractiveHint Names the escape a caller offers, so a surface that cannot
 *   reach a terminal is told how to answer instead of only being told that it failed to.
 */
async function choose(label, entries, { selection = null, nonInteractiveHint = null } = {}) {
  if (selection != null) {
    if (!entries.some(([id]) => id === selection)) throw new SingularityFlowError(`Unknown ${label} '${selection}'.`);
    return selection;
  }
  if (label === 'persona' && process.env.SINGULARITY_FLOW_GITHUB_PERSONA) {
    const selected = process.env.SINGULARITY_FLOW_GITHUB_PERSONA;
    if (!entries.some(([id]) => id === selected)) throw new SingularityFlowError(`Unknown GitHub-selected working lens '${selected}'.`);
    return selected;
  }
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_SELECTION) {
      const selection = JSON.parse(process.env.SINGULARITY_FLOW_TEST_SELECTION);
      const selected = selection[label === 'workflow template' ? 'workType' : label === 'intake source' ? 'source' : 'persona']
        ?? (label === 'intake source' ? 'manual' : undefined);
      if (entries.some(([id]) => id === selected)) return selected;
    }
    throw new SingularityFlowError(
      `Selecting a ${label} requires an interactive terminal.${nonInteractiveHint ? ` ${nonInteractiveHint}` : ''}`
    );
  }
  const io = readline.createInterface({ input, output });
  try {
    console.log(`\nChoose ${label}:`);
    entries.forEach(([id, item], index) => console.log(`  ${index + 1}. ${item.label} (${id})${item.description ? ` — ${item.description}` : ''}`));
    const answer = (await io.question(`Enter 1-${entries.length}: `)).trim();
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || !entries[index]) throw new SingularityFlowError(`Invalid ${label} selection.`);
    return entries[index][0];
  } finally { io.close(); }
}

export async function selectWorkType(definition, options = {}) {
  return choose('workflow template', Object.entries(definition.workTypes), options);
}

export async function selectIntakeSource(options = {}) {
  return choose('intake source', [
    ['jira', { label: 'Jira story', description: 'Retrieve the work item and configured fields from Jira.' }],
    ['manual', { label: 'Manual description and documents', description: 'Enter the request and attach local files or URLs.' }]
  ], options);
}

export async function selectPersona(root, definition, actor, workId = null, { allowedPersonas = null, selection = null, nonInteractiveHint = null } = {}) {
  const allowed = allowedPersonas ? new Set(allowedPersonas) : null;
  const entries = Object.entries(definition.personas).filter(([id]) => !allowed || allowed.has(id));
  if (!entries.length) throw new SingularityFlowError('No configured working lens is available for this action.');
  const persona = await choose('working lens', entries, { selection, nonInteractiveHint });
  return setPersonaSession(root, definition, actor, persona, workId);
}

export async function setPersonaSession(root, definition, actor, persona, workId = null) {
  if (!definition.personas?.[persona]) throw new SingularityFlowError(`Unknown working lens '${persona}'.`);
  const existing = await loadSession(root, { required: false });
  const copilot = await loadCopilotSession(root);
  const binding = copilot?.workId === workId && copilot?.sessionId
    ? { copilotSessionId: copilot.sessionId, copilotSource: copilot.source, copilotBoundAt: nowIso() }
    : existing?.workId === workId && existing?.copilotSessionId
      ? { copilotSessionId: existing.copilotSessionId, copilotSource: existing.copilotSource, copilotBoundAt: existing.copilotBoundAt }
      : {};
  const record = { ...(existing?.agent ? { agent: existing.agent, agentSource: existing.agentSource, agentSelectedAt: existing.agentSelectedAt } : {}), persona, actor, workId, selectedAt: nowIso(), ...binding };
  await writeLocalJson(sessionPath(root), record);
  if (copilot?.workId === workId) await writeLocalJson(copilotSessionPath(root), { ...copilot, selectionRequired: false, selectedPersona: persona, selectedAt: record.selectedAt });
  return record;
}

export async function setAgentSession(root, agent, actor = null) {
  const existing = await loadSession(root, { required: false });
  const record = { ...(existing ?? {}), agent: agent.id, agentSource: agent.source, agentSelectedAt: nowIso() };
  if (actor && !record.actor) record.actor = actor;
  await mkdir(path.dirname(sessionPath(root)), { recursive: true });
  await writeFile(sessionPath(root), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function loadSession(root, { required = true } = {}) {
  const file = sessionPath(root);
  if (!(await exists(file))) {
    if (required) throw new SingularityFlowError('No active working-lens session. Run singularity-flow resume <WORK-ID> and choose a working lens.');
    return null;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadCopilotSession(root) {
  const file = copilotSessionPath(root);
  return await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

export async function recordCopilotSession(root, record) {
  return writeLocalJson(copilotSessionPath(root), { schemaVersion: 1, ...record });
}

export function sessionOnlyPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const match = prompt.trim().match(/^\/(?:(?:singularity-flow)\/)?sflow-session(?:\s+([A-Za-z0-9._-]+))?$/);
  return match ? { intent: 'session-only', workId: match[1] ?? null } : null;
}

export async function recordCopilotTurnIntent(root, payload = {}) {
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : null;
  const selected = sessionOnlyPrompt(payload.prompt);
  return writeLocalJson(copilotTurnIntentPath(root, sessionId), {
    schemaVersion: 1,
    sessionId,
    intent: selected?.intent ?? null,
    workId: selected?.workId ?? null,
    recordedAt: nowIso()
  });
}

export async function loadCopilotTurnIntent(root, sessionId = null) {
  const file = copilotTurnIntentPath(root, sessionId);
  if (!(await exists(file))) return null;
  try {
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (sessionId && record.sessionId && record.sessionId !== sessionId) return null;
    return record;
  } catch {
    return null;
  }
}

export async function clearCopilotTurnIntent(root, sessionId = null) {
  try { await unlink(copilotTurnIntentPath(root, sessionId)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function validPersonaSession(definition, session, workId, copilotSessionId = null) {
  if (!session || session.workId !== workId || !definition.personas?.[session.persona]) return false;
  return !copilotSessionId || session.copilotSessionId === copilotSessionId;
}

export async function bindPersonaToCopilotSession(root, definition, workId, copilot) {
  const session = await loadSession(root, { required: false });
  if (!validPersonaSession(definition, session, workId)) return null;
  const record = { ...session, copilotSessionId: copilot.sessionId, copilotSource: copilot.source, copilotBoundAt: nowIso() };
  await writeLocalJson(sessionPath(root), record);
  return record;
}

export async function activateWorkItemSession(root, definition, workflow) {
  const copilot = await loadCopilotSession(root);
  const policy = normalizeSessionPolicy(workflow.resolution?.session ?? definition.session ?? {});
  const existing = await loadSession(root, { required: false });
  const valid = validPersonaSession(definition, existing, workflow.workItem.id);
  const selectionRequired = policy.personaSelection !== 'off'
    && (!valid || (policy.personaSelection === 'prompt' && policy.promptOnNewSession === true));
  const record = await recordCopilotSession(root, {
    ...(copilot ?? {}),
    sessionId: copilot?.sessionId ?? null,
    source: copilot?.source ?? 'startup',
    repositoryRoot: root,
    workId: workflow.workItem.id,
    candidateWorkId: workflow.workItem.id,
    phase: workflow.currentPhase,
    policy,
    workItemSelectionRequired: false,
    selectionRequired,
    selectedPersona: selectionRequired ? null : valid ? existing.persona : null,
    workItemSelectedAt: nowIso()
  });
  if (!selectionRequired && valid && record.sessionId) await bindPersonaToCopilotSession(root, definition, workflow.workItem.id, record);
  return record;
}

export async function personaSessionStatus(root, definition, workflow) {
  const [session, copilot] = await Promise.all([loadSession(root, { required: false }), loadCopilotSession(root)]);
  const policy = normalizeSessionPolicy(copilot?.policy ?? workflow?.resolution?.session ?? definition.session ?? {});
  const workItemSelectionRequired = copilot
    ? copilot.workItemSelectionRequired === true
    : policy.workItemSelection === 'prompt' || (policy.workItemSelection === 'reuse' && !workflow);
  const workId = workItemSelectionRequired ? null : workflow?.workItem?.id ?? copilot?.workId ?? null;
  const baseValid = workId ? validPersonaSession(definition, session, workId) : false;
  const bound = baseValid && (!copilot?.sessionId || session.copilotSessionId === copilot.sessionId);
  return {
    workId,
    candidateWorkId: copilot?.candidateWorkId ?? workflow?.workItem?.id ?? null,
    copilotSessionId: copilot?.sessionId ?? null,
    source: copilot?.source ?? null,
    policy,
    activePersona: baseValid ? session.persona : null,
    bound,
    workItemSelectionRequired,
    selectionRequired: !workItemSelectionRequired && copilot?.selectionRequired === true && !bound,
    ready: !workItemSelectionRequired && !(copilot?.selectionRequired === true && !bound),
    choices: Object.entries(definition.personas ?? {}).map(([id, persona]) => ({ id, label: persona.label, description: persona.description ?? '' }))
  };
}
