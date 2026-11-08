/**
 * Where each blocking finding is documented. `[recoverable-findings M1]`
 *
 * A refusal named a finding code, and its route sent the author back to repair it; nothing said
 * what the code meant, what usually causes it, or who else can act when the author cannot (an
 * Android Story looped on CODE_DELIVERY_EVIDENCE_REQUIRED because the check misread its tests).
 * Every finding now points at an entry in the `findings` topic: its own when the recovery routes
 * name the code, else its family's, else its class's, so no finding is left without one.
 */
import { phaseFindingCode, phaseFindingPolicy } from './phase-finding-policy.mjs';

export const FINDINGS_TOPIC = 'findings';

// Codes the recovery routes name, by the section that documents them (lower case).
const CODE_SECTIONS = new Map(Object.entries({
  'CODE_DELIVERY_EVIDENCE_REQUIRED': ['code_delivery_evidence_required'],
  'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING': ['code_delivery_retained_evidence_missing'],
  // Published retained evidence the checkout no longer holds: a later step's commit, or a witness.
  'RETAINED_EVIDENCE_CHANGED': ['retained_evidence_changed', 'witness_evidence_unpublished'],
  // Every runner an approved test command must supply: none inferable, two build systems, a native
  // target (Android variant, Xcode scheme) or adapter that would otherwise be guessed.
  'CODE_DELIVERY_TEST_COMMAND_REQUIRED': ['code_delivery_test_command_required', 'test_module_ambiguous', 'test_module_uncovered',
    'gradle_test_target_required', 'xcode_test_target_required', 'rust_test_adapter_required', 'code_test_result_required',
    'code_test_suppressed'],
  'SPEC_COVERAGE_INCOMPLETE': ['spec_coverage_incomplete'],
  'Unclaimed changed paths': ['generation_excluded_changes_unresolved'],
  'test-repair': ['code_test_failed', 'code_test_timeout', 'code_test_skipped', 'code_test_zero_discovered'],
  // An honest partial or missing verdict, its approval refusal and its gate code share one entry.
  'conformance.verdict-incomplete': ['conformance.verdict-incomplete', 'conformance_blocking_verdicts', 'gate.conformance.blocking-verdict'],
  'conformance.verdict-contradicted': ['conformance.verdict-contradicted', 'conformance.verdict-summary-stale'],
  'plan_evidence_correction_review_required': ['plan_evidence_correction_review_required'],
  'phase_quality_risk_pending_tests': ['phase_quality_risk_pending_tests'],
  'generation.document.published-changed': ['generation.document.published-changed'],
  'Agent brief findings': ['agent_brief_summary_required', 'agent_brief_preserved_section_required',
    'agent_brief_maximum_bytes_exceeded', 'agent_brief_heading_ambiguous', 'artifact_comment_unclosed'],
  'Document quality findings': ['artifact.placeholder.unresolved', 'artifact.required.too-short', 'artifact.heading.empty'],
  'Upstream input findings': ['phase_inputs_not_ready', 'phase.inputs.not-ready', 'specification_index_untrusted',
    'convergence_upstream_artifact_stale'],
  'Claim binding findings': ['specification_claim_map_binding_stale', 'specification_claim_map_binding_required'],
  'Repair attempt findings': ['phase_repair_recheck_required'],
  'Generation intent findings': ['generation_intent_required', 'phase.generation-intent.required',
    'generation_intent_already_consumed', 'generation.intent.consumed-changed'],
  'Grounding findings': ['phase.grounding.required', 'phase.grounding.not-ready'],
  'Files outside the step': ['phase_artifact_only_changes', 'phase_source_change_ungoverned'],
  // A code step's lint, static-analysis and security findings on changed lines, and its scanners [CQF M4].
  'Code quality findings': ['code_quality_findings', 'code_quality_findings_held'],
  // A vulnerable package the Story added, which holds the step's approval for a person [CQF:REQ-052].
  'Vulnerable new dependencies': ['dependency_vulnerability_held']
}).flatMap(([section, codes]) => codes.map((code) => [code, section])));

// Code families the recovery routes match by prefix or pattern.
const FAMILY_SECTIONS = [
  [/^generation_publication/u, 'Retained publication findings'],
  [/^phase_repair_journal/u, 'Repair attempt findings'],
  [/unclaimed|outside.*scope/u, 'Unclaimed changed paths']
];

/** Every section this module can name, for the catalog's own completeness check. */
export function findingCatalogSections() {
  return [...new Set([...CODE_SECTIONS.values(), ...FAMILY_SECTIONS.map(([, section]) => section)])];
}

/** A refusal's own catalog entry, or null when only a class entry would apply (it has no category). */
export function specificFindingDocumentation(code) {
  const lower = String(code ?? '').toLowerCase();
  const known = CODE_SECTIONS.has(lower) || FAMILY_SECTIONS.some(([pattern]) => pattern.test(lower));
  return known ? findingDocumentation({ code }) : null;
}

/** The `findings` section that documents a finding, and the command that serves it. */
export function findingDocumentation(finding) {
  const code = phaseFindingCode(finding);
  const lower = code.toLowerCase();
  const section = CODE_SECTIONS.get(lower)
    ?? FAMILY_SECTIONS.find(([pattern]) => pattern.test(lower))?.[1]
    ?? phaseFindingPolicy(finding).classification;
  return Object.freeze({
    topic: FINDINGS_TOPIC, section, code,
    argv: Object.freeze(['explain', FINDINGS_TOPIC, '--section', section]),
    command: `singularity-flow explain ${FINDINGS_TOPIC} --section ${/\s/u.test(section) ? `"${section}"` : section}`
  });
}
