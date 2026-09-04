import { loadDefinition } from '../config.mjs';
import { observeShadowProof } from '../delivery-modes/proof-kernel.mjs';
import { resolveShadowPassportDiagnostic } from '../delivery-modes/shadow-passport-service.mjs';
import { branch, repoRoot } from '../git.mjs';
import { commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const ACTIONS = new Set(['status', 'explain', 'gaps', 'signals']);

function selectData(action, observation, predicateId) {
  if (action === 'status') return observation;
  const base = {
    schemaVersion: 1, // schema-transient: read-only command projection, never durable.
    kind: `gdp-proof-${action}-view`,
    mode: 'observe',
    authority: 'none',
    proofSubjectSha256: observation.proofSubject?.proofSubjectSha256 ?? null,
    proofSummarySha256: observation.summary?.summarySha256 ?? null,
    guarantees: observation.guarantees
  };
  if (action === 'gaps') return {
    ...base, gapRegister: observation.gapRegister, gaps: observation.gaps
  };
  if (action === 'signals') return {
    ...base, signals: observation.signals,
    message: observation.signals.length
      ? 'Signals are observations only.'
      : 'No signals were observed. Absence of a signal is not proof.',
    gateEligible: false
  };
  const index = observation.predicateSpecifications.findIndex(
    (specification) => specification.predicate.id === predicateId
  );
  if (index < 0) throw new SingularityFlowError(
    `Unknown observed predicate '${predicateId}'. Available: ${observation.predicateSpecifications
      .map((entry) => entry.predicate.id).join(', ') || 'none'}.`,
    { code: 'PFC_PREDICATE_INPUT_INVALID' }
  );
  const specification = observation.predicateSpecifications[index];
  const result = observation.results.find((entry) => (
    entry.predicate.id === specification.predicate.id
      && entry.predicate.version === specification.predicate.version
  )) ?? null;
  return {
    ...base,
    predicate: specification,
    result,
    explanation: result == null ? 'No deterministic result is available.'
      : result.verdict === 'pass' ? 'Every exact required input satisfied the registered deterministic algorithm.'
        : result.verdict === 'fail' ? 'The registered deterministic algorithm found a bound counterexample.'
          : result.verdict === 'not-applicable' ? 'The exact profile applicability contract excludes this predicate.'
            : 'Required exact evidence or capability is unavailable; this cannot be treated as pass.'
  };
}

export async function run(_argv, { positionals, options, operation: suppliedOperation = null } = {}) {
  const action = positionals?.[1] ?? 'status';
  if (!ACTIONS.has(action)) throw new SingularityFlowError(
    `Unknown proof action '${action}'. Use: proof status, proof explain, proof gaps, or proof signals.`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  if (optionBoolean(options, 'release')) throw new SingularityFlowError(
    'Release-scoped proof aggregation is not available in GDP-M3. Inspect one Work ID; nothing changed.',
    { code: 'PFC_SCHEMA_UNAVAILABLE' }
  );
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const workId = positionals?.[2] ?? optionString(options, 'work-id') ?? branch(root);
  const predicateId = action === 'explain' ? positionals?.[3] : null;
  if (action === 'explain' && !predicateId) throw new SingularityFlowError(
    'Proof explanation requires an exact predicate ID: singularity-flow proof explain <WORK-ID> <PREDICATE-ID> --json',
    { code: 'PFC_PREDICATE_INPUT_INVALID' }
  );
  const { workflow, diagnostic } = await resolveShadowPassportDiagnostic(root, definition, workId, {
    proofProfile: optionString(options, 'proof-profile') ?? 'standard'
  });
  const observation = observeShadowProof(diagnostic);
  const data = selectData(action, observation, predicateId);
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: `proof.${action}`, classification: 'read' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('proof.observation-reported', {
      workId: workflow.workItem.id,
      action,
      status: observation.status
    }),
    effects: noEffects(),
    restState: 'informational',
    data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
