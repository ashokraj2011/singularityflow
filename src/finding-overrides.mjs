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
    const key = bar ? null : findingOverrideKey(phase.id, finding);
    const record = key ? active.get(key) : null;
    if (record) overridden.push(Object.freeze({ ...finding, overriddenBy: overrideSummary(record) }));
    else kept.push(key && !finding.override ? Object.freeze({ ...finding, override: Object.freeze({ key }) }) : finding);
  }
  return { findings: kept, overridden };
}

/** Who overrode it, when and why, as every reader shows it. */
export function overrideSummary(record) {
  return Object.freeze({ id: record.id, key: record.finding, by: record.actor ?? null, at: record.at ?? null, reason: record.reason });
}

/** In words: `<code> on <file> was overridden by <who>: "<reason>". Recorded as overridden, not passed.` */
export function overriddenWords(finding, record = finding?.overriddenBy) {
  const what = `${finding?.code ?? 'The finding'}${finding?.path ? ` on ${finding.path}` : ''}${finding?.value ? ` (${finding.value})` : ''}`;
  return `${what} was overridden by ${record?.by ?? 'a person'}: "${record?.reason ?? ''}". Recorded as overridden, not passed.`;
}

const refused = (message, details = undefined) => { throw new SingularityFlowError(message, { code: 'FINDING_OVERRIDE_INVALID', ...(details ? { details } : {}) }); };

/** Append a person's override to the aggregate and return it; the caller checked the finding and their authority. */
export function recordFindingOverride(workflow, { phase, generation, finding, reason, actor, authorityGroup, identityAssurance = null, at }) {
  if (!KEY.test(String(finding?.key ?? ''))) refused('Name the finding by its key, as CHK- and twelve hex digits.');
  const said = String(reason ?? '').replace(/\s+/gu, ' ').trim();
  if (said.length < FINDING_OVERRIDE_REASON.minimum || said.length > FINDING_OVERRIDE_REASON.maximum) {
    refused(`An override says why the check is wrong, in your own words: ${FINDING_OVERRIDE_REASON.minimum} to ${FINDING_OVERRIDE_REASON.maximum} characters (this one has ${said.length}). Nothing was recorded.`);
  }
  workflow.findingOverrides ??= [];
  const record = { id: `FOV-${String(workflow.findingOverrides.length + 1).padStart(3, '0')}`, phase, generation: Number(generation),
    finding: finding.key, code: String(finding.code ?? ''), path: finding.path ?? null, value: finding.value ?? null,
    message: String(finding.message ?? '').replace(/\s+/gu, ' ').trim().slice(0, 600), reason: said, actor, authorityGroup, identityAssurance, at };
  workflow.findingOverrides.push(record);
  return record;
}
