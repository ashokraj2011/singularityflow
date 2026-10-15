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
    return { problems: [...error.details.problems], candidateSha256: error.details.candidateSha256 };
  }
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
  const core = { schemaVersion: 3, kind: 'phase-quality-risk',
    binding: findingDisputeBinding(workflow, phase, observed.candidateSha256),
    gateMode: 'dispute', enablesPilotForPhase: false, gate: 'CODE_DELIVERY_EVIDENCE_REQUIRED', clauses: [],
    problems: observed.problems, evidence: await Promise.all(paths.map((candidate) => evidenceItem(root, candidate))),
    transitions: ['publish'], expiresAt, reason: typeof reason === 'string' ? reason.trim() : reason,
    observationSha256: digest(observed.problems) };
  const parsed = FindingDisputePacketSchema.safeParse({ ...core, packetSha256: digest(core) });
  if (!parsed.success) fail(`The dispute is incomplete: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'packet'} ${issue.message}`).join('; ')}. Give a reason of at least 20 characters.`);
  return parsed.data;
}

/**
 * The accepted dispute that covers these exact problems for this candidate, if any, with every
 * dispute's status for display. Reads nothing when the Story records no dispute.
 */
export async function codeDeliveryDisputeStatus(root, config, workflow, phase, { problems, candidateSha256, at = nowIso() } = {}) {
  const recorded = (workflow.qualityRiskDecisions ?? []).filter((record) => isFindingDispute(record)
    && record.gate === 'CODE_DELIVERY_EVIDENCE_REQUIRED' && record.binding?.phaseId === phase.id);
  if (!recorded.length) return { active: null, items: [] };
  const { retainedQualityRiskRecords } = await import('./phase-quality-risk.mjs');
  const retained = await retainedQualityRiskRecords(root, config, workflow);
  const revoked = new Set(retained.filter((record) => record.revokes).map((record) => record.revokes));
  const binding = findingDisputeBinding(workflow, phase, candidateSha256);
  let active = null; const items = [];
  for (const record of retained.filter((entry) => isFindingDispute(entry) && entry.binding.phaseId === phase.id)) {
    const covered = problems.every((problem) => record.problems.includes(problem));
    const status = revoked.has(record.id) ? 'revoked'
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
