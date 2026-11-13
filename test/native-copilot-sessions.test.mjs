import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CALL_CAUSES, RESULT_ROUTES, copilotSessionReport, createSessionAttribution, readCopilotSessionReport } from '../src/native-copilot-sessions.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(packageRoot, 'test/fixtures/copilot-sessions');
const audit = (...args) => spawnSync(process.execPath, [path.join(packageRoot, 'scripts/native-copilot-audit.mjs'), ...args],
  { cwd: packageRoot, encoding: 'utf8', timeout: childTimeout(15000) });

// SPEC-OUT v3 AC-001: every call one cause, every result one route, totals equal the input.
test('session report gives every model call one cause and every tool result one route', async () => {
  const report = await readCopilotSessionReport(fixture, { since: '2026-10-15', details: true });
  assert.equal(report.corpus.sessionsRead, 3, 'the 1 Oct session is before --since');
  assert.equal(report.corpus.sessionsWithSflow, 2, 'a session with no SFlow command is left out');
  assert.deepEqual(Object.keys(report.byCause), CALL_CAUSES);
  assert.deepEqual(Object.keys(report.byRoute), RESULT_ROUTES);
  assert.equal(Object.values(report.byCause).reduce((sum, row) => sum + row.calls, 0), report.totals.calls);
  assert.equal(Object.values(report.byCause).reduce((sum, row) => sum + row.inputTokens, 0), report.totals.inputTokens);
  assert.equal(Object.values(report.byRoute).reduce((sum, row) => sum + row.results, 0), report.totals.toolResults);
  assert.equal(Object.values(report.byRoute).reduce((sum, row) => sum + row.bytes, 0), report.totals.resultBytes);
  assert.equal(report.records.calls.length, 16);
  assert.equal(report.records.routes.length, 16);
  assert.deepEqual(Object.fromEntries(Object.entries(report.byCause).map(([cause, row]) => [cause, row.calls])),
    { 'user-turn': 4, 'sflow-result': 5, 'sflow-overflow': 1, 'sflow-mixed': 1, 'source-read': 1, 'host-shell': 2, 'host-saved-read': 1, other: 1 });
  assert.deepEqual(Object.fromEntries(Object.entries(report.byRoute).map(([route, row]) => [route, row.results])),
    { 'sflow-result': 6, 'sflow-overflow-read': 3, 'source-read': 1, search: 1, 'host-shell-test': 1, 'host-shell-other': 1, 'host-saved-read': 1, other: 2 });
  assert.deepEqual(report.otherTools, { apply_patch: 1, unknown: 1 }, 'a result without a logged start is other, never dropped');
  assert.equal(report.byRoute['host-shell-other'].savedByHost, 1);
  assert.deepEqual([report.corpus.unparsedLines, report.corpus.unmatchedToolResults, report.corpus.unfinishedToolCalls], [1, 1, 1]);
  // A kind is counted without its `sflow-` prefix, the way the checkout's `.sflow/out` names it.
  assert.deepEqual(report.resultTypes.overflowReads, { 'phase-entry': { results: 3, bytes: 81 } });
  assert.deepEqual(report.overflowReads, { files: 1, reads: 3, readsPerFile: { median: 3, p90: 3 }, repeatRate: 0.3333 });
  // The asynchronous shell's later read keeps the SFlow route of the command that started it.
  assert.equal(report.resultTypes.sflowResults['sflow-submission-readiness'].results, 1);
});

// AC-002 and AC-003: hand-computed ITC; an abandoned skill run stays in the denominator.
test('task ITC is the sum of its calls and an unfinished run is still counted', async () => {
  const report = await readCopilotSessionReport(fixture, { since: '2026-10-15' });
  const { 'sf-phase': phase, 'sf-code': code, 'sf-approve': approve } = report.tasks.bySkill;
  assert.deepEqual([phase.calls, phase.inputTokens, phase.cacheReadTokens, phase.uncachedInputTokens, phase.finished],
    [9, 1000 + 1500 + 2500 + 2600 + 2700 + 3000 + 3100 + 3200 + 3300, 19600, 3300, 1]);
  assert.deepEqual([code.tasks, code.finished, code.inputTokens, code.inputPerFinishedTask], [1, 0, 8100, null], 'a refused /sf-code run is unfinished');
  assert.deepEqual([approve.finished, approve.inputTokens], [1, 2600], 'older hosts log the skill after its message');
  assert.equal(report.tasks.sflowSkills.tasks, 3);
  assert.equal(report.tasks.sflowSkills.finishRate, 0.6667);
  assert.equal(report.tasks.sflowSkills.inputPerFinishedTask, (22900 + 8100 + 2600) / 2, 'the unfinished run is charged to the finished ones');
  assert.deepEqual(report.tasks.unlabelled, { tasks: 1, inputTokens: 4200 });
  assert.equal(report.totals.inputTokens, 37800);
  assert.equal(report.totals.premiumRequests, 4);
  assert.equal(report.fixedPrefix.share, Math.round(((1000 * 12 + 500 * 4) / 37800) * 10000) / 10000);
  assert.equal(report.auxiliaryModelCalls.calls, 1);
  assert.equal(report.hookContext.injections, 2);
});

