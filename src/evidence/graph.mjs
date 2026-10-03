/**
 * Load one Story's evidence graph for the evaluator, in projection mode [E2G-028, E2G-033].
 *
 * Projection mode reads committed records only: no network, no test runs and no live tree digest.
 * A record that cannot be read or trusted is never skipped quietly; it becomes a finding and the
 * rows it would have supported read inconclusive.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { recordSha256 } from '../records.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { currentCompletenessReview } from '../scope/decisions.mjs';
import { buildScopeInventory } from '../scope/inventory.mjs';
import { removedClauseIds } from '../scope/revisions.mjs';
import { planAmendmentRecord } from '../plan-amendments.mjs';
import { applicabilityStatus } from './applicability.mjs';
import { pinnedStorySource } from '../story-epic-sources.mjs';
import {
  isSpecificationDefinitionPhase, loadActiveSpecRecords, loadSpecRecords, readBoundSpecificationClaimMap,
  readBoundSpecificationIndex, selectActiveSpecRecords
} from '../specifications.mjs';

function itemDirectory(root, definition, workId) {
  return path.join(root, definition.workItemRoot ?? 'singularity/work-items', workId);
}

async function readJsonAt(root, relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

/** What the evaluator needs of one test attempt: how it ended and every occurrence it observed. */
function attemptProjection(record) {
  return {
    attemptId: record.attemptId ?? null, purpose: record.purpose ?? null, status: record.status,
    exitCode: record.exitCode ?? null, timedOut: record.timedOut === true, terminal: record.terminal !== false,
    candidateTreeSha256: record.candidate?.treeSha256 ?? null, tests: record.tests ?? {},
    occurrences: record.occurrences ?? []
  };
}

/** Read one bound test attempt, or report it. */
async function loadAttempt(root, entry, phase, findings, label) {
  try {
    return attemptProjection(readRecord('test-execution', await readFile(path.join(root, entry.receiptPath))).record);
  } catch (error) {
    findings.push({
      code: 'EVIDENCE_TEST_RECEIPT_UNREADABLE', category: 'records', blocking: true, obligationIds: [],
      message: `The ${label} for '${entry.commandId}' in ${phase.id} could not be read: ${error.message}`
    });
    return null;
  }
}

/** The committed delivery evidence of one code phase: receipt, test receipts and dispositions. */
async function loadDelivery(root, phase, findings) {
  const evidence = phase.deliveryEvidence;
  let receipt = null;
  if (evidence.receiptPath) {
    try { receipt = await readJsonAt(root, evidence.receiptPath); } catch (error) {
      findings.push({
        code: 'EVIDENCE_RECEIPT_UNREADABLE', category: 'records', blocking: true, obligationIds: [],
        message: `The code-delivery receipt of ${phase.id} could not be read: ${error.message}`
      });
    }
  }
  const executions = [];
  for (const entry of evidence.testExecutions ?? []) {
    if (entry.kind === 'phase-validation-observation') {
      executions.push({ commandId: entry.commandId, kind: entry.kind, status: entry.status, receiptPath: entry.receiptPath, record: null });
      continue;
    }
    const record = await loadAttempt(root, entry, phase, findings, 'test receipt');
    executions.push({
      commandId: entry.commandId, kind: entry.kind ?? 'test-execution', status: entry.status ?? null,
      receiptPath: entry.receiptPath, record
    });
  }
  // A published delivery not yet submitted shows what its preflight runs observed.
  const preflight = [];
  if (evidence.status !== 'ready') {
    for (const entry of evidence.preflightAttempts ?? []) {
      const record = await loadAttempt(root, entry, phase, findings, 'preflight test attempt');
      if (record) preflight.push({ commandId: entry.commandId, record });
    }
  }
  return {
    phaseId: phase.id,
    generation: phase.generation,
    status: evidence.status ?? null,
    validation: evidence.validation ? { status: evidence.validation.status } : null,
    testRecovery: evidence.testRecovery ? { disposition: evidence.testRecovery.disposition, observedOutcome: evidence.testRecovery.observedOutcome } : null,
    acceptanceCriteria: evidence.acceptanceCriteria
      ? {
        bindings: (evidence.acceptanceCriteria.bindings ?? []).map((binding) => ({ clauseId: binding.clauseId, testSource: binding.testSource })),
        witnesses: evidence.acceptanceCriteria.witnesses ?? null,
        unattachedTags: evidence.acceptanceCriteria.unattachedTags ?? []
      }
      : null,
    // What each obligation delivered in source was bound to, and how its author explained it [E2G-011].
    implementationBindings: receipt?.implementationBindings ? {
      bindingsSha256: receipt.implementationBindings.bindingsSha256 ?? null,
      bindings: (receipt.implementationBindings.bindings ?? []).map((binding) => ({
        clauseId: binding.clauseId,
        explanation: binding.explanation ?? null,
        regions: (binding.regions ?? []).map((region) => ({
          path: region.path, change: region.change, hunks: (region.hunks ?? []).length,
          symbols: (region.symbols ?? []).map((symbol) => symbol.name), symbolAssurance: region.symbolAssurance ?? null
        }))
      }))
    } : null,
    receipt: receipt ? {
      status: receipt.status ?? null,
      traceability: {
        bindings: (receipt.traceability?.bindings ?? []).map((binding) => ({
          clauseId: binding.clauseId, testSource: binding.testSource, commandId: binding.commandId ?? null
        })),
        witnesses: receipt.traceability?.witnesses ?? null,
        unattachedTags: receipt.traceability?.unattachedTags ?? []
      }
    } : null,
    executions,
    preflight,
    attemptHistory: evidence.attemptHistory ?? []
  };
}

