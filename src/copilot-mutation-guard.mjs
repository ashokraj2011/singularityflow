/** Explicit-turn interception. Ordinary chat/pause never loads Story policy. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { COMMAND_PRESENTATION_CONTRACT, formatCommandRouteLines } from './model-free-commands.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deriveMutationContract, mutationContractPresentation, mutationDenial, mutationPathDecision, mutationTurnMode } from './phase-mutation-contract.mjs';
import { asSflowCommand, copilotModeFile, mentionsHookCli, readCopilotMode } from './copilot-mode.mjs';
// The guard runs on every tool call: the staging-path helper loads only when a turn's record is built
// or a staging refusal is written, never on the per-call path.
const stagingPaths = () => import('./phase-staging-paths.mjs');
import { parseArgs } from './util.mjs';
import { AGENT_OUTPUT_FOLDER, lineRanges, READ_CHUNK_BYTES } from './agent-output-folder.mjs';
import { canonicalCommand, resolveOperation } from './command-registry.mjs';
import { DECISION_LIST_CHAT_OPTIONS, liveTerminalReviewStep, planRowCorrectionStep } from './command-skills.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { CLI_PATH_REFERENCE, safeCommandGuidance, validateSflowExecutionCommand } from './safe-command-guidance.mjs';

const MAX_AGE = 30 * 60 * 1000;

/** Whether this explicit turn's permissions have lapsed (MAX_AGE from its prompt). */
function turnExpired(record) {
  return Number.isFinite(record?.recordedAt) && Date.now() - record.recordedAt > MAX_AGE;
}

/**
 * An expired turn says so, with the one thing that renews it: invoking its skill again. Shell commands
 * never renew a Copilot turn, and the issuers skip expired turns, so routing to one would loop.
 */
function turnExpiredDenial(record) {
  const skill = `/sf-${String(record?.skill ?? 'phase').replace(/^\/?(?:sf|sflow)-/u, '')}`;
  return { permissionDecision: 'deny', next: [], permissionDecisionReason:
    `PHASE_MUTATION_TURN_EXPIRED: this turn's permissions last ${MAX_AGE / 60000} minutes from its prompt and have ended; nothing was written. `
    + `Invoke ${skill} again to continue: the new turn enters again and keeps everything already written. `
    + `No Shell command renews a Copilot turn.\n\n${formatCommandRouteLines({ copilotCommand: skill }).join('\n')}` };
}

/**
 * The draft file a refused propose command names, when nothing of its kind is issued to this turn and
 * that is the only thing wrong: the same command passes with that file issued. Its issuer issues the same file
 * again, unchanged, so the refusal can name it.
 */
function unissuedDraftOption(call, scope, mode, field, pick) {
  // With a draft already issued to this turn, a different file is a mismatch the ordinary refusal
  // covers; the issuer would issue that same draft again, not the file named.
  if ((scope[field] ?? []).length) return null;
  const safe = verifiedShellForm(call, scope);
  if (!safe) return null;
  const { positionals, options } = parseCli(safe.argv);
  const file = pick(positionals, options);
  if (typeof file !== 'string' || !path.isAbsolute(file) || (scope[field] ?? []).includes(path.resolve(file))) return null;
  return shellAllowed(call, mode, { ...scope, [field]: [...(scope[field] ?? []), path.resolve(file)] }) ? file : null;
}
const TERMINALS = new Set(['bash', 'powershell', 'run_in_terminal', 'execute', 'exec_command', 'write_stdin']);
const FILE_READS = new Set(['read', 'read_file', 'readfile', 'read_text_file', 'view', 'get_file']);
const DECIDE_SKILL_MUTATIONS = Object.freeze(['choose', 'applicability', 'scope', 'completeness', 'plan']);
// An agent may raise an issue or propose an amendment; only an approver decides or revalidates.
const UPSTREAM_ISSUE_DECISIONS = Object.freeze(['decide', 'decide-amendment', 'revalidate']);
// The decision list's options that write only upstream-issue records (ISSUE_ONLY_OPTIONS in
// src/decision-list.mjs; a test pins the two equal). A /sf-decide turn may record only these; the
// routes read the same list (command-skills.mjs), so no surface sends another choice to that turn.
export { DECISION_LIST_CHAT_OPTIONS };
const DELEGATION = new Set(['task', 'spawn_agent', 'write_agent', 'delegate', 'run_subagent']);
const IMPORT_TEAM_COMMANDS = Object.freeze(['inspect', 'compile', 'status']);
/**
 * Skills whose own steps write exact files an SFlow command issued to this turn, which another of their
 * commands then consumes. `initiative`: an Epic or Initiative step's authored outputs, issued by
 * `initiative phase` (which `epic requirements|planning prepare` run) and `initiative phase draft-check`
 * and published from where they are by `initiative phase publish`; the Epic skills also get one
 * Git-private source-text draft, named in their turn's rules, for `epic sources note|answer --text-file`.
 * `repair`: the patch file `repair authorize|status` names for /sf-fix's `repair attempt --patch`.
 * Each grant is one exact file, never a directory or another repository file.
 */
const DRAFT_SKILLS = Object.freeze({ 'epic-story-draft': 'initiative', 'epic-planning': 'initiative',
  'epic-requirements': 'initiative', 'initiative-phase': 'initiative', fix: 'repair' });
const SOURCE_TEXT_SKILLS = Object.freeze(['epic-story-draft', 'epic-planning', 'epic-requirements']);
const skillName = skill => String(skill ?? '').replace(/^\/?(?:sf|sflow)-/u, '');
const draftKind = skill => DRAFT_SKILLS[skillName(skill)] ?? null;
/** The Epic source-text draft beside the checkout's Git data, for `epic sources note|answer --text-file`. */
export function epicSourceTextDraftPath(gitDirectory) {
  return path.join(gitDirectory, 'singularity-flow', 'epic-source-drafts', 'source-text.md');
}
async function derivedDraftStaging(skill, gitDirectory) {
  if (!gitDirectory || !SOURCE_TEXT_SKILLS.includes(skillName(skill))) return [];
  const draft = epicSourceTextDraftPath(gitDirectory);
  // The kernel prepares only this file's parent; the parent grants no edits.
  await mkdir(path.dirname(draft), { recursive: true, mode: 0o700 }).catch(() => {});
  return [draft];
}
const sourceTextRule = files => files.length
  ? ` Write an Epic source note or answer only at the issued file ${files[0]}, for epic sources note|answer --text-file.` : '';
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
async function boundedRecord(file, kind = 'copilot-mutation-contract') {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Unsafe mutation record');
  const value = JSON.parse(await readFile(file, 'utf8'));
  const { integritySha256, ...content } = value;
  if (value.kind !== kind || integritySha256 !== digest(JSON.stringify(content))) throw new Error('Corrupt mutation record');
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
    && !['approval-only', 'session-only', 'import-team', 'build-workflow', 'fix-workflow', 'run-and-test'].includes(requestedMode) ? 'read' : requestedMode;
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
  // The step's own staging files follow from the pinned contract, so every turn bound to this step
  // may write them: also a turn after an interrupted one, or a new chat (SPEC-STAGING-PERMISSIONS D1).
  // Each is one exact file that must pass the same checks as an issued one; nothing else widens.
  const derived = (await stagingPaths()).phaseStagingPaths({ gitDirectory: gitIdentity.gitDir, definition, workflow, phase, turnMode: mode,
    skill: record.skill }).map(file => path.resolve(file));
  contract.allow.staging = [...new Set([...derived, ...(samePhase ? previous.contract.allow.staging : [])])];
  for (const file of derived) {
    if (!mutationPathDecision(contract, file, root).allowed) {
      contract.allow.staging = contract.allow.staging.filter(entry => entry !== file);
      continue;
    }
    // The kernel prepares only this file's parent, as issuance does; the parent grants no edits.
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(() => {});
  }
  // The one file a /sf-reject turn may write is named in its rules, so the draft lands there.
  if (mode === 'approval-only' && contract.allow.staging.length) {
    contract.summary = `${contract.summary} Draft an intent amendment only at the issued file ${contract.allow.staging.join(', ')}, for story intent-amendment propose --file.`;
  }
  const sourceText = await derivedDraftStaging(record.skill, gitIdentity.gitDir);
  contract.summary += sourceTextRule(sourceText);
  const draftStaging = [...new Set([...sourceText, ...(previous?.draftStaging ?? [])])];
  const value = { schemaVersion: currentSchemaVersion('copilot-mutation-contract'), kind: 'copilot-mutation-contract',
    turnId: record.turnId, sessionId: record.sessionId, skill: record.skill, recordedAt: record.recordedAt,
    modeChangedAt: record.modeChangedAt, contract,
    originPhase: previous?.originPhase ?? contract.phaseId,
    // The generation this turn's edits belong to, when one is open; XPL2 observed writes name it.
    openGeneration: phase?.generationIntent?.status === 'open' ? phase.generationIntent.generation ?? null : null,
    decisionEnded: previous?.decisionEnded ?? false,
    binding: { workflowFile, workflowSha256: digest(await readFile(workflowFile)), ...gitIdentity },
    baseline: previous?.baseline ?? null, findings: previous?.findings ?? [],
    ...(record.confirmDigest ? { confirmDigest: record.confirmDigest } : {}),
    ...(previous?.importTeamStaging ? { importTeamStaging: previous.importTeamStaging } : {}),
    ...(previous?.buildStaging ? { buildStaging: previous.buildStaging } : {}),
    ...(previous?.fixStaging ? { fixStaging: previous.fixStaging } : {}),
    ...(previous?.appDraftStaging ? { appDraftStaging: previous.appDraftStaging } : {}),
    ...(draftStaging.length ? { draftStaging } : {}),
    // Which turn rules this conversation already has: a refreshed contract does not take them back.
    ...(previous?.contextDigest ? { contextDigest: previous.contextDigest } : {}) };
  return value;
}

/**
 * A prompt's context in two parts. `[OUT:REQ-032]` The volatile part names this turn (skill, mode,
 * Story, step, readiness, prerequisite) in at most 400 bytes. The stable part is the turn's rules: sent
 * whole when they differ from the rules this conversation was last given, otherwise named by digest.
 * Recorded prompts carried 0.8 KB (up to 1.9 KB) each, the full path rule included, beside a skill
 * that states it once already (2026-10-18 to 10-22).
 */
export function turnBoundaryContext(value, presented = mutationContractPresentation(value.contract)) {
  const { contract } = value;
  const volatile = [
    `SFlow turn boundary (${value.skill}): ${contract.turnMode} turn, ${contract.workId ?? 'no Story'} step ${contract.phaseId ?? 'none'} generation ${contract.generation ?? 'none'}.`,
    contract.authoringSkill ? `Step author: ${contract.authoringSkill}.` : null,
    contract.policy?.requiresOpenGeneration ? `Code authoring ready: ${presented.codeAuthoringReady}.` : null,
    presented.sourceEditPrerequisite ? `Before source edits: ${presented.sourceEditPrerequisite.command}.` : null
  ].filter(Boolean).join(' ');
  const stable = [
    COMMAND_PRESENTATION_CONTRACT,
    presented.summary,
    CLI_PATH_REFERENCE,
    presented.toolProtocol.terminal,
    presented.toolProtocol.localVerification.allowed ? presented.toolProtocol.localVerification.guidance : null,
    'Binding readiness is not source-edit permission.',
    presented.sourceEditPrerequisite
      ? 'After the "Before source edits" operation, re-enter the phase to verify fresh permissions; never auto-adopt or discard edits.' : null,
    // Never a stop: every kernel skill (/sf-submit, /sf-next…) gets this line, and "return the
    // authoring skill and stop" ended those turns before their own steps ran (2026-10-26).
    contract.turnMode === 'kernel-only'
      ? 'Carry out the invoked skill\'s steps in this turn. Never inline an authoring skill or edit files here; the step author drafts when the human invokes it.' : null
  ].filter(Boolean).join(' ');
  return { volatile, stable, digest: `sha256:${digest(stable).slice(0, 16)}` };
}

