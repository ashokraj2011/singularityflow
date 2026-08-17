import { approvalChainSnapshot } from '../approval-chain.mjs';
import { branch, repoRoot } from '../git.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { because, commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean } from '../util.mjs';

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
  const reference = positionals[1] ?? branch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference,
    kind: 'story',
    required: true
  });
  const snapshot = approvalChainSnapshot(selected.state);
  return emitCommandResult(commandResult({
    operation: { id: 'approvals', classification: 'read' },
    subject: { kind: 'story', id: snapshot.workItem.id },
    outcome: succeeded('approvals.reported', {
      workId: snapshot.workItem.id,
      phases: snapshot.summary.phases,
      documents: snapshot.summary.documents,
      received: snapshot.summary.approvalsReceived,
      required: snapshot.summary.approvalsRequired
    }),
    effects: noEffects(),
    why: [because('approvals.from-pinned-state', 'evidence', {
      ref: snapshot.workItem.id,
      topic: 'approvals'
    })],
    restState: 'informational',
    data: { approvalChain: snapshot }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
