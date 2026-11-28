/**
 * A person overrides a blocking finding the check got wrong (owner, 2026-11-23: "we should be able to override this",
 * "any blocking finding").
 *
 * On the owner's d-story a check kept a step from publishing for something its author could not, or should not, change.
 * Any finding that blocks a step now has a person's way past it:
 * - Most already have one: an assignment, an accepted test-run risk, a scope appeal, a plan decision, a dispute of the
 *   reviewer's finding, a dispute of the code-delivery check.
 * - A finding a check raises about the step's own document has this override.
 *
 * Who decides:
 * - Someone the step's approval rules name (its approvers, or its author where they may approve their own step), never
 *   the agent.
 * - They give their own reason, from the decision list (the Decide card, /sf-decide with their Yes, or `decisions record`
 *   in their terminal) or `decision override-finding` in their terminal.
 *
 * What it does:
 * - That exact finding (its code, file and clause, never its wording) stops blocking the version of the step being written.
 * - It is recorded as overridden, never as passed, and shown with who and why wherever the step's evidence is reviewed.
 * - Its approvers may still return the step.
 * - A later version of the step is checked afresh.
 *
 * Never overridden: a finding that guards integrity or a secret, a failing test (it has its own accepted risk), a finding
 * of where the Story stands, and a person's own answer still owed.
 *
 * Gates honour it at one place each: the findings a check returns pass through `honourOverrides` (phase-draft-check.mjs,
 * publication-preflight.mjs, conformance-readiness.mjs), so prepublish, publish and submission agree, and a finding is
 * offered for override only where its gate honours one (`finding.override`). Pure: no I/O.
 */
import { createHash } from 'node:crypto';
import { phaseFindingIdentity, phaseFindingPolicy } from './phase-finding-policy.mjs';
import { countedRecords } from './presence/counted.mjs';
import { canonicalJson } from './records.mjs';
import { stepDecisionOf } from './step-decision.mjs';
import { SingularityFlowError } from './util.mjs';

/** The reason an override takes: the person's own words, as a dispute's. */
export const FINDING_OVERRIDE_REASON = Object.freeze({ minimum: 20, maximum: 1000 });
/**
 * What a person's record says, by kind [owner, 2026-11-28]:
 *   override          the check is wrong about the step's own document (the finding's own override)
 *   check-wrong       an SFlow check is wrong here and nothing else gets past it: the last way on, where SFlow's maintainer
 *                     was once the only one; the report for the maintainer is still offered to copy
 *   browser-sign-off  SFlow could not capture the page itself, so the person signed off on its saved screenshot: signed
 *                     off by a person, not captured by SFlow; no reason needed, the sign-off is the person's own look
 */
export const OVERRIDE_KINDS = Object.freeze(['override', 'check-wrong', 'browser-sign-off']);
/** Why SFlow's own hooks, governance files and secrets have no override, in one line every surface shows. */
export const PROTECTED_WHY = 'SFlow\'s own hooks, governance files and secrets stay protected: nobody overrides them, so what the Story records stays true.';
const KEY = /^CHK-[a-f0-9]{12}$/u;
/** What the check reports about the step's own document; everything else keeps its own person's route. */
const OVERRIDABLE = new Set(['author-correction', 'quality', 'owner-resolution']);
// The code delivery family has its own dispute and its coverage its own accepted risk: never overridden here.
const OWN_ROUTE_CODE = /^(?:code[._]|spec[._]coverage|evidence[._]corner)/iu;

/** The finding's key on this step: `CHK-` and twelve hex digits of its identity (code, file, clause), never its words. */
export function findingOverrideKey(phaseId, finding) {
  // A check may name the clause as `value`, `clauseId` or `details.clauseId`: one key for one finding, whichever it uses.
  const identity = { ...phaseFindingIdentity(finding), value: finding?.details?.clauseId ?? finding?.value ?? finding?.clauseId ?? null };
  return `CHK-${createHash('sha256').update(canonicalJson({ phase: phaseId, ...identity })).digest('hex').slice(0, 12)}`;
}

/**
 * Why a person may not say SFlow's check is wrong here (an override of kind `check-wrong`), or null when they may: any
 * blocking finding but one that guards SFlow's own hooks, governance files or a secret, or that says where the Story
 * stands or that its records are damaged (its own next action moves those on, and the transaction checks them again).
 */
