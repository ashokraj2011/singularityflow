/**
 * Dispute a finding the author cannot fix because the check misreads correct work.
 * `[recoverable-findings M2]`
 *
 * The author (or its agent) prepares an exact packet: the problems the gate reported for this
 * candidate, the evidence that shows the work is right, and why. One of the step's approvers reviews
 * it in a live terminal (`appeal risk-accept`) and the gate then honours exactly that exception for
 * exactly that candidate. A changed candidate, a new problem, a new generation, an expiry or a
 * revocation ends it. It is recorded as an exception, never as passing evidence; no test is waived.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from './records.mjs';
import { humanReviewOriginPresent } from './human-review-origin.mjs';
import { countedRecords } from './presence/counted.mjs';
import { nowIso, posix, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import {
  DISPUTABLE_GATES, DISPUTE_EVIDENCE_LIMITS, FindingDisputePacketSchema, isFindingDispute
} from './phase-finding-dispute-schema.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const fail = (message, code = 'PHASE_FINDING_DISPUTE_INVALID', details = undefined) => {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
};

/** The exact application endpoints of an open code candidate, as the gate observed them. */
export function codeDeliveryCandidateSha256(applicationEntries) {
  return digest(applicationEntries.map(({ status, oldPath, newPath, oldMode, newMode, oldObject, newContent }) =>
    ({ status, oldPath, newPath, oldMode, newMode, oldObject, newContent })));
}

export function findingDisputeBinding(workflow, phase, candidateSha256) {
  return { workId: workflow.workItem.id, phaseId: phase.id, generation: Number(phase.generationIntent?.generation),
    candidateSha256, policySha256: digest(workflow.resolution ?? null) };
}

async function evidenceItem(root, candidate) {
  const relative = posix(String(candidate ?? '')).replace(/^\.\//u, '');
  if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) fail(`Evidence '${candidate}' must be a path inside the repository.`);
  const secured = await secureRepositoryPath(root, relative, { mustExist: true, type: 'file', label: 'Dispute evidence' });
  if (secured.entry.size > DISPUTE_EVIDENCE_LIMITS.fileBytes) fail(`Evidence '${relative}' exceeds ${DISPUTE_EVIDENCE_LIMITS.fileBytes} bytes; attach the relevant part.`);
  const bytes = await readFile(secured.absolute);
  const text = bytes.includes(0) ? null : bytes.toString('utf8');
  return { path: relative, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length,
    excerpt: text !== null && Buffer.from(text).equals(bytes) ? text.slice(0, DISPUTE_EVIDENCE_LIMITS.excerptChars) : null };
}

/** What the gate reports for the open candidate, ignoring any accepted dispute. */
async function observeCodeDelivery(root, config, workflow, phase) {
  const { evaluateCodeDeliveryPreflight } = await import('./delivery-evidence.mjs');
  try {
    await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { ignoreDisputes: true });
    return null;
  } catch (error) {
    if (error?.code !== 'CODE_DELIVERY_EVIDENCE_REQUIRED' || !Array.isArray(error.details?.problems)
        || !error.details?.candidateSha256) {
      const { findingDocumentation } = await import('./finding-catalog.mjs');
      fail(`The current finding is ${error?.code ?? 'not a code-delivery finding'}, which this dispute cannot cover. ${error?.message ?? ''} `
        + `Its documented routes: ${findingDocumentation({ code: error?.code ?? 'UNKNOWN' }).command}`,
      'PHASE_FINDING_DISPUTE_NOT_ELIGIBLE');
    }
    return { problems: [...error.details.problems], findings: [...error.details.findings ?? []],
      candidateSha256: error.details.candidateSha256 };
  }
}

const ENTRY_ID = /^(FND-[a-f0-9]{24}) /u;
const ENTRY_LIMIT = 2000;

/**
 * The entries a new dispute records: each problem keyed by its canonical finding ID, the sentence
 * kept for the reviewer and cut to the schema's entry limit [SDA-AC-022]. The schema is unchanged,
 * so an older client still reads the record; it compares whole sentences, so it fails closed on it.
 */
export function disputeEntries(problems, findings = []) {
  return problems.map((problem, index) => {
    const id = findings[index]?.id;
    return id ? `${id} ${problem}`.slice(0, ENTRY_LIMIT) : problem;
  });
}

/**
 * Whether a recorded dispute covers every current problem: an ID-keyed entry covers the finding
 * with that ID whatever its sentence now says; a sentence-only entry (a record made before IDs) is
 * the migration alias and covers exactly that sentence, as before.
 */
