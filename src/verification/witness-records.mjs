/**
 * Inspection and visual witnesses, bound to a criterion's contract slot [E2G-018].
 *
 * A person in the group that approves the criterion's delivery inspects one exact file (for an
 * inspection slot, the file the contract names; for a visual slot, the captured image of the screen
 * it names) and answers a fixed checklist: the file states the criterion's observable outcome, it
 * matches the criterion as written, and it is current for this change. The record binds the file's
 * SHA-256, the reviewer and their authority, and is append-only. It witnesses the slot only while
 * every answer is yes and the file still has those bytes; a changed file must be inspected again.
 * Nothing here depends on a step's name. Pure.
 */
import { SingularityFlowError } from '../util.mjs';
import { recordSha256 } from '../records.mjs';
import { phaseNeedsGeneration } from '../phase-generation-need.mjs';
import { upstreamChangeRoutes } from '../upstream-routes.mjs';
import { phaseCorrectionTargets } from '../phase-finding-policy.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { createHash } from 'node:crypto';

export const WITNESS_CHECKLIST = Object.freeze(['states-the-outcome', 'matches-the-criterion', 'current-for-this-change']);

/**
 * ARA live/result-based acceptance is a separate observation basis in this authoritative human
 * decision service. It never invents answers to the older file-inspection checklist. Images are
 * admitted after the actual human confirmation, and these records reference both events.
 */
export function recordApplicationReviewAcceptance(workflow, { confirmation, captures, decisions, target, actor, authorityGroup, at }) {
  if (!confirmation?.hostAction?.id || !['live-application-and-retained-results', 'retained-structured-results'].includes(confirmation.reviewedBasis)
      || confirmation.targetId !== target?.id || !captures.length || !authorityGroup || !actor
      || captures.some(item => item.confirmation !== confirmation.id || item.targetId !== target.id || item.status !== 'captured'
        || Date.parse(item.capturedAt) < Date.parse(confirmation.at))) {
    throw invalid('Application acceptance needs the actual current human confirmation and its admitted post-confirmation evidence.', 'ARA_ACCEPTANCE_INVALID');
  }
  workflow.applicationAcceptanceRecords ??= [];
  for (const decision of decisions) {
    if (!confirmation.dimensions.includes(decision.dimension) || decision.confirmation !== confirmation.id || decision.targetId !== target.id) {
      throw invalid('Application acceptance differs from the actual confirmed dimensions.', 'ARA_ACCEPTANCE_INVALID');
    }
    const record = { schemaVersion: 1, kind: 'application-review-acceptance', ...decision, subject: target.subject,
      observationBasis: confirmation.reviewedBasis, humanAction: confirmation.hostAction, confirmedAt: confirmation.at,
      screenshotsInspectedByHuman: false, capturedAfterConfirmation: true, contextBinding: witnessContextBinding(workflow),
      witnesses: decision.dimension === 'visual' && confirmation.reviewedBasis === 'live-application-and-retained-results'
        ? (target.plan?.items ?? []).filter(item => item.dimension === 'visual' && confirmation.coverage.includes(item.id) && item.source?.kind === 'approved-clause')
          .flatMap(item => (item.slots ?? []).map(slot => ({ clauseId: item.source.id, slot: slot.slot, target: slot.target }))) : [],
      actor, authorityGroup, at };
    const prior = workflow.applicationAcceptanceRecords.find(item => item.id === record.id);
    if (prior && recordSha256(prior) !== recordSha256(record)) throw invalid('Acceptance identity already has different content.', 'ARA_IDEMPOTENCY_CONFLICT');
    if (!prior) workflow.applicationAcceptanceRecords.push(record);
  }
  return decisions;
}

