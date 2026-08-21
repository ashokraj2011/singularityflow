/**
 * Host-neutral, bounded context for an attached developer session.
 *
 * This is a projection over governed records and existing intelligence. It never persists prompt
 * or source content, and it never treats context as gate evidence. Deeper slices are requested by
 * the gateway through newly sealed read handles rather than by accepting a path from a model.
 */
import { readFile } from 'node:fs/promises';

import { astContext } from './ast-intelligence.mjs';
import { head } from './git.mjs';
import { resolveWorldModelContext } from './grounding.mjs';
import { loadConfig, loadStoryAggregate } from './state-stores.mjs';
import { secureRepositoryPath } from './util.mjs';
import { inspectWorkflowGrounding } from './worldmodel.mjs';

export const CONTEXT_BRIEF_RESULT_VERSION = 1; // schema-transient: bounded gateway result, never persisted
export const CONTEXT_BRIEF_SLICES = Object.freeze(['brief', 'world-model', 'ast', 'evidence']);

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const BRIEF_TEXT_BUDGET = 12 * 1024;

function utf8Prefix(value, maximumBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= maximumBytes) return { text, bytes: Buffer.byteLength(text), truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  const prefix = text.slice(0, low);
  return { text: prefix, bytes: Buffer.byteLength(prefix), truncated: true };
}

function briefRecords(workflow, phaseId) {
  return (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).flatMap((producerId) => {
    const producer = workflow.phases?.[producerId];
    return (producer?.agentBriefs ?? [])
      .filter((entry) => entry.consumerPhase === phaseId)
      .map((entry) => ({ producerPhase: producerId, ...entry }));
  });
}

async function readBriefs(root, workflow, phaseId, budget) {
  const records = briefRecords(workflow, phaseId);
  const selected = [];
  let remaining = budget;
  for (const record of records) {
    const metadata = {
      producerPhase: record.producerPhase,
      consumerPhase: record.consumerPhase,
      generation: record.generation,
      status: record.status,
      path: record.renderedPath ?? record.path,
      sha256: record.renderedSha256 ?? record.integritySha256
    };
    if (record.status !== 'ready' || !record.renderedPath || remaining <= 0) {
      selected.push({ ...metadata, content: null, omission: record.status === 'ready' ? 'budget' : record.status });
      continue;
    }
    try {
      const resolved = await secureRepositoryPath(root, record.renderedPath, {
        label: 'Approved agent brief', mustExist: true, type: 'file'
      });
      const content = await readFile(resolved.absolute, 'utf8');
      const bounded = utf8Prefix(content, remaining);
      remaining -= bounded.bytes;
      selected.push({ ...metadata, content: bounded.text, bytes: bounded.bytes, truncated: bounded.truncated });
    } catch {
      selected.push({ ...metadata, content: null, omission: 'unavailable' });
    }
  }
  return { records: selected, bytes: budget - remaining };
}

async function worldModelSlice(root, workflow, phaseId, budget) {
  try {
    const inspected = await inspectWorkflowGrounding(root, workflow, phaseId, { refreshRemote: false });
    if (!inspected.availability?.ready) {
      return { status: 'unavailable', reason: inspected.reason, selections: [], bytes: 0 };
    }
    const resolved = await resolveWorldModelContext(root, inspected.config, phaseId, {
      plan: inspected.plan,
      located: inspected.availability.located
    });
    const selections = [];
    let remaining = budget;
    for (const selected of resolved.selected) {
      const metadata = {
        path: selected.relative,
        sha256: selected.sha256,
        sourceBytes: selected.size,
        level: selected.level,
        reason: selected.reason
      };
      if (remaining <= 0) {
        selections.push({ ...metadata, content: null, omission: 'budget' });
        continue;
      }
      const content = await readFile(selected.absolute, 'utf8');
      const bounded = utf8Prefix(content, remaining);
      remaining -= bounded.bytes;
      selections.push({ ...metadata, content: bounded.text, bytes: bounded.bytes, truncated: bounded.truncated });
    }
    return {
      status: resolved.freshness?.fresh ? 'exact' : 'partial',
      source: resolved.located?.source ?? null,
      commit: resolved.located?.commit ?? null,
      selections,
      bytes: budget - remaining
    };
  } catch (error) {
    return { status: 'unavailable', reason: error.code ?? error.message, selections: [], bytes: 0 };
  }
}

