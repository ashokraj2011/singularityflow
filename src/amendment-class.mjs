/**
 * How big an intent amendment is [CIC:REQ-013, REQ-014; owner decisions 2026-11-14]: `editorial`, `refinement` or
 * `material`, under SPEC-CIC switch 3 (`spec.changeImpact: on`). Registered, model-free rules compute the lowest class
 * a change can have (its floor) from the clause diff and what the clauses are bound to; each class carries its
 * reasons as rule IDs, which every surface words the same way. A proposer (an agent or a person) may suggest a
 * stricter class; a suggestion below the floor is raised to it and the words say why, never refused. A scope
 * approver may raise the class when deciding. Nobody goes below the floor.
 *
 * Class decides handling, within CIC:CON-003 and CON-004: an `editorial` change carries the evidence of the clauses it
 * rewords without per-step "still holds", a `refinement` follows the intent-amendment route as it was, and a
 * `material` change also needs the scope-change authority (`spec.scopeChangeAuthority`, an approvalAuthorities group;
 * without it, the scope step's own approval groups). Exact phase-bundle approval stays the only thing that advances
 * state: there is no clause-level approval here. Loaded only on a Story with the switch, by the preview, the card,
 * proposing and deciding.
 */
import { SingularityFlowError } from './util.mjs';

export const AMENDMENT_CLASSES = Object.freeze(['editorial', 'refinement', 'material']);
const rank = (value) => AMENDMENT_CLASSES.indexOf(value);
/** The stricter of two classes; an unknown one reads as nothing. */
export const stricterClass = (left, right) => (rank(right) > rank(left) ? right : left);

/**
 * The registered rules, in the order a reader is told them: REQ-013 as written. A change is not editorial if it adds or
 * removes a clause, changes a clause with a bound test or an acceptance clause, or changes expected paths or test
 * bindings; it is material if it adds a clause, widens expected paths beyond the Story's admitted scope, or changes
 * required authority. An ambiguous change (what its clauses are bound to cannot be read) takes the stricter class.
 */
export const CLASS_RULES = Object.freeze([
  { id: 'adds-clause', class: 'material' },
  { id: 'widens-paths', class: 'material' },
  { id: 'changes-authority', class: 'material' },
  { id: 'bindings-unreadable', class: 'material' },
  { id: 'removes-clause', class: 'refinement' },
  { id: 'tested-clause', class: 'refinement' },
  { id: 'acceptance-clause', class: 'refinement' },
  { id: 'changes-bindings', class: 'refinement' },
  { id: 'wording-only', class: 'editorial' }
].map((rule) => Object.freeze(rule)));
const RULE_CLASS = new Map(CLASS_RULES.map((rule) => [rule.id, rule.class]));

const upper = (value) => String(value ?? '').toUpperCase();
const sorted = (values) => [...new Set(values)].sort();
const posix = (value) => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
/** Whether `candidate` is `root` or lies under it. */
const within = (candidate, root) => { const [path, base] = [posix(candidate), posix(root)]; return Boolean(base) && (path === base || path.startsWith(`${base}/`)); };
const typeOf = (clauseId) => /:([A-Z]+)-\d+$/u.exec(upper(clauseId))?.[1] ?? null;

/**
 * The floor and its reasons, from facts already read: `diff` (added, revised, removed), the Story's merged `planned` and
 * `observed` claims, the scope step's own planned claims before and after (`scopePlanned`, only where the scope plans
 * its clauses itself), the plan rows the amendment carries (`operations`), the paths the Story's plan admits
 * (`admitted`), the protected paths (`protectedPaths`), and what could not be read (`unreadable`). Pure.
 */
