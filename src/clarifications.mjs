import { SingularityFlowError } from './util.mjs';

const CLARIFICATION_MODES = new Set(['off', 'when-needed', 'required']);
const DEFAULT_MAX_QUESTIONS = 5;

export function normalizeClarificationPolicy(value = {}) {
  if (value == null) value = {};
  if (typeof value === 'string') value = { mode: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('clarification must be an object or mode string.');
  }
  for (const key of Object.keys(value)) {
    if (!['mode', 'maxQuestions', 'topics'].includes(key)) {
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
  return { mode, maxQuestions, topics: normalizedTopics };
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
    '- Do not ask for information already established by pinned sources, approved upstream artifacts, or the repository world model.',
    '- For each question, explain briefly why the answer changes the governed output. Offer a recommended/default choice when the evidence supports one.',
    '- Do not infer an answer from generic knowledge. The user may explicitly answer “unknown” or defer a non-blocking decision.',
    '- After the response, incorporate confirmed answers into the phase artifact as decisions. Keep explicitly deferred items in Open questions with their impact and owner.',
    '- If `ask_user` is unavailable, print the numbered questions and stop before authoring or publication. Never turn missing interactivity into silent assumptions.',
    '- Do not author or publish the governed output until the checkpoint is complete.'
  ].join('\n');
}
