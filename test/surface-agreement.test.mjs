/**
 * Two surfaces that answer the same question give the same answer, at every lifecycle state.
 *
 * The gateway (sflow_read, VS Code cards) and the CLI work out readiness and the next step on their
 * own. Each passed its own fixtures while they disagreed on a published, unsubmitted step: the
 * gateway said "publish required artifacts" and `status --submission-readiness` said ready
 * (1521125f). One Story walks through its states here, and both are asked at each one.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { CLI, implementationPlan, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'AGREE-1';

/** The gateway's readiness answer, through the kernel as sflow_resolve and sflow_read reach it. */
async function gatewayReadiness(root, label) {
  const { kernel } = createHostGateway({ root, hostSessionId: `agree-ready-${label}`, planners: gatewayPlanners() });
  const resolved = await kernel.resolve({ utterance: 'am I ready', goalHint: 'work.ready', subject: { workId: WORK } });
  assert.equal(resolved.kind, 'read', `${label}: readiness resolves to a read`);
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(read.operation.id, 'work.readiness', label);
  return read.data;
}

/** The gateway's recommended next step, in the model mode a host serves. */
async function gatewayRecommendation(root, label, routeModelMode) {
  const { kernel } = createHostGateway({ root, hostSessionId: `agree-next-${label}`, planners: gatewayPlanners(), routeModelMode });
  const resolved = await kernel.resolve({ utterance: 'what should I do next' });
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(read.operation.id, 'developer.next', label);
  const recommended = read.next.find((action) => action.id === 'developer:recommended');
  assert.ok(recommended, `${label}: developer.next recommends a step`);
  return { command: recommended.fallback.command, skill: recommended.fallback.skill };
}

async function agree(story, label) {
  const { root, run } = story;
  const json = (args) => {
    const result = run(process.execPath, [CLI, ...args]);
    return JSON.parse(result.stdout);
  };
  const cli = json(['--no-model', 'status', WORK, '--submission-readiness', '--json']);
  const gateway = await gatewayReadiness(root, label);
  const published = gateway.verification.find((row) => row.id === 'published-artifacts');

  // The step and generation being judged.
  assert.deepEqual([gateway.phase, gateway.generation], [cli.phaseId, cli.currentGeneration], `${label}: same step and generation`);

  // "Is the current generation published?" `publicationRecorded` is the CLI's answer; the gateway's
  // is its published-artifacts row. Nothing here edits a document after publishing it, so a
  // published generation's bytes are also unchanged.
  assert.equal(published.slots.published === 'true', cli.publicationRecorded, `${label}: published? ${JSON.stringify(published)}`);
  if (cli.publicationRecorded) assert.equal(published.state, 'met', `${label}: published bytes unchanged`);

  // "Can it be submitted?" The CLI's lifecycle readiness is the gateway's: no lifecycle blocker and
  // the published-artifacts row met. The gateway's other rows (tests, approvals, clarifications…)
  // are checks the CLI defers to submit; only where they all pass is the whole answer the same.
  if (cli.phaseStatus === 'in_progress') {
    assert.equal(gateway.blockers.length === 0 && published.state === 'met', cli.lifecycleReady,
      `${label}: submittable? CLI ${cli.classification}, gateway blockers ${JSON.stringify(gateway.blockers)}`);
    const deferred = gateway.verification.filter((row) => row.id !== 'published-artifacts');
    if (deferred.every((row) => row.state === 'met')) assert.equal(gateway.ready, cli.lifecycleReady, `${label}: ready`);
  }
  // "Is it waiting for approval?"
  assert.equal(cli.classification === 'already-submitted',
    gateway.blockers.some((entry) => entry.blocker === 'approvals-outstanding'), `${label}: awaiting approval`);

  // "What is the next step?" developer.next takes nextsteps' first `now` action, in the model mode the
  // host serves; both modes are compared, since the model adds steps (World Model grounding first).
  for (const [mode, args, routeModelMode] of [
    ['model on', ['nextsteps', WORK, '--json'], { enabled: true, source: 'default' }],
    ['model off', ['--no-model', 'nextsteps', WORK, '--json'], { enabled: false, source: 'environment' }]
  ]) {
    const now = json(args).actions.find((action) => action.timing === 'now');
    assert.ok(now, `${label} ${mode}: nextsteps has a step to take now`);
    assert.deepEqual(await gatewayRecommendation(root, `${label}-${mode}`, routeModelMode),
      { command: now.command, skill: now.skill }, `${label} ${mode}: same next step`);
  }
}

test('the CLI and the gateway agree on readiness and the next step at every lifecycle state', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await startedSpecificationStory(t, WORK);
  const { cli, git, item } = story;
  await agree(story, 'specification, nothing published');

  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  await agree(story, 'specification published');

  git('commit', '-q', '--allow-empty', '-m', 'A later commit, as a retained source review adds');
  await agree(story, 'specification published, then a later commit');

  cli('submit', 'specification', '--skip-checks');
  await agree(story, 'specification submitted');

  cli('approve', 'specification', '--yes');
  await agree(story, 'specification approved');
  cli('prepare', 'planning');
  await agree(story, 'planning prepared, nothing published');

  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  await agree(story, 'planning published');

  cli('submit', 'planning', '--skip-checks');
  await agree(story, 'planning submitted');
});