export function classFloor({ diff = {}, planned = {}, observed = {}, scopePlanned = null, operations = [], admitted = [], protectedPaths = [], unreadable = [] } = {}) {
  const reasons = [];
  const add = (rule, fields) => reasons.push({ rule, class: RULE_CLASS.get(rule), ...fields });
  const added = sorted((diff.added ?? []).map(upper));
  const revised = sorted((diff.revised ?? []).map(upper));
  const removed = sorted((diff.removed ?? []).map(upper));
  if (added.length) add('adds-clause', { clauses: added });
  if (removed.length) add('removes-clause', { clauses: removed });
  const testsOf = (id) => sorted([...(planned[id]?.tests ?? []), ...(observed[id]?.tests ?? [])]);
  const tested = revised.filter((id) => testsOf(id).length);
  if (tested.length) add('tested-clause', { clauses: tested, tests: sorted(tested.flatMap(testsOf)).slice(0, 12) });
  const acceptance = revised.filter((id) => typeOf(id) === 'AC');
  if (acceptance.length) add('acceptance-clause', { clauses: acceptance });
  // What the change does to paths and tests: the rows it carries for a separate plan (keep-row keeps a row as it is),
  // and, where the scope plans its own clauses, the rows its amended text plans for a clause it revises.
  const changed = new Set();
  const newPaths = new Set();
  for (const operation of operations) {
    if (operation?.op === 'keep-row') continue;
    const id = upper(operation?.clauseId);
    if (operation?.op !== 'add-row' && operation?.op !== 'remove-row') changed.add(id);
    for (const candidate of operation?.op === 'add-row' ? operation.expectedPaths ?? [] : operation?.op === 'replace-location' ? [operation.to] : []) {
      if (candidate) newPaths.add(posix(candidate));
    }
  }
  if (scopePlanned) {
    for (const id of revised) {
      const [was, now] = [scopePlanned.before?.[id], scopePlanned.after?.[id]];
      const same = (field) => sorted((was?.[field] ?? []).map(posix)).join('\n') === sorted((now?.[field] ?? []).map(posix)).join('\n');
      if (!same('expectedPaths') || !same('tests')) changed.add(id);
      for (const candidate of now?.expectedPaths ?? []) if (!(was?.expectedPaths ?? []).map(posix).includes(posix(candidate))) newPaths.add(posix(candidate));
    }
    for (const id of added) for (const candidate of scopePlanned.after?.[id]?.expectedPaths ?? []) newPaths.add(posix(candidate));
  }
  const rebound = sorted([...changed].filter((id) => !added.includes(id) && !removed.includes(id)));
  if (rebound.length) add('changes-bindings', { clauses: rebound });
  const outside = sorted([...newPaths].filter((candidate) => !admitted.some((root) => within(candidate, root))));
  if (outside.length) add('widens-paths', { paths: outside.slice(0, 12) });
  const guarded = sorted([...newPaths].flatMap((candidate) => protectedPaths.filter((root) => within(candidate, root)).map((root) => `${candidate}\u0000${posix(root)}`)));
  if (guarded.length) add('changes-authority', { paths: sorted(guarded.map((entry) => entry.split('\u0000')[0])).slice(0, 12), protectedPaths: sorted(guarded.map((entry) => entry.split('\u0000')[1])) });
  if (unreadable.length) add('bindings-unreadable', { what: sorted(unreadable) });
  if (!reasons.length) add('wording-only', { clauses: revised });
  return { floor: reasons.map((reason) => reason.class).reduce(stricterClass, 'editorial'), reasons };
}

/** A class a command was given, or null; anything else is refused with the three it takes. */
export function requestedClass(value, flag = '--class') {
  if (value == null || value === true || value === '') return null;
  const named = String(value).trim().toLowerCase();
  if (!AMENDMENT_CLASSES.includes(named)) {
    throw new SingularityFlowError(`${flag} takes editorial, refinement or material; '${value}' is none of them.`, { code: 'INTENT_AMENDMENT_CLASS_INVALID' });
  }
  return named;
}

/**
 * The amendment's class as it stands: the floor the rules compute now (never below the one recorded when it was
 * proposed), the proposer's suggestion, each approver's raise, and the class that results. `stored` is the proposal's
 * recorded classification; `decisions` its recorded decisions, each raise among them.
 */
export function effectiveClass(computed, { stored = null, decisions = [] } = {}) {
  const floor = stricterClass(computed.floor, stored?.floor ?? 'editorial');
  const reasons = computed.floor === floor ? computed.reasons : stored?.reasons ?? computed.reasons;
  const suggested = stored?.suggested ?? null;
  const raises = decisions.filter((entry) => entry?.raise?.to).map((entry) => ({ by: entry.actor?.name ?? entry.actor?.email ?? entry.actor?.login ?? null,
    from: entry.raise.from, to: entry.raise.to, at: entry.at ?? null }));
  const effective = [suggested?.class ?? null, ...raises.map((entry) => entry.to)].filter(Boolean).reduce(stricterClass, floor);
  return { floor, reasons, ...(suggested ? { suggested } : {}), ...(raises.length ? { raises } : {}), effective };
}

/**
 * Who decides a change of this class [CIC:REQ-014, owner decision 2]: the scope step's own approval groups, and for a
 * material change the scope-change authority the pinned policy names (`spec.scopeChangeAuthority`), else the same
 * groups. `policy` is the scope step's approval policy; the material policy keeps its minimum and self-approval rule.
 */
