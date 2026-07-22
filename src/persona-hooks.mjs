import { currentPhase } from './state.mjs';
import { normalizeSessionPolicy } from './config.mjs';
import {
  bindPersonaToCopilotSession, loadCopilotSession, loadSession, personaSessionStatus, recordCopilotSession, validPersonaSession
} from './session.mjs';

function sourceKind(value) { return ['startup', 'resume', 'new'].includes(value) ? value : 'startup'; }

function shouldPrompt(policy, source, valid) {
  if (policy.personaSelection === 'off') return false;
  if (!valid) return true;
  if (source === 'resume') return policy.promptOnResume === true;
  return policy.personaSelection === 'prompt' && policy.promptOnNewSession === true;
}

export async function sessionStartPersonaHook(root, definition, workflow, payload = {}) {
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
  const status = await personaSessionStatus(root, definition, workflow);
  const blocked = status.workItemSelectionRequired || status.selectionRequired;
  if (!status.policy?.requireBeforeTools || !blocked || isPersonaToolCall(payload)) return {};
  if (status.workItemSelectionRequired) return {
    permissionDecision: 'deny',
    permissionDecisionReason: `Select and synchronize a Singularity Flow work/Jira ID before using '${payload.toolName ?? 'this tool'}'. Run /sflow-session; the contributor must choose the ID.`
  };
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: `Select a Singularity Flow persona for ${status.workId} before using '${payload.toolName ?? 'this tool'}'. Run /sflow-session; the contributor must choose the persona.`
  };
}
