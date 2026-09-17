import { repoRoot } from '../git.mjs';
import { smartInitPrecheck } from '../initialization/precheck.mjs';
import {
  buildRepositoryReadinessPlan, executeRepositoryReadinessPlan
} from '../initialization/runtime-readiness.mjs';
import {
  action, commandResult, effects, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(argv, { options } = {}) {
  const quick = optionBoolean(options, 'quick');
  const execute = optionBoolean(options, 'run');
  if (quick && execute) throw new SingularityFlowError(
    'Choose either metadata-only precheck --quick or reviewed repository execution with precheck --run.',
    { code: 'INI_CONFIGURATION_INVALID' }
  );
  if (!quick && !execute) throw new SingularityFlowError(
    'Choose precheck --quick or precheck --run.', { code: 'INI_CONFIGURATION_INVALID' }
  );
  const root = repoRoot();
  if (execute) {
    const scope = optionString(options, 'scope', 'dependency-test');
    const confirmation = optionString(options, 'confirm-plan');
    if (!confirmation) {
      const plan = await buildRepositoryReadinessPlan(root, { scope });
      const command = `singularity-flow precheck --run --scope ${plan.scope} --confirm-plan ${plan.planId} --json`;
      return emitCommandResult(commandResult({
        operation: { id: 'precheck.run.plan', classification: 'read' },
        outcome: succeeded('precheck.run-planned', { commands: plan.commands.length }),
        effects: noEffects(),
        next: plan.blockers.length ? [] : [action({
          id: 'precheck-run-confirm',
          label: plan.scope === 'dependency-test'
            ? 'Run the exact reviewed locked-dependency and existing-unit-test plan.'
            : 'Run the exact reviewed dependency, build, test, and application-start plan.',
          command,
          skill: '/sf-ready',
          kind: 'review'
        })],
        restState: 'informational',
        data: { plan }
      }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
    }
    const result = await executeRepositoryReadinessPlan(root, { confirmation, scope });
    return emitCommandResult(commandResult({
      operation: { id: 'precheck.run.execute', classification: 'mutation' },
      outcome: succeeded('precheck.run-completed', {
        commands: result.receipt.commandResults.length,
        commit: result.receipt.sourceCommit.slice(0, 12)
      }),
      effects: effects({ stateChanged: true }),
      restState: 'complete',
      data: result
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
  }
  const precheck = await smartInitPrecheck(root);
  return emitCommandResult(commandResult({
    operation: { id: 'precheck.quick', classification: 'read' },
    outcome: succeeded('precheck.reported', { status: precheck.status, checks: precheck.checks.length }),
    effects: noEffects(),
    restState: 'informational',
    data: { precheck }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
