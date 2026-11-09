import {SPECIFICATION_CLAIM_TIMESTAMP_REQUEST} from './kernel/specification-values.mjs';
import {normalizeClaimMapReplay,inspectPlannedClaimMapReplay,derivePlannedClaimMapReplay,deriveObservedClaimMapReplay} from './engine-compatibility/node-specification-policy.mjs';
export {FULFILLMENT_TYPES} from './kernel/specification-values.mjs';
import {testOnlyClaimEvidence} from './engine-compatibility/node-specification-policy.mjs';
export {validatePlannedEvidenceTypes,planSupportingFiles,testOnlyClaimEvidence} from './engine-compatibility/node-specification-policy.mjs';
import {canonicalJson,canonicalize} from './foundation/record-schema.mjs';
export {canonicalJson} from './foundation/record-schema.mjs';
export {ignoredRanges,isIgnored,clauseReferences,plannedClaimSource} from './kernel/specification-values.mjs';
import {extractClauses,specificationIndexRecord} from './engine-compatibility/node-specification-policy.mjs';
export {extractClauses} from './engine-compatibility/node-specification-policy.mjs';
import {plannedImplementationPaths,plannedSupportingFiles} from './engine-compatibility/node-source-policy.mjs';
export {plannedImplementationPaths,plannedProductSourcePaths,plannedSupportingFiles} from './engine-compatibility/node-source-policy.mjs';
import { isSpecificationDefinitionPhase, skillPhasePrimaryOutputRole } from './kernel/specification-policy.mjs';
export { isSpecificationDefinitionPhase, skillPhasePrimaryOutputRole, SPECIFICATION_DEFINITION_KINDS } from './kernel/specification-policy.mjs';
import { normalizeSpecPolicy } from './kernel/configuration-policy.mjs';
export { normalizeSpecPolicy } from './kernel/configuration-policy.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, readlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  SingularityFlowError, exists, nowIso, posix, run, secureRepositoryPath, snapshot, writeJson
} from './util.mjs';
import {
  applicationPathContext, isApplicationChangePath, isApplicationPath
} from './engine-compatibility/node-source-policy.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { accountedAmendmentPaths, planAmendmentRecord } from './plan-amendments.mjs';
import {mergedVerificationContracts} from './engine-compatibility/node-specification-policy.mjs';
import {nonTestVerification} from './kernel/verification-policy.mjs';
import { verifyPlanEvidenceAmendments } from './plan-evidence-amendments.mjs';
import { applyPlanCorrections } from './plan-row-corrections.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameDigest(left, right) {
  return String(left ?? '').replace(/^sha256:/, '') === String(right ?? '').replace(/^sha256:/, '');
}

/**
 * How code steps answer for clause coverage. Enforced coverage refuses there. Recorded coverage on
 * a Story whose conformance report has qualified rows is told there what its ending will refuse (an
 * unimplemented, withdrawn or invalidly evidenced clause; an unclaimed path only warns there), as a
 * warning: an incomplete generation is legitimate while a convergence review or a later step can
 * still deliver it, and the code step is where its owner can see it [gate parity].
 */
export function codeCoverageEnforcement(policy) {
  if (policy?.coverage === 'enforce') return 'enforce';
  if (policy?.coverage === 'record' && (policy.conformanceRows ?? 'qualified') === 'qualified') return 'qualified-ending';
  return null;
}

export async function buildSpecIndex(root, artifact, {
  workId, phase, generation = 0, outputPath = null, policy = {}, write = true,
  externalClauseIds = [], externalClauses = []
} = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const source = await secureRepositoryPath(root, artifact, {
    label: 'Specification artifact', mustExist: true, type: 'file'
  });
  const markdown = await readFile(source.absolute, 'utf8');
  const sourceSnapshot = await snapshot(source.absolute);
  const clauses = extractClauses(markdown, {
    sourcePath: source.relative,
    namespace: normalized.namespace,
    limits: normalized.limits,
    externalClauseIds,
    externalClauses
  });
  const index = specificationIndexRecord({workId,phase,generation,
    source:{path:source.relative,sha256:sourceSnapshot.sha256,bytes:sourceSnapshot.size},clauses});
  if (write && outputPath) await writeJson(path.join(root, outputPath), canonicalize(index));
  return index;
}
/** Fulfillment types that change product source, so the delivery carries the clause in that source. */
import {SOURCE_CHANGING_FULFILLMENT,recordOrder,sortedUnique,mergePlannedClaimRecords} from './kernel/specification-policy.mjs';
export {SOURCE_CHANGING_FULFILLMENT,mergePlannedClaimRecords} from './kernel/specification-policy.mjs';

/** Native compatibility clock adapter. All validation/order and candidate values belong to the kernel. */
function nativeSpecificationClaimValue(replay) {
  let step=replay.next();
  while(!step.done) {
    if(step.value!==SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)throw new SingularityFlowError('Unsupported specification claim value request.',{code:'ENGINE_PORT_RESULT_INVALID'});
    let timestamp;
    try {timestamp=nowIso();}catch(error){step=replay.throw(error);continue;}
    step=replay.next(timestamp);
  }
  return step.value;
}
export function normalizeClaimMap(value,options={}) {return nativeSpecificationClaimValue(normalizeClaimMapReplay(value,options));}
export function inspectPlannedClaimMap(markdown,options={}) {return nativeSpecificationClaimValue(inspectPlannedClaimMapReplay(markdown,options));}
export function derivePlannedClaimMap(markdown,options={}) {return nativeSpecificationClaimValue(derivePlannedClaimMapReplay(markdown,options));}
export function deriveObservedClaimMap(plannedMap,delivery={},options={}) {return nativeSpecificationClaimValue(deriveObservedClaimMapReplay(plannedMap,delivery,options));}

