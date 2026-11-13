import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  copilotSessionCalls, copilotSessionStateDirectory, copilotSessionUsageStatus, storyCopilotSessions, syncCopilotSessionUsage
} from '../src/copilot-session-usage.mjs';
import { deriveReport, renderHtml, renderMarkdown } from '../src/report.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const cleanup = [];
test.after(async () => { await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

/** A repository with a Story worktree on ENG-7, another repository, and an empty session folder. */
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-sessions-'));
  cleanup.push(base);
  const root = path.join(base, 'repo');
  const other = path.join(base, 'other');
  const story = path.join(base, '.singularity-flow', 'story-worktrees', '.w-0123456789abcdef01234567');
  for (const directory of [root, other]) {
    await mkdir(directory, { recursive: true });
    git(directory, 'init', '-q', '-b', 'main');
    git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'start');
  }
  await mkdir(path.dirname(story), { recursive: true });
  git(root, 'worktree', 'add', '-q', '-b', 'ENG-7', story);
  const sessions = path.join(base, 'session-state');
  await mkdir(sessions);
  return { base, root, other, story, sessions };
}

const at = (minutes) => new Date(Date.parse('2026-11-01T09:00:00.000Z') + minutes * 60_000).toISOString();
let ids = 0;
// The shape Copilot writes: one event per line, its type first.
const event = (type, data, minutes) => JSON.stringify({ type, data, id: `e${++ids}`, timestamp: at(minutes), parentId: null });
const start = (minutes, context) => event('session.start', {
  sessionId: 'kept-only-as-a-hash', version: 1, producer: 'copilot-agent', copilotVersion: '1.0.109', startTime: at(minutes),
  selectedModel: 'model-alpha-1.5', context: { cwd: context.gitRoot ?? context.cwd, hostType: 'github', repository: 'acme/payments', headCommit: 'f'.repeat(40), ...context }
}, minutes);
const call = (minutes, { session = 's', sequence, initiator = 'agent', model = 'model-alpha-1.5', input = 1000, cached = 900, written = 50, output = 40, cost = 1, nano = 100_000_000 } = {}) =>
  event('session.usage_record', { usage: {
    model, responseModel: `${model}-2026`, inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: written,
    reasoningTokens: 0, cost, initiator, interactionType: initiator === 'sub-agent' ? 'conversation-subagent' : 'conversation-agent',
    isByok: false, isAuto: false, aiCreditsStatus: 'complete', copilotUsage: { totalNanoAiu: nano, tokenDetails: [] },
    accounting: { sourceSessionId: session, sequence, usageId: `${session}-usage-${sequence}` }
  } }, minutes);
const noise = (minutes) => [
  event('user.message', { content: 'please fix the secret prompt text' }, minutes),
  event('tool.execution_start', { toolCallId: 't', toolName: 'bash', arguments: { command: 'cat /private/notes.txt' } }, minutes)
];

