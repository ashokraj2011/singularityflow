/**
 * The `tests summary` read model [RUN M2]: one shape for a capability's local preview run and for a
 * Story step's recorded attempts, read by the Shell, VS Code and Copilot alike.
 *
 * Totals and per-command results come from the attempt receipts. Test cases come from their kept
 * occurrences, listed up to 5,000. A case's requirement tags come from the same `@ac:` scanners
 * and join the evidence matrix uses: an exact JavaScript declaration joined to its occurrence, or,
 * for a report that names each case's file and line, the comment tags directly above that line.
 * A failed case carries `message`: a short failure message (test-case-messages.mjs) when its
 * command's report gives one, else null. Passing and skipped cases carry none, which keeps a
 * 5,000-case answer within the size its readers take.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { posix, secureRepositoryPath } from './util.mjs';

export const SUMMARY_CASE_LIMIT = 5_000;
export const PER_CASE_ADAPTERS = Object.freeze(['junit-xml', 'node-tap', 'jest-json', 'vitest-json']);
export const SUMMARY_RESULT_TYPE = 'sflow-test-summary';
const MAX_TAG_SOURCE_BYTES = 1024 * 1024;
const MAX_TAG_FILES = 256;

/** Why a command shows no test cases, naming the report format that would list them. */
export function perCaseNote({ adapter, kind, occurrences = [], tests = null, status }) {
  if (kind && kind !== 'test') return 'Not a test command: its exit code is its whole result.';
  if (!adapter) return 'No structured report: only the exit code is known.';
  if (!PER_CASE_ADAPTERS.includes(adapter)) {
    return `${adapter} reports give totals only. A junit-xml, node-tap, jest-json or vitest-json report lists each test case.`;
  }
  if (!occurrences.length && tests && Number(tests.discovered) > 0) {
    return adapter === 'node-tap'
      ? 'This TAP report has totals only. Run node --test through the code step\'s reporter (as tests run does) to list each test case.'
      : `This ${adapter} report named no test cases.`;
  }
  if (!tests && status !== 'passed') return 'The command produced no readable report.';
  return null;
}

