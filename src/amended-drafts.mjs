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
 * unpublished work from before it; a step the amendment kept is never pinned. Loaded by the approval, the
 * publication, the composer, and the document-step checks below.
 *
 * A later code step's closed generation keeps its code in the working tree, recorded at the closure path by path with
 * each content digest (owner, 2026-11-14). An earlier document step the amendment reopened does not count exactly that
 * code against itself while its bytes match the record and the generation stays closed; the code step's next
 * `phase begin` carries exactly that code. A return to an earlier step records a code step's open, unpublished
 * generation the same way. Anything else is refused as before.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { authoredArtifactFingerprint } from './artifact-review-read.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { supersedePromptGeneration } from './inject.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { buildRepositoryChangeSet, compareRepositoryIdentity, evaluateProtectedPaths, evaluateSourceBoundary } from './repository-change-set.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { posix, SingularityFlowError } from './util.mjs';
import { applicationChangeSetProjection, applicationPathContext } from './work-intervals.mjs';
import { storyLocation } from './story-paths.mjs';

/** Whether the Story's pinned spec policy refuses drafts written before an approved amendment (switch 2) [CIC:REQ-018]. */
export const refusesPreAmendmentDrafts = (workflow) => workflow?.resolution?.spec?.preAmendmentDrafts === 'refuse';

const approved = (workflow) => (workflow?.intentAmendments ?? []).filter((entry) => ['approved', 'revalidated'].includes(entry?.status)).map((entry) => entry.id);

/**
 * At approval: pin `phase`, the step the amendment reopens, to the amended scope, set its earlier prompt pair aside,
 * close its open code generation, and keep its draft read only. `revision` is the scope revision the amendment
 * recorded (null when the Story records none). Returns the pin, kept on the step as `scopePin`.
 */
export async function pinReopenedStep(root, workflow, phase, { amendment, revision, itemRelative, at, config = null }) {
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
  let closedChangeSet = null;
  if (intent?.status === 'open') {
    // Its start receipt is kept beside the draft: the next `phase begin` writes that generation's receipt again.
    const receiptFile = intent.path ? storyLocation(root, workflow, workflow.workItem.id).fromRecord(intent.path) : null;
    const receipt = receiptFile && existsSync(receiptFile) ? await keep(receiptFile, 'generation-start.json') : intent.path;
    // The code it holds, as the generation boundary sees it from the same baseline: what stays for this step.
    if (config && intent.baseline?.commit) {
      const held = await heldCode(root, config, workflow, phase, intent.baseline.commit);
      closedChangeSet = { intent: intent.id, baseCommit: intent.baseline.commit, paths: recorded(held) };
    }
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
    ...(Object.keys(setAside).length ? { setAside } : {}), ...(draft ? { draft } : {}), ...(closedChangeSet ? { closedChangeSet } : {}) };
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

/**
 * The code a code step's generation holds from `baseCommit`, from the change set the generation boundary builds: each
 * application path it reaches with its content (`missing` where the change removed it). A protected or out-of-boundary
 * path, or anything but a file or link, is never held, since `phase begin` refuses it; `other` lists those paths.
 */
function heldPaths(config, workflow, phase, changeSet) {
  const guards = [...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])];
  const refused = new Set([...evaluateProtectedPaths(changeSet, guards).violations, ...evaluateSourceBoundary(changeSet,
    phase.sourceBoundary ?? 'unrestricted', { phaseId: phase.id, allowedPath: isTestAutomationPath }).violations].map((entry) => entry.path));
  const held = new Map();
  const other = [];
  for (const entry of changeSet.entries) {
    const ends = [entry.oldPath, entry.newPath].filter(Boolean);
    const kind = entry.newContent?.kind ?? 'missing';
    if (ends.some((file) => refused.has(file)) || !['regular-file', 'symlink', 'missing'].includes(kind)) { other.push(...ends); continue; }
    if (entry.oldPath && entry.oldPath !== entry.newPath && entry.status !== 'copied') held.set(entry.oldPath, { kind: 'missing', sha256: null });
    if (entry.newPath) held.set(entry.newPath, { kind, sha256: entry.newContent?.sha256 ?? null });
  }
  return { held, other };
}

async function heldCode(root, config, workflow, phase, baseCommit) {
  const changeSet = applicationChangeSetProjection(await buildRepositoryChangeSet(root, { baseCommit,
    subject: { workId: workflow.workItem.id, phase: phase.id, generation: nextPhaseGeneration(phase), generationIntentId: null } }),
  applicationPathContext(config, workflow));
  return heldPaths(config, workflow, phase, changeSet).held;
}

const recorded = (held) => [...held].map(([file, content]) => ({ path: file, ...content })).sort((left, right) => compareRepositoryIdentity(left.path, right.path));
const sameContent = (left, right) => Boolean(left && right) && left.kind === right.kind && left.sha256 === right.sha256;

/**
 * The later code steps holding code recorded for them, while the recorded generation is unchanged: one an amendment closed
 * (`scopePin.closedChangeSet`, still superseded), or one a return to an earlier step left open and unpublished (`heldCode`).
 */
function heldCodeRecords(workflow, phase) {
  const order = workflow.phaseOrder ?? [];
  return order.slice(order.indexOf(phase.id) + 1).map((id) => workflow.phases?.[id]).flatMap((step) => {
    const intent = step?.generationIntent;
    if (!intent || Number(intent.generation) !== nextPhaseGeneration(step)) return [];
    const record = intent.status === 'superseded' ? step.scopePin?.closedChangeSet : intent.status === 'open' ? step.heldCode : null;
    return record?.intent === intent.id ? [{ step, record, by: record.by ?? step.scopePin?.amendment }] : [];
  });
}

