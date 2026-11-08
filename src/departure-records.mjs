/**
 * Departures as the Story records them [CQF:REQ-021 to REQ-029]: each write in its own Story commit,
 * and every read that needs what a file holds now. The model (departures.mjs) decides nothing by itself.
 *
 *   commitDepartures         one commit for the departures a model or prepublish records
 *   recordDepartureRequest   `departure record`: what a /sf-code turn may record, inside the hard limits
 *   recordPathDepartures     the files prepublish would leave out, recorded by SFlow itself
 *   departureReadings        each departure of a step with what its files hold now
 *   commitDepartureDecision  a person's accept or reject, writing the record that already exists for it
 *   assertDeparturesDecided  the code step's approval holds while one is open
 *
 * A commit names only the Story's own state (and a wording draft it saves), so an unfinished step's
 * draft is never swept into it, as an upstream issue raised mid-step never is.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  acceptAllEligible, DEPARTURE_RECORDS, departureHolds, departureRefusal, departuresWithStatus, departureWords, nextDepartureId,
  recordDeparture, recordDepartureRejection
} from './departures.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { posix, SingularityFlowError, nowIso } from './util.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** What each file holds now, by the hash reconciliation and plan amendments read it with; null when absent. */
export async function fileHashes(root, paths) {
  const { fileEvidence } = await import('./work-intervals.mjs');
  return Object.fromEntries((await fileEvidence(root, [...new Set(paths)])).map((entry) => [entry.path, entry.sha256 ?? null]));
}

/** What each file held at a commit; null when it was not there. */
export async function baseHashesAt(root, commit, paths) {
  if (!commit) return Object.fromEntries(paths.map((file) => [file, null]));
  const { exactFileAtObject } = await import('./git.mjs');
  return Object.fromEntries(paths.map((file) => {
    try {
      const bytes = exactFileAtObject(root, commit, file, { maximumBytes: 64 * 1024 * 1024 });
      return [file, bytes ? sha(bytes) : null];
    } catch { return [file, null]; }
  }));
}

/** The commit a step's open generation began from: what a rejected file is restored to. */
export function generationBase(workflow, phase) {
  return phase?.generationIntent?.baseline?.commit ?? workflow?.workIntervals?.current?.sourceBaseCommit ?? null;
}

/** Whether the step can record a departure now: its own open code generation, as an appeal needs. */
async function openCodeGeneration(workflow, phase) {
  const [{ openScopeAppeal }, { phaseRequiresCodeDelivery }] = await Promise.all([import('./phase-finding-policy.mjs'), import('./code-delivery-policy.mjs')]);
  return Boolean(phase) && workflow.currentPhase === phase.id && openScopeAppeal(workflow, phase, phaseRequiresCodeDelivery(phase));
}

/**
 * Why a file can never be a departure [CQF:REQ-029], or null. `context` carries the Story's application
 * path boundary (which keeps out `.git`, workflow and configuration files, every Story's own records and
 * other Stories' files), its protected paths and the paths another step's plan names.
 */
