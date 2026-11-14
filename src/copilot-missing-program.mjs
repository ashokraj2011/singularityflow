/**
 * An SFlow command typed without its program: `story intent-amendment propose --file …` where
 * `singularity-flow story …` was meant. The guard refused it as a tool form it could not read, the
 * model was told nothing about the missing word and gave up on the route (paid Copilot CLI run,
 * 2026-11-14). The refusal now names the command it meant, which the turn corrects at once.
 *
 * Only the refusal's words change: the command stays refused. Loaded by copilot-mutation-guard.mjs
 * only when it refuses a terminal call, so the guard's per-call graph stays as it was.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { canonicalCommand } from './command-registry.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { safeCommandGuidance, validateSflowExecutionCommand } from './safe-command-guidance.mjs';

export const MISSING_PROGRAM_CODE = 'PHASE_MUTATION_SFLOW_PROGRAM_MISSING';

// Shell builtins and keywords (sh, bash, zsh) a family shares its name with: the shell runs those as themselves.
const SHELL_WORDS = new Set(['help', 'return', 'local', 'exec', 'command', 'type', 'test', 'time', 'source', 'export',
  'set', 'unset', 'cd', 'read', 'wait', 'jobs', 'history', 'alias', 'eval', 'trap', 'select', 'function']);
const SFLOW = /^(?:singularity-flow|sflow)$/u;

/** Whether `word` is a program on this PATH (with Windows' PATHEXT), as the shell would find it. */
function onPath(word, env = process.env) {
  const extensions = process.platform === 'win32'
    ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const directory of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const stat = statSync(path.join(directory, `${word}${extension}`));
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return true;
      } catch { /* not in this directory */ }
    }
  }
  return false;
}

/** The first simple command of a line: up to its first `&&`, `||`, `;`, `|` or newline outside quotes. */
function firstCommand(line) {
  return /^\s*((?:[^'"&;|\n]|'[^']*'|"(?:[^"\\]|\\.)*")+?)\s*(?:&&|\|\||;|\||\n|$)/u.exec(line)?.[1]?.trim() ?? null;
}

const standalone = (line, powershell) => {
  const safe = validateSflowExecutionCommand(line, { shell: powershell ? 'powershell' : 'posix', maximumLength: 2000 });
  return safe?.copyable ? safe : null;
};

/**
 * The refusal for the first terminal call whose line starts with a registered command family or alias
 * that is not itself a program, or null. `scoped(call)` is the guard's own reading of the line: what
 * follows a `cd <root> &&` or `env -C <root>` it accepts, or the line itself.
 */
export function missingProgramDenial(terminalCalls, scoped) {
  for (const call of terminalCalls) {
    const typed = String(call.args?.command ?? call.args?.cmd ?? call.args?.script ?? '').trim();
    const rest = scoped(call);
    if (typeof rest !== 'string') continue;
    const remainder = rest.trim();
    const head = /^([a-z][a-z0-9-]*)(?=\s|$)/u.exec(remainder)?.[1];
    if (!head || SFLOW.test(head) || SHELL_WORDS.has(head)) continue;
    try { canonicalCommand(head); } catch { continue; }
    if (onPath(head)) continue;
    const prefix = typed.endsWith(remainder) ? typed.slice(0, typed.length - remainder.length) : '';
    const powershell = call.name === 'powershell';
    const whole = `singularity-flow ${remainder}`;
    // The whole line when it is one standalone command; otherwise its first command, run on its own.
    const first = standalone(whole, powershell) ? null : firstCommand(remainder);
    const safe = standalone(whole, powershell) ?? (first ? standalone(`singularity-flow ${first}`, powershell) : null);
    const corrected = safe && first ? `${prefix}singularity-flow ${first}` : `${prefix}${whole}`;
    const guidance = safe ? safeCommandGuidance({ argv: safe.argv }) : null;
    // This turn runs it: the route is the command, not another turn's skill.
    const routes = guidance ? [{ ...guidance, skill: null, copilotCommand: null }] : [];
    const reason = `${MISSING_PROGRAM_CODE}: \`${head}\` is not a program: run it as \`${corrected}\``
      + `${safe && first ? ', on its own, with no chain or pipe' : ''}. Every SFlow command starts with singularity-flow; nothing ran. `
      + 'Correct the tool form in this turn; this refusal does not invalidate the phase or require repeating clarification';
    const lines = routes.map(route => formatCommandRouteLines(route).join('\n'));
    return { permissionDecision: 'deny', permissionDecisionReason: `${reason}.${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`, next: routes };
  }
  return null;
}
