/** Auto execution-origin records pinned into governed Story state. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { nowIso, posix, SingularityFlowError, writeAtomic } from '../util.mjs';
import { autoPlanHash } from './auto-plan.mjs';
import {
  AUTO_PLAN_CONFIRMATION_PROTOCOL, buildAutoPlanPacket
} from './auto-plan-packet.mjs';

export function autoExecutionOrigin({ flightId, planId, planSha256 }) {
  return Object.freeze({
    schemaVersion: currentSchemaVersion('auto-origin'),
    mode: 'auto', flightId, planId, planSha256
  });
}

function ratificationAuthorizationSha256(record) {
  const authority = {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    mode: record.mode,
    planId: record.planId,
    planSha256: record.planSha256,
    actor: record.actor,
    identityAssurance: record.identityAssurance,
    ratifiedAt: record.ratifiedAt,
    expiresAt: record.expiresAt
  };
  for (const field of [
    'confirmationProtocol', 'confirmedSha256', 'packetSha256', 'validationSha256'
  ]) {
    if (record[field] != null) authority[field] = record[field];
  }
  return `sha256:${recordSha256(authority)}`;
}

const LEGACY_AUTO_COMPATIBILITY = Object.freeze({
  sourceSchemaVersion: 2,
  confirmationProtocol: 'packet-v1',
  repairPolicy: 'never',
  repairAttemptsPerPhase: 0
});

/**
 * Verify the exact packet-v1 authority of an already-active v2 flight.
 *
 * This is deliberately not a start-time compatibility path. Both inputs must have been migrated
 * from stored v2 bytes by the registry, the original packet digest must match on both records, and
 * effective repair authority is always reduced to never/zero.
 */
export function verifyLegacyAutoBindingCompatibility({
  acceptedPlan, ratification, state, planStoredVersion, ratificationStoredVersion
}) {
  const reject = (message) => {
    throw new SingularityFlowError(message, {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH',
      details: { flightId: state?.flightId ?? null, compatibility: 'packet-v1-no-repair' }
    });
  };
  if (planStoredVersion !== 2 || ratificationStoredVersion !== 2) {
    reject('Legacy Auto compatibility requires matching stored v2 Plan and ratification records.');
  }
  const planCompatibility = acceptedPlan?.legacyCompatibility;
  const ratificationCompatibility = ratification?.legacyCompatibility;
  const expectedCompatibility = {
    ...LEGACY_AUTO_COMPATIBILITY,
    planSha256: acceptedPlan?.planSha256,
    packetSha256: ratification?.packetSha256,
    validationSha256: ratification?.validationSha256
  };
  if (acceptedPlan?.confirmation?.protocol !== 'packet-v1'
      || acceptedPlan?.execution?.repair?.policy !== 'never'
      || acceptedPlan?.execution?.repair?.maximumAttempts !== 0
      || canonicalJson(planCompatibility) !== canonicalJson(expectedCompatibility)
      || canonicalJson(ratificationCompatibility) !== canonicalJson(expectedCompatibility)) {
    reject('Legacy Auto compatibility does not preserve the packet-v1 no-repair boundary.');
  }
  const ratificationCopy = structuredClone(ratification);
  delete ratificationCopy.recordSha256;
  if (ratification?.kind !== 'auto-plan-ratification'
      || ratification?.mode !== 'auto'
      || ratification?.confirmationProtocol !== 'packet-v1'
      || ratification?.confirmedSha256 !== expectedCompatibility.packetSha256
      || ratification?.packetSha256 !== expectedCompatibility.packetSha256
      || ratification?.validationSha256 !== expectedCompatibility.validationSha256
      || ratification?.authorizationSha256 !== ratificationAuthorizationSha256(ratification)
      || ratification?.recordSha256 !== recordSha256(ratificationCopy)
      || ratification?.planId !== acceptedPlan?.planId
      || ratification?.planSha256 !== acceptedPlan?.planSha256
      || ratification?.flightId !== state?.flightId
      || acceptedPlan?.planId !== state?.planId
      || acceptedPlan?.planSha256 !== state?.planSha256) {
    reject('Legacy Auto compatibility failed its exact Plan, packet, or flight binding.');
  }
  return Object.freeze({
    protocol: 'packet-v1-no-repair',
    sourceSchemaVersion: 2,
    packetSha256: expectedCompatibility.packetSha256,
    validationSha256: expectedCompatibility.validationSha256,
    repair: Object.freeze({ policy: 'never', maximumAttempts: 0 })
  });
}