async function session(sessions, name, lines) {
  await mkdir(path.join(sessions, name), { recursive: true });
  const file = path.join(sessions, name, 'events.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

test('the session folder is the override, else COPILOT_HOME\'s, else the home directory\'s', () => {
  assert.equal(copilotSessionStateDirectory({ SINGULARITY_FLOW_COPILOT_SESSION_STATE: '/x/state', COPILOT_HOME: '/y' }), path.resolve('/x/state'));
  assert.equal(copilotSessionStateDirectory({ COPILOT_HOME: '/y/copilot' }), path.join('/y/copilot', 'session-state'));
  assert.equal(copilotSessionStateDirectory({}), path.join(os.homedir(), '.copilot', 'session-state'));
  assert.ok(process.env.SINGULARITY_FLOW_COPILOT_SESSION_STATE, 'the suite runner points every test run at its own folder');
  assert.notEqual(copilotSessionStateDirectory(), path.join(os.userInfo().homedir, '.copilot', 'session-state'));
});

test('a sync records this repository\'s model calls by branch, content-free and once each', async () => {
  const { root, other, story, sessions } = await fixture();
  await session(sessions, 'session-story', [
    start(0, { gitRoot: story, branch: 'ENG-7' }), ...noise(1),
    call(1, { session: 'session-story', sequence: 1, initiator: 'user', model: 'model-premium-2', nano: 2_500_000_000 }),
    call(2, { session: 'session-story', sequence: 2 }),
    call(3, { session: 'session-story', sequence: 3, initiator: 'sub-agent' }),
    event('session.usage_checkpoint', { totalPremiumRequests: 1, totalNanoAiu: 2_700_000_000 }, 4)
  ]);
  await session(sessions, 'session-other', [start(0, { gitRoot: other, branch: 'ENG-7' }), call(1, { session: 'session-other', sequence: 1, initiator: 'user' })]);
  await session(sessions, 'session-no-git', [start(0, { cwd: path.join(os.tmpdir(), 'scratch') }), call(1, { session: 'session-no-git', sequence: 1 })]);
  await mkdir(path.join(sessions, 'session-without-log'));

  const first = await syncCopilotSessionUsage(root, { directory: sessions, now: Date.parse(at(10)) });
  assert.equal(first.status, 'synced');
  assert.equal(first.added, 3, 'the other repository and the session outside Git are not ours');
  const calls = await copilotSessionCalls(root, 'ENG-7');
  assert.equal(calls.since, at(10));
  assert.equal(calls.branchSessions, 1);
  assert.deepEqual(calls.calls.map(({ key, session: id, ...rest }) => rest), [
    { at: at(1), model: 'model-premium-2', initiator: 'user', inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 40, premiumRequests: 1, nanoAiu: 2_500_000_000 },
    { at: at(2), model: 'model-alpha-1.5', initiator: 'agent', inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 40, premiumRequests: 0, nanoAiu: 100_000_000 },
    { at: at(3), model: 'model-alpha-1.5', initiator: 'sub-agent', inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 40, premiumRequests: 0, nanoAiu: 100_000_000 }
  ], 'premium requests count the person\'s request only; a checkpoint beside per-call records adds nothing');
  assert.ok(calls.calls.every((entry) => /^[0-9a-f]{16}$/u.test(entry.key) && /^[0-9a-f]{16}$/u.test(entry.session)), 'ids are kept only as short hashes');

  const directory = path.join(root, '.git', 'singularity-flow', 'copilot-sessions');
  const stored = (await Promise.all([path.join(directory, 'cursor.json'),
    ...(await readdir(path.join(directory, 'branches'))).map((name) => path.join(directory, 'branches', name))]
    .map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(stored, /secret prompt|private\/notes|session-story|kept-only|acme|usage-1/u, 'no text, argument, path or raw id is kept');
  assert.equal(stored.includes(story), false);
  assert.equal(stored.includes(sessions), false);

  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 0, 'a repeated sync adds nothing');
  const status = await copilotSessionUsageStatus(root, { directory: sessions });
  assert.deepEqual(status.sessions, {
    seen: 3, matched: 1, unmatched: { 'other-repository': 1, 'no-git-context': 1 }, withoutLog: 1, pending: 0, calls: 3, callsWithoutBranch: 0
  });
  assert.equal(status.branches, 1);
});

test('appended lines are read on the next sync, a partial last line waits, and a rewritten log counts nothing twice', async () => {
  const { root, story, sessions } = await fixture();
  const file = await session(sessions, 'growing', [start(0, { gitRoot: story, branch: 'ENG-7' }), call(1, { session: 'growing', sequence: 1, initiator: 'user' })]);
  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 1);
  const next = call(2, { session: 'growing', sequence: 2, initiator: 'user' });
  await appendFile(file, `${call(1.5, { session: 'growing', sequence: 3 })}\n${next.slice(0, 50)}`);
  const second = await syncCopilotSessionUsage(root, { directory: sessions });
  assert.equal(second.added, 1, 'the complete line only');
  await appendFile(file, `${next.slice(50)}\n`);
  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 1, 'the finished line is read once it is complete');
  const calls = (await copilotSessionCalls(root, 'ENG-7')).calls;
  assert.deepEqual(calls.map((entry) => entry.premiumRequests), [1, 0, 1]);

  // Copilot rewrites the log (a new file at the same place): read again from the start, nothing doubles.
  const text = await readFile(file, 'utf8');
  await rm(file);
  await writeFile(file, text);
  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 0);
  assert.equal((await copilotSessionCalls(root, 'ENG-7')).calls.length, 3);
});

test('a session whose first line is still being written is decided by a later sync, from its start', async () => {
  const { root, story, sessions } = await fixture();
  const opening = start(0, { gitRoot: story, branch: 'ENG-7' });
  await mkdir(path.join(sessions, 'new'));
  const file = path.join(sessions, 'new', 'events.jsonl');
  await writeFile(file, opening.slice(0, 30));
  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 0);
  await appendFile(file, `${opening.slice(30)}\n${call(1, { session: 'new', sequence: 1, initiator: 'user' })}\n`);
  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 1);
  assert.equal((await copilotSessionUsageStatus(root, { directory: sessions })).sessions.matched, 1);
});