/** Distinct live-review semantics: never fabricate the legacy screenshot checklist. */
export function applicationReviewSlotResults(workflow, view, { targetCurrent, evidenceAvailable }) {
  if (!workflow.resolution?.applicationReview || workflow.resolution.applicationReview.mode === 'off'
      || !targetCurrent || !evidenceAvailable || view.target?.applicability.surface !== 'web') return [];
  const active = new Set(view.decisions.map(item => item.id));
  const context = witnessContextBinding(workflow);
  return (workflow.applicationAcceptanceRecords ?? []).filter(record => active.has(record.id) && record.dimension === 'visual'
    && record.targetId === view.target.id && record.contextBinding === context && record.observationBasis === 'live-application-and-retained-results'
    && view.decisions.some(decision => decision.id === record.id && decision.confirmation === record.confirmation && decision.targetId === record.targetId)
    && record.captureReceipts?.length && record.captureReceipts.every(id => view.captures?.some(receipt => receipt.id === id && receipt.confirmation === record.confirmation && receipt.targetId === record.targetId))
    && record.screenshotsInspectedByHuman === false && record.capturedAfterConfirmation === true)
    .flatMap(record => (record.witnesses ?? []).map(witness => ({ ...witness, recordId: record.id, method: 'visual', status: 'met', assurance: 'source-bound',
      reviewer: record.actor, observationBasis: record.observationBasis, applicationReview: view.id,
      captureReceipts: record.captureReceipts, authorityGroup: record.authorityGroup, at: record.at, file: null })));
}

/** Lazy owner adapter; ordinary witnesses load no application-review or browser closure. */
export async function applicationReviewWitnesses(root, workflow, config = null) {
  if (!workflow?.applicationAcceptanceRecords?.length) return [];
  const runtime = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'application-review-read.mjs')).href;
  return (await import(runtime)).applicationReviewWitnessResults(root,
    config ?? { workItemRoot: workflow.resolution?.workItemRoot ?? 'singularity/work-items' }, workflow);
}
const AC_ID = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u;

function invalid(message, code = 'WITNESS_RECORD_INVALID') {
  return new SingularityFlowError(message, { code });
}

/**
 * A visual/inspection decision belongs to this plan, criterion set and published candidate: its
 * generation and the source and test bytes it delivered. Not the commit those bytes land in, which
 * submission sets: a sign-off given after publishing, as the outcome review asks, was always marked
 * missing once the step was submitted (2026-10-28). `legacy` is the form records before that bound.
 */
export function witnessContextBinding(workflow, { legacy = false } = {}) {
  return `sha256:${recordSha256({ workId: workflow.workItem?.id ?? null,
    phases: (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map((id) => {
      const phase = workflow.phases?.[id] ?? {};
      return { id, specification: phase.specIndex?.indexSha256 ?? null,
        plan: phase.claimMaps?.planned?.sha256 ?? null,
        candidate: phase.deliveryEvidence ? { generation: phase.generation, ...(legacy ? { commit: phase.generationCommit ?? null } : {}),
          source: phase.deliveryEvidence.sourceTreeSha256 ?? null, tests: phase.deliveryEvidence.testInputSha256 ?? null } : null };
    }) })}`;
}

/** Refuse a native review whose inspected candidate or file changed before its record is written. */
export function assertWitnessReviewBinding(workflow, { expectedContext, expectedFile, actualFile, clauseId, slot, file }) {
  const digest = /^sha256:[a-f0-9]{64}$/u;
  if (expectedContext != null && (!digest.test(expectedContext) || expectedContext !== witnessContextBinding(workflow))
      || expectedFile != null && (!digest.test(expectedFile) || expectedFile !== actualFile)) {
    throw new SingularityFlowError('The candidate or evidence changed after inspection. Nothing was recorded; reopen the current human witness review.',
      { code: 'WITNESS_REVIEW_CHANGED' });
  }
  // Native review selected a still-pending slot, not a second signature on a completed review.
  const existing = expectedContext && witnessRecordResults(workflow.witnessRecords, new Map([[file, actualFile]]),
    { contextBinding: witnessContextBindings(workflow) }).find(record => record.clauseId === clauseId && record.slot === slot && record.status === 'met');
  if (existing) throw new SingularityFlowError(`${existing.recordId} already signs off ${clauseId} slot ${slot} for this evidence and candidate. No duplicate was recorded. Refresh Decisions for the remaining items.`,
    { code: 'WITNESS_ALREADY_RECORDED' });
}

/** The bindings a record may carry and still belong to this candidate: today's, and the legacy form. */
export function witnessContextBindings(workflow) {
  return [witnessContextBinding(workflow), witnessContextBinding(workflow, { legacy: true })];
}

