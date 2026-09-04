import { loadDefinition } from '../config.mjs';
import { resolveShadowPassportDiagnostic } from '../delivery-modes/shadow-passport-service.mjs';
import { branch, repoRoot } from '../git.mjs';
import { commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(_argv, { positionals, options, operation: suppliedOperation = null } = {}) {
  if (positionals?.[1] != null && positionals[1] !== 'show') throw new SingularityFlowError(
    `Unknown change action '${positionals[1]}'. Use: singularity-flow change show [WORK-ID] --shadow --json`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  if (!optionBoolean(options, 'shadow')) throw new SingularityFlowError(
    'The Change Passport is an advanced GDP-M2 diagnostic. Re-run with --shadow; it remains read-only and non-authoritative.',
    { code: 'GDP_SHADOW_FLAG_REQUIRED' }
  );
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const requested = positionals?.[2] ?? optionString(options, 'work-id') ?? branch(root);
  const { workflow, diagnostic } = await resolveShadowPassportDiagnostic(root, definition, requested, {
    proofProfile: optionString(options, 'proof-profile') ?? 'standard'
  });
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: 'change.show.shadow', classification: 'read' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('change.shadow-reported', {
      workId: workflow.workItem.id,
      status: diagnostic.status,
      gaps: diagnostic.gaps.length
    }),
    effects: noEffects(),
    restState: 'informational',
    data: diagnostic
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
