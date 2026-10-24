/**
 * `build.read`: recent builds from the configured read-only provider, related to HEAD exactly.
 * `[INT:IFC-041]` `[INT:CON-093]` `[INT:REQ-153]`
 *
 * A reachability expansion with the same safety class as every other automatic read (§13 lists
 * `build.read`): it reads one provider through its own authentication and changes nothing. An
 * unconfigured provider is an informational gap, not an empty list of builds.
 */
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';

export async function buildRead({ arguments: args = {}, subject = null, root = null, context = {}, env = process.env, runs = null } = {}) {
  if (!root) throw new SingularityFlowError('build.read requires the repository root it should read.', { code: 'BUILD_READ_NO_ROOT' });
  const [{ buildBoundary, buildRelation, readBuilds }, { typedMergeBase, typedRevision }] = await Promise.all([
    import('../build-provenance.mjs'), import('../../git-access.mjs')
  ]);
  const read = await readBuilds(root, { repositoryId: context.repositoryId ?? null, branch: args.branch ?? null, limit: args.limit ?? 30, env, runs });
  const head = typedRevision(root, 'HEAD');
  const isAncestor = (older, newer) => typedMergeBase(root, older, newer) === older;
  const builds = read.builds.map((build) => ({ ...build, ...(head ? buildRelation(build, head, { isAncestor }) : { relation: 'mapping-unavailable', language: 'mapping unavailable' }) }));
  return sflowResult({
    kind: 'read',
    operation: { id: 'build.read', classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { builds: String(builds.length) } },
    effects: noEffects(),
    why: [{ code: 'build.from-provider', source: read.gap ? 'unavailable' : 'provider', reference: read.provider, slots: { count: String(builds.length) } }],
    warnings: read.gap ? [{ code: 'impact.evidence-gap', source: 'unavailable', slots: { field: read.gap } }] : [],
    restState: 'informational',
    data: { provider: read.provider, head, builds, boundary: buildBoundary(builds), gap: read.gap ?? null }
  });
}
