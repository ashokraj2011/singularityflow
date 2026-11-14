/**
 * Drafts written before an approved intent amendment [SPEC-CIC v1.1 stage 5; CIC:REQ-008 to REQ-011, switch 2].
 *
 * Approving an amendment reopens the first step it resets in place. On a Story whose pinned spec policy has
 * `preAmendmentDrafts: refuse` (new Stories pin it), that step is pinned to the amended scope at the approval: its
 * pending prompt pair, composed for its next generation before the amendment, is set aside with the amendment as the
 * reason (inject.mjs supersedePromptGeneration); its open code generation is closed, so the next `phase begin` opens one
 * under the amended scope; and its draft as it stood is copied, read only, beside them. Publication of that generation
 * then refuses, by records and never by times, a draft whose code generation or composed prompt started under an
 * earlier scope (generation-boundary.mjs generationScope), and an agent's document not composed again since. A text
 * that still holds may be published unchanged (owner, 2026-11-14): its approvers approve it again either way.
 * The way out is in the same step: open it again under the amended scope and write it; the recomposed prompt names
 * the old draft as a read-only reference. A later step the amendment resets is pinned the same way when it still holds
 * unpublished work from before it; a step the amendment kept is never pinned. Loaded only by the approval, the
 * publication and the composer.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { authoredArtifactFingerprint } from './artifact-review-read.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { supersedePromptGeneration } from './inject.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { posix, SingularityFlowError } from './util.mjs';

/** Whether the Story's pinned spec policy refuses drafts written before an approved amendment (switch 2) [CIC:REQ-018]. */
export const refusesPreAmendmentDrafts = (workflow) => workflow?.resolution?.spec?.preAmendmentDrafts === 'refuse';

const approved = (workflow) => (workflow?.intentAmendments ?? []).filter((entry) => ['approved', 'revalidated'].includes(entry?.status)).map((entry) => entry.id);

/**
 * At approval: pin `phase`, the step the amendment reopens, to the amended scope, set its earlier prompt pair aside,
 * close its open code generation, and keep its draft read only. `revision` is the scope revision the amendment
 * recorded (null when the Story records none). Returns the pin, kept on the step as `scopePin`.
 */
export async function pinReopenedStep(root, workflow, phase, { amendment, revision, itemRelative, at }) {
  const generation = nextPhaseGeneration(phase);
  const workDir = path.join(root, itemRelative);
  const setAside = {};
  if (existsSync(path.join(workDir, 'context', `${phase.id}-gen${generation}.json`))) {
    setAside.prompt = (await supersedePromptGeneration(root, workflow, phase, { workDir },
      `Set aside by ${amendment}: composed before the amended scope.`)).directory;
  }
  const kept = posix(path.join(itemRelative, 'context', 'superseded', `${phase.id}-gen${generation}-before-${amendment}`));
  const keep = async (from, name) => {
    await mkdir(path.join(root, kept), { recursive: true });
    await copyFile(from, path.join(root, kept, name));
    return `${kept}/${name}`;
  };
  const intent = phase.generationIntent;
  if (intent?.status === 'open') {
    // Its start receipt is kept beside the draft: the next `phase begin` writes that generation's receipt again.
    const receipt = intent.path && existsSync(path.join(root, intent.path)) ? await keep(path.join(root, intent.path), 'generation-start.json') : intent.path;
    Object.assign(intent, { status: 'superseded', supersededBy: amendment, supersededAt: at, path: receipt });
    setAside.intent = intent.id;
  }
  let draft = null;
  const artifact = phase.requiredArtifact?.path ? path.join(workDir, phase.requiredArtifact.path) : null;
  const text = artifact ? await readFile(artifact, 'utf8').catch(() => null) : null;
  if (text !== null) {
    draft = { path: await keep(artifact, path.basename(artifact)), artifact: posix(path.relative(root, artifact)), sha256: authoredArtifactFingerprint(text) };
  }
  phase.scopePin = { amendment, generation, revision: revision?.revision ?? null, revisionSha256: revision?.revisionSha256 ?? null, at,
    ...(Object.keys(setAside).length ? { setAside } : {}), ...(draft ? { draft } : {}) };
  return phase.scopePin;
}

/**
 * At approval, over the steps it resets in order: pin the one it reopens in place, and each later one still holding work
 * from before the amendment that is not published (an open code generation or a composed prompt for its next generation).
 */
export async function pinResetSteps(root, workflow, reset, options) {
  for (const [index, id] of reset.entries()) {
    const phase = workflow.phases[id];
    const pending = phase.generationIntent?.status === 'open'
      || existsSync(path.join(root, options.itemRelative, 'context', `${id}-gen${nextPhaseGeneration(phase)}.json`));
    if (index === 0 || pending) await pinReopenedStep(root, workflow, phase, options);
  }
}

