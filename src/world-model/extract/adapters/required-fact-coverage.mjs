import { implementationSha256, result, unavailableDraft } from './common.mjs';
import { compareText } from '../../canonicalize.mjs';

export const REQUIRED_FACT_COVERAGE_ID = 'required-fact-coverage';
export const REQUIRED_FACT_COVERAGE_VERSION = '1.0.0';
export const REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256 = implementationSha256(
  REQUIRED_FACT_COVERAGE_ID,
  REQUIRED_FACT_COVERAGE_VERSION,
  'register-typed-unavailable-for-unsatisfied-view-fact-requirements-v1'
);

export function extractRequiredFactCoverage({ viewContracts = [], existingFacts = [] } = {}) {
  const facts = [];
  for (const view of [...viewContracts].sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`))) {
    const present = new Set(existingFacts.map((fact) => fact.factType));
    const required = [...new Set([
      ...view.factPolicy.requiredFactTypes,
      ...view.factPolicy.requiredUnavailableSubjects
    ])].sort();
    for (const factType of required) {
      const explicitlyUnavailable = view.factPolicy.requiredUnavailableSubjects.includes(factType);
      if (!explicitlyUnavailable && present.has(factType)) continue;
      if (explicitlyUnavailable && existingFacts.some((fact) => fact.factType === factType && fact.status === 'unavailable')) continue;
      facts.push(unavailableDraft({
        factType,
        subject: { kind: 'analysis', id: `${view.id}@${view.version}:${factType}` },
        attemptedProducer: REQUIRED_FACT_COVERAGE_ID,
        code: factType === 'runtime-frequency' || factType === 'runtime-guarantee'
          ? 'NO_RUNTIME_EVIDENCE'
          : 'NO_REGISTERED_PRODUCER',
        detail: `No registered deterministic producer supplied ${factType} for ${view.id}@${view.version} within the pinned scope.`
      }));
    }
  }
  return result(REQUIRED_FACT_COVERAGE_ID, [], facts);
}
