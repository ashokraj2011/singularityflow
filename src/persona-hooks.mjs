import { currentPhase } from './state.mjs';
import {
  bindPersonaToCopilotSession, loadSession, personaSessionStatus, recordCopilotSession, validPersonaSession
} from './session.mjs';

function sourceKind(value) { return ['startup', 'resume', 'new'].includes(value) ? value : 'startup'; }

function shouldPrompt(policy, source, valid) {
  if (policy.personaSelection === 'off') return false;
  if (!valid) return true;
  if (source === 'resume') return policy.promptOnResume === true;
  return policy.personaSelection === 'prompt' && policy.promptOnNewSession === true;
}

export async function sessionStartPersonaHook(root, definition, workflow, payload = {}) {
  const policy = workflow.resolution?.session ?? definition.session ?? { personaSelection: 'off', promptOnNewSession: false, promptOnResume: false, requireBeforeTools: false };
  const phase = currentPhase(workflow);
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim() ? payload.sessionId.trim() : null;
  const source = sourceKind(payload.source);
  const existing = await loadSession(root, { required: false });
  const valid = validPersonaSession(definition, existing, workflow.workItem.id);
  const selectionRequired = Boolean(phase && shouldPrompt(policy, source, valid));
  const record = await recordCopilotSession(root, {
    sessionId, source, workId: workflow.workItem.id, phase: phase?.id ?? null, policy,
    selectionRequired, selectedPersona: selectionRequired ? null : valid ? existing.persona : null,
    startedAt: new Date().toISOString()
  });
  let active = existing;
  if (!selectionRequired && valid && sessionId) active = await bindPersonaToCopilotSession(root, definition, workflow.workItem.id, record);
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

function isPersonaToolCall(payload) {
  const command = commandText(payload.toolArgs);
  if (/^(?:singularity-flow|sflow) session status(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow persona|sflow-persona)(?: [A-Za-z0-9._-]+)?(?: 2>&1)?$/.test(command)) return true;
  const chars = payload.toolArgs?.chars ?? payload.toolArgs?.input ?? payload.toolArgs?.text;
  const terminal = payload.toolArgs?.sessionId ?? payload.toolArgs?.session_id;
  return Boolean(terminal && typeof chars === 'string' && /^\d+\r?\n$/.test(chars));
}

export async function personaGuardHook(root, definition, workflow, payload = {}) {
  const status = await personaSessionStatus(root, definition, workflow);
  if (!status.policy?.requireBeforeTools || !status.selectionRequired || isPersonaToolCall(payload)) return {};
  return {
    permissionDecision: 'deny',
    permissionDecisionReason: `Select a Singularity Flow persona for ${workflow.workItem.id} before using '${payload.toolName ?? 'this tool'}'. Run /sflow-session; the contributor must choose the persona.`
  };
}