function evidenceSlice(workflow) {
  const submissions = (workflow.lineage?.submissions ?? []).map((entry) => ({
    phase: entry.phase,
    generation: entry.generation,
    path: entry.path,
    packetSha256: entry.packetSha256,
    sourceCommit: entry.sourceCommit ?? null
  }));
  const approvals = Object.values(workflow.phases ?? {}).flatMap((phase) =>
    (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt).map((entry) => ({
      phase: phase.id,
      generation: entry.generation,
      decision: entry.decision,
      authorityGroup: entry.authorityGroup ?? null,
      at: entry.at ?? null
    }))
  );
  return { status: 'exact', submissions, approvals };
}

function withinOutputBudget(result, maximumOutputBytes) {
  if (Buffer.byteLength(JSON.stringify(result)) <= maximumOutputBytes) return result;
  return {
    ...result,
    payload: {
      status: 'partial',
      summary: 'This context slice exceeded the response budget. Request a narrower governed slice.'
    },
    accounting: {
      ...result.accounting,
      includedContentBytes: 0,
      estimatedInputTokens: 0
    },
    omissions: [...new Set([...(result.omissions ?? []), 'output-budget'])].sort()
  };
}

/** Compose one bounded page. The gateway owns and seals navigation to subsequent slices. */
export async function composeContextBrief(root, {
  workId,
  slice = 'brief',
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  if (!CONTEXT_BRIEF_SLICES.includes(slice)) throw new Error(`Unsupported context slice '${slice}'.`);
  const budget = Math.min(MAX_OUTPUT_BYTES, Math.max(4096, Number(maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES));
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, workId);
  const phaseId = workflow.currentPhase;
  const sourceCommit = head(root) ?? null;
  const base = {
    schemaVersion: CONTEXT_BRIEF_RESULT_VERSION,
    kind: 'context-brief',
    work: {
      id: workflow.workItem.id,
      title: cleanBoundedTitle(workflow.workItem.title),
      workType: workflow.workItem.workType,
      sourceStableId: workflow.workItem.source?.stableId ?? null
    },
    phase: phaseId ? {
      id: phaseId,
      generation: workflow.phases?.[phaseId]?.generation ?? null,
      status: workflow.phases?.[phaseId]?.status ?? null
    } : null,
    sourceRevision: {
      commit: sourceCommit,
      lifecycleRevision: workflow.lineage?.lastPublishedCommit ?? sourceCommit
    },
    slice,
    guidanceOnly: true
  };

  let payload;
  let includedBytes = 0;
  const omissions = [];
  if (slice === 'brief') {
    const briefs = await readBriefs(root, workflow, phaseId, Math.min(BRIEF_TEXT_BUDGET, budget));
    includedBytes = briefs.bytes;
    payload = {
      summary: `${workflow.workItem.id} is ${workflow.status} in ${phaseId ?? 'complete'}.`,
      approvedBriefs: briefs.records
    };
    if (!briefs.records.length) omissions.push('approved-agent-briefs-unavailable');
    if (briefs.records.some((entry) => entry.truncated || entry.omission === 'budget')) omissions.push('approved-agent-briefs-bounded');
  } else if (slice === 'world-model') {
    payload = await worldModelSlice(root, workflow, phaseId, budget);
    includedBytes = payload.bytes;
    if (payload.status === 'unavailable') omissions.push('world-model-unavailable');
    if (payload.selections?.some((entry) => entry.truncated || entry.omission === 'budget')) omissions.push('world-model-bounded');
  } else if (slice === 'ast') {
    try {
      payload = await astContext(root, {
        'max-files': 50,
        'max-facts': 200,
        'max-output-bytes': budget
      });
      includedBytes = Buffer.byteLength(JSON.stringify(payload));
      if (payload.status === 'partial' || payload.nextCursor) omissions.push('ast-bounded');
    } catch (error) {
      payload = { status: 'unavailable', reason: error.code ?? error.message };
      omissions.push('ast-unavailable');
    }
  } else {
    payload = evidenceSlice(workflow);
    includedBytes = Buffer.byteLength(JSON.stringify(payload));
  }

  const result = {
    ...base,
    payload,
    accounting: {
      maximumOutputBytes: budget,
      includedContentBytes: includedBytes,
      estimatedInputTokens: Math.ceil(includedBytes / 4),
      estimationMethod: 'utf8-bytes-divided-by-four',
      exact: false
    },
    omissions: [...new Set(omissions)].sort(),
    expansion: CONTEXT_BRIEF_SLICES.filter((candidate) => candidate !== slice)
  };
  return withinOutputBudget(result, budget);
}

function cleanBoundedTitle(value) {
  return utf8Prefix(String(value ?? ''), 512).text;
}
