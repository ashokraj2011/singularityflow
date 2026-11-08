/**
 * Departures from the approved documents in a code step [CQF:REQ-020 to REQ-029].
 *
 * /sf-code edits what the change needs. Whatever that departs from (a file no row of the plan names, a
 * supporting file, a plan row, a planned test, an earlier document's wording or a clause) is one
 * append-only record, `DEP-NNN`, written by the model through `departure record` or by SFlow itself at
 * prepublish. Recording one asks nobody and refuses nothing: publish goes ahead with its files, and the
 * step's approval waits until a person decides each one in one table. Accepting writes the record that
 * already exists for that kind (a plan amendment, a plan row correction, a forward amendment or an intent
 * amendment), under its own authority; rejecting is its own record, and the model reverts the change.
 *
 * A `finding` departure is a fix for findings register items made on the way [CQF:REQ-066]: its files
 * may be ones the plan already names, so nothing in the plan changes. A person's acceptance is its own
 * record, beside the rejection, under the plan's authority; a rejected one is reverted once each file
 * is back to what it held when the generation began, or no longer what it held when it was rejected.
 *
 * Status is read, never stored: a departure is accepted while a counted record that names it stands and
 * its files still hold what was accepted (a later edit reopens only that row, the plan amendment hash
 * rule), rejected until each file is back to what it held when the generation began, and open otherwise.
 * Pure: hashes arrive from the caller (departure-records.mjs).
 */
import { departureCandidatePaths } from './plan-amendments.mjs';
import { countedRecords, isWithdrawn } from './presence/counted.mjs';
import { SingularityFlowError, posix } from './util.mjs';

export const DEPARTURE_KINDS = Object.freeze(['path', 'supporting', 'plan-row', 'test', 'wording', 'clause', 'finding']);
/** What each kind's acceptance writes, the record that already exists for it [CQF:REQ-025]; a fix on the way, its own. */
export const DEPARTURE_RECORDS = Object.freeze({ path: 'plan-amendment', supporting: 'plan-amendment', 'plan-row': 'plan-row-correction',
  test: 'plan-row-correction', wording: 'forward-amendment', clause: 'intent-amendment', finding: 'departure-acceptance' });
export const MAX_DEPARTURE_FINDINGS = 20;
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,79}$/u;
export const MAX_DEPARTURE_PATHS = 20;
export const MAX_DEPARTURE_DIFF = 64 * 1024;
export const DEPARTURE_REASON = Object.freeze({ minimum: 20, maximum: 1000 });
// A plan row correction a departure may ask for. Removing a planned test is never one [CQF:REQ-029].
export const DEPARTURE_ROW_OPERATIONS = Object.freeze({ 'plan-row': ['add-row', 'set-fulfillment', 'remove-location', 'replace-location'],
  test: ['add-test', 'replace-test'] });
// Statuses that hold the code step's approval: undecided, edited since accepted, or rejected and not yet reverted.
const HOLDING = new Set(['open', 'reopened', 'rejected']);
// The kinds whose own files the candidate carries, and which a rejection restores.
const FILE_KINDS = new Set(['path', 'supporting', 'finding']);

export function departureRefusal(message, code = 'DEPARTURE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function exactPath(value) {
  const candidate = posix(String(value ?? '').trim());
  if (!candidate || candidate.startsWith('/') || /^[a-z]:/iu.test(candidate) || candidate.endsWith('/')
      || candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..') || /[*?[\]{}\\\0]/u.test(candidate)) {
    departureRefusal(`'${String(value ?? '').slice(0, 200)}' is not one exact repository-relative file path.`);
  }
  return candidate;
}

/** The next ID, counting every departure ever recorded on the Story: IDs are never reused. */
export function nextDepartureId(workflow) {
  return `DEP-${String((workflow?.departures ?? []).length + 1).padStart(3, '0')}`;
}

/**
 * "Accept all" covers files, supporting files and wording that touches no clause [owner decision 14],
 * and a fix on the way, which changes files and no clause. Everything else is decided one by one,
 * each with its own reason.
 */
export function acceptAllEligible(departure) {
  return ['path', 'supporting', 'finding'].includes(departure?.kind) || (departure?.kind === 'wording' && !(departure.clauses ?? []).length);
}

/**
 * Append one departure. `paths` are the files it changes; `contentHashes` what each holds now and
 * `baseHashes` what each held when the generation began (null: the file did not exist), so a rejected one
 * can be seen reverted. Each kind names what it departs from: a supporting class, a plan row change, or an
 * earlier document (`target`) with the diff. Returns the record.
 */
