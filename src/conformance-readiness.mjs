import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  conformanceTableRows, conformanceVerdictGaps, contradictedConformanceVerdicts, duplicateQualifiedConformanceRows, missingQualifiedConformanceRows, unreadConformanceTables
} from './conformance-verdicts.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';
import { normalizeQualifiedClauseId } from './foundation/traceability-ids.mjs';
import { conformanceGapDecisions } from './upstream-routes.mjs';
import { secureRepositoryPath } from './util.mjs';
import {shown} from './kernel/draft-diagnostics.mjs';

const VERDICT = /^(matched|partial|missing|deviated|unplanned)(?:\s|\(|$)/u;
const ANY_VERDICT = /\b(matched|partial|missing|deviated|unplanned)\b/;
const TRACEABILITY_KINDS = new Set(['requirements', 'implementation-spec']);
const MULTIPLE_VERDICTS = /\b(?:matched|partial|missing|deviated|unplanned)\s*(?:\/|\bor\b)\s*(?:matched|partial|missing|deviated|unplanned)\b/u;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/gu;
const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\n[\s\S]*?\n-->\s*/u;

function authoredConformanceText(markdown) {
  return String(markdown ?? '').replace(MANAGED_METADATA, '').replace(MANAGED_INPUTS, '');
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

/**
 * Whether `text` names `value` whole: a phase ID, login or email not run into a longer one, so
 * `implementation` is not named by `implementation-spec` or `implementation.md`, nor `ann` by `anna`.
 */
export function mentionsWhole(text, value) {
  if (!value) return false;
  return new RegExp(`(?<![\\w.@+-])${String(value).replace(REGEXP_SPECIAL, '\\$&')}(?![\\w@+-]|\\.\\w)`, 'u').test(String(text ?? ''));
}

function retainedSelfApprovals(workflow) {
  const entries = [];
  const phaseIds = [...new Set([...(workflow?.phaseOrder ?? []), ...Object.keys(workflow?.phases ?? {})])];
  for (const phaseId of phaseIds) {
    for (const approval of workflow?.phases?.[phaseId]?.approvals ?? []) {
      if (approval.invalidatedAt || !approval.selfApproval) continue;
      const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name ?? null;
      entries.push({ phaseId, actor,
        line: `- \`${phaseId}\`: self-approved${actor ? ` by ${actor}` : ''}; not an independent review.` });
    }
  }
  return entries;
}

/**
 * Each retained self-approval `text` does not disclose: one that names neither its phase ID nor its
 * approver whole. Draft check, publication and the gate share it [gate parity]; the message names
 * the exact line that satisfies it.
 */
export function undisclosedSelfApprovals(text, workflow) {
  return retainedSelfApprovals(workflow)
    .filter(({ phaseId, actor }) => !(mentionsWhole(text, phaseId) && (!actor || mentionsWhole(text, actor))))
    .map((entry) => ({ ...entry,
      message: `conformance report does not disclose self-approval for ${entry.phaseId}${entry.actor ? ` by ${entry.actor}` : ''}; `
        + `add this line under the report's self-approval section, naming the phase and approver exactly: ${entry.line}` }));
}

/** Required disclosure is derived from retained approvals, not model-authored recollection. */
export function inspectSelfApprovalDisclosures(markdown, workflow) {
  return undisclosedSelfApprovals(authoredConformanceText(markdown), workflow).map(({ message }) => ({
    code: 'conformance.self-approval-undisclosed', clauseId: null, line: null, message
  }));
}

/** Each self-approval a conformance report owes, from retained approvals, as one Markdown line. */
export function selfApprovalDisclosureLines(workflow) {
  return retainedSelfApprovals(workflow).map(({ line }) => line);
}

/**
 * A new conformance report starts with the self-approval disclosures it owes.
 *
 * The draft check refuses a report that omits one, and an agent that forgets it pays for a bounded
 * repair loop to add a paragraph the engine already knows. The template's own disclosure section,
 * when it has one, receives the lines in place of its TODO; otherwise the section is appended.
 */
export function withSelfApprovalDisclosures(markdown, workflow) {
  const lines = selfApprovalDisclosureLines(workflow);
  if (!lines.length) return markdown;
  const block = ['Recorded from the retained approvals. Keep every line.', '', ...lines].join('\n');
  const section = /^## Self-approval disclosures?[ \t]*\n(?:(?!^## )[\s\S])*?^TODO:[^\n]*$/mu;
  if (section.test(markdown)) return markdown.replace(section, (match) => match.replace(/^TODO:[^\n]*$/mu, block));
  return `${String(markdown).trimEnd()}\n\n## Self-approval disclosures\n\n${block}\n`;
}

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

/**
 * What every conformance report owes the approval gate apart from qualified rows and self-approval
 * disclosure, read exactly as the gate reads it: a mention of each traceable identifier and at least
 * one recognized verdict. The gate and the earlier checks call this one function, so a report is
 * never refused first at approval [gate parity]. A partial or missing verdict is not a defect of the
 * report: it is an advisory here (inspectConformanceVerdictAdvisories), decided by a person before
 * approval. `rowsQualified` means the qualified row contract already judged the rows.
 */
export function inspectConformanceReportContract(report, { expected = [], rowsQualified = false } = {}) {
  const text = String(report ?? '');
  const findings = [];
  if (!rowsQualified) {
    for (const id of expected) {
      if (!text.includes(id)) findings.push({ code: 'conformance.clause-row-missing', clauseId: id, line: null, message: `conformance report has no row for ${id}` });
    }
  }
  if (!ANY_VERDICT.test(text)) findings.push({ code: 'conformance.verdict-invalid', clauseId: null, line: null, message: 'conformance report has no recognized verdict' });
  return findings;
}

/** One report-row contract for draft, publication, approval, and terminal review. */
export function inspectQualifiedConformanceReport(markdown, clauseIds) {
  const known = new Set((clauseIds ?? []).map(normalizeQualifiedClauseId).filter(Boolean));
  if (!known.size) return [];
  const findings = [];
  // No table read at all: say which table was skipped and why, not "no row" once per clause.
  const unread = conformanceTableRows(markdown).length ? [] : unreadConformanceTables(markdown);
  if (unread.length) {
    findings.push({ code: 'conformance.table-unrecognized', clauseId: null, line: unread[0].line,
      message: `conformance report has no comparison table: one needs a Clause ID column (or Clause, ID, Criterion) and a Verdict column; the table at line ${unread[0].line} has ${shown(unread[0].header.join(' | '))}` });
    return findings;
  }
  for (const id of missingQualifiedConformanceRows(markdown, known)) {
    findings.push({ code: 'conformance.clause-row-missing', clauseId: id,
      message: `conformance report has no row for ${id}`, line: null });
  }
  for (const id of duplicateQualifiedConformanceRows(markdown)) {
    findings.push({ code: 'conformance.clause-row-duplicate', clauseId: id,
      message: `conformance report has duplicate row for ${id}`, line: null });
  }
  for (const row of conformanceTableRows(markdown)) {
    const id = normalizeQualifiedClauseId(row.clauseId);
    if (!id) {
      findings.push({ code: 'conformance.clause-row-invalid', clauseId: row.clauseId,
        message: `conformance report has an invalid qualified clause ID on line ${row.line}: it holds ${shown(row.clauseId)}; write it in full, such as ORDER:REQ-001`, line: row.line });
      continue;
    }
    if (!known.has(id)) {
      findings.push({ code: 'conformance.clause-row-unknown', clauseId: id,
        message: `conformance report references unapproved clause ${id} on line ${row.line}`, line: row.line });
    } else if (!VERDICT.test(row.verdict) || MULTIPLE_VERDICTS.test(row.verdict)) {
      findings.push({ code: 'conformance.verdict-invalid', clauseId: id,
        message: `conformance ${id} has no recognized verdict on line ${row.line}: its Verdict holds ${shown(row.verdict)}; start it with one word of matched, partial, missing, deviated or unplanned, then any note`, line: row.line });
    }
  }
  return findings;
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
