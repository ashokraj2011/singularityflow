/** Recognize current-generation preparation bytes, never publication or adoption authority. */
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { readPromptGeneration } from './inject.mjs';
import { clarificationRecordRelative, verifyClarificationRecord } from './clarifications.mjs';
import { resolveRepositoryManifest } from './repository-manifest.mjs';

const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;

async function regularContextFile(root, relative) {
  const resolved = await resolveRepositoryManifest(root, relative);
  // No symlinks, including in parent directories, and no unbounded reads. Recovery must not
  // mistake another location's bytes for preparation performed in this Story checkout.
  return !resolved.links.length && resolved.info.size <= MAX_CONTEXT_BYTES;
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
