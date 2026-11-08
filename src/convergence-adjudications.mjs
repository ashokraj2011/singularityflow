/**
 * What a person decides at convergence, read once for every surface: `story adjudications`, the
 * Adjudicate page, `/adjudicate` and the one decisions list [SCS:REQ-030]. Each records through
 * `story adjudicate --answers` with the digest read here, so a person sees and is asked the same thing
 * wherever they work, and a list that moved since records nothing.
 *
 * Read-only. Lifted out of commands/story.mjs so the decision list reads it without loading the
 * Story command module, which nothing on a read path needs.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { matchApprovalAuthority, normalizeApprovalAuthorities } from './approval-authority.mjs';
import { DISPOSITIONS, decodeConvergenceRecord, findingAdjudication } from './convergence.mjs';
import { currentConvergenceContext } from './convergence-context.mjs';
import { actionActor } from './git.mjs';
import { convergencePhaseOf } from './phase-roles.mjs';
import { recordSha256 } from './records.mjs';
import { exists, posix, SingularityFlowError } from './util.mjs';

/** Each disposition as a person reads it [SPK:REQ-079]. */
export const DISPOSITION_WORDS = Object.freeze({ 'accepted-deviation': 'Accept as is', rework: 'Send back to fix',
  'update-intent': 'The spec should change', dismissed: 'Not a real finding', deferred: 'Decide later' });

export function convergenceRecordRelative(itemRelative, iteration) {
  return posix(path.join(itemRelative, 'context', 'convergence', `iteration-${iteration}.json`));
}

export async function readConvergence(root, itemRelative, iteration) {
  const relative = convergenceRecordRelative(itemRelative, iteration);
  if (!(await exists(path.join(root, relative)))) return null;
  try {
    return decodeConvergenceRecord(await readFile(path.join(root, relative)), { iteration });
  } catch (error) {
    if (['SCHEMA_VERSION_FUTURE', 'SCHEMA_VERSION_ARCHIVED'].includes(error?.code)) throw error;
    throw new SingularityFlowError(
      `Convergence record '${relative}' is corrupt and cannot authorize a decision: ${error.message}`,
      { code: error.code ?? 'CONVERGENCE_RECORD_CORRUPT', details: { path: relative }, cause: error }
    );
  }
}

/** The convergence step a person may adjudicate now, or null: read from the Story alone, before any file. */
export function openConvergencePhase(workflow) {
  const phase = convergencePhaseOf(workflow);
  return phase && workflow.currentPhase === phase.id && phase.status === 'in_progress' ? phase : null;
}

function decidedBy(root, config, workflow, phase, actor) {
  const authorities = workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities;
  const groups = phase.approvalPolicy?.authorities ?? [];
  let registry = {};
  try { registry = normalizeApprovalAuthorities(authorities); } catch { registry = {}; }
  const labels = groups.map((id) => registry?.[id]?.label ?? id);
  let allowed = false;
  try { allowed = matchApprovalAuthority(authorities, phase.approvalPolicy, actor ?? actionActor(root)).authorized === true; } catch { allowed = false; }
  return { groups, labels, allowed, words: `${allowed ? 'You may decide these' : `The ${labels.join(' or ')} decide these`}${allowed && labels.length ? ` (${labels.join(' or ')})` : ''}.` };
}

/**
 * Everything a person decides at convergence, on one page: what changed, what the plan already says
 * about it, and what is decided. `actor` names who is asking; `null` (the decision list, which says
 * who decides each item itself) leaves `decidedBy` out. Neither changes the digest.
 */
