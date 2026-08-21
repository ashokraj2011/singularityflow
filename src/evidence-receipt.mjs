import { createHash } from 'node:crypto';

import { changedRepositoryPaths, loadActiveSpecRecords } from './specifications.mjs';
import { workDir } from './state-stores.mjs';
import { run } from './util.mjs';

export const EVIDENCE_RECEIPT_RESULT_VERSION = 2; // schema-transient: deterministic projection, never persisted

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function counts(values, names) {
  return Object.fromEntries(names.map((name) => [name, values.filter((value) => value === name).length]));
}

function checkProjection(phase, packet) {
  const configured = phase?.qualityCommands?.length ?? 0;
  const recorded = packet.checks ?? [];
  const statuses = recorded.map((check) => check.status);
  const tally = counts(statuses, ['passed', 'failed', 'blocked', 'skipped-warning', 'stale']);
  const unavailable = tally.blocked + tally['skipped-warning'] + Math.max(0, configured - recorded.length);
  return {
    status: recorded.length >= configured ? 'exact' : 'partial',
    configured,
    recorded: recorded.length,
    passed: tally.passed,
    failed: tally.failed + tally.stale,
    unavailable
  };
}

function approvalProjection(phase, packet) {
  const mode = phase?.approvalPolicy?.mode ?? 'required';
  const required = ['none', 'policy'].includes(mode) ? 0 : phase?.approvalPolicy?.minimum ?? 1;
  const decisions = (packet.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  return { status: 'exact', mode, required, current: decisions.length };
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
  const observed = Object.assign({}, ...(records.observed ?? []).map((entry) => entry.claims ?? {}));
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
  let changedPaths = { status: 'unavailable', count: null, sha256: null };
  try {
    const base = workflow.workItem.baseCommit ?? workflow.workItem.baseBranch;
    const paths = changedRepositoryPaths(root, { base, target: packet.sourceCommit });
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
    approvals: approvalProjection(phase, packet),
    context: contextProjection(packet),
    reviewPacket: { status: 'exact', sha256: packet.packetSha256 },
    nextHumanAction: packet.status === 'awaiting_review'
      ? 'Review and decide this phase.'
      : 'Continue to the next governed phase.',
    links: {
      reviewPacket: workflow.lineage?.submissions?.find((entry) => entry.packetSha256 === packet.packetSha256)?.path ?? null,
      trace: `singularity-flow spec trace --work-id ${workflow.workItem.id}`,
      status: `singularity-flow status --work-id ${workflow.workItem.id}`
    }
  };
  const observations = {
    changes: changedPaths,
    requirements,
    publication: publicationProjection(root, config, packet)
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

export function renderEvidenceReceipt(receipt) {
  const unavailable = (value) => value == null ? 'unavailable' : String(value);
  return [
    `Evidence receipt: ${receipt.work.id} · ${receipt.work.phase} generation ${receipt.work.generation}`,
    `Source: ${receipt.source.commit.slice(0, 12)} · changes ${unavailable(receipt.changes.count)} (${receipt.changes.status})`,
    `Requirements: ${unavailable(receipt.requirements.claimed)}/${unavailable(receipt.requirements.clauses)} claimed (${receipt.requirements.status})`,
    `Checks: ${receipt.checks.passed} passed · ${receipt.checks.failed} failed · ${receipt.checks.unavailable} unavailable (${receipt.checks.status})`,
    `Approvals: ${receipt.approvals.current}/${receipt.approvals.required} (${receipt.approvals.status})`,
    `Context: ${receipt.context.status} · Review packet: ${receipt.reviewPacket.sha256.slice(0, 12)}`,
    `Publication: ${receipt.publication.state} · Next: ${receipt.nextHumanAction}`,
    `Receipt core hash: ${receipt.receiptCoreSha256 ?? receipt.receiptSha256}`,
    `Observation hash: ${receipt.observationSha256 ?? 'unavailable'}`
  ].join('\n');
}

export function renderEvidenceReceiptMarkdown(receipt) {
  const value = (entry) => entry == null ? 'unavailable' : String(entry);
  return [
    `# Evidence receipt — ${receipt.work.id}`,
    '',
    `- Phase: \`${receipt.work.phase}\` generation ${receipt.work.generation}`,
    `- Source commit: \`${receipt.source.commit}\``,
    `- Changed paths: **${value(receipt.changes.count)}** (${receipt.changes.status})`,
    `- Requirements claimed: **${value(receipt.requirements.claimed)}/${value(receipt.requirements.clauses)}** (${receipt.requirements.status})`,
    `- Checks: **${receipt.checks.passed} passed**, **${receipt.checks.failed} failed**, **${receipt.checks.unavailable} unavailable** (${receipt.checks.status})`,
    `- Approvals: **${receipt.approvals.current}/${receipt.approvals.required}** (${receipt.approvals.status})`,
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