function safeRelative(file) {
  const candidate = posix(String(file ?? '')).replace(/^\.\//u, '');
  return candidate && !path.posix.isAbsolute(candidate) && !/^[A-Za-z]:/u.test(candidate)
    && !candidate.split('/').includes('..') ? candidate : null;
}

async function sourceLines(root, relative, cache) {
  if (cache.has(relative)) return cache.get(relative);
  let lines = null;
  try {
    const secured = await secureRepositoryPath(root, relative, { label: 'Test source', mustExist: true, type: 'file' });
    const bytes = await readFile(secured.absolute);
    if (bytes.length <= MAX_TAG_SOURCE_BYTES) lines = bytes.toString('utf8').split(/\r?\n/u);
  } catch { /* an unreadable source tags nothing */ }
  cache.set(relative, lines);
  return lines;
}

/**
 * The `@ac:` clause IDs of each occurrence, aligned with `occurrences`. `locations` (from the raw
 * report) supplies a case's file and line when its occurrence does not carry them.
 */
export async function occurrenceClauses(root, { occurrences = [], profile = null, locations = null }) {
  const clauses = occurrences.map(() => new Set());
  if (!occurrences.length) return [];
  const [{ profileIsExact, testAdapterProfile }, { acceptanceTagsAboveLine }] = await Promise.all([
    import('./verification/profiles.mjs'), import('./verification/tags.mjs')]);
  const profileId = profile ?? 'module-counts-v1';
  const exactJavaScript = profileIsExact(profileId) && testAdapterProfile(profileId).language === 'javascript';
  if (exactJavaScript) {
    const files = [...new Set(occurrences.map((entry) => safeRelative(entry.file)).filter(Boolean))].slice(0, MAX_TAG_FILES);
    if (files.length) {
      const [{ discoverDeclarations }, { joinDeclaration }] = await Promise.all([
        import('./verification/adapters.mjs'), import('./verification/join.mjs')]);
      const { declarations } = await discoverDeclarations(root, profileId, files).catch(() => ({ declarations: [] }));
      for (const declaration of declarations) {
        if (declaration.suiteTag || !declaration.clauseIds?.length) continue;
        // Only the identity join matters here, not whether the declaration is exact enough to verify.
        const identity = { ...declaration, gaps: [] };
        occurrences.forEach((occurrence, index) => {
          const file = safeRelative(occurrence.file);
          if (file && file !== declaration.sourcePath && !file.endsWith(`/${declaration.sourcePath}`)) return;
          const joined = joinDeclaration(identity, [occurrence], { language: 'javascript' });
          if (joined.occurrences?.length) for (const id of declaration.clauseIds) clauses[index].add(id);
        });
      }
    }
  }
  const cache = new Map();
  for (const [index, occurrence] of occurrences.entries()) {
    if (clauses[index].size) continue;
    const file = safeRelative(occurrence.file ?? locations?.[index]?.file);
    const line = Number.isInteger(occurrence.line) ? occurrence.line : locations?.[index]?.line;
    if (!file || !Number.isInteger(line) || line < 1 || (!cache.has(file) && cache.size >= MAX_TAG_FILES)) continue;
    const lines = await sourceLines(root, file, cache);
    if (!lines) continue;
    for (const id of acceptanceTagsAboveLine(lines, line - 1).clauseIds) clauses[index].add(id);
  }
  return clauses.map((set) => [...set].sort());
}

function outcomeOf(occurrence) {
  if (occurrence.flaky === true && occurrence.outcome === 'passed') return 'flaky';
  return ['passed', 'failed', 'skipped'].includes(occurrence.outcome) ? occurrence.outcome : 'failed';
}

function durationOf(receipt) {
  const started = Date.parse(receipt?.process?.startedAt ?? '');
  const completed = Date.parse(receipt?.process?.completedAt ?? '');
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : 0;
}

/**
 * Build the summary. Each entry is one command's receipt with its run metadata:
 * `{ receipt, kind, clauses, environment, evidenceClass, countsForStep, label, note, messages }`, where
 * `messages` (already redacted) is aligned with the receipt's occurrences.
 */
export function buildTestSummary({ scope, run, entries, history = [] }) {
  const totals = { discovered: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 };
  const commands = [];
  const cases = [];
  let caseCount = 0;
  let untagged = 0;
  for (const entry of entries) {
    const receipt = entry.receipt ?? {};
    const occurrences = receipt.occurrences ?? [];
    const tests = receipt.tests ?? null;
    if (tests) for (const key of ['discovered', 'passed', 'failed', 'skipped']) totals[key] += Number(tests[key] ?? 0) || 0;
    totals.flaky += occurrences.filter((occurrence) => occurrence.flaky === true).length;
    totals.durationMs += durationOf(receipt);
    const adapter = receipt.adapter ?? null;
    const perCase = occurrences.length > 0 && PER_CASE_ADAPTERS.includes(adapter);
    commands.push({
      id: receipt.commandId, kind: entry.kind ?? 'test', adapter, status: receipt.status ?? 'unavailable',
      exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null,
      tests: tests ? { discovered: tests.discovered, passed: tests.passed, failed: tests.failed, skipped: tests.skipped } : {},
      perCase,
      note: entry.note ?? (perCase ? null : perCaseNote({ adapter, kind: entry.kind, occurrences, tests, status: receipt.status })),
      ...(entry.evidenceClass ? { evidenceClass: entry.evidenceClass } : {}),
      environment: entry.environment ?? null,
      countsForStep: entry.countsForStep ?? false,
      ...(entry.label ? { label: entry.label } : {}),
      // A gate run that ran narrowed, and the acceptance that let it through [TCE:REQ-024].
      ...(entry.narrowing ? { narrowing: entry.narrowing } : {}),
      attemptId: receipt.attemptId ?? null
    });
    for (const [index, occurrence] of occurrences.entries()) {
      const clauses = entry.clauses?.[index] ?? [];
      if (!clauses.length) untagged += 1;
      caseCount += 1;
      if (cases.length >= SUMMARY_CASE_LIMIT) continue;
      cases.push({
        command: receipt.commandId,
        suite: Array.isArray(occurrence.suitePath) ? (occurrence.suitePath.join(' › ') || null) : occurrence.className ?? null,
        name: occurrence.name ?? null,
        file: occurrence.file ?? entry.locations?.[index]?.file ?? null,
        line: Number.isInteger(occurrence.line) ? occurrence.line : entry.locations?.[index]?.line ?? null,
        outcome: outcomeOf(occurrence),
        durationMs: occurrence.durationMs ?? null,
        clauses,
        ...(occurrence.outcome === 'failed' ? { message: typeof entry.messages?.[index] === 'string' ? entry.messages[index] : null } : {})
      });
    }
  }
  return {
    resultType: SUMMARY_RESULT_TYPE,
    schemaVersion: 1, // schema-transient: a read model, never stored
    scope,
    run,
    totals,
    commands,
    cases,
    truncated: caseCount > cases.length,
    untagged,
    history
  };
}

/** Totals of one stored run or attempt group, for the history list. */
export function historyTotals(receipts) {
  return buildTestSummary({ scope: null, run: null, entries: receipts.map((receipt) => ({ receipt })) }).totals;
}

function caseLine(entry) {
  const where = entry.file ? ` (${entry.file}${entry.line ? `:${entry.line}` : ''})` : '';
  const tags = entry.clauses.length ? ` [${entry.clauses.join(', ')}]` : '';
  return `${[entry.suite, entry.name].filter(Boolean).join(' › ')}${where}${tags}`;
}

/** The short human summary: totals, one line per command, failed cases, and the next command. */
export function testSummaryText(summary, { next = null } = {}) {
  const lines = [];
  const scope = summary.scope.kind === 'story' ? `${summary.scope.workId} step ${summary.scope.phase}` : `capability ${summary.scope.capability}`;
  if (!summary.run) {
    lines.push(`No test run is recorded for ${scope} yet.`);
    if (next) lines.push(`Run: ${next}`);
    return lines.join('\n');
  }
  const run = summary.run;
  lines.push(`Test summary — ${scope} · ${run.label} · ${run.id}${run.commit ? ` · commit ${String(run.commit).slice(0, 7)}` : ''}${run.uncommittedChanges ? ' (uncommitted changes)' : ''}`);
  // The step's bound run is the default; a newer one it did not bind is named [CQF:REQ-015].
  if (run.newer) lines.push(`The run bound to this step. A newer run, ${run.newer.id}, is not bound to it: ${run.newer.command}`);
  const t = summary.totals;
  lines.push(`Totals: ${t.discovered} discovered · ${t.passed} passed · ${t.failed} failed · ${t.skipped} skipped · ${t.flaky} flaky · ${(t.durationMs / 1000).toFixed(1)} s`);
  for (const command of summary.commands) {
    const counts = command.tests?.discovered != null ? ` · ${command.tests.discovered} tests, ${command.tests.passed} passed, ${command.tests.failed} failed` : '';
    const environment = command.environment ? ` · environment ${command.environment}` : '';
    lines.push(`  ${command.id} (${command.adapter ?? command.kind}): ${command.status}${command.exitCode != null ? `, exit ${command.exitCode}` : ''}${counts}${environment}`);
    if (command.label && command.label !== run.label) lines.push(`    ${command.label}`);
    if (command.note) lines.push(`    ${command.note}`);
    if (command.narrowing) {
      const accepted = command.narrowing.accepted;
      lines.push(`    Narrowed: ${command.narrowing.words}; ${accepted ? `accepted as ${accepted.id}: ${accepted.reason}` : 'not accepted, so its gate refuses it'}`);
    }
  }
  const failed = summary.cases.filter((entry) => entry.outcome === 'failed');
  if (failed.length) {
    lines.push('Failed:');
    for (const entry of failed.slice(0, 20)) {
      lines.push(`  ✖ ${entry.command} › ${caseLine(entry)}`);
      // Its message, bounded and redacted as the JSON's [CQF:REQ-014].
      if (entry.message) for (const line of entry.message.split('\n')) lines.push(`      ${line}`);
    }
    if (failed.length > 20) lines.push(`  … and ${failed.length - 20} more (use --json)`);
  }
  lines.push(`Untagged cases: ${summary.untagged}${summary.truncated ? ` · first ${summary.cases.length} cases listed` : ''}`);
  if (next) lines.push(`Next: ${next}`);
  return lines.join('\n');
}