/**
 * Of the `paths` a document step found changed, those it still answers for [owner, 2026-11-14]: a path recorded for a
 * later code step, with the same bytes now, while that step's recorded generation is unchanged, is that step's and stays
 * in place for it. `changed` names the recorded paths whose bytes moved since. Nothing is excluded with switch 2 off,
 * for a code step, or when the change set cannot be read.
 */
export async function withoutHeldCode(root, config, workflow, phase, paths) {
  if (!refusesPreAmendmentDrafts(workflow) || phaseRequiresCodeDelivery(phase) || !paths.length) return { paths, changed: [] };
  const excluded = new Set();
  const changed = [];
  for (const { step, record, by } of heldCodeRecords(workflow, phase)) {
    const now = await heldCode(root, config, workflow, step, record.baseCommit).catch(() => new Map());
    for (const entry of record.paths ?? []) {
      if (!paths.includes(entry.path)) continue;
      if (sameContent(now.get(entry.path), entry)) excluded.add(entry.path);
      else changed.push({ path: entry.path, step: step.id, by });
    }
  }
  return { paths: paths.filter((file) => !excluded.has(file)), changed: changed.filter((entry) => !excluded.has(entry.path)) };
}

/** Every path the document step `phase` leaves in place for a later code step, as withoutHeldCode reads it. */
export async function heldCodePaths(root, config, workflow, phase) {
  const files = [...new Set(heldCodeRecords(workflow, phase).flatMap(({ record }) => (record.paths ?? []).map((entry) => entry.path)))];
  const { paths } = await withoutHeldCode(root, config, workflow, phase, files);
  return new Set(files.filter((file) => !paths.includes(file)));
}

/** The words a document step's refusal adds for recorded code whose bytes moved after it was left in place. */
export function heldCodeChangedWords(changed) {
  if (!changed.length) return '';
  const { step, by } = changed[0];
  return ` ${changed.map((entry) => entry.path).join(', ')} changed after ${by} left ${step}'s code in place for it, so this step answers for it: `
    + `put back the bytes recorded then, or set it aside; ${step} picks up only that code.`;
}

/**
 * At a return to an earlier step (rejectPhase): each later code step it resets whose generation is open and unpublished
 * keeps its code in place, recorded as an amendment's closure records it, so an earlier document step is not stalled by
 * it; the step picks it up in that same open generation when the Story reaches it again [owner, 2026-11-14].
 */
export async function holdReturnedCode(root, config, workflow, reopened, by) {
  if (!refusesPreAmendmentDrafts(workflow)) return;
  for (const id of reopened.slice(1)) {
    const phase = workflow.phases[id];
    const intent = phase?.generationIntent;
    delete phase.heldCode;
    if (!phaseRequiresCodeDelivery(phase) || intent?.status !== 'open' || Number(intent.generation) !== nextPhaseGeneration(phase) || !intent.baseline?.commit) continue;
    const held = await heldCode(root, config, workflow, phase, intent.baseline.commit);
    if (held.size) phase.heldCode = { by, intent: intent.id, baseCommit: intent.baseline.commit, paths: recorded(held) };
  }
}

/**
 * At `phase begin` of a code step whose generation an amendment closed [owner, 2026-11-14]: it carries exactly the code
 * the closure recorded, the paths a reopened document step left in place for it, and nothing else unless a person adopts
 * the whole change set. A path changed since, or new code, is refused here, in this step, with its way out.
 */
export function assertCarriesClosedCode(config, workflow, phase, changeSet, details) {
  const record = phase.scopePin?.closedChangeSet;
  if (!record || record.intent !== phase.generationIntent?.id) return;
  const byPath = new Map((record.paths ?? []).map((entry) => [entry.path, entry]));
  const { held, other } = heldPaths(config, workflow, phase, changeSet);
  const moved = [...new Set([...other, ...[...held].filter(([file, content]) => !sameContent(byPath.get(file), content)).map(([file]) => file)])].sort();
  if (!moved.length) return;
  const adopt = `singularity-flow phase begin ${phase.id} --adopt-existing --confirm ${changeSet.digest}`;
  throw new SingularityFlowError(`${phase.id} carries only the code its generation held when ${phase.scopePin.amendment} closed it, `
    + `and ${moved.join(', ')} changed since. Put back the bytes that generation held there, or set them aside with singularity-flow recover ${workflow.workItem.id} --json, then begin again; `
    + `or, once a person has reviewed the whole change set, adopt it: ${adopt}`, {
    code: 'GENERATION_DIRTY_START',
    details: { ...details, phase: phase.id, changedSinceClosure: moved, closedBy: phase.scopePin.amendment,
      nextAction: { command: `singularity-flow recover ${workflow.workItem.id} --json`, skill: '/sf-recover',
        label: `Review changes since ${phase.scopePin.amendment} closed ${phase.id}: restore or set them aside` } }
  });
}

/**
 * Whether `changeSet`, a code step's application change set from its closed generation's baseline, is exactly the code
 * the closure recorded and nothing else: what its own `phase begin` carries (assertCarriesClosedCode) with nothing to
 * adopt, so recovery routes there, not to a commit of the code [paid run, 2026-11-14].
 */
export function carriesExactlyClosedCode(config, workflow, phase, changeSet) {
  const record = phase?.scopePin?.closedChangeSet;
  if (!record || record.intent !== phase.generationIntent?.id || !changeSet?.entries?.length) return false;
  const byPath = new Map((record.paths ?? []).map((entry) => [entry.path, entry]));
  const { held, other } = heldPaths(config, workflow, phase, changeSet);
  return !other.length && [...held].every(([file, content]) => sameContent(byPath.get(file), content));
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
