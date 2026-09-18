/**
 * One strict trust boundary for displaying a CLI command beside its Copilot equivalent.
 *
 * Commands in result envelopes cross a process boundary and must therefore be treated as
 * untrusted, even when the current producer is the SFlow engine.  This module accepts only a
 * registered SFlow command, rejects shell syntax and credential-shaped material, and derives the
 * Copilot route from the canonical crosswalk.  Producer-supplied routes are assertions: when they
 * disagree with the crosswalk the whole action is rejected instead of being silently repaired.
 */

import { commandDefinition } from './command-registry.mjs';
import { skillForCommandLine } from './command-skills.mjs';
import {
  copilotCommandForCommand, directCopilotSkill, directCopilotSkillId
} from './copilot-guidance.mjs';

const SAFE_EXECUTABLE = /^(?:singularity-flow|sflow)(?:\s|$)/u;
const SECRET_SHAPE = /(?:--(?:token|secret|password|credential|authorization|cookie|api[-_]?key|private[-_]?key|selection[-_]?receipt)\b|:\/\/[^\s/@:]+:[^\s/@]+@)/iu;
const FORBIDDEN_SHELL_SYNTAX = /[;&|`$()*?![\]{}#~]/u;
// Names with a stable non-code meaning in the packaged workflows cannot be relabelled by an
// untrusted presentation assertion. Custom phase ids remain eligible for `/sf-code`; the skill
// still re-reads their signed `generation.task: code` policy before it can act.
const KNOWN_NON_CODE_PHASE_IDS = new Set([
  'intake', 'requirements', 'specification', 'planning', 'plan', 'design', 'verification',
  'verify', 'testing', 'convergence', 'release', 'conformance', 'reproduction', 'fix-design',
  'fix-spec', 'design-intake', 'design-inventory', 'component-mapping', 'mobile-spec',
  'visual-verification', 'poc-impact-analysis', 'poc-ui-exploration', 'poc-validation',
  'poc-lite-plan', 'poc-lite-verify'
]);
// Guidance is allowed to describe a value the user must still supply.  The grammar is deliberately
// narrower than a shell word: no whitespace, quotes, substitutions, or redirection.  Lower-case
// names and bounded alternatives are accepted because the product's own help uses forms such as
// `<phase>`, `<reason>`, and `<rework|dismissed>`.
const PLACEHOLDER_SOURCE = '<[A-Za-z][A-Za-z0-9 ._/|-]*>';
const PLACEHOLDER_GLOBAL = new RegExp(`(?<![A-Za-z0-9._/-])${PLACEHOLDER_SOURCE}(?![A-Za-z0-9._/-])`, 'gu');
const PLACEHOLDER_ASSIGNMENT_GLOBAL = new RegExp(
  `(?<![A-Za-z0-9._/-])${PLACEHOLDER_SOURCE}=[A-Za-z0-9._/-]+(?:\\|[A-Za-z0-9._/-]+)+(?![A-Za-z0-9._/-])`,
  'gu'
);
// Optional CLI syntax is display-only and must be one bracketed option with safe literal or
// placeholder arguments.  It is never made copyable or converted into platform execution forms.
const OPTIONAL_GROUP_SOURCE = `\\[--[a-z0-9][a-z0-9-]*(?:\\s+(?:${PLACEHOLDER_SOURCE}|[A-Za-z0-9._/-]+|\\.\\.\\.))*\\]`;
const OPTIONAL_GROUP_GLOBAL = new RegExp(OPTIONAL_GROUP_SOURCE, 'giu');
// Older producers used unquoted sentinel words instead of the explicit `<VALUE>` grammar. Keep
// accepting those records for display, but never make them executable. This is intentionally a
// small closed list: arbitrary upper-case Story IDs such as `CFA-STORY` remain real values.
const LEGACY_PLACEHOLDER_GLOBAL = /(?<![A-Za-z0-9._/-])(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|WORK-ID|GOAL-ID|BOOTSTRAP-ID|CFP-ID|PLAN-HASH|PREDICATE-ID|CONFIGURED-COMMAND-ID|PROPOSAL-FILE|FILE|URL|PATH|PHASE|TYPE|TEXT|ID|SHA|SHA256|REVISION|PROFILE|SLICE|LEVEL|ASSURANCE|VERSION|STATUS|SOURCE|ENV|SECONDS|BYTES)(?![A-Za-z0-9._/-])/gu;

function scrubDisplayGrammar(value) {
  const optional = value.replace(OPTIONAL_GROUP_GLOBAL, ' OPTIONAL ');
  const assignments = optional.replace(PLACEHOLDER_ASSIGNMENT_GLOBAL, ' VALUE ');
  const placeholders = assignments.replace(PLACEHOLDER_GLOBAL, ' VALUE ');
  const legacy = placeholders.replace(LEGACY_PLACEHOLDER_GLOBAL, ' VALUE ');
  // An ellipsis is always an instruction to supply missing content, including when an older
  // producer wrapped it in quotes (`--reason "..."`). Treat it as display grammar rather than an
  // executable literal so the UI cannot offer a misleading Copy/Run action.
  const ellipses = legacy.replace(/\.{3}|…/gu, ' MORE ');
  return {
    scrubbed: ellipses,
    displayOnly: optional !== value || assignments !== optional
      || placeholders !== assignments || legacy !== placeholders || ellipses !== legacy
  };
}

function hasForbiddenShellSyntax(value) {
  let quote = null;
  for (const character of value) {
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') { quote = null; continue; }
      // Both POSIX shells and PowerShell interpolate at least one of these inside double quotes.
      if (/[$`!]/u.test(character)) return true;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (FORBIDDEN_SHELL_SYNTAX.test(character)) return true;
  }
  return false;
}

