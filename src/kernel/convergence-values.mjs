/** Shared deterministic convergence values. No storage, provider, process or host selection. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textValueSyntax,admitRecordSchemaVersion,CONVERGENCE_VALUE_SCHEMA,convergenceSealCore} from '../foundation/record-schema.mjs';
export {convergenceSealCore} from '../foundation/record-schema.mjs';
import {configurationPathSyntax} from './configuration-path-policies.mjs';
import {capWithDisclosure,analysisLimits} from './configuration-declarations.mjs';
import {mergePlannedClaimRecords} from './specification-policy.mjs';
import {specificationClaimPolicies} from './specification-values.mjs';
import {supportingChangePolicies} from './source-path-policies.mjs';
export const CONVERGENCE_VALUES_PROFILE='sflow-convergence-values/v1';
export const NAMESPACE_CONVERGENCE_VALUES_PROFILE='sflow-namespace-convergence-values/v1';
/**
 * The deterministic fact kinds `[SPK:REQ-074]` enumerates.
 *
 * Every one of them is a statement about the *record*, which is the only thing the kernel can check.
 */
export const FACT_KINDS = Object.freeze([
  'absent-observed-claim', 'unclaimed-changed-path', 'stale-claim-binding', 'missing-bound-test',
  'failing-bound-test', 'claimed-withdrawn-clause', 'unresolved-deviation', 'missing-required-evidence',
  // `[AMD:REQ-050]`. A claim reconciled against a clause whose text has since changed. Distinct from
  // `claimed-withdrawn-clause`, which is the clause going away: here it still exists and still has a
  // verdict, and the verdict is about words the specification no longer contains.
  'verdict-against-superseded-clause'
]);

/** What an assisted pass may propose `[SPK:REQ-076]`, and a human may confirm. */
export const FINDING_CLASSIFICATIONS = Object.freeze(['missing', 'partial', 'contradicts', 'unplanned']);

/**
 * How a human disposes of an item `[SPK:REQ-079]` `[AMD:REQ-010]`.
 *
 * `update-intent` is the reality-altitude door into an amendment: the code is right and the plan was
 * wrong. It is distinct from `accepted-deviation`, which says the divergence is tolerated and leaves
 * the specification alone — the deviation stands on the record and the clause keeps saying what it
 * always said. `update-intent` says the clause itself must change, so the specification, not the
 * code, is what moves next.
 */
export const DISPOSITIONS = Object.freeze([
  'rework', 'accepted-deviation', 'dismissed', 'deferred', 'update-intent'
]);

/**
 * Dispositions that leave the Story unable to advance until they are resolved.
 *
 * `update-intent` blocks for the same reason `rework` does, from the other direction. Rework says
 * the code has not caught up with the plan; update-intent says the plan has not caught up with the
 * code. Either way the Story would be advancing on a specification known to be wrong, and the whole
 * point of recording the disposition is that somebody said so out loud. It clears when the
 * amendment lands, which is a human act `[AMD:CON-003]` — nothing here amends anything.
 */
const BLOCKING = Object.freeze(['rework', 'update-intent']);


