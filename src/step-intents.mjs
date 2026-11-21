/**
 * Step intents (spec "SFlow step intents", owner-approved 2026-11-20): what each workflow step is for, and how SFlow
 * tells a step's intent from its structure when the step declares none.
 *
 * - The profiles and the workflow rules are in step-intent-settings.mjs, re-exported here: INTENT_PROFILES holds every
 *   published profile version as data (a published version never changes; test/step-intents.test.mjs locks each by
 *   its hash), deriveStepSettings is what one step's intent gives in its workflow, and workflowIntentFacts the
 *   workflow rules (spec §5) it reads. They load wherever a workflow resolves; what is here loads only where it is used.
 * - PACKAGED_STEP_INTENTS is the intent of each step SFlow ships.
 * - inferStepIntents tells each step's intent from its structure first, then its position, words and agent (§6.1),
 *   with how sure it is: certain, likely or unclear. `workflow check` shows it; nothing derives a setting from it.
 *
 * Stage 2: a work type whose steps all say what they are for, in a version 4 workflow.yml, derives every setting a
 * step does not set itself (step-intent-settings.mjs, read by config.mjs resolveWorkType); every other work type
 * resolves as it always did. A test compares what the shipped workflows would derive with what they have today
 * (test/step-intents-comparison.test.mjs).
 *
 * Pure: no file, process or clock is read, and it imports only modules that read nothing, so Workflow Studio's page
 * can run the same inference (spec §6.4).
 */
import { BECAUSE_SETTINGS, STEP_INTENTS } from './phase-roles.mjs';
import { PACKAGED_STEP_INTENTS } from './packaged-step-intents.mjs';
// The profiles and the workflow rules live with the derivation configuration reads (step-intent-settings.mjs), so only
// they load whenever a workflow resolves; the inference below loads only where it is used (workflow check, the tests).
import {
  CURRENT_INTENT_PROFILE, deriveStepSettings, deriveWorkflowSettings, DOCUMENT_INTENTS, INTENT_PROFILES, intentProfile, workflowIntentFacts
} from './step-intent-settings.mjs';

export {
  BECAUSE_SETTINGS, CURRENT_INTENT_PROFILE, deriveStepSettings, deriveWorkflowSettings, DOCUMENT_INTENTS, INTENT_PROFILES, intentProfile,
  STEP_INTENTS, workflowIntentFacts
};

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// The intent of each step SFlow ships, in an import-free module of its own so seeded-workflow protection can read it
// without loading the profiles (packaged-step-intents.mjs).
export { PACKAGED_STEP_INTENTS };

// ---------------------------------------------------------------------------------------------
// Inference (spec §6.1)

const INTAKE_KINDS = new Set(['intake', 'design-intake', 'poc-intake']);
const DESIGN_KINDS = new Set(['design', 'reproduction', 'fix-design', 'impact-analysis', 'ui-exploration-evidence', 'design-inventory', 'component-mapping']);
const PLAN_KINDS = new Set(['implementation-spec', 'delivery-plan', 'implementation-plan']);
const TEST_KINDS = new Set(['test-evidence', 'visual-test-evidence']);
const REVIEW_KINDS = new Set(['conformance-report', 'convergence-report']);

/** The words that lean a step to an intent, found in its ID, label, description and template headings (§6.1). */
export const INTENT_WORDS = deepFreeze({
  intake: ['intake', 'request', 'brief', 'triage', 'capture', 'ticket'],
  requirements: ['requirement', 'spec', 'specification', 'acceptance criteria', 'user story', 'prd', 'scope'],
  design: ['design', 'architecture', 'analysis', 'investigate', 'reproduce', 'research', 'explore', 'impact', 'inventory', 'mapping'],
  plan: ['plan', 'implementation spec', 'technical spec', 'fix spec', 'approach', 'task breakdown'],
  code: ['implement', 'code', 'build', 'develop', 'fix', 'repair', 'change', 'refactor', 'migrate', 'generate tests'],
  test: ['test', 'verify', 'validation', 'qa', 'check', 'retest', 'regression', 'e2e', 'scenario', 'smoke'],
  review: ['conformance', 'compliance', 'traceability', 'requirement check', 'code checking', 'audit'],
  release: ['release', 'publish', 'pr', 'pull request', 'ship', 'finalize', 'handoff'],
  report: ['report', 'summary', 'close', 'gaps', 'retrospective', 'outcome']
});

/** The agents that lean a step to intents (§6.1). An agent whose ID ends in one of these leans the same way. */
export const AGENT_LEANS = deepFreeze({
  'product-owner': ['intake', 'requirements'], architect: ['design', 'plan'], developer: ['code'], qa: ['test', 'review']
});

