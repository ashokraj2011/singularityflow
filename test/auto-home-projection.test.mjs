import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildResultCard } from '../apps/vscode/src/views/result-card-model.ts';
import { resultCardHtml } from '../apps/vscode/src/views/result-card-page.ts';
import { autoHomeSummary } from '../src/gateway/auto-home-summary.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';
import { workReturnResult } from '../src/gateway/planners/work-return.mjs';
import {
  createAutoFlightState, mutateAutoFlightState, persistAutoFlightReport
} from '../src/auto/auto-flight-store.mjs';
import {
  persistAutoAttempt, persistAutoHumanRequest, persistAutoRefusal
} from '../src/auto/auto-p1-records.mjs';
import { gitCommonDir } from '../src/git.mjs';

const FLIGHT = `AFL-${'A'.repeat(26)}`;
const TAKEOVER = `AFL-${'B'.repeat(26)}`;
const HASH = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  const flight = await createAutoFlightState(root, {
    flightId: FLIGHT, planId: `APL-${'C'.repeat(26)}`, planSha256: HASH('c'),
    status: 'waiting-human', story: { workId: 'AUTO-HOME', branch: 'AUTO-HOME', phase: 'implementation' },
    worktree: root, execution: { ceilings: {} }, nextAction: 'Review the typed request.'
  });
  const attempt = await persistAutoAttempt(root, {
    flightId: FLIGHT, phase: 'implementation', attemptNumber: 1,
    attemptKind: 'initial', parentAttemptId: null, reason: 'phase-entry',
    generationIntentSha256: HASH('1'), taskContractSha256: HASH('2'),
    contextManifestSha256: HASH('3'), executionUnitManifestSha256: HASH('4'),
    status: 'refused', budgetImpact: {}, result: null
  });
  const refusal = await persistAutoRefusal(root, {
    flightId: FLIGHT, phase: 'implementation', attemptId: attempt.attemptId,
    gate: 'verification', code: 'TEST_FAILED', subject: { candidateSha256: HASH('5') },
    missing: [{ evidence: 'passing tests' }], preserved: { paths: ['src/app.mjs'] },
    repair: { eligibility: 'ask-only', scope: ['src/app.mjs'], maximumAttempts: 1 },
    primaryNextAction: { operation: 'auto.repair', label: 'Review repair' }
  });
  const request = await persistAutoHumanRequest(root, {
    flightId: FLIGHT, phase: 'implementation', attemptId: attempt.attemptId,
    requestType: 'architecture-choice', title: 'Choose storage', detail: { reason: 'material' },
    options: [{ id: 'sql' }, { id: 'document' }], subjectSha256: HASH('6'),
    policySha256: HASH('7'), checkpointSha256: HASH('8'), status: 'open', response: null
  });
  await mutateAutoFlightState(root, FLIGHT, (state) => {
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.openHumanRequestIds = [request.requestId];
  });

  let takeover = await createAutoFlightState(root, {
    flightId: TAKEOVER, planId: `APL-${'D'.repeat(26)}`, planSha256: HASH('d'),
    status: 'manual-takeover', story: { workId: 'OTHER-STORY', branch: 'OTHER-STORY', phase: 'planning' },
    worktree: root, execution: { ceilings: {} }, nextAction: 'Continue manually.'
  });
  const report = await persistAutoFlightReport(root, takeover);
  takeover = await mutateAutoFlightState(root, TAKEOVER, (state) => {
    state.finalReportSha256 = report.reportSha256;
  });
  return { root, flight, refusal, request, takeover, report };
}

function homeResult(auto) {
  const item = {
    kind: 'story', id: 'AUTO-HOME', title: 'Auto Home', phase: 'implementation',
    status: 'in_progress', group: 'active', repositoryId: 'repo', branch: 'AUTO-HOME', rail: []
  };
  return homeOverviewResult({
    workspace: { id: 'workspace', name: 'Workspace' },
    repository: { id: 'repo', branch: 'AUTO-HOME', head: HASH('f').slice(7) },
    records: { items: [item], groups: { active: [item] } },
    current: { workId: item.id, repositoryId: 'repo', branch: item.branch },
    localChanges: { dirty: false, files: 0, worktreeHash: HASH('e'), worktreeAlgorithm: 'v2' },
    otherWorkspaces: 0, auto
  });
}

