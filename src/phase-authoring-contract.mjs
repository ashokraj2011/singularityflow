import path from 'node:path';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isConformancePhase, isConvergencePhase, isTestEvidencePhase, phaseOwnsScope, stepResponsibilities } from './phase-roles.mjs';
import { CLI_PATH_CONTRACT } from './safe-command-guidance.mjs';
import { REPAIR_CONTINUATION_CONTRACT, REPAIR_CONTINUATION_PROTOCOL, phaseRepairCapabilities } from './phase-finding-policy.mjs';
import { REQUIREMENT_COVERAGE, REQUIREMENT_AUTHORING_PROTOCOL } from './requirement-coverage.mjs';

/** Resolve responsibilities from the accepted workflow, never from a packaged phase name. */
export function plannedDeliveryCodeSteps(workflow, phase) {
  if (!phase) return [];
  const policy = workflow?.resolution?.plannedClaims;
  if (policy) return policy.mode === 'required' ? Object.entries(policy.owners ?? {})
    .filter(([codeId, ownerId]) => ownerId === phase.id && phaseRequiresCodeDelivery(workflow.phases?.[codeId]))
    .map(([codeId]) => codeId).sort() : [];
  const order = workflow?.phaseOrder ?? workflow?.resolution?.phases?.map(entry => entry.id)
    ?? Object.keys(workflow?.phases ?? {});
  const position = order.indexOf(phase.id);
  if (position < 0) return [];
  const next = order[position + 1];
  return phaseRequiresCodeDelivery(workflow?.phases?.[next]) ? [next] : [];
}

export function phasePlansDelivery(workflow, phase) {
  return plannedDeliveryCodeSteps(workflow, phase).length > 0;
}

/** Installed defaults apply to seeded, imported, duplicated and future custom workflows alike. */
export function phaseAuthoringContract(definition, workflow, phase) {
  if (!phase) return null;
  const roles = new Set(stepResponsibilities(workflow, phase.id));
  if (phaseOwnsScope(workflow, phase)) roles.add('scope');
  const plans = phasePlansDelivery(workflow, phase);
  if (plans) roles.add('plan');
  if (phaseRequiresCodeDelivery(phase)) roles.add('code');
  if (isConvergencePhase(phase)) roles.add('convergence');
  if (isTestEvidencePhase(phase)) roles.add('verification');
  if (isConformancePhase(phase)) roles.add('closure');
  const evidenceRoot = path.posix.join(definition.workItemRoot ?? 'singularity/work-items', workflow?.workItem?.id ?? '<WORK-ID>', 'evidence');
  return Object.freeze({ revision: 'phase-authoring-v9', phase: phase.id, roles: [...roles].sort(),
    priorApprovalsImmutable: true, revalidatePriorDraftQuality: false,
    executionEvidence: { authority: 'immutable-submission-packets', discoveryIsExecution: false,
      commandSuccessIsCriterionAcceptance: false, priorReportsMutable: false },
    draftDefectsPreventRepair: false, repairIsApproval: false,
    selfHealing: REPAIR_CONTINUATION_CONTRACT,
    repairCapabilities: phaseRepairCapabilities(phase),
    advisories: { blockPublication: false, scopeAccountingRequiredBefore: 'approve', commentsRequireHumanDecision: false },
    configuration: { productSource: false, sourceTagsRequired: false, apiDocumentationRequired: false,
      scopeAccountingRequired: true, candidateAndTestInput: true, protectedPathsEnforced: true },
    clauseAuthority: 'approved-active-clause-capsule', evidenceRoot,
    ...(roles.has('scope') ? { requirementCoverage: REQUIREMENT_COVERAGE, verificationIntent: {
      table: 'Clause | Methods | Criterion', methods: ['test', 'visual', 'inspection'],
      combination: 'all', oneRowPerDeclaredClause: true, nonTestRequirementCriterion: 'exact-declared-AC'
    }, scenarioCoverage: { table: 'Clause | Scenario | Outcome', outcomes: ['success', 'failure', 'boundary', 'empty'],
      acceptanceCase: ['Given', 'When', 'Then'], failureProseIsAcceptance: false,
      lexicalHintsAreBlocking: false, priorApprovedInputsMutable: false } } : {}),
    ...(plans ? { planning: {
      rows: 'one-per-approved-clause', preserveIdsAndMeaning: true,
      emptyPathCell: 'unquoted-dash', retainedEvidencePrefix: `${evidenceRoot}/`,
      touchpointReview: ['entry-points', 'layouts-and-assets', 'data-and-contracts', 'configuration-and-test-support'],
      verification: { criterion: 'exact-approved-AC', method: ['test', 'inspection', 'visual'], inheritApprovedMethods: true,
        role: ['primary', 'supporting'], visualAssurance: ['declared', 'source-bound'] }
    } } : {}),
    recovery: { currentDraft: 'repair-in-place', publishedDraft: 'reviewed-successor-or-return',
      approvedInputIntegrity: 'restore-reviewed-bytes-or-authorized-amendment',
      // An approved earlier artifact that is wrong in content is recorded and worked around; it is
      // never edited here and never a reason to stop. Changed or unapproved bytes are integrity.
      upstreamDefect: 'record-and-continue',
      exhaustedAutomaticBudget: 'manual-repair-remains-available' }
  });
}

