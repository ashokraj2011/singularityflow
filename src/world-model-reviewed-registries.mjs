/**
 * Extractor Registry identities that reviewed lock transitions accepted, and what each transition
 * changed in a published World Model.
 *
 * Every entry mirrors one accepted identity table in
 * docs/contracts/wmb/REGISTRY-LOCK-REVIEW-2026-09-19.md, and test/world-model-reviewed-registries.test.mjs
 * keeps the two identical. A published model whose Extractor Registry is on this chain stays readable
 * after an upgrade. It is also current when every transition from its registry to the installed one
 * left facts and views unchanged. Any other registry stays fail-closed.
 *
 * This file is deliberately outside src/world-model/: the chain names the installed kernel identity,
 * so it cannot be part of the bytes that identity hashes.
 */
import {
  BUILTIN_EXTRACTOR_REGISTRY, assertInstalledExtractorRegistry, validateHistoricalExtractorRegistry
} from './world-model/registry/extractors.mjs';
import { WMB_V4_VALIDATION_CHECK_IDS } from './world-model/validate/candidate.mjs';
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

/** Transition effects, in increasing blast radius. Only `mechanical` preserves a model as current. */
export const REVIEWED_TRANSITION_EFFECTS = Object.freeze({
  mechanical: 'Facts and views are unchanged; only the kernel identity moved.',
  'view-selection': 'Facts are unchanged; bounded view selection or rendering changed.',
  composition: 'Facts are unchanged; the composition input admitted to a view changed.',
  'source-admission': 'Exact source admission changed, so facts may differ for some repositories.'
});