function departureLimit(file, { pathContext, protectedPaths = [], otherStep = () => false }) {
  const candidate = posix(file);
  if (candidate === '.git' || candidate.startsWith('.git/')) return 'it is Git\'s own data';
  const { isApplicationPath, alwaysLocalName, evaluateProtectedPaths, isTestAutomationPath } = limits;
  if (alwaysLocalName(candidate) || /(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/iu.test(candidate)) {
    return 'it is a secret or an environment file, which stays on this machine';
  }
  let application = false;
  try { application = isApplicationPath(candidate, pathContext); } catch { application = false; }
  if (!application) return 'it is not application source: workflow and configuration files, Story records and other Stories\' files change through their own routes';
  if (!evaluateProtectedPaths({ entries: [{ newPath: candidate }] }, protectedPaths).valid) return 'it is a protected path';
  if (otherStep(candidate)) return 'another step\'s plan names it, so it is published with that step';
  if (isTestAutomationPath(candidate)) return 'a test always belongs to the step\'s candidate; a change to the planned tests is --kind test';
  return null;
}

// The path rules, read once and kept: each departure file is held to them.
let limits = null;
async function loadLimits() {
  if (limits) return;
  const [{ isApplicationPath }, { alwaysLocalName }, { evaluateProtectedPaths }, { isTestAutomationPath }] = await Promise.all([
    import('./application-paths.mjs'), import('./local-config-policy.mjs'), import('./repository-change-set.mjs'), import('./source-boundary.mjs')]);
  limits = { isApplicationPath, alwaysLocalName, evaluateProtectedPaths, isTestAutomationPath };
}

/** The paths only other steps' rows name: what this step's departures can never carry. */
async function otherStepPlannedPaths(itemDirectory, workflow, phase) {
  const { loadActiveSpecRecords, mergePlannedClaimRecords } = await import('./specifications.mjs');
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const mine = new Set(); const others = new Set();
  for (const claim of Object.values(mergePlannedClaimRecords(records.planned ?? []))) {
    const elsewhere = (claim.steps ?? []).length && !claim.steps.includes(phase.id);
    for (const candidate of [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]) (elsewhere ? others : mine).add(candidate);
  }
  return new Set([...others].filter((candidate) => !mine.has(candidate)));
}

/** The boundary every departure file is held to, read once for a step. */
async function limitContext(root, config, workflow, phase) {
  await loadLimits();
  const [{ applicationPathContext }, { workDir }] = await Promise.all([import('./application-paths.mjs'), import('./story-paths.mjs')]);
  const others = await otherStepPlannedPaths(workDir(root, config, workflow.workItem.id), workflow, phase).catch(() => new Set());
  return { pathContext: applicationPathContext(config, workflow), otherStep: (file) => others.has(file),
    protectedPaths: [...new Set([...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])])] };
}

/**
 * Record departures in one Story commit, authored as governed-agent. `drafts` are recordDeparture's
 * fields without the ID; `saved` are the wording drafts to write beside the Story's records.
 */
export async function commitDepartures(root, config, workflow, drafts, { actor, agent = null, saved = [] }) {
  const [{ actorKey, assertNoPendingPublication, transactStory }, { writeBytes }] = await Promise.all([import('./state-stores.mjs'), import('./util.mjs')]);
  const at = nowIso();
  const author = actorKey(actor);
  // Checked first, on a copy: nothing is written for a refused one.
  const preview = structuredClone(workflow);
  for (const draft of drafts) recordDeparture(preview, { ...draft, actor: author, agent, at });
  const { value } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: null, payload: { decision: 'departure' }
  }, `[${workflow.workItem.id}][departure] record ${drafts.length}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'record a departure');
    for (const file of saved) await writeBytes(path.join(root, file.path), file.bytes);
    const recorded = drafts.map((draft) => recordDeparture(aggregate, { ...draft, actor: author, agent, at }));
    aggregate.history.push({ at, actor: author, agent, event: 'departure_recorded', phase: aggregate.currentPhase ?? null,
      detail: recorded.map((entry) => `${entry.id} (${entry.kind}): ${departureWords(entry)}. ${entry.reason}`).join(' ') });
    return recorded;
  }, { exactWorkItemPaths: saved.map((file) => file.path),
    eventFromResult: (recorded) => ({ payload: { decision: 'departure', departures: recorded.map((entry) => entry.id), reviewPacketSha256: null } }) });
  return value;
}

/**
 * The approved plan a file, row or test departure departs from [CQF:REQ-021]: the step that owns this
 * step's plan, with its generation and the approved bytes' hash. Null when no approved step holds it.
 */
function planTarget(config, workflow, phase) {
  const owner = workflow.resolution?.plannedClaims?.owners?.[phase.id]
    ?? (workflow.phaseOrder ?? []).find((id) => workflow.phases?.[id]?.claimMaps?.planned) ?? null;
  const step = owner ? workflow.phases?.[owner] : null;
  if (!step || step.status !== 'approved' || !step.requiredArtifact?.path) return null;
  const relative = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, step.requiredArtifact.path));
  return { phase: owner, generation: Number(step.generation ?? 0), sha256: (step.artifacts ?? []).find((artifact) => artifact.path === relative)?.sha256 ?? null, path: relative };
}

/** The earlier document a wording or clause departure departs from, with its approved bytes. */
async function targetDocument(root, config, workflow, phaseId) {
  const [{ workDirRelative }, { exactFileAtObject, head }] = await Promise.all([import('./story-paths.mjs'), import('./git.mjs')]);
  const order = workflow.phaseOrder ?? [];
  const phase = workflow.phases?.[phaseId];
  if (!phase || order.indexOf(phaseId) < 0 || order.indexOf(phaseId) >= order.indexOf(workflow.currentPhase)) {
    departureRefusal(`${phaseId ?? 'That step'} is not an earlier step of this Story; --target names the approved document the change departs from.`);
  }
  if (phase.status !== 'approved' || !phase.requiredArtifact?.path) departureRefusal(`${phaseId} has no approved document to depart from.`);
  const relative = posix(path.join(workDirRelative(config, workflow.workItem.id), phase.requiredArtifact.path));
  const approved = (phase.artifacts ?? []).find((artifact) => artifact.path === relative)?.sha256 ?? null;
  const committed = exactFileAtObject(root, head(root), relative, { maximumBytes: 4 * 1024 * 1024 });
  if (!approved || !committed || sha(committed) !== approved) departureRefusal(`${relative} at HEAD is not ${phaseId}'s approved bytes; sync first.`, 'DEPARTURE_TARGET_STALE');
  return { phase, relative, approved, bytes: committed };
}