const tokens = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
const commonPrefix = (left, right) => {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
};
/** A word matches a token as written, as the token's start, or as the same stem (verify, verification). */
const wordMatches = (word, token) => token === word || (word.length >= 4 && token.startsWith(word))
  || (word.length >= 6 && token.length >= 6 && commonPrefix(word, token) >= Math.min(word.length, token.length) - 2);

/** Each intent's word score for `texts` ([text, weight] pairs), with the words found. Phrases count before their words. */
export function intentWordScores(texts) {
  const scores = new Map();
  for (const [text, weight] of texts) {
    const words = tokens(text);
    const used = new Array(words.length).fill(false);
    for (const [intent, list] of Object.entries(INTENT_WORDS)) {
      for (const phrase of list.filter((entry) => entry.includes(' '))) {
        const parts = phrase.split(' ');
        for (let start = 0; start + parts.length <= words.length; start += 1) {
          if (parts.every((part, offset) => !used[start + offset] && wordMatches(part, words[start + offset]))) {
            for (let offset = 0; offset < parts.length; offset += 1) used[start + offset] = true;
            const entry = scores.get(intent) ?? { score: 0, words: [] };
            entry.score += weight * 2;
            if (!entry.words.includes(phrase)) entry.words.push(phrase);
            scores.set(intent, entry);
          }
        }
      }
    }
    words.forEach((token, position) => {
      if (used[position]) return;
      for (const [intent, list] of Object.entries(INTENT_WORDS)) {
        const word = list.find((entry) => !entry.includes(' ') && wordMatches(entry, token));
        if (!word) continue;
        const entry = scores.get(intent) ?? { score: 0, words: [] };
        entry.score += weight;
        if (!entry.words.includes(token)) entry.words.push(token);
        scores.set(intent, entry);
      }
    });
  }
  return scores;
}

const agentLeans = (agent) => {
  const id = String(agent ?? '').toLowerCase();
  const key = Object.keys(AGENT_LEANS).find((name) => id === name || id.endsWith(`-${name}`));
  return key ? [...AGENT_LEANS[key]] : [];
};

const certain = (intent, why, source = 'structure') => ({ intent, confidence: 'certain', source, why });
const likely = (intent, why, source = 'structure') => ({ intent, confidence: 'likely', source, why });

/** The structural signals of §6.1, in its order; null when the step has none. */
function structuralIntent(step, index, steps, planners) {
  const kind = step.kind ?? null;
  const task = step.task ?? null;
  const intakeLike = (candidate, position) => INTAKE_KINDS.has(candidate.kind) || (candidate.task === 'clarify' && position === 0);
  if (task === 'code' || (kind === 'implementation-summary' && task == null)) {
    return certain('code', task === 'code' ? 'its generation task is code' : 'its output kind is implementation-summary');
  }
  if (TEST_KINDS.has(kind)) return certain('test', `its output kind is ${kind}`);
  if (step.testEvidenceFrom) return certain('test', `it cites ${step.testEvidenceFrom}'s test results`);
  if (step.repositoryTests === 'run') return certain('test', 'it runs the repository\'s tests');
  if (REVIEW_KINDS.has(kind)) return certain('review', `its output kind is ${kind}`);
  if (PLAN_KINDS.has(kind)) return certain('plan', `its output kind is ${kind}`);
  if (planners.has(step.id)) return certain('plan', 'the workflow names it as the plan of a code step');
  if (kind === 'requirements') {
    const otherIntake = steps.some((candidate, position) => position !== index && intakeLike(candidate, position));
    return index === 0 && !otherIntake ? certain('intake', 'it is the first step and writes the requirements')
      : certain('requirements', 'its output kind is requirements');
  }
  if (intakeLike(step, index)) return certain('intake', INTAKE_KINDS.has(kind) ? `its output kind is ${kind}` : 'it is the first step and asks questions');
  if (DESIGN_KINDS.has(kind)) return certain('design', `its output kind is ${kind}`);
  if (kind === 'publication-review') {
    const words = intentWordScores(stepTexts(step)).get('report');
    return task === 'summarize' && words ? likely('report', 'its output is a publication review that summarizes')
      : likely('release', 'its output kind is publication-review');
  }
  if (step.writeScope === 'source-and-artifact' && task !== 'code' && intentWordScores(stepTexts(step)).has('test')) {
    return { ...likely('test', 'it may change source files and its words say test'), changesSourceKept: true };
  }
  return null;
}

function stepTexts(step) {
  return [[step.id, 2], [step.label, 2], [step.description, 1], ...(step.headings ?? []).map((heading) => [heading, 1])];
}

