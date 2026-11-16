#!/usr/bin/env node
/**
 * SPEC-OSA v1.1 Stage 0 inventory: the first count for the AC-020 ratchet (docs/SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md
 * §12.3, plan §2 and §3; docs/osa/decision-inventory.md).
 *
 * Every place outside the future decision owner that reads a step's lifecycle facts or decides a route, found by
 * reading the sources as syntax trees, never by running them (the same method as scripts/sda-inventory.mjs).
 * Per module it counts:
 *   - intentStatus.direct: `.status` read off `….generationIntent` (with or without `?.`);
 *   - intentStatus.aliased: `.status` read off a name bound from `….generationIntent` in an enclosing scope, and a
 *     `status` destructured from it;
 *   - intentWrites: an assignment to `….generationIntent` or one of its fields, an `Object.assign` onto it (or onto a
 *     name bound from it), or a `generationIntent:` property in an object literal (a record built with its intent);
 *   - predicateCalls: calls of the shared lifecycle predicates and the version arithmetic owner (PREDICATES);
 *   - skillChooserCalls: calls of the functions that choose a skill or a turn from a step or a command (CHOOSERS);
 *   - versionArithmetic: `generation ± 1` and `Math.max(…HighWatermark…)` computed in place;
 *   - routeObjects: object literals that carry both a command (`command`, `nextCommand`, `shell`) and a skill
 *     (`skill`, `copilotCommand`, `nextSkill`, `copilot`) where the command is a lifecycle command line or the skill
 *     is a step skill (LIFECYCLE_SKILLS) or chosen by a CHOOSERS call: a step route built in place;
 *   - lifecycleCommands: string and template literals that start a lifecycle command line (`singularity-flow prepare`,
 *     `phase begin|rollover|enter|publish|prepublish|show`, `recover`, `submit`, `approve`, `reject`, `review-source`,
 *     `nextsteps`, `status … --submission-readiness`), by verb;
 *   - skillLiterals: the route skills `/sf-recover`, `/sf-code`, `/sf-phase` and their `/sflow-` spellings, each as an
 *     exact literal, a route literal (the skill then a space and its arguments) or a mention inside other text.
 * Comments are not counted. `role` is the module's role from the decision inventory (ROLES): policy, mapping,
 * renderer, validator or record; every other module is `unclassified` until Stage 1 classifies it.
 *
 * The committed form (benchmarks/osa/inventory.json) has counts per module and no line numbers. Stage 1 turns it into
 * the ratchet: a module's counts may only fall, and approved normalizers, record validators and renderer strings are
 * named exceptions with an owner and a deletion target.
 *
 *   node scripts/osa-inventory.mjs [--json] [--sites] [--output=FILE]
 *
 * --sites keeps every site with its line, for an investigation; the default prints the summary.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source roots read, with the extensions read in each. */
export const ROOTS = Object.freeze([['src', '.mjs'], ['apps/vscode/src', '.ts']]);

/** The shared lifecycle predicates and the one version arithmetic helper (docs/osa/decision-inventory.md §3, §5). */
export const PREDICATES = Object.freeze(['phaseNeedsGeneration', 'successorGenerationOpen', 'stepBeingWritten',
  'hasPublishedPhaseGeneration', 'requiresProspectivePhaseInspection', 'phaseInspectionGeneration', 'phaseExplicitlyReopened',
  'phaseKernelOwned', 'phaseUsesDeterministicGeneration', 'deterministicOnlyGeneration', 'consumedByPublishedGeneration',
  'opensCodeVersion', 'publicationIsRecorded', 'nextPhaseGeneration']);

/** The functions that choose a skill, a command's skill or a turn (decision inventory §2). */
export const CHOOSERS = Object.freeze(['generationSkillForPhase', 'successorSkillForPhase', 'authoringRoute',
  'copilotSkillForCommand', 'skillRouteForCommand', 'skillForCommandLine', 'mutationTurnMode']);

