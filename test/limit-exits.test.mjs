/**
 * Every limit has an exit [owner, 2026-11-20; limit audit §6]: a budget, cap, size, expiry, timeout or retry limit leaves a
 * next step that changes something, never only the same command on unchanged input and never nothing.
 *
 * The ratchet, from test/helpers/limit-table.mjs:
 *   1. every limit-like code in src/ is routed, a row, in a group off the Story's path, or not a limit, each with its reason;
 *      every row's anchor still exists in its file;
 *   2. a limit thrown with no code (no plan can route it) stays at its reviewed count per module, and only shrinks;
 *   3. every limit route's plan has an exit: the person's change in words, a command that changes something, or the same
 *      command again only with the change it waits for; never a rejected command, never the refused command unchanged;
 *   4. the kernel's repair budget is its own: a request's continuations never spend it (owner decision 2);
 *   5. a kept result older than the call it answers is never that call's;
 *   6. every high- or medium-reach row is walked by a test that still says so;
 *   7. a wait (a timeout of the machine or a remote, a run that holds it) is retried once it answers, never told that
 *      unchanged input meets it again; a real limit keeps those words.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KNOWN_REFUSAL_CODES, refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { LIMIT_RETRY_LABEL, LIMIT_ROUTE_CODES, WAIT_ROUTE_CODES, waitRetryLabel } from '../src/limit-remediation.mjs';
import { COVERAGE_REACH, GROUPS, LIMITS, NOT_LIMITS } from './helpers/limit-table.mjs';
import { registryReader, routeEffect } from './helpers/route-walker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT_CODE = /(?:EXHAUST|LIMIT|BUDGET|EXPIRE|EXCEED|QUOTA|CEILING|TOO_LARGE|TOO_LONG|TIMEOUT|TIMED_OUT|_MAX\b|MAXIMUM)/u;

function sourceFiles(directory = path.join(ROOT, 'src')) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) found.push(...sourceFiles(file));
    else if (name.endsWith('.mjs')) found.push(file);
  }
  return found;
}

/** Every quoted code in src/ that names a limit, with the modules that name it. Environment variable names are settings. */
function limitCodes() {
  const codes = new Map();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/gu)) {
      const code = match[1];
      if (!LIMIT_CODE.test(code) || code.startsWith('SINGULARITY_FLOW_')) continue;
      if (!codes.has(code)) codes.set(code, new Set());
      codes.get(code).add(path.relative(ROOT, file));
    }
  }
  return codes;
}

test('every limit code in src/ is routed, a row, off the Story\'s path, or not a limit, each with its reason', () => {
  const routed = new Set([...KNOWN_REFUSAL_CODES, ...LIMIT_ROUTE_CODES, ...LIMITS.map((row) => row.code)]);
  const found = limitCodes();
  const unclassified = [...found.keys()].filter((code) => !routed.has(code) && !Object.hasOwn(NOT_LIMITS, code)
    && !GROUPS.some((group) => group.pattern.test(code))).sort();
  assert.deepEqual(unclassified, [], 'a new limit code: give it a route (limit-remediation.mjs), a row, or a group or NOT_LIMITS entry with its reason (test/helpers/limit-table.mjs)');
  for (const [code, reason] of Object.entries(NOT_LIMITS)) {
    assert.ok(reason.length >= 20, `${code} needs its reason`);
    assert.ok(found.has(code), `${code} is in no module any more: remove it from NOT_LIMITS`);
  }
  for (const group of GROUPS) assert.ok(group.reason.length >= 20, `${group.pattern} needs its reason`);
  // No code is both routed and set aside: a route makes its NOT_LIMITS entry stale.
  assert.deepEqual(Object.keys(NOT_LIMITS).filter((code) => routed.has(code)), [], 'routed now: remove it from NOT_LIMITS');
});

test('every row names its limit where it lives: its anchor text is still in its file', () => {
  const ids = new Set();
  for (const row of LIMITS) {
    assert.ok(!ids.has(row.id), `${row.id} is listed twice`);
    ids.add(row.id);
    const [file, anchor] = row.source;
    assert.ok(existsSync(path.join(ROOT, file)), `${row.id}: ${file} is gone`);
    assert.ok(readFileSync(path.join(ROOT, file), 'utf8').includes(anchor), `${row.id}: "${anchor}" is no longer in ${file}`);
    assert.ok(['turn', 'chat', 'process', 'machine', 'story'].includes(row.lives), `${row.id}: where its count lives`);
    assert.ok(Array.isArray(row.resetBy) && row.resetBy.length, `${row.id}: what resets it`);
    assert.ok(row.exit && (row.exit.step || row.exit.route || row.exit.changes), `${row.id}: its exit`);
  }
});

