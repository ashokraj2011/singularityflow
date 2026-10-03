/**
 * `singularity-flow evidence scope [WORK-ID]`: the Story's accepted-scope inventory [E2G-006].
 *
 * A view: it reads the Story's sources and records, changes nothing, runs no test and makes no
 * network call. Every requirement statement found in the sources is listed with its disposition,
 * and every source that could not be read is listed as unreadable.
 */
import { repoRoot } from '../git.mjs';
import { loadEvidenceGraph } from '../evidence/graph.mjs';
import { action, because, commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
  const graph = await loadEvidenceGraph(root, { workId: positionals[2] ?? null });
  const inventory = graph.scope;
  if (!inventory) {
    const reason = graph.findings.find((entry) => entry.code === 'SCOPE_INVENTORY_UNAVAILABLE')?.message ?? 'unknown reason';
    throw new SingularityFlowError(reason, { code: 'SCOPE_INVENTORY_UNAVAILABLE' });
  }
  return emitCommandResult(commandResult({
    operation: { id: 'evidence.scope', classification: 'read' },
    subject: { kind: 'story', id: inventory.workId },
    outcome: succeeded('evidence.scope.reported', {
      workId: inventory.workId, items: inventory.items.length, unresolved: inventory.summary.unresolved,
      sources: inventory.sources.length
    }),
    effects: noEffects(),
    why: [because('scope.from-pinned-sources', 'evidence', { ref: inventory.workId, topic: 'evidence-matrix' })],
    restState: 'informational',
    next: inventory.structurallyComplete && !graph.completenessReview ? [action({
      id: 'scope-completeness-review',
      label: 'Review the interpretation, then answer each checklist article once (completeness, ambiguity, consistency, verifiability, boundary-conditions, non-functional) and say what you assessed; a review never says the scope is correct.',
      command: `singularity-flow decision completeness ${inventory.workId} --confirm ${inventory.inventorySha256} --article <article>=satisfied|exception|not-applicable --reason <reason>`,
      kind: 'review'
    })] : [],
    data: { scope: inventory, completenessReview: graph.completenessReview ?? null }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