test('a branch or folder change in the middle of a session moves the calls after it', async () => {
  const { root, other, story, sessions } = await fixture();
  const moving = await session(sessions, 'moving', [
    start(0, { gitRoot: root, branch: 'main' }),
    call(1, { session: 'moving', sequence: 1, initiator: 'user' }),
    // Copilot announces the new folder before it has resolved its Git root: nothing changes yet.
    event('session.context_changed', { cwd: story, pendingGitContext: true }, 2),
    call(2, { session: 'moving', sequence: 2 }),
    event('session.context_changed', { cwd: story, gitRoot: story, branch: 'ENG-7', repository: 'acme/payments', hostType: 'github' }, 3),
    call(3, { session: 'moving', sequence: 3, initiator: 'user' })
  ]);
  // Started in another repository; it moves here after the first sync skipped what it had written.
  const arriving = await session(sessions, 'arriving', [start(0, { gitRoot: other, branch: 'ENG-7' }), call(1, { session: 'arriving', sequence: 1, initiator: 'user' })]);
  await syncCopilotSessionUsage(root, { directory: sessions });
  assert.deepEqual((await copilotSessionCalls(root, 'main')).calls.map((entry) => entry.at), [at(1), at(2)]);
  assert.deepEqual((await copilotSessionCalls(root, 'ENG-7')).calls.map((entry) => entry.at), [at(3)]);

  await appendFile(moving, `${event('session.resume', { resumeTime: at(5), context: { cwd: other, gitRoot: other, branch: 'ENG-7' } }, 5)}\n${call(6, { session: 'moving', sequence: 4, initiator: 'user' })}\n`);
  await appendFile(arriving, `${event('session.context_changed', { cwd: story, gitRoot: story, branch: 'ENG-7' }, 7)}\n${call(8, { session: 'arriving', sequence: 2, initiator: 'user' })}\n`);
  assert.equal((await syncCopilotSessionUsage(root, { directory: sessions })).added, 1, 'resumed elsewhere: not ours; arrived here: ours');
  assert.deepEqual((await copilotSessionCalls(root, 'ENG-7')).calls.map((entry) => entry.at), [at(3), at(8)]);
});

test('older Copilot versions without per-call records count premium requests and AIU from checkpoint growth', async () => {
  const { root, story, sessions } = await fixture();
  const checkpoint = (minutes, premium, nano) => event('session.usage_checkpoint', { totalPremiumRequests: premium, totalNanoAiu: nano }, minutes);
  await session(sessions, 'older', [start(0, { gitRoot: story, branch: 'ENG-7' }), checkpoint(1, 0, 0), checkpoint(2, 2, 3_000_000_000),
    event('session.resume', { context: { cwd: story, gitRoot: story, branch: 'ENG-7' } }, 3), checkpoint(4, 2, 3_000_000_000), checkpoint(5, 5, 4_000_000_000)]);
  await syncCopilotSessionUsage(root, { directory: sessions });
  const calls = (await copilotSessionCalls(root, 'ENG-7')).calls;
  assert.deepEqual(calls.map(({ at: when, kind, premiumRequests, nanoAiu, inputTokens }) => ({ when, kind, premiumRequests, nanoAiu, inputTokens })), [
    { when: at(2), kind: 'checkpoint', premiumRequests: 2, nanoAiu: 3_000_000_000, inputTokens: null },
    { when: at(5), kind: 'checkpoint', premiumRequests: 3, nanoAiu: 1_000_000_000, inputTokens: null }
  ]);
});

test('a sync reads at most its byte budget, and the next one continues where it stopped', async () => {
  const { root, story, sessions } = await fixture();
  for (const name of ['one', 'two']) {
    await session(sessions, name, [start(0, { gitRoot: story, branch: 'ENG-7' }),
      ...Array.from({ length: 20 }, (_, index) => call(index + 1, { session: name, sequence: index + 1, initiator: index ? 'agent' : 'user' }))]);
  }
  const first = await syncCopilotSessionUsage(root, { directory: sessions, maxBytes: 4096 });
  assert.ok(first.pending >= 1 && first.added < 40, JSON.stringify(first));
  let rounds = 0;
  while ((await syncCopilotSessionUsage(root, { directory: sessions, maxBytes: 4096 })).pending && rounds < 40) rounds += 1;
  const calls = await copilotSessionCalls(root, 'ENG-7');
  assert.equal(calls.calls.length, 40);
  assert.equal(calls.pending, 0);
  assert.equal(calls.calls.reduce((sum, entry) => sum + entry.premiumRequests, 0), 2);
});

