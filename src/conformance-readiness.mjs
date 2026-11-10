import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  conformanceTableRows, conformanceVerdictGaps, contradictedConformanceVerdicts, duplicateQualifiedConformanceRows, missingQualifiedConformanceRows, unreadConformanceTables
} from './engine-compatibility/node-specification-policy.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';
import { normalizeQualifiedClauseId } from './foundation/traceability-ids.mjs';
import { conformanceGapDecisions } from './upstream-routes.mjs';
import { secureRepositoryPath } from './util.mjs';
import { mentionsWhole, undisclosedSelfApprovals, inspectSelfApprovalDisclosures, selfApprovalDisclosureLines, withSelfApprovalDisclosures, inspectConformanceReportContract, inspectQualifiedConformanceReport } from './kernel/conformance-report.mjs';
export { mentionsWhole, undisclosedSelfApprovals, inspectSelfApprovalDisclosures, selfApprovalDisclosureLines, withSelfApprovalDisclosures, inspectConformanceReportContract, inspectQualifiedConformanceReport } from './kernel/conformance-report.mjs';

const TRACEABILITY_KINDS = new Set(['requirements', 'implementation-spec']);

/**
 * The identifiers a report without qualified rows must mention: every AC- or SPEC- ID in the
 * Story's requirements and implementation-spec documents. An unreadable document adds none.
 */
export async function traceableConformanceIds(root, config, workflow) {
  const directory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const found = new Set();
  for (const phase of (workflow.phaseOrder ?? []).map((id) => workflow.phases?.[id])) {
    if (!TRACEABILITY_KINDS.has(phase?.requiredArtifact?.kind)) continue;
    const text = await readFile(path.join(directory, phase.requiredArtifact.path), 'utf8').catch(() => '');
    for (const match of text.matchAll(/\b(?:AC|SPEC)-\d+\b/g)) found.add(match[0]);
  }
  return [...found];
}

const advisory = (code, fields) => Object.freeze({ code, category: 'traceability', blocking: false, ...fields });

/**
 * What the report's verdicts tell its author and reviewer, never a blocker. Owner decision
 * (2026-10-19): an honest partial or missing verdict does not block drafting, publication or
 * submission. A release step that pushed its agent to clear such a check flipped four honest
 * verdicts to "matched" while its own discrepancy paragraph still said "partial", and published.
 * So a gap is an advisory required before approval (a person decides it, see
 * conformanceGapDecisions), and a table that contradicts its own discrepancy text is information.
 */
export function inspectConformanceVerdictAdvisories(markdown, { workflow = null, phaseId = null, now = undefined, reused = [] } = {}) {
  const gaps = conformanceVerdictGaps(markdown, { workflow, phaseId });
  const decided = workflow && phaseId ? conformanceGapDecisions(workflow, phaseId, gaps, { now, reused })
    : gaps.map((gap) => ({ ...gap, owner: null, status: 'unraised', issue: null, choices: [] }));
  return [
    ...decided.map((gap) => {
      const named = gap.owner ?? 'the step that delivered it';
      const covered = gap.status === 'decided';
      return advisory('conformance.verdict-incomplete', {
        requiredBefore: covered ? null : 'approve', clauseId: gap.clauseId, value: gap.clauseId, line: gap.line,
        details: { clauseId: gap.clauseId, verdict: gap.verdict, owner: gap.owner, status: gap.status, issue: gap.issue,
          ...(/^UPI-\d{3,}$/u.test(gap.issue ?? '') ? { issueRefs: [gap.issue] }
            : gap.issueRefs ? { issueRefs: gap.issueRefs } : {}),
          expiresAt: gap.expiresAt ?? null, choices: gap.choices },
        message: `conformance ${gap.clauseId} remains ${gap.verdict}. Keep the honest verdict: it publishes, and ${named} owns the gap. `
          + (covered ? `${gap.issue} (${gap.outcome}) decides it, so this step can be approved with the honest verdict.`
            : `${gap.issue ? `${gap.issue} names it; ` : `Raise an upstream issue against ${named} for ${gap.clauseId} if none exists; `}its approvers decide it before this step is approved.`)
      });
    }),
    ...contradictedConformanceVerdicts(markdown).map((entry) => advisory('conformance.verdict-contradicted', {
      requiredBefore: null, clauseId: entry.clauseId, value: entry.clauseId, line: entry.line,
      details: { clauseId: entry.clauseId, verdict: entry.verdict, stated: entry.stated, section: entry.section, excerpt: entry.excerpt },
      message: `conformance ${entry.clauseId}: the table says matched, the ${entry.section} text says ${entry.stated}: use the honest verdict.`
    }))
  ];
}

export const VERDICT_SUMMARY_START = '<!-- singularity-flow:verdict-summary:start -->';
export const VERDICT_SUMMARY_END = '<!-- singularity-flow:verdict-summary:end -->';
const VERDICT_SUMMARY = /<!-- singularity-flow:verdict-summary:start -->[\s\S]*?<!-- singularity-flow:verdict-summary:end -->/u;

