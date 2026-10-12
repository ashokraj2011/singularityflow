import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  blockingConformanceVerdicts,
  conformanceTableRows,
  duplicateQualifiedConformanceRows,
  missingQualifiedConformanceRows
} from './conformance-verdicts.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';
import { normalizeQualifiedClauseId } from './traceability-ids.mjs';
import { secureRepositoryPath } from './util.mjs';

const VERDICT = /^(matched|partial|missing|deviated|unplanned)(?:\s|\(|$)/u;
const ANY_VERDICT = /\b(matched|partial|missing|deviated|unplanned)\b/;
const TRACEABILITY_KINDS = new Set(['requirements', 'implementation-spec']);
const MULTIPLE_VERDICTS = /\b(?:matched|partial|missing|deviated|unplanned)\s*(?:\/|\bor\b)\s*(?:matched|partial|missing|deviated|unplanned)\b/u;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/gu;
const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\n[\s\S]*?\n-->\s*/u;

function authoredConformanceText(markdown) {
  return String(markdown ?? '').replace(MANAGED_METADATA, '').replace(MANAGED_INPUTS, '');
}

/** Required disclosure is derived from retained approvals, not model-authored recollection. */
export function inspectSelfApprovalDisclosures(markdown, workflow) {
  const authored = authoredConformanceText(markdown);
  const findings = [];
  for (const phaseId of workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {})) {
    for (const approval of workflow?.phases?.[phaseId]?.approvals ?? []) {
      if (approval.invalidatedAt || !approval.selfApproval) continue;
      const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name ?? null;
      if (authored.includes(phaseId) && (!actor || authored.includes(actor))) continue;
      findings.push({
        code: 'conformance.self-approval-undisclosed', clauseId: null, line: null,
        message: `conformance report does not disclose self-approval for ${phaseId}${actor ? ` by ${actor}` : ''}`
      });
    }
  }
  return findings;
}

/** Each self-approval a conformance report owes, from retained approvals, as one Markdown line. */
export function selfApprovalDisclosureLines(workflow) {
  const lines = [];
  for (const phaseId of workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {})) {
    for (const approval of workflow?.phases?.[phaseId]?.approvals ?? []) {
      if (approval.invalidatedAt || !approval.selfApproval) continue;
      const actor = approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name ?? null;
      lines.push(`- \`${phaseId}\`: self-approved${actor ? ` by ${actor}` : ''}; not an independent review.`);
    }
  }
  return lines;
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
 * disclosure, read exactly as the gate reads it: a mention of each traceable identifier, at least
 * one recognized verdict, and no partial or missing verdict. The gate and the earlier checks call
 * this one function, so a report is never refused first at approval [gate parity].
 * `rowsQualified` means the qualified row contract already judged the rows and their verdicts.
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
  if (!rowsQualified) {
    for (const finding of blockingConformanceVerdicts(text)) {
      findings.push({ code: 'conformance.verdict-incomplete', clauseId: finding.clauseId, line: null, message: `conformance ${finding.clauseId} remains ${finding.verdict}` });
    }
  }
  return findings;
}

/** One report-row contract for draft, publication, approval, and terminal review. */
export function inspectQualifiedConformanceReport(markdown, clauseIds) {
  const known = new Set((clauseIds ?? []).map(normalizeQualifiedClauseId).filter(Boolean));
  if (!known.size) return [];
  const findings = [];
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
        message: `conformance report has an invalid qualified clause ID on line ${row.line}`, line: row.line });
      continue;
    }
    if (!known.has(id)) {
      findings.push({ code: 'conformance.clause-row-unknown', clauseId: id,
        message: `conformance report references unapproved clause ${id} on line ${row.line}`, line: row.line });
    } else if (!VERDICT.test(row.verdict) || MULTIPLE_VERDICTS.test(row.verdict)) {
      findings.push({ code: 'conformance.verdict-invalid', clauseId: id,
        message: `conformance ${id} has no recognized verdict on line ${row.line}`, line: row.line });
    } else if (/^(partial|missing)(?:\s|\(|$)/u.test(row.verdict)) {
      findings.push({ code: 'conformance.verdict-incomplete', clauseId: id,
        message: `conformance ${id} remains ${row.verdict.split(/\s/u)[0]}`, line: row.line });
    }
  }
  return findings;
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
  if (phase?.requiredArtifact?.kind !== 'conformance-report') return [];
  const qualified = workflow.resolution?.spec?.conformanceRows === 'qualified';
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const relative = path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    phase.requiredArtifact.path
  );
  const safe = await secureRepositoryPath(root, relative, {
    label: `Conformance report for phase '${phase.id}'`, mustExist: qualified, type: 'file'
  });
  if (!qualified && !safe.exists) return [];
  const markdown = await readFile(safe.absolute, 'utf8');
  const clauseIds = qualified ? [...new Set((await loadActiveSpecRecords(itemDirectory, workflow)).indexes
    .flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)))] : [];
  // As the gate: qualified rows replace the identifier mentions only when there are clauses.
  const rowsQualified = clauseIds.length > 0;
  return [
    ...(rowsQualified ? inspectQualifiedConformanceReport(markdown, clauseIds) : []),
    ...inspectConformanceReportContract(markdown, {
      rowsQualified, expected: rowsQualified ? [] : await traceableConformanceIds(root, config, workflow)
    }),
    ...inspectSelfApprovalDisclosures(markdown, workflow)
  ].map((finding) => ({
    ...finding, path: relative
  }));
}