export function recordDeparture(workflow, {
  kind, phase, generation, paths = [], contentHashes = {}, baseHashes = {}, target = null, diff = null, clauses = [],
  supportingClass = null, change = null, proposal = null, reason, findings = [], recordedBy = 'agent', actor = null, agent = null,
  supersedes = null, at
}) {
  if (!DEPARTURE_KINDS.includes(kind)) departureRefusal(`A departure's kind is one of ${DEPARTURE_KINDS.join(', ')}; got '${String(kind).slice(0, 40)}'.`);
  const files = [...new Set((paths ?? []).map(exactPath))].sort();
  if (files.length > MAX_DEPARTURE_PATHS) departureRefusal(`Name at most ${MAX_DEPARTURE_PATHS} files in one departure; record the rest as their own.`);
  if (FILE_KINDS.has(kind) && !files.length) departureRefusal(`A ${kind} departure names the file it changes with --path.`);
  const fixes = [...new Set((findings ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (fixes.some((id) => !FINDING_ID.test(id)) || fixes.length > MAX_DEPARTURE_FINDINGS) {
    departureRefusal(`Name at most ${MAX_DEPARTURE_FINDINGS} findings register items with --finding, each by its ID.`);
  }
  if (kind === 'finding' && !fixes.length) departureRefusal('A finding departure names the findings register item it fixes with --finding.');
  if (['wording', 'clause'].includes(kind) && !target?.phase) departureRefusal(`A ${kind} departure names the earlier step it departs from with --target.`);
  if (['plan-row', 'test'].includes(kind) && !DEPARTURE_ROW_OPERATIONS[kind].includes(change?.op)) {
    departureRefusal(`A ${kind} departure names one plan row change: ${DEPARTURE_ROW_OPERATIONS[kind].join(', ')}.${kind === 'test' ? ' Removing or loosening a planned test is never a departure.' : ''}`,
      kind === 'test' && change?.op === 'remove-test' ? 'DEPARTURE_NOT_ALLOWED' : 'DEPARTURE_INVALID');
  }
  if (diff != null && Buffer.byteLength(String(diff)) > MAX_DEPARTURE_DIFF) departureRefusal(`The diff is over ${MAX_DEPARTURE_DIFF / 1024} KiB; split the departure.`, 'DEPARTURE_TOO_LARGE');
  const text = String(reason ?? '').trim();
  if (text.length < DEPARTURE_REASON.minimum || text.length > DEPARTURE_REASON.maximum) {
    departureRefusal(`Say why the change departs from the approved documents in ${DEPARTURE_REASON.minimum} to ${DEPARTURE_REASON.maximum} characters with --reason.`, 'DEPARTURE_REASON_REQUIRED');
  }
  if (supersedes && !(workflow.departures ?? []).some((entry) => entry.id === supersedes)) departureRefusal(`${supersedes} is not a departure of this Story.`);
  workflow.departures ??= [];
  const record = {
    id: nextDepartureId(workflow), kind, phase, generation: Number(generation), paths: files,
    contentHashes: Object.fromEntries(files.map((file) => [file, contentHashes[file] ?? null])),
    baseHashes: Object.fromEntries(files.map((file) => [file, baseHashes[file] ?? null])),
    target: target ? { phase: target.phase, generation: Number(target.generation ?? 0), sha256: target.sha256 ?? null, path: target.path ?? null } : null,
    diff: diff == null ? null : String(diff), clauses: [...new Set((clauses ?? []).map((clause) => String(clause).toUpperCase()))].sort(),
    ...(supportingClass ? { class: supportingClass } : {}), ...(change ? { change } : {}), ...(proposal ? { proposal } : {}),
    reason: text, findings: fixes, recordedBy, author: { producer: 'governed-agent', actor, agent }, supersedes: supersedes ?? null, at
  };
  workflow.departures.push(record);
  return record;
}

/**
 * A person's rejection of one or more departures: its own append-only record [CQF:REQ-026]. `hashes` is
 * what a fix on the way's files held when it was rejected, so its revert can be seen.
 */
export function recordDepartureRejection(workflow, { departures, reason, actor, authorityGroup, identityAssurance = null, hashes = null, at }) {
  return departureDecision(workflow, 'rejected', { departures, reason, actor, authorityGroup, identityAssurance, hashes, at });
}

/** A person's acceptance of fixes on the way: their own record, binding what each file holds [CQF:REQ-066, REQ-028]. */
export function recordDepartureAcceptance(workflow, { departures, reason, actor, authorityGroup, identityAssurance = null, hashes, at }) {
  return departureDecision(workflow, 'accepted', { departures, reason, actor, authorityGroup, identityAssurance, hashes, at });
}

function departureDecision(workflow, decision, { departures, reason, actor, authorityGroup, identityAssurance, hashes, at }) {
  const text = String(reason ?? '').trim();
  if (text.length < DEPARTURE_REASON.minimum || text.length > DEPARTURE_REASON.maximum) {
    departureRefusal(`Say why in ${DEPARTURE_REASON.minimum} to ${DEPARTURE_REASON.maximum} characters with --reason.`, 'DEPARTURE_REASON_REQUIRED');
  }
  workflow.departureDecisions ??= [];
  const record = { id: `DDC-${String(workflow.departureDecisions.length + 1).padStart(3, '0')}`, departures: [...departures].sort(), decision,
    reason: text, actor, authorityGroup, identityAssurance, ...(hashes ? { hashes } : {}), at };
  workflow.departureDecisions.push(record);
  return record;
}

// The same plan row change, whatever the row's digest was when it was asked for.
const sameOperation = (left, right) => {
  const strip = ({ previousClaimSha256, ...rest } = {}) => JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]));
  return strip(left) === strip(right);
};