function tokenizeCommand(command, shell = 'posix') {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { current += character; escaped = false; continue; }
    if (shell === 'posix' && character === '\\' && quote !== "'") {
      const next = command[index + 1] ?? '';
      // Preserve ordinary Windows separators. In portable guidance a backslash is an escape only
      // where both the POSIX and Windows readings are unambiguous: before whitespace, a quote, or
      // another backslash. Inside double quotes POSIX likewise treats `\x` as a literal backslash
      // for ordinary characters, so `"C:\work\repo"` remains intact.
      const escapable = quote === '"'
        ? ['"', '\\'].includes(next)
        : /\s/u.test(next) || ['"', "'", '\\'].includes(next);
      if (escapable) { escaped = true; continue; }
      current += character;
      continue;
    }
    if (quote) {
      if (character === quote) {
        // PowerShell represents an apostrophe inside a single-quoted argument as ''.
        // POSIX closes and reopens the quote instead; keep the two grammars distinct.
        if (shell === 'powershell' && quote === "'" && command[index + 1] === "'") {
          current += "'";
          index += 1;
        } else quote = null;
      }
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/u.test(character)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += character;
  }
  if (escaped || quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function quoteToken(value, platform) {
  return platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function canonicalDisplayToken(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandFromArgv(executable, argv) {
  return [executable, ...argv].map(canonicalDisplayToken).join(' ');
}

function normalizedCommandArgv(input) {
  if (!Array.isArray(input?.argv)) return null;
  const executable = input.executable == null ? 'singularity-flow' : String(input.executable).trim();
  if (!['singularity-flow', 'sflow'].includes(executable)) return null;
  if (input.argv.some((value) => typeof value !== 'string' || !value
      || /[\u0000-\u001f\u007f]/u.test(value))) return null;
  const fullVector = ['singularity-flow', 'sflow'].includes(input.argv[0]);
  if (fullVector && input.executable != null && input.argv[0] !== executable) return null;
  // Most producers use { executable, argv: [subcommand, ...] }; a few durable recovery
  // plans preserve the full process argv. Accept both forms while applying the identical
  // registered-command, secret, and shell-syntax checks below.
  const argv = (fullVector ? input.argv.slice(1) : input.argv).map(String);
  const command = commandFromArgv(executable, argv);
  const safe = validateSafeSflowCommand(command);
  return safe ? { ...safe, executable: 'singularity-flow' } : null;
}

/**
 * Render an argv vector as one copyable command without ever treating an argument as shell text.
 *
 * JSON string syntax is not shell quoting: POSIX shells still expand `$()` and backticks inside a
 * JSON double-quoted string.  This is the shared presentation boundary for command guidance.  It
 * deliberately uses single-quoted words on POSIX and PowerShell and refuses control characters so
 * a rendered command always remains one visible command line.
 */
export function renderPlatformCommand(argv, platform = process.platform) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('Command argv must be a non-empty array.');
  }
  const normalized = argv.map((value) => {
    if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError('Command argv values must be non-empty strings without control characters.');
    }
    return value;
  });
  const command = normalized.map((token) => quoteToken(token, platform)).join(' ');
  return platform === 'win32' ? `& ${command}` : command;
}

/**
 * Render exact argv for cmd.exe without relying on cmd's unsafe quoting and expansion rules.
 *
 * `%NAME%`, `!NAME!`, carets, ampersands, and parentheses can remain active even inside ordinary
 * cmd.exe quotes. Encode the already-safe PowerShell argv invocation as UTF-16LE instead; the
 * resulting Base64 token contains no cmd metacharacters and works from Command Prompt on every
 * supported Windows installation.
 */
export function renderCommandPromptCommand(argv) {
  const powershell = renderPlatformCommand(argv, 'win32');
  const encoded = Buffer.from(powershell, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function normalizedSkill(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || /\s/u.test(candidate)) return null;
  const direct = directCopilotSkill(candidate);
  const id = directCopilotSkillId(direct);
  return direct === id ? id : null;
}

/** Validate command syntax and the registered top-level CLI family. */
export function validateSafeSflowCommand(value, { shell = 'posix' } = {}) {
  if (!['posix', 'powershell'].includes(shell)) return null;
  const original = typeof value === 'string' ? value.trim() : '';
  const displayGrammar = scrubDisplayGrammar(original);
  if (!original || original.length > 2_000 || /[\r\n\u0000-\u001f\u007f]/u.test(original)
      || !SAFE_EXECUTABLE.test(original) || SECRET_SHAPE.test(original)
      || hasForbiddenShellSyntax(displayGrammar.scrubbed)
      || /[<>\[\]]/u.test(displayGrammar.scrubbed)) return null;
  const tokens = tokenizeCommand(original, shell);
  if (!tokens?.length || !['singularity-flow', 'sflow'].includes(tokens[0])) return null;
  const executable = tokens[0] === 'sflow' ? ['singularity-flow', ...tokens.slice(1)] : tokens;
  const top = executable[1];
  if (!top || (top.startsWith('-') && !['--help', '--version', '-h', '-v'].includes(top))) return null;
  if (!top.startsWith('-')) {
    try { commandDefinition(top); } catch { return null; }
  }
  const command = original;
  const copyable = !displayGrammar.displayOnly;
  return Object.freeze({
    command,
    executable: 'singularity-flow',
    argv: Object.freeze(executable.slice(1)),
    copyable,
    platformCommands: copyable ? Object.freeze({
      darwin: renderPlatformCommand(executable, 'darwin'),
      linux: renderPlatformCommand(executable, 'linux'),
      win32: renderPlatformCommand(executable, 'win32')
    }) : null
  });
}

/**
 * Return a canonical shell/Copilot pair, or null when any supplied route contradicts it.
 *
 * Only `/sf-sgos` and `/sf-auto` deliberately preserve CLI arguments.  That behavior lives in
 * `copilotCommandForCommand`; every other route is the bare, packaged journey selected by the
 * command crosswalk.
 */
export function safeCommandGuidance(value) {
  const input = typeof value === 'string' ? { command: value } : (value ?? {});
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fromCommand = input.command == null ? null
    : validateSafeSflowCommand(input.command, { shell: input.shell ?? 'posix' });
  const fromArgv = input.argv == null ? null : normalizedCommandArgv(input);
  if (input.command != null && !fromCommand) return null;
  if (input.argv != null && !fromArgv) return null;
  if (fromCommand && fromArgv && (
    fromCommand.executable !== fromArgv.executable
      || fromCommand.argv.length !== fromArgv.argv.length
      || fromCommand.argv.some((entry, index) => entry !== fromArgv.argv[index])
  )) return null;
  const safe = fromCommand ?? fromArgv;
  if (!safe) return null;
  const canonicalSkill = normalizedSkill(skillForCommandLine(safe.command));
  if (!canonicalSkill) return null;
  // The exact subcommand route is authoritative.  Treating every skill in a broad command family
  // as interchangeable can turn a read (`workspace list`) into a copied mutation journey
  // (`/sf-workspace-bootstrap`).  Phase generation is the one deliberate exception: repository
  // policy may select a specialised authoring skill such as `/sf-code` for the same prepare/publish
  // command, and the closed family whitelist records those reviewed alternatives.
  const allowedSkills = new Set([canonicalSkill]);
  const phaseId = safe.argv[0] === 'prepare'
    ? safe.argv[1]
    : safe.argv[0] === 'phase' && ['begin', 'publish', 'draft-check', 'show'].includes(safe.argv[1])
      ? safe.argv[2]
      : null;
  // A repository may name a code-delivery phase freely. The engine-selected `/sf-code` assertion
  // is safe for every prepare/begin/publish command because that skill re-reads the signed phase
  // policy before doing work; presentation does not infer code delivery from the phase name.
  if (phaseId && !KNOWN_NON_CODE_PHASE_IDS.has(phaseId)) {
    allowedSkills.add('/sf-code');
  }
  if (phaseId === 'convergence') allowedSkills.add('/sf-converge');
  const assertedSkill = input.skill != null
    ? normalizedSkill(input.skill)
    : input.copilotCommand != null
      ? directCopilotSkillId(input.copilotCommand)
      : null;
  const selectedSkill = assertedSkill ?? canonicalSkill;
  if (!selectedSkill || !allowedSkills.has(selectedSkill)) return null;
  const canonicalCopilotCommand = copilotCommandForCommand(safe.command, selectedSkill);

  if (input.skill != null) {
    const suppliedSkill = normalizedSkill(input.skill);
    if (!suppliedSkill || suppliedSkill !== selectedSkill) return null;
  }
  if (input.copilotCommand != null) {
    const supplied = typeof input.copilotCommand === 'string'
      ? input.copilotCommand.trim() : '';
    if (!supplied || supplied !== canonicalCopilotCommand || SECRET_SHAPE.test(supplied)
        || /[\r\n\u0000-\u001f\u007f]/u.test(supplied)) return null;
  }

  return Object.freeze({
    ...safe,
    skill: selectedSkill,
    copilotCommand: canonicalCopilotCommand
  });
}
