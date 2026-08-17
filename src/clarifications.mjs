import path from 'node:path';
import { markerPolicy, markerQuestionHash } from './clarification-markers.mjs';
import { groundingRecordRelative } from './grounding.mjs';
import {
  exists, nowIso, posix, readJson, SingularityFlowError, snapshot, writeJson
} from './util.mjs';

const CLARIFICATION_MODES = new Set(['off', 'when-needed', 'required']);
const DEFAULT_MAX_QUESTIONS = 5;

/**
 * The pinned clarification policy for a phase.
 *
 * Exported because the marker half of this policy is enforced at the publication and submission
 * boundaries in `src/specification-gate.mjs`, and a second copy of this three-way fallback is how
 * the two surfaces would drift into disagreeing about what a Story pinned.
 */
export function resolvedClarificationPolicy(definition, workflow, phase) {
  const resolved = workflow.resolution?.phases?.find((entry) => entry.id === phase.id);
  return normalizeClarificationPolicy(resolved?.clarification ?? phase.clarification ?? definition.phases?.[phase.id]?.clarification);
}

const resolvedPolicy = resolvedClarificationPolicy;

export function clarificationRecordRelative(definition, workflow, phase, generation = phase.generation + 1) {
  return posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context',
    `clarifications-${phase.id}-gen${generation}.json`
  ));
}

/**
 * The marker this answer resolves, if it resolves one. `[SPK:REQ-066]`
 *
 * A marker is identified by its question text rather than by where it sat in the document, because
 * a line number moves the moment a paragraph is inserted above it, and the reviewer answered the
 * question — not the line. `markerQuestionHash` is the same normalization the extractor applies, so
 * an answer recorded against a reflowed question still binds.
 *
 * Accepting the bare question string as well as the object shape is deliberate: the CLI flag people
 * will actually use is `--marker "<the question>"`, copied out of the artifact.
 */
function normalizeMarkerBinding(value, index) {
  if (value === undefined || value === null || value === '') return null;
  const question = typeof value === 'string' ? value : String(value.question ?? '');
  const questionHash = markerQuestionHash(
    typeof value === 'string' ? value : value.questionHash ?? value.question ?? ''
  );
  if (!questionHash) {
    throw new SingularityFlowError(`Clarification response ${index + 1} names a marker with no question text.`);
  }
  return { question: markerQuestionHash(question), questionHash };
}

