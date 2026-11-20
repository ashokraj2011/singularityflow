import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { boundedAgentOutput, completeAgentResult } from '../src/agent-output.mjs';
import { copilotSessionReport, createSessionAttribution } from '../src/native-copilot-sessions.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin/singularity-flow.mjs');
const bytes = (text) => Buffer.byteLength(text, 'utf8');

function cliIn(root, results) {
  return (...args) => {
    const result = spawnSync(process.execPath, [executable, ...args], {
      cwd: root, encoding: 'utf8', timeout: childTimeout(30000),
      env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspace-registry.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json'),
        SINGULARITY_FLOW_AGENT_RESULTS: results }
    });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
}

// The command a part of a view hands the agent: its `next` line, else act's first route.
function visibleCommand(part) {
  // A retained review's next step is the person's (act.show): its line names the author's command after that (fb368d49b).
  const next = part.match(/"(?:next|actNext)":"[a-z-]+: (?:run |show the person |ask the person in this chat, and only on an explicit yes run |end your reply with act\.show for the person; only the step's author runs )?((?:\\"|[^"])*?)(?:; never run it)?"\}?\s*$/mu);
  if (next) return JSON.parse(`"${next[1]}"`);
  const first = part.match(/"do":\{"(?:shell|copilot)":"((?:\\"|[^"])*)"/u);
  return first ? JSON.parse(`"${first[1]}"`) : null;
}

// How each host shows a long result (Copilot runtime 1.0.x and CLI 1.0.107: a saved-file pointer with
// the first 500 characters; older terminals: the head, the head and tail, or the tail), and what the
// agent sees of `text` there. `[]` is a result the host never showed (backgrounded or timed out).
const HOST_CUTS = {
  'pointer and 500-character preview': (text) => [text.slice(0, 500)],
  'head only at 4 KB': (text) => [Buffer.from(text).subarray(0, 4096).toString('utf8')],
  'head and tail, middle dropped': (text) => [text.slice(0, 1024), text.slice(-1024)],
  'tail only at 2 KB': (text) => [text.slice(-2048)],
  'no output': () => []
};

function assertSurvivesEveryCut(text, label) {
  const view = JSON.parse(text);
  assert.ok(bytes(text) <= 4096, `${label}: ${bytes(text)} bytes`);
  const lead = view.act.do?.shell && / --json(?=\s|$)/u.test(view.act.do.shell) && !/<[A-Z]+>/u.test(view.act.do.shell)
    ? view.act.do.shell : view.act.do?.copilot ?? view.act.do?.shell ?? null;
  // The state and the one command are in the first 400 bytes, and the last line repeats them.
  const head = Buffer.from(text).subarray(0, 400).toString('utf8');
  assert.match(head, new RegExp(`"state":"${view.act.state}"`, 'u'), `${label}: state past 400 bytes`);
  if (lead) assert.ok(head.includes(JSON.stringify(lead).slice(1, -1)), `${label}: the command is past the first 400 bytes\n${head}`);
  const lastLine = text.trimEnd().split('\n').at(-1);
  assert.match(lastLine, new RegExp(`^"next":"${view.act.state}: `, 'u'), `${label}: last line ${lastLine}`);
  if (lead) assert.ok(lastLine.includes(JSON.stringify(lead).slice(1, -1)), `${label}: the last line names another command`);
  for (const [style, cut] of Object.entries(HOST_CUTS)) {
    const parts = cut(text);
    if (!parts.length) continue;
    // Every part the host shows gives the same next command, or the act state when none is to run.
    for (const part of parts) {
      if (lead) assert.equal(visibleCommand(part), lead, `${label} / ${style}`);
      else assert.match(part, new RegExp(`"state":"${view.act.state}"|"next":"${view.act.state}: `, 'u'), `${label} / ${style}`);
    }
  }
  return lead;
}

test('check, submit, status and result last hand the agent what comes after retention, in a view every host cut keeps', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const results = await mkdtemp(path.join(os.tmpdir(), 'sflow-kept-'));
  t.after(() => rm(results, { recursive: true, force: true }));
  const cli = cliIn(root, results);
  const packet = JSON.parse(cli('review-source', 'context', phaseId, '--json'));
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, JSON.stringify(reviewReport(packet)));

  const check = cli('review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json');
  const checked = JSON.parse(check);
  assert.equal(checked.act.state, 'retain');
  // The retain route returns the agent view: before, it printed the retained review whole, past the host's cut.
  // The staged report is the file SFlow issued: its submit needs no --report-file [owner, 2026-11-20].
  assert.equal(checked.act.do.shell, `singularity-flow review-source submit ${phaseId} --for-agent --json`);
  assertSurvivesEveryCut(check, 'check');

  const submit = cli(...checked.act.do.shell.replace(/^singularity-flow /u, '').split(' '));
  const submitted = JSON.parse(submit);
  // The retained review's status, with its report's digest. Its act (with the next step's show line, 2026-11-16) fills
  // the view, so a bounded view keeps the other fields in its file (agentOutput), where the whole result is read; what
  // the result is and says (resultType, status) stays in the view (the next test).
  const retained = completeAgentResult(submitted);
  assert.equal(retained.resultType, 'source-review-status', submit);
  assert.equal(submitted.resultType, retained.resultType, submit);
  assert.ok(retained.reportSha256);
  assert.equal(submitted.act.state, 'next');
  // A retained review with a pending disposition goes to the person's decision, never back to retention.
  assert.match(submitted.act.do.copilot, new RegExp(`^/sf-review-decide ${phaseId} `, 'u'));
  assert.notEqual(submitted.act.state, 'retain');
  assert.doesNotMatch(JSON.stringify(submitted.act.do), /review-source submit/u);
  assert.doesNotMatch(submitted.next, /review-source submit/u);
  const lead = assertSurvivesEveryCut(submit, 'submit');
  assert.equal(lead, submitted.act.do.copilot);

  const status = cli('review-source', 'status', phaseId, '--for-agent', '--json');
  assert.deepEqual(JSON.parse(status).act, submitted.act);
  assertSurvivesEveryCut(status, 'status');

  // A cut (or never shown) submit is read back as itself, never run again.
  const kept = cli('result', 'last', '--command', `review-source submit ${phaseId}`, '--for-agent', '--json');
  const keptView = JSON.parse(kept);
  assert.deepEqual(keptView.act, submitted.act);
  assert.equal(completeAgentResult(keptView).reportSha256, retained.reportSha256);
  assertSurvivesEveryCut(kept, 'result last');

  // Another command's words never return the submit's result.
  const other = JSON.parse(cli('result', 'last', '--command', 'choices answer', '--for-agent', '--json'));
  assert.equal(other.status, 'none');
  assert.equal(other.act.do.shell, 'singularity-flow nextsteps --for-agent --json');
  assert.equal(other.reportSha256, undefined);
});

