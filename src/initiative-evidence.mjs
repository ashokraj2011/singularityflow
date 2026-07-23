import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  EVIDENCE_ASSURANCE
} from './initiative-config.mjs';
import {
  initiativeDir, loadInitiative, saveInitiative, verifyInitiativePhaseInputs
} from './initiative-state.mjs';
import { identity } from './git.mjs';
import {
  SingularityFlowError, exists, nowIso, posix, repoRelative, snapshot, writeText
} from './util.mjs';

const RECORD_CATEGORIES = new Set(['evidence', 'approvals', 'invalidations']);

function actorEmail(actor) { return actor?.email?.trim().toLowerCase() ?? null; }
function actorName(actor) { return actor?.name ?? actorEmail(actor) ?? 'unknown'; }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function recordSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function recordDirectory(root, portfolio, initiativeId, category) {
  if (!RECORD_CATEGORIES.has(category)) throw new SingularityFlowError(`Unsupported initiative record category '${category}'.`);
  return path.join(initiativeDir(root, portfolio, initiativeId), category, 'records');
}

export async function appendInitiativeRecord(root, portfolio, initiativeId, category, record) {
  const sha256 = recordSha256(record);
  const directory = recordDirectory(root, portfolio, initiativeId, category);
  const absolute = path.join(directory, `${sha256}.json`);
  if (!(await exists(absolute))) await writeText(absolute, canonicalJson(record));
  return { sha256, path: posix(path.relative(root, absolute)), record };
}

export async function readInitiativeRecords(root, portfolio, initiativeId, category) {
  const directory = recordDirectory(root, portfolio, initiativeId, category);
  if (!(await exists(directory))) return [];
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const raw = await readFile(absolute, 'utf8');
    let record;
    try { record = JSON.parse(raw); }
    catch (error) { throw new SingularityFlowError(`Invalid initiative ${category} record ${entry.name}: ${error.message}`); }
    const expected = entry.name.slice(0, -5);
    const actual = recordSha256(record);
    if (actual !== expected) throw new SingularityFlowError(`Initiative ${category} record ${entry.name} was modified after creation.`);
    records.push({ sha256: actual, path: posix(path.relative(root, absolute)), record });
  }
  return records.sort((left, right) => String(left.record.at ?? left.record.observedAt ?? '').localeCompare(String(right.record.at ?? right.record.observedAt ?? '')));
}

export function durationMilliseconds(value) {
  if (!value) return null;
  const match = /^([1-9]\d*)(m|h|d|w)$/.exec(value);
  if (!match) throw new SingularityFlowError(`Unsupported freshness duration '${value}'.`);
  const multiplier = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return Number(match[1]) * multiplier;
}

function phaseDefinition(initiative, phaseId) {
  const phase = initiative.resolution.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new SingularityFlowError(`Unknown initiative phase '${phaseId}'.`);
  return phase;
}

function checkDefinition(initiative, phaseId, checkId) {
  const check = phaseDefinition(initiative, phaseId).checklist.find((candidate) => candidate.id === checkId);
  if (!check) throw new SingularityFlowError(`Unknown initiative checklist item '${phaseId}/${checkId}'.`);
  return check;
}

function outputDefinition(initiative, phaseId, outputId) {
  const output = phaseDefinition(initiative, phaseId).outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new SingularityFlowError(`Unknown initiative output '${phaseId}/${outputId}'.`);
  return output;
}

export function isAuthorized(resolution, policy, actor) {
  if (policy.mode === 'none') return true;
  const email = actorEmail(actor);
  if (!email) return false;
  return (policy.authorities ?? []).some((authorityId) =>
    (resolution.approvalAuthorities[authorityId]?.members ?? []).some((member) => member.email.toLowerCase() === email));
}

export function authorityDescription(policy) {
  return (policy.authorities ?? []).join(', ') || 'no configured authority';
}

function approvalPolicyForCheck(initiative, phaseId, check) {
  if (check.approval.mode !== 'bundle' || check.approval.authorities.length) return check.approval;
  return phaseDefinition(initiative, phaseId).bundleApproval;
}

function sourceRecord(root, source = {}) {
  const type = source.type ?? (source.path ? 'file' : source.url ? 'url' : 'manual');
  return {
    type,
    path: source.path ? repoRelative(root, source.path) : null,
    url: source.url ?? null,
    externalId: source.externalId ?? null,
    version: source.version ?? null,
    observedState: source.observedState ?? null
  };
}