/** Whether a generation's recorded start scope is the pinned one or a later one, by revision digest, else by amendment. */
function startsUnder(workflow, pin, scope) {
  if (!scope) return false;
  if (pin.revisionSha256) {
    const chain = (workflow.scopeRevisions ?? []).map((entry) => entry.revisionSha256);
    const pinned = chain.indexOf(pin.revisionSha256);
    return pinned >= 0 && chain.indexOf(scope.revisionSha256) >= pinned;
  }
  const order = approved(workflow);
  const pinned = order.indexOf(pin.amendment);
  return pinned >= 0 && order.indexOf(scope.amendment) >= pinned;
}

/**
 * At publication [CIC:REQ-009]: refuse the pinned generation of a reopened step when its code generation or its composed
 * prompt is from before the amendment, or when an agent wrote its document without composing it again since. A person's
 * own text, and an agent's composed again, may be the old draft's unchanged (owner, 2026-11-14). Nothing is rebased;
 * the refusal names the step's own way out.
 */
export async function assertDraftPostdatesAmendment(root, workflow, phase, { itemRelative, producer = 'legacy-unspecified' }) {
  const pin = phase?.scopePin;
  const generation = nextPhaseGeneration(phase);
  if (!pin || Number(pin.generation) !== generation) return;
  const code = phaseRequiresCodeDelivery(phase);
  const reasons = [];
  const intent = phase.generationIntent;
  if (code && !(intent?.status === 'open' && Number(intent.generation) === generation && startsUnder(workflow, pin, intent.scopeRevision))) reasons.push('generation');
  const receipt = await readFile(path.join(root, itemRelative, 'context', `${phase.id}-gen${generation}.json`), 'utf8').then(JSON.parse, () => null);
  if (receipt ? !startsUnder(workflow, pin, receipt.scopeRevision) : Boolean(pin.setAside?.prompt)) reasons.push('prompt');
  // A model's document reads the amended scope only through a prompt composed under it (state.mjs modelAssisted).
  else if (!receipt && !code && MODEL_ASSISTED.has(producer)) reasons.push('uncomposed');
  if (reasons.length) throw preAmendmentDraftRefusal(workflow, phase, pin, reasons);
}

const MODEL_ASSISTED = new Set(['governed-agent', 'legacy-unspecified']);

const REASON_WORDS = Object.freeze({
  generation: 'its code generation was opened before',
  prompt: 'its prompt was composed before',
  uncomposed: 'it has not been composed again since'
});

/** The refusal, with the step's own way out [PHR:REQ-006]: open it again under the amended scope, in this step. */
export function preAmendmentDraftRefusal(workflow, phase, pin, reasons) {
  const workId = workflow.workItem.id;
  const code = phaseRequiresCodeDelivery(phase);
  const compose = `singularity-flow phase enter ${phase.id} --work-id ${workId} --compose --for-agent --json`;
  const begin = `singularity-flow phase begin ${phase.id} --work-id ${workId} --json`;
  // Each command with the skill its route crosswalk names: a code step's begin is /sf-code's, a composition the entry's.
  const actions = [
    ...(reasons.includes('generation') ? [{ command: begin, skill: '/sf-code', detail: `Open ${phase.id}'s code generation again under the amended scope.` }] : []),
    { command: compose, detail: `Compose ${phase.id} again under the amended scope, and write it from that prompt.` }
  ];
  const scope = `${pin.amendment} amended the scope${pin.revision ? ` (scope revision ${pin.revision})` : ''}`;
  return new SingularityFlowError(`${phase.id} cannot publish this draft: ${reasons.map((reason) => REASON_WORDS[reason]).join(', and ')} ${scope}. `
    + `Write it again here, in ${phase.id}, under the amended scope: ${actions.map((action) => action.command).join(', then ')}.`
    + `${pin.draft ? ` The earlier draft is kept read only at ${pin.draft.path}; keep from it only what still holds under the amended scope.` : ''}`, {
    code: 'PHASE_DRAFT_PREDATES_AMENDMENT',
    details: { workId, phase: phase.id, amendment: pin.amendment, revision: pin.revision, reasons, readOnlyDraft: pin.draft?.path ?? null,
      ...(code ? { codeStep: true } : {}), actions, nextAction: { command: actions[0].command, ...(actions[0].skill ? { skill: actions[0].skill } : {}), label: actions[0].detail } }
  });
}

/**
 * The recomposed prompt's read-only reference to the old draft [CIC:REQ-008]: its exact path, marked as written before
 * the amendment, kept only where it still holds under the amended scope. Empty when the step is not pinned or has no old draft.
 */
export function preAmendmentDraftSection(workflow, phase) {
  const pin = phase?.scopePin;
  if (!refusesPreAmendmentDrafts(workflow) || !pin?.draft || Number(pin.generation) !== nextPhaseGeneration(phase)) return '';
  return [`## Draft written before ${pin.amendment} (read only)`, '',
    `\`${pin.draft.path}\` is this step's draft as it stood when ${pin.amendment} amended the scope${pin.revision ? ` (scope revision ${pin.revision})` : ''}. `
    + 'Read it only as a reference: write this step against the amended scope, and keep from it only what still holds under it.', ''].join('\n');
}
