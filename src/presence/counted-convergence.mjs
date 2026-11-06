/**
 * SF Guard (SPEC-PSS-v1 §10.10): a convergence projection as its readers count it.
 *
 * On a Story SF Guard requires, a finding counts only while its adjudication's presence signature
 * (kept in the sealed projection, family v4) verifies, or a per-person exception covers it. An
 * uncounted finding reads as undisposed: its item is adjudicated again, signed, and the blockers and
 * next steps are recomputed without it. Elsewhere the projection is read as recorded. The view never
 * replaces the sealed projection: it keeps it under a symbol, so the integrity check reads the seal.
 */
import { convergenceProjection, findingAdjudication } from '../convergence.mjs';
import { countedRecords, presenceRequires } from './counted.mjs';

const RECORDED = Symbol.for('singularity-flow.convergence-recorded');

/** `record` as counted for `workflow`; `uncountedFindings` names the findings set aside. */
export function countedConvergence(workflow, record) {
  if (!record || !presenceRequires(workflow)) return record;
  const adjudications = (record.findings ?? []).map(findingAdjudication);
  const counts = new Set(countedRecords(workflow, adjudications));
  if (counts.size === adjudications.length) return record;
  const view = convergenceProjection({ workId: record.workId, bindings: record.bindings, facts: record.facts ?? [],
    candidates: record.candidateSnapshot ?? [], candidateRecords: record.candidateRecords ?? [],
    candidateRecordBindings: record.candidateRecordBindings ?? [], legacyMigration: record.legacyMigration ?? null,
    adjudications: adjudications.filter((entry) => counts.has(entry)), settledByPlan: record.settledByPlan ?? null });
  const kept = new Set(view.findings.map((finding) => finding.id));
  const counted = { ...record, findings: view.findings, unresolvedBlockers: view.unresolvedBlockers, allowedNext: view.allowedNext,
    uncountedFindings: (record.findings ?? []).filter((finding) => !kept.has(finding.id)).map((finding) => finding.id) };
  Object.defineProperty(counted, RECORDED, { value: record });
  return counted;
}
