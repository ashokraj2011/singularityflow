/** Early repair guidance, never a new publication/approval gate or an automatic scope decision. */
import path from 'node:path';
import { finalScopeStep, ownerStepChecks, phaseOwnsScope } from '../phase-roles.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { decisionListRoute } from '../upstream-routes.mjs';
import { SingularityFlowError } from '../util.mjs';
import { scopeAuthorities } from './decisions.mjs';
import { scopeDecisionArgv, scopeDecisionCommandLine } from './extract.mjs';

export { finalScopeStep, phaseOwnsScope };

/** Read the actual current draft while it is still repairable, not only its later submitted index. */
export async function scopeAuthoringCheckpoint(root, definition, workflow, phase) {
  if (!phaseOwnsScope(workflow, phase)) return null;
  const { requiresProspectivePhaseInspection } = await import('../code-submission-evidence.mjs');
  const draftPreview = workflow.currentPhase === phase.id && requiresProspectivePhaseInspection(workflow, phase);
  const inspect = safeCommandGuidance({ argv: ['evidence', 'scope', workflow.workItem.id, '--json'] });
  const common = { advisory: true, blocking: false, ownerPhase: phase.id, previewOnly: true,
    draftPreview, mutationAuthority: false, humanAuthorities: scopeAuthorities(workflow), inspect };
  try {
    const { previewScopeInventory } = await import('../evidence/graph.mjs');
    const diagnostics = [];
    const inventory = await previewScopeInventory(root, definition, workflow, { draftPhase: draftPreview ? phase : null, diagnostics });
    if (!inventory) throw Object.assign(new Error(diagnostics[0]?.message ?? 'The scope inventory is unavailable.'), {
      code: diagnostics[0]?.code ?? 'scope-preview-unavailable'
    });
    if (!inventory.sources.length) throw new Error('No readable or unreadable Story scope sources were found.');
    const unresolved = inventory.items.filter(item => item.disposition === 'unresolved');
    const artifact = phase.requiredArtifact?.path;
    const artifactPath = artifact ? path.posix.join(
      String(workflow.resolution?.workItemRoot ?? definition.workItemRoot ?? 'singularity/work-items').replaceAll('\\', '/'),
      workflow.workItem.id, artifact) : null;
    return { ...common, status: unresolved.length ? draftPreview ? 'repair-or-human-decision' : 'human-decision' : 'covered',
      inventorySha256: inventory.inventorySha256, sourceSetSha256: inventory.sourceSetSha256,
      total: inventory.items.length, unresolvedCount: unresolved.length,
      message: unresolved.length
        ? `Scope advisory: ${unresolved.length} source item(s) need a clause link or an authorized human scope decision in ${phase.id}. ${draftPreview ? 'Repair clear draft omissions now' : 'Preserve the retained artifact; author repairs need its authorized successor route'}; human decisions may include, exclude or defer with a reason. This does not block publishing this phase, but ${holdsScopeApproval(workflow, phase) ? `approving ${phase.id} waits until` : 'the Story cannot finish until'} each item is linked or decided; ordinary approval is not a scope disposition.`
        : null,
      items: unresolved.slice(0, 8).map(item => ({ id: item.id, sourceId: item.sourceId,
        text: item.text, statementSha256: item.statementSha256, kind: item.kind,
        repair: draftPreview && item.kind === 'statement' ? { scope: 'current-draft', artifactPath,
          sourceReference: `[scope:${item.id}]`, requiresSubstantiveClause: true,
          instruction: 'Use the supplied intent to repair or add a real observable clause in this draft, linking this source reference inside that clause. A reference is a coverage claim, never a test pass or an approval. If interpretation or scope must change, that is the person\'s decision: name this item\'s humanDecision route, never ask for a disposition in this turn.' } : null,
        humanDecision: { requiresActualHumanChoice: true, requiresReason: true,
          includedOrExistingRequiresClause: true,
          // Included or existing names its clauses; every other disposition refuses --clause.
          commandGuidance: safeCommandGuidance({ argv: scopeDecisionArgv(workflow.workItem.id, item.id).linked }),
          otherCommandGuidance: safeCommandGuidance({ argv: scopeDecisionArgv(workflow.workItem.id, item.id).unlinked }) }
      })),
      more: Math.max(0, unresolved.length - 8),
      instruction: unresolved.length
        ? `${draftPreview ? 'Repair clear source-to-clause coverage in this scope-owning draft before handoff.' : 'This is a retained publication, not editable draft coverage: preserve it and use only a returned successor or human decision route.'} Do not stop solely on this advisory or loop on unchanged output. For ambiguity, exclusions, deferral or unreadable sources, name each item's humanDecision route: a person records the disposition in a /sf-decide turn they start, so never ask for one in this turn or invent one. A source nobody could read (kind source) has no clause reference; only that decision closes it. Ordinary phase approval is not a waiver. Unchanged recorded decisions and approved clause links carry forward; later phases must not edit this earlier artifact.`
        : 'Every identified source statement is linked or dispositioned. This draft preview is not approval or proof that implementation/tests pass.' };
  } catch (error) {
    return { ...common, status: 'unavailable', reason: error.code ?? 'scope-preview-unavailable',
      message: `Scope advisory unavailable: ${error.message}`,
      instruction: 'Scope preview is unavailable, not a passing or completed scope review. Keep the existing phase gates and show the read-only inspection route; never auto-exclude sources.' };
  }
}