/** The additionalContext text: the stable rules whole, or by digest when this conversation has them. */
export function turnBoundaryText(context, previous = null) {
  return previous === context.digest
    ? `${context.volatile} Turn rules unchanged (${context.digest}): given in full earlier in this conversation.`
    : `${context.volatile} ${context.stable} Turn rules ${context.digest}.`;
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
    // The rules this conversation was last given, from its previous explicit turn's record. A native
    // prompt in between removes that record, so its rules are sent whole again.
    const earlier = await boundedRecord(file).catch(() => null);
    const value = await createRecord(payload, record, root, await load(root));
    const context = turnBoundaryContext(value);
    const given = earlier?.sessionId === record.sessionId && earlier.modeChangedAt === record.modeChangedAt
      ? earlier.contextDigest ?? null : null;
    await rm(`${file}.issued`, { recursive: true, force: true }).catch(() => {});
    // One content-bound baseline, not a path/status-only baseline. It is deliberately lazy:
    // edit-tool interception needs no Git process; post-shell detection records its own baseline.
    await atomicRecord(file, { ...value, contextDigest: context.digest });
    // A verified native Copilot turn may be rooted in the canonical workspace while its Story
    // lives in a linked checkout. Tell only that launch folder's window, never every open window.
    const follow = await import('./copilot-story-follow.mjs');
    if (follow.copilotStoryFollowSkill(record.skill)) {
      const copilot = await (await import('./session.mjs')).loadCopilotSession(root).catch(() => null);
      // An accepted checkout alone is not this conversation's selection. Do not follow another
      // chat's retained session, a branch candidate, or a workspace-only selection gate.
      if (copilot?.sessionId === record.sessionId && copilot.workId === value.contract.workId
          && copilot.workItemSelectionRequired === false) await follow.recordCopilotStoryFollow({
        originPath: payload.cwd, repositoryPath: root, workId: value.contract.workId
      }).catch(() => {});
    }
    return { additionalContext: turnBoundaryText(context, given) };
  } catch {
    // An Epic or Initiative checkout binds no Story: its drafting skills still write the files their
    // own SFlow commands issue, and the Epic skills one source-text draft, named here.
    const draftStaging = root && draftKind(record.skill)
      ? await import('./git.mjs').then(({ gitDir }) => derivedDraftStaging(record.skill, gitDir(root))).catch(() => []) : [];
    await atomicRecord(file, { schemaVersion: currentSchemaVersion('copilot-mutation-contract'), kind: 'copilot-mutation-contract',
      sessionId: record.sessionId, turnId: record.turnId, skill: record.skill, modeChangedAt: record.modeChangedAt,
      contract: null, repositoryRoot: root, recordedAt: record.recordedAt, ...(draftStaging.length ? { draftStaging } : {}) });
    if (root && draftKind(record.skill)) return { additionalContext: `SFlow turn boundary (${record.skill}): ${mutationTurnMode(record.skill)} turn, no Story. `
      + `Edit only the exact files this turn's SFlow commands issue (${draftKind(record.skill) === 'repair' ? 'the patch file repair authorize or repair status names'
        : 'the step outputs initiative phase prepare or draft-check returns'}); no other file.${sourceTextRule(draftStaging)} ${CLI_PATH_REFERENCE}` };
  }
}

export async function clearMutationTurn(payload) {
  const file = recordFile(payload);
  if (file) {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rm(`${file}.issued`, { recursive: true, force: true }).catch(() => {});
  }
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

/** A correction hint, never automatic retargeting or a broader private-directory grant. */
function stagingPathMismatch(contract, paths, cwd, operation, outputPaths = null) {
  const issued = outputPaths ?? contract.allow.staging ?? [];
  const corrections = [];
  for (const target of paths) {
    const absolute = editTarget(target, cwd);
    if (!absolute || issued.includes(absolute)) continue;
    const matches = issued.filter(file => {
      if (operation === 'write') return path.basename(absolute) === path.basename(file);
      // Reads are otherwise unrestricted by this mutation guard. Correct only an exact reserved
      // staging or output suffix rebuilt below this checkout, not arbitrary files sharing a basename.
      const issuedTail = issuedSuffix(file), tail = issuedSuffix(absolute);
      if (!issuedTail || !tail || issuedKey(issuedTail) !== issuedKey(tail)) return false;
      return [path.join(contract.repositoryRoot, tail), path.join(contract.repositoryRoot, '.git', tail)].includes(absolute);
    });
    if (matches.length === 1) corrections.push({ attemptedPath: target, issuedPath: matches[0], operation });
  }
  if (!corrections.length) return null;
  return { permissionDecision: 'deny', next: [], pathCorrections: corrections,
    permissionDecisionReason: `${outputPaths ? 'CLI_ISSUED_PATH_MISMATCH' : 'PHASE_MUTATION_STAGING_PATH_MISMATCH'}: ${corrections.map(entry =>
      `${operation === 'read' ? 'read' : 'write'} the issued ${outputPaths ? 'output' : 'staging'} file at exactly ${entry.issuedPath}.`).join(' ')} `
      + 'Copy the CLI-returned path verbatim; repositoryPath is command cwd, not a file prefix. Correct only the tool target in this turn; do not recreate or move files, restart the phase or repeat human questions. No operation was retargeted or executed.' };
}

const STAGING_ISSUERS = Object.freeze({
  clarification: { mode: 'authoring', argv: ['phase', 'enter', '--compose', '--for-agent', '--json'], skill: '/sf-phase',
    what: "the step author's clarification-response staging file" },
  'source-review': { mode: 'read-only-review', argv: ['review-source', 'context', '--for-agent', '--json'], skill: '/sf-review-source',
    what: "the source reviewer's report staging file" }
});

function sameDirectory(left, right) {
  const canonical = value => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  return Boolean(left && right) && canonical(left) === canonical(right);
}

/**
 * A write to a reserved Story staging file that this turn may not write is refused with what the file
 * is and the command that issues it, never the generic path denial whose route is the skill already
 * running (SPEC-STAGING-PERMISSIONS D2). A file this turn may write under another name is a correction.
 */
async function unissuedStagingRefusal(value, targetsDenied, cwd) {
  if (!targetsDenied.length) return null;
  const { stagingTargetPurpose } = await stagingPaths();
  const contract = value.contract;
  for (const target of targetsDenied) {
    const absolute = editTarget(target, cwd);
    const reserved = absolute ? stagingTargetPurpose(absolute) : null;
    if (!reserved) continue;
    // Only a file refused for where it is. A link, an unreadable ancestor or an invalid target keeps
    // the ordinary denial and its reason; it is never re-offered as the file to write.
    if (!['outside-bound-worktree', 'protected-path'].includes(mutationPathDecision(contract, target, cwd).reason)) continue;
    const issuer = STAGING_ISSUERS[reserved.purpose];
    const preserve = "Preserve the person's answers and any drafted content; do not repeat questions. No file was written.";
    if (!sameDirectory(reserved.gitDirectory, value.binding?.gitDir)) {
      return mutationDenial({ ...contract, next: [safeCommandGuidance({ argv: ['session', 'current', '--for-agent', '--json'] })] },
        `PHASE_MUTATION_STAGING_NOT_ISSUED: ${target} belongs to another checkout's Git directory. This turn is bound to ${contract.repositoryRoot}; write only the staging file the CLI issues for this checkout. ${preserve}`);
    }
    const own = (contract.allow.staging ?? []).filter(file => stagingTargetPurpose(file)?.purpose === reserved.purpose);
    if (own.length === 1) {
      return { permissionDecision: 'deny', next: [], pathCorrections: [{ attemptedPath: target, issuedPath: own[0], operation: 'write' }],
        permissionDecisionReason: `PHASE_MUTATION_STAGING_PATH_MISMATCH: write ${issuer.what} at exactly ${own[0]}; ${target} is another step's or generation's file. Copy the CLI-returned path verbatim. ${preserve}` };
    }
    const reason = contract.turnMode === issuer.mode
      ? `this step has no open ${reserved.purpose === 'clarification' ? 'clarification checkpoint' : 'source review'} for this turn. Run ${'singularity-flow ' + issuer.argv.join(' ')} standalone in this turn to read its current state, then follow what it returns`
      : `it is ${issuer.what}, issued only in a ${issuer.mode} turn by ${'singularity-flow ' + issuer.argv.join(' ')} (${issuer.skill}). This is a ${contract.turnMode} turn`;
    return mutationDenial({ ...contract, next: [safeCommandGuidance({ argv: issuer.argv, skill: issuer.skill })] },
      `PHASE_MUTATION_STAGING_NOT_ISSUED: this turn may not write ${target}: ${reason}. ${preserve}`);
  }
  return null;
}

// Generated output is issued in the checkout's output folder (agent-output-folder.mjs). A read at
// the older Git-directory spelling, rebuilt below the checkout, is corrected to it like a misplaced
// staging read, never retargeted.
const OUTPUT_FOLDERS = Object.freeze([AGENT_OUTPUT_FOLDER, 'singularity-flow/agent-results'].map(folder => folder.split('/')));

/** The issued suffix a path names: its output folder and file, or its Git-private `singularity-flow` tail. */
function issuedSuffix(file) {
  const parts = file.split(path.sep);
  const folder = OUTPUT_FOLDERS.find(segments => parts.length > segments.length
    && segments.every((segment, index) => parts[parts.length - 1 - segments.length + index] === segment));
  if (folder) return path.join(...folder, parts.at(-1));
  const index = parts.lastIndexOf('singularity-flow');
  return index < 0 ? null : parts.slice(index).join(path.sep);
}
/** One key for every spelling of the same issued file: an output file's is its current folder's. */
function issuedKey(suffix) {
  const parts = suffix.split(path.sep);
  return OUTPUT_FOLDERS.some(segments => parts.length === segments.length + 1 && segments.every((segment, index) => parts[index] === segment))
    ? path.join(...OUTPUT_FOLDERS[0], parts.at(-1)) : suffix;
}
function issuedReadFile(payload, turnId, suffix) {
  return path.join(`${recordFile(payload)}.issued`, digest(turnId), `${digest(suffix)}.json`);
}
async function outputPathMismatch(payload, record, call) {
  const owner = await boundedRecord(recordFile(payload)).catch(() => null);
  const root = owner?.contract?.repositoryRoot ?? owner?.repositoryRoot;
  if (!root || owner.turnId !== record.turnId || Date.now() - owner.recordedAt > MAX_AGE) return null;
  for (const target of targets(call.args)) {
    const absolute = editTarget(target, call.args.cwd ?? payload.cwd ?? root);
    const suffix = absolute && issuedSuffix(absolute);
    if (!suffix || ![path.join(root, suffix), path.join(root, '.git', suffix)].includes(absolute)) continue;
    const issued = await boundedRecord(issuedReadFile(payload, record.turnId, issuedKey(suffix)), 'copilot-issued-read').catch(() => null);
    if (issued?.root !== root || issued.turnId !== record.turnId || typeof issued.path !== 'string') continue;
    const correction = stagingPathMismatch({ repositoryRoot: root }, [target],
      call.args.cwd ?? payload.cwd ?? root, 'read', [issued.path]);
    if (correction) return correction;
  }
  return null;
}
function scopedShellCommand(call, value) {
  let command = call.args.command ?? call.args.cmd ?? call.args.script;
  if (typeof command !== 'string') return null;
  // `cd <root> && …`, or `env -C <root> …` from a shell that cannot set its cwd (a VS Code agent-host
  // chat runs in its own folder, 2026-10-26): either sets exactly the bound cwd, nothing more.
  const scoped = command.trim().match(/^cd\s+(?:'([^']*)'|"([^"$`]*)"|([^\s;&|`$<>]+))\s*&&\s*([\s\S]+)$/u)
    ?? command.trim().match(/^env\s+(?:-C\s*|--chdir[=\s])(?:'([^']*)'|"([^"$`]*)"|([^\s;&|`$<>]+))\s+([\s\S]+)$/u);
  if (scoped) {
    const target = scoped[1] ?? scoped[2] ?? scoped[3];
    const root = value.contract?.repositoryRoot ?? value.repositoryRoot;
    if (!root || !path.isAbsolute(target)) return null;
    try { if (realpathSync(target) !== root) return null; } catch { return null; }
    command = scoped[4];
  }
  // The launcher's verified Node + CLI entry, which the turn names when the CLI is off PATH, is the CLI.
  return asSflowCommand(command, call.name === 'powershell');
}

/**
 * A verified argv as the guard reads it: the command under its canonical name, so an alias the CLI
 * accepts (`world-model` for `wm`, `config` for `configuration`) meets every check below the same way.
 * A removed or unknown command keeps its spelling; the CLI refuses it.
 */
function parseCli(argv) {
  const parsed = parseArgs(argv);
  try { parsed.positionals[0] = canonicalCommand(parsed.positionals[0]); } catch { /* removed or unknown: read as written */ }
  return parsed;
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
  return Boolean(safe) && argvAllowed(safe.argv, mode, value);
}

/**
 * The stored argv of the planned action `action execute` names, read as `selectPlannedAction` selects
 * it (exact or prefix ID, or the plan's only executable action), or null when it cannot be read here.
 * The CLI still verifies the plan's content hash, freshness and the one-time authorization.
 */
function plannedActionArgv(positionals, options, value) {
  const planId = positionals[2] ?? options.plan;
  if (!value.binding?.gitDir || typeof planId !== 'string' || !/^[a-f0-9]{12,64}$/iu.test(planId)) return null;
  try {
    const plan = JSON.parse(readFileSync(path.join(value.binding.gitDir, 'singularity-flow', 'action-plans', `${planId}.json`), 'utf8'));
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];
    const selected = options.action === undefined ? actions.filter(action => action?.executable)
      : actions.filter(action => typeof options.action === 'string' && typeof action?.actionId === 'string'
        && action.actionId.startsWith(options.action)).slice(0, 1);
    const argv = selected.length === 1 && selected[0].executable ? selected[0].argv : null;
    return Array.isArray(argv) && argv.length && argv.every(item => typeof item === 'string' && !/[\u0000-\u001f\u007f]/u.test(item))
      ? argv : null;
  } catch { return null; }
}