export async function readStructuredFile(root, relative) {
  const file = await secureRepositoryPath(root, relative, { label: 'Structured specification file', mustExist: true, type: 'file' });
  const text = await readFile(file.absolute, 'utf8');
  return file.relative.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
}

async function jsonFiles(directory) {
  if (!(await exists(directory))) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await jsonFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.json')) output.push(absolute);
  }
  return output.sort();
}

export async function loadSpecRecords(itemDirectory) {
  const indexes = [];
  const planned = [];
  const observed = [];
  const acceptance = [];
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'spec-indexes'))) indexes.push(readRecord('specification-index', await readFile(file)).record);
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'claims'))) {
    const value = readRecord('specification-claim-map', await readFile(file)).record;
    (value.kind === 'observed' ? observed : planned).push(value);
  }
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'acceptance'))) acceptance.push(readRecord('specification-acceptance', await readFile(file)).record);
  return { indexes, planned, observed, acceptance };
}

function expectedClaimMapPath(root, itemDirectory, phase, kind) {
  return posix(path.relative(root, path.join(
    itemDirectory, 'context', 'claims', `${phase.id}-gen${phase.generation}-${kind}.json`
  )));
}

function assertCommittedInputBytes(root, relative, label) {
  const current = run('git', ['hash-object', '--', relative], { cwd: root, allowFailure: true });
  const committed = run('git', ['rev-parse', '--verify', `HEAD:${relative}`], {
    cwd: root, allowFailure: true
  });
  if (current.status !== 0 || committed.status !== 0
      || current.stdout.trim() !== committed.stdout.trim()) {
    throw new SingularityFlowError(
      `${label} is not the exact version committed with the approved Story state.`,
      { code: 'SPECIFICATION_INPUT_NOT_COMMITTED', details: { path: relative } }
    );
  }
}

function expectedSpecIndexPath(root, itemDirectory, phase) {
  return posix(path.relative(root, path.join(
    itemDirectory, 'context', 'spec-indexes', `${phase.id}-gen${phase.generation}.json`
  )));
}

export async function readBoundSpecificationIndex(root, itemDirectory, workflow, phase, {
  requireCommitted = false
} = {}) {
  return readSpecificationIndexBinding(root, itemDirectory, workflow, phase, { requireCommitted, approvedSource: true });
}

/**
 * The index a step awaiting approval submitted, with every binding check except its source bytes:
 * submission rewrites the artifact's managed status block, and approval re-binds the index to the
 * approved bytes. For previews of what approval will make true only; never evidence.
 */
export async function readSubmittedSpecificationIndex(root, itemDirectory, workflow, phase) {
  if (phase?.status !== 'awaiting_approval') {
    throw new SingularityFlowError(`Phase '${phase?.id ?? 'unknown'}' is not awaiting approval.`, { code: 'SPECIFICATION_INDEX_NOT_SUBMITTED' });
  }
  return readSpecificationIndexBinding(root, itemDirectory, workflow, phase, { approvedSource: false });
}

async function readSpecificationIndexBinding(root, itemDirectory, workflow, phase, { requireCommitted = false, approvedSource = true }) {
  const pointer = phase?.specIndex;
  if (!pointer) {
    throw new SingularityFlowError(
      `Phase '${phase?.id ?? 'unknown'}' has no authoritative specification-index binding.`,
      { code: 'SPECIFICATION_INDEX_BINDING_REQUIRED' }
    );
  }
  const expectedPath = expectedSpecIndexPath(root, itemDirectory, phase);
  if (pointer.path !== expectedPath || Number(pointer.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' specification-index binding is stale.`,
      { code: 'SPECIFICATION_INDEX_BINDING_STALE' }
    );
  }
  const boundary = await secureRepositoryPath(root, pointer.path, {
    label: `Specification index for phase '${phase.id}'`, mustExist: true, type: 'file'
  });
  if (requireCommitted) {
    assertCommittedInputBytes(root, boundary.relative, `Specification index for phase '${phase.id}'`);
  }
  const index = readRecord('specification-index', await readFile(boundary.absolute)).record;
  const withoutHash = { ...index };
  delete withoutHash.indexSha256;
  const computedIndexSha256 = sha256(canonicalJson(withoutHash));
  const expectedSourcePath = posix(path.relative(root, path.join(
    itemDirectory, phase.requiredArtifact?.path ?? ''
  )));
  if (index.workId !== workflow.workItem.id
      || index.phase !== phase.id
      || Number(index.generation) !== Number(phase.generation)
      || !sameDigest(index.indexSha256, computedIndexSha256)
      || !sameDigest(pointer.indexSha256, computedIndexSha256)
      || Number(pointer.clauses) !== Number(index.clauses?.length ?? 0)
      || index.source?.path !== expectedSourcePath
      || !sameDigest(pointer.sourceSha256, index.source?.sha256)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' specification index does not match its exact workflow binding.`,
      { code: 'SPECIFICATION_INDEX_UNTRUSTED', details: { phase: phase.id, path: boundary.relative } }
    );
  }
  if (!approvedSource) return index;
  const source = await secureRepositoryPath(root, index.source.path, {
    label: `Specification source for phase '${phase.id}'`, mustExist: true, type: 'file'
  });
  if (requireCommitted) {
    assertCommittedInputBytes(root, source.relative, `Specification source for phase '${phase.id}'`);
  }
  const current = await snapshot(source.absolute);
  const approved = (phase.artifacts ?? []).find((artifact) => artifact.path === source.relative);
  if (!sameDigest(current.sha256, index.source.sha256)
      || Number(current.size) !== Number(index.source.bytes)
      || !approved
      || approved.status !== 'approved'
      || !sameDigest(approved.sha256, current.sha256)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' specification source changed after its approved index was recorded.`,
      { code: 'SPECIFICATION_INDEX_UNTRUSTED', details: { phase: phase.id, path: source.relative } }
    );
  }
  return index;
}

