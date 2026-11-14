/**
 * Step dependency records [SPEC-CIC v1.1 stage 3; CIC:REQ-001, REQ-002, REQ-005].
 *
 * On a Story whose pinned spec policy turns observed dependencies on (switch 1), each published generation
 * records what it depended on, from production facts only, never from what a model says it used: the clause
 * revisions its prompt held (`input`, from the prompt receipt), the clauses its plan claims or that are planned
 * for it (`claim`, from the planned claim maps), the changed paths a clause expects (`path`, from the
 * code-delivery change set), the tests bound to a clause (`test`), the exact test each criterion tag sits on
 * (`witness`), the source and implementation bindings (`binding`), and the clause IDs its own artifacts cite
 * (`citation`). One file per generation, `context/dependencies/<step>-gen<N>.json`, committed with the
 * publication; the step keeps only its path and digest, so `workflow.json` stays small. A record is
 * append-only and digest-bound to the step generation and to the scope revision current at publication.
 *
 * Coverage (REQ-005) is `resolved` only when the record is complete: a receipt that names the clause
 * revisions and whose prompt matches it, the claim maps it relies on present and matching their digests, and
 * no changed path that no clause claims, other than a supporting change an approved plan row or plan amendment
 * names (`supportingPaths`: covered, and depending on no clause; owner, 2026-11-14). Anything else is `unresolved`, with the reasons; a generation with no
 * record (published before the switch, or by a route that writes none) reads as unresolved too. An intent
 * amendment's effect reads them (state.mjs intentAmendmentEffect): an unresolved record counts as affected, and a
 * kept step whose `input` edges hold a changed clause is asked whether it still holds [CIC:REQ-006, REQ-021].
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { clauseReferences, loadActiveSpecRecords, mergePlannedClaimRecords, plannedClaimsForObservedPhase } from './specifications.mjs';
import { posix, writeJson } from './util.mjs';

export const STEP_DEPENDENCIES_SCHEMA = 'step-dependencies/v1';
export const EDGE_KINDS = Object.freeze(['input', 'claim', 'path', 'test', 'witness', 'binding', 'citation']);

const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const upper = (id) => String(id).toUpperCase();
const sealed = (record) => ({ ...record, recordSha256: `sha256:${recordSha256(record)}` });

/** Where a generation's record lives, relative to the repository. */
export function dependencyRecordPath(itemRelative, phaseId, generation) {
  return posix(path.join(itemRelative, 'context', 'dependencies', `${phaseId}-gen${generation}.json`));
}

async function readJsonFile(root, relative) {
  const bytes = await readFile(path.join(root, relative)).catch(() => null);
  if (!bytes) return { bytes: null, value: null };
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; } catch { return { bytes, value: null }; }
}

/** The planned claim maps a step relies on: its own, when it plans, and for a code step the ones planned for it. */
function reliedClaimMaps(workflow, phase) {
  const bound = (id) => {
    const map = workflow.phases?.[id]?.claimMaps?.planned;
    return map?.path ? { phase: id, kind: 'planned', generation: Number(map.generation ?? 0), path: map.path, sha256: map.sha256 ?? null } : null;
  };
  if (!phaseRequiresCodeDelivery(phase)) return Number(phase.claimMaps?.planned?.generation) === Number(phase.generation) ? [bound(phase.id)] : [];
  const policy = workflow.resolution?.plannedClaims;
  const owners = policy?.mode === 'required' ? [policy.owners?.[phase.id]].filter(Boolean)
    : (workflow.phaseOrder ?? []).filter((id) => workflow.phases?.[id]?.claimMaps?.planned && workflow.phases[id].status !== 'skipped');
  return owners.map((id) => bound(id) ?? { phase: id, kind: 'planned', generation: null, path: null, sha256: null });
}

/** The changed paths a code generation's delivery evidence names. */
function changedPaths(evidence) {
  return [...new Set(['sourcePaths', 'deletedSourcePaths', 'configurationPaths', 'testPaths', 'supportingTestPaths']
    .flatMap((key) => evidence?.[key] ?? []).map(String))].sort();
}

/** Each path a binding names: a source binding's own path, or each region of an implementation binding. */
function bindingPaths(binding) {
  return [...new Set([binding?.path, binding?.sourcePath, ...(binding?.paths ?? []), ...(binding?.regions ?? []).map((region) => region?.path)]
    .filter((value) => typeof value === 'string' && value))];
}

function edgeKey(edge) {
  return canonicalJson(edge);
}

/**
 * Build and write the record of `phase`'s generation just published, and keep its path and digest on the step.
 * Called by publishGeneration under switch 1 only, after the generation's own records (receipt, claim maps,
 * delivery evidence, artifacts) are final, so it is committed with the publication.
 */
