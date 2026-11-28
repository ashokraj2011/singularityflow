#!/usr/bin/env node
/**
 * Typed-value checks: every place a person must type an exact value, or tick a box after reviewing, before SFlow goes on
 * [owner, 2026-11-28: "No typed values and no second confirmations"]. A Yes bound to what the person saw (a button that
 * carries the reviewed value, a modal that names what happens) replaces each; this counts what is left.
 *
 * Read from the sources only, never by running a command. Kinds:
 *   terminal-typed   the CLI asks the person to type an exact value at a prompt (confirmExact, "Type X to …", "Paste the exact …")
 *   vscode-typed-box a VS Code input box that accepts only one exact value
 *   vscode-typed-page a VS Code confirmation page that asks for an exact typed value (askConfirmation, `expected` beside `confirmLabel`),
 *                    while the shared page (review-confirmation-page.ts) still has a box to type in
 *   vscode-checkbox  a VS Code confirmation page with an "I reviewed this" box to tick before its button (each caller, while the page has one)
 *   chat-typed       a skill line telling the person to type an exact value in chat (a Work ID, an initiative ID)
 * A `--confirm <digest>` flag a route fills in is not counted: the person never types it, and it binds the Yes to what was reviewed.
 *
 *   node scripts/typed-value-checks.mjs [--json] [--list]
 *
 * test/typed-value-checks.test.mjs pins the counts: a new typed check fails it, and a removed one lowers the pin.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = Object.freeze(['terminal-typed', 'vscode-typed-box', 'vscode-typed-page', 'vscode-checkbox', 'chat-typed']);

async function files(directory, test) {
  const found = [];
  const walk = async (dir) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') await walk(full); }
      else if (test(full)) found.push(full);
    }
  };
  await walk(directory);
  return found.sort();
}

// A prompt of its own that asks for a typed value; the typed helpers' own prompts (`${prompt}\nType …`) count at each call instead.
const TERMINAL_PROMPT = /\.question\(\s*[`'"](?!\$\{prompt\})[^\n]*\b(?:Type\b|Paste the exact)/u;
const CONFIRM_EXACT_CALL = /(?<!function\s)\bconfirmExact\(/u;
const INITIATIVE_EXACT_CALL = /(?<!function\s)\bconfirmInitiativeExact\(/u;
// `value === subject ? null : …`, `value !== expected`, `value === plan.confirmation`: one exact value, not a rule.
const EXACT_BOX = /validateInput:[^\n]*\bvalue\s*[!=]==\s*(?!['"`])[A-Za-z_$][\w$.()]*/u;
const CHAT_TYPED = /\btype the (?:Work ID|exact [a-z ]*ID)\b|\bType [^.\n]{1,40} exactly\b/iu;

/** Every typed-value check in the checkout at `root`: { total, kinds, sites }. */
export async function typedValueChecks(root = ROOT) {
  const sites = [];
  const add = (kind, file, line, text) => sites.push({ kind, file: path.relative(root, file), line, text: text.trim().slice(0, 160) });
  for (const file of await files(path.join(root, 'src'), (name) => name.endsWith('.mjs'))) {
    const source = await readFile(file, 'utf8');
    // An Initiative's confirmation is typed only while its helper asks the person to type the ID at the prompt.
    const initiativeTyped = /async function confirmInitiativeExact[\s\S]{0,900}?Type \$\{expected\}/u.test(source);
    source.split('\n').forEach((text, index) => {
      if (CONFIRM_EXACT_CALL.test(text) || TERMINAL_PROMPT.test(text) || (initiativeTyped && INITIATIVE_EXACT_CALL.test(text))) add('terminal-typed', file, index + 1, text);
    });
  }
  const vscode = path.join(root, 'apps', 'vscode', 'src');
  const page = await readFile(path.join(vscode, 'views', 'review-confirmation-page.ts'), 'utf8').catch(() => '');
  // The shared confirmation page: each caller counts while the page asks to type a value or tick a box.
  const typedPage = /data-confirmation/u.test(page);
  const checkbox = /data-acknowledged/u.test(page);
  for (const file of await files(vscode, (name) => name.endsWith('.ts'))) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      if (EXACT_BOX.test(text)) add('vscode-typed-box', file, index + 1, text);
      if (typedPage && /(?<!function\s)\baskConfirmation\(/u.test(text)) add('vscode-typed-page', file, index + 1, text);
      else if (typedPage && /(?:^|[\s,{])expected:\s/u.test(text) && lines.slice(Math.max(0, index - 4), index + 5).some((near) => /\bconfirmLabel\b/u.test(near))) {
        add('vscode-typed-page', file, index + 1, text);
      }
      if (checkbox && /(?<!function\s)\bcollectReviewConfirmation\(/u.test(text) && !/^\s*(?:export|import)\b/u.test(text)) add('vscode-checkbox', file, index + 1, text);
    });
  }
  for (const file of await files(path.join(root, 'plugin', 'skills'), (name) => name.endsWith('SKILL.md'))) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, index) => { if (CHAT_TYPED.test(text)) add('chat-typed', file, index + 1, text); });
  }
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, sites.filter((site) => site.kind === kind).length]));
  return { total: sites.length, kinds, sites };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await typedValueChecks(ROOT);
  if (process.argv.includes('--json')) console.log(JSON.stringify(process.argv.includes('--list') ? result : { total: result.total, kinds: result.kinds }, null, 2));
  else {
    console.log(`Typed-value checks: ${result.total}`);
    for (const kind of KINDS) console.log(`  ${kind}: ${result.kinds[kind]}`);
    if (process.argv.includes('--list')) for (const site of result.sites) console.log(`${site.kind}\t${site.file}:${site.line}\t${site.text}`);
  }
}
