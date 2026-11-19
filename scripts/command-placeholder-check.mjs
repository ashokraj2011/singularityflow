#!/usr/bin/env node
/**
 * Command placeholders: a person never composes a command [owner, 2026-11-19].
 *
 * "It is very difficult to understand all the commands and options in singularity." Every refusal and
 * next action gives a complete command, or names the screen that does it; only the person's own words
 * (a reason, an answer, a title) may stay open. This reads, as syntax trees and never by running a
 * command, every route a person is handed: each text that is a command (`singularity-flow …`, `sflow …`,
 * a Copilot `/sf-…` route) and each printed "Run:" or "Next:" line, wherever it is built (refusal plans,
 * next actions, act.do, nextAction details, CLI output, VS Code views). It also builds every known
 * refusal's plan and reads the commands it returns. A route that leaves `<UPPER>` or `<lower>` to fill
 * in, other than the person's own words (PERSON_WORDS), is a violation.
 *
 * Help and usage text are not routes: src/help-text.mjs, src/help-pages.mjs and "Usage:"/"Use:" lines.
 * Violations found today are the committed baseline (BASELINE_PATH), which may only shrink:
 * test/command-placeholder-ratchet.test.mjs fails on a new one, and on a fixed one until the baseline
 * is regenerated. TEMPORARY names the audit entries another branch fixes, each with its number.
 *
 *   node scripts/command-placeholder-check.mjs [--list] [--update]
 *
 * --list prints every violation with its file and line; --update rewrites the baseline from the sources.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { render } from './plain-language-check.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = 'benchmarks/command-placeholders/baseline.json';

/**
 * What a person writes in their own words, and so may stay open in a route. The six the owner named
 * (2026-11-19), and a placeholder that reads as a sentence (it has a space: "<why the exception is
 * renewed>"), which asks for the same thing in more words. Each other one says why it is theirs.
 */
export const PERSON_WORDS = Object.freeze({
  '<REASON>': 'their reason', '<ANSWER>': 'their answer', '<TITLE>': 'their title', '<NOTE>': 'their note',
  '<why>': 'their reason', '<reason>': 'their reason',
  '<NEW-WORK-ID>': 'the ID a person gives a new Story (their tracker\'s key): nothing names it before they do',
  '<what-is-wrong>': 'the problem as the person who raises it describes it (upstream-routes.mjs raiseUpstreamIssueRoute)',
  '<REQUIREMENT>': 'the requirement as the person states it, which a plan is made from (auto plan)'
});
export const isPersonWords = (placeholder) => Object.hasOwn(PERSON_WORDS, placeholder) || /\s/u.test(placeholder.slice(1, -1).trim());

/**
 * TEMPORARY: the audit entries (scratchpad compose-audit.md, 2026-11-19) that branch departure-row-choice fixes.
 * Each names its entry, its file and words of the route; it is removed when the branches merge. An entry that
 * matches no route fails the test, so this list empties as they land.
 */
export const TEMPORARY = Object.freeze([
  { entry: 2, file: 'src/decision-list.mjs', includes: 'departure account' },
  { entry: 5, file: 'src/state.mjs', includes: '--add-location <clause>=' },
  { entry: 5, file: 'src/phase-resolution.mjs', includes: '--add-location <clause>=' },
  { entry: 6, file: 'src/decision-list.mjs', includes: '--add-location <clause>=' },
  { entry: 21, file: 'src/phase-resolution.mjs', includes: 'appeal evidence-prepare' }
].map(Object.freeze));

const SKIP_DIRECTORIES = new Set(['node_modules', 'generated', 'dist', 'out', '.git']);
const HELP = /^src\/help-(?:text|pages)\.mjs$/u;
const PLACEHOLDER = /<[A-Za-z][^<>\n]{0,80}>/gu;
// A text that is a command, at the start of a line or after a printed "Run:"/"Next:".
const COMMAND_AT = /(?:^|\b(?:Run|Next):\s*)(`?)((?:singularity-flow|sflow)\s+\S.*|\/sf-[a-z0-9-]+(?:\s.*)?)$/u;

async function filesUnder(root, relative, extension) {
  const found = [];
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) await walk(child); }
      else if (entry.name.endsWith(extension)) found.push(child);
    }
  };
  await walk(relative);
  return found;
}

/** The placeholders a route leaves to fill in that are not the person's own words. */
export function openPlaceholders(text) {
  return [...new Set(String(text).match(PLACEHOLDER) ?? [])].filter((placeholder) => !isPersonWords(placeholder));
}

/** The route in one line of text, from its command to the line's end (or its closing backtick), or null. */
export function routeIn(line) {
  const trimmed = line.trim();
  if (/^(?:Usage|Use):/u.test(trimmed)) return null;
  const match = COMMAND_AT.exec(trimmed.replace(/^(?:[-*]\s+|\d+\.\s+)/u, ''));
  if (!match) return null;
  return match[1] ? match[2].split('`')[0] : match[2];
}