/** Whether this step's approval waits for every statement's disposition: its Story pinned the owner-step checks and it defines the scope last. */
export function holdsScopeApproval(workflow, phase) {
  return ownerStepChecks(workflow) && finalScopeStep(workflow)?.id === phase?.id;
}

/**
 * The step that defines the scope last is approved only once each statement of the Story's sources is
 * linked to its clauses or dispositioned by a person [PHR:REQ-002], finding 10. The ending refused it
 * as SCOPE_ITEMS_UNRESOLVED, when nobody who decides scope was looking; here its approvers decide it,
 * in the decision list (a scope disposition is review-safe, so the submission stands). An inventory
 * that cannot be built here holds nothing: the ending reads it again.
 */
export async function assertScopeDispositioned(root, definition, workflow, phase) {
  if (!holdsScopeApproval(workflow, phase)) return;
  const { previewScopeInventory } = await import('../evidence/graph.mjs');
  const refusal = scopeDispositionRefusal(workflow, phase, await previewScopeInventory(root, definition, workflow).catch(() => null));
  if (refusal) throw refusal;
}

/** The refusal for a scope step whose inventory still has a statement nobody dispositioned, or null. */
export function scopeDispositionRefusal(workflow, phase, inventory) {
  if (!holdsScopeApproval(workflow, phase)) return null;
  const unresolved = (inventory?.items ?? []).filter((item) => item.disposition === 'unresolved');
  if (!unresolved.length) return null;
  const workId = workflow.workItem.id;
  const items = unresolved.slice(0, 8).map((item) => {
    const argv = scopeDecisionArgv(workId, item.id);
    return { id: item.id, source: item.line ? `${item.sourceId}:${item.line}` : item.sourceId, kind: item.kind ?? null,
      text: String(item.text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240),
      command: scopeDecisionCommandLine(argv.linked), otherCommand: scopeDecisionCommandLine(argv.unlinked) };
  });
  const list = decisionListRoute(workId);
  return new SingularityFlowError(
    `${phase.id} cannot be approved while ${unresolved.length} statement(s) of this Story's sources have no disposition (the first: ${unresolved[0].id}). `
    + `${phase.id} defines the Story's scope, so its approvers link each statement to the clauses that carry it, or include, exclude or defer it with a reason, in the decision list; approving is not a scope disposition.`,
    { code: 'SCOPE_ITEMS_UNRESOLVED', details: { workId, phase: phase.id, ownerPhase: phase.id, scopePhase: phase.id,
      authorities: scopeAuthorities(workflow), items, more: Math.max(0, unresolved.length - items.length),
      nextAction: { command: list.command, skill: list.skill, label: `An approver of ${phase.id} decides each statement in the decision list, then approves.` },
      recoveryCommands: [{ command: items[0].command, label: 'Include it through the clauses that carry it.' },
        { command: items[0].otherCommand, label: 'Or exclude, defer or mark it informative, with a reason.' }] } }
  );
}