/**
 * Commands only a host runs. A lifecycle hook records host decisions (a turn's own boundary among
 * them). The gateway server carries out plans a person confirms in its client's own UI: started from
 * a turn, the agent would be that client, claim the UI at initialize and answer the confirmation
 * itself. Only its reads (`tools`, `events`) and the guide session are a turn's: resetting
 * conversational context changes no work, plan, workspace selection or lifecycle record `[INT:REQ-101]`.
 */
function hostOnlyCommand(positionals) {
  return ['hook', 'exec'].includes(positionals[0])
    || (positionals[0] === 'gateway' && !['tools', 'events', 'session'].includes(positionals[1] ?? 'tools'));
}

export function argvAllowed(argv, mode, value) {
  const { positionals, options } = parseCli(argv);
  if (hostOnlyCommand(positionals)) return false;
  // `run --repair-on-fault` runs the command it wraps unchecked; the guided `run` is `next` and `submit`.
  if (positionals[0] === 'run' && (positionals.length > 1 || options['repair-on-fault'] !== undefined)) return false;
  // `action execute` runs its plan's stored command in this process: a turn admits it only when it
  // would admit that command itself, so a plan cannot carry an approval or a person's decision past it.
  if (positionals[0] === 'action' && positionals[1] === 'execute') {
    const planned = plannedActionArgv(positionals, options, value);
    if (!planned || planned[0] === 'action' || !argvAllowed(planned, mode, value)) return false;
  }
  // Environment values come only from the person's own secret helper on standard input, in no turn.
  if (positionals[0] === 'env' && ['bind', 'unbind'].includes(positionals[1])) return false;
  // What the code means is a person's word: confirming a rule's meaning or reviewing knowledge, in no turn.
  if (knowledgeConfirmation(positionals)) return false;
  // Confirming a workflow delete is the person's own step, in any turn; the preview stays allowed.
  if (positionals[0] === 'workflow' && positionals[1] === 'delete' && options.confirm !== undefined) return false;
  let classification;
  try { classification = resolveOperation({ requestedCommand: positionals[0], positionals, options }).classification; }
  catch { return false; }
  // Rehydrating exact pinned document bytes changes no governed files, identities or approvals.
  // It is safe in any Story-bound turn; upload/add remain ordinary phase-governed mutations.
  if (positionals[0] === 'documents' && positionals[1] === 'restore') return Boolean(value.contract?.workId)
    && positionals.length === 3 && typeof options.file === 'string'
    && (!options['work-id'] || options['work-id'] === value.contract.workId)
    && Object.keys(options).every(key => ['file', 'work-id', 'json', 'for-agent'].includes(key));
  if (mode === 'approval-only') {
    const action = value.skill?.replace(/^\/?(?:sf|sflow)-/u, '');
    if (positionals[0] === 'choices') return positionals[1] === 'status' || !value.decisionEnded && (positionals[1] === 'answer'
      || positionals[1] === 'begin' && positionals[2] === action && positionals[3] === value.contract.workId);
    if (classification === 'read') return true;
    if (value.decisionEnded || options['work-id'] && options['work-id'] !== value.contract.workId) return false;
    // /sf-approve opens the decision list in its own turn when pending decisions hold the approval.
    if (positionals[0] === 'decisions') return decisionListChatRecord(positionals, options, value.contract.workId);
    // /sf-reject's other routes, for the bound Story only, each previewed and confirmed by the CLI:
    // reopen a closed Story, propose an intent amendment (its scope approvers decide it) and abandon
    // rework. Deciding or acknowledging an amendment is not among them.
    if (action === 'reject' && positionals[0] === 'reopen') return positionals.length === 2 && positionals[1] === value.contract.workId;
    if (action === 'reject' && positionals[0] === 'story') return options['work-id'] === value.contract.workId && positionals.length === 3
      && (positionals[1] === 'intent-amendment' && positionals[2] === 'propose' && typeof options.file === 'string'
        || positionals[1] === 'rework' && positionals[2] === 'roll-forward' && typeof options['change-request'] === 'string');
    return positionals[0] === action && (!positionals[1] || positionals[1] === value.originPhase)
      && (action !== 'approve' || approvalChatDecisions(options));
  }
  if (classification === 'read') return true;
  if (mode === 'review-decision-only') return !value.decisionEnded && positionals[0] === 'review-source'
    && positionals[1] === 'decide' && positionals[2] === value.contract.phaseId
    && options['work-id'] === value.contract.workId && typeof options.finding === 'string'
    && typeof options.reason === 'string' && /^[a-f0-9]{64}$/u.test(options.confirm ?? '')
    && positionals.length === 3
    && Object.keys(options).every(key => ['work-id', 'finding', 'reason', 'confirm', 'json'].includes(key));
  // /sf-decide continues into the approval when only the approval is left [SPEC-OAP M4]: the same
  // receipt-bound commands a /sf-approve turn runs, for the bound Story, recording only the
  // upstream-issue options a chat turn may with the approval.
  if (mode === 'decision-only' && (positionals[0] === 'choices' || positionals[0] === 'approve')) {
    return !value.decisionEnded && decideTurnApproval(positionals, options, value.contract.workId);
  }
  // A /sf-decide turn records the decision list's upstream-issue options for the bound Story, with the
  // list's digest; a reused run or a test-run risk stays the person's own terminal step.
  if (mode === 'decision-only' && positionals[0] === 'decisions') return !value.decisionEnded
    && decisionListChatRecord(positionals, options, value.contract.workId);
  // The /sf-decide turn boundary: the decision commands its skill names, for the bound Story only.
  // `decision risk` and `decision witness` stay outside it; a witness needs the human terminal.
  // Raising one for an earlier step is the route a final check names, and /sf-decide is where it is
  // routed: denied here, it was a dead-end (2026-10-28). The problem is the person's own words.
  if (mode === 'decision-only' && positionals[0] === 'upstream-issue') return !value.decisionEnded
    && (positionals[1] === 'decide' && /^UPI-\d{3,}$/u.test(positionals[2] ?? '') && positionals.length === 3
      || positionals[1] === 'raise' && positionals.length === 2 && typeof options.phase === 'string'
        && typeof options.about === 'string' && typeof options.problem === 'string')
    && options['work-id'] === value.contract.workId;
  if (mode === 'decision-only') return !value.decisionEnded && positionals[0] === 'decision'
    && DECIDE_SKILL_MUTATIONS.includes(positionals[1]) && positionals.length <= 3
    && !planRowCorrectionStep(positionals, options)
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
  // The /sf-run-app and /sf-test turns: the declared application and tests, and proposing exactly the
  // application block draft `app suggest` issued to this turn (a local map, or a reviewed proposal).
  if (mode === 'run-and-test') return (positionals[0] === 'app' && ['start', 'stop'].includes(positionals[1]))
    || (positionals[0] === 'tests' && positionals[1] === 'run')
    || (positionals[0] === 'capability' && positionals.length === 3 && typeof options['application-file'] === 'string'
      && path.isAbsolute(options['application-file']) && (value.appDraftStaging ?? []).includes(path.resolve(options['application-file']))
      && (positionals[1] === 'set'
        ? Object.keys(options).every(key => ['application-file', 'json'].includes(key))
        : positionals[1] === 'edit' && options.mode === 'set' && typeof options.lead === 'string'
          && Object.keys(options).every(key => ['application-file', 'lead', 'mode', 'json'].includes(key))));
  // The /sf-import-team turn: its own three commands; every other mutation stays refused.
  if (mode === 'import-team') return positionals[0] === 'workflow' && positionals[1] === 'import-team'
    && IMPORT_TEAM_COMMANDS.includes(positionals[2]) && positionals.length === 3;
  // The /sf-build-workflow turn: its build commands are reads; finishing is its one mutation.
  if (mode === 'build-workflow') return positionals[0] === 'workflow' && positionals[1] === 'build'
    && positionals[2] === 'finish' && positionals.length === 3;
  // The /sf-fix-workflow turn: its one mutation proposes the issued change set draft for review.
  if (mode === 'fix-workflow') return positionals[0] === 'workflow' && positionals[1] === 'studio'
    && positionals[2] === 'apply' && positionals.length === 3 && options.propose === true
    && Object.keys(options).every(key => ['change-set', 'propose', 'json'].includes(key))
    && typeof options['change-set'] === 'string' && path.isAbsolute(options['change-set'])
    && (value.fixStaging ?? []).includes(path.resolve(options['change-set']));
  if (mode === 'read') return false;
  // A /sf-confirm of the list's own record command is the person's typed yes: the same upstream-issue
  // options a /sf-decide turn may record, with the digest they confirmed.
  if (mode === 'confirm' && positionals[0] === 'decisions') return !value.decisionEnded
    && options.confirm === value.confirmDigest && decisionListChatRecord(positionals, options, value.contract?.workId);
  // Recording the decision list is a person's decision; outside a /sf-decide turn it is theirs to run.
  if (positionals[0] === 'decisions') return false;
  // Deciding an upstream issue is the earlier step's approvers' call, like approve and reject; an
  // agent may raise one and keep working, never decide it.
  if (positionals[0] === 'upstream-issue' && UPSTREAM_ISSUE_DECISIONS.includes(positionals[1])) return false;
  // So is deciding an intent amendment: the scope's approvers decide it, in their own terminal.
  if (intentAmendmentDecision(positionals)) return false;
  // Accepting that a step's tests cannot run here or ran narrowed, reusing another step's recorded run
  // for it, or saying one of its screen sizes does not apply, is its approvers' call too; the refusal names it.
  if (positionals[0] === 'decision' && ['test-risk', 'test-narrowing', 'evidence-reuse', 'visual-profile'].includes(positionals[1])) return false;
  // An agent may request a Story-only test command; accepting or revoking it is the step approvers' call.
  if (storyTestCommandDecision(positionals, options)) return false;
  // A Story's authorized browser target is a security boundary: a person pins it, in no turn (its preview is a read).
  if (targetOriginPin(positionals, options)) return false;
  if (positionals[0] === 'spec' && positionals[1] === 'drift' && positionals[2] === 'decide') return false;
  // Setting held changes aside drops them from the checkout: the person who looked at them decides.
  if (positionals[0] === 'recover' && options['set-aside'] === true) return false;
  if (publicationSetAside(positionals, options)) return false;
  // Witnessing evidence and accepting a dated obligation risk are a person's word on what they looked
  // at, in no turn: run under the person's Git identity, an agent would sign off its own work.
  if (signOff(positionals)) return false;
  if (planRowCorrectionStep(positionals, options)) return false;
  if (liveTerminalReviewStep(positionals, options)) return false;
  // The /sf-confirm turn: only the command carrying the digest the person typed, for the bound Story.
  // The CLI refuses the digest once it is stale; approvals and the decisions above keep their routes.
  if (mode === 'confirm') return !value.decisionEnded && typeof value.confirmDigest === 'string'
    && [options.confirm, options['confirm-plan']].includes(value.confirmDigest)
    && !['approve', 'reject'].includes(positionals[0])
    && (!options['work-id'] || !value.contract || options['work-id'] === value.contract.workId);
  return !['approve', 'reject'].includes(positionals[0]);
}

