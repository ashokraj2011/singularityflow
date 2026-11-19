/** Pinned phase permissions, not a filesystem sandbox or a new lifecycle authority. */
import path from 'node:path';
import { stepState } from './kernel/step-state.mjs';
import { decisionRoutes, onlyDeterministic, stepSnapshotOf } from './step-decision.mjs';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { phaseRequiresCodeDelivery, generationSkillForPhase } from './code-delivery-policy.mjs';
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { isCopilotHooksPath } from './governed-roots.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { intentAmendmentPause, intentAmendmentPauseReason } from './intent-amendment-pause.mjs';
import { AUTHORING_VERIFICATION_PROTOCOL, CLI_PATH_CONTRACT, safeCommandGuidance } from './safe-command-guidance.mjs';
import { AUTHORING_SKILL_DECLARATION } from './authoring-skills.mjs';
import { WRITING_ALIASES } from './writing-aliases.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { formatCommandRouteLines, VSCODE_DECIDE_CARD } from './model-free-commands.mjs';
import { WORK_COMMANDS } from './command-skills.mjs';
import { phasePublicationContract } from './manual-authorship.mjs';

// The kernel's adapter and the host's rendering of its decision live in step-decision.mjs, shared with every surface.
export { decisionRoutes, stepSnapshotOf } from './step-decision.mjs';

export const MUTATION_CONTRACT_VERSION = 1;
/**
 * The skills whose own steps run registered SFlow commands the registry calls mutations and edit no
 * file. A read turn refused each of them its core step (`finalize`, `pr --create`, `sync <INTENT-ID>`,
 * `story start`, `epic start`, `mcp smoke`, …). The kernel-only turn admits any registered command
 * except approval, rejection and the person-only decisions the guard names, and no file edits.
 */
const KERNEL_ONLY_SKILLS = new Set([
  'inputs', 'recover', 'appeal', 'clarify', 'revise', 'submit', 'continue',
  'admin', 'init', 'configuration', 'documents', 'upload', 'workflows', 'workflow-rules', 'skills', 'instructions',
  'capability-map', 'workspace', 'worldmodel', 'start', 'test-setup',
  // Story lifecycle actions on a bound Story.
  'assign', 'cancel', 'finalize', 'fix', 'gate', 'pr', 'refresh-branch', 'review', 'revision-attachments',
  'spec', 'story-checks', 'story-skill-version', 'visual', 'work-interval',
  // Story intake, setup and repository-level actions that run before or without a Story.
  'story-start', 'story-fetch', 'story-branch', 'ready', 'return', 'adhoc', 'agents', 'auto', 'constitution',
  'call-add', 'environment', 'factory-reset', 'fault', 'governance-rebuild', 'impact', 'import', 'integrations',
  'knowledge', 'learn', 'ledger', 'mcp', 'prompt-log', 'reset-all', 'secrets', 'sgos', 'sgos-create', 'stack',
  'telemetry', 'watch',
  // The security team's and TLM owners' workbook into the register, and remediation Stories (CQF M6).
  'findings',
  'capability-add', 'capability-depend', 'capability-protect', 'capability-doctor',
  'workspace-bootstrap', 'workspace-impact', 'refresh-configuration',
  // Machine-level installation, reset and local state.
  'fresh-install', 'local-reset', 'local', 'product', 'plugin', 'push', 'quickstart', 'goal', 'journal', 'reinstall',
  // Epic, Initiative and Jira actions (Epic and Initiative checkouts bind no Story).
  'epic-complete', 'epic-drift', 'epic-merge-plan', 'epic-planning', 'epic-publish', 'epic-requirements', 'epic-resume',
  'epic-review', 'epic-review-decision', 'epic-sources', 'epic-start', 'epic-stories', 'epic-story-draft', 'epic-sync',
  'initiative-approve', 'initiative-evidence', 'initiative-materialize', 'initiative-phase', 'initiative-start',
  'jira-initiative', 'jira-update'
]);

