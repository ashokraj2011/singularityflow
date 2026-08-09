import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { deriveReport } from './report.mjs';
import { identity } from './git.mjs';
import { nowIso, readJson, secureRepositoryPath, SingularityFlowError, snapshot, writeJson, writeText } from './util.mjs';
import {
  DEFAULT_IMPACT_METRIC_AUTHORITIES, deterministicStudyGroup, eligibleImpactStudies, IMPACT_BANDS, IMPACT_METRICS
} from './impact-config.mjs';

export const IMPACT_EVIDENCE_STATUSES = Object.freeze(['exact', 'partial', 'self-reported', 'unavailable']);
export const IMPACT_EXPOSURE_LEVELS = Object.freeze(['available', 'invoked', 'artifact-assisted', 'code-assisted', 'agent-executed', 'unknown']);
export const IMPACT_ASSURANCE_LEVELS = Object.freeze(['host-observed', 'provider-verified', 'attested', 'unknown']);
export const IMPACT_EVIDENCE_ASSURANCE_LEVELS = Object.freeze([
  ...IMPACT_ASSURANCE_LEVELS, 'provider-signed', 'unverified-import', 'kernel-derived'
]);
/**
 * Assurance levels an allowlisted external provider's observation can carry. `attested` is what
 * `collectImpactEvidence` stamps today; the two provider-* levels are reserved for a future
 * signature check and rank above it. Deliberately excludes `unverified-import` — a hand-edited file
 * is not a provider observation however trusted the provider ID it names.
 */
export const PROVIDER_ASSURANCE_LEVELS = Object.freeze(['provider-signed', 'provider-verified', 'attested']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function canonicalJson(value) { return JSON.stringify(stable(value)); }
export function impactSha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex'); }

function measurementRoot(root, config, workflow) {
  return path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'measurement');
}

function relative(root, absolute) { return path.relative(root, absolute).split(path.sep).join('/'); }

function timePeriod(iso, kind) {
  const date = new Date(iso);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  if (kind === 'month') return `${year}-${String(month).padStart(2, '0')}`;
  if (kind === 'quarter') return `${year}-Q${Math.ceil(month / 3)}`;
  if (kind === 'half-year') return `${year}-H${month <= 6 ? 1 : 2}`;
  return String(year);
}

function suggestedClassification(source = {}) {
  const acceptanceCriteria = source.acceptanceCriteria ?? source.acceptance_criteria ?? [];
  const repositoryCount = new Set([source.repository, ...(source.repositories ?? [])].filter(Boolean)).size || 1;
  const dependencyCount = source.dependencies?.length ?? 0;
  const text = `${source.title ?? ''} ${source.description ?? ''}`.toLowerCase();
  let score = Math.min(8, acceptanceCriteria.length) + Math.max(0, repositoryCount - 1) * 3 + Math.min(6, dependencyCount * 2);
  if (/migration|security|privacy|compliance|breaking change/.test(text)) score += 4;
  const complexity = score >= 13 ? 'extra-large' : score >= 8 ? 'large' : score >= 4 ? 'medium' : 'small';
  const risk = /security|privacy|compliance|production data|payment/.test(text)
    ? 'large'
    : /migration|breaking change|cross[- ]repo/.test(text) ? 'medium' : 'small';
  return { complexity, risk, signals: { acceptanceCriteria: acceptanceCriteria.length, repositoryCount, dependencyCount } };
}

export async function initializeStoryImpact(root, config, workflow, source) {
  const impact = workflow.resolution?.impact;
  const studies = eligibleImpactStudies(impact, {
    workType: workflow.workItem.workType,
    capabilityId: workflow.resolution?.capability?.id ?? null
  });
  workflow.measurement = {
    schemaVersion: 1,
    status: studies.length ? 'classification-required' : 'not-enrolled',
    plan: null,
    exposures: [],
    evidence: [],
    receipt: null,
    invalidations: []
  };
  if (!studies.length) return null;
  const study = studies[0];
  const group = deterministicStudyGroup(study, workflow.workItem.id);
  const suggested = suggestedClassification(source);
  const createdAt = workflow.workItem.createdAt;
  const core = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    study: { id: study.id, configurationSha256: impact.sha256, configurationPath: impact.path },
    method: study.method,
    group: { id: group.id, plannedAssistanceMode: group.assistanceMode },
    classification: { suggested, confirmed: null, confirmedAt: null, confirmedBy: null },
    matching: {
      capability: workflow.resolution?.capability?.id ?? 'unmapped',
      repositoryClass: workflow.resolution?.capability?.kind ?? 'repository',
      workType: workflow.workItem.workType,
      timePeriod: timePeriod(createdAt, study.matching.timePeriod)
    },
    enrollment: { mode: 'automatic', enrolledAt: createdAt, optedOutAt: null, reason: null }
  };
  const plan = { ...core, integrity: { sha256: impactSha256(core) } };
  const file = path.join(measurementRoot(root, config, workflow), 'plan.json');
  await writeJson(file, plan);
  workflow.measurement.plan = { path: relative(root, file), sha256: plan.integrity.sha256, studyId: study.id, groupId: group.id };
  workflow.measurement.classification = structuredClone(plan.classification);
  return { plan, path: relative(root, file) };
}

export function impactImplementationGate(workflow, phaseId) {
  if (phaseId !== 'implementation' || !workflow.measurement?.plan || workflow.measurement.status === 'opted-out') return null;
  const confirmed = workflow.measurement.classification?.confirmed;
  if (confirmed?.complexity && confirmed?.risk) return null;
  return `Story '${workflow.workItem.id}' is enrolled in impact study '${workflow.measurement.plan.studyId}'. Confirm complexity and risk before implementation: singularity-flow impact enroll ${workflow.workItem.id} --complexity <${IMPACT_BANDS.join('|')}> --risk <${IMPACT_BANDS.join('|')}> --confirm.`;
}

async function readPlan(root, workflow) {
  if (!workflow.measurement?.plan?.path) return null;
  const target = await secureRepositoryPath(root, workflow.measurement.plan.path, { label: 'Impact plan', type: 'file' });
  if (!target.exists) throw new SingularityFlowError(`Impact plan is missing: ${workflow.measurement.plan.path}.`);
  const plan = await readJson(target.absolute);
  const { integrity, ...core } = plan;
  if (integrity?.sha256 !== impactSha256(core)) throw new SingularityFlowError(`Impact plan hash mismatch for ${workflow.workItem.id}.`);
  return plan;
}

