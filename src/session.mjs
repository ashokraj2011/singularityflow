import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { exists } from './util.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';
import { normalizeSessionPolicy } from './config.mjs';

function sessionPath(root) {
  return path.join(root, '.git/singularity-flow/session.json');
}

function copilotSessionPath(root) {
  return path.join(root, '.git/singularity-flow/copilot-session.json');
}

async function writeLocalJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function choose(label, entries, { selection = null } = {}) {
  if (selection != null) {
    if (!entries.some(([id]) => id === selection)) throw new SingularityFlowError(`Unknown ${label} '${selection}'.`);
    return selection;
  }
  if (label === 'persona' && process.env.SINGULARITY_FLOW_GITHUB_PERSONA) {
    const selected = process.env.SINGULARITY_FLOW_GITHUB_PERSONA;
    if (!entries.some(([id]) => id === selected)) throw new SingularityFlowError(`Unknown GitHub approval persona '${selected}'.`);
    return selected;
  }
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_SELECTION) {
      const selection = JSON.parse(process.env.SINGULARITY_FLOW_TEST_SELECTION);
      const selected = selection[label === 'workflow template' ? 'workType' : label === 'intake source' ? 'source' : 'persona']
        ?? (label === 'intake source' ? 'manual' : undefined);
      if (entries.some(([id]) => id === selected)) return selected;
    }
    throw new SingularityFlowError(`Selecting a ${label} requires an interactive terminal.`);
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

export async function selectPersona(root, definition, actor, workId = null, { allowedPersonas = null, selection = null } = {}) {
  const allowed = allowedPersonas ? new Set(allowedPersonas) : null;
  const entries = Object.entries(definition.personas).filter(([id]) => !allowed || allowed.has(id));
  if (!entries.length) throw new SingularityFlowError('No configured persona is available for this action.');
  const persona = await choose('persona', entries, { selection });
  return setPersonaSession(root, definition, actor, persona, workId);
}

export async function setPersonaSession(root, definition, actor, persona, workId = null) {
  if (!definition.personas?.[persona]) throw new SingularityFlowError(`Unknown persona '${persona}'.`);
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
    if (required) throw new SingularityFlowError('No active persona session. Run singularity-flow resume <WORK-ID> and choose a persona.');
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