export function mutationTurnMode(skill) {
  const name = String(skill ?? '').replace(/^\/?(?:sf|sflow)-/u, '');
  // /sf-amend is /sf-reject's intent-amendment route on its own; the guard narrows its turn to that route.
  if (['approve', 'reject', 'amend'].includes(name)) return 'approval-only';
  if (['session', 'resume', 'agent'].includes(name)) return 'session-only';
  if (name === 'review-source') return 'read-only-review';
  if (name === 'review-decide') return 'review-decision-only';
  // /sf-decide records a person's typed choice; its decision commands carry their own authority check.
  if (name === 'decide') return 'decision-only';
  if (name === 'confirm') return 'confirm';
  // /sf-run-app and /sf-test start, check and stop the declared application and run the declared
  // tests (`app` and `tests`); they edit nothing and never bind environment values.
  if (['run-app', 'test', 'test-scope', 'app-review', 'outcome'].includes(name)) return 'run-and-test';
  // /sf-inbox, /sf-stories and /sf-workspace-session read and then attach a session (`session attach`,
  // the /sf-session steps, `session workspace`).
  if (['inbox', 'stories', 'workspace-session'].includes(name)) return 'session-only';
  if (name === 'publish') return 'publish-only';
  // /sf-import-team converts a team directory through its own CLI commands and one issued
  // candidate file; it never edits a repository (copilot-mutation-guard.mjs importTeamGuard).
  if (name === 'import-team') return 'import-team';
  // /sf-build-workflow grows a machine-local workflow build through `workflow build` and one issued
  // proposal file; finishing goes through Workflow Studio's reviewed apply (buildWorkflowGuard).
  if (name === 'build-workflow') return 'build-workflow';
  // /sf-fix-workflow reads `workflow validate` and `workflow check`, writes the one change set draft
  // `workflow validate` issued, and proposes it through Workflow Studio's reviewed apply (fixWorkflowGuard).
  if (name === 'fix-workflow') return 'fix-workflow';
  // /sf-spec-author reads a specification draft, collects cited research and stages one issued
  // proposal file; a person accepts each proposal (specStudioGuard, SPEC-SPA v1.3 §4.1).
  if (name === 'spec-author') return 'spec-studio';
  if (AUTHORING_SKILL_DECLARATION[`sflow-${name}`]) return 'authoring';
  // Every writing alias, from the one table that names them (writing-aliases.mjs) [OSA:REQ-027, AC-019]. /sf-specify,
  // /sf-plan and /sf-verify run `prepare` and write the current step's artifacts, and /sf-implement, /sf-call and
  // /sf-scenario-repair run /sf-code (/sf-call a document step through /sf-phase) in the same turn. No step names them as
  // its author, but they author like /sf-phase, bound to the current step's own policy; a read turn refused what their
  // instructions do. Every delegation skill takes the turn of the skill it delegates to (phase-mutation-contract.test.mjs).
  // /sf-converge writes the step's document at a model-generation checkpoint; a deterministic step's contract still grants
  // no edits (deriveMutationContract), so its kernel-built publication is unchanged. /sf-code-docs writes doc comments into
  // the code the open generation changed, under that step's own policy like /sf-code; a closed or published generation
  // grants it no source edits. /sf-run runs the guided `run` (`next` and `submit`) and then the step's work command in the
  // same turn. /sf-next does the current step's own agent work in its turn (D2, SPEC-OSA v1.1 Stage 4) [OSA:REQ-025]: the
  // kernel's decision still grants its writes, so where the step's next action is a person's, or not this step's, it
  // writes nothing, and its other actions (sync, a relayed decision, a chat reset) are the registered commands every
  // authoring turn runs.
  if (Object.hasOwn(WRITING_ALIASES, name)) return 'authoring';
  // Kernel actions have their own authority checks. This never permits direct source edits.
  if (KERNEL_ONLY_SKILLS.has(name)) return 'kernel-only';
  // Every other skill only reads. Each registry skill's own SFlow commands are held to its turn by
  // the registry-wide test in phase-mutation-contract.test.mjs, so a new skill cannot silently get one
  // that refuses its own steps.
  return 'read';
}

