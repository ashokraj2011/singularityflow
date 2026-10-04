/**
 * Load exact-base repository-readiness evidence without running repository commands.
 *
 * Story-start callers already own the verified repository roots and selected base commits. This
 * adapter deliberately projects only receipt identity and policy-relevant outcomes into the pure
 * Story readiness evaluator; machine paths and command argv never cross that boundary.
 */
import {
  buildRepositoryReadinessPlan, inspectRepositoryReadinessReceipt, loadRepositoryTestBaseline,
  recordEmptyRepositoryReadiness, buildEmptyRepositoryReadinessPlan
} from './initialization/runtime-readiness.mjs';
import { head } from './git.mjs';
import {
  assessPreStoryRiskForStoryStart, assessPreStoryTestBaseline,
  listPreStoryTestRiskAcceptances
} from './test-baseline-risk.mjs';

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

function publicFailedBaseline(baseline, assessment, acceptance = null, planCurrent = false) {
  const accepted = Boolean(acceptance);
  const observedFailure = baseline.status === 'failing-tests'
    && (Array.isArray(baseline.testObservations) ? baseline.testObservations : [])
      .some((entry) => entry?.status === 'available' && entry.counts?.failed > 0);
  return Object.freeze({
    status: accepted ? 'accepted-known-failures'
      : observedFailure ? 'failing-tests' : 'readiness-failed',
    reasons: Object.freeze(accepted ? [] : [
      observedFailure ? 'pre-story-tests-failing' : 'pre-story-readiness-incomplete',
      ...(planCurrent ? [] : ['baseline-plan-not-current'])
    ]),
    scope: baseline.scope,
    sourceCommit: baseline.sourceCommit,
    sourceManifestSha256: baseline.sourceManifestSha256,
    planId: baseline.planId,
    baselineSha256: baseline.baselineSha256,
    receiptSha256: null,
    structuredTestContract: Object.freeze({
      status: assessment.eligible ? 'available' : 'unavailable',
      commands: Object.freeze((Array.isArray(baseline.testTools) ? baseline.testTools : [])
        .slice(0, 200).map((tool) => Object.freeze({
        id: tool?.id ?? null, workingDirectory: tool?.workingDirectory ?? null,
        launcher: displayLauncher(tool?.launcher), adapter: tool?.adapter ?? null,
        reportPath: tool?.reportPath ?? null,
        minimumDiscovered: tool?.minimumDiscovered ?? null
      })))
    }),
    riskAssessment: Object.freeze({ eligible: assessment.eligible, planCurrent,
      reasons: Object.freeze([...assessment.reasons,
        ...(planCurrent ? [] : ['baseline-plan-not-current'])]) }),
    riskAcceptance: accepted ? Object.freeze({
      status: 'accepted-known-failures',
      acceptanceSha256: acceptance.acceptanceSha256,
      baselineSha256: acceptance.baselineSha256,
      sourceCommit: acceptance.sourceCommit,
      acceptedAt: acceptance.acceptedAt,
      expiresAt: acceptance.expiresAt
    }) : null,
    testObservations: Object.freeze((Array.isArray(baseline.testObservations)
      ? baseline.testObservations : []).slice(0, 200).map((entry) => Object.freeze({
      commandId: entry?.commandId ?? null, adapter: entry?.adapter ?? null,
      status: entry?.status ?? null,
      counts: entry?.counts ? Object.freeze({ ...entry.counts }) : null,
      failingCases: Object.freeze((Array.isArray(entry?.failingCases) ? entry.failingCases : [])
        .slice(0, 100).map((item) => Object.freeze({
        suite: item?.suite ?? null, className: item?.className ?? null, name: item?.name ?? null,
        fullName: item?.fullName ?? null,
        ancestorTitles: Object.freeze(Array.isArray(item?.ancestorTitles)
          ? item.ancestorTitles.slice(0, 16) : []),
        identityStatus: item?.identityStatus ?? null
      })))
    }))),
    detectedStacks: Object.freeze([]),
    commandResults: Object.freeze((Array.isArray(baseline.commandResults)
      ? baseline.commandResults : []).slice(0, 200).map((entry) => Object.freeze({
      id: entry?.id ?? null, purpose: entry?.purpose ?? null, status: entry?.status ?? null
    })))
  });
}

