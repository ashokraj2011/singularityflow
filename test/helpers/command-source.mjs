/**
 * The command layer's source, wherever it currently lives.
 *
 * Several guards assert that a computation is *reached from a command* rather than merely exported —
 * the defect they exist to catch is a function that is written, tested and never called. They did
 * that by reading `src/cli.mjs` and matching the call site in its text.
 *
 * That worked while every handler lived in one file. Splitting the dispatcher into services under
 * `src/commands/` moved the call sites, and each guard failed with a message claiming the wiring had
 * been removed — which was untrue, and is the worst thing a guard can say, because the next person
 * to see it will loosen the assertion.
 *
 * So they read the router and its services together. A handler moving between them is a refactor;
 * the guard only fires when the call site genuinely disappears.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Strip comments so a guard cannot be satisfied by a mention in prose. */
export function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * `cli.mjs` plus every service under `src/commands/`, concatenated with a marker between them so a
 * slice taken between two function names cannot silently run past the end of one file into another.
 */
export async function commandLayerSource({ comments = true } = {}) {
  const files = ['cli.mjs', ...(await readdir(path.join(SRC, 'commands')))
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => path.join('commands', name))];
  const parts = [];
  for (const file of files) {
    const text = await readFile(path.join(SRC, file), 'utf8');
    parts.push(`\n/* ==== ${file} ==== */\n${comments ? text : withoutComments(text)}`);
  }
  return parts.join('\n');
}

/**
 * One function's body, found in whichever file defines it.
 *
 * Takes the function's own text rather than a slice between two names: the old
 * `slice(indexOf(a), indexOf(b))` idiom silently returned the rest of the file when the second name
 * moved, so a guard could pass by matching something in an unrelated command.
 */
export async function commandFunction(name) {
  const source = withoutComments(await commandLayerSource());
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\s*\\(`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined anywhere in the command layer.`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const open = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(open, index + 1);
}