/**
 * Where a change the person typed for the step's next version is read (requested-successor.mjs): an authoring turn whose
 * decision would otherwise review or submit the published version. Read there, the decision asks its version question.
 */
export const changeRequestApplies = (contract) => contract?.turnMode === 'authoring'
  && ['published', 'in-review', 'review-ready'].includes(contract.policy?.step?.state);

function route(argv, detail, skill = null) {
  const guidance = safeCommandGuidance({ argv, ...(skill ? { skill } : {}) });
  return { detail, ...guidance, commandGuidance: guidance,
    modelFreeStatus: guidance?.modelFreeCommand ? 'available' : 'unavailable' };
}

function caseInsensitiveCheckout(root) {
  if (!root) return false;
  const base = path.basename(root);
  const alternate = base.replace(/[a-z]/iu, character => character === character.toUpperCase()
    ? character.toLowerCase() : character.toUpperCase());
  if (alternate === base) return ['darwin', 'win32'].includes(process.platform);
  try {
    const original = lstatSync(root);
    const other = lstatSync(path.join(path.dirname(root), alternate));
    return original.dev === other.dev && original.ino === other.ino;
  } catch { return false; }
}

export function deriveMutationContract({ root = null, definition, workflow, phase = workflow?.phases?.[workflow.currentPhase],
  turnMode = 'authoring', staging = [], evidence = [], opening = null, sources = {}, task = null, changeRequested = false, skill = null }) {
  const workId = workflow?.workItem?.id ?? null;
  const repositoryRoot = root ? realpathSync.native(root) : null;
  const ownership = applicationPathContext(definition, workflow);
  const workItemRoot = workflow?.resolution?.workItemRoot ?? definition?.workItemRoot ?? 'singularity/work-items';
  const item = `${workItemRoot}/${workId}`;
  const code = phaseRequiresCodeDelivery(phase);
  // One decision owner: the kernel decides the step's state, what an authoring turn may write and its next action
  // [OSA:REQ-001, REQ-010]; this module renders it and keeps the path checks.
  // `opening`: the open version's acceptance and writer as the caller observed them on this checkout (a few file reads,
  // never Git: story-version-acceptance.mjs) [OSA:REQ-041]; without it an operation's opening grants nothing.
  // `task`: the step's durable task stage as the caller read it (workflow-task-outcome.mjs readGuardTaskOutcome): a spent
  // repair budget, or a wait for a person, input or environment, grants this turn nothing, as every view says [§8, OSA:REQ-010].
  // `changeRequested`: the person's typed words wait for the published step's next version (requested-successor.mjs), so the
  // decision, this permission and the entry's act all ask its version question, never its submission [daily run 2026-11-17].
  const decision = phase ? stepState(stepSnapshotOf({ workflow, phase, turnMode, opening, sources, task, changeRequested })) : null;
  const openGeneration = code && decision?.publication.hasOpenVersion === true;
  const editable = decision?.edit.authoring === true;
  const deterministic = onlyDeterministic(phase);
  const ownsCode = (workflow?.phaseOrder ?? []).slice(0, (workflow?.phaseOrder ?? []).indexOf(phase?.id))
    .some(id => phaseRequiresCodeDelivery(workflow.phases[id]) && workflow.phases[id]?.status === 'approved');
  const artifacts = [`${item}/artifacts/${phase?.id}/`];
  // Required artifacts are resolved relative to the work item, not necessarily a seeded folder.
  // Only exact configured paths are added; recorded source files cannot widen artifact-only scope.
  if (phase?.requiredArtifact?.path) {
    const configured = path.posix.normalize(`${item}/${phase.requiredArtifact.path}`);
    if (configured.startsWith(`${item}/`) && !configured.startsWith(`${item}/context/`)
        && !['workflow.json', 'source.json'].includes(configured.slice(item.length + 1))) artifacts.push(configured);
  }
  // The exact evidence files the approved plan allocates to this open code generation are its
  // author's deliverable (plannedEvidencePaths). Exact files only, never the evidence directory.
  if (code && openGeneration) {
    for (const file of evidence) {
      const exact = path.posix.normalize(String(file));
      if (exact.startsWith(`${item}/evidence/`) && !exact.endsWith('/') && !exact.split('/').includes('..')) artifacts.push(exact);
    }
  }
  // An undecided amendment proposed from this step pauses it: no file of it changes and nothing moves it, so the
  // proposal cannot go stale; reads and the amendment's own status and draft stay open [owner, 2026-11-13].
  const pause = phase ? intentAmendmentPause(workflow, phase.id) : null;
  const paused = pause && ['authoring', 'kernel-only', 'publish-only'].includes(turnMode);
  // The categories the decision grants: a deterministic code step builds only its summary, its code in the open version.
  const application = decision?.edit.permittedCategories.includes('application') === true;
  const next = !phase ? [route(['session', 'current', '--for-agent', '--json'], 'Resolve the Story binding first.')]
    : turnMode === 'read-only-review'
      ? [sourceReviewKind(workflow, phase.id)
        ? route(['review-source', 'context', phase.id, '--for-agent', '--json'], 'Use the pinned review packet and its staging protocol; no shell writers or repository edits.')
        : route(['nextsteps', '--json'], 'This step has no source review; inspect the next action.')]
    : turnMode === 'review-decision-only'
      ? [route(['review-source', 'decision-context', phase.id, '--work-id', workId,
        '--finding', '<FINDING-ID>', '--reason', '<TEXT>', '--json'],
        'Prepare and confirm the exact pending human disposition; no reviewer retention, authoring, submission or approval.')]
    : turnMode === 'decision-only'
      ? [route(['decision', 'show', workId, '--json'],
        "Record only the person's typed choice and reason; no authoring, submission, approval, rejection or next.", '/sf-decide')]
    : paused ? [route(['decisions', workId], `A person who approves the scope decides ${pause.id} on the decisions card.`, '/sf-decide')]
    : turnMode === 'publish-only'
      ? [route(['phase', 'publish', phase.id, '--authored', phasePublicationContract(phase).producer,
        '--channel', phasePublicationContract(phase).channel], 'Recheck publication readiness first; publish only when the kernel returns ready. Never author, submit or approve.')]
    : ['approval-only', 'session-only', 'read', 'read-only-review', 'import-team', 'build-workflow', 'fix-workflow', 'confirm', 'run-and-test', 'spec-studio'].includes(turnMode)
      ? [route(['nextsteps', '--json'], 'End this turn. Inspect the next action in a new turn; do not author now.')]
      // The kernel's primary action for this step: its own way on, recover only for positive damage [OSA:REQ-011, C1].
      : decisionRoutes(decision, workflow, phase);
  const summary = paused ? `${intentAmendmentPauseReason(workflow, pause)}. Reads, and \`singularity-flow story intent-amendment status\` and \`singularity-flow story intent-amendment draft\`, stay open.`
    : turnMode === 'approval-only' ? 'Approval/rejection only. No file edits or next-phase authoring; end this turn after the decision.'
    : turnMode !== 'authoring' ? 'This chat edits no repository file directly: only the exact files its SFlow commands issue, and the SFlow commands it allows.'
      : !editable && decision?.next.inputs.consent === 'required' ? `No edits before the person's yes to version ${decision.next.inputs.version} of ${phase.id}: run the returned preview, ask them its question, and only on their yes open it and do its work in this turn.`
      : !editable ? 'No direct edits: this step is not being written now. Take its returned next action.'
      : deterministic && !code ? 'No direct edits to this deterministic generation. Use the returned kernel action.'
        : deterministic && application ? 'May edit application paths within pinned policy; the summary is built by `singularity-flow prepare` from what changed, never edited by hand.'
        : deterministic && code ? 'No edits until its code version is open: open it with the returned action. The summary is built by `singularity-flow prepare` from what changed, never edited by hand.'
        : application ? `May edit this phase's artifacts and ${phase.sourceBoundary === 'test-automation' ? 'test-automation' : 'application'} paths within pinned policy; protected and governed state remain kernel-owned.`
          : `May edit this phase's artifacts only.${code ? ' Open a code generation before application edits.' : ' Do not implement application code in this phase.'}`;
  // The skill this chat was started with: a refusal here never sends the person back to it (mutationDenial).
  const turnSkill = turnSkills(skill)[0] ?? null;
  return {
    schemaVersion: MUTATION_CONTRACT_VERSION, kind: 'phase-mutation-contract',
    workId, phaseId: phase?.id ?? null, generation: phase?.generation ?? null, turnMode, ...(turnSkill ? { turnSkill } : {}), summary,
    // The skill that drafts this step, named in every turn so no turn guesses one (/sf-code for a plan).
    authoringSkill: phase ? directCopilotSkill(generationSkillForPhase(phase, workflow)) : null,
    repositoryRoot,
    policy: { writeScope: phase?.writeScope ?? 'artifact-only', sourceBoundary: phase?.sourceBoundary ?? 'unrestricted',
      requiresOpenGeneration: code, openGeneration, editable, supportingChangesOnly: !code && !ownsCode,
      // The kernel's decision this contract renders, and the version an authoring task here works on [OSA:REQ-002, C22].
      ...(decision ? { step: { state: decision.state, next: decision.next.actionId, reasons: decision.next.reasonCodes,
        version: decision.version.writing ?? decision.version.proposedNext } } : {}),
      ...(pause ? { intentAmendmentPause: { id: pause.id, phaseId: phase.id } } : {}),
      // SPEC-CIC switch 3: a proposal in chat waits for the person's yes (copilot-answer-binding.mjs) [CIC:REQ-015].
      ...(workflow?.resolution?.spec?.changeImpact === 'on' ? { changeImpact: true } : {}) },
    allow: { artifacts: decision?.edit.permittedCategories.includes('step-artifacts') ? artifacts : [], application, staging },
    deny: { protectedPaths: [...new Set([...(definition?.governance?.protectedPaths ?? []),
      ...(workflow?.resolution?.governance?.protectedPaths ?? []),
      ...(workflow?.resolution?.capability?.policy?.protectedPaths ?? [])])],
      governedState: true, gitMetadata: true, otherRepositories: true },
    ownership: { ...ownership, caseInsensitivePaths: ownership.caseInsensitivePaths || caseInsensitiveCheckout(repositoryRoot) },
    enforcement: { edits: 'unverified', shell: 'detected-at-lifecycle', sandbox: false,
      detail: 'Hook interception is tool-specific. Installation alone does not prove host enforcement.' }, next
  };
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** New files validate every existing ancestor; moves validate both endpoints at the caller. */
export function mutationPathDecision(contract, target, cwd = contract.repositoryRoot) {
  if (typeof target !== 'string' || !target || /[\u0000-\u001f\u007f]/u.test(target)) return { allowed: false, reason: 'missing-or-invalid-target' };
  if (target.startsWith('file:')) {
    try { target = fileURLToPath(target); } catch { return { allowed: false, reason: 'invalid-file-uri' }; }
  }
  const root = realpathSync.native(contract.repositoryRoot);
  let absolute = path.resolve(cwd, target);
  try {
    const realCwd = realpathSync.native(cwd);
    if (contained(root, realCwd) && contained(path.resolve(cwd), absolute)) {
      absolute = path.resolve(realCwd, path.relative(path.resolve(cwd), absolute));
    }
  } catch { return { allowed: false, reason: 'unverified-cwd' }; }
  let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) return { allowed: false, reason: 'linked-target' };
    } catch (error) { if (error.code !== 'ENOENT') return { allowed: false, reason: 'unreadable-target' }; }
  }
  // Git-private staging is the only external write exception, exact and issuer-provided.
  if ((contract.allow.staging ?? []).some(file => path.resolve(file) === absolute)) return { allowed: true, path: absolute, staging: true };
  if (!contained(root, absolute)) return { allowed: false, reason: 'outside-bound-worktree' };
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const compared = contract.ownership.caseInsensitivePaths ? relative.toLowerCase() : relative;
  const matches = prefix => {
    const value = contract.ownership.caseInsensitivePaths ? prefix.toLowerCase() : prefix;
    return compared === value.replace(/\/$/u, '') || compared.startsWith(`${value.replace(/\/$/u, '')}/`);
  };
  // Git's own files and SFlow's Copilot hooks are never an agent's to change, whatever the repository protects.
  if (!relative || /^(?:\.git)(?:\/|$)/iu.test(relative) || isCopilotHooksPath(relative)
      || contract.deny.protectedPaths.some(matches)) return { allowed: false, reason: 'protected-path', path: relative };
  if (contract.allow.artifacts.some(matches)) return { allowed: true, path: relative };
  if (!isApplicationPath(relative, contract.ownership)) return { allowed: false, reason: 'kernel-owned-state', path: relative };
  if (!contract.allow.application) return { allowed: false, reason: 'application-edits-not-allowed', path: relative };
  if (contract.policy.sourceBoundary === 'test-automation' && !isTestAutomationPath(relative)) return { allowed: false, reason: 'test-automation-only', path: relative };
  if (contract.policy.supportingChangesOnly && classifySupportingChange(relative).refused) return { allowed: false, reason: 'no-approved-code-owner', path: relative };
  return { allowed: true, path: relative };
}