export async function confirmImpactEnrollment(root, config, workflow, { complexity, risk, optOut = false, reason = null } = {}) {
  const plan = await readPlan(root, workflow);
  if (!plan) throw new SingularityFlowError(`Story '${workflow.workItem.id}' is not enrolled in an impact study.`);
  if (workflow.lineage?.deliveryStatus === 'finalized_for_review') throw new SingularityFlowError('Impact enrollment cannot be changed after Story finalization.');
  const actor = identity(root, { offline: true });
  const at = nowIso();
  if (optOut) {
    if (!reason?.trim()) throw new SingularityFlowError('Impact study opt-out requires --reason.');
    plan.enrollment.optedOutAt = at;
    plan.enrollment.reason = reason.trim();
    workflow.measurement.status = 'opted-out';
  } else {
    if (!IMPACT_BANDS.includes(complexity) || !IMPACT_BANDS.includes(risk)) throw new SingularityFlowError(`Complexity and risk must be one of: ${IMPACT_BANDS.join(', ')}.`);
    plan.classification.confirmed = { complexity, risk };
    plan.classification.confirmedAt = at;
    plan.classification.confirmedBy = { name: actor.name, email: actor.email };
    workflow.measurement.status = 'enrolled';
  }
  const { integrity: _prior, ...core } = plan;
  plan.integrity = { sha256: impactSha256(core) };
  await writeJson(path.join(root, workflow.measurement.plan.path), plan);
  workflow.measurement.plan.sha256 = plan.integrity.sha256;
  workflow.measurement.classification = structuredClone(plan.classification);
  workflow.history.push({ at, actor: actor.email?.toLowerCase() ?? actor.name, event: optOut ? 'impact_opted_out' : 'impact_classified', phase: workflow.currentPhase, detail: optOut ? reason : `${complexity}/${risk}` });
  return plan;
}

export async function hydrateImpactPlan(root, workflow) {
  if (!workflow.measurement?.plan) return workflow;
  const plan = await readPlan(root, workflow);
  workflow.measurement.classification = structuredClone(plan.classification);
  return workflow;
}

export async function invalidateImpactReceipt(root, config, workflow, {
  reason, cause = 'workflow-reopened', actor = null, agent = null
} = {}) {
  const receipt = workflow.measurement?.receipt;
  if (!receipt || receipt.status === 'invalidated') return null;
  const core = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    receiptSha256: receipt.sha256,
    cause,
    reason: reason?.trim() || cause,
    invalidatedAt: nowIso(),
    actor: actor ?? identity(root),
    agent
  };
  const record = { ...core, integrity: { sha256: impactSha256(core) } };
  const file = path.join(measurementRoot(root, config, workflow), 'invalidations', `${record.integrity.sha256}.json`);
  await writeJson(file, record);
  receipt.status = 'invalidated';
  receipt.invalidatedAt = record.invalidatedAt;
  workflow.measurement.status = 'invalidated';
  workflow.measurement.invalidations ??= [];
  workflow.measurement.invalidations.push({ path: relative(root, file), sha256: record.integrity.sha256, receiptSha256: receipt.sha256 });
  workflow.history.push({
    at: record.invalidatedAt,
    actor: record.actor?.email?.toLowerCase() ?? record.actor?.name ?? 'unknown',
    agent,
    event: 'impact_invalidated',
    phase: workflow.currentPhase,
    detail: `${cause}: ${record.reason}`
  });
  return { record, path: relative(root, file) };
}

export async function recordImpactExposure(root, config, workflow, { phaseId, level, assurance, reason = null } = {}) {
  if (!workflow.phases?.[phaseId]) throw new SingularityFlowError(`Unknown phase '${phaseId}'.`);
  if (!IMPACT_EXPOSURE_LEVELS.includes(level)) throw new SingularityFlowError(`Exposure level must be ${IMPACT_EXPOSURE_LEVELS.join(', ')}.`);
  if (!IMPACT_ASSURANCE_LEVELS.includes(assurance)) throw new SingularityFlowError(`Exposure assurance must be ${IMPACT_ASSURANCE_LEVELS.join(', ')}.`);
  if (['artifact-assisted', 'code-assisted', 'agent-executed'].includes(level) && !['host-observed', 'provider-verified', 'attested'].includes(assurance)) {
    throw new SingularityFlowError(`${level} exposure requires host-observed, provider-verified, or attested assurance.`);
  }
  const core = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    phaseId,
    level,
    assurance,
    observationStatus: assurance === 'attested' ? 'self-reported' : assurance === 'unknown' ? 'unavailable' : 'exact',
    reason: reason?.trim() || null,
    capturedAt: nowIso(),
    actor: identity(root)
  };
  const record = { ...core, integrity: { sha256: impactSha256(core) } };
  const file = path.join(measurementRoot(root, config, workflow), 'exposure', `${record.integrity.sha256}.json`);
  await writeJson(file, record);
  workflow.measurement ??= { schemaVersion: 1, exposures: [], evidence: [], invalidations: [] };
  workflow.measurement.exposures ??= [];
  workflow.measurement.exposures.push({ path: relative(root, file), sha256: record.integrity.sha256, phaseId, level, assurance });
  return { record, path: relative(root, file) };
}

