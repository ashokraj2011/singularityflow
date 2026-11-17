/**
 * SPEC-OSA v1.1 §10: the one versioned action-to-command map [OSA:REQ-021, REQ-023, REQ-024]. Per kernel operation, its
 * Copilot command (`work`: the step's work command; `by-command`: the crosswalk's skill for its Shell command; otherwise
 * the fixed skill) and its named Shell forms. VS Code's model-free command is always read from the exact Shell command,
 * never assumed. Every renderer builds a step route's command from here (step-decision.mjs `actionRoute`, the review
 * delegation): a command line built anywhere else is a competing route (test/osa-ratchet.test.mjs).
 *
 * Pure, and it imports only the step's configured author (code-delivery-policy.mjs), whether its review comes first and
 * the decision values a submission records, so a module that only names a command loads neither the kernel nor its adapter. D1: `/sf-code` and `/sf-phase` are two names of one work command
 * (command-skills.mjs WORK_COMMANDS).
 */
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';

export const ACTION_COMMAND_MAP_VERSION = 'sflow-action-command-map/v1';
export const ACTION_MODEL_FREE = 'by-command';

/** The fixed Copilot commands of the actions that are not a step's own work. `recover` is for positive damage only. */
export const ACTION_SKILLS = Object.freeze({ recover: '/sf-recover', takeover: '/sf-session', decide: '/sf-decide', approve: '/sf-approve',
  reject: '/sf-reject', readiness: '/sf-submit', review: '/sf-review-source' });

/*
 * Each entry: its Copilot command and its named Shell forms. `<step>` and `<W>` are filled from the decision's target and
 * Story; any other `<…>` is a placeholder the person fills. `shell` lists every form, in the order the forms are named.
 */
const entry = (copilot, forms) => Object.freeze({ copilot, forms: Object.freeze(forms), shell: Object.freeze(Object.values(forms)) });
export const ACTION_COMMANDS = Object.freeze({
  'open-version': entry('work', { preview: 'phase rollover <step> --json', begin: 'phase begin <step> --json', prepare: 'prepare <step>' }),
  'build-version': entry('work', { prepare: 'prepare <step>', preview: 'phase rollover <step> --json' }),
  'author-version': entry('work', { prepare: 'prepare <step>' }),
  'repair-version': entry('work', { prepare: 'prepare <step>' }),
  // `prepublish` checks and publishes once ready; `check` checks a deterministic step's code; `draft` checks an authored draft.
  'publish-version': entry('work', { prepublish: 'phase prepublish <step> --for-agent --json --publish-if-ready', pending: 'sync',
    check: 'phase prepublish <step> --for-agent --json', draft: 'phase prepublish <step>' }),
  // The review's packet, its retention and its status read: the reviewer's and the delegation's own commands.
  'start-review': entry(ACTION_SKILLS.review, { context: 'review-source context <step> --for-agent --json', retain: 'review-source submit <step>',
    status: 'review-source status <step> --work-id <W> --for-agent --json' }),
  'review-version': entry(ACTION_SKILLS.review, { context: 'review-source context <step> --for-agent --json' }),
  // `exact`: the submission itself; the decision values a step records are added by submitRoute below.
  'submit-version': entry(ACTION_SKILLS.readiness, { readiness: 'status <W> --submission-readiness --json', exact: 'submit <step> --work-id <W>' }),
  'refresh-facts': entry(ACTION_SKILLS.readiness, { readiness: 'status <W> --submission-readiness --json' }),
  'approve-step': entry(ACTION_SKILLS.approve, { approve: 'approve <step> --work-id <W> --fetch',
    reject: 'reject <step> --work-id <W> --fetch --to <phase> --reason <reason>' }),
  decide: entry(ACTION_SKILLS.decide, { story: 'decision show <W>', card: 'decisions <W>' }),
  'recover-operation': entry('work', { reconcile: 'phase opening <step> --reconcile --json', recover: 'recover <W> --phase <step> --json' }),
  'takeover-writer': entry(ACTION_SKILLS.takeover, { takeover: 'session takeover <W> --json' }),
  'refresh-authority': entry('by-command', { branch: 'refresh-branch', session: 'session current --for-agent --json' }),
  inspect: entry('by-command', { show: 'phase show <step> --json', session: 'session current --for-agent --json' }),
  'provide-input': entry('by-command', { readiness: 'documents readiness --phase <step> --work-id <W> --json' }),
  none: entry('by-command', { nextsteps: 'nextsteps --json' })
});