/** Compact delivery; the hook retains the complete pinned ownership boundary. */
export function mutationContractPresentation(contract) {
  return { schemaVersion: contract.schemaVersion, scope: 'phase-policy', workId: contract.workId,
    phaseId: contract.phaseId, generation: contract.generation, summary: contract.summary,
    policy: contract.policy, artifacts: contract.allow.artifacts, applicationEdits: contract.allow.application,
    codeAuthoringReady: contract.policy.requiresOpenGeneration && contract.allow.application,
    // Only while the step is being written: a published step has no edit to wait for [OSA:REQ-011, C1].
    sourceEditPrerequisite: contract.turnMode === 'authoring' && contract.policy.requiresOpenGeneration && contract.policy.editable
      && !contract.allow.application ? contract.next[0] ?? null : null,
    enforcement: contract.enforcement, toolProtocol: mutationToolProtocol(contract), next: contract.next };
}

/** Tool-form errors are recoverable in the same bound turn, not lifecycle failures. */
export function mutationToolProtocol(contract) {
  const authoring = contract.turnMode === 'authoring';
  const verification = authoring && (contract.allow.application || contract.allow.artifacts.length > 0);
  return { paths: CLI_PATH_CONTRACT,
    read: `Use native file-read tools at the exact issued path, including Git-private files outside the checkout. Recover size/range limits using issued readRequests/readRanges in the reader's supported parameters; finish the remaining ranges and continue the current task. Preserve real missing-file/permission errors and their owner recovery routes; never recreate inputs or retry unchanged access.${authoring ? '' : ' Do not run shell parsers or wrappers in a restricted turn.'}`,
    completion: 'Honor the current taskCompletion checkpoint. Reading inputs, preparation and diagnostic test passes do not complete authoring or review. Finish only within the admitted scope; otherwise report the exact blocker and owner route. Human approval and single-step requests keep their original boundaries.',
    staging: 'Use a file-edit tool only at an exact kernel-issued staging path. No shell writers, mkdir or arbitrary temporary paths.',
    terminal: authoring
      ? 'Run every SFlow command standalone, reads included (never piped to head, redirected or chained), with cwd=repositoryPath. Repository-local authoring shell commands are permitted under the pinned file policy and before/after change detection; this is not a standalone-SFlow-only terminal.'
      : 'Run one standalone registered SFlow command with cwd=repositoryPath, or as is from a non-Git folder such as a chat folder (SFlow finds the bound checkout; `cd <it> && …` or `env -C <it> …` also sets it); no pipes, redirects, substitutions or other command chains.',
    localVerification: { allowed: verification, guidance: verification ? AUTHORING_VERIFICATION_PROTOCOL :
      'This retained, deterministic or non-authoring turn does not grant local test/app execution. Use its returned authoring or kernel route; do not reopen a phase or broaden write permissions.' },
    retry: 'Correct the tool form without re-asking settled questions or changing lifecycle state.',
    mode: contract.turnMode };
}

