/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { repoRoot } from '../git.mjs';
import { optionBoolean, posix, table } from '../util.mjs';
import { preparePhaseInputs, saveStoryDraft, workDir } from '../state-stores.mjs';
import { storyDraftTransaction } from './shared/story-draft-transaction.mjs';
import path from 'node:path';
import { phaseContinuationLines } from '../phase-continuation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => inputsCommand(positionals, options)));
}

export async function inputsCommand(positionals, options) {
  if (positionals[1] === 'restore') return (await import('./input-restore.mjs')).inputsRestoreCommand(repoRoot(), positionals, options);
  const forAgent = optionBoolean(options, 'for-agent');
  if (forAgent) (await import('../agent-entry-options.mjs')).validateAgentEntryRequest('inputs', { positionals, options });
  const { phaseEntryContext } = await import('../phase-entry.mjs');
  const entry = forAgent ? await phaseEntryContext({ phaseId: positionals[1] ?? null }) : null;
  if (entry?.packet.paused || (entry && !entry.packet.ready)) {
    console.log(JSON.stringify(entry.packet));
    return;
  }
  const root = entry?.root ?? repoRoot();
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const accepted = entry ?? await loadAcceptedStoryExecution(root);
  const { definition: config, workflow } = accepted;
  const { resolveStorySnapshot, agentNextSteps, snapshotContinuation } = await import('./nextsteps.mjs');
  const { inputRepresentationLabel, phaseInputArtifacts, compactInputContinuation } = await import('../phase-input-presentation.mjs');
  const dryRun = optionBoolean(options, 'dry-run');
  const prepareInputs = async () => {
    const prepared = await preparePhaseInputs(root, config, workflow, positionals[1], { dryRun });
    if (!dryRun) await saveStoryDraft(root, config, workflow);
    return prepared;
  };
  const result = dryRun
    ? await prepareInputs()
    : await storyDraftTransaction(
      root, config, workflow, `inputs:${positionals[1] ?? workflow.currentPhase}`, prepareInputs
    );
  const workItemDirectory = posix(path.relative(root, workDir(root, config, workflow.workItem.id)));
  const records = result.records.map(({ content, ...entry }) => entry);
  const nextSnapshot = await resolveStorySnapshot(root, accepted);
  const continuation = snapshotContinuation(workflow, forAgent ? agentNextSteps(nextSnapshot) : nextSnapshot);
  const artifacts = await phaseInputArtifacts(root, result.phase, result, dryRun);
  const { inputReadinessReport, inputReadinessLines } = await import('../inputs.mjs');
  const readiness = inputReadinessReport(workflow, result.phase, result);
  if (optionBoolean(options, 'json')) {
    console.log((await import('../agent-packet-presentation.mjs')).agentOrIndentedJson(forAgent, {
      ...(entry?.packet ?? {}),
      resultType: 'sflow-phase-inputs',
      phase: result.phase.id,
      mode: result.mode,
      dryRun,
      generation: result.generation,
      phaseGeneration: result.phase.generation,
      ...(forAgent ? { intent: result.phase.generationIntent ?? null,
        effects: { inputAuditRecorded: Boolean(artifacts.audit), artifactRendered: !dryRun,
          testsRun: false, storyAdvanced: false, committed: false, pushed: false }, modelInvocations: 0 } : {}),
      continuation: forAgent ? compactInputContinuation(continuation) : continuation,
      workItemDirectory,
      ...artifacts,
      records,
      readiness,
      warnings: result.warnings,
      remoteWarnings: result.remoteWarnings
    }));
    return;
  }
  console.log(`Phase inputs: ${result.phase.id} (${result.mode})${dryRun ? ' [dry-run]' : ''}`);
  console.log(`Work-item directory: ${workItemDirectory}`);
  if (!records.length) console.log(result.mode === 'off' ? 'Input dataflow is disabled for this work item.' : 'This phase declares no phase inputs.');
  else console.log(table(records.map((entry) => ({
    phase: entry.phase,
    status: entry.status,
    optional: entry.optional ? 'yes' : 'no',
    sha256: entry.sha256?.slice(0, 12) ?? '',
    bytes: inputRepresentationLabel(entry),
    path: entry.repositoryPath ?? entry.path ?? ''
  })), [
    { key: 'phase', label: 'INPUT' },
    { key: 'status', label: 'STATUS' },
    { key: 'optional', label: 'OPTIONAL' },
    { key: 'sha256', label: 'SHA256' },
    { key: 'bytes', label: 'REPRESENTATION' },
    { key: 'path', label: 'PATH', kind: 'path' }
  ]));
  result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  result.remoteWarnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  inputReadinessLines(result.phase, readiness).forEach((line) => console.log(line));
  if (!dryRun && result.records.length) console.log(`Recorded generation ${result.generation} inputs and rendered the managed artifact block.`);
  if (!dryRun) console.log(phaseContinuationLines(continuation).join('\n'));
}
