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
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../specifications.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { relayFacts, relayRequest, validateInterpretation } from '../assisted-relay.mjs';
import { noEffects, plannerNavigation, preservedAll, repositoryReference, sflowResult } from '../result.mjs';
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
 * and branch logic uses — so `paths` are relative to the workspace (`repos/<id>/...`). No inference
 * from names: a directory called `payments` in a repository that declares no payments capability is
 * not a payments change.
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

/**
 * The workspace repository `root` is a checkout of, as `{ id, capabilities }`, or null.
 *
 * Hosts name the workspace by ID alone, so its manifest is read here: the registry entries with that
 * ID, and the member `root` belongs to by Git identity, never by path. The declared clone, a linked
 * Story worktree of it (one Git common directory) and a recorded branch checkout are members exactly
 * as workspace membership decides elsewhere; failing those, a second clone is the member whose
 * declared remote has the same comparison key as its origin. Local files and `git config` only.
 */
async function workspaceRepositoryOf(root, workspaceId, env) {
  if (!workspaceId) return null;
  const [{ readWorkspace, readWorkspaceRegistry }, { workspaceRegistryFile }, { findWorkspaceMembership },
    { configuredRemoteIdentity }, { resolvedGitRepositoryComparisonKey }] = await Promise.all([
    import('../../workspace-manifest.mjs'), import('../../workspace-context.mjs'), import('../../workspace-membership.mjs'),
    import('../../git-remote-diagnostics.mjs'), import('../../git-repository-identity.mjs')
  ]);
  const entries = await readWorkspaceRegistry(workspaceRegistryFile(env)).catch(() => []);
  let origin;
  for (const entry of entries.filter((candidate) => candidate.id === workspaceId && !candidate.archivedAt)) {
    // Membership throws on an unreadable manifest and on an origin not spelled exactly as declared;
    // the comparison key below still recognises a respelled one.
    const member = await findWorkspaceMembership(root, { workspacePath: entry.path }).catch(() => null);
    if (member) return { id: member.repositoryId, capabilities: [...member.repositoryCapabilities] };
    const workspace = await readWorkspace(entry.path).catch(() => null);
    if (!workspace) continue;
    if (origin === undefined) {
      try { origin = await resolvedGitRepositoryComparisonKey(configuredRemoteIdentity(root, 'origin', { env }).url); }
      catch { origin = null; }
    }
    if (!origin) return null;
    const matches = [];
    for (const [id, repository] of Object.entries(workspace.repositories)) {
      if (await resolvedGitRepositoryComparisonKey(repository.url) !== origin) continue;
      matches.push({ id, capabilities: [...repository.capabilities] });
    }
    // Two members declaring one remote cannot say which of them this clone is.
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/**
 * The capabilities a change in `root` touches, or null when they cannot be known.
 *
 * Changed paths are relative to `root`, so every one of them is that repository's and its declared
 * capabilities are the ones touched: the repository-level reading `affectedCapabilities` gives, not
 * path-level ownership. A context that carries the manifest itself names paths in the workspace's
 * frame and is matched as it always was.
 */
async function changedCapabilities(root, context, paths, env) {
  if (context.workspace?.repositories) return affectedCapabilities(context.workspace, paths);
  if (!paths.length) return [];
  const repository = await workspaceRepositoryOf(root, context.workspace?.id ?? null, env);
  if (!repository) return null;
  return repository.capabilities.sort().map((capability) => ({ capability, repositories: [repository.id] }));
}

export function impactQuickResult({
  baseRef, targetRef, paths, capabilities, activeWork, includeWorktree, subject = null, repositoryScope = null,
  revisions = { baseline: null, target: null }, owners = null, builds = null, gaps = [...IMPACT_EVIDENCE_GAPS],
  generatedAt = null, policyHash = null, registryHash = null, operationId = 'impact.quick', assisted = null
} = {}) {
  const tests = paths.filter((file) => TEST_PATH.test(file));
  // Every deterministic fact gets a stable ID: an assisted interpretation may cite them, never edit them.
  const facts = relayFacts([
    ...paths.map((file) => ({ kind: 'changed-path', statement: file })),
    ...capabilities.map((entry) => ({ kind: 'capability', statement: `${entry.capability} (${entry.repositories.join(', ')})` })),
    ...(owners ?? []).map((entry) => ({ kind: 'owner', statement: `${entry.path}: ${entry.owners.join(' ')}` })),
    ...activeWork.map((item) => ({ kind: 'active-work', statement: `${item.id} ${item.phase ?? ''}`.trim() })),
    ...(builds?.associations ?? []).map((entry) => ({ kind: 'build', statement: `${entry.buildId} ${entry.language}` }))
  ]);
  const evidenceHandle = `sha256:${createHash('sha256').update(canonicalJson(facts)).digest('hex')}`;

  return sflowResult({
    kind: 'read',
    operation: { id: operationId, classification: 'read' },
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
      ...gaps.map((field) => ({ code: 'impact.evidence-gap', source: 'unavailable', slots: { field } })),
      { code: 'impact.tests-by-path-convention', source: 'deterministic', slots: { matched: String(tests.length) } },
      ...(assisted && !assisted.accepted?.length ? [{ code: 'impact.assistance-not-invoked', source: 'unavailable', slots: {} }] : [])
    ],
    next: [...activeWork.map((item, index) => plannerNavigation({
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
    }, 'work.continue', { workId: item.id })),
    /**
     * `[INT:REQ-075]`: a finding may seed governed work, through its own reviewed start plan. This
     * opens the intake with the finding as its source; nothing is created until that plan is
     * confirmed.
     */
    ...(paths.length ? [plannerNavigation({
      handle: 'impact:start-from-finding', id: 'impact:start-from-finding', label: 'Start a Story from this change',
      rank: activeWork.length, kind: 'read', reasonCode: 'impact.start-reviewed-plan', confirmation: 'none',
      interaction: 'navigation', emphasis: 'link', executable: false,
      fallback: { label: 'Start in the terminal', command: 'sflow start <WORK-ID>' }
    }, 'work.start.intake', { source: 'finding', summary: `Change ${revisions.baseline ?? baseRef ?? 'HEAD'}..${revisions.target ?? targetRef ?? 'worktree'}: ${paths.length} path(s)` })] : []),
    /**
     * The full Impact Analysis view, as a host action. `[INT:IFC-061]` `[INT:CON-130]`
     *
     * Offered whatever this range found, because the view reads more than changed paths. Opening a
     * view, nothing more: the kernel withholds it from a host that cannot open one, and the terminal
     * command beside it is the same answer for a host without views `[INT:REQ-130]`.
     */
    {
      handle: 'host-action:impact', id: 'impact:open-view', label: 'Open Impact Analysis',
      rank: activeWork.length + (paths.length ? 1 : 0), kind: 'host-action', reasonCode: 'impact.open-impact-view',
      confirmation: 'none', interaction: 'navigation', emphasis: 'link', executable: false,
      hostAction: { id: 'vscode.openImpact', arguments: {} },
      fallback: { label: 'Show the impact in the terminal', command: 'sflow impact' }
    }],
    restState: activeWork.length || paths.length ? null : 'informational',
    data: {
      // `[INT:IFC-031]`: the report names exactly what it was computed from.
      baseline: baseRef ?? 'HEAD',
      target: targetRef ?? (includeWorktree ? 'worktree' : 'HEAD'),
      revisions,
      includeWorktree: Boolean(includeWorktree),
      repositoryScope,
      binding: { registryHash, policyHash, evidenceHandle, generatedAt },
      facts,
      owners,
      builds: builds ?? { provider: null, associations: [] },
      affected: {
        paths,
        capabilities,
        repositories: [...new Set(capabilities.flatMap((entry) => entry.repositories))].sort(),
        testsByConvention: tests,
        activeWork: activeWork.map((item) => ({ id: item.id, title: item.title, phase: item.phase, group: item.group }))
      },
      evidenceGaps: [...gaps],
      // Never a verdict about whether anything is broken `[INT:REQ-074]`.
      semanticImpact: null,
      ...(assisted ? { assisted } : {})
    }
  });
}

/** CODEOWNERS at a revision, as path → owners, last matching rule winning like the forge does. */
export function ownersOf(text, paths) {
  const rules = String(text ?? '').split(/\r?\n/u).map((line) => line.replace(/#.*$/u, '').trim()).filter(Boolean)
    .map((line) => line.split(/\s+/u)).filter(([pattern, ...owners]) => pattern && owners.length)
    .map(([pattern, ...owners]) => ({ owners, test: codeownersPattern(pattern) }));
  return paths.map((file) => {
    const rule = [...rules].reverse().find((entry) => entry.test(file));
    return rule ? { path: file, owners: rule.owners } : null;
  }).filter(Boolean);
}

function codeownersPattern(pattern) {
  const anchored = pattern.startsWith('/');
  const body = pattern.replace(/^\//u, '').replace(/\/$/u, '/**');
  const source = body.split('/').map((part) => part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')).join('/');
  const expression = new RegExp(`${anchored || body.includes('/') ? '^' : '(^|/)'}${source}(/.*)?$`, 'u');
  return (file) => expression.test(file);
}

function refusal(code, slots) {
  return sflowResult({
    kind: 'refusal', operation: { id: 'impact.quick', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots }, effects: noEffects(),
    why: [{ code, source: 'deterministic', slots }], preserved: preservedAll('gateway.nothing-was-carried-out'), restState: 'blocked'
  });
}

/**
 * The deterministic fact set for a change. `[INT:REQ-073]` `[INT:REQ-074]`
 *
 * Changed paths come from the exact baseline and target commits (or the tracked working tree);
 * owners from CODEOWNERS at the target; builds from the configured read-only provider, related to
 * the target only through exact provenance. Every source that could not be read stays a named gap.
 */
async function deterministicImpact({ arguments: args = {}, subject = null, root = null, context = {}, env = process.env,
  now = () => new Date(), runs = null } = {}) {
  if (!root) throw new SingularityFlowError('impact.quick requires the repository root it should read.', { code: 'IMPACT_QUICK_NO_ROOT' });
  let paths;
  let revisions = { baseline: null, target: null };
  let owners = null;
  const gaps = IMPACT_EVIDENCE_GAPS.filter((gap) => gap !== 'build-provenance');
  if (context.changedPaths) {
    paths = context.changedPaths.slice().sort();
  } else {
    const { typedChangedPaths, typedFileText, typedRevision } = await import('../../git-access.mjs');
    const baseline = typedRevision(root, args.baseRef ?? 'HEAD');
    if (!baseline) return refusal('impact.revision-unresolved', { side: 'baseline', revision: args.baseRef ?? 'HEAD' });
    const target = args.targetRef ? typedRevision(root, args.targetRef) : null;
    if (args.targetRef && !target) return refusal('impact.revision-unresolved', { side: 'target', revision: args.targetRef });
    revisions = { baseline, target: target ?? (args.includeWorktree ? 'worktree' : baseline) };
    paths = target || args.includeWorktree ? typedChangedPaths(root, baseline, target, { max: 2000 }).entries.map((entry) => entry.path) : [];
    const ownersText = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']
      .map((file) => typedFileText(root, target ?? baseline, file)).find((text) => text != null) ?? null;
    owners = ownersText == null ? null : ownersOf(ownersText, paths);
  }
  if (owners == null) gaps.push('ownership');
  const { buildRelation, gitAncestry, readBuilds } = await import('../build-provenance.mjs');
  const read = await readBuilds(root, { repositoryId: context.repositoryId ?? null, env, now, runs });
  let builds = { provider: read.provider, associations: [] };
  if (read.gap) gaps.push('build-provenance');
  else if (revisions.target && revisions.target !== 'worktree') {
    const isAncestor = await gitAncestry(root);
    builds = { provider: read.provider, associations: read.builds.slice(0, 20).map((build) => ({
      buildId: build.buildId, pipeline: build.pipeline, sourceCommit: build.sourceCommit, result: build.result,
      providerReference: build.providerReference, ...buildRelation(build, revisions.target, { isAncestor })
    })) };
  }
  const changed = await changedCapabilities(root, context, paths, env);
  // No workspace, or no member `root` is a checkout of: a named gap, never "no capabilities touched".
  if (changed == null) gaps.push('capability-map');
  const capabilities = changed ?? [];
  // Work in the same area, from records rather than from proximity.
  const records = await workRecords(root, context);
  const touched = new Set(capabilities.map((entry) => entry.capability));
  const activeWork = records.items.filter((item) => !item.capabilityId || touched.has(item.capabilityId));
  return {
    baseRef: args.baseRef ?? null, targetRef: args.targetRef ?? null, includeWorktree: args.includeWorktree ?? false,
    paths, capabilities, activeWork, subject, repositoryScope: context.repositoryId ?? repositoryReference(root), revisions, owners, builds, gaps,
    generatedAt: now().toISOString(), policyHash: subject?.revision?.policyHash ?? null, registryHash: subject?.revision?.registryHash ?? null
  };
}

export async function impactQuick(input = {}) {
  const facts = await deterministicImpact(input);
  return facts.kind ? facts : impactQuickResult(facts);
}

/**
 * `impact.quick.assisted`: the same fact set, and the relay for a host model to interpret it.
 * `[INT:CON-069]`
 *
 * Without an interpretation it returns the deterministic facts and a relay request — the facts with
 * stable IDs and the only response shape that will be accepted. With one, it validates the answer
 * against the facts as they are now: interpretations that cite real facts are labelled assisted
 * and returned beside them; anything that tries to add, remove or reclassify a fact is refused, and
 * the facts are the deterministic ones whatever came back.
 */
export async function impactQuickAssisted(input = {}) {
  const { interpretation = null, ...args } = input.arguments ?? {};
  const facts = await deterministicImpact({ ...input, arguments: args });
  if (facts.kind) return facts;
  const draft = impactQuickResult({ ...facts, operationId: 'impact.quick.assisted' });
  const request = relayRequest('impact.quick.assisted', draft.data.facts);
  const assisted = interpretation
    ? { requested: true, invoked: 'host-relay', ...validateInterpretation(request, interpretation) }
    : { requested: true, invoked: false, relay: request };
  return impactQuickResult({ ...facts, operationId: 'impact.quick.assisted', assisted });
}