export function checkWrongBar(finding) {
  if (finding?.blocking === false) return 'it is an advisory and blocks nothing';
  const { classification } = phaseFindingPolicy(finding ?? {});
  if (classification === 'integrity-or-authority') return PROTECTED_WHY;
  // A test is the repository's, never SFlow's check: one that failed is fixed, and a run the environment stopped has its risk.
  if (classification === 'test-repair') return 'a failing test is fixed, never overridden; a run the environment stopped has its own accepted risk';
  const category = String(finding?.category ?? '').toLowerCase();
  if (category === 'lifecycle' || category === 'records') return 'it says where the Story stands or that a record is damaged; its own next action moves it on';
  return null;
}

/** Why a finding is not overridden, in words, or null when a person may override it. */
export function findingOverrideBar(finding) {
  if (finding?.blocking === false) return 'it is an advisory and blocks nothing';
  const policy = phaseFindingPolicy(finding ?? {});
  if (policy.classification === 'integrity-or-authority') return 'it guards the Story\'s integrity, an authority or a secret';
  if (policy.classification === 'test-repair') return 'a failing test has its own accepted risk instead';
  if (OWN_ROUTE_CODE.test(String(finding?.code ?? ''))) return 'the code delivery check has its own dispute and accepted risk instead';
  if (['artifact.required.missing', 'artifact.metadata.invalid'].includes(String(finding?.code ?? ''))) return 'the document itself is missing or its record is damaged';
  if (!OVERRIDABLE.has(policy.classification)) return `it is not about the step's own document (${policy.classification})`;
  return null;
}

/**
 * The version of the step an override applies to: the one being written, else its latest published one, as the step's
 * own decision reads them (step-decision.mjs), never decided here [OSA:REQ-020].
 */
export function overrideGeneration(workflow, phase) {
  let version = null;
  try { version = stepDecisionOf(workflow, phase)?.version ?? null; } catch { version = null; }
  return Number(version?.writing ?? version?.published ?? phase?.generation ?? 0);
}

/** The overrides in force for `phase`'s version `generation`, newest last. */
export function activeFindingOverrides(workflow, phase, generation = overrideGeneration(workflow, phase)) {
  return countedRecords(workflow, workflow?.findingOverrides)
    .filter((entry) => entry.phase === phase?.id && Number(entry.generation) === Number(generation) && !entry.withdrawnAt);
}

/**
 * The findings a gate keeps after the person's overrides: each overridden one leaves `findings` for `overridden` (with
 * who and why), and each one a person may override carries `override: { key }`, so a route offers only what this gate
 * honours. Never throws.
 */
export function honourOverrides(workflow, phase, findings = [], { generation } = {}) {
  if (!phase || !Array.isArray(findings) || !findings.length) return { findings: findings ?? [], overridden: [] };
  const active = new Map(activeFindingOverrides(workflow, phase, generation ?? overrideGeneration(workflow, phase)).map((entry) => [entry.finding, entry]));
  const kept = [];
  const overridden = [];
  for (const finding of findings) {
    const bar = findingOverrideBar(finding);
    // A finding with its own person's route keeps it; "this check is wrong here" is its last way on, never in its place.
    const kind = bar ? (checkWrongBar(finding) ? null : 'check-wrong') : 'override';
    const key = kind ? findingOverrideKey(phase.id, finding) : null;
    const record = key ? active.get(key) : null;
    if (record) overridden.push(Object.freeze({ ...finding, overriddenBy: overrideSummary(record) }));
    else kept.push(key && !finding.override ? Object.freeze({ ...finding, override: Object.freeze(kind === 'override' ? { key } : { key, kind }) }) : finding);
  }
  return { findings: kept, overridden };
}

/** Who overrode it, when and why, as every reader shows it. */
export function overrideSummary(record) {
  return Object.freeze({ id: record.id, key: record.finding, by: record.actor ?? null, at: record.at ?? null, reason: record.reason,
    kind: record.kind ?? 'override', ...(record.screenshot ? { screenshot: record.screenshot } : {}) });
}

/**
 * In words, by kind:
 *   override          `<code> on <file> was overridden by <who>: "<reason>". Recorded as overridden, not passed.`
 *   check-wrong       `<who> said SFlow's check <code> on <file> is wrong here: "<reason>". Recorded as overridden, not passed.`
 *   browser-sign-off  `The <server> page was signed off by <who> on SFlow's saved screenshot <file>, not captured by SFlow.`
 */
