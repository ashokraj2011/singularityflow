/**
 * Every problem in workflow.yml at once, each with its line, a plain reason and a concrete fix.
 *
 * The validator refuses at the first problem, which is right for enforcement and painful for the
 * person repairing the file: fix one, run again, meet the next. This reads the file the way the
 * validator does, then repeats the real validator on a working copy: after each refusal it applies
 * the fix it suggests (or sets the offending entry aside) and validates again. One misspelled phase
 * therefore reports once, not once per place that names it. Nothing here decides validity: the
 * validator still does, and only runs on a refusal path or when someone asks for a check.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { nearestNames, sentenceList, SingularityFlowError } from './util.mjs';

export const WORKFLOW_FILE = 'singularity/workflow.yml';
const MAXIMUM_PROBLEMS = 20;
const MAXIMUM_CHOICES = 12;
const MAXIMUM_TEMPLATE_FILES = 2000;

const spaces = line => /^ */u.exec(line)[0].length;
const meaningful = line => line.trim() && !line.trimStart().startsWith('#');

function nearestMeaningful(lines, index, step) {
  for (let cursor = index + step; cursor >= 0 && cursor < lines.length; cursor += step) if (meaningful(lines[cursor])) return lines[cursor];
  return null;
}

/**
 * The indentation a misaligned line most likely meant. Under a line that opens a block (ends in
 * `:`) it is the block's own indentation, taken from the next line when that is deeper; otherwise
 * it is whichever neighbour is closer, the line above winning a tie.
 */
