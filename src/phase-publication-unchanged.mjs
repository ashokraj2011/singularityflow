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
import { hasPublishedPhaseGeneration, requiresProspectivePhaseInspection } from './phase-inspection-generation.mjs';
import { isConvergencePhase } from './phase-roles.mjs';

export async function documentUnchangedSincePublication(root, config, workflow, phase) {
  if (phase?.status !== 'in_progress' || phaseRequiresCodeDelivery(phase) || isConvergencePhase(phase)
      || !hasPublishedPhaseGeneration(phase) || requiresProspectivePhaseInspection(workflow, phase)) return false;
  try {
    const story = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
    const relative = path.posix.join(story, phase.requiredArtifact.path);
    const commit = publishedGenerationCommit(root, workflow, phase);
    const bytes = commit ? exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024, regularOnly: true }) : null;
    if (!bytes) return false;
    const current = await readFile(path.join(root, relative), 'utf8');
    if (authoredArtifactFingerprint(current) !== authoredArtifactFingerprint(bytes.toString('utf8'))) return false;
    // What a publication would commit is new work under the same words: a capture recorded for the next
    // generation sits in the Story's context, and a step's artifact folder holds more than its one document.
    const folder = `${path.posix.dirname(relative)}/`;
    return !changedFiles(root).some((file) => file !== relative && file.startsWith(`${story}/`))
      && !committedChangedPaths(root, commit).some((file) => file !== relative && file.startsWith(folder));
  } catch { return false; }
}
