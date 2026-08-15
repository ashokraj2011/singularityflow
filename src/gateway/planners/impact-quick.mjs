/**
 * `impact.quick`: deterministic facts first, and only facts. `[INT:REQ-073]` `[INT:REQ-074]` `[INT:CON-070]`
 *
 * Read-only, model-free, and bounded by what the changed paths can actually prove. The rule that
 * shapes everything here is `[INT:REQ-074]`: report affected repositories, capabilities, clauses,
 * tests, owners, active work and build associations **without claiming semantic impact it cannot
 * prove**. A path changed under `src/checkout/` is evidence that the checkout capability is
 * involved. It is not evidence that checkout is broken, and the difference is the whole report.
 *
 * So there are two lists and they never merge. `affected` is what the evidence supports.
 * `evidenceGaps` is what could not be computed — and build provenance lives there permanently
 * until the provider adapters exist `[INT:REQ-153]`, because a missing input reported as an empty
 * result is indistinguishable from a clean one.
 */
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';
import { workRecords } from '../work-records.mjs';

/** Everything §8.5 asks for that changed paths alone cannot answer. Named, so the absence is visible. */
export const IMPACT_EVIDENCE_GAPS = Object.freeze([
  'build-provenance', 'dependency-graph', 'interface-signatures', 'test-bindings', 'release-associations'
]);

/** A path is a test when the repository says so by convention. Reported as a heuristic, not a fact. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//i;

/**
 * Which declared capabilities a changed path touches.
 *
 * Prefix matching against the workspace manifest's own repository paths — the same map the clone
 * and branch logic uses. No inference from names: a directory called `payments` in a repository
 * that declares no payments capability is not a payments change.
 */
export function affectedCapabilities(workspace, paths) {
  const repositories = Object.values(workspace?.repositories ?? {});
  const hits = new Map();
  for (const repository of repositories) {
    const prefix = String(repository.path ?? '').replace(/\/+$/, '');
    if (!prefix) continue;
    const touched = paths.filter((file) => file === prefix || file.startsWith(`${prefix}/`));
    if (!touched.length) continue;
    for (const capability of repository.capabilities ?? []) {
      hits.set(capability, [...new Set([...(hits.get(capability) ?? []), repository.id])]);
    }
  }
  return [...hits.entries()]
    .map(([capability, repositoryIds]) => ({ capability, repositories: repositoryIds.sort() }))
    .sort((left, right) => left.capability.localeCompare(right.capability));
}

export function impactQuickResult({
  baseRef, targetRef, paths, capabilities, activeWork, includeWorktree, subject = null, repositoryScope = null
} = {}) {
  const tests = paths.filter((file) => TEST_PATH.test(file));

  return sflowResult({
    kind: 'read',
    operation: { id: 'impact.quick', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.read',
      slots: { paths: paths.length, capabilities: capabilities.length, work: activeWork.length }
    },
    // `[INT:CON-070]`: read-only. No work created, no claim modified, no Jira, no CI, no phase moved.
    effects: noEffects(),
    why: [{
      code: 'impact.from-changed-paths',
      source: 'deterministic',
      reference: repositoryScope,
      slots: { base: baseRef ?? 'HEAD', target: targetRef ?? 'worktree', count: String(paths.length) }
    }],
    /**
     * Gaps are warnings, not omissions, and the heuristic is labelled as one.
     *
     * A reader who sees "0 tests affected" and a reader who sees "test bindings were not read" make
     * different decisions, and only one of them is entitled to relax.
     */
    warnings: [
      ...IMPACT_EVIDENCE_GAPS.map((field) => ({ code: 'impact.evidence-gap', source: 'unavailable', slots: { field } })),
      { code: 'impact.tests-by-path-convention', source: 'deterministic', slots: { matched: String(tests.length) } }
    ],
    next: activeWork.map((item, index) => ({
      handle: `impact:work:${item.id}`,
      id: `impact:work:${item.id}`,
      label: item.title,
      rank: index,
      kind: 'read',
      reasonCode: 'impact.work-in-the-same-area',
      confirmation: 'none',
      interaction: 'navigation',
      /**
       * `[INT:REQ-075]`: starting work from a finding is a separate reviewed plan. Nothing here is
       * a shortcut into creating one.
       */
      executable: false,
      fallback: { label: 'See this work', command: `sflow status --work-id ${item.id}` }
    })),
    restState: activeWork.length ? null : 'informational',
    data: {
      // `[INT:IFC-031]`: the report names exactly what it was computed from.
      baseline: baseRef ?? 'HEAD',
      target: targetRef ?? (includeWorktree ? 'worktree' : 'HEAD'),
      includeWorktree: Boolean(includeWorktree),
      repositoryScope,
      affected: {
        paths,
        capabilities,
        repositories: [...new Set(capabilities.flatMap((entry) => entry.repositories))].sort(),
        testsByConvention: tests,
        activeWork: activeWork.map((item) => ({ id: item.id, title: item.title, phase: item.phase, group: item.group }))
      },
      evidenceGaps: [...IMPACT_EVIDENCE_GAPS],
      // Never a verdict about whether anything is broken `[INT:REQ-074]`.
      semanticImpact: null
    }
  });
}

export async function impactQuick({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) throw new SingularityFlowError('impact.quick requires the repository root it should read.', { code: 'IMPACT_QUICK_NO_ROOT' });
  const paths = (context.changedPaths ?? []).slice().sort();
  const capabilities = affectedCapabilities(context.workspace, paths);

  /**
   * Work in the same area, from records rather than from proximity.
   *
   * An item is listed when its capability is one the change touches. Listing everything currently
   * open would be the easier query and would make the report useless the first time a team had ten
   * things in flight.
   */
  const records = await workRecords(root, context);
  const touched = new Set(capabilities.map((entry) => entry.capability));
  const activeWork = records.items.filter((item) => !item.capabilityId || touched.has(item.capabilityId));

  return impactQuickResult({
    baseRef: args.baseRef ?? null,
    targetRef: args.targetRef ?? null,
    includeWorktree: args.includeWorktree ?? false,
    paths,
    capabilities,
    activeWork,
    subject,
    repositoryScope: root
  });
}