export function overriddenWords(finding, record = finding?.overriddenBy) {
  const by = record?.by ?? 'a person';
  if (record?.kind === 'browser-sign-off') {
    const shot = record.screenshot?.path ? ` ${record.screenshot.path}` : '';
    return `The ${finding?.value ?? 'browser'} page was signed off by ${by} on SFlow's saved screenshot${shot}, not captured by SFlow.${record?.reason ? ` "${record.reason}"` : ''}`;
  }
  const what = `${finding?.code ?? 'The finding'}${finding?.path ? ` on ${finding.path}` : ''}${finding?.value ? ` (${finding.value})` : ''}`;
  if (record?.kind === 'check-wrong') return `${by} said SFlow's check ${what} is wrong here: "${record?.reason ?? ''}". Recorded as overridden, not passed.`;
  return `${what} was overridden by ${by}: "${record?.reason ?? ''}". Recorded as overridden, not passed.`;
}

/** Every override in force on the Story, in words, oldest first: what the approval page and the pull request show. */
export function personOverrideLines(workflow, { phase = null } = {}) {
  return countedRecords(workflow, workflow?.findingOverrides)
    .filter((entry) => !entry.withdrawnAt && (!phase || entry.phase === phase))
    .map((entry) => ({ phase: entry.phase, generation: Number(entry.generation), kind: entry.kind ?? 'override',
      words: overriddenWords({ code: entry.code, path: entry.path, value: entry.value }, overrideSummary(entry)) }));
}

/**
 * The text a person sends SFlow's maintainer when a check is wrong: what it raised, where, and that a person overrode it
 * with their reason on the Story. Plain, so it can be copied as it is.
 */
export function checkReportText(workId, phaseId, finding) {
  const where = finding?.path ? ` on ${finding.path}${finding.line ? `:${finding.line}` : ''}` : '';
  const said = String(finding?.message ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400);
  return `SFlow check ${finding?.code ?? 'unknown'} looks wrong. It blocked step ${phaseId} of Story ${workId}${where}${said ? `: ${said}` : '.'}`
    + `${said && !/[.!?]$/u.test(said) ? '.' : ''} The person who approves the step overrode it with their reason, recorded on the Story. Please check this rule.`;
}

const refused = (message, details = undefined) => { throw new SingularityFlowError(message, { code: 'FINDING_OVERRIDE_INVALID', ...(details ? { details } : {}) }); };

/** Append a person's override to the aggregate and return it; the caller checked the finding and their authority. */
export function recordFindingOverride(workflow, { phase, generation, finding, reason, actor, authorityGroup, identityAssurance = null, at, kind = 'override', screenshot = null }) {
  if (!KEY.test(String(finding?.key ?? ''))) refused('Name the finding by its key, as CHK- and twelve hex digits.');
  if (!OVERRIDE_KINDS.includes(kind)) refused(`An override is one of ${OVERRIDE_KINDS.join(', ')}.`);
  const said = String(reason ?? '').replace(/\s+/gu, ' ').trim();
  // A sign-off is the person's own look at SFlow's screenshot: a note is theirs to add, never required.
  const signOff = kind === 'browser-sign-off';
  if (signOff && !/^[a-f0-9]{64}$/u.test(String(screenshot?.sha256 ?? ''))) refused('A sign-off names the exact screenshot SFlow saved for this version. Nothing was recorded.');
  if ((!signOff || said) && (said.length < FINDING_OVERRIDE_REASON.minimum || said.length > FINDING_OVERRIDE_REASON.maximum)) {
    refused(`${signOff ? 'A note on a sign-off is' : 'An override says why the check is wrong,'} in your own words: ${FINDING_OVERRIDE_REASON.minimum} to ${FINDING_OVERRIDE_REASON.maximum} characters (this one has ${said.length}). Nothing was recorded.`);
  }
  workflow.findingOverrides ??= [];
  const record = { id: `FOV-${String(workflow.findingOverrides.length + 1).padStart(3, '0')}`, phase, generation: Number(generation),
    finding: finding.key, code: String(finding.code ?? ''), path: finding.path ?? null, value: finding.value ?? null,
    message: String(finding.message ?? '').replace(/\s+/gu, ' ').trim().slice(0, 600), reason: said || null, actor, authorityGroup, identityAssurance, at,
    ...(kind === 'override' ? {} : { kind }),
    ...(signOff ? { screenshot: { record: String(screenshot.record ?? ''), path: screenshot.path ?? null, sha256: screenshot.sha256 } } : {}) };
  workflow.findingOverrides.push(record);
  return record;
}