export async function registerInitiativeEvidence(root, {
  initiativeId,
  phaseId,
  checkId,
  assurance,
  verificationMethod = null,
  source = {},
  subject = null,
  persona = null,
  decision = null,
  reason = null,
  supersedes = []
} = {}) {
  if (!EVIDENCE_ASSURANCE.has(assurance)) throw new SingularityFlowError(`Evidence assurance must be one of: ${[...EVIDENCE_ASSURANCE].join(', ')}.`);
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const phase = initiative.phases[phaseId];
  if (!phase) throw new SingularityFlowError(`Unknown initiative phase '${phaseId}'.`);
  const check = checkDefinition(initiative, phaseId, checkId);
  if (!['not_applicable', 'waived', null].includes(decision)) throw new SingularityFlowError('Evidence decision must be not_applicable or waived.');
  if (decision && check.requirement !== 'conditional') throw new SingularityFlowError(`Only conditional checklist items can be marked ${decision}.`);
  if (decision && assurance !== 'human-approved') throw new SingularityFlowError(`${decision} decisions require human-approved assurance.`);
  const actor = identity(root);
  if (!actorEmail(actor)) throw new SingularityFlowError('Initiative evidence requires a configured local Git email.');
  if (assurance === 'human-approved' || decision) {
    const policy = approvalPolicyForCheck(initiative, phaseId, check);
    if (!isAuthorized(initiative.resolution, policy, actor)) throw new SingularityFlowError(`${actorEmail(actor)} is not authorized for '${phaseId}/${checkId}'. Required authority: ${authorityDescription(policy)}.`);
  }
  const normalizedSource = sourceRecord(root, source);
  let sourceSnapshot = { exists: false, size: 0, sha256: null };
  if (normalizedSource.path) {
    const absolute = path.join(root, normalizedSource.path);
    sourceSnapshot = await snapshot(absolute);
    if (!sourceSnapshot.exists) throw new SingularityFlowError(`Evidence source does not exist: ${normalizedSource.path}`);
    const originalPath = normalizedSource.path;
    const destination = path.join(initiativeDir(root, portfolio, initiative.initiative.id), 'evidence', 'files', `${sourceSnapshot.sha256}-${path.basename(originalPath)}`);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!(await exists(destination))) await copyFile(absolute, destination);
    normalizedSource.originalPath = originalPath;
    normalizedSource.path = posix(path.relative(root, destination));
  } else if (!normalizedSource.url && !normalizedSource.externalId && !normalizedSource.observedState) {
    throw new SingularityFlowError('Evidence requires a repository path, URL, external ID, or observed state.');
  }
  const observedAt = nowIso();
  const validForMs = durationMilliseconds(check.freshness.validFor);
  const record = {
    schemaVersion: 1,
    type: 'evidence',
    initiativeId: initiative.initiative.id,
    phase: phaseId,
    check: checkId,
    requirement: check.requirement,
    assurance,
    identityAssurance: 'configured-local',
    verificationMethod: verificationMethod ?? (assurance === 'presence-only' ? 'presence' : assurance),
    source: normalizedSource,
    sourceSha256: sourceSnapshot.sha256,
    sourceBytes: sourceSnapshot.size,
    observedAt,
    expiresAt: validForMs ? new Date(Date.parse(observedAt) + validForMs).toISOString() : null,
    revalidateAt: check.freshness.revalidateAt,
    registeredBy: actor,
    persona,
    subject,
    decision,
    reason: reason?.trim() || null,
    supersedes: [...new Set(supersedes)]
  };
  const appended = await appendInitiativeRecord(root, portfolio, initiative.initiative.id, 'evidence', record);
  initiative.history.push({
    at: observedAt,
    actor: actorEmail(actor),
    persona,
    event: decision ? `initiative_check_${decision}` : 'initiative_evidence_registered',
    phase: phaseId,
    detail: `${checkId} ${assurance} ${appended.sha256.slice(0, 12)}`
  });
  await saveInitiative(root, portfolio, initiative);
  return appended;
}

function supersededEvidence(records) {
  return new Set(records.flatMap((item) => item.record.supersedes ?? []));
}

async function evidenceState(root, entry, now) {
  const record = entry.record;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) return { ...entry, status: 'stale', reason: `expired ${record.expiresAt}` };
  if (record.source.path) {
    const current = await snapshot(path.join(root, record.source.path));
    if (!current.exists || current.sha256 !== record.sourceSha256) return { ...entry, status: 'stale', reason: 'source changed after evidence registration' };
  }
  return { ...entry, status: 'active', reason: null };
}