/*
 * Retained evidence a code step published (fulfillment `evidence`): who published which bytes, and
 * how the step that owns a file publishes a new image. A witness refused at release used to name
 * neither, nor any command that could make its "reviewed correction" (ws-graph AC-001, 2026-10-27);
 * a later step's commit is held to the same records (evidence/retained-evidence.mjs).
 */
export const evidenceDigest = (value) => `sha256:${String(value ?? '').replace(/^sha256:/u, '')}`;
export const shortCommit = (commit) => String(commit ?? '').slice(0, 12);

/** A delivery's fulfillment entries: the current list, or the receipt form with `obligations`. */
function fulfillmentEntries(phase) {
  const fulfillment = phase?.deliveryEvidence?.fulfillment;
  const entries = fulfillment?.obligations ?? fulfillment;
  return Array.isArray(entries) ? entries : [];
}

/**
 * Each retained evidence file a published delivery recorded present: the step and generation that
 * published it, that generation's commit and the file's digest. `approvedOnly` keeps the steps whose
 * approval stands; `except` leaves one step out.
 */
export function publishedRetainedEvidence(workflow, { approvedOnly = false, except = null } = {}) {
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  return order.flatMap((phaseId) => {
    const phase = workflow?.phases?.[phaseId];
    if (!phase?.generationCommit || phaseId === except || (approvedOnly && phase.status !== 'approved')) return [];
    return fulfillmentEntries(phase).filter((entry) => entry?.fulfillment === 'evidence')
      .flatMap((entry) => (entry.paths ?? []).filter((item) => item?.state === 'present' && item.sha256 && item.path)
        .map((item) => ({ phase: phaseId, generation: phase.generation, generationCommit: phase.generationCommit,
          clauseId: entry.clauseId, path: item.path, sha256: evidenceDigest(item.sha256) })));
  });
}

/** Whether a step's delivery recorded `file` present for `clauseId`: until one does, a witness of it is refused (unpublishedWitnessRefusal). */
export function retainedEvidenceDelivered(workflow, clauseId, file) {
  return Object.values(workflow?.phases ?? {}).some((phase) => Number(phase?.generation) > 0 && fulfillmentEntries(phase).some((entry) => entry?.clauseId === clauseId
    && entry.fulfillment === 'evidence' && (entry.paths ?? []).some((item) => item?.path === file && item.state === 'present')));
}

/** The step whose published delivery recorded `file` for `clauseId` other than present, and what it recorded. */
function unpublishedDelivery(workflow, clauseId, file) {
  for (const [phaseId, phase] of Object.entries(workflow?.phases ?? {})) {
    if (!phase?.generationCommit) continue;
    for (const entry of fulfillmentEntries(phase)) {
      const item = entry?.clauseId === clauseId ? (entry.paths ?? []).find((candidate) => candidate?.path === file) : null;
      if (item) return { phase: phaseId, state: item.state ?? 'unknown' };
    }
  }
  return null;
}

/**
 * How `owner`, the step that published a retained evidence file, publishes a new image, seen from
 * step `from`: a return the CLI accepts from where the Story stands, else the upstream issue that is
 * open from any status, else words. `submittable` is false when `from` cannot be submitted as it is,
 * so the return that needs its submission first is not offered. Returns `{ kind, command, sentence }`.
 */
