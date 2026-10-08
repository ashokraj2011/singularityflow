/** Append-only correction of evidence typing, never an edit to an approved claim map. */
import { z } from 'zod';
import { recordSha256, canonicalJson } from './records.mjs';
import { exactFileAtObject, head } from './git.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { normalizeVerificationContracts } from './verification/contracts.mjs';
import { SingularityFlowError } from './util.mjs';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const portablePath = z.string().min(1).max(512).refine(value => !/[\\:*?"<>|\x00-\x1f\x7f]/u.test(value)
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)));
export const EvidenceAmendmentSchema = z.strictObject({
  id: z.string().regex(/^PEA-[a-f0-9]{24}$/u), kind: z.literal('evidence-contract-correction'),
  ownerPhase: z.string().min(1), ownerGeneration: z.number().int().positive(), ownerMapSha256: sha,
  clauseId: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u), previousClaimSha256: sha,
  path: portablePath, method: z.enum(['visual', 'inspection']),
  reason: z.string().trim().min(20).max(1000),
  actor: z.string().min(1), authorityGroup: z.string().min(1), authorizationId: z.string().min(1),
  reviewAssurance: z.enum(['live-terminal-exact-evidence-review', 'live-local-ui-exact-evidence-review']),
  at: z.string().datetime(), recordPath: portablePath,
  reviewedFile: z.strictObject({ sha256: sha, size: z.number().int().nonnegative().max(16 * 1024 * 1024) }),
  testsWaived: z.literal(false), phaseApproved: z.literal(false)
});

function invalid(message) { throw new SingularityFlowError(message, { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' }); }

/** A different plan's reviewers cannot change this owner's approved contract. */
export function evidenceOwnerAuthorities(workflow, ownerPhase) {
  const policy = workflow.phases?.[ownerPhase]?.approvalPolicy ?? {};
  return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
}

/** The same before/after projection is displayed for review and applied by every plan reader. */
export function evidenceCorrectionProjection(clauseId, claim, evidencePath, method) {
  const contract = normalizeVerificationContracts([{ clauseId, combination: 'all', slots: [
    { slot: 'retained-evidence', method, role: 'primary',
      witness: method === 'visual' ? { target: evidencePath } : { path: evidencePath }, requiredAssurance: 'source-bound' },
    ...(claim.tests ?? []).map((test, index) => ({ slot: `supporting-test-${index + 1}`, method: 'test', role: 'supporting',
      witness: { path: test }, requiredAssurance: null }))
  ] }])[0];
  return { claim: { ...structuredClone(claim), fulfillment: 'evidence', expectedPaths: [evidencePath] }, contract };
}

/** Apply only the exact owner's generation. A later approved plan supersedes its old correction. */
export function applyPlanEvidenceAmendments(record, workflow, { evidenceRoot } = {}) {
  let result = record;
  for (const value of workflow.planAmendments ?? []) {
    if (value.kind !== 'evidence-contract-correction') continue;
    const checked = EvidenceAmendmentSchema.safeParse(value);
    if (!checked.success) invalid('Evidence amendment schema or human decision binding is invalid.');
    const amendment = checked.data;
    if (!evidenceOwnerAuthorities(workflow, amendment.ownerPhase).includes(amendment.authorityGroup)) invalid('Evidence amendment lacks its exact owner plan authority.');
    if (amendment.ownerPhase !== record.phase || amendment.ownerGeneration !== Number(record.generation)) continue;
    const pointer = workflow.phases?.[record.phase]?.claimMaps?.planned;
    if (!pointer || pointer.sha256 !== amendment.ownerMapSha256) invalid('Evidence amendment no longer binds its approved owner map.');
    const claim = result.claims?.[amendment.clauseId];
    if (!claim || recordSha256(claim) !== amendment.previousClaimSha256) invalid('Evidence amendment does not replace the exact reviewed clause row.');
    if (evidenceRoot && !amendment.path.startsWith(`${evidenceRoot}/`)) invalid('Evidence amendment points outside this Story.');
    result = structuredClone(result);
    // Retain planned test files as supporting witnesses, not primary visual proof. Commands and
    // their required execution policy do not change. Source obligations of other clauses survive.
    const { claim: corrected, contract } = evidenceCorrectionProjection(amendment.clauseId, claim, amendment.path, amendment.method);
    result.claims[amendment.clauseId] = corrected;
    result.verificationContracts = normalizeVerificationContracts([
      ...(result.verificationContracts ?? []).filter(entry => entry.clauseId !== amendment.clauseId), contract
    ]);
  }
  return result;
}

/** Committed exact decision records are required even while the current draft is dirty. */
export async function verifyPlanEvidenceAmendments(root, workflow, itemRoot) {
  for (const entry of workflow.planAmendments ?? []) {
    if (entry.kind !== 'evidence-contract-correction') continue;
    if (!EvidenceAmendmentSchema.safeParse(entry).success
        || entry.recordPath !== `${itemRoot}/appeals/evidence/${entry.id}.json`) invalid('Evidence amendment has an invalid retained decision path.');
    const committed = exactFileAtObject(root, head(root), entry.recordPath, { maximumBytes: 65536, regularOnly: true });
    if (!committed?.equals(Buffer.from(canonicalJson(entry)))) invalid('Evidence correction is not the exact committed human decision.');
    const current = await readRepositoryManifest(root, entry.recordPath, { maxBytes: 65536 });
    if (current.links?.length || !current.bytes.equals(committed)) invalid('Retained evidence correction was changed after the human decision.');
  }
}
