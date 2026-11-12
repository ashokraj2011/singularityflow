import { createHash } from 'node:crypto';

import {
  changedRepositoryPaths, loadActiveSpecRecords, mergeObservedClaimRecords, mergePlannedClaimRecords
} from './specifications.mjs';
import { applicationPathContext } from './application-paths.mjs';
import { storyRepositoryBases, storyRepositoryBaseText } from './capability-branches.mjs';
import { qualityValidationVerdict } from './lifecycle-evidence-policy.mjs';
import { countedApprovals } from './presence/counted.mjs';
import { workDir } from './story-paths.mjs';
import { run } from './util.mjs';

/** The receipt's next human action while people review the phase. */
const REVIEW_ACTION = 'Review and decide this phase.';
export const EVIDENCE_RECEIPT_RESULT_VERSION = 2; // schema-transient: deterministic projection, never persisted

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/**
 * Check counts by the same rule the gates apply (`qualityValidationVerdict`): blocked and unknown
 * statuses are failures, unavailable and skipped checks are unavailable, an advisory scanner that
 * reported problems is warned, and a configured check with
 * no record is unavailable. Every recorded check lands in exactly one count, so a receipt can never
 * read "1 passed · 0 failed · 0 unavailable" over a required check that did not run. A failure that
 * passed its transition under accepted risk stays a failure and is also counted as such.
 */
function checkProjection(phase, packet) {
  const configured = phase?.deliveryEvidence?.validation?.commands?.length
    ?? phase?.qualityCommands?.length
    ?? 0;
  const recorded = packet.checks ?? [];
  const verdict = qualityValidationVerdict(recorded);
  const acceptedRisk = recorded.filter((check) => check?.disposition === 'accepted-risk').length;
  return {
    status: recorded.length >= configured ? 'exact' : 'partial',
    configured,
    recorded: recorded.length,
    passed: recorded.filter((check) => check?.status === 'passed').length,
    failed: verdict.failed.length,
    unavailable: verdict.unavailable.length + Math.max(0, configured - recorded.length),
    ...(verdict.warned.length ? { warned: verdict.warned.length } : {}),
    ...(acceptedRisk ? { acceptedRisk } : {})
  };
}