/**
 * Read one claim map through the workflow aggregate's authoritative pointer.
 *
 * The directory is audit storage, not an authority index. Current planned-claim Stories therefore
 * bind every live claim through `phase.claimMaps`; otherwise an extra JSON file can participate in
 * terminal arithmetic merely by naming the current work item, phase, and generation.
 */
export async function readBoundSpecificationClaimMap(root, itemDirectory, workflow, phase, kind, {
  clauseIds = [], policy = {}, requireCommitted = false, plannedClaims = {}
} = {}) {
  if (!['planned', 'observed'].includes(kind)) {
    throw new SingularityFlowError(`Claim-map binding kind must be planned or observed.`);
  }
  const pointer = phase?.claimMaps?.[kind];
  if (!phase || !pointer) {
    throw new SingularityFlowError(
      `Phase '${phase?.id ?? 'unknown'}' has no authoritative ${kind} claim-map binding.`,
      { code: 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED' }
    );
  }
  const expectedPath = expectedClaimMapPath(root, itemDirectory, phase, kind);
  if (pointer.path !== expectedPath || Number(pointer.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' ${kind} claim-map binding is stale.`,
      { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' }
    );
  }
  const boundary = await secureRepositoryPath(root, pointer.path, {
    label: `Phase '${phase.id}' ${kind} claim map`, mustExist: true, type: 'file'
  });
  if (requireCommitted) {
    assertCommittedInputBytes(root, boundary.relative, `Phase '${phase.id}' ${kind} claim map`);
  }
  const raw = JSON.parse(await readFile(boundary.absolute, 'utf8'));
  if (sha256(canonicalJson(raw)) !== pointer.sha256) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' ${kind} claim map changed after publication.`,
      { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' }
    );
  }
  const record = readRecord('specification-claim-map', raw).record;
  if (record.kind !== kind
      || record.workId !== workflow?.workItem?.id
      || record.phase !== phase.id
      || Number(record.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `${kind} specification claim map does not bind ${workflow?.workItem?.id ?? 'unknown'}/${phase.id} generation ${phase.generation}.`,
      { code: 'SPECIFICATION_CLAIM_MAP_IDENTITY_INVALID' }
    );
  }
  // Schema migration proves readability; normalization enforces the pinned clause and path bounds.
  normalizeClaimMap(record, { kind, clauseIds, policy, plannedClaims });
  if (kind === 'planned') {
    const itemRoot = posix(path.relative(root, itemDirectory));
    await verifyPlanEvidenceAmendments(root, workflow, itemRoot);
    return applyPlanCorrections(record, workflow, { evidenceRoot: `${itemRoot}/evidence` });
  }
  return record;
}





/** Merge planned evidence cumulatively across multiple code intervals. */
/**
 * Every supporting file the planned claim maps list, once each — limited to paths of a supporting
 * class, so a plan written before the classes existed, or a hand-written map, cannot exempt
 * application source, tests or migrations from requirement accounting.
 */




/** A code step can use only its bound plan owner's fulfillment, never another step's plan. */
export function plannedClaimsForObservedPhase(workflow, phaseId, planned = []) {
  const policy = workflow?.resolution?.plannedClaims;
  const owner = policy?.owners?.[phaseId];
  const owned = policy?.mode === 'required'
    ? (owner ? planned.filter((record) => record.phase === owner) : []) : planned;
  return mergePlannedClaimRecords(owned);
}

/**
 * Merge observed evidence cumulatively instead of letting a later interval's empty/missing result
 * erase an earlier exact match. Completeness is recomputed against the cumulative planned paths and
 * tests, so two partial implementation intervals can together form one matched claim.
 */
export function mergeObservedClaimRecords(maps = [], plannedClaims = {}, { workflow = null } = {}) {
  const grouped = new Map();
  for (const map of [...maps].sort(recordOrder)) {
    for (const [id, claim] of Object.entries(map?.claims ?? {})) {
      const current = grouped.get(id) ?? {
        observedPaths: [], testResults: [], commits: [], verdicts: [], deviation: null
      };
      current.observedPaths.push(...(claim.observedPaths ?? []));
      current.testResults.push(...(claim.testResults ?? []));
      current.commits.push(...(claim.commits ?? []));
      current.verdicts.push(claim.verdict ?? 'missing');
      if (claim.deviation != null) current.deviation = claim.deviation;
      grouped.set(id, current);
    }
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
    const observedPaths = sortedUnique(value.observedPaths);
    const testResults = sortedUnique(value.testResults);
    const plan = plannedClaims[id] ?? null;
    let verdict;
    if (value.verdicts.includes('deviated')) verdict = 'deviated';
    else if (value.verdicts.includes('unplanned')) verdict = 'unplanned';
    else if (plan?.obligations?.length) {
      // Evaluate each planning owner's obligation against only its allocated Code steps. One
      // test-only stage cannot erase, or satisfy, another stage's product-source obligation.
      const outcomes = plan.obligations.map((obligation) => {
        const ownedSteps = Object.entries(workflow?.resolution?.plannedClaims?.owners ?? {})
          .filter(([, owner]) => owner === obligation.owner).map(([step]) => step);
        const steps = obligation.steps?.length ? obligation.steps : ownedSteps;
        const selected = maps.filter((map) => !steps.length || steps.includes(map.phase));
        return mergeObservedClaimRecords(selected, { [id]: obligation })[id]?.verdict ?? 'missing';
      });
      verdict = outcomes.every((outcome) => outcome === 'matched') ? 'matched'
        : outcomes.some((outcome) => outcome !== 'missing') ? 'partial' : 'missing';
    } else if (plan?.fulfillment && !SOURCE_CHANGING_FULFILLMENT.includes(plan.fulfillment)) {
      // Implemented by its own fulfillment, not by source and tests together: existing, removed,
      // document and configuration work by their paths, test-only work by its tests [E2G-010].
      const evidence = plan.fulfillment === 'test-only' ? testResults : observedPaths;
      const expected = plan.fulfillment === 'test-only' ? plan.tests ?? [] : plan.expectedPaths ?? [];
      verdict = evidence.length && expected.every((candidate) => evidence.includes(candidate)) ? 'matched'
        : evidence.length ? 'partial' : 'missing';
    } else if (plan) {
      const expectedPaths = plannedImplementationPaths(plan);
      const sourceComplete = expectedPaths.length > 0
        && expectedPaths.every((candidate) => observedPaths.includes(candidate));
      const testsComplete = !(plan.tests ?? []).length
        || plan.tests.every((candidate) => testResults.includes(candidate));
      const acceptanceTestOnly = /:AC-\d{3}$/.test(id) && !observedPaths.length && testResults.length;
      verdict = observedPaths.length
        ? (sourceComplete && testsComplete ? 'matched' : 'partial')
        : acceptanceTestOnly
          ? (!(plan.expectedPaths ?? []).length && testsComplete ? 'matched' : 'partial')
          // Preserve an invalid producer verdict when it has no source path. Convergence and
          // terminal coverage must expose that stale binding; normalizing it to `missing` here
          // would erase the stronger integrity defect from the fact set.
          : value.verdicts.includes('matched')
            ? 'matched'
            : value.verdicts.includes('partial')
              ? 'partial'
              : 'missing';
    } else if (value.verdicts.includes('matched')) verdict = 'matched';
    else if (value.verdicts.includes('partial')) verdict = 'partial';
    else verdict = 'missing';
    return [id, {
      observedPaths,
      testResults,
      commits: sortedUnique(value.commits),
      verdict,
      deviation: value.deviation
    }];
  }));
}

