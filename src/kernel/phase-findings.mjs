/** Pure installed finding identity and policy. Diagnostic text cannot register authority. */
const ARTIFACT_QUALITY = new Set([
  'artifact.placeholder.unresolved', 'artifact.required.too-short',
  'artifact.heading.empty'
]);
const AUTHOR_CATEGORIES = new Set(['authoring', 'artifact', 'traceability', 'artifact-set',
  'specification-quality', 'specification-index', 'planning-table', 'verification-contracts',
  'retained-evidence']);
// Fixed by the step's own author in its draft, whatever check reports them: an Agent brief the
// projection cannot see (for example written inside a template comment), an unclosed comment, a
// code delivery the author has not finished, or a planned evidence file it has not produced yet.
const AUTHOR_CODES = new Set(['AGENT_BRIEF_SUMMARY_REQUIRED', 'AGENT_BRIEF_PRESERVED_SECTION_REQUIRED',
  'AGENT_BRIEF_MAXIMUM_BYTES_EXCEEDED', 'AGENT_BRIEF_HEADING_AMBIGUOUS', 'ARTIFACT_COMMENT_UNCLOSED',
  'CODE_DELIVERY_EVIDENCE_REQUIRED', 'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING']);
// An honest comparison that finds the delivery incomplete: the gap is the delivering step's, so the
// report's author never edits the verdict; that step's approvers decide an upstream issue.
const UPSTREAM_DEFECT_CODES = new Set(['conformance.verdict-incomplete']);
const DERIVED_CODES = new Set(['phase.grounding.required', 'phase.grounding.not-ready',
  'phase.generation-intent.required', 'GENERATION_INTENT_REQUIRED']);
const OPERATION_CATEGORIES = new Set(['host', 'integration', 'transport', 'external-evidence',
  'collaboration', 'tests', 'test', 'validation', 'inputs', 'repair-coordination']);
const TEST_REPAIR_CODES = new Set(['CODE_TEST_FAILED', 'CODE_TEST_TIMEOUT', 'CODE_TEST_SKIPPED',
  'CODE_TEST_ZERO_DISCOVERED', 'CODE_TEST_RESULT_REQUIRED', 'CODE_TEST_SUPPRESSED',
  'TEST_MODULE_AMBIGUOUS', 'TEST_MODULE_UNCOVERED', 'GRADLE_TEST_TARGET_REQUIRED',
  'XCODE_TEST_TARGET_REQUIRED', 'RUST_TEST_ADAPTER_REQUIRED', 'CODE_DELIVERY_TEST_COMMAND_REQUIRED']);
const INTEGRITY_FINDING_CODE = /integrity|tamper|protected|authority|identity|provenance|snapshot|source[._-]boundary|unsafe|secret|publication_invalid|publication_missing|binding_stale|binding_required/iu;
const canonicalFindingCode = code => code.includes('.') ? code.toLowerCase() : code.toUpperCase();

export function phaseFindingCode(finding) {
  // Both legacy underscore codes and dotted findings cross CLI, hook and review adapters.
  // Canonicalize once, before routing, permission classification or repair journaling.
  const primary = canonicalFindingCode(String(finding?.code || 'UNKNOWN_PHASE_FINDING').trim());
  // A nested source code explains an ordinary wrapper; it cannot replace an installed integrity
  // boundary with a quality/risk selector. Routing, identity and policy must all retain that code.
  return INTEGRITY_FINDING_CODE.test(primary) ? primary
    : canonicalFindingCode(String(finding?.details?.sourceCode || primary).trim());
}

/** Lines/messages are presentation, never finding identity or permission. */
export function phaseFindingIdentity(finding) {
  return { code: phaseFindingCode(finding), path: finding.path ?? null,
    value: finding.details?.clauseId ?? finding.value ?? null };
}

export function phaseFindingPolicy(finding) {
  const coverage=finding.details?.coverage;
  return phaseFindingPolicyFromFacts({code:phaseFindingCode(finding),category:finding.category??null,
    hasPath:typeof finding.path==='string',upstreamDecisionComplete:finding.details?.upstreamDecision?.complete===true,
    coverageReviewRequired:Boolean(coverage?.invalidEvidence?.length||coverage?.unclaimedChangedPaths?.length||coverage?.withdrawnButClaimed?.length),
    riskEligible:finding.details?.riskEligible===true||finding.details?.qualityRisk?.eligible===true});
}

/** Semantic observations from a check; text and suggested commands never establish authority. */
export function phaseFindingPolicyFromFacts(facts) {
  const {code}=facts;
  const category = String(facts.category ?? '').trim().toLowerCase();
  let classification = 'owner-resolution';
  let repair = 'owner-review';
  let riskEligible = false;
  // Category hints never override an installed integrity/authority/safety boundary.
  if (INTEGRITY_FINDING_CODE.test(code)
      || ['integrity', 'configuration'].includes(category)) {
    classification = 'integrity-or-authority'; repair = 'authenticated-restoration-or-amendment';
  } else if (ARTIFACT_QUALITY.has(code) && facts.hasPath) {
    classification = 'quality'; repair = 'owned-author'; riskEligible = true;
  } else if (UPSTREAM_DEFECT_CODES.has(code)) {
    classification = 'upstream-defect'; repair = 'raise-upstream-issue';
  } else if (DERIVED_CODES.has(code)) {
    classification = 'current-phase-preparation'; repair = 'prepare-current-generation';
  } else if (/dirty|worktree|working.tree|staged|index.conflict/iu.test(code) || category === 'worktree') {
    classification = 'worktree-review'; repair = 'review-and-scoped-commit';
  } else if (code === 'SPEC_COVERAGE_INCOMPLETE' && facts.upstreamDecisionComplete) {
    // Every clause still without delivery is named by an open upstream issue: the earlier step's
    // approvers decide it. More code cannot clear it, so it is never the producer's repair.
    classification = 'upstream-decision'; repair = 'decide-upstream-issue';
  } else if (code === 'SPEC_COVERAGE_INCOMPLETE') {
    classification = 'quality';
    repair = facts.coverageReviewRequired ? 'scope-or-evidence-review' : 'owned-author';
    riskEligible = !facts.coverageReviewRequired && facts.riskEligible;
  } else if (AUTHOR_CATEGORIES.has(category) || /^artifact\./u.test(code) || AUTHOR_CODES.has(code)) {
    classification = 'author-correction'; repair = 'owned-author';
  } else if (category === 'clarification') {
    classification = 'human-input'; repair = 'record-real-answer';
  } else if (TEST_REPAIR_CODES.has(code)) {
    // A repair handoff grants no edit permission. The current producer must still pass the
    // ownership, source boundary, pinned command and mutation-contract checks.
    classification = 'test-repair'; repair = 'owned-test-environment';
  } else if (OPERATION_CATEGORIES.has(category)) {
    classification = 'operational-prerequisite'; repair = 'configured-owner-action';
  } else if (category === 'lifecycle') {
    classification = 'lifecycle'; repair = 'resume-or-successor';
  }
  return Object.freeze({ classification, repair, riskEligible,
    repairableByProducer: ['owned-author', 'owned-test-environment'].includes(repair), automaticRiskAcceptance: false,
    preserveWork: true, priorApprovalsImmutable: true });
}

export function isArtifactQualityFinding(finding) {
  return ARTIFACT_QUALITY.has(phaseFindingCode(finding)) && phaseFindingPolicy(finding).riskEligible;
}
