/**
 * Bounded reader for the clause text owned by a Story's specification artifacts.
 *
 * The specification artifact is the clause owner; this reader only locates the artifacts that the
 * Story's own phase records name, reads their exact bytes through the repository path guard, and
 * uses the existing `extractClauses` parser. It never searches the repository, follows a caller-
 * supplied path, or repairs a malformed artifact. An unreadable or malformed artifact is reported
 * with its own state so a missing clause is never mistaken for a clause that does not exist.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { extractClauses } from '../../specifications.mjs';
import { secureRepositoryPath } from '../../util.mjs';

export const XPL2_CLAUSE_SOURCE_LIMITS = Object.freeze({
  maximumArtifacts: 8,
  maximumArtifactBytes: 1024 * 1024,
  maximumClauses: 500
});

const ACTIVE_PHASE_STATES = new Set(['approved', 'awaiting_approval', 'in_progress']);

function specificationArtifacts(workflow) {
  const artifacts = [];
  for (const phaseId of workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {})) {
    const phase = workflow?.phases?.[phaseId];
    if (!phase || !ACTIVE_PHASE_STATES.has(phase.status)) continue;
    for (const artifact of phase.artifacts ?? []) {
      if (typeof artifact?.path !== 'string' || !artifact.path) continue;
      if (artifact.kind !== 'requirements' && !/specification|requirements/u.test(phaseId)) continue;
      if (artifacts.some((entry) => entry.path === artifact.path)) continue;
      artifacts.push({ path: artifact.path, phase: phaseId, phaseStatus: phase.status });
    }
  }
  return artifacts;
}

/**
 * Read the Story's specification artifacts once for one explanation snapshot.
 * Returns one record per artifact with `status`: read, inaccessible, too-large, invalid or omitted.
 */
export async function readStoryClauseSources(root, workflow) {
  if (!workflow) return { status: 'not-applicable', reason: 'no-active-story', artifacts: [] };
  const candidates = specificationArtifacts(workflow);
  const artifacts = [];
  let clauseCount = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (index >= XPL2_CLAUSE_SOURCE_LIMITS.maximumArtifacts) {
      artifacts.push({ ...candidate, status: 'omitted', reason: 'partial-inventory', digest: null, clauses: [] });
      continue;
    }
    let bytes;
    try {
      const secured = await secureRepositoryPath(root, candidate.path, {
        label: 'XPL2 specification source', mustExist: true, type: 'file'
      });
      bytes = await readFile(secured.absolute);
    } catch {
      artifacts.push({ ...candidate, status: 'inaccessible', reason: 'source-inaccessible', digest: null, clauses: [] });
      continue;
    }
    if (bytes.length > XPL2_CLAUSE_SOURCE_LIMITS.maximumArtifactBytes) {
      artifacts.push({ ...candidate, status: 'too-large', reason: 'bounded-delivery', digest: null, clauses: [] });
      continue;
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    let parsed;
    try {
      parsed = extractClauses(bytes.toString('utf8'), { sourcePath: candidate.path });
    } catch {
      artifacts.push({ ...candidate, status: 'invalid', reason: 'integrity-failed', digest, clauses: [] });
      continue;
    }
    const remaining = Math.max(0, XPL2_CLAUSE_SOURCE_LIMITS.maximumClauses - clauseCount);
    const clauses = parsed.slice(0, remaining).map((clause) => ({
      id: clause.id,
      type: clause.type,
      line: clause.source?.line ?? null,
      body: clause.body,
      bodySha256: clause.bodySha256
    }));
    clauseCount += clauses.length;
    artifacts.push({
      ...candidate,
      status: 'read',
      reason: parsed.length > clauses.length ? 'partial-inventory' : null,
      digest,
      clauses
    });
  }
  return {
    status: candidates.length ? 'available' : 'not-applicable',
    reason: candidates.length ? null : 'source-not-recorded',
    artifacts
  };
}
