/**
 * Load exact-base repository-readiness evidence without running repository commands.
 *
 * Story-start callers already own the verified repository roots and selected base commits. This
 * adapter deliberately projects only receipt identity and policy-relevant outcomes into the pure
 * Story readiness evaluator; machine paths and command argv never cross that boundary.
 */
import { inspectRepositoryReadinessReceipt } from './initialization/runtime-readiness.mjs';

function publicReceipt(inspection) {
  const receipt = inspection?.receipt ?? null;
  return Object.freeze({
    status: inspection?.status ?? 'missing',
    reasons: Object.freeze([...(inspection?.reasons ?? [])]),
    sourceCommit: receipt?.sourceCommit ?? null,
    receiptSha256: receipt?.receiptSha256 ?? null,
    structuredTestContract: receipt?.structuredTestContract ?? null,
    detectedStacks: Object.freeze([...(receipt?.detectedStacks ?? [])]),
    commandResults: Object.freeze((receipt?.commandResults ?? []).map((entry) => Object.freeze({
      id: entry.id,
      purpose: entry.purpose,
      status: entry.status
    })))
  });
}

export async function collectRepositoryReadinessEvidence(repositories = []) {
  const pairs = await Promise.all(repositories.map(async (entry) => {
    const inspection = await inspectRepositoryReadinessReceipt(entry.root, {
      commit: entry.baseCommit,
      // A selected remote base need not be the current checkout. The immutable receipt already
      // seals its source-manifest and plan; exact commit/platform/architecture lookup is enough.
      recompute: false
    });
    return [entry.id ?? entry.repository, publicReceipt(inspection)];
  }));
  return Object.freeze({ repositories: Object.freeze(Object.fromEntries(pairs)) });
}
