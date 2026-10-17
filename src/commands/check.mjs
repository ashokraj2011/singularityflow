/** Explicit model-free refresh. No preparation, tests, publication, approval or remote fetch. */
import { phaseEntryContext } from '../phase-entry.mjs';
import { recoveryPlan } from '../collaboration.mjs';
import { repoRoot, head, branch } from '../git.mjs';
import { loadDefinition } from '../config.mjs';
import { withFreshGitFacts } from '../git-fact-cache.mjs';
import { withFreshRepositoryChecks, repositoryCheckStatus } from '../repository-check-cache.mjs';
import { repositoryCheckSettings } from '../repository-check-settings.mjs';
import { verifyReferenceRepositories, storyReferenceRepositories } from '../reference-repositories.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';
import { commandResult, succeeded, action, noEffects } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

export async function run(_argv, { positionals, options }) {
  if (positionals.length !== 1 || Object.keys(options).some(key => !['json', 'for-agent', 'timings', 'timing', 'no-model'].includes(key))) {
    throw new SingularityFlowError('Use singularity-flow check [--for-agent] [--json]. This command refreshes local checks; it does not run tests or fetch.', {
      code: 'REPOSITORY_CHECK_OPTIONS_INVALID'
    });
  }
  const result = await withFreshRepositoryChecks(() => withFreshGitFacts(async () => {
    let entry;
    try { entry = await phaseEntryContext({ allowTerminal: true, turnMode: 'kernel-only' }); }
    catch (error) {
      if (error.code !== 'STORY_NOT_FOUND') throw error;
      const root = repoRoot();
      await loadDefinition(root);
      return { schemaVersion: 1, resultType: 'sflow-repository-check', status: 'ready',
        repositoryPath: root, head: head(root), branch: branch(root), workId: null,
        repositoryChecks: { ...repositoryCheckSettings(root), source: 'fresh', checkedAt: new Date().toISOString(), ageMs: 0 },
        effects: { testsRun: false, storyAdvanced: false, committed: false, pushed: false } };
    }
    if (entry.packet.paused) return entry.packet;
    const { root, definition, workflow, phase } = entry;
    const recovery = await recoveryPlan(root, definition, workflow, { phaseId: phase?.id ?? null, inspectActivePhase: true });
    const references = await verifyReferenceRepositories(root, await storyReferenceRepositories(root, definition, workflow));
    const ready = entry.packet.ready && !recovery.blockers.some(item => item.blocking !== false) && references.status !== 'blocked';
    return { schemaVersion: 1, resultType: 'sflow-repository-check', status: ready ? 'ready' : 'attention-required',
      repositoryPath: root, workId: workflow.workItem.id, phase: phase?.id ?? null,
      head: entry.packet.head, branch: entry.packet.branch,
      repositoryChecks: { ...repositoryCheckStatus(root), source: 'fresh',
        checkedAt: repositoryCheckStatus(root).checkedAt ?? new Date().toISOString() },
      findings: recovery.blockers, references,
      next: safeCommandGuidance({ argv: ['nextsteps', '--json'] }),
      effects: { testsRun: false, storyAdvanced: false, committed: false, pushed: false } };
  }));
  if (result.paused) return console.log(JSON.stringify(result));
  emitCommandResult(commandResult({ operation: { id: 'check', classification: 'read' },
    subject: result.workId ? { kind: 'story', id: result.workId } : { kind: 'repository', id: result.repositoryPath },
    outcome: succeeded('repository-check.reported', { status: result.status,
      mode: result.repositoryChecks.mode, intervalMinutes: result.repositoryChecks.intervalMinutes }),
    effects: noEffects(), data: result,
    next: result.workId ? [action({ id: 'repository-check.next', label: 'Read the current next action',
      command: 'singularity-flow nextsteps --json', skill: '/sf-nextsteps', kind: 'informational' })] : []
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