// A limit thrown with no code reaches no plan, no ratchet and no route. Their count per module, as reviewed here; it only
// shrinks. The limit audit gave the five on a Story's path their codes (CAPABILITY_TOKEN_BUDGET_EXCEEDED,
// CLARIFICATION_QUESTION_LIMIT, CHOICE_RECEIPT_EXPIRED, LEDGER_BEHIND_BLOCKED, PRODUCT_COMMAND_TIMEOUT).
const CODELESS_REVIEWED = Object.freeze({
  'src/action-authorization.mjs': 1, 'src/action-plans.mjs': 1, 'src/agent-document-parser.mjs': 2, 'src/analysis-limits.mjs': 3,
  'src/assisted-convergence.mjs': 2, 'src/assisted-quality.mjs': 2, 'src/ast-adapter-contract.mjs': 1, 'src/ast-policy.mjs': 2,
  'src/clarification-markers.mjs': 1, 'src/cli.mjs': 2, 'src/commands/start.mjs': 1, 'src/config.mjs': 3, 'src/constitution.mjs': 1,
  'src/documents.mjs': 3, 'src/editor.mjs': 1, 'src/epic-sources.mjs': 5, 'src/fault-repair.mjs': 2, 'src/jira.mjs': 2,
  'src/knowledge-projection.mjs': 5, 'src/ledger.mjs': 1, 'src/reinstall.mjs': 1, 'src/remote-fetch.mjs': 4, 'src/repair-budget.mjs': 5,
  'src/repository-metadata.mjs': 1, 'src/source-grounded-review.mjs': 2, 'src/source-path-policy.mjs': 1, 'src/specification-quality.mjs': 3,
  'src/specifications.mjs': 6, 'src/story-start-documents.mjs': 4
});

/** Each `new SingularityFlowError(...)` call, whole, by balanced parentheses. */
function errorCalls(text) {
  const found = [];
  for (let index = text.indexOf('new SingularityFlowError('); index >= 0; index = text.indexOf('new SingularityFlowError(', index + 1)) {
    let depth = 0; let end = index + 'new SingularityFlowError'.length; let quote = null;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (quote) { if (char === '\\') end += 1; else if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')' && --depth === 0) break;
    }
    found.push(text.slice(index, end + 1));
  }
  return found;
}

