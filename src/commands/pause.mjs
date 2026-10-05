import { copilotModePresentation, readCopilotMode, setCopilotPaused } from '../copilot-mode.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';
import { action, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

export async function run(_argv, { positionals, options, operation }) {
  const selected = positionals[1] ?? 'on';
  if (positionals.length > 2 || !['on', 'off', 'status'].includes(selected)) {
    throw new SingularityFlowError('Use singularity-flow pause [on|off|status] [--json].', { code: 'COPILOT_MODE_ACTION_INVALID' });
  }
  const mode = selected === 'status' ? readCopilotMode() : await setCopilotPaused(selected === 'on');
  const result = copilotModePresentation(mode);
  return emitCommandResult(commandResult({
    operation: { id: operation.id, classification: operation.classification },
    outcome: succeeded('copilot.mode-reported', { mode: mode.paused ? 'paused' : 'available',
      stateAvailable: mode.stateAvailable }),
    effects: selected === 'status' ? noEffects() : effects({ filesChanged: true }),
    data: result,
    next: [action({ id: 'copilot.mode.change', label: mode.paused ? 'Resume SFlow guidance explicitly' : 'Pause SFlow guidance',
      command: result.commandGuidance.command, kind: 'informational' })],
    restState: 'informational'
  }), { json: optionBoolean(options, 'json') });
}