export function validateImpactEvidence(value, { expectedWorkId = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('Impact evidence must be an object.');
  const permitted = ['schemaVersion', 'evidenceId', 'kind', 'provider', 'subject', 'observation', 'source', 'actor', 'capturedAt', 'integrity'];
  for (const key of Object.keys(value)) if (!permitted.includes(key)) throw new SingularityFlowError(`Impact evidence contains forbidden field '${key}'. Providers may submit observations only.`);
  if (value.schemaVersion !== 1) throw new SingularityFlowError('Impact evidence schemaVersion must be 1.');
  const strictObject = (candidate, fields, label) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new SingularityFlowError(`Impact evidence ${label} must be an object.`);
    for (const key of Object.keys(candidate)) if (!fields.includes(key)) throw new SingularityFlowError(`Impact evidence ${label} contains forbidden field '${key}'.`);
  };
  strictObject(value.provider, ['id', 'version', 'assurance'], 'provider');
  strictObject(value.subject, ['workId', 'phaseId', 'generation', 'commitSha'], 'subject');
  strictObject(value.observation, ['metric', 'value', 'unit', 'status'], 'observation');
  strictObject(value.source, ['type', 'id', 'sha256', 'url', 'path'], 'source');
  if (value.actor != null) strictObject(value.actor, ['name', 'email'], 'actor');
  if (!value.provider?.id || !value.provider?.version) throw new SingularityFlowError('Impact evidence requires provider id and version.');
  if (value.provider.assurance != null && !IMPACT_EVIDENCE_ASSURANCE_LEVELS.includes(value.provider.assurance)) throw new SingularityFlowError('Impact evidence provider assurance is invalid.');
  if (['attested', 'unverified-import'].includes(value.provider.assurance) && (!value.actor?.name?.trim() || !value.actor?.email?.trim())) {
    throw new SingularityFlowError(`${value.provider.assurance} impact evidence requires actor name and email provenance.`);
  }
  if (!value.subject?.workId || (expectedWorkId && value.subject.workId !== expectedWorkId)) throw new SingularityFlowError(`Impact evidence subject must be Story '${expectedWorkId ?? '<work-id>'}'.`);
  if (value.subject.commitSha && !/^[a-f0-9]{40}$/.test(value.subject.commitSha)) throw new SingularityFlowError('Impact evidence commitSha must be a full Git SHA.');
  if (value.subject.generation != null && (!Number.isInteger(value.subject.generation) || value.subject.generation < 0)) throw new SingularityFlowError('Impact evidence generation must be a non-negative integer.');
  if (!IMPACT_METRICS[value.observation?.metric]) throw new SingularityFlowError(`Unknown impact metric '${value.observation?.metric}'.`);
  if (value.observation.unit !== IMPACT_METRICS[value.observation.metric].unit) throw new SingularityFlowError(`Impact metric '${value.observation.metric}' must use unit '${IMPACT_METRICS[value.observation.metric].unit}'.`);
  if (!IMPACT_EVIDENCE_STATUSES.includes(value.observation?.status)) throw new SingularityFlowError(`Impact observation status must be ${IMPACT_EVIDENCE_STATUSES.join(', ')}.`);
  if (value.observation.status === 'unavailable' && value.observation.value != null) throw new SingularityFlowError('Unavailable observations must not contain an estimated value.');
  if (value.observation.status !== 'unavailable' && !Number.isFinite(value.observation.value)) throw new SingularityFlowError('Available impact observations require a finite numeric value.');
  if (!value.source.type?.trim()) throw new SingularityFlowError('Impact evidence source.type is required.');
  if (value.source.sha256 != null && !/^[a-f0-9]{64}$/.test(value.source.sha256)) throw new SingularityFlowError('Impact evidence source.sha256 must be a full SHA-256 hash.');
  if (!value.kind?.trim()) throw new SingularityFlowError('Impact evidence kind is required.');
  if (!value.capturedAt || Number.isNaN(Date.parse(value.capturedAt))) throw new SingularityFlowError('Impact evidence capturedAt must be an ISO timestamp.');
  const { integrity, ...unidentifiedCore } = value;
  const evidenceId = value.evidenceId ?? impactSha256(unidentifiedCore);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(evidenceId)) throw new SingularityFlowError('Impact evidenceId must be a safe identifier without path separators.');
  const core = { ...unidentifiedCore, evidenceId };
  const expected = impactSha256(core);
  if (integrity?.sha256 && integrity.sha256 !== expected) throw new SingularityFlowError(`Impact evidence integrity mismatch for '${value.evidenceId ?? 'unknown'}'.`);
  return { ...core, integrity: { sha256: expected } };
}

function authorityFor(workflow, metric) {
  return workflow.resolution?.impact?.metricAuthorities?.[metric] ?? DEFAULT_IMPACT_METRIC_AUTHORITIES[metric];
}

function assertEvidenceAuthority(workflow, record) {
  const metric = record.observation.metric;
  const authority = authorityFor(workflow, metric);
  const assurance = record.provider.assurance ?? 'unknown';
  const providerAllowed = (authority.providers ?? []).includes(record.provider.id);
  const kernel = assurance === 'kernel-derived' && record.provider.id === 'singularity-flow';
  // The governance property `external-provider` asserts is that the observation came from a provider
  // the configuration allowlists — that is what `providerAllowed` checks. The assurance floor only
  // has to exclude evidence a provider did not produce: a hand-edited import, or an unknown level.
  // Requiring `provider-verified`/`provider-signed` made the mode unsatisfiable, because the only
  // two producers stamp `attested` (collect) and `unverified-import` (import), so no user action
  // could ever satisfy it — and `composite` silently degraded to `kernel-only` for the same reason.
  const external = providerAllowed && PROVIDER_ASSURANCE_LEVELS.includes(assurance);
  const attested = ['attested', 'unverified-import'].includes(assurance) && record.actor?.name && record.actor?.email;
  const accepted = authority.authority === 'kernel-only' ? kernel
    : authority.authority === 'external-provider' ? external
      : authority.authority === 'attested' ? attested
        : kernel || external;
  if (!accepted) {
    throw new SingularityFlowError(`Impact metric '${metric}' is governed by '${authority.authority}' authority; evidence from '${record.provider.id}' with '${assurance}' assurance is not authoritative.`);
  }
  return authority;
}

function oneConsistentObservation(metric, records) {
  const values = new Set(records.map((record) => canonicalJson(record.observation)));
  if (values.size > 1) throw new SingularityFlowError(`Conflicting authoritative observations exist for impact metric '${metric}'. Resolve the conflict explicitly; evidence ID ordering is not an authority rule.`);
  return records.toSorted((a, b) => a.evidenceId.localeCompare(b.evidenceId))[0];
}

export function selectAuthoritativeImpactEvidence(workflow, records) {
  const unique = [...new Map(records.map((record) => [record.evidenceId, record])).values()];
  const byMetric = new Map();
  for (const record of unique) byMetric.set(record.observation.metric, [...(byMetric.get(record.observation.metric) ?? []), record]);
  const selected = new Map();
  for (const [metric, candidates] of byMetric) {
    const authority = authorityFor(workflow, metric);
    for (const candidate of candidates) assertEvidenceAuthority(workflow, candidate);
    const kernel = candidates.filter((record) => record.provider.assurance === 'kernel-derived');
    const preferred = authority.authority === 'composite' && authority.reducer === 'prefer-kernel' && kernel.length ? kernel : candidates;
    selected.set(metric, oneConsistentObservation(metric, preferred));
  }
  return { observations: unique.toSorted((a, b) => `${a.observation.metric}:${a.evidenceId}`.localeCompare(`${b.observation.metric}:${b.evidenceId}`)), selected };
}

export async function importImpactEvidence(root, config, workflow, file) {
  const text = await readFile(file, 'utf8');
  let parsed;
  try { parsed = /\.ya?ml$/i.test(file) ? YAML.parse(text) : JSON.parse(text); } catch (error) { throw new SingularityFlowError(`Cannot parse impact evidence ${file}: ${error.message}`); }
  const supplied = validateImpactEvidence(parsed, { expectedWorkId: workflow.workItem.id });
  const actor = identity(root, { offline: true });
  const { integrity: _integrity, ...suppliedCore } = supplied;
  const record = validateImpactEvidence({
    ...suppliedCore,
    provider: { ...supplied.provider, assurance: 'unverified-import' },
    actor: { name: actor.name, email: actor.email }
  }, { expectedWorkId: workflow.workItem.id });
  assertEvidenceAuthority(workflow, record);
  const target = path.join(measurementRoot(root, config, workflow), 'evidence', `${record.evidenceId}.json`);
  await writeJson(target, record);
  workflow.measurement ??= { schemaVersion: 1, exposures: [], evidence: [], invalidations: [] };
  workflow.measurement.evidence ??= [];
  workflow.measurement.evidence = [
    ...workflow.measurement.evidence.filter((item) => item.evidenceId !== record.evidenceId),
    { evidenceId: record.evidenceId, path: relative(root, target), sha256: record.integrity.sha256, metric: record.observation.metric }
  ];
  return { record, path: relative(root, target) };
}

