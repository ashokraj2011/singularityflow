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
import { countedRecords } from './presence/counted.mjs';
import { classifySupportingChange, SUPPORTING_CHANGE_CLASSES } from './supporting-changes.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { SingularityFlowError, posix } from './util.mjs';

const MAX_CHANGES = 50;
export const MAX_PLAN_AMENDMENT_CHANGES = MAX_CHANGES;

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

/** The plan's rows, as a person chooses among them to account for a path. */
export function planRowsOf(planned) {
  return Object.entries(planned).slice(0, 40).map(([clauseId, claim]) => ({ clauseId,
    ...(claim.observableResult ? { result: String(claim.observableResult).slice(0, 120) } : {}),
    ...(claim.fulfillment === 'test-only' ? { testOnly: true } : {}) }));
}

function exactPath(value, label) {
  const candidate = posix(String(value ?? '').trim());
  if (!candidate || candidate.startsWith('/') || /^[a-z]:/iu.test(candidate) || candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || /[*?[\]{}\\]/u.test(candidate) || candidate.endsWith('/')) {
    throw new SingularityFlowError(`${label} must be one exact repository-relative file path.`, { code: 'PLAN_AMENDMENT_INVALID' });
  }
  return candidate;
}

/**
 * Validate and record one amendment. `plan` is the Story's merged planned claims, keyed by clause.
 * Each change is `{ kind: 'add-location', clauseId, path }` or `{ kind: 'add-supporting', path, class, reason }`.
 * `contentHashes` holds what each file held when this was decided, so a later change to that file is
 * a question again. It sits beside `changes`, which an appeal's decision binds exactly as it was reviewed.
 * A file that is not there yet has nothing to bind. `departures` names the departures it accepts.
 */
