/** Pinned phase permissions, not a filesystem sandbox or a new lifecycle authority. */
import path from 'node:path';
import { versionFactsOf } from './phase-generation-need.mjs';
import { stepState } from './kernel/step-state.mjs';
import { pendingIntentAmendmentAcknowledgement, sourceReviewRequired } from './source-review-policy.mjs';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { phaseKernelOwned, phaseRequiresCodeDelivery, generationSkillForPhase } from './code-delivery-policy.mjs';
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { isCopilotHooksPath } from './governed-roots.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { intentAmendmentPause, intentAmendmentPauseReason } from './intent-amendment-pause.mjs';
import { AUTHORING_VERIFICATION_PROTOCOL, CLI_PATH_CONTRACT, safeCommandGuidance } from './safe-command-guidance.mjs';
import { AUTHORING_SKILL_DECLARATION } from './authoring-skills.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { phasePublicationContract } from './manual-authorship.mjs';

export const MUTATION_CONTRACT_VERSION = 1;
/**
 * The skills whose own steps run registered SFlow commands the registry calls mutations and edit no
 * file. A read turn refused each of them its core step (`finalize`, `pr --create`, `sync <INTENT-ID>`,
 * `story start`, `epic start`, `mcp smoke`, …). The kernel-only turn admits any registered command
 * except approval, rejection and the person-only decisions the guard names, and no file edits.
 */
