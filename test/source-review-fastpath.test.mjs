import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { completeAgentResult } from '../src/agent-output.mjs';
import { scopedUtilityRead } from '../src/utility-entry.mjs';
import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const engine = fileURLToPath(new URL('..', import.meta.url));

test('paired measurement requires a baseline and balanced sample order before starting any fixture', () => {
  const script = path.join(engine, 'scripts/source-review-paired-benchmark.mjs');
  for (const args of [[], ['--baseline-engine=.', '--samples=3'], ['--baseline-engine=.', '--samples=0']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: childTimeout(10_000) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baseline-engine|even sample count/u);
  }
});

test('review readers cannot statically pull in phase authoring or lifecycle publication writers', async () => {
  const visited = new Set();
  const forbidden = new Set(['src/state.mjs', 'src/state-stores.mjs', 'src/phase-entry.mjs',
    'src/publication-unit-of-work.mjs', 'src/collaboration.mjs']);
  async function walk(file) {
    if (visited.has(file)) return;
    assert.ok(!forbidden.has(file), `review read eagerly reaches ${file}`);
    visited.add(file);
    const source = await readFile(path.join(engine, file), 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/gu)) {
      await walk(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  await walk('src/commands/review-source.mjs');
  await walk('src/source-review-agent-context.mjs');
  assert.ok(visited.size < 260, `review read closure grew to ${visited.size} local modules`);
});

test('only exact read forms share a review command scope; writers and override flags never do', () => {
  for (const [action, options] of [['context', { json: true, 'for-agent': true }],
    ['status', { json: true }], ['check', { json: true, 'report-file': '/issued/report.json' }]]) {
    assert.equal(scopedUtilityRead(['review-source', action, 'team-scope'], options), true);
    assert.equal(scopedUtilityRead(['review-source', action, 'team-scope'], { ...options, yes: true }), false);
  }
  for (const action of ['stage', 'submit', 'decide', 'unknown']) {
    assert.equal(scopedUtilityRead(['review-source', action, 'team-scope'], { json: true }), false);
  }
});

test('native review context/check/status avoid full catalog accounting and retention still rebinds fresh', { timeout: 120_000 }, async t => {
  const { root, phaseId } = await publishedSpecificationStory(t, { humanAnswers: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-read-scope-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_GIT_FACT_STORE: path.join(directory, 'facts'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json') };
  delete env.SINGULARITY_FLOW_NO_MODEL;
  function invoke(action, flags = []) {
    const result = spawnSync(process.execPath, [path.join(engine, 'bin/singularity-flow.mjs'),
      'review-source', action, phaseId, ...flags, '--json', '--timings'], {
      cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: childTimeout(90_000)
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const counter = name => Number(result.stderr.match(new RegExp(`(?:^|\\s)${name.replaceAll('.', '\\.')}=([0-9]+)(?=\\s|$)`))?.[1] ?? 0);
    assert.equal(counter('configuration.definition-load'), 1, 'only the authoritative Story bootstrap loads a definition');
    assert.equal(counter('configuration.template-checks'), 0, 'accounting never validates unrelated templates');
    assert.equal(counter('catalog.scans'), 0, 'accounting never scans the current agent catalog');
    if (['context', 'check', 'status'].includes(action)) assert.equal(counter('configuration.source-read'), 1);
    return { packet: completeAgentResult(result.stdout), counter };
  }
  const head = () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const before = head();
  const { packet } = invoke('context', ['--for-agent']);
  assert.equal(packet.canReview, true);
  const report = reviewReport(packet);
  report.clarificationsReviewed = packet.clarifications.map(entry => entry.id);
  invoke('stage', ['--report-json', JSON.stringify(report)]);
  const checked = invoke('check', ['--report-file', packet.stagingPath]).packet;
  assert.equal(checked.retentionReady, true);
  assert.equal(head(), before, 'read/stage/check do not publish or change the Story');
  const retained = invoke('submit', ['--report-file', packet.stagingPath]);
  assert.equal(retained.counter('source-review.fresh-bindings'), 1);
  assert.equal(retained.counter('source-review.input-loads'), 3, 'initial/fresh/post-commit inputs remain independent');
  assert.equal(retained.packet.status, checked.evaluation.status,
    'retention preserves the independent semantic verdict, including honest correction-required findings');
  assert.ok(retained.packet.continuation.actions.length, 'retention returns status and next actions without a follow-up status call');
  assert.equal(invoke('status').packet.reportSha256, retained.packet.reportSha256);
});
