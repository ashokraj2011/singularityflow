/** Version two quality decisions: the same human authority, for review-document quality. */
import { z } from 'zod';
const SHA = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ArtifactRiskPacketSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('phase-quality-risk'),
  binding: z.object({ workId: z.string().min(1), phaseId: z.string().min(1), generation: z.number().int().positive(),
    contentSha256: SHA, upstreamSha256: SHA, policySha256: SHA }).strict(),
  gateMode: z.literal('soft'), enablesPilotForPhase: z.boolean(), gate: z.literal('PHASE_ARTIFACT_QUALITY'),
  clauses: z.array(z.string()).max(0),
  findings: z.array(z.object({ code: z.enum(['artifact.placeholder.unresolved', 'artifact.required.too-short', 'artifact.heading.empty']),
    path: z.string().min(1).max(1024), value: z.string().max(1000).nullable() }).strict()).min(1).max(200),
  transitions: z.array(z.enum(['publish', 'submit', 'approve', 'consume', 'terminal'])).min(1).max(5),
  expiresAt: z.string().datetime(), reason: z.string().trim().min(20).max(1000).refine(value => !/[\x00-\x1f\x7f]/u.test(value)),
  observationSha256: SHA, packetSha256: SHA }).strict();
export const ArtifactRiskDecisionSchema = ArtifactRiskPacketSchema.extend({ id: z.string().regex(/^PQR-[a-f0-9]{24}$/u),
  actor: z.string().min(1), authorityGroup: z.string().min(1), identityAssurance: z.string().nullable(),
  authorizationId: z.string().min(1), reviewAssurance: z.literal('live-terminal-risk-review'), at: z.string().datetime(),
  testsWaived: z.literal(false), phaseApproved: z.literal(false) }).strict();