function verdictCoverage(gap) {
  const owner = gap.owner ?? 'the delivering step';
  if (gap.status === 'decided' && gap.outcome === 'evidence-reuse') return `covered by ${gap.issue}: ${gap.reuse}.`;
  if (gap.status === 'decided') {
    return `covered by ${gap.issue} (${gap.outcome === 'accept-risk' ? `accepted risk until ${String(gap.expiresAt ?? '').slice(0, 10)}` : 'dismissed'}).`;
  }
  if (gap.status === 'expired') return `${gap.issue}'s accepted risk expired; ${owner}'s approvers decide it again.`;
  if (gap.status === 'undecided') return `${gap.issue} raised against ${owner}; not decided yet.`;
  return `no issue raised yet; ${owner} owns it.`;
}

/**
 * One verdict source [owner decision 2026-10-19, D]. The clause table is the only place a verdict is
 * stated; this engine-written block repeats each partial or missing one with the upstream issue
 * that covers it, so no prose has to restate a verdict. It is read from the table without itself.
 */
export function verdictSummaryBlock(markdown, workflow, phaseId, { now = undefined, reused = [] } = {}) {
  const table = String(markdown ?? '').replace(VERDICT_SUMMARY, '');
  const gaps = conformanceGapDecisions(workflow, phaseId, conformanceVerdictGaps(table, { workflow, phaseId }), { now, reused });
  return [
    VERDICT_SUMMARY_START,
    'Engine-written from the clause table; keep it. The table is the only place a verdict is stated.', '',
    ...(gaps.length ? gaps.map((gap) => `- \`${gap.clauseId}\`: ${gap.verdict}; ${verdictCoverage(gap)}`) : ['- No clause in the table is partial or missing.']),
    VERDICT_SUMMARY_END
  ].join('\n');
}

/** The report with its Verdict summary refreshed in place, or added under its own heading. */
export function withVerdictSummary(markdown, workflow, phaseId, options = {}) {
  const text = String(markdown ?? '');
  const block = verdictSummaryBlock(text, workflow, phaseId, options);
  if (VERDICT_SUMMARY.test(text)) return text.replace(VERDICT_SUMMARY, () => block);
  return `${text.trimEnd()}\n\n## Verdict summary\n\n${block}\n`;
}

/** Whether the report's Verdict summary says what its table and the upstream issues say now. */
export function verdictSummaryStatus(markdown, workflow, phaseId, options = {}) {
  const present = String(markdown ?? '').match(VERDICT_SUMMARY)?.[0] ?? null;
  const expected = verdictSummaryBlock(markdown, workflow, phaseId, options);
  return Object.freeze({ present: present != null, current: present === expected, expected });
}

/**
 * Inspect only the immutable policy captured by this Story, never the current workspace default.
 *
 * Qualified clause rows follow the pinned policy. Self-approval disclosure, the traceable
 * identifiers and the verdicts are checked for every conformance report, because the approval gate
 * checks them for every one: a report authored under another row policy was published without
 * them and refused only at approval.
 */
export async function inspectPhaseQualifiedConformance(root, config, workflow, phase) {
  return (await inspectPhaseConformance(root, config, workflow, phase)).findings;
}

/** The report's blocking findings, its verdict advisories and its Verdict summary, read once. */
export async function inspectPhaseConformance(root, config, workflow, phase) {
  if (phase?.requiredArtifact?.kind !== 'conformance-report') return { findings: [], advisories: [], summary: null };
  const qualified = workflow.resolution?.spec?.conformanceRows === 'qualified';
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const relative = path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    phase.requiredArtifact.path
  );
  const safe = await secureRepositoryPath(root, relative, {
    label: `Conformance report for phase '${phase.id}'`, mustExist: qualified, type: 'file'
  });
  if (!qualified && !safe.exists) return { findings: [], advisories: [], summary: null };
  const markdown = await readFile(safe.absolute, 'utf8');
  const clauseIds = qualified ? [...new Set((await loadActiveSpecRecords(itemDirectory, workflow)).indexes
    .flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)))] : [];
  // As the gate: qualified rows replace the identifier mentions only when there are clauses.
  const rowsQualified = clauseIds.length > 0;
  const findings = [
    ...(rowsQualified ? inspectQualifiedConformanceReport(markdown, clauseIds) : []),
    ...inspectConformanceReportContract(markdown, {
      rowsQualified, expected: rowsQualified ? [] : await traceableConformanceIds(root, config, workflow)
    }),
    ...inspectSelfApprovalDisclosures(markdown, workflow)
  ].map((finding) => ({
    ...finding, path: relative
  }));
  const reused = await conformanceEvidenceReuse(root, config, workflow, phase.id);
  const advisories = inspectConformanceVerdictAdvisories(markdown, { workflow, phaseId: phase.id, reused })
    .map((entry) => Object.freeze({ ...entry, path: relative }));
  return { findings, advisories, summary: verdictSummaryStatus(markdown, workflow, phase.id, { reused }) };
}

/**
 * The evidence-reuse decisions a person approved for this step or an earlier one that still hold
 * (bound to unchanged source). Each covers its clauses' gaps as that step's recorded run. Loaded only
 * when the Story has such a decision, so Story start and lifecycle reads load nothing new.
 */
export async function conformanceEvidenceReuse(root, config, workflow, phaseId, at = undefined) {
  if (!(workflow?.evidenceReuses ?? []).length) return [];
  const { evidenceReuseFor } = await import('./evidence-reuse.mjs');
  return (await evidenceReuseFor(root, config, workflow, phaseId, { ...(at ? { at } : {}), through: true })).active;
}