export async function evaluateInitiativeChecklist(root, initiative, portfolio, phaseId, { now = new Date() } = {}) {
  const definitions = phaseDefinition(initiative, phaseId).checklist;
  const all = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'evidence');
  const invalidations = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'invalidations');
  const superseded = supersededEvidence(all);
  const results = [];
  for (const check of definitions) {
    const matching = [];
    const checkNode = `check:${phaseId}/${check.id}`;
    const invalidatedAt = invalidations
      .filter((entry) => entry.record.affected?.includes(checkNode))
      .map((entry) => Date.parse(entry.record.at))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0] ?? null;
    for (const entry of all.filter((candidate) => candidate.record.phase === phaseId && candidate.record.check === check.id && !superseded.has(candidate.sha256))) {
      const state = await evidenceState(root, entry, now);
      matching.push(invalidatedAt && Date.parse(entry.record.observedAt) <= invalidatedAt
        ? { ...state, status: 'invalidated', reason: 'dependency cone invalidated this evidence' }
        : state);
    }
    const active = matching.filter((entry) => entry.status === 'active');
    const decision = active.slice().reverse().find((entry) => ['not_applicable', 'waived'].includes(entry.record.decision));
    const accepted = active.filter((entry) => check.acceptedAssurance.includes(entry.record.assurance) && !entry.record.decision);
    let status;
    if (decision) status = decision.record.decision;
    else if (accepted.length) status = 'satisfied';
    else if (check.requirement === 'optional') status = 'optional';
    else if (matching.some((entry) => entry.status === 'stale')) status = 'stale';
    else status = 'missing';
    results.push({
      id: check.id,
      label: check.label,
      requirement: check.requirement,
      gate: check.gate,
      status,
      acceptedAssurance: check.acceptedAssurance,
      evidence: matching.map((entry) => ({
        sha256: entry.sha256,
        assurance: entry.record.assurance,
        status: entry.status,
        reason: entry.reason,
        observedAt: entry.record.observedAt,
        expiresAt: entry.record.expiresAt,
        decision: entry.record.decision
      }))
    });
  }
  return results;
}

function activeApprovalRecords(records, { phaseId, subjectType, subjectId, subjectHash }, invalidated = new Set()) {
  return records.filter(({ record }) =>
    record.decision === 'approved'
    && record.phase === phaseId
    && record.subject.type === subjectType
    && record.subject.id === subjectId
    && record.subject.sha256 === subjectHash
    && !invalidated.has(recordSha256(record))
    && !record.invalidatedBy);
}

function distinctApprovals(records) {
  return new Set(records.map(({ record }) => actorEmail(record.actor))).size;
}

export async function initiativeBundle(root, portfolio, initiative, phaseId, { now = new Date() } = {}) {
  const phase = initiative.phases[phaseId];
  const checklist = await evaluateInitiativeChecklist(root, initiative, portfolio, phaseId, { now });
  const evidenceRecords = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'evidence');
  const approvals = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'approvals');
  const invalidations = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'invalidations');
  const invalidatedApprovals = new Set(invalidations.flatMap((entry) =>
    (entry.record.affected ?? []).filter((node) => node.startsWith('approval:')).map((node) => node.slice('approval:'.length))));
  const contracts = Object.values(initiative.contracts ?? {}).map((contract) => ({
    id: contract.id,
    version: contract.version,
    sha256: contract.sha256,
    status: contract.status
  })).sort((left, right) => left.id.localeCompare(right.id));
  const children = Object.values(initiative.childStories ?? {}).map((story) => ({
    id: story.id,
    repository: story.repository,
    blocking: story.blocking,
    phase: story.currentPhase ?? null,
    status: story.status ?? null,
    observedCommit: story.observedCommit ?? null,
    stale: story.stale ?? false
  })).sort((left, right) => left.id.localeCompare(right.id));
  const value = {
    initiativeId: initiative.initiative.id,
    phase: phaseId,
    generation: phase.generation,
    outputs: Object.values(phase.outputs).map((output) => ({
      id: output.id,
      required: output.required,
      status: output.status,
      generation: output.generation,
      sha256: output.sha256
    })).sort((left, right) => left.id.localeCompare(right.id)),
    checklist: checklist.map((check) => ({
      id: check.id,
      status: check.status,
      evidence: check.evidence.filter((entry) => entry.status === 'active').map((entry) => entry.sha256).sort()
    })),
    evidence: evidenceRecords.filter(({ record }) => record.phase === phaseId).map((entry) => entry.sha256).sort(),
    invalidations: invalidations.filter(({ record }) => (record.affected ?? []).some((node) => node.includes(`:${phaseId}/`) || node === `phase:${phaseId}`)).map((entry) => entry.sha256).sort(),
    contracts,
    children
  };
  return { value, sha256: recordSha256(value), checklist, approvals, invalidations, invalidatedApprovals };
}