// AC-004 and AC-006: counts and identifiers only; byte-identical on re-run.
test('the report holds no planted content and is byte-identical on re-run', async () => {
  const first = audit('--sessions', fixture, '--since', '2026-10-15', '--details');
  assert.equal(first.status, 0, first.stderr);
  for (const planted of ['PLANTED', '/work/repo', '/tmp/fixture', '/home/', 'WRK-', 'phase enter', 'npm test', 'git log']) {
    assert.equal(first.stdout.includes(planted), false, `report leaked ${planted}`);
  }
  const logged = await readFile(path.join(fixture, '11111111-0000-4000-8000-000000000001', 'events.jsonl'), 'utf8');
  for (const planted of ['SYSTEM', 'SKILL', 'HOOK', 'PROMPT', 'ARG', 'OUTPUT', 'STDERR', 'PATH', 'PATCH']) {
    assert.ok(logged.includes(`PLANTED-SECRET-${planted}`), `the fixture plants ${planted}`);
  }
  const second = audit('--sessions', fixture, '--since', '2026-10-15', '--details');
  assert.equal(second.stdout, first.stdout);
  assert.equal(JSON.parse(first.stdout).resultType, 'copilot-session-attribution-report');
  for (const args of [['--since', '2026-10-15'], ['--sessions', fixture, '--since', '20/10/2026'], ['--sessions', path.join(fixture, 'missing')],
    ['--sessions', fixture, '--trace', path.join(fixture, 'x.json')]]) {
    const refused = audit(...args);
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.equal(refused.stdout, '');
  }
});

test('session logs are read only as regular files, one event at a time', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (process.platform !== 'win32') {
    await mkdir(path.join(root, 'linked'));
    await symlink(path.join(fixture, '11111111-0000-4000-8000-000000000001', 'events.jsonl'), path.join(root, 'linked', 'events.jsonl'));
  }
  assert.equal((await readCopilotSessionReport(root)).corpus.sessionsRead, 0, 'a linked log is not followed');
  const session = createSessionAttribution('../not-an-id');
  session.push('{'); session.push('null');
  const summary = session.finish();
  assert.equal(summary.unparsedLines, 2);
  assert.match(summary.id, /^[0-9a-f]{16}$/u, 'a session name that is not an identifier is reported only as its digest');
});

test('an overflow read counts the same in the checkout\'s .sflow/out and the older Git-directory folder', () => {
  const session = createSessionAttribution('11111111-0000-4000-8000-0000000000aa');
  const at = (index) => `2026-10-26T10:00:${String(index).padStart(2, '0')}.000Z`;
  const events = [
    { type: 'session.start', data: { copilotVersion: '1.0.103', startTime: at(0) } },
    { type: 'user.message', data: { content: '/sf-phase' } },
    { type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'bash', arguments: { command: 'singularity-flow phase enter --compose --for-agent --json' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'a', success: true, result: { content: '{"resultType":"sflow-phase-entry"}' } } },
    { type: 'tool.execution_start', data: { toolCallId: 'b', toolName: 'view',
      arguments: { path: '/w/.singularity-flow/story-worktrees/.w-1ba53a9069e84ec4093256c2/.sflow/out/phase-entry-5ec3d303.context.text.txt' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'b', success: true, result: { content: 'new' } } },
    { type: 'tool.execution_start', data: { toolCallId: 'c', toolName: 'view',
      arguments: { path: '/w/main/.git/worktrees/-w-1ba53a9069e84ec4093256c2/singularity-flow/agent-results/sflow-phase-entry-2026-10-25T10-00-00-000Z-5ec3d303.json' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c', success: true, result: { content: 'old' } } }
  ];
  events.forEach((event, index) => session.push(JSON.stringify({ ...event, id: `e${index}`, timestamp: at(index) })));
  const report = copilotSessionReport([session.finish()]);
  assert.equal(report.byRoute['sflow-overflow-read'].results, 2);
  assert.deepEqual(report.resultTypes.overflowReads, { 'phase-entry': { results: 2, bytes: 6 } });
});

// AC-005 (CON-015): no work command, hook or skill reads the report, the analyzer or the host logs.
test('only the offline audit script reaches the session analyzer and the host logs', async () => {
  const roots = ['src', 'bin', 'plugin', 'templates', 'scripts', 'apps/vscode/src', 'apps/intellij/src'];
  // Fresh-install reset removes SFlow's own `singularity-*` session folders; it never reads a session log.
  // The Copilot extensions page is opened by a person, reads at most 4,000 lines of a chat, and no work command loads it.
  // Story reports read the logs' usage records (src/copilot-session-usage.mjs); only `report`, `telemetry sessions`
  // and the snapshot load it, which test/copilot-session-usage.test.mjs holds. [owner, 2026-11-13]
  const hostLogReaders = new Set(['src/fresh-install-reset.mjs', 'apps/vscode/src/views/copilot-extensions-model.ts', 'src/copilot-session-usage.mjs']);
  const files = [];
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(path.join(packageRoot, directory), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !['node_modules', 'dist', 'build'].includes(entry.name)) await walk(relative);
      else if (entry.isFile() && /\.(?:mjs|cjs|js|ts|kt|java|sh|ps1|json|md|ya?ml)$/u.test(entry.name)) files.push(relative);
    }
  };
  for (const root of roots) await walk(root);
  assert.ok(files.includes('plugin/hooks.json') && files.some((file) => file.startsWith('plugin/skills/')));
  for (const file of files) {
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    if (file !== 'scripts/native-copilot-audit.mjs' && file !== 'src/native-copilot-sessions.mjs') {
      assert.equal(/native-copilot-sessions|readCopilotSessionReport|copilot-session-attribution-report/u.test(text), false, `${file} reaches the session analyzer`);
    }
    if (!hostLogReaders.has(file) && file !== 'src/native-copilot-sessions.mjs' && file !== 'scripts/native-copilot-audit.mjs') {
      assert.equal(/\.copilot[\\/]session-state|['"`]session-state['"`]/u.test(text), false, `${file} names the host session logs`);
    }
    if (file.startsWith('plugin/')) assert.equal(/audit:copilot|native-copilot-audit/u.test(text), false, `${file} runs the audit`);
  }
});
