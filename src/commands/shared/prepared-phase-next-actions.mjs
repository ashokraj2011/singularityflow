/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { action as narrationAction } from '../../narration/command-result.mjs';
import { convergencePreparationState } from './convergence-preparation-state.mjs';
import { phaseKernelOwned } from '../../code-delivery-policy.mjs';
import { actionCommandLine, actionSkill } from '../../action-command-map.mjs';
import { phasePublicationCommandForProducer, phasePublicationContract } from '../../manual-authorship.mjs';

const ITEMS_NAMED = 8;

/** Exact post-preparation actions; deterministic convergence cannot be published before review. */
export function preparedPhaseNextActions(workflow, phase, prepared) {
  const inputs = narrationAction({
    id: 'prepare.inputs',
    label: 'See the approved upstream decisions this phase was given',
    command: `singularity-flow inputs ${phase.id}`,
    rank: 'LATER'
  });
  const convergence = convergencePreparationState(prepared.convergence);
  // After preparation: the check, and for a step SFlow builds its publication once ready, by the step's own work command.
  // The kernel's publish-version, in the action-to-command map's form for who built the draft [OSA:REQ-021].
  const ownedBy = phaseKernelOwned(phase);
  const check = actionCommandLine('publish-version', prepared.publicationProducer !== 'deterministic' ? 'draft' : ownedBy ? 'prepublish' : 'check',
    { step: phase.id, workId: workflow.workItem.id });
  const author = actionSkill('publish-version', { phase, workflow });
  if (!convergence) return [
    narrationAction({
      id: 'prepare.author',
      // After preparation the next step is authoring, never preparation again: the Copilot route is
      // the step's authoring skill, and the terminal route checks the draft once it is written.
      // A deterministic code step still has its code to write; only its summary is kernel-built.
      // A step SFlow builds is checked and published by its own work command in the same turn, as the kernel's
      // build-version then publish-version says [D5, OSA:REQ-020, REQ-026, C9]: never handed to another skill.
      label: prepared.publicationProducer === 'deterministic' && !ownedBy
        ? 'Write the planned code and tests; SFlow rebuilds the summary'
        : prepared.publicationProducer === 'deterministic'
        ? 'Check what SFlow prepared, and publish it once its checks pass'
        : 'Author the prepared draft (preparation is not completed authoring), then check it with prepublish',
      command: check,
      skill: author
    }),
    inputs
  ];

  if (convergence.undisposedItemIds.length) {
    const itemId = convergence.undisposedItemIds[0];
    // Every item, by ID and path, so the person decides from this step alone; only the first one used to
    // be named, with a count.
    const items = [...(prepared.convergence.facts ?? []), ...(prepared.convergence.candidateSnapshot ?? [])]
      .filter((item) => convergence.undisposedItemIds.includes(item.id));
    const named = items.slice(0, ITEMS_NAMED).map((item) => `${item.id} ${item.kind ?? 'item'}${item.paths?.length ? `: ${item.paths.join(', ')}` : ''}`);
    return [
      narrationAction({
        id: 'convergence.adjudicate',
        label: `A person decides each of ${items.length || convergence.undisposedItemIds.length} convergence item(s): ${named.join('; ') || itemId}`
          + `${items.length > named.length ? `; and ${items.length - named.length} more` : ''}`,
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
      // The draft from these decisions gives the whole command that proposes it.
      command: `singularity-flow story intent-amendment draft --work-id ${workflow.workItem.id}`,
      kind: 'review'
    }),
    inputs
  ];
  if (convergence.unresolvedBlockers.length) return [
    narrationAction({
      id: 'convergence.inspect',
      label: 'See what blocks the convergence report',
      command: `singularity-flow story converge --work-id ${workflow.workItem.id} --json`,
      kind: 'review'
    }),
    inputs
  ];
  return [
    narrationAction({
      id: 'convergence.publish',
      label: 'Publish the reviewed convergence report',
      // The step's own work command checks and publishes it in the same turn, never /sf-publish (C9): the kernel's
      // build-version then publish-version, one route for the agent and every view [D5, OSA:REQ-020, REQ-026].
      command: prepared.publicationProducer === 'deterministic' && ownedBy ? check
        : phasePublicationCommandForProducer(phase, prepared.publicationProducer ?? phasePublicationContract(phase).producer),
      skill: author
    }),
    inputs
  ];
}
