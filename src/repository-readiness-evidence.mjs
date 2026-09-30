/**
 * Load exact-base repository-readiness evidence without running repository commands.
 *
 * Story-start callers already own the verified repository roots and selected base commits. This
 * adapter deliberately projects only receipt identity and policy-relevant outcomes into the pure
 * Story readiness evaluator; machine paths and command argv never cross that boundary.
 */
import { inspectRepositoryReadinessReceipt } from './initialization/runtime-readiness.mjs';

function displayLauncher(value) {
  if (typeof value !== 'string' || !value) return null;
  // An approved tool may still have been resolved to a machine-specific executable path.
  return value.split(/[\\/]/u).at(-1)?.slice(0, 120) ?? null;
}

function publicReceipt(inspection) {
  const receipt = inspection?.receipt ?? null;
  return Object.freeze({
    status: inspection?.status ?? 'missing',
    reasons: Object.freeze([...(inspection?.reasons ?? [])]),
    scope: receipt?.scope ?? 'full',
    sourceCommit: receipt?.sourceCommit ?? null,
    receiptSha256: receipt?.receiptSha256 ?? null,
    structuredTestContract: receipt?.structuredTestContract ?? null,
    testObservations: Object.freeze((receipt?.testObservations ?? []).map((entry) => Object.freeze({
      commandId: entry.commandId,
      adapter: entry.adapter,
      status: entry.status,
      counts: entry.counts ? Object.freeze({ ...entry.counts }) : null
    }))),
    detectedStacks: Object.freeze([...(receipt?.detectedStacks ?? [])]),
    commandResults: Object.freeze((receipt?.commandResults ?? []).map((entry) => Object.freeze({
      id: entry.id,
      purpose: entry.purpose,
      status: entry.status
    })))
  });
}

export async function collectRepositoryReadinessEvidence(repositories = [], {
  scope = 'dependency-test'
} = {}) {
  const pairs = await Promise.all(repositories.map(async (entry) => {
    const inspection = await inspectRepositoryReadinessReceipt(entry.root, {
      commit: entry.baseCommit,
      scope: entry.scope ?? scope,
      // A selected remote base need not be the current checkout. The immutable receipt already
      // seals its source-manifest and plan; exact commit/platform/architecture lookup is enough.
      recompute: false
    });
    return [entry.id ?? entry.repository, publicReceipt(inspection)];
  }));
  return Object.freeze({ repositories: Object.freeze(Object.fromEntries(pairs)) });
}

/**
 * A bounded display-only projection of evidence already loaded for the selected Story base.
 * It intentionally omits command argv, host paths, reports and acceptance records. In
 * particular, a missing passing receipt is not evidence that tests passed or failed.
 */
export function preflightTestReadiness(repositories = [], evidence = null) {
  const receipts = evidence?.repositories ?? {};
  return Object.freeze({
    schemaVersion: 1,
    repositories: Object.freeze(repositories.map((entry) => {
      const id = entry.id ?? entry.repository;
      const receipt = receipts[id] ?? null;
      const current = receipt?.status === 'pass'
        && receipt.sourceCommit === entry.baseCommit;
      // An old or stale receipt may describe a different test runner. Do not label its commands
      // as tools checked for this selected base merely because the receipt file was discoverable.
      const commands = current ? receipt.structuredTestContract?.commands ?? [] : [];
      const observations = current ? receipt.testObservations ?? [] : [];
      const tools = commands.map((command) => {
        const observation = observations.find((result) => result.commandId === command.id);
        return Object.freeze({
          id: command.id,
          launcher: displayLauncher(command.launcher),
          adapter: command.adapter ?? null,
          status: observation?.status ?? 'not-observed',
          counts: observation?.status === 'available' ? Object.freeze({
            discovered: observation.counts?.discovered ?? null,
            passed: observation.counts?.passed ?? null,
            failed: observation.counts?.failed ?? null,
            skipped: observation.counts?.skipped ?? null
          }) : null
        });
      });
      const allPassed = current && tools.length > 0
        && tools.every((tool) => tool.status === 'available'
          && Number.isSafeInteger(tool.counts?.discovered) && tool.counts.discovered > 0
          && Number.isSafeInteger(tool.counts?.passed) && tool.counts.passed > 0
          && tool.counts.failed === 0);
      return Object.freeze({
        repository: id,
        baseCommit: entry.baseCommit ?? null,
        status: receipt?.status ?? 'missing',
        scope: receipt?.scope ?? null,
        testToolStatus: current ? receipt.structuredTestContract?.status ?? 'not-checked' : 'not-checked',
        tools: Object.freeze(tools),
        disposition: allPassed ? 'no-observed-pre-story-failures'
          : current && !tools.length ? 'no-test-tool-selected'
            : 'not-verified'
      });
    }))
  });
}
