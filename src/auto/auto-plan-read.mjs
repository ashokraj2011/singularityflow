/** Native read-only Auto Plan observation. No synthesis, provider launch, ratification or writes. */
import path from 'node:path';
import {gitCommonDir} from '../git.mjs';
import {currentSchemaVersion,readRecord} from '../schema-migrations.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {assertCredentialFreeRemote} from '../git-remote-diagnostics.mjs';
import {readAutoPrivateRecord} from './auto-private-store.mjs';
import {AUTO_PLAN_CONFIRMATION_PROTOCOL,autoPlanHash} from './auto-plan-packet.mjs';
const PLAN_ID=/^APL-[A-F0-9]{26}$/;
export function planFile(root,planId){return path.join(gitCommonDir(root),'singularity-flow','auto-plans',planId+'.json');}
export function validatePlanId(value) {
  const id = String(value ?? '').trim();
  if (!PLAN_ID.test(id)) throw new SingularityFlowError(`Invalid Auto Plan ID '${id}'.`, { code: 'AUTO_PLAN_NOT_FOUND' });
  return id;
}

export async function readAutoPlan(root, planIdValue) {
  const planId = validatePlanId(planIdValue);
  const raw = await readAutoPrivateRecord(root, planFile(root, planId), 'plan', { optional: true });
  if (raw == null) {
    throw new SingularityFlowError(`Auto Plan '${planId}' is not available in this repository.`, {
      code: 'AUTO_PLAN_NOT_FOUND'
    });
  }
  let loaded;
  try {
    loaded = readRecord('auto-plan', raw);
  } catch (error) {
    if (error?.code !== 'SCHEMA_VERSION_ARCHIVED') throw error;
    const storedVersion = error.details?.storedVersion ?? null;
    throw new SingularityFlowError(
      `Auto Plan '${planId}' uses retired schema version ${storedVersion ?? 'unknown'} and cannot authorize execution.`,
      {
        code: 'AUTO_PLAN_LEGACY_UNSUPPORTED',
        details: {
          storedVersion,
          nextAction: 'Create and review a new Auto Plan; packet-v2 confirmation is required.'
        },
        cause: error
      }
    );
  }
  const plan = loaded.record;
  if (loaded.storedVersion < currentSchemaVersion('auto-plan')
      || plan.legacyCompatibility != null) {
    throw new SingularityFlowError(
      `Auto Plan '${planId}' uses compatibility schema version ${loaded.storedVersion} and cannot authorize a new flight.`,
      {
        code: 'AUTO_PLAN_LEGACY_UNSUPPORTED',
        details: {
          storedVersion: loaded.storedVersion,
          nextAction: 'Create and review a new Auto Plan; packet-v2 confirmation is required.'
        }
      }
    );
  }
  if (plan.kind !== 'auto-plan' || plan.mode !== 'auto'
      || plan.confirmation?.protocol !== AUTO_PLAN_CONFIRMATION_PROTOCOL
      || plan.planId !== planId || plan.planSha256 !== autoPlanHash(plan)) {
    throw new SingularityFlowError(`Auto Plan '${planId}' failed its integrity check.`, { code: 'AUTO_PLAN_CORRUPT' });
  }
  // Recheck every persisted transport before rendering or executing the Plan. This protects
  // upgraded repositories as well as records copied from another machine.
  try {
    if (plan.bindings?.repository) assertCredentialFreeRemote(plan.bindings.repository);
    for (const repository of plan.repositories ?? []) {
      if (repository.remoteUrl) assertCredentialFreeRemote(repository.remoteUrl);
    }
  } catch (error) {
    throw new SingularityFlowError(`Auto Plan '${planId}' contains an unsafe repository authority.`, {
      code: 'AUTO_PLAN_REMOTE_UNSAFE', cause: error
    });
  }
  return plan;
}
