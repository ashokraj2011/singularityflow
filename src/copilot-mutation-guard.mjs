/** Explicit-turn interception. Ordinary chat/pause never loads Story policy. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
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
    && !['approval-only', 'session-only'].includes(requestedMode) ? 'read' : requestedMode;
  const contract = deriveMutationContract({ root, definition, workflow, turnMode: mode });
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
    baseline: previous?.baseline ?? null, findings: previous?.findings ?? [] };
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
  if (mode === 'publish-only') return positionals[0] === 'phase' && positionals[1] === 'publish'
    && positionals[2] === value.contract.phaseId && (!options['work-id'] || options['work-id'] === value.contract.workId);
  if (mode === 'read') return false;
  // Deciding an upstream issue is the earlier step's approvers' call, like approve and reject; an
  // agent may raise one and keep working, never decide it.
  if (positionals[0] === 'upstream-issue' && UPSTREAM_ISSUE_DECISIONS.includes(positionals[1])) return false;
  return !['approve', 'reject'].includes(positionals[0]);
}

/** A verified `upstream-issue decide`: an approver's decision, never an agent's. */
function upstreamIssueDecision(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseArgs(safe.argv);
  return positionals[0] === 'upstream-issue' && UPSTREAM_ISSUE_DECISIONS.includes(positionals[1]);
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

export async function mutationToolGuard(payload = {}) {
  const record = await turn(payload);
  if (!record) return {};
  const toolCalls = calls(payload);
  if (!toolCalls.some(call => TERMINALS.has(call.name) || DELEGATION.has(call.name) || isEdit(call.name))) return {};
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
        if (contract.turnMode !== 'authoring' && verifiedShellForm(call, value)) {
          return mutationDenial(contract, value.decisionEnded
            ? 'PHASE_MUTATION_DECISION_TURN_ENDED: the decision turn has ended. Preserve work and inspect the returned next action in a new turn; correcting command syntax cannot reopen approval'
            : 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: this standalone command is not permitted by the bound turn mode. Preserve work and follow the exact returned action; tool-form repair does not grant authoring or decision authority');
        }
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
  if (!record || !calls(payload).some(call => TERMINALS.has(call.name))) return {};
  let value;
  try { value = await currentContract(payload, record); }
  catch { return postFinding(mutationDenial(null, 'PHASE_MUTATION_CONTRACT_STALE: preserve changes and refresh the binding')); }
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
  accepted ??= await loadStory(root);
  for (const { file, value } of entries) {
    const payload = { sessionId: value.sessionId };
    const record = await turn(payload);
    if (!record || record.turnId !== value.turnId) continue;
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
