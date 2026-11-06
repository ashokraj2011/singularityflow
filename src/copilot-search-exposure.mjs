/**
 * A search can show a secret without naming its file (docs/SPEC-ENVIRONMENT-FILES-v2.md, "Searches"):
 * `grep -rn password .` prints the line that holds it. A search is refused only when what it looks for
 * would match a line holding a real value, in a file it would read, and the refusal says how to search
 * without that file. A search that shows only file names or counts shows no value.
 *
 * Only a pattern with a credential word comes here (CREDENTIAL_WORD in the guard), which is also what the launchers'
 * no-Node test looks for, so a pattern as broad as `.` is not seen. Nor is a folder this walk skips.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { alwaysLocalName, configShapedPath } from './local-config-policy.mjs';

const MAXIMUM_ENTRIES = 20_000;
const MAXIMUM_BYTES = 262_144;
const SKIPPED = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', 'vendor', '.venv', 'venv', '__pycache__', '.gradle', '.idea', 'coverage', '.next', '.sflow', '.singularity-flow']);
const quoteless = (word) => word.replace(/^['"]|['"]$/gu, '');

// Options that take the next word as their value, for each kind of search.
const GREP_VALUES = new Set(['-A', '-B', '-C', '-m', '-d', '-D', '--context', '--after-context', '--before-context', '--max-count', '--color', '--colour', '--binary-files', '--label', '--directories', '--devices']);
const RG_VALUES = new Set(['-A', '-B', '-C', '-m', '-t', '-T', '-r', '-j', '-M', '--context', '--after-context', '--before-context', '--max-count', '--type', '--type-not', '--replace', '--threads', '--max-depth', '--max-filesize', '--max-columns', '--color', '--colors', '--sort', '--sortr', '--engine', '--encoding']);
const LISTS_ONLY = new Set(['--files-with-matches', '--files-without-match', '--count', '--count-matches', '--quiet', '--silent', '--files', '--name-only', '--name-status']);
const READS_HIDDEN = new Set(['--hidden', '--no-ignore', '--unrestricted', '--no-exclude-standard', '--untracked']);

function shellSearch(simple, piped, cwd) {
  const words = simple.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  let at = words.findIndex((word) => !/^[A-Za-z_]\w*=/u.test(word));
  if (at < 0) return null;
  let verb = quoteless(words[at]).split('/').at(-1);
  if (verb === 'git') { if (words[at + 1] !== 'grep') return null; at += 1; }
  else if (!['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'].includes(verb)) return null;
  const git = verb === 'git';
  const grep = ['grep', 'egrep', 'fgrep'].includes(verb);
  const valued = grep ? GREP_VALUES : RG_VALUES;
  const search = { pattern: null, anything: false, literal: verb === 'fgrep', roots: [], includes: [], excludes: [], readsHidden: grep };
  let recursive = !grep;
  let listsOnly = false;
  let operands = false;
  for (let index = at + 1; index < words.length; index += 1) {
    const word = quoteless(words[index]);
    if (operands || !word.startsWith('-') || word === '-') {
      if (word.startsWith(':!') || word.startsWith(':(exclude)')) search.excludes.push(word.replace(/^:(?:!|\(exclude\))/u, ''));
      else if (search.pattern === null && !search.anything) search.pattern = word;
      else search.roots.push(word);
      continue;
    }
    if (word === '--') { operands = true; continue; }
    const [name, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, null];
    const value = () => inline ?? quoteless(words[(index += 1)] ?? '');
    if (['--include', '-g', '--glob', '--iglob'].includes(name)) {
      const glob = value();
      (glob.startsWith('!') ? search.excludes : search.includes).push(glob.replace(/^!/u, ''));
    } else if (name === '--exclude') search.excludes.push(value());
    else if (name === '--exclude-dir') search.excludes.push(`**/${value()}/**`);
    else if (name === '-e' || name === '--regexp') search.pattern = value();
    else if (name === '-f' || name === '--file') { value(); search.anything = true; }
    else if (name === '-d' || name === '--directories') { if (value() === 'recurse') recursive = true; }
    else if (valued.has(name)) { if (inline === null) index += 1; }
    else if (name === '--recursive' || name === '--dereference-recursive') recursive = true;
    else if (name === '--fixed-strings') search.literal = true;
    else if (LISTS_ONLY.has(name)) listsOnly = true;
    else if (READS_HIDDEN.has(name)) search.readsHidden = true;
    else if (!word.startsWith('--')) {
      // A cluster: -rnI, or -A3 and -m5, whose letters are a value.
      for (const [position, letter] of [...word.slice(1)].entries()) {
        if (/[ABCmdDtTrjM]/u.test(letter) && !(grep && letter === 'r') && word.length > position + 2) break;
        if (grep && (letter === 'r' || letter === 'R')) recursive = true;
        else if (letter === 'l' || letter === 'L' || letter === 'c' || letter === 'q') listsOnly = true;
        else if (letter === 'F') search.literal = true;
        else if (!grep && letter === 'u') search.readsHidden = true;
        else if (letter === 'e') { search.pattern = word.slice(position + 2) || quoteless(words[(index += 1)] ?? ''); break; }
        else if (letter === 'f') { if (!word.slice(position + 2)) index += 1; search.anything = true; break; }
      }
    }
  }
  if (listsOnly || !recursive || (search.pattern === null && !search.anything)) return null;
  if (!search.roots.length && piped) return null;
  if (git) search.roots = search.roots.filter((root) => { try { return Boolean(statSync(path.resolve(cwd || process.cwd(), root))); } catch { return false; } });
  if (!search.roots.length) search.roots = ['.'];
  return search;
}

// A line's commands, and whether each reads a pipe. A `|` inside quotes is a pattern's.
function simpleCommands(command) {
  const commands = [];
  let current = '';
  let quote = null;
  let piped = false;
  const end = (next) => { commands.push({ simple: current.trim(), piped }); current = ''; piped = next; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) { if (character === quote) quote = null; current += character; continue; }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') { end(false); index += 1; }
    else if (character === ';' || character === '\n') end(false);
    else if (character === '|') end(true);
    else current += character;
  }
  end(false);
  return commands;
}

/** The searches a shell line runs that could print file contents. */
export function searchesInCommand(command, cwd) {
  return simpleCommands(command).map(({ simple, piped }) => shellSearch(simple, piped, cwd)).filter(Boolean);
}

