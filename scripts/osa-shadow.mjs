#!/usr/bin/env node
/**
 * SPEC-OSA v1.1 shadow comparison (plan sections 3 and 5): evaluate the kernel's decision against every surface's output
 * on the same captured Story records, without executing any action and without reading anything but the records
 * themselves (no Git, no repeated I/O).
 *
 *   node scripts/osa-shadow.mjs [--json]
 *
 * Each captured record is a Story at its current step, generated over the lifecycle facts the surfaces read, with each
 * review a surface may hold. For each, the kernel's primary operation (step-decision.mjs) is compared with the operation
 * each surface's first action carries out (`operationOf`): sequence guidance, the guide, next steps' "now", the review
 * continuation, submission readiness and the entry's classification. Stage 3 moved every one onto the decision, so a
 * difference is a new competing decision [OSA:AC-002, AC-020]; test/osa-stage1-shadow.test.mjs holds the count to zero.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RECORD = { path: 'singularity/work-items/SH-1/publications/x.json', sha256: `sha256:${'d'.repeat(64)}` };

/** The captured records: a Story at its current step over the facts the cohort reads. */
export function* capturedRecords() {
  for (const kind of ['code', 'document']) for (const status of ['in_progress', 'awaiting_approval'])
    for (const generation of [0, 1, 2]) for (const intent of [null, 'open-next', 'open-stale', 'consumed-same', 'consumed-before'])
      for (const reason of [null, 'rework', 'rejected', 'change-request']) for (const review of [false, true]) for (const pause of [false, true]) {
        if (kind === 'document' && intent !== null && intent !== 'open-next') continue;
        const id = kind === 'code' ? 'implement' : 'design';
        const phase = { id, status, generation, writeScope: kind === 'code' ? 'source-and-artifact' : 'artifact-only',
          generationPolicy: { requirement: 'required', task: kind, defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
          requiredArtifact: { path: `artifacts/${id}/summary.md`, kind: kind === 'code' ? 'implementation-summary' : 'document' },
          generationPublications: generation > 0 ? [{ generation, record: RECORD }] : [] };
        // A code version is published with its code-delivery receipt (only a publication records one); a published code
        // version without one is not a state a publication leaves, and readiness sends it to its next version (routes #3).
        if (kind === 'code' && generation > 0) phase.deliveryEvidence = { generation };
        if (intent) phase.generationIntent = intent === 'open-next' ? { status: 'open', generation: generation + 1 }
          : intent === 'open-stale' ? { status: 'open', generation: Math.max(1, generation) }
            : { status: 'consumed', generation: intent === 'consumed-same' ? generation : generation - 1 };
        if (reason === 'rework') phase.reworkRevalidation = { generation };
        if (reason === 'rejected') phase.rejectedAt = '2026-11-16T09:00:00.000Z';
        const workflow = { schemaVersion: 13, workItem: { id: 'SH-1' }, status: 'in_progress', currentPhase: id, phaseOrder: [id, 'verify'],
          phases: { [id]: phase, verify: { id: 'verify', status: 'pending', generation: 0, generationPolicy: { requirement: 'required', task: 'document' } } },
          history: pause ? [{ event: 'intent_amendment_proposed', phase: id, detail: 'IA-1 proposed', at: '2026-11-16T10:00:00.000Z' }] : [],
          ...(pause ? { intentAmendments: [{ id: 'IA-1', status: 'proposed' }] } : {}),
          ...(reason === 'change-request' ? { changeRequests: [{ id: 'CR-1', status: 'open', targetPhase: id }] } : {}),
          resolution: review ? { sourceReview: { mode: 'enforce', phases: [id], kinds: { [id]: kind === 'code' ? 'code' : 'planning' }, reviewerAgent: 'sflow-source-reviewer' } } : {} };
        yield { name: JSON.stringify({ kind, status, generation, intent, reason, review, pause }), workflow };
      }
}

const words = (command) => String(command ?? '').replace(/\s--(?:json|for-agent|fetch)\b/gu, '').trim() || null;

/**
 * The operation a rendered command carries out, so two renderings of one action compare equal: the exact submission and
 * the readiness read that names it are one `submit-version`; a review's context and its status are one review [AC-002].
 */
export function operationOf(command) {
  const line = words(command) ?? '';
  if (/^singularity-flow submit |--submission-readiness/u.test(line)) return 'submit-version';
  if (/^singularity-flow review-source (?:context|status) /u.test(line)) return 'start-review';
  if (/^singularity-flow (?:review-source decision-context|decisions? )/u.test(line)) return 'decide';
  if (/^singularity-flow phase rollover /u.test(line)) return 'open-version (consent)';
  if (/^singularity-flow (?:phase begin|prepare) /u.test(line)) return 'write';
  if (/^singularity-flow approve /u.test(line)) return 'approve-step';
  if (/^singularity-flow (?:recover |phase opening .*--reconcile)/u.test(line)) return 'recover-operation';
  if (/^singularity-flow story advance /u.test(line)) return 'submit-version';
  if (/^singularity-flow (?:nextsteps|phase show)\b/u.test(line)) return 'inspect';
  return line ? `other: ${line.split(' ').slice(1, 3).join(' ')}` : null;
}

/** The kernel's own operation in the same terms; a facts read accepts the surface that read those facts (the review). */
function kernelOperations(decision) {
  const { operation, inputs } = decision.next;
  if (operation === 'open-version' && inputs.consent === 'required') return ['open-version (consent)'];
  if (['open-version', 'author-version', 'build-version', 'repair-version'].includes(operation)) return ['write'];
  if (operation === 'refresh-facts') return inputs.source === 'review' ? ['submit-version', 'start-review'] : ['submit-version'];
  if (operation === 'none') return ['inspect'];
  return [operation];
}

/** The reviews a surface may have read for a step that owes one: none read, or one in each of the kernel's statuses. */
const REVIEWS = { 'not read': null, pending: { status: 'pending', findings: [] }, ready: { status: 'ready', findings: [] },
  corrections: { status: 'correction-required', findings: [{ code: 'reviewer-blocker', message: 'Say why.' }] },
  disposition: { status: 'correction-required', findings: [{ code: 'human-disposition-required' }], pendingDispositions: [{ id: 'F-1' }] } };

/**
 * Compare every captured record, with each review a surface may hold; returns { records, differences: [{ class, surface,
 * name, state, kernel, existing }] }. Each surface is read on the same basis the kernel decided on: the same Story
 * record and the same review [OSA:AC-002]. A surface that reads no review (sequence) is given none.
 */
export async function shadowDifferences({ root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..') } = {}) {
  const load = (file) => import(pathToFileURL(path.join(root, 'src', file)).href);
  const [{ stepDecisionOf }, { sequenceGuidance }, { phaseAuthoringEntry }, { workflowGuide }, { workflowNextSteps },
    { sourceReviewContinuation }, { submissionReadinessSnapshot }] = await Promise.all([load('step-decision.mjs'), load('sequence.mjs'),
    load('phase-authoring-entry.mjs'), load('guide.mjs'), load('nextsteps.mjs'), load('source-review-continuation.mjs'), load('submission-readiness.mjs')]);
  const differences = [];
  let records = 0, comparisons = 0;
  for (const { name, workflow } of capturedRecords()) {
    records += 1;
    const phase = workflow.phases[workflow.currentPhase];
    for (const [reviewName, review] of Object.entries(REVIEWS)) {
      if (review && !workflow.resolution?.sourceReview) continue;
      const decision = stepDecisionOf(workflow, phase, { review });
      const expected = kernelOperations(decision);
      const compare = (surface, read) => {
        let theirs;
        try { theirs = read(); } catch (error) { theirs = `refused: ${error.code ?? error.message}`; }
        if (!theirs) return;
        comparisons += 1;
        const operation = theirs.startsWith('refused: ') ? theirs : operationOf(theirs);
        if (expected.includes(operation)) return;
        differences.push({ class: `${decision.state}: ${expected.join(' | ')} / ${operation}`, surface, name: `${name} review ${reviewName}`,
          state: decision.state, kernel: expected.join(' | '), existing: words(theirs) });
      };
      if (!review) compare('sequence', () => sequenceGuidance(workflow).actions.find((action) => action.command)?.command);
      compare('guide', () => workflowGuide(workflow, { sourceReviewEvidence: review }).nextActions[0]?.command);
      compare('nextsteps', () => workflowNextSteps(workflow, { sourceReviewEvidence: review, pendingDecisions: null }).find((action) => action.timing === 'now')?.command);
      if (phase.status !== 'in_progress') continue;
      compare('continuation', () => (review || workflow.resolution?.sourceReview ? sourceReviewContinuation(workflow, phase, review).nextCommand : null));
      compare('readiness', () => { const read = submissionReadinessSnapshot(workflow, { sourceReviewEvidence: review }); return read.nextCommand ?? read.command; });
      compare('entry', () => phaseAuthoringEntry(workflow, phase, { review }).actions?.[0]?.command ?? null);
    }
  }
  return { records, comparisons, differences };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { records, comparisons, differences } = await shadowDifferences();
  const byClass = {};
  for (const entry of differences) (byClass[`${entry.surface} ${entry.class}`] ??= []).push(entry);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ records, byClass }, null, 2));
  else {
    console.log(`${records} captured records, ${comparisons} surface readings, ${differences.length} differences`);
    for (const [key, entries] of Object.entries(byClass)) console.log(`${String(entries.length).padStart(5)}  ${key}  e.g. kernel "${entries[0].kernel}" / existing "${entries[0].existing}" (${entries[0].state})`);
  }
}
