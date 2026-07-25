import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { currentPhase } from './state.mjs';
import { normalizeSessionPolicy } from './config.mjs';
import { branch } from './git.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { repositoryLogger } from './logging.mjs';
import { initiativeRelative } from './initiative-state.mjs';
import {
  bindPersonaToCopilotSession, loadCopilotSession, loadSession, personaSessionStatus, recordCopilotSession, validPersonaSession
} from './session.mjs';

// An initiative branch is a governed context in its own right: the branch name IS the initiative
// ID, the profile and persona were pinned when it was started, and every phase output is
// hash-bound. It has no work item and never will, so requiring a work-item selection there can
// never be satisfied — it only starves the session. Copilot Studio composes exactly this kind of
// context, so without this the studio was deadlocked on every Epic phase by Singularity Flow's own
// session hook: Copilot was told a work ID was mandatory and correctly refused to proceed without
// one, ending the turn with nothing.
async function activeInitiative(root) {
  try {
    const id = branch(root);
    if (!id) return null;
    const portfolio = await loadPortfolio(root);
    const state = path.join(root, initiativeRelative(portfolio, id), 'state.json');
    if (!existsSync(state)) return null;
    const parsed = JSON.parse(await readFile(state, 'utf8'));
    return parsed?.initiative?.id === id ? parsed : null;
  } catch {
    return null;
  }
}

function sourceKind(value) { return ['startup', 'resume', 'new'].includes(value) ? value : 'startup'; }

function shouldPrompt(policy, source, valid) {
  if (policy.personaSelection === 'off') return false;
  if (!valid) return true;
  if (source === 'resume') return policy.promptOnResume === true;
  return policy.personaSelection === 'prompt' && policy.promptOnNewSession === true;
}

export async function sessionStartPersonaHook(root, definition, workflow, payload = {}) {
  const log = repositoryLogger(root, definition, { context: { hook: 'session-start', sessionId: payload.sessionId ?? null } });
  const initiative = workflow ? null : await activeInitiative(root);
  if (initiative) {
    log.info('hook.session.initiative', 'governed initiative session; no work-item selection applies', {
      initiativeId: initiative.initiative.id, profile: initiative.initiative.profile, phase: initiative.currentPhase ?? 'complete'
    });
    const phase = initiative.currentPhase ?? 'complete';
    return {
      additionalContext: `Singularity Flow initiative ${initiative.initiative.id} is active on this branch: '${initiative.initiative.title}' (profile ${initiative.initiative.profile}, current phase ${phase}). This is a governed initiative context, not a work item, so no work/Jira ID selection applies and /sflow-session is not required here. Compose only the artifact for the phase you were given, treat the supplied governed contract as authoritative, and never write outside the initiative's declared promotion target. Never approve a phase automatically.`
    };
  }
  const policy = normalizeSessionPolicy(workflow?.resolution?.session ?? definition.session ?? {});
  const phase = workflow ? currentPhase(workflow) : null;
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim() ? payload.sessionId.trim() : null;
  const source = sourceKind(payload.source);
  const [existing, previous] = await Promise.all([loadSession(root, { required: false }), loadCopilotSession(root)]);
  const activeWorkId = workflow?.workItem?.id ?? null;
  const sameCopilotSession = Boolean(sessionId && previous?.sessionId === sessionId && previous?.repositoryRoot === root);
  const previousSelectionStillActive = sameCopilotSession && previous?.workId && previous.workId === activeWorkId && previous.workItemSelectionRequired !== true;
  const workItemSelectionRequired = policy.workItemSelection === 'prompt'
    ? !previousSelectionStillActive
    : policy.workItemSelection === 'reuse'
      ? !activeWorkId
      : false;
  const selectedWorkId = workItemSelectionRequired ? null : activeWorkId;
  const valid = selectedWorkId ? validPersonaSession(definition, existing, selectedWorkId) : false;
  const selectionRequired = Boolean(selectedWorkId && phase && shouldPrompt(policy, source, valid));
  const record = await recordCopilotSession(root, {
    sessionId, source, repositoryRoot: root, workId: selectedWorkId, candidateWorkId: activeWorkId, phase: phase?.id ?? null, policy,
    workItemSelectionRequired,
    selectionRequired, selectedPersona: selectionRequired ? null : valid ? existing.persona : null,
    startedAt: new Date().toISOString()
  });
  let active = existing;
  if (!workItemSelectionRequired && !selectionRequired && valid && sessionId) active = await bindPersonaToCopilotSession(root, definition, selectedWorkId, record);
  if (workItemSelectionRequired) return {
    additionalContext: `Singularity Flow work-item selection is required for Copilot session ${sessionId ?? '(unknown)'}. Invoke /sflow-session before using implementation or lifecycle tools. Ask the contributor for a work ID or Jira ID, fetch the configured Git remote, and attach only to the exact remote branch after fast-forward verification. Never infer an ID, create a branch, or discard local work. Never approve automatically.${activeWorkId ? ` Current branch candidate: ${activeWorkId}.` : ''}`
  };
  if (!workflow) return { additionalContext: 'No Singularity Flow work item is active on this branch. Use /sflow-session to attach to a remote work/Jira ID.' };
  const choices = Object.entries(definition.personas).map(([id, persona]) => `${persona.label} (${id})`).join(', ');
  if (selectionRequired) return {
    additionalContext: `Singularity Flow persona selection is required for Copilot session ${sessionId ?? '(unknown)'}. Before using implementation or lifecycle tools, invoke /sflow-session and let the contributor choose from: ${choices}. Never infer or select a persona for them. Never approve automatically. Work item: ${workflow.workItem.id}; phase: ${phase.id}.`
  };
  const persona = active?.persona;
  const context = phase
    ? `Singularity Flow work item ${workflow.workItem.id} is at ${phase.id} (${phase.status}).${persona ? ` Acting as ${persona} for this Copilot session; change it with /sflow-persona.` : ''} Before changing lifecycle state, run /sflow-nextsteps. Never approve automatically.`
    : `Singularity Flow work item ${workflow.workItem.id} is complete; run the governance gate before handoff.`;
  return { additionalContext: context };
}

