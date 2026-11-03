/**
 * The human visual and inspection reviews a Story recorded, read back for the steps that report on
 * them [E2G-018].
 *
 * `decision witness` appends one record to the Story's `witnessRecords`: who looked at which exact
 * file (bound by its SHA-256) for which criterion slot, their checklist answers and their note. A
 * later report that never saw the record wrote that no human visual review existed. This reads the
 * records the Story already holds, never a model's recollection: the latest record of each
 * criterion slot (records are append-only, so a newer one replaces an older one), whether its file
 * still has the bound bytes, and whether the plan or code candidate changed after it was recorded,
 * the same two checks the evidence matrix applies. Only recorded fields are returned; a field the
 * record does not hold is left out, never filled in. Reading changes nothing.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { recordSha256 } from '../records.mjs';
import { countedRecords } from '../presence/counted.mjs';
import { secureRepositoryPath } from '../util.mjs';
import { witnessContextBindings, applicationReviewWitnesses } from './witness-records.mjs';
import { approvedInputPhases } from '../phase-input-policy.mjs';
import {
  isConformancePhase, isTestEvidencePhase, isVisualVerificationPhase, stepResponsibilities
} from '../phase-roles.mjs';

export const WITNESS_DECISIONS_REVISION = 'recorded-visual-reviews-v1';
export const WITNESS_DECISIONS_HEADING = '# Recorded human visual reviews';
const LIMIT = 50;

export const WITNESS_DECISIONS_INSTRUCTION = 'These are the human visual and inspection reviews this Story recorded with decision witness, each bound to the SHA-256 of one file. Report them as recorded: where a valid review satisfies a criterion, do not say that criterion lacks human visual review or acceptance; cite its record ID. A review whose bound file or code candidate changed after it was recorded is not valid: say so, and that the criterion needs a new review. Never infer a review that is not listed here.';

/** The latest record of each criterion slot, in the order the evidence matrix reads them. */
function activeRecords(records = []) {
  const latest = new Map();
  for (const record of records) latest.set(`${record.clauseId}\u0000${record.slot}`, record);
  return [...latest.values()];
}

/**
 * Each active witness decision, judged against `currentSha256` (file -> digest of its bytes now, or
 * null when it cannot be read; a file absent from the map is reported unchecked). Pure.
 */
export function witnessDecisionsFrom(workflow, currentSha256 = new Map()) {
  const contextBindings = new Set(witnessContextBindings(workflow ?? {}));
  return activeRecords(countedRecords(workflow, workflow?.witnessRecords)).map((record) => {
    const current = currentSha256.has(record.file) ? currentSha256.get(record.file) : undefined;
    const binding = current === undefined ? 'unchecked'
      : current == null ? 'bound-file-unreadable'
        : current === record.sha256 ? 'bound-file-unchanged' : 'bound-file-changed';
    const candidate = !record.contextBinding ? 'not-recorded'
      : contextBindings.has(record.contextBinding) ? 'unchanged' : 'changed';
    const answeredNo = Object.entries(record.checklist ?? {}).filter(([, answer]) => answer !== 'yes').map(([item]) => item);
    const decision = record.outcome === 'met' ? 'satisfies' : 'does-not-satisfy';
    return {
      id: record.id, clauseId: record.clauseId, slot: record.slot, method: record.method,
      ...(record.target ? { target: record.target } : {}),
      file: record.file, sha256: record.sha256,
      decision, ...(answeredNo.length ? { answeredNo } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.actor ? { actor: record.actor } : {}),
      ...(record.authorityGroup ? { authorityGroup: record.authorityGroup } : {}),
      ...(record.identityAssurance ? { identityAssurance: record.identityAssurance } : {}),
      ...(record.at ? { at: record.at } : {}),
      binding, candidate,
      valid: decision === 'satisfies' && binding === 'bound-file-unchanged' && candidate !== 'changed'
    };
  });
}

/** The digest of each witnessed file's bytes in the working tree, or null when it cannot be read. */
async function currentWitnessedBytes(root, workflow) {
  const current = new Map();
  for (const file of new Set((workflow?.witnessRecords ?? []).map((entry) => entry.file))) {
    try {
      const secured = await secureRepositoryPath(root, file, { label: 'Witnessed file', mustExist: true, type: 'file' });
      current.set(file, `sha256:${createHash('sha256').update(await readFile(secured.absolute)).digest('hex')}`);
    } catch { current.set(file, null); }
  }
  return current;
}

/** Every active witness decision of the Story, with its binding checked against the files now. */
export async function storyWitnessDecisions(root, workflow) {
  const existing = workflow?.witnessRecords?.length ? witnessDecisionsFrom(workflow, await currentWitnessedBytes(root, workflow)) : [];
  for (const record of await applicationReviewWitnesses(root, workflow)) {
    const next = { id: record.recordId, clauseId: record.clauseId, slot: record.slot, method: 'visual', file: null,
      target: record.target, sha256: null, decision: 'satisfies', actor: record.reviewer?.email ?? record.reviewer?.login ?? record.reviewer?.name,
      authorityGroup: record.authorityGroup, at: record.at,
      binding: 'live-target-and-evidence-unchanged', candidate: 'unchanged', valid: true, observationBasis: record.observationBasis, applicationReview: record.applicationReview };
    const at = existing.findIndex(item => item.clauseId === next.clauseId && item.slot === next.slot && item.method === 'visual');
    if (at < 0) existing.push(next);
    else if (existing[at].binding !== 'bound-file-unchanged' || existing[at].candidate === 'changed'
      || Date.parse(next.at) > (Date.parse(existing[at].at) || 0)) existing[at] = next;
  }
  return existing;
}