export function deciders(workflow, scopePolicy, effective) {
  const named = workflow?.resolution?.spec?.scopeChangeAuthority ?? null;
  const groups = sorted([...(scopePolicy?.authorities ?? []), ...(scopePolicy?.requiredAuthorities ?? [])]);
  if (effective !== 'material' || !named) return { groups, authority: null, policy: scopePolicy };
  return { groups: [named], authority: named, policy: { ...scopePolicy, authorities: [named], requiredAuthorities: [] } };
}

const RULE_WORDS = Object.freeze({
  'adds-clause': (reason, name) => `it adds ${list(reason.clauses.map(name))}, so the Story must do something new`,
  'removes-clause': (reason, name) => `it removes ${list(reason.clauses.map(name))}`,
  'tested-clause': (reason, name) => `${list(reason.clauses.map(name))} ${reason.clauses.length === 1 ? 'has a bound test' : 'have bound tests'}${reason.tests?.length ? ` (${list(reason.tests)})` : ''}`,
  'acceptance-clause': (reason, name) => `${list(reason.clauses.map(name))} ${reason.clauses.length === 1 ? 'is an acceptance criterion' : 'are acceptance criteria'}`,
  'changes-bindings': (reason, name) => `it changes the expected paths or tests of ${list(reason.clauses.map(name))}`,
  'widens-paths': (reason) => `it adds ${list(reason.paths)}, outside the paths the Story's plan admits`,
  'changes-authority': (reason) => `it adds ${list(reason.paths)}, under the protected ${list(reason.protectedPaths)}, whose own approval then applies`,
  'bindings-unreadable': (reason) => `what its clauses are bound to could not be read (${list(reason.what)}), so the stricter class applies`,
  'wording-only': (reason, name) => `it only rewords ${list(reason.clauses.map(name)) || 'the scope'}: no bound test, no acceptance criterion, and no path or test binding changes`
});