/**
 * The counted record that accepted a departure, or null: a decided plan amendment naming it, the approved
 * forward amendment proposed from it, a plan row correction asking for its exact change since it was
 * recorded, or the approved intent amendment proposed from it. `hashes` is what that record bound for each file.
 */
export function departureAcceptance(workflow, departure) {
  if (['path', 'supporting'].includes(departure.kind)) {
    const amendment = countedRecords(workflow, workflow?.planAmendments)
      .filter((entry) => (entry.departures ?? []).includes(departure.id) && !isWithdrawn(workflow, entry)).at(-1);
    return amendment ? { kind: 'plan-amendment', id: amendment.id, at: amendment.at, hashes: amendment.contentHashes ?? {} } : null;
  }
  if (departure.kind === 'wording') {
    const proposal = (workflow?.forwardAmendments ?? []).findLast((entry) => entry.departure === departure.id);
    const decision = proposal ? countedRecords(workflow, workflow?.forwardAmendmentDecisions).findLast((entry) => entry.amendment === proposal.id) : null;
    return decision?.decision === 'approved' ? { kind: 'forward-amendment', id: proposal.id, at: decision.at, hashes: null } : null;
  }
  if (departure.kind === 'clause') {
    const amendment = (workflow?.intentAmendments ?? []).findLast((entry) => entry.departure === departure.id && entry.status === 'approved');
    return amendment ? { kind: 'intent-amendment', id: amendment.id, at: amendment.decision?.at ?? amendment.at ?? null, hashes: null } : null;
  }
  if (departure.kind === 'finding') {
    const accepted = countedRecords(workflow, workflow?.departureDecisions)
      .filter((entry) => entry.decision === 'accepted' && (entry.departures ?? []).includes(departure.id)).at(-1);
    return accepted ? { kind: 'departure-acceptance', id: accepted.id, at: accepted.at, hashes: accepted.hashes ?? {} } : null;
  }
  const correction = countedRecords(workflow, workflow?.planRowCorrections)
    .filter((entry) => String(entry.at) >= String(departure.at) && (entry.operations ?? []).some((operation) => sameOperation(operation, departure.change))).at(-1);
  return correction ? { kind: 'plan-row-correction', id: correction.id, at: correction.at, hashes: null } : null;
}

/** The latest counted rejection of a departure, or null. */
export function departureRejection(workflow, departure) {
  return countedRecords(workflow, workflow?.departureDecisions)
    .filter((entry) => entry.decision === 'rejected' && (entry.departures ?? []).includes(departure.id)).at(-1) ?? null;
}

/**
 * Where a departure stands, with `hashes` of what each of its files holds now (null: absent; a file not
 * read is left out and compares as unchanged):
 *   superseded  a later departure replaced it
 *   open        nobody has decided it
 *   accepted    a counted record accepted it and its files still hold what was accepted
 *   reopened    accepted, then a file changed [CQF:REQ-028]
 *   rejected    rejected and not reverted yet
 *   reverted    rejected and every file is back to what it held when the generation began
 *   declined    a rejected row, test, wording or clause: the approved document stays as it was
 */