/**
 * `decisions record` for one Story with only upstream-issue options, each item once, with the list's
 * digest: what a /sf-decide turn may record after the person's explicit yes in chat.
 */
function decisionListChatRecord(positionals, options, workId) {
  if (positionals[1] !== 'record' || positionals[2] !== workId || positionals.length !== 3) return false;
  if (!Object.keys(options).every(key => ['choose', 'reason', 'expires', 'confirm', 'json', 'phase'].includes(key))) return false;
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.confirm ?? '')) return false;
  const chosen = [options.choose].flat().filter(entry => entry !== undefined);
  return chosen.length > 0 && chosen.every(entry => typeof entry === 'string'
    && new RegExp(`^d\\d{1,3}=(?:${DECISION_LIST_CHAT_OPTIONS.join('|')})$`, 'u').test(entry));
}

/**
 * The decision-list answers an approval in a chat turn may carry [SPEC-OAP M4]: none, or only
 * upstream-issue options that record (never a return), each with the list's digest. A reused run or
 * a test-run risk is answered in the approver's own terminal or VS Code approval form.
 */
function approvalChatDecisions(options) {
  // Confirming evidence with the approval is a sign-off on what the approver looked at; never a chat turn's.
  if (options['confirm-evidence'] !== undefined) return false;
  const chosen = [options.choose].flat().filter(entry => entry !== undefined);
  if (!chosen.length) return options.decisions === undefined;
  return /^sha256:[a-f0-9]{64}$/u.test(options.decisions ?? '') && chosen.every(entry => typeof entry === 'string'
    && new RegExp(`^d\\d{1,3}=(?:${DECISION_LIST_CHAT_OPTIONS.filter(option => option !== 'return').join('|')})$`, 'u').test(entry));
}

/** The approval commands a /sf-decide turn runs when it continues into the approval, for the bound Story. */
function decideTurnApproval(positionals, options, workId) {
  if (positionals[0] === 'choices') return positionals[1] === 'status' || positionals[1] === 'answer'
    || positionals[1] === 'begin' && positionals[2] === 'approve' && positionals[3] === workId;
  return options['work-id'] === workId && typeof options['selection-receipt'] === 'string' && options.yes === undefined
    && positionals.length === 2 && approvalChatDecisions(options);
}

/** A verified `decisions record`: the person's own step unless a /sf-decide turn may record it. */
/** A verified `workflow delete --confirm`: the person confirms a delete, never an agent turn. */
function workflowDeleteConfirmation(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return positionals[0] === 'workflow' && positionals[1] === 'delete' && options.confirm !== undefined;
}
const WORKFLOW_DELETE_CONFIRMATION_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: confirming a workflow delete is the person\'s own step. '
  + 'Show them the preview (workflow delete <ID> --dry-run) and its plan digest; they confirm in VS Code (Workflow Studio → Delete…) '
  + 'or run singularity-flow workflow delete <ID> --confirm <PLAN-SHA256> --propose in their own terminal. Do not retry it';

function decisionListRecord(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseCli(safe.argv);
  return positionals[0] === 'decisions' && positionals[1] === 'record';
}

/** A verified `upstream-issue decide`: an approver's decision, never an agent's. */
function upstreamIssueDecision(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseCli(safe.argv);
  return positionals[0] === 'upstream-issue' && UPSTREAM_ISSUE_DECISIONS.includes(positionals[1]);
}

/** `story intent-amendment decide`: a person who approves the scope decides it, never an agent turn. */
function intentAmendmentDecision(positionals) {
  return positionals[0] === 'story' && positionals[1] === 'intent-amendment' && positionals[2] === 'decide';
}
function intentAmendmentDecisionCall(call, value) {
  const safe = verifiedShellForm(call, value);
  return Boolean(safe) && intentAmendmentDecision(parseCli(safe.argv).positionals);
}

/** A verified `env bind` or `env unbind`: only the person supplies or removes environment values. */
function environmentBinding(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseCli(safe.argv);
  return positionals[0] === 'env' && ['bind', 'unbind'].includes(positionals[1]);
}
const ENVIRONMENT_BINDING_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: environment values are bound and removed only by the person: they pipe their own secret helper into `singularity-flow env bind <ENV> --stdin`, or run `singularity-flow env unbind <ENV> --json`, in their own terminal. Give them that command; never ask for, type or pipe a value';

/** A verified `action execute` this turn refused for the planned command it would run. */
function plannedActionExecution(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals } = parseCli(safe.argv);
  return positionals[0] === 'action' && positionals[1] === 'execute';
}
const HOOK_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: a lifecycle hook records the host\'s own decisions (a turn\'s boundary among them), so only the host runs it, or the person in their own terminal with the exact payload. Give them the command; do not retry it';
/**
 * `sflow_run` carries out a plan; a read turn carries out none. The four read tools pass every turn
 * (they are not terminals, edits or delegations), so a read skill may answer through them. Matched by
 * suffix: an MCP host may prefix the server name (`singularity-flow-sflow_run`).
 */
