/** Auto execution-origin records pinned into governed Story state. */
import path from 'node:path';

import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { nowIso, posix, writeAtomic } from '../util.mjs';

export function autoExecutionOrigin({ flightId, planId, planSha256 }) {
  return Object.freeze({
    schemaVersion: currentSchemaVersion('auto-origin'),
    mode: 'auto', flightId, planId, planSha256
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
