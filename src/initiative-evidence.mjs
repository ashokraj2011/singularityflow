import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadDefinition } from './config.mjs';
import {
  resolveWorldModelSource, validateWorldModelDirectory, worldModelFreshness, worldModelSourceSnapshot
} from './grounding.mjs';
import {
  EVIDENCE_ASSURANCE
} from './initiative-config.mjs';
import { validateImpactMap } from './initiative-repositories.mjs';
import { verifyEpicTraceability } from './epic-traceability.mjs';
import {
  initiativeRelative, loadInitiative, saveInitiativeDraft, secureInitiativePath,
  verifyInitiativePhaseInputs
} from './state-stores.mjs';
import {
  initiativeMilestoneReadiness, requiredInitiativeMilestone
} from './initiative-milestones.mjs';
import { initiativeCheckRequirement, initiativeOutputRequired } from './initiative-policy.mjs';
import { changedFiles, identity } from './git.mjs';
import {
  secureRepositoryPath, SingularityFlowError, nowIso, repoRelative, snapshot, writeText
} from './util.mjs';
import { contextBoundaryHandoff } from './context-policy.mjs';
import { harvestInitiativeKnowledge } from './knowledge.mjs';
// Imported for use here and re-exported so every existing caller keeps importing them from this
// module. The definitions moved to records.mjs so knowledge.mjs can hash a record without importing
// this one — that cycle is what stopped the approval path from harvesting knowledge. See records.mjs.
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { repositoryCaseInsensitivePaths } from './repository-change-set.mjs';
import { withWorldModelSourceScope } from './source-scope.mjs';
import { resolveWorldModelV4Grounding } from './world-model/commands.mjs';
import {
  cachedWorldModelV4AuthorityPresent, refreshWorldModelV4Authority
} from './world-model/authority-refresh.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
import { isWorldModelAvailabilityError } from './world-model-availability.mjs';

export { canonicalJson, recordSha256 };

const RECORD_CATEGORIES = new Set(['evidence', 'approvals', 'invalidations']);
const RECORD_FAMILIES = Object.freeze({
  evidence: 'initiative-evidence-record',
  approvals: 'initiative-approval-record',
  invalidations: 'initiative-invalidation-record'
});
function actorEmail(actor) { return actor?.email?.trim().toLowerCase() ?? null; }
function actorName(actor) { return actor?.name ?? actorEmail(actor) ?? 'unknown'; }


async function recordDirectory(root, portfolio, initiativeId, category) {
  if (!RECORD_CATEGORIES.has(category)) throw new SingularityFlowError(`Unsupported initiative record category '${category}'.`);
  return secureInitiativePath(root, portfolio, initiativeId, path.join(category, 'records'), {
    label: `Initiative '${initiativeId}' ${category} record directory`,
    type: 'directory'
  });
}

export async function appendInitiativeRecord(root, portfolio, initiativeId, category, record) {
  if (!RECORD_CATEGORIES.has(category)) throw new SingularityFlowError(`Unsupported initiative record category '${category}'.`);
  record = { ...record, schemaVersion: currentSchemaVersion(RECORD_FAMILIES[category]) };
  const sha256 = recordSha256(record);
  await recordDirectory(root, portfolio, initiativeId, category);
  const target = await secureInitiativePath(root, portfolio, initiativeId, path.join(category, 'records', `${sha256}.json`), {
    label: `Initiative '${initiativeId}' ${category} record`,
    type: 'file'
  });
  if (!target.exists) await writeText(target.absolute, canonicalJson(record));
  if (category === 'approvals') await writeInitiativeApprovalSummary(root, portfolio, initiativeId);
  return { sha256, path: target.relative, record };
}

