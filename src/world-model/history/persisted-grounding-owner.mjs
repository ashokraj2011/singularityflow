import { canonicalJson, deepFreeze, sealRecord, sha256 } from '../canonicalize.mjs';
import {
  PERSISTED_GROUNDING_COMPOSER_V1_ID,
  PERSISTED_GROUNDING_COMPOSER_V1_VERSION,
  PERSISTED_GROUNDING_SEPARATOR_V1,
  composePersistedGroundingPacketV1
} from './persisted-grounding-composer-v1.mjs';
import {
  PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST
} from './persisted-grounding-source-manifest.mjs';
import {
  createPersistedGroundingImplementationRegistry
} from './persisted-grounding-implementation-registry.mjs';

const FROZEN_V1_CONTRACT_SHA256 =
  'sha256:be819f7b1624949088dcb3f6262f5f631dd26f1f53c381798c43d4bc0dbc138f';

function assertFrozenContract(contract) {
  if (contract.contractSha256 !== FROZEN_V1_CONTRACT_SHA256) {
    const error = new Error(
      "Frozen persisted-grounding contract 'persisted-grounding-markdown' changed without a new version."
    );
    error.code = 'WMP_FROZEN_OWNER_CONTRACT_DRIFT';
    error.details = {
      expectedContractSha256: FROZEN_V1_CONTRACT_SHA256,
      receivedContractSha256: contract.contractSha256
    };
    throw error;
  }
  return contract;
}

const implementation = deepFreeze({
  kind: 'wmp/persisted-grounding-composer-implementation',
  version: 1,
  sourceManifestId: PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST.id,
  sourceManifestSha256: PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST.manifestSha256,
  sourceSha256: PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST.sourceSha256,
  entrypoints: [...PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST.entrypoints],
  sourceFiles: PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST.modules.map(
    (entry) => entry.path
  )
});

export const PERSISTED_GROUNDING_COMPOSER_IMPLEMENTATION = implementation;
export const PERSISTED_GROUNDING_COMPOSER_IMPLEMENTATION_SHA256 = sha256(implementation);
export const PERSISTED_GROUNDING_SEPARATOR_SHA256 = sha256(
  Buffer.from(PERSISTED_GROUNDING_SEPARATOR_V1, 'utf8')
);
export const PERSISTED_GROUNDING_FRAMING_SHA256 = sha256({
  kind: 'wmp/persisted-grounding-framing',
  version: 1,
  entry: 'exact-rendered-view-bytes',
  separatorSha256: PERSISTED_GROUNDING_SEPARATOR_SHA256,
  terminalSeparator: true
});
export const PERSISTED_GROUNDING_COMPOSER_CONTRACT = assertFrozenContract(deepFreeze(sealRecord({
  id: PERSISTED_GROUNDING_COMPOSER_V1_ID,
  version: PERSISTED_GROUNDING_COMPOSER_V1_VERSION,
  implementationSha256: PERSISTED_GROUNDING_COMPOSER_IMPLEMENTATION_SHA256,
  ordering: 'explicit-order-v1',
  separatorSha256: PERSISTED_GROUNDING_SEPARATOR_SHA256,
  framingSha256: PERSISTED_GROUNDING_FRAMING_SHA256,
  mediaType: 'text/markdown',
  measurement: 'exact-bytes-v1'
}, 'contractSha256')));
export const PERSISTED_GROUNDING_COMPOSER_CONTRACT_SHA256 =
  PERSISTED_GROUNDING_COMPOSER_CONTRACT.contractSha256;

export function assertPersistedGroundingComposerContract(value) {
  if (canonicalJson(value) !== canonicalJson(PERSISTED_GROUNDING_COMPOSER_CONTRACT)) {
    const error = new Error('Persisted grounding packet names an unknown composer identity.');
    error.code = 'WMP_GROUNDING_COMPOSER_UNSUPPORTED';
    throw error;
  }
  return value;
}

export const PERSISTED_GROUNDING_IMPLEMENTATION_REGISTRY =
  createPersistedGroundingImplementationRegistry({
    activeWriterId: 'persisted-grounding-v1',
    entries: [{
      id: 'persisted-grounding-v1',
      version: 1,
      composerContract: PERSISTED_GROUNDING_COMPOSER_CONTRACT,
      replay: composePersistedGroundingPacketV1
    }]
  });

export function replayPersistedGroundingPacketV1(entries) {
  return PERSISTED_GROUNDING_IMPLEMENTATION_REGISTRY.replay({
    composerContract: PERSISTED_GROUNDING_COMPOSER_CONTRACT,
    entries
  });
}