export async function collectImpactEvidence(root, config, workflow, {
  providerId, providerVersion = '1', runId, file, commitSha,
  phaseId = null, generation = null, kind = null, capturedAt = null
} = {}) {
  if (!providerId?.trim()) throw new SingularityFlowError('Impact evidence collection requires a provider ID.');
  if (!runId?.trim()) throw new SingularityFlowError('Impact evidence collection requires --run-id.');
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw new SingularityFlowError('Impact evidence collection requires --commit with a full Git SHA.');
  const text = await readFile(file, 'utf8');
  let observation;
  try { observation = /\.ya?ml$/i.test(file) ? YAML.parse(text) : JSON.parse(text); } catch (error) {
    throw new SingularityFlowError(`Cannot parse provider observation ${file}: ${error.message}`);
  }
  const permitted = ['metric', 'value', 'unit', 'status'];
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new SingularityFlowError('Provider observation must be an object.');
  for (const key of Object.keys(observation)) if (!permitted.includes(key)) throw new SingularityFlowError(`Provider observation contains forbidden field '${key}'.`);
  const actor = identity(root);
  const core = {
    schemaVersion: 1,
    kind: kind?.trim() || `${providerId.trim()}-observation`,
    provider: { id: providerId.trim(), version: providerVersion.trim(), assurance: 'attested' },
    actor: { name: actor.name, email: actor.email },
    subject: {
      workId: workflow.workItem.id,
      phaseId: phaseId || workflow.currentPhase || null,
      generation: generation == null ? null : Number(generation),
      commitSha
    },
    observation,
    source: { type: 'provider-run', id: runId.trim(), sha256: impactSha256(text) },
    capturedAt: capturedAt || nowIso()
  };
  const record = validateImpactEvidence(core, { expectedWorkId: workflow.workItem.id });
  assertEvidenceAuthority(workflow, record);
  const target = path.join(measurementRoot(root, config, workflow), 'evidence', `${record.evidenceId}.json`);
  await writeJson(target, record);
  workflow.measurement ??= { schemaVersion: 1, exposures: [], evidence: [], invalidations: [] };
  workflow.measurement.evidence ??= [];
  workflow.measurement.evidence = [
    ...workflow.measurement.evidence.filter((item) => item.evidenceId !== record.evidenceId),
    { evidenceId: record.evidenceId, path: relative(root, target), sha256: record.integrity.sha256, metric: record.observation.metric }
  ];
  return { record, path: relative(root, target) };
}

function nativeMetricRecords(workflow, report, finalization) {
  const usage = workflow.phaseOrder.flatMap((phaseId) => workflow.phases[phaseId]?.usage ?? []);
  const usageMetric = (field) => {
    const values = usage.filter((record) => record.status === 'exact' && Number.isFinite(record[field]));
    return {
      value: values.length ? values.reduce((sum, record) => sum + record[field], 0) : null,
      status: !values.length ? 'unavailable' : values.length === usage.length ? 'exact' : 'partial'
    };
  };
  const inputTokens = usageMetric('inputTokens');
  const outputTokens = usageMetric('outputTokens');
  const cachedInputTokens = usageMetric('cachedInputTokens');
  const totalTokens = usageMetric('totalTokens');
  const metrics = {
    'flow-time-excluding-approval-wait-ms': { value: report.flowTimeExcludingApprovalWaitMs },
    'elapsed-ms': { value: report.elapsedMs },
    'approval-wait-ms': { value: report.waitingMs },
    'rework-cycles': { value: report.reworkCycles },
    rejections: { value: report.rejections.length },
    'self-approvals': { value: report.selfApprovals },
    'sequence-overrides': { value: report.sequenceOverrides.length },
    'input-tokens': inputTokens,
    'output-tokens': outputTokens,
    'cached-input-tokens': cachedInputTokens,
    'total-tokens': totalTokens,
    'cost-usd': { value: report.cost, status: report.cost == null ? 'unavailable' : report.costStatus },
    'first-pass-approval-rate': { value: report.phases.length ? report.phases.filter((phase) => phase.generations === 1 && phase.status === 'approved').length / report.phases.length : null },
    'required-check-pass-rate': { value: (() => {
      const checks = report.phases.flatMap((phase) => phase.checks);
      return checks.length ? checks.filter((check) => check.status === 'passed').length / checks.length : null;
    })() },
    'conformance-gap-count': { value: null }
  };
  return Object.entries(metrics).map(([metric, measurement]) => {
    const { value } = measurement;
    const status = measurement.status ?? (value == null ? 'unavailable' : 'exact');
    const core = {
      schemaVersion: 1,
      evidenceId: null,
      kind: 'native-lifecycle',
      provider: { id: 'singularity-flow', version: '0.9.0', assurance: 'kernel-derived' },
      subject: { workId: workflow.workItem.id, commitSha: finalization.sourceCommit },
      observation: { metric, value, unit: IMPACT_METRICS[metric].unit, status },
      source: { type: 'finalization-packet', sha256: finalization.packetSha256 },
      capturedAt: finalization.finalizedAt
    };
    const evidenceId = impactSha256({ ...core, evidenceId: undefined });
    const recordCore = { ...core, evidenceId };
    return { ...recordCore, integrity: { sha256: impactSha256(recordCore) } };
  });
}