export async function evaluateInitiativePhase(root, portfolio, initiative, phaseId, { now = new Date() } = {}) {
  const definition = phaseDefinition(initiative, phaseId);
  const phase = initiative.phases[phaseId];
  const bundle = await initiativeBundle(root, portfolio, initiative, phaseId, { now });
  const errors = [], warnings = [], passes = [];
  for (const outputDefinitionValue of definition.outputs) {
    const output = phase.outputs[outputDefinitionValue.id];
    if (outputDefinitionValue.required && (!output.sha256 || !['published', 'approved'].includes(output.status))) errors.push(`required output ${phaseId}/${output.id} is not published`);
    if (!output.sha256) continue;
    const absolute = path.join(initiativeDir(root, portfolio, initiative.initiative.id), output.path);
    const current = await snapshot(absolute);
    if (!current.exists || current.sha256 !== output.sha256) errors.push(`output ${phaseId}/${output.id} changed after publication`);
    const policy = outputDefinitionValue.approval;
    if (policy.mode === 'individual') {
      const decisions = activeApprovalRecords(bundle.approvals, { phaseId, subjectType: 'output', subjectId: output.id, subjectHash: output.sha256 }, bundle.invalidatedApprovals);
      if (distinctApprovals(decisions) < policy.minimum) errors.push(`output ${phaseId}/${output.id} has ${distinctApprovals(decisions)}/${policy.minimum} approvals`);
      else passes.push(`output approval: ${phaseId}/${output.id}`);
    }
  }
  for (const check of bundle.checklist) {
    if (['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status)) {
      passes.push(`checklist ${phaseId}/${check.id}: ${check.status}`);
      continue;
    }
    const message = `checklist ${phaseId}/${check.id} is ${check.status}`;
    if (check.gate === 'block') errors.push(message);
    else if (check.gate === 'warn') warnings.push(message);
  }
  return { ready: errors.length === 0, errors, warnings, passes, bundleSha256: bundle.sha256, checklist: bundle.checklist };
}

export async function publishInitiativePhase(root, initiativeId, phaseId, { persona = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.currentPhase !== phaseId) throw new SingularityFlowError(`Current initiative phase is '${initiative.currentPhase ?? 'complete'}'; cannot publish '${phaseId}'.`);
  const phase = initiative.phases[phaseId];
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Initiative phase '${phaseId}' is ${phase.status}.`);
  await verifyInitiativePhaseInputs(root, portfolio, initiative, phaseId);
  const actor = identity(root);
  const nextGeneration = phase.generation + 1;
  const missing = [];
  for (const definition of phaseDefinition(initiative, phaseId).outputs) {
    const output = phase.outputs[definition.id];
    const absolute = path.join(initiativeDir(root, portfolio, initiativeId), output.path);
    const current = await snapshot(absolute);
    if (definition.required && !current.exists) missing.push(definition.id);
    if (!current.exists) continue;
    Object.assign(output, {
      status: 'published',
      generation: nextGeneration,
      sha256: current.sha256,
      bytes: current.size,
      generatedBy: output.generatedBy ?? actor,
      generatedPersona: output.generatedPersona ?? persona,
      publishedAt: nowIso()
    });
  }
  if (missing.length) throw new SingularityFlowError(`Initiative phase '${phaseId}' is missing required outputs: ${missing.join(', ')}.`);
  phase.generation = nextGeneration;
  phase.status = 'awaiting_approval';
  phase.submittedAt = nowIso();
  initiative.history.push({ at: phase.submittedAt, actor: actorEmail(actor), persona, event: 'initiative_phase_published', phase: phaseId, detail: `generation ${nextGeneration}` });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, phase };
}

function approvalSubject(initiative, phaseId, subject, bundle) {
  if (subject === 'phase') return { definition: phaseDefinition(initiative, phaseId).bundleApproval, type: 'phase', id: phaseId, sha256: bundle.sha256 };
  const output = initiative.phases[phaseId].outputs[subject];
  if (output) return { definition: outputDefinition(initiative, phaseId, subject).approval, type: 'output', id: subject, sha256: output.sha256, generatedBy: output.generatedBy };
  const check = initiative.phases[phaseId].checklist[subject];
  if (check) {
    const definition = checkDefinition(initiative, phaseId, subject);
    const projection = bundle.checklist.find((item) => item.id === subject);
    return {
      definition: approvalPolicyForCheck(initiative, phaseId, definition),
      type: 'check',
      id: subject,
      sha256: recordSha256(projection),
      generatedBy: null
    };
  }
  throw new SingularityFlowError(`Unknown approval subject '${subject}'. Use phase, an output ID, or a checklist ID.`);
}

export async function approveInitiative(root, {
  initiativeId,
  phaseId = null,
  subject = 'phase',
  persona = null,
  channel = 'terminal'
} = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const selectedPhase = phaseId ?? initiative.currentPhase;
  if (selectedPhase !== initiative.currentPhase) throw new SingularityFlowError(`Current initiative phase is '${initiative.currentPhase ?? 'complete'}'.`);
  const phase = initiative.phases[selectedPhase];
  if (phase.status !== 'awaiting_approval') throw new SingularityFlowError(`Initiative phase '${selectedPhase}' is ${phase.status}; approval requires awaiting_approval.`);
  const bundle = await initiativeBundle(root, portfolio, initiative, selectedPhase);
  const target = approvalSubject(initiative, selectedPhase, subject, bundle);
  if (!target.sha256) throw new SingularityFlowError(`Approval subject '${subject}' has no published hash.`);
  const actor = identity(root);
  if (!actorEmail(actor)) throw new SingularityFlowError('Initiative approval requires a configured local Git email.');
  if (!isAuthorized(initiative.resolution, target.definition, actor)) throw new SingularityFlowError(`${actorEmail(actor)} is not authorized to approve ${target.type} '${target.id}'. Required authority: ${authorityDescription(target.definition)}.`);
  if (target.type === 'phase') {
    const gate = await evaluateInitiativePhase(root, portfolio, initiative, selectedPhase);
    if (!gate.ready) throw new SingularityFlowError(`Initiative phase '${selectedPhase}' is not ready:\n- ${gate.errors.join('\n- ')}`);
  }
  const approvals = await readInitiativeRecords(root, portfolio, initiativeId, 'approvals');
  const current = activeApprovalRecords(approvals, {
    phaseId: selectedPhase,
    subjectType: target.type,
    subjectId: target.id,
    subjectHash: target.sha256
  }, bundle.invalidatedApprovals);
  if (current.some(({ record }) => actorEmail(record.actor) === actorEmail(actor))) throw new SingularityFlowError(`${actorEmail(actor)} already approved this exact ${target.type} hash.`);
  const generatedByEmail = actorEmail(target.generatedBy);
  const phaseGeneratedByActor = Object.values(phase.outputs).some((output) => actorEmail(output.generatedBy) === actorEmail(actor));
  const selfApproval = generatedByEmail === actorEmail(actor) || (target.type === 'phase' && phaseGeneratedByActor);
  const at = nowIso();
  const record = {
    schemaVersion: 1,
    type: 'approval',
    decision: 'approved',
    initiativeId,
    phase: selectedPhase,
    subject: { type: target.type, id: target.id, sha256: target.sha256 },
    actor,
    identityAssurance: 'configured-local',
    persona,
    channel,
    at,
    selfApproval
  };
  const appended = await appendInitiativeRecord(root, portfolio, initiativeId, 'approvals', record);
  const after = [...current, appended];
  const reached = distinctApprovals(after) >= target.definition.minimum;
  if (reached && target.type === 'output') phase.outputs[target.id].status = 'approved';
  if (reached && target.type === 'phase') {
    phase.status = 'approved';
    phase.approvedAt = at;
    const nextId = initiative.phaseOrder[initiative.phaseOrder.indexOf(selectedPhase) + 1] ?? null;
    if (nextId) {
      initiative.phases[nextId].status = 'in_progress';
      initiative.phases[nextId].startedAt = at;
      initiative.currentPhase = nextId;
    } else {
      initiative.currentPhase = null;
      initiative.status = 'complete';
    }
  }
  initiative.history.push({
    at,
    actor: actorEmail(actor),
    persona,
    event: selfApproval ? 'initiative_self_approved' : 'initiative_approved',
    phase: selectedPhase,
    detail: `${target.type}/${target.id} ${reached ? 'threshold reached' : 'approval recorded'}`
  });
  await saveInitiative(root, portfolio, initiative);
  return { portfolio, initiative, approval: appended, reached, selfApproval, next: initiative.currentPhase };
}

export async function initiativeEvidenceStatus(root, initiativeId, phaseId = null, { now = new Date() } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const selectedPhase = phaseId ?? initiative.currentPhase ?? initiative.phaseOrder.at(-1);
  const gate = await evaluateInitiativePhase(root, portfolio, initiative, selectedPhase, { now });
  return {
    initiativeId,
    phase: selectedPhase,
    identityAssurance: 'configured-local',
    ...gate
  };
}
