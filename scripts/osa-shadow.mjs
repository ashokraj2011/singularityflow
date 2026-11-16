#!/usr/bin/env node
/**
 * SPEC-OSA v1.1 shadow comparison (plan section 3, "Shadow comparison"): evaluate the kernel's decision against the
 * existing surfaces' outputs on the same captured Story records, without executing any action and without reading
 * anything but the records themselves (no Git, no repeated I/O).
 *
 *   node scripts/osa-shadow.mjs [--baseline=<checkout>] [--json]
 *
 * Each captured record is a Story at its current step, generated over the lifecycle facts the cohort reads. For each,
 * the kernel's primary action, rendered by the host map (phase-mutation-contract.mjs decisionRoutes), is compared with:
 * - `sequence`: the Story's next action (sequence.mjs sequenceGuidance), a Stage 3 surface that adapts later;
 * - `entry`: the entry's classification (phase-authoring-entry.mjs), where it names a command;
 * - `baseline` (with --baseline): the edit permission's next as the baseline checkout derived it, before the migration.
 * Differences are grouped by class; `shadowDifferences` is what test/osa-stage1-shadow.test.mjs holds to its declared list.
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

/** The class of one difference, from what each side named. Unclassified differences are reported as such. */
function classify(surface, kernelDecision, ours, theirs) {
  const state = kernelDecision.state;
  if (surface === 'sequence') {
    if (state === 'paused') return 'sequence-ignores-amendment-pause';
    if (state === 'damaged') return 'sequence-writes-a-damaged-step';
    if (state === 'invalid') return 'sequence-writes-an-invalid-opening';
    if (/^singularity-flow submit /u.test(theirs) && /--submission-readiness/u.test(ours)) return 'submit-led-by-readiness';
    if (/phase rollover/u.test(ours) && /phase begin/u.test(theirs)) return 'published-code-successor-previewed';
  }
  if (surface === 'entry') {
    if (state === 'paused') return 'entry-holds-for-the-pause';
    if (/phase rollover/u.test(theirs) && state === 'damaged') return 'entry-previews-a-damaged-step';
  }
  if (surface !== 'sequence' && state === 'damaged' && /decisions /u.test(theirs)) return 'damage-before-pause';
  if (surface === 'baseline') {
    if (/nextsteps/u.test(theirs)) return 'guard-named-nextsteps';
    if (/phase rollover/u.test(ours) && /phase begin/u.test(theirs)) return 'published-code-successor-previewed';
    if (state === 'invalid') return 'invalid-opening-classified';
  }
  return `unclassified:${surface}`;
}

/** Compare every captured record; returns { records, differences: [{ class, surface, name, kernel, existing }] }. */
export async function shadowDifferences({ root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), baseline = null } = {}) {
  const load = (base, file) => import(pathToFileURL(path.join(base, 'src', file)).href);
  const [{ stepState }, contract, { sequenceGuidance }, { phaseAuthoringEntry }] = await Promise.all([
    load(root, 'kernel/step-state.mjs'), load(root, 'phase-mutation-contract.mjs'), load(root, 'sequence.mjs'), load(root, 'phase-authoring-entry.mjs')]);
  const old = baseline ? await load(baseline, 'phase-mutation-contract.mjs') : null;
  const differences = [];
  let records = 0;
  for (const { name, workflow } of capturedRecords()) {
    records += 1;
    const phase = workflow.phases[workflow.currentPhase];
    const decision = stepState(contract.stepSnapshotOf({ workflow, phase }));
    const ours = words(contract.decisionRoutes(decision, workflow, phase)[0]?.command);
    const compare = (surface, theirs) => {
      if (!theirs || words(theirs) === ours) return;
      differences.push({ class: classify(surface, decision, ours, words(theirs)), surface, name, state: decision.state, kernel: ours, existing: words(theirs) });
    };
    let sequence = null;
    try { sequence = sequenceGuidance(workflow).actions.find((action) => action.command)?.command; } catch { /* the surface itself refused */ }
    compare('sequence', sequence);
    if (phase.status === 'in_progress') compare('entry', phaseAuthoringEntry(workflow, phase).actions?.[0]?.command ?? null);
    if (old) compare('baseline', old.deriveMutationContract({ definition: {}, workflow }).next[0]?.command);
  }
  return { records, differences };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice('--baseline='.length) ?? null;
  const { records, differences } = await shadowDifferences({ baseline: baseline ? path.resolve(baseline) : null });
  const byClass = {};
  for (const entry of differences) (byClass[`${entry.surface} ${entry.class}`] ??= []).push(entry);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ records, byClass }, null, 2));
  else {
    console.log(`${records} captured records, ${differences.length} differences`);
    for (const [key, entries] of Object.entries(byClass)) console.log(`${String(entries.length).padStart(5)}  ${key}  e.g. kernel "${entries[0].kernel}" / existing "${entries[0].existing}" (${entries[0].state})`);
  }
}