function normalizeResponse(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Clarification response ${index + 1} must be an object.`);
  }
  const question = String(value.question ?? '').trim();
  const answer = String(value.answer ?? '').trim();
  const why = String(value.why ?? '').trim();
  const status = value.status ?? 'answered';
  const blocking = value.blocking === true;
  if (!question) throw new SingularityFlowError(`Clarification response ${index + 1} requires a question.`);
  if (!answer) throw new SingularityFlowError(`Clarification response ${index + 1} requires the human answer or deferral rationale.`);
  if (!['answered', 'deferred'].includes(status)) throw new SingularityFlowError(`Clarification response ${index + 1} status must be answered or deferred.`);
  if (status === 'answered' && blocking) throw new SingularityFlowError(`Clarification response ${index + 1} cannot be both answered and blocking.`);
  const marker = normalizeMarkerBinding(value.marker, index);
  // A deferred answer is an explicit "not decided yet", so it cannot also be the thing that lets the
  // marker leave the artifact. Recording it as a resolution would let a marker be closed by saying
  // nothing about it at length.
  if (marker && status !== 'answered') {
    throw new SingularityFlowError(`Clarification response ${index + 1} resolves a clarification marker, so it must be answered rather than ${status}.`);
  }
  return {
    id: value.id ?? `Q-${String(index + 1).padStart(3, '0')}`,
    question,
    ...(why ? { why } : {}),
    answer,
    status,
    blocking,
    ...(marker ? { marker } : {}),
    ...(value.owner ? { owner: String(value.owner).trim() } : {}),
    ...(value.impact ? { impact: String(value.impact).trim() } : {})
  };
}

/**
 * The clarification record for one generation, or null.
 *
 * Read-only and forgiving: callers that only want the marker answers should not have to run the
 * full checkpoint verification, and an unreadable record is not their failure to report.
 */
export async function readClarificationRecord(root, definition, workflow, phase, generation) {
  const relative = clarificationRecordRelative(definition, workflow, phase, generation);
  if (!(await exists(path.join(root, relative)))) return null;
  return readJson(path.join(root, relative)).catch(() => null);
}

/** Every marker question hash a clarification record answers. */
export function answeredMarkerHashes(record) {
  return [...new Set((record?.responses ?? [])
    .map((response) => response.marker?.questionHash)
    .filter(Boolean))];
}

export async function recordClarificationResponses(root, definition, workflow, phase, {
  responses, actor, agent, replace = false, generation = phase.generation + 1
} = {}) {
  const policy = resolvedPolicy(definition, workflow, phase);
  if (policy.mode === 'off') throw new SingularityFlowError(`Phase '${phase.id}' has clarification mode off.`);
  if (!Array.isArray(responses) || !responses.length) throw new SingularityFlowError('Record at least one clarification response.');
  const groundingPath = groundingRecordRelative(definition, workflow, phase, generation);
  if (!(await exists(path.join(root, groundingPath)))) {
    throw new SingularityFlowError(`Compose the governed prompt before recording clarification: singularity-flow wm compose --phase ${phase.id}`);
  }
  const grounding = await readJson(path.join(root, groundingPath));
  const groundingInfo = await snapshot(path.join(root, groundingPath));
  const promptPath = posix(grounding.promptPath ?? '');
  const promptInfo = promptPath ? await snapshot(path.join(root, promptPath)) : { exists: false, sha256: null };
  if (!promptInfo.exists || !promptInfo.sha256 || promptInfo.sha256 !== grounding.renderedSha256) {
    throw new SingularityFlowError(`The composed prompt for ${phase.id} generation ${generation} is missing or stale. Re-run singularity-flow wm compose --phase ${phase.id}.`);
  }
  const relative = clarificationRecordRelative(definition, workflow, phase, generation);
  let previous = null;
  if (!replace && await exists(path.join(root, relative))) previous = await readJson(path.join(root, relative));
  if (previous && (previous.promptSha256 !== promptInfo.sha256 || previous.groundingRecordSha256 !== groundingInfo.sha256)) {
    throw new SingularityFlowError(`The existing clarification record is bound to an older prompt. Re-run with --replace after reviewing the current prompt.`);
  }
  const combined = [
    ...(replace ? [] : previous?.responses ?? []),
    ...responses
  ].map(normalizeResponse);
  if (combined.length > policy.maxQuestions) {
    throw new SingularityFlowError(`Phase '${phase.id}' permits no more than ${policy.maxQuestions} clarification questions.`);
  }
  const ids = new Set();
  for (const response of combined) {
    if (ids.has(response.id)) throw new SingularityFlowError(`Clarification response ID '${response.id}' is duplicated.`);
    ids.add(response.id);
  }
  const record = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    phase: phase.id,
    generation,
    mode: policy.mode,
    promptPath,
    promptSha256: promptInfo.sha256,
    groundingRecordPath: groundingPath,
    groundingRecordSha256: groundingInfo.sha256,
    responses: combined,
    completed: combined.length > 0 && !combined.some((response) => response.blocking),
    recordedAt: nowIso(),
    recordedBy: actor ?? null,
    agent: agent ?? grounding.agent ?? null
  };
  await writeJson(path.join(root, relative), record);
  const info = await snapshot(path.join(root, relative));
  return { record, path: relative, sha256: info.sha256 };
}

export async function verifyClarificationRecord(root, definition, workflow, phase, {
  generation = phase.generation + 1, groundingRecord = null
} = {}) {
  const policy = resolvedPolicy(definition, workflow, phase);
  const relative = clarificationRecordRelative(definition, workflow, phase, generation);
  if (policy.mode === 'off') return { mode: policy.mode, errors: [], warnings: [], passes: [], record: null, path: null, sha256: null };
  if (!(await exists(path.join(root, relative)))) {
    const message = `clarification response is missing for ${phase.id} generation ${generation}; ask the human checkpoint questions, then run singularity-flow clarification record ${phase.id} --question "..." --answer "..."`;
    return {
      mode: policy.mode,
      errors: policy.mode === 'required' ? [message] : [],
      warnings: [],
      passes: policy.mode === 'when-needed' ? [`clarification checkpoint: ${phase.id} generation ${generation} had no recorded material ambiguity`] : [],
      record: null,
      path: relative,
      sha256: null
    };
  }
  let record;
  try { record = await readJson(path.join(root, relative)); }
  catch (error) {
    return { mode: policy.mode, errors: [`clarification record is invalid for ${phase.id} generation ${generation}: ${error.message}`], warnings: [], passes: [], record: null, path: relative, sha256: null };
  }
  const problems = [];
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== generation) problems.push(`clarification record identity mismatch: ${relative}`);
  if (record.mode !== policy.mode) problems.push(`clarification record mode differs from the pinned phase policy: ${relative}`);
  if (!record.recordedBy || typeof record.recordedBy !== 'object') problems.push(`clarification record has no human actor: ${relative}`);
  if (!record.agent) problems.push(`clarification record has no governed agent: ${relative}`);
  if (!Array.isArray(record.responses) || !record.responses.length) problems.push(`clarification record contains no human responses: ${relative}`);
  if ((record.responses?.length ?? 0) > policy.maxQuestions) problems.push(`clarification record exceeds ${policy.maxQuestions} questions: ${relative}`);
  if (record.responses?.some((response) => !response.question || !response.answer)) problems.push(`clarification record contains an empty question or answer: ${relative}`);
  if (record.responses?.some((response) => response.blocking)) problems.push(`clarification record still contains a material unresolved decision: ${relative}`);
  if (record.completed !== true) problems.push(`clarification checkpoint is not complete: ${relative}`);
  const expectedGroundingPath = groundingRecordRelative(definition, workflow, phase, generation);
  if (record.groundingRecordPath !== expectedGroundingPath) problems.push(`clarification record points to the wrong grounding record: ${relative}`);
  const groundingInfo = await snapshot(path.join(root, expectedGroundingPath));
  if (!groundingInfo.exists || groundingInfo.sha256 !== record.groundingRecordSha256) problems.push(`clarification record is stale because the grounding record changed: ${relative}`);
  const currentGrounding = groundingRecord ?? (groundingInfo.exists ? await readJson(path.join(root, expectedGroundingPath)).catch(() => null) : null);
  if (!currentGrounding || currentGrounding.renderedSha256 !== record.promptSha256) problems.push(`clarification record is stale because the composed prompt changed: ${relative}`);
  const promptInfo = record.promptPath ? await snapshot(path.join(root, record.promptPath)) : { exists: false, sha256: null };
  if (!promptInfo.exists || promptInfo.sha256 !== record.promptSha256) problems.push(`clarification prompt snapshot hash differs: ${relative}`);
  const info = await snapshot(path.join(root, relative));
  return {
    mode: policy.mode,
    errors: problems,
    warnings: [],
    passes: problems.length ? [] : [`clarification checkpoint: ${phase.id} generation ${generation} (${record.responses.length} human response${record.responses.length === 1 ? '' : 's'})`],
    record,
    path: relative,
    sha256: info.sha256
  };
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

export function renderClarificationProtocol(value, phaseId) {
  const policy = normalizeClarificationPolicy(value);
  if (policy.mode === 'off') return '';
  const topics = policy.topics.length
    ? `Prioritize material uncertainty about: ${policy.topics.join(', ')}.`
    : 'Prioritize only uncertainties that could materially change scope, acceptance criteria, implementation direction, risk, or approval.';
  const required = policy.mode === 'required'
    ? [
        'This checkpoint is required. Pause for at least one human response before authoring.',
        'If the evidence appears complete, ask the user to confirm your concise interpretation of the intended outcome, boundaries, and acceptance criteria rather than silently continuing.'
      ]
    : [
        'Ask only when a material ambiguity remains after reading the governed evidence.',
        'If none remains, state that the clarification checkpoint found no material ambiguity and continue.'
      ];
  return [
    '# Human clarification checkpoint',
    '',
    `The \`${phaseId}\` phase uses clarification mode \`${policy.mode}\`.`,
    topics,
    '',
    ...required.map((line) => `- ${line}`),
    `- Ask one concise batch of no more than ${policy.maxQuestions} questions with the interactive \`ask_user\` tool.`,
    '- Derive every question only from the current Story’s pinned sources, approved upstream artifacts, repository world model, or contradictions among them. Never reuse example questions or placeholder text from templates.',
    '- Do not ask for information already established by pinned sources, approved upstream artifacts, or the repository world model.',
    '- Treat pinned evidence as fact. Label every hypothesis or proposed design explicitly; never convert it into an acceptance or specification decision without human confirmation.',
    '- For each question, explain briefly why the answer changes the governed output. Offer a recommended/default choice when the evidence supports one.',
    '- Do not infer an answer from generic knowledge. The user may explicitly answer “unknown” or defer a non-blocking decision.',
    '- After the response, incorporate confirmed answers into the phase artifact as decisions. Keep explicitly deferred items in Open questions with their impact and owner.',
    `- Record the accepted response batch with \`singularity-flow clarification record ${phaseId} --response-file <json>\`. The record is bound to this exact prompt and prospective generation.`,
    '- A material unresolved decision remains blocking through specification publication; do not hide it behind a recommendation or placeholder.',
    '- If `ask_user` is unavailable, print the numbered questions and stop before authoring or publication. Never turn missing interactivity into silent assumptions.',
    '- Do not author or publish the governed output until the checkpoint is complete.'
  ].join('\n');
}
