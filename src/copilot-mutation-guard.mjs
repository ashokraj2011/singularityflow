/** Explicit-turn interception. Ordinary chat/pause never loads Story policy. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deriveMutationContract, mutationContractPresentation, mutationDenial, mutationPathDecision, mutationTurnMode } from './phase-mutation-contract.mjs';
import { copilotModeFile, readCopilotMode } from './copilot-mode.mjs';
import { parseArgs } from './util.mjs';
import { resolveOperation } from './command-registry.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { safeCommandGuidance, validateSflowExecutionCommand } from './safe-command-guidance.mjs';

const MAX_AGE = 30 * 60 * 1000;
const TERMINALS = new Set(['bash', 'powershell', 'run_in_terminal', 'execute', 'exec_command', 'write_stdin']);
const DECIDE_SKILL_MUTATIONS = Object.freeze(['choose', 'applicability', 'scope', 'completeness', 'plan']);
// An agent may raise an issue or propose an amendment; only an approver decides or revalidates.
const UPSTREAM_ISSUE_DECISIONS = Object.freeze(['decide', 'decide-amendment', 'revalidate']);
const DELEGATION = new Set(['task', 'spawn_agent', 'write_agent', 'delegate', 'run_subagent']);
const IMPORT_TEAM_COMMANDS = Object.freeze(['inspect', 'compile', 'status']);
const digest = value => createHash('sha256').update(value).digest('hex');
const directory = () => path.join(path.dirname(copilotModeFile()), 'copilot-boundaries');
function key(payload) {
  const id = payload.sessionId ?? payload.session_id;
  return typeof id === 'string' && id && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id) ? digest(id) : null;
}
function recordFile(payload) { const id = key(payload); return id ? path.join(directory(), `${id}.mutation.json`) : null; }
async function atomicRecord(file, record) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new Error('Unsafe mutation cache directory');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const { integritySha256: ignored, ...content } = record;
    await writeFile(temporary, JSON.stringify({ ...content, integritySha256: digest(JSON.stringify(content)) }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
async function boundedRecord(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Unsafe mutation record');
  const value = JSON.parse(await readFile(file, 'utf8'));
  const { integritySha256, ...content } = value;
  if (value.kind !== 'copilot-mutation-contract' || integritySha256 !== digest(JSON.stringify(content))) throw new Error('Corrupt mutation record');
  return value;
}
async function turn(payload) {
  if (readCopilotMode().paused || !key(payload)) return null;
  try {
    const record = readRecord('copilot-repository-boundary', await readFile(path.join(directory(), `${key(payload)}.json`), 'utf8')).record;
    if (record.sessionId !== (payload.sessionId ?? payload.session_id)
        || record.modeChangedAt !== readCopilotMode().changedAt) return null;
    return record;
  } catch {
    // Corruption must not silently release an explicitly opted-in session's edit lock.
    try {
      const value = await boundedRecord(recordFile(payload));
      if (value.sessionId === (payload.sessionId ?? payload.session_id)
          && value.modeChangedAt === readCopilotMode().changedAt) return { ...value, corrupt: true };
    } catch {}
    const exists = await lstat(recordFile(payload)).catch(() => null);
    return exists ? { sessionId: payload.sessionId ?? payload.session_id, corrupt: true } : null;
  }
}

async function loadStory(root) {
  return (await import('./accepted-story-execution.mjs')).loadAcceptedStoryExecution(root);
}
async function identity(root) {
  const { gitDir } = await import('./git.mjs');
  const git = gitDir(root);
  const headFile = path.join(git, 'HEAD');
  const headText = await readFile(headFile, 'utf8');
  const commonText = await readFile(path.join(git, 'commondir'), 'utf8').catch(() => '.');
  const common = path.resolve(git, commonText.trim());
  const files = [headFile, path.join(common, 'packed-refs')];
  if (headText.startsWith('ref: ')) files.push(path.join(common, headText.slice(5).trim()));
  const stamps = await Promise.all(files.map(async file => ({ file,
    sha256: digest(await readFile(file).catch(error => { if (error.code === 'ENOENT') return ''; throw error; })) })));
  return { gitDir: git, stamps };
}

async function createRecord(payload, record, root, accepted, previous = null) {
  const workflow = accepted.workflow;
  const definition = accepted.definition ?? accepted.config;
  const requestedMode = mutationTurnMode(record.skill);
  const mode = previous?.originPhase && previous.originPhase !== workflow.currentPhase
    && !['approval-only', 'session-only', 'import-team'].includes(requestedMode) ? 'read' : requestedMode;
  const phase = workflow.phases?.[workflow.currentPhase];
  const evidence = mode === 'authoring' && phase?.generationIntent?.status === 'open'
    ? await (await import('./delivery-evidence.mjs')).plannedEvidencePaths(root, definition, workflow, phase).catch(() => [])
    : [];
  const contract = deriveMutationContract({ root, definition, workflow, turnMode: mode, evidence });
  if (mode === 'read' && requestedMode !== 'read') {
    contract.summary = 'The phase changed during this turn. Preserve work, end this turn, and start the configured author in a new turn.';
  }
  const workflowFile = path.join(root, definition.workItemRoot, workflow.workItem.id, 'workflow.json');
  const gitIdentity = await identity(root);
  // Issued staging is scoped to the exact phase/generation. Never use a wildcard private path.
  const samePhase = previous?.contract?.phaseId === contract.phaseId && previous.contract.generation === contract.generation;
  contract.allow.staging = samePhase ? previous.contract.allow.staging : [];
  const value = { schemaVersion: currentSchemaVersion('copilot-mutation-contract'), kind: 'copilot-mutation-contract',
    turnId: record.turnId, sessionId: record.sessionId, skill: record.skill, recordedAt: record.recordedAt,
    modeChangedAt: record.modeChangedAt, contract,
    originPhase: previous?.originPhase ?? contract.phaseId,
    decisionEnded: previous?.decisionEnded ?? false,
    binding: { workflowFile, workflowSha256: digest(await readFile(workflowFile)), ...gitIdentity },
    baseline: previous?.baseline ?? null, findings: previous?.findings ?? [],
    ...(previous?.importTeamStaging ? { importTeamStaging: previous.importTeamStaging } : {}) };
  return value;
}

export async function captureMutationTurn(payload, record, {
  resolveRoot = async value => (await import('./copilot-repository-boundary.mjs')).resolveCopilotDiscoveryRoot(value),
  load = loadStory
} = {}) {
  const file = recordFile(payload);
  if (!file) return;
  let root = null;
  try {
    const candidate = await resolveRoot(payload);
    root = candidate ? await realpath(candidate) : null;
    if (!root) throw new Error('No verified Story checkout');
    const value = await createRecord(payload, record, root, await load(root));
    // One content-bound baseline, not a path/status-only baseline. It is deliberately lazy:
    // edit-tool interception needs no Git process; post-shell detection records its own baseline.
    await atomicRecord(file, value);
    const presented = mutationContractPresentation(value.contract);
    return { additionalContext: [
      `SFlow turn boundary (${value.skill}): ${presented.summary}`,
      `Binding readiness is not source-edit permission. Code authoring ready: ${presented.codeAuthoringReady}.`,
      presented.sourceEditPrerequisite
        ? `Before source edits: ${presented.sourceEditPrerequisite.command}. Re-enter the phase after that operation to verify fresh permissions; never auto-adopt or discard edits.` : null,
      value.contract.turnMode === 'kernel-only'
        ? 'Do not inline /sf-code or edit files in this kernel-only turn. Return the configured authoring skill and stop; the human invokes it explicitly.' : null
    ].filter(Boolean).join(' ') };
  } catch {
    await atomicRecord(file, { schemaVersion: currentSchemaVersion('copilot-mutation-contract'), kind: 'copilot-mutation-contract',
      sessionId: record.sessionId, turnId: record.turnId, skill: record.skill, modeChangedAt: record.modeChangedAt,
      contract: null, repositoryRoot: root, recordedAt: record.recordedAt });
  }
}

export async function clearMutationTurn(payload) {
  const file = recordFile(payload);
  if (file) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

function calls(payload) {
  return (payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name, args: payload.toolArgs ?? payload.tool_input }])
    .map(call => {
      let args = call.args ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { patch: args }; } }
      let name = String(call.name ?? '').toLowerCase().split(/[.:]/u).at(-1);
      if (name === 'str_replace_editor') name = args.command === 'view' ? 'view' : 'edit';
      return { name, args };
    });
}
function isEdit(name) { return /(?:patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename).*?(?:file|directory)|^(?:patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename|apply_patch)$/u.test(name); }
function targets(args) {
  const found = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [field, child] of Object.entries(value)) {
      if (/^(?:path|file_path|filePath|filepath|file|source|destination|old_path|new_path|oldPath|newPath|from|to|uri|fileName|filename)$/u.test(field)) {
        if (typeof child === 'string') found.push(child);
      } else if (field === 'paths' && Array.isArray(child)) found.push(...child.filter(item => typeof item === 'string'));
      else if (child && typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    }
  };
  visit(args);
  const patch = args.patch ?? args.input ?? args.text;
  if (typeof patch === 'string') {
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu)) found.push(match[1]);
  }
  return [...new Set(found)];
}
function scopedShellCommand(call, value) {
  let command = call.args.command ?? call.args.cmd ?? call.args.script;
  if (typeof command !== 'string') return null;
  const scoped = command.trim().match(/^cd\s+(?:'([^']*)'|"([^"$`]*)"|([^\s;&|`$<>]+))\s*&&\s*([\s\S]+)$/u);
  if (scoped) {
    const target = scoped[1] ?? scoped[2] ?? scoped[3];
    const root = value.contract?.repositoryRoot ?? value.repositoryRoot;
    if (!root || !path.isAbsolute(target)) return null;
    try { if (realpathSync(target) !== root) return null; } catch { return null; }
    command = scoped[4];
  }
  return command;
}

function verifiedShellForm(call, value) {
  const command = scopedShellCommand(call, value);
  if (typeof command !== 'string') return null;
  // Reuse the guidance lexer: punctuation inside literal answers/paths is data, not a
  // command separator. Accept its quoted executable and PowerShell call-operator forms.
  const powershell = call.name === 'powershell' || /^\s*&\s+/u.test(command);
  const normalized = command.trim().replace(/^&\s+(?=['"]?(?:singularity-flow|sflow)\b)/u, '')
    .replace(/^(['"])(singularity-flow|sflow)\1(?=\s|$)/u, '$2');
  const staging = /^(?:singularity-flow|sflow)\s+(?:review-source|'review-source'|"review-source")\s+(?:stage|'stage'|"stage")\s/u.test(normalized);
  const safe = validateSflowExecutionCommand(normalized, { shell: powershell ? 'powershell' : 'posix',
    maximumLength: staging ? 65536 : 2000 });
  return safe?.copyable ? safe : null;
}

function shellAllowed(call, mode, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseArgs(safe.argv);
  if (['hook', 'run', 'exec'].includes(positionals[0])) return false;
  let classification;
  try { classification = resolveOperation({ requestedCommand: positionals[0], positionals, options }).classification; }
  catch { return false; }
  if (mode === 'approval-only') {
    const action = value.skill?.replace(/^\/?(?:sf|sflow)-/u, '');
    if (positionals[0] === 'choices') return positionals[1] === 'status' || !value.decisionEnded && (positionals[1] === 'answer'
      || positionals[1] === 'begin' && positionals[2] === action && positionals[3] === value.contract.workId);
    if (classification === 'read') return true;
    if (value.decisionEnded || options['work-id'] && options['work-id'] !== value.contract.workId) return false;
    return positionals[0] === action && (!positionals[1] || positionals[1] === value.originPhase);
  }
  if (classification === 'read') return true;
  if (mode === 'review-decision-only') return !value.decisionEnded && positionals[0] === 'review-source'
    && positionals[1] === 'decide' && positionals[2] === value.contract.phaseId
    && options['work-id'] === value.contract.workId && typeof options.finding === 'string'
    && typeof options.reason === 'string' && /^[a-f0-9]{64}$/u.test(options.confirm ?? '')
    && positionals.length === 3
    && Object.keys(options).every(key => ['work-id', 'finding', 'reason', 'confirm', 'json'].includes(key));
  // The /sf-decide turn boundary: the decision commands its skill names, for the bound Story only.
  // `decision risk` and `decision witness` stay outside it; a witness needs the human terminal.
  if (mode === 'decision-only' && positionals[0] === 'upstream-issue') return !value.decisionEnded
    && positionals[1] === 'decide' && /^UPI-\d{3,}$/u.test(positionals[2] ?? '') && positionals.length === 3
    && options['work-id'] === value.contract.workId;
  if (mode === 'decision-only') return !value.decisionEnded && positionals[0] === 'decision'
    && DECIDE_SKILL_MUTATIONS.includes(positionals[1]) && positionals.length <= 3
    && (!positionals[2] || positionals[2] === value.contract.workId)
    && (!options['work-id'] || options['work-id'] === value.contract.workId);
  if (mode === 'session-only') return ['session', 'agent', 'resume'].includes(positionals[0])
    || positionals[0] === 'workspace' && ['use', 'switch'].includes(positionals[1]);
  if (mode === 'read-only-review') return positionals[0] === 'review-source'
    && ['stage', 'check', 'submit'].includes(positionals[1]) && positionals[2] === value.contract.phaseId
    && (!options['work-id'] || options['work-id'] === value.contract.workId);
  // The combined form publishes only the command its own prepublish returns, for the same phase.
  if (mode === 'publish-only') return positionals[0] === 'phase'
    && (positionals[1] === 'publish' || positionals[1] === 'prepublish' && options['publish-if-ready'] === true)
    && positionals[2] === value.contract.phaseId && (!options['work-id'] || options['work-id'] === value.contract.workId);
  // The /sf-import-team turn: its own three commands; every other mutation stays refused.
  if (mode === 'import-team') return positionals[0] === 'workflow' && positionals[1] === 'import-team'
    && IMPORT_TEAM_COMMANDS.includes(positionals[2]) && positionals.length === 3;
  if (mode === 'read') return false;
  // Deciding an upstream issue is the earlier step's approvers' call, like approve and reject; an
  // agent may raise one and keep working, never decide it.
  if (positionals[0] === 'upstream-issue' && UPSTREAM_ISSUE_DECISIONS.includes(positionals[1])) return false;
  // Accepting that a step's tests cannot run here is its approvers' call too; the refusal names it.
  if (positionals[0] === 'decision' && positionals[1] === 'test-risk') return false;
  if (positionals[0] === 'spec' && positionals[1] === 'drift' && positionals[2] === 'decide') return false;
  return !['approve', 'reject'].includes(positionals[0]);
}

/** A verified `upstream-issue decide`: an approver's decision, never an agent's. */
function upstreamIssueDecision(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseArgs(safe.argv);
  return positionals[0] === 'upstream-issue' && UPSTREAM_ISSUE_DECISIONS.includes(positionals[1]);
}