export const REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS = Object.freeze([
  Object.freeze({
    review: 'Accepted identity transition',
    effect: 'mechanical',
    from: 'sha256:f0809bd0c483e1ec23681b32556b379d22e36c31779f9858e0cede7147821495',
    to: 'sha256:d30ebced366e1916decc7592db0eca0ec354b6d396bd76078c43f857823073fd',
    kernelFrom: 'sha256:c27d146e2f3020bafe501b3c6e62b67f2e2d5e41b92b6935e66aa56594945863',
    kernelTo: 'sha256:5e5d9f2cae0b949239ce8a0af298b47d9ee085bb7f63c8af9d4ec2bbe4c98fe7'
  }),
  Object.freeze({
    review: 'Persisted-view historical-reader isolation addendum',
    effect: 'mechanical',
    from: 'sha256:d30ebced366e1916decc7592db0eca0ec354b6d396bd76078c43f857823073fd',
    to: 'sha256:45432b2ad2b036f386a135396230e49f946bb8a600ca5cd40e0a81a42c035fd9',
    kernelFrom: 'sha256:5e5d9f2cae0b949239ce8a0af298b47d9ee085bb7f63c8af9d4ec2bbe4c98fe7',
    kernelTo: 'sha256:b2f21878f0ca48d970576a620d29233906043dd4ae6167d1358fc51f84fee9f1'
  }),
  Object.freeze({
    review: 'Saved-view publication and successor-grounding addendum',
    effect: 'mechanical',
    from: 'sha256:45432b2ad2b036f386a135396230e49f946bb8a600ca5cd40e0a81a42c035fd9',
    to: 'sha256:b666190ca6e5edba596438fb54440a4f111dd49524eb76219f35a3880ef29f53',
    kernelFrom: 'sha256:b2f21878f0ca48d970576a620d29233906043dd4ae6167d1358fc51f84fee9f1',
    kernelTo: 'sha256:eee353719a12ed6f4aeab43c4d77dcfb6cf21c660f3f1f6c8cfbf36ba565917d'
  }),
  Object.freeze({
    review: 'Automatic Story grounding activation registry acceptance',
    effect: 'mechanical',
    from: 'sha256:b666190ca6e5edba596438fb54440a4f111dd49524eb76219f35a3880ef29f53',
    to: 'sha256:1652d0a2c6b04b56e656c0975669f30beb159f0c3a628127ac4a1963b7bbd312',
    kernelFrom: 'sha256:eee353719a12ed6f4aeab43c4d77dcfb6cf21c660f3f1f6c8cfbf36ba565917d',
    kernelTo: 'sha256:6a7b4e5418e79f77a48b2de4bc338c7374c6514992c0ba2c1198a340c8ea870f'
  }),
  Object.freeze({
    review: 'Post-review activation hardening acceptance',
    effect: 'mechanical',
    from: 'sha256:1652d0a2c6b04b56e656c0975669f30beb159f0c3a628127ac4a1963b7bbd312',
    to: 'sha256:672a8937cbd9310ffe7fa7c91c2b158c4618b14663b8c13d2bdf0f3b1f554d10',
    kernelFrom: 'sha256:6a7b4e5418e79f77a48b2de4bc338c7374c6514992c0ba2c1198a340c8ea870f',
    kernelTo: 'sha256:d0164edc9b553ce98dfbc143c55d2298428e20901e8b8475dcad6ba9fa0ee516'
  }),
  Object.freeze({
    review: 'Package-root isolation acceptance',
    effect: 'mechanical',
    from: 'sha256:672a8937cbd9310ffe7fa7c91c2b158c4618b14663b8c13d2bdf0f3b1f554d10',
    to: 'sha256:0ddd7ed4a60f4da2b276e1569f2e5163320242d3156da7c8cb999a1ca2616c8d',
    kernelFrom: 'sha256:d0164edc9b553ce98dfbc143c55d2298428e20901e8b8475dcad6ba9fa0ee516',
    kernelTo: 'sha256:b042f23949f063775180dfc97053afd9150f1aaa836ab77efdde76b5bb1b5fbe'
  }),
  Object.freeze({
    review: 'CALM refusal-preservation acceptance',
    effect: 'mechanical',
    from: 'sha256:0ddd7ed4a60f4da2b276e1569f2e5163320242d3156da7c8cb999a1ca2616c8d',
    to: 'sha256:f5ddab132c91bd76cb1b51354fc5744b8fa4718a4ef99ac1df57ea0e03bb1e38',
    kernelFrom: 'sha256:b042f23949f063775180dfc97053afd9150f1aaa836ab77efdde76b5bb1b5fbe',
    kernelTo: 'sha256:83f7260677dbcb7a127825b6e06be16e7ad7e3f8c17e34aa3ee81440449e557d'
  }),
  Object.freeze({
    review: 'Bounded registered-view selection acceptance',
    effect: 'view-selection',
    from: 'sha256:f5ddab132c91bd76cb1b51354fc5744b8fa4718a4ef99ac1df57ea0e03bb1e38',
    to: 'sha256:3a4e1e9a031721eddfb101ff154884fe8de36956b0b64996cdbece12266cee55',
    kernelFrom: 'sha256:83f7260677dbcb7a127825b6e06be16e7ad7e3f8c17e34aa3ee81440449e557d',
    kernelTo: 'sha256:55fe41694090b06cf190fac97047108f7ed689a25f72ce84731a169d78ac97fe'
  }),
  Object.freeze({
    review: 'Bounded composition-input acceptance',
    effect: 'composition',
    from: 'sha256:3a4e1e9a031721eddfb101ff154884fe8de36956b0b64996cdbece12266cee55',
    to: 'sha256:83aaacb514ad8af54819d2aa16b7fd9f3d3b79ddc744c1ab6ae53333ebda0531',
    kernelFrom: 'sha256:55fe41694090b06cf190fac97047108f7ed689a25f72ce84731a169d78ac97fe',
    kernelTo: 'sha256:fcb6379667299b0f6aadadd7d38881d1734059243b81daca28703e45531e2db5'
  }),
  Object.freeze({
    review: 'Portable environment-exclusion identity acceptance',
    effect: 'source-admission',
    from: 'sha256:83aaacb514ad8af54819d2aa16b7fd9f3d3b79ddc744c1ab6ae53333ebda0531',
    to: 'sha256:95968338f449e6a1628fccf167233e986bde1cd0619724c4e048c0aff6531503',
    kernelFrom: 'sha256:fcb6379667299b0f6aadadd7d38881d1734059243b81daca28703e45531e2db5',
    kernelTo: 'sha256:b2e1bfeb1211a022b8e68dd92648087b613fe21b7c79cf33dc4a8763c927f30c'
  }),
  Object.freeze({
    review: 'Frozen view-contract schema constant acceptance',
    effect: 'mechanical',
    from: 'sha256:95968338f449e6a1628fccf167233e986bde1cd0619724c4e048c0aff6531503',
    to: 'sha256:559285187f036990893a6b062df871b70339be4bed7ee94e8896b21c3e163542',
    kernelFrom: 'sha256:b2e1bfeb1211a022b8e68dd92648087b613fe21b7c79cf33dc4a8763c927f30c',
    kernelTo: 'sha256:c7fb97c6492ade4be5ac53811ce610faf3fa873f62aea96d5b93f3604d987cde'
  }),
  Object.freeze({
    review: 'Batched Exact Source Snapshot read acceptance',
    effect: 'mechanical',
    from: 'sha256:559285187f036990893a6b062df871b70339be4bed7ee94e8896b21c3e163542',
    to: 'sha256:b7d5cfaa65ad4294da1c8ae565eae238ca5e83cadde2e43e543e9ba5f092c949',
    kernelFrom: 'sha256:c7fb97c6492ade4be5ac53811ce610faf3fa873f62aea96d5b93f3604d987cde',
    kernelTo: 'sha256:b4aefa776a1b8813671d7f0df65d21af0e0e8aed2234bf536fd4af21146dbb53'
  }),
  Object.freeze({
    review: 'Reviewed-registry admission acceptance',
    effect: 'mechanical',
    from: 'sha256:b7d5cfaa65ad4294da1c8ae565eae238ca5e83cadde2e43e543e9ba5f092c949',
    to: 'sha256:2ef1d57fa168ac0b7c0c41677f0af43c3ba77799bd02c02d3416aba1cee2278f',
    kernelFrom: 'sha256:b4aefa776a1b8813671d7f0df65d21af0e0e8aed2234bf536fd4af21146dbb53',
    kernelTo: 'sha256:3b812b54e3e741f4d38d303b59c9632fd29f7e3b7fb697bc52bb056074bee322'
  }),
  Object.freeze({
    review: 'Qualified clause-binding grammar acceptance',
    effect: 'source-admission',
    from: 'sha256:2ef1d57fa168ac0b7c0c41677f0af43c3ba77799bd02c02d3416aba1cee2278f',
    to: 'sha256:48ddfe38046673188341f2682d813a9ec5c301524f3df3ebefacac83e44c56a3',
    kernelFrom: 'sha256:3b812b54e3e741f4d38d303b59c9632fd29f7e3b7fb697bc52bb056074bee322',
    kernelTo: 'sha256:9eef2d9ef8aba21f15c993c2f1b47d6870b0cacdae9f41d2f8eefd25c755206e'
  })
]);