function exposureSummary(workflow) {
  const recorded = workflow.measurement?.exposures ?? [];
  const rank = new Map(IMPACT_EXPOSURE_LEVELS.map((level, index) => [level, index]));
  return workflow.phaseOrder.map((phaseId) => {
    const phase = workflow.phases[phaseId];
    const candidates = recorded.filter((item) => item.phaseId === phaseId).sort((a, b) => (rank.get(b.level) ?? -1) - (rank.get(a.level) ?? -1));
    const telemetry = phase?.usage ?? [];
    if (candidates[0]) return { phaseId, level: candidates[0].level, assurance: candidates[0].assurance, observationStatus: candidates[0].assurance === 'attested' ? 'self-reported' : 'exact' };
    if (telemetry.length) return { phaseId, level: 'invoked', assurance: 'host-observed', observationStatus: 'exact' };
    const authorship = [...(phase?.authorship ?? [])].reverse().find((record) => record.generation === phase.generation);
    if (authorship) {
      const kernelInvoked = authorship.kernelModel?.invoked === true;
      const externalAiUse = authorship.externalAiUse?.value ?? 'unknown';
      const externalAiUseStatus = authorship.externalAiUse?.status ?? 'unavailable';
      const hosted = authorship.producer === 'governed-agent' && authorship.channel === 'copilot-host';
      return {
        phaseId,
        level: kernelInvoked ? 'invoked' : hosted || externalAiUse === 'assisted' ? 'artifact-assisted' : 'unknown',
        assurance: kernelInvoked ? 'provider-verified' : hosted || externalAiUseStatus === 'self-reported' ? 'attested' : 'unknown',
        observationStatus: kernelInvoked ? 'exact' : hosted || externalAiUseStatus === 'self-reported' ? 'self-reported' : 'unavailable',
        kernelModelInvoked: kernelInvoked,
        kernelModelStatus: authorship.kernelModel?.status ?? 'unavailable',
        kernelInvocationIds: [...(authorship.kernelModel?.invocationIds ?? [])],
        externalAiUse,
        externalAiUseStatus,
        producer: authorship.producer,
        channel: authorship.channel
      };
    }
    return { phaseId, level: 'unknown', assurance: 'unknown', observationStatus: 'unavailable' };
  });
}

export function storyModelExposure(workflow) { return exposureSummary(workflow); }

function actualAssistance(exposures) {
  if (exposures.some((item) => item.level === 'agent-executed')) return 'governed-agent';
  if (exposures.some((item) => ['invoked', 'artifact-assisted', 'code-assisted'].includes(item.level))) return 'assisted';
  if (exposures.every((item) => item.level === 'available')) return 'baseline';
  return 'unknown';
}

function receiptCompleteness(selected) {
  const category = (metrics) => {
    const statuses = metrics.map((metric) => selected.get(metric)?.observation.status ?? 'unavailable');
    return statuses.every((status) => status === 'exact') ? 'exact' : statuses.every((status) => status === 'unavailable') ? 'unavailable' : 'partial';
  };
  return {
    velocity: category(['flow-time-excluding-approval-wait-ms', 'elapsed-ms', 'approval-wait-ms']),
    quality: category(['rework-cycles', 'rejections', 'first-pass-approval-rate', 'required-check-pass-rate', 'conformance-gap-count', 'escaped-defects']),
    economics: category(['input-tokens', 'output-tokens', 'cached-input-tokens', 'total-tokens', 'cost-usd']),
    governance: category(['self-approvals', 'sequence-overrides'])
  };
}

export async function createImpactReceipt(root, config, workflow, finalization) {
  if (!workflow.measurement?.plan || workflow.measurement.status === 'opted-out') return null;
  const plan = await readPlan(root, workflow);
  if (!plan.classification.confirmed) throw new SingularityFlowError('Impact receipt requires confirmed complexity and risk bands.');
  const study = workflow.resolution.impact.studies.find((item) => item.id === plan.study.id);
  if (!study) throw new SingularityFlowError(`Pinned impact study '${plan.study.id}' is unavailable.`);
  const report = deriveReport(workflow, { pricing: config.tokens?.pricing ?? null, now: finalization.finalizedAt });
  const native = nativeMetricRecords(workflow, report, finalization);
  const evidenceDirectory = path.join(measurementRoot(root, config, workflow), 'evidence');
  await mkdir(evidenceDirectory, { recursive: true });
  for (const evidence of native) await writeJson(path.join(evidenceDirectory, `${evidence.evidenceId}.json`), evidence);
  const imported = [];
  for (const ref of workflow.measurement.evidence ?? []) {
    const target = await secureRepositoryPath(root, ref.path, { label: `Impact evidence '${ref.evidenceId}'`, type: 'file' });
    if (!target.exists) throw new SingularityFlowError(`Impact evidence is missing: ${ref.path}.`);
    const record = validateImpactEvidence(await readJson(target.absolute), { expectedWorkId: workflow.workItem.id });
    imported.push(record);
  }
  // Finalization is retryable. A previous attempt may already have registered the
  // kernel-derived records, so collapse by the content-addressed evidence ID before
  // constructing the receipt. This keeps an identical retry byte-for-byte stable.
  const { observations, selected } = selectAuthoritativeImpactEvidence(workflow, [...native, ...imported]);
  const exposures = exposureSummary(workflow);
  const core = {
    schemaVersion: 1,
    status: 'finalized',
    subject: {
      workId: workflow.workItem.id,
      subjectRevision: { commit: finalization.sourceCommit, sourceTreeSha256: finalization.sourceTreeSha256 },
      workType: workflow.workItem.workType,
      capability: plan.matching.capability,
      repositoryClass: plan.matching.repositoryClass,
      timePeriod: plan.matching.timePeriod,
      complexity: plan.classification.confirmed.complexity,
      risk: plan.classification.confirmed.risk
    },
    study: { id: study.id, method: study.method, configurationSha256: plan.study.configurationSha256, groupId: plan.group.id },
    assistance: { planned: plan.group.plannedAssistanceMode, actual: actualAssistance(exposures), exposure: exposures },
    metrics: Object.fromEntries([...selected].map(([metric, evidence]) => [metric, {
      ...evidence.observation, assurance: evidence.provider.assurance
    }])),
    completeness: receiptCompleteness(selected),
    evidence: observations.map((item) => ({ evidenceId: item.evidenceId, sha256: item.integrity.sha256, metric: item.observation.metric })),
    economics: {
      models: report.tokens.byModel.map((item) => ({
        provider: item.provider,
        model: item.model,
        records: item.records,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedInputTokens: item.cachedInputTokens,
        totalTokens: item.totalTokens,
        cost: item.cost,
        costStatus: item.costStatus
      }))
    },
    publication: { eventType: 'impact-finalized', subjectCommit: finalization.sourceCommit },
    finalizedAt: finalization.finalizedAt
  };
  const receipt = { ...core, integrity: { sha256: impactSha256(core) } };
  const target = path.join(measurementRoot(root, config, workflow), 'impact-receipt.json');
  await writeJson(target, receipt);
  workflow.measurement.receipt = { path: relative(root, target), sha256: receipt.integrity.sha256, status: 'active', finalizedAt: receipt.finalizedAt };
  workflow.measurement.status = 'finalized';
  workflow.measurement.evidence = observations.map((item) => ({ evidenceId: item.evidenceId, path: relative(root, path.join(evidenceDirectory, `${item.evidenceId}.json`)), sha256: item.integrity.sha256, metric: item.observation.metric }));
  return { receipt, path: relative(root, target), evidencePaths: workflow.measurement.evidence.map((item) => item.path) };
}