/**
 * Select only records that belong to the current generation of the current
 * Story. Historical files remain in Git for audit, but must never participate
 * in a live governance decision.
 */
export function selectActiveSpecRecords(records, workflow) {
  const workId = workflow?.workItem?.id ?? null;
  const configuredClausePhases = workflow?.resolution?.plannedClaims?.mode === 'required'
    && Array.isArray(workflow.resolution.plannedClaims.clausePhases)
    ? new Set(workflow.resolution.plannedClaims.clausePhases)
    : null;
  const active = (record) => {
    const phase = workflow?.phases?.[record?.phase];
    return Boolean(
      record
      && record.workId === workId
      && phase
      && Number(record.generation) === Number(phase.generation)
    );
  };
  return {
    indexes: (records.indexes ?? []).filter((record) =>
      active(record)
      && (configuredClausePhases
        ? configuredClausePhases.has(record.phase)
          && isSpecificationDefinitionPhase(workflow?.phases?.[record.phase])
        : isSpecificationDefinitionPhase(workflow?.phases?.[record.phase]))).sort(recordOrder),
    planned: (records.planned ?? []).filter(active).sort(recordOrder),
    observed: (records.observed ?? []).filter(active).sort(recordOrder),
    acceptance: (records.acceptance ?? []).filter(active).sort(recordOrder)
  };
}

export async function loadActiveSpecRecords(itemDirectory, workflow) {
  return withAmendmentRecord(selectActiveSpecRecords(await loadSpecRecords(itemDirectory), workflow), workflow);
}

/** The Story's plan amendments, merged as one more planned record [E2G-012]. */
function withAmendmentRecord(records, workflow, { evidenceApplied = false } = {}) {
  if (!evidenceApplied) records = { ...records, planned: (records.planned ?? []).map(record => applyPlanCorrections(record, workflow)) };
  const amendment = planAmendmentRecord(workflow);
  return amendment ? { ...records, planned: [...(records.planned ?? []), amendment] } : records;
}

/**
 * Load terminal specification evidence for a Story that explicitly pins required planned claims.
 * Indexes and acceptance runs remain directory records; planned and observed maps are admitted only
 * through the exact current-generation bindings in the workflow aggregate.
 */