function storyWorkflow() {
  const phase = (id, label, fields = {}) => ({ id, label, status: 'approved', generation: 1, usage: [], approvals: [], checks: [],
    telemetry: [{ generation: 1, status: 'pending', captureGap: 'no-metered-session', models: [] }], ...fields });
  return {
    schemaVersion: 2, status: 'in_progress', currentPhase: null,
    workItem: { id: 'ENG-7', title: 'Session logs', workType: 'feature', branch: 'ENG-7' },
    phaseOrder: ['requirements', 'design', 'implementation'],
    phases: {
      requirements: phase('requirements', 'Requirements', { startedAt: at(0), approvedAt: at(60) }),
      design: phase('design', 'Design', { startedAt: at(60), approvedAt: at(300), generation: 2 }),
      implementation: phase('implementation', 'Implementation', { startedAt: at(120), approvedAt: at(400) })
    },
    usage: { byAgent: {}, byPhase: {} }, sequenceOverrides: [],
    history: [
      { at: at(0), event: 'phase_generated', phase: 'requirements' },
      { at: at(60), event: 'phase_approved', phase: 'requirements' },
      { at: at(120), event: 'phase_approved', phase: 'design' },
      { at: at(150), event: 'phase_telemetry_reconciled', phase: 'design' },
      { at: at(200), event: 'phase_rejected', phase: 'implementation', detail: 'CR-001 returned to design: the diagram is missing' },
      { at: at(300), event: 'phase_approved', phase: 'design' },
      { at: at(400), event: 'phase_approved', phase: 'implementation' }
    ]
  };
}