/** The skills a step route can name (a route object naming one is a step route). */
export const LIFECYCLE_SKILLS = Object.freeze(['/sf-code', '/sf-phase', '/sf-recover', '/sf-submit', '/sf-review-source',
  '/sf-publish', '/sf-converge', '/sf-phase-documents', '/sf-next', '/sf-nextsteps', '/sf-resume', '/sf-appeal']);

export const ROUTE_SKILLS = Object.freeze(['/sf-recover', '/sf-code', '/sf-phase', '/sflow-recover', '/sflow-code', '/sflow-phase']);

const LIFECYCLE_VERBS = [
  ['prepare', /^singularity-flow prepare\b/u],
  ['phase begin', /^singularity-flow phase begin\b/u],
  ['phase rollover', /^singularity-flow phase rollover\b/u],
  ['phase enter', /^singularity-flow phase enter\b/u],
  ['phase publish', /^singularity-flow phase publish\b/u],
  ['phase prepublish', /^singularity-flow phase prepublish\b/u],
  ['phase show', /^singularity-flow phase show\b/u],
  ['recover', /^singularity-flow recover\b/u],
  ['submit', /^singularity-flow submit\b/u],
  ['approve', /^singularity-flow approve\b/u],
  ['reject', /^singularity-flow reject\b/u],
  ['review-source', /^singularity-flow review-source\b/u],
  ['nextsteps', /^singularity-flow nextsteps\b/u],
  ['submission-readiness', /^singularity-flow status\b[^\n]*--submission-readiness\b/u]
];

const COMMAND_KEYS = new Set(['command', 'nextCommand', 'shell']);
const SKILL_KEYS = new Set(['skill', 'copilotCommand', 'nextSkill', 'copilot']);

/**
 * Each module's role from docs/osa/decision-inventory.md, where it has one. `policy` decides state, permission or a
 * route; `mapping` maps a command or step to a skill (host adapter material, REQ-021); `renderer` shows a decision
 * made elsewhere; `validator` checks a route or record without choosing it; `record` writes or normalizes records.
 */
export const ROLES = Object.freeze({
  'agent-hooks.mjs': 'policy',
  'amended-drafts.mjs': 'policy',
  'agent-output.mjs': 'policy',
  'changes-after-publication.mjs': 'policy',
  'cli.mjs': 'policy',
  'code-delivery-policy.mjs': 'policy',
  'collaboration.mjs': 'policy',
  'command-skills.mjs': 'mapping',
  'commands/nextsteps.mjs': 'policy',
  'commands/phase-lifecycle.mjs': 'policy',
  'commands/shared/prepared-phase-next-actions.mjs': 'policy',
  'copilot-answer-binding.mjs': 'policy',
  'copilot-guidance.mjs': 'mapping',
  'copilot-mode.mjs': 'policy',
  'copilot-mutation-guard.mjs': 'policy',
  'copilot-review-completion.mjs': 'policy',
  'gate-recovery.mjs': 'policy',
  'generation-boundary.mjs': 'policy',
  'guide.mjs': 'policy',
  'nextsteps.mjs': 'policy',
  'own-correction-rollover.mjs': 'policy',
  'phase-authoring-entry.mjs': 'policy',
  'phase-authoring-progress.mjs': 'policy',
  'phase-authoring-summary.mjs': 'policy',
  'phase-draft-check.mjs': 'policy',
  'phase-entry-admission.mjs': 'policy',
  'phase-entry-authoring.mjs': 'policy',
  'phase-entry-context.mjs': 'policy',
  'phase-entry.mjs': 'policy',
  'phase-generation-need.mjs': 'policy',
  'phase-generation.mjs': 'policy',
  'phase-governance-routing.mjs': 'policy',
  'phase-mutation-contract.mjs': 'policy',
  'phase-prepublish.mjs': 'policy',
  'phase-prompt-composer.mjs': 'policy',
  'phase-resolution.mjs': 'policy',
  'phase-transition-routes.mjs': 'policy',
  'recovery-plan.mjs': 'policy',
  'refusal-remediation.mjs': 'policy',
  'requested-successor.mjs': 'policy',
  'review-continuation.mjs': 'policy',
  'review-subagent.mjs': 'policy',
  'safe-command-guidance.mjs': 'validator',
  'sequence.mjs': 'policy',
  'source-review-continuation.mjs': 'policy',
  'source-review-lifecycle.mjs': 'policy',
  'state.mjs': 'policy',
  'submission-readiness.mjs': 'policy',
  'verification/witness-records.mjs': 'policy',
  'workflow-task-store.mjs': 'record',
  'workflow-task.mjs': 'policy',
  'apps/vscode/src/chat-prefill.ts': 'renderer',
  'apps/vscode/src/views/journey-model.ts': 'renderer',
  'apps/vscode/src/views/submission-presentation.ts': 'renderer',
  'apps/vscode/src/views/tree-model.ts': 'renderer'
});

