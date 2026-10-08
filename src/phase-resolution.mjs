/** Shared, read-only recovery choices. A route is not authority or a successful check. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './records.mjs';
import { renderPlatformCommand, safeCommandGuidance } from './safe-command-guidance.mjs';
import { phaseFindingPolicy, phaseFindingCode, phaseFindingIdentity, isArtifactQualityFinding } from './phase-finding-policy.mjs';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const route = (kind, owner, argv, detail, skill = '/sf-recover') => {
  // Guidance consumes a registered command line, not a platform-executable string with a
  // quoted executable (or PowerShell '&'). Quote only literal values that need it; placeholders
  // remain display-only and safeCommandGuidance supplies platform forms for copyable actions.
  const command = ['singularity-flow', ...argv].map(value =>
    /^[A-Za-z0-9._:/-]+$/u.test(value) || /^<[A-Za-z][A-Za-z0-9._/|-]*>$/u.test(value)
      ? value : renderPlatformCommand([value], 'darwin')).join(' ');
  const commandGuidance = safeCommandGuidance({ command, skill });
  return { kind, owner, argv, command, skill, detail, automatic: false,
    commandGuidance, copilotCommand: commandGuidance?.copilotCommand ?? null };
};

/** Closed dispositions, including an honest owner route for an unknown/unsupported blocker. */
export function phaseResolutionChoices(workflow, phase, finding) {
  // Downstream checks can name an approved input's owner. Keep its repair/risk routes there,
  // rather than asking the consuming phase to edit immutable upstream bytes.
  const ownerPhase = workflow.phases?.[finding.phaseId ?? finding.phase];
  if (ownerPhase) phase = ownerPhase;
  const workId = workflow.workItem.id;
  const code = String(finding.details?.sourceCode ?? finding.code ?? '').toLowerCase();
  const category = String(finding.category ?? '').toLowerCase();
  const recovery = route('inspect', phase.id, ['recover', workId, '--phase', phase.id, '--json'],
    'Inspect the exact preserved state. No automatic commit, discard, approval or retry.');
  const policy = phaseFindingPolicy(finding);
  const preserve = route('preserve-checkpoint', phase.id,
    ['appeal', 'checkpoint', '--work-id', workId, '--phase', phase.id, '--json'],
    'Save private recovery copies of dirty files and the index. No commit, discard, publication or phase advance.', '/sf-appeal');
  let resolution;
  if (code === 'plan_evidence_correction_review_required') {
    resolution = route('human-review', 'plan-approval-authority',
      ['appeal', 'evidence-prepare', '--phase', phase.id, '--path', finding.path ?? '<EVIDENCE-PATH>',
        '--clause', '<CLAUSE-ID>', '--method', 'visual', '--reason', '<reason>', '--json'],
      'Preserve the exact pending evidence. Continue only admitted draft repairs; the plan authority must review its contract before publication. The preview offers a guided local browser review or human terminal. No visual pass or test waiver is implied.', '/sf-appeal');
  } else if (code.startsWith('generation_publication')) {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Inspect the exact retained publication and its authored bytes. Restore authenticated evidence or use a reviewed successor/return; configuration refresh and risk acceptance cannot authenticate a changed publication.', '/sf-doctor');
  } else if (code === 'phase_quality_risk_pending_tests') {
    resolution = route('submission-evidence', phase.id, ['submit', phase.id, '--work-id', workId],
      'Collect this published generation\'s fresh tests and observed claims before reviewing quality risk. No tests or evidence are waived.', '/sf-submit');
  } else if (code === 'generation.document.published-changed') {
    resolution = phase.status === 'awaiting_approval'
      ? route('published-document-return', 'phase-approval-authority',
        ['reject', phase.id, '--work-id', workId, '--to', '<phase>', '--reason', '<reason>'],
        'Request an authorized return before changing submitted evidence. Preserve both the retained publication and the new draft.', '/sf-reject')
      : route('published-document-restore', phase.id, ['phase', 'show', phase.id, '--show-artifact'],
        'Preserve the new draft separately and restore exact reviewed bytes from the authenticated publication. Submit the restored publication for authorized return if its content needs rework.', '/sf-phase-documents');
  } else if (code === 'specification_claim_map_binding_stale'
      || code === 'specification_claim_map_binding_required') {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Inspect this phase\'s exact published claim binding. Current-generation corruption requires restoration of authenticated bytes or reviewed rework; refreshing configuration or risk acceptance cannot repair it.', '/sf-doctor');
  } else if (code === 'phase_repair_recheck_required') {
    resolution = route('repair-resume', phase.id, ['appeal', 'repair-resume', '--phase', phase.id, '--json'],
      'Resume the same durable attempt and rerun its gates. Do not start a new budget or blindly repeat the interrupted operation.', '/sf-appeal');
  } else if (code.startsWith('phase_repair_journal')) {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Preserve the private repair journal for diagnosis. Never delete or reset it to obtain a new budget.', '/sf-doctor');
  } else if (/protected|authority|identity|provenance|snapshot|configuration|integrity|source.boundary/u.test(code)
      || ['configuration', 'integrity'].includes(category)) {
    resolution = route('configuration-owner', 'configuration-authority',
      ['workspace', 'refresh-configuration', '--dry-run'],
      'Preserve the edit. Use the original configuration authority or restore reviewed bytes; an ordinary appeal cannot waive integrity.', '/sf-workspace');
  } else if (/appeal.*(?:path.unsupported|too.large)/u.test(code)) {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Preserve the exact file. Split an oversized review, or use a qualified owner review for binary, rename, deletion or link changes; ordinary scope accounting cannot approve it.', '/sf-doctor');
  } else if (/appeal.*lifecycle/u.test(code)) {
    resolution = recovery;
  } else if (category === 'appeal' || code.includes('appeal')) {
    resolution = route('human-review', 'plan-approval-authority', ['appeal', 'list', '--phase', phase.id, '--json'],
      'Review the exact retained appeal or request corrections and prepare a successor. This is not phase approval or a risk waiver.', '/sf-appeal');
  } else if (/dirty|worktree|working.tree|staged|index.conflict/u.test(code) || category === 'worktree') {
    resolution = route('worktree-review', 'human-reviewer', ['recover', workId, '--phase', phase.id, '--json'],
      'Review exact current bytes. Recovery can offer a hash-confirmed scoped commit and revalidation; unrelated edits and the index are preserved. Published work needs an authorized successor.');
  } else if (code === 'spec_coverage_incomplete' && finding.details?.coverage?.unclaimedChangedPaths?.length) {
    resolution = route('scope-appeal', 'plan-approval-authority', ['appeal', 'prepare', '--phase', phase.id, '--json'],
      'Account for exact unplanned paths through a reviewed scope appeal first. Recheck afterward; only the remaining missing coverage is eligible for pilot risk.', '/sf-appeal');
  } else if ((category === 'quality-coverage' || code === 'spec_coverage_incomplete')
      && (finding.details?.riskEligible === true || finding.details?.qualityRisk?.eligible === true)) {
    resolution = route('pilot-risk-review', 'phase-approval-authority',
      ['appeal', 'risk-prepare', '--phase', phase.id, '--gate-mode', 'soft', '--expires', '<YYYY-MM-DD>', '--reason', '<why>', '--json'],
      'Preview exact missing coverage. An authorized human may accept it for this pilot phase with an expiry; soft mode alone is no waiver. Tests, review and integrity stay enforced.', '/sf-appeal');
  } else if (category === 'quality-coverage' || code === 'spec_coverage_incomplete') {
    resolution = route('author-correction', phase.id, ['recover', workId, '--phase', phase.id, '--json'],
      'Repair unaccounted scope or invalid evidence through a reviewed successor or plan amendment. Pilot risk cannot waive integrity.');
  } else if (/unclaimed|outside.*scope/u.test(code) || category === 'coverage') {
    resolution = route('scope-appeal', 'plan-approval-authority', ['appeal', 'prepare', '--phase', phase.id, '--json'],
      'Explain each exact extra path and its approved clause or supporting class. Review the diff before accounting for it; tests still have to run.', '/sf-appeal');
  } else if (/test|validation|coverage/u.test(code) || ['test', 'tests', 'validation'].includes(category)) {
    resolution = route('risk-inspection', 'validation-approval-authority',
      ['story', 'test-policy', 'risks', '--phase', phase.id, '--operation', 'publish', '--json'],
      'Inspect eligible, exact observed risks and runner repair. Unsupported or stale evidence is not a pass.', '/sf-recover');
  } else if (/host|remote|transport|integration|dependency/u.test(code)
      || ['host', 'integration', 'transport', 'external-evidence'].includes(category)) {
    resolution = route('external-owner', 'repository-or-integration-owner',
      ['doctor', '--json'], 'Preserve the retained outcome; resolve access or the external prerequisite before retrying.', '/sf-doctor');
  } else if (code === 'phase.grounding.required' || code === 'phase.grounding.not-ready') {
    resolution = route('prepare-current-generation', phase.id,
      ['wm', 'compose', '--phase', phase.id, '--work-id', workId],
      'Refresh the current pending composition from trusted inputs; retain the prior context and review the existing draft. Authenticated-record tampering still requires restoration.', '/sf-worldmodel');
  } else if (code === 'phase.generation-intent.required' || code === 'generation_intent_required') {
    resolution = phase.status === 'in_progress' && phase.generationIntent?.status !== 'consumed'
      ? route('prepare-current-generation', phase.id,
        ['phase', 'begin', phase.id, '--work-id', workId, '--json'],
        'Open the current generation without discarding its work. Honor the returned adoption preview and exact human confirmation; never fabricate an intent or overwrite published evidence.', '/sf-code')
      : recovery;
  } else if (code === 'generation_intent_already_consumed' || code === 'generation.intent.consumed-changed') {
    resolution = recovery;
  } else if (policy.repairableByProducer) {
    resolution = route('author-correction', phase.id,
      ['appeal', 'repair-plan', '--work-id', workId, '--phase', phase.id, '--json'],
      'Save a recovery checkpoint, then repair the current owned draft from its existing work. A bounded automatic budget never prevents a reviewed manual correction; published content requires a successor.', '/sf-appeal');
  } else if (/artifact|placeholder|document|grounding|clarification|traceability/u.test(code)) {
    resolution = route('author-correction', phase.id, ['phase', 'show', phase.id, '--show-artifact'],
      'Repair only the current owned draft and recheck. Approved/published bytes require a successor or authorized return.', '/sf-phase-documents');
  } else {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'No automatic repair or waiver is registered for this finding. Give the maintainer this exact finding and preserved-state diagnostics.', '/sf-doctor');
  }
  const choices = [resolution, recovery];
  if (isArtifactQualityFinding(finding)) choices.splice(1, 0, route('pilot-risk-review', 'phase-approval-authority',
    ['appeal', 'risk-prepare', '--work-id', workId, '--phase', phase.id, '--finding', phaseFindingCode(finding),
      '--gate-mode', 'soft', '--expires', '<YYYY-MM-DD>', '--reason', '<why>', '--json'],
    'An authorized human may carry this exact document-quality shortfall through the selected transitions. It remains unmet, not passed; tests, trust and phase approval remain required.', '/sf-appeal'));
  choices.push(preserve);
  return { code: finding.code ?? 'unknown', path: finding.path ?? null, policy,
    status: resolution.kind.endsWith('owner') || resolution.kind === 'owner-escalation'
      ? 'needs-owner' : resolution.kind.includes('risk') || resolution.kind.includes('appeal') || ['human-review', 'worktree-review'].includes(resolution.kind) ? 'needs-human' : 'needs-correction',
    choices, preserved: ['working-tree bytes', 'Git index', 'published evidence', 'approval history'] };
}