test('a report places each call in the phase worked on then, shows premium requests and cache hits, and never counts twice', async () => {
  const { root, story, sessions } = await fixture();
  await session(sessions, 'work', [
    start(-10, { gitRoot: story, branch: 'ENG-7' }),
    call(-5, { session: 'work', sequence: 1, initiator: 'user' }), // before the Story began
    call(90, { session: 'work', sequence: 2, initiator: 'user', model: 'model-premium-2', input: 2000, cached: 1500, written: 400, cost: 3, nano: 900_000_000 }),
    call(91, { session: 'work', sequence: 3 }), // design
    call(160, { session: 'work', sequence: 4, initiator: 'user' }), // design completed at 120: implementation, despite the reconcile at 150
    call(250, { session: 'work', sequence: 5, initiator: 'user' }), // returned to design at 200
    call(350, { session: 'work', sequence: 6, initiator: 'sub-agent' }), // design completed at 300: implementation
    call(450, { session: 'work', sequence: 7, initiator: 'user' }) // after the last phase completed
  ]);
  const copilotSessions = await storyCopilotSessions(root, storyWorkflow(), { sync: true, directory: sessions });
  // Copilot Chat's own count of the same design work, and of requirements, which the logs do not cover.
  const chatRequest = (minutes) => ({ trace: `t${minutes}`, at: at(minutes), model: 'model-alpha-1.5', modelCalls: 2, inputTokens: 500, outputTokens: 10,
    cachedInputTokens: 100, cacheWriteInputTokens: null, nanoAiu: 50_000_000, failed: false });
  const copilotChat = { since: at(0), syncedAt: at(500), requests: [chatRequest(30), chatRequest(90)] };
  const report = deriveReport(storyWorkflow(), { now: at(500), premiumMultipliers: { 'model-alpha-1.5': 1 }, copilotChat, copilotSessions });
  const [requirements, design, implementation] = report.phases;

  assert.equal(requirements.copilot.sessions, null);
  assert.deepEqual(requirements.copilot.requests, { value: 1, status: 'observed' }, 'Copilot Chat counts where the logs have nothing');
  assert.deepEqual(requirements.copilot.premiumRequests, { value: 1, status: 'estimated', missingModels: [] });
  assert.deepEqual(design.copilot.requests, { value: 2, status: 'observed' }, 'the logs\' two person requests; Copilot Chat\'s is not added');
  assert.deepEqual(design.copilot.modelCalls, { value: 3, status: 'observed' });
  assert.deepEqual(design.copilot.premiumRequests, { value: 4, status: 'observed', missingModels: [] });
  assert.deepEqual(design.copilot.billedAiu, { value: 1.1, status: 'observed' });
  assert.deepEqual(design.copilot.uncaptured, {}, 'a covered phase is not told to reconcile');
  assert.deepEqual(design.copilot.sessions, {
    modelCalls: 3, requests: 2, premiumRequests: 4, inputTokens: 4000, cachedInputTokens: 3300, uncachedInputTokens: 700,
    cacheWriteInputTokens: 500, outputTokens: 120, cacheHitShare: 82.5, aiu: 1.1, sessions: 1, intervalsWithoutCalls: 0,
    byModel: [
      { model: 'model-premium-2', modelCalls: 1, requests: 1, premiumRequests: 3, inputTokens: 2000, cachedInputTokens: 1500, uncachedInputTokens: 500,
        cacheWriteInputTokens: 400, outputTokens: 40, cacheHitShare: 75, aiu: 0.9 },
      { model: 'model-alpha-1.5', modelCalls: 2, requests: 1, premiumRequests: 1, inputTokens: 2000, cachedInputTokens: 1800, uncachedInputTokens: 200,
        cacheWriteInputTokens: 100, outputTokens: 80, cacheHitShare: 90, aiu: 0.2 }
    ]
  });
  assert.deepEqual(implementation.copilot.premiumRequests, { value: 1, status: 'observed', missingModels: [] });
  assert.equal(implementation.copilot.sessions.modelCalls, 2);

  const summary = report.copilot.sessions;
  assert.equal(summary.found, true);
  assert.deepEqual(summary.coveredPhases, ['design', 'implementation']);
  assert.equal(summary.callsOutsideStory, 2);
  assert.equal(summary.premiumRequests, 5);
  assert.equal(summary.modelCalls, 5);
  assert.equal(summary.cacheHitShare, 85);
  assert.deepEqual(report.copilot.premiumRequests, { value: 6, status: 'estimated', missingModels: [] }, 'Copilot\'s count beside an estimate');
  assert.deepEqual(report.copilot.billedAiu, { value: 1.35, status: 'observed' }, 'requirements from Copilot Chat, the rest from the logs');
  assert.deepEqual(report.copilot.uncaptured, {});
  assert.deepEqual(report.copilot.captureNotes, []);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /## Copilot premium requests and cache use\n\n5 premium requests · 3 requests you sent · 5 model calls · 6,000 input tokens, 85% read from Copilot's cache · 1\.3 AIU/);
  assert.match(markdown, /\| Design \(`design`\) \| 4 \| 2 \| 3 \| 4,000 \| 3,300 \| 700 \| 500 \| 120 \| 82\.5% \| 1\.1 \|/);
  assert.match(markdown, /\| Requirements \(`requirements`\) \| — \| — \|/);
  assert.match(markdown, /\| model-premium-2 \| 3 \| 1 \| 1 \| 2,000 \| 1,500 \| 500 \| 40 \| 75% \| 0\.9 \|/);
  assert.match(markdown, /Never counted twice: in `design`, `implementation` these logs are the only source/);
  assert.match(markdown, /2 model calls on this branch fell before the Story began or after it finished/);
  assert.doesNotMatch(markdown, /telemetry reconcile/);
  const html = renderHtml(report);
  assert.match(html, /<h2>Copilot premium requests and cache use<\/h2>/);
  assert.match(html, /<td>82\.5%<\/td>/);
  assert.equal(JSON.parse(JSON.stringify(report)).copilot.sessions.byModel.length, 2, 'the JSON carries the by-model breakdown');
});

