/**
 * Which Stories claim and deliver a specification's clauses (SPEC-SPA v1.3 §6.4).
 *
 * Once a Story's first step is approved, its claim on each sliced clause is one immutable record per
 * approved generation, `singularity/specifications/<SPEC-ID>/usage/<WORK-ID>/<NNNNNN>.json`. Closing
 * the Story adds `delivered.json`, citing the completion its final check recorded. A record is built
 * only from the Story's own committed state, so writing it again (repair) produces the same bytes.
 *
 * Records are written after the approval has landed, never inside it. Paths are disjoint per Story,
 * so two Stories never write the same file; they share the state branch, and a lost race is retried.
 * A failed write never blocks the Story: `spec author coverage SPEC-ID@N --repair --story WORK-ID`
 * writes what is missing from the Story's committed approval and closure.
 *
 * Coverage reads every record at one pinned state commit: per clause, the Stories that delivered it,
 * the Stories that claim it, or uncovered. An unreadable state branch is unavailable, never uncovered.
 */
import { createHash } from 'node:crypto';

import { committedFileBytes, committedTreePaths } from '../git.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { extractClauses } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';
import { LIBRARY_ROOT, revisionName } from './ids.mjs';
import { libraryView } from './library.mjs';
import { droppedSliceClauses, sliceClauseId } from './slice.mjs';

export const USAGE_FAMILY = 'spec-usage';
const PUBLISH_ATTEMPTS = 3;

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

export const usageDirectory = (specId) => `${LIBRARY_ROOT}/${specId}/usage`;

/** `SPEC-X@3` → `{ specId, revision }`. */
function revisionOf(slice) {
  const [specId, number] = String(slice?.revision ?? '').split('@');
  return { specId, revision: Number(number) };
}

/** The latest standing approval of the Story's first step, or null. */
export function firstStepApproval(workflow) {
  const first = workflow?.phases?.[workflow?.phaseOrder?.[0]];
  return [...(first?.approvals ?? [])].reverse()
    .find((entry) => !entry.invalidatedAt && (entry.decision ?? 'approved') === 'approved') ?? null;
}

/** The exact usage records a Story's committed state proves, one per attached specification and kind. */
export function usageRecords(workflow, source) {
  const slices = Array.isArray(source?.specification) ? source.specification : [];
  const approval = firstStepApproval(workflow);
  if (!slices.length || !approval) return [];
  const workId = workflow.workItem.id;
  const first = workflow.phaseOrder[0];
  const completion = workflow.status === 'closed' && workflow.completion?.evaluatedAt ? workflow.completion : null;
  const records = [];
  for (const slice of slices) {
    const { specId, revision } = revisionOf(slice);
    const dropped = droppedSliceClauses(workflow, slice);
    const common = {
      schemaVersion: currentSchemaVersion(USAGE_FAMILY), specId, revision, manifestSha256: slice.manifestSha256 ?? null,
      workId, clauses: (slice.clauses ?? []).map(sliceClauseId).filter((id) => !dropped.includes(id)), dropped
    };
    const generation = Number(approval.generation ?? 0);
    records.push({
      path: `${usageDirectory(specId)}/${workId}/${revisionName(generation)}.json`,
      record: { ...common, kind: 'claimed', generation, receipt: {
        phase: first, generation, approvedAt: approval.at ?? null, authorityGroup: approval.authorityGroup ?? null,
        reviewPacketSha256: approval.reviewPacketSha256 ?? null
      } }
    });
    if (completion) {
      records.push({
        path: `${usageDirectory(specId)}/${workId}/delivered.json`,
        record: { ...common, kind: 'delivered', generation, receipt: {
          label: completion.label ?? null, kind: completion.kind ?? null, inputSha256: completion.inputSha256 ?? null,
          assuranceFloor: completion.assuranceFloor ?? null, evaluatedAt: completion.evaluatedAt
        } }
      });
    }
  }
  return records.map((entry) => ({ ...entry, bytes: Buffer.from(canonicalJson(entry.record), 'utf8') }));
}

