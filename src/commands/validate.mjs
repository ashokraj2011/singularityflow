import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { repoRoot } from '../git.mjs';
import { runGovernanceGate } from '../governance.mjs';
import { validateWorkflow } from '../state-stores.mjs';
import * as style from '../style.mjs';
import { SingularityFlowError, optionBoolean } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () =>
      positionals[0] === 'gate'
        ? gateCommand(options)
        : validateCommand(options)));
}

export async function validateCommand(options) {
  const root = repoRoot();
  let accepted;
  try {
    accepted = await loadAcceptedStoryExecution(root);
  } catch (error) {
    // Snapshot integrity is part of workflow validation. Preserve validate's established exit-2
    // contract even though the saved-policy resolver now runs at the command boundary.
    if (String(error?.code ?? '').startsWith('WFA_')) {
      throw new SingularityFlowError(error.message, {
        code: error.code, exitCode: 2, details: error.details, cause: error
      });
    }
    throw error;
  }
  const config = accepted.definition;
  const workflow = accepted.workflow;
  const result = await validateWorkflow(root, config, workflow, { strict: optionBoolean(options, 'strict') });
  result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (!result.valid) throw new SingularityFlowError(`Validation failed:\n- ${result.errors.join('\n- ')}`, { exitCode: 2, code: 'STORY_STATE_INVALID', details: { workId: workflow.workItem.id, problems: result.errors } });
  console.log('Singularity Flow workflow is valid.');
}

export async function gateCommand(options) {
  const root = repoRoot();
  const accepted = await loadAcceptedStoryExecution(root);
  const config = accepted.definition;
  const workflow = accepted.workflow;
  const result = await runGovernanceGate(root, config, workflow, {
    terminal: optionBoolean(options, 'terminal') || process.env.SINGULARITY_FLOW_ENFORCE_TERMINAL === '1'
  });
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify({ valid: result.errors.length === 0, ...result }, null, 2));
    if (result.errors.length) process.exitCode = 2;
    return;
  }
  result.passes.forEach((message) => console.log(`  ${style.mark('pass')} ${message}`));
  result.warnings.forEach((message) => console.warn(`  ${style.mark('warn')} ${message}`));
  if (result.errors.length) {
    const commands = [...new Set(result.findings.map((finding) => finding.recovery?.command).filter(Boolean))];
    commands.forEach((command) => console.error(`  ${style.action('Recover:')} ${command}`));
    throw new SingularityFlowError(`Governance gate failed:\n- ${result.errors.join('\n- ')}`, {
      exitCode: 2,
      code: 'GOVERNANCE_GATE_FAILED',
      details: { findings: result.findings }
    });
  }
  console.log('Singularity Flow governance gate passed.');
}