const insideTemplate = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTemplateSpan(current) || ts.isTemplateExpression(current)) return true;
    if (ts.isBlock(current) || ts.isSourceFile(current)) return false;
  }
  return false;
};

/** The placeholder literals a slot holds (`${id ?? '<WORK-ID>'}`, `shellWord(path ?? '<FILE>')`): text a route can end up with. */
function slotPlaceholders(node) {
  const found = [];
  const walk = (child) => {
    if (ts.isStringLiteralLike(child) && /^<[A-Za-z][^<>\n]{0,80}>$/u.test(child.text.trim())) found.push(child.text.trim());
    ts.forEachChild(child, walk);
  };
  if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) walk(span.expression);
  return found;
}

/** An argv array a route is built from (`['decision', 'test-risk', id, '--cause', '<cause>']`): its words, slots as `{}`. */
function argvRoute(node) {
  const words = node.elements.map((element) => (ts.isStringLiteralLike(element) ? element.text : ts.isSpreadElement(element) ? '{…}' : '{}'));
  const literal = node.elements.filter((element) => ts.isStringLiteralLike(element)).map((element) => element.text);
  if (!literal.some((word) => /^--[a-z]/u.test(word)) || !literal.some((word) => PLACEHOLDER.test(word))) return null;
  PLACEHOLDER.lastIndex = 0;
  return words.join(' ');
}