/** What a search tool's call looks for, or null when it shows only names and counts. */
export function searchOfTool(name, args) {
  if (!['grep', 'rg', 'grep_search'].includes(name)) return null;
  const pattern = args.pattern ?? args.query ?? args.regex;
  if (typeof pattern !== 'string' || !pattern) return null;
  if (['files_with_matches', 'count'].includes(args.output_mode ?? args.outputMode)) return null;
  const strings = (...values) => values.flat().filter((value) => typeof value === 'string' && value);
  const roots = strings(args.path, args.paths);
  return { pattern, anything: false, literal: args.isRegexp === false || args.fixed_strings === true, roots: roots.length ? roots : ['.'],
    includes: strings(args.glob, args.include, args.includePattern), excludes: strings(args.exclude, args.excludePattern),
    readsHidden: name === 'grep_search' || args.hidden === true };
}

function lineMatcher({ pattern, anything, literal }) {
  if (anything) return () => true;
  const fixed = (line) => line.toLowerCase().includes(pattern.toLowerCase());
  if (literal) return fixed;
  try { const regex = new RegExp(pattern.replaceAll('\\|', '|'), 'iu'); return (line) => regex.test(line); }
  catch { return fixed; }
}

function globMatcher(glob) {
  const body = glob.replace(/[.+^$()|\\]/gu, '\\$&').replace(/\{([^}]*)\}/gu, (_, list) => `(?:${list.split(',').join('|')})`)
    .replaceAll('**/', '\u0000').replaceAll('**', '\u0001').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replaceAll('\u0000', '(?:.*/)?').replaceAll('\u0001', '.*');
  try { return new RegExp(`^${body}$`, 'u'); } catch { return null; }
}

// A glob matches a file by its name or its path below the search's root. One that cannot be read selects the file, so the file is judged.
function selected({ includes, excludes }, file, root) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const hits = (glob) => { const regex = globMatcher(glob); return regex ? regex.test(path.basename(file)) || regex.test(relative) || regex.test(`${relative}/`) : null; };
  if (excludes.some((glob) => hits(glob) === true)) return false;
  return !includes.length || includes.some((glob) => hits(glob) !== false);
}

function* filesUnder(root, budget) {
  let info;
  try { info = statSync(root); } catch { return; }
  if (info.isFile()) { yield root; return; }
  const stack = [root];
  while (stack.length && budget.entries > 0) {
    let entries;
    try { entries = readdirSync(stack.pop(), { withFileTypes: true, encoding: 'utf8' }); } catch { continue; }
    for (const entry of entries) {
      budget.entries -= 1;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED.has(entry.name)) stack.push(full); } else if (entry.isFile()) yield full;
    }
  }
}

function linesOf(file) {
  try { return statSync(file).size > MAXIMUM_BYTES ? [] : readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

/**
 * The first file `search` would show a secret from, as `{ file, finding }` or `{ file, named: true }`, or
 * null. `judge.covers` and `judge.allows` are the caller's scope; `judge.privateByName` says a file stays on
 * this laptop whatever it holds, and `judge.heldValue` finds the real values in a shared config file.
 */
export async function secretShownBySearch(search, cwd, judge) {
  const matches = lineMatcher(search);
  const budget = { entries: MAXIMUM_ENTRIES };
  for (const given of search.roots) {
    const root = path.resolve(cwd || process.cwd(), given);
    for (const file of filesUnder(root, budget)) {
      const name = path.basename(file);
      const declared = judge.declared?.(file) ?? false;
      if (!declared && !alwaysLocalName(name) && !configShapedPath(name)) continue;
      if (!selected(search, file, root) || !judge.covers(file, cwd)) continue;
      if (declared || await judge.privateByName(file, cwd)) {
        if (!search.readsHidden && name.startsWith('.')) continue;
        if (linesOf(file).some(matches) && !await judge.allows(file, cwd)) return { file, named: true };
        continue;
      }
      const held = await judge.heldValue(file, cwd);
      const finding = held?.findings.find((entry) => matches(held.lines[entry.line - 1] ?? ''));
      if (finding && !await judge.allows(file, cwd)) return { file, finding };
    }
  }
  return null;
}