const KERNEL_ONLY_SKILLS = new Set([
  'inputs', 'next', 'recover', 'appeal', 'clarify', 'revise', 'submit', 'continue',
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
  // /sf-specify, /sf-plan and /sf-verify run `prepare` and write the current step's artifacts, and
  // /sf-implement, /sf-call and /sf-scenario-repair run /sf-code (/sf-call a document step through
  // /sf-phase) in the same turn. No step names them as its author, but they author like /sf-phase,
  // bound to the current step's own policy; a read turn refused what their instructions do. Every
  // delegation skill takes the turn of the skill it delegates to (phase-mutation-contract.test.mjs).
  // /sf-converge writes the step's document at a model-generation checkpoint; a deterministic step's
  // contract still grants no edits (deriveMutationContract), so its kernel-built publication is unchanged.
  // /sf-code-docs writes doc comments into the code the open generation changed, under that step's
  // own policy like /sf-code; a closed or published generation grants it no source edits. /sf-run runs
  // the guided `run` (`next` and `submit`) and then the returned canonical author in the same turn.
  if (['specify', 'plan', 'verify', 'implement', 'call', 'scenario-repair', 'converge', 'code-docs', 'run'].includes(name)) return 'authoring';
  // Kernel actions have their own authority checks. This never permits direct source edits.
  if (KERNEL_ONLY_SKILLS.has(name)) return 'kernel-only';
  // Every other skill only reads. Each registry skill's own SFlow commands are held to its turn by
  // the registry-wide test in phase-mutation-contract.test.mjs, so a new skill cannot silently get one
  // that refuses its own steps.
  return 'read';
}

function route(argv, detail, skill = null) {
  const guidance = safeCommandGuidance({ argv, ...(skill ? { skill } : {}) });
  return { detail, ...guidance, commandGuidance: guidance,
    modelFreeStatus: guidance?.modelFreeCommand ? 'available' : 'unavailable' };
}

/** Only the step's own configuration decides what it may change: no producer but the kernel builds no files (P-9). */
const onlyDeterministic = (phase) => phase?.generationPolicy?.allowedProducers?.length === 1 && phase.generationPolicy.allowedProducers[0] === 'deterministic';
/** Who builds the step (the entry's phaseKernelOwned); a policy that contradicts itself is classified by its producers alone. */
function executionOwner(phase) {
  try { return phaseKernelOwned(phase) ? 'kernel' : 'agent'; } catch { return onlyDeterministic(phase) && !phaseRequiresCodeDelivery(phase) ? 'kernel' : 'agent'; }
}

/**
 * `StepSnapshot/v1` from the Story record the caller already loaded: the adapter side of the kernel [OSA:REQ-040, REQ-041].
 * No Git, history walk or review record is read here, so the entry's permission and the edit guard decide on one basis.
 * Sources the caller did not read are `unavailable`, never empty or allowed [OSA:REQ-004]; the review status is one of them.
 */
export function stepSnapshotOf({ workflow, phase = workflow?.phases?.[workflow?.currentPhase], turnMode = 'authoring', sources = {},
  review = null, revoked = false, basis = {}, opening = null } = {}) {
  // What this checkout observed of an operation's opening (story-version-acceptance.mjs): its shared acceptance and writer.
  const observed = (step, version) => version.opening?.record === 'operation' && step.id === phase?.id && opening
    ? { ...version, opening: { ...version.opening, acceptance: opening.acceptance, writer: opening.writer } } : version;
  const facts = (step) => step ? { id: step.id, ...observed(step, versionFactsOf(workflow, step)),
    kind: { executionOwner: executionOwner(step), code: phaseRequiresCodeDelivery(step),
      changeCapabilities: [...(onlyDeterministic(step) ? [] : ['step-artifacts']),
        ...(step.writeScope === 'source-and-artifact' && (!onlyDeterministic(step) || phaseRequiresCodeDelivery(step)) ? ['application'] : [])] },
    pause: intentAmendmentPause(workflow, step.id) ? { id: intentAmendmentPause(workflow, step.id).id } : null,
    // An approved amendment waits for a person's acknowledgement before downstream submission, not before authoring.
    holds: pendingIntentAmendmentAcknowledgement(workflow) ? [{ code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED', owner: 'person',
      blocks: ['submission'], resolution: 'decide' }] : [],
    review: { required: sourceReviewRequired(workflow, step.id), status: review?.phaseId === step.id ? review.status : 'unavailable',
      version: review?.phaseId === step.id ? review.version ?? null : null }, damage: null } : null;
  const currentPhaseId = workflow?.currentPhase ?? null;
  return { schemaVersion: 1, record: { family: 'story-workflow', version: Number(workflow?.schemaVersion ?? 1) },
    subject: { projectId: null, workId: workflow?.workItem?.id ?? null, requestedPhaseId: phase?.id ?? null, currentPhaseId },
    basis, sources: { lifecycle: { status: 'verified' }, configuration: { status: 'verified' }, review: { status: review ? 'verified' : 'unavailable' }, ...sources },
    // The working record against the accepted one is not compared here (no Git per tool call): unknown, never "same".
    differences: [{ field: 'lifecycle-record', state: 'unknown' }],
    story: { status: workflow?.status === 'cancelled' ? 'cancelled' : currentPhaseId ? 'active' : 'complete', phaseOrder: workflow?.phaseOrder ?? [],
      pendingDecision: workflow?.pendingDecision ? { id: workflow.pendingDecision.key ?? null } : null },
    step: facts(phase), current: phase && phase.id !== currentPhaseId ? facts(workflow?.phases?.[currentPhaseId]) : null,
    actor: { principalKind: 'agent', role: turnMode === 'read-only-review' ? 'reviewer' : 'author', turnMode, permissionsRevoked: revoked === true } };
}

/** One Shell command as a route, with the skill the host shows for it. */
function commandRoute(command, detail, skill = null) {
  const guidance = safeCommandGuidance({ command, ...(skill ? { skill } : {}) });
  return guidance ? { detail, ...guidance, commandGuidance: guidance, modelFreeStatus: guidance.modelFreeCommand ? 'available' : 'unavailable' } : null;
}

/**
 * The host's rendering of the kernel's primary action for this step's own turns [OSA:REQ-021]: the command and skill each
 * operation maps to. The entry, the edit guard and the authoring task all render it from the same decision, so they give
 * one next step [OSA:REQ-010, C7]; recovery appears only for a positively damaged step [OSA:REQ-003, C1].
 */
export function decisionRoutes(decision, workflow, requested) {
  const { next } = decision;
  const workId = workflow.workItem.id;
  // The action's own step: from an inspected step, the current one it names [§4.2 target].
  const phase = workflow.phases?.[next.target?.phase] ?? requested;
  const author = generationSkillForPhase(phase, workflow);
  const code = phaseRequiresCodeDelivery(phase);
  switch (next.operation) {
    // An opening whose shared acceptance is lost or uncertain is reconciled as the same operation; nothing new opens [REQ-033].
    case 'recover-operation': return [next.inputs.operation === 'version-opening'
      ? route(['phase', 'opening', phase.id, '--reconcile', '--json'], `Find out whether version ${next.inputs.version} of ${phase.id} reached the shared Story branch; this settles the same opening and opens no other version.`, author)
      : route(['recover', workId, '--phase', phase.id, '--json'], 'Preserve published bytes and review the successor boundary before application edits.', '/sf-recover')];
    // Another checkout holds the version's writer fence: this one inspects it, or takes it over with its writer's agreement [REQ-034].
    case 'takeover-writer': return [route(['session', 'takeover', workId, '--json'],
      `Another checkout writes version ${next.inputs.version} of ${phase.id}. Take it over here only when that checkout's work is published or set aside; this checkout may still inspect it.`, '/sf-session')];
    case 'open-version':
      // A successor, for any reason, is previewed and opened only on the person's yes [D3, OSA:REQ-030]; version 1 opens directly.
      if (next.inputs.consent === 'required') return [route(['phase', 'rollover', phase.id, '--json'],
        `Preview starting version ${next.inputs.version} of ${phase.id} and ask the person to confirm it; ${next.inputs.from ? `version ${next.inputs.from} stays as published` : 'nothing published changes'}.`, author)];
      return [code ? route(['phase', 'begin', phase.id, '--json'], 'Open the exact code generation before application edits.', author)
        : route(['prepare', phase.id], 'Continue the configured phase author; publish only after its checks pass.', author)];
    case 'author-version': case 'build-version': return [route(['prepare', phase.id], 'Continue the configured phase author; publish only after its checks pass.', author)];
    case 'decide': return [next.inputs.decision === 'story-decision'
      ? route(['decision', 'show', workId], 'Choose what happens next; a member of the deciding group decides.', '/sf-decide')
      : route(['decisions', workId], `A person ${next.inputs.decision === 'review-disposition' ? 'decides what the review left to them' : `who approves the scope decides ${next.inputs.id ?? 'the amendment'}`} on the decisions card.`, '/sf-decide')];
    case 'approve-step': return [commandRoute(`singularity-flow approve ${phase.id} --work-id ${workId} --fetch`, `Review submitted ${phase.id}, then approve it or return it for correction.`, '/sf-approve'),
      commandRoute(`singularity-flow reject ${phase.id} --work-id ${workId} --fetch --to <phase> --reason <reason>`, 'Or return it for correction.', '/sf-reject')].filter(Boolean);
    // Submission readiness reports the review and the workflow decisions a submission records, then the exact submit.
    case 'submit-version': case 'refresh-facts': return [route(['status', workId, '--submission-readiness', '--json'],
      `Check ${phase.id}'s submission readiness: it names its review, if one is owed, and then the exact submission.`, '/sf-submit')];
    case 'start-review': return [route(['review-source', 'context', phase.id, '--for-agent', '--json'], 'Review the exact published version against its sources.', '/sf-review-source')];
    case 'none': return [route(['nextsteps', '--json'], 'Nothing is written now; see where the Story stands.')];
    case 'refresh-authority': return [route(['session', 'current', '--for-agent', '--json'], 'Run this read in this turn: it binds the turn to the Story as it is now.')];
    default: return [route(['phase', 'show', phase.id, '--json'], `Inspect ${phase.id} as it is (${next.reasonCodes.join(', ') || 'no action'}); nothing is written now.`)];
  }
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
  turnMode = 'authoring', staging = [], evidence = [], opening = null }) {
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
  const decision = phase ? stepState(stepSnapshotOf({ workflow, phase, turnMode, opening })) : null;
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
    : turnMode !== 'authoring' ? `${turnMode}: no direct repository edits; only explicitly issued staging files and permitted kernel operations.`
      : !editable ? 'No direct edits: this step is not being written now. Take its returned next action.'
      : deterministic && !code ? 'No direct edits to this deterministic generation. Use the returned kernel action.'
        : deterministic && application ? 'May edit application paths within pinned policy; the summary is built by `singularity-flow prepare` from what changed, never edited by hand.'
        : deterministic && code ? 'No edits until its code version is open: open it with the returned action. The summary is built by `singularity-flow prepare` from what changed, never edited by hand.'
        : application ? `May edit this phase's artifacts and ${phase.sourceBoundary === 'test-automation' ? 'test-automation' : 'application'} paths within pinned policy; protected and governed state remain kernel-owned.`
          : `May edit this phase's artifacts only.${code ? ' Open a code generation before application edits.' : ' Do not implement application code in this phase.'}`;
  return {
    schemaVersion: MUTATION_CONTRACT_VERSION, kind: 'phase-mutation-contract',
    workId, phaseId: phase?.id ?? null, generation: phase?.generation ?? null, turnMode, summary,
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
      ? 'Run SFlow lifecycle commands standalone with cwd=repositoryPath; do not wrap or chain kernel mutations. Repository-local authoring shell commands are permitted under the pinned file policy and before/after change detection; this is not a standalone-SFlow-only terminal.'
      : 'Run one standalone registered SFlow command with cwd=repositoryPath, or as is from a non-Git folder such as a chat folder (SFlow finds the bound checkout; `cd <it> && …` or `env -C <it> …` also sets it); no pipes, redirects, substitutions or other command chains.',
    localVerification: { allowed: verification, guidance: verification ? AUTHORING_VERIFICATION_PROTOCOL :
      'This retained, deterministic or non-authoring turn does not grant local test/app execution. Use its returned authoring or kernel route; do not reopen a phase or broaden write permissions.' },
    retry: 'Correct the tool form without re-asking settled questions or changing lifecycle state.',
    mode: contract.turnMode };
}

export function mutationDenial(contract, reason, paths = [], { routes = null } = {}) {
  // Any SFlow command, a read too, rebuilds this turn's binding (cli-entry.mjs), so the way back is a read
  // in this turn; `phase enter` in a new /sf-phase turn sent approval and decision turns elsewhere (2026-10-28).
  const actions = routes ?? (contract?.next?.length ? contract.next : [route(['session', 'current', '--for-agent', '--json'],
    'Preserve existing work. Run this read in this turn: it binds the turn to the Story as it is now; a missing selection uses /sf-session.')]);
  const lines = actions.map(action => formatCommandRouteLines(action).join('\n'));
  return { permissionDecision: 'deny', permissionDecisionReason:
    `${reason}${paths.length ? ` (${paths.join(', ')})` : ''}. ${contract?.summary ?? 'No current verified mutation contract.'}${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`.trimEnd(),
    next: actions };
}