function list(values) {
  const items = (values ?? []).filter(Boolean);
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** One reason in words, with its rule ID: "AC-001 has a bound test (test/a.test.mjs) [tested-clause]". */
export function reasonWords(reason, name = (id) => id) {
  const words = RULE_WORDS[reason.rule];
  return `${words ? words(reason, name) : reason.rule} [${reason.rule}]`;
}

const CLASS_NAME = Object.freeze({ editorial: 'an editorial change', refinement: 'a refinement', material: 'a material change' });

/**
 * The class in a person's words, the same on the preview, the terminal and every card: how big it is and why, a
 * suggestion the rules raised, each raise, and who decides it. `scopeName` names the scope step; `groups` and
 * `authority` come from deciders().
 */
export function classWords(classification, { name = (id) => id, scopeName = 'the scope', groups = [], authority = null } = {}) {
  if (!classification) return [];
  const { floor, reasons, suggested, raises, effective } = classification;
  const why = reasons.filter((reason) => reason.class === floor).map((reason) => reasonWords(reason, name)).map((words, index) => (index ? words : `${words[0].toUpperCase()}${words.slice(1)}`));
  const lines = [`How big: ${CLASS_NAME[effective]}${effective === floor ? '' : ` (the rules make it at least ${CLASS_NAME[floor]})`}. ${why.length ? `${why.join('; ')}.` : ''}`.trim()];
  if (suggested && suggested.class !== effective && rank(suggested.class) < rank(floor)) {
    lines.push(`It was suggested as ${CLASS_NAME[suggested.class]}; the rules raise it to ${CLASS_NAME[floor]}, as the reasons above say.`);
  }
  for (const raise of raises ?? []) lines.push(`${raise.by ?? 'An approver'} raised it from ${CLASS_NAME[raise.from] ?? raise.from} to ${CLASS_NAME[raise.to] ?? raise.to}.`);
  const who = groups.length ? list(groups) : 'its approvers';
  lines.push(effective === 'editorial'
    ? `Who decides: ${scopeName}'s approvers (${who}) approve the new wording as editorial; then every step keeps its approval and the evidence of the reworded clauses is carried, without asking each step whether it still holds.`
    : effective === 'material' && authority
      ? `Who decides: the scope-change authority, ${who}: only a person in it approves a material change.`
      : `Who decides: ${scopeName}'s approvers (${who}).`);
  return lines;
}

/**
 * The floor from the Story as it is [CIC:REQ-013]: its merged planned and observed claims (records already read),
 * the scope step's own planned claims before and after (`plannedAfter()` derives the amended text's plan, null where
 * the scope plans nothing), the rows the amendment carries, the paths the plan admits and the protected paths. What
 * cannot be read is named, so the stricter class applies.
 */
export async function amendmentClassification(workflow, proposal, { records, scopePhase, protectedPaths = [], plannedAfter }) {
  const { mergeObservedClaimRecords, mergePlannedClaimRecords, plannedSupportingFiles } = await import('./specifications.mjs');
  const unreadable = [];
  const planned = mergePlannedClaimRecords(records?.planned ?? []);
  let observed = {};
  try { observed = mergeObservedClaimRecords(records?.observed ?? [], planned, { workflow }); } catch { unreadable.push('the observed claims'); }
  const scope = (records?.planned ?? []).find((record) => !record.amendment && record.phase === scopePhase) ?? null;
  let scopePlanned = null;
  try {
    const after = await plannedAfter();
    if (after) scopePlanned = { before: scope?.claims ?? {}, after: after.derived?.claimMap?.claims ?? {} };
  } catch { unreadable.push('the amended scope\'s plan'); }
  const admitted = [...Object.values(planned).flatMap((claim) => claim.expectedPaths ?? []), ...plannedSupportingFiles(records?.planned ?? [])];
  return classFloor({ diff: proposal.diff ?? {}, planned, observed, scopePlanned, admitted, protectedPaths, unreadable,
    operations: (proposal.planCorrections ?? []).flatMap((entry) => entry.operations ?? []) });
}

/**
 * What one approver's decision approves under switch 3 [CIC:REQ-013, REQ-014; owner decisions 1 and 2]: the class as it
 * stands, their raise (only on an approval, and never below it), the class they approve, and the policy that decides
 * it. An approval recorded for a lower class than the amendment now has no longer counts toward it.
 */
export function classedApproval(workflow, scopePolicy, current, { decision, raise = null, amendment, workId }) {
  const command = `singularity-flow story intent-amendment decide ${amendment} --decision approve --confirm ${amendment} --work-id ${workId}`;
  if (raise && decision !== 'approve') {
    throw new SingularityFlowError(`--class raises the class an approval approves; rejecting ${amendment} takes none. Run it again without --class.`,
      { code: 'INTENT_AMENDMENT_CLASS_INVALID', details: { workId, amendment, recoveryCommand: command.replace('--decision approve', '--decision reject') } });
  }
  if (raise && rank(raise) < rank(current.effective)) {
    const stricter = AMENDMENT_CLASSES.slice(rank(current.effective) + 1);
    throw new SingularityFlowError(`${amendment} is ${CLASS_NAME[current.effective]}${current.effective === current.floor ? ' by the rules' : ''}: a person may raise its class, never lower it, so nothing was recorded. `
      + `Approve it as it is${stricter.length ? `, or raise it to ${list(stricter)} with --class` : ''}.`,
    { code: 'INTENT_AMENDMENT_CLASS_LOWERED', details: { workId, amendment, class: current.effective, floor: current.floor,
      actions: [{ command, detail: `Approve it as ${CLASS_NAME[current.effective]}.` }, ...stricter.map((value) => ({ command: `${command} --class ${value}`, detail: `Approve it as ${CLASS_NAME[value]}.` }))] } });
  }
  const approves = raise ? stricterClass(current.effective, raise) : current.effective;
  const counts = (entry) => !entry?.class || rank(entry.class) >= rank(approves);
  return { approves, raise: approves !== current.effective ? { from: current.effective, to: approves } : null, counts, ...deciders(workflow, scopePolicy, approves) };
}

/**
 * A material approval by someone outside the scope-change authority [owner decision 2]: refused with who can decide it
 * and how, on the decisions card or in their own terminal. Nothing was recorded; rejecting it stays theirs.
 */
export function materialAuthorityRefusal(error, { authority, groups, eligible = [], anyIdentity = false, amendment, workId }) {
  const command = `singularity-flow story intent-amendment decide ${amendment} --decision approve --confirm ${amendment} --work-id ${workId}`;
  const who = `${authority ? `the scope-change authority, ${list(groups)}` : `the scope's approvers (${list(groups)})`}${eligible.length ? `: ${list(eligible)}` : anyIdentity ? ', which any Git identity may hold' : ''}`;
  return new SingularityFlowError(`${amendment} is a material change, which only a person in ${who} approves, so nothing was recorded (${error.message}). `
    + `One of them approves it on the decisions card (/sf-decide ${workId}) or in their own terminal; you may still reject it, or leave it to them.`,
  { code: 'INTENT_AMENDMENT_MATERIAL_AUTHORITY', details: { workId, amendment, authorities: groups, eligibleApprovers: eligible, ...(authority ? { scopeChangeAuthority: authority } : {}),
    actions: [{ command: `singularity-flow decisions ${workId}`, skill: '/sf-decide', detail: `A person in ${list(groups)} approves it on the decisions card.` },
      { command, detail: 'Or in their own terminal.' }] } });
}