export async function readInitiativeRecords(root, portfolio, initiativeId, category) {
  const directory = await recordDirectory(root, portfolio, initiativeId, category);
  if (!directory.exists) return [];
  const records = [];
  for (const entry of await readdir(directory.absolute, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const target = await secureInitiativePath(root, portfolio, initiativeId, path.join(category, 'records', entry.name), {
      label: `Initiative '${initiativeId}' ${category} record`,
      mustExist: true,
      type: 'file'
    });
    const raw = await readFile(target.absolute, 'utf8');
    let record;
    try { record = readRecord(RECORD_FAMILIES[category], raw).record; }
    catch (error) { throw new SingularityFlowError(`Invalid initiative ${category} record ${entry.name}: ${error.message}`); }
    const expected = entry.name.slice(0, -5);
    const actual = recordSha256(record);
    if (actual !== expected) throw new SingularityFlowError(`Initiative ${category} record ${entry.name} was modified after creation.`);
    records.push({ sha256: actual, path: target.relative, record });
  }
  return records.sort((left, right) => String(left.record.at ?? left.record.observedAt ?? '').localeCompare(String(right.record.at ?? right.record.observedAt ?? '')));
}

export function initiativeApprovalSummary(initiativeId, records) {
  return {
    schemaVersion: currentSchemaVersion('initiative-approval-summary'),
    initiativeId,
    decisions: records.map(({ sha256, path: recordPath, record }) => ({
      sha256,
      path: recordPath,
      decision: record.decision ?? record.type ?? null,
      phase: record.phaseId ?? record.phase ?? null,
      subjectType: record.subject?.type ?? null,
      subjectId: record.subject?.id ?? null,
      subjectHash: record.subject?.sha256 ?? null,
      actor: record.actor ?? null,
      agent: record.agent ?? null,
      authorityGroup: record.subject?.authorityGroup ?? null,
      selfApproval: record.selfApproval === true,
      at: record.at ?? null
    }))
  };
}

export async function writeInitiativeApprovalSummary(root, portfolio, initiativeId) {
  const records = await readInitiativeRecords(root, portfolio, initiativeId, 'approvals');
  const target = await secureInitiativePath(root, portfolio, initiativeId, path.join('approvals', 'SUMMARY.json'), {
    label: `Initiative '${initiativeId}' approval summary`,
    type: 'file'
  });
  await writeText(target.absolute, canonicalJson(initiativeApprovalSummary(initiativeId, records)));
  return target.relative;
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

export function isAuthorized(resolution, policy, actor, records = null) {
  if (policy.mode === 'none') return true;
  const email = actorEmail(actor);
  if (!email) return false;
  // With a chain, only the body whose step is currently open may sign. Callers that have no decision
  // history to reason about (rejection, evidence waivers) fall back to the union of the chain's
  // bodies, which is the same question those callers were always asking.
  if (policy.chain && records) {
    const progress = approvalChainProgress(policy, records);
    if (!progress.open) return false;
    return authorityMembers(resolution, progress.open.authority).has(email);
  }
  return (policy.authorities ?? []).some((authorityId) => authorityMembers(resolution, authorityId).has(email));
}

export function authorityDescription(policy) {
  return (policy.authorities ?? []).join(', ') || 'no configured authority';
}

function authorityMembers(resolution, authorityId) {
  return new Set((resolution.approvalAuthorities?.[authorityId]?.members ?? [])
    .map((member) => String(member.email ?? '').toLowerCase())
    .filter(Boolean));
}

// Each decision records the chain step it satisfied, rather than being matched to a body after the
// fact. Without that, one reviewer who sits on two bodies would silently satisfy both steps with a
// single approval, and the record would not say which body they signed for.
export function approvalChainProgress(policy, records) {
  if (!policy?.chain) return null;
  const steps = policy.chain.map((step, index) => {
    const signatures = new Set(records
      .filter(({ record }) => record.subject?.chainStep === index)
      .map(({ record }) => actorEmail(record.actor))
      .filter(Boolean));
    return {
      index,
      authority: step.authority,
      label: step.label,
      minimum: step.minimum,
      count: signatures.size,
      satisfied: signatures.size >= step.minimum
    };
  });
  const open = steps.find((step) => !step.satisfied) ?? null;
  return { steps, open, satisfied: !open };
}

export function chainStatusDescription(progress) {
  if (!progress) return null;
  if (progress.satisfied) return 'all review steps satisfied';
  return `waiting on ${progress.open.label} (${progress.open.count}/${progress.open.minimum})`;
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
  agent = null,
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
  // A check states which assurance tiers can satisfy it, and evidence at any other tier can never
  // do so. Recording it anyway produced evidence that is stored, listed as active, and permanently
  // inert — the check stays missing and nothing says why. Refusing here is the difference between
  // an afternoon and a sentence. A waiver is exempt: it is a decision about the check rather than
  // evidence for it.
  if (!decision && !check.acceptedAssurance.includes(assurance)) {
    throw new SingularityFlowError(
      `'${phaseId}/${checkId}' cannot be satisfied by ${assurance} evidence. `
      + `It accepts: ${check.acceptedAssurance.join(', ')}.`);
  }
  const actor = identity(root);
  if (!actorEmail(actor)) throw new SingularityFlowError('Initiative evidence requires a configured local Git email.');
  if (assurance === 'human-approved' || decision) {
    const policy = approvalPolicyForCheck(initiative, phaseId, check);
    if (!isAuthorized(initiative.resolution, policy, actor)) throw new SingularityFlowError(`${actorEmail(actor)} is not authorized for '${phaseId}/${checkId}'. Required authority: ${authorityDescription(policy)}.`);
  }
  const normalizedSource = sourceRecord(root, source);
  let sourceSnapshot = { exists: false, size: 0, sha256: null };
  if (normalizedSource.path) {
    // Evidence paths are relative to the repository, but `initiative documents` reports them
    // relative to the initiative — two honest frames for the same file, and copying one into the
    // other fails with "does not exist" and no hint about which frame was wrong.
    let sourceFile;
    try {
      sourceFile = await secureRepositoryPath(root, normalizedSource.path, {
        label: 'Initiative evidence source',
        mustExist: true,
        type: 'file'
      });
    } catch (error) {
      const withinInitiative = path.join(
        initiativeRelative(portfolio, initiative.initiative.id), normalizedSource.path);
      const alternative = await secureRepositoryPath(root, withinInitiative, {
        label: 'Initiative evidence source', mustExist: true, type: 'file'
      }).catch(() => null);
      if (!alternative) throw error;
      throw new SingularityFlowError(
        `${error.message} Did you mean '${withinInitiative}'? `
        + '`initiative documents` reports paths relative to the initiative; `evidence add --path` '
        + 'takes them relative to the repository.');
    }
    sourceSnapshot = await snapshot(sourceFile.absolute);
    const originalPath = normalizedSource.path;
    const destination = await secureInitiativePath(
      root,
      portfolio,
      initiative.initiative.id,
      path.join('evidence', 'files', `${sourceSnapshot.sha256}-${path.basename(originalPath)}`),
      { label: `Initiative evidence snapshot for '${phaseId}/${checkId}'`, type: 'file' }
    );
    await mkdir(path.dirname(destination.absolute), { recursive: true });
    if (!destination.exists) await copyFile(sourceFile.absolute, destination.absolute);
    normalizedSource.originalPath = originalPath;
    normalizedSource.path = destination.relative;
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
    requirement: initiativeCheckRequirement(initiative, phaseId, check),
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
    agent,
    subject,
    decision,
    reason: reason?.trim() || null,
    supersedes: [...new Set(supersedes)]
  };
  const appended = await appendInitiativeRecord(root, portfolio, initiative.initiative.id, 'evidence', record);
  initiative.history.push({
    at: observedAt,
    actor: actorEmail(actor),
    agent,
    event: decision ? `initiative_check_${decision}` : 'initiative_evidence_registered',
    phase: phaseId,
    detail: `${checkId} ${assurance} ${appended.sha256.slice(0, 12)}`
  });
  await saveInitiativeDraft(root, portfolio, initiative);
  return appended;
}

function supersededEvidence(records) {
  return new Set(records.flatMap((item) => item.record.supersedes ?? []));
}

async function evidenceState(root, entry, now) {
  const record = entry.record;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) return { ...entry, status: 'stale', reason: `expired ${record.expiresAt}` };
  if (record.source.path) {
    let source;
    try {
      source = await secureRepositoryPath(root, record.source.path, {
        label: 'Registered initiative evidence',
        mustExist: true,
        type: 'file'
      });
    } catch (error) {
      return { ...entry, status: 'stale', reason: `source is no longer safe: ${error.message}` };
    }
    const current = await snapshot(source.absolute);
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
    // A conditional item is resolved by the initiative's answer to its applicability policy. An
    // explicit evidence decision still wins — somebody who recorded a waiver meant it — but an
    // unanswered policy is reported as such rather than masquerading as missing evidence, because the
    // fix is to answer the question, not to hunt for an artifact.
    const policyId = check.applicability?.policy ?? null;
    const answer = policyId ? initiative.applicability?.[policyId] ?? null : null;
    let status;
    if (decision) status = decision.record.decision;
    else if (answer && answer.applicable === false) status = 'not_applicable';
    else if (accepted.length) status = 'satisfied';
    else if (policyId && !answer) status = 'unanswered';
    else if (initiativeCheckRequirement(initiative, phaseId, check) === 'optional') status = 'optional';
    else if (matching.some((entry) => entry.status === 'stale')) status = 'stale';
    else status = 'missing';
    results.push({
      id: check.id,
      label: check.label,
      requirement: initiativeCheckRequirement(initiative, phaseId, check),
      gate: check.gate,
      status,
      applicabilityPolicy: policyId,
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

function packDefinitions(initiative) {
  return initiative.resolution.packs ?? [];
}

function packDefinition(initiative, packId) {
  const pack = packDefinitions(initiative).find((candidate) => candidate.id === packId);
  if (!pack) throw new SingularityFlowError(`Unknown initiative artifact pack '${packId}'.`);
  return pack;
}

// A pack becomes reviewable at the latest phase that contributes a member: everything it contains has
// been produced by then, and gating it any earlier would block a phase on artifacts that do not exist
// yet. This is what lets one pack span phases.
function packTerminalPhase(initiative, pack) {
  const order = new Map(initiative.resolution.phases.map((phase) => [phase.id, phase.order]));
  let terminal = null;
  let latest = -1;
  for (const member of pack.members) {
    const position = order.get(member.split('/')[0]);
    if (position != null && position > latest) { latest = position; terminal = member.split('/')[0]; }
  }
  return terminal;
}

function packsTerminatingAt(initiative, phaseId) {
  return packDefinitions(initiative).filter((pack) => packTerminalPhase(initiative, pack) === phaseId);
}

// Hash exactly the pack's members, so a pack that spans phases still has one stable identity and an
// approval binds to the precise artifact set a reviewer saw. Missing members are recorded rather than
// skipped: a pack whose member has not been published must not hash the same as a complete one.
function initiativePackBundle(initiative, pack) {
  const members = pack.members.map((member) => {
    const [phaseId, outputId] = member.split('/');
    const output = initiative.phases[phaseId]?.outputs?.[outputId] ?? null;
    return {
      member,
      status: output?.status ?? 'missing',
      generation: output?.generation ?? 0,
      sha256: output?.sha256 ?? null
    };
  }).sort((left, right) => left.member.localeCompare(right.member));
  // A pack may legitimately contain optional outputs — an opportunity brief carries a roadmap only
  // when one exists. Completeness therefore tracks the members the profile actually requires, while
  // the hash still covers every member, so approving a pack binds to whether the optional artifact
  // was present at review time.
  const required = new Set(pack.members.filter((member) => {
    const [phaseId, outputId] = member.split('/');
    return initiativeOutputRequired(initiative, phaseId, outputDefinition(initiative, phaseId, outputId));
  }));
  const value = { initiativeId: initiative.initiative.id, pack: pack.id, members };
  return {
    value,
    sha256: recordSha256(value),
    members: members.map((entry) => ({ ...entry, required: required.has(entry.member) })),
    missing: members.filter((entry) => required.has(entry.member) && (!entry.sha256 || !['published', 'approved'].includes(entry.status)))
  };
}

export function initiativePackState(initiative, phaseId = null) {
  const packs = phaseId ? packsTerminatingAt(initiative, phaseId) : packDefinitions(initiative);
  return packs.map((pack) => {
    const bundle = initiativePackBundle(initiative, pack);
    return {
      id: pack.id,
      label: pack.label,
      members: pack.members,
      terminalPhase: packTerminalPhase(initiative, pack),
      sha256: bundle.sha256,
      complete: bundle.missing.length === 0,
      missing: bundle.missing.map((entry) => entry.member),
      approval: pack.approval
    };
  });
}

export async function initiativeBundle(root, portfolio, initiative, phaseId, { now = new Date() } = {}) {
  const phase = initiative.phases[phaseId];
  const checklist = await evaluateInitiativeChecklist(root, initiative, portfolio, phaseId, { now });
  const evidenceRecords = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'evidence');
  const approvals = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'approvals');
  const invalidations = await readInitiativeRecords(root, portfolio, initiative.initiative.id, 'invalidations');
  const invalidatedApprovals = new Set(invalidations.flatMap((entry) =>
    (entry.record.affected ?? []).filter((node) => node.startsWith('approval:')).map((node) => node.slice('approval:'.length))));
  const requiredMilestone = requiredInitiativeMilestone(phaseId);
  const contracts = requiredMilestone
    ? Object.values(initiative.contracts ?? {}).map((contract) => ({
        id: contract.id,
        version: contract.version,
        sha256: contract.sha256,
        status: contract.status
      })).sort((left, right) => left.id.localeCompare(right.id))
    : [];
  const children = requiredMilestone
    ? Object.values(initiative.childStories ?? {}).filter((story) => story.blocking).map((story) => ({
        id: story.id,
        repository: story.repository,
        blocking: true,
        milestone: requiredMilestone,
        reached: story.milestones?.[requiredMilestone] === true,
        stale: story.stale ?? false
      })).sort((left, right) => left.id.localeCompare(right.id))
    : [];
  const planningIndex = phase.outputs?.['story-specification-index'];
  const planningPackage = phaseId === 'epic-planning' && planningIndex?.sha256
    ? await (await import('./epic-lifecycle.mjs')).verifyEpicPlanningPackage(root, portfolio, initiative)
    : null;
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
    storySpecifications: planningPackage?.storySpecifications ?? [],
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
    if (initiativeOutputRequired(initiative, phaseId, outputDefinitionValue) && (!output.sha256 || !['published', 'approved'].includes(output.status))) errors.push(`required output ${phaseId}/${output.id} is not published`);
    if (!output.sha256) continue;
    const target = await secureInitiativePath(root, portfolio, initiative.initiative.id, output.path, {
      label: `Initiative output '${phaseId}/${output.id}'`,
      type: 'file'
    });
    const current = await snapshot(target.absolute);
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
    const message = check.status === 'unanswered'
      ? `checklist ${phaseId}/${check.id} needs an applicability decision: run singularity-flow initiative applicability set ${check.applicabilityPolicy} yes|no --reason "..."`
      : `checklist ${phaseId}/${check.id} is ${check.status}`;
    if (check.gate === 'block') errors.push(message);
    else if (check.gate === 'warn') warnings.push(message);
  }
  const milestone = initiativeMilestoneReadiness(initiative, phaseId);
  if (milestone.requiredMilestone) {
    if (!milestone.ready) {
      errors.push(`${phaseId} has ${milestone.incomplete.length} blocking stories below ${milestone.requiredMilestone}`);
    } else {
      passes.push(`${phaseId}: all ${milestone.blockingStories} blocking stories reached ${milestone.requiredMilestone}`);
    }
  }
  // Artifact packs are evaluated unconditionally, exactly like individual output approvals, so the
  // pack must be complete and signed off before the phase gate can pass. Publication does not run this
  // evaluation, so a pack can still be assembled and reviewed after its members are published.
  for (const pack of packsTerminatingAt(initiative, phaseId)) {
    const packBundle = initiativePackBundle(initiative, pack);
    if (packBundle.missing.length) {
      errors.push(`artifact pack ${pack.id} is incomplete: ${packBundle.missing.map((entry) => entry.member).join(', ')}`);
      continue;
    }
    if (pack.approval.mode === 'none') {
      passes.push(`artifact pack complete: ${pack.id}@${packBundle.sha256.slice(0, 12)}`);
      continue;
    }
    const decisions = activeApprovalRecords(bundle.approvals, {
      phaseId,
      subjectType: 'pack',
      subjectId: pack.id,
      subjectHash: packBundle.sha256
    }, bundle.invalidatedApprovals);
    const progress = approvalChainProgress(pack.approval, decisions);
    const complete = progress ? progress.satisfied : distinctApprovals(decisions) >= pack.approval.minimum;
    if (!complete) {
      const detail = progress ? chainStatusDescription(progress) : `${distinctApprovals(decisions)}/${pack.approval.minimum} approvals`;
      errors.push(`artifact pack ${pack.id} has ${detail} for exact pack ${packBundle.sha256.slice(0, 12)}`);
    } else {
      passes.push(`artifact pack approval: ${pack.id}@${packBundle.sha256.slice(0, 12)}`);
    }
  }
  if (phase.status === 'approved' && definition.bundleApproval.mode !== 'none') {
    const decisions = activeApprovalRecords(bundle.approvals, {
      phaseId,
      subjectType: 'phase',
      subjectId: phaseId,
      subjectHash: bundle.sha256
    }, bundle.invalidatedApprovals);
    const progress = approvalChainProgress(definition.bundleApproval, decisions);
    const count = distinctApprovals(decisions);
    const complete = progress ? progress.satisfied : count >= definition.bundleApproval.minimum;
    if (!complete) {
      const detail = progress ? chainStatusDescription(progress) : `${count}/${definition.bundleApproval.minimum} approvals`;
      errors.push(`phase ${phaseId} has ${detail} for exact bundle ${bundle.sha256.slice(0, 12)}`);
    } else {
      passes.push(`phase bundle approval: ${phaseId}@${bundle.sha256.slice(0, 12)}`);
    }
  }
  return { ready: errors.length === 0, errors, warnings, passes, bundleSha256: bundle.sha256, checklist: bundle.checklist };
}

// A phase that publishes an impact map (the repository/world-model areas an epic touches) has it
// checked against ground truth before it can be approved: repositories must exist in the portfolio
// and views must exist in the committed world model. Phases without such an output are unaffected.
async function verifyInitiativeImpactMap(root, portfolio, initiative, phaseId) {
  const definition = phaseDefinition(initiative, phaseId).outputs.find((output) => ['repository-map', 'impact-analysis'].includes(output.id));
  if (!definition) return { errors: [], warnings: [] };
  const output = initiative.phases[phaseId].outputs[definition.id];
  const target = await secureInitiativePath(root, portfolio, initiative.initiative.id, output.path, {
    label: `Initiative output '${phaseId}/${output.id}'`,
    type: 'file'
  });
  if (!target.exists) return { errors: [], warnings: [] };

  let impact;
  try { impact = YAML.parse(await readFile(target.absolute, 'utf8')) ?? {}; }
  catch (error) { return { errors: [`impact map ${output.path} is not valid YAML: ${error.message}`], warnings: [] }; }
  if (!impact.repositories || !Object.keys(impact.repositories).length) return { errors: [], warnings: [] };

  const outputDir = initiative.resolution?.worldModelOutputDir ?? 'singularity/world-model';
  let manifest = null;
  let modelDiagnostic = null;
  let modelFailure = 'availability';
  try {
    const definition = withWorldModelSourceScope(
      await loadDefinition(root),
      initiative.resolution?.worldModelSourceScope ?? null
    );
    const ledger = initiative.resolution?.ledger ?? definition.ledger ?? {};
    const stateAuthority = worldModelStateAuthority({
      ...definition,
      ledger: {
        ...(definition.ledger ?? {}),
        ...ledger
      }
    });
    if (definition.worldModel?.format === 'registered-v4') {
      const config = {
        definition,
        ...(initiative.resolution?.capability
          ? { workflow: { resolution: { capability: initiative.resolution.capability } } }
          : {}),
        outputDir,
        stateBranch: stateAuthority.branch,
        remote: stateAuthority.remote,
        staleness: 'warn',
        phases: {
          'initiative-impact': {
            views: definition.worldModel?.views ?? [],
            declaredViews: definition.worldModel?.views ?? [],
            depth: 'standard',
            evidence: false
          }
        }
      };
      const authority = refreshWorldModelV4Authority(root, config, { refreshRemote: true });
      if (authority.status === 'remote-absent') {
        throw new SingularityFlowError(
          'The configured remote state branch has no registered World-Model projection.',
          { code: 'WMB_MANIFEST_MISSING', details: { refresh: authority.status } }
        );
      }
      if (['offline-cached', 'timeout-cached', 'unavailable'].includes(authority.status)
          && !cachedWorldModelV4AuthorityPresent(root, config)) {
        throw new SingularityFlowError(
          'The registered World-Model authority could not be refreshed and has no verified cache.',
          { code: 'WMB_STATE_AUTHORITY_UNAVAILABLE', details: { refresh: authority.status } }
        );
      }
      const resolved = resolveWorldModelV4Grounding(root, config, {
        phase: 'initiative-impact'
      });
      if (!resolved.freshness.fresh) {
        modelDiagnostic = `the preserved registered World Model is stale (${resolved.freshness.reason ?? 'source changed'})`;
      } else {
        manifest = resolved.manifest;
      }
    } else {
      const source = await worldModelSourceSnapshot(root, definition);
      const located = await resolveWorldModelSource(root, {
        ...(definition.worldModel ?? {}),
        outputDir,
        stateBranch: stateAuthority.branch,
        remote: stateAuthority.remote,
        ledger,
        definition
      }, { sourceTreeSha256: source.sha256 });
      const candidate = path.join(located.directory, 'manifest.json');
      const candidateInfo = await snapshot(candidate);
      if (!candidateInfo.exists) {
        modelDiagnostic = `no world-model manifest is available at ${candidate}`;
      } else {
        const validated = await validateWorldModelDirectory(located.directory, {
          integrity: 'full',
          sourceLabel: located.source === 'state-branch'
            ? `governed state-branch world model '${located.branch}'`
            : 'application-projection world model'
        });
        const freshness = await worldModelFreshness(root, definition, validated.manifest);
        if (!freshness.fresh || freshness.built !== source.sha256) {
          modelDiagnostic = `the preserved world model at ${candidate} describes ${freshness.built ?? 'an unknown source'}, not the current scoped source ${source.sha256}`;
        } else {
          manifest = validated.manifest;
        }
      }
    }
  } catch (error) {
    modelDiagnostic = error.message;
    modelFailure = isWorldModelAvailabilityError(error)
      ? 'availability'
      : 'integrity';
  }
  const mode = initiative.resolution?.worldModelGrounding ?? 'off';
  if (!manifest) {
    const message = `impact map references world-model views, but no exact-source validated model is available from governed state or the application projection (${outputDir}): ${modelDiagnostic ?? 'model authority is unavailable'}`;
    const referencesViews = Object.values(impact.repositories).some((entry) => (entry?.worldModelViews ?? entry?.views ?? []).length);
    if (!referencesViews) return { errors: [], warnings: [] };
    return mode === 'enforce' && modelFailure === 'integrity'
      ? { errors: [message], warnings: [] }
      : { errors: [], warnings: [message] };
  }
  return validateImpactMap(portfolio, manifest, impact, { mode });
}

/**
 * A published Story plan has to contain Stories.
 *
 * The template calls itself machine-validated and lists the rules — every entry titled, every
 * `repository` declared in the portfolio, `dependsOn` acyclic and internal. Nothing enforced any of
 * them, so an unfilled template published cleanly: seven governed phases, every pack approved by
 * three separate authorities, and `initiative breakdown` reporting zero epics and zero stories. The
 * governance was real and it was guarding an empty file.
 */
async function verifyInitiativeStoryPlan(root, portfolio, initiative, phaseId) {
  const definition = phaseDefinition(initiative, phaseId).outputs.find((output) => output.id === 'story-plan');
  if (!definition) return { errors: [], warnings: [] };
  const output = initiative.phases[phaseId].outputs[definition.id];
  if (!output?.path) return { errors: [], warnings: [] };
  const target = await secureInitiativePath(root, portfolio, initiative.initiative.id, output.path, {
    label: `Initiative output '${phaseId}/${output.id}'`,
    type: 'file'
  });
  if (!target.exists) return { errors: [], warnings: [] };

  let plan;
  try { plan = YAML.parse(await readFile(target.absolute, 'utf8')) ?? {}; }
  catch (error) { return { errors: [`story plan ${output.path} is not valid YAML: ${error.message}`], warnings: [] }; }

  const errors = [];
  const epics = Array.isArray(plan.epics) ? plan.epics : [];
  if (!epics.length) errors.push(`story plan ${output.path} declares no epics`);

  const planIds = new Set();
  const dependencies = new Map();
  for (const [index, epic] of epics.entries()) {
    const epicId = epic?.planId ?? epic?.id ?? `epic ${index + 1}`;
    if (!String(epic?.title ?? '').trim()) errors.push(`story plan epic '${epicId}' has no title`);
    const stories = Array.isArray(epic?.stories) ? epic.stories : [];
    if (!stories.length) errors.push(`story plan epic '${epicId}' has no stories`);
    for (const [position, story] of stories.entries()) {
      const storyId = story?.planId ?? story?.id ?? `story ${position + 1} of ${epicId}`;
      if (!String(story?.title ?? '').trim()) errors.push(`story plan story '${storyId}' has no title`);
      if (planIds.has(storyId)) errors.push(`story plan reuses plan id '${storyId}'`);
      planIds.add(storyId);
      // A repository is what a Story ships from, so it has to be one the portfolio declares —
      // otherwise materialization has nowhere to create the branch.
      const repository = story?.repository;
      if (repository && !portfolio.repositories?.[repository]) {
        errors.push(`story '${storyId}' names repository '${repository}', which the portfolio does not declare`);
      }
      // A dependency is written as a plan id in the template and normalized to
      // `{ story, requiredPhase }` in the breakdown, so both forms are read here.
      const dependsOn = (Array.isArray(story?.dependsOn) ? story.dependsOn : [])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.story ?? entry?.planId))
        .filter(Boolean);
      dependencies.set(storyId, dependsOn);
    }
  }

  for (const [storyId, dependsOn] of dependencies) {
    for (const other of dependsOn) {
      if (!planIds.has(other)) errors.push(`story '${storyId}' depends on '${other}', which is not in this plan`);
    }
  }
  // The dependency graph becomes the merge order, so a cycle there is a plan that can never be
  // integrated — better said now than discovered during delivery.
  const visiting = new Set();
  const done = new Set();
  const walk = (id, trail) => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`story plan dependencies form a cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    for (const other of dependencies.get(id) ?? []) {
      if (planIds.has(other)) walk(other, [...trail, id]);
    }
    visiting.delete(id);
    done.add(id);
  };
  for (const id of planIds) walk(id, []);

  return { errors: [...new Set(errors)], warnings: [] };
}

function declaresCheck(initiative, phaseId, checkId) {
  return phaseDefinition(initiative, phaseId).checklist.some((check) => check.id === checkId);
}

const TRACEABLE_PHASES = ['epic-requirements', 'epic-planning'];
const MACHINE_CHECKS = Object.freeze({
  'epic-requirements': ['requirements-traceable'],
  'epic-planning': [
    'stories-traceable',
    'repositories-resolved',
    'dependencies-acyclic',
    'story-specifications-complete',
    'acceptance-criteria-covered'
  ]
});

export async function publishInitiativePhase(root, initiativeId, phaseId, { agent = null } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  if (initiative.currentPhase !== phaseId) throw new SingularityFlowError(`Current initiative phase is '${initiative.currentPhase ?? 'complete'}'; cannot publish '${phaseId}'.`);
  const phase = initiative.phases[phaseId];
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Initiative phase '${phaseId}' is ${phase.status}.`);
  await verifyInitiativePhaseInputs(root, portfolio, initiative, phaseId);
  const protectedPaths = initiative.resolution?.capability?.policy?.protectedPaths ?? [];
  const ignoreCase = repositoryCaseInsensitivePaths(root);
  const compare = (value) => ignoreCase ? value.toLocaleLowerCase('en-US') : value;
  const protectedChange = protectedPaths.find((protectedPath) => changedFiles(root).some((file) => {
    const candidate = compare(file);
    const guard = compare(protectedPath.replace(/\/$/, ''));
    return candidate === guard || candidate.startsWith(`${guard}/`);
  }));
  if (protectedChange) {
    throw new SingularityFlowError(`Initiative generation cannot modify protected capability path: ${protectedChange}`);
  }
  if (phaseId === 'epic-planning') {
    await (await import('./epic-lifecycle.mjs')).prepareEpicStorySpecifications(root, initiativeId);
  }
  const actor = identity(root);
  const nextGeneration = phase.generation + 1;
  const missing = [];
  for (const definition of phaseDefinition(initiative, phaseId).outputs) {
    const output = phase.outputs[definition.id];
    const target = await secureInitiativePath(root, portfolio, initiativeId, output.path, {
      label: `Initiative output '${phaseId}/${output.id}'`,
      type: 'file'
    });
    const current = await snapshot(target.absolute);
    if (initiativeOutputRequired(initiative, phaseId, definition) && !current.exists) missing.push(`${definition.id} (${output.path})`);
    if (!current.exists) continue;
    Object.assign(output, {
      status: 'published',
      generation: nextGeneration,
      sha256: current.sha256,
      bytes: current.size,
      generatedBy: output.generatedBy ?? actor,
      generatedAgent: output.generatedAgent ?? agent,
      publishedAt: nowIso()
    });
  }
  if (missing.length) throw new SingularityFlowError(`Initiative phase '${phaseId}' is missing required outputs: ${missing.join(', ')}.`);
  const impact = await verifyInitiativeImpactMap(root, portfolio, initiative, phaseId);
  if (impact.errors.length) throw new SingularityFlowError(`Initiative phase '${phaseId}' impact map is not grounded:\n- ${impact.errors.join('\n- ')}`);
  impact.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));

  const plan = await verifyInitiativeStoryPlan(root, portfolio, initiative, phaseId);
  if (plan.errors.length) throw new SingularityFlowError(`Initiative phase '${phaseId}' story plan cannot be materialized:\n- ${plan.errors.join('\n- ')}`);

  // Traceability is a publication gate, not a CLI courtesy. It used to live in the CLI's publish
  // command, so publishing from the desktop skipped both the check and the evidence it produces —
  // leaving blocking gates permanently unsatisfied and the phase impossible to approve. Verifying
  // here means every surface behaves the same way.
  const traceability = initiative.resolution.profile === 'epic-planning' && TRACEABLE_PHASES.includes(phaseId)
    ? await verifyEpicTraceability(root, portfolio, initiative)
    : null;
  if (traceability?.errors.length) {
    throw new SingularityFlowError(`Cannot publish ${phaseId}:\n- ${traceability.errors.join('\n- ')}`);
  }
  const planningPackage = phaseId === 'epic-planning'
    ? await (await import('./epic-lifecycle.mjs')).verifyEpicPlanningPackage(root, portfolio, initiative)
    : null;
  if (planningPackage && !planningPackage.valid) {
    throw new SingularityFlowError(`Cannot publish ${phaseId}:\n- ${planningPackage.errors.join('\n- ')}`);
  }

  phase.generation = nextGeneration;
  phase.status = 'awaiting_approval';
  phase.submittedAt = nowIso();
  initiative.history.push({ at: phase.submittedAt, actor: actorEmail(actor), agent, event: 'initiative_phase_published', phase: phaseId, detail: `generation ${nextGeneration}` });
  await saveInitiativeDraft(root, portfolio, initiative);

  // Evidence is recorded after the publication is saved: registerInitiativeEvidence reloads state
  // from disk, so registering first would read a pre-publish copy and write it back over this one.
  const machineChecks = [
    ...(traceability ? (MACHINE_CHECKS[phaseId] ?? []).filter((id) => declaresCheck(initiative, phaseId, id)) : []),
    // The impact map was just validated above; recording that result is what allows the phase to be
    // approved at all. Without it the gate stays missing however many times the phase is published.
    // Driven by the phase's own checklist rather than a phase name, so a custom profile that
    // declares the gate gets the evidence too.
    ...(declaresCheck(initiative, phaseId, 'impact-grounded') && !impact.errors.length ? ['impact-grounded'] : [])
  ];
  for (const checkId of machineChecks) {
    await registerInitiativeEvidence(root, {
      initiativeId,
      phaseId,
      checkId,
      assurance: 'machine-verified',
      verificationMethod: checkId === 'impact-grounded' ? 'singularity-impact-map' : 'singularity-epic-traceability',
      source: {
        externalId: initiative.resolution.resolutionSha256,
        version: String(nextGeneration),
        observedState: checkId === 'impact-grounded'
          ? `Impact map repository IDs resolved against the pinned workspace portfolio${impact.warnings.length ? ` with ${impact.warnings.length} warning(s)` : ''}`
          : (traceability?.passes ?? []).join('; ')
      },
      agent
    });
  }

  // Return the state as it now stands on disk, so callers commit what was actually recorded rather
  // than the pre-evidence snapshot.
  const refreshed = await loadInitiative(root, initiativeId);
  return { portfolio: refreshed.portfolio, initiative: refreshed.initiative, phase: refreshed.initiative.phases[phaseId], evidence: machineChecks };
}