const GATEWAY_RUN_TOOL = /(?:^|[^a-z0-9])sflow_run$/u;
const GATEWAY_RUN_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: sflow_run carries out a plan, and this read-only turn carries out none. Answer with sflow_resolve, sflow_read, sflow_next or sflow_explain, or this skill\'s own CLI read; a plan the person wants carried out runs from its own /sf-* skill. Do not retry it';
const GATEWAY_SERVER_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: the gateway server carries out plans a person confirms in their own client\'s UI, so only that client starts it (from its MCP configuration), never a turn. Use the SFlow tools the host already offers; do not retry it';
/** A verified host-only command (a hook, or the gateway server), as the refusal that names why. */
function hostOnlyDenial(call, value) {
  const safe = verifiedShellForm(call, value);
  const { positionals } = safe ? parseCli(safe.argv) : { positionals: [] };
  if (!hostOnlyCommand(positionals)) return null;
  return { gateway: GATEWAY_SERVER_DENIAL, hook: HOOK_DENIAL }[positionals[0]] ?? null;
}
const PLANNED_ACTION_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: action execute runs its planned command in this process, and this turn may not run that command itself (an approval or rejection, a person\'s own decision, or a plan this checkout does not hold). Show the user the planned command and its own route; do not retry it';

/** A verified `recover --set-aside`: a person's decision about changes held for review. */
/** `sync --set-aside --confirm <COMMIT>`: a person's decision to drop a waiting commit from publication. */
function publicationSetAside(positionals, options) {
  return positionals[0] === 'sync' && options['set-aside'] === true && options.confirm !== undefined;
}
function publicationSetAsideCall(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return publicationSetAside(positionals, options);
}
function setAsideDecision(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return positionals[0] === 'recover' && options['set-aside'] === true;
}

/**
 * A verified `decision test-risk`, `decision test-narrowing`, `decision evidence-reuse`, `decision
 * visual-profile` or `spec drift decide`: a step approver's decision, that its tests cannot run here,
 * that a narrowed run of them is enough, that an earlier step's recorded run stands for it, that one
 * of its screen sizes does not apply, or how a closed Story's drifted clause is resolved.
 */
function testRunRiskDecision(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return (positionals[0] === 'decision' && ['test-risk', 'test-narrowing', 'evidence-reuse', 'visual-profile'].includes(positionals[1]))
    || storyTestCommandDecision(positionals, options)
    || (positionals[0] === 'spec' && positionals[1] === 'drift' && positionals[2] === 'decide');
}

/** `decision witness`, `decision risk` or `decision witness-exception`: an approver's sign-off on evidence they looked at, or a dated risk or exception. */
function signOff(positionals) {
  return positionals[0] === 'decision' && ['witness', 'risk', 'witness-exception'].includes(positionals[1]);
}
/** The denied command's own route, for the person's terminal: its Shell line and no Copilot route. */
function personRoute(call, value) {
  const safe = verifiedShellForm(call, value);
  const guidance = safe ? safeCommandGuidance({ argv: safe.argv }) : null;
  return { routes: guidance ? [{ ...guidance, skill: null, copilotCommand: null }] : [] };
}
function liveTerminalReviewCall(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return liveTerminalReviewStep(positionals, options);
}
function approvalEvidenceConfirmationCall(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return positionals[0] === 'approve' && options['confirm-evidence'] === true;
}
function planRowCorrectionCall(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return planRowCorrectionStep(positionals, options);
}
function signOffCall(call, value) {
  const safe = verifiedShellForm(call, value);
  return Boolean(safe) && signOff(parseCli(safe.argv).positionals);
}

/** `decision test-command --accept|--revoke`: a step approver's decision on a requested command. */
function storyTestCommandDecision(positionals, options) {
  return positionals[0] === 'decision' && positionals[1] === 'test-command' && (options.accept !== undefined || options.revoke !== undefined);
}

/** `wm rules confirm` or `wm knowledge confirm|correct|reject`: a person's word on what the code means. */
function knowledgeConfirmation(positionals) {
  return positionals[0] === 'wm' && ((positionals[1] === 'rules' && positionals[2] === 'confirm')
    || (positionals[1] === 'knowledge' && ['confirm', 'correct', 'reject'].includes(positionals[2])));
}
function knowledgeConfirmationCall(call, value) {
  const safe = verifiedShellForm(call, value);
  return Boolean(safe) && knowledgeConfirmation(parseCli(safe.argv).positionals);
}
const KNOWLEDGE_CONFIRMATION_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: what a business rule means, and whether a repository '
  + 'knowledge item is right, is confirmed by a person who knows the code, in their own terminal (singularity-flow wm rules confirm '
  + 'RULE-ID, or wm knowledge confirm|correct|reject ITEM), never by this turn. Show the user the draft (singularity-flow wm rules list, '
  + 'which is allowed) and the command; do not retry it';

/** A confirmed `story target-origin`: pinning a Story's authorized browser target origin. */
function targetOriginPin(positionals, options) {
  return positionals[0] === 'story' && positionals[1] === 'target-origin' && options.confirm !== undefined;
}
function targetOriginPinCall(call, value) {
  const safe = verifiedShellForm(call, value);
  if (!safe) return false;
  const { positionals, options } = parseCli(safe.argv);
  return targetOriginPin(positionals, options);
}
const TARGET_ORIGIN_PIN_DENIAL = 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: a Story\'s authorized browser target origin is a security boundary; '
  + 'a person who approves the step that smoke-checks it confirms the pin in their own terminal, never this turn. '
  + 'Show the user the preview (story target-origin <WORK-ID> --url <URL>, which is allowed) and its plan digest; do not retry it';

function mentionsKernelExecution(call, value) {
  const command = scopedShellCommand(call, value) ?? call.args.command ?? call.args.cmd ?? call.args.script ?? '';
  // A directory or file prefixed with sflow/singularity-flow is not a CLI invocation.
  // Match a complete executable token, not a word boundary inside a literal path.
  // Keep rejecting unverified wrappers, substitutions and executable paths; never grant kernel authority
  // to a raw shell. Its file mutations still undergo the normal before/after path checks.
  return /\b(?:singularity-flow|sflow)(?:\.(?:exe|cmd|bat))?(?=$|[\s'";&|`$<>()])/iu.test(command) || mentionsHookCli(command);
}

/**
 * The command families a skill that needs no Story runs before one is bound (its registry
 * executionBoundary is machine, repository or organisation), under the kernel-only rules: the
 * families its own steps name, never every registered command. An Epic, Initiative or machine-level
 * checkout binds no Story, so without this a kernel-only turn there could run none of its own steps.
 * phase-mutation-contract.test.mjs holds each skill's named commands to this list.
 */
const NO_STORY_COMMANDS = Object.freeze({
  admin: ['state'], adhoc: ['adhoc', 'land'], agents: ['agents'], auto: ['auto'],
  'capability-add': ['capability'], 'capability-depend': ['capability'], 'capability-protect': ['capability'],
  'capability-doctor': ['capabilities', 'capability'], 'call-add': ['call'], constitution: ['constitution'],
  documents: ['documents', 'epic'], upload: ['documents', 'epic'], environment: ['env'],
  'epic-complete': ['epic'], 'epic-drift': ['epic'], 'epic-merge-plan': ['epic'], 'epic-planning': ['epic', 'initiative'],
  'epic-publish': ['epic'],
  'epic-requirements': ['epic', 'initiative'], 'epic-resume': ['epic'], 'epic-review': ['epic'],
  'epic-review-decision': ['epic'], 'epic-sources': ['epic'], 'epic-start': ['epic', 'initiative'],
  'epic-stories': ['epic'], 'epic-story-draft': ['epic', 'initiative'], 'epic-sync': ['epic'],
  'factory-reset': ['factory-reset'], fault: ['fault'], 'fresh-install': ['fresh-install'], goal: ['goal'],
  // A fault and its bounded repair need no Story (/sf-fault records one in any checkout).
  fix: ['fault', 'fix', 'repair'],
  'governance-rebuild': ['governance'],
  impact: ['impact'], import: ['import', 'imports', 'marketplace'],
  'initiative-approve': ['initiative'], 'initiative-evidence': ['initiative'], 'initiative-materialize': ['initiative'],
  'initiative-phase': ['initiative'], 'initiative-start': ['initiative'], 'jira-initiative': ['initiative'],
  'jira-update': ['jira'], integrations: ['integrations'], journal: ['journal'], knowledge: ['knowledge'], learn: ['learn'],
  ledger: ['ledger'], local: ['local'], 'local-reset': ['local-reset'], mcp: ['mcp'], plugin: ['plugin'],
  product: ['product'], 'prompt-log': ['prompt-log'], push: ['push', 'sync'], quickstart: ['quickstart'],
  ready: ['precheck'], reinstall: ['reinstall'],
  'refresh-configuration': ['workspace'], 'reset-all': ['reset-all'], return: ['return'], secrets: ['secrets'],
  sgos: ['intent', 'program', 'process', 'policy', 'task', 'request', 'evidence', 'candidate', 'execution-unit',
    'device', 'authority-store', 'pack', 'memory', 'meta-tool'],
  'sgos-create': ['intent'], stack: ['stack'], 'story-branch': ['story'], 'story-fetch': ['story'],
  'story-start': ['story'], telemetry: ['telemetry'], watch: ['watch'],
  'workspace-bootstrap': ['workspace'], 'workspace-impact': ['workspace']
});

function bootstrapAllowed(call, record) {
  if (shellAllowed(call, 'read', record)) return true;
  const mode = mutationTurnMode(record.skill);
  // Before a Story is bound there is no decision to record, so /sf-decide gets reads only here.
  if (mode === 'session-only') return shellAllowed(call, mode, record);
  // A confirmed setup command runs before any Story exists; only its typed digest is allowed.
  if (mode === 'confirm') return shellAllowed(call, mode, record);
  // Starting the application or running a capability's tests needs no Story.
  if (mode === 'run-and-test') return shellAllowed(call, mode, record);
  // Repository setup has no Story yet. Its registered CLI operations retain their existing
  // configuration authority and confirmations; this exception never authorizes file tools.
  const setup = ['admin', 'init', 'configuration', 'workflows', 'workflow-rules', 'skills', 'instructions',
    'capability-map', 'workspace', 'worldmodel', 'start', 'test-setup'];
  const name = record.skill?.replace(/^\/?(?:sf|sflow)-/u, '');
  const command = scopedShellCommand(call, record) ?? '';
  if (setup.includes(name) && /^\s*(?:singularity-flow|sflow)\s+(?:workspace|configuration|workflow|skill|instruction|capability|init|precheck|wm|start|test-policy)\b/u.test(command)
    && shellAllowed(call, 'kernel-only', record)) return true;
  const families = mode === 'kernel-only' ? NO_STORY_COMMANDS[name] : null;
  const safe = families ? verifiedShellForm(call, record) : null;
  return Boolean(safe) && families.includes(parseCli(safe.argv).positionals[0]) && shellAllowed(call, 'kernel-only', record);
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
  // Background refresh and CLI issuance may overlap. A stale read/modify/write of the turn
  // record must not revoke an exact grant. Independent issuer receipts survive that race;
  // only this live turn's same Story/phase/generation/mode may recover one, never a wildcard.
  for (const call of calls(payload)) for (const target of targets(call.args)) {
    const absolute = editTarget(target, call.args.cwd ?? payload.cwd ?? value.contract.repositoryRoot);
    if (!absolute || value.contract.allow.staging.includes(absolute)) continue;
    const suffix = issuedSuffix(absolute);
    if (!suffix) continue;
    const issued = await boundedRecord(issuedReadFile(payload, value.turnId, `staging:${suffix}`),
      'copilot-issued-staging').catch(() => null);
    if (issued?.root === value.contract.repositoryRoot && issued.turnId === value.turnId
        && issued.workId === value.contract.workId && issued.phaseId === value.contract.phaseId
        && issued.generation === value.contract.generation && issued.mode === value.contract.turnMode
        && typeof issued.path === 'string' && !value.contract.allow.staging.includes(issued.path)) value.contract.allow.staging.push(issued.path);
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
  const deny = reason => turnExpired(record) ? turnExpiredDenial(record) : ({ permissionDecision: 'deny', next: [], permissionDecisionReason: reason });
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
      : 'IMPORT_TEAM_PATH_DENIED: no candidate file is issued to this turn. To continue an earlier session, run singularity-flow workflow import-team status --session <SESSION-ID> --json in this turn: it issues that session\'s candidate file again and keeps its answers. To start a new session, run singularity-flow workflow import-team inspect and write only the path it returns');
  }
  return {};
}

/**
 * /sf-fix-workflow: reads (`workflow validate`, `workflow check --change-set`, `workflow studio apply
 * --dry-run`), edits to exactly the change set draft `workflow validate` issued to this turn, and one
 * mutation: `workflow studio apply --change-set <that draft> --propose`, a configuration proposal a
 * person reviews. It needs no Story, edits no repository file and does not delegate.
 */
async function fixWorkflowGuard(payload, record, toolCalls) {
  const value = await importTeamTurn(payload, record);
  const issued = (value?.fixStaging ?? []).map(file => path.resolve(file));
  const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot, fixStaging: issued };
  const deny = reason => turnExpired(record) ? turnExpiredDenial(record) : ({ permissionDecision: 'deny', next: [], permissionDecisionReason: reason });
  for (const call of toolCalls) {
    if (DELEGATION.has(call.name)) return deny('FIX_WORKFLOW_DELEGATION_NOT_ALLOWED: draft the fixes in this turn; /sf-fix-workflow does not delegate');
    if (TERMINALS.has(call.name)) {
      if (shellAllowed(call, 'fix-workflow', scope)) continue;
      const draft = unissuedDraftOption(call, scope, 'fix-workflow', 'fixStaging',
        (positionals, options) => positionals[0] === 'workflow' ? options['change-set'] : null);
      if (draft) return deny(`FIX_WORKFLOW_DRAFT_NOT_ISSUED: ${draft} is not issued to this turn. Run singularity-flow workflow validate --json standalone in this turn first, for the same workflow: it issues the same change set file at fixDraft.changeSetPath and leaves what is in it unchanged. Then run this command again`);
      return deny('FIX_WORKFLOW_OPERATION_NOT_ALLOWED: run one standalone read command (workflow validate, workflow check --change-set, workflow studio apply --dry-run) or singularity-flow workflow studio apply --change-set <issued draft> --propose; no other mutations, chains or wrappers, and never approve or activate');
    }
    if (!isEdit(call.name)) continue;
    const paths = targets(call.args);
    const cwd = call.args.cwd ?? payload.cwd ?? scope.repositoryRoot ?? process.cwd();
    const outside = paths.filter(target => !issued.includes(editTarget(target, cwd)));
    if (paths.length && !outside.length) continue;
    return deny(issued.length
      ? `FIX_WORKFLOW_PATH_DENIED (${outside.join(', ') || 'no target'}): write only the issued change set draft at exactly ${issued.join(', ')}; Workflow Studio's apply changes the repository, never this turn`
      : 'FIX_WORKFLOW_PATH_DENIED: no change set draft is issued to this turn. Run singularity-flow workflow validate --json first and write only its fixDraft.changeSetPath');
  }
  return {};
}

/**
 * /sf-run-app and /sf-test: reads, `app start|stop`, `tests run`, edits to exactly the application
 * block draft `app suggest` issued to this turn, and proposing that draft. They need no Story, edit no
 * repository file, never bind environment values and do not delegate.
 */
async function runAndTestGuard(payload, record, toolCalls) {
  const value = await importTeamTurn(payload, record);
  const issued = (value?.appDraftStaging ?? []).map(file => path.resolve(file));
  const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot, appDraftStaging: issued };
  const deny = reason => turnExpired(record) ? turnExpiredDenial(record) : ({ permissionDecision: 'deny', next: [], permissionDecisionReason: reason });
  for (const call of toolCalls) {
    if (DELEGATION.has(call.name)) return deny('RUN_AND_TEST_DELEGATION_NOT_ALLOWED: start the application or run the tests in this turn; it does not delegate');
    if (TERMINALS.has(call.name)) {
      if (shellAllowed(call, 'run-and-test', scope)) continue;
      if (environmentBinding(call, scope)) return deny(ENVIRONMENT_BINDING_DENIAL);
      const draft = unissuedDraftOption(call, scope, 'run-and-test', 'appDraftStaging',
        (positionals, options) => positionals[0] === 'capability' ? options['application-file'] : null);
      if (draft) return deny(`RUN_AND_TEST_DRAFT_NOT_ISSUED: ${draft} is not issued to this turn. Run singularity-flow app suggest --json standalone in this turn first: it issues the same draft file and leaves what is in it unchanged. Then run this command again`);
      return deny('RUN_AND_TEST_OPERATION_NOT_ALLOWED: run one standalone SFlow read, app start|stop, tests run, or capability set|edit --application-file <the draft app suggest issued>; no other mutations, chains or wrappers');
    }
    if (!isEdit(call.name)) continue;
    const paths = targets(call.args);
    const cwd = call.args.cwd ?? payload.cwd ?? scope.repositoryRoot ?? process.cwd();
    const outside = paths.filter(target => !issued.includes(editTarget(target, cwd)));
    if (paths.length && !outside.length) continue;
    return deny(issued.length
      ? `RUN_AND_TEST_PATH_DENIED (${outside.join(', ') || 'no target'}): write only the issued application draft at exactly ${issued.join(', ')}; this turn edits no repository file`
      : 'RUN_AND_TEST_PATH_DENIED: this turn edits no file. To draft start entries run singularity-flow app suggest --json and write only its draft.applicationFile');
  }
  return {};
}