const ROW_OPTIONS = Object.freeze(['row-op', 'fulfillment', 'test', 'from', 'to']);

/**
 * `departure record`: what the model records without asking [owner decision 12], one departure per call.
 * The step's own open code generation only. Files are held to the hard limits; an earlier document is
 * never edited: a wording or clause departure carries a draft copy, saved with the record, and its diff.
 */
export async function recordDepartureRequest(root, config, workflow, request, { actor, agent = null }) {
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!await openCodeGeneration(workflow, phase)) {
    departureRefusal('A departure is recorded inside the current code step\'s open generation. Once it is published or submitted, departures are decided on the decisions table; changed work needs a new generation.', 'DEPARTURE_LIFECYCLE');
  }
  const kind = request.kind;
  const context = await limitContext(root, config, workflow, phase);
  const files = [...new Set((request.paths ?? []).map((file) => posix(String(file).trim())))];
  for (const file of files) {
    const limit = departureLimit(file, context);
    if (limit) departureRefusal(`${file} cannot be a departure: ${limit}.`, 'DEPARTURE_NOT_ALLOWED', { path: file });
  }
  let supportingClass = null;
  if (kind === 'supporting') {
    const { classifySupportingChange } = await import('./supporting-changes.mjs');
    for (const file of files) {
      const classified = classifySupportingChange(file);
      if (classified.refused) departureRefusal(`${file} cannot be a supporting change: ${classified.reason}. Record it with --kind path and the clause it serves.`, 'DEPARTURE_INVALID');
      if (supportingClass && classified.class !== supportingClass) departureRefusal('One supporting departure names files of one class; record the others as their own.');
      supportingClass = classified.class;
    }
  }
  let change = null;
  if (['plan-row', 'test'].includes(kind)) {
    const clauseId = String(request.clauses?.[0] ?? '').toUpperCase();
    const op = request['row-op'];
    if (!clauseId) departureRefusal(`A ${kind} departure names the plan row it changes with --clause.`);
    change = { op, clauseId,
      ...(op === 'add-test' ? { test: posix(String(request.test ?? '')) } : {}),
      ...(op === 'set-fulfillment' ? { fulfillment: String(request.fulfillment ?? '') } : {}),
      ...(op === 'remove-location' ? { path: posix(String(files[0] ?? request.from ?? '')) } : {}),
      ...(['replace-test', 'replace-location'].includes(op) ? { from: posix(String(request.from ?? '')), to: posix(String(request.to ?? '')) } : {}) };
  } else if (ROW_OPTIONS.some((option) => request[option] !== undefined)) {
    departureRefusal(`--${ROW_OPTIONS.find((option) => request[option] !== undefined)} belongs to a plan-row or test departure.`);
  }
  let target = null;
  let diff = null;
  const saved = [];
  let proposal = null;
  if (['wording', 'clause'].includes(kind)) {
    if (!request.file) departureRefusal(`A ${kind} departure carries a draft copy of the earlier document with --file; the approved document itself is never edited.`);
    const document = await targetDocument(root, config, workflow, request.target);
    // Each document changes through the record its kind already has: name the kind that writes it.
    const [{ isSpecificationDefinitionPhase }, { phaseRequiresCodeDelivery }] = await Promise.all([import('./specifications.mjs'), import('./code-delivery-policy.mjs')]);
    const definesClauses = isSpecificationDefinitionPhase(document.phase);
    if (phaseRequiresCodeDelivery(document.phase)) departureRefusal(`${request.target} is a code step; it changes through its own generations, never by a departure.`);
    if (kind === 'wording' && definesClauses) departureRefusal(`${request.target} defines the clauses; record a change to its text as --kind clause.`);
    if (kind === 'wording' && document.phase.claimMaps?.planned) departureRefusal(`${request.target} holds the plan; record a change to its rows as --kind plan-row or --kind test.`);
    if (kind === 'clause' && !definesClauses) departureRefusal(`${request.target} defines no clauses; record a change to its text as --kind wording.`);
    const { secureRepositoryPath } = await import('./util.mjs');
    const source = await secureRepositoryPath(root, posix(request.file), { label: 'Departure draft', mustExist: true, type: 'file' });
    if (posix(request.file) === document.relative) departureRefusal(`Leave ${document.relative} as it was approved; put the changed wording in a draft copy and pass that with --file.`, 'DEPARTURE_NOT_ALLOWED');
    const bytes = await readFile(source.absolute);
    if (sha(bytes) === document.approved) departureRefusal(`The draft is ${request.target}'s approved document unchanged.`);
    const { extractInputsBlock } = await import('./inputs.mjs');
    if (extractInputsBlock(bytes.toString('utf8')) !== extractInputsBlock(document.bytes.toString('utf8'))) {
      departureRefusal(`Keep ${request.target}'s managed input block as it is; a departure changes only authored text.`, 'DEPARTURE_NOT_ALLOWED');
    }
    const { unifiedDiff } = await import('./workflow-studio.mjs');
    diff = unifiedDiff(document.bytes.toString('utf8'), bytes.toString('utf8'), document.relative);
    const { workDirRelative } = await import('./story-paths.mjs');
    const id = nextDepartureId(workflow);
    proposal = { path: `${workDirRelative(config, workflow.workItem.id)}/context/departures/${id}-${document.relative.split('/').at(-1)}`, sha256: sha(bytes) };
    saved.push({ path: proposal.path, bytes });
    target = { phase: request.target, generation: Number(document.phase.generation), sha256: document.approved, path: document.relative };
    if (kind === 'clause' && !(request.clauses ?? []).length) departureRefusal('A clause departure names the clauses it changes with --clause.');
  } else if (request.target || request.file) {
    departureRefusal('--target and --file belong to a wording or clause departure.');
  } else target = planTarget(config, workflow, phase);
  const [contentHashes, baseHashes] = await Promise.all([fileHashes(root, files), baseHashesAt(root, generationBase(workflow, phase), files)]);
  if (['path', 'supporting'].includes(kind)) {
    // A file not written yet is no change: say so, and what to do, rather than blame a policy [bin-opr2 #9].
    const missing = files.filter((file) => contentHashes[file] == null && baseHashes[file] == null);
    if (missing.length) departureRefusal(`${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist yet, so there is no change to record. Create ${missing.length === 1 ? 'it' : 'them'} first, then record the departure.`, 'DEPARTURE_UNCHANGED', { missing });
    const unchanged = files.filter((file) => contentHashes[file] === baseHashes[file]);
    if (unchanged.length) departureRefusal(`${unchanged.join(', ')} ${unchanged.length === 1 ? 'is' : 'are'} unchanged in this generation, so there is no departure to record.`, 'DEPARTURE_UNCHANGED');
  }
  const [recorded] = await commitDepartures(root, config, workflow, [{ kind, phase: phase.id, generation: Number(phase.generationIntent?.generation ?? 0), paths: ['path', 'supporting'].includes(kind) ? files : [],
    contentHashes, baseHashes, target, diff, clauses: request.clauses ?? [], supportingClass, change, proposal, reason: request.reason,
    findings: request.findings ?? [], recordedBy: 'agent', supersedes: request.supersedes ?? null }], { actor, agent, saved });
  // The draft now lives in the Story's record. A copy left in the checkout, never committed, would be a
  // departure of its own at the next prepublish, so it goes; a file Git holds stays as it is.
  if (proposal) {
    const [{ exactFileAtObject, head }, { rm }] = await Promise.all([import('./git.mjs'), import('node:fs/promises')]);
    if (!exactFileAtObject(root, head(root), posix(request.file))) await rm(path.join(root, posix(request.file)), { force: true });
  }
  return recorded;
}