// ---- A refusal never sends the person back to the chat they are in [owner, 2026-11-19, loop 1] ----------------------------
// Inside /sf-decide a refused command's route was /sf-decide again: the person typed it, came back here, and went round.
// The one exception is renewal: the chat's permissions really ended, so the same command again is how to go on.

/** The codes whose route may be the chat's own command: its permissions ended or expired. */
export const TURN_RENEWAL_CODE = /^(?:PHASE_MUTATION_TURN_EXPIRED|[A-Z][A-Z0-9_]*_TURN_ENDED):/u;
/** The modes only one skill takes, for a contract derived without the chat's own skill. */
const ONE_SKILL_MODES = Object.freeze({ 'decision-only': '/sf-decide', 'review-decision-only': '/sf-review-decide',
  'read-only-review': '/sf-review-source', 'publish-only': '/sf-publish', confirm: '/sf-confirm' });
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const slashSkill = (value) => {
  const word = String(value ?? '').trim().split(/\s+/u)[0].replace(/^\/?(?:sf|sflow)-/u, '');
  return /^[a-z][a-z0-9-]*$/u.test(word) ? `/sf-${word}` : null;
};

/** The chat's own skill as `/sf-<name>`, first, then every other name its work goes by (/sf-code and /sf-phase are one). */
export function turnSkills(skill, turnMode = null) {
  const own = slashSkill(skill) ?? ONE_SKILL_MODES[turnMode] ?? null;
  if (!own) return [];
  return [...new Set([own, ...(['work-command', 'delegate'].includes(WRITING_ALIASES[own.slice(4)]?.kind) ? WORK_COMMANDS : [])])];
}

