/**
 * The human decisions a step owes the Story's ending, read before the ending needs them.
 *
 * Two kinds are decided only by people, and the final evaluation refuses the ending without them:
 * a visual or inspection witness, recorded by an approver of the step that delivers the criterion,
 * and a disposition of each requirement statement in the Story's sources (an SRI scope item),
 * recorded by an approver of the step that defines the scope. A Story used to learn of both at its
 * last approval. Readiness, the approval review and later steps' entry packets now list each with
 * its exact command. Nothing here blocks, records or decides: only the authorized person may.
 */
import { stepResponsibilities } from './phase-roles.mjs';
import { WITNESS_CHECKLIST } from './verification/witness-records.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

const MAX_LISTED = 8;
const MAX_TEXT = 160;

// The evidence modules load only when a witnessing step is read; readiness of any other step and
// the terminal lines below pay nothing for them.
async function evidenceReader() {
  const [{ evidenceGraphFromAggregate, previewScopeInventory }, { evaluateEvidence }, { mergedVerificationContracts }, { plannedClaimsForObservedPhase }] = await Promise.all([
    import('./evidence/graph.mjs'), import('./evidence/evaluate.mjs'), import('./verification/contracts.mjs'), import('./specifications.mjs')
  ]);
  return { evidenceGraphFromAggregate, previewScopeInventory, evaluateEvidence, mergedVerificationContracts, plannedClaimsForObservedPhase };
}

function witnessesOf({ mergedVerificationContracts, plannedClaimsForObservedPhase }, workflow, graph, evaluation, phaseId) {
  const owned = plannedClaimsForObservedPhase(workflow, phaseId, graph.records.planned ?? []);
  const contracts = mergedVerificationContracts(graph.records.planned ?? []);
  const witnesses = [];
  for (const [clauseId, claim] of Object.entries(owned)) {
    const row = evaluation.rows.find(row => row.id === clauseId);
    const contract = contracts.get(clauseId);
    if (!contract || !row || row.type !== 'AC') continue;
    // A primary 'any' contract already fulfilled by another slot needs no extra witness.
    const slots = row.verification?.contract?.slots ?? [];
    if (contract.combination === 'any' && slots.some(slot => slot.role === 'primary' && slot.status === 'met')) continue;
    // Whoever approves a step that delivers or verifies the criterion may witness it.
    const owners = [...new Set((row.obligations ?? []).filter(entry => ['verify', 'implement'].includes(entry.responsibility))
      .flatMap(entry => entry.owningSteps ?? []))];
    for (const slot of contract.slots.filter(slot => slot.role === 'primary' && ['visual', 'inspection'].includes(slot.method))) {
      const status = slots.find(result => result.slot === slot.slot)?.status ?? 'pending';
      const files = slot.method === 'inspection' ? [slot.witness.path]
        : (claim.obligations ?? [claim]).filter(entry => entry.fulfillment === 'evidence').flatMap(entry => entry.expectedPaths ?? []);
      const unique = [...new Set(files)];
      const shell = safeCommandGuidance({ executable: 'singularity-flow', argv: ['decision', 'witness',
        '--work-id', workflow.workItem.id, '--criterion', clauseId, '--slot', slot.slot,
        '--file', unique.length === 1 ? unique[0] : '<EVIDENCE-PATH>', '--reason', '<review-reason>',
        ...WITNESS_CHECKLIST.flatMap(item => ['--confirm', item]), '--json'] });
      // /sf-decide handles workflow decisions, not this exact witness operation. Do not
      // route the reviewer into that unrelated menu or let an agent pre-answer a checklist.
      const command = { ...shell, skill: null, copilotCommand: null, copilotStatus: 'unavailable',
        copilotReason: 'Use the human witness terminal or VS Code witness review. /sf-decide does not implement decision witness.' };
      witnesses.push({ clauseId, slot: slot.slot, method: slot.method, status, files: unique, owners,
        checklist: WITNESS_CHECKLIST, commandGuidance: command, humanRequired: true,
        availableAfterPublication: true, availableAfterSubmission: true, contractClassificationIsWitness: false,
        detail: 'After submission pins fresh candidate/test evidence, an authorized human must inspect the published candidate and exact file before confirming every checklist item. No agent may answer this checklist.' });
    }
  }
  return witnesses;
}

export async function phaseWitnessObligations(root, config, workflow, phase) {
  const reader = await evidenceReader();
  const graph = await reader.evidenceGraphFromAggregate(root, config, workflow);
  if (graph.untrusted) return { witnesses: [], findings: graph.findings.filter(f => f.blocking !== false)
    .map(f => ({ ...f, category: 'integrity' })) };
  return { witnesses: witnessesOf(reader, workflow, graph, reader.evaluateEvidence(graph), phase.id), findings: [] };
}

/** The steps up to and including `phaseId`, or before it when `inclusive` is false. */
export function stepsThrough(workflow, phaseId, { inclusive = true } = {}) {
  const order = workflow?.phaseOrder ?? [];
  const index = order.indexOf(phaseId);
  return index < 0 ? [] : order.slice(0, inclusive ? index + 1 : index);
}