/**
 * One form of an operation's Shell command without its executable (`review-source context intake --for-agent --json`),
 * for `step` of Story `workId`; null for a form the map does not name. A form keeps any placeholder for the person.
 */
export function actionCommand(operation, form, { step = null, workId = null } = {}) {
  const template = ACTION_COMMANDS[operation]?.forms[form];
  if (!template) return null;
  const words = template.split(' ').map((word) => word === '<step>' ? step : word === '<W>' ? workId : word);
  return words.some((word) => word === null || word === undefined || word === '') ? null : words.join(' ');
}

/** The same with its executable, as a person runs it. */
export const actionCommandLine = (operation, form, subject) => {
  const words = actionCommand(operation, form, subject);
  return words ? `singularity-flow ${words}` : null;
};

/** The work command a step's routes show: /sf-code for code, /sf-phase for any other step, or its configured or fixed author. */
export function workCommandOf(phase, workflow = null) {
  const skill = generationSkillForPhase(phase, workflow);
  return skill ? skill.replace(/^\/sflow-/u, '/sf-') : null;
}

/** An operation's Copilot command for `phase` (null: the crosswalk decides from its Shell command); `recover`: positive damage. */
export function actionSkill(operation, { phase = null, workflow = null, variant = null } = {}) {
  const found = ACTION_COMMANDS[operation];
  if (!found) return null;
  if (operation === 'recover-operation' && variant === 'recover') return ACTION_SKILLS.recover;
  if (found.copilot === 'work') return phase ? workCommandOf(phase, workflow) : null;
  return found.copilot === 'by-command' ? null : found.copilot;
}

/** A step SFlow builds (producer `deterministic`) is checked and published by its own work command, never /sf-publish [C9]. */
export function builtPublicationRoute(workflow, phase, producer, modelEnabled) {
  const command = producer === 'deterministic' && actionCommandLine('publish-version', 'prepublish', { step: phase.id });
  return command ? { skill: actionSkill('publish-version', { phase, workflow }), command: modelEnabled ? command : `${command} --no-model` } : null;
}

/** A published step's own version question, the open-version preview: its next version opens only on the person's yes [D3]. */
export const versionQuestionRoute = (workflow, phase) => ({ skill: actionSkill('open-version', { phase, workflow }),
  command: actionCommandLine('open-version', 'preview', { step: phase.id }).replace(/ --json$/u, ' --reason "<what to change>" --json') });

/**
 * The command that takes a published step toward approval, for every producer of guidance: the map's `submit-version`
 * forms [OSA:REQ-021]. Routes used to offer a bare `submit <phase>` from wherever they were, so a step that owes an
 * independent source review first, or that feeds a workflow decision, got a command the submit gate then refused. A
 * reviewable step goes through submission readiness (which reports the review and its exact route); any other step gets
 * `submit` with the decision values it must record.
 */
export function submitRoute(workflow, phase) {
  const subject = { step: phase.id, workId: workflow.workItem.id };
  if (sourceReviewRequired(workflow, phase.id)) {
    return { skill: ACTION_SKILLS.readiness, command: actionCommandLine('submit-version', 'readiness', subject),
      reason: `Check ${phase.id}'s submission readiness: its independent source review comes before submission.` };
  }
  return { skill: ACTION_SKILLS.readiness, command: `${actionCommandLine('submit-version', 'exact', subject)}${decisionSubmitArguments(workflow, phase.id)}`,
    reason: `Submit published ${phase.id}.` };
}

/**
 * A code step's publication as its work command runs it, check then publish once ready [OSA:REQ-021]: its code is written
 * by that command, never generated by SFlow, whatever producer records its summary (daily run, 2026-11-17).
 */
export function codePublicationRoute(workflow, phase) {
  return { skill: actionSkill('publish-version', { phase, workflow }), command: actionCommandLine('publish-version', 'prepublish', { step: phase.id }) };
}
