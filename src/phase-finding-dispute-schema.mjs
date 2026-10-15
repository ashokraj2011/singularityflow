/**
 * A disputed finding: the step's approvers accept an exact exception, never a pass.
 * `[recoverable-findings M2]`
 *
 * Owner decision (2026-10-15): when a check misreads correct work (an Android Story's tests in
 * src/androidTest were not recognised, so every owed tag read as missing and its author looped),
 * the step's own approvers may accept the exact finding as an exception for that generation, on
 * attached evidence, in a live terminal. It is recorded as an exception, shown wherever the Story's
 * evidence is reviewed, and never counted as passing evidence.
 */
import { z } from 'zod';

const SHA = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const text = (maximum) => z.string().trim().min(20).max(maximum).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const portablePath = z.string().min(1).max(512).refine((value) => value === value.trim()
  && !value.startsWith('/') && !/\\|^[A-Za-z]:|[\x00-\x1f\x7f]/u.test(value)
  && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..'));

/** The gates that honour an accepted dispute. Every other finding keeps its documented routes. */
export const DISPUTABLE_GATES = Object.freeze(['CODE_DELIVERY_EVIDENCE_REQUIRED']);
export const DISPUTE_EVIDENCE_LIMITS = Object.freeze({ items: 5, fileBytes: 4 * 1024 * 1024, excerptChars: 4096 });

export const FindingDisputePacketSchema = z.object({
  schemaVersion: z.literal(3), kind: z.literal('phase-quality-risk'),
  binding: z.object({ workId: z.string().min(1), phaseId: z.string().min(1), generation: z.number().int().positive(),
    candidateSha256: SHA, policySha256: SHA }).strict(),
  gateMode: z.literal('dispute'), enablesPilotForPhase: z.literal(false),
  gate: z.enum(DISPUTABLE_GATES), clauses: z.array(z.string()).max(0),
  // The exact problems the gate reported for this candidate; a different problem is not covered.
  problems: z.array(z.string().min(1).max(2000)).min(1).max(50),
  evidence: z.array(z.object({ path: portablePath, sha256: SHA, bytes: z.number().int().nonnegative(),
    excerpt: z.string().max(DISPUTE_EVIDENCE_LIMITS.excerptChars).nullable() }).strict())
    .min(1).max(DISPUTE_EVIDENCE_LIMITS.items),
  // The editable candidate's publication only; a published generation keeps its own checks.
  transitions: z.array(z.literal('publish')).length(1),
  expiresAt: z.string().datetime(), reason: text(2000), observationSha256: SHA, packetSha256: SHA
}).strict();

export const FindingDisputeDecisionSchema = FindingDisputePacketSchema.extend({
  id: z.string().regex(/^PQR-[a-f0-9]{24}$/u), actor: z.string().min(1), authorityGroup: z.string().min(1),
  identityAssurance: z.string().nullable(), authorizationId: z.string().min(1),
  reviewAssurance: z.literal('live-terminal-risk-review'), at: z.string().datetime(),
  testsWaived: z.literal(false), phaseApproved: z.literal(false)
}).strict();

export const isFindingDispute = (record) => record?.gateMode === 'dispute' && DISPUTABLE_GATES.includes(record?.gate);
