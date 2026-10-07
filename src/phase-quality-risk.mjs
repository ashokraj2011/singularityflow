/** Pilot exceptions carry unmet quality obligations; they never manufacture passing evidence. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './records.mjs';
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { exactFileAtObject, exactFirstParentFileChanges, head, identity } from './git.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { consumeAndRetainHumanReview, humanReviewOriginPresent } from './human-review-origin.mjs';
import { actorKey, assertNoPendingPublication, transactStory } from './state-stores.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { pendingCodeSubmissionEvidence } from './code-submission-evidence.mjs';
import { ArtifactRiskPacketSchema, ArtifactRiskDecisionSchema } from './phase-artifact-risk-schema.mjs';
import { isArtifactQualityFinding, phaseFindingPolicy } from './phase-finding-policy.mjs';
import { terminalTransitionAt } from './workflow-terminal-time.mjs';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const fail = (message, code = 'PHASE_QUALITY_RISK_INVALID', details = null) => { throw new SingularityFlowError(message, { code, details }); };
const MAX_DECISIONS = 500;
const historyChecks = new Map();
const SHA = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const reasonSchema = z.string().trim().min(20).max(1000).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const bindingSchema = z.object({ workId: z.string(), phaseId: z.string(), generation: z.number().int().positive(),
  stage: z.enum(['candidate', 'published']), candidateSha256: SHA.nullable(), generationStartSha256: SHA.nullable(),
  candidateCommit: z.string().regex(/^[a-f0-9]{40,64}$/u), policySha256: SHA, claimsSha256: SHA }).strict();
const packetSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('phase-quality-risk'),
  binding: bindingSchema, gateMode: z.literal('soft'), enablesPilotForPhase: z.boolean(),
  gate: z.literal('SPEC_COVERAGE_INCOMPLETE'), clauses: z.array(z.string().min(1).max(200)).min(1).max(200),
  transitions: z.array(z.enum(['publish', 'submit', 'approve', 'consume', 'terminal'])).min(1).max(5), expiresAt: z.string().datetime(),
  reason: reasonSchema, observationSha256: SHA, packetSha256: SHA }).strict();
const decisionSchema = packetSchema.extend({ id: z.string().regex(/^PQR-[a-f0-9]{24}$/u),
  actor: z.string().min(1), authorityGroup: z.string().min(1), identityAssurance: z.string().nullable(),
  authorizationId: z.string().min(1), reviewAssurance: z.literal('live-terminal-risk-review'), at: z.string().datetime(),
  testsWaived: z.literal(false), phaseApproved: z.literal(false) }).strict();
const revocationSchema = z.object({ kind: z.literal('phase-quality-risk-revocation'), id: z.string().min(1),
  revokes: z.string().regex(/^PQR-[a-f0-9]{24}$/u), reason: reasonSchema, actor: z.string().min(1),
  authorityGroup: z.string().min(1), authorizationId: z.string().min(1), at: z.string().datetime() }).strict();
// Closed policy variants, not a lossy upgrade of a coverage decision into a document decision.
const isArtifactRisk = record => record?.gate === 'PHASE_ARTIFACT_QUALITY';
const riskPacketSchema = record => isArtifactRisk(record) ? ArtifactRiskPacketSchema : packetSchema;
const riskDecisionSchema = record => isArtifactRisk(record) ? ArtifactRiskDecisionSchema : decisionSchema;

export function normalizeQualityGateMode(value = 'hard') {
  if (!['hard', 'soft'].includes(value)) fail('Gate mode must be hard or soft. Soft mode still requires a specific authorized human risk decision.');
  return value;
}

export function qualityRiskBinding(workflow, phase, { candidate = null, config = {}, publishedCommit = phase.generationCommit } = {}) {
  const phases = (workflow.phaseOrder ?? []).slice(0, (workflow.phaseOrder ?? []).indexOf(phase.id) + 1);
  const context = applicationPathContext(config, workflow);
  // HEAD/index bookkeeping and governed metadata commits are not application-byte changes.
  const candidateSha256 = candidate ? digest({ paths: candidate.paths,
    endpoints: candidate.changeSet.entries.filter(entry => [entry.oldPath, entry.newPath].some(file => file && isApplicationPath(file, context)))
      .map(({ status, oldPath, newPath, oldMode, newMode, oldObject, newContent }) => ({ status, oldPath, newPath, oldMode, newMode, oldObject, newContent })),
    sourceBindings: candidate.sourceBindings, acceptanceCriteria: candidate.acceptanceCriteria,
    fulfillment: candidate.fulfillment, excludedChanges: candidate.excludedChanges }) : null;
  return bindingSchema.parse({ workId: workflow.workItem.id, phaseId: phase.id,
    generation: Number(candidate ? phase.generationIntent?.generation : phase.generation),
    stage: candidate ? 'candidate' : 'published', candidateSha256,
    generationStartSha256: candidate ? phase.generationIntent?.receiptSha256 : null,
    candidateCommit: candidate ? candidate.baselineCommit : publishedCommit, policySha256: digest(workflow.resolution),
    claimsSha256: digest({ claims: phases.map(id => ({ id, specIndex: workflow.phases[id].specIndex ?? null,
      claimMaps: workflow.phases[id].claimMaps ?? null })),
      planAmendments: workflow.planAmendments ?? [], scopeRevisions: workflow.scopeRevisions ?? [] }) });
}

/** Only absent implementation coverage is soft. Forged/stale/unclaimed/withdrawn evidence stays hard. */
export function coverageRiskEligibility(error) {
  const coverage = error?.details?.coverage;
  const clauses = coverage?.unimplemented ?? error?.details?.open ?? [];
  const hard = ['invalidEvidence', 'unclaimedChangedPaths', 'withdrawnButClaimed']
    .some(key => (coverage?.[key] ?? []).length > 0);
  return { eligible: error?.code === 'SPEC_COVERAGE_INCOMPLETE' && clauses.length > 0 && !hard,
    clauses: [...new Set(clauses)].sort(), reason: hard ? 'Evidence integrity or unaccounted scope requires repair, not risk acceptance.'
      : 'Unmet implementation coverage may be carried as explicit pilot risk; tests and independent review remain required.' };
}