export async function loadBoundActiveSpecRecords(root, itemDirectory, workflow, policy = {}, {
  requireCommitted = false, throughPhase = null, excludeObservedPhase = null, plannedOnly = false
} = {}) {
  if (requireCommitted && (excludeObservedPhase || plannedOnly)) throw new SingularityFlowError('Committed coverage cannot omit an observed phase.', { code: 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED' });
  const plannedPolicy = workflow?.resolution?.plannedClaims;
  if (!requireCommitted && plannedPolicy?.mode !== 'required') {
    const records = await loadActiveSpecRecords(itemDirectory, workflow);
    return plannedOnly ? { ...records, observed: [], acceptance: [] } : records;
  }
  const phaseOrder = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const indexes = [];
  const acceptance = [];
  for (const phaseId of phaseOrder) {
    const phase = workflow.phases?.[phaseId];
    if (!phase || !isSpecificationDefinitionPhase(phase) || !phase.specIndex) continue;
    indexes.push(await readBoundSpecificationIndex(root, itemDirectory, workflow, phase, {
      requireCommitted
    }));
  }
  for (const phaseId of plannedOnly ? [] : phaseOrder) {
    const phase = workflow.phases?.[phaseId];
    if (!phase || !(phase.generation > 0)) continue;
    const relative = posix(path.relative(root, path.join(
      itemDirectory, 'context', 'acceptance', `${phase.id}-gen${phase.generation}.json`
    )));
    if (!(await exists(path.join(root, relative)))) continue;
    const boundary = await secureRepositoryPath(root, relative, {
      label: `Specification acceptance for phase '${phase.id}'`, mustExist: true, type: 'file'
    });
    if (requireCommitted) {
      assertCommittedInputBytes(root, boundary.relative, `Specification acceptance for phase '${phase.id}'`);
    }
    const record = readRecord('specification-acceptance', await readFile(boundary.absolute)).record;
    const withoutHash = { ...record };
    delete withoutHash.recordSha256;
    if (record.workId !== workflow.workItem.id
        || record.phase !== phase.id
        || Number(record.generation) !== Number(phase.generation)
        || !sameDigest(record.recordSha256, sha256(canonicalJson(withoutHash)))) {
      throw new SingularityFlowError(
        `Phase '${phase.id}' specification acceptance record is not sealed to this Story generation.`,
        { code: 'SPECIFICATION_ACCEPTANCE_UNTRUSTED', details: { path: boundary.relative } }
      );
    }
    acceptance.push(record);
  }
  const base = selectActiveSpecRecords({ indexes, planned: [], observed: [], acceptance }, workflow);
  const clauseIds = [...new Set(base.indexes.flatMap((index) =>
    (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())))].sort();
  const planned = [];
  const observed = [];
  const ownerIds = (plannedPolicy?.mode === 'required'
    ? [...new Set(Object.values(plannedPolicy.owners ?? {}))]
    : phaseOrder.filter((phaseId) => workflow.phases?.[phaseId]?.claimMaps?.planned))
    .filter((phaseId) => workflow.phases?.[phaseId]?.status !== 'skipped');
  for (const ownerId of ownerIds) {
    const owner = workflow.phases?.[ownerId];
    planned.push(await readBoundSpecificationClaimMap(
      root, itemDirectory, workflow, owner, 'planned', { clauseIds, policy, requireCommitted }
    ));
  }
  // An earlier code step is judged before later ones have run, so only the steps up to it count.
  const limit = throughPhase ? phaseOrder.indexOf(throughPhase) : -1;
  const codePhaseIds = (plannedPolicy?.mode === 'required'
    ? Object.keys(plannedPolicy.owners ?? {})
    : phaseOrder.filter((phaseId) => workflow.phases?.[phaseId]?.claimMaps?.observed))
    .filter((phaseId) => workflow.phases?.[phaseId]?.status !== 'skipped'
      && phaseId !== excludeObservedPhase
      && (limit < 0 || phaseOrder.indexOf(phaseId) <= limit));
  for (const codePhaseId of plannedOnly ? [] : codePhaseIds) {
    const codePhase = workflow.phases?.[codePhaseId];
    observed.push(await readBoundSpecificationClaimMap(
      root, itemDirectory, workflow, codePhase, 'observed', { clauseIds, policy, requireCommitted,
        plannedClaims: plannedClaimsForObservedPhase(workflow, codePhaseId, planned) }
    ));
  }
  return withAmendmentRecord({
    ...base,
    planned: planned.sort(recordOrder),
    observed: observed.sort(recordOrder)
  }, workflow, { evidenceApplied: true });
}

export function predecessorSpecClauses(records, workflow, phaseId) {
  // Current records carry phaseOrder. Legacy/ad-hoc fixtures may only carry the pinned resolution
  // or phase map; they still need a deterministic, non-throwing continuity projection. When no
  // predecessor order can be proven, treating no phase as a predecessor is safer than importing a
  // current/later clause.
  const phaseOrder = Array.isArray(workflow?.phaseOrder)
    ? workflow.phaseOrder
    : Array.isArray(workflow?.resolution?.phases)
      ? workflow.resolution.phases.map((phase) => phase.id).filter(Boolean)
      : Object.keys(workflow?.phases ?? {});
  const position = phaseOrder.indexOf(phaseId);
  const allowed = new Set(position < 0 ? [] : phaseOrder.slice(0, position));
  return (records.indexes ?? [])
    .filter((index) => allowed.has(index.phase))
    .flatMap((index) => index.clauses ?? []);
}

function pathExcluded(candidate, excludes) {
  return excludes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix.replace(/\/$/, '')}/`));
}

// Test association is independent of fulfillment; source-changing rows also need their tests.
function exactPlannedTestEvidence(id, plannedClaims, observedClaims) {
  const plannedTests = plannedClaims[id]?.tests ?? [];
  const observedTests = new Set(observedClaims[id]?.testResults ?? []);
  return plannedTests.length > 0 && plannedTests.every((candidate) => observedTests.has(candidate));
}

export function evaluateSpecCoverage({ indexes = [], planned = [], observed = [] }, changedPaths = [], policy = {}, { root = null, workflow = null } = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = mergePlannedClaimRecords(planned);
  const observedClaims = mergeObservedClaimRecords(observed, plannedClaims, { workflow });
  const activePaths = [...new Set(changedPaths.map(posix))].filter((candidate) => !pathExcluded(candidate, normalized.excludes)).sort();
  const claimedPaths = new Set(Object.entries(observedClaims).flatMap(([id, claim]) => [
    ...(claim.observedPaths ?? []),
    ...(claim.testResults ?? []).filter((candidate) => (plannedClaims[id]?.tests ?? []).includes(candidate))
  ]));
  // A path a plan amendment added to a row is accounted for by that amendment [E2G-012].
  for (const candidate of accountedAmendmentPaths(planned)) claimedPaths.add(candidate);
  const unimplemented = [...clauses.keys()].filter((id) => {
    const claim = observedClaims[id];
    if (!claim) return true;
    if (plannedClaims[id]?.fulfillment === 'test-only'
        && !testOnlyClaimEvidence(id, plannedClaims[id], claim)) return true;
    if (testOnlyClaimEvidence(id, plannedClaims[id], claim) && claim.verdict !== 'deviated'
        && (!plannedClaims[id]?.obligations?.length || claim.verdict === 'matched')) return false;
    return ['missing', 'partial'].includes(claim.verdict);
  }).sort();
  // Covered only because their planned test files were delivered: no source change and, until
  // test-case results are joined, no proof the tests ran for them. Reported so no label overstates it.
  const testPresenceOnly = [...clauses.keys()].filter((id) => observedClaims[id]
    && !(observedClaims[id].observedPaths ?? []).length
    && testOnlyClaimEvidence(id, plannedClaims[id], observedClaims[id])).sort();
  // A file the plan lists under Supporting files may change without a clause claiming it.
  const supporting = new Set(plannedSupportingFiles(planned));
  const supportingChangedPaths = activePaths.filter((candidate) => !claimedPaths.has(candidate) && supporting.has(candidate));
  const unclaimedChangedPaths = activePaths.filter((candidate) => !claimedPaths.has(candidate) && !supporting.has(candidate));
  const withdrawnButClaimed = Object.keys(observedClaims).filter((id) => !clauses.has(id)).sort();
  const invalidEvidence = [];
  for (const [id, claim] of Object.entries(observedClaims)) {
    // A test-only obligation is delivered by its tests, and a removal by the absence of its paths,
    // which receipt replay proves [E2G-010].
    const fulfillment = plannedClaims[id]?.fulfillment ?? null;
    if (fulfillment === 'test-only' && ['matched', 'partial', 'deviated'].includes(claim.verdict)
        && !testOnlyClaimEvidence(id, plannedClaims[id], claim, { complete: claim.verdict === 'matched' })) {
      invalidEvidence.push(`${id} has verdict ${claim.verdict} without exact planned test-only evidence`);
    }
    if (['matched', 'partial', 'deviated'].includes(claim.verdict)
        && !(claim.observedPaths ?? []).length
        && fulfillment !== 'test-only'
        && !testOnlyClaimEvidence(id, plannedClaims[id], claim)) {
      invalidEvidence.push(`${id} has verdict ${claim.verdict} without source-path evidence`);
    }
    if (root) {
      for (const candidate of fulfillment === 'removed' ? [] : claim.observedPaths ?? []) {
        // An exact, governed source deletion is still observable code evidence. Its path appears
        // in the committed change set but no longer exists in the worktree; receipt replay owns
        // proving that deletion. Absence without a changed-path witness remains invalid.
        if (!existsSync(path.join(root, candidate)) && !activePaths.includes(candidate)) {
          invalidEvidence.push(`${id} references missing source evidence ${candidate}`);
        }
      }
      for (const candidate of claim.testResults ?? []) {
        if (!existsSync(path.join(root, candidate))) invalidEvidence.push(`${id} references missing test evidence ${candidate}`);
      }
      for (const commit of claim.commits ?? []) {
        const resolved = run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true });
        if (resolved.status !== 0) invalidEvidence.push(`${id} references unreachable commit ${commit}`);
      }
    }
  }
  const result = {
    schemaVersion: 1, // schema-transient: computed coverage result, never persisted
    mode: normalized.coverage,
    totals: {
      clauses: clauses.size,
      planned: Object.keys(plannedClaims).length,
      observed: Object.keys(observedClaims).length,
      changedPaths: activePaths.length
    },
    unimplemented,
    testPresenceOnly,
    unclaimedChangedPaths,
    supportingChangedPaths,
    withdrawnButClaimed,
    invalidEvidence: [...new Set(invalidEvidence)].sort(),
    complete: !unimplemented.length && !unclaimedChangedPaths.length && !withdrawnButClaimed.length && !invalidEvidence.length
  };
  result.severity = result.complete || normalized.coverage === 'off' ? 'pass' : normalized.coverage === 'enforce' ? 'error' : 'warning';
  return result;
}

export function evaluateSpecAcceptance({ indexes = [], planned = [], observed = [], acceptance = [] }, policy = {}, expected = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = mergePlannedClaimRecords(planned);
  const verificationContracts = mergedVerificationContracts(planned);
  const nonTestProof = id => plannedClaims[id]?.testDisposition === 'non-test'
    && nonTestVerification(id, plannedClaims[id], verificationContracts, clauses.get(id)?.verification);
  const testExemption = id => plannedClaims[id]?.testDisposition === 'not-applicable'
    && plannedClaims[id]?.testReason && !clauses.get(id)?.verification?.methods.includes('test');
  const observedClaims = mergeObservedClaimRecords(observed, plannedClaims);
  const candidates = [...acceptance].sort(recordOrder);
  const latestRun = candidates.at(-1) ?? null;
  const missingPlannedTests = normalized.acceptance === 'off'
    ? []
    : [...clauses.keys()].filter((id) => {
      const claim = plannedClaims[id];
      return !(claim?.tests ?? []).length
        && !testExemption(id)
        && !nonTestProof(id);
    }).sort();
  const missingObservedTests = normalized.acceptance !== 'verify'
    ? []
    : [...clauses.keys()].filter((id) => {
      return !exactPlannedTestEvidence(id, plannedClaims, observedClaims)
        && !testExemption(id)
        && !nonTestProof(id);
    }).sort();
  const failedCommands = normalized.acceptance !== 'verify' || !latestRun
    ? []
    : (latestRun.commands ?? []).filter((entry) => entry.status !== 'passed').map((entry) => entry.id);
  const missingRun = normalized.acceptance === 'verify' && !latestRun;
  const staleRunReasons = [];
  if (latestRun) {
    const storedHash = latestRun.recordSha256;
    const withoutHash = { ...latestRun };
    delete withoutHash.recordSha256;
    if (!storedHash || storedHash !== sha256(canonicalJson(withoutHash))) staleRunReasons.push('acceptance record hash is missing or invalid');
    if (latestRun.status !== 'passed') staleRunReasons.push('latest acceptance run did not pass');
    if (latestRun.sourceChangedDuringRun) staleRunReasons.push('repository source changed while acceptance commands were running');
    if (expected.workId && latestRun.workId !== expected.workId) staleRunReasons.push(`acceptance run belongs to ${latestRun.workId ?? 'no work item'}`);
    if (expected.phase && latestRun.phase !== expected.phase) staleRunReasons.push(`acceptance run belongs to phase ${latestRun.phase ?? 'unknown'}`);
    if (expected.generation != null && Number(latestRun.generation) !== Number(expected.generation)) staleRunReasons.push(`acceptance run belongs to generation ${latestRun.generation ?? 'unknown'}`);
    if (expected.sourceTreeSha256 && latestRun.sourceTreeSha256 !== expected.sourceTreeSha256) staleRunReasons.push('source tree changed after the acceptance run');
    if (expected.commandSetSha256 && latestRun.commandSetSha256 !== expected.commandSetSha256) staleRunReasons.push('configured acceptance commands changed after the run');
  }
  const complete = normalized.acceptance === 'off'
    || (!missingPlannedTests.length && !missingObservedTests.length && !failedCommands.length && !missingRun && !staleRunReasons.length);
  return {
    schemaVersion: 1, // schema-transient: computed acceptance result, never persisted
    mode: normalized.acceptance,
    complete,
    missingPlannedTests,
    missingObservedTests,
    failedCommands,
    missingRun,
    staleRunReasons,
    latestRunAt: latestRun?.completedAt ?? null
  };
}

export async function runSpecAcceptance(root, policy = {}, {
  commandIds = [], workId = null, phase = null, generation = null, outputPath = null, write = true,
  pathContext = null
} = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const configured = normalized.testCommands;
  const selected = commandIds.length ? [...new Set(commandIds)] : Object.keys(configured);
  for (const id of selected) if (!configured[id]) throw new SingularityFlowError(`Unknown allowlisted specification test command '${id}'.`);
  if (!selected.length) throw new SingularityFlowError('No spec.testCommands are configured. Add an allowlisted argv command before running acceptance.');
  const sourceTreeBefore = await specificationSourceTreeHash(root, pathContext);
  const commandSetSha256 = sha256(canonicalJson(selected.map((id) => ({ id, argv: configured[id] }))));
  const startedAt = nowIso();
  const commands = selected.map((id) => {
    const argv = configured[id];
    const result = run(argv[0], argv.slice(1), { cwd: root, allowFailure: true });
    return {
      id,
      argv,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      stdout: result.stdout.slice(-65536),
      stderr: result.stderr.slice(-65536)
    };
  });
  const sourceTreeAfter = await specificationSourceTreeHash(root, pathContext);
  const sourceChangedDuringRun = sourceTreeBefore !== sourceTreeAfter;
  const record = {
    schemaVersion: currentSchemaVersion('specification-acceptance'),
    workId,
    phase,
    generation,
    sourceCommit: gitCommit(root),
    sourceTreeSha256: sourceTreeAfter,
    commandSetSha256,
    sourceChangedDuringRun,
    startedAt,
    completedAt: nowIso(),
    status: commands.every((entry) => entry.status === 'passed') && !sourceChangedDuringRun ? 'passed' : 'failed',
    commands
  };
  record.recordSha256 = sha256(canonicalJson(record));
  if (write && outputPath) await writeJson(path.join(root, outputPath), canonicalize(record));
  return record;
}

export function configuredAcceptanceCommandSetSha256(policy = {}, commandIds = []) {
  const normalized = normalizeSpecPolicy(policy);
  const selected = commandIds.length ? [...new Set(commandIds)] : Object.keys(normalized.testCommands);
  for (const id of selected) if (!normalized.testCommands[id]) throw new SingularityFlowError(`Unknown allowlisted specification test command '${id}'.`);
  return sha256(canonicalJson(selected.map((id) => ({ id, argv: normalized.testCommands[id] }))));
}

export async function specificationSourceTreeHash(root, pathContext = null) {
  assertNoHiddenWorktreeChanges(root, 'Specification source hashing');
  const tracked = run('git', ['ls-files', '-z', '--cached'], { cwd: root, allowFailure: true });
  const untracked = run('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, allowFailure: true });
  if (tracked.status !== 0 || untracked.status !== 0) {
    const failure = tracked.status !== 0 ? tracked : untracked;
    throw new SingularityFlowError(`Unable to enumerate repository source for specification acceptance: ${(failure.stderr || failure.stdout).trim() || 'git ls-files failed'}`);
  }
  const files = [...new Set([
    ...tracked.stdout.split('\0').filter(Boolean).map(posix)
      .filter((file) => isApplicationPath(file, pathContext)),
    ...untracked.stdout.split('\0').filter(Boolean).map(posix)
      .filter((file) => isApplicationChangePath(file, { ...pathContext, untracked: true }))
  ])].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const secured = await secureRepositoryPath(root, file, {
      label: 'Specification source path',
      allowFinalSymlink: true
    });
    if (!secured.exists) continue;
    const absolute = secured.absolute;
    const stat = secured.entry;
    if (stat.isDirectory()) {
      throw new SingularityFlowError(
        `Specification source contains a checked-out or dirty Git submodule at ${file}. `
          + 'Commit a clean submodule pointer before evaluating acceptance.',
        { code: 'SPECIFICATION_GITLINK_DIRTY', details: { path: file } }
      );
    }
    const mode = stat.isSymbolicLink() ? 'symlink' : stat.mode & 0o111 ? 'executable' : 'file';
    const content = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    hash.update(file).update('\0').update(mode).update('\0').update(content).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function gitCommit(root) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function changedRepositoryPaths(root, { base = null, target = 'HEAD', pathContext = null } = {}) {
  const args = base
    ? ['diff', '--name-only', '--diff-filter=ACDMRTUXB', base, target, '--']
    : ['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${target}^`, target, '--'];
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(`Unable to calculate changed repository paths: ${(result.stderr || result.stdout).trim() || `git diff exited ${result.status}`}`);
  }
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map(posix)
    .filter((file) => isApplicationPath(file, pathContext));
}

