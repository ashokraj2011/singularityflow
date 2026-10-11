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
  return Object.freeze({ revision: 'phase-authoring-v1', phase: phase.id, roles: [...roles].sort(),
    priorApprovalsImmutable: true, revalidatePriorDraftQuality: false,
    draftDefectsPreventRepair: false, repairIsApproval: false,
    clauseAuthority: 'approved-active-clause-capsule', evidenceRoot,
    ...(plans ? { planning: {
      rows: 'one-per-approved-clause', preserveIdsAndMeaning: true,
      emptyPathCell: 'unquoted-dash', retainedEvidencePrefix: `${evidenceRoot}/`,
      verification: { criterion: 'exact-approved-AC', method: ['test', 'inspection', 'visual'],
        role: ['primary', 'supporting'], visualAssurance: ['declared', 'source-bound'] }
    } } : {}),
    recovery: { currentDraft: 'repair-in-place', publishedDraft: 'reviewed-successor-or-return',
      approvedInputIntegrity: 'restore-reviewed-bytes-or-authorized-amendment',
      exhaustedAutomaticBudget: 'manual-repair-remains-available' }
  });
}

export function phaseAuthoringContractLines(contract) {
  if (!contract) return [];
  return [
    '- Repair boundary: the configured producer repairs this open draft in place; regenerate kernel-owned artifacts, never hand-edit them. Draft defects do not forbid repairs. Preserve prior approved artifacts and decisions; never re-author an earlier phase to satisfy a new template. Publication and any configured approvals remain separate checks.',
    ...(contract.planning ? [
      '- Planning rows: cover every approved requirement and acceptance ID from the authoritative clause capsule; preserve its meaning. Use a bare - for an empty path cell, never `-` (which names a file).',
      `- Evidence planning: put retained files under ${contract.planning.retainedEvidencePrefix} in that clause's Expected paths with Fulfillment \`evidence\`; do not assign screenshot obligations to another clause.`,
      '- Verification: use the actual `## Verification contracts` table. Criterion = exact approved AC; Slot = lower-hyphen identifier; Method = test/inspection/visual; Role = primary/supporting; visual Required assurance = source-bound. Put scenario/reviewer prose outside these typed cells. File presence is not a passing witness.'
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