export function validateQualityRiskPacket(packet) {
  const parsed = riskPacketSchema(packet).safeParse(packet);
  if (!parsed.success) fail('Quality risk packet is invalid.', 'PHASE_QUALITY_RISK_INTEGRITY');
  const { packetSha256, ...core } = parsed.data;
  if (digest(core) !== packetSha256 || new Set(packet.clauses).size !== packet.clauses.length
      || new Set(packet.transitions).size !== packet.transitions.length
      || (isArtifactRisk(packet) && (digest(packet.findings) !== packet.observationSha256
        || new Set(packet.findings.map(finding => canonicalJson(finding))).size !== packet.findings.length
        || packet.findings.some(finding => !isArtifactQualityFinding(finding)
          || /(?:^|\/)\.\.(?:\/|$)|\\|^\/|^[A-Za-z]:|[\x00-\x1f\x7f]/u.test(finding.path))))) fail('Quality risk packet hash or scope is invalid.', 'PHASE_QUALITY_RISK_INTEGRITY');
  return parsed.data;
}
const packetOf = record => Object.fromEntries(Object.keys(riskPacketSchema(record).shape).map(key => [key, record[key]]));

function retainedQualityCommit(root, workflow, phase) {
  return phase?.generationIntent || phase?.generationPublications?.length
    ? publishedGenerationCommit(root, workflow, phase) : phase?.generationCommit ?? null;
}

