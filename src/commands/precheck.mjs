import { repoRoot } from '../git.mjs';
import { smartInitPrecheck } from '../initialization/precheck.mjs';
import { commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';

export async function run(argv, { options } = {}) {
  if (optionBoolean(options, 'run')) throw new SingularityFlowError(
    'precheck --run is reserved for explicit configured-command execution and is not part of quick readiness inspection.',
    { code: 'INI_CONFIGURATION_INVALID' }
  );
  if (!optionBoolean(options, 'quick')) throw new SingularityFlowError('Use precheck --quick.', { code: 'INI_CONFIGURATION_INVALID' });
  const precheck = await smartInitPrecheck(repoRoot());
  return emitCommandResult(commandResult({
    operation: { id: 'precheck.quick', classification: 'read' },
    outcome: succeeded('precheck.reported', { status: precheck.status, checks: precheck.checks.length }),
    effects: noEffects(),
    restState: 'informational',
    data: { precheck }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