export function departureStatus(workflow, departure, hashes = {}) {
  if ((workflow?.departures ?? []).some((entry) => entry.supersedes === departure.id)) return { status: 'superseded', acceptance: null, rejection: null };
  const acceptance = departureAcceptance(workflow, departure);
  const rejection = departureRejection(workflow, departure);
  const now = (file) => (Object.hasOwn(hashes, file) ? hashes[file] : undefined);
  if (rejection && (!acceptance || String(rejection.at) >= String(acceptance.at))) {
    // Only a file has bytes to restore; a rejected row, test or wording leaves the approved document as it was.
    if (!FILE_KINDS.has(departure.kind)) return { status: 'declined', acceptance: null, rejection };
    // A fix on the way may share its file with planned work: taking the fix out changes what the file held when it was rejected.
    const fixOut = (file) => departure.kind === 'finding' && Object.hasOwn(rejection.hashes ?? {}, file) && now(file) !== rejection.hashes[file];
    const back = departure.paths.every((file) => now(file) === undefined ? false : now(file) === (departure.baseHashes?.[file] ?? null) || fixOut(file));
    return { status: back ? 'reverted' : 'rejected', acceptance: null, rejection };
  }
  if (acceptance) {
    const bound = acceptance.hashes;
    const changed = bound ? departure.paths.filter((file) => now(file) !== undefined && Object.hasOwn(bound, file) && bound[file] !== now(file)) : [];
    return changed.length ? { status: 'reopened', acceptance, rejection: null, changed } : { status: 'accepted', acceptance, rejection: null };
  }
  return { status: 'open', acceptance: null, rejection: null };
}

/** Whether a departure holds the code step's approval [CQF:REQ-023]. */
export const departureHolds = (status) => HOLDING.has(status);

/** Every departure of a step with its status, newest last; `phaseId` null for every step. */
export function departuresWithStatus(workflow, { phaseId = null, hashes = {} } = {}) {
  return (workflow?.departures ?? []).filter((entry) => !phaseId || entry.phase === phaseId)
    .map((departure) => ({ departure, ...departureStatus(workflow, departure, hashes) }));
}

/** The files a step's candidate includes because of its departures, kept beside the plan's own (plan-amendments.mjs). */
export { departureCandidatePaths };

/** The files of a step's rejected departures, with the departure that rejected each. */
export function rejectedDeparturePaths(workflow, phaseId) {
  const superseded = new Set((workflow?.departures ?? []).map((entry) => entry.supersedes).filter(Boolean));
  const rejected = new Map();
  for (const entry of workflow?.departures ?? []) {
    if (entry.phase !== phaseId || !FILE_KINDS.has(entry.kind) || superseded.has(entry.id)) continue;
    if (departureStatus(workflow, entry).status === 'rejected') for (const file of entry.paths ?? []) rejected.set(file, entry);
  }
  return rejected;
}

/** One departure as a person reads it in a row: what changed and what it departs from. */
export function departureWords(departure) {
  const files = (departure.paths ?? []).join(', ');
  const clauses = (departure.clauses ?? []).length ? ` under ${departure.clauses.join(', ')}` : '';
  if (departure.kind === 'path') return `${files} changed and no row of the plan names it${clauses ? `; it serves ${departure.clauses.join(', ')}` : ''}`;
  if (departure.kind === 'supporting') return `${files} changed as a supporting change (${departure.class ?? 'unclassified'})`;
  if (departure.kind === 'test') return `a planned test changes: ${departure.change?.op} ${departure.change?.test ?? departure.change?.to ?? ''}${clauses}`.trim();
  if (departure.kind === 'plan-row') return `a plan row changes: ${departure.change?.op}${departure.change?.clauseId ? ` on ${departure.change.clauseId}` : ''}`;
  if (departure.kind === 'clause') return `the approved clause${(departure.clauses ?? []).length === 1 ? '' : 's'} ${(departure.clauses ?? []).join(', ') || 'of the scope'} change in ${departure.target?.phase}`;
  if (departure.kind === 'finding') return `${files} ${(departure.paths ?? []).length === 1 ? 'carries' : 'carry'} the fix for ${(departure.findings ?? []).join(', ')} from the findings register`;
  return `${departure.target?.phase}'s approved wording changes${clauses}`;
}
