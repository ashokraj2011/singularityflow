import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  conformanceTableRows,
  duplicateQualifiedConformanceRows,
  missingQualifiedConformanceRows
} from './conformance-verdicts.mjs';
import { loadActiveSpecRecords } from './specifications.mjs';
import { normalizeQualifiedClauseId } from './traceability-ids.mjs';
import { secureRepositoryPath } from './util.mjs';

const VERDICT = /^(matched|partial|missing|deviated|unplanned)(?:\s|\(|$)/u;
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

/** Inspect only the immutable policy captured by this Story, never the current workspace default. */
export async function inspectPhaseQualifiedConformance(root, config, workflow, phase) {
  if (workflow.resolution?.spec?.conformanceRows !== 'qualified'
      || phase?.requiredArtifact?.kind !== 'conformance-report') return [];
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const clauseIds = [...new Set(records.indexes.flatMap((index) =>
    (index.clauses ?? []).map((clause) => clause.id)))];
  const relative = path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    phase.requiredArtifact.path
  );
  const safe = await secureRepositoryPath(root, relative, {
    label: `Conformance report for phase '${phase.id}'`, mustExist: true, type: 'file'
  });
  const markdown = await readFile(safe.absolute, 'utf8');
  return [
    ...inspectQualifiedConformanceReport(markdown, clauseIds),
    ...inspectSelfApprovalDisclosures(markdown, workflow)
  ].map((finding) => ({
    ...finding, path: relative
  }));
}