/**
 * The reviewed transitions leading from `fromSha256` to `toSha256`, oldest first, or null when the
 * chain does not connect them. The chain is linear, so there is at most one path.
 */
export function reviewedExtractorRegistryPath(
  fromSha256, toSha256 = BUILTIN_EXTRACTOR_REGISTRY.registrySha256
) {
  if (fromSha256 === toSha256) return Object.freeze([]);
  const start = REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.findIndex((entry) => entry.from === fromSha256);
  if (start < 0) return null;
  const path = [];
  for (const transition of REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.slice(start)) {
    if (transition.from !== (path.at(-1)?.to ?? fromSha256)) return null;
    path.push(transition);
    if (transition.to === toSha256) return Object.freeze(path);
  }
  return null;
}

/** True when every transition on a reviewed path left published facts and views unchanged. */
export function reviewedPathPreservesModel(path) {
  return Array.isArray(path) && path.every((transition) => transition.effect === 'mechanical');
}

/**
 * The refusal for a model this build cannot verify exactly. It is an availability outcome: no byte
 * of the model is accepted, and a rebuild with this build replaces it.
 */
export function earlierBuildModelIncompatible(publishedRegistrySha256, reason, cause = null) {
  return new SingularityFlowError(
    'This World Model was published by an earlier build that this build cannot verify exactly. Rebuild it with this build to replace it.',
    {
      code: 'WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE',
      details: {
        reason,
        publishedRegistrySha256,
        installedRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
        ...(cause?.code ? { causeCode: cause.code } : {})
      },
      ...(cause ? { cause } : {})
    }
  );
}

/**
 * Admit the Extractor Registry recorded in a published World Model.
 *
 * The installed registry is admitted exactly as before. A registry the reviewed chain connects to
 * the installed one is admitted as historical when this build can reproduce that build's validation
 * contract exactly: its structure and self-hash are verified, and the chain vouches for its
 * identity. Any other registry is refused, and a rebuild with this build replaces the model.
 */