/**
 * Write the records the state branch does not hold yet. A record already there with the same bytes is
 * left as it is; one there with different bytes is reported and never overwritten.
 */
export async function publishUsage(root, config, records, { env = process.env } = {}) {
  if (!records.length) return { written: [], present: [], differing: [] };
  const { publishToStateBranch } = await import('../ledger.mjs');
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    const view = await libraryView(root, config, { env });
    const present = [];
    const differing = [];
    const missing = [];
    for (const entry of records) {
      const existing = view.commit ? committedFileBytes(root, view.commit, entry.path, { env }) : null;
      if (!existing) missing.push(entry);
      else if (Buffer.compare(existing, entry.bytes) === 0) present.push(entry.path);
      else differing.push(entry.path);
    }
    if (!missing.length) return { written: [], present, differing, commit: view.commit };
    const files = Object.fromEntries(missing.map((entry) => [entry.path, entry.bytes]));
    const workIds = [...new Set(missing.map((entry) => entry.record.workId))].join(', ');
    try {
      const published = await publishToStateBranch(root, view.ledger, files, `[${workIds}][spec:usage] ${missing.map((entry) => `${entry.record.specId}@${entry.record.revision} ${entry.record.kind}`).join(', ')}`, {
        exactBlobSha256: Object.fromEntries(missing.map((entry) => [entry.path, digest(entry.bytes)])),
        pathPreconditions: Object.fromEntries(missing.map((entry) => [entry.path, { condition: 'absent' }])),
        env
      });
      return { written: missing.map((entry) => entry.path), present, differing, commit: published.commit };
    } catch (error) {
      if (error?.concurrent || error?.code === 'state_branch.path_precondition_failed') continue;
      throw error;
    }
  }
  fail(`Other publications kept moving the ${config?.ledger?.branch ?? 'state'} branch; the usage records were not written after ${PUBLISH_ATTEMPTS} attempts.`, 'SPEC_LIBRARY_BUSY',
    { nextAction: 'singularity-flow spec author list' });
}

/** The repair command for a Story's records of one attached specification. */
export function repairCommand(slice, workId) {
  return `singularity-flow spec author coverage ${slice.revision} --repair --story ${workId}`;
}

/** Every usage record of one revision at the pinned commit, and the files that could not be read. */
export function readUsage(root, view, specId, revision, { env = process.env } = {}) {
  const records = [];
  const unreadable = [];
  if (!view.commit) return { records, unreadable };
  for (const file of committedTreePaths(root, view.commit, [usageDirectory(specId)], { env })) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = readRecord(USAGE_FAMILY, committedFileBytes(root, view.commit, file, { env })).record;
      if (record.specId === specId && record.revision === revision) records.push(record);
    } catch (error) {
      if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error;
      unreadable.push(file);
    }
  }
  return { records, unreadable };
}

/** Per clause of a read revision: delivered, claimed or uncovered, with the Stories behind each. */
export function coverageOf(revision, records) {
  const latest = new Map();
  for (const record of records.filter((entry) => entry.kind === 'claimed')) {
    const prior = latest.get(record.workId);
    if (!prior || record.generation > prior.generation) latest.set(record.workId, record);
  }
  const delivered = records.filter((entry) => entry.kind === 'delivered');
  return extractClauses(revision.spec, { namespace: revision.specId }).map((clause) => {
    const by = (list) => [...new Set(list.filter((record) => record.clauses.includes(clause.id)).map((record) => record.workId))].sort();
    const deliveredBy = by(delivered);
    const claimedBy = by([...latest.values()]).filter((workId) => !deliveredBy.includes(workId));
    return { clause: clause.id, status: deliveredBy.length ? 'delivered' : claimedBy.length ? 'claimed' : 'uncovered',
      deliveredBy, claimedBy, allocatedTo: [] };
  });
}