function commandText(toolArgs) {
  if (!toolArgs || typeof toolArgs !== 'object') return '';
  for (const key of ['command', 'cmd', 'script']) if (typeof toolArgs[key] === 'string') return toolArgs[key].trim();
  return '';
}

function setupCommandText(toolArgs) {
  const command = commandText(toolArgs);
  const scoped = command.match(/^cd\s+(?:"[^"$`;&|<>\n]+"|'[^'$`;&|<>\n]+'|[^$`;&|<>\n]+?)\s+&&\s+(.+)$/);
  return scoped?.[1]?.trim() ?? command;
}

function isPersonaToolCall(payload) {
  const command = setupCommandText(payload.toolArgs);
  if (/^(?:singularity-flow|sflow) choices (?:begin start [A-Za-z0-9._-]+|begin approve [A-Za-z0-9._-]+(?: --fetch)?|answer [0-9a-f-]{36} (?:intake-source|workflow-template|persona|phase-confirmation) [A-Za-z0-9._-]+|status [0-9a-f-]{36})(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) start\s/.test(command)
    && /(?:^|\s)--selection-receipt\s+[0-9a-f-]{36}(?:\s|$)/.test(command)
    && !/[;&|`$<>\n]/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) approve\s/.test(command)
    && /(?:^|\s)--selection-receipt\s+[0-9a-f-]{36}(?:\s|$)/.test(command)
    && !/[;&|`$<>\n]/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) inbox(?:(?: --json| --offline)){0,2}(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) session status(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) session candidates(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) session attach [A-Za-z0-9._-]+(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow persona|sflow-persona)(?: [A-Za-z0-9._-]+)?(?: 2>&1)?$/.test(command)) return true;
  const chars = payload.toolArgs?.chars ?? payload.toolArgs?.input ?? payload.toolArgs?.text;
  const terminal = payload.toolArgs?.sessionId ?? payload.toolArgs?.session_id;
  return Boolean(terminal && typeof chars === 'string' && /^\d+\r?\n$/.test(chars));
}

export async function personaGuardHook(root, definition, workflow, payload = {}) {
  // Work-item selection cannot be satisfied on an initiative branch, so denying tools there blocks
  // governed initiative work permanently rather than protecting anything. Lifecycle mutation stays
  // gated by the initiative's own phase, approval, and evidence checks.
  const log = repositoryLogger(root, definition, {
    context: { hook: 'persona-guard', toolName: payload.toolName ?? null }
  });
  const initiative = workflow ? null : await activeInitiative(root);
  if (initiative) {
    log.info('hook.guard.allow', 'governed initiative branch', { reason: 'initiative', initiativeId: initiative.initiative.id });
    return {};
  }
  const status = await personaSessionStatus(root, definition, workflow);
  const blocked = status.workItemSelectionRequired || status.selectionRequired;
  if (!status.policy?.requireBeforeTools || !blocked || isPersonaToolCall(payload)) {
    log.debug('hook.guard.allow', null, {
      reason: !status.policy?.requireBeforeTools ? 'requireBeforeTools disabled' : !blocked ? 'session complete' : 'session-management tool',
      workId: status.workId ?? null
    });
    return {};
  }
  log.warn('hook.guard.deny', `denied '${payload.toolName ?? 'tool'}'`, {
    reason: status.workItemSelectionRequired ? 'work-item selection required' : 'persona selection required',
    workId: status.workId ?? null,
    workItemSelectionRequired: status.workItemSelectionRequired,
    personaSelectionRequired: status.selectionRequired
  });
  if (status.workItemSelectionRequired) return {
    permissionDecision: 'deny',
    permissionDecisionReason: `Select and synchronize a Singularity Flow work/Jira ID before using '${payload.toolName ?? 'this tool'}'. Run /sflow-session; the contributor must choose the ID.`
  };
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: `Select a Singularity Flow persona for ${status.workId} before using '${payload.toolName ?? 'this tool'}'. Run /sflow-session; the contributor must choose the persona.`
  };
}