export async function adjudicationList(root, config, workflow, { actor } = {}) {
  const phase = convergencePhaseOf(workflow);
  const base = { schemaVersion: 1, resultType: 'sflow-adjudications', workId: workflow.workItem.id, phase: phase?.id ?? null, repositoryPath: root };
  if (!openConvergencePhase(workflow)) {
    return { ...base, status: 'not-open', items: [], open: 0, message: 'There is nothing to adjudicate: this Story is not at an open convergence step.' };
  }
  const subject = await currentConvergenceContext(root, config, workflow);
  const projection = await readConvergence(root, subject.itemRelative, subject.iteration);
  if (!projection) return { ...base, status: 'not-prepared', items: [], open: 0, message: `Convergence has not been prepared. Run singularity-flow prepare ${phase.id}.` };
  const changed = new Map((subject.reconciliation?.findings ?? []).map((finding) => [posix(finding.path), finding]));
  const planSays = (file) => subject.planAccount(changed.get(file) ?? { path: file });
  const decided = new Map((projection.findings ?? []).map((finding) => [finding.itemId, findingAdjudication(finding)]));
  const decisionOn = (id) => {
    const decision = decided.get(id);
    return decision ? { disposition: decision.disposition, reason: decision.reason ?? null, clauseIds: decision.clauseIds ?? [], actor: decision.actor ?? null, at: decision.at ?? null,
      replaced: (decision.replaced ?? []).map(({ disposition, reason, actor: who, at }) => ({ disposition, reason: reason ?? null, actor: who, at })) } : null;
  };
  const items = [...(projection.facts ?? []), ...(projection.candidateSnapshot ?? [])].map((item) => {
    return { id: item.id, kind: item.kind ?? 'item', paths: item.paths ?? [], clauseIds: item.clauseIds ?? [], detail: item.detail ?? item.summary ?? null,
      plan: (item.paths ?? []).map(planSays).find(Boolean) ?? null,
      // One reason may cover only changed files no requirement claims: a failing test or a missing bound test gets its own answer.
      acceptAll: item.kind === 'unclaimed-changed-path',
      decision: decisionOn(item.id),
      // What an assisted pass proposed, and the facts it cites: the decision list asks once about one problem [SCS:REQ-031].
      ...(item.classification ? { classification: item.classification, text: item.text ?? null, factIds: item.factIds ?? [] } : {}) };
  });
  // Files that changed together for how tests run are one row wherever a person is asked; each still gets its own record.
  const open = (item) => item.kind === 'unclaimed-changed-path' && !item.decision && !item.plan && item.paths.length === 1;
  const setup = new Set((await import('./test-support-files.mjs')).testSetupFiles(items.filter(open).map((item) => item.paths[0])));
  for (const item of items) if (open(item) && setup.has(posix(item.paths[0]))) item.group = 'test-setup';
  // Not a question, and never out of sight: each says which entry of the plan answered it.
  const settled = (projection.settledByPlan ?? []).map((item) => ({ id: item.id, paths: item.paths, clauseIds: item.clauseIds, settledBy: item.settledBy, decision: decisionOn(item.id) }));
  return { ...base, status: 'open', iteration: subject.iteration, items, settled, open: items.filter((item) => !item.decision).length,
    // The Story's clause IDs, which an update-intent may name.
    clauses: [...new Set((subject.records?.indexes ?? []).flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)))].sort(),
    ...(setup.size ? { groupWords: { 'test-setup': 'These changed together for how tests run: one change, so one decision. Each file is still recorded by name.' } } : {}),
    ...(actor === null ? {} : { decidedBy: decidedBy(root, config, workflow, phase, actor) }),
    dispositions: DISPOSITIONS.map((id) => ({ id, label: DISPOSITION_WORDS[id] ?? id })),
    digest: `sha256:${recordSha256({ iteration: subject.iteration, settled: settled.map(({ id, settledBy, decision }) => ({ id, settledBy, decision: decision && { disposition: decision.disposition, reason: decision.reason, clauseIds: decision.clauseIds } })), items: items.map(({ id, paths, decision }) =>
      ({ id, paths, decision: decision && { disposition: decision.disposition, reason: decision.reason, clauseIds: decision.clauseIds } })) })}` };
}
