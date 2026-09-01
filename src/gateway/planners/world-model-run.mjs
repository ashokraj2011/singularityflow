import { canonicalJson } from '../../specifications.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { planWorldModelV4 } from '../../world-model/plan.mjs';
import { sha256 } from '../../world-model/canonicalize.mjs';
import {
  assertWorldModelV4BuildCompleted, buildAndPublishWorldModelV4,
  resolveWorldModelV4BuildViews
} from '../../world-model/service.mjs';
import { captureWorldModelPublicationReview } from '../../world-model/publication-authority.mjs';
import { effects, sflowResult } from '../result.mjs';

const EFFECTS = Object.freeze(effects({
  filesChanged: true,
  stateChanged: true,
  gitRefsChanged: true,
  publicationCreated: true,
  externalSystemsChanged: true
}));

function normalizedOptions(root, args, defaults = {}, { forPlanning = false } = {}) {
  const requestedViews = [...args.views];
  const outputDir = defaults.outputDir ?? 'singularity/world-model';
  const ledgerConfig = Object.freeze({
    ...(defaults.ledgerConfig ?? {}),
    branch: defaults.ledgerConfig?.branch ?? 'state',
    remote: defaults.ledgerConfig?.remote ?? 'origin'
  });
  const effectiveViews = forPlanning
    ? resolveWorldModelV4BuildViews(root, {
        views: requestedViews, outputDir, ledgerConfig, preserveIndependentViews: true
      })
    : requestedViews;
  return {
    ...defaults,
    views: effectiveViews,
    depth: args.depth ?? defaults.depth ?? 'standard',
    consumer: args.consumer ?? defaults.consumer ?? 'developer',
    composer: args.composer ?? defaults.composer ?? 'deterministic',
    cachePolicy: args.cachePolicy ?? defaults.cachePolicy ?? 'reuse-valid',
    outputDir,
    ledgerConfig,
    preserveIndependentViews: true
  };
}

/** Build the exact review record a host displays before it asks for confirmation. */
export function worldModelBuildPlanDescriptor({ root, arguments: args, defaults = {}, policy = null } = {}) {
  if (!root) {
    throw new SingularityFlowError('A registered world-model Plan requires a selected repository.', {
      code: 'WMB_GATEWAY_REPOSITORY_REQUIRED'
    });
  }
  const options = normalizedOptions(root, args, defaults, { forPlanning: true });
  const planned = planWorldModelV4(root, options);
  const requiresModel = options.composer === 'model'
    || planned.requestedViews.some((entry) => entry.contract.model.mode === 'required');
  if (requiresModel && policy?.modelRouting === 'disabled') {
    throw new SingularityFlowError('Current gateway policy disables model-backed world-model composition.', {
      code: 'WMB_GATEWAY_MODEL_ROUTING_DISABLED'
    });
  }
  const review = Object.freeze({
    requestSha256: planned.request.requestSha256,
    planSha256: planned.plan.planSha256,
    sourceManifestSha256: planned.sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: planned.scopeManifest.scopeSha256,
    requestedViews: Object.freeze([...args.views]),
    effectiveViews: Object.freeze(planned.plan.views.map((entry) => `${entry.viewId}@${entry.viewVersion}`)),
    depth: options.depth,
    consumer: options.consumer,
    composer: options.composer,
    cachePolicy: options.cachePolicy,
    publication: captureWorldModelPublicationReview(root, options)
  });
  const operationSha256 = sha256({
    kind: 'wmb-v4-gateway-operation',
    requestSha256: planned.request.requestSha256,
    planSha256: planned.plan.planSha256,
    publication: review.publication
  });
  return Object.freeze({
    effects: EFFECTS,
    externalTargets: Object.freeze([
      `${review.publication.remote}:${review.publication.targetRef}`,
      review.publication.remoteEndpointSha256 ?? 'local-only-state-branch'
    ]),
    idempotencyKey: `wmb-v4:${operationSha256}`,
    review
  });
}

/** Execute only the WMB Plan that was reviewed and signed by the gateway. */
export async function executeWorldModelBuildPlan({
  root, arguments: args, plan, defaults = {}, policy = null
} = {}) {
  const current = worldModelBuildPlanDescriptor({ root, arguments: args, defaults, policy });
  if (canonicalJson(current.review) !== canonicalJson(plan.review)) {
    throw new SingularityFlowError('The registered world-model Plan changed after confirmation.', {
      code: 'WMB_GATEWAY_PLAN_DRIFTED',
      details: {
        expectedRequestSha256: plan.review?.requestSha256 ?? null,
        currentRequestSha256: current.review.requestSha256,
        expectedPlanSha256: plan.review?.planSha256 ?? null,
        currentPlanSha256: current.review.planSha256
      }
    });
  }
  const buildOptions = normalizedOptions(root, args, defaults);
  // Gateway Plans always publish. A local-only build is a distinct operation and is not smuggled
  // through defaults or model-authored arguments.
  const result = assertWorldModelV4BuildCompleted(await buildAndPublishWorldModelV4(root, {
    ...buildOptions,
    publish: true,
    expectedBuildIdentity: Object.freeze({
      requestSha256: plan.review.requestSha256,
      planSha256: plan.review.planSha256
    }),
    expectedPublication: plan.review.publication
  }));
  if (result.requestSha256 !== plan.review.requestSha256
      || result.runtime.planned.plan.planSha256 !== plan.review.planSha256) {
    throw new SingularityFlowError('Executed world-model build did not match its confirmed Plan.', {
      code: 'WMB_GATEWAY_PLAN_DRIFTED'
    });
  }
  return sflowResult({
    kind: 'read',
    operation: { id: 'world-model.build', classification: 'mutation' },
    outcome: {
      status: 'succeeded', messageId: 'gateway.completed',
      slots: { views: result.views.length, manifestSha256: result.manifestSha256 }
    },
    effects: {
      ...EFFECTS,
      filesChanged: true,
      stateChanged: result.publication?.changed === true,
      gitRefsChanged: result.publication?.changed === true,
      publicationCreated: result.publication != null,
      externalSystemsChanged: result.publication?.changed === true
    },
    restState: 'complete',
    data: {
      requestSha256: result.requestSha256,
      planSha256: result.runtime.planned.plan.planSha256,
      manifestSha256: result.manifestSha256,
      views: result.views,
      publication: result.publication
    }
  });
}

export function worldModelGatewayCapabilities({ defaults = {} } = {}) {
  return Object.freeze({
    planBuilders: new Map([[
      'world-model-build', (request) => worldModelBuildPlanDescriptor({ ...request, defaults })
    ]]),
    mutationExecutors: new Map([[
      'world-model-build', (request) => executeWorldModelBuildPlan({ ...request, defaults })
    ]])
  });
}