/**
 * The files publication would leave out of this step [CQF:REQ-021]: recorded as departures by SFlow
 * itself, one per file, so publish goes ahead with them and a person decides each once. A file a person
 * rejected is not recorded again (prepublish asks for it back), nor one the hard limits keep out: those
 * keep their own refusal. Returns what was recorded; an empty list when nothing was, or nothing could be.
 */
export async function recordPathDepartures(root, config, workflow, phase, { actor, agent = null } = {}) {
  if (!await openCodeGeneration(workflow, phase)) return [];
  const [{ unreconciledCandidatePaths }, { rejectedDeparturePaths }, { classifySupportingChange }, { loadActiveSpecRecords, mergePlannedClaimRecords }, { workDir }] = await Promise.all([
    import('./candidate-scope.mjs'), import('./departures.mjs'), import('./supporting-changes.mjs'), import('./specifications.mjs'), import('./story-paths.mjs')]);
  const unresolved = await unreconciledCandidatePaths(root, config, workflow, phase);
  if (!unresolved.length) return [];
  const rejected = rejectedDeparturePaths(workflow, phase.id);
  const context = await limitContext(root, config, workflow, phase);
  const files = unresolved.filter((file) => !rejected.has(file) && !departureLimit(file, context));
  if (!files.length) return [];
  // The one row this step delivers, when it has only one: what the file most plainly serves.
  const plan = mergePlannedClaimRecords((await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).planned ?? []);
  const rows = Object.entries(plan).filter(([, claim]) => !(claim.steps ?? []).length || claim.steps.includes(phase.id)).filter(([, claim]) => claim.fulfillment !== 'test-only');
  const [contentHashes, baseHashes] = await Promise.all([fileHashes(root, files), baseHashesAt(root, generationBase(workflow, phase), files)]);
  const target = planTarget(config, workflow, phase);
  const drafts = files.map((file) => {
    const supportingClass = classifySupportingChange(file).class ?? null;
    return { kind: supportingClass ? 'supporting' : 'path', phase: phase.id, generation: Number(phase.generationIntent?.generation ?? 0), paths: [file],
      contentHashes, baseHashes, target, clauses: !supportingClass && rows.length === 1 ? [rows[0][0]] : [], supportingClass,
      reason: `${file} changed in this generation, and no row of the approved plan names it.`,
      recordedBy: 'sflow' };
  });
  try {
    return await commitDepartures(root, config, workflow, drafts, { actor, agent });
  } catch (error) {
    // Recording is a convenience over the refusal it replaces: when it cannot be written, that refusal stands.
    if (error instanceof SingularityFlowError) return [];
    throw error;
  }
}