const POSITION_WORDS = Object.freeze({
  first: 'it is the first step',
  'before-code': 'it comes right before the first code step',
  'after-code': 'it comes after the last code step',
  'last-code-free': 'it is the last step of a workflow that changes no code'
});

/** Which intents a step's place leans to, given the steps known to be code (§6.1 position signals). */
function positionLeans(index, steps, codeIndexes) {
  const leans = [];
  if (index === 0) leans.push(['first', ['intake']]);
  if (codeIndexes.length && index === Math.min(...codeIndexes) - 1) leans.push(['before-code', ['plan']]);
  if (codeIndexes.length && index > Math.max(...codeIndexes)) leans.push(['after-code', ['test', 'review', 'release', 'report']]);
  if (!codeIndexes.length && index === steps.length - 1 && index > 0) leans.push(['last-code-free', ['report']]);
  return leans;
}

const quote = (words) => words.slice(0, 3).map((word) => `"${word}"`).join(', ');

/**
 * Each step's intent and how sure SFlow is, in workflow order: `{ step, intent, confidence, source, why }`, where
 * confidence is certain, likely or unclear and source is declared, shipped, structure, words, position or agent.
 *
 * `steps` are `{ id, label?, description?, headings?, agent?, declared?, shipped?, kind?, task?, writeScope?,
 * testEvidenceFrom?, repositoryTests? }` as the workflow resolves them: `declared` is the step's own `intent:`,
 * `shipped` the packaged intent of an exact shipped revision. `planOwners` names the steps the workflow's planned
 * claims make the plan of a code step. A declared intent that differs from the structure keeps what the structure
 * says under `inferred`.
 */
export function inferStepIntents(steps, { planOwners = [] } = {}) {
  const planners = new Set(planOwners);
  const fromStructure = steps.map((step, index) => (step.shipped && STEP_INTENTS.includes(step.shipped)
    ? certain(step.shipped, 'a step SFlow ships', 'shipped')
    : structuralIntent(step, index, steps, planners)));
  const known = steps.map((step, index) => (STEP_INTENTS.includes(step.declared) ? step.declared : fromStructure[index]?.intent ?? null));
  const codeIndexes = known.flatMap((intent, index) => (intent === 'code' ? [index] : []));
  return steps.map((step, index) => {
    let inferred = fromStructure[index];
    if (!inferred) {
      const scores = intentWordScores(stepTexts(step));
      const leans = positionLeans(index, steps, codeIndexes);
      const placed = new Set(leans.flatMap(([, intents]) => intents));
      const agent = agentLeans(step.agent);
      const best = Math.max(0, ...[...scores.values()].map((entry) => entry.score));
      const top = STEP_INTENTS.filter((intent) => scores.get(intent)?.score === best && best > 0);
      const rank = (candidates) => [...candidates].sort((left, right) => Number(placed.has(right)) - Number(placed.has(left))
        || Number(agent.includes(right)) - Number(agent.includes(left)) || STEP_INTENTS.indexOf(left) - STEP_INTENTS.indexOf(right));
      const where = (intent) => leans.filter(([, intents]) => intents.includes(intent)).map(([key]) => POSITION_WORDS[key]).join(' and ');
      const agreed = top.filter((intent) => placed.has(intent));
      if (agreed.length) {
        const intent = rank(agreed)[0];
        inferred = { intent, confidence: 'likely', source: 'words', why: `its words say ${quote(scores.get(intent).words)}, and ${where(intent)}` };
      } else if (top.length) {
        const intent = rank(top)[0];
        inferred = { intent, confidence: 'unclear', source: 'words', why: `its words say ${quote(scores.get(intent).words)}, but nothing else agrees` };
      } else {
        const candidates = rank([...placed].filter((intent) => agent.includes(intent)));
        const intent = candidates[0] ?? rank([...placed])[0] ?? rank(agent)[0] ?? 'document';
        const why = placed.has(intent) ? `only its place: ${where(intent)}`
          : agent.includes(intent) ? `only its agent, ${step.agent}` : 'nothing in it says what it is for';
        inferred = { intent, confidence: 'unclear', source: placed.has(intent) ? 'position' : agent.includes(intent) ? 'agent' : 'none', why };
      }
    }
    if (STEP_INTENTS.includes(step.declared)) {
      return { step: step.id, intent: step.declared, confidence: 'certain', source: 'declared', why: 'it says so in workflow.yml',
        ...(inferred.intent !== step.declared ? { inferred: { intent: inferred.intent, confidence: inferred.confidence, source: inferred.source, why: inferred.why } } : {}) };
    }
    return { step: step.id, ...inferred };
  });
}
