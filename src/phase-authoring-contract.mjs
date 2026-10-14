import path from 'node:path';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isConformancePhase, isConvergencePhase, isTestEvidencePhase, stepResponsibilities } from './phase-roles.mjs';

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
  const plans = phasePlansDelivery(workflow, phase);
  if (plans) roles.add('plan');
  if (phaseRequiresCodeDelivery(phase)) roles.add('code');
  if (isConvergencePhase(phase)) roles.add('convergence');
  if (isTestEvidencePhase(phase)) roles.add('verification');
  if (isConformancePhase(phase)) roles.add('closure');
  const evidenceRoot = path.posix.join(definition.workItemRoot ?? 'singularity/work-items', workflow?.workItem?.id ?? '<WORK-ID>', 'evidence');
  return Object.freeze({ revision: 'phase-authoring-v7', phase: phase.id, roles: [...roles].sort(),
    priorApprovalsImmutable: true, revalidatePriorDraftQuality: false,
    executionEvidence: { authority: 'immutable-submission-packets', discoveryIsExecution: false,
      commandSuccessIsCriterionAcceptance: false, priorReportsMutable: false },
    draftDefectsPreventRepair: false, repairIsApproval: false,
    advisories: { blockPublication: false, scopeAccountingRequiredBefore: 'approve', commentsRequireHumanDecision: false },
    configuration: { productSource: false, sourceTagsRequired: false, apiDocumentationRequired: false,
      scopeAccountingRequired: true, candidateAndTestInput: true, protectedPathsEnforced: true },
    clauseAuthority: 'approved-active-clause-capsule', evidenceRoot,
    ...(roles.has('scope') ? { verificationIntent: {
      table: 'Clause | Methods | Criterion', methods: ['test', 'visual', 'inspection'],
      combination: 'all', oneRowPerDeclaredClause: true, nonTestRequirementCriterion: 'exact-declared-AC'
    }, scenarioCoverage: { table: 'Clause | Scenario | Outcome', outcomes: ['success', 'failure', 'boundary', 'empty'],
      acceptanceCase: ['Given', 'When', 'Then'], failureProseIsAcceptance: false,
      lexicalHintsAreBlocking: false, priorApprovedInputsMutable: false } } : {}),
    ...(plans ? { planning: {
      rows: 'one-per-approved-clause', preserveIdsAndMeaning: true,
      emptyPathCell: 'unquoted-dash', retainedEvidencePrefix: `${evidenceRoot}/`,
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
export const UPSTREAM_DISCREPANCY_PROTOCOL = '- Upstream discrepancies: approved earlier-phase artifacts are fixed evidence. If one is wrong, incomplete or contradicts another input or the pinned source, do not edit it and do not stop: continue on the most conservative reading consistent with the pinned source, and list each item under `## Upstream discrepancies` (producer phase, exact clause or section, problem, assumption used, impact, proposed owner action), then file them once with `singularity-flow upstream-issue raise --from-artifact`; the producer\'s approvers decide them. Stop only for a refusal about changed or unapproved input bytes (use its restore or return route), or when no reading satisfies the pinned source.';

export function phaseAuthoringContractLines(contract, { deterministicOnly = false } = {}) {
  if (!contract) return [];
  return [
    '- Repair boundary: the configured producer repairs this open draft in place; regenerate kernel-owned artifacts, never hand-edit them. Draft defects do not forbid repairs. Preserve prior approved artifacts and decisions; never re-author an earlier phase to satisfy a new template. Publication and any configured approvals remain separate checks.',
    '- Readiness: advisories are not current blockers. Documentation comments need no human approval; unplanned-path advice names work to account for before approval. When prepublish is ready and returns commands.publish, continue that publication attempt; required tests still run there. A resolved runner does not require editing package scripts just to emit its configured report.',
    ...(deterministicOnly ? [] : [UPSTREAM_DISCREPANCY_PROTOCOL]),
    '- Configuration: manifests, lockfiles and build/test/CI/runtime settings are configuration, never product code or executable test declarations. Do not add code traceability tags or API documentation to them. Account for tooling under Supporting files with a reason, or use fulfillment configuration for a requirement changing runtime settings. Keep these bytes in scope review, candidate hashes and required tests; governed configuration still uses its separate authority.',
    ...(contract.verificationIntent ? [
      '- Scenario coverage: author S-number situations with substantive Given/When/Then acceptance cases and a `## Scenario coverage` table: Clause | Scenario | Outcome (success/failure/boundary/empty). Cover every behavior and acceptance clause; repeat rows for multiple outcomes. Approved rejection/error behavior needs a distinct invalid-input case with an observable error, not only failure-state prose. Use pinned request/clarification facts, not invented error wording or extra scope. Lexical hints are advisory; independent source review still judges semantic completeness.',
      '- Specification: author a `## Verification intent` table with Clause | Methods | Criterion, one row per declared clause. Methods = test, visual, inspection, or a comma-separated combination (all required). AC Criterion is its own ID; a visual/inspection requirement names the AC proving it. Test-only requirements may use -. Choose from pinned source obligations: screenshot/visual acceptance is not an executable-test exemption. Resolve material ambiguity here, not in Planning.'
    ] : []),
    ...(contract.planning ? [
      '- Planning rows: cover every approved requirement and acceptance ID from the authoritative clause capsule; preserve its meaning. Use a bare - for an empty path cell, never `-` (which names a file).',
      `- Evidence planning: put retained files under ${contract.planning.retainedEvidencePrefix} in that clause's Expected paths with Fulfillment \`evidence\`; do not assign screenshot obligations to another clause.`,
      '- Verification: inherit approved clause verification methods, without downgrading required proof to supporting or any-of. Use the actual `## Verification contracts` table: exact approved AC Criterion, lower-hyphen Slot, test/inspection/visual Method, primary/supporting Role; visual assurance = source-bound. Put scenario/reviewer prose outside these cells. For non-executable proof put verification: <AC-ID> in Planned tests and define its primary visual/inspection slot. not-applicable: <reason> is only a genuine exemption requiring human disposition, not a screenshot check. File presence is not a passing witness.'
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
  const rows = ids.map(id => `| ${columns.map(column => column === 'Clause' ? `[${id}]`
    : column === 'Expected paths' || column === 'Fulfillment' || column === 'Steps' ? '-'
      : 'TODO').join(' | ')} |`);
  lines.splice(header + 2, end - header - 2, ...rows);
  return lines.join(newline);
}