/**
 * What an author does with an approved earlier artifact that is wrong, incomplete or contradicts
 * another input. Without it the only instruction was 'never re-author an earlier phase', and agents
 * stopped. The section it asks for is optional, so a phase with nothing to report has no extra
 * heading, and `upstreamDiscrepancies` (phase-upstream-discrepancies.mjs) shows it to reviewers.
 */
export const UPSTREAM_DISCREPANCY_PROTOCOL = '- Upstream discrepancies: approved inputs are fixed evidence. If wrong, incomplete or contradictory, do not edit it and do not stop: use the most conservative reading consistent with the pinned source. Under `## Upstream discrepancies` list producer phase, clause/section, problem, assumption, impact and owner action. Include every affected qualified clause ID in Impact/Clause, also for section issues; cite existing UPI-IDs in comparison rows, never duplicate them. Missing evidence belongs to its producer, not automatically the code phase. File new items once with `singularity-flow upstream-issue raise --from-artifact`; producer approvers decide. Stop only for a refusal about changed or unapproved input bytes (use its restore/return route), or when no reading satisfies the pinned source: then (ask the person only if clarification permits) raise `singularity-flow upstream-issue raise --phase <EARLIER> --about <ID|SECTION> --problem "<TEXT>" --proposed amend` (or `--proposed return`) and end the turn.';

/**
 * `specificationSections` says which optional specification tables this scope step asks for (its
 * policy, required headings or template); null keeps the full contract for a caller that cannot tell.
 */
