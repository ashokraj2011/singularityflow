/** Model-free, resource-level intent trace over the exact current repository change set. */
import { buildChangeRegionManifest } from '../../comprehension/contracts.mjs';
import { buildRepositoryChangeSet } from '../../repository-change-set.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';

function repositoryMatches(root, requested, context) {
  const known = new Set([
    root,
    context.repositoryId,
    context.repository?.id,
    context.repository?.name
  ].filter(Boolean).map(String));
  return known.has(String(requested));
}

function refusal(subject, repositoryId) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'intent.trace', classification: 'read' },
    subject,
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: { repository: repositoryId } },
    effects: noEffects(),
    why: [{
      code: 'intent.trace.wrong-repository', source: 'deterministic',
      slots: { repository: repositoryId }
    }],
    preserved: preservedAll('intent.trace.nothing-was-carried-out', { reference: repositoryId }),
    restState: 'blocked'
  });
}

export async function intentTracePlanner({
  root = null,
  arguments: args = {},
  subject = null,
  context = {}
} = {}) {
  if (!root) throw new SingularityFlowError('intent.trace requires the repository root it should read.', {
    code: 'INTENT_TRACE_NO_ROOT'
  });
  if (!repositoryMatches(root, args.repositoryId, context)) {
    return refusal(subject, args.repositoryId);
  }
  if (args.lineStart != null && args.lineEnd != null && args.lineEnd < args.lineStart) {
    throw new SingularityFlowError('intent.trace lineEnd must be greater than or equal to lineStart.', {
      code: 'INVALID_OPERATION_ARGUMENT'
    });
  }
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: 'HEAD',
    subject: { kind: 'gateway-intent-trace', path: args.path }
  });
  const manifest = buildChangeRegionManifest(changeSet);
  const regions = manifest.regions.filter((region) =>
    region.location.pathAfter === args.path || region.location.pathBefore === args.path);
  const observed = regions.length > 0;
  return sflowResult({
    kind: 'read',
    operation: { id: 'intent.trace', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { path: args.path, regions: String(regions.length) }
    },
    effects: noEffects(),
    why: [{
      code: 'intent.trace.resource-observation', source: 'deterministic',
      reference: manifest.manifestSha256,
      slots: { path: args.path, regions: String(regions.length) }
    }],
    warnings: [{
      code: observed ? 'intent.trace.cause-unavailable' : 'intent.trace.path-not-changed',
      source: 'unavailable',
      slots: { path: args.path }
    }],
    preserved: preservedAll('intent.trace.nothing-was-carried-out', { reference: args.repositoryId }),
    restState: 'informational',
    data: {
      mode: 'observe-only',
      repository: args.repositoryId,
      path: args.path,
      requestedLines: {
        start: args.lineStart ?? null,
        end: args.lineEnd ?? null,
        assurance: 'unavailable-at-resource-granularity'
      },
      compatibilitySubjectSha256: manifest.compatibilityCandidateSha256,
      manifestSha256: manifest.manifestSha256,
      regions: regions.map((region) => ({
        regionId: region.regionId,
        regionSha256: region.regionSha256,
        operation: region.operation,
        pathBefore: region.location.pathBefore,
        pathAfter: region.location.pathAfter,
        assurance: region.classification.assurance
      })),
      cause: {
        status: 'unavailable',
        reasonCode: 'CMP_EXPLANATION_SOURCE_UNAVAILABLE'
      },
      structure: {
        status: 'unavailable',
        reason: 'resource-fallback-no-ast-required'
      },
      bounds: {
        sourceBodiesIncluded: false,
        promptsIncluded: false,
        transcriptsIncluded: false,
        modelInvoked: false,
        astRequired: false,
        authoritative: false,
        lifecycleGate: false
      }
    }
  });
}