/**
 * An appeal's exact changes recorded as departures [CQF:REQ-029], from the packet `appeal prepare` checked:
 * a file under the clause it names, or a supporting file of its class, with the hashes the packet bound. A
 * file whose departure named no clause is replaced by the one that names it; one already decided stays.
 */
export async function recordAppealDepartures(root, config, workflow, packet, { actor, agent = null }) {
  const phase = workflow.phases?.[packet.binding.phaseId];
  const plain = (value) => (value ? String(value).replace(/^sha256:/u, '') : null);
  const readings = await departureReadings(root, workflow, phase.id);
  const drafts = [];
  for (const change of packet.changes) {
    const diff = packet.diff.find((entry) => entry.path === change.path);
    const earlier = readings.find((entry) => entry.departure.paths.includes(change.path) && ['open', 'reopened'].includes(entry.status));
    if (earlier && (change.kind === 'add-supporting' || earlier.departure.clauses.includes(String(change.clauseId).toUpperCase()))) continue;
    drafts.push({ kind: change.kind === 'add-supporting' ? 'supporting' : 'path', phase: phase.id, generation: Number(packet.binding.generation), paths: [change.path],
      contentHashes: { [change.path]: plain(diff?.afterSha256) }, baseHashes: { [change.path]: plain(diff?.beforeSha256) }, target: planTarget(config, workflow, phase),
      clauses: change.kind === 'add-location' ? [change.clauseId] : [], supportingClass: change.kind === 'add-supporting' ? change.class : null,
      reason: change.kind === 'add-supporting' ? change.reason : packet.reason, recordedBy: 'agent', supersedes: earlier?.departure.id ?? null });
  }
  return drafts.length ? commitDepartures(root, config, workflow, drafts, { actor, agent }) : [];
}