test('a limit thrown with no code stays at its reviewed count per module, and only shrinks', () => {
  const words = /budget|limit\b|limits\b|exceed|at most|no more than|permits no more|expired|quota|ceiling/iu;
  const counts = {};
  for (const file of sourceFiles()) {
    const hits = errorCalls(readFileSync(file, 'utf8')).filter((call) => !/\bcode\s*[:,]/u.test(call) && !/\{\s*code\b/u.test(call) && words.test(call.slice(0, 400)));
    if (hits.length) counts[path.relative(ROOT, file)] = hits.length;
  }
  const grown = Object.entries(counts).filter(([file, count]) => count > (CODELESS_REVIEWED[file] ?? 0)).map(([file, count]) => `${file}: ${count}`);
  assert.deepEqual(grown, [], 'a limit thrown with no code: give it a code and a route (limit-remediation.mjs)');
  const shrunk = Object.entries(CODELESS_REVIEWED).filter(([file, count]) => (counts[file] ?? 0) < count).map(([file]) => file);
  assert.deepEqual(shrunk, [], 'fewer codeless limits now: lower CODELESS_REVIEWED to the new count');
});

const STANDARD_DETAILS = Object.freeze({ workId: 'W-1', phase: 'build', phaseId: 'build', subject: { kind: 'story', id: 'W-1' } });
const STANDARD_ARGV = Object.freeze([['phase', 'prepublish', 'build', '--work-id', 'W-1'], ['approve', 'build', '--work-id', 'W-1'], ['start', 'W-1'],
  ['submit', 'build', '--work-id', 'W-1'], ['session', 'open', 'W-1'], ['clarification', 'record', 'build', '--work-id', 'W-1', '--response-file', 'r.json']]);
const GENERIC = /^singularity-flow (?:help|doctor|nextsteps)\b/u;
// A command's own words, before its first option.
const words = (command) => { const list = String(command ?? '').trim().split(/\s+/u); const end = list.findIndex((word) => word.startsWith('-')); return (end < 0 ? list : list.slice(0, end)).join(' '); };

/** Whether `entry` changes something: the person's change in words, the same command after a named change, or a command that writes. */
const exitStep = (entry, isRead) => (!entry.command && entry.kind === 'remediation' && entry.label)
  || Boolean(entry.changes)
  || (entry.command && !GENERIC.test(entry.command) && routeEffect({ command: entry.command, skill: entry.skill ?? null }, isRead) !== 'read-only');

function planProblems(code, argv, details, isRead) {
  const refused = `singularity-flow ${argv.join(' ')}`;
  const plan = refusalRemediationPlan(Object.assign(new Error('Refused at a limit.'), { code, details }), argv);
  const problems = [];
  for (const entry of plan.steps) if (entry.commandRejected) problems.push(`${code} (${argv.slice(0, 2).join(' ')}): ${entry.id} names a command the route filter refuses`);
  if (!plan.steps.some((entry) => exitStep(entry, isRead))) problems.push(`${code} (${argv.slice(0, 2).join(' ')}): no step changes anything: ${JSON.stringify(plan.steps.map((entry) => entry.command ?? entry.label?.slice(0, 40)))}`);
  const first = plan.steps.find((entry) => entry.command && !entry.wait);
  if (first && !first.changes && words(first.command) === words(refused)) problems.push(`${code} (${argv.slice(0, 2).join(' ')}): its first route is the refused command unchanged`);
  if (plan.retry?.command && !plan.retry.changes && words(plan.retry.command) === words(refused)) problems.push(`${code}: its retry is the refused command unchanged`);
  return { plan, problems };
}

test('every limit route\'s plan changes something: the person\'s change, a command that writes, or the same command only after a change', async () => {
  const isRead = await registryReader();
  const problems = [];
  // A route keyed on what the refusal carries: the Git reader's own code under its wrapper.
  const carried = { AUTHORITY_UNAVAILABLE: { gitAccessCode: 'GAL_TIMEOUT' }, CONFIGURATION_PROPOSAL_RETENTION_FAILED: { gitAccessCode: 'GAL_OUTPUT_LIMIT' } };
  for (const code of LIMIT_ROUTE_CODES) {
    for (const argv of STANDARD_ARGV) problems.push(...planProblems(code, argv, { ...STANDARD_DETAILS, ...carried[code] }, isRead).problems);
  }
  assert.deepEqual(problems, []);
  // None is also a KNOWN route: the KNOWN one would win, and this one would only look covered.
  assert.deepEqual(LIMIT_ROUTE_CODES.filter((code) => KNOWN_REFUSAL_CODES.includes(code)), []);
});

// A real test log [owner, 2026-11-21]: `git did not respond within 15000ms.` (SUBPROCESS_TIMEOUT) was shown "A limit refused
// this, and running the same command on unchanged input meets it again". The machine was busy: running it again is the way on.
const HARD_LIMIT_WORDS = /unchanged input meets it again/u;
const refusedAt = (code, details, message = 'Refused.') => Object.assign(new Error(message), { code, details });

test('a timeout is retried once the machine answers, never told that unchanged input meets it again', () => {
  const plan = refusalRemediationPlan(refusedAt('SUBPROCESS_TIMEOUT', { command: 'git', timeoutMs: 15000 }, 'git did not respond within 15000ms.'),
    ['session', 'open', 'W-1', '--json']);
  const [retry, read] = plan.steps;
  assert.deepEqual([retry.id, retry.command, retry.changes], ['run-again-once-answered', 'singularity-flow session open W-1', 'the machine is less busy']);
  assert.match(retry.label, /^git did not answer within 15 seconds; .* Run the same command again once the machine is less busy\.$/u);
  assert.deepEqual([read.id, read.command, read.kind], ['see-what-is-slow', 'singularity-flow doctor --json', 'diagnostic']);
  assert.ok(plan.steps.some((entry) => entry.id === 'give-it-more-time' && /SINGULARITY_FLOW_GIT_LOCAL_TIMEOUT_MS/u.test(entry.label) && !entry.command));
  assert.equal(plan.retry.label, waitRetryLabel('the machine is less busy'));
  const text = renderRefusalPlan(plan);
  assert.doesNotMatch(text, HARD_LIMIT_WORDS);
  assert.match(text, /\n {2}1\. git did not answer within 15 seconds;/u);
  assert.match(text, /\n {2}Then: This was a wait, not a limit: nothing about the input needs changing\. Run the same command again once the machine is less busy\.$/u);
  // A program that is not Git names no Git setting.
  const other = refusalRemediationPlan(refusedAt('SUBPROCESS_TIMEOUT', { command: 'npm', timeoutMs: 120000 }), ['session', 'open', 'W-1']);
  assert.match(other.steps[0].label, /^npm did not answer within 120 seconds;/u);
  assert.equal(other.steps.some((entry) => /SINGULARITY_FLOW_GIT_/u.test(entry.label)), false);
});

test('every wait\'s plan leads with the same command again, and only a real limit keeps the limit words', () => {
  const argv = ['session', 'open', 'W-1'];
  const waits = [...WAIT_ROUTE_CODES.map((code) => [code, {}]), ['AUTHORITY_UNAVAILABLE', { gitAccessCode: 'GAL_TIMEOUT' }],
    ['CONFIGURATION_PROPOSAL_RETENTION_FAILED', { gitAccessCode: 'GAL_TIMEOUT' }]];
  for (const [code, details] of waits) {
    const plan = refusalRemediationPlan(refusedAt(code, details), argv);
    assert.doesNotMatch(renderRefusalPlan(plan), HARD_LIMIT_WORDS, code);
    const first = plan.steps.find((entry) => entry.command && !entry.wait);
    assert.deepEqual([first?.id, first?.command, Boolean(first?.changes)], ['run-again-once-answered', 'singularity-flow session open W-1', true], code);
    // The plan's last words name the same wait as the retry step.
    assert.equal(plan.retry.label, waitRetryLabel(first.changes), code);
  }
  // A run that holds what the command needs is read first, as a wait; the same command follows it.
  const flight = 'AFL-0123456789ABCDEF0123456789';
  const busy = refusalRemediationPlan(refusedAt('AUTO_FLIGHT_BUSY', { active: [flight] }), ['auto', 'start', 'APL-0123456789ABCDEF0123456789']);
  assert.deepEqual(busy.steps.slice(0, 2).map((entry) => [entry.id, entry.command, entry.wait ?? false, entry.changes ?? null]), [
    ['see-what-holds-it', `singularity-flow auto status ${flight}`, true, null],
    ['run-again-once-answered', 'singularity-flow auto start APL-0123456789ABCDEF0123456789', false, 'the other Auto run has ended']]);
  assert.equal(busy.retry.label, 'This was a wait, not a limit: nothing about the input needs changing. Run the same command again once the other Auto run has ended.');
  // Budgets, counts and sizes: the same command meets them again until the change the steps name.
  const limits = [['CLARIFICATION_QUESTION_LIMIT', { maxQuestions: 3, given: 5 }], ['DOCUMENT_TOO_LARGE', {}], ['MODEL_TOKEN_BUDGET_EXCEEDED', {}],
    ['CAPABILITY_TOKEN_BUDGET_EXCEEDED', { capabilityId: 'web', used: 1200, budget: 1000 }], ['AUTHORITY_UNAVAILABLE', { gitAccessCode: 'GAL_OUTPUT_LIMIT' }],
    ['APP_READY_TIMEOUT', {}], ['UI_OPERATION_TIMEOUT', {}]];
  for (const [code, details] of limits) {
    const plan = refusalRemediationPlan(refusedAt(code, details), argv);
    assert.equal(plan.retry.label, LIMIT_RETRY_LABEL, code);
    assert.match(renderRefusalPlan(plan), /\n {2}Then: A limit refused this, and running the same command on unchanged input meets it again\./u, code);
  }
});

test('each refusal row names its own exit, as the row says', async () => {
  const isRead = await registryReader();
  for (const row of LIMITS.filter((entry) => entry.surface === 'refusal')) {
    const { plan, problems } = planProblems(row.code, row.argv, row.details, isRead);
    assert.deepEqual(problems, [], row.id);
    if (row.exit.step) {
      const named = plan.steps.find((entry) => entry.id === row.exit.step);
      assert.ok(named, `${row.id}: no step ${row.exit.step} in ${JSON.stringify(plan.steps.map((entry) => entry.id))}`);
      if (row.exit.changes) assert.equal(named.changes, row.exit.changes, row.id);
      if (row.exit.route) assert.match(named.command ?? '', row.exit.route, row.id);
    } else if (row.exit.route) assert.ok(plan.steps.some((entry) => row.exit.route.test(entry.command ?? '')), `${row.id}: no step runs ${row.exit.route}`);
  }
});

test('a limit\'s own words reach the plan as the person\'s step, never only help, doctor and next steps', () => {
  // A prose nextAction no route filter accepts (an Auto Plan's "Create and review a new Auto Plan.") stays as words.
  const plan = refusalRemediationPlan(Object.assign(new Error('Refused.'), { code: 'SOME_PROSE_LIMIT_EXCEEDED',
    details: { nextAction: 'Select an approved larger profile, or narrow the operation.' } }), ['context', 'pack']);
  assert.equal(plan.steps[0].label, 'Select an approved larger profile, or narrow the operation.');
  assert.equal(plan.steps[0].command, null);
});

test('the kernel\'s repair budget is its own: a request\'s continuations never spend it (owner decision 2)', async (t) => {
  const { taskOutcomeOf, lifecycleMark, outcomeCode } = await import('../src/workflow-task-outcome.mjs');
  const workflow = { history: [{ at: '2026-11-20T00:00:00.000Z', event: 'phase-entered', phase: 'build' }] };
  const record = { id: 'WT-x', state: 'blocked', blockedCode: outcomeCode('repair-required', 'CODE_TEST_FAILED', workflow),
    repairConsumed: 3, maximumContinuations: 3, continuations: 0 };
  assert.ok(lifecycleMark(workflow));
  assert.deepEqual(taskOutcomeOf(record, workflow).repairs, { used: 3, budget: 3 });
  const row = LIMITS.find((entry) => entry.id === 'kernel-repair-budget');
  // Its route is still the appeal read: reported as a todo until it names a person's step that changes something.
  await t.test('its route names a person\'s step that changes something', { todo: row.todo }, async () => {
    const { decisionRoutes } = await import('../src/step-decision.mjs');
    const phase = { id: 'build', status: 'in_progress', generation: 1 };
    const decision = { next: { operation: 'decide', target: { phase: 'build' }, inputs: { decision: 'task-outcome', outcome: 'repair-exhausted', code: 'CODE_TEST_FAILED' } } };
    const routes = decisionRoutes(decision, { workItem: { id: 'W-1' }, phases: { build: phase }, phaseOrder: ['build'] }, phase);
    assert.ok(routes.some((route) => !/^singularity-flow appeal preflight\b/u.test(route.command ?? '')), JSON.stringify(routes));
  });
});

test('a kept result older than the call it answers is never that call\'s', async (t) => {
  const { keepAgentResult, beginAgentResult, lastAgentResult, noteAgentCall } = await import('../src/agent-result-keeper.mjs');
  const { keptResultView } = await import('../src/commands/result.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-limit-kept-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { SINGULARITY_FLOW_AGENT_RESULTS: path.join(base, 'results') };
  const command = 'singularity-flow review-source check build --report-file r.json --for-agent --json';
  const argv = ['review-source', 'check', 'build', '--report-file', 'r.json', '--for-agent', '--json'];
  const now = Date.now();
  const run = beginAgentResult(argv, { cwd: base, env, now: now - 60_000 });
  keepAgentResult(run, JSON.stringify({ act: { state: 'correct', do: { shell: command } }, status: 'old' }), { now: now - 59_000 });
  noteAgentCall(command, { cwd: base, env, now });
  const found = await lastAgentResult({ cwd: base, env, command, wait: 0, arrival: 0, clock: () => now + 10 });
  assert.equal(found.status, 'none', 'the earlier run is never this call\'s');
  const view = keptResultView(found, { command });
  assert.equal(view.act, undefined);
  assert.equal(view.next, undefined);
  assert.equal(view.status, 'none');
});

test('every high- or medium-reach row is walked by a test that still says so', (t) => {
  for (const row of LIMITS.filter((entry) => COVERAGE_REACH.includes(entry.reach))) {
    if (row.surface === 'refusal') continue; // walked above, through its plan
    // A row whose exit is still open says so and why (its `todo`); the rest of this check still counts.
    if (row.todo && !row.coveredBy) { t.diagnostic(`open: ${row.id}: ${row.todo}`); continue; }
    assert.ok(row.coveredBy, `${row.id} (${row.reach}) is walked by no test`);
    const [file, text] = row.coveredBy;
    assert.ok(readFileSync(path.join(ROOT, file), 'utf8').includes(text), `${row.id}: ${file} no longer says "${text}"`);
  }
});