/** A committed deletion of a revocation must not resurrect an older live-consent witness. */
function assertAppendOnlyHistory(root, relative, tip, entries) {
  const key = canonicalJson([root, relative, tip]);
  if (historyChecks.has(key)) return;
  const revisions = exactFirstParentFileChanges(root, tip, relative, {
    pattern: '"qualityRiskDecisions"|phase-quality-risk', maximum: MAX_DECISIONS * 2 + 1
  });
  if (revisions.length > MAX_DECISIONS * 2) fail('Quality risk history exceeds the bounded review limit. Preserve it for the workflow maintainer.', 'PHASE_QUALITY_RISK_INTEGRITY');
  let prior = [];
  for (const commit of revisions) {
    let stored;
    try { stored = JSON.parse(exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024, regularOnly: true })?.toString('utf8') ?? 'null'); }
    catch { fail('Quality risk history cannot be read exactly.', 'PHASE_QUALITY_RISK_INTEGRITY'); }
    const next = stored?.qualityRiskDecisions ?? [];
    if (!Array.isArray(next) || (canonicalJson(next) !== canonicalJson(prior)
        && (next.length !== prior.length + 1 || canonicalJson(next.slice(0, prior.length)) !== canonicalJson(prior)))) {
      fail('Quality risk history was rewritten. Restore its retained decisions/revocations through reviewed Git recovery; never remove a revocation to reactivate risk.', 'PHASE_QUALITY_RISK_INTEGRITY');
    }
    prior = next;
  }
  if (canonicalJson(prior) !== canonicalJson(entries)) fail('Quality risk decisions are not their append-only Git history tip.', 'PHASE_QUALITY_RISK_INTEGRITY');
  if (historyChecks.size >= 32) historyChecks.delete(historyChecks.keys().next().value);
  historyChecks.set(key, true);
}