/** Each departure of a step with what its files hold now; `phaseId` null for every step. */
export async function departureReadings(root, workflow, phaseId = null) {
  const departures = (workflow?.departures ?? []).filter((entry) => !phaseId || entry.phase === phaseId);
  if (!departures.length) return [];
  const hashes = await fileHashes(root, departures.flatMap((entry) => entry.paths ?? []));
  return departuresWithStatus(workflow, { phaseId, hashes });
}

/** Who decides a departure: the plan's approvers for files, rows and tests; the earlier step's for its wording or clauses. */
export async function departureAuthorities(workflow, departure) {
  if (['wording', 'clause'].includes(departure.kind)) {
    const policy = workflow.phases?.[departure.target?.phase]?.approvalPolicy ?? {};
    return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
  }
  return (await import('./plan-amendments.mjs')).planAuthorities(workflow);
}

/**
 * The plan amendment changes accepting a file departure writes: its file under each clause it serves, or
 * as the supporting change it is. `clause` is the row a person chose when the departure named none.
 */
export function departureAmendmentChanges(departure, { clause = null, reason }) {
  if (departure.kind === 'supporting') {
    return departure.paths.map((file) => ({ kind: 'add-supporting', path: file, class: departure.class, reason: String(reason).slice(0, 500) }));
  }
  const clauses = clause ? [String(clause).toUpperCase()] : departure.clauses ?? [];
  if (!clauses.length) departureRefusal(`${departure.id} names no clause; choose the row ${departure.paths.join(', ')} serves.`, 'DEPARTURE_CLAUSE_REQUIRED', { departure: departure.id });
  return departure.paths.flatMap((file) => clauses.map((clauseId) => ({ kind: 'add-location', clauseId, path: file })));
}

/** A departure that may be decided now, by its ID, or a refusal that says why not. */
function decidable(workflow, readings, id) {
  const reading = readings.find((entry) => entry.departure.id === id);
  if (!reading) departureRefusal(`${id || 'That departure'} is not a departure of this Story.`, 'DEPARTURE_NOT_FOUND');
  if (!['open', 'reopened'].includes(reading.status)) departureRefusal(`${id} is ${reading.status}; only an open departure is decided.`, 'DEPARTURE_DECIDED');
  return reading.departure;
}

/**
 * A person decides departures [CQF:REQ-024 to REQ-026]. Accepting a file or supporting departure writes one
 * plan amendment naming them, under the plan's authority (commitPlanAmendment); accepting wording writes a
 * forward amendment, proposed from the saved draft and approved by the earlier step's approvers. A row, test
 * or clause is accepted through its own record, a person's own step (`decision plan`, `story intent-amendment`),
 * which names the departure by its exact change. Rejecting writes one rejection; the model reverts the files.
 */
