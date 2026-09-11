import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists } from './util.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
import {
  validateArchitectureIntent, validateArchitectureIntentFulfilment
} from './world-model/projections/calm/projection.mjs';
import { resolvePublishedWorldModelV4 } from './world-model/store.mjs';

const EMPTY = Object.freeze({ applies: false, errors: [], warnings: [], passes: [] });

function policyFor(definition, workflow) {
  return workflow?.resolution?.architectureIntent ?? definition?.architectureIntent ?? {
    enabled: false, allowedPhases: [], blockRequiredUnfulfilledAt: []
  };
}

function storyArchitecturePath(root, definition, workflow, name) {
  const workItemRoot = workflow?.resolution?.workItemRoot
    ?? definition?.workItemRoot ?? 'singularity/work-items';
  return path.join(root, workItemRoot, workflow.workItem.id, 'context', 'architecture', name);
}

async function jsonFile(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

/**
 * Verify an opted-in Story architecture intent immediately before a configured lifecycle gate.
 *
 * Absence of an intent is not architecture impact and therefore does not create work. Once an
 * intent exists, however, its exact fulfilment receipt must describe the current reusable state
 * projection; an old or blocking receipt can never be carried through verification or release.
 */
export async function evaluateArchitectureIntentGate(root, definition, workflow, phaseId) {
  const policy = policyFor(definition, workflow);
  if (!policy.enabled || !policy.blockRequiredUnfulfilledAt?.includes(phaseId)) return EMPTY;
  const intentPath = storyArchitecturePath(root, definition, workflow, 'architecture-intent.json');
  if (!(await exists(intentPath))) return EMPTY;

  const errors = [];
  let intent;
  try { intent = validateArchitectureIntent(await jsonFile(intentPath)); }
  catch (error) {
    return { applies: true, errors: [`architecture intent is invalid: ${error.message}`], warnings: [], passes: [] };
  }
  if (intent.workId !== workflow.workItem.id) errors.push('architecture intent belongs to another Work ID');
  if (!policy.allowedPhases?.includes(intent.phase)) {
    errors.push(`architecture intent phase '${intent.phase}' is not allowed by the pinned Story policy`);
  }

  const reportPath = storyArchitecturePath(root, definition, workflow, 'intent-fulfilment.json');
  if (!(await exists(reportPath))) {
    errors.push(`architecture intent has no fulfilment receipt; run singularity-flow architecture intent verify --work-id ${workflow.workItem.id}`);
    return { applies: true, errors, warnings: [], passes: [] };
  }
  let report;
  try { report = validateArchitectureIntentFulfilment(await jsonFile(reportPath)); }
  catch (error) {
    errors.push(`architecture intent fulfilment is invalid: ${error.message}`);
    return { applies: true, errors, warnings: [], passes: [] };
  }
  if (report.workId !== workflow.workItem.id || report.intentSha256 !== intent.intentSha256
      || report.baseBeforeSha256 !== intent.base.calmProjectionSha256) {
    errors.push('architecture intent fulfilment does not bind the pinned Story intent and base');
  }

  try {
    const authority = worldModelStateAuthority(definition, {});
    const store = resolvePublishedWorldModelV4(root, {
      outputDir: workflow.resolution?.worldModelOutputDir
        ?? definition.worldModel?.outputDir ?? 'singularity/world-model',
      stateBranch: authority.branch, remote: authority.remote
    });
    const current = store.projections?.find((entry) => entry.projectionId === 'arch.calm'
      && entry.status === 'available');
    if (!current) errors.push('the current reusable World Model has no available arch.calm projection');
    else if (report.baseAfterSha256 !== current.projectionSha256) {
      errors.push(`architecture intent fulfilment is stale for the current projection ${current.projectionSha256}`);
    }
  } catch (error) {
    errors.push(`the current reusable architecture projection cannot be verified: ${error.message}`);
  }

  const verdicts = new Map(report.clauses.map((clause) => [clause.clauseId, clause.verdict]));
  for (const clause of intent.clauses.filter((entry) => entry.required)) {
    const verdict = verdicts.get(clause.clauseId);
    if (verdict !== 'fulfilled') {
      errors.push(`required architecture clause ${clause.clauseId} is ${verdict ?? 'missing from the fulfilment receipt'}`);
    }
  }
  if (report.blocking && !errors.some((message) => message.includes('required architecture clause'))) {
    errors.push('architecture intent fulfilment remains blocking');
  }
  return {
    applies: true,
    errors,
    warnings: [],
    passes: errors.length ? [] : [`architecture intent fulfilled: ${report.reportSha256.slice(0, 19)}`]
  };
}