export function republicationRoute(workflow, owner, clauseId, { from = workflow?.currentPhase ?? null, submittable = true } = {}) {
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  const phase = workflow?.phases?.[owner] ?? null;
  const order = workflow?.phaseOrder ?? [];
  const next = `${owner} publishes the new image in its next generation`;
  if (owner === from) {
    if (phase?.status === 'awaiting_approval' && phaseCorrectionTargets(phase).includes(owner)) {
      const command = `singularity-flow reject ${owner} --work-id ${workId} --to ${owner} --reason <reason>`;
      return { kind: 'return', command, sentence: `an approver of ${owner} returns it with ${command}, and ${next}.` };
    }
    if (phase?.status === 'in_progress' && !phaseNeedsGeneration(workflow, phase)) {
      const command = `singularity-flow phase rollover ${owner} --json`;
      return { kind: 'rollover', command, sentence: `open its next generation (${command} previews it), save the new image there and publish it.` };
    }
    return { kind: null, command: null, sentence: 'save the new image in its open generation and publish it.' };
  }
  if (order.indexOf(owner) > order.indexOf(from)) return { kind: null, command: null, sentence: `${next}, once the Story reaches it again.` };
  const { routes, notes } = upstreamChangeRoutes(workflow, owner, { currentPhaseId: from });
  const returned = routes.find((route) => route.kind === 'return');
  if (returned) return { kind: 'return', command: returned.command, sentence: `an approver of ${from} returns the Story to ${owner} with ${returned.command}, and ${next}.` };
  const raised = routes.find((route) => route.kind === 'upstream-issue');
  if (raised) {
    const command = raised.command.replace('<clause-or-section>', clauseId).replace('<what-is-wrong>', '<what-changed>');
    const later = submittable ? notes.find((note) => note.startsWith('Once ')) : null;
    return { kind: 'upstream-issue', command, sentence: `record it for ${owner}'s approvers with ${command}; they can return the Story to ${owner}, and ${next}.${later ? ` ${later}` : ''}` };
  }
  return { kind: null, command: null, sentence: notes[0] ?? `only an authorized return of ${owner} changes it.` };
}

// Where a test's capture belongs (the plan template and the evidence topics say the same).
export const CAPTURE_RULE = 'A test saves its capture under its runner\'s output (for example test-results/), never at a retained evidence path, '
  + 'and the image is copied to the evidence path once, when the evidence is produced.';
export const IF_A_TEST = `If a test saves its capture to this path, every run replaces it. ${CAPTURE_RULE}`;

/** The structured facts both refusals carry, so every surface builds the same steps from them. */
export function retainedEvidenceDetails(workflow, rows, route, lead) {
  const label = `${lead}: ${route.sentence}`;
  return {
    workId: workflow?.workItem?.id ?? null,
    paths: [...new Set(rows.map((row) => row.entry.path))],
    upstreamPhases: [...new Set(rows.map((row) => row.entry.phase))],
    retainedEvidence: rows.map(({ entry, current, during = false, restore = true }) => ({
      path: entry.path, clauseId: entry.clauseId, publishedBy: entry.phase, generation: entry.generation,
      generationCommit: entry.generationCommit, publishedSha256: entry.sha256, currentSha256: current ?? null, changedDuring: during,
      restore: restore ? `git restore --source=${entry.generationCommit} -- ${entry.path}` : null })),
    routes: route.command ? [{ kind: route.kind, command: route.command, label }] : [],
    notes: route.command ? [] : [label]
  };
}

/**
 * The refusal of a witness whose file is not the retained evidence a step published for the
 * criterion: nothing published it, or it has other bytes now. `published` are the present entries
 * for this file (publishedRetainedEvidence); `sha256` the file's current digest.
 */