export async function commitDepartureDecision(root, config, workflow, { departures: ids, decision, reason, clause = null, changes: chosenChanges = null }, { actor, agent = null }) {
  if (!['accept', 'reject'].includes(decision)) departureRefusal("A departure is decided with --as accepted or --as rejected.");
  if (!ids?.length) departureRefusal('Name the departure with --departure DEP-NNN.');
  const readings = await departureReadings(root, workflow);
  const chosen = [...new Set(ids)].map((id) => decidable(workflow, readings, id));
  if (decision === 'reject') {
    const groups = [...new Set((await Promise.all(chosen.map((entry) => departureAuthorities(workflow, entry)))).flat())];
    const [{ requireApprovalAuthority }, { actorKey, assertNoPendingPublication, transactStory }] = await Promise.all([import('./approval-authority.mjs'), import('./state-stores.mjs')]);
    if (!groups.length) departureRefusal('No step names an approval group that may decide this departure.', 'DEPARTURE_AUTHORITY_UNAVAILABLE');
    const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
      { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
    const at = nowIso();
    const record = (aggregate) => recordDepartureRejection(aggregate, { departures: chosen.map((entry) => entry.id), reason, actor: actorKey(actor),
      authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at });
    record(structuredClone(workflow));
    const { value } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'departure' }
    }, `[${workflow.workItem.id}][departure] reject ${chosen.map((entry) => entry.id).join(', ')}`, async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'decide a departure');
      const recorded = record(aggregate);
      aggregate.history.push({ at, actor: recorded.actor, agent, event: 'departure_decided', phase: aggregate.currentPhase ?? null,
        detail: `${recorded.departures.join(', ')} rejected: ${recorded.reason}` });
      return recorded;
    }, { exactWorkItemPaths: [], eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'departure', departures: recorded.departures, reviewPacketSha256: null } }) });
    return { decision: 'rejected', record: value, departures: chosen.map((entry) => entry.id) };
  }
  const kinds = new Set(chosen.map((entry) => DEPARTURE_RECORDS[entry.kind]));
  if (kinds.size > 1) departureRefusal('Accept departures that write the same record together; decide the others on their own.');
  const [writes] = kinds;
  if (writes === 'plan-amendment') {
    const { commitPlanAmendment } = await import('./commands/decision-plan-amendment.mjs');
    // The rows a person chose on the list, else each departure's own clause or class.
    const changes = chosenChanges?.length
      ? chosenChanges.map((change) => (change.kind === 'add-supporting' ? { ...change, reason: String(reason).slice(0, 500) } : change))
      : chosen.flatMap((entry) => departureAmendmentChanges(entry, { clause, reason }));
    const covered = new Set(changes.map((change) => change.path));
    const uncovered = chosen.flatMap((entry) => entry.paths).filter((file) => !covered.has(file));
    if (uncovered.length) departureRefusal(`Accepting these departures accounts for every file they change; ${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} not named.`);
    const { amendment } = await commitPlanAmendment(root, config, workflow, { changes, reason, departures: chosen.map((entry) => entry.id) }, { actor, agent });
    return { decision: 'accepted', record: amendment, departures: chosen.map((entry) => entry.id) };
  }
  if (writes === 'forward-amendment') {
    if (chosen.length > 1) departureRefusal('Accept one wording departure at a time: each is its own forward amendment.');
    const [departure] = chosen;
    const { acceptWordingDeparture } = await import('./commands/upstream-issue.mjs');
    const decided = await acceptWordingDeparture(root, config, workflow, { departure, reason, actor, agent });
    return { decision: 'accepted', record: decided, departures: [departure.id] };
  }
  const [departure] = chosen;
  departureRefusal(`${departure.id} is accepted by its own record, ${writes === 'intent-amendment' ? 'an intent amendment the scope\'s approvers decide' : 'a plan row correction an approver of the plan reviews'}, in a person's own terminal: ${acceptanceCommand(workflow, departure)}`,
    'DEPARTURE_OWN_TERMINAL', { departure: departure.id, command: acceptanceCommand(workflow, departure) });
}

const shellWord = (value) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${String(value).replaceAll("'", `'"'"'`)}'`);

/** The command that writes a row, test or clause departure's own record: a person's own terminal step. */
export function acceptanceCommand(workflow, departure) {
  const workId = workflow.workItem.id;
  if (departure.kind === 'clause') {
    return `singularity-flow story intent-amendment propose --work-id ${workId} --file ${shellWord(departure.proposal?.path ?? '<FILE>')} --departure ${departure.id} --reason "<REASON>"`;
  }
  const change = departure.change ?? {};
  const flag = { 'add-test': `--add-test ${shellWord(`${change.clauseId}=${change.test}`)}`, 'replace-test': `--replace-test ${shellWord(`${change.clauseId}=${change.from}:${change.to}`)}`,
    'set-fulfillment': `--set-fulfillment ${shellWord(`${change.clauseId}=${change.fulfillment}`)}`, 'remove-location': `--remove-location ${shellWord(`${change.clauseId}=${change.path}`)}`,
    'replace-location': `--replace-location ${shellWord(`${change.clauseId}=${change.from}:${change.to}`)}`, 'add-row': `--add-row ${shellWord(change.clauseId)}` }[change.op] ?? '';
  return `singularity-flow decision plan ${workId} --fetch ${flag} --reason "<REASON>"`;
}

