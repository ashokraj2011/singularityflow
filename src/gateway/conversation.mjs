/**
 * A small, deterministic vocabulary for ordinary developer requests.
 *
 * This is deliberately not a command parser. It identifies one of six user-facing intents and
 * routes it to a read planner that can reconstruct current state. A request such as "submit this"
 * therefore reaches `work.continue`, where the kernel can show whether submission is legal; it
 * never becomes a submit operation merely because those words appeared in conversation.
 */

export const CONVERSATION_SCHEMA_VERSION = 2;

export const DEVELOPER_INTENTS = Object.freeze([
  'orient', 'continue', 'start', 'inspect', 'act', 'recover'
]);

const EFFECTS_NONE = Object.freeze({
  contextChanged: false,
  stateChanged: false,
  filesChanged: false,
  gitRefsChanged: false,
  publicationCreated: false,
  externalSystemsChanged: false
});

const route = ({ id, intent, label, operationId, skill, automatic, confirmation, patterns }) => Object.freeze({
  id, intent, label, operationId, skill, automatic, confirmation,
  patterns: Object.freeze(patterns)
});

/**
 * More specific routes come first. The matcher still returns ambiguity when two distinct routes
 * match; ordering is not permission to silently choose between "generate and submit".
 */
const ROUTES = Object.freeze([
  route({
    id: 'recover-publication', intent: 'recover', label: 'Diagnose and recover interrupted work',
    operationId: 'work.continue', skill: '/sf-doctor', automatic: true, confirmation: 'none',
    patterns: [
      /\b(publication|push|sync)\b.{0,32}\b(failed|broken|stuck|pending|recover|repair)\b/,
      /\b(failed|broken|stuck|pending|recover|repair)\b.{0,32}\b(publication|push|sync)\b/,
      /\b(recover|repair)\b.{0,24}\b(branch|session|workspace|work)\b/
    ]
  }),
  route({
    id: 'inspect-return', intent: 'inspect', label: 'Show what changed while you were away',
    operationId: 'work.return', skill: '/sf-work-interval', automatic: true, confirmation: 'none',
    patterns: [/\b(what changed|catch me up|since i was away|while i was away|where i left off)\b/]
  }),
  route({
    id: 'inspect-readiness', intent: 'inspect', label: 'Show blockers and readiness',
    operationId: 'work.readiness', skill: '/sf-nextsteps', automatic: true, confirmation: 'none',
    patterns: [
      /\b(blocked|blocker|blockers|blocking|what is missing|what's missing|ready to|readiness)\b/,
      /\bwhy\b.{0,32}\b(cannot|can't|wont|won't)\b.{0,24}\b(advance|continue|submit|publish)\b/
    ]
  }),
  route({
    id: 'inspect-progress', intent: 'inspect', label: 'Show progress and governed artifacts',
    operationId: 'work.list', skill: '/sf-progress', automatic: true, confirmation: 'none',
    patterns: [/\b(progress|artifacts?|approvals?|what phase|which phase|show the work)\b/]
  }),
  route({
    id: 'act-ceremony', intent: 'act', label: 'Open the governed review decision',
    operationId: 'work.continue', skill: '/sf-review', automatic: false, confirmation: 'ceremony',
    patterns: [/\b(approve|approval|reject|rejection|review decision)\b/]
  }),
  route({
    id: 'act-submit', intent: 'act', label: 'Prepare the current phase for submission',
    operationId: 'work.continue', skill: '/sf-submit', automatic: false, confirmation: 'host-confirm',
    patterns: [/\b(submit|send for review|request review)\b/]
  }),
  route({
    id: 'act-generate', intent: 'act', label: 'Generate the active phase',
    operationId: 'work.continue', skill: '/sf-phase', automatic: false, confirmation: 'host-confirm',
    patterns: [/\b(generate|author|write|implement|verify)\b(?:.{0,28}\b(phase|requirements?|design|spec|artifact|work|change)\b)?/]
  }),
  route({
    id: 'act-next', intent: 'act', label: 'Execute one legal next action',
    operationId: 'work.continue', skill: '/sf-next', automatic: false, confirmation: 'host-confirm',
    patterns: [/\b(run|do|execute|take)\b.{0,20}\b(the )?next\b/, /\badvance\b.{0,20}\b(work|story|phase|workflow)\b/]
  }),
  route({
    id: 'start', intent: 'start', label: 'Start new governed work',
    operationId: 'work.start.intake', skill: '/sf-start', automatic: false, confirmation: 'host-confirm',
    patterns: [
      /\b(start|begin|create|open)\b.{0,32}\b(new )?(work|story|bug|bug fix|feature|epic|initiative|task|chore)\b/,
      /\b(new)\b.{0,20}\b(work|story|bug|feature|epic|initiative|task|chore)\b/
    ]
  }),
  route({
    id: 'continue', intent: 'continue', label: 'Continue current governed work',
    operationId: 'work.continue', skill: '/sf-resume', automatic: false, confirmation: 'host-confirm',
    patterns: [/\b(continue|resume|pick up|carry on|return to)\b(?:.{0,32}\b(work|story|task|epic|initiative|where i left off)\b)?/]
  }),
  route({
    id: 'orient', intent: 'orient', label: 'Show current developer context',
    operationId: 'developer.next', skill: '/sf-home', automatic: true, confirmation: 'none',
    patterns: [
      /\b(where am i|what am i working on|what i am working on|what is active|what's active|current work|current status)\b/,
      /\b(what should i do|what do i do|what now|what next|show me my day)\b/
    ]
  })
]);

const normalize = (value) => String(value ?? '')
  .toLocaleLowerCase('en-US')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[^a-z0-9'./_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function inferredWork(normalized, entry) {
  if (entry.intent !== 'start') return null;
  const shape = /\binitiative\b/.test(normalized) ? 'initiative'
    : /\bepic\b/.test(normalized) ? 'epic' : 'story';
  const category = /\bbug(?:\s+fix)?\b/.test(normalized) ? 'bug-fix'
    : /\bfeature\b/.test(normalized) ? 'feature'
      : /\bchore\b/.test(normalized) ? 'chore' : null;
  return Object.freeze({
    shape,
    category,
    /** These are product decisions, not facts extracted from prose. */
    requiredInputs: Object.freeze([
      'work description',
      ...(shape === 'story' ? ['definition of done', 'remote base branch'] : ['success outcome'])
    ])
  });
}

function publicRoute(entry, normalized) {
  const work = inferredWork(normalized, entry);
  return Object.freeze({
    id: entry.id,
    intent: entry.intent,
    label: entry.label,
    operationId: entry.operationId,
    recommendedSkill: entry.skill,
    automatic: entry.automatic,
    confirmation: entry.confirmation,
    ...(work ? { work } : {})
  });
}

/**
 * Plan a conversation without reading or changing lifecycle state.
 *
 * The utterance is deliberately absent from the result. Hosts may record the intent ID and outcome
 * for aggregate experience metrics without turning private developer prose into telemetry.
 */
export function planDeveloperConversation(utterance) {
  const normalized = normalize(utterance);
  const matched = normalized
    ? ROUTES.filter((entry) => entry.patterns.some((pattern) => pattern.test(normalized)))
    : [];
  const unique = [...new Map(matched.map((entry) => [entry.id, entry])).values()];

  if (unique.length > 1) {
    return Object.freeze({
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      intent: null,
      confidence: 'ambiguous',
      route: null,
      choices: Object.freeze(unique.map((entry) => publicRoute(entry, normalized))),
      stateSource: 'durable-records',
      effects: EFFECTS_NONE
    });
  }

  if (!unique.length) {
    return Object.freeze({
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      intent: null,
      confidence: 'none',
      route: null,
      choices: Object.freeze([]),
      stateSource: 'durable-records',
      effects: EFFECTS_NONE
    });
  }

  const selected = publicRoute(unique[0], normalized);
  return Object.freeze({
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    intent: selected.intent,
    confidence: 'strong',
    route: selected,
    choices: Object.freeze([]),
    stateSource: 'durable-records',
    effects: EFFECTS_NONE
  });
}
