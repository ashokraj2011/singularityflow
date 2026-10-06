/** Recognize current-generation preparation bytes, never publication or adoption authority. */
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { readPromptGeneration } from './inject.mjs';
import { clarificationRecordRelative, verifyClarificationRecord } from './clarifications.mjs';
import { resolveRepositoryManifest } from './repository-manifest.mjs';
import { readBoundSpecificationClaimMap } from './specifications.mjs';

const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;

async function regularContextFile(root, relative) {
  const resolved = await resolveRepositoryManifest(root, relative);
  // No symlinks, including in parent directories, and no unbounded reads. Recovery must not
  // mistake another location's bytes for preparation performed in this Story checkout.
  return !resolved.links.length && resolved.info.size <= MAX_CONTEXT_BYTES;
}

/**
 * Exact evidence files allocated by an approved, committed planning claim map belong to the
 * open phase's draft. This is routing ownership only, not passing evidence or publication
 * authority. Never admit an evidence directory wholesale or trust prose in a dirty draft.
 */
export async function expectedPhaseEvidencePaths(root, config, workflow, phase, {
  itemRoot, generation, changedPaths
}) {
  if (generation !== nextPhaseGeneration(phase)) return [];
  const prefix = `${itemRoot}/evidence/`;
  const candidates = changedPaths.filter(relative => relative.startsWith(prefix));
  if (!candidates.length) return [];
  const ownerId = workflow.resolution?.plannedClaims?.owners?.[phase.id];
  const owner = workflow.phases?.[ownerId];
  const order = workflow.phaseOrder ?? [];
  if (!owner || owner.status !== 'approved' || !(owner.generation > 0)
      || order.indexOf(ownerId) < 0 || order.indexOf(phase.id) <= order.indexOf(ownerId)) return [];
  let plan;
  try {
    plan = await readBoundSpecificationClaimMap(root, path.join(root, itemRoot), workflow, owner, 'planned', {
      policy: workflow.resolution?.spec ?? config.spec ?? {}, requireCommitted: true
    });
  } catch { return []; }
  const declared = new Set(Object.values(plan.claims ?? {})
    .filter(claim => !(claim.steps ?? []).length || claim.steps.includes(phase.id))
    .flatMap(claim => claim.expectedPaths ?? []));
  const expected = [];
  for (const relative of candidates) {
    if (!declared.has(relative)) continue;
    try {
      if (await regularContextFile(root, relative)) expected.push(relative);
    } catch { /* Missing, linked, oversized or unsafe evidence stays manual. */ }
  }
  return expected;
}

/**
 * Inspect only the exact paths written by prompt composition and clarification recording.
 * The existing validators own identity and hash checks. Do not run another World Model scan,
 * fetch, compose, record, or commit just to classify a dirty worktree for recovery routing.
 */
export async function expectedPreparationContextPaths(root, config, workflow, phase, {
  itemRoot, generation, changedPaths
}) {
  const expected = [];
  if (generation !== nextPhaseGeneration(phase)) return expected;
  const recordPath = `${itemRoot}/context/${phase.id}-gen${generation}.json`;
  const promptPath = `${itemRoot}/context/prompts/${phase.id}-gen${generation}.md`;
  const clarificationPath = clarificationRecordRelative(config, workflow, phase, generation);
  if (![recordPath, promptPath, clarificationPath].some(relative => changedPaths.includes(relative))) {
    return expected;
  }

  let composed;
  try {
    if (!await regularContextFile(root, recordPath) || !await regularContextFile(root, promptPath)) return expected;
    composed = await readPromptGeneration(root, workflow, phase, {
      workDir: path.join(root, itemRoot)
    });
    const agents = workflow.resolution?.agents ?? config.agents ?? {};
    if (!composed?.record.agent || !Object.hasOwn(agents, composed.record.agent)) return expected;
    expected.push(recordPath, promptPath);
  } catch {
    // Missing, unsupported, malformed, interrupted, or hash-mismatched pairs remain manual.
    return expected;
  }

  if (changedPaths.includes(clarificationPath)) {
    try {
      if (!await regularContextFile(root, clarificationPath)) return expected;
      const checked = await verifyClarificationRecord(root, config, workflow, phase, {
        generation, groundingRecord: composed.record
      });
      if (!checked.errors.length && checked.record?.agent === composed.record.agent
          && checked.record.promptPath === promptPath) expected.push(clarificationPath);
    } catch {
      // A valid prompt pair does not waive review of an invalid clarification record.
    }
  }
  return expected;
}
