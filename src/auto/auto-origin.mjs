/** Auto execution-origin records pinned into governed Story state. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { nowIso, posix, SingularityFlowError, writeAtomic } from '../util.mjs';
import { autoPlanHash } from './auto-plan.mjs';
import { buildAutoPlanPacket } from './auto-plan-packet.mjs';

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

  let acceptedPlan;
  let ratification;
  try {
    const loadedPlan = readRecord('auto-plan', await readFile(expectedPlanPath, 'utf8'));
    acceptedPlan = loadedPlan.record;
    ratification = readRecord(
      'auto-plan-ratification', await readFile(expectedRatificationPath, 'utf8')
    ).record;
  } catch (error) {
    if (error?.code === 'SCHEMA_VERSION_ARCHIVED') {
      fail('The governed accepted Plan uses a retired schema and must be recreated before Auto execution can continue.', {
        storedVersion: 1,
        nextAction: 'Create and review a new Auto Plan; legacy Plan-SHA confirmation is retired.'
      });
    }
    if (error instanceof SingularityFlowError) throw error;
    fail(`The governed Auto binding cannot be read: ${error.message}`);
  }
  if (acceptedPlan.planId !== state.planId
      || acceptedPlan.planSha256 !== state.planSha256
      || acceptedPlan.confirmation?.protocol !== 'packet-v1'
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
  if (ratification.confirmationProtocol !== 'packet-v1'
      || ratification.confirmedSha256 !== packet.packetSha256
      || ratification.packetSha256 !== packet.packetSha256
      || ratification.validationSha256 !== packet.validationSha256) {
    fail('The governed Auto ratification is not bound to the accepted Plan packet.');
  }
  return Object.freeze({ acceptedPlan, ratification });
}