function untrustedFinding(error, what) {
  return {
    code: 'EVIDENCE_RECORDS_UNTRUSTED', category: 'records', blocking: true, obligationIds: [],
    message: `${what} does not match its binding in the Story: ${error.message}`
  };
}

/**
 * The Story's current specification records, read through the aggregate's own bindings.
 *
 * Unlike the terminal loader, a step that has not produced its records yet is simply pending: only
 * a binding that exists and does not match is a problem, and an earlier generation's binding is
 * not current evidence at all.
 */
async function loadProjectedSpecRecords(root, directory, workflow, findings) {
  if (workflow.resolution?.plannedClaims?.mode !== 'required') {
    return { records: await loadActiveSpecRecords(directory, workflow), untrusted: false };
  }
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const policy = workflow.resolution?.spec ?? {};
  let untrusted = false;
  const indexes = [];
  for (const id of order) {
    const phase = workflow.phases[id];
    if (!phase?.specIndex || !isSpecificationDefinitionPhase(phase)) continue;
    try { indexes.push(await readBoundSpecificationIndex(root, directory, workflow, phase)); } catch (error) {
      if (/_STALE$/.test(error.code ?? '')) continue;
      untrusted = true;
      findings.push(untrustedFinding(error, `The specification index of ${id}`));
    }
  }
  const stored = await loadSpecRecords(directory).catch(() => ({ acceptance: [] }));
  const base = selectActiveSpecRecords({ indexes, planned: [], observed: [], acceptance: stored.acceptance ?? [] }, workflow);
  // A claim for a clause a scope revision removed is history, not a broken record [E2G-008].
  const clauseIds = [...new Set([
    ...base.indexes.flatMap((index) => (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())),
    ...removedClauseIds(workflow)
  ])].sort();
  const maps = { planned: [], observed: [] };
  for (const id of order) {
    const phase = workflow.phases[id];
    for (const kind of ['planned', 'observed']) {
      if (!phase?.claimMaps?.[kind]) continue;
      try { maps[kind].push(await readBoundSpecificationClaimMap(root, directory, workflow, phase, kind, { clauseIds, policy })); } catch (error) {
        if (/_STALE$/.test(error.code ?? '')) continue;
        untrusted = true;
        findings.push(untrustedFinding(error, `The ${kind} claim map of ${id}`));
      }
    }
  }
  const amendment = planAmendmentRecord(workflow);
  return { records: { ...base, planned: amendment ? [...maps.planned, amendment] : maps.planned, observed: maps.observed }, untrusted };
}