/**
 * Steps that report on visual or inspection evidence, read from structure, never a step's name: a
 * conformance or test-evidence report, a step that holds the verify responsibility, and any step
 * whose approved inputs include a visual verification step.
 */
export function phaseReadsWitnessDecisions(workflow, phase) {
  if (!workflow || !phase) return false;
  if (isConformancePhase(phase) || isTestEvidencePhase(phase)) return true;
  if (stepResponsibilities(workflow, phase.id).includes('verify')) return true;
  return approvedInputPhases(workflow, phase).some((id) => isVisualVerificationPhase(workflow.phases?.[id]));
}

/** The read-only projection a step's entry packet carries, or null when it has nothing to show. */
export function witnessDecisionProjection(workflow, phase, decisions) {
  if (!decisions?.length) return null;
  const reviews = decisions.slice(0, LIMIT);
  const core = {
    revision: WITNESS_DECISIONS_REVISION, workId: workflow?.workItem?.id ?? null, phase: phase?.id ?? null,
    readOnly: true, reviews, omittedReviews: decisions.length - reviews.length,
    supersededRecords: Math.max(0, (workflow?.witnessRecords?.length ?? 0) - decisions.filter(item => !item.applicationReview).length),
    instruction: decisions.some(item => item.applicationReview)
      ? 'Report the listed human reviews as recorded. An ARA record witnesses an inspected live application and retained results, with images captured afterwards; never claim that the person inspected those later images. File-inspection records keep their own exact-file basis. Valid listed decisions satisfy only their named criterion slots. Do not invent or omit acceptance.'
      : WITNESS_DECISIONS_INSTRUCTION
  };
  return { ...core, projectionSha256: `sha256:${recordSha256(core)}` };
}

/** The recorded reviews a step that reports on visual evidence is shown, or null. */
export async function phaseWitnessDecisions(root, workflow, phase) {
  if (!workflow?.witnessRecords?.length && !workflow?.applicationAcceptanceRecords?.length || !phaseReadsWitnessDecisions(workflow, phase)) return null;
  return witnessDecisionProjection(workflow, phase, await storyWitnessDecisions(root, workflow));
}

/** One review's binding, in the words the block uses. */
export function witnessBindingStatus(review) {
  if (review.observationBasis === 'live-application-and-retained-results') return 'live result and post-confirmation evidence unchanged';
  if (review.binding === 'bound-file-changed') return 'bound file changed since: not valid';
  if (review.binding === 'bound-file-unreadable') return 'bound file missing or unreadable: not valid';
  if (review.binding === 'unchecked') return 'bound file not checked';
  if (review.candidate === 'changed') return 'bound file unchanged, but the plan or code candidate changed since: not valid';
  return 'bound file unchanged';
}

function reviewLine(review) {
  if (review.observationBasis === 'live-application-and-retained-results') return [`- ${review.id}: authorized human visual acceptance of the live application and retained results satisfies ${review.clauseId} slot \`${review.slot}\`. Evidence was captured afterwards; the human did not claim to inspect those later images. Session: ${review.applicationReview}.`];
  const outcome = review.decision === 'satisfies' ? 'satisfies it'
    : `does not satisfy it${review.answeredNo?.length ? ` (answered no: ${review.answeredNo.join(', ')})` : ''}`;
  const by = [review.actor ? `by ${review.actor}` : null, review.authorityGroup ? `for ${review.authorityGroup}` : null,
    review.at ? `at ${review.at}` : null].filter(Boolean).join(' ');
  return [
    `- ${review.id}: ${review.method} of \`${review.file}\`${review.target ? ` (screen: ${JSON.stringify(review.target)})` : ''} for ${review.clauseId} slot \`${review.slot}\` ${outcome}.`
      + `${by ? ` Recorded ${by}.` : ''} Bound to ${review.sha256}; ${witnessBindingStatus(review)}.`,
    ...(review.reason ? [`  Reviewer note: ${JSON.stringify(review.reason)}`] : [])
  ].join('\n');
}

/** The short, factual Markdown block a reporting step's prompt carries. */
export function renderWitnessDecisions(projection) {
  if (!projection?.reviews?.length) return '';
  return [WITNESS_DECISIONS_HEADING, '', projection.instruction, '',
    ...projection.reviews.map(reviewLine),
    ...(projection.omittedReviews ? ['', `Further recorded reviews not listed: ${projection.omittedReviews}; see singularity-flow evidence matrix.`] : [])
  ].join('\n');
}

/**
 * A reused generation prompt keeps its exact bytes; reviews recorded after it was composed are
 * delivered beside it, as the execution-evidence refresh is. Unchanged reviews add nothing.
 */
export function withWitnessDecisionRefresh(text, record, projection) {
  if (!projection || record?.promptBudget?.visualReviews?.projectionSha256 === projection.projectionSha256) return text;
  return `${text.trimEnd()}\n\n# Current recorded visual reviews refresh\n\nThis read-only list supersedes any earlier list of recorded human visual reviews; the retained prompt, artifacts and approvals remain unchanged.\n\n${renderWitnessDecisions(projection)}\n`;
}

/** What a composition record keeps about the reviews it delivered. */
export function witnessDecisionCompositionRecord(projection) {
  return { projectionSha256: projection.projectionSha256, reviews: projection.reviews.length,
    valid: projection.reviews.filter((review) => review.valid).length };
}
