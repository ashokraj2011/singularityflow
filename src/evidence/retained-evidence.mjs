/**
 * A later step's commit keeps the retained evidence an approved step published [ws-graph AC-001,
 * 2026-10-27].
 *
 * A code step's delivery records each retained evidence file its plan owes (fulfillment `evidence`)
 * with the SHA-256 of its bytes, and a witness or an approval reads the file from the worktree. Every
 * Story commit stages the whole work directory, so a test that saved its capture straight to that
 * path put new bytes into a later step's submission commit, and nothing said so until the witness
 * was refused at release. Now a later step's publication or submission refuses to change a file an
 * approved step published, naming the published bytes, the committed ones and the two ways on:
 * restore the published image, or have the step that owns the evidence publish a new one. That
 * step's own next generation is the way to a new image: its delivery records the new bytes in the
 * same commit, and its review sees them. Nothing here restores, deletes or adopts a file. Loaded
 * only by a publication or submission; the records and routes it shares with the witness live in
 * verification/witness-records.mjs.
 */
import { CAPTURE_RULE, evidenceDigest, IF_A_TEST, publishedRetainedEvidence, republicationRoute, retainedEvidenceDetails, shortCommit }
  from '../verification/witness-records.mjs';
import { SingularityFlowError } from '../util.mjs';

/**
 * The retained evidence a step's commit would change: each file an approved step other than
 * `phaseId` published, whose bytes in `committed` (path to hex digest; absent when the commit has no
 * such file) differ. `before` holds the worktree digests read before the command ran, so a file
 * changed while it ran (its own test run) is told apart from one changed earlier.
 */
export function retainedEvidenceChanges(workflow, phaseId, committed, before = new Map()) {
  return publishedRetainedEvidence(workflow, { approvedOnly: true, except: phaseId }).flatMap((entry) => {
    const current = committed.has(entry.path) ? evidenceDigest(committed.get(entry.path)) : null;
    if (current === entry.sha256) return [];
    const earlier = before.has(entry.path) ? before.get(entry.path) : undefined;
    const during = earlier !== undefined && earlier !== current;
    // A file the command itself changed is put back by the refused transaction; it needs restoring
    // only when it already differed before.
    return [{ entry, current, during, restore: !during || earlier !== entry.sha256 }];
  });
}

/**
 * Refuse a publication or submission of `phaseId` that would change retained evidence an approved
 * step published (retainedEvidenceChanges). `action` is 'publication' or 'submission'. The prior
 * aggregate decides the routes: a refused transition leaves the step as it was before it.
 */
export function retainedEvidenceChangedRefusal(workflow, phaseId, changes, { action }) {
  const [first] = changes;
  const { entry, current, during, restore } = first;
  // One file may be the evidence of several criteria; it is named once, with each of them.
  const clauses = [...new Set(changes.filter((item) => item.entry.path === entry.path).map((item) => item.entry.clauseId))];
  const others = [...new Set(changes.map((item) => item.entry.path).filter((file) => file !== entry.path))];
  const verb = action === 'submission' ? 'submit' : 'publish';
  const route = republicationRoute(workflow, entry.phase, entry.clauseId, { from: phaseId, submittable: !during });
  const lead = during ? `That test changes in ${entry.phase}, the step that owns this evidence`
    : `To keep a new image, ${entry.phase}, the step that owns this evidence, must publish it again`;
  const text = `${action.charAt(0).toUpperCase()}${action.slice(1)} of ${phaseId} would change retained evidence that ${entry.phase} published: ${entry.path} for ${clauses.join(' and ')}. `
    + `${entry.phase} published ${entry.sha256} in generation ${entry.generation} (commit ${shortCommit(entry.generationCommit)}); `
    + `this ${action} would ${current ? `commit ${current}` : 'delete it'}. Nothing was committed.`
    + (others.length ? ` It would change ${others.join(', ')} too.` : '')
    + (during ? ` The file changed while this ${action} ran, most likely because a test saves its capture to this path: every run replaces it, `
      + `so ${verb === 'submit' ? 'submitting' : 'publishing'} again would be refused again. The file is back to its bytes from before this ${action}.` : '')
    + (restore ? ` To keep the published image, restore it with git restore --source=${entry.generationCommit} -- ${entry.path}, then ${verb} ${phaseId} again.` : '')
    + (during ? ` ${CAPTURE_RULE} ${lead}: ${route.sentence}` : ` ${lead}: ${route.sentence} ${IF_A_TEST}`);
  return new SingularityFlowError(text, { code: 'RETAINED_EVIDENCE_CHANGED',
    details: { ...retainedEvidenceDetails(workflow, changes, route, lead), phase: phaseId } });
}

/**
 * The guard a Story publication or submission of `phaseId` carries: it reads the worktree digest of
 * each protected file now, before the command runs anything, and `assert` compares the exact tree
 * the commit admits with the records the transition leaves. Null for any other event.
 */
export async function retainedEvidenceGuard(root, workflow, event) {
  const action = { 'approval-requested': 'submission', 'artifact-generated': 'publication' }[event?.type];
  const phaseId = event?.phaseId ?? null;
  if (!action || !phaseId || !workflow?.phases?.[phaseId]) return null;
  const [{ createHash }, { readFile }, { secureRepositoryPath }] = await Promise.all([
    import('node:crypto'), import('node:fs/promises'), import('../util.mjs')]);
  const before = new Map();
  for (const file of new Set(publishedRetainedEvidence(workflow, { approvedOnly: true, except: phaseId }).map((entry) => entry.path))) {
    const secured = await secureRepositoryPath(root, file, { label: 'Retained evidence' }).catch(() => null);
    before.set(file, secured?.exists && secured.entry?.isFile()
      ? evidenceDigest(createHash('sha256').update(await readFile(secured.absolute)).digest('hex')) : null);
  }
  return {
    /** `priorWorkflow` is the aggregate before the transition; `workflow` the one it leaves. */
    async assert({ workflow: after, priorWorkflow, event: finalized, prospectiveTree }) {
      if (finalized?.type !== event.type || finalized?.phaseId !== phaseId) return;
      const paths = [...new Set(publishedRetainedEvidence(after, { approvedOnly: true, except: phaseId }).map((entry) => entry.path))];
      if (!paths.length) return;
      const { committedFileDigests } = await import('../git.mjs');
      const changes = retainedEvidenceChanges(after, phaseId, committedFileDigests(root, prospectiveTree, paths), before);
      if (changes.length) throw retainedEvidenceChangedRefusal(priorWorkflow, phaseId, changes, { action });
    }
  };
}