test('when Copilot\'s session logs hold nothing for a Story, the report says why in plain words', async () => {
  const { root, other, story, sessions } = await fixture();
  const workflow = storyWorkflow();
  const reason = async (options) => {
    const copilotSessions = await storyCopilotSessions(root, workflow, options);
    const report = deriveReport(workflow, { now: at(500), copilotSessions });
    return [report.copilot.sessions.reason, report.copilot.sessions.explanation, renderMarkdown(report)];
  };
  let [code, text, markdown] = await reason({ sync: true, directory: path.join(sessions, 'missing') });
  assert.equal(code, 'no-session-logs');
  assert.match(text, /no Copilot CLI or VS Code Copilot agent session has run here/);
  assert.match(markdown, /## Copilot premium requests and cache use\n\n_Copilot's session logs: Copilot has written no session logs/);
  [code] = await reason({ sync: false, directory: sessions });
  assert.equal(code, 'not-read');

  await session(sessions, 'elsewhere', [start(0, { gitRoot: other, branch: 'ENG-7' }), call(30, { session: 'elsewhere', sequence: 1, initiator: 'user' })]);
  [code] = await reason({ sync: true, directory: sessions });
  assert.equal(code, 'no-repository-session');
  await session(sessions, 'main-work', [start(0, { gitRoot: root, branch: 'main' }), call(30, { session: 'main-work', sequence: 1, initiator: 'user' })]);
  [code, text] = await reason({ sync: true, directory: sessions });
  assert.equal(code, 'no-branch-session');
  assert.equal(text, 'Copilot\'s session logs: no Copilot session on this computer has worked on branch `ENG-7` in this repository.');
  await session(sessions, 'too-late', [start(0, { gitRoot: story, branch: 'ENG-7' }), call(450, { session: 'too-late', sequence: 1, initiator: 'user' })]);
  [code, text] = await reason({ sync: true, directory: sessions });
  assert.equal(code, 'outside-story');
  assert.match(text, /Copilot made 1 model call on branch `ENG-7`, all before this Story began or after it finished\./);
  assert.equal(deriveReport(workflow, { now: at(500) }).copilot.sessions, null, 'a caller that did not read the logs gets no claim about them');
});

test('telemetry sessions shows what was found and sync records it, only in a repository that uses SFlow', async () => {
  const { root, story, sessions } = await fixture();
  await session(sessions, 'cli', [start(0, { gitRoot: story, branch: 'ENG-7' }), call(1, { session: 'cli', sequence: 1, initiator: 'user' }), call(2, { session: 'cli', sequence: 2 })]);
  const env = { ...process.env, SINGULARITY_FLOW_COPILOT_SESSION_STATE: sessions };
  const run = (...args) => spawnSync(process.execPath, [cli, 'telemetry', 'sessions', ...args], { cwd: root, env, encoding: 'utf8' });

  let result = run('sync', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sync.status, 'not-governed');
  assert.equal(JSON.parse(result.stdout).following, false, 'nothing is written into a repository that does not use SFlow');

  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'schemaVersion: 1\n');
  result = run('sync', '--json');
  assert.equal(result.status, 0, result.stderr);
  const synced = JSON.parse(result.stdout);
  assert.equal(synced.sync.added, 2);
  assert.equal(synced.sessions.matched, 1);
  assert.equal(synced.sessions.calls, 2);

  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /This repository: 1 session of 1, 2 model calls on 1 branch; read since /);
  result = run('tidy');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Unknown telemetry sessions action: tidy/);
});

// [owner, 2026-10-16]: work never reads Copilot's telemetry or session logs. Only the report, the
// snapshot behind Story Analytics and the telemetry utility reach this module.
test('no work command, hook or skill reaches the session usage reader', async () => {
  const allowed = new Set(['src/copilot-session-usage.mjs', 'src/commands/report.mjs', 'src/commands/telemetry.mjs', 'src/editor.mjs']);
  const files = [];
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(path.join(packageRoot, directory), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !['node_modules', 'dist', 'build'].includes(entry.name)) await walk(relative);
      else if (entry.isFile() && /\.(?:mjs|cjs|js|ts|json|md|ya?ml|sh|ps1)$/u.test(entry.name)) files.push(relative);
    }
  };
  for (const directory of ['src', 'bin', 'plugin', 'templates', 'scripts', 'apps/vscode/src', 'apps/intellij/src']) await walk(directory);
  assert.ok(files.includes('plugin/hooks.json') && files.some((file) => file.startsWith('plugin/skills/')));
  const reaching = [];
  for (const file of files) {
    // A module specifier naming it, or one of its readers: a comment pointing at the file is not a use.
    if (/['"`][^'"`\n]*copilot-session-usage(?:\.mjs)?['"`]|syncCopilotSessionUsage|storyCopilotSessions|copilotSessionCalls/u
      .test(await readFile(path.join(packageRoot, file), 'utf8'))) reaching.push(file);
  }
  assert.deepEqual(reaching.filter((file) => !allowed.has(file)), []);
  // The readers load it only when they run: nothing that imports them statically gets it.
  for (const file of ['src/commands/report.mjs', 'src/commands/telemetry.mjs', 'src/editor.mjs']) {
    assert.doesNotMatch(await readFile(path.join(packageRoot, file), 'utf8'), /^import[^;]*copilot-session-usage/mu, `${file} imports it eagerly`);
  }
});