test('Home and Return show bounded Auto state, Needs You, refusal, takeover, report, and exact CLI next actions', async (t) => {
  const { root, refusal, report } = await fixture(t);
  const auto = await autoHomeSummary(root, { workId: 'AUTO-HOME' });
  assert.equal(auto.availability, 'available');
  assert.equal(auto.total, 2);
  assert.deepEqual(auto.cards.map((card) => card.kind), [
    'status', 'refusal', 'needs-you', 'takeover', 'report'
  ]);
  assert.equal(auto.cards[0].command, `singularity-flow auto needs-you ${FLIGHT}`);
  assert.equal(auto.cards[1].command,
    `singularity-flow auto repair ${FLIGHT} --refusal ${refusal.refusalId}`);
  assert.equal(auto.cards[3].command, `singularity-flow auto report ${TAKEOVER}`);
  assert.equal(auto.cards[4].reportSha256, report.reportSha256);

  const home = homeResult(auto);
  const returned = workReturnResult({
    kind: 'story', id: 'AUTO-HOME', title: 'Auto Home', phase: 'implementation',
    status: 'in_progress', group: 'active', rail: []
  }, { auto, localChanges: { dirty: false, files: 0 } });
  assert.equal(home.effects.stateChanged, false);
  assert.equal(returned.effects.stateChanged, false);
  assert.equal(home.data.auto, auto);
  assert.equal(returned.data.auto, auto);

  const view = buildResultCard(home);
  assert.deepEqual(view.auto.map((card) => card.kind), [
    'status', 'refusal', 'needs-you', 'takeover', 'report'
  ]);
  assert.equal(view.auto[0].actions[0].command, `singularity-flow auto needs-you ${FLIGHT}`);
  const html = resultCardHtml(view);
  assert.match(html, /aria-label="Auto work"/);
  assert.match(html, new RegExp(`auto repair ${FLIGHT} --refusal ${refusal.refusalId}`));
  assert.doesNotMatch(html, /requestSha256|checkpointSha256|absolute path/);

  const runningId = `AFL-${'C'.repeat(26)}`;
  await createAutoFlightState(root, {
    flightId: runningId, planId: `APL-${'C'.repeat(26)}`, planSha256: HASH('c'),
    status: 'running', story: { workId: 'AUTO-RUNNING', branch: 'AUTO-RUNNING', phase: 'implementation' },
    worktree: root, execution: { ceilings: {} }
  });
  const refreshed = await autoHomeSummary(root, { workId: 'AUTO-RUNNING' });
  const running = refreshed.cards.find((card) => card.kind === 'running');
  assert.equal(running.command, `singularity-flow auto pause ${runningId}`,
    'Home never labels an auto status read as Pause');
  assert.deepEqual(buildResultCard(homeResult(refreshed)).auto
    .find((card) => card.kind === 'running').actions.map((action) => action.label), [
    'Prepare pause', 'Prepare takeover', 'Prepare stop'
  ]);
});

test('an unreadable report is shown as unavailable instead of disappearing from Home', async (t) => {
  const { root } = await fixture(t);
  const reportPath = path.join(
    gitCommonDir(root), 'singularity-flow', 'auto-flights', TAKEOVER, 'report.json'
  );
  await writeFile(reportPath, '{"corrupt":true}\n');
  const auto = await autoHomeSummary(root, { workId: 'OTHER-STORY' });
  assert.equal(auto.availability, 'partial');
  const unavailable = auto.cards.find((card) => card.kind === 'unavailable');
  assert.equal(unavailable.status, 'report-unavailable');
  assert.equal(unavailable.command,
    `singularity-flow auto recover OTHER-STORY --flight ${TAKEOVER}`);
  assert.ok(homeResult(auto).warnings.some((warning) => warning.code === 'home.auto-unavailable'));
  const html = resultCardHtml(buildResultCard(homeResult(auto)));
  assert.match(html, /Auto report unavailable/);
  assert.match(html, /auto recover OTHER-STORY/);
});

test('an unreadable flight store makes Home explicitly unavailable rather than claiming zero flights', async (t) => {
  const { root } = await fixture(t);
  const statePath = path.join(
    gitCommonDir(root), 'singularity-flow', 'auto-flights', FLIGHT, 'state.json'
  );
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, '{}\n');
  const auto = await autoHomeSummary(root, { workId: 'AUTO-HOME' });
  assert.equal(auto.availability, 'unavailable');
  assert.equal(auto.total, null);
  assert.deepEqual(auto.cards.map((card) => card.kind), ['unavailable']);
  assert.equal(auto.cards[0].command, 'singularity-flow doctor');

  const home = homeResult(auto);
  assert.ok(home.warnings.some((warning) => warning.code === 'home.auto-unavailable'));
  const view = buildResultCard(home);
  assert.equal(view.auto[0].title, 'Auto status unavailable');
  assert.equal(view.auto[0].actions[0].command, 'singularity-flow doctor');
  assert.match(resultCardHtml(view), /Auto status unavailable/);
});
