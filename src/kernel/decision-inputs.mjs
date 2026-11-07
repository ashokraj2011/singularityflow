/** Pure decision-input policy shared by submission and the workflow interpreter. */
import { SingularityFlowError } from '../foundation/failures.mjs';

function list(values) {
  const quoted = values.map((value) => `'${value}'`);
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/** The decision pinned after this phase, or null. */
export function decisionAfter(workflow, phaseId) {
  return (workflow?.resolution?.decisions ?? []).find((decision) => decision.after === phaseId) ?? null;
}

/** The automatic decision whose inputs this phase records. */
export function decisionFedBy(workflow, phaseId) {
  const decision = decisionAfter(workflow, phaseId);
  return decision?.mode === 'auto' && decision.inputs.length ? decision : null;
}

/** Existing diagnostic spelling retained for adapter compatibility. */
export function decisionInputsHint(decision) {
  return decision.inputs.map((input) => input.type === 'number'
    ? `--decision ${input.name}=<number${input.minimum != null || input.maximum != null ? ` ${input.minimum ?? ''}..${input.maximum ?? ''}` : ''}>`
    : `--decision ${input.name}=<${input.values.join('|')}>`).join(' ');
}

/** Normalize every declared input, refusing missing or unknown values before recording. */
export function normalizeDecisionInputValues(decision, supplied = {}) {
  const values = {};
  const unknown = Object.keys(supplied).filter((name) => !decision.inputs.some((input) => input.name === name));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Decision '${decision.label}' does not record ${list(unknown)}. It records: ${decision.inputs.map((input) => input.name).join(', ')}.`,
      { code: 'DECISION_INPUT_UNKNOWN' }
    );
  }
  const missing = [];
  for (const input of decision.inputs) {
    if (!Object.hasOwn(supplied, input.name) || String(supplied[input.name]).trim() === '') { missing.push(input.name); continue; }
    const raw = String(supplied[input.name]).trim();
    if (input.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)
          || (input.minimum != null && number < input.minimum)
          || (input.maximum != null && number > input.maximum)) {
        throw new SingularityFlowError(
          `Decision input '${input.name}' must be a number${input.minimum != null ? ` from ${input.minimum}` : ''}${input.maximum != null ? ` up to ${input.maximum}` : ''}; got '${raw}'.`,
          { code: 'DECISION_INPUT_INVALID' }
        );
      }
      values[input.name] = number;
    } else {
      const found = input.values.find((choice) => choice.toLowerCase() === raw.toLowerCase());
      if (!found) {
        throw new SingularityFlowError(
          `Decision input '${input.name}' must be one of ${input.values.join(', ')}; got '${raw}'.`,
          { code: 'DECISION_INPUT_INVALID' }
        );
      }
      values[input.name] = found;
    }
  }
  if (missing.length) {
    throw new SingularityFlowError(
      `Decision '${decision.label}' after '${decision.after}' needs ${list(missing)}. Submit with ${decisionInputsHint(decision)}.`,
      { code: 'DECISION_INPUTS_MISSING', details: { decision: decision.id, missing } }
    );
  }
  return values;
}

/** Values bound to this exact decision, rather than an incidental previous round. */
export function recordedDecisionValues(phase, decision) {
  return phase?.decisionInputs?.decision === decision?.id ? phase.decisionInputs.values ?? null : null;
}
