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
  if (label === 'agent' && process.env.SINGULARITY_FLOW_GITHUB_AGENT) {
    const selected = process.env.SINGULARITY_FLOW_GITHUB_AGENT;
    if (!entries.some(([id]) => id === selected)) throw new SingularityFlowError(`Unknown GitHub-selected governed agent '${selected}'.`);
    return selected;
  }
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_SELECTION) {
      const selection = JSON.parse(process.env.SINGULARITY_FLOW_TEST_SELECTION);
      const selected = selection[label === 'workflow template' ? 'workType' : label === 'intake source' ? 'source' : 'agent']
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

export async function selectAgent(root, definition, actor, workId = null, { phaseId = null, allowedAgents = null, selection = null, nonInteractiveHint = null } = {}) {
  const allowed = allowedAgents ? new Set(allowedAgents) : null;
  const entries = Object.entries(definition.agents ?? {}).filter(([id]) => !allowed || allowed.has(id));
  if (!entries.length) throw new SingularityFlowError(`No governed agent is available${phaseId ? ` for phase '${phaseId}'` : ''}.`);
  const defaultAgent = phaseId ? entries.find(([, agent]) => agent.defaultFor.includes(phaseId))?.[0] : null;
  const agent = selection ?? defaultAgent ?? (entries.length === 1 ? entries[0][0] : await choose('agent', entries, { selection, nonInteractiveHint }));
  return setAgentSession(root, definition, actor, agent, workId, { phaseId, source: 'explicit-override' });
}

export async function setAgentSession(root, definition, actor, agent, workId = null, { phaseId = null, nativeCopilotAgent = null, source = null } = {}) {
  const profile = definition.agents?.[agent];
  if (!profile) throw new SingularityFlowError(`Unknown governed agent '${agent}'.`);
  const compatible = !phaseId || !profile.phases.length || profile.phases.includes(phaseId);
  const existing = await loadSession(root, { required: false });
  const copilot = await loadCopilotSession(root);
  const binding = copilot?.workId === workId && copilot?.sessionId
    ? { copilotSessionId: copilot.sessionId, copilotSource: copilot.source, copilotBoundAt: nowIso() }
    : existing?.workId === workId && existing?.copilotSessionId
      ? { copilotSessionId: existing.copilotSessionId, copilotSource: existing.copilotSource, copilotBoundAt: existing.copilotBoundAt }
      : {};
  const selectedAt = nowIso();
  const record = {
    ...(existing ?? {}),
    schemaVersion: 2,
    agent,
    agentSource: source ?? profile.scope ?? 'repository',
    agentSha256: profile.sha256,
    nativeCopilotAgent: nativeCopilotAgent ?? existing?.nativeCopilotAgent ?? null,
    phaseCompatibilityOverride: compatible ? null : { phase: phaseId, agent, warnedAt: selectedAt },
    actor,
    workId,
    phaseId,
    selectedAt,
    ...binding
  };
  await writeLocalJson(sessionPath(root), record);
  if (copilot?.workId === workId) await writeLocalJson(copilotSessionPath(root), { ...copilot, selectionRequired: false, selectedAgent: agent, selectedAt: record.selectedAt });
  return record;
}

export async function setNativeCopilotAgentSession(root, resolved, actor = null) {
  const existing = await loadSession(root, { required: false });
  const record = {
    ...(existing ?? {}),
    schemaVersion: 2,
    nativeCopilotAgent: resolved.copilotAgent,
    nativeAgentMappingSource: resolved.source,
    ...(resolved.agent ? { agent: resolved.agent.id, agentSource: resolved.agent.scope, agentSha256: resolved.agent.sha256 } : {}),
    agentSelectedAt: nowIso()
  };
  if (actor && !record.actor) record.actor = actor;
  await mkdir(path.dirname(sessionPath(root)), { recursive: true });
  await writeFile(sessionPath(root), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function loadSession(root, { required = true } = {}) {
  const file = sessionPath(root);
  if (!(await exists(file))) {
    if (required) throw new SingularityFlowError('No active governed-agent session. Run singularity-flow resume <WORK-ID>.');
    return null;
  }
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function restoreAgentSession(root, record) {
  const file = sessionPath(root);
  if (record == null) {
    try { await unlink(file); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return null;
  }
  return writeLocalJson(file, record);
}

export async function loadCopilotSession(root) {
  const file = copilotSessionPath(root);
  return await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

export async function restoreCopilotSession(root, record) {
  const file = copilotSessionPath(root);
  if (record == null) {
    try { await unlink(file); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return null;
  }
  return writeLocalJson(file, record);
}

export async function recordCopilotSession(root, record) {
  return writeLocalJson(copilotSessionPath(root), { schemaVersion: 1, ...record });
}

/**
 * Mark a workspace-only Copilot handoff as deliberately unbound from its checked-out Story.
 *
 * The branch is still exposed as a candidate by `session status`, but it is not consent to select
 * that Story. Persisting the gate in the repository Git directory makes the same decision visible
 * to VS Code, Copilot hooks, and direct CLI calls without introducing another lifecycle store.
 */
export async function requireCopilotWorkItemSelection(root, definition, workflow = null) {
  const previous = await loadCopilotSession(root);
  const policy = normalizeSessionPolicy(workflow?.resolution?.session ?? definition.session ?? {});
  return recordCopilotSession(root, {
    ...(previous ?? {}),
    sessionId: null,
    source: 'workspace',
    repositoryRoot: root,
    workId: null,
    candidateWorkId: workflow?.workItem?.id ?? null,
    phase: workflow?.currentPhase ?? null,
    policy,
    workItemSelectionRequired: true,
    selectionRequired: false,
    selectedAgent: null,
    startedAt: nowIso()
  });
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

export function validAgentSession(definition, session, workId, copilotSessionId = null, phaseId = null) {
  if (!session || session.workId !== workId || !definition.agents?.[session.agent]) return false;
  if (phaseId && session.phaseId !== phaseId) return false;
  return !copilotSessionId || session.copilotSessionId === copilotSessionId;
}

export async function bindAgentToCopilotSession(root, definition, workId, copilot, phaseId = null) {
  const session = await loadSession(root, { required: false });
  if (!validAgentSession(definition, session, workId, null, phaseId)) return null;
  const record = { ...session, copilotSessionId: copilot.sessionId, copilotSource: copilot.source, copilotBoundAt: nowIso() };
  await writeLocalJson(sessionPath(root), record);
  return record;
}

export async function activateWorkItemSession(root, definition, workflow) {
  const copilot = await loadCopilotSession(root);
  const policy = normalizeSessionPolicy(workflow.resolution?.session ?? definition.session ?? {});
  const existing = await loadSession(root, { required: false });
  const phaseId = workflow.currentPhase;
  if (!phaseId) {
    if (!['complete', 'cancelled'].includes(workflow.status)) {
      throw new SingularityFlowError(
        `Work item '${workflow.workItem.id}' has no active phase while its status is '${workflow.status ?? 'unknown'}'. `
        + 'Run singularity-flow doctor before attaching the session.'
      );
    }
    // A terminal Story remains inspectable, but there is no phase contract and
    // therefore no governed phase agent to activate. Clear a stale local agent
    // from the final phase so status and Copilot do not present it as active.
    await restoreAgentSession(root, null);
    return recordCopilotSession(root, {
      ...(copilot ?? {}),
      sessionId: copilot?.sessionId ?? null,
      source: copilot?.source ?? 'startup',
      repositoryRoot: root,
      workId: workflow.workItem.id,
      candidateWorkId: workflow.workItem.id,
      phase: null,
      workflowStatus: workflow.status,
      policy,
      workItemSelectionRequired: false,
      selectionRequired: false,
      selectedAgent: null,
      workItemSelectedAt: nowIso()
    });
  }
  const phase = workflow.phases?.[phaseId] ?? null;
  const defaultAgent = phase?.defaultAgent
    ? definition.agents?.[phase.defaultAgent]
    : definition.agentCatalog?.find((agent) => agent.defaultFor.includes(phaseId));
  const defaultAgentId = phase?.defaultAgent ?? defaultAgent?.id;
  if (!defaultAgentId || !definition.agents?.[defaultAgentId]) throw new SingularityFlowError(`Phase '${phaseId}' has no configured governed agent.`);
  const valid = validAgentSession(definition, existing, workflow.workItem.id, null, phaseId);
  const selected = valid ? existing.agent : defaultAgent?.id;
  const activeAgent = selected ?? defaultAgentId;
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
    selectionRequired: false,
    selectedAgent: activeAgent,
    workItemSelectedAt: nowIso()
  });
  if (!valid) await setAgentSession(root, definition, existing?.actor ?? null, activeAgent, workflow.workItem.id, { phaseId, source: 'phase-default' });
  if (record.sessionId) await bindAgentToCopilotSession(root, definition, workflow.workItem.id, record, phaseId);
  return record;
}

export async function agentSessionStatus(root, definition, workflow) {
  const [session, copilot] = await Promise.all([loadSession(root, { required: false }), loadCopilotSession(root)]);
  const policy = normalizeSessionPolicy(copilot?.policy ?? workflow?.resolution?.session ?? definition.session ?? {});
  const workItemSelectionRequired = copilot
    ? copilot.workItemSelectionRequired === true
    : policy.workItemSelection === 'prompt' || (policy.workItemSelection === 'reuse' && !workflow);
  const workId = workItemSelectionRequired ? null : workflow?.workItem?.id ?? copilot?.workId ?? null;
  const phaseId = workflow?.currentPhase ?? copilot?.phase ?? null;
  const baseValid = workId ? validAgentSession(definition, session, workId, null, phaseId) : false;
  const bound = baseValid && (!copilot?.sessionId || session.copilotSessionId === copilot.sessionId);
  return {
    workId,
    candidateWorkId: copilot?.candidateWorkId ?? workflow?.workItem?.id ?? null,
    copilotSessionId: copilot?.sessionId ?? null,
    source: copilot?.source ?? null,
    policy,
    activeAgent: baseValid ? session.agent : null,
    bound,
    workItemSelectionRequired,
    selectionRequired: false,
    ready: !workItemSelectionRequired,
    choices: Object.entries(definition.agents ?? {}).map(([id, agent]) => ({ id, label: agent.label ?? id, description: agent.description ?? '' }))
  };
}