function approvalSubject(initiative, phaseId, subject, bundle) {
  if (subject === 'phase') return { definition: phaseDefinition(initiative, phaseId).bundleApproval, type: 'phase', id: phaseId, sha256: bundle.sha256 };
  // Packs are addressed explicitly as 'pack:<id>' so a pack can never be shadowed by an output or
  // checklist item that happens to share its name.
  if (subject.startsWith('pack:')) {
    const pack = packDefinition(initiative, subject.slice('pack:'.length));
    const terminal = packTerminalPhase(initiative, pack);
    if (terminal !== phaseId) throw new SingularityFlowError(`Artifact pack '${pack.id}' is reviewed at phase '${terminal}', not '${phaseId}'.`);
    const packBundle = initiativePackBundle(initiative, pack);
    if (packBundle.missing.length) throw new SingularityFlowError(`Artifact pack '${pack.id}' is incomplete: ${packBundle.missing.map((entry) => entry.member).join(', ')}.`);
    return { definition: pack.approval, type: 'pack', id: pack.id, sha256: packBundle.sha256, generatedBy: null };
  }
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
  throw new SingularityFlowError(`Unknown approval subject '${subject}'. Use phase, 'pack:<id>', an output ID, or a checklist ID.`);
}

export async function approveInitiative(root, {
  initiativeId,
  phaseId = null,
  subject = 'phase',
  agent = null,
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
  const priorDecisions = activeApprovalRecords(bundle.approvals, {
    phaseId: selectedPhase,
    subjectType: target.type,
    subjectId: target.id,
    subjectHash: target.sha256
  }, bundle.invalidatedApprovals);
  const chainBefore = approvalChainProgress(target.definition, priorDecisions);
  if (chainBefore?.satisfied) throw new SingularityFlowError(`${target.type} '${target.id}' has already completed its review chain.`);
  if (!isAuthorized(initiative.resolution, target.definition, actor, priorDecisions)) {
    const required = chainBefore
      ? `${chainBefore.open.label} (chain step ${chainBefore.open.index + 1} of ${chainBefore.steps.length})`
      : authorityDescription(target.definition);
    throw new SingularityFlowError(`${actorEmail(actor)} is not authorized to approve ${target.type} '${target.id}'. Required authority: ${required}.`);
  }
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
  const chainStep = approvalChainProgress(target.definition, current)?.open ?? null;
  const generatedByEmail = actorEmail(target.generatedBy);
  const phaseGeneratedByActor = Object.values(phase.outputs).some((output) => actorEmail(output.generatedBy) === actorEmail(actor));
  const selfApproval = generatedByEmail === actorEmail(actor) || (target.type === 'phase' && phaseGeneratedByActor);
  if (selfApproval && target.definition.allowSelfApproval === false) {
    throw new SingularityFlowError(`Capability and initiative policy prohibit self-approval for ${target.type} '${target.id}'. Ask another authorized Git identity to approve this hash.`);
  }
  const at = nowIso();
  const record = {
    schemaVersion: 1,
    type: 'approval',
    decision: 'approved',
    initiativeId,
    phase: selectedPhase,
    subject: {
      type: target.type,
      id: target.id,
      sha256: target.sha256,
      // Recorded only for chained policies, so a reviewer on two bodies cannot satisfy two steps with
      // one decision, and the record names the body they signed for.
      ...(chainStep ? { chainStep: chainStep.index, authorityGroup: chainStep.authority } : {})
    },
    actor,
    identityAssurance: 'configured-local',
    agent,
    channel,
    at,
    selfApproval
  };
  const appended = await appendInitiativeRecord(root, portfolio, initiativeId, 'approvals', record);
  const after = [...current, appended];
  const chainAfter = approvalChainProgress(target.definition, after);
  const reached = chainAfter ? chainAfter.satisfied : distinctApprovals(after) >= target.definition.minimum;
  if (reached && target.type === 'output') phase.outputs[target.id].status = 'approved';
  if (reached && target.type === 'phase') {
    phase.status = 'approved';
    phase.approvedAt = at;
    const nextId = initiative.phaseOrder
      .slice(initiative.phaseOrder.indexOf(selectedPhase) + 1)
      .find((phaseId) => initiative.phases[phaseId].status !== 'approved') ?? null;
    if (nextId) {
      initiative.phases[nextId].status = 'in_progress';
      initiative.phases[nextId].startedAt ??= at;
      initiative.currentPhase = nextId;
    } else {
      initiative.currentPhase = null;
      initiative.status = 'complete';
    }
  }
  initiative.history.push({
    at,
    actor: actorEmail(actor),
    agent,
    event: selfApproval ? 'initiative_self_approved' : 'initiative_approved',
    phase: selectedPhase,
    detail: `${target.type}/${target.id} ${reached ? 'threshold reached' : 'approval recorded'}`
  });
  await saveInitiativeDraft(root, portfolio, initiative);

  // Approval is the moment an artifact's claims become citable, so it is the moment its decisions,
  // learnings and open uncertainties are worth keeping. Harvesting only when somebody remembered to
  // run `knowledge harvest` meant the store stayed empty in every real Epic, and the feed-forward
  // into later phases had nothing to feed.
  //
  // Deliberately non-fatal: an approval that has already been recorded and saved must not be
  // reported as failed because extracting knowledge from it went wrong. The reason is returned so a
  // caller can surface it rather than swallow it.
  let knowledge = null;
  if (reached) {
    try {
      knowledge = await harvestInitiativeKnowledge(root, portfolio, initiative, { phaseId: selectedPhase });
    } catch (error) {
      knowledge = { harvested: [], skipped: 0, error: error.message };
    }
  }

  const contextBoundary = reached && target.type === 'phase'
    ? contextBoundaryHandoff(initiative.resolution.contextPolicy, selectedPhase, {
      nextPhase: initiative.currentPhase,
      nextSkill: '/sf-initiative-next',
      complete: initiative.status === 'complete'
    })
    : null;
  return { portfolio, initiative, approval: appended, reached, selfApproval, next: initiative.currentPhase, contextBoundary, knowledge };
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
