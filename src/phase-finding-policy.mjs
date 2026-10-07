/** Installed gate policy. Repository/error text cannot register a waiver or executable repair. */
const ARTIFACT_QUALITY = new Set([
  'artifact.placeholder.unresolved', 'artifact.required.too-short',
  'artifact.heading.empty'
]);
const AUTHOR_CATEGORIES = new Set(['authoring', 'artifact', 'traceability', 'artifact-set',
  'specification-quality', 'specification-index', 'planning-table', 'verification-contracts']);
const DERIVED_CODES = new Set(['phase.grounding.required', 'phase.grounding.not-ready',
  'phase.generation-intent.required', 'GENERATION_INTENT_REQUIRED']);
const OPERATION_CATEGORIES = new Set(['host', 'integration', 'transport', 'external-evidence',
  'collaboration', 'tests', 'test', 'validation', 'inputs', 'repair-coordination']);

export function phaseFindingCode(finding) {
  return String(finding?.details?.sourceCode || finding?.code || 'UNKNOWN_PHASE_FINDING');
}

/** Lines/messages are presentation, never finding identity or permission. */
export function phaseFindingIdentity(finding) {
  return { code: phaseFindingCode(finding), path: finding.path ?? null,
    value: finding.details?.clauseId ?? finding.value ?? null };
}

export function phaseFindingPolicy(finding) {
  const code = phaseFindingCode(finding);
  const category = String(finding.category ?? '');
  let classification = 'owner-resolution';
  let repair = 'owner-review';
  let riskEligible = false;
  // Category hints never override an installed integrity/authority/safety boundary.
  if (/integrity|tamper|protected|authority|identity|provenance|snapshot|source[._-]boundary|unsafe|secret|publication_invalid|publication_missing|binding_stale|binding_required/iu.test(code)
      || ['integrity', 'configuration'].includes(category)) {
    classification = 'integrity-or-authority'; repair = 'authenticated-restoration-or-amendment';
  } else if (ARTIFACT_QUALITY.has(code) && typeof finding.path === 'string') {
    classification = 'quality'; repair = 'owned-author'; riskEligible = true;
  } else if (DERIVED_CODES.has(code)) {
    classification = 'current-phase-preparation'; repair = 'prepare-current-generation';
  } else if (/dirty|worktree|working.tree|staged|index.conflict/iu.test(code) || category === 'worktree') {
    classification = 'worktree-review'; repair = 'review-and-scoped-commit';
  } else if (code === 'SPEC_COVERAGE_INCOMPLETE') {
    classification = 'quality';
    const coverage = finding.details?.coverage;
    repair = coverage?.invalidEvidence?.length || coverage?.unclaimedChangedPaths?.length
      || coverage?.withdrawnButClaimed?.length ? 'scope-or-evidence-review' : 'owned-author';
    riskEligible = !(coverage?.invalidEvidence?.length || coverage?.unclaimedChangedPaths?.length
      || coverage?.withdrawnButClaimed?.length)
      && (finding.details?.riskEligible === true || finding.details?.qualityRisk?.eligible === true);
  } else if (AUTHOR_CATEGORIES.has(category) || /^artifact\./u.test(code)) {
    classification = 'author-correction'; repair = 'owned-author';
  } else if (category === 'clarification') {
    classification = 'human-input'; repair = 'record-real-answer';
  } else if (OPERATION_CATEGORIES.has(category)) {
    classification = 'operational-prerequisite'; repair = 'configured-owner-action';
  } else if (category === 'lifecycle') {
    classification = 'lifecycle'; repair = 'resume-or-successor';
  }
  return Object.freeze({ classification, repair, riskEligible,
    repairableByProducer: repair === 'owned-author', automaticRiskAcceptance: false,
    preserveWork: true, priorApprovalsImmutable: true });
}

export function isArtifactQualityFinding(finding) {
  return ARTIFACT_QUALITY.has(phaseFindingCode(finding)) && phaseFindingPolicy(finding).riskEligible;
}