/**
 * The code step's approval waits while any of its departures is open, reopened, or rejected and not
 * reverted [CQF:REQ-023]. The refusal names the decision list, where each one says who decides it.
 */
export async function assertDeparturesDecided(root, config, workflow, phase) {
  if (!(workflow.departures ?? []).some((entry) => entry.phase === phase.id)) return;
  const readings = (await departureReadings(root, workflow, phase.id)).filter((entry) => departureHolds(entry.status));
  if (!readings.length) return;
  const workId = workflow.workItem.id;
  const open = readings.filter((entry) => entry.status !== 'rejected');
  if (open.length) {
    throw new SingularityFlowError(`${phase.label ?? phase.id} waits for ${open.length === 1 ? 'one departure' : `${open.length} departures`} from the approved documents to be decided: ${open.map((entry) => `${entry.departure.id} (${departureWords(entry.departure)}${entry.status === 'reopened' ? ', changed since it was accepted' : ''})`).join('; ')}.`, {
      code: 'DEPARTURES_UNDECIDED', details: { phase: phase.id, departures: open.map((entry) => ({ id: entry.departure.id, kind: entry.departure.kind, status: entry.status,
        acceptAll: acceptAllEligible(entry.departure) })), nextAction: { command: `singularity-flow decisions ${workId}`, label: 'Decide each departure on the decisions table.' } } });
  }
  throw new SingularityFlowError(`${readings.map((entry) => entry.departure.id).join(', ')} ${readings.length === 1 ? 'was' : 'were'} rejected and ${readings.flatMap((entry) => entry.departure.paths).join(', ')} still ${readings.length === 1 ? 'holds' : 'hold'} the change. Its author restores each file to what it held when the generation began, in a new generation, and submits again.`, {
    code: 'DEPARTURE_REJECTED_NOT_REVERTED', details: { phase: phase.id, departures: readings.map((entry) => entry.departure.id), paths: readings.flatMap((entry) => entry.departure.paths) } });
}

/**
 * What prepublish and phase entry tell the step about its departures, or null when none waits: what was recorded now,
 * what waits for a person (nothing for the model to ask), and what a person rejected, which the model
 * restores in this generation.
 */
export async function departureSummary(root, workflow, phase, recordedNow = []) {
  const readings = await departureReadings(root, workflow, phase.id);
  if (!readings.length) return null;
  const pick = (status) => readings.filter((entry) => status.includes(entry.status)).map((entry) => ({ id: entry.departure.id, kind: entry.departure.kind,
    paths: entry.departure.paths, status: entry.status, words: departureWords(entry.departure) }));
  const open = pick(['open', 'reopened']);
  const rejected = pick(['rejected']);
  // Decided and done: nothing to say to the step.
  if (!recordedNow.length && !open.length && !rejected.length) return null;
  const name = phase.label ?? phase.id;
  const words = [
    recordedNow.length ? `Recorded ${recordedNow.map((entry) => `${entry.id} (${entry.paths.join(', ')})`).join(', ')} as ${recordedNow.length === 1 ? 'a departure' : 'departures'} from the approved plan.` : '',
    open.length ? `${open.map((entry) => entry.id).join(', ')} ${open.length === 1 ? 'waits' : 'wait'} for a person on the decisions table before ${name} is approved; publish goes ahead with ${open.length === 1 ? 'it' : 'them'}, so keep working and do not ask about ${open.length === 1 ? 'it' : 'them'} now.` : '',
    ...rejected.map((entry) => `${entry.id} was rejected: restore ${entry.paths.join(', ')} to what ${entry.paths.length === 1 ? 'it' : 'they'} held when this generation began (remove a file that is new), then recheck.`)
  ].filter(Boolean).join(' ');
  return { recorded: recordedNow.map((entry) => entry.id), open, rejected, words, decide: `singularity-flow decisions ${workflow.workItem.id}` };
}
