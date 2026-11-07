/** Existing Git convergence review inside one subject lock; no CLI dispatch or presentation. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { loadStoryAggregate } from '../story-aggregate-read.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import {
  currentConvergenceContext, assertConvergenceSources, assertConvergencePublicationReady,
  missingConvergenceProjectionError
} from '../convergence-context.mjs';
import { assertConvergenceIntegrity } from '../convergence.mjs';
import { advancementBlocked } from '../kernel/phase-policy.mjs';
import { convergenceReviewRoute } from '../convergence-review-route.mjs';
import { readConvergence } from './convergence-projection-read.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';

export function createGitAdvancementPort({ root, notice = () => {}, onContext = () => {} }) {
  return {
    notice,
    async withReview(input, operation) {
      const { config, workflow: selected } = await loadAcceptedStoryExecution(root, input.workId ?? null);
      return withSubjectLock(root, { kind: 'story', id: selected.workItem.id }, async () => {
        const workflow = await loadStoryAggregate(root, config, selected.workItem.id);
        const subject = await currentConvergenceContext(root, config, workflow);
        const projection = await readConvergence(root, subject.itemRelative, subject.iteration);
        if (!projection) throw missingConvergenceProjectionError(workflow, subject);
        const { bindings, facts, settlement } = subject;
        assertConvergenceIntegrity(projection, {
          workId: workflow.workItem.id, iteration: subject.iteration,
          currentBindings: bindings, currentFacts: facts, currentSettlement: settlement
        });
        await assertConvergenceSources(root, projection, { itemRelative: subject.itemRelative });
        // Unsigned adjudications remain undisposed on Stories that require presence assurance.
        const counted = (await import('../presence/counted-convergence.mjs')).countedConvergence(workflow, projection);
        const blocked = advancementBlocked(counted);
        if (blocked.length) {
          const following = workflow.phaseOrder[workflow.phaseOrder.indexOf(subject.phase.id) + 1] ?? null;
          const disposed = new Set((counted.findings ?? []).map(finding => finding.itemId));
          const error = new SingularityFlowError(`Convergence cannot advance${following ? ` to ${following}` : ''}:\n- ${blocked.join('\n- ')}`, {
            code: 'CONVERGENCE_REVIEW_REQUIRED', details: {
              workId: workflow.workItem.id, phase: subject.phase.id, iteration: subject.iteration,
              allowedNext: counted.allowedNext ?? [], unresolvedBlockers: counted.unresolvedBlockers ?? [],
              undisposedItemIds: [...(projection.facts ?? []), ...(projection.candidates ?? [])]
                .filter(item => !disposed.has(item.id)).map(item => item.id)
            }
          });
          const route = convergenceReviewRoute(error, workflow);
          error.details.recoveryCommand = { command: route.command, skill: route.skill };
          throw error;
        }
        const reviewed = await assertConvergencePublicationReady(root, config, workflow, subject.phase);
        // A final convergence phase must already satisfy the terminal gate before offering consent.
        const { endsStory } = await import('../upstream-entry-summary.mjs');
        if (endsStory(workflow, subject.phase)) {
          await (await import('../evidence/terminal.mjs')).assertTerminalReadiness(root, config, workflow);
        }
        const context = {
          root, config, workflow, phase: subject.phase, subject: { kind: 'story', id: workflow.workItem.id },
          review: {
            workId: workflow.workItem.id, phase: subject.phase.id, generation: subject.phase.generation ?? 0,
            iteration: projection.iteration, findings: projection.findings.length,
            reconciliation: projection.bindings.reconciliation.sha256, confirmationDigest: reviewed.snapshotSha256
          }
        };
        onContext(context);
        // The SDK's confirmation and registered submission complete before the native lease ends.
        return operation(context);
      });
    }
  };
}
