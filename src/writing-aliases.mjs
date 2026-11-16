/**
 * SPEC-OSA v1.1 Stage 4, REQ-027 and AC-019: the writing aliases as compatibility adapters into the one work command (D1).
 * Each keeps its arguments, its explicit target and its standalone meaning (docs/osa/alias-matrix.md); an ambiguous
 * invocation gets a precise clarification instead of a guess. Pure. The prompt hook reads the alias table for its skill
 * lists (copilot-repository-boundary.mjs, asked-for.mjs), so this module is in the hook's own graph; no lifecycle
 * handler's eager closure carries it.
 */
import { WORK_COMMANDS } from './command-skills.mjs';

// A bare word that says which step or form to run, never what to build (asked-for.mjs NOT_AN_INSTRUCTION).
const FORM_WORD = /^(?:context|stage|check|status|show|preview|prepare|publish|continue|resume)$/iu;

/**
 * Every writing alias, by its skill name, and what it is: the one place that names them [OSA:REQ-027, AC-019, Stage 5].
 * writingAlias reads it, and so do the Copilot hook's skill lists below. `kind`:
 * - `work-command`: one of the work command's two names (D1, command-skills.mjs WORK_COMMANDS);
 * - `delegate`: does the current step's work by handing it once to the work command;
 * - `router`: a fast-path verb's router, which says where the Story stands; a work type without the fast path, or a step
 *   the verb does not route, gets that answer and the Story's next steps, never a guess;
 * - `checklist`: /sf-verify, the verification checklist on a step /sf-phase writes; another step's writer is relayed;
 * - `next`: /sf-next, the current step's work in its own turn (D2);
 * - `standalone`: its own registered contract (`contract`).
 * `completesTask`: its turn asks the stop hook to keep going until the step's task is done.
 */
export const WRITING_ALIASES = Object.freeze({
  code: Object.freeze({ kind: 'work-command', completesTask: true }),
  phase: Object.freeze({ kind: 'work-command', completesTask: true }),
  implement: Object.freeze({ kind: 'delegate', completesTask: true }),
  'scenario-repair': Object.freeze({ kind: 'delegate', completesTask: true }),
  call: Object.freeze({ kind: 'delegate', completesTask: true }),
  specify: Object.freeze({ kind: 'router', completesTask: true }),
  plan: Object.freeze({ kind: 'router', completesTask: true }),
  verify: Object.freeze({ kind: 'checklist', completesTask: true }),
  next: Object.freeze({ kind: 'next', completesTask: false }),
  run: Object.freeze({ kind: 'standalone', contract: 'guided-run', completesTask: false }),
  converge: Object.freeze({ kind: 'standalone', contract: 'convergence', completesTask: false }),
  'code-docs': Object.freeze({ kind: 'standalone', contract: 'doc-comments', completesTask: false })
});

const aliasNames = (keep) => Object.entries(WRITING_ALIASES).filter(([, alias]) => keep(alias)).map(([name]) => name);

/**
 * The prompt hook's turns whose typed words are kept as what the person asked for [SCS:REQ-040]: the work command's two
 * names, as a turn names its skill (`sf-code`, `sflow-code`, …).
 */
export const ASKED_FOR_SKILLS = Object.freeze(aliasNames((alias) => alias.kind === 'work-command').flatMap((name) => [`sf-${name}`, `sflow-${name}`]));

/** The aliases whose turn completes the step's task, by their packaged skill name (`sflow-call`, …). */
export const TASK_COMPLETION_ALIASES = Object.freeze(aliasNames((alias) => alias.completesTask).map((name) => `sflow-${name}`));

/**
 * The arguments typed after a work command (`/sf-code <step> [what to change]`, `/sf-phase <step>`), as the one work
 * command reads them [OSA:REQ-027]: a first word naming one of the Story's steps is the explicit target, never what the
 * person asked for; the rest is the focus. `steps`: the Story's step IDs.
 */