export async function verifyImpactReceipt(root, workflow) {
  const ref = workflow.measurement?.receipt;
  if (!ref) return { valid: false, errors: ['No Impact Receipt is registered.'] };
  let receipt;
  try {
    const target = await secureRepositoryPath(root, ref.path, { label: 'Impact Receipt', type: 'file' });
    if (!target.exists) throw new SingularityFlowError(`Impact Receipt is missing: ${ref.path}.`);
    receipt = await readJson(target.absolute);
  }
  catch (error) { return { valid: false, errors: [`Impact Receipt cannot be read: ${error.message}`], receipt: null }; }
  const { integrity, ...core } = receipt;
  const errors = [];
  const expected = impactSha256(core);
  if (integrity?.sha256 !== expected || ref.sha256 !== expected) errors.push(`Receipt hash mismatch: expected ${expected}.`);
  const records = [];
  for (const evidence of receipt.evidence ?? []) {
    const registered = (workflow.measurement.evidence ?? []).find((item) => item.evidenceId === evidence.evidenceId);
    if (!registered) { errors.push(`Evidence '${evidence.evidenceId}' is not registered.`); continue; }
    let target;
    try { target = await secureRepositoryPath(root, registered.path, { label: `Impact evidence '${evidence.evidenceId}'`, type: 'file' }); }
    catch (error) { errors.push(error.message); continue; }
    const current = target.exists ? await snapshot(target.absolute) : { exists: false, sha256: null };
    if (!current.exists || current.sha256 == null) errors.push(`Evidence '${evidence.evidenceId}' is missing.`);
    else {
      try {
        const record = await readJson(target.absolute);
        const { integrity: recordIntegrity, ...recordCore } = record;
        const hash = impactSha256(recordCore);
        if (recordIntegrity?.sha256 !== hash || evidence.sha256 !== hash || registered.sha256 !== hash) errors.push(`Evidence '${evidence.evidenceId}' hash mismatch.`);
        else records.push(record);
      } catch (error) { errors.push(`Evidence '${evidence.evidenceId}' cannot be read: ${error.message}`); }
    }
  }
  let plan = null;
  try { plan = await readPlan(root, workflow); }
  catch (error) { errors.push(error.message); }
  if (plan) {
    const expectedSubject = {
      workId: workflow.workItem.id,
      workType: workflow.workItem.workType,
      capability: plan.matching.capability,
      repositoryClass: plan.matching.repositoryClass,
      timePeriod: plan.matching.timePeriod,
      complexity: plan.classification.confirmed?.complexity,
      risk: plan.classification.confirmed?.risk
    };
    for (const [key, value] of Object.entries(expectedSubject)) {
      if (receipt.subject?.[key] !== value) errors.push(`Receipt subject ${key} does not match the governed measurement plan.`);
    }
    if (receipt.study?.id !== plan.study.id || receipt.study?.configurationSha256 !== plan.study.configurationSha256 || receipt.study?.groupId !== plan.group.id) {
      errors.push('Receipt study or cohort does not match the governed measurement plan.');
    }
  }
  let selected = new Map();
  try { ({ selected } = selectAuthoritativeImpactEvidence(workflow, records)); }
  catch (error) { errors.push(error.message); }
  const expectedMetrics = Object.fromEntries([...selected].map(([metric, evidence]) => [metric, {
    ...evidence.observation, assurance: evidence.provider.assurance
  }]));
  if (canonicalJson(receipt.metrics ?? {}) !== canonicalJson(expectedMetrics)) errors.push('Receipt metrics do not match the referenced evidence observations.');
  if (canonicalJson(receipt.completeness ?? {}) !== canonicalJson(receiptCompleteness(selected))) errors.push('Receipt completeness does not match the referenced evidence statuses.');
  const expectedExposure = exposureSummary(workflow);
  if (canonicalJson(receipt.assistance?.exposure ?? []) !== canonicalJson(expectedExposure)
    || receipt.assistance?.actual !== actualAssistance(expectedExposure)) {
    errors.push('Receipt assistance exposure does not match the governed exposure records.');
  }
  if (ref.status !== 'active') errors.push(`Receipt is ${ref.status}.`);
  return { valid: errors.length === 0, errors, receipt };
}