function expectedIndent(lines, index) {
  const own = spaces(lines[index] ?? '');
  const before = nearestMeaningful(lines, index, -1); const after = nearestMeaningful(lines, index, 1);
  if (before != null && /:\s*(?:#.*)?$/u.test(before)) {
    const parent = spaces(before);
    return after != null && spaces(after) > parent ? spaces(after) : parent + 2;
  }
  const options = [before, after].filter(line => line != null).map(spaces).filter(value => value !== own);
  return options.sort((left, right) => Math.abs(left - own) - Math.abs(right - own))[0] ?? null;
}

function indentationFix(lines, index) {
  const own = spaces(lines[index] ?? ''); const expected = expectedIndent(lines, index);
  if (expected == null || expected === own) return 'Line it up with the lines it belongs with, using spaces only.';
  return `It is indented ${own} space${own === 1 ? '' : 's'}; it belongs with lines indented ${expected}. Indent it by ${expected} spaces.`;
}

const INDENTATION_ERRORS = new Set(['BAD_INDENT', 'BLOCK_AS_IMPLICIT_KEY', 'MULTILINE_IMPLICIT_KEY', 'TAB_AS_INDENT']);

const parseErrors = lines => YAML.parseDocument(lines.join('\n')).errors;
const reindent = (line, width) => `${' '.repeat(width)}${line.trimStart()}`;

/**
 * The line to re-indent and how, or null when there is no confident repair. YAML reports where the
 * parse broke, which is not always the misaligned line: an over-indented first child makes the next,
 * correctly indented line the one reported. So the reported line and the line above it are each
 * tried at the other's indentation, as is the reported line at its expected indentation, and the
 * repair leaving the fewest errors wins.
 */
function repairedLine(lines, error) {
  const index = (error.linePos?.[0]?.line ?? 0) - 1; const line = lines[index];
  if (line == null || !INDENTATION_ERRORS.has(error.code)) return null;
  if (error.code === 'TAB_AS_INDENT') return { index, text: line.replace(/^[\t ]+/u, match => match.replace(/\t/gu, '  ')) };
  const candidates = [];
  const expected = expectedIndent(lines, index);
  if (expected != null && expected !== spaces(line)) candidates.push({ index, text: reindent(line, expected) });
  let above = index - 1; while (above >= 0 && !meaningful(lines[above])) above -= 1;
  if (above >= 0 && !/:\s*(?:#.*)?$/u.test(lines[above]) && spaces(lines[above]) !== spaces(line)) {
    candidates.push({ index: above, text: reindent(lines[above], spaces(line)) });
    candidates.push({ index, text: reindent(line, spaces(lines[above])) });
  }
  let best = null;
  for (const candidate of candidates) {
    const trial = [...lines]; trial[candidate.index] = candidate.text;
    const errors = parseErrors(trial).length;
    if (!best || errors < best.errors) best = { ...candidate, errors };
  }
  return best;
}

/** The earlier line with the same key at the same indentation, inside the same block. */
function firstCopy(lines, index) {
  const own = lines[index] ?? ''; const key = /^\s*([^:#]+):/u.exec(own)?.[1]; const indent = spaces(own);
  if (!key) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!meaningful(lines[cursor])) continue;
    if (spaces(lines[cursor]) < indent) return null;
    if (spaces(lines[cursor]) === indent && /^\s*([^:#]+):/u.exec(lines[cursor])?.[1] === key) return cursor + 1;
  }
  return null;
}

/** A misaligned line, named by the repair that fixed it rather than where the parse broke. */
function indentationProblem(lines, repaired, file) {
  const own = spaces(lines[repaired.index]); const width = spaces(repaired.text);
  return { code: 'YAML_BAD_INDENT', file, line: repaired.index + 1, column: own + 1, source: lines[repaired.index].trimEnd(),
    message: 'This line is indented differently from the lines it belongs with.',
    fix: `It is indented ${own} space${own === 1 ? '' : 's'}; it belongs with lines indented ${width}. Indent it by ${width} spaces.` };
}

/** A YAML error in words a person editing the file can act on. */
function syntaxProblem(error, lines, file) {
  const line = error.linePos?.[0]?.line ?? null;
  const column = error.linePos?.[0]?.col ?? null;
  const index = line == null ? -1 : line - 1;
  const raw = String(error.message).split(/ at line \d+/u)[0].trim();
  const key = /^\s*([^:#]+):/u.exec(lines[index] ?? '')?.[1]?.trim();
  const plain = {
    BAD_INDENT: ['This line is indented differently from the lines it belongs with.', indentationFix(lines, index)],
    BLOCK_AS_IMPLICIT_KEY: ['This line is indented differently from the lines it belongs with.', indentationFix(lines, index)],
    MULTILINE_IMPLICIT_KEY: ['A key here runs onto the next line, which usually means the indentation is off.', indentationFix(lines, index)],
    TAB_AS_INDENT: ['This line is indented with a tab. YAML needs spaces.', 'Replace the tab with spaces.'],
    DUPLICATE_KEY: [`${key ? `'${key}'` : 'A key'} appears twice in the same block.`, `Keep one of them and remove the other${firstCopy(lines, index) ? ` (the first is on line ${firstCopy(lines, index)})` : ''}.`],
    MISSING_CHAR: [`Something is not closed here: ${raw}.`, 'Add the missing character, or quote the whole value.'],
    BAD_SCALAR_START: ['This value starts with a character YAML treats specially.', 'Put the value in quotes.'],
    UNEXPECTED_TOKEN: [`YAML cannot read this line: ${raw}.`, 'Check the line for a stray character, or quote the value.']
  }[error.code] ?? [`YAML cannot read this line: ${raw}.`, 'Check the line for a stray character or mismatched indentation.'];
  return { code: `YAML_${error.code ?? 'SYNTAX'}`, file, line, column, source: lines[index]?.trimEnd() ?? null,
    message: plain[0], fix: plain[1] };
}

/** Every key and scalar in the document, with the path a validator message would name. */
function documentEntries(document) {
  const entries = [];
  const walk = (node, at) => {
    if (YAML.isMap(node)) {
      for (const pair of node.items) {
        const key = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        entries.push({ path: [...at, key], node: pair.key, kind: 'key', text: key });
        walk(pair.value, [...at, key]);
      }
    } else if (YAML.isSeq(node)) node.items.forEach((item, index) => walk(item, [...at, index]));
    else if (YAML.isScalar(node) && node.value != null) entries.push({ path: at, node, kind: 'value', text: String(node.value) });
  };
  walk(document.contents, []);
  return entries;
}

/**
 * Where a validator message points in the file. Messages name things the way people do — "work type
 * 'feature' phase 'requirements' input references inactive phase 'intak'" — so the last quoted name
 * is looked up under the earlier ones. Dotted labels such as `collaboration.assignmentMode` are tried
 * as paths first. Returns null rather than guess when nothing matches.
 */
export function locateMessage(document, message) {
  for (const match of String(message).matchAll(/\b([A-Za-z][\w-]*(?:\.[\w-]+|\[\d+\])+)/gu)) {
    const parts = match[1].split(/\.|\[(\d+)\]/u).filter(part => part !== undefined && part !== '')
      .map(part => (/^\d+$/u.test(part) ? Number(part) : part));
    for (let length = parts.length; length >= 2; length -= 1) {
      const node = document.getIn(parts.slice(0, length), true);
      if (node !== undefined) {
        // A scalar's own value is what the message is about; a collection is found by its key.
        const entry = documentEntries(document).find(item => item.path.length === length
          && item.path.every((part, index) => part === parts[index]) && item.kind === (YAML.isScalar(node) ? 'value' : 'key'));
        if (entry) return entry;
      }
    }
  }
  const names = [...String(message).matchAll(/'([^'\n]{1,200})'/gu)].map(match => match[1]);
  const entries = documentEntries(document);
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const context = names.slice(0, index);
    const scored = entries.filter(entry => entry.text === names[index]).map(entry => ({ entry,
      score: context.filter(name => entry.path.slice(0, -1).includes(name)).length }));
    if (!scored.length) continue;
    const best = Math.max(...scored.map(item => item.score));
    return scored.find(item => item.score === best).entry;
  }
  return null;
}

/** The validator's words, with its internal jargon replaced by what to look for in the file. */
export function plainConfigurationMessage(message) {
  return String(message)
    .replace(/^Work type '([^']+)' references unknown phase '([^']+)'\./u,
      (_, type, phase) => `Work type '${type}' lists phase '${phase}', but no phase with that ID is defined under phases.`)
    .replace(/^Work type '([^']+)' phase '([^']+)' input references inactive phase '([^']+)'\./u,
      (_, type, phase, input) => `Phase '${phase}' of work type '${type}' takes input from '${input}', which is not one of the phases this work type lists.`)
    .replace(/^Work type '([^']+)' has an override for inactive phase '([^']+)'\./u,
      (_, type, phase) => `Work type '${type}' overrides phase '${phase}', which is not one of the phases it lists.`)
    .replace(/^Work type '([^']+)' has a template override for inactive phase '([^']+)'\./u,
      (_, type, phase) => `Work type '${type}' sets a template for phase '${phase}', which is not one of the phases it lists.`)
    .replace(/^Work type '([^']+)' allows document upload in inactive phase '([^']+)'\./u,
      (_, type, phase) => `Work type '${type}' allows document upload in phase '${phase}', which is not one of the phases it lists.`)
    .replace(/\binactive phase\b/gu, 'phase this work type does not list');
}

/** The names that would have been right where the message says a name is wrong. */
function choicesFor(message, entry, working, knownAgents) {
  const text = String(message);
  const enumerated = /must be (?:one of )?([\w-]+(?:, [\w-]+)*,? (?:or|and) [\w-]+)\.?$/u.exec(text);
  if (enumerated) return enumerated[1].split(/,?\s+(?:or|and)\s+|,\s*/u).filter(Boolean);
  if (!/\b(unknown|inactive|undefined|missing|unsupported|not (?:defined|configured|declared))\b/iu.test(text)) return [];
  const workType = entry?.path[0] === 'workTypes' ? working?.workTypes?.[entry.path[1]] : null;
  if (/\bphase\b/iu.test(text)) {
    const listed = Array.isArray(workType?.phases) ? workType.phases : [];
    const listsItself = entry?.path[0] === 'workTypes' && entry.path[2] === 'phases';
    return /inactive|does not list|this work type/iu.test(text) && listed.length && !listsItself ? listed : Object.keys(working?.phases ?? {});
  }
  if (/\bagent\b/iu.test(text)) return knownAgents ?? [];
  if (/\bwork type\b/iu.test(text)) return Object.keys(working?.workTypes ?? {});
  return [];
}

function lineOf(lineCounter, node) {
  if (!Array.isArray(node?.range)) return { line: null, column: null };
  const position = lineCounter.linePos(node.range[0]);
  return { line: position.line, column: position.col };
}

function setAt(target, at, value) {
  let parent = target;
  for (const part of at.slice(0, -1)) parent = parent?.[part];
  if (parent == null || typeof parent !== 'object') return false;
  parent[at.at(-1)] = value; return true;
}

/** Apply the suggested fix, or set the offending entry aside, so the next refusal is a new one. */
function repair(working, entry, suggestion) {
  let parent = working;
  for (const part of entry.path.slice(0, -1)) parent = parent?.[part];
  const last = entry.path.at(-1);
  if (parent == null || typeof parent !== 'object') return false;
  if (entry.kind === 'value') {
    if (suggestion != null) return setAt(working, entry.path, suggestion);
    if (Array.isArray(parent) && typeof last === 'number') { parent.splice(last, 1); return true; }
    delete parent[last]; return true;
  }
  if (!(last in parent)) return false;
  if (suggestion != null && !(suggestion in parent)) parent[suggestion] = parent[last];
  delete parent[last];
  return true;
}

async function templateFiles(root, templatesRoot) {
  const files = []; const base = path.join(root, templatesRoot);
  const walk = async (directory, relative) => {
    if (files.length >= MAXIMUM_TEMPLATE_FILES) return;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isDirectory()) await walk(path.join(directory, child.name), path.posix.join(relative, child.name));
      else if (child.isFile()) files.push(path.posix.join(relative, child.name));
    }
  };
  await walk(base, '');
  return files;
}

/**
 * Diagnose workflow.yml text. `validate` and `resolveWorkType` are the real validator functions,
 * passed in so this module never imports config.mjs and adds nothing to its load.
 */
export async function diagnoseWorkflowText(text, {
  root = null, file = WORKFLOW_FILE, validate, prepare = value => value, resolveWorkType = null,
  isAgentTemplateReference = () => false, knownAgents = []
} = {}) {
  const original = String(text).split('\n');
  // A YAML mistake derails the parse of the lines after it, so report the first error, repair it on a
  // copy the way its fix says, and parse again: knock-on errors disappear, independent ones remain.
  const lines = [...original]; const syntax = [];
  let lineCounter = new YAML.LineCounter();
  let document = YAML.parseDocument(lines.join('\n'), { lineCounter });
  while (document.errors.length && syntax.length < MAXIMUM_PROBLEMS) {
    const [error] = document.errors;
    const repaired = repairedLine(lines, error);
    syntax.push(repaired && error.code !== 'TAB_AS_INDENT'
      ? indentationProblem(original, repaired, file) : syntaxProblem(error, original, file));
    if (!repaired || lines[repaired.index] === repaired.text) return syntax;
    lines[repaired.index] = repaired.text;
    lineCounter = new YAML.LineCounter();
    document = YAML.parseDocument(lines.join('\n'), { lineCounter });
  }
  if (document.errors.length) return syntax;
  const problems = [...syntax]; const seen = new Set();
  const working = document.toJS();
  let validated = null;
  for (let round = 0; round <= MAXIMUM_PROBLEMS && problems.length < MAXIMUM_PROBLEMS; round += 1) {
    const candidate = prepare(structuredClone(working));
    try { validate(candidate); validated = candidate; break; } catch (error) {
      if (!(error instanceof SingularityFlowError)) break;
      const entry = locateMessage(document, error.message);
      const choices = choicesFor(error.message, entry, working, knownAgents);
      const suggestion = entry && choices.length ? nearestNames(entry.text, choices, { limit: 1 })[0] ?? null : null;
      const signature = `${entry?.path.join('.') ?? ''}|${error.message}`;
      if (seen.has(signature)) break;
      seen.add(signature);
      const listed = [...new Set(choices)].sort();
      problems.push({
        code: error.code ?? 'WORKFLOW_CONFIGURATION_INVALID', file, ...lineOf(lineCounter, entry?.node),
        path: entry?.path ?? null, source: entry ? lines[lineOf(lineCounter, entry.node).line - 1]?.trimEnd() ?? null : null,
        message: `${plainConfigurationMessage(error.message)}${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
        fix: suggestion ? `Change '${entry.text}' to '${suggestion}'.`
          : listed.length && listed.length <= MAXIMUM_CHOICES ? `Use one of: ${sentenceList(listed)}.`
            : entry ? 'Correct or remove this entry.' : null,
        ...(suggestion ? { suggestion } : {}), ...(listed.length ? { choices: listed } : {}),
        validatorMessage: error.message
      });
      if (!entry || !repair(working, entry, suggestion)) break;
    }
  }
  if (validated && root && typeof resolveWorkType === 'function') {
    const templatesRoot = validated.templatesRoot ?? 'singularity/templates';
    let available = null;
    for (const workTypeId of Object.keys(validated.workTypes ?? {})) {
      let phases;
      try { phases = resolveWorkType(validated, workTypeId).phases; } catch { continue; }
      for (const phase of phases) {
        if (phase.kind === 'skill' || !phase.template || isAgentTemplateReference(phase.template)) continue;
        if (existsSync(path.join(root, templatesRoot, phase.template))) continue;
        available ??= await templateFiles(root, templatesRoot);
        const declared = document.getIn(['workTypes', workTypeId, 'templateOverrides', phase.id], true) !== undefined
          ? ['workTypes', workTypeId, 'templateOverrides', phase.id] : ['phases', phase.id, 'defaultTemplate'];
        const entry = documentEntries(document).find(item => item.kind === 'value' && item.path.join('\u0000') === declared.join('\u0000'));
        const near = nearestNames(phase.template, available, { limit: 1 })[0] ?? null;
        const folder = path.posix.dirname(phase.template);
        const siblings = available.filter(candidate => path.posix.dirname(candidate) === folder).sort();
        const position = lineOf(lineCounter, entry?.node);
        if (problems.some(problem => problem.line === position.line && problem.code === 'WORKFLOW_TEMPLATE_MISSING')) continue;
        problems.push({ code: 'WORKFLOW_TEMPLATE_MISSING', file, ...position, path: entry?.path ?? declared,
          source: position.line ? lines[position.line - 1]?.trimEnd() ?? null : null,
          message: `Work type '${workTypeId}' phase '${phase.id}' uses template '${phase.template}', but ${path.posix.join(templatesRoot, phase.template)} does not exist.${near ? ` Did you mean '${near}'?` : ''}`,
          fix: near ? `Change '${phase.template}' to '${near}'.`
            : `Create ${path.posix.join(templatesRoot, phase.template)}, or use a template that exists${siblings.length && siblings.length <= MAXIMUM_CHOICES ? `: ${sentenceList(siblings)}` : ''}.`,
          ...(near ? { suggestion: near } : {}), ...(siblings.length ? { choices: siblings.slice(0, MAXIMUM_CHOICES) } : {}) });
      }
    }
  }
  return problems.sort((left, right) => (left.line ?? Infinity) - (right.line ?? Infinity)).slice(0, MAXIMUM_PROBLEMS);
}

/** One problem as the lines a terminal shows: where, what, and the fix. */
export function formatConfigurationProblem(problem, { indent = '  ' } = {}) {
  const where = [problem.file, problem.line != null ? `line ${problem.line}` : null].filter(Boolean).join(', ');
  return [
    `${indent}${where ? `${where}: ` : ''}${problem.message}`,
    problem.source ? `${indent}  | ${problem.source.trim()}` : null,
    problem.fix ? `${indent}  Fix: ${problem.fix}` : null
  ].filter(Boolean);
}

/** The whole list, headed by how many there are. */
export function formatConfigurationProblems(problems, { file = WORKFLOW_FILE } = {}) {
  if (!problems.length) return [];
  return [
    problems.length === 1 ? `${file} has 1 problem:` : `${file} has ${problems.length} problems:`,
    ...problems.flatMap(problem => formatConfigurationProblem(problem))
  ];
}