/**
 * A verified `decision test-risk` or `spec drift decide`: a step approver's decision, that its tests
 * cannot run here or how a closed Story's drifted clause is resolved.
 */
function testRunRiskDecision(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseArgs(safe.argv);
  return (positionals[0] === 'decision' && positionals[1] === 'test-risk')
    || (positionals[0] === 'spec' && positionals[1] === 'drift' && positionals[2] === 'decide');
}

function mentionsKernelExecution(call, value) {
  const command = scopedShellCommand(call, value) ?? call.args.command ?? call.args.cmd ?? call.args.script ?? '';
  // A directory or file prefixed with sflow/singularity-flow is not a CLI invocation.
  // Match a complete executable token, not a word boundary inside a literal path.
  // Keep rejecting unverified wrappers, substitutions and executable paths; never grant kernel authority
  // to a raw shell. Its file mutations still undergo the normal before/after path checks.
  return /\b(?:singularity-flow|sflow)(?:\.(?:exe|cmd|bat))?(?=$|[\s'";&|`$<>()])/iu.test(command);
}

function bootstrapAllowed(call, record) {
  if (shellAllowed(call, 'read', record)) return true;
  const mode = mutationTurnMode(record.skill);
  // Before a Story is bound there is no decision to record, so /sf-decide gets reads only here.
  if (mode === 'session-only') return shellAllowed(call, mode, record);
  // Repository setup has no Story yet. Its registered CLI operations retain their existing
  // configuration authority and confirmations; this exception never authorizes file tools.
  const setup = ['admin', 'init', 'configuration', 'workflows', 'workflow-rules', 'skills', 'instructions',
    'capability-map', 'workspace', 'worldmodel', 'start', 'test-setup'];
  const name = record.skill?.replace(/^\/?(?:sf|sflow)-/u, '');
  const command = scopedShellCommand(call, record) ?? '';
  return setup.includes(name) && /^\s*(?:singularity-flow|sflow)\s+(?:workspace|configuration|workflow|skill|instruction|capability|init|precheck|wm|start|test-policy)\b/u.test(command)
    && shellAllowed(call, 'kernel-only', record);
}

async function currentContract(payload, record) {
  const value = await boundedRecord(recordFile(payload));
  if (record.corrupt || !value.contract || value.turnId !== record.turnId || value.sessionId !== record.sessionId
      || !Number.isFinite(record.recordedAt) || Date.now() < record.recordedAt
      || Date.now() - record.recordedAt > MAX_AGE) throw new Error('Missing or expired contract');
  if (digest(await readFile(value.binding.workflowFile)) !== value.binding.workflowSha256) throw new Error('Phase changed; refresh contract');
  for (const stamp of value.binding.stamps) {
    if (digest(await readFile(stamp.file).catch(error => { if (error.code === 'ENOENT') return ''; throw error; })) !== stamp.sha256) throw new Error('Checkout identity changed; refresh contract');
  }
  return value;
}

/** The turn record of a live /sf-import-team turn, or null when it ended, expired or is corrupt. */
async function importTeamTurn(payload, record) {
  const value = await boundedRecord(recordFile(payload)).catch(() => null);
  if (!value || record.corrupt || value.turnId !== record.turnId || value.sessionId !== record.sessionId
      || !Number.isFinite(record.recordedAt) || Date.now() < record.recordedAt
      || Date.now() - record.recordedAt > MAX_AGE) return null;
  return value;
}

function editTarget(target, cwd) {
  try { return path.resolve(cwd, target.startsWith('file:') ? fileURLToPath(target) : target); }
  catch { return null; }
}

/**
 * /sf-import-team: reads, its own `workflow import-team` commands, and edits to exactly the
 * candidate files `workflow import-team inspect` issued to this turn. It needs no Story and grants
 * nothing a bound Story's contract would: no repository edits, no other kernel mutations, no
 * delegation.
 */
async function importTeamGuard(payload, record, toolCalls) {
  const value = await importTeamTurn(payload, record);
  const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot };
  const issued = (value?.importTeamStaging ?? []).map(file => path.resolve(file));
  const deny = reason => ({ permissionDecision: 'deny', next: [], permissionDecisionReason: reason });
  for (const call of toolCalls) {
    if (DELEGATION.has(call.name)) {
      return deny('IMPORT_TEAM_DELEGATION_NOT_ALLOWED: convert the team directory in this turn; /sf-import-team does not delegate');
    }
    if (TERMINALS.has(call.name)) {
      if (shellAllowed(call, 'import-team', scope)) continue;
      return deny('IMPORT_TEAM_OPERATION_NOT_ALLOWED: run one standalone read command or singularity-flow workflow import-team inspect|compile|status; no other mutations, chains or wrappers');
    }
    if (!isEdit(call.name)) continue;
    const paths = targets(call.args);
    const cwd = call.args.cwd ?? payload.cwd ?? scope.repositoryRoot ?? process.cwd();
    const outside = paths.filter(target => !issued.includes(editTarget(target, cwd)));
    if (paths.length && !outside.length) continue;
    return deny(issued.length
      ? `IMPORT_TEAM_PATH_DENIED (${outside.join(', ') || 'no target'}): write only the issued candidate file at exactly ${issued.join(', ')}; never the source directory, a repository or the bundle`
      : 'IMPORT_TEAM_PATH_DENIED: no candidate file is issued to this turn. Run singularity-flow workflow import-team inspect first and write only the path it returns');
  }
  return {};
}

/**
 * A shell command that reads the host's own saved copy of a long tool result. The host keeps it
 * outside the workspace, so the agent's file tools cannot open it, and an agent reached for `jq` on
 * it in a turn that runs only SFlow commands. The SFlow result itself, run again as an agent view,
 * is bounded and names its complete copy inside the repository.
 */
export function readsHostSavedOutput(call) {
  const command = String(call?.args?.command ?? call?.args?.cmd ?? call?.args?.script ?? '');
  return /copilot-tool-output|[\\/]tool-output-[^\s'"]*\.txt/iu.test(command);
}

const HOST_SAVED_OUTPUT_DENIAL = 'PHASE_MUTATION_TOOL_PROTOCOL: that file is the host\'s saved copy of a long result, outside the workspace; do not read it with shell tools. Run the same SFlow command again, standalone, with --for-agent --json: its result starts with act, fits the host, and names the complete copy inside the repository (agentOutput.path) for your file-read tool. This refusal does not invalidate the phase or require repeating clarification';

export async function mutationToolGuard(payload = {}) {
  const record = await turn(payload);
  if (!record) return {};
  const toolCalls = calls(payload);
  if (!toolCalls.some(call => TERMINALS.has(call.name) || DELEGATION.has(call.name) || isEdit(call.name))) return {};
  if (mutationTurnMode(record.skill) === 'import-team') return importTeamGuard(payload, record, toolCalls);
  let value;
  try { value = await currentContract(payload, record); }
  catch {
    // Explicit setup/diagnostics can rebuild the contract, but a missing cache never authorizes edits.
    const cached = await boundedRecord(recordFile(payload)).catch(() => null);
    const bootstrap = { ...record, repositoryRoot: cached?.contract?.repositoryRoot ?? cached?.repositoryRoot };
    if (toolCalls.every(call => TERMINALS.has(call.name) && bootstrapAllowed(call, bootstrap))) return {};
    return mutationDenial(null, 'PHASE_MUTATION_CONTRACT_REQUIRED: refresh the exact binding; expired/corrupt permissions require a new explicit turn; do not discard work');
  }
  const contract = value.contract;
  value.skill = record.skill;
  for (const call of toolCalls) {
    if (DELEGATION.has(call.name) && contract.turnMode !== 'authoring') return mutationDenial(contract, 'PHASE_MUTATION_DELEGATION_NOT_ALLOWED');
    if (TERMINALS.has(call.name)) {
      const kernel = shellAllowed(call, contract.turnMode, value);
      if (!kernel && value.findings.length) return mutationDenial({ ...contract, next: recoveryRoutes(contract) }, 'PHASE_MUTATION_REPAIR_REQUIRED');
      if (!kernel) {
        if (testRunRiskDecision(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: accepting that a step\'s tests cannot run here, or how a closed Story\'s drifted clause is resolved, is decided by a person who approves that step, in their own terminal, not by this turn. Show the user the command and stop; do not retry it');
        if (contract.turnMode !== 'authoring' && verifiedShellForm(call, value)) {
          return mutationDenial(contract, value.decisionEnded
            ? 'PHASE_MUTATION_DECISION_TURN_ENDED: the decision turn has ended. Preserve work and inspect the returned next action in a new turn; correcting command syntax cannot reopen approval'
            : 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: this standalone command is not permitted by the bound turn mode. Preserve work and follow the exact returned action; tool-form repair does not grant authoring or decision authority');
        }
        if (contract.turnMode !== 'authoring' && readsHostSavedOutput(call)) return mutationDenial(contract, HOST_SAVED_OUTPUT_DENIAL);
        if (contract.turnMode !== 'authoring')
          return mutationDenial(contract, 'PHASE_MUTATION_TOOL_PROTOCOL: use native file-read tools for output; write only exact issued staging files with a file-edit tool (source review also supports review-source stage --report-json). Run permitted SFlow commands standalone with the bound cwd. Correct the tool form in this turn; this refusal does not invalidate the phase or require repeating clarification');
        if (upstreamIssueDecision(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: an upstream issue or amendment is decided by the earlier step\'s approvers in their own terminal, not by this turn. Keep working; the Story completes once they decide it');
        if (mentionsKernelExecution(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED: run one standalone registered SFlow command; no chains or wrappers. Use a file-edit tool for the exact issued staging file. Preserve human answers and repair recording, not the questions');
      }
      // Baseline BEFORE execution, refreshed after kernel-owned operations at the CLI boundary.
      if (!kernel && !value.baseline) {
        value.baseline = await shellSnapshot(contract.repositoryRoot);
        await atomicRecord(recordFile(payload), value);
      }
      continue;
    }
    if (!isEdit(call.name)) continue;
    if (value.findings.length) return mutationDenial({ ...contract, next: recoveryRoutes(contract) },
      'PHASE_MUTATION_REPAIR_REQUIRED: this turn detected forbidden shell changes; preserve bytes and inspect recovery');
    const paths = targets(call.args);
    if (!paths.length) return mutationDenial(contract, 'PHASE_MUTATION_TARGET_UNKNOWN');
    const denied = paths.filter(target => !mutationPathDecision(contract, target, call.args.cwd ?? payload.cwd ?? contract.repositoryRoot).allowed);
    // An author that rebuilt an issued staging path (a linked worktree keeps it under the main
    // repository's .git/worktrees, not the worktree) was refused with only the phase's routes and
    // stopped. Name the exact issued file so it corrects the target in this turn; never grant it.
    const issued = (contract.allow.staging ?? []).filter(file => denied.some(target => path.basename(target) === path.basename(file)));
    if (issued.length) return { permissionDecision: 'deny', next: [], permissionDecisionReason:
      `PHASE_MUTATION_STAGING_PATH_MISMATCH (${denied.join(', ')}): write the issued staging file at exactly ${issued.join(', ')}. `
      + 'Copy the path from the entry; do not rebuild it from the worktree. Correct the target in this turn; the human replies stay valid and need not be asked again.' };
    if (denied.length) return mutationDenial(contract, 'PHASE_MUTATION_PATH_DENIED', denied);
  }
  return {};
}

async function shellSnapshot(root) {
  const { worktreeFingerprint } = await import('./worktree-fingerprint.mjs');
  const fingerprint = worktreeFingerprint(root, { fresh: true, includeManifest: true });
  return { headTree: fingerprint.headTree, indexTree: fingerprint.indexTree, files: fingerprint.fileDigests };
}

export async function mutationPostToolGuard(payload = {}) {
  const record = await turn(payload);
  const terminals = calls(payload).filter(call => TERMINALS.has(call.name));
  if (!record || !terminals.length) return {};
  // A turn with no Story contract has no baseline to compare and nothing to go stale: its pre-tool
  // guard admitted only verified commands (import-team's own three and reads; setup and session
  // kernel commands before a Story is bound). Telling it to stop and refresh a binding it never had
  // ended a live /sf-import-team turn after its first command.
  if (mutationTurnMode(record.skill) === 'import-team') {
    const value = await importTeamTurn(payload, record);
    const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot };
    if (value && terminals.every(call => shellAllowed(call, 'import-team', scope))) return {};
    return postFinding(mutationDenial(null, 'IMPORT_TEAM_TURN_ENDED: the import-team turn ended or expired; run /sf-import-team again'));
  }
  let value;
  try { value = await currentContract(payload, record); }
  catch {
    const cached = await boundedRecord(recordFile(payload)).catch(() => null);
    if (cached && cached.contract === null && !record.corrupt
        && terminals.every(call => bootstrapAllowed(call, { ...record, repositoryRoot: cached.repositoryRoot }))) return {};
    return postFinding(mutationDenial(null, 'PHASE_MUTATION_CONTRACT_STALE: preserve changes and refresh the binding'));
  }
  if (!value.baseline) {
    if (calls(payload).every(call => shellAllowed(call, value.contract.turnMode, value))) return {};
    return postFinding(mutationDenial(value.contract, 'PHASE_MUTATION_BASELINE_UNAVAILABLE: detection cannot establish which command changed bytes'));
  }
  const after = await shellSnapshot(value.contract.repositoryRoot);
  const changed = [...new Set([...Object.keys(value.baseline.files), ...Object.keys(after.files)])]
    .filter(file => value.baseline.files[file] !== after.files[file]);
  const forbidden = changed.filter(file => !mutationPathDecision(value.contract, file, value.contract.repositoryRoot).allowed);
  if (value.baseline.headTree !== after.headTree || value.baseline.indexTree !== after.indexTree) forbidden.push('[HEAD/index changed outside a recorded kernel operation]');
  if (forbidden.length) {
    value.findings = [...new Set([...value.findings, ...forbidden])];
    await atomicRecord(recordFile(payload), value);
    const denial = mutationDenial({ ...value.contract, next: recoveryRoutes(value.contract) }, 'PHASE_MUTATION_SHELL_CHANGE_DETECTED: preserve bytes; stop authoring and inspect recovery', forbidden);
    return postFinding(denial);
  }
  value.baseline = after;
  await atomicRecord(recordFile(payload), value);
  return {};
}

function postFinding(denial) {
  // Config-file postToolUse supports additionalContext, not permissionDecision/continue.
  // The next pre-tool guard latches the file/shell restriction; this cannot undo execution.
  return { ...denial, continue: false, stopReason: denial.permissionDecisionReason,
    additionalContext: `Stop this SFlow authoring turn and preserve changes. ${denial.permissionDecisionReason}` };
}

function recoveryRoutes(contract) {
  return [safeCommandGuidance({ argv: ['recover', contract.workId, '--phase', contract.phaseId, '--json'] })];
}

/** Cache refresh is a best-effort tail, never a reason to retry a successful mutation. */
/** Whether a record was derived from the Story file and the checkout's HEAD/ref files as they are now. */
async function bindingCurrent(value) {
  try {
    if (!value?.contract || !value.binding?.workflowFile) return false;
    if (digest(await readFile(value.binding.workflowFile)) !== value.binding.workflowSha256) return false;
    for (const stamp of value.binding.stamps ?? []) {
      const bytes = await readFile(stamp.file).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      if (digest(bytes) !== stamp.sha256) return false;
    }
    return true;
  } catch { return false; }
}

export async function refreshMutationContracts(root, accepted = null, { decisionEnded = false, advanceBaseline = false } = {}) {
  if (readCopilotMode().paused || !root) return;
  root = await realpath(root);
  const names = await readdir(directory()).catch(() => []);
  const entries = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if ((value?.contract?.repositoryRoot ?? value?.repositoryRoot) === path.resolve(root)) entries.push({ file, value });
  }
  if (!entries.length) return;
  // Only live turns are rebuilt; a record left by an ended chat is not. When every live record was
  // derived from the Story file and HEAD/ref files as they are now, rebuilding gives the same records:
  // after a read-only command this reloaded the whole Story for nothing, about five seconds on a
  // Windows machine. A decision ending or a shell baseline advancing still rebuilds.
  const live = [];
  for (const entry of entries) {
    const record = await turn({ sessionId: entry.value.sessionId });
    if (record && record.turnId === entry.value.turnId) live.push({ ...entry, record });
  }
  if (!live.length) return;
  if (!decisionEnded && !advanceBaseline
      && (await Promise.all(live.map(({ value }) => bindingCurrent(value)))).every(Boolean)) return;
  accepted ??= await loadStory(root);
  for (const { file, value, record } of live) {
    const payload = { sessionId: value.sessionId };
    const next = await createRecord(payload, record, root, accepted, value);
    if (decisionEnded && ['approval-only', 'review-decision-only'].includes(next.contract.turnMode)) next.decisionEnded = true;
    if (value.baseline && advanceBaseline) next.baseline = await shellSnapshot(root);
    await atomicRecord(file, next);
  }
}

/**
 * Failed decisions end approval-only turns even when accepted-state reloading fails.
 *
 * A failed workflow decision (`decision choose` and its siblings) ends only /sf-decide turns, whose
 * skill says any refusal ends the turn; it never ends an unrelated approval turn.
 */
export async function endMutationDecisionTurns(root, { modes = ['approval-only', 'review-decision-only'] } = {}) {
  if (readCopilotMode().paused || !root) return;
  root = await realpath(root);
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if ((value?.contract?.repositoryRoot ?? value?.repositoryRoot) !== root
        || !modes.includes(mutationTurnMode(value.skill))) continue;
    value.decisionEnded = true;
    await atomicRecord(file, value);
  }
}

export async function issueMutationStaging(root, target, purpose) {
  root = await realpath(root);
  const names = await readdir(directory()).catch(() => []);
  for (const name of names.filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if (value?.contract?.repositoryRoot !== path.resolve(root)) continue;
    const expectedMode = purpose === 'source-review' ? 'read-only-review' : 'authoring';
    if (value.contract.turnMode !== expectedMode) continue;
    value.contract.allow.staging = [...new Set([...value.contract.allow.staging, path.resolve(target)])];
    // The kernel prepares only the exact issued private file's parents. Review turns cannot
    // use arbitrary shell mkdir, and parent directories are not additional edit permissions.
    if (!mutationPathDecision(value.contract, target, root).allowed) throw new Error('Unsafe private staging target');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await atomicRecord(file, value);
  }
}

/**
 * Let live /sf-import-team turns edit `target`, the candidate file `workflow import-team inspect`
 * just issued. The CLI cannot tell which chat ran it, so every live import-team turn for the same
 * repository (or with none) receives the exact path; each is a fresh session's unguessable file
 * and admits that one file only. Returns how many turns received it.
 */
export async function issueImportTeamStaging(target, { root = null } = {}) {
  if (readCopilotMode().paused) return 0;
  const resolvedRoot = root ? await realpath(root).catch(() => path.resolve(root)) : null;
  let issued = 0;
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if (!value || mutationTurnMode(value.skill) !== 'import-team') continue;
    const record = await turn({ sessionId: value.sessionId });
    if (!record || !await importTeamTurn({ sessionId: value.sessionId }, record)) continue;
    const owner = value.contract?.repositoryRoot ?? value.repositoryRoot ?? null;
    if (owner && resolvedRoot && owner !== resolvedRoot) continue;
    // Bounded: a long conversation keeps its latest candidates, never an unbounded grant list.
    value.importTeamStaging = [...new Set([...(value.importTeamStaging ?? []), path.resolve(target)])].slice(-16);
    await atomicRecord(file, value);
    issued += 1;
  }
  return issued;
}

export async function mutationGuardDiagnostics(root) {
  root = await realpath(root);
  const names = await readdir(directory()).catch(() => []);
  const active = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const value = await boundedRecord(path.join(directory(), name)).catch(() => null);
    if (value?.contract?.repositoryRoot === path.resolve(root)) active.push({
      phase: value.contract.phaseId, turnMode: value.contract.turnMode,
      findings: value.findings ?? [], expired: Date.now() - value.recordedAt > MAX_AGE });
  }
  return { edits: 'host-qualification-required', shell: 'detected-when-postToolUse-runs', sandbox: false, active,
    detail: 'A hook file is not runtime proof. Unsupported hosts retain lifecycle detection; native and paused turns are unchanged.' };
}