export async function pinAcceptedAutoPlan(root, definition, workflow, { plan, ratification, flightId }) {
  const directory = path.join(root, definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', 'auto');
  const acceptedPlan = structuredClone(plan);
  const acceptedPath = path.join(directory, 'accepted-plan.json');
  const ratificationRecord = {
    schemaVersion: currentSchemaVersion('auto-plan-ratification'),
    kind: 'auto-plan-ratification', mode: 'auto', flightId,
    planId: plan.planId, planSha256: plan.planSha256,
    confirmationProtocol: ratification.confirmationProtocol,
    confirmedSha256: ratification.confirmedSha256,
    packetSha256: ratification.packetSha256,
    validationSha256: ratification.validationSha256,
    actor: structuredClone(ratification.actor),
    identityAssurance: ratification.identityAssurance,
    ratifiedAt: ratification.ratifiedAt, expiresAt: ratification.expiresAt,
    authorizationSha256: ratification.authorizationSha256,
    pinnedAt: nowIso()
  };
  ratificationRecord.recordSha256 = recordSha256(ratificationRecord);
  const ratificationPath = path.join(directory, 'ratification.json');
  await writeAtomic(acceptedPath, canonicalJson(acceptedPlan));
  await writeAtomic(ratificationPath, canonicalJson(ratificationRecord));
  workflow.executionOrigin = autoExecutionOrigin({
    flightId, planId: plan.planId, planSha256: plan.planSha256
  });
  workflow.lineage.executionOrigin = structuredClone(workflow.executionOrigin);
  workflow.auto = {
    mode: 'auto', flightId, planId: plan.planId, planSha256: plan.planSha256,
    acceptedPlanPath: posix(path.relative(root, acceptedPath)),
    ratificationPath: posix(path.relative(root, ratificationPath))
  };
  return workflow.auto;
}

/**
 * Read the governed Auto binding committed with the Story.
 *
 * The local flight file is an operational projection. It is never sufficient authority for
 * resuming model execution: the accepted Plan, ratification, and Story execution origin must all
 * still agree byte-for-byte in the governed worktree.
 */
export async function readVerifiedAcceptedAutoBinding(root, definition, workflow, state) {
  const workId = workflow?.workItem?.id;
  const expectedDirectory = path.join(
    root, definition.workItemRoot ?? 'singularity/work-items', workId ?? '', 'context', 'auto'
  );
  const expectedPlanPath = path.join(expectedDirectory, 'accepted-plan.json');
  const expectedRatificationPath = path.join(expectedDirectory, 'ratification.json');
  const expectedPlanRelative = posix(path.relative(root, expectedPlanPath));
  const expectedRatificationRelative = posix(path.relative(root, expectedRatificationPath));
  const fail = (message, details = {}) => {
    throw new SingularityFlowError(message, {
      code: 'AUTO_FLIGHT_BINDING_MISMATCH', details: { workId, flightId: state?.flightId, ...details }
    });
  };

  if (!workId || workId !== state?.story?.workId) fail('The governed Story does not match the Auto flight.');
  if (workflow.executionOrigin?.mode !== 'auto'
      || workflow.executionOrigin?.flightId !== state.flightId
      || workflow.executionOrigin?.planId !== state.planId
      || workflow.executionOrigin?.planSha256 !== state.planSha256) {
    fail('The governed Story execution origin does not match the Auto flight.');
  }
  if (workflow.auto?.acceptedPlanPath !== expectedPlanRelative
      || workflow.auto?.ratificationPath !== expectedRatificationRelative) {
    fail('The governed Story points outside its canonical Auto binding paths.');
  }

  let loadedPlan;
  let loadedRatification;
  let acceptedPlan;
  let ratification;
  try {
    loadedPlan = readRecord('auto-plan', await readFile(expectedPlanPath, 'utf8'));
    acceptedPlan = loadedPlan.record;
    loadedRatification = readRecord(
      'auto-plan-ratification', await readFile(expectedRatificationPath, 'utf8')
    );
    ratification = loadedRatification.record;
  } catch (error) {
    if (error?.code === 'SCHEMA_VERSION_ARCHIVED') {
      fail('The governed accepted Plan uses a retired schema and must be recreated before Auto execution can continue.', {
        storedVersion: error.details?.storedVersion ?? null,
        nextAction: 'Create and review a new Auto Plan; packet-v2 confirmation is required.'
      });
    }
    if (error instanceof SingularityFlowError) throw error;
    fail(`The governed Auto binding cannot be read: ${error.message}`);
  }
  if (loadedPlan.storedVersion === 2 || loadedRatification.storedVersion === 2) {
    let compatibility;
    try {
      compatibility = verifyLegacyAutoBindingCompatibility({
        acceptedPlan,
        ratification,
        state,
        planStoredVersion: loadedPlan.storedVersion,
        ratificationStoredVersion: loadedRatification.storedVersion
      });
    } catch (error) {
      if (error instanceof SingularityFlowError) throw error;
      fail(`The governed legacy Auto binding cannot be verified: ${error.message}`);
    }
    return Object.freeze({ acceptedPlan, ratification, compatibility });
  }
  if (acceptedPlan.planId !== state.planId
      || acceptedPlan.planSha256 !== state.planSha256
      || acceptedPlan.confirmation?.protocol !== AUTO_PLAN_CONFIRMATION_PROTOCOL
      || autoPlanHash(acceptedPlan) !== acceptedPlan.planSha256) {
    fail('The governed accepted Plan failed its identity or integrity check.');
  }
  const ratificationCopy = structuredClone(ratification);
  delete ratificationCopy.recordSha256;
  if (ratification.kind !== 'auto-plan-ratification'
      || ratification.mode !== 'auto'
      || ratification.flightId !== state.flightId
      || ratification.planId !== state.planId
      || ratification.planSha256 !== state.planSha256
      || ratification.authorizationSha256 !== ratificationAuthorizationSha256(ratification)
      || ratification.recordSha256 !== recordSha256(ratificationCopy)) {
    fail('The governed Auto ratification failed its identity or integrity check.');
  }
  const packet = buildAutoPlanPacket(acceptedPlan);
  if (ratification.confirmationProtocol !== AUTO_PLAN_CONFIRMATION_PROTOCOL
      || ratification.confirmedSha256 !== packet.packetSha256
      || ratification.packetSha256 !== packet.packetSha256
      || ratification.validationSha256 !== packet.validationSha256) {
    fail('The governed Auto ratification is not bound to the accepted Plan packet.');
  }
  return Object.freeze({ acceptedPlan, ratification, compatibility: null });
}
