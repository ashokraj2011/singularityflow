/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { action as narrationAction } from '../../narration/command-result.mjs';
import { convergencePreparationState } from './convergence-preparation-state.mjs';
import { generationSkillForPhase } from '../../code-delivery-policy.mjs';
import { phasePublicationCommandForProducer, phasePublicationContract } from '../../manual-authorship.mjs';

/** Exact post-preparation actions; deterministic convergence cannot be published before review. */
export function preparedPhaseNextActions(workflow, phase, prepared) {
  const inputs = narrationAction({
    id: 'prepare.inputs',
    label: 'See the approved upstream decisions this phase was given',
    command: `singularity-flow inputs ${phase.id}`,
    rank: 'LATER'
  });
  const convergence = convergencePreparationState(prepared.convergence);
  if (!convergence) return [
    narrationAction({
      id: 'prepare.author',
      // After preparation the next step is authoring, never preparation again: the Copilot route is
      // the step's authoring skill, and the terminal route checks the draft once it is written.
      label: prepared.publicationProducer === 'deterministic'
        ? 'Check the prepared deterministic artifact before publication'
        : 'Author the prepared draft (preparation is not completed authoring), then check it with prepublish',
      command: prepared.publicationProducer === 'deterministic'
        ? `singularity-flow phase prepublish ${phase.id} --for-agent --json`
        : `singularity-flow phase prepublish ${phase.id}`,
      skill: prepared.publicationProducer === 'deterministic'
        ? '/sf-publish'
        : generationSkillForPhase(phase, workflow)
    }),
    inputs
  ];

  if (convergence.undisposedItemIds.length) {
    const itemId = convergence.undisposedItemIds[0];
    return [
      narrationAction({
        id: 'convergence.adjudicate',
        label: `Review and disposition ${itemId}; ${convergence.undisposedItemIds.length} item(s) remain`,
      command: `singularity-flow story adjudicate ${itemId} --disposition <rework|update-intent|accepted-deviation|dismissed|deferred> --reason <reason> [--clause <CLAUSE-ID> ...]`,
        kind: 'review'
      }),
      inputs
    ];
  }
  if (convergence.allowedNext.includes('create-rework')) return [
    narrationAction({
      id: 'convergence.rework',
      label: 'Preview the bounded rework required by the convergence decisions',
      command: 'singularity-flow story rework',
      kind: 'review'
    }),
    inputs
  ];
  if (convergence.allowedNext.includes('propose-intent-amendment')) return [
    narrationAction({
      id: 'convergence.intent-amendment',
      label: 'Propose the intent amendment required by the convergence decisions',
      command: 'singularity-flow story intent-amendment propose --file <AMENDED-SPEC.md> --reason <reason>',
      kind: 'review'
    }),
    inputs
  ];
  if (convergence.unresolvedBlockers.length) return [
    narrationAction({
      id: 'convergence.inspect',
      label: 'Inspect the blocked deterministic convergence projection',
      command: `singularity-flow story converge --work-id ${workflow.workItem.id} --json`,
      kind: 'review'
    }),
    inputs
  ];
  return [
    narrationAction({
      id: 'convergence.publish',
      label: 'Publish the reviewed deterministic convergence projection',
      command: phasePublicationCommandForProducer(
        phase, prepared.publicationProducer ?? phasePublicationContract(phase).producer
      ),
      skill: generationSkillForPhase(phase, workflow)
    }),
    inputs
  ];
}
