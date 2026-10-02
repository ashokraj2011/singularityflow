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
import { readRecord } from '../schema-migrations.mjs';
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
    let record = null;
    try { record = readRecord('test-execution', await readFile(path.join(root, entry.receiptPath))).record; } catch (error) {
      findings.push({
        code: 'EVIDENCE_TEST_RECEIPT_UNREADABLE', category: 'records', blocking: true, obligationIds: [],
        message: `The test receipt for '${entry.commandId}' in ${phase.id} could not be read: ${error.message}`
      });
    }
    executions.push({
      commandId: entry.commandId, kind: entry.kind ?? 'test-execution', status: entry.status ?? null,
      receiptPath: entry.receiptPath, record: record ? { status: record.status, tests: record.tests ?? {} } : null
    });
  }
  return {
    phaseId: phase.id,
    generation: phase.generation,
    status: evidence.status ?? null,
    validation: evidence.validation ? { status: evidence.validation.status } : null,
    testRecovery: evidence.testRecovery ? { disposition: evidence.testRecovery.disposition, observedOutcome: evidence.testRecovery.observedOutcome } : null,
    acceptanceCriteria: evidence.acceptanceCriteria
      ? { bindings: (evidence.acceptanceCriteria.bindings ?? []).map((binding) => ({ clauseId: binding.clauseId, testSource: binding.testSource })) }
      : null,
    receipt: receipt ? {
      status: receipt.status ?? null,
      traceability: {
        bindings: (receipt.traceability?.bindings ?? []).map((binding) => ({
          clauseId: binding.clauseId, testSource: binding.testSource, commandId: binding.commandId ?? null
        }))
      }
    } : null,
    executions
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
  const clauseIds = [...new Set(base.indexes.flatMap((index) => (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())))].sort();
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
  return { records: { ...base, planned: maps.planned, observed: maps.observed }, untrusted };
}

/** Build the graph from records already in memory; the loader and the tests both use this. */
export function evidenceGraph({ workflow, records, deliveries = [], findings = [], untrusted = false, terminal = null }) {
  const graph = { workflow, records, deliveries, findings, untrusted, terminal };
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
    findings: findings.map((entry) => entry.code)
  })}`;
  return graph;
}

/** Read one Story's records from its checkout. Never throws for a record problem; reports it. */
export async function loadEvidenceGraph(root, { workId = null } = {}) {
  const accepted = await loadAcceptedStoryExecution(root, workId);
  const workflow = accepted.workflow;
  const directory = itemDirectory(root, accepted.definition, workflow.workItem.id);
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
  return evidenceGraph({ workflow, records, deliveries, findings, untrusted });
}