function unpublishedWitnessRefusal(workflow, { clauseId, file, sha256, published }) {
  if (!published.length) {
    const recorded = unpublishedDelivery(workflow, clauseId, file);
    return new SingularityFlowError(`Nothing has published ${file} for ${clauseId}`
      + `${recorded ? ` (${recorded.phase}'s delivery recorded it ${recorded.state})` : ': no step\'s delivery records it'}, `
      + 'so there is no published image to witness yet. The code step that owes it saves it and publishes it with its delivery; witness it after that. Nothing was recorded.',
    { code: 'WITNESS_EVIDENCE_UNPUBLISHED', details: { workId: workflow?.workItem?.id ?? null, paths: [file], retainedEvidence: [], routes: [], notes: [],
      ...(workflow?.workItem?.id ? { nextAction: { argv: ['recover', workflow.workItem.id,
        ...(workflow.currentPhase ? ['--phase', workflow.currentPhase] : []), '--for-agent', '--json'],
      label: 'Inspect the current delivery and its publication requirements before attempting a witness again.' } } : {}) } });
  }
  const entry = published.find((item) => item.sha256 !== sha256) ?? published[0];
  const route = republicationRoute(workflow, entry.phase, clauseId);
  const others = published.filter((item) => item !== entry && item.sha256 !== sha256);
  const lead = `To keep the new image instead, ${entry.phase}, the step that owns this evidence, must publish it again`;
  return new SingularityFlowError(`${file} is not the image ${entry.phase} published for ${clauseId}: ${entry.phase} published ${entry.sha256} `
    + `in generation ${entry.generation} (commit ${shortCommit(entry.generationCommit)}), and the file now has ${sha256}`
    + `${others.length ? `; ${others.map((item) => `${item.phase} published ${item.sha256}`).join(', ')}` : ''}. Nothing was recorded. `
    + `To witness the published image, restore it with git restore --source=${entry.generationCommit} -- ${file}, then witness it again. `
    + `${lead}: ${route.sentence} ${IF_A_TEST}`,
  { code: 'WITNESS_EVIDENCE_UNPUBLISHED', details: retainedEvidenceDetails(workflow, [{ entry, current: sha256 }], route, lead) });
}

/**
 * Append one witness record. `slot` is the contract slot it witnesses; `file` the inspected path
 * with its current `sha256`; `answers` maps every checklist item to yes or no.
 */
function recordWitnessWithEvidence(workflow, { clauseId, slot, file, sha256, answers = {}, reason, actor, authorityGroup, identityAssurance = null, at, plannedClaim = null }, publishedEvidence = null) {
  if (!AC_ID.test(String(clauseId ?? ''))) throw invalid('--criterion must name one acceptance criterion, such as ORDER:AC-001.');
  if (!slot || !['inspection', 'visual'].includes(slot.method)) {
    throw invalid(`${clauseId}'s contract has no inspection or visual slot by that name; tests are witnessed by their own runs.`);
  }
  if (slot.method === 'inspection' && file !== slot.witness.path) {
    throw invalid(`${clauseId}'s slot ${slot.slot} inspects ${slot.witness.path}, not ${file}.`);
  }
  const retained = (plannedClaim?.obligations ?? (plannedClaim ? [plannedClaim] : []))
    .filter((entry) => entry.fulfillment === 'evidence');
  if (retained.length) {
    const expected = retained.flatMap((entry) => entry.expectedPaths);
    if (!expected.includes(file)) throw invalid(`${clauseId}'s retained evidence is ${expected.join(', ')}, not ${file}.`);
    const published = (publishedEvidence ?? publishedRetainedEvidence(workflow)).filter((entry) => entry.clauseId === clauseId && entry.path === file);
    // The refusal names who published which bytes, the file's bytes now and both ways on (ws-graph, 2026-10-27).
    if (!published.length || published.some((entry) => entry.sha256 !== sha256)) {
      throw unpublishedWitnessRefusal(workflow, { clauseId, file, sha256, published });
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(sha256 ?? ''))) throw invalid(`${file} could not be read to bind its bytes.`);
  const unknown = Object.keys(answers).filter((item) => !WITNESS_CHECKLIST.includes(item));
  const missing = WITNESS_CHECKLIST.filter((item) => !['yes', 'no'].includes(answers[item]));
  if (unknown.length || missing.length) {
    throw invalid(`Answer every checklist item once with --confirm or --deny: ${WITNESS_CHECKLIST.join(', ')}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}.`);
  }
  const text = String(reason ?? '').trim();
  if (text.length < 10 || text.length > 1000) throw invalid('Say what you inspected in 10 to 1000 characters with --reason.', 'WITNESS_RECORD_REASON_REQUIRED');
  workflow.witnessRecords ??= [];
  const record = {
    id: `WIT-${String(workflow.witnessRecords.length + 1).padStart(3, '0')}`,
    clauseId, slot: slot.slot, method: slot.method, file, sha256,
    contextBinding: witnessContextBinding(workflow),
    ...(slot.method === 'visual' ? { target: slot.witness.target } : {}),
    checklist: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, answers[item]])),
    outcome: WITNESS_CHECKLIST.every((item) => answers[item] === 'yes') ? 'met' : 'failed',
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.witnessRecords.push(record);
  return record;
}

/** Pure record construction for already bound internal aggregates and fixture callers. */
export function recordWitness(workflow, input) {
  return recordWitnessWithEvidence(workflow, input);
}

/**
 * Read the authenticated publication, not the nullable submission marker or mutable draft metadata.
 * Publication commits cannot contain their own hash. `generationCommit` is populated on submission;
 * a human may inspect the delivered image before then. Resolve its existing immutable publication
 * record and read the exact committed fulfillment and file bytes without changing the aggregate.
 */