/** Whether a route sends the person to one of these skills, by its Copilot command or its skill. */
export function routesToSkill(route, skills) {
  return [route?.copilotCommand, route?.skill, route?.commandGuidance?.copilotCommand, route?.commandGuidance?.skill]
    .some((value) => typeof value === 'string' && value.startsWith('/') && skills.includes(slashSkill(value)));
}

/** The person's way to the Decide card from inside /sf-decide: the card here, or their own terminal line, all filled in. */
export function decideCardInThisChat(route, workId) {
  const { detail: ignored, commandGuidance, modelFreeStatus, ...guidance } = route ?? {};
  // A read of the list or of a decision is not the person's step: the card's own record command is.
  const read = !Array.isArray(guidance.argv) || (guidance.argv[0] === 'decision' && guidance.argv[1] === 'show')
    || (guidance.argv[0] === 'decisions' && !['record', 'undo'].includes(guidance.argv[1]));
  const base = read ? { ...(safeCommandGuidance({ argv: ['decisions', 'record', workId] }) ?? guidance) } : guidance;
  const card = { ...base, skill: null, copilotCommand: `/decide ${workId}`, modelFreeCommand: base.modelFreeCommand ?? VSCODE_DECIDE_CARD };
  return { detail: `Open the Decide card in this chat: call #sflowDecide (VS Code) or sflow_decide (Copilot CLI) with workId ${workId} only; `
    + 'the person answers there, or runs the Shell line in their own terminal.', ...card,
  ...(commandGuidance ? { commandGuidance: card } : {}), modelFreeStatus: 'available', decideCard: { vscode: '#sflowDecide', copilotCli: 'sflow_decide', workId } };
}

