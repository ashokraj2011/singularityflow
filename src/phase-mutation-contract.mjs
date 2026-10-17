/** Pinned phase permissions, not a filesystem sandbox or a new lifecycle authority. */
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { phaseRequiresCodeDelivery, generationSkillForPhase } from './code-delivery-policy.mjs';
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';
import { phaseNeedsGeneration } from './phase-generation-need.mjs';
import { sourceReviewKind } from './phase-roles.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { AUTHORING_SKILL_DECLARATION } from './authoring-skills.mjs';
import { phasePublicationContract } from './manual-authorship.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';

export const MUTATION_CONTRACT_VERSION = 1;
export function mutationTurnMode(skill) {
  const name = String(skill ?? '').replace(/^\/?(?:sf|sflow)-/u, '');
  if (['approve', 'reject'].includes(name)) return 'approval-only';
  if (['session', 'resume', 'agent'].includes(name)) return 'session-only';
  if (name === 'review-source') return 'read-only-review';
  if (name === 'review-decide') return 'review-decision-only';
  // /sf-decide records a person's typed choice; its decision commands carry their own authority check.
  if (name === 'decide') return 'decision-only';
  if (name === 'publish') return 'publish-only';
  // /sf-import-team converts a team directory through its own CLI commands and one issued
  // candidate file; it never edits a repository (copilot-mutation-guard.mjs importTeamGuard).
  if (name === 'import-team') return 'import-team';
  // /sf-build-workflow grows a machine-local workflow build through `workflow build` and one issued
  // proposal file; finishing goes through Workflow Studio's reviewed apply (buildWorkflowGuard).
  if (name === 'build-workflow') return 'build-workflow';
  if (AUTHORING_SKILL_DECLARATION[`sflow-${name}`]) return 'authoring';
  // Kernel actions have their own authority checks. This never permits direct source edits.
  if (['inputs', 'next', 'recover', 'appeal', 'clarify', 'revise', 'submit', 'converge', 'continue',
    'admin', 'init', 'configuration', 'workflows', 'workflow-rules', 'skills', 'instructions',
    'capability-map', 'workspace', 'worldmodel', 'start', 'test-setup'].includes(name)) return 'kernel-only';
  return 'read';
}

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
  turnMode = 'authoring', staging = [], evidence = [] }) {
  const workId = workflow?.workItem?.id ?? null;
  const repositoryRoot = root ? realpathSync(root) : null;
  const ownership = applicationPathContext(definition, workflow);
  const workItemRoot = workflow?.resolution?.workItemRoot ?? definition?.workItemRoot ?? 'singularity/work-items';
  const item = `${workItemRoot}/${workId}`;
  const code = phaseRequiresCodeDelivery(phase);
  const openGeneration = code && phase?.generationIntent?.status === 'open'
    && Number(phase.generationIntent.generation) === nextPhaseGeneration(phase);
  const editable = phase?.status === 'in_progress' && phaseNeedsGeneration(workflow, phase);
  const deterministic = phase?.generationPolicy?.allowedProducers?.length === 1
    && phase.generationPolicy.allowedProducers[0] === 'deterministic';
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
  // A deterministic code step builds only its summary; its code is written in the open generation.
  const application = turnMode === 'authoring' && editable && (!deterministic || code)
    && phase?.writeScope === 'source-and-artifact' && (!code || openGeneration);
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
    : turnMode === 'publish-only'
      ? [route(['phase', 'publish', phase.id, '--authored', phasePublicationContract(phase).producer,
        '--channel', phasePublicationContract(phase).channel], 'Recheck publication readiness first; publish only when the kernel returns ready. Never author, submit or approve.')]
    : ['approval-only', 'session-only', 'read', 'read-only-review', 'import-team', 'build-workflow'].includes(turnMode)
      ? [route(['nextsteps', '--json'], 'End this turn. Inspect the next action in a new turn; do not author now.')]
      : code && phase.generationIntent?.status === 'consumed'
        ? [route(['recover', workId, '--phase', phase.id, '--json'], 'Preserve published bytes and review the successor boundary before application edits.', '/sf-recover')]
      : code && !openGeneration && editable
        ? [route(['phase', 'begin', phase.id, '--json'], 'Open the exact code generation before application edits.', generationSkillForPhase(phase, workflow))]
        : !editable
          ? [route(['recover', workId, '--phase', phase.id, '--json'], 'Preserve published bytes; inspect the reviewed successor or return route.')]
          : [route(['prepare', phase.id], 'Continue the configured phase author; publish only after its checks pass.', generationSkillForPhase(phase, workflow))];
  const summary = turnMode === 'approval-only' ? 'Approval/rejection only. No file edits or next-phase authoring; end this turn after the decision.'
    : turnMode !== 'authoring' ? `${turnMode}: no direct repository edits; only explicitly issued staging files and permitted kernel operations.`
      : !editable || (deterministic && !code) ? 'No direct edits to this retained or deterministic generation. Use the returned kernel/recovery action.'
        : deterministic && application ? 'May edit application paths within pinned policy; the summary is built by `singularity-flow prepare` from what changed, never edited by hand.'
        : application ? `May edit this phase's artifacts and ${phase.sourceBoundary === 'test-automation' ? 'test-automation' : 'application'} paths within pinned policy; protected and governed state remain kernel-owned.`
          : `May edit this phase's artifacts only.${code ? ' Open a code generation before application edits.' : ' Do not implement application code in this phase.'}`;
  return {
    schemaVersion: MUTATION_CONTRACT_VERSION, kind: 'phase-mutation-contract',
    workId, phaseId: phase?.id ?? null, generation: phase?.generation ?? null, turnMode, summary,
    repositoryRoot,
    policy: { writeScope: phase?.writeScope ?? 'artifact-only', sourceBoundary: phase?.sourceBoundary ?? 'unrestricted',
      requiresOpenGeneration: code, openGeneration, editable, supportingChangesOnly: !code && !ownsCode },
    allow: { artifacts: turnMode === 'authoring' && editable && !deterministic ? artifacts : [], application, staging },
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
  const root = realpathSync(contract.repositoryRoot);
  let absolute = path.resolve(cwd, target);
  try {
    const realCwd = realpathSync(cwd);
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
  if (!relative || /^(?:\.git)(?:\/|$)/iu.test(relative) || contract.deny.protectedPaths.some(matches)) return { allowed: false, reason: 'protected-path', path: relative };
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
    sourceEditPrerequisite: contract.turnMode === 'authoring' && contract.policy.requiresOpenGeneration && !contract.allow.application
      ? contract.next[0] ?? null : null,
    enforcement: contract.enforcement, toolProtocol: mutationToolProtocol(contract), next: contract.next };
}

/** Tool-form errors are recoverable in the same bound turn, not lifecycle failures. */
export function mutationToolProtocol(contract) {
  return { read: 'Use native file-read tools for captured CLI output; do not run shell parsers or wrappers in a restricted turn.',
    staging: 'Use a file-edit tool only at an exact kernel-issued staging path. No shell writers, mkdir or arbitrary temporary paths.',
    terminal: 'Run one standalone registered SFlow command with cwd=repositoryPath; no pipes, redirects, substitutions or command chains.',
    retry: 'Correct the tool form without re-asking settled questions or changing lifecycle state.',
    mode: contract.turnMode };
}

export function mutationDenial(contract, reason, paths = []) {
  const actions = contract?.next?.length ? contract.next : [route(['phase', 'enter', '--for-agent', '--json'],
    'Preserve existing work. End an expired/corrupt turn and invoke /sf-phase in a new turn; missing selection uses /sf-session.')];
  const lines = actions.map(action => `Copilot: ${action.copilotCommand ?? 'unavailable'}; Shell: ${action.command}; Model-free: ${action.modelFreeCommand ?? 'not available for this action'}`);
  return { permissionDecision: 'deny', permissionDecisionReason:
    `${reason}${paths.length ? ` (${paths.join(', ')})` : ''}. ${contract?.summary ?? 'No current verified mutation contract.'} ${lines.join(' ')}`,
    next: actions };
}