/**
 * /sf-build-workflow: reads, its own `workflow build` commands, and edits to exactly the proposal
 * files `workflow build` issued to this turn. Like /sf-import-team it needs no Story, edits no
 * repository and does not delegate.
 */
async function buildWorkflowGuard(payload, record, toolCalls) {
  const value = await importTeamTurn(payload, record);
  const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot };
  const issued = (value?.buildStaging ?? []).map(file => path.resolve(file));
  const deny = reason => turnExpired(record) ? turnExpiredDenial(record) : ({ permissionDecision: 'deny', next: [], permissionDecisionReason: reason });
  for (const call of toolCalls) {
    if (DELEGATION.has(call.name)) return deny('BUILD_WORKFLOW_DELEGATION_NOT_ALLOWED: grow the build in this turn; /sf-build-workflow does not delegate');
    if (TERMINALS.has(call.name)) {
      if (shellAllowed(call, 'build-workflow', scope)) continue;
      return deny('BUILD_WORKFLOW_OPERATION_NOT_ALLOWED: run one standalone read command or singularity-flow workflow build start|add|status|propose|decide|answer|check|finish; no other mutations, chains or wrappers');
    }
    if (!isEdit(call.name)) continue;
    const paths = targets(call.args);
    const cwd = call.args.cwd ?? payload.cwd ?? scope.repositoryRoot ?? process.cwd();
    const outside = paths.filter(target => !issued.includes(editTarget(target, cwd)));
    if (paths.length && !outside.length) continue;
    return deny(issued.length
      ? `BUILD_WORKFLOW_PATH_DENIED (${outside.join(', ') || 'no target'}): write only the issued proposal file at exactly ${issued.join(', ')}; never the team's material or a repository`
      : 'BUILD_WORKFLOW_PATH_DENIED: no proposal file is issued to this turn. Run singularity-flow workflow build status --build <ID> --json first and write only its proposalPath');
  }
  return {};
}

/**
 * A shell command that reads the host's own saved copy of a long tool result. The host keeps it
 * outside the workspace, so the agent's file tools cannot open it, and an agent reached for `jq` on
 * it in a turn that runs only SFlow commands. SFlow kept that result: `result last` returns it, bounded
 * and act first, without running the command again (agent-result-keeper.mjs).
 */
export function readsHostSavedOutput(call) {
  const command = String(call?.args?.command ?? call?.args?.cmd ?? call?.args?.script ?? '');
  return /copilot-tool-output|[\\/]tool-output-[^\s'"]*\.txt/iu.test(command);
}

const OWN_ROUTE_TURNS = new Set(['read-only-review', 'review-decision-only', 'decision-only', 'publish-only']);
const HOST_SAVED_OUTPUT_DENIAL = 'PHASE_MUTATION_TOOL_PROTOCOL: that file is the host\'s saved copy of a long result, outside the workspace; do not read it with shell tools. Run singularity-flow result last --wait --for-agent --json, standalone: it returns that command\'s kept result, starting with act and fitting the host, without running the command again. This refusal does not invalidate the phase or require repeating clarification';

/**
 * XPL2 observed writes, on the guard that already runs: settle what this session's earlier edits
 * left, then note what this allowed edit is about to change. File reads only (no Git, no repository
 * scan); it never changes the decision, prints nothing and swallows every error.
 */
async function observeEdits(payload, record, decision) {
  const file = recordFile(payload);
  if (!file) return;
  const pending = file.replace(/\.mutation\.json$/u, '.pending-writes.json');
  const edits = decision.permissionDecision === 'deny' || record.corrupt ? [] : calls(payload).filter(call => isEdit(call.name));
  const waiting = await lstat(pending).then(() => true, () => false);
  if (!edits.length && !waiting) return;
  // A literal specifier: the hook bundle loads this module from source (scripts/build-cold-cli-bundle.mjs).
  const recorder = await import('./comprehension/xpl2/observed-write-recorder.mjs');
  if (waiting) await recorder.settleToolWrites(pending).catch(() => {});
  if (!edits.length) return;
  const value = await boundedRecord(file).catch(() => null);
  const contract = value?.contract;
  if (!contract?.repositoryRoot || !value.binding?.gitDir || value.turnId !== record.turnId) return;
  const agent = payload.agentName ?? payload.agent_name;
  await recorder.captureToolWrites({ pendingFile: pending, root: contract.repositoryRoot, cwd: payload.cwd ?? contract.repositoryRoot,
    calls: edits.map(call => ({ ...call, targets: targets(call.args) })), gitDirectory: value.binding.gitDir,
    writer: { kind: 'copilot-turn', session: key(payload).slice(0, 16), turn: record.turnId, skill: record.skill,
      agent: typeof agent === 'string' ? agent.slice(0, 80) : null },
    subject: { workId: contract.workId, phase: contract.phaseId, generation: value.openGeneration ?? null } });
}

/** Settle a session's noted edits for good when its turn ends or a new prompt starts. Never throws. */
export async function settleObservedEdits(payload) {
  const file = recordFile(payload);
  const pending = file?.replace(/\.mutation\.json$/u, '.pending-writes.json');
  if (!pending || !await lstat(pending).then(() => true, () => false)) return;
  await import('./comprehension/xpl2/observed-write-recorder.mjs').then(recorder => recorder.settleToolWrites(pending, { final: true })).catch(() => {});
  await unlink(pending).catch(() => {});
}

export async function mutationToolGuard(payload = {}) {
  const record = await turn(payload);
  if (!record) return {};
  const decision = await mutationToolDecision(payload, record);
  await observeEdits(payload, record, decision).catch(() => {});
  return decision;
}

// A read is turned back only when the host would cut it (the smallest cut seen was 8,193 bytes); the
// ranges it names are READ_CHUNK_BYTES, with room to spare. A file longer than the scan limit is not
// scanned for ranges; the host's own refusal stands.
const LONG_READ_BYTES = 8_000;
const LONG_READ_SCAN_BYTES = 1024 * 1024;
const LONG_READ_RANGES_SHOWN = 10;

/**
 * Any file an agent reads in an SFlow turn (a custom workflow's artifacts, a draft, a workflow file,
 * source), not only the results SFlow names: a whole read or range longer than one file read
 * (LONG_READ_BYTES) would come back cut or refused, and the agent reads it again in slices or gives
 * up. Turn it back before it runs, naming the exact ranges to request together. A short read, an
 * image or other binary, a link, and a text whose single line is longer than one read pass as before.
 */
async function longFileRead(toolCalls, cwd) {
  for (const call of toolCalls) {
    if (call.name !== 'view') continue;
    const [target] = targets(call.args);
    if (typeof target !== 'string' || !target) continue;
    let file;
    try { file = target.startsWith('file:') ? fileURLToPath(target) : path.resolve(call.args.cwd ?? cwd ?? process.cwd(), target); }
    catch { continue; }
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size <= LONG_READ_BYTES || info.size > LONG_READ_SCAN_BYTES) continue;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text == null || text.includes('\u0000')) continue;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const range = Array.isArray(call.args.view_range) ? call.args.view_range.map(Number) : null;
    const first = Math.max(1, range?.[0] || 1);
    const last = range && range[1] > 0 ? Math.min(range[1], lines.length) : lines.length;
    if (first > last) continue;
    const part = lines.slice(first - 1, last);
    if (Buffer.byteLength(part.join('\n')) <= LONG_READ_BYTES || part.some(line => Buffer.byteLength(line) >= READ_CHUNK_BYTES)) continue;
    const ranges = lineRanges(part.join('\n')).map(([start, end]) => [start + first - 1, end + first - 1]);
    const shown = ranges.slice(0, LONG_READ_RANGES_SHOWN);
    const more = ranges.length > shown.length ? ` Then continue from line ${shown.at(-1)[1] + 1} the same way, or search the file for what you need.` : '';
    return { permissionDecision: 'deny', next: [], readRanges: [{ path: target, ranges }],
      permissionDecisionReason: `FILE_READ_TOO_LONG: ${target}${range ? ` lines ${first}-${last}` : ''} is longer than one file read shows (about 8 KB), so it would come back cut or refused. Nothing was read. `
        + `Request these view_range values together in one response: ${shown.map(([start, end]) => `[${start}, ${end}]`).join(', ')}.${more}` };
  }
  return null;
}