export function phaseAuthoringContractLines(contract, { deterministicOnly = false, specificationSections = null } = {}) {
  if (!contract) return [];
  const scenarios = contract.verificationIntent && (specificationSections?.scenarioCoverage ?? true);
  const intent = contract.verificationIntent && (specificationSections?.verificationIntent ?? true);
  // A step that both defines the clauses and plans them (a quick fix's intake) has no approved
  // clauses to inherit: it plans the ones it writes.
  const definesClauses = Boolean(contract.verificationIntent);
  return [
    `- Paths: ${CLI_PATH_CONTRACT}`,
    `- ${REPAIR_CONTINUATION_PROTOCOL}`,
    '- Repair boundary: the configured producer repairs this open draft in place; regenerate kernel-owned artifacts, never hand-edit them. Draft defects do not forbid repairs. Preserve prior approved artifacts and decisions; never re-author an earlier phase to satisfy a new template. Publication and any configured approvals remain separate checks.',
    '- Unfinished markers: TODO (in capitals), TBD, TBC, FIXME, {{...}} and [describe ...] read as unfinished work and refuse publication, even inside code spans.',
    '- Readiness: advisories are not current blockers. Documentation comments need no human approval; unplanned-path advice names work to account for before approval. When prepublish is ready and returns commands.publish, continue that publication attempt; required tests still run there. A resolved runner does not require editing repository build/test scripts or runner configuration just to emit its configured report.',
    ...(deterministicOnly ? [] : [UPSTREAM_DISCREPANCY_PROTOCOL]),
    '- Configuration: manifests, lockfiles and build/test/CI/runtime settings are configuration, never product code or executable test declarations. Do not add code traceability tags or API documentation to them. When such a file is the requested change itself (a CI pipeline, container or runtime setting), an approved clause claims it with Fulfillment `configuration`; otherwise account for tooling under Supporting files with a reason. Keep these bytes in scope review, candidate hashes and required tests; governed configuration still uses its separate authority.',
    ...(contract.requirementCoverage && !deterministicOnly ? [REQUIREMENT_AUTHORING_PROTOCOL] : []),
    ...(contract.requirementCoverage ? [
      '- Clause IDs: brackets define a clause once, as `[NS:REQ-001]` (REQ, BEH, IFC, AC or CON, three digits); cite it anywhere else in backticks without brackets.'
    ] : []),
    ...(scenarios ? [
      '- Scenario coverage: author S-number situations, each a heading starting with its number (`### S1 — <situation>`), with substantive Given/When/Then acceptance cases (each keyword once per case, in that order: another "when" or "then" in the sentence starts a new field) and a `## Scenario coverage` table: Clause | Scenario | Outcome (success/failure/boundary/empty), its Scenario cell only the number. Cover every behavior and acceptance clause; repeat rows for multiple outcomes. Approved rejection/error behavior needs a distinct invalid-input case with an observable error, not only failure-state prose. Use pinned request/clarification facts, not invented error wording or extra scope. Lexical hints are advisory; independent source review still judges semantic completeness.'
    ] : []),
    ...(intent ? [
      '- Specification: author a `## Verification intent` table with Clause | Methods | Criterion, one row per declared clause. Methods = test, visual, inspection, or a comma-separated combination (all required). AC Criterion is its own ID; a visual/inspection requirement names the AC proving it, and any AC a requirement names lists every method that requirement lists (a `test, visual` requirement needs a `test, visual` AC). Test-only requirements may use -. Choose from pinned source obligations: screenshot/visual acceptance is not an executable-test exemption. Resolve material ambiguity here, not in Planning.'
    ] : []),
    ...(contract.verificationIntent && !(scenarios && intent) ? [
      `- Optional tables: this step's template and policy ask for no ${[!scenarios && '`## Scenario coverage`', !intent && '`## Verification intent`'].filter(Boolean).join(' or ')} section; do not add one (a malformed optional table still refuses publication). Write each acceptance criterion as an observable pass/fail result.`
    ] : []),
    ...(contract.roles?.includes('closure') ? [
      '- Conformance: one comparison table with a Clause ID column and a Verdict column, one row per clause, each Verdict starting with one word of matched, partial, missing, deviated or unplanned, then any note.'
    ] : []),
    ...(contract.planning ? [
      '- Planning touchpoints: inspect the actual entry points, page/layout shells, shared assets, data/contracts, manifests and test/runtime setup relevant to the approved behavior. Account for expected product files under clause rows and configuration under supporting files; never require a web entry point for an API or CLI. Expected paths are estimates: Implementation reconciles every newly touched file in its own phase through narrow accounting or privately preserved exclusion, without rewriting an approved earlier plan.',
      definesClauses
        ? '- Planning rows: cover every requirement and acceptance ID this draft defines, in a table whose first columns are Clause | Expected paths | Planned tests, in that order. Use a bare - for an empty path cell, never `-` (which names a file).'
        : '- Planning rows: cover every approved requirement and acceptance ID from the authoritative clause capsule; preserve its meaning. The table\'s first columns are Clause | Expected paths | Planned tests, in that order. Use a bare - for an empty path cell, never `-` (which names a file).',
      `- Evidence planning: put retained files under ${contract.planning.retainedEvidencePrefix} in that clause's Expected paths with Fulfillment \`evidence\`; do not assign screenshot obligations to another clause. A planned test that captures one saves under its runner's output (for example test-results/), never at that path, which every later run would replace; the code step copies it there once.`,
      definesClauses
        ? `- Verification: this draft defines its clauses, so there are no approved methods to inherit: ${intent ? 'plan the methods its own `## Verification intent` rows state' : 'each clause is proved by its planned tests'}. Add a \`## Verification contracts\` table only for non-test proof: exact AC Criterion, lower-hyphen Slot, visual/inspection Method, Witness = one backticked value and nothing else (an exact file, or the screen a visual shows), primary Role, Required assurance empty or source-bound, and verification: <AC-ID> in Planned tests. not-applicable: <reason> is only a genuine exemption requiring human disposition. File presence is not a passing witness.`
        : '- Verification: inherit approved clause verification methods, without downgrading required proof to supporting or any-of. Use the actual `## Verification contracts` table: exact approved AC Criterion, lower-hyphen Slot, test/inspection/visual Method, Witness = one backticked value and nothing else (a planned test or exact file, or the screen a visual shows), primary/supporting Role; Required assurance empty or one word: module-observed/exact-local-observed for test, source-bound/declared for inspection or visual. Put scenario/reviewer prose outside these cells. For non-executable proof put verification: <AC-ID> in Planned tests and define its primary visual/inspection slot. not-applicable: <reason> is only a genuine exemption requiring human disposition, not a screenshot check. File presence is not a passing witness.'
    ] : [])
  ];
}

/** Only for a newly rendered template; never rewrite an existing authored or published draft. */
export function scaffoldPlanningRows(markdown, clauseIds) {
  const ids = [...new Set(clauseIds.map(id => String(id).toUpperCase()))].sort();
  if (!ids.length) return markdown;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/u);
  const header = lines.findIndex(line => /^\|\s*Clause\s*\|\s*Expected paths\s*\|\s*Planned tests\s*\|/u.test(line));
  if (header < 0 || !/^\|[\s:|\-]+\|$/u.test(lines[header + 1] ?? '')) return markdown;
  const columns = lines[header].split('|').slice(1, -1).map(value => value.trim());
  const supported = new Set(['Clause', 'Expected paths', 'Planned tests', 'Fulfillment', 'Steps', 'Observable result']);
  if (columns.some(column => !supported.has(column))) return markdown;
  let end = header + 2;
  while (/^\|/u.test(lines[end] ?? '')) end += 1;
  if (lines.slice(header + 2, end).some(line => !/TODO|TBD|<[^>]+>/iu.test(line))) return markdown;
  // Cite each clause as the templates do. A bracketed anchor would define it again, and an earlier
  // phase already defines it (SPEC_CLAUSE_REDEFINED).
  const rows = ids.map(id => `| ${columns.map(column => column === 'Clause' ? `\`${id}\``
    : column === 'Expected paths' || column === 'Fulfillment' || column === 'Steps' ? '-'
      : 'TODO').join(' | ')} |`);
  lines.splice(header + 2, end - header - 2, ...rows);
  return lines.join(newline);
}
