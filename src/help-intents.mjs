/**
 * A closed vocabulary for questions about Singularity Flow.
 *
 * This classifies the shape of the requested answer, not the operation to execute and not the
 * documentation topic. It is deliberately lexical and model-free so a host can decide whether to
 * retrieve cited product documentation without giving prose mutation authority.
 */
export const HELP_INTENTS = Object.freeze([
  'concept', 'procedure', 'diagnose', 'compare', 'command-discovery', 'recover'
]);

const RULES = Object.freeze([
  ['recover', [
    /\b(recover|repair|resume after|restore|roll back|rollback|return to (?:a )?(?:safe|stable) state|unblock)\b/
  ]],
  ['diagnose', [
    /\bwhy\b/,
    /\b(error|failed|failure|failing|blocked|blocker|broken|stuck|not working|does not work|doesn't work)\b/,
    /\b(cannot|can't|unable to)\b/
  ]],
  ['compare', [
    /\b(compare|comparison|difference|different|versus|vs\.?|better than)\b/
  ]],
  ['command-discovery', [
    /\b(what|which) command\b/,
    /\bcommand (?:do i use|should i use|to run|to use|for)\b/,
    /\bhow (?:do|can|should) i run\b/,
    /\b(cli|command line)\b/
  ]],
  ['concept', [
    /\bwhat (?:is|are|does)\b/,
    /\bhow does\b/,
    /\bwhere (?:is|are|does|do|can)\b/,
    /\bwhen (?:is|are|does|do|can)\b/,
    /\bwho (?:is|are|does|do|can)\b/,
    /\bwhat .*\bmean(?:s)?\b/,
    /\b(explain|tell me about|help me understand)\b/
  ]],
  ['procedure', [
    /\bhow (?:do|can|should|would)\b/,
    /\bhow to\b/,
    /\b(steps? to|set up|setup|configure|enable|disable|install|onboard)\b/
  ]]
]);

const normalize = (value) => String(value ?? '')
  .toLocaleLowerCase('en-US')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[^a-z0-9'./_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Return one answer-shape intent, or null when the text is not recognisably a help request. */
export function classifyHelpIntent(question) {
  const normalized = normalize(question);
  if (!normalized) return null;
  for (const [intent, patterns] of RULES) {
    if (patterns.some((pattern) => pattern.test(normalized))) return intent;
  }
  return null;
}
