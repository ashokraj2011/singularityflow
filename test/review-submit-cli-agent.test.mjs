import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { boundedAgentOutput } from '../src/agent-output.mjs';

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
  const next = part.match(/"(?:next|actNext)":"[a-z-]+: (?:run |show the person |ask the person in this chat, and only on an explicit yes run )?((?:\\"|[^"])*?)(?:; never run it)?"\}?\s*$/mu);
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
  assert.equal(checked.act.do.shell, `singularity-flow review-source submit ${phaseId} --report-file ${packet.stagingPath} --for-agent --json`);
  assertSurvivesEveryCut(check, 'check');

  const submit = cli(...checked.act.do.shell.replace(/^singularity-flow /u, '').split(' '));
  const submitted = JSON.parse(submit);
  assert.equal(submitted.resultType, 'source-review-status');
  assert.ok(submitted.reportSha256);
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
  assert.equal(keptView.reportSha256, submitted.reportSha256);
  assertSurvivesEveryCut(kept, 'result last');

  // Another command's words never return the submit's result.
  const other = JSON.parse(cli('result', 'last', '--command', 'choices answer', '--for-agent', '--json'));
  assert.equal(other.status, 'none');
  assert.equal(other.act.do.shell, 'singularity-flow nextsteps --for-agent --json');
  assert.equal(other.reportSha256, undefined);
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