export function disputeCovers(entries, current) {
  const ids = new Set(entries.map((entry) => ENTRY_ID.exec(entry)?.[1]).filter(Boolean));
  return current.every(({ id, problem }) => (id && ids.has(id)) || entries.includes(problem));
}

export async function prepareCodeDeliveryDispute(root, config, workflow, phase, { evidence = [], expires, reason } = {}) {
  if (workflow.status !== 'in_progress' || workflow.currentPhase !== phase?.id || phase.status !== 'in_progress'
      || phase.generationIntent?.status !== 'open') {
    fail('A code-delivery dispute needs the current step with its open code generation. A published generation keeps its own checks; use recover for anything else.', 'PHASE_FINDING_DISPUTE_LIFECYCLE');
  }
  const paths = [...new Set((Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean).map(String))];
  if (!paths.length || paths.length > DISPUTE_EVIDENCE_LIMITS.items) {
    fail(`Attach 1 to ${DISPUTE_EVIDENCE_LIMITS.items} --evidence-file paths that show the work is right (test output, the test file, a log).`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires ?? '')) fail('Give an expiry as YYYY-MM-DD within the next 90 days.');
  const expiresAt = `${expires}T23:59:59.999Z`; const time = Date.parse(expiresAt);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== expires
      || time <= Date.now() || time - Date.now() > 90 * 86400000) fail('Expiry must be a valid future date within 90 days.');
  const observed = await observeCodeDelivery(root, config, workflow, phase);
  if (!observed) fail('The code delivery passes; there is no finding to dispute.', 'PHASE_FINDING_DISPUTE_NOT_ELIGIBLE');
  const problems = disputeEntries(observed.problems, observed.findings);
  const core = { schemaVersion: 3, kind: 'phase-quality-risk',
    binding: findingDisputeBinding(workflow, phase, observed.candidateSha256),
    gateMode: 'dispute', enablesPilotForPhase: false, gate: 'CODE_DELIVERY_EVIDENCE_REQUIRED', clauses: [],
    problems, evidence: await Promise.all(paths.map((candidate) => evidenceItem(root, candidate))),
    transitions: ['publish'], expiresAt, reason: typeof reason === 'string' ? reason.trim() : reason,
    observationSha256: digest(problems) };
  const parsed = FindingDisputePacketSchema.safeParse({ ...core, packetSha256: digest(core) });
  if (!parsed.success) fail(`The dispute is incomplete: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'packet'} ${issue.message}`).join('; ')}. Give a reason of at least 20 characters.`);
  return parsed.data;
}

/**
 * The accepted dispute that covers these exact findings for this candidate, if any, with every
 * dispute's status for display. Reads nothing when the Story records no dispute.
 */
export async function codeDeliveryDisputeStatus(root, config, workflow, phase, { problems, findings = [], candidateSha256, at = nowIso() } = {}) {
  return disputeStatus(root, config, workflow, phase, { gate: 'CODE_DELIVERY_EVIDENCE_REQUIRED', at,
    binding: findingDisputeBinding(workflow, phase, candidateSha256),
    covers: (record) => disputeCovers(record.problems, problems.map((problem, index) => ({ id: findings[index]?.id ?? null, problem }))) });
}

/** Every recorded dispute of `gate` on this step with its status, and the first active one; `covers` says whether it still covers what the gate reports. */
async function disputeStatus(root, config, workflow, phase, { gate, binding, covers, at = nowIso() }) {
  const recorded = (workflow.qualityRiskDecisions ?? []).filter((record) => isFindingDispute(record)
    && record.gate === gate && record.binding?.phaseId === phase.id);
  if (!recorded.length) return { active: null, items: [] };
  const { retainedQualityRiskRecords } = await import('./phase-quality-risk.mjs');
  const retained = await retainedQualityRiskRecords(root, config, workflow);
  // SF Guard: on a Story it requires, only a signed revocation or decision counts [SPEC-PSS-v1 §10.7].
  const revoked = new Set(countedRecords(workflow, retained.filter((record) => record.revokes)).map((record) => record.revokes));
  const counted = new Set(countedRecords(workflow, retained));
  let active = null; const items = [];
  for (const record of retained.filter((entry) => isFindingDispute(entry) && entry.gate === gate && entry.binding.phaseId === phase.id)) {
    const covered = covers(record);
    const status = revoked.has(record.id) ? 'revoked'
      : !counted.has(record) ? 'unsigned'
      : Date.parse(record.expiresAt) <= Date.parse(at) ? 'expired'
        : canonicalJson(record.binding) !== canonicalJson(binding) ? 'stale'
          : !covered ? 'observation-changed'
            : !await humanReviewOriginPresent(root, record) ? 'needs-reattestation' : 'active';
    const item = { id: record.id, gate: record.gate, clauses: [], status, problems: record.problems,
      evidence: record.evidence.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), reason: record.reason,
      expiresAt: record.expiresAt, actor: record.actor, authorityGroup: record.authorityGroup,
      transitions: record.transitions, decisionSha256: digest(record), packetSha256: record.packetSha256 };
    items.push(item);
    if (status === 'active' && !active) active = item;
  }
  return { active, items };
}

/** The current status of every dispute on this step, for re-attestation and display. */
export async function inspectCodeDeliveryDisputes(root, config, workflow, phase) {
  let observed = null;
  try { observed = await observeCodeDelivery(root, config, workflow, phase); } catch { observed = null; }
  if (!observed) return { risks: { items: [] } };
  return { risks: await codeDeliveryDisputeStatus(root, config, workflow, phase, observed) };
}

export function isDisputableFinding(code) {
  return DISPUTABLE_GATES.includes(String(code ?? ''));
}

/**
 * The plan falls short of the approved verification intent, and its approvers may uphold it [PHR:REQ-003,
 * finding 2]: a dispute before them, tied to the exact plan draft (any change to it voids the dispute),
 * honoured only by the verification-intent check and only for the rows it names. The plan's own row
 * errors are never disputable here: they are the planner's to correct.
 */
export const PLAN_INTENT_GATE = 'SPEC_VERIFICATION_INTENT_INVALID';

/**
 * The exact plan draft (its authored text: the status block publication writes is not the plan) and
 * the approved intent of every clause, as one digest.
 */
export async function planDraftSha256(text, clauses) {
  const { authoredArtifactText } = await import('./publication-preflight.mjs');
  return digest({ plan: createHash('sha256').update(authoredArtifactText(text)).digest('hex'),
    intents: clauses.map((clause) => [clause.id, clause.verification ?? null]).sort(([left], [right]) => String(left).localeCompare(String(right))) });
}

/** The plan step's draft, the clauses it plans (an earlier step defines them) and its draft generation, or null. */
async function planDraft(root, config, workflow, phase) {
  const { loadActiveSpecRecords } = await import('./specifications.mjs');
  const { requiredRepoPath } = await import('./story-state-validation.mjs');
  const { workDir } = await import('./story-paths.mjs');
  const { nextPhaseGeneration } = await import('./phase-generation.mjs');
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  const indexes = (records.indexes ?? []).filter((index) => index.phase !== phase.id);
  const clauses = indexes.flatMap((index) => index.clauses ?? []);
  if (!clauses.length) return null;
  const artifactPath = requiredRepoPath(config, workflow, phase);
  const secured = await secureRepositoryPath(root, artifactPath, { mustExist: true, type: 'file', label: 'Plan draft' }).catch(() => null);
  if (!secured) return null;
  const text = await readFile(secured.absolute, 'utf8');
  const policy = workflow.resolution?.spec ?? config.spec ?? {};
  const generation = Number(phase.status === 'in_progress' ? nextPhaseGeneration(phase) : phase.generation);
  return { text, clauses, indexes, policy, artifactPath, generation,
    evidenceRoot: `${String(workflow.resolution?.workItemRoot ?? config.workItemRoot ?? 'singularity/work-items')}/${workflow.workItem.id}/evidence` };
}

/** Each row of the plan that falls short of the approved intent, one at a time (the check stops at the first). */
export async function intentNotMet(draft, upheld = new Set()) {
  const { inspectPlannedClaimMap } = await import('./specifications.mjs');
  const { authoredArtifactText } = await import('./publication-preflight.mjs');
  const authored = authoredArtifactText(draft.text);
  const kept = new Set(upheld);
  const rows = [];
  for (let index = 0; index <= draft.clauses.length; index += 1) {
    const inspected = inspectPlannedClaimMap(authored, { clauseIds: draft.clauses.map((clause) => clause.id), clauses: draft.clauses,
      policy: draft.policy, evidenceRoot: draft.evidenceRoot, upheldIntent: kept });
    const next = inspected.diagnostics.find((entry) => entry.details?.cause === 'intent-not-met' && entry.clauseId && !kept.has(entry.clauseId));
    if (!next) break;
    kept.add(next.clauseId);
    rows.push({ clauseId: next.clauseId, message: next.message });
  }
  return rows;
}

async function planIntentBinding(workflow, phase, draft) {
  return { workId: workflow.workItem.id, phaseId: phase.id, generation: draft.generation,
    candidateSha256: await planDraftSha256(draft.text, draft.clauses), policySha256: digest(workflow.resolution ?? null) };
}

/** The clause a dispute entry names: each entry starts with it. */
const entryClause = (entry) => String(entry).split(' ')[0];

/** Prepare a dispute of the rows that fall short of the approved intent, for the plan's approvers to review. */
export async function preparePlanIntentDispute(root, config, workflow, phase, { evidence = [], expires, reason } = {}) {
  if (workflow.status !== 'in_progress' || workflow.currentPhase !== phase?.id || phase.status !== 'in_progress') {
    fail('A plan dispute needs the current plan step with its open draft.', 'PHASE_FINDING_DISPUTE_LIFECYCLE');
  }
  const paths = [...new Set((Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean).map(String))];
  if (!paths.length || paths.length > DISPUTE_EVIDENCE_LIMITS.items) {
    fail(`Attach 1 to ${DISPUTE_EVIDENCE_LIMITS.items} --evidence-file paths that show the plan is right (the plan, a design note, a log).`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(expires ?? '')) fail('Give an expiry as YYYY-MM-DD within the next 90 days.');
  const expiresAt = `${expires}T23:59:59.999Z`; const time = Date.parse(expiresAt);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== expires
      || time <= Date.now() || time - Date.now() > 90 * 86400000) fail('Expiry must be a valid future date within 90 days.');
  const draft = await planDraft(root, config, workflow, phase);
  const rows = draft ? await intentNotMet(draft) : [];
  if (!rows.length) fail('The plan meets the approved verification intent; there is nothing to dispute.', 'PHASE_FINDING_DISPUTE_NOT_ELIGIBLE');
  const problems = rows.map((row) => `${row.clauseId} ${row.message}`.slice(0, 2000));
  const core = { schemaVersion: 3, kind: 'phase-quality-risk', binding: await planIntentBinding(workflow, phase, draft),
    gateMode: 'dispute', enablesPilotForPhase: false, gate: PLAN_INTENT_GATE, clauses: [],
    problems, evidence: await Promise.all(paths.map((candidate) => evidenceItem(root, candidate))),
    transitions: ['publish'], expiresAt, reason: typeof reason === 'string' ? reason.trim() : reason,
    observationSha256: digest(problems) };
  const parsed = FindingDisputePacketSchema.safeParse({ ...core, packetSha256: digest(core) });
  if (!parsed.success) fail(`The dispute is incomplete: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'packet'} ${issue.message}`).join('; ')}. Give a reason of at least 20 characters.`);
  return parsed.data;
}