export function admitPublishedExtractorRegistry(value) {
  const registry = validateHistoricalExtractorRegistry(value);
  if (registry.registrySha256 === BUILTIN_EXTRACTOR_REGISTRY.registrySha256) {
    return Object.freeze({
      registry: assertInstalledExtractorRegistry(value), installed: true, path: Object.freeze([])
    });
  }
  const path = reviewedExtractorRegistryPath(registry.registrySha256);
  if (!path) throw earlierBuildModelIncompatible(registry.registrySha256, 'registry-unreviewed');
  // Views are re-validated by this build acting as the earlier validator. That is exact only when
  // the earlier validator ran the same checks this one runs.
  const contract = reviewedValidationContract(registry.registrySha256);
  if (!contract || JSON.stringify(contract.checkIds) !== JSON.stringify(WMB_V4_VALIDATION_CHECK_IDS)) {
    throw earlierBuildModelIncompatible(registry.registrySha256, 'validation-contract-changed');
  }
  return Object.freeze({ registry, installed: false, path });
}

// The validation contract each reviewed build's own validator satisfied, as that build's code computes
// it. The candidate schema never changed across the chain. The execution-route check arrived with
// the composition-input acceptance, so every registry up to that transition used the shorter list.
const REVIEWED_CANDIDATE_SCHEMA_SHA256 = 'sha256:1673dbd2acd154d9d6283e5bcbe3943aac0de71d3a6472ab037c31251799afa1';
const CHECKS_BEFORE_EXECUTION_ROUTE = Object.freeze([
  'candidate-json',
  'candidate-schema',
  'view-identity',
  'registered-title',
  'required-sections',
  'section-order',
  'unregistered-sections',
  'narrative-budgets',
  'factual-unit-references',
  'fact-reference-integrity',
  'used-fact-set',
  'required-facts',
  'required-unavailable',
  'contradictions',
  'assurance',
  'scope',
  'body-access',
  'cross-view',
  'kernel-metadata',
  'total-output'
]);
const CHECKS_WITH_EXECUTION_ROUTE = Object.freeze([
  'candidate-json',
  'candidate-schema',
  'view-identity',
  'registered-title',
  'required-sections',
  'section-order',
  'unregistered-sections',
  'narrative-budgets',
  'factual-unit-references',
  'fact-reference-integrity',
  'used-fact-set',
  'required-facts',
  'required-unavailable',
  'contradictions',
  'assurance',
  'scope',
  'body-access',
  'cross-view',
  'kernel-metadata',
  'execution-route-contract',
  'total-output'
]);
const FIRST_REGISTRY_WITH_EXECUTION_ROUTE_CHECK = 'sha256:83aaacb514ad8af54819d2aa16b7fd9f3d3b79ddc744c1ab6ae53333ebda0531';

function reviewedKernelOf(registrySha256) {
  const entry = REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.find((candidate) => candidate.to === registrySha256)
    ?? REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.find((candidate) => candidate.from === registrySha256);
  if (!entry) return null;
  return entry.to === registrySha256 ? entry.kernelTo : entry.kernelFrom;
}

/**
 * The exact validation contract a reviewed build's validator satisfied: its kernel-derived validator
 * identity, the candidate schema, and its check list. Null for a registry the chain does not know.
 */
export function reviewedValidationContract(registrySha256) {
  const kernelSha256 = reviewedKernelOf(registrySha256);
  if (!kernelSha256) return null;
  const order = REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.flatMap((entry, index) => (
    index === 0 ? [entry.from, entry.to] : [entry.to]
  ));
  const withExecutionRoute = order.indexOf(registrySha256)
    >= order.indexOf(FIRST_REGISTRY_WITH_EXECUTION_ROUTE_CHECK);
  return Object.freeze({
    checkIds: withExecutionRoute ? CHECKS_WITH_EXECUTION_ROUTE : CHECKS_BEFORE_EXECUTION_ROUTE,
    candidateSchemaSha256: REVIEWED_CANDIDATE_SCHEMA_SHA256,
    validatorSha256: `sha256:${recordSha256({
      kind: 'wmb-v4-validator-implementation', sourceSha256: kernelSha256
    })}`
  });
}