/**
 * A route to the chat's own skill, replaced, in this order: the next real action (the Decide card, in a /sf-decide chat),
 * the person's exact terminal line, or, for the chat's own route, the same command run here. Never the skill again.
 */
function withoutOwnSkill(route, skills, { workId, own }) {
  if (!routesToSkill(route, skills)) return route;
  if (skills[0] === '/sf-decide') {
    const named = String(route?.copilotCommand ?? '').trim().split(/\s+/u)[1];
    const id = [workId, named].find((value) => STORY_ID.test(value ?? ''));
    return id ? decideCardInThisChat(route, id) : null;
  }
  const none = { skill: null, copilotCommand: null, ...(own ? { inThisChat: true } : {}) };
  return { ...route, ...none, ...(route.commandGuidance ? { commandGuidance: { ...route.commandGuidance, ...none } } : {}),
    ...(own ? { detail: 'Run it in this chat; never send the person to start this chat again.' } : {}) };
}

export function mutationDenial(contract, reason, paths = [], { routes = null, alone = false, turn = null, workId = null } = {}) {
  // Any SFlow command, a read too, rebuilds this turn's binding (cli-entry.mjs), so the way back is a read
  // in this turn; `phase enter` in a new /sf-phase turn sent approval and decision turns elsewhere (2026-10-28).
  const own = !routes;
  let actions = routes ?? (contract?.next?.length ? contract.next : [route(['session', 'current', '--for-agent', '--json'],
    'Preserve existing work. Run this read in this chat: it ties the chat to the Story as it is now; a missing selection uses /sf-session.')]);
  // `alone`: the reason is whole (an answer-bound refusal reads no contract), so no contract summary follows it. A reason that
  // ends its own sentence gets no second period ("which asks them.. No current…", daily run 2026-11-17).
  let said = `${reason}${paths.length ? ` (${paths.join(', ')})` : ''}`.replace(/\.+$/u, '');
  const skills = TURN_RENEWAL_CODE.test(reason) ? [] : turnSkills(turn ?? contract?.turnSkill, contract?.turnMode);
  if (skills.length) {
    const story = [workId, contract?.workId].find((value) => STORY_ID.test(value ?? '')) ?? null;
    const replaced = actions.map((action) => withoutOwnSkill(action, skills, { workId: story, own }));
    const swapped = replaced.some((action, index) => action !== actions[index]);
    actions = replaced.filter(Boolean);
    // Words that name this chat's own command are never its way on: they say so, and where the way is.
    const named = new RegExp(`(?:^|[\\s(\`'"])${skills[0]}(?![\\w-])`, 'u').test(said);
    if (skills[0] === '/sf-decide' && (named || swapped)) {
      said += `. Never send the person to /sf-decide again: this chat is it. ${story ? `The Decide card opens here: call #sflowDecide (VS Code) or sflow_decide (Copilot CLI) with workId ${story}`
        : 'Waiting on the person: they answer on the Decide card (#sflowDecide or sflow_decide with the Story ID) or in their own terminal (singularity-flow decisions record <Story ID>)'}`;
    } else if (named) said += `. Never send the person to ${skills[0]} again: this chat is it`;
  }
  // The chat's own route has no Copilot command to type: this chat runs it.
  const lines = actions.map(action => formatCommandRouteLines(action).map((line, index) => (index === 0 && action.inThisChat
    ? '- Copilot: run it in this chat' : line)).join('\n'));
  return { permissionDecision: 'deny', permissionDecisionReason:
    `${said}.${alone ? '' : ` ${contract?.summary ?? 'SFlow holds no current permissions for this chat.'}`}${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`.trimEnd(),
    next: actions };
}
