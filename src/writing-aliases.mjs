/**
 * SPEC-OSA v1.1 Stage 4, REQ-027 and AC-019: the writing aliases as compatibility adapters into the one work command (D1).
 * Each keeps its arguments, its explicit target and its standalone meaning (docs/osa/alias-matrix.md); an ambiguous
 * invocation gets a precise clarification instead of a guess. Pure, and loaded only where it is read (the prompt hook's
 * typed-words record, asked-for.mjs), so no eager closure carries it.
 */
import { WORK_COMMANDS } from './command-skills.mjs';

// A bare word that says which step or form to run, never what to build (asked-for.mjs NOT_AN_INSTRUCTION).
const FORM_WORD = /^(?:context|stage|check|status|show|preview|prepare|publish|continue|resume)$/iu;

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

/**
 * A writing alias as the work command reads it: a compatibility adapter that keeps the alias's arguments, explicit target
 * and standalone meaning [OSA:REQ-027, AC-019]. Returns
 * - `{ coordinator: 'work', via, target, focus }` for the work command and the aliases that do the current step's work
 *   (`via`: the work command the alias names; D1 makes both the same);
 * - `{ coordinator: 'next' }` for /sf-next, which does the current step's agent work in its own turn (D2);
 * - `{ standalone: <contract> }` for an invocation that keeps its own registered behaviour (/sf-run's guided run, a
 *   convergence adjudication, /sf-code-docs's doc comments);
 * - `{ clarification: <code>, … }` for an ambiguous one, never a guess.
 * `steps`: the Story's step IDs; `stepAgent`: the user-defined agent the Story was started with, when there is one.
 */
export function writingAlias(skill, typed = '', { steps = [], stepAgent = null } = {}) {
  const name = String(skill ?? '').trim().replace(/^\/?(?:sflow|sf)-/u, '');
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
    case 'next': return { coordinator: 'next' };
    case 'run': return { standalone: 'guided-run', focus: text || null };
    case 'converge': return { standalone: 'convergence' };
    case 'code-docs': return { standalone: 'doc-comments', focus: text || null };
    default: return null;
  }
}