function approvalProjection(phase, packet, workflow) {
  const mode = phase?.approvalPolicy?.mode ?? 'required';
  const required = ['none', 'policy'].includes(mode) ? 0 : phase?.approvalPolicy?.minimum ?? 1;
  // On a Story SF Guard requires, only an approval whose presence signature verifies counts (M4).
  const decisions = countedApprovals(workflow, (packet.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved'));
  return { status: 'exact', mode, required, current: decisions.length };
}

/**
 * SF Guard's re-verification of the Story's person records, as the receipt shows it (SPEC-PSS-v1
 * AC-013): every signature verified again from the pinned keys when the receipt is composed. An
 * observation, like the publication state: it reads the policy chain as it stands. Deterministic, so
 * the observation hash is too.
 */
function presenceProjection(report) {
  const notCounted = report.records.filter((entry) => entry.active && !entry.counts).length;
  return { status: report.required ? 'required' : 'off', signed: report.summary.signed, bypass: report.summary.bypass,
    preSigning: report.summary.preSigning, notCounted };
}

/**
 * SF Guard's labels as the packet sealed them (SPEC-SFG-v1 REQ-041, REQ-050): their digest, whether
 * the block still matches it, and the counts. From the packet alone, so the core stays deterministic.
 */
function attributionProjection(packet, attribution) {
  const block = packet.attribution;
  return { status: block.status, sha256: block.sha256 ?? null, verified: attribution.attributionDigest(block) === block.sha256,
    counts: block.counts ?? null,
    // G4 (AC-011): the agents whose stamped file drifted, only where the packet sealed any, so other receipts are unchanged.
    ...(Array.isArray(block.agentDrift) && block.agentDrift.length ? { agentDrift: block.agentDrift.map((entry) => entry.id) } : {}) };
}

/**
 * Whether the packet's labels are still sealed here (AC-009): the packet file at its path holds the
 * bytes its digest names, and a counted approval signs that digest. An observation of this clone.
 */
async function attributionSealProjection(root, workflow, packet, attribution) {
  const entry = workflow.lineage?.submissions?.find((item) => item.packetSha256 === packet.packetSha256) ?? null;
  const standing = attribution.packetFileStanding(entry?.path ? await attribution.checkoutReader(root)(entry.path).catch(() => null) : null, packet.packetSha256);
  const approvals = countedApprovals(workflow, (workflow.phases?.[packet.phase]?.approvals ?? [])
    .filter((item) => !item.invalidatedAt && item.decision === 'approved' && item.reviewPacketSha256 === packet.packetSha256));
  if (standing.status !== 'intact') return { status: standing.status, reason: standing.reason ?? null, approvals: approvals.length };
  return { status: approvals.length ? 'sealed' : 'not-yet-approved', approvals: approvals.length };
}

function contextProjection(packet) {
  if (packet.authorship?.producer !== 'governed-agent') {
    return { status: 'exact', source: 'not-invoked', briefs: 0 };
  }
  const briefs = packet.agentBriefs ?? [];
  if (!briefs.length) return { status: 'unavailable', source: 'agent-briefs', briefs: 0 };
  return {
    status: briefs.every((brief) => brief.status === 'ready') ? 'exact' : 'partial',
    source: 'agent-briefs',
    briefs: briefs.length,
    hashes: briefs.map((brief) => brief.integritySha256).filter(Boolean).sort()
  };
}

function requirementProjection(records, policy) {
  if (policy?.coverage === 'off') {
    return { status: 'exact', configured: false, clauses: 0, claimed: 0 };
  }
  if (!(records.indexes ?? []).length) {
    return { status: 'unavailable', configured: true, clauses: null, claimed: null };
  }
  const clauses = new Set((records.indexes ?? []).flatMap((index) => index.clauses ?? []).map((clause) => clause.id));
  const planned = mergePlannedClaimRecords(records.planned ?? []);
  const observed = mergeObservedClaimRecords(records.observed ?? [], planned);
  const claimed = [...clauses].filter((id) => observed[id] && observed[id].verdict !== 'missing').length;
  return { status: 'exact', configured: true, clauses: clauses.size, claimed };
}

function publicationProjection(root, config, packet) {
  if (config.git?.publish === 'off') {
    return { status: 'exact', state: 'local-only', branch: packet.submittedBranch };
  }
  const remote = config.git?.remote ?? 'origin';
  const branch = packet.submittedBranch;
  const observed = run('git', [
    'merge-base', '--is-ancestor', packet.sourceCommit, `refs/remotes/${remote}/${branch}`
  ], { cwd: root, allowFailure: true });
  if (observed.status === 0) return { status: 'exact', state: 'published', branch, remote };
  return { status: 'unavailable', state: 'unverified', branch, remote };
}

/**
 * Compose the compact developer receipt exclusively from durable Story records.
 *
 * This is a projection, not a new evidence store. Re-running it in a fresh clone with the same
 * packet produces the same `receiptCoreSha256`; timestamps, local paths and transient push output
 * are deliberately absent. Clone-local reachability and availability are separately hashed
 * observations and never redefine the receipt's immutable identity.
 */
export async function composeEvidenceReceipt(root, config, workflow, packet) {
  const phase = workflow.phases?.[packet.phase] ?? null;
  const presence = workflow.resolution?.presence
    ? await (await import('./presence/story-verify.mjs')).storyPresenceReport(root, workflow) : null;
  const attribution = packet.attribution ? await import('./presence/attribution.mjs') : null;
  let changedPaths = { status: 'unavailable', count: null, sha256: null };
  try {
    const base = workflow.workItem.baseCommit ?? workflow.workItem.baseBranch;
    const paths = changedRepositoryPaths(root, {
      base, target: packet.sourceCommit,
      pathContext: applicationPathContext(config, workflow)
    });
    changedPaths = { status: 'exact', count: paths.length, sha256: digest(paths) };
  } catch {
    // A shallow clone or unavailable base is a truthful unavailable projection, never zero changes.
  }

  let requirements = { status: 'unavailable', configured: true, clauses: null, claimed: null };
  const specPolicy = workflow.resolution?.spec ?? config.spec ?? {};
  if (specPolicy.coverage === 'off') requirements = requirementProjection({}, specPolicy);
  else {
    try {
      const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
      requirements = requirementProjection(records, specPolicy);
    } catch {
      // The packet remains usable even when optional specification records cannot be read.
    }
  }

  const core = {
    schemaVersion: EVIDENCE_RECEIPT_RESULT_VERSION,
    kind: 'submission-evidence-receipt',
    work: { id: workflow.workItem.id, phase: packet.phase, generation: packet.generation },
    source: { status: 'exact', commit: packet.sourceCommit, treeSha256: packet.sourceTreeSha256 },
    checks: checkProjection(phase, packet),
    approvals: approvalProjection(phase, packet, workflow),
    context: contextProjection(packet),
    reviewPacket: { status: 'exact', sha256: packet.packetSha256 },
    ...(attribution ? { attribution: attributionProjection(packet, attribution) } : {}),
    nextHumanAction: packet.status === 'awaiting_review' ? REVIEW_ACTION : 'Continue to the next phase.',
    links: {
      reviewPacket: workflow.lineage?.submissions?.find((entry) => entry.packetSha256 === packet.packetSha256)?.path ?? null,
      trace: `singularity-flow spec trace --work-id ${workflow.workItem.id}`,
      status: `singularity-flow status --work-id ${workflow.workItem.id}`
    }
  };
  // Each repository's base sits with the observations, not the core: a Story that already has a
  // receipt keeps the same receiptCoreSha256 when it replays, and one repository adds nothing.
  const repositoryBases = storyRepositoryBases(workflow).map(({ repositoryId, baseBranch, baseCommit, source }) =>
    ({ repositoryId, baseBranch, baseCommit, ...(source ? { source } : {}) }));
  const observations = {
    changes: changedPaths,
    requirements,
    publication: publicationProjection(root, config, packet),
    ...(repositoryBases.length ? { repositoryBases } : {}),
    ...(presence?.applies ? { presence: presenceProjection(presence) } : {}),
    ...(attribution ? { attributionSeal: await attributionSealProjection(root, workflow, packet, attribution) } : {})
  };
  const receiptCoreSha256 = digest(core);
  const observationSha256 = digest(observations);
  return Object.freeze({
    ...core,
    ...observations,
    observations: Object.freeze({ ...observations, sha256: observationSha256 }),
    receiptCoreSha256,
    observationSha256,
    // Compatibility name: this has always represented the receipt's durable identity. In v2 it
    // explicitly aliases the immutable core rather than clone-local observations.
    receiptSha256: receiptCoreSha256
  });
}

/**
 * The receipt's approval count in words. A phase nobody approves is not "0/0 (exact)": approval
 * mode none needs no approval, and mode policy is completed by its deterministic waiver or, when
 * the waiver does not apply, by people. The receipt's recorded fields, and so its hashes, are unchanged.
 */
export function receiptApprovalText(receipt) {
  const { approvals } = receipt;
  if (approvals.mode === 'none') return 'not required (approval mode none)';
  if (approvals.mode === 'policy') {
    return receipt.nextHumanAction === REVIEW_ACTION
      ? `${approvals.current} recorded; the low-risk policy did not waive this phase, so it needs human approval`
      : `waived by the deterministic low-risk policy (${approvals.current} human approval${approvals.current === 1 ? '' : 's'} recorded)`;
  }
  return `${approvals.current}/${approvals.required} (${approvals.status})`;
}

/** SF Guard's line on a receipt: how the Story's person records verified when it was composed. */
export function receiptPresenceText(presence) {
  if (presence.status !== 'required') return `off for this Story${presence.preSigning ? ` (${presence.preSigning} record(s) pre-signing)` : ''}`;
  return [`${presence.signed} signed`, ...(presence.bypass ? [`${presence.bypass} bypass (per-person exception)`] : []),
    ...(presence.notCounted ? [`${presence.notCounted} not counted`] : []), 'every signature re-verified'].join(' · ');
}

/** SF Guard's labels line on a receipt: the sealed counts, and whether the seal still holds here. */
export function receiptAttributionText(receipt) {
  const block = receipt.attribution;
  if (block.status === 'unavailable') return 'labels unavailable at submission';
  const words = { 'outside-workflow': 'outside the workflow', 'unknown-agent': 'agent unknown', shell: 'shell command', unattributed: 'unattributed', 'pre-guard': 'before SF Guard' };
  const parts = [`${block.counts?.declared ?? 0} declared`, ...Object.entries(words).filter(([name]) => block.counts?.[name]).map(([name, word]) => `${block.counts[name]} ${word}`)];
  const seal = receipt.attributionSeal;
  const standing = !block.verified ? 'the labels do not match their own digest'
    : seal?.status === 'sealed' ? `sealed by ${seal.approvals} counted approval(s)`
      : seal?.status === 'not-yet-approved' ? 'not sealed yet: no counted approval signs this packet'
        : seal ? `the sealed packet ${seal.status === 'absent' ? 'is gone' : `was changed after submission (${seal.reason})`}` : 'seal not checked';
  const drift = block.agentDrift?.length ? ` · agent file drift: ${block.agentDrift.join(', ')}` : '';
  return `${parts.join(' · ')} (lines, ${block.status})${drift} · ${standing}`;
}

export function renderEvidenceReceipt(receipt) {
  const unavailable = (value) => value == null ? 'unavailable' : String(value);
  return [
    `Evidence receipt: ${receipt.work.id} · ${receipt.work.phase} generation ${receipt.work.generation}`,
    // The receipt as a person reads it: no commit or digest (owner, 2026-11-11); `--json` and the Markdown record keep them.
    `Changes: ${unavailable(receipt.changes.count)} (${receipt.changes.status})`,
    ...(receipt.repositoryBases ? [`Bases: ${receipt.repositoryBases.map(storyRepositoryBaseText).join(' · ')}`] : []),
    `Requirements: ${unavailable(receipt.requirements.claimed)}/${unavailable(receipt.requirements.clauses)} claimed (${receipt.requirements.status})`,
    `Checks: ${receipt.checks.passed} passed · ${receipt.checks.failed} failed · ${receipt.checks.unavailable} unavailable (${receipt.checks.status})${receipt.checks.acceptedRisk ? ` · ${receipt.checks.acceptedRisk} under accepted risk` : ''}`,
    `Approvals: ${receiptApprovalText(receipt)}`,
    ...(receipt.presence ? [`SF Guard: ${receiptPresenceText(receipt.presence)}`] : []),
    ...(receipt.attribution ? [`SF Guard labels: ${receiptAttributionText(receipt)}`] : []),
    `Context: ${receipt.context.status}`,
    `Publication: ${receipt.publication.state} · Next: ${receipt.nextHumanAction}`
  ].join('\n');
}

export function renderEvidenceReceiptMarkdown(receipt) {
  const value = (entry) => entry == null ? 'unavailable' : String(entry);
  return [
    `# Evidence receipt — ${receipt.work.id}`,
    '',
    `- Phase: \`${receipt.work.phase}\` generation ${receipt.work.generation}`,
    `- Source commit: \`${receipt.source.commit}\``,
    ...(receipt.repositoryBases ? [`- Bases: ${receipt.repositoryBases.map(base => `\`${storyRepositoryBaseText(base, { commit: true })}\``).join(', ')}`] : []),
    `- Changed paths: **${value(receipt.changes.count)}** (${receipt.changes.status})`,
    `- Requirements claimed: **${value(receipt.requirements.claimed)}/${value(receipt.requirements.clauses)}** (${receipt.requirements.status})`,
    `- Checks: **${receipt.checks.passed} passed**, **${receipt.checks.failed} failed**, **${receipt.checks.unavailable} unavailable** (${receipt.checks.status})${receipt.checks.acceptedRisk ? `, ${receipt.checks.acceptedRisk} under accepted risk` : ''}`,
    `- Approvals: **${receiptApprovalText(receipt)}**`,
    ...(receipt.presence ? [`- SF Guard: **${receiptPresenceText(receipt.presence)}**`] : []),
    ...(receipt.attribution ? [`- SF Guard labels: **${receiptAttributionText(receipt)}**`] : []),
    `- Context provenance: **${receipt.context.status}**`,
    `- Review packet: \`${receipt.reviewPacket.sha256}\``,
    `- Publication: **${receipt.publication.state}** on \`${receipt.publication.branch}\``,
    `- Next: ${receipt.nextHumanAction}`,
    '',
    `Receipt core SHA-256: \`${receipt.receiptCoreSha256 ?? receipt.receiptSha256}\``,
    `Observation SHA-256: \`${receipt.observationSha256 ?? 'unavailable'}\``,
    '',
    `Review packet: ${receipt.links.reviewPacket ?? 'unavailable'}`,
    `Trace: \`${receipt.links.trace}\``
  ].join('\n');
}