// Copilot's session-state keeps each tool result as the agent saw it: for SFlow, the --for-agent view. The usage report
// counts a /sf-review-source run finished from that view (native-copilot-sessions.mjs), so a review kept behind a bounded
// view (act's show line fills it, fb368d49b) went uncounted twice over: the view left out resultType and status, and the
// report counted only a ready review, while this kept one waits on a person's decision (correction-required). The owner's
// decision of 2026-11-17, "count everything": every kept review is a finished run, whatever it found.
test('a review kept behind a bounded agent view counts as a finished /sf-review-source run in the session report', async (t) => {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const results = await mkdtemp(path.join(os.tmpdir(), 'sflow-kept-'));
  t.after(() => rm(results, { recursive: true, force: true }));
  const cli = cliIn(root, results);
  const packet = JSON.parse(cli('review-source', 'context', phaseId, '--json'));
  await mkdir(path.dirname(packet.stagingPath), { recursive: true });
  await writeFile(packet.stagingPath, JSON.stringify(reviewReport(packet)));
  const check = cli('review-source', 'check', phaseId, '--report-file', packet.stagingPath, '--for-agent', '--json');
  const submitCommand = JSON.parse(check).act.do.shell;
  const submit = cli(...submitCommand.replace(/^singularity-flow /u, '').split(' '));
  const view = JSON.parse(submit);
  const retained = completeAgentResult(view);
  assert.equal(view.agentOutput?.view, 'bounded', 'the case: the rest of the retained review is in the view\'s file');
  assert.ok(bytes(submit) <= 4096, `${bytes(submit)} bytes`);
  assert.ok(retained.reportSha256, 'the review is retained');
  // The run as Copilot records it: the person's /sf-review-source, then the check and the submit in its shell.
  const session = createSessionAttribution('55555555-0000-4000-8000-000000000005');
  const at = (index) => `2026-11-17T10:00:${String(index).padStart(2, '0')}.000Z`;
  const usage = (initiator) => ({ type: 'session.usage_record', data: { usage: { model: 'fixture-model', initiator,
    inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cost: 1 } } });
  const shell = (id, command, output) => [
    { type: 'tool.execution_start', data: { toolCallId: id, toolName: 'bash', arguments: { command } } },
    { type: 'tool.execution_complete', data: { toolCallId: id, success: true, result: { content: `${output.trimEnd()}\n<exited with exit code 0>` } } },
    usage('agent')];
  const events = [
    { type: 'session.start', data: { copilotVersion: '1.0.107', startTime: at(0) } },
    { type: 'skill.invoked', data: { name: 'sflow-review-source', content: 'SKILL', trigger: 'user-invoked' } },
    { type: 'user.message', data: { content: `/sf-review-source ${phaseId}` } },
    usage('user'),
    ...shell('check', `singularity-flow review-source check ${phaseId} --report-file ${packet.stagingPath} --for-agent --json`, check),
    ...shell('submit', submitCommand, submit)
  ];
  events.forEach((event, index) => session.push(JSON.stringify({ ...event, id: `e${index}`, timestamp: at(index) })));
  const report = copilotSessionReport([session.finish()]);
  assert.equal(report.resultTypes.sflowResults['source-review-status']?.results, 1, JSON.stringify(report.resultTypes));
  assert.deepEqual([report.tasks.bySkill['sf-review-source'].tasks, report.tasks.bySkill['sf-review-source'].finished], [1, 1],
    `the kept review (${retained.status}) is a finished /sf-review-source run`);
  // Who the result is and what it says stay in the view, before any optional field.
  assert.equal(view.resultType, 'source-review-status', submit);
  assert.equal(view.status, retained.status, submit);
});

test('a long refusal is at most 4 KB, leads with its repair and ends on it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-long-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', root]);
  const refusal = { schemaVersion: 1, ok: false, error: { code: 'SCOPE_ITEMS_UNRESOLVED', message: `Scope items are open: ${'REQ-0001 '.repeat(900)}` },
    remediationPlan: { steps: [{ kind: 'repair', label: 'Decide the open statements', reason: 'The step is held by its open statements.',
      command: 'singularity-flow choices begin decide SFLOW-1 --for-agent --json', copilotCommand: '/sf-decide SFLOW-1' }] },
    blockers: Array.from({ length: 60 }, (_, index) => ({ id: `REQ-${String(index).padStart(4, '0')}`, detail: 'x'.repeat(120) })) };
  const view = await boundedAgentOutput(JSON.stringify(refusal, null, 2), { cwd: root });
  assert.equal(assertSurvivesEveryCut(view, 'long refusal'), 'singularity-flow choices begin decide SFLOW-1 --for-agent --json');
});
