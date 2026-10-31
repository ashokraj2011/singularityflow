/**
 * Names in the specification library (SPEC-SPA v1.3).
 *
 * A specification ID is also its clauses' namespace (`[SPEC-CHK-004:REQ-001]`), so it satisfies the
 * clause grammar's namespace rule, and the `SPEC-` prefix keeps it apart from Work IDs. A revision is
 * numbered 1, 2, 3… per specification and lives in a six-digit directory on the state branch.
 */
import { SingularityFlowError } from '../util.mjs';

export const SPEC_ID = /^SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
export const SPEC_ID_MAXIMUM = 64;
export const LIBRARY_ROOT = 'singularity/specifications';
export const REVISION_FILES = Object.freeze(['manifest.json', 'spec.md', 'gaps.json', 'research.json', 'quality.json']);
export const GAP_ID = /^GAP-\d{3,}$/u;
export const RESEARCH_ID = /^R-\d{3,}$/u;

export function validSpecId(value) {
  return typeof value === 'string' && value.length <= SPEC_ID_MAXIMUM && SPEC_ID.test(value);
}

export function requireSpecId(value, command = 'singularity-flow spec author list') {
  if (!validSpecId(value)) {
    throw new SingularityFlowError(`'${value ?? ''}' is not a specification ID. Use SPEC- followed by uppercase letters, digits and single hyphens, for example SPEC-CHK-004.`, {
      code: 'SPEC_ID_INVALID', details: { specId: value ?? null, nextAction: command }
    });
  }
  return value;
}

/** `SPEC-CHK-004` or `SPEC-CHK-004@3`. */
export function parseSpecReference(value) {
  const [specId, revisionText, ...rest] = String(value ?? '').split('@');
  requireSpecId(specId);
  if (rest.length || (revisionText !== undefined && !/^[1-9]\d{0,5}$/u.test(revisionText))) {
    throw new SingularityFlowError(`'${value}' is not a specification reference. Use SPEC-ID or SPEC-ID@N with a revision number.`, {
      code: 'SPEC_REFERENCE_INVALID', details: { reference: value, nextAction: `singularity-flow spec author list` }
    });
  }
  return { specId, revision: revisionText === undefined ? null : Number(revisionText) };
}

export const revisionName = (revision) => String(revision).padStart(6, '0');
export const revisionDirectory = (specId, revision) => `${LIBRARY_ROOT}/${specId}/${revisionName(revision)}`;
export const formatGapId = (number) => `GAP-${String(number).padStart(3, '0')}`;
export const formatResearchId = (number) => `R-${String(number).padStart(3, '0')}`;
export const nextNumber = (ids, prefix) => ids.reduce((highest, id) => Math.max(highest, Number(String(id).slice(prefix.length)) || 0), 0) + 1;