export async function recordStepDependencies(root, workflow, phase, { itemRelative, publishedAt }) {
  const itemDirectory = path.join(root, itemRelative);
  const generation = Number(phase.generation);
  const reasons = new Set();
  const edges = new Map();
  const add = (edge) => edges.set(edgeKey(edge), edge);
  // input: the clause revisions the prompt receipt says the composed prompt held.
  const receiptPath = posix(path.join(itemRelative, 'context', `${phase.id}-gen${generation}.json`));
  const receiptFile = await readJsonFile(root, receiptPath);
  let receipt = null;
  if (!receiptFile.bytes) reasons.add('receipt-missing');
  else {
    receipt = { path: receiptPath, sha256: `sha256:${hex(receiptFile.bytes)}` };
    const prompt = receiptFile.value?.promptPath ? await readFile(path.join(root, receiptFile.value.promptPath)).catch(() => null) : null;
    if (!prompt || hex(prompt) !== String(receiptFile.value?.renderedSha256 ?? '').replace(/^sha256:/u, '')) reasons.add('receipt-digest');
    const revisions = receiptFile.value?.promptBudget?.activeClauseCapsule?.clauseRevisions;
    if (!Array.isArray(revisions)) reasons.add('receipt-clauses-unrecorded');
    else for (const revision of revisions) add({ kind: 'input', clause: upper(revision.id), statementSha256: revision.statementSha256 ?? null });
  }
  // claim: the planned claim maps the step relies on, each checked against the digest its owner recorded.
  const claimMaps = reliedClaimMaps(workflow, phase);
  for (const map of claimMaps) {
    const file = map.path ? await readJsonFile(root, map.path) : { bytes: null, value: null };
    if (!file.value) reasons.add('claim-map-missing');
    else if (hex(canonicalJson(file.value)) !== String(map.sha256 ?? '').replace(/^sha256:/u, '')) reasons.add('claim-map-digest');
  }
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const code = phaseRequiresCodeDelivery(phase);
  const planned = code ? plannedClaimsForObservedPhase(workflow, phase.id, records.planned)
    : mergePlannedClaimRecords((records.planned ?? []).filter((record) => record.phase === phase.id && Number(record.generation) === generation));
  for (const clause of Object.keys(planned)) add({ kind: 'claim', clause: upper(clause) });
  // path, test, witness, binding: the code-delivery evidence this publication recorded.
  const evidence = code && Number(phase.deliveryEvidence?.generation) === generation ? phase.deliveryEvidence : null;
  const unclaimedPaths = [];
  const supportingPaths = [];
  if (evidence) {
    const expecting = new Map();
    const expect = (clause, paths) => { for (const expected of paths) expecting.set(expected, [...new Set([...(expecting.get(expected) ?? []), upper(clause)])]); };
    for (const [clause, claim] of Object.entries(planned)) expect(clause, [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]);
    // An approved plan amendment's added location is its clause's too (decision plan --add-location).
    const approvedPlans = (records.planned ?? []).filter((record) => record.amendment || workflow.phases?.[record.phase]?.status === 'approved');
    for (const record of approvedPlans) for (const [clause, paths] of Object.entries(record.accountedPaths ?? {})) expect(clause, paths);
    // A supporting change an approved plan row or plan amendment names is covered and depends on no clause (owner, 2026-11-14) [CIC:REQ-005].
    const supporting = new Set(approvedPlans.flatMap((record) => record.supportingFiles ?? []));
    for (const changed of changedPaths(evidence)) {
      const clauses = expecting.get(changed) ?? [];
      if (!clauses.length) (supporting.has(changed) ? supportingPaths : unclaimedPaths).push(changed);
      for (const clause of clauses) add({ kind: 'path', clause, path: changed });
    }
    for (const binding of evidence.acceptanceCriteria?.bindings ?? []) add({ kind: 'test', clause: upper(binding.clauseId), test: binding.testSource });
    for (const witness of evidence.acceptanceCriteria?.witnesses ?? []) {
      add({ kind: 'witness', clause: upper(witness.clauseId), test: witness.testSource, line: witness.line ?? null });
    }
    for (const binding of [...(evidence.sourceBindings?.bindings ?? []), ...(evidence.implementationBindings?.bindings ?? [])]) {
      for (const where of bindingPaths(binding)) add({ kind: 'binding', clause: upper(binding.clauseId), path: where });
    }
  } else if (code) reasons.add('delivery-evidence-missing');
  if (unclaimedPaths.length) reasons.add('unclaimed-paths');
  // citation: every clause its own artifacts cite by exact ID, other than the clauses it defines itself.
  const defined = new Set(records.indexes.filter((index) => index.phase === phase.id).flatMap((index) => (index.clauses ?? []).map((clause) => upper(clause.id))));
  for (const artifact of phase.artifacts ?? []) {
    const text = await readFile(path.join(root, artifact.path), 'utf8').catch(() => null);
    if (text === null) {
      if (!(artifact.exists === false && !existsSync(path.join(root, artifact.path)))) reasons.add('artifact-unreadable');
      continue;
    }
    for (const clause of new Set(clauseReferences(text).map(upper))) if (!defined.has(clause)) add({ kind: 'citation', clause, path: artifact.path });
  }
  const latest = workflow.scopeRevisions?.at(-1) ?? null;
  const record = sealed({
    schema: STEP_DEPENDENCIES_SCHEMA,
    workId: workflow.workItem.id,
    phase: phase.id,
    generation,
    publishedAt,
    scopeRevision: latest ? { revision: latest.revision, revisionSha256: latest.revisionSha256 } : null,
    receipt,
    claimMaps,
    changeSet: evidence ? { path: evidence.changeSetPath ?? null, digest: evidence.changeSet?.digest ?? null } : null,
    edges: [...edges.values()].sort((left, right) => EDGE_KINDS.indexOf(left.kind) - EDGE_KINDS.indexOf(right.kind)
      || left.clause.localeCompare(right.clause) || edgeKey(left).localeCompare(edgeKey(right))),
    unclaimedPaths,
    ...(supportingPaths.length ? { supportingPaths } : {}),
    coverage: { state: reasons.size ? 'unresolved' : 'resolved', reasons: [...reasons].sort() }
  });
  const relative = dependencyRecordPath(itemRelative, phase.id, generation);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeJson(path.join(root, relative), record);
  phase.dependencyRecords = [...(phase.dependencyRecords ?? []).filter((entry) => Number(entry.generation) !== generation),
    { generation, path: relative, recordSha256: record.recordSha256 }].sort((left, right) => left.generation - right.generation);
  return record;
}