async function mutationToolDecision(payload, record) {
  const toolCalls = calls(payload);
  if (mutationTurnMode(record.skill) === 'read' && toolCalls.some(call => GATEWAY_RUN_TOOL.test(call.name))) {
    return { permissionDecision: 'deny', next: [], permissionDecisionReason: GATEWAY_RUN_DENIAL };
  }
  const guarded = toolCalls.filter(call => TERMINALS.has(call.name) || DELEGATION.has(call.name) || isEdit(call.name));
  const stagingReads = toolCalls.filter(call => FILE_READS.has(call.name)
    && targets(call.args).some(target => /(?:^|[\\/])(?:singularity-flow|\.sflow[\\/]out)[\\/]/u.test(target)));
  if (stagingReads.length) {
    // Read references are hints, never write grants. Use the integrity-bound live turn record:
    // no Story/config reload, Git lookup or directory search is needed to correct an output read.
    for (const call of stagingReads) {
      const correction = await outputPathMismatch(payload, record, call);
      if (correction) return correction;
    }
  }
  const tooLong = await longFileRead(toolCalls, payload.cwd);
  if (tooLong) return tooLong;
  if (!guarded.length) {
    if (!stagingReads.length) return {}; // Ordinary file reads keep the existing no-policy-load path.
    const current = await currentContract(payload, record).catch(() => null);
    if (!current) return {}; // An expired/missing contract never creates a new read restriction.
    for (const call of stagingReads) {
      const correction = stagingPathMismatch(current.contract, targets(call.args),
        call.args.cwd ?? payload.cwd ?? current.contract.repositoryRoot, 'read');
      if (correction) return correction;
    }
    return {};
  }
  if (mutationTurnMode(record.skill) === 'import-team') return importTeamGuard(payload, record, toolCalls);
  if (mutationTurnMode(record.skill) === 'build-workflow') return buildWorkflowGuard(payload, record, toolCalls);
  if (mutationTurnMode(record.skill) === 'fix-workflow') return fixWorkflowGuard(payload, record, toolCalls);
  if (mutationTurnMode(record.skill) === 'run-and-test') return runAndTestGuard(payload, record, toolCalls);
  // A drafting skill's edits to exactly the files its SFlow commands issued to this live turn pass;
  // every other call in the batch is judged as it would be alone.
  const drafts = draftKind(record.skill) && guarded.some(call => isEdit(call.name)) ? await importTeamTurn(payload, record) : null;
  const issuedDrafts = (drafts?.draftStaging ?? []).map(file => path.resolve(file));
  if (issuedDrafts.length) {
    const root = drafts.contract?.repositoryRoot ?? drafts.repositoryRoot ?? process.cwd();
    // The same exact-file check as a phase's staging grant (no links, no other path), with nothing else allowed.
    const only = { repositoryRoot: root, allow: { staging: issuedDrafts, artifacts: [], application: false },
      deny: { protectedPaths: [] }, ownership: { caseInsensitivePaths: false }, policy: {} };
    const issuedEdit = call => isEdit(call.name) && targets(call.args).length > 0 && targets(call.args).every(target => {
      try { return mutationPathDecision(only, target, call.args.cwd ?? payload.cwd ?? root).staging === true; } catch { return false; }
    });
    const rest = toolCalls.filter(call => !issuedEdit(call));
    if (rest.length < toolCalls.length) return rest.some(call => TERMINALS.has(call.name) || DELEGATION.has(call.name) || isEdit(call.name))
      ? mutationToolDecision({ ...payload, toolName: undefined, tool_name: undefined, toolArgs: undefined, tool_input: undefined, toolCalls: rest }, record) : {};
  }
  let value;
  try { value = await currentContract(payload, record); }
  catch {
    // Explicit setup/diagnostics can rebuild the contract, but a missing cache never authorizes edits.
    // A read in the same batch is judged as it is alone: this guard does not govern it.
    const cached = await boundedRecord(recordFile(payload)).catch(() => null);
    const bootstrap = { ...record, repositoryRoot: cached?.contract?.repositoryRoot ?? cached?.repositoryRoot };
    // An expired turn keeps only its reads: sync, session attach, tests run and a confirmed digest
    // still ran after 30 minutes through this fallback (route closure, 2026-10-28).
    const expired = turnExpired(record);
    if (guarded.every(call => TERMINALS.has(call.name)
      && (expired ? shellAllowed(call, 'read', bootstrap) : bootstrapAllowed(call, bootstrap)))) return {};
    if (guarded.some(call => TERMINALS.has(call.name) && workflowDeleteConfirmation(call, bootstrap))) {
      return { permissionDecision: 'deny', next: [], permissionDecisionReason: WORKFLOW_DELETE_CONFIRMATION_DENIAL };
    }
    if (guarded.some(call => TERMINALS.has(call.name) && targetOriginPinCall(call, bootstrap))) {
      return { permissionDecision: 'deny', next: [], permissionDecisionReason: TARGET_ORIGIN_PIN_DENIAL };
    }
    const hostOnly = guarded.map(call => TERMINALS.has(call.name) && hostOnlyDenial(call, bootstrap)).find(Boolean);
    if (hostOnly) {
      return { permissionDecision: 'deny', next: [], permissionDecisionReason: hostOnly };
    }
    if (guarded.some(call => TERMINALS.has(call.name) && knowledgeConfirmationCall(call, bootstrap))) {
      return { permissionDecision: 'deny', next: [], permissionDecisionReason: KNOWLEDGE_CONFIRMATION_DENIAL };
    }
    if (turnExpired(record)) return turnExpiredDenial(record);
    if (draftKind(record.skill) && guarded.some(call => isEdit(call.name))) return { permissionDecision: 'deny', next: [],
      permissionDecisionReason: `DRAFT_PATH_DENIED: this turn edits only the exact files its SFlow commands issued to it${issuedDrafts.length ? ` (${issuedDrafts.join(', ')})` : ', and none is issued yet'}. `
        + (draftKind(record.skill) === 'repair'
          ? 'Run singularity-flow repair status <REPAIR-ID> --json in this turn: while the repair awaits a patch, its repair attempt action names the patch file to write'
          : 'Run singularity-flow initiative phase draft-check <PHASE> --json in this turn (or the step\'s prepare): it issues the step\'s outputs; write only those paths')
        + '. No file was written; never write another repository file' };
    return mutationDenial(null, 'PHASE_MUTATION_CONTRACT_REQUIRED: refresh the exact binding; expired/corrupt permissions require a new explicit turn; do not discard work');
  }
  const contract = value.contract;
  value.skill = record.skill;
  for (const call of toolCalls) {
    if (stagingReads.includes(call)) {
      const correction = stagingPathMismatch(contract, targets(call.args),
        call.args.cwd ?? payload.cwd ?? contract.repositoryRoot, 'read');
      if (correction) return correction;
    }
    if (DELEGATION.has(call.name) && contract.turnMode !== 'authoring') return mutationDenial(contract, 'PHASE_MUTATION_DELEGATION_NOT_ALLOWED');
    if (TERMINALS.has(call.name)) {
      const kernel = shellAllowed(call, contract.turnMode, value);
      if (!kernel && value.findings.length) return mutationDenial({ ...contract, next: recoveryRoutes(contract) }, 'PHASE_MUTATION_REPAIR_REQUIRED');
      if (!kernel) {
        // A person's own step: the denial shows the person its exact terminal line, never the turn's generic route.
        const own = () => personRoute(call, value);
        if (environmentBinding(call, value)) return mutationDenial(contract, ENVIRONMENT_BINDING_DENIAL, [], own());
        if (plannedActionExecution(call, value)) return mutationDenial(contract, PLANNED_ACTION_DENIAL, [], own());
        const hostOnly = hostOnlyDenial(call, value);
        if (hostOnly) return mutationDenial(contract, hostOnly);
        if (publicationSetAsideCall(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: setting a waiting commit aside clears what SFlow would publish and moves the branch; the person who looked at it confirms it with the commit ID in their own terminal (the preview without --confirm may run here). Show the user the preview and the command, and stop; do not retry it', [], own());
        if (setAsideDecision(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: setting held changes aside removes them from the checkout (after a private recovery copy); the person who looked at them runs it in their own terminal. Show the user the listed files and the command, and stop; do not retry it', [], own());
        if (workflowDeleteConfirmation(call, value)) return mutationDenial(contract, WORKFLOW_DELETE_CONFIRMATION_DENIAL, [], own());
        if (decisionListRecord(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: recording the decision list is the person\'s own step: they run the exact decisions record command in their own terminal (a /sf-decide turn may record only its upstream-issue options, after their explicit yes). Show the user the summary and the command, and stop; do not retry it or change its digest', [], own());
        if (targetOriginPinCall(call, value)) return mutationDenial(contract, TARGET_ORIGIN_PIN_DENIAL, [], own());
        if (knowledgeConfirmationCall(call, value)) return mutationDenial(contract, KNOWLEDGE_CONFIRMATION_DENIAL, [], own());
        if (intentAmendmentDecisionCall(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: an intent amendment is decided by a person who approves the scope, in their own terminal, not by this turn. Show the user the amendment and the decide command, and stop; do not retry it', [], own());
        if (approvalEvidenceConfirmationCall(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: approving with --confirm-evidence also records the step\'s screenshots and inspections as witnessed, the word of the approver who looked at them, in their own terminal; an agent never signs off evidence. Approve here without it, or show the user the command and stop; do not retry it');
        if (planRowCorrectionCall(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: correcting an approved plan\'s rows is the word of a person who approves that plan, after reviewing the exact rows in their own terminal; a preview (--dry-run) is all this turn may run. Show the user the command and stop; do not retry it', [], own());
        if (liveTerminalReviewCall(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: this decision is recorded only after the person reviews its exact card in their own terminal and types the confirmation there; no turn runs or answers it. Show the user the command and stop; do not retry it', [], own());
        if (signOffCall(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: witnessing a criterion\'s evidence or accepting a dated obligation risk is the word of a person who approves the step that delivered it, after looking for themselves, in their own terminal; an agent never signs off its own work. Show the user the command and stop; do not retry it', [], own());
        if (testRunRiskDecision(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: accepting that a step\'s tests cannot run here or ran narrowed, reusing an earlier step\'s recorded run for it, that one of its screen sizes does not apply, or how a closed Story\'s drifted clause is resolved, is decided by a person who approves that step, in their own terminal, not by this turn. Show the user the command and stop; do not retry it', [], own());
        if (contract.turnMode !== 'authoring' && verifiedShellForm(call, value)) {
          return mutationDenial(contract, value.decisionEnded
            ? 'PHASE_MUTATION_DECISION_TURN_ENDED: the decision turn has ended. Preserve work and inspect the returned next action in a new turn; correcting command syntax cannot reopen approval'
            : 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: this standalone command is not permitted by the bound turn mode. Preserve work and follow the exact returned action; tool-form repair does not grant authoring or decision authority');
        }
        if (contract.turnMode !== 'authoring' && readsHostSavedOutput(call)) return mutationDenial(contract, HOST_SAVED_OUTPUT_DENIAL);
        // A tool form is corrected in this turn. A review, decision or publish turn's route is its own
        // work; any other turn's (recover, prepare, nextsteps) would send it elsewhere.
        if (contract.turnMode !== 'authoring')
          return mutationDenial(contract, `PHASE_MUTATION_TOOL_PROTOCOL: use native file-read tools for output; write only exact issued staging files with a file-edit tool (source review also supports review-source stage --report-json). Run a permitted SFlow command standalone: from a non-Git folder such as a chat folder it runs as is (SFlow finds the bound checkout); otherwise set the bound cwd${contract.repositoryRoot ? ` (${contract.repositoryRoot})` : ''} with \`cd <it> && …\` or \`env -C <it> …\`. Correct the tool form in this turn; this refusal does not invalidate the phase or require repeating clarification`, [],
            OWN_ROUTE_TURNS.has(contract.turnMode) ? {} : { routes: [] });
        if (upstreamIssueDecision(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_OPERATION_NOT_ALLOWED: an upstream issue or amendment is decided by the earlier step\'s approvers in their own terminal, not by this turn. Keep working; the Story completes once they decide it');
        if (mentionsKernelExecution(call, value)) return mutationDenial(contract,
          'PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED: run one standalone registered SFlow command; no chains or wrappers. Use a file-edit tool for the exact issued staging file. Preserve human answers and repair recording, not the questions');
      }
      // Baseline BEFORE execution, refreshed after kernel-owned operations at the CLI boundary. A
      // command that only reads changes nothing, so it needs none.
      if (!kernel && !readOnlyShell(call, value) && !value.baseline) {
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
    const correction = stagingPathMismatch(contract, denied,
      call.args.cwd ?? payload.cwd ?? contract.repositoryRoot, 'write');
    if (correction) return correction;
    const unissued = await unissuedStagingRefusal(value, denied, call.args.cwd ?? payload.cwd ?? contract.repositoryRoot);
    if (unissued) return unissued;
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
  if (mutationTurnMode(record.skill) === 'build-workflow') {
    const value = await importTeamTurn(payload, record);
    const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot };
    if (value && terminals.every(call => shellAllowed(call, 'build-workflow', scope))) return {};
    return postFinding(mutationDenial(null, 'BUILD_WORKFLOW_TURN_ENDED: the build-workflow turn ended or expired; run /sf-build-workflow again'));
  }
  if (mutationTurnMode(record.skill) === 'fix-workflow') {
    const value = await importTeamTurn(payload, record);
    const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot,
      fixStaging: (value?.fixStaging ?? []).map(file => path.resolve(file)) };
    if (value && terminals.every(call => shellAllowed(call, 'fix-workflow', scope))) return {};
    return postFinding(mutationDenial(null, 'FIX_WORKFLOW_TURN_ENDED: the fix-workflow turn ended or expired; run /sf-fix-workflow again'));
  }
  if (mutationTurnMode(record.skill) === 'run-and-test') {
    const value = await importTeamTurn(payload, record);
    const scope = { ...record, repositoryRoot: value?.contract?.repositoryRoot ?? value?.repositoryRoot,
      appDraftStaging: (value?.appDraftStaging ?? []).map(file => path.resolve(file)) };
    if (value && terminals.every(call => shellAllowed(call, 'run-and-test', scope))) return {};
    return postFinding(mutationDenial(null, 'RUN_AND_TEST_TURN_ENDED: the run-and-test turn ended or expired; run /sf-run-app or /sf-test again'));
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
    // Neither an SFlow command the turn allowed nor a command that only reads needs a shell baseline:
    // the CLI refreshes this turn at its own boundary, and a read changes nothing. A command that
    // ran without its pre-tool check (the host stops a slow hook and runs the call anyway) is
    // judged the same way; anything else is stopped, since nothing can tell what it changed.
    const ran = turnAsRun(value, record);
    if (terminals.every(call => shellAllowed(call, ran.contract.turnMode, ran) || readOnlyShell(call, value))) return {};
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

/**
 * The turn as an SFlow command found it, for judging that command after it ran: the CLI refreshes the
 * turn at its own boundary, so approve and reject have already ended their decision and a command
 * that moved the phase has already made the turn read-only. Judged by the refreshed turn, the command
 * that did it was refused after it succeeded.
 */
function turnAsRun(value, record) {
  return { ...value, decisionEnded: false, contract: { ...value.contract,
    turnMode: mutationTurnMode(record.skill ?? value.skill), phaseId: value.originPhase ?? value.contract.phaseId } };
}

// Commands that only read the checkout: no redirection, pipe or substitution, `&&` chains of these only.
const READ_ONLY_GIT = Object.freeze({
  status: /^(?:-s|--short|-b|--branch|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?|--ignored|-z)$/u,
  diff: /^(?:--stat|--numstat|--shortstat|--name-only|--name-status|--cached|--staged|--no-color|--no-renames|--check|-U\d+|--unified=\d+|-z)$/u,
  log: /^(?:--oneline|--stat|--name-only|--name-status|--no-decorate|--decorate|--graph|-\d+|-n\d*|--max-count=\d+|\d+|--format=[A-Za-z%:() -]*|--pretty=[A-Za-z%:() -]*|--no-color|-z)$/u,
  show: /^(?:--stat|--name-only|--name-status|--oneline|--no-patch|-s|--no-color|--format=[A-Za-z%:() -]*|--pretty=[A-Za-z%:() -]*)$/u,
  'ls-files': /^(?:-c|--cached|-m|--modified|-o|--others|--exclude-standard|-z|-s|--stage)$/u,
  'rev-parse': /^(?:--show-toplevel|--abbrev-ref|--verify|--short|--git-dir|--absolute-git-dir|HEAD|HEAD\^\{tree\})$/u
});

function readOnlyShell(call, value) {
  const command = scopedShellCommand(call, value);
  if (typeof command !== 'string' || /[;|`$<>\n\r]/u.test(command)) return false;
  const parts = command.split(/\s*&&\s*/u).map(part => part.trim());
  if (!parts.length || parts.some(part => !part || part.includes('&'))) return false;
  return parts.every(part => {
    const words = part.match(/'[^']*'|"[^"]*"|\S+/gu) ?? [];
    if (/^(?:pwd|ls(?: -[1aAlhR]+)*(?: [^-'"][^\s]*)*)$/u.test(part)) return true;
    let [tool, ...rest] = words;
    if (tool !== 'git') return false;
    while (rest[0] === '--no-pager' || rest[0] === '-P') rest = rest.slice(1);
    if (rest[0] === 'branch' && rest.length === 2 && rest[1] === '--show-current') return true;
    const allowed = READ_ONLY_GIT[rest[0]];
    if (!allowed) return false;
    let paths = false;
    return rest.slice(1).every(word => {
      if (word === '--') return (paths = true);
      // After `--`, or not an option: a path or revision, quoted or plain.
      if (paths || !word.startsWith('-')) return !/^-/u.test(word.replace(/^['"]/u, ''));
      return allowed.test(word);
    });
  });
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
    // A confirmation runs once: after a command changed this checkout, its turn has nothing left to run.
    if (advanceBaseline && next.contract.turnMode === 'confirm') next.decisionEnded = true;
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
    const suffix = issuedSuffix(path.resolve(target));
    if (suffix) await atomicRecord(issuedReadFile({ sessionId: value.sessionId }, value.turnId, `staging:${suffix}`), {
      kind: 'copilot-issued-staging', root, turnId: value.turnId, workId: value.contract.workId,
      phaseId: value.contract.phaseId, generation: value.contract.generation,
      mode: value.contract.turnMode, path: path.resolve(target)
    });
    await atomicRecord(file, value);
  }
}

/** Register exact generated files as read references only, scoped to live turns in this checkout. */
export async function issueMutationReadPaths(root, targets) {
  if (readCopilotMode().paused || !targets.length) return;
  root = await realpath(root);
  const paths = [...new Set(targets.map(target => path.resolve(target)))];
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if ((value?.contract?.repositoryRoot ?? value?.repositoryRoot) !== root) continue;
    const record = await turn({ sessionId: value.sessionId });
    if (!record || record.turnId !== value.turnId || Date.now() - value.recordedAt > MAX_AGE) continue;
    // Immutable per-file entries avoid read/modify/write races between parallel CLI results.
    // They are removed at turn replacement/end; output pruning still owns the actual files.
    for (const target of paths) {
      const suffix = issuedSuffix(target);
      if (suffix) await atomicRecord(issuedReadFile({ sessionId: value.sessionId }, value.turnId, issuedKey(suffix)), {
        kind: 'copilot-issued-read', root, turnId: value.turnId, path: target
      });
    }
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

/**
 * Let live /sf-build-workflow turns edit `target`, the proposal file of a build `workflow build`
 * just showed. As for team import, every live build-workflow turn for the same repository (or with
 * none) receives the exact path. Returns how many turns received it.
 */
export async function issueBuildStaging(target, { root = null } = {}) {
  if (readCopilotMode().paused) return 0;
  const resolvedRoot = root ? await realpath(root).catch(() => path.resolve(root)) : null;
  let issued = 0;
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if (!value || mutationTurnMode(value.skill) !== 'build-workflow') continue;
    const record = await turn({ sessionId: value.sessionId });
    if (!record || !await importTeamTurn({ sessionId: value.sessionId }, record)) continue;
    const owner = value.contract?.repositoryRoot ?? value.repositoryRoot ?? null;
    if (owner && resolvedRoot && owner !== resolvedRoot) continue;
    value.buildStaging = [...new Set([...(value.buildStaging ?? []), path.resolve(target)])].slice(-16);
    await atomicRecord(file, value);
    issued += 1;
  }
  return issued;
}

/**
 * Let live /sf-fix-workflow turns edit `target`, the change set draft `workflow validate` just
 * returned as fixDraft.changeSetPath, and propose exactly that file. As for builds, every live
 * fix-workflow turn for the same repository (or with none) receives the exact path. Returns how many
 * turns received it.
 */
export async function issueFixWorkflowStaging(target, { root = null } = {}) {
  if (readCopilotMode().paused) return 0;
  const resolvedRoot = root ? await realpath(root).catch(() => path.resolve(root)) : null;
  let issued = 0;
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if (!value || mutationTurnMode(value.skill) !== 'fix-workflow') continue;
    const record = await turn({ sessionId: value.sessionId });
    if (!record || !await importTeamTurn({ sessionId: value.sessionId }, record)) continue;
    const owner = value.contract?.repositoryRoot ?? value.repositoryRoot ?? null;
    if (owner && resolvedRoot && owner !== resolvedRoot) continue;
    value.fixStaging = [...new Set([...(value.fixStaging ?? []), path.resolve(target)])].slice(-16);
    await atomicRecord(file, value);
    issued += 1;
  }
  return issued;
}

/**
 * Let live /sf-run-app and /sf-test turns write `target`, the application block draft `app suggest`
 * just named as draft.applicationFile, and propose exactly that file. Returns how many turns received it.
 */
export async function issueRunAppDraftStaging(target, { root = null } = {}) {
  if (readCopilotMode().paused) return 0;
  const resolvedRoot = root ? await realpath(root).catch(() => path.resolve(root)) : null;
  let issued = 0;
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if (!value || mutationTurnMode(value.skill) !== 'run-and-test') continue;
    const record = await turn({ sessionId: value.sessionId });
    if (!record || !await importTeamTurn({ sessionId: value.sessionId }, record)) continue;
    const owner = value.contract?.repositoryRoot ?? value.repositoryRoot ?? null;
    if (owner && resolvedRoot && owner !== resolvedRoot) continue;
    value.appDraftStaging = [...new Set([...(value.appDraftStaging ?? []), path.resolve(target)])].slice(-16);
    await atomicRecord(file, value);
    issued += 1;
  }
  return issued;
}

/**
 * Let live turns of the skills that draft `kind` files (DRAFT_SKILLS) in this repository edit exactly
 * `targets`, files an SFlow command just issued: an Epic or Initiative step's authored outputs, or a
 * repair's patch file. A turn without a known repository receives nothing. Returns how many turns did.
 */
export async function issueDraftStaging(kind, targets, { root }) {
  if (readCopilotMode().paused || !targets.length) return 0;
  const resolvedRoot = await realpath(root).catch(() => path.resolve(root));
  // Canonical like the turn's root, so a symlinked temporary directory still names the same file.
  const exact = await Promise.all(targets.map(target => realpath(path.dirname(path.resolve(target)))
    .then(parent => path.join(parent, path.basename(target))).catch(() => path.resolve(target))));
  let issued = 0;
  for (const name of (await readdir(directory()).catch(() => [])).filter(name => /^[a-f0-9]{64}\.mutation\.json$/u.test(name))) {
    const file = path.join(directory(), name);
    const value = await boundedRecord(file).catch(() => null);
    if (!value || draftKind(value.skill) !== kind || (value.contract?.repositoryRoot ?? value.repositoryRoot) !== resolvedRoot) continue;
    const record = await turn({ sessionId: value.sessionId });
    if (!record || !await importTeamTurn({ sessionId: value.sessionId }, record)) continue;
    value.draftStaging = [...new Set([...(value.draftStaging ?? []), ...exact])].slice(-32);
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