export async function readPublishedWitnessEvidence(root, workflow, { clauseId, file }) {
  const [{ publishedGenerationCommit, generationPublicationRelative }, { exactFileAtObject }] = await Promise.all([
    import('../generation-publication-store.mjs'), import('../git.mjs')
  ]);
  const evidence = [];
  for (const phase of Object.values(workflow.phases ?? {})) {
    if (!(Number(phase.generation) > 0) || !fulfillmentEntries(phase).some(entry => entry?.clauseId === clauseId
        && entry.fulfillment === 'evidence' && entry.paths?.some(item => item?.path === file))) continue;
    const commit = publishedGenerationCommit(root, workflow, phase);
    if (!commit) continue;
    const publication = phase.generationPublications?.find(entry => Number(entry.generation) === Number(phase.generation));
    const recordPath = publication?.record?.path ?? generationPublicationRelative(phase);
    const workflowPath = recordPath && `${path.posix.dirname(path.posix.dirname(path.posix.dirname(recordPath)))}/workflow.json`;
    const fail = () => { throw new SingularityFlowError(`The retained evidence for ${clauseId} could not be verified in ${phase.id}'s publication ${commit}. Preserve the image and inspect that publication before retrying.`, {
      code: 'WITNESS_PUBLICATION_INVALID', details: { workId: workflow.workItem.id, phase: phase.id, paths: [file],
        nextAction: { argv: ['recover', workflow.workItem.id, '--phase', phase.id, '--for-agent', '--json'],
          label: 'Inspect the exact retained publication; no witness was recorded.' },
        routes: [{ kind: 'diagnostic', command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --for-agent --json`, label: 'Inspect the exact retained publication; no witness was recorded.' }] }
    }); };
    const bytes = workflowPath && exactFileAtObject(root, commit, workflowPath, { maximumBytes: 32 * 1024 * 1024, regularOnly: true });
    if (!bytes) fail();
    let stored;
    try { stored = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
    const saved = stored?.phases?.[phase.id];
    if (stored?.workItem?.id !== workflow.workItem.id || Number(saved?.generation) !== Number(phase.generation)) fail();
    const entries = publishedRetainedEvidence({ phaseOrder: [phase.id], phases: { [phase.id]: { ...saved, generationCommit: commit } } })
      .filter(entry => entry.clauseId === clauseId && entry.path === file);
    if (entries.length) {
      const image = exactFileAtObject(root, commit, file, { maximumBytes: 64 * 1024 * 1024, regularOnly: true });
      if (!image || entries.some(entry => entry.sha256 !== `sha256:${createHash('sha256').update(image).digest('hex')}`)) fail();
      evidence.push(...entries);
    }
  }
  return evidence;
}

/** Authoritative witness entry: final publication binding stays inside the existing transaction. */
export async function recordPublishedWitness(root, workflow, input) {
  const obligations = input.plannedClaim?.obligations ?? (input.plannedClaim ? [input.plannedClaim] : []);
  const evidence = obligations.some(entry => entry.fulfillment === 'evidence')
    ? await readPublishedWitnessEvidence(root, workflow, input) : null;
  return recordWitnessWithEvidence(workflow, input, evidence);
}

/**
 * What each criterion slot's latest record proves now. `currentSha256` maps a file to the digest
 * of its bytes at evaluation, or null when it cannot be read.
 */
export function witnessRecordResults(records = [], currentSha256 = new Map(), { contextBinding = null } = {}) {
  const bindings = new Set([contextBinding].flat());
  const latest = new Map();
  for (const record of records) latest.set(`${record.clauseId}\u0000${record.slot}`, record);
  return [...latest.values()].map((record) => {
    const base = { clauseId: record.clauseId, slot: record.slot, method: record.method, recordId: record.id, file: record.file, reviewer: record.actor };
    const what = record.method === 'inspection' ? 'inspection' : 'visual evidence';
    if (record.contextBinding && !bindings.has(record.contextBinding)) {
      return { ...base, status: 'missing', message: `The plan or code candidate changed after ${what} ${record.id}; inspect ${record.file} again for this generation.` };
    }
    if (currentSha256.get(record.file) !== record.sha256) {
      return { ...base, status: 'missing', message: `${record.file} changed after its ${what} ${record.id} for ${record.clauseId}; inspect it again.` };
    }
    if (record.outcome !== 'met') {
      const denied = Object.entries(record.checklist).filter(([, answer]) => answer !== 'yes').map(([item]) => item);
      return { ...base, status: 'failed', message: `${record.actor}'s ${what} ${record.id} found ${record.file} does not satisfy ${record.clauseId} (${denied.join(', ')}).` };
    }
    return { ...base, status: 'met', assurance: 'source-bound' };
  });
}

/**
 * The visual and inspection witnesses an approver may confirm with an approval [witness folded into
 * approval, 2026-10-28]: each open slot of an acceptance criterion whose evidence is one planned or
 * inspected file, for a person in a group of the steps that deliver or verify it, as `decision
 * witness` requires. `others` names the rest, which stay with whoever may witness them.
 */
export async function evidenceConfirmations(root, config, workflow, actor) {
  const [{ createHash }, { readFile }, { evidenceGraphFromAggregate }, { evaluateEvidence }, { mergedVerificationContracts },
    { mergePlannedClaimRecords }, { riskAuthorities }, { requireApprovalAuthority }, { plannedEvidenceFiles }, { secureRepositoryPath }] = await Promise.all([
    import('node:crypto'), import('node:fs/promises'), import('../evidence/graph.mjs'), import('../evidence/evaluate.mjs'),
    import('./contracts.mjs'), import('../specifications.mjs'), import('../evidence/risk-decisions.mjs'),
    import('../approval-authority.mjs'), import('../evidence/terminal.mjs'), import('../util.mjs')]);
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  const plans = graph.records.planned ?? [];
  const contracts = mergedVerificationContracts(plans);
  const claims = mergePlannedClaimRecords(plans);
  const confirm = [], others = [];
  for (const row of evaluateEvidence(graph).rows) {
    if (row.type !== 'AC') continue;
    for (const open of row.verification?.contract?.slots ?? []) {
      if (open.status !== 'missing' || !['visual', 'inspection'].includes(open.method)) continue;
      const slot = contracts.get(row.id)?.slots.find((entry) => entry.slot === open.slot) ?? null;
      const files = open.method === 'inspection' ? [slot?.witness?.path].filter(Boolean) : plannedEvidenceFiles(row);
      const owning = [...new Set(row.obligations.filter((entry) => ['verify', 'implement'].includes(entry.responsibility)).flatMap((entry) => entry.owningSteps))];
      const groups = riskAuthorities(workflow, { owningSteps: owning });
      const other = (reason) => others.push({ clauseId: row.id, slot: open.slot, reason });
      if (!slot || files.length !== 1) { other('it names no single evidence file to confirm'); continue; }
      let authority;
      try {
        authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
          { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
      } catch { other(groups.length ? `it is witnessed by ${groups.join(' or ')}` : 'no step delivering it has an approval group'); continue; }
      const secured = await secureRepositoryPath(root, files[0], { label: 'Confirmed evidence', mustExist: true, type: 'file' }).catch(() => null);
      if (!secured) { other(`${files[0]} is not in this checkout`); continue; }
      confirm.push({ clauseId: row.id, slot, file: secured.relative ?? files[0],
        sha256: `sha256:${createHash('sha256').update(await readFile(secured.absolute)).digest('hex')}`,
        plannedClaim: claims[row.id] ?? null, authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null });
    }
  }
  return { confirm, others };
}

/** Record each confirmation on the aggregate an approval is about to write: every check answered yes. */
export function recordEvidenceConfirmations(workflow, confirmations, { actor, agent = null, phaseId, reason = null, at }) {
  return confirmations.map((entry) => {
    const recorded = recordWitness(workflow, { ...entry,
      answers: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes'])),
      reason: reason ?? `Confirmed while approving ${phaseId}: ${entry.file} shows ${entry.clauseId}.`, actor, at });
    workflow.history ??= [];
    workflow.history.push({ at, actor, agent, event: 'witness_recorded', phase: workflow.currentPhase ?? null,
      detail: `${recorded.id}: ${recorded.method} of ${recorded.file} for ${recorded.clauseId} slot ${recorded.slot} confirmed with the approval of ${phaseId}. ${recorded.reason}` });
    return recorded;
  });
}
