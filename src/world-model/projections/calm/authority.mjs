import { readFile } from 'node:fs/promises';

import { CAPABILITIES_PATH, loadCapabilities } from '../../../capabilities.mjs';
import { WORKFLOW_PATH } from '../../../config.mjs';
import { secureRepositoryPath, SingularityFlowError } from '../../../util.mjs';
import { canonicalJson, sha256 } from '../../canonicalize.mjs';
import {
  createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot
} from './projection.mjs';
import { createCalmToolchainLock } from './validator.mjs';

function snapshotDifference(label, staged, current) {
  if (canonicalJson(staged) === canonicalJson(current)) return null;
  return Object.freeze({
    authority: label,
    stagedSha256: staged?.snapshotSha256 ?? null,
    currentSha256: current?.snapshotSha256 ?? null
  });
}

async function exactConfigurationDigest(root, relative, label) {
  const located = await secureRepositoryPath(root, relative, {
    label, mustExist: true, type: 'file'
  });
  return sha256({ utf8: await readFile(located.absolute, 'utf8') });
}

/** Resolve the exact approved inputs which make a reusable architecture projection current. */
export async function resolveCurrentArchitectureProjectionInputs(root, definition) {
  const [capabilities, capabilitySourceSha256, configurationSourceSha256, toolchain] = await Promise.all([
    loadCapabilities(root, { required: true }),
    exactConfigurationDigest(root, CAPABILITIES_PATH, 'Capability map'),
    exactConfigurationDigest(root, WORKFLOW_PATH, 'Workflow configuration'),
    createCalmToolchainLock()
  ]);
  return Object.freeze({
    capabilitySnapshot: createArchitectureCapabilitySnapshot(capabilities, {
      sourcePath: CAPABILITIES_PATH, sourceSha256: capabilitySourceSha256
    }),
    configurationSnapshot: createArchitectureConfigurationSnapshot(definition, {
      sourcePath: WORKFLOW_PATH, sourceSha256: configurationSourceSha256
    }),
    toolchainLock: toolchain.lock
  });
}

export function architectureProjectionInputIdentity(inputs) {
  return Object.freeze({
    capabilitySnapshotSha256: inputs?.capabilitySnapshot?.snapshotSha256 ?? null,
    configurationSnapshotSha256: inputs?.configurationSnapshot?.snapshotSha256 ?? null,
    toolchainLockSha256: inputs?.toolchainLock?.lockSha256 ?? null
  });
}

/**
 * Prove that staged normalized inputs are the deterministic projection of current approved bytes.
 *
 * A snapshot's source digest is necessary but not sufficient: a forged snapshot can quote the
 * correct source digest, change normalized fields, and then seal itself consistently. Publication
 * therefore regenerates both snapshots from authority and compares their complete canonical shape.
 */
export function assertArchitectureProjectionAuthoritySnapshots(staged, current) {
  const changes = [
    snapshotDifference('capability', staged?.capabilitySnapshot, current?.capabilitySnapshot),
    snapshotDifference('configuration', staged?.configurationSnapshot, current?.configurationSnapshot)
  ].filter(Boolean);
  if (changes.length) {
    throw new SingularityFlowError(
      'The staged CALM inputs are not the deterministic projection of current approved authority. Nothing was published.',
      {
        code: 'WMC_PROJECTION_INPUT_CHANGED',
        details: {
          changes,
          nextAction: 'singularity-flow wm build --format registered-v4 --projections arch.calm'
        }
      }
    );
  }
  return staged;
}

/** Refuse a projection whose approved capability, policy, or local toolchain identity moved. */
export function assertCurrentArchitectureProjection(store, inputs) {
  const expected = architectureProjectionInputIdentity(inputs);
  const request = store?.records?.buildRequest ?? {};
  const changes = Object.entries(expected)
    .filter(([field, value]) => request[field] !== value)
    .map(([field, value]) => ({ field, built: request[field] ?? null, current: value }));
  if (changes.length) {
    throw new SingularityFlowError(
      'The reusable CALM architecture projection is stale for the current capability, configuration, or validator authority.',
      {
        code: 'WMC_PROJECTION_STALE',
        details: {
          changes,
          nextAction: 'singularity-flow wm build --format registered-v4 --projections arch.calm'
        }
      }
    );
  }
  return store;
}