/** Build the graph from records already in memory; the loader and the tests both use this. */
export function evidenceGraph({ workflow, records, deliveries = [], inspections = [], findings = [], untrusted = false, terminal = null, scope = null }) {
  // A completeness review counts only for the exact inventory it reviewed [E2G-007].
  const completenessReview = currentCompletenessReview(workflow, scope);
  const graph = { workflow, records, deliveries, inspections, findings, untrusted, terminal, scope, completenessReview };
  // What the evaluation was computed from, so a cache or a stored decision can tell whether its
  // inputs are still current without re-reading every record.
  graph.inputSha256 = `sha256:${recordSha256({
    workId: workflow.workItem.id,
    status: workflow.status ?? null,
    currentPhase: workflow.currentPhase ?? null,
    phases: Object.fromEntries((workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map((id) => {
      const phase = workflow.phases[id] ?? {};
      return [id, {
        status: phase.status ?? null, generation: phase.generation ?? 0,
        approvals: (phase.approvals ?? []).filter((item) => !item.invalidatedAt)
          .map((item) => ({ decision: item.decision, authorityGroup: item.authorityGroup ?? null, at: item.at ?? null }))
      }];
    })),
    records: {
      indexes: (records.indexes ?? []).map((index) => index.indexSha256 ?? recordSha256(index)),
      planned: (records.planned ?? []).map((map) => recordSha256(map)),
      observed: (records.observed ?? []).map((map) => recordSha256(map))
    },
    deliveries,
    inspections: inspections.map((entry) => ({ phaseId: entry.phaseId, sha256: recordSha256({ text: entry.text }) })),
    applicability: (workflow.applicability ?? []).filter((entry) => !entry.withdrawnAt)
      .map((entry) => ({ responsibility: entry.responsibility, authorityGroup: entry.authorityGroup ?? null, at: entry.at ?? null })),
    findings: findings.map((entry) => entry.code),
    scope: scope?.inventorySha256 ?? null,
    completenessReview: completenessReview ? recordSha256(completenessReview) : null,
    scopeRevision: workflow.scopeRevisions?.at(-1)?.revisionSha256 ?? null,
    riskDecisions: (workflow.riskDecisions ?? []).map((entry) => recordSha256(entry)),
    planAmendments: (workflow.planAmendments ?? []).map((entry) => recordSha256(entry))
  })}`;
  // A final evaluation counts only for the evidence it was made over.
  if (terminal == null && workflow.completion?.inputSha256 === graph.inputSha256) graph.terminal = workflow.completion;
  return graph;
}

/**
 * The approved artifacts of the steps that verify, for a Story with no code step: there a criterion
 * is verified by inspection, when an approved verification artifact cites it.
 */
async function loadInspections(root, directory, workflow, findings) {
  const phases = workflow.phases ?? {};
  if ((workflow.phaseOrder ?? []).some((id) => phaseRequiresCodeDelivery(phases[id]))) return [];
  const verifying = (workflow.resolution?.obligationGraph?.nodes ?? []).filter((node) => node.responsibilities.includes('verify'));
  const inspections = [];
  for (const node of verifying) {
    const phase = phases[node.id];
    const relative = phase?.requiredArtifact?.path;
    if (!relative || !['approved', 'awaiting_approval'].includes(phase.status)) continue;
    try {
      const text = await readFile(path.join(directory, relative), 'utf8');
      inspections.push({ phaseId: node.id, text: text.slice(0, 1024 * 1024) });
    } catch (error) {
      findings.push({
        code: 'EVIDENCE_INSPECTION_UNREADABLE', category: 'records', blocking: true, obligationIds: [],
        message: `The verification artifact of ${node.id} could not be read: ${error.message}`
      });
    }
  }
  return inspections;
}

/** The Story's accepted-scope inventory [E2G-006], or null with a finding when it cannot be built. */
async function loadScopeInventory(root, definition, workflow, directory, records, findings) {
  try {
    const source = await pinnedStorySource(root, { workItemRoot: workflow.resolution?.workItemRoot ?? definition?.workItemRoot }, workflow);
    const clauses = (records.indexes ?? []).flatMap((index) => index.clauses ?? []);
    const scopeNotApplicable = applicabilityStatus(workflow).some((entry) => entry.responsibility === 'scope' && entry.satisfied);
    return await buildScopeInventory(root, directory, workflow, { source, clauses, scopeNotApplicable });
  } catch (error) {
    findings.push({
      code: 'SCOPE_INVENTORY_UNAVAILABLE', category: 'records', blocking: true, obligationIds: [],
      message: `The accepted-scope inventory could not be built: ${error.message}`
    });
    return null;
  }
}

/** Read one Story's records from its checkout. Never throws for a record problem; reports it. */
export async function loadEvidenceGraph(root, { workId = null } = {}) {
  const accepted = await loadAcceptedStoryExecution(root, workId);
  return evidenceGraphFromAggregate(root, accepted.definition, accepted.workflow);
}

/**
 * The graph of an aggregate already in memory: a view passes the committed Story; the final check
 * passes the Story its transition is about to commit.
 */
export async function evidenceGraphFromAggregate(root, definition, workflow) {
  const directory = itemDirectory(root, { workItemRoot: workflow.resolution?.workItemRoot ?? definition?.workItemRoot }, workflow.workItem.id);
  const findings = [];
  let untrusted = false;
  const projected = await loadProjectedSpecRecords(root, directory, workflow, findings);
  const records = projected.records;
  untrusted = projected.untrusted;
  const deliveries = [];
  for (const id of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
    const phase = workflow.phases[id];
    if (phase?.deliveryEvidence) deliveries.push(await loadDelivery(root, phase, findings));
  }
  const inspections = await loadInspections(root, directory, workflow, findings);
  const scope = await loadScopeInventory(root, definition, workflow, directory, records, findings);
  return evidenceGraph({ workflow, records, deliveries, inspections, findings, untrusted, scope });
}