async function sourceFiles(directory, extension, prefix = '') {
  const found = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await sourceFiles(path.join(directory, entry.name), extension, relative));
    else if (entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts')) found.push(relative);
  }
  return found.sort();
}

const unwrap = (node) => {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression?.(current)
    || ts.isTypeAssertionExpression?.(current))) current = current.expression;
  return current;
};

/** `….generationIntent`, also behind `?? {}` or `|| {}`. */
function isIntentExpression(node) {
  let current = unwrap(node);
  if (current && ts.isBinaryExpression(current) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]
    .includes(current.operatorToken.kind)) current = unwrap(current.left);
  return Boolean(current && ts.isPropertyAccessExpression(current) && current.name.text === 'generationIntent');
}

const isScope = (node) => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isModuleBlock(node)
  || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node);

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, head: true };
  if (ts.isTemplateHead(node)) return { text: node.text, head: true };
  if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return { text: node.text, head: false };
  return null;
}

const skillPattern = (skill) => new RegExp(`(?<![A-Za-z0-9_-])${skill.replace(/\//gu, '\\/')}(?![A-Za-z0-9_-])`, 'u');
const SKILL_PATTERNS = new Map(ROUTE_SKILLS.map((skill) => [skill, skillPattern(skill)]));

function propertyName(node) {
  if (!node.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return null;
}

/** All sites of one module, with their lines. */
export function scanModule(relative, text, kind) {
  const file = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, kind);
  const sites = [];
  const line = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (node, metric, detail = null) => sites.push({ line: line(node), metric, ...(detail ? { detail } : {}) });
  const scopes = [new Map()];
  const declare = (name, intent) => { scopes.at(-1).set(name, intent); };
  const bound = (name) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) if (scopes[index].has(name)) return scopes[index].get(name);
    return false;
  };
  const visit = (node) => {
    const scoped = node !== file && isScope(node);
    if (scoped) scopes.push(new Map());
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) declare(node.name.text, isIntentExpression(node.initializer));
      else if (ts.isObjectBindingPattern(node.name)) {
        const fromIntent = isIntentExpression(node.initializer);
        for (const element of node.name.elements) {
          const key = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
            ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null;
          if (fromIntent && key === 'status') add(element, 'intentStatus.aliased', 'destructured');
          if (ts.isIdentifier(element.name)) declare(element.name.text, key === 'generationIntent');
        }
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) declare(node.name.text, false);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'status') {
      const target = unwrap(node.expression);
      const written = ts.isBinaryExpression(node.parent) && node.parent.left === node
        && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!written && target && ts.isPropertyAccessExpression(target) && target.name.text === 'generationIntent') add(node, 'intentStatus.direct');
      else if (!written && target && ts.isIdentifier(target) && bound(target.text)) add(node, 'intentStatus.aliased', target.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      const owner = left && ts.isPropertyAccessExpression(left) ? unwrap(left.expression) : null;
      if (left && ts.isPropertyAccessExpression(left) && (left.name.text === 'generationIntent'
        || (owner && ts.isPropertyAccessExpression(owner) && owner.name.text === 'generationIntent'))) add(node, 'intentWrites');
    }
    if (ts.isPropertyAssignment(node) && propertyName(node) === 'generationIntent' && ts.isObjectLiteralExpression(node.parent)) {
      add(node, 'intentWrites', 'object literal');
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = callee && ts.isIdentifier(callee) ? callee.text : callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name === 'assign' && callee && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && callee.expression.text === 'Object' && node.arguments[0]) {
        const target = unwrap(node.arguments[0]);
        if (isIntentExpression(target) || (target && ts.isIdentifier(target) && bound(target.text))) add(node, 'intentWrites', 'Object.assign');
      }
      if (name && PREDICATES.includes(name)) add(node, 'predicateCalls', name);
      if (name && CHOOSERS.includes(name)) add(node, 'skillChooserCalls', name);
      if (name === 'max' && callee && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && callee.expression.text === 'Math' && node.arguments.some((argument) => /HighWatermark/u.test(argument.getText(file)))) {
        add(node, 'versionArithmetic', 'max with the high-watermark');
      }
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operatorToken.kind)) {
      const [left, right] = [unwrap(node.left), unwrap(node.right)];
      const one = (side) => side && ts.isNumericLiteral(side) && side.text === '1';
      const versioned = (side) => side && !ts.isStringLiteral(side) && /(?:^|[^A-Za-z])generation\b|Generation\b/u.test(side.getText(file))
        && !/nextPhaseGeneration\s*\(/u.test(side.getText(file)) && !ts.isNumericLiteral(side);
      if ((one(right) && versioned(left)) || (one(left) && versioned(right) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        add(node, 'versionArithmetic', node.operatorToken.kind === ts.SyntaxKind.PlusToken ? '+ 1' : '- 1');
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const values = new Map(node.properties.filter((property) => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
        .map((property) => [propertyName(property), ts.isPropertyAssignment(property) ? property.initializer : property.name]));
      const commands = [...COMMAND_KEYS].filter((key) => values.has(key)).map((key) => values.get(key));
      const skills = [...SKILL_KEYS].filter((key) => values.has(key)).map((key) => values.get(key));
      const lifecycleCommand = commands.some((value) => {
        const head = unwrap(value);
        const text = head && (ts.isStringLiteral(head) || ts.isNoSubstitutionTemplateLiteral(head)) ? head.text
          : head && ts.isTemplateExpression(head) ? head.head.text : null;
        return text !== null && LIFECYCLE_VERBS.some(([, pattern]) => pattern.test(text));
      });
      const stepSkill = skills.some((value) => {
        const head = unwrap(value);
        const text = head && (ts.isStringLiteral(head) || ts.isNoSubstitutionTemplateLiteral(head)) ? head.text
          : head && ts.isTemplateExpression(head) ? head.head.text : null;
        if (text !== null) return LIFECYCLE_SKILLS.some((skill) => text === skill || text.startsWith(`${skill} `)
          || text === skill.replace('/sf-', '/sflow-'));
        const call = head && ts.isCallExpression(head) ? unwrap(head.expression) : null;
        const name = call && ts.isIdentifier(call) ? call.text : call && ts.isPropertyAccessExpression(call) ? call.name.text : null;
        return Boolean(name && CHOOSERS.includes(name));
      });
      if (commands.length && skills.length && (lifecycleCommand || stepSkill)) add(node, 'routeObjects');
    }
    const literal = literalText(node);
    if (literal) {
      if (literal.head) {
        const verb = LIFECYCLE_VERBS.find(([, pattern]) => pattern.test(literal.text));
        if (verb) add(node, 'lifecycleCommands', verb[0]);
      }
      for (const [skill, pattern] of SKILL_PATTERNS) {
        if (literal.head && literal.text === skill) add(node, 'skillLiterals', `${skill} exact`);
        else if (literal.head && literal.text.startsWith(`${skill} `)) add(node, 'skillLiterals', `${skill} route`);
        else if (pattern.test(literal.text)) add(node, 'skillLiterals', `${skill} text`);
      }
    }
    ts.forEachChild(node, visit);
    if (scoped) scopes.pop();
  };
  visit(file);
  return sites;
}

/** Counts per module from its sites; zero counts are left out. */
export function moduleCounts(module, sites) {
  const entry = { module, role: ROLES[module] ?? 'unclassified' };
  const bump = (object, key) => { object[key] = (object[key] ?? 0) + 1; };
  for (const site of sites) {
    if (site.metric === 'intentStatus.direct' || site.metric === 'intentStatus.aliased') {
      bump(entry.intentStatus ??= {}, site.metric.split('.')[1]);
    } else if (['predicateCalls', 'skillChooserCalls', 'lifecycleCommands'].includes(site.metric)) {
      bump(entry[site.metric] ??= {}, site.detail);
    } else if (site.metric === 'skillLiterals') {
      const [skill, form] = site.detail.split(' ');
      bump((entry.skillLiterals ??= {})[skill] ??= {}, form);
    } else entry[site.metric] = (entry[site.metric] ?? 0) + 1;
  }
  return entry;
}

export async function scanSources(root = packageRoot) {
  const modules = [];
  for (const [base, extension] of ROOTS) {
    for (const relative of await sourceFiles(path.join(root, base), extension)) {
      const text = await readFile(path.join(root, base, relative), 'utf8');
      const name = base === 'src' ? relative : `${base}/${relative}`;
      const sites = scanModule(name, text, extension === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
      if (sites.length) modules.push({ ...moduleCounts(name, sites), sites });
    }
  }
  return modules;
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const nested = (modules, key) => {
  const totals = {};
  for (const entry of modules) for (const [name, count] of Object.entries(entry[key] ?? {})) totals[name] = (totals[name] ?? 0) + count;
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)));
};

export function summarize(modules) {
  const skills = {};
  for (const entry of modules) {
    for (const [skill, forms] of Object.entries(entry.skillLiterals ?? {})) {
      const bucket = skills[skill] ??= { modules: 0, exact: 0, route: 0, text: 0 };
      bucket.modules += 1;
      for (const [form, count] of Object.entries(forms)) bucket[form] += count;
    }
  }
  const withIntent = modules.filter((entry) => entry.intentStatus);
  return {
    intentStatus: { modules: withIntent.length, direct: sum(withIntent.map((entry) => entry.intentStatus.direct ?? 0)),
      aliased: sum(withIntent.map((entry) => entry.intentStatus.aliased ?? 0)) },
    intentWrites: { modules: modules.filter((entry) => entry.intentWrites).length, sites: sum(modules.map((entry) => entry.intentWrites ?? 0)) },
    predicateCalls: nested(modules, 'predicateCalls'),
    skillChooserCalls: nested(modules, 'skillChooserCalls'),
    versionArithmetic: { modules: modules.filter((entry) => entry.versionArithmetic).length, sites: sum(modules.map((entry) => entry.versionArithmetic ?? 0)) },
    routeObjects: { modules: modules.filter((entry) => entry.routeObjects).length, sites: sum(modules.map((entry) => entry.routeObjects ?? 0)) },
    lifecycleCommands: nested(modules, 'lifecycleCommands'),
    skillLiterals: Object.fromEntries(Object.entries(skills).sort(([a], [b]) => a.localeCompare(b))),
    roles: Object.fromEntries(['policy', 'mapping', 'renderer', 'validator', 'record', 'unclassified']
      .map((role) => [role, modules.filter((entry) => entry.role === role).length]))
  };
}

/** The committed form: counts per module, no line numbers. */
export function baseline(modules) {
  return { schemaVersion: 1, specification: 'SPEC-OSA v1.1 Stage 0 inventory (AC-020 baseline)',
    roots: ROOTS.map(([base]) => base), summary: summarize(modules),
    modules: modules.map(({ sites, ...entry }) => entry) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modules = await scanSources();
  const report = process.argv.includes('--sites')
    ? { schemaVersion: 1, specification: 'SPEC-OSA v1.1 Stage 0 inventory (AC-020 baseline)', summary: summarize(modules), modules }
    : baseline(modules);
  const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length);
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report.summary, null, 2));
}
