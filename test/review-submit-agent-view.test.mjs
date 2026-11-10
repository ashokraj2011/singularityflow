/**
 * The owner's own run (2026-11-10, main e60f3f342): planning's review was retained, but the submit's JSON was cut
 * by the host, `result last` returned the earlier `review-source check` (still "retain"), and the agent told the
 * person to submit again. Now the submit takes --for-agent (bounded and kept), its agent view and a retained
 * status lead with what comes after retention, and `result last --command` never answers with another command.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { beginAgentResult, keepAgentResult, lastAgentResult } from '../src/agent-result-keeper.mjs';
import { agentAct, withAgentRoutes } from '../src/agent-output.mjs';
import { interpretsForAgent } from '../src/cli-json-output.mjs';
import { keptResultView } from '../src/commands/result.mjs';

const SUBMIT = 'singularity-flow review-source submit planning --report-file .sflow/review/planning.json --json';

test('the check\'s retain route runs the submit with --for-agent, an output-only flag', async () => {
  assert.equal(interpretsForAgent(['review-source', 'submit']), false, 'the CLI removes it before the submit reads its options');
  const routed = await withAgentRoutes({ act: { state: 'retain', do: { shell: SUBMIT } } });
  assert.equal(routed.act.do.shell, 'singularity-flow review-source submit planning --report-file .sflow/review/planning.json --for-agent --json');
});

test('a retained review leads with what comes after retention, never retain or submit again', () => {
  const retained = (classification, action) => ({ resultType: 'source-review-status', phase: 'planning', reportSha256: 'a'.repeat(64),
    status: classification === 'submission-required' ? 'ready' : 'correction-required', findings: [], pendingDispositions: [],
    continuation: { classification, actions: [action] } });
  for (const [classification, action] of [
    ['successor-publication-required', { skill: '/sf-plan', command: 'singularity-flow prepare planning', reason: 'Resume the phase author and prepare generation 2.' }],
    ['submission-required', { skill: '/sf-submit', command: 'singularity-flow submit planning --work-id W-1', reason: 'Submit the reviewed publication.' }],
    ['human-disposition-required', { skill: '/sf-review-decide', command: 'singularity-flow review-source decision-context planning --work-id W-1 --finding F-1 --reason <TEXT> --json', reason: 'A person decides it.' }]]) {
    const act = agentAct(retained(classification, action));
    assert.notEqual(act.state, 'retain', classification);
    assert.ok([act.do?.shell, act.do?.copilot].some((route) => route && (route.includes(action.command.split(' ').slice(1, 3).join(' ')) || route.startsWith(action.skill))), `${classification}: ${JSON.stringify(act.do)}`);
    assert.doesNotMatch(JSON.stringify(act.do ?? {}), /review-source submit/u, classification);
  }
});

test('`result last --command` answers none, with the safe read, rather than another command\'s result', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-result-command-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, SINGULARITY_FLOW_AGENT_RESULTS: path.join(base, 'results') };
  const handle = beginAgentResult(['review-source', 'check', 'planning', '--for-agent', '--json'], { cwd: base, env });
  keepAgentResult(handle, JSON.stringify({ resultType: 'source-review-check', retentionReady: true }));
  const any = await lastAgentResult({ cwd: base, env });
  assert.equal(any.status, 'kept', 'the check was kept');
  const submit = await lastAgentResult({ cwd: base, env, command: 'review-source submit planning' });
  assert.equal(submit.status, 'none', 'never the check, as if it were the submit');
  const view = keptResultView(submit, { command: 'review-source submit planning' });
  assert.equal(view.safeRead, 'singularity-flow review-source status planning --for-agent --json');
  assert.equal(agentAct(view).do.shell, view.safeRead);
  assert.equal(keptResultView({ status: 'none' }, { command: 'choices answer R-1 phase-confirmation specification' }).safeRead, 'singularity-flow nextsteps --for-agent --json');
});