/** The steps among `phaseIds` that hold any of `responsibilities`. */
export function stepsHolding(workflow, phaseIds, responsibilities) {
  return phaseIds.filter((id) => stepResponsibilities(workflow, id).some((entry) => responsibilities.includes(entry)));
}

/** Steps whose approvers may witness a criterion: those that implement or verify. */
export function witnessingSteps(workflow, phaseIds) {
  return stepsHolding(workflow, phaseIds, ['implement', 'verify']);
}

function listed(entries) {
  return { entries: entries.slice(0, MAX_LISTED), more: Math.max(0, entries.length - MAX_LISTED) };
}

/** Statements of the Story's sources nobody has linked to a clause or dispositioned. */
function scopeItemsOf(workflow, inventory) {
  return (inventory?.items ?? []).filter((item) => item.disposition === 'unresolved').map((item) => {
    const text = String(item.text ?? '').replace(/\s+/gu, ' ').trim();
    return { id: item.id, source: item.line ? `${item.sourceId}:${item.line}` : item.sourceId, kind: item.kind ?? null, humanRequired: true,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
      command: `singularity-flow decision scope ${workflow.workItem.id} --item ${item.id} --as <included|existing|excluded|deferred|informative|duplicate|superseded> --reason "<why>"` };
  });
}

/**
 * Every sign-off and scope disposition still owed by the steps named, from one evidence read, at
 * most MAX_LISTED of each; null when none is owed. Advisory: an unreadable evidence graph reports
 * itself unavailable and nothing here throws.
 */
export async function owedDecisions(root, config, workflow, phaseIds) {
  const witnessing = witnessingSteps(workflow, phaseIds);
  const scoping = stepsHolding(workflow, phaseIds, ['scope']);
  if (!witnessing.length && !scoping.length) return null;
  try {
    const reader = await evidenceReader();
    const graph = await reader.evidenceGraphFromAggregate(root, config, workflow);
    // A specification step awaiting approval is not trusted evidence until approval re-binds its
    // index, so its scope is previewed from what it submitted; witnesses wait for trusted evidence.
    if (graph.untrusted && !scoping.length) return { advisory: true, status: 'unavailable', reason: 'evidence-untrusted' };
    const evaluation = graph.untrusted ? null : reader.evaluateEvidence(graph);
    const seen = new Set();
    const witnesses = !evaluation ? [] : witnessing.flatMap((phaseId) => witnessesOf(reader, workflow, graph, evaluation, phaseId)
      .filter((witness) => witness.status !== 'met' && witness.owners.includes(phaseId)))
      .filter((witness) => !seen.has(`${witness.clauseId}\u0000${witness.slot}`) && seen.add(`${witness.clauseId}\u0000${witness.slot}`))
      .map((witness) => ({ clauseId: witness.clauseId, slot: witness.slot, method: witness.method, status: witness.status,
        files: witness.files, owners: witness.owners, humanRequired: true, command: witness.commandGuidance.command ?? null }));
    const scopeItems = !scoping.length ? []
      : scopeItemsOf(workflow, graph.untrusted ? await reader.previewScopeInventory(root, config, workflow) : graph.scope);
    if (!witnesses.length && !scopeItems.length) return null;
    const owedWitnesses = listed(witnesses), owedScope = listed(scopeItems);
    return { advisory: true, status: 'owed',
      witnesses: owedWitnesses.entries, scopeItems: owedScope.entries, more: { witnesses: owedWitnesses.more, scopeItems: owedScope.more },
      instruction: 'Relay each item with its exact command to the user. Only a person who approves the owning step decides these: a sign-off after inspecting its file, a scope item by linking or dispositioning the statement; an agent never records or answers them. The Story cannot end without them. This does not block the current step.' };
  } catch (error) {
    return { advisory: true, status: 'unavailable', reason: error?.code ?? 'evaluation-failed' };
  }
}

/** Terminal lines for owed decisions; nothing when none is owed. */
export function owedDecisionLines(owed) {
  if (!owed) return [];
  if (owed.status === 'unavailable') return [`Owed decisions: unavailable (${owed.reason}); see singularity-flow evidence matrix.`];
  const lines = [];
  const witnessCount = owed.witnesses.length + owed.more.witnesses;
  if (witnessCount) {
    lines.push(`Owed sign-offs (${witnessCount}, human only, not blocking this step):`);
    for (const witness of owed.witnesses) {
      lines.push(`  ${witness.clauseId} ${witness.slot} (${witness.method}${witness.files.length ? `: ${witness.files.join(', ')}` : ''}) — inspect it first, then:`,
        `    ${witness.command ?? 'singularity-flow evidence matrix --json'}`);
    }
    if (owed.more.witnesses) lines.push(`  …and ${owed.more.witnesses} more: singularity-flow evidence matrix --json`);
  }
  const scopeCount = owed.scopeItems.length + owed.more.scopeItems;
  if (scopeCount) {
    lines.push(`Open scope items (${scopeCount}, human only, not blocking this step):`);
    for (const item of owed.scopeItems) lines.push(`  ${item.id} ${item.source ?? ''}: "${item.text}"`, `    ${item.command}`);
    if (owed.more.scopeItems) lines.push(`  …and ${owed.more.scopeItems} more: singularity-flow evidence scope`);
  }
  return lines;
}