export function phaseResolutionProjection(workflow, phase, findings = []) {
  return { status: findings.length ? 'resolution-required' : 'ready',
    contract: { preserveWork: true, automaticDiscard: false, automaticRiskAcceptance: false,
      priorApprovalsImmutable: true, exhaustedAutomationBlocksManualRepair: false },
    issues: findings.map(finding => phaseResolutionChoices(workflow, phase, finding)),
    retry: { maximumAttempts: 3, requiresChangedCondition: true, autoAcceptRisk: false,
      fingerprint: digest(findings.map(phaseFindingIdentity).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))) } };
}

/** A deterministic repair budget: no unchanged retry or A→B→A oscillation. */
export function repairLoopAdmission(previous = [], next, { maximumAttempts = 3 } = {}) {
  if (!Array.isArray(previous) || !Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) return { allowed: false, reason: 'invalid-repair-budget' };
  if (!next?.conditionHash || !next?.actionId) return { allowed: false, reason: 'missing-exact-condition' };
  if (previous.length >= maximumAttempts) return { allowed: false, reason: 'budget-exhausted' };
  if (previous.some(entry => entry.conditionHash === next.conditionHash)) return { allowed: false, reason: 'unchanged-or-oscillating-condition' };
  return { allowed: true, reason: 'changed-condition', attemptsRemaining: maximumAttempts - previous.length - 1 };
}