export function recordPlanAmendment(workflow, { changes = [], reason, actor, authorityGroup, identityAssurance = null, at, plan = {}, contentHashes = {}, departures = [] }) {
  if (!changes.length || changes.length > MAX_CHANGES) {
    throw new SingularityFlowError(`Name 1 to ${MAX_CHANGES} changes with --add-location <clause>=<path> or --add-supporting <path>=<class>.`, { code: 'PLAN_AMENDMENT_INVALID' });
  }
  const classification = classificationContext(workflow);
  const normalized = changes.map((change) => {
    if (change.kind === 'add-location') {
      const clauseId = String(change.clauseId ?? '').toUpperCase();
      const claim = plan[clauseId];
      if (!claim) {
        throw new SingularityFlowError(`The plan has no row for ${clauseId}; a plan amendment adds to an existing row. Its rows: ${Object.keys(plan).slice(0, 12).join(', ') || 'none'}.`, { code: 'PLAN_AMENDMENT_INVALID', details: { clauseId, rows: Object.keys(plan) } });
      }
      const candidate = exactPath(change.path, `The location for ${clauseId}`);
      if (claim.fulfillment === 'test-only' && !isTestAutomationPath(candidate, classification)) {
        throw new SingularityFlowError(`${clauseId} is test-only; only an exact test or test-support path can be accounted for without changing its delivery contract.`, { code: 'PLAN_AMENDMENT_INVALID', details: { clauseId } });
      }
      if ((claim.expectedPaths ?? []).includes(candidate)) {
        throw new SingularityFlowError(`${candidate} is already an expected path of ${clauseId}.`, { code: 'PLAN_AMENDMENT_INVALID' });
      }
      return { kind: 'add-location', clauseId, path: candidate };
    }
    if (change.kind === 'add-supporting') {
      const candidate = exactPath(change.path, 'A supporting change');
      const classified = classifySupportingChange(candidate, classification);
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
    changes: normalized, ...(Object.keys(contentHashes).length ? { contentHashes } : {}),
    // The departures this amendment accepts [CQF:REQ-025]: each is accepted while this record counts.
    ...(departures.length ? { departures: [...new Set(departures)].sort() } : {}),
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.planAmendments.push(amendment);
  return amendment;
}

// What a settled file may be listed as (out-of-plan-classes.mjs) [C3, 2026-11-19].
const SETTLED_SUPPORTING = new Set(['test-support', 'documentation', 'repository-metadata']);
// Who a file outside the plan is listed as changed by (code-outside-plan.mjs codeWriters).
const OUTSIDE_PLAN_WRITERS = Object.freeze(['copilot', 'person', 'base']);

/** Settlements none undid, read without loading settled-decisions.mjs. */
function standingSettlements(workflow) {
  const list = countedRecords(workflow, workflow?.settledDecisions, (entry) => Boolean(entry?.undoes));
  const undone = new Set(list.map((entry) => entry.undoes));
  return list.filter((entry) => !entry.undoes && !undone.has(entry.id));
}

/** Plan changes SFlow settled and nobody undid, as settled-decisions.mjs reads them, without loading it [owner, 2026-11-13]. */
export function settledPlanChanges(workflow) {
  return standingSettlements(workflow).flatMap(({ kind, effect: e = {}, answer, at }) => (
    kind === 'plan-accounting' && e.path ? [{ kind: 'add-location', clauseId: e.clauseId, path: e.path, at }]
      : kind === 'plan-accounting' && e.file && SETTLED_SUPPORTING.has(e.class) ? [{ kind: 'add-supporting', path: e.file, class: e.class, reason: String(answer).slice(0, 500), at }]
        : kind === 'node-version' && e.file ? [{ kind: 'add-supporting', path: e.file, class: e.class, reason: String(answer).slice(0, 500), at }] : []));
}

/** The files this Story's standing settlements class as test support beyond their path, for every reader (source-boundary.mjs) [C3]. */
export function classificationContext(workflow) {
  const testSupportPaths = new Set(standingSettlements(workflow).filter((entry) => entry.kind === 'plan-accounting' && entry.effect?.file
    && entry.effect.class === 'test-support' && entry.effect.rule).map((entry) => entry.effect.file));
  return testSupportPaths.size ? { testSupportPaths } : null;
}

/**
 * Every amendment as one more planned record, merged by the plan's readers: added locations are
 * accounted paths of their row, supporting changes join the plan's list. It claims nothing new, so
 * no row's implementation is judged differently. Null when the plan was never amended.
 */
export function planAmendmentRecord(workflow) {
  const amendments = countedRecords(workflow, workflow?.planAmendments);
  const settled = settledPlanChanges(workflow);
  if (!amendments.length && !settled.length) return null;
  const accountedPaths = {};
  const supportingFileDetails = [];
  for (const change of [...amendments.flatMap((amendment) => amendment.changes ?? []), ...settled]) {
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
    generation: Number(workflow.phases?.[owner]?.generation ?? 0), recordedAt: settled.length ? [...amendments, ...settled].map((entry) => entry.at).sort().at(-1) : amendments.at(-1).at,
    claims: {}, accountedPaths,
    ...(supportingFileDetails.length ? { supportingFiles: supportingFileDetails.map((entry) => entry.path), supportingFileDetails } : {})
  };
}

/**
 * The files a code step's departures carry into its candidate [CQF:REQ-022]: a file or supporting one's,
 * unless replaced or rejected; `phaseId` null for every step's. Beside the plan's own paths, which every
 * reader of these reads too (departures.mjs has the rest).
 */
export function departureCandidatePaths(workflow, phaseId = null) {
  const departures = workflow?.departures ?? [];
  if (!departures.length) return [];
  const superseded = new Set(departures.map((entry) => entry.supersedes).filter(Boolean));
  const rejected = new Set(countedRecords(workflow, workflow.departureDecisions).filter((entry) => entry.decision === 'rejected').flatMap((entry) => entry.departures ?? []));
  return [...new Set(departures.filter((entry) => (!phaseId || entry.phase === phaseId) && ['path', 'supporting', 'finding'].includes(entry.kind)
    && !superseded.has(entry.id) && !rejected.has(entry.id)).flatMap((entry) => entry.paths ?? []))].sort();
}

/**
 * The files SFlow took up with a code step because they changed outside the plan, as nobody undid them [WCB:REQ-010]:
 * each `{ id, file, writer, basis, reason, kind, supporting, branch, at }`, newest last; `phaseId` null for every step's. The
 * `out-of-plan` settlements, and the supporting changes (a person's scratch note, a test helper) whose settlement says who
 * changed them (`supporting` names the class) [owner, 2026-11-28: a scratch note is committed, listed "by you"]. `writer` is
 * `copilot`, `person`, or `base` for a file that holds what the base branch has, merged in (`branch` names it). An
 * `out-of-plan` one is read beside the plan, never merged into it: `settledPlanChanges` leaves it out, so no plan record
 * or hash built from one changes.
 */
export function outsidePlanSettled(workflow, phaseId = null) {
  return standingSettlements(workflow).filter((entry) => entry.kind === 'plan-accounting' && entry.effect?.file
    && (entry.effect.class === 'out-of-plan' || (SETTLED_SUPPORTING.has(entry.effect.class) && OUTSIDE_PLAN_WRITERS.includes(entry.effect.writer)))
    && (!phaseId || entry.phase === phaseId))
    .map(({ id, phase, at, effect }) => ({ id, phase: phase ?? null, file: effect.file,
      writer: OUTSIDE_PLAN_WRITERS.includes(effect.writer) ? effect.writer : 'person',
      basis: effect.basis ?? null, reason: effect.reason ?? null, kind: effect.kind ?? null,
      supporting: effect.class === 'out-of-plan' ? null : effect.class, ...(effect.writer === 'base' ? { branch: effect.branch ?? null } : {}), at }));
}

/**
 * Who changed a file outside the plan, in the words every place shows it [WCB:REQ-014]: "by Copilot: <reason>" (through a
 * terminal command when that is what SFlow's hooks saw), "by you" (and why no hook could tell, for a folder VS Code opened
 * through a link), or, for a file that holds what the base branch has, "from <branch>, merged in: not changed in this
 * Story". A supporting change adds ", as a supporting change".
 */
export function outsidePlanWho({ writer, reason = null, basis = null, branch = null, supporting = null } = {}) {
  if (writer === 'base') return `from ${branch ?? 'the base branch'}, merged in: not changed in this Story`;
  const as = supporting ? ', as a supporting change' : '';
  if (writer === 'copilot') {
    const how = basis === 'shell-write' || basis === 'shell-call' ? ', through a terminal command' : '';
    return `by Copilot${how}${reason ? `: ${reason}` : supporting ? '' : ': no reason written'}${as}`;
  }
  return `by you${basis === 'linked-folder' ? ' (no SFlow hooks ran here: VS Code opened this folder through a link)' : ''}${as}`;
}

/** Every path an amendment accounted for, across the planned records given. */
export function accountedAmendmentPaths(planned = []) {
  return [...new Set(planned.filter((record) => record?.amendment)
    .flatMap((record) => Object.values(record.accountedPaths ?? {}).flat()))].sort();
}