/**
 * Whether the Story's scope revisions still chain: each one's digest matches its own fields, and each names the
 * one before it. v1 and v2 revisions chain alike. Nothing verified this before stage 3; a broken chain is
 * reported here and read as unresolved, and refuses nothing.
 */
export function verifyScopeRevisionChain(workflow) {
  const problems = [];
  let previous = null;
  for (const [index, revision] of (workflow?.scopeRevisions ?? []).entries()) {
    const { revisionSha256, ...core } = revision ?? {};
    const number = revision?.revision ?? index + 1;
    if (`sha256:${recordSha256(core)}` !== revisionSha256) problems.push({ revision: number, problem: 'digest' });
    if ((revision?.previousRevisionSha256 ?? null) !== (previous?.revisionSha256 ?? null)) problems.push({ revision: number, problem: 'link' });
    previous = revision;
  }
  return { verified: problems.length === 0, revisions: workflow?.scopeRevisions?.length ?? 0, problems };
}

/**
 * Every published generation of every step (or of `step`), with its record's edges by kind and its coverage
 * read now: the reasons recorded at publication, plus `no-record`, `record-missing`, `record-digest` (the file
 * or the step's digest no longer matches), `receipt-changed` or `claim-map-changed` (a file it was built from
 * changed since), and `scope-chain` (the revision it names is not in a chain that verifies). Reads only.
 */
export async function stepDependencies(root, workflow, { step = null } = {}) {
  const chain = verifyScopeRevisionChain(workflow);
  const chained = new Set(chain.verified ? (workflow.scopeRevisions ?? []).map((revision) => revision.revisionSha256) : []);
  const order = (workflow.phaseOrder ?? []).filter((id) => !step || id === step);
  const steps = [];
  for (const id of order) {
    const phase = workflow.phases?.[id];
    if (!phase) continue;
    const generations = [...new Set((phase.generationPublications ?? []).map((entry) => Number(entry.generation)).filter((value) => value > 0))].sort((a, b) => a - b);
    const rows = [];
    for (const generation of generations) {
      const entry = (phase.dependencyRecords ?? []).find((candidate) => Number(candidate.generation) === generation);
      if (!entry) { rows.push({ generation, record: null, coverage: { state: 'unresolved', reasons: ['no-record'] }, edges: {} }); continue; }
      const file = await readJsonFile(root, entry.path);
      const reasons = new Set();
      if (!file.value) reasons.add('record-missing');
      const record = file.value ?? {};
      const { recordSha256: stored, ...body } = record;
      if (file.value && (`sha256:${recordSha256(body)}` !== stored || stored !== entry.recordSha256)) reasons.add('record-digest');
      for (const reason of record.coverage?.reasons ?? []) reasons.add(reason);
      if (record.receipt?.path) {
        const receipt = await readFile(path.join(root, record.receipt.path)).catch(() => null);
        if (!receipt || `sha256:${hex(receipt)}` !== record.receipt.sha256) reasons.add('receipt-changed');
      }
      for (const map of record.claimMaps ?? []) {
        if (!map.path) continue;
        const current = await readJsonFile(root, map.path);
        if (!current.value || hex(canonicalJson(current.value)) !== String(map.sha256 ?? '').replace(/^sha256:/u, '')) reasons.add('claim-map-changed');
      }
      if (record.scopeRevision && !chained.has(record.scopeRevision.revisionSha256)) reasons.add('scope-chain');
      const byKind = {};
      for (const edge of record.edges ?? []) (byKind[edge.kind] ??= []).push(edge);
      rows.push({ generation, record: entry.path, scopeRevision: record.scopeRevision?.revision ?? null,
        coverage: { state: reasons.size ? 'unresolved' : 'resolved', reasons: [...reasons].sort() },
        edges: byKind, unclaimedPaths: record.unclaimedPaths ?? [], ...(record.supportingPaths?.length ? { supportingPaths: record.supportingPaths } : {}) });
    }
    if (rows.length || step) steps.push({ phase: id, generations: rows });
  }
  return { chain, steps };
}
