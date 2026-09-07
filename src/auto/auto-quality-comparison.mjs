/** Privacy-safe, content-free linkage between one Auto report and an approved IMP comparison. */
import { recordSha256 } from '../records.mjs';
import { classifyTokenOptimization } from '../token-economy.mjs';
import { SingularityFlowError } from '../util.mjs';

const TOKEN_FIELDS = Object.freeze({
  'input-tokens': 'inputTokens',
  'output-tokens': 'outputTokens',
  'cached-input-tokens': 'cachedInputTokens',
  'total-tokens': 'totalTokens'
});

function refuse(message, code, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function receiptCohortKey(receipt, dimensions) {
  const values = {
    capability: receipt.subject.capability,
    'repository-class': receipt.subject.repositoryClass,
    'work-type': receipt.subject.workType,
    complexity: receipt.subject.complexity,
    risk: receipt.subject.risk,
    'time-period': receipt.subject.timePeriod
  };
  return dimensions.map((dimension) => `${dimension}=${values[dimension] ?? 'unknown'}`).join('|');
}

function exactReceiptTokenEvidence(receipt, metricId) {
  const field = TOKEN_FIELDS[metricId];
  const metric = receipt.metrics?.[metricId];
  const models = receipt.economics?.models;
  return Boolean(field && metric?.status === 'exact' && metric.assurance === 'kernel-derived'
    && Array.isArray(models) && models.length
    && models.every((entry) => entry.provider && entry.model && Number.isFinite(entry[field]))
    && models.reduce((total, entry) => total + entry[field], 0) === metric.value);
}

/**
 * Build a read-only comparison projection. The immutable Auto report and IMP receipts remain the
 * authorities; this projection never writes either one and never turns one flight into a cohort.
 */
export function buildAutoQualityComparison({
  report, study, configurationSha256, receipts, comparison
}) {
  if (report?.kind !== 'auto-flight-report' || !report.flightId || !report.reportSha256
      || !report.story?.workId) {
    refuse('Auto quality comparison requires an exact Auto flight report.',
      'AUTO_COMPARISON_REPORT_INVALID');
  }
  if (!study || study.id !== comparison?.study
      || comparison.studyConfigurationSha256 !== configurationSha256) {
    refuse('Auto quality comparison is not bound to the current approved Impact study.',
      'AUTO_COMPARISON_STUDY_STALE', {
        studyId: study?.id ?? null, configurationSha256: configurationSha256 ?? null
      });
  }
  const baseline = study.groups?.find((group) => group.assistanceMode === 'baseline');
  const treatment = study.groups?.find((group) => group.assistanceMode === 'governed-agent');
  if (!baseline || !treatment || baseline.id === treatment.id) {
    refuse(
      `Impact study '${study.id}' must have distinct baseline and governed-agent groups before it can evaluate Auto.`,
      'AUTO_COMPARISON_STUDY_INCOMPATIBLE', { studyId: study.id }
    );
  }
  const candidates = (receipts ?? []).filter((receipt) => (
    receipt.status === 'finalized'
    && receipt.subject?.workId === report.story.workId
    && receipt.study?.id === study.id
    && receipt.study?.configurationSha256 === configurationSha256
  ));
  if (candidates.length !== 1) {
    refuse(
      candidates.length
        ? `Auto Story '${report.story.workId}' has multiple finalized receipts for Impact study '${study.id}'.`
        : `Auto Story '${report.story.workId}' has no finalized receipt for the current revision of Impact study '${study.id}'.`,
      'AUTO_COMPARISON_RECEIPT_UNAVAILABLE', {
        flightId: report.flightId, studyId: study.id, receipts: candidates.length,
        nextAction: `Finalize and verify the Story Impact receipt, then rerun auto compare ${report.flightId} --study ${study.id}.`
      }
    );
  }
  const receipt = candidates[0];
  if (receipt.study.groupId !== treatment.id
      || receipt.assistance?.planned !== 'governed-agent'
      || receipt.assistance?.actual !== 'governed-agent') {
    refuse(
      `Auto Story '${report.story.workId}' is not an observed governed-agent treatment in Impact study '${study.id}'.`,
      'AUTO_COMPARISON_TREATMENT_UNPROVEN', {
        expectedGroup: treatment.id, actualGroup: receipt.study.groupId ?? null,
        plannedAssistance: receipt.assistance?.planned ?? null,
        actualAssistance: receipt.assistance?.actual ?? null
      }
    );
  }
  const receiptRevision = receipt.subject?.subjectRevision?.commit ?? null;
  if (!report.lastSuccessfulStoryRevision || receiptRevision !== report.lastSuccessfulStoryRevision
      || receipt.publication?.subjectCommit !== report.lastSuccessfulStoryRevision) {
    refuse(
      `Auto Story '${report.story.workId}' Impact evidence is not bound to the report's final Story revision.`,
      'AUTO_COMPARISON_REVISION_MISMATCH', {
        reportRevision: report.lastSuccessfulStoryRevision ?? null,
        receiptRevision, publicationRevision: receipt.publication?.subjectCommit ?? null
      }
    );
  }
  const stratum = receiptCohortKey(receipt, study.matching.dimensions);
  const matchedStrata = comparison.result?.effectsByStratum ?? [];
  if (!matchedStrata.some((entry) => entry.key === stratum)
      || !exactReceiptTokenEvidence(receipt, comparison.primaryMetric?.id)) {
    refuse(
      `Auto Story '${report.story.workId}' is not a usable exact-token member of the matched treatment cohort.`,
      'AUTO_COMPARISON_TREATMENT_EVIDENCE_INCOMPLETE', {
        studyId: study.id, matchedStratum: matchedStrata.some((entry) => entry.key === stratum),
        exactProviderTokenEvidence: exactReceiptTokenEvidence(
          receipt, comparison.primaryMetric?.id
        )
      }
    );
  }
  const classification = classifyTokenOptimization(comparison);
  const core = {
    schemaVersion: 1, // schema-transient: read-only projection; no durable writer.
    kind: 'auto-quality-comparison', contentFree: true,
    flight: {
      flightId: report.flightId, reportSha256: report.reportSha256,
      workId: report.story.workId, subjectRevision: report.lastSuccessfulStoryRevision
    },
    study: {
      id: study.id, configurationSha256,
      definitionSha256: study.definitionSha256 ?? null,
      baselineGroup: baseline.id, treatmentGroup: treatment.id,
      treatmentReceiptSha256: receipt.integrity?.sha256 ?? null
    },
    cohorts: {
      matchedBaseline: comparison.cohorts.matchedBaseline,
      matchedTreatment: comparison.cohorts.matchedTreatment,
      privacyFloor: comparison.cohorts.privacyFloor,
      evidenceGrade: comparison.evidenceGrade
    },
    tokenMetric: {
      id: comparison.primaryMetric.id, unit: comparison.primaryMetric.unit,
      gainPercent: comparison.result.gainPercent,
      providerTokenEvidence: comparison.measurementAssurance?.primary?.providerTokenEvidence === true
    },
    quality: {
      gatePassed: comparison.qualityGatePassed === true,
      guardrails: comparison.guardrails.map((guardrail) => ({
        metric: guardrail.metric, passed: guardrail.passed,
        maximumRegressionPercent: guardrail.maximumRegressionPercent
      }))
    },
    classification
  };
  return Object.freeze({
    ...core, comparisonSha256: `sha256:${recordSha256(core)}`
  });
}
