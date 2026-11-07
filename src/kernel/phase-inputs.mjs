/** Pure accepted-input selection and human-checkpoint policy. No native record or artifact I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';

export function workflowInputsMode(workflow) {
  return workflow.resolution?.inputsMode ?? 'off';
}

export function resolvedPhaseInputs(workflow, phase) {
  return workflow.resolution?.phases?.find((candidate) => candidate.id === phase.id)?.inputs ?? phase.inputs ?? [];
}

export function approvedInputPhases(workflow, phase) {
  if (!workflow || !phase || workflowInputsMode(workflow) === 'off') return [];
  return [...new Set(resolvedPhaseInputs(workflow, phase)
    .map((entry) => typeof entry === 'string' ? entry : entry?.phase).filter(Boolean))];
}

const CLARIFICATION_MODES=new Set(['off','when-needed','required']);
const DEFAULT_MAX_QUESTIONS=5;
export const MARKER_MODES=Object.freeze(['off','warn','block']);

export function markerPolicy(value) {
  const mode = typeof value === 'string' ? value : value?.mode ?? 'off';
  if (!MARKER_MODES.includes(mode)) {
    throw new SingularityFlowError(`clarification.markers.mode must be one of ${MARKER_MODES.join(', ')}; got '${mode}'.`);
  }
  return { mode };
}

export function normalizeClarificationPolicy(value = {}) {
  if (value == null) value = {};
  if (typeof value === 'string') value = { mode: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('clarification must be an object or mode string.');
  }
  for (const key of Object.keys(value)) {
    // `markers` is the marker policy, pinned separately from the conversational mode above
    // [SPK:REQ-064]: one governs whether the agent asks questions, the other governs what happens
    // to an unanswered `[NEEDS CLARIFICATION: ...]` left in the artifact.
    if (!['mode', 'maxQuestions', 'topics', 'markers'].includes(key)) {
      throw new SingularityFlowError(`clarification contains unknown field '${key}'.`);
    }
  }
  const mode = value.mode ?? 'off';
  if (!CLARIFICATION_MODES.has(mode)) {
    throw new SingularityFlowError('clarification.mode must be off, when-needed, or required.');
  }
  const maxQuestions = value.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 10) {
    throw new SingularityFlowError('clarification.maxQuestions must be an integer from 1 through 10.');
  }
  const topics = value.topics ?? [];
  if (!Array.isArray(topics) || topics.some((topic) => typeof topic !== 'string' || !topic.trim())) {
    throw new SingularityFlowError('clarification.topics must contain non-empty strings.');
  }
  const normalizedTopics = [...new Set(topics.map((topic) => topic.trim()))];
  if (normalizedTopics.length !== topics.length) {
    throw new SingularityFlowError('clarification.topics must not contain duplicates.');
  }
  return { mode, maxQuestions, topics: normalizedTopics, markers: markerPolicy(value.markers) };
}

export function clarificationCheckpointState(mode,recordState,errorCount) {
  const missing=recordState==='missing';
  const stage=mode==='off'?'off':missing?mode==='required'?'derive-questions':'assess-ambiguity'
    :errorCount?'inspect-binding':'complete';
  return {stage,questioningAllowed:['derive-questions','assess-ambiguity'].includes(stage),requiresHumanResponse:stage==='derive-questions'};
}