/** Every route a source file's literals hold, `{ file, line, route }`, slots as `{name}`. */
export function routesOfSource(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const routes = [];
  const seen = new Set();
  const add = (node, route) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const key = `${line}\u0000${route}`;
    if (route && !seen.has(key)) { seen.add(key); routes.push({ file, line, route: route.trim() }); }
  };
  const visit = (node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && !insideTemplate(node)
        && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
      const { text, variants } = render(node, sourceFile);
      const held = slotPlaceholders(node);
      for (const value of [text, ...variants]) {
        for (const part of value.split('\n')) {
          const route = routeIn(part);
          const missing = held.filter((placeholder) => !route?.includes(placeholder));
          if (route) add(node, `${route}${missing.length ? ` ${missing.join(' ')}` : ''}`);
        }
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      const route = argvRoute(node);
      if (route) add(node, `[argv] ${route}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

/** Every route in the product's sources. */
export async function collectSourceRoutes(root = ROOT) {
  const files = [...await filesUnder(root, 'src', '.mjs'), ...await filesUnder(root, 'apps/vscode/src', '.ts')].filter((file) => !HELP.test(file));
  const routes = [];
  for (const file of files) routes.push(...routesOfSource(file, await readFile(path.join(root, file), 'utf8')));
  return routes;
}

/**
 * Every known refusal's plan, built as the dead-end check builds it (test/no-dead-end.test.mjs), and the commands
 * its steps hand a person: `{ code, route }`. A route a plan assembles from parts is read here.
 */
export async function collectPlanRoutes(root = ROOT) {
  const { KNOWN_REFUSAL_CODES, refusalRemediationPlan } = await import(pathToFileURL(path.join(root, 'src/refusal-remediation.mjs')).href);
  const details = { workId: 'W-1', phase: 'build', phaseId: 'build', currentPhase: 'build', documentId: 'DOC-001', decidableStep: 'plan',
    issue: 'UPI-001', workType: 'feature', upstreamPhases: ['plan'], producerPhase: 'plan', restorable: true, paths: ['a.txt'],
    errors: ['x'], authorities: ['product'], capabilityId: 'web-app', storyId: 'W-1', expectedWorkId: 'W-1' };
  const routes = [];
  for (const code of KNOWN_REFUSAL_CODES) {
    for (const argv of [['phase', 'prepublish', 'build', '--work-id', 'W-1'], []]) {
      let plan;
      try { plan = refusalRemediationPlan(Object.assign(new Error('refused'), { code, details }), argv); } catch { continue; }
      for (const step of plan.steps ?? []) {
        for (const route of [step.command, step.copilotCommand]) if (typeof route === 'string') routes.push({ code, route });
      }
    }
  }
  return routes;
}

const normalized = (route) => route.replace(/\{[^}]*\}/gu, '{}').replace(/\s+/gu, ' ').trim();
export const temporaryFor = (entry) => TEMPORARY.find((item) => item.file === entry.file && entry.route.includes(item.includes)) ?? null;

/** Every route that leaves something other than the person's words open: `{ sources, plans, temporary, unusedTemporary }`. */
export async function scan(root = ROOT) {
  const sourceRoutes = await collectSourceRoutes(root);
  const planRoutes = await collectPlanRoutes(root);
  const used = new Set();
  const sources = [];
  for (const entry of sourceRoutes) {
    const open = openPlaceholders(entry.route);
    if (!open.length) continue;
    const temporary = temporaryFor(entry);
    if (temporary) { used.add(temporary); continue; }
    sources.push({ ...entry, open, key: normalized(entry.route) });
  }
  const plans = planRoutes.map((entry) => ({ ...entry, open: openPlaceholders(entry.route) }))
    .filter((entry) => entry.open.length && !TEMPORARY.some((item) => item.file === 'src/refusal-remediation.mjs' && entry.route.includes(item.includes)))
    .map((entry) => ({ ...entry, key: normalized(entry.route) }));
  for (const item of TEMPORARY) {
    if (item.file === 'src/refusal-remediation.mjs' && planRoutes.some((entry) => entry.route.includes(item.includes))) used.add(item);
  }
  return { routeCount: sourceRoutes.length, planRouteCount: planRoutes.length, sources, plans,
    unusedTemporary: TEMPORARY.filter((item) => !used.has(item)) };
}

/** The committed form: per file the routes' words (slots as `{}`), per refusal code the plan's commands. */
export function baselineOf({ sources, plans }) {
  const files = {};
  for (const entry of sources) (files[entry.file] ??= new Set()).add(entry.key);
  const codes = {};
  for (const entry of plans) (codes[entry.code] ??= new Set()).add(entry.key);
  const sorted = (object) => Object.fromEntries(Object.keys(object).sort().map((key) => [key, [...object[key]].sort()]));
  return { revision: 1, sources: sorted(files), plans: sorted(codes) };
}

/** What is new against the committed baseline, and what is no longer there. */
export function compare(committed, current) {
  const rose = [];
  const fell = [];
  for (const section of ['sources', 'plans']) {
    const before = committed?.[section] ?? {};
    const now = current[section];
    for (const [owner, keys] of Object.entries(now)) for (const key of keys) if (!(before[owner] ?? []).includes(key)) rose.push(`${owner}: ${key}`);
    for (const [owner, keys] of Object.entries(before)) for (const key of keys) if (!(now[owner] ?? []).includes(key)) fell.push(`${owner}: ${key}`);
  }
  return { rose, fell };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = new Set(process.argv.slice(2));
  const result = await scan(ROOT);
  if (args.has('--list')) {
    for (const entry of result.sources) console.log(`${entry.file}:${entry.line}\t${entry.open.join(' ')}\t${entry.route}`);
    for (const entry of result.plans) console.log(`plan ${entry.code}\t${entry.open.join(' ')}\t${entry.route}`);
  }
  if (args.has('--update')) {
    await mkdir(path.join(ROOT, path.dirname(BASELINE_PATH)), { recursive: true });
    await writeFile(path.join(ROOT, BASELINE_PATH), `${JSON.stringify(baselineOf(result), null, 2)}\n`);
  }
  console.log(`${result.routeCount} routes read, ${result.planRouteCount} plan routes; ${result.sources.length} source and ${result.plans.length} plan routes leave a placeholder open`
    + `${result.unusedTemporary.length ? `; TEMPORARY entries matching nothing: ${result.unusedTemporary.map((item) => item.entry).join(', ')}` : ''}.`);
}
