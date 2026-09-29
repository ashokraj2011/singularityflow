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
  if (!clauseIds.length) return [];
  const relative = path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    phase.requiredArtifact.path
  );
  const safe = await secureRepositoryPath(root, relative, {
    label: `Conformance report for phase '${phase.id}'`, mustExist: true, type: 'file'
  });
  const markdown = await readFile(safe.absolute, 'utf8');
  return inspectQualifiedConformanceReport(markdown, clauseIds).map((finding) => ({
    ...finding, path: relative
  }));
}
