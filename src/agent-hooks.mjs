import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { currentPhase } from './state.mjs';
import { normalizeSessionPolicy } from './config.mjs';
import { branch } from './git.mjs';
import { AGENT_MAPPING_PATH, agentStatus, resolveCopilotAgent } from './agents.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { repositoryLogger } from './logging.mjs';
import { initiativeRelative } from './initiative-state.mjs';
import {
  bindAgentToCopilotSession, loadCopilotSession, loadCopilotTurnIntent, loadSession, agentSessionStatus,
  recordCopilotSession, setAgentSession, setNativeCopilotAgentSession, validAgentSession
} from './session.mjs';
import {
  activeWorkspaceFile, workspaceContextForRepository, workspacePromptLabel, workspaceRegistryFile
} from './workspace-context.mjs';

// An initiative branch is a governed context in its own right: the branch name IS the initiative
// ID, the profile and agent were pinned when it was started, and every phase output is
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

function copilotAgentName(payload = {}) {
  const value = payload.agentName ?? payload.agent_name;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Copilot exposes the selected custom-agent ID on subagentStart, but it does not pass that
// selection to child shell processes. Resolve an explicit agent-mappings.yml entry first, then
// retain same-name matching as a zero-configuration fallback. Record the resolved agent in
// the machine-local session so phase composition can use the same context automatically. This
// hook is intentionally trust-preserving: local-only packs and fully cached locked packs may be
// activated, while first trust, changed hashes, and network synchronization remain explicit human
// actions. Unknown Copilot agents are unrelated to Flow and produce no output or token overhead.
export async function copilotAgentStartHook(root, payload = {}) {
  const agentName = copilotAgentName(payload);
  if (!agentName) return {};
  const log = repositoryLogger(root, null, {
    context: { hook: 'agent-start', sessionId: payload.sessionId ?? payload.session_id ?? null, agentName }
  });
  let resolution;
  try { resolution = await resolveCopilotAgent(root, agentName); }
  catch (error) {
    log.warn('hook.agent.mapping-invalid', error.message, { agentName });
    return { additionalContext: `Singularity Flow did not activate a governed agent because ${error.message} Fix '${AGENT_MAPPING_PATH}', then start the Copilot agent again.` };
  }
  const agent = resolution.agent;
  if (!agent) {
    log.debug('hook.agent.unmapped', 'Copilot agent has no matching governed Flow agent', { agentName });
    await setNativeCopilotAgentSession(root, resolution);
    return { additionalContext: `Copilot agent '${agentName}' is not mapped to a governed Flow agent. Flow will use the phase-default Agent Markdown and record the native name for audit.` };
  }
  const status = (await agentStatus(root, agent.id))[0];
  if (status && ['local-only', 'ready'].includes(status.status)) {
    await setNativeCopilotAgentSession(root, resolution);
    log.info('hook.agent.mapped', 'Copilot agent mapped to governed Flow agent', {
      agentName, agent: agent.id, mapping: resolution.source, status: status.status, scope: agent.scope
    });
    return {};
  }
  const command = status?.status === 'stale'
    ? `singularity-flow agents lock ${agent.id} --update`
    : status?.status === 'needs-sync'
      ? `singularity-flow agents sync ${agent.id}`
      : `singularity-flow agents lock ${agent.id}`;
  log.warn('hook.agent.trust-required', 'Copilot agent was not mapped because its governed resources are not ready', {
    agentName, agent: agent.id, mapping: resolution.source, status: status?.status ?? 'unknown', command
  });
  return {
    additionalContext: `Copilot agent '${agentName}' resolves to governed Flow agent '${agent.id}', but Flow did not activate its remote resources because the trust state is ${status?.status ?? 'unknown'}. Ask the contributor to review and run '${command}'. Never confirm first trust, update hashes, or overwrite remote content automatically.`
  };
}

export async function sessionStartAgentHook(root, definition, workflow, payload = {}) {
  const log = repositoryLogger(root, definition, { context: { hook: 'session-start', sessionId: payload.sessionId ?? null } });
  const workspace = await workspaceContextForRepository(root, activeWorkspaceFile(), workspaceRegistryFile());
  const workspaceContext = workspace
    ? ` Active workspace: ${workspace.workspaceName}; repository: ${workspace.repositoryId}; context label: '${workspacePromptLabel(workspace)}'.`
    : '';
  const initiative = workflow ? null : await activeInitiative(root);
  if (initiative) {
    log.info('hook.session.initiative', 'governed initiative session; no work-item selection applies', {
      initiativeId: initiative.initiative.id, profile: initiative.initiative.profile, phase: initiative.currentPhase ?? 'complete'
    });
    const phase = initiative.currentPhase ?? 'complete';
    return {
      additionalContext: `Singularity Flow initiative ${initiative.initiative.id} is active on this branch: '${initiative.initiative.title}' (profile ${initiative.initiative.profile}, current phase ${phase}).${workspaceContext} This is a governed initiative context, not a work item, so no work/Jira ID selection applies and /sflow-session is not required here. Compose only the artifact for the phase you were given, treat the supplied governed contract as authoritative, and never write outside the initiative's declared promotion target. Never approve a phase automatically.`
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
  const phaseAgent = phase?.defaultAgent
    ?? definition.agentCatalog?.find((agent) => agent.defaultFor.includes(phase?.id))?.id
    ?? null;
  const valid = selectedWorkId ? validAgentSession(definition, existing, selectedWorkId, null, phase?.id ?? null) : false;
  if (selectedWorkId && phase && !phaseAgent) throw new Error(`Phase '${phase.id}' has no configured governed agent.`);
  const record = await recordCopilotSession(root, {
    sessionId, source, repositoryRoot: root, workId: selectedWorkId, candidateWorkId: activeWorkId, phase: phase?.id ?? null, policy,
    workItemSelectionRequired,
    selectionRequired: false, selectedAgent: valid ? existing.agent : phaseAgent,
    startedAt: new Date().toISOString()
  });
  let active = existing;
  if (!workItemSelectionRequired && phase && !valid) {
    active = await setAgentSession(root, definition, existing?.actor ?? null, phaseAgent, selectedWorkId, { phaseId: phase.id, source: 'phase-default' });
  }
  if (!workItemSelectionRequired && active && sessionId) active = await bindAgentToCopilotSession(root, definition, selectedWorkId, record, phase?.id ?? null);
  if (workItemSelectionRequired) return {
    additionalContext: `Singularity Flow work-item selection is required for implementation and lifecycle work in Copilot session ${sessionId ?? '(unknown)'}. The contributor must type /sflow-session; that skill is human-invoked only, so do not invoke it yourself and do not treat the host reporting it as unavailable as a broken installation. Once the contributor confirms the ID you may run 'singularity-flow session attach <WORK-ID>', which stays permitted while this gate is active. Repository-scoped /sflow-worldmodel initialization, build, freshness checks, and context inspection are allowed without a work or Jira ID. Ask the contributor for a work ID or Jira ID only when attaching to governed Story work; fetch the configured Git remote and attach only to the exact remote branch after fast-forward verification. Never infer an ID, create a branch, or discard local work. Never approve automatically.${activeWorkId ? ` Current branch candidate: ${activeWorkId}.` : ''}`
  };
  if (!workflow) return { additionalContext: `No Singularity Flow work item is active on this branch.${workspaceContext} Use /sflow-session to attach to a remote work/Jira ID.` };
  const agent = active?.agent;
  const context = phase
    ? `Singularity Flow work item ${workflow.workItem.id} is at ${phase.id} (${phase.status}).${workspaceContext}${agent ? ` Governed agent ${agent} is active; change it with /sf-agent. Agent instructions never replace human identity or approval authority.` : ''} Before changing lifecycle state, run /sflow-nextsteps. Never approve automatically.`
    : `Singularity Flow work item ${workflow.workItem.id} is complete.${workspaceContext} Run the governance gate before handoff.`;
  return { additionalContext: context };
}

function parsedToolArgs(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedToolPayload(payload = {}) {
  return {
    ...payload,
    toolName: payload.toolName ?? payload.tool_name ?? null,
    toolArgs: parsedToolArgs(payload.toolArgs ?? payload.tool_input)
  };
}

function commandText(toolArgs) {
  for (const key of ['command', 'cmd', 'script']) if (typeof toolArgs[key] === 'string') return toolArgs[key].trim();
  return '';
}

function setupCommandText(toolArgs) {
  const command = commandText(toolArgs);
  const scoped = command.match(/^cd\s+(?:"[^"$`;&|<>\n]+"|'[^'$`;&|<>\n]+'|[^$`;&|<>\n]+?)\s+&&\s+(.+)$/);
  return scoped?.[1]?.trim() ?? command;
}

function isRepositoryWorldModelCall(payload) {
  const command = setupCommandText(payload.toolArgs);
  if (/[;&|`$<>\n]/.test(command)) return false;
  const prefix = '(?:singularity-flow|sflow) wm';
  if (new RegExp(`^${prefix} init(?: 2>&1)?$`).test(command)) return true;

  const quoted = `(?:"[^"]*"|'[^']*')`;
  const identifier = '[A-Za-z0-9._:/,+@=-]+';
  const branchOption = `--(?:branch|remote) ${identifier}`;
  if (new RegExp(`^${prefix} check(?: ${branchOption})*(?: 2>&1)?$`).test(command)) return true;

  const buildOption = `(?:--local|--depth (?:quick|standard|deep)|--(?:phase|views) ${identifier}|${branchOption}|--(?:task|focus) (?:${quoted}|${identifier}))`;
  if (new RegExp(`^${prefix} build(?: ${buildOption})*(?: 2>&1)?$`).test(command)) return true;

  const contextOption = `(?:--concat|--evidence|--no-agent|${branchOption}|--task (?:${quoted}|${identifier}))`;
  return new RegExp(`^${prefix} context ${identifier}(?: ${contextOption})*(?: 2>&1)?$`).test(command);
}

function isReadOnlyRepositoryProbe(payload) {
  const command = setupCommandText(payload.toolArgs);
  if (!command || /[;|`$<>\n]/.test(command)) return false;
  const parts = command.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => part.includes('&'))) return false;
  return parts.every((part) => [
    /^cd (?:\/[A-Za-z0-9._+@%/:=-]+|'\/[^']+'|"\/[^"]+")$/,
    /^git remote -v$/,
    /^git branch --show-current$/,
    /^git branch -vv$/,
    /^git status --short --branch$/,
    /^git status --porcelain(?:=v1)?(?: --branch)?$/,
    /^git rev-parse --show-toplevel$/,
    /^git rev-parse --absolute-git-dir$/,
    /^git config --get remote\.[A-Za-z0-9._-]+\.url$/,
    /^pwd$/,
    /^echo (?:---|'---'|"---")$/
  ].some((pattern) => pattern.test(part)));
}

function isSessionBoundaryToolCall(payload) {
  const command = setupCommandText(payload.toolArgs);
  if (isReadOnlyRepositoryProbe(payload)) return true;
  if (/^(?:singularity-flow|sflow) session (?:status|candidates)(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) session attach [A-Za-z0-9._-]+(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow agent|sflow-agent)(?: [A-Za-z0-9._-]+)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) nextsteps(?: [A-Za-z0-9._-]+)?(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  const chars = payload.toolArgs?.chars ?? payload.toolArgs?.input ?? payload.toolArgs?.text;
  const terminal = payload.toolArgs?.sessionId ?? payload.toolArgs?.session_id;
  return Boolean(terminal && typeof chars === 'string' && /^\d+\r?\n$/.test(chars));
}

function isAgentToolCall(payload) {
  const command = setupCommandText(payload.toolArgs);
  // Copilot may orient itself before invoking the first command in /sflow-session. Permit only
  // exact read-only repository probes; lifecycle mutation and arbitrary shell composition remain
  // denied until the contributor explicitly selects a work item. The phase agent is automatic.
  if (isReadOnlyRepositoryProbe(payload)) return true;
  // Building and inspecting the repository model is repository maintenance, not Story work.
  // Keep this exception deliberately narrow: it accepts only the documented world-model
  // subcommands and flags, rejects shell metacharacters, and does not admit --runner or --out.
  if (isRepositoryWorldModelCall(payload)) return true;
  if (/^(?:singularity-flow|sflow) choices (?:begin start [A-Za-z0-9._-]+|begin approve [A-Za-z0-9._-]+(?: --fetch)?|answer [0-9a-f-]{36} (?:intake-source|workflow-template|agent|phase-confirmation) [A-Za-z0-9._-]+|status [0-9a-f-]{36})(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) (?:story )?start\s/.test(command)
    && /(?:^|\s)--selection-receipt\s+[0-9a-f-]{36}(?:\s|$)/.test(command)
    && !/[;&|`$<>\n]/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) approve\s/.test(command)
    && /(?:^|\s)--selection-receipt\s+[0-9a-f-]{36}(?:\s|$)/.test(command)
    && !/[;&|`$<>\n]/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) inbox(?:(?: --json| --offline)){0,2}(?: 2>&1)?$/.test(command)) return true;
  // Reading the activity log is read-only diagnostics and must survive the gate: a blocked session
  // is exactly when Copilot needs to explain why it is blocked. Values admit no shell
  // metacharacters, so this cannot be used to smuggle a command past the guard.
  if (/^(?:singularity-flow|sflow) logs(?: (?:path|level))?(?:(?: --json| --tail [0-9]{1,6}| --level [a-z]+| --event [A-Za-z0-9._:-]+| --since [0-9A-Za-z:.+-]+)){0,5}(?: 2>&1)?$/.test(command)) return true;
  // Reporting the SDLC status of a work item is read-only ("Do not change files or lifecycle
  // state") and is the whole job of /sflow-status. Gating it created a chicken-and-egg: a
  // contributor could not see a work item's state without first attaching a session to it. The ID
  // admits no shell metacharacters, so this cannot smuggle a command past the guard.
  if (/^(?:singularity-flow|sflow) status(?: [A-Za-z0-9._-]+)?(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  // Initialization and its audit must be available before a work item or governed agent exists.
  // Keep the exception narrow: no shell composition, arbitrary paths, or unbounded arguments.
  if (/^(?:singularity-flow|sflow) init --check(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) init --repair(?: --work-id [A-Za-z0-9._-]+)?(?: --base [A-Za-z0-9._/-]+)?(?: --fetch)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) doctor(?: [A-Za-z0-9._-]+)?(?: --offline)?(?: --json)?(?: 2>&1)?$/.test(command)) return true;

  if (/^(?:singularity-flow|sflow) session status(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) session candidates(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) session attach [A-Za-z0-9._-]+(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) workspace (?:list|current)(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow|sflow) workspace (?:use|switch) [A-Za-z0-9._-]+(?: --repository [A-Za-z0-9._-]+)?(?: --story [A-Za-z0-9._-]+)?(?: --json)?(?: 2>&1)?$/.test(command)) return true;
  if (/^(?:singularity-flow agent|sflow-agent)(?: [A-Za-z0-9._-]+)?(?: 2>&1)?$/.test(command)) return true;
  const chars = payload.toolArgs?.chars ?? payload.toolArgs?.input ?? payload.toolArgs?.text;
  const terminal = payload.toolArgs?.sessionId ?? payload.toolArgs?.session_id;
  return Boolean(terminal && typeof chars === 'string' && /^\d+\r?\n$/.test(chars));
}

export async function agentGuardHook(root, definition, workflow, payload = {}) {
  payload = normalizedToolPayload(payload);
  // Work-item selection cannot be satisfied on an initiative branch, so denying tools there blocks
  // governed initiative work permanently rather than protecting anything. Lifecycle mutation stays
  // gated by the initiative's own phase, approval, and evidence checks.
  const log = repositoryLogger(root, definition, {
    context: { hook: 'agent-guard', toolName: payload.toolName ?? null }
  });
  const turnIntent = await loadCopilotTurnIntent(root, payload.sessionId ?? payload.session_id ?? null);
  if (turnIntent?.intent === 'session-only' && !isSessionBoundaryToolCall(payload)) {
    log.warn('hook.guard.deny', `denied '${payload.toolName ?? 'tool'}'`, {
      reason: 'session-only turn',
      workId: turnIntent.workId ?? null
    });
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: 'This is a session-setup-only turn. Synchronize the selected work item, activate its phase agent, report next steps, and then end the turn. Do not search, read, edit, implement, generate, publish, submit, or approve project work.'
    };
  }
  const initiative = workflow ? null : await activeInitiative(root);
  if (initiative) {
    log.info('hook.guard.allow', 'governed initiative branch', { reason: 'initiative', initiativeId: initiative.initiative.id });
    return {};
  }
  const status = await agentSessionStatus(root, definition, workflow);
  const blocked = status.workItemSelectionRequired;
  if (!status.policy?.requireBeforeTools || !blocked || isAgentToolCall(payload)) {
    log.debug('hook.guard.allow', null, {
      reason: !status.policy?.requireBeforeTools ? 'requireBeforeTools disabled' : !blocked ? 'session complete' : 'session-management tool',
      workId: status.workId ?? null
    });
    return {};
  }
  log.warn('hook.guard.deny', `denied '${payload.toolName ?? 'tool'}'`, {
    reason: 'work-item selection required',
    workId: status.workId ?? null,
    workItemSelectionRequired: status.workItemSelectionRequired,
    agent: status.activeAgent ?? null
  });
  // A refusal has to name a remedy the reader can actually perform, or it is a deadlock rather than
  // a gate. `/sflow-session` and `/sflow-agent` are `disable-model-invocation: true`, so an assistant
  // told only to "run /sflow-session" cannot comply: the host reports the blocked skill as "Skill
  // not found", the assistant falls back to composing raw shell orientation commands, those are not
  // on the allowlist, and the loop repeats until the human gives up. So each refusal now states the
  // exact CLI remedy for the missing work-item selection and says who can run it.
  const tool = payload.toolName ?? 'this tool';
  if (status.workItemSelectionRequired) {
    const candidate = status.workId ?? status.candidateWorkId ?? null;
    const attach = `singularity-flow session attach ${candidate ?? '<WORK-ID>'}`;
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: `Select and synchronize a Singularity Flow work/Jira ID before using '${tool}'. The contributor must choose the ID: ask them to type /sflow-session, or to confirm the ID and then run '${attach}'. That command is permitted while this gate is active. Do not invoke the sflow-session skill yourself; it is human-invoked only. Never infer the ID.`
    };
  }
  return {};
}
