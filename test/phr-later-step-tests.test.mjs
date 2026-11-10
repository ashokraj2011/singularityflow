/**
 * Phase responsibility, item 8 (owner, option A, 2026-11-10) [PHR:REQ-007]: a code step runs, before its approval,
 * the repository tests a later step chose, with the same runner and result adapter, so the later step finds
 * nothing new: on the same code its run only confirms the code step's. Through a real Story: the repository's
 * `tests:` holds a unit and an integration run, Implementation chooses the unit one and Verification the
 * integration one.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { slowLane } from './helpers/slow-lane.mjs';
import { storyAtVerification, writeVerificationEvidence } from './helpers/story-to-verification.mjs';

const W = 'LATE-8';
const run = (id, level, argv) => ({ id, kind: 'test', level, argv, workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
  result: { adapter: 'node-tap', path: `.sflow/results/${id}.tap`, minimumDiscovered: 1 } });

test('[PHR:REQ-007] item 8: Implementation runs the test Verification chose, and Verification only confirms it on the same code', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await storyAtVerification(t, W, { configure: (configuration) => {
    configuration.tests = [run('value-unit', 'unit', ['node', '--test', 'test/value.test.mjs']),
      run('value-integration', 'integration', ['node', '--test', 'test/'])];
    configuration.phases.implementation.testLevels = ['unit'];
    const overrides = configuration.workTypes['spec-driven-standard'].phaseOverrides ??= {};
    overrides.verification = { ...(overrides.verification ?? {}), testIds: ['value-integration'] };
  } });
  const workflow = JSON.parse(await readFile(path.join(story.item, 'workflow.json'), 'utf8'));
  const pinned = workflow.resolution.phases.find((entry) => entry.id === 'implementation');
  assert.deepEqual(pinned.laterStepTests, { runs: [{ id: 'value-integration', steps: ['verification'] }], cannotRunHere: [] });
  // Implementation ran it with its own, before its approval.
  const implementation = workflow.phases.implementation;
  assert.ok(implementation.checks.some((check) => check.id === 'value-integration' && check.status === 'passed'),
    JSON.stringify(implementation.checks.map((check) => [check.id, check.status])));

  await writeVerificationEvidence(story);
  story.cli('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  const submitted = story.cli('submit', 'verification');
  assert.match(submitted.stderr, /Not run again: value-integration passed on this exact code \(TA-[a-f0-9]{20}, recorded by implementation\)/u);
});