/** Every plan dispute on this step with its status for the current draft, for re-attestation and display. */
export async function inspectPlanIntentDisputes(root, config, workflow, phase) {
  const draft = await planDraft(root, config, workflow, phase).catch(() => null);
  if (!draft) return { risks: { items: [] } };
  return { risks: await disputeStatus(root, config, workflow, phase, { gate: PLAN_INTENT_GATE,
    binding: await planIntentBinding(workflow, phase, draft), covers: () => true }) };
}

/**
 * The rows the plan's approvers upheld against the approved intent, for this exact draft: those an
 * active dispute names, and each clause an unexpired accepted risk on an upstream issue against an
 * earlier step names (as settledUpstreamClauses settles code coverage). A dismissal settles nothing.
 * `text` and `clauses` are the draft and the clauses the caller judges it with.
 */
export async function upheldIntentRows(root, config, workflow, phase, { text, clauses }) {
  const { settledUpstreamClauses } = await import('./upstream-routes.mjs');
  const upheld = new Set(settledUpstreamClauses(workflow, phase.id, clauses.map((clause) => clause.id)).map((entry) => String(entry.clauseId).toUpperCase()));
  if ((workflow.qualityRiskDecisions ?? []).some((record) => record?.gate === PLAN_INTENT_GATE && record.binding?.phaseId === phase.id)) {
    const { nextPhaseGeneration } = await import('./phase-generation.mjs');
    const generation = Number(phase.status === 'in_progress' ? nextPhaseGeneration(phase) : phase.generation);
    const { active } = await disputeStatus(root, config, workflow, phase, { gate: PLAN_INTENT_GATE, covers: () => true,
      binding: await planIntentBinding(workflow, phase, { text, clauses, generation }) });
    for (const entry of active?.problems ?? []) upheld.add(entryClause(entry).toUpperCase());
  }
  return upheld;
}