export async function retainedQualityRiskRecords(root, config, workflow) {
  const entries = workflow.qualityRiskDecisions ?? [];
  if (!Array.isArray(entries) || entries.length > MAX_DECISIONS * 2
      || entries.filter(entry => !entry?.revokes).length > MAX_DECISIONS
      || new Set(entries.map(entry => entry?.id)).size !== entries.length
      || new Set(entries.filter(entry => entry?.revokes).map(entry => entry.revokes)).size !== entries.filter(entry => entry?.revokes).length) {
    fail('Quality risk decisions must be a bounded append-only list.', 'PHASE_QUALITY_RISK_INTEGRITY');
  }
  if (!entries.length) return [];
  const relative = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/workflow.json`;
  const tip = head(root);
  const bytes = exactFileAtObject(root, tip, relative, { maximumBytes: 16 * 1024 * 1024, regularOnly: true });
  let committed;
  try { committed = JSON.parse(bytes?.toString('utf8') ?? 'null'); } catch { /* fail below */ }
  if (!committed || canonicalJson(committed.qualityRiskDecisions ?? []) !== canonicalJson(entries)) {
    fail('Quality risk decisions differ from their committed records.', 'PHASE_QUALITY_RISK_INTEGRITY');
  }
  for (const record of entries) {
    const schema = record?.revokes ? revocationSchema : riskDecisionSchema(record);
    if (!schema.safeParse(record).success) fail('Quality risk decision schema is invalid.', 'PHASE_QUALITY_RISK_INTEGRITY');
    if (!record.revokes) {
      validateQualityRiskPacket(packetOf(record));
      if (record.id !== `PQR-${record.packetSha256.slice(7, 31)}`) fail('Quality risk identity is invalid.', 'PHASE_QUALITY_RISK_INTEGRITY');
    } else if (!entries.some(candidate => !candidate.revokes && candidate.id === record.revokes)) {
      fail('Quality risk revocation has no decision.', 'PHASE_QUALITY_RISK_INTEGRITY');
    }
  }
  assertAppendOnlyHistory(root, relative, tip, entries);
  return entries;
}
const retainedRecords = retainedQualityRiskRecords;

export async function qualityRiskStatus(root, config, workflow, phase, error, { transition = 'approve', at = nowIso(), candidate = null } = {}) {
  const eligible = coverageRiskEligibility(error);
  const commit = candidate?.baselineCommit ?? retainedQualityCommit(root, workflow, phase);
  const generation = candidate ? phase?.generationIntent?.generation : phase?.generation;
  if (!/^[a-f0-9]{40,64}$/u.test(commit ?? '') || !Number.isInteger(Number(generation)) || Number(generation) < 1
      || (candidate && phase?.generationIntent?.status !== 'open')) {
    return { gateMode: normalizeQualityGateMode(workflow.resolution?.qualityGateMode), transition, ...eligible,
      eligible: false, reason: 'A retained published generation is required for pilot risk review.',
      accepted: [], remaining: eligible.clauses, items: [], excepted: false, testsWaived: false, phaseApproved: false };
  }
  const binding = qualityRiskBinding(workflow, phase, { candidate, config, publishedCommit: commit });
  const entries = await retainedRecords(root, config, workflow);
  const revoked = new Set(entries.filter(entry => entry.revokes).map(entry => entry.revokes));
  const items = [];
  const accepted = new Set();
  for (const record of entries.filter(entry => entry.gate === 'SPEC_COVERAGE_INCOMPLETE' && entry.binding.phaseId === phase.id)) {
    let status = revoked.has(record.id) ? 'revoked'
      : Date.parse(record.expiresAt) <= Date.parse(at) ? 'expired'
        : canonicalJson(record.binding) !== canonicalJson(binding) ? 'stale'
          : !record.transitions.includes(transition) ? 'out-of-scope'
            : !eligible.eligible || record.observationSha256 !== digest(eligible.clauses) ? 'observation-changed'
              : !await humanReviewOriginPresent(root, record) ? 'needs-reattestation' : 'active';
    if (status === 'active') record.clauses.forEach(id => accepted.add(id));
    items.push({ id: record.id, status, clauses: record.clauses, reason: record.reason, expiresAt: record.expiresAt,
      actor: record.actor, authorityGroup: record.authorityGroup, transitions: record.transitions,
      decisionSha256: digest(record), packetSha256: record.packetSha256 });
  }
  const remaining = eligible.clauses.filter(id => !accepted.has(id));
  return { gateMode: normalizeQualityGateMode(workflow.resolution?.qualityGateMode), transition, binding, ...eligible,
    accepted: [...accepted].sort(), remaining, items, excepted: eligible.eligible && remaining.length === 0,
    testsWaived: false, phaseApproved: false };
}

/** Use the same strict check as submit/approve. No tests, network, publication or generation edits. */
export async function inspectPhaseQualityGate(root, config, workflow, phase, { transition = 'approve', at = nowIso() } = {}) {
  if (!phaseRequiresCodeDelivery(phase)) return { status: 'not-applicable', findings: [], risks: null };
  const editable = phase?.generationIntent?.status === 'open';
  if (!editable && Number(phase?.generation) < 1) return { status: 'not-applicable', findings: [], risks: null };
  if (editable) transition = 'publish';
  let evidenceCommit = phase.generationCommit;
  try {
    if (editable) {
      const { verifyOpenGenerationIntent } = await import('./generation-boundary.mjs');
      await verifyOpenGenerationIntent(root, workflow, phase);
      const { evaluateCodeDeliveryPreflight } = await import('./delivery-evidence.mjs');
      await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { strictCoverage: true });
      return { status: 'ready', findings: [], risks: null };
    }
    // A just-published generation does not receive generationCommit until submission. Resolve its
    // authenticated publication now; never bind a new generation to the previous submission OID.
    evidenceCommit = retainedQualityCommit(root, workflow, phase);
    if (!evidenceCommit) return { status: 'resolution-required', risks: null,
      findings: [{ code: 'GENERATION_PUBLICATION_MISSING', category: 'integrity', path: null,
        message: 'The published generation must have an authenticated publication before risk review.' }] };
    // Submission first runs required tests and records this generation's observed claim map.
    // Its absence at this specific lifecycle stage is pending evidence, not corrupt evidence or
    // permission to waive tests. Approval/consumption must never use this intermediate result.
    const pending = await pendingCodeSubmissionEvidence(root, config, workflow, phase);
    if (pending) return { ...pending, findings: [], risks: null };
    if (phase.status === 'awaiting_approval') {
      const entry = [...(workflow.lineage?.submissions ?? [])].reverse().find(candidate => candidate.phase === phase.id
        && Number(candidate.generation) === Number(phase.generation));
      if (entry) {
        const { readStoryReviewPacket } = await import('./story-lineage.mjs');
        const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
        evidenceCommit = packet.evidenceCommit;
      }
    }
    const { assertStrictCodeSpecificationCoverage } = await import('./state.mjs');
    await assertStrictCodeSpecificationCoverage(root, config, workflow, phase, evidenceCommit, { boundary: transition });
    return { status: 'ready', findings: [], risks: null };
  } catch (error) {
    if (error.code !== 'SPEC_COVERAGE_INCOMPLETE') return { status: 'resolution-required', risks: null,
      findings: [{ code: error.code ?? 'PHASE_QUALITY_INSPECTION_UNAVAILABLE',
        category: phaseFindingPolicy({ code: error.code }).classification === 'integrity-or-authority' ? 'integrity' : 'inspection-unavailable', path: null,
        message: error.message, details: error.details ?? null }] };
    const risks = await qualityRiskStatus(root, config, workflow, phase, error, { transition, at, candidate: error.qualityRiskCandidate ?? null });
    return { status: risks.excepted ? 'ready-with-accepted-risk' : 'resolution-required', risks, evidenceCommit,
      findings: risks.excepted ? [] : [{ code: error.code, category: 'quality-coverage', path: null,
        message: error.message, details: { ...error.details, riskEligible: risks.eligible } }] };
  }
}

export async function prepareQualityRisk(root, config, workflow, { phaseId = workflow.currentPhase,
  gateMode, clauses = [], findings = [], transitions, expires, reason } = {}) {
  const phase = workflow.phases?.[phaseId];
  if (workflow.status !== 'in_progress'
      || !['in_progress', 'awaiting_approval', 'approved'].includes(phase?.status)
      || (Number(phase?.generation) < 1 && phase?.generationIntent?.status !== 'open'
        && (phaseRequiresCodeDelivery(phase) || phaseId !== workflow.currentPhase))) {
    fail('Select an open code candidate, published, submitted or approved phase on an active Story.', 'PHASE_QUALITY_RISK_LIFECYCLE');
  }
  const mode = normalizeQualityGateMode(gateMode ?? workflow.resolution?.qualityGateMode);
  if (mode !== 'soft') fail('Hard mode does not allow this quality exception. Choose --gate-mode soft explicitly for a reviewed pilot exception on this phase.', 'PHASE_QUALITY_RISK_HARD_MODE');
  if (findings.length || !phaseRequiresCodeDelivery(phase)) {
    if (clauses.length) fail('Document-quality risk selects --finding codes, not clause coverage.', 'PHASE_QUALITY_RISK_NOT_ELIGIBLE');
    const { prepareArtifactQualityRisk } = await import('./phase-artifact-risk.mjs');
    return validateQualityRiskPacket(await prepareArtifactQualityRisk(root, config, workflow, phase,
      { findings, transitions, expires, reason }));
  }
  const inspection = await inspectPhaseQualityGate(root, config, workflow, phase);
  if (inspection.status === 'pending-submission-evidence') fail(
    'This published generation needs fresh submission tests and observed claims before a quality-risk packet can be reviewed. Submit the retained generation; do not republish or waive its tests.',
    'PHASE_QUALITY_RISK_PENDING_TESTS', { phase: phase.id, generation: inspection.generation,
      nextAction: { command: inspection.next, skill: inspection.skill }, testsWaived: false });
  if (!inspection.risks?.eligible || inspection.risks.excepted) fail('No unresolved eligible quality gap exists. Hard integrity/scope gates require their prescribed repair.', 'PHASE_QUALITY_RISK_NOT_ELIGIBLE');
  const selected = clauses.length ? [...new Set(clauses)].sort() : inspection.risks.remaining;
  if (!selected.length || selected.some(id => !inspection.risks.remaining.includes(id))) fail('Select only exact currently unmet clause identities.');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires ?? '')) fail('Give an expiry as YYYY-MM-DD, within the next 90 days.');
  const expiresAt = `${expires}T23:59:59.999Z`;
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== expires
      || time <= Date.now() || time - Date.now() > 90 * 86400000) fail('Expiry must be a valid future date within 90 days.');
  const binding = inspection.risks.binding;
  const selectedTransitions = transitions ?? (binding.stage === 'candidate' ? ['publish'] : ['submit', 'approve', 'consume', 'terminal']);
  if (binding.stage === 'candidate' && selectedTransitions.some(value => value !== 'publish')) fail('Editable-candidate risk covers publication only. Review retained evidence afresh after publication.');
  const core = { schemaVersion: 1, kind: 'phase-quality-risk', binding,
    gateMode: mode, enablesPilotForPhase: normalizeQualityGateMode(workflow.resolution?.qualityGateMode) !== 'soft',
    gate: 'SPEC_COVERAGE_INCOMPLETE', clauses: selected, transitions: [...new Set(selectedTransitions)].sort(),
    expiresAt, reason: typeof reason === 'string' ? reason.trim() : reason, observationSha256: digest(inspection.risks.clauses) };
  return validateQualityRiskPacket({ ...core, packetSha256: digest(core) });
}

function authorityFor(config, workflow, phase, actor, requiredGroup = null) {
  const policy = phase.approvalPolicy;
  if (!policy?.authorities?.length) fail('No pinned phase approval authority can accept this risk.', 'PHASE_QUALITY_RISK_AUTHORITY_REQUIRED');
  return requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    requiredGroup ? { mode: 'required', authorities: [requiredGroup], requiredAuthorities: [], minimum: 1 }
      : { ...policy, mode: 'required', minimum: 1 }, actor);
}

export async function acceptQualityRisk(root, config, workflow, options) {
  const packet = await prepareQualityRisk(root, config, workflow, options);
  if (options.confirm !== packet.packetSha256) fail('Review and confirm the exact current risk packet hash.', 'PHASE_QUALITY_RISK_STALE');
  const actor = identity(root); const phase = workflow.phases[packet.binding.phaseId];
  const authority = authorityFor(config, workflow, phase, actor);
  const id = `PQR-${packet.packetSha256.slice(7, 31)}`;
  const entries = await retainedRecords(root, config, workflow);
  const retained = entries.find(entry => entry.id === id);
  if (retained && entries.some(entry => entry.revokes === id)) fail('This exact risk was revoked. Prepare a fresh packet with a new reviewed reason or expiry; revocation cannot be undone by re-attestation.', 'PHASE_QUALITY_RISK_STALE');
  if (retained) return { status: 'needs-reattestation', decision: retained, stateChanged: false,
    next: `singularity-flow appeal risk-attest ${id} --confirm ${digest(retained)}` };
  if (entries.filter(entry => !entry.revokes).length >= MAX_DECISIONS) fail('This Story reached its pilot-risk decision limit. Preserve the audit history and ask its workflow maintainer; existing decisions can still be revoked.', 'PHASE_QUALITY_RISK_INVALID');
  const card = { plan: { planId: id, planHash: digest({ packet, actor, authority }),
    subject: { workId: workflow.workItem.id, phaseId: phase.id }, revision: head(root), packet,
    consequence: 'Advance with the exact recorded quality shortfall, not a passing proof. Required tests and phase approval are not waived.' },
  action: { actionId: id, confirmation: { required: true } } };
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: `Accept risk ${id}` });
  if (!grant) return { status: 'cancelled', stateChanged: false };
  const { value, publication } = await transactStory(root, config, workflow, { type: LIFECYCLE_EVENT.DECISION_MADE,
    phaseId: phase.id, generation: packet.binding.generation, actor, agent: null, authorityGroup: authority.authorityGroup,
    payload: { decision: 'quality-risk', packetSha256: packet.packetSha256 } }, `[${workflow.workItem.id}][quality-risk] ${id}`,
  async aggregate => {
    await assertNoPendingPublication(root, config, aggregate, 'accept pilot quality risk');
    const fresh = await prepareQualityRisk(root, config, aggregate, options);
    if (fresh.packetSha256 !== packet.packetSha256) fail('Coverage, policy or candidate changed during human review.', 'PHASE_QUALITY_RISK_STALE');
    if ((aggregate.qualityRiskDecisions ?? []).some(entry => entry.id === id)) fail('This exact risk was already retained. Re-attest it instead of duplicating it.', 'PHASE_QUALITY_RISK_STALE');
    if ((aggregate.qualityRiskDecisions ?? []).filter(entry => !entry.revokes).length >= MAX_DECISIONS) fail('Pilot-risk decision limit reached; no history was pruned.');
    const record = riskDecisionSchema(packet).parse({ ...packet, id, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
      identityAssurance: authority.identityAssurance ?? null, authorizationId: grant.authorizationId,
      reviewAssurance: 'live-terminal-risk-review', at: nowIso(), testsWaived: false, phaseApproved: false });
    await consumeAndRetainHumanReview(root, record, card, grant.token);
    aggregate.qualityRiskDecisions ??= []; aggregate.qualityRiskDecisions.push(record);
    aggregate.history.push({ at: record.at, actor: record.actor, agent: null, event: 'quality_risk_decided', phase: phase.id, detail: id });
    return record;
  }, { exactWorkItemPaths: [] });
  return { status: 'risk-accepted', decision: value, publication, stateChanged: true, testsWaived: false, phaseApproved: false,
    next: `singularity-flow appeal preflight --phase ${phase.id} --json` };
}

/** Key loss or a new laptop needs review, not a rewrite of the published generation. */
export async function attestQualityRisk(root, config, workflow, { id, confirm } = {}) {
  const record = (await retainedRecords(root, config, workflow)).find(entry => !entry.revokes && entry.id === id);
  if (!record || confirm !== digest(record)) fail('Select and confirm an exact retained risk decision.', 'PHASE_QUALITY_RISK_STALE');
  const phase = workflow.phases[record.binding.phaseId];
  const inspect = async () => {
    if (!isArtifactRisk(record)) return inspectPhaseQualityGate(root, config, workflow, phase);
    const { inspectPhaseAuthoredReviewContent } = await import('./publication-preflight.mjs');
    const { artifactQualityStatus } = await import('./phase-artifact-risk.mjs');
    const findings = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { resolveRisks: false });
    return { risks: await artifactQualityStatus(root, config, workflow, phase, findings,
      { transition: record.transitions[0] }) };
  };
  const inspection = await inspect();
  if (!inspection.risks?.items.some(item => item.id === id && ['needs-reattestation', 'active'].includes(item.status))) {
    fail('This risk expired, was revoked, or no longer describes the current candidate.', 'PHASE_QUALITY_RISK_STALE');
  }
  const actor = identity(root); authorityFor(config, workflow, phase, actor, record.authorityGroup);
  const card = { plan: { planId: `attest-${id}`, planHash: digest(record), subject: record.binding,
    revision: head(root), record, reviewer: actorKey(actor) }, action: { actionId: `attest-${id}`, confirmation: { required: true } } };
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: `Re-review risk ${id}` });
  if (!grant) return { status: 'cancelled', stateChanged: false };
  const fresh = await inspect();
  if (!fresh.risks?.items.some(item => item.id === id && ['needs-reattestation', 'active'].includes(item.status))) fail('Risk changed during review.', 'PHASE_QUALITY_RISK_STALE');
  await consumeAndRetainHumanReview(root, record, card, grant.token);
  return { status: 'risk-review-origin-restored', stateChanged: false, localFilesChanged: true };
}

export async function revokeQualityRisk(root, config, workflow, { id, reason, confirm } = {}) {
  const entries = await retainedRecords(root, config, workflow);
  const record = entries.find(entry => !entry.revokes && entry.id === id);
  if (!record || confirm !== digest(record) || !reasonSchema.safeParse(reason).success) fail('Confirm an exact risk decision and substantive revocation reason.');
  if (entries.some(entry => entry.revokes === id)) fail('This risk is already revoked.');
  const actor = identity(root); const phase = workflow.phases[record.binding.phaseId];
  const authority = authorityFor(config, workflow, phase, actor, record.authorityGroup);
  const card = { plan: { planId: `revoke-${id}`, planHash: digest({ record, reason }), subject: record.binding,
    revision: head(root), record, reason }, action: { actionId: `revoke-${id}`, confirmation: { required: true } } };
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: `Revoke risk ${id}` });
  if (!grant) return { status: 'cancelled', stateChanged: false };
  const { publication } = await transactStory(root, config, workflow, { type: LIFECYCLE_EVENT.DECISION_MADE,
    phaseId: phase.id, generation: record.binding.generation, actor, agent: null, authorityGroup: authority.authorityGroup,
    payload: { decision: 'quality-risk', revokes: id } }, `[${workflow.workItem.id}][quality-risk] revoke ${id}`, async aggregate => {
    await assertNoPendingPublication(root, config, aggregate, 'revoke quality risk');
    const retained = await retainedRecords(root, config, aggregate);
    if (retained.some(entry => entry.revokes === id)) fail('This risk was already revoked.');
    const revocation = revocationSchema.parse({ kind: 'phase-quality-risk-revocation', id: `revoke-${grant.authorizationId}`,
      revokes: id, reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup, authorizationId: grant.authorizationId, at: nowIso() });
    await consumeAndRetainHumanReview(root, revocation, card, grant.token);
    aggregate.qualityRiskDecisions.push(revocation);
    aggregate.history.push({ at: revocation.at, actor: revocation.actor, agent: null, event: 'quality_risk_decided', phase: phase.id, detail: `revoked ${id}` });
  }, { exactWorkItemPaths: [] });
  return { status: 'risk-revoked', stateChanged: true, publication };
}

/** Validated exceptions for downstream consumption. No source or test verdict is changed. */
export async function activeQualityRisks(root, config, workflow, transition = 'consume') {
  if (!workflow.qualityRiskDecisions?.length) return [];
  const result = [];
  for (const id of new Set(workflow.qualityRiskDecisions.filter(entry => !entry.revokes).map(entry => entry.binding?.phaseId))) {
    const phase = workflow.phases?.[id];
    if (!phase) fail('Risk references an unknown phase.', 'PHASE_QUALITY_RISK_INTEGRITY');
    if (workflow.qualityRiskDecisions.some(entry => entry.gate === 'PHASE_ARTIFACT_QUALITY' && entry.binding.phaseId === id)) {
      const { inspectPhaseAuthoredReviewContent } = await import('./publication-preflight.mjs');
      const { artifactQualityStatus } = await import('./phase-artifact-risk.mjs');
      const findings = await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { resolveRisks: false });
      const status = await artifactQualityStatus(root, config, workflow, phase, findings, { transition });
      for (const risk of status.items) if (risk.status === 'active') result.push({ ...risk, phaseId: id });
    }
    const inspection = await inspectPhaseQualityGate(root, config, workflow, phase,
      { transition, at: transition === 'terminal' ? terminalTransitionAt(workflow) : nowIso() });
    for (const risk of inspection.risks?.items ?? []) if (risk.status === 'active' && risk.transitions.includes(transition)) result.push({ ...risk, phaseId: id });
  }
  return result;
}
