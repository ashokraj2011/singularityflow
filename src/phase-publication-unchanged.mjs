/**
 * Whether a document step's draft is exactly what it last published, so another publish would record
 * nothing new. A code step has its own idempotent retry, bound to its result digest. Only a step in
 * progress with a current publication counts: one that was returned, or whose inputs moved, needs its
 * next generation even with the same words (phaseNeedsGeneration). Lifecycle metadata aside, as the rest of
 * recovery compares a published document. Any doubt answers false, and the publish goes ahead as before.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { authoredArtifactFingerprint } from './artifact-review-read.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { changedFiles, committedChangedPaths, exactFileAtObject } from './git.mjs';
import { hasPublishedPhaseGeneration, requiresProspectivePhaseInspection } from './phase-generation-need.mjs';
import { isConvergencePhase } from './phase-roles.mjs';
import { storyLocation } from './story-paths.mjs';

/** A document step in progress with a publication: its document's path, the published text and the current one; else null. */
async function publishedAndCurrent(root, config, workflow, phase) {
  if (phase?.status !== 'in_progress' || phaseRequiresCodeDelivery(phase) || isConvergencePhase(phase) || !hasPublishedPhaseGeneration(phase)) return null;
  const story = storyLocation(null, config, workflow.workItem.id).prefix;
  const relative = path.posix.join(story, phase.requiredArtifact.path);
  const commit = publishedGenerationCommit(root, workflow, phase);
  const bytes = commit ? exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024, regularOnly: true }) : null;
  if (!bytes) return null;
  return { story, relative, commit, published: bytes.toString('utf8'), current: await readFile(path.join(root, relative), 'utf8') };
}

export async function documentUnchangedSincePublication(root, config, workflow, phase) {
  try {
    const read = phase?.status === 'in_progress' && !requiresProspectivePhaseInspection(workflow, phase) ? await publishedAndCurrent(root, config, workflow, phase) : null;
    if (!read) return false;
    const { story, relative, commit } = read;
    if (authoredArtifactFingerprint(read.current) !== authoredArtifactFingerprint(read.published)) return false;
    // What a publication would commit is new work under the same words: a capture recorded for the next
    // generation sits in the Story's context, and a step's artifact folder holds more than its one document.
    const folder = `${path.posix.dirname(relative)}/`;
    return !changedFiles(root).some((file) => file !== relative && file.startsWith(`${story}/`))
      && !committedChangedPaths(root, commit).some((file) => file !== relative && file.startsWith(folder));
  } catch { return false; }
}

/**
 * The step's document, when its authored text was edited after its publication: its path in the step, or null (unchanged,
 * not a published document step, or any doubt). An edit is its own reason for the next version, as changed code files
 * are: the preview asks the person in SFlow's words, and nothing is kept as theirs (review of the opening flow, 2026-11-17).
 */
export async function documentEditedSincePublication(root, config, workflow, phase) {
  try {
    const read = await publishedAndCurrent(root, config, workflow, phase);
    return read && authoredArtifactFingerprint(read.current) !== authoredArtifactFingerprint(read.published) ? phase.requiredArtifact.path : null;
  } catch { return null; }
}
