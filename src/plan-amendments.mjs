/**
 * Narrow plan amendments [E2G-012].
 *
 * A delivered change to a path no plan row names is accounted for, not deleted and not silently
 * exempted: someone in the group that approves the plan records an amendment that adds the path
 * to one obligation's expected paths, or lists it as a supporting change of a closed class with its
 * reason. An added location accounts for a changed path as part of that row's delivery; it does not
 * oblige the row to change it again. Amendments are append-only records on the Story; every reader
 * of the plan merges them as one more planned record, so the plan's revision changes without
 * resetting any step. Pure.
 */
import { stepResponsibilities } from './phase-roles.mjs';
import { classifySupportingChange, SUPPORTING_CHANGE_CLASSES } from './supporting-changes.mjs';
import { SingularityFlowError, posix } from './util.mjs';

const MAX_CHANGES = 50;

/** Who may amend the plan: the approval groups of the steps that hold the plan and of the planned-claim owners. */
export function planAuthorities(workflow) {
  const groups = new Set();
  const owners = new Set(Object.values(workflow?.resolution?.plannedClaims?.owners ?? {}));
  for (const id of workflow?.phaseOrder ?? []) {
    if (!owners.has(id) && !stepResponsibilities(workflow, id).includes('plan')) continue;
    const policy = workflow.phases?.[id]?.approvalPolicy ?? {};
    for (const group of [...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])]) groups.add(group);
  }
  return [...groups].sort();
}

function exactPath(value, label) {
  const candidate = posix(String(value ?? '').trim());
  if (!candidate || candidate.startsWith('/') || candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || /[*?[\]{}\\]/u.test(candidate) || candidate.endsWith('/')) {
    throw new SingularityFlowError(`${label} must be one exact repository-relative file path.`, { code: 'PLAN_AMENDMENT_INVALID' });
  }
  return candidate;
}

/**
 * Validate and record one amendment. `plan` is the Story's merged planned claims, keyed by clause.
 * Each change is `{ kind: 'add-location', clauseId, path }` or `{ kind: 'add-supporting', path, class, reason }`.
 */
export function recordPlanAmendment(workflow, { changes = [], reason, actor, authorityGroup, identityAssurance = null, at, plan = {} }) {
  if (!changes.length || changes.length > MAX_CHANGES) {
    throw new SingularityFlowError(`Name 1 to ${MAX_CHANGES} changes with --add-location <clause>=<path> or --add-supporting <path>=<class>.`, { code: 'PLAN_AMENDMENT_INVALID' });
  }
  const normalized = changes.map((change) => {
    if (change.kind === 'add-location') {
      const clauseId = String(change.clauseId ?? '').toUpperCase();
      const claim = plan[clauseId];
      if (!claim) {
        throw new SingularityFlowError(`The plan has no row for ${clauseId}; a plan amendment adds to an existing row.`, { code: 'PLAN_AMENDMENT_INVALID', details: { clauseId } });
      }
      if (claim.fulfillment === 'test-only') {
        throw new SingularityFlowError(`${clauseId} is test-only, so it has no product paths to add to.`, { code: 'PLAN_AMENDMENT_INVALID', details: { clauseId } });
      }
      const candidate = exactPath(change.path, `The location for ${clauseId}`);
      if ((claim.expectedPaths ?? []).includes(candidate)) {
        throw new SingularityFlowError(`${candidate} is already an expected path of ${clauseId}.`, { code: 'PLAN_AMENDMENT_INVALID' });
      }
      return { kind: 'add-location', clauseId, path: candidate };
    }
    if (change.kind === 'add-supporting') {
      const candidate = exactPath(change.path, 'A supporting change');
      const classified = classifySupportingChange(candidate);
      if (classified.refused) {
        throw new SingularityFlowError(`${candidate} cannot be a supporting change: ${classified.reason}. Add it to a row with --add-location instead.`, {
          code: 'PLAN_AMENDMENT_SUPPORTING_REFUSED', details: { path: candidate, refused: classified.refused }
        });
      }
      if (!SUPPORTING_CHANGE_CLASSES.includes(change.class) || change.class !== classified.class) {
        throw new SingularityFlowError(`${candidate} is ${classified.class}; name that class with --add-supporting ${candidate}=${classified.class}.`, {
          code: 'PLAN_AMENDMENT_INVALID', details: { path: candidate, class: classified.class }
        });
      }
      const why = String(change.reason ?? '').trim();
      if (why.length < 10 || why.length > 500) {
        throw new SingularityFlowError(`Say why ${candidate} changes in 10 to 500 characters with --supporting-reason.`, { code: 'PLAN_AMENDMENT_INVALID' });
      }
      return { kind: 'add-supporting', path: candidate, class: classified.class, reason: why };
    }
    throw new SingularityFlowError('A plan amendment adds a location or a supporting change.', { code: 'PLAN_AMENDMENT_INVALID' });
  });
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why the plan changes in 20 to 1000 characters with --reason.', { code: 'PLAN_AMENDMENT_REASON_REQUIRED' });
  }
  workflow.planAmendments ??= [];
  const amendment = {
    id: `PAM-${String(workflow.planAmendments.length + 1).padStart(3, '0')}`,
    changes: normalized, reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.planAmendments.push(amendment);
  return amendment;
}

/**
 * Every amendment as one more planned record, merged by the plan's readers: added locations are
 * accounted paths of their row, supporting changes join the plan's list. It claims nothing new, so
 * no row's implementation is judged differently. Null when the plan was never amended.
 */
export function planAmendmentRecord(workflow) {
  const amendments = workflow?.planAmendments ?? [];
  if (!amendments.length) return null;
  const accountedPaths = {};
  const supportingFileDetails = [];
  for (const change of amendments.flatMap((amendment) => amendment.changes ?? [])) {
    if (change.kind === 'add-location') {
      accountedPaths[change.clauseId] = [...new Set([...(accountedPaths[change.clauseId] ?? []), change.path])].sort();
    } else if (change.kind === 'add-supporting' && !supportingFileDetails.some((entry) => entry.path === change.path)) {
      supportingFileDetails.push({ path: change.path, class: change.class, reason: change.reason });
    }
  }
  // Evidence corrections are applied to their exact owner's record by the shared plan reader,
  // not merged as extra obligations (which would leave the wrong source obligation in force).
  if (!Object.keys(accountedPaths).length && !supportingFileDetails.length) return null;
  supportingFileDetails.sort((left, right) => left.path.localeCompare(right.path));
  const owners = Object.values(workflow.resolution?.plannedClaims?.owners ?? {});
  const owner = owners[0] ?? workflow.phaseOrder?.find((id) => stepResponsibilities(workflow, id).includes('plan')) ?? null;
  return {
    kind: 'planned', amendment: true, workId: workflow.workItem?.id ?? null, phase: owner,
    generation: Number(workflow.phases?.[owner]?.generation ?? 0), recordedAt: amendments.at(-1).at,
    claims: {}, accountedPaths,
    ...(supportingFileDetails.length ? { supportingFiles: supportingFileDetails.map((entry) => entry.path), supportingFileDetails } : {})
  };
}

/** Every path an amendment accounted for, across the planned records given. */
export function accountedAmendmentPaths(planned = []) {
  return [...new Set(planned.filter((record) => record?.amendment)
    .flatMap((record) => Object.values(record.accountedPaths ?? {}).flat()))].sort();
}