export function workCommandArguments(typed, steps = []) {
  const text = typeof typed === 'string' ? typed.trim() : '';
  if (!text) return { target: null, focus: null };
  const [first, ...rest] = text.split(/\s+/u);
  const target = steps.includes(first) ? first : null;
  const focus = (target ? rest.join(' ') : text).trim();
  return { target, focus: focus && !FORM_WORD.test(focus) ? focus : null };
}

// A skill as a route names it, `/sf-<name>` (or `/sflow-<name>`, or bare), as its name alone.
const nameOf = (skill) => String(skill ?? '').trim().split(/\s+/u)[0].replace(/^\/?(?:sflow|sf)-/u, '');

/**
 * A writing alias as the work command reads it: a compatibility adapter that keeps the alias's arguments, explicit target
 * and standalone meaning [OSA:REQ-027, AC-019]. Returns
 * - `{ coordinator: 'work', via, target, focus }` for the work command and the aliases that do the current step's work
 *   (`via`: the work command the alias names; D1 makes both the same);
 * - `{ coordinator: 'next' }` for /sf-next, which does the current step's agent work in its own turn (D2);
 * - `{ router: <verb> }` for /sf-specify and /sf-plan: their own router answers, with no argument of theirs;
 * - `{ checklist: 'verification', scope }` for /sf-verify on a step /sf-phase writes, and `{ relay: <writer>, scope }` on
 *   any other step: its writer is named and the turn stops there, never verified by this command;
 * - `{ standalone: <contract> }` for an invocation that keeps its own registered behaviour (/sf-run's guided run, a
 *   convergence adjudication, /sf-code-docs's doc comments);
 * - `{ clarification: <code>, … }` for an ambiguous one, never a guess.
 * `steps`: the Story's step IDs; `stepAgent`: the user-defined agent the Story was started with, when there is one;
 * `writer`: the current step's own writer (`phase show`'s `effectiveAuthoringSkill`), when it was read.
 */
export function writingAlias(skill, typed = '', { steps = [], stepAgent = null, writer = null } = {}) {
  const name = nameOf(skill);
  const text = typeof typed === 'string' ? typed.trim() : '';
  switch (name) {
    case 'code': case 'phase': return { coordinator: 'work', via: `/sf-${name}`, ...workCommandArguments(text, steps) };
    case 'implement': return { coordinator: 'work', via: WORK_COMMANDS[0], target: null, focus: text || null };
    case 'scenario-repair': return text
      ? { coordinator: 'work', via: WORK_COMMANDS[0], target: null, focus: text }
      : { clarification: 'scenario-defect-required', words: 'Name the approved scenario defect to repair after /sf-scenario-repair.' };
    case 'call': {
      const [agent, ...rest] = text ? text.split(/\s+/u) : [];
      if (!agent) return { clarification: 'agent-required', words: 'Name the agent after /sf-call: /sf-call <AGENT-NAME> [focus].' };
      if (stepAgent && agent !== stepAgent) return { clarification: 'agent-mismatch', agent, stepAgent,
        words: `This Story runs agent ${stepAgent}, not ${agent}. A Story for ${agent} starts with /sf-start <WORK-ID> --agent ${agent}.` };
      return { coordinator: 'work', via: WORK_COMMANDS[0], agent, target: null, focus: rest.join(' ') || null };
    }
    // The router takes no argument: it names the step its commands run, and a work type without the fast path is told so.
    case 'specify': case 'plan': return { router: name };
    // The scope or environment typed after /sf-verify is the checklist's own, never a step target or what was asked for.
    case 'verify': {
      const scope = text || null;
      const own = writer ? nameOf(writer) : null;
      return own && own !== 'phase' ? { relay: `/sf-${own}`, scope } : { checklist: 'verification', scope };
    }
    case 'next': return { coordinator: 'next' };
    case 'run': return { standalone: 'guided-run', focus: text || null };
    case 'converge': return { standalone: 'convergence' };
    case 'code-docs': return { standalone: 'doc-comments', focus: text || null };
    default: return null;
  }
}