export { applicationPathContext };

export function traceClause(records, clauseId = null) {
  const rows = [];
  // The same cumulative merge the gate evaluates. Reading only the latest map made the trace
  // disagree with the gate whenever more than one code phase implemented a clause.
  const plannedClaims = mergePlannedClaimRecords(records.planned ?? []);
  const observedClaims = mergeObservedClaimRecords(records.observed ?? [], plannedClaims);
  for (const index of records.indexes ?? []) {
    for (const clause of index.clauses ?? []) {
      if (clauseId && clause.id !== clauseId) continue;
      const planned = plannedClaims[clause.id] ?? null;
      const observed = observedClaims[clause.id] ?? null;
      rows.push({
        id: clause.id,
        type: clause.type,
        source: `${clause.source?.path ?? index.source?.path ?? 'unknown'}:${clause.source?.line ?? 0}`,
        bodySha256: clause.bodySha256,
        dependsOn: clause.dependsOn ?? [],
        planned,
        observed,
        verdict: observed?.verdict ?? 'missing'
      });
    }
  }
  if (clauseId && !rows.length) throw new SingularityFlowError(`Clause ${clauseId} was not found in the current specification indexes.`);
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function traceCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    ['clause', 'type', 'source', 'verdict', 'planned_paths', 'observed_paths'].map(quote).join(','),
    ...rows.map((row) => [row.id, row.type, row.source, row.verdict, (row.planned?.expectedPaths ?? []).join(';'), (row.observed?.observedPaths ?? []).join(';')].map(quote).join(','))
  ].join('\n');
}

export function selectClauseContext(indexes, clauseIds, { includeDependencies = true, fallback = 'whole' } = {}) {
  const all = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const requested = [...new Set(clauseIds ?? [])];
  if (!requested.length) return fallback === 'whole' ? [...all.values()] : [];
  const selected = new Map();
  const visit = (id) => {
    const clause = all.get(id);
    if (!clause) throw new SingularityFlowError(`Clause selector references unknown clause ${id}.`);
    if (selected.has(id)) return;
    selected.set(id, clause);
    if (includeDependencies) for (const dependency of clause.dependsOn ?? []) visit(dependency);
  };
  requested.forEach(visit);
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderClauseContext(clauses) {
  if (!clauses.length) return '';
  return ['# Selected specification clauses', '', ...clauses.flatMap((clause) => [
    `## ${clause.anchor}`,
    '',
    clause.body,
    ...(clause.verification ? [`Verification: ${clause.verification.methods.join(', ')} (all required)${clause.verification.criterionId ? ` via ${clause.verification.criterionId}` : ''}.`] : []),
    '',
    `Source: \`${clause.source?.path ?? 'unknown'}:${clause.source?.line ?? 0}\`; SHA-256: \`${clause.bodySha256}\``
  ])].join('\n');
}