/** Explicit value primitives preserve host syntax without importing a runtime or record reader. */
export function convergenceValuePolicies(pathPort,textPort,{schemaVersion=6,profile=CONVERGENCE_VALUES_PROFILE}={}){
  const {posix}=configurationPathSyntax(pathPort),text=textValueSyntax(textPort),
    {mergeObservedClaimRecords,testOnlyClaimEvidence}=specificationClaimPolicies(pathPort,textPort),
    {classifySupportingChange}=supportingChangePolicies(pathPort);
  try{admitRecordSchemaVersion(CONVERGENCE_VALUE_SCHEMA,{schemaVersion});}catch(cause){throw new SingularityFlowError(
    'Convergence values need their supported record version.',{code:'ENGINE_STORAGE_UNSUPPORTED',cause});}
  if(![CONVERGENCE_VALUES_PROFILE,NAMESPACE_CONVERGENCE_VALUES_PROFILE].includes(profile))throw new SingularityFlowError(
    'Select the explicit native or namespace convergence value profile.',{code:'ENGINE_STORAGE_UNSUPPORTED'});
  const CONVERGENCE_SCHEMA_VERSION=schemaVersion,recordSha256=value=>text.sha256Utf8(canonicalJson(value));
/**
 * A content-derived identity `[SPK:REQ-078]`.
 *
 * Derived rather than sequential so the same fact keeps the same ID across iterations. A reviewer
 * who dismissed `CF-4a1c…` in iteration 2 and sees it again in iteration 3 is seeing the same
 * problem; a counter would have renamed it and hidden that.
 */
function itemId(prefix, payload) {
  return `${prefix}-${recordSha256(payload).slice(0, 12)}`;
}

function sorted(values) {
  return [...new Set((values ?? []).map((value) => String(value)))].sort();
}

function fact(kind, { clauseIds = [], paths = [], evidence = [], detail }) {
  if (!FACT_KINDS.includes(kind)) throw new SingularityFlowError(`Unknown convergence fact kind '${kind}'.`);
  const body = { kind, clauseIds: sorted(clauseIds), paths: sorted(paths).map(posix), evidence: sorted(evidence) };
  return { id: itemId('CF', body), ...body, detail };
}

/**
 * The deterministic convergence facts `[SPK:REQ-073]` `[SPK:REQ-074]`.
 *
 * Pure and clock-free `[SPK:REQ-075]`: the same bound inputs always produce the same bytes, so two
 * runs can be compared and an iteration can be proved unchanged. The observation time belongs to the
 * caller, exactly as it does for specification quality.
 */
function convergenceFacts({
  reconciliation, indexes = [], planned = [], observed = [], acceptance = null, deviations = [],
  requiredEvidence = [], limits = undefined, workflow = null,
  /**
   * Clauses an amendment revised since the observed claims were recorded `[AMD:REQ-050]`.
   *
   * Passed in rather than derived, because convergence has the claims but not the two generations
   * of specification text needed to diff them — that is `amendment.mjs`'s job, and recomputing it
   * here would be a second opinion about what changed.
   */
  amendedClauses = []
} = {}) {
  if (!reconciliation) throw new SingularityFlowError('Convergence requires the reconciliation record it operates on.');
  const bounds = analysisLimits(limits);
  const disclosures = [];
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = mergePlannedClaimRecords(planned);
  const observedClaims = mergeObservedClaimRecords(observed, plannedClaims, { workflow });
  const amended = new Set(amendedClauses.map((id) => String(id).toUpperCase()));
  const facts = [];

  /**
   * Clauses with nothing observed against them.
   *
   * `[SPK:CON-033]` in its purest form. `missing` and `partial` verdicts count as absent trace too —
   * a claim that says "I did not do this" is a record of the absence, not evidence of presence.
   */
  for (const id of [...clauses.keys()].sort()) {
    const claim = observedClaims[id];
    if (!claim) {
      facts.push(fact('absent-observed-claim', {
        clauseIds: [id],
        detail: `no observed claim records evidence for ${id}; this is missing trace evidence, not proof that the requirement is unimplemented`
      }));
    } else if (['missing', 'partial'].includes(claim.verdict)) {
      facts.push(fact('absent-observed-claim', {
        clauseIds: [id],
        evidence: claim.observedPaths,
        detail: `the observed claim for ${id} records verdict '${claim.verdict}', so trace evidence is incomplete`
      }));
    }
  }

  /**
   * Paths reconciliation reported that no observed claim accounts for.
   *
   * Taken from `reconciliation.findings` and not recomputed `[SPK:CON-032]`. Reconciliation has
   * already decided what changed and whether it was planned; convergence only asks whether a
   * requirement claims it.
   */
  const claimedPaths = new Set(Object.entries(observedClaims).flatMap(([id, claim]) => [
    ...(claim.observedPaths ?? []),
    ...(claim.testResults ?? []).filter((candidate) => (plannedClaims[id]?.tests ?? []).includes(candidate))
  ]).map(posix));
  /**
   * Bounded `[SPK:REQ-130]`. A large refactor can change tens of thousands of paths, and one fact
   * per unclaimed path is not a report — it is a way of making the real findings unfindable. Capped
   * and disclosed rather than silently shortened.
   */
  const changed = capWithDisclosure(
    [...(reconciliation.findings ?? [])].sort((left, right) => String(left.path).localeCompare(String(right.path))),
    'maxChangedPaths', { limits: bounds, label: 'changed paths reported by reconciliation' }
  );
  if (changed.disclosure) disclosures.push(changed.disclosure);
  for (const finding of changed.items) {
    if (claimedPaths.has(posix(finding.path))) continue;
    facts.push(fact('unclaimed-changed-path', {
      paths: [finding.path],
      clauseIds: finding.clauseIds,
      detail: `${finding.path} changed and no observed claim cites it; this is missing trace evidence, not a finding that the change was unplanned`
    }));
  }

  // A claim that points at evidence which is not there, or at a clause that no longer exists.
  for (const id of Object.keys(observedClaims).sort()) {
    const claim = observedClaims[id];
    if (!clauses.has(id)) {
      facts.push(fact('claimed-withdrawn-clause', {
        clauseIds: [id],
        detail: `an observed claim exists for ${id}, which the approved specification no longer contains`
      }));
      continue;
    }
    if (['matched', 'partial', 'deviated'].includes(claim.verdict)
        && !(claim.observedPaths ?? []).length
        && !testOnlyClaimEvidence(id, plannedClaims[id], claim, { complete: claim.verdict === 'matched' })) {
      facts.push(fact('stale-claim-binding', {
        clauseIds: [id],
        detail: `${id} claims verdict '${claim.verdict}' with no source evidence bound to it`
      }));
    }
    /**
     * `[AMD:REQ-050]`. The verdict stands against the text it was recorded under, and that text has
     * moved — so the fact is that the verdict is *unverified against the current clause*, not that
     * the work is wrong. Saying "unimplemented" here would be the CON-033 mistake in a new place:
     * absent evidence about the new wording is missing trace evidence, not a finding.
     */
    if (amended.has(id) && ['matched', 'partial', 'deviated'].includes(claim.verdict)) {
      facts.push(fact('verdict-against-superseded-clause', {
        clauseIds: [id],
        detail: `${id} was reconciled as '${claim.verdict}' before the clause was revised; that verdict describes the previous wording and has not been re-checked against the current one`
      }));
    }
  }

  /**
   * Tests, from the acceptance evaluation rather than from a fresh run.
   *
   * `evaluateSpecAcceptance` already owns "which clause has a planned test, which has an observed
   * result, which command failed". Recomputing it here would be a second acceptance engine.
   */
  for (const id of sorted(acceptance?.missingPlannedTests)) {
    if (!clauses.has(id)) continue;
    facts.push(fact('missing-bound-test', {
      clauseIds: [id],
      detail: `${id} has no planned test binding`
    }));
  }
  for (const id of sorted(acceptance?.missingObservedTests)) {
    if (!clauses.has(id)) continue;
    facts.push(fact('missing-bound-test', {
      clauseIds: [id],
      evidence: plannedClaims[id]?.tests,
      detail: `${id} has a planned test binding with no recorded result`
    }));
  }
  for (const command of sorted(acceptance?.failedCommands)) {
    facts.push(fact('failing-bound-test', {
      evidence: [command],
      detail: `bound acceptance command '${command}' did not pass`
    }));
  }
  for (const reason of sorted(acceptance?.staleRunReasons)) {
    facts.push(fact('failing-bound-test', { detail: `acceptance evidence is stale: ${reason}` }));
  }

  /**
   * A deviation recorded on either claim map, until someone accepts or removes it.
   *
   * Read from both rather than from a merged object. Spreading `{...planned, ...observed}` replaces
   * the whole planned claim with the observed one, so a deviation written at planning time — the
   * ordinary case, since a deviation is usually something you plan — disappeared the moment anyone
   * recorded an observation for that clause. Silently, and exactly when the clause mattered most.
   */
  const deviationIds = [...new Set([...Object.keys(plannedClaims), ...Object.keys(observedClaims)])].sort();
  for (const id of deviationIds) {
    const deviation = String(observedClaims[id]?.deviation ?? plannedClaims[id]?.deviation ?? '').trim();
    if (!deviation) continue;
    if (deviations.some((entry) => String(entry.clauseId).toUpperCase() === id.toUpperCase() && entry.accepted)) continue;
    facts.push(fact('unresolved-deviation', {
      clauseIds: [id],
      detail: `${id} records an unresolved deviation: ${deviation}`
    }));
  }

  // Evidence the phase contract requires and the record does not contain.
  for (const entry of requiredEvidence) {
    if (entry.present) continue;
    facts.push(fact('missing-required-evidence', {
      clauseIds: entry.clauseIds,
      evidence: entry.path ? [entry.path] : [],
      detail: `required ${entry.kind ?? 'evidence'} is missing${entry.path ? `: ${entry.path}` : ''}`
    }));
  }

  const ordered = facts.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const capped = capWithDisclosure(ordered, 'maxFacts', { limits: bounds, label: 'convergence facts' });
  if (capped.disclosure) disclosures.push(capped.disclosure);
  /**
   * A disclosure is itself a fact, so it travels with the list rather than beside it. A cap noted
   * in a return value the caller forgets to render is the silent truncation this avoids.
   */
  return disclosures.length
    ? [...capped.items, ...disclosures.map((detail) => fact('missing-required-evidence', { detail: `analysis was bounded: ${detail}` }))]
    : capped.items;
}

/**
 * Everything an iteration is bound to `[SPK:REQ-072]`.
 *
 * The binding is what makes an iteration re-checkable. Without it a convergence record is an opinion
 * about "the code", and nobody can tell later which code that was.
 */
function convergenceBindings({
  iteration, configurationSha256 = null, configurationRevision = null, constitutionSha256 = null,
  specification = null, planning = null, indexes = [], reconciliation, planned = [], observed = [],
  evidence = []
} = {}) {
  if (!Number.isInteger(iteration) || iteration < 1) throw new SingularityFlowError('Convergence iteration must be a positive integer.');
  if (!reconciliation?.reconciliationSha256) throw new SingularityFlowError('Convergence requires a reconciliation record hash.');
  return {
    iteration,
    configurationSha256,
    configurationRevision,
    constitutionSha256,
    specification: specification && { generation: specification.generation ?? null, sha256: specification.sha256 ?? null },
    planning: planning && { generation: planning.generation ?? null, sha256: planning.sha256 ?? null },
    clauseIndexSha256: sorted(indexes.map((index) => index.indexSha256)),
    reconciliation: {
      path: reconciliation.path ?? null,
      sha256: reconciliation.reconciliationSha256,
      intervalId: reconciliation.intervalId ?? null
    },
    sourceBaseCommit: reconciliation.sourceBaseCommit ?? null,
    sourceTargetCommit: reconciliation.target?.head ?? null,
    plannedClaimsSha256: sorted(planned.map((map) => map.recordSha256 ?? recordSha256(map))),
    observedClaimsSha256: sorted(observed.map((map) => map.recordSha256 ?? recordSha256(map))),
    evidenceSha256: sorted(evidence.map((entry) => entry.recordSha256 ?? entry.sha256).filter(Boolean))
  };
}

/**
 * Validate one human adjudication `[SPK:REQ-079]`.
 *
 * A reason is mandatory for every disposition except rework taken directly on a deterministic fact.
 * That exception is narrow and deliberate: "this fact is real, fix it" adds nothing a reader cannot
 * already see in the fact. Every other disposition is a decision to *not* act on something, and a
 * decision not to act is exactly the one that needs its reasoning on the record.
 */
function validateAdjudication(entry, { facts = [], candidates = [] } = {}) {
  const target = String(entry?.itemId ?? '').trim();
  if (!target) throw new SingularityFlowError('An adjudication must name the fact or candidate it disposes of.');
  const known = new Set([...facts.map((item) => item.id), ...candidates.map((item) => item.id)]);
  if (known.size && !known.has(target)) {
    throw new SingularityFlowError(`Adjudication references unknown convergence item '${target}'.`);
  }
  const disposition = entry?.disposition;
  if (!DISPOSITIONS.includes(disposition)) {
    throw new SingularityFlowError(`Adjudication disposition must be one of ${DISPOSITIONS.join(', ')}; got '${disposition}'.`);
  }
  const deterministic = facts.some((item) => item.id === target);
  const reason = String(entry?.reason ?? '').trim();
  if (!reason && !(deterministic && disposition === 'rework')) {
    throw new SingularityFlowError(
      `Disposition '${disposition}' on ${target} needs a human-authored reason.`
      + (deterministic ? '' : ' Only rework on a deterministic fact may go unexplained.')
    );
  }
  const classification = entry?.classification ?? null;
  if (classification !== null && !FINDING_CLASSIFICATIONS.includes(classification)) {
    throw new SingularityFlowError(`Finding classification must be one of ${FINDING_CLASSIFICATIONS.join(', ')}; got '${classification}'.`);
  }
  /**
   * An `update-intent` that does not say which clauses are wrong is an instruction nobody can act
   * on: the amendment it exists to trigger is computed from a clause set `[AMD:REQ-011]`, and the
   * blast radius from that. Every other disposition may leave the clause list empty, because none of
   * them asks the specification to change.
   */
  if (disposition === 'update-intent' && !sorted(entry?.clauseIds).length) {
    throw new SingularityFlowError(
      `Disposition 'update-intent' on ${target} must name the clause IDs the specification should change.`
      + ' Without them there is nothing for an amendment to revise.',
      { code: 'ADJUDICATION_CLAUSES_REQUIRED', details: { itemId: target } }
    );
  }
  return {
    itemId: target,
    source: deterministic ? 'deterministic' : 'assisted',
    disposition,
    ...(classification ? { classification } : {}),
    ...(reason ? { reason } : {}),
    clauseIds: sorted(entry?.clauseIds),
    actor: entry?.actor ?? null,
    at: entry?.at ?? null,
    ...(entry?.presence && typeof entry.presence === 'object' ? { presence: entry.presence } : {}),
    ...(entry?.replaced ? { replaced: validReplacedAnswers(entry.replaced, target) } : {})
  };
}

function validReplacedAnswers(replaced, target) {
  const whole = (answer) => DISPOSITIONS.includes(answer?.disposition) && typeof answer.actor === 'string' && typeof answer.at === 'string';
  if (!Array.isArray(replaced) || !replaced.length || !replaced.every(whole)) {
    throw new SingularityFlowError(`The answers ${target} replaced are not whole.`, { code: 'CONVERGENCE_RECORD_CORRUPT', details: { itemId: target } });
  }
  return replaced;
}

/**
 * What a changed answer keeps, oldest first: the answer it replaces with that answer's own signature, after
 * whatever that answer had already replaced. A person may change an answer; the record says they did.
 */
function replacedAnswers(earlier) {
  const { replaced = [], presence, itemId: _itemId, ...answer } = earlier;
  return [...replaced, { ...answer, ...(presence ? { presence } : {}) }];
}

/** A finding's adjudication as recorded and signed (SPEC-PSS-v1 §10.10), its presence block riding along. */
function findingAdjudication(finding) {
  const { actor, at, reason, presence, replaced } = finding?.decision ?? {};
  return { itemId: finding?.itemId, disposition: finding?.disposition, classification: finding?.classification,
    clauseIds: finding?.clauseIds, reason, actor, at, ...(presence ? { presence } : {}), ...(replaced ? { replaced } : {}) };
}

// A counted view (presence/counted-convergence.mjs) keeps the sealed projection it was read from.
const recordedConvergence = (projection) => projection?.[Symbol.for('singularity-flow.convergence-recorded')] ?? projection;

/**
 * A governed finding: an item plus the human decision about it. `[SPK:REQ-078]`
 *
 * Findings exist only where a human has spoken. An undisposed fact is a fact, not a finding — which
 * is what keeps `[SPK:CON-035]` true, since an assisted candidate cannot become governed by sitting
 * in the record long enough.
 */
function governedFindings(adjudications, { facts, candidates }) {
  const byId = new Map([...facts, ...candidates].map((item) => [item.id, item]));
  return adjudications.map((decision) => {
    const item = byId.get(decision.itemId) ?? null;
    const body = {
      source: decision.source,
      itemId: decision.itemId,
      kind: item?.kind ?? null,
      classification: decision.classification ?? item?.classification ?? null,
      clauseIds: sorted([...(decision.clauseIds ?? []), ...(item?.clauseIds ?? [])]),
      disposition: decision.disposition
    };
    return {
      id: itemId('GF', body),
      ...body,
      decision: { actor: decision.actor, at: decision.at, reason: decision.reason ?? null, ...(decision.presence ? { presence: decision.presence } : {}),
        ...(decision.replaced ? { replaced: decision.replaced } : {}) }
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * What the Story is allowed to do next `[SPK:REQ-081]`.
 *
 * Computed rather than configured, and deliberately never `advance` while anything is undisposed.
 * `[SPK:REQ-183]` asks that advancement be an explicit human action that fails with blockers open;
 * naming the legal transitions here is what lets a surface offer the right button instead of
 * discovering the refusal after the click.
 */
function allowedTransitions({ facts, candidates, findings, blockers }) {
  const disposed = new Set(findings.map((finding) => finding.itemId));
  const undisposed = [...facts, ...candidates].filter((item) => !disposed.has(item.id));
  const blockerFindings = findings.filter((finding) => blockers.includes(finding.id));
  const next = [];
  if (undisposed.length) next.push('adjudicate');
  if (blockerFindings.some((finding) => finding.disposition === 'rework')) next.push('create-rework');
  if (blockerFindings.some((finding) => finding.disposition === 'update-intent')) {
    next.push('propose-intent-amendment');
  }
  if (!undisposed.length && !blockers.length) next.push('advance-to-verification');
  return next;
}

/**
 * The authoritative `convergence.json` `[SPK:REQ-080]` `[SPK:REQ-081]`.
 *
 * A projection of bound inputs and recorded decisions, and nothing else. Model prose stays in the
 * referenced candidate record: the moment narrative text enters this document it becomes part of the
 * evidence hash, and improving a sentence would invalidate the iteration it described.
 */
function convergenceProjection({
  workId, bindings, facts = [], candidates = [], candidateRecords = [],
  candidateRecordBindings = [], legacyMigration = null, adjudications = [],
  // What the approved plan settled (family v5). Null only for a record from before v5, which asks every changed path.
  settledByPlan = []
} = {}) {
  if (!workId) throw new SingularityFlowError('A convergence projection requires the work item it belongs to.');
  // Nobody has to answer a settled path, and anyone in the group still may: a plan entry cannot overrule a person.
  const answerable = [...facts, ...(settledByPlan ?? [])];
  const validated = adjudications.map((entry) => validateAdjudication(entry, { facts: answerable, candidates }));
  const findings = governedFindings(validated, { facts: answerable, candidates });
  const blockers = findings.filter((finding) => BLOCKING.includes(finding.disposition)).map((finding) => finding.id);
  const record = {
    schemaVersion: CONVERGENCE_SCHEMA_VERSION,
    resultType: 'convergence',
    workId,
    iteration: bindings.iteration,
    bindings,
    // Facts carry their detail; candidates are referenced by ID only, with their prose in the
    // record named below `[SPK:REQ-080]`.
    facts,
    ...(settledByPlan ? { settledByPlan } : {}),
    candidates: candidates.map(({ id, classification, clauseIds }) => ({ id, classification, clauseIds })),
    candidateRecords: sorted(candidateRecords).map(posix),
    candidateRecordBindings: [...candidateRecordBindings]
      .map((binding) => ({ path: posix(binding.path), sha256: String(binding.sha256 ?? '') }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    legacyMigration: legacyMigration == null ? null : {
      path: posix(legacyMigration.path),
      recordSha256: String(legacyMigration.recordSha256 ?? '')
    },
    findings,
    unresolvedBlockers: blockers,
    allowedNext: allowedTransitions({ facts, candidates, findings, blockers })
  };
  return { ...record, convergenceSha256: recordSha256(convergenceHashCore(record)) };
}

/**
 * Rebuild a projection after a human decision without dropping any sealed source authority.
 *
 * Keeping this in the kernel (instead of reconstructing the shape in the command layer) makes the
 * legacy archive binding and complete assisted-candidate snapshot part of every new projection
 * seal. A decision can change findings; it cannot rewrite where the evidence came from.
 */
function adjudicatedConvergenceProjection(existing, adjudications) {
  return {
    ...convergenceProjection({
      workId: existing.workId,
      bindings: existing.bindings,
      facts: existing.facts ?? [],
      candidates: existing.candidateSnapshot ?? [],
      candidateRecords: existing.candidateRecords ?? [],
      candidateRecordBindings: existing.candidateRecordBindings ?? [],
      legacyMigration: existing.legacyMigration ?? null,
      adjudications,
      settledByPlan: existing.settledByPlan ?? null
    }),
    candidateSnapshot: existing.candidateSnapshot ?? []
  };
}

function convergenceIntegrityFailure(message, code = 'CONVERGENCE_RECORD_CORRUPT', details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

// Version 1 stored the complete assisted-candidate snapshot beside the sealed projection. The
// projection still binds every candidate through its content-derived ID; validate the complete
// snapshot independently below rather than silently changing the historical v1 hash contract.
const convergenceHashCore = convergenceSealCore;

/** What each settled path must hold whatever else is checked: its own identity, and an entry that says what settled it. */
function assertSettledByPlan(record) {
  const settled = record.settledByPlan;
  if (settled === undefined) return;
  if (!Array.isArray(settled)) convergenceIntegrityFailure('Convergence settledByPlan is not an array.', 'CONVERGENCE_SETTLED_INVALID');
  const facts = new Set((record.facts ?? []).map((entry) => entry?.id));
  const seen = new Set();
  for (const item of settled) {
    const { kind, clauseIds, paths, evidence, settledBy } = item ?? {};
    const identity=()=>{
      if(profile===CONVERGENCE_VALUES_PROFILE)return item.id===itemId('CF',{kind,clauseIds,paths,evidence});
      const originalId=itemId('CF',{kind,clauseIds,paths,evidence});
      return typeof item.repositoryId==='string'&&item.repositoryId.length>0&&item.originalId===originalId
        &&item.id===itemId('CF',{repositoryId:item.repositoryId,itemId:originalId});
    };
    if (kind !== 'unclaimed-changed-path' || paths?.length !== 1 || !identity()
        || !(settledBy?.kind === 'supporting' || (settledBy?.kind === 'amendment' && settledBy.id)) || settledBy.askedBecause
        || facts.has(item.id) || seen.has(item.id)) {
      convergenceIntegrityFailure(`Convergence settled path '${item?.id ?? 'unknown'}' is not one changed path a plan entry settled.`, 'CONVERGENCE_SETTLED_INVALID');
    }
    seen.add(item.id);
  }
}

function candidatePayload(candidate, index) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    convergenceIntegrityFailure(`Convergence candidate snapshot entry ${index + 1} is not an object.`);
  }
  const classification = String(candidate.classification ?? '').trim();
  if (!FINDING_CLASSIFICATIONS.includes(classification)) {
    convergenceIntegrityFailure(
      `Convergence candidate snapshot entry ${index + 1} has invalid classification '${classification}'.`
    );
  }
  const text = String(candidate.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) convergenceIntegrityFailure(`Convergence candidate snapshot entry ${index + 1} has no text.`);
  const payload = {
    classification,
    clauseIds: sorted(candidate.clauseIds).map((id) => id.toUpperCase()),
    evidence: sorted(candidate.evidence).map(posix),
    factIds: sorted(candidate.factIds),
    text
  };
  if (candidate.id !== itemId('CC', payload)) {
    convergenceIntegrityFailure(
      `Convergence candidate '${candidate.id ?? `at position ${index + 1}`}' does not match its complete content-derived identity.`
    );
  }
  return { id: candidate.id, ...payload };
}

/**
 * Verify the exact stored convergence projection before any human decision can consume it.
 *
 * The v1 projection hash intentionally excludes the complete candidate prose, but its compact
 * candidate row contains a content-derived ID. Recomputing that ID from the full snapshot closes
 * the other half of the binding: changed prose/evidence cannot remain attached to the old ID.
 */
function assertConvergenceIntegrity(record, {
  workId = null, iteration = null, currentBindings = null, currentFacts = null, currentSettlement = null
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    convergenceIntegrityFailure('Convergence record is not an object.');
  }
  if (record.resultType !== 'convergence') {
    convergenceIntegrityFailure(`Convergence record has resultType '${record.resultType ?? 'missing'}'.`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(record.convergenceSha256 ?? ''))) {
    convergenceIntegrityFailure('Convergence record has no valid convergenceSha256.');
  }
  const computedSha256 = recordSha256(convergenceHashCore(record));
  if (record.convergenceSha256 !== computedSha256) {
    convergenceIntegrityFailure(
      `Convergence record hash mismatch: stored ${record.convergenceSha256}, computed ${computedSha256}.`,
      'CONVERGENCE_RECORD_HASH_MISMATCH',
      { storedSha256: record.convergenceSha256, computedSha256 }
    );
  }
  if (workId != null && record.workId !== workId) {
    convergenceIntegrityFailure(`Convergence record belongs to '${record.workId}', not '${workId}'.`);
  }
  if (iteration != null && Number(record.iteration) !== Number(iteration)) {
    convergenceIntegrityFailure(
      `Convergence record is iteration ${record.iteration}, not current iteration ${iteration}.`
    );
  }
  if (Number(record.bindings?.iteration) !== Number(record.iteration)) {
    convergenceIntegrityFailure('Convergence record iteration does not match its bound iteration.');
  }

  const snapshot = record.candidateSnapshot ?? [];
  if (!Array.isArray(snapshot)) {
    convergenceIntegrityFailure('Convergence candidateSnapshot is not an array.');
  }
  if (snapshot.length === 0 && (record.candidates ?? []).length > 0) {
    convergenceIntegrityFailure('Convergence record has compact candidates but no complete candidate snapshot.');
  }
  const complete = snapshot.map(candidatePayload);
  const ids = complete.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) {
    convergenceIntegrityFailure('Convergence candidate snapshot contains duplicate candidate IDs.');
  }
  const compact = complete.map(({ id, classification, clauseIds }) => ({ id, classification, clauseIds }));
  if (canonicalJson(compact) !== canonicalJson(record.candidates ?? [])) {
    convergenceIntegrityFailure(
      'Convergence compact candidates do not match the complete candidate snapshot.',
      'CONVERGENCE_CANDIDATE_SNAPSHOT_MISMATCH'
    );
  }

  const factIds = (record.facts ?? []).map((entry) => entry?.id);
  if (factIds.some((id) => typeof id !== 'string') || new Set(factIds).size !== factIds.length) {
    convergenceIntegrityFailure('Convergence facts contain missing or duplicate identities.');
  }
  assertSettledByPlan(record);
  if (!Array.isArray(record.findings)) {
    convergenceIntegrityFailure('Convergence findings are not an array.');
  }
  const findingItemIds = record.findings.map((finding) => finding?.itemId);
  if (findingItemIds.some((id) => typeof id !== 'string')
      || new Set(findingItemIds).size !== findingItemIds.length) {
    convergenceIntegrityFailure('Convergence findings contain missing or duplicate item identities.');
  }
  const adjudications = record.findings.map((finding) => {
    const actor = finding?.decision?.actor;
    const at = finding?.decision?.at;
    if (typeof actor !== 'string' || !actor.trim()) {
      convergenceIntegrityFailure(`Convergence finding '${finding?.id ?? 'unknown'}' has no human decision identity.`);
    }
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)
        || Number.isNaN(Date.parse(at))) {
      convergenceIntegrityFailure(`Convergence finding '${finding?.id ?? 'unknown'}' has no valid decision timestamp.`);
    }
    return findingAdjudication(finding);
  });
  const derived = convergenceProjection({
    workId: record.workId,
    bindings: record.bindings,
    facts: record.facts ?? [],
    candidates: complete,
    candidateRecords: record.candidateRecords ?? [],
    candidateRecordBindings: record.candidateRecordBindings ?? [],
    legacyMigration: record.legacyMigration ?? null,
    adjudications,
    settledByPlan: record.settledByPlan ?? null
  });
  for (const field of ['findings', 'unresolvedBlockers', 'allowedNext']) {
    if (canonicalJson(record[field] ?? []) !== canonicalJson(derived[field] ?? [])) {
      convergenceIntegrityFailure(
        `Convergence ${field} is not the deterministic projection of its facts and human decisions.`,
        'CONVERGENCE_DERIVED_STATE_MISMATCH',
        { field }
      );
    }
  }

  const candidateRecords = sorted(record.candidateRecords).map(posix);
  const sourceBindings = record.candidateRecordBindings ?? [];
  if (!Array.isArray(sourceBindings)
      || sourceBindings.some((binding) => !binding || typeof binding !== 'object'
        || !candidateRecords.includes(posix(String(binding.path ?? '')))
        || !/^[0-9a-f]{64}$/.test(String(binding.sha256 ?? '')))
      || sourceBindings.length !== candidateRecords.length
      || new Set(sourceBindings.map((binding) => posix(binding.path))).size !== candidateRecords.length) {
    convergenceIntegrityFailure(
      'Convergence candidate records are not bound to exact provenance digests.',
      'CONVERGENCE_CANDIDATE_RECORD_BINDING_MISSING'
    );
  }
  if (record.legacyMigration != null) {
    const migration = record.legacyMigration;
    const migrationPath = String(migration?.path ?? '');
    const normalizedMigrationPath = posix(migrationPath);
    const migrationSegments = normalizedMigrationPath.split('/');
    if (!migration || typeof migration !== 'object' || Array.isArray(migration)
        || Object.keys(migration).sort().join(',') !== 'path,recordSha256'
        || !normalizedMigrationPath || normalizedMigrationPath !== migrationPath
        || migrationSegments.some((segment) => !segment || segment === '.' || segment === '..')
        || !/\/context\/convergence\/legacy\/iteration-\d+-[0-9a-f]{64}\.json$/.test(normalizedMigrationPath)
        || !/^[0-9a-f]{64}$/.test(String(migration.recordSha256 ?? ''))) {
      convergenceIntegrityFailure(
        'Convergence legacy migration is not bound to one exact archive record.',
        'CONVERGENCE_LEGACY_ARCHIVE_BINDING_INVALID'
      );
    }
  }

  if (currentBindings && canonicalJson(record.bindings) !== canonicalJson(currentBindings)) {
    convergenceIntegrityFailure(
      'Convergence bindings no longer match the current approved inputs.',
      'CONVERGENCE_BINDINGS_STALE',
      {
        storedBindingsSha256: recordSha256(record.bindings),
        currentBindingsSha256: recordSha256(currentBindings)
      }
    );
  }
  if (currentFacts) {
    // A record from before v5 asked about every changed path, so that whole list is what it is held to.
    const expected = record.settledByPlan === undefined ? (currentSettlement?.everyFact ?? currentFacts) : currentFacts;
    const settledMoved = record.settledByPlan !== undefined
      && canonicalJson(record.settledByPlan) !== canonicalJson(currentSettlement?.settled ?? []);
    if (settledMoved || canonicalJson(record.facts ?? []) !== canonicalJson(expected)) {
      convergenceIntegrityFailure(
        'Convergence facts no longer match the deterministic result for the current approved inputs. Prepare the convergence step again before publishing, adjudicating, or advancing.',
        'CONVERGENCE_FACTS_STALE',
        {
          storedFactsSha256: recordSha256(record.facts ?? []),
          currentFactsSha256: recordSha256(expected)
        }
      );
    }
  }
  return record;
}

/** Verify the complete candidate snapshot against the assisted record that produced it. */
function assertConvergenceCandidateSource(source, projection, { path: sourcePath = null } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    convergenceIntegrityFailure('Assisted convergence candidate record is not an object.');
  }
  if (source.resultType !== 'convergence-candidates'
      || source.workId !== projection.workId
      || Number(source.iteration) !== Number(projection.iteration)) {
    convergenceIntegrityFailure(
      'Assisted convergence candidate record does not belong to this Story iteration.',
      'CONVERGENCE_CANDIDATE_RECORD_MISMATCH'
    );
  }
  const sourceCore = structuredClone(source);
  delete sourceCore.recordSha256;
  const computedSourceSha256 = recordSha256(sourceCore);
  if (!/^[0-9a-f]{64}$/.test(String(source.recordSha256 ?? ''))
      || source.recordSha256 !== computedSourceSha256) {
    convergenceIntegrityFailure(
      'Assisted convergence candidate provenance has changed since it was recorded.',
      'CONVERGENCE_CANDIDATE_RECORD_HASH_MISMATCH',
      { storedSha256: source.recordSha256 ?? null, computedSha256: computedSourceSha256 }
    );
  }
  if (sourcePath != null) {
    const normalizedPath = posix(sourcePath);
    const binding = (projection.candidateRecordBindings ?? [])
      .find((entry) => posix(entry.path) === normalizedPath);
    if (!binding || binding.sha256 !== source.recordSha256) {
      convergenceIntegrityFailure(
        `Assisted convergence candidate record '${normalizedPath}' does not match its sealed projection binding.`,
        'CONVERGENCE_CANDIDATE_RECORD_BINDING_MISMATCH',
        { path: normalizedPath, expectedSha256: binding?.sha256 ?? null, currentSha256: source.recordSha256 }
      );
    }
  }
  const expectedDeterministic = {
    reconciliationSha256: projection.bindings?.reconciliation?.sha256 ?? null,
    sourceTargetCommit: projection.bindings?.sourceTargetCommit ?? null,
    clauseIndexSha256: projection.bindings?.clauseIndexSha256 ?? [],
    factIds: (projection.facts ?? []).map((item) => item.id)
  };
  if (canonicalJson(source.deterministic ?? null) !== canonicalJson(expectedDeterministic)) {
    convergenceIntegrityFailure(
      'Assisted convergence candidate record is bound to different deterministic inputs.',
      'CONVERGENCE_CANDIDATE_BINDINGS_STALE'
    );
  }
  if (canonicalJson(source.candidates ?? []) !== canonicalJson(projection.candidateSnapshot ?? [])) {
    convergenceIntegrityFailure(
      'The complete convergence candidate snapshot does not match its assisted source record.',
      'CONVERGENCE_CANDIDATE_SNAPSHOT_MISMATCH'
    );
  }
  return source;
}

function markdownCell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replaceAll('|', '\\|').trim() || '—';
}

function planEntryWords(entry) {
  const source = entry.kind === 'amendment'
    ? `${entry.id}${entry.clause ? ` under ${entry.clause}` : ''}`
    : `Supporting file${entry.phase ? ` of ${entry.phase} generation ${entry.generation}` : ''}`;
  return `${source}${entry.class ? ` · ${entry.class}` : ''}${entry.text ? `: ${markdownCell(entry.text)}` : ''}`;
}

// Absent for a record with nothing settled, so every report written before this reads as it did.
function settledSection(projection) {
  const settled = projection.settledByPlan ?? [];
  return settled.length ? [
    '## Settled by the approved plan',
    '',
    'These changed paths no claim cites are ones the approved plan already accounts for, so no person is asked about them again.',
    '',
    ...settled.map((item) => `- **${item.id}** · ${markdownCell(item.paths.join(', '))} · ${planEntryWords(item.settledBy)}`),
    ''
  ] : [];
}

/** Deterministic human-readable projection used as the convergence phase artifact. */
/** Each answer a person replaced and what it became. Nothing at all when no answer changed, so older reports read the same. */
function changedAnswerLines(projection) {
  const rows = (projection.findings ?? []).flatMap((finding) => {
    const answers = [...(finding.decision?.replaced ?? []), { ...finding.decision, disposition: finding.disposition }];
    return answers.slice(0, -1).map((answer, index) => `| ${markdownCell(finding.id)} | ${markdownCell(finding.itemId)} | ${markdownCell(answer.disposition)} | ${markdownCell(answer.reason)} | ${markdownCell(answer.actor)} | ${markdownCell(answer.at)} | ${markdownCell(`${answers[index + 1].disposition} by ${answers[index + 1].actor}`)} |`);
  });
  if (!rows.length) return [];
  return ['## Changed answers', '', 'A person may change an answer. The answer in force is in the table above; each one it replaced stays here.', '',
    '| Finding | Item | Earlier answer | Reason | Given by | Given at | Changed to |', '|---|---|---|---|---|---|---|', ...rows, ''];
}

function renderConvergenceArtifact(projection) {
  assertConvergenceIntegrity(projection);
  const candidates = projection.candidateSnapshot ?? [];
  const lines = [
    `# Convergence — ${projection.workId}`,
    '',
    '> Deterministically rendered from the kernel-owned convergence projection. No model authored this artifact.',
    '',
    '## Iteration',
    '',
    `- Iteration: **${projection.iteration}**`,
    `- Projection SHA-256: \`${projection.convergenceSha256}\``,
    `- Reconciliation SHA-256: \`${projection.bindings.reconciliation.sha256}\``,
    `- Source target: \`${projection.bindings.sourceTargetCommit ?? 'unavailable'}\``,
    '',
    '## Deterministic facts',
    '',
    ...(projection.facts?.length
      ? projection.facts.map((fact) => `- **${fact.id}** · ${fact.kind}${fact.clauseIds?.length ? ` · ${fact.clauseIds.join(', ')}` : ''}: ${markdownCell(fact.detail)}`)
      : ['- No deterministic trace-evidence gaps were found.']),
    '',
    ...settledSection(projection),
    '## Assisted candidates',
    '',
    ...(candidates.length
      ? candidates.map((candidate) => `- **${candidate.id}** · ${candidate.classification}${candidate.clauseIds?.length ? ` · ${candidate.clauseIds.join(', ')}` : ''}: ${markdownCell(candidate.text)}`)
      : ['- No assisted candidates are bound to this iteration.']),
    '',
    '## Findings and dispositions',
    '',
    '| Finding | Item | Clauses | Disposition | Reason |',
    '|---|---|---|---|---|',
    ...(projection.findings?.length
      ? projection.findings.map((finding) => `| ${markdownCell(finding.id)} | ${markdownCell(finding.itemId)} | ${markdownCell(finding.clauseIds?.join(', '))} | ${markdownCell(finding.disposition)} | ${markdownCell(finding.decision?.reason)} |`)
      : ['| — | — | — | — | No human dispositions recorded. |']),
    '',
    ...changedAnswerLines(projection),
    '## Unresolved blockers',
    '',
    ...(projection.unresolvedBlockers?.length
      ? projection.unresolvedBlockers.map((id) => `- \`${id}\``)
      : ['- None.']),
    '',
    '## Allowed next actions',
    '',
    ...(projection.allowedNext?.length
      ? projection.allowedNext.map((action) => `- \`${action}\``)
      : ['- None.']),
    ''
  ];
  return lines.join('\n');
}

function normalizedConvergenceArtifactBody(value) {
  return String(value ?? '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Refuse publication until the deterministic projection has been reviewed to a terminal state and
 * the authored artifact bytes are still its canonical rendering.
 *
 * Guidance alone is not an authorization boundary: a caller can always invoke `phase publish`
 * directly. Keeping this check in the publication path prevents an undisposed projection or a
 * hand-edited narrative from consuming the generation intent and trapping the Story in a recovery
 * loop.
 */
function assertConvergencePublishable(projection, authoredArtifactBody) {
  assertConvergenceIntegrity(recordedConvergence(projection));
  const allowed = projection.allowedNext ?? [];
  const disposed = new Set((projection.findings ?? []).map((finding) => finding.itemId));
  const candidateItems = (projection.candidateSnapshot ?? []).length
    ? projection.candidateSnapshot
    : projection.candidates ?? [];
  const undisposedItemIds = [...(projection.facts ?? []), ...candidateItems]
    .map((item) => item.id)
    .filter((id) => !disposed.has(id));
  if (!allowed.includes('advance-to-verification')
      || (projection.unresolvedBlockers ?? []).length > 0) {
    throw new SingularityFlowError(
      `Convergence iteration ${projection.iteration} has not completed human review. `
      + `Allowed next action${allowed.length === 1 ? ' is' : 's are'}: ${allowed.join(', ') || 'none'}. `
      + 'Record the required adjudications or rework, then prepare the convergence step again.',
      {
        code: 'CONVERGENCE_REVIEW_REQUIRED',
        details: {
          iteration: projection.iteration,
          allowedNext: allowed,
          undisposedItemIds,
          unresolvedBlockers: projection.unresolvedBlockers ?? [],
          ...(projection.uncountedFindings?.length ? { uncountedFindings: projection.uncountedFindings } : {})
        }
      }
    );
  }
  const expected = normalizedConvergenceArtifactBody(renderConvergenceArtifact(projection));
  const actual = normalizedConvergenceArtifactBody(authoredArtifactBody);
  if (actual !== expected) {
    throw new SingularityFlowError(
      'The convergence artifact no longer matches the reviewed deterministic projection. '
      + 'Prepare the convergence step again to restore the canonical artifact before publishing.',
      {
        code: 'CONVERGENCE_ARTIFACT_MISMATCH',
        details: {
          iteration: projection.iteration,
          projectionSha256: projection.convergenceSha256
        }
      }
    );
  }
  return projection;
}

/** Canonical bytes, so an unchanged iteration rewrites identically `[SPK:REQ-075]`. */
function serializeConvergence(record) {
  return canonicalJson(record);
}

/** Authority and record readers supply these entries; a matching pathname alone grants nothing. */
function planAccountsFromEntries(entries,{keptByPerson=new Set()}={}){
  const ordered=[...entries].sort((left,right)=>Number(right.approved)-Number(left.approved));
  return finding=>{
    const read=ordered.filter(({file})=>file===posix(finding.path)).map(candidate=>{
      const askedBecause=stillAsked(finding,candidate,keptByPerson);
      return askedBecause?{...candidate.entry,askedBecause}:candidate.entry;
    });
    return read.find(entry=>!entry.askedBecause)??read[0]??null;
  };
}

/** Preserve the approved plan's answer only while the actual path evidence still matches it. */
function stillAsked(finding,{problem,entry},keptByPerson){
  if(problem)return problem;
  if(!keptByPerson)return 'the record of an earlier iteration cannot be read, so a person may have sent it back';
  if(keptByPerson.has(posix(finding.path)))return 'a person sent it back in an earlier iteration, so it is theirs to answer again';
  if(finding.protected)return 'it is a protected path';
  if(finding.status==='deleted')return 'the file was deleted, which the entry does not record';
  if(finding.status!=='present')return 'reconciliation does not record it as an ordinary file';
  if(entry.sha256&&finding.sha256!==entry.sha256)return `the file changed after ${entry.id} accounted for it`;
  if(finding.clauseIds?.length)return `${finding.clauseIds.join(', ')} expected it and no observed claim cites it`;
  if(entry.class){const classified=classifySupportingChange(finding.path);
    if(classified.refused)return classified.reason;
    if(classified.class!==entry.class)return `the entry lists it as ${entry.class}, and the path is ${classified.class}`;}
  return null;
}

function settleChangedPaths(facts,{reconciliation,planAccount}){
  const findings=new Map((reconciliation?.findings??[]).map(finding=>[posix(finding.path),finding])),asked=[],settled=[];
  for(const item of facts){const finding=item.kind==='unclaimed-changed-path'&&item.paths.length===1?findings.get(item.paths[0]):null,
    account=finding?planAccount(finding):null;
    if(account&&!account.askedBecause)settled.push({...item,settledBy:account});else asked.push(item);}
  return {facts:asked,settled};
}

return Object.freeze({itemId,convergenceFacts,convergenceBindings,validateAdjudication,replacedAnswers,findingAdjudication,convergenceProjection,adjudicatedConvergenceProjection,assertConvergenceIntegrity,assertConvergenceCandidateSource,renderConvergenceArtifact,assertConvergencePublishable,serializeConvergence,planAccountsFromEntries,settleChangedPaths});
}