export async function collectRepositoryReadinessEvidence(repositories = [], {
  scope = 'dependency-test', recordEmpty = false, previewEmpty = false
} = {}) {
  const pairs = await Promise.all(repositories.map(async (entry) => {
    const selectedScope = entry.scope ?? scope;
    let inspection = await inspectRepositoryReadinessReceipt(entry.root, {
      commit: entry.baseCommit,
      scope: selectedScope,
      // A selected remote base need not be the current checkout. The immutable receipt already
      // seals its source-manifest and plan; exact commit/platform/architecture lookup is enough.
      recompute: false
    });
    // A failed rerun on the same Git commit does not erase an earlier passing receipt. The
    // baseline takes precedence until a successful rerun durably writes its receipt and clears
    // the obsolete baseline. A narrow failure also supersedes an older full-scope pass.
    const baselineScopes = selectedScope === 'full'
      ? ['full', 'dependency-test'] : ['dependency-test'];
    const candidates = await Promise.all(baselineScopes.map((candidateScope) =>
      loadRepositoryTestBaseline(entry.root, {
        commit: entry.baseCommit, scope: candidateScope
      })));
    const loaded = candidates.find(Boolean);
    // Only Story start opts in. Preview/status remain read-only, failed baselines are preserved,
    // and no command can run implicitly. Cross-branch no-ops require proven detector equivalence.
    if (recordEmpty && !loaded && inspection.status !== 'pass') {
      try {
        const recorded = await recordEmptyRepositoryReadiness(entry.root, {
          scope: selectedScope, commit: entry.baseCommit
        });
        if (recorded) inspection = await inspectRepositoryReadinessReceipt(entry.root, {
          commit: entry.baseCommit, scope: selectedScope, recompute: false
        });
      } catch { /* Dirty, ambiguous or changed inputs retain the explicit readiness repair route. */ }
    }
    if (!loaded && inspection.status === 'pass') {
      return [entry.id ?? entry.repository, publicReceipt(inspection)];
    }
    if (previewEmpty && !loaded) {
      try {
        const plan = await buildEmptyRepositoryReadinessPlan(entry.root, {
          scope: selectedScope, commit: entry.baseCommit
        });
        if (plan) return [entry.id ?? entry.repository, Object.freeze({
          status: 'no-commands-applicable', sourceCommit: plan.sourceCommit,
          scope: plan.scope, planId: plan.planId, receiptSha256: null,
          detectedStacks: plan.detectedStacks ?? [], structuredTestContract: plan.structuredTestContract,
          commandResults: [], testObservations: []
        })];
      } catch { /* Read-only preview never grants an exception for incomplete or changed inputs. */ }
    }
    // The failing run and the explicit human decision are Git-private. Read only the selected
    // immutable base; a different branch, host, expired decision, or incomplete observation cannot
    // become an accepted Story-start risk.
    if (!loaded) return [entry.id ?? entry.repository, publicReceipt(inspection)];
    const assessment = assessPreStoryTestBaseline(loaded.baseline);
    // Unlike an old passing receipt, a locally accepted failure is a narrow exception. Rebuild
    // its deterministic plan whenever the selected base is checked out: an unchanged Git commit
    // can still be evaluated by a newer runner or detector.
    let currentPlan = null;
    const selectedBaseCheckedOut = head(entry.root) === entry.baseCommit;
    if (assessment.eligible && selectedBaseCheckedOut) {
      try {
        currentPlan = await buildRepositoryReadinessPlan(entry.root, {
          scope: 'dependency-test'
        });
      } catch { /* Preserve the failing evidence, but never activate a stale exception. */ }
    }
    // Remote base selection can happen from another checkout. In that provisional preflight the
    // sealed exact-commit baseline is the available proof; the Story checkout must recompute the
    // plan on the selected base before it writes governed Story state.
    const planCurrent = assessment.eligible && (selectedBaseCheckedOut
      ? currentPlan?.status === 'ready'
        && currentPlan.planId === loaded.baseline.planId
        && currentPlan.sourceCommit === loaded.baseline.sourceCommit
        && currentPlan.sourceManifestSha256 === loaded.baseline.sourceManifestSha256
      : loaded.baseline.sourceCommit === entry.baseCommit);
    const decisions = assessment.eligible && planCurrent
      ? await listPreStoryTestRiskAcceptances(entry.root, loaded.baseline) : [];
    const accepted = decisions.find(({ acceptance }) => assessPreStoryRiskForStoryStart(
      acceptance, loaded.baseline, { baseCommit: entry.baseCommit }
    ).accepted)?.acceptance ?? null;
    return [entry.id ?? entry.repository,
      publicFailedBaseline(loaded.baseline, assessment, accepted, planCurrent)];
  }));
  return Object.freeze({ repositories: Object.freeze(Object.fromEntries(pairs)) });
}

/**
 * A bounded display-only projection of evidence already loaded for the selected Story base.
 * It intentionally omits command argv, host paths and report bytes. An exact-base failed baseline
 * remains a failure; a human decision is displayed separately and never presented as a pass.
 */
export function preflightTestReadiness(repositories = [], evidence = null) {
  const receipts = evidence?.repositories ?? {};
  return Object.freeze({
    schemaVersion: 1,
    repositories: Object.freeze(repositories.map((entry) => {
      const id = entry.id ?? entry.repository;
      const receipt = receipts[id] ?? null;
      const current = ['pass', 'failing-tests', 'accepted-known-failures', 'no-commands-applicable'].includes(receipt?.status)
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
      const allPassed = receipt?.status === 'pass' && current && tools.length > 0
        && tools.every((tool) => tool.status === 'available'
          && Number.isSafeInteger(tool.counts?.discovered) && tool.counts.discovered > 0
          && Number.isSafeInteger(tool.counts?.passed) && tool.counts.passed > 0
          && tool.counts.failed === 0);
      return Object.freeze({
        repository: id,
        baseCommit: entry.baseCommit ?? null,
        status: receipt?.status ?? 'missing',
        scope: receipt?.scope ?? null,
        baselineSha256: current ? receipt?.baselineSha256 ?? null : null,
        riskAcceptanceSha256: current ? receipt?.riskAcceptance?.acceptanceSha256 ?? null : null,
        testToolStatus: current ? receipt.structuredTestContract?.status ?? 'not-checked' : 'not-checked',
        tools: Object.freeze(tools),
        disposition: allPassed ? 'no-observed-pre-story-failures'
          : current && receipt.status === 'accepted-known-failures'
            ? 'accepted-pre-existing-test-failures'
            : current && receipt.status === 'failing-tests'
              ? 'pre-existing-test-failures-require-decision'
          : current && !tools.length ? 'no-test-tool-selected'
            : 'not-verified'
      });
    }))
  });
}