export async function listImpactReceipts(root, config, { studyId = null } = {}) {
  const directory = path.join(root, config.workItemRoot ?? 'singularity/work-items');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const receipts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let workflow;
    try { workflow = await readJson(path.join(directory, entry.name, 'workflow.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!workflow.measurement?.receipt || workflow.measurement.receipt.status !== 'active') continue;
    const verification = await verifyImpactReceipt(root, workflow);
    if (!verification.valid) throw new SingularityFlowError(`Impact Receipt for Story '${workflow.workItem?.id ?? entry.name}' is invalid: ${verification.errors.join('; ')}`);
    if (!studyId || verification.receipt.study?.id === studyId) receipts.push(verification.receipt);
  }
  return receipts;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function seeded(seed) {
  let state = Number.parseInt(impactSha256(seed).slice(0, 8), 16) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

function effectPercent(baseline, treatment, direction) {
  return baseline === 0 ? 0 : (direction === 'lower' ? baseline - treatment : treatment - baseline) / Math.abs(baseline) * 100;
}

function stratumWeight(stratum, weighting) {
  return weighting === 'equal-stratum' ? 1 : Math.min(stratum.baselineValues.length, stratum.treatmentValues.length);
}

function weightedEffect(strata, direction, weighting) {
  const effects = strata.map((stratum) => {
    const baselineMedian = median(stratum.baselineValues);
    const treatmentMedian = median(stratum.treatmentValues);
    const weight = stratumWeight(stratum, weighting);
    return { key: stratum.key, baselineMedian, treatmentMedian, weight, gainPercent: effectPercent(baselineMedian, treatmentMedian, direction) };
  });
  const totalWeight = effects.reduce((sum, item) => sum + item.weight, 0);
  return { effects, combined: totalWeight ? effects.reduce((sum, item) => sum + item.gainPercent * item.weight, 0) / totalWeight : null };
}

function bootstrapStratifiedGain(strata, direction, weighting, samples, level, seed) {
  const random = seeded(seed); const gains = [];
  for (let index = 0; index < samples; index += 1) {
    const sampled = strata.map((stratum) => ({
      ...stratum,
      baselineValues: Array.from({ length: stratum.baselineValues.length }, () => stratum.baselineValues[Math.floor(random() * stratum.baselineValues.length)]),
      treatmentValues: Array.from({ length: stratum.treatmentValues.length }, () => stratum.treatmentValues[Math.floor(random() * stratum.treatmentValues.length)])
    }));
    gains.push(weightedEffect(sampled, direction, weighting).combined);
  }
  const alpha = (1 - level) / 2;
  return { lower: percentile(gains, alpha), upper: percentile(gains, 1 - alpha) };
}

function dimensionBalance(receipts, dimensions) {
  const values = (dimension, group) => Object.fromEntries([...group.reduce((counts, receipt) => {
    const key = cohortKey(receipt, [dimension]).split('=').slice(1).join('=');
    counts.set(key, (counts.get(key) ?? 0) + 1); return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
  return dimensions.map((dimension) => ({ dimension, baseline: values(dimension, receipts.baseline), treatment: values(dimension, receipts.treatment) }));
}

function verifyRolloutDesign(receipts, study, floor) {
  const reasons = [];
  const rollout = study.rollout;
  if (!rollout) reasons.push('No predeclared rollout design is pinned.');
  const eligible = rollout ? receipts.filter((receipt) => receipt.rollout?.waveId) : [];
  if (rollout) {
    for (const wave of rollout.waves) if (!eligible.some((receipt) => receipt.rollout.waveId === wave.id)) reasons.push(`Wave '${wave.id}' has no observed receipt.`);
    if (eligible.length < floor * 2) reasons.push(`Observed rollout sample ${eligible.length} is below ${floor * 2}.`);
    for (const receipt of eligible) {
      if (receipt.rollout.exposureObserved !== true) reasons.push(`${receipt.subject.workId} has no observed treatment exposure.`);
      if (rollout.requireConcurrentControl && receipt.rollout.concurrentControl !== true) reasons.push(`${receipt.subject.workId} has no concurrent control.`);
      if (Number(receipt.rollout.adherencePercent) < rollout.minimumAdherencePercent) reasons.push(`${receipt.subject.workId} is below minimum adherence.`);
      if (rollout.requirePreTrendCheck && receipt.rollout.preTrendPassed !== true) reasons.push(`${receipt.subject.workId} has no passing pre-trend check.`);
      if (receipt.rollout.crossoverApplied !== true) reasons.push(`${receipt.subject.workId} has no applied crossover decision.`);
    }
  }
  return { valid: reasons.length === 0, reasons, observedReceipts: eligible.length };
}

function metricValue(receipt, metric) {
  const observation = receipt.metrics?.[metric];
  return observation && ['exact', 'partial'].includes(observation.status) && Number.isFinite(observation.value) ? observation.value : null;
}

function cohortKey(receipt, dimensions) {
  const values = {
    capability: receipt.subject.capability,
    'repository-class': receipt.subject.repositoryClass,
    'work-type': receipt.subject.workType,
    complexity: receipt.subject.complexity,
    risk: receipt.subject.risk,
    'time-period': receipt.subject.timePeriod
  };
  return dimensions.map((dimension) => `${dimension}=${values[dimension] ?? 'unknown'}`).join('|');
}

export function compareImpactReceipts(receipts, study, { filters = {} } = {}) {
  for (const key of Object.keys(filters)) if (!study.privacy.allowedDimensions.includes(key)) throw new SingularityFlowError(`Privacy policy does not allow filtering by '${key}'.`);
  let selected = receipts.filter((receipt) => receipt.study?.id === study.id && receipt.status === 'finalized');
  selected = selected.filter((receipt) => Object.entries(filters).every(([key, value]) => cohortKey(receipt, [key]) === `${key}=${value}`));
  const groups = new Map(study.groups.map((group) => [group.id, []]));
  for (const receipt of selected) groups.get(receipt.study.groupId)?.push(receipt);
  const baselineGroup = study.groups.find((group) => group.assistanceMode === 'baseline') ?? study.groups[0];
  const treatmentGroup = study.groups.find((group) => group.id !== baselineGroup.id);
  const baseline = groups.get(baselineGroup.id) ?? [];
  const treatment = groups.get(treatmentGroup.id) ?? [];
  const floor = study.privacy.minimumCohortSize;
  if (baseline.length < floor || treatment.length < floor) throw new SingularityFlowError(`Impact comparison refused by privacy floor: '${baselineGroup.id}' has ${baseline.length}, '${treatmentGroup.id}' has ${treatment.length}; each requires ${floor}.`);
  const byKey = new Map();
  for (const receipt of baseline) { const key = cohortKey(receipt, study.matching.dimensions); const pair = byKey.get(key) ?? { baseline: [], treatment: [] }; pair.baseline.push(receipt); byKey.set(key, pair); }
  for (const receipt of treatment) { const key = cohortKey(receipt, study.matching.dimensions); const pair = byKey.get(key) ?? { baseline: [], treatment: [] }; pair.treatment.push(receipt); byKey.set(key, pair); }
  const matched = [...byKey].map(([key, pair]) => ({
    key,
    ...pair,
    baselineValues: pair.baseline.map((receipt) => metricValue(receipt, study.primaryMetric.id)).filter(Number.isFinite),
    treatmentValues: pair.treatment.map((receipt) => metricValue(receipt, study.primaryMetric.id)).filter(Number.isFinite)
  })).filter((pair) => pair.baselineValues.length && pair.treatmentValues.length);
  const baseValues = matched.flatMap((pair) => pair.baselineValues);
  const treatmentValues = matched.flatMap((pair) => pair.treatmentValues);
  if (baseValues.length < floor || treatmentValues.length < floor) throw new SingularityFlowError(`Impact comparison refused: matched metric cohorts require at least ${floor} usable observations each.`);
  const baselineMedian = median(baseValues); const treatmentMedian = median(treatmentValues);
  const primary = weightedEffect(matched, study.primaryMetric.direction, study.matching.weighting);
  const gainPercent = primary.combined;
  const guardrails = study.guardrails.map((guardrail) => {
    const guardrailStrata = matched.map((pair) => ({
      key: pair.key,
      baselineValues: pair.baseline.map((receipt) => metricValue(receipt, guardrail.id)).filter(Number.isFinite),
      treatmentValues: pair.treatment.map((receipt) => metricValue(receipt, guardrail.id)).filter(Number.isFinite)
    })).filter((pair) => pair.baselineValues.length && pair.treatmentValues.length);
    const base = median(guardrailStrata.flatMap((pair) => pair.baselineValues));
    const treated = median(guardrailStrata.flatMap((pair) => pair.treatmentValues));
    const guarded = guardrailStrata.length ? weightedEffect(guardrailStrata, guardrail.direction === 'lower' ? 'higher' : 'lower', study.matching.weighting) : { combined: null };
    const regressionPercent = guarded.combined;
    return { metric: guardrail.id, baselineMedian: base, treatmentMedian: treated, regressionPercent, maximumRegressionPercent: guardrail.maximumRegressionPercent, passed: regressionPercent != null && regressionPercent <= guardrail.maximumRegressionPercent };
  });
  const qualityPassed = guardrails.length > 0 && guardrails.every((item) => item.passed);
  const rolloutVerification = study.method === 'phased-rollout' ? verifyRolloutDesign(selected, study, floor) : null;
  const causal = study.method === 'phased-rollout' && rolloutVerification.valid;
  const label = !guardrails.length ? 'observed acceleration; quality validation incomplete'
    : !qualityPassed ? 'observed acceleration; quality guardrails failed'
      : causal ? 'validated causal gain' : 'quality-gated matched-cohort association';
  return {
    schemaVersion: 1,
    study: study.id,
    method: study.method,
    evidenceGrade: causal ? 'A' : ['matched-observational', 'phased-rollout'].includes(study.method) ? 'B' : 'C',
    inference: causal ? 'causal-estimate' : study.method === 'phased-rollout' ? 'observed-phased-rollout-association' : study.method === 'matched-observational' ? 'quality-gated-observed-association' : 'observed-change',
    label,
    primaryMetric: study.primaryMetric,
    cohorts: {
      baseline: baselineGroup.id, treatment: treatmentGroup.id,
      eligibleBaseline: baseline.length, eligibleTreatment: treatment.length,
      matchedBaseline: baseValues.length, matchedTreatment: treatmentValues.length,
      excludedBaseline: baseline.length - baseValues.length, excludedTreatment: treatment.length - treatmentValues.length,
      privacyFloor: floor, strata: matched.length,
      balance: dimensionBalance({ baseline, treatment }, study.matching.dimensions)
    },
    result: {
      baselineMedian, treatmentMedian, baselineP25: percentile(baseValues, 0.25), baselineP75: percentile(baseValues, 0.75),
      treatmentP25: percentile(treatmentValues, 0.25), treatmentP75: percentile(treatmentValues, 0.75), gainPercent,
      weighting: study.matching.weighting, effectsByStratum: primary.effects,
      confidenceInterval: bootstrapStratifiedGain(matched, study.primaryMetric.direction, study.matching.weighting, study.reporting.bootstrapSamples, study.reporting.confidenceLevel, study.matching.seed)
    },
    guardrails,
    rollout: rolloutVerification,
    qualityGatePassed: qualityPassed,
    completeness: { eligibleReceipts: selected.length, matchedStrata: matched.length, usableBaseline: baseValues.length, usableTreatment: treatmentValues.length }
  };
}

export async function exportImpactReceipts(root, config, output, { studyId = null } = {}) {
  const receipts = await listImpactReceipts(root, config, { studyId });
  const lines = receipts.map((receipt) => canonicalJson(receipt));
  await writeText(output, lines.join('\n'));
  return { output, receipts: receipts.length, sha256: impactSha256(lines.join('\n')) };
}

export async function impactBandDrift(root, config) {
  const directory = path.join(root, config.workItemRoot ?? 'singularity/work-items');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rank = new Map(IMPACT_BANDS.map((band, index) => [band, index]));
  const periods = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let candidate;
    try { candidate = await readJson(path.join(directory, entry.name, 'workflow.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!candidate.measurement?.plan) continue;
    let plan;
    try { plan = await readPlan(root, candidate); }
    catch { continue; }
    if (!plan.classification?.confirmed) continue;
    const key = `${plan.study.id}:${plan.matching.timePeriod}`;
    const current = periods.get(key) ?? {
      studyId: plan.study.id,
      timePeriod: plan.matching.timePeriod,
      confirmed: 0,
      matches: 0,
      mismatches: 0,
      upward: 0,
      downward: 0,
      mixed: 0,
      complexityMismatches: 0,
      riskMismatches: 0
    };
    current.confirmed += 1;
    let dimensionMismatches = 0;
    let netDelta = 0;
    for (const dimension of ['complexity', 'risk']) {
      const suggested = plan.classification.suggested?.[dimension];
      const confirmed = plan.classification.confirmed?.[dimension];
      if (suggested === confirmed) continue;
      current[`${dimension}Mismatches`] += 1;
      dimensionMismatches += 1;
      netDelta += (rank.get(confirmed) ?? 0) - (rank.get(suggested) ?? 0);
    }
    if (!dimensionMismatches) current.matches += 1;
    else {
      current.mismatches += 1;
      if (netDelta > 0) current.upward += 1;
      else if (netDelta < 0) current.downward += 1;
      else current.mixed += 1;
    }
    periods.set(key, current);
  }
  return [...periods.values()].sort((a, b) => `${a.studyId}:${a.timePeriod}`.localeCompare(`${b.studyId}:${b.timePeriod}`));
}

export async function impactDoctor(root, config, workflow = null) {
  const findings = [];
  const bandDrift = await impactBandDrift(root, config);
  for (const period of bandDrift) {
    if (!period.mismatches) continue;
    findings.push({
      severity: 'warning',
      code: 'impact.systematic-band-drift',
      message: `${period.studyId}/${period.timePeriod}: ${period.mismatches} of ${period.confirmed} confirmed classifications differ from suggestions (${period.upward} upward, ${period.downward} downward, ${period.mixed} mixed).`
    });
  }
  if (!workflow?.resolution?.impact) findings.push({ severity: 'info', code: 'impact.not-configured', message: 'No immutable impact configuration is pinned for this Story.' });
  if (workflow?.measurement?.status === 'classification-required') findings.push({ severity: 'error', code: 'impact.classification-required', message: 'Confirm complexity and risk before implementation.' });
  if (workflow?.measurement?.plan) {
    try {
      const plan = await readPlan(root, workflow);
      if (plan.classification.confirmed && (plan.classification.suggested.complexity !== plan.classification.confirmed.complexity || plan.classification.suggested.risk !== plan.classification.confirmed.risk)) {
        findings.push({ severity: 'warning', code: 'impact.band-drift', message: `Suggested ${plan.classification.suggested.complexity}/${plan.classification.suggested.risk}; confirmed ${plan.classification.confirmed.complexity}/${plan.classification.confirmed.risk}.` });
      }
    } catch (error) { findings.push({ severity: 'error', code: 'impact.plan-invalid', message: error.message }); }
  }
  if (workflow?.measurement?.receipt) {
    const verification = await verifyImpactReceipt(root, workflow);
    for (const error of verification.errors) findings.push({ severity: 'error', code: 'impact.receipt-invalid', message: error });
    if (verification.receipt
      && verification.receipt.assistance?.actual !== 'unknown'
      && verification.receipt.assistance.actual !== verification.receipt.assistance?.planned) {
      findings.push({
        severity: 'warning',
        code: 'impact.assistance-drift',
        message: `Planned assistance '${verification.receipt.assistance.planned}' differs from observed '${verification.receipt.assistance.actual}'.`
      });
    }
  }
  return { valid: !findings.some((item) => item.severity === 'error'), findings, bandDrift };
}
