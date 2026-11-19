/**
 * SFlow never merges (owner, 2026-11-19). After a person approves the delivered code, finalizing the Story and opening
 * its pull request follow by themselves once the remaining steps pass; merging stays the person's click on the Git host.
 * Where the pull request cannot be opened here (another host, no GitHub CLI), the Story still finalizes and the person is
 * given the one route that opens it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { deliveredCodeApprovedByPerson } from '../src/story-landing.mjs';
import { cooperativePerson, quickFixIntake, report, reviewer, writeValueCode } from './helpers/journey-scripts.mjs';
import { followRoutes, formatTrail, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

test('only a person\'s approval of the delivered code lets the pull request open later', () => {
  const code = (approvals) => ({ phaseOrder: ['implement'], phases: { implement: { id: 'implement', status: 'approved', writeScope: 'source-and-artifact',
    generation: { requirement: 'required', producer: 'deterministic', task: 'code' }, approvals } } });
  assert.equal(deliveredCodeApprovedByPerson(code([{ decision: 'approved' }])), true);
  assert.equal(deliveredCodeApprovedByPerson(code([])), false, 'code nobody approved (approval none) opens nothing by itself');
  assert.equal(deliveredCodeApprovedByPerson(code([{ decision: 'approved', invalidatedAt: 'then' }])), false);
});

test('after the person approves the code, the Story finalizes by itself at its end and the pull request is the one step left; nothing merges', slowLane({ timeout: 1_200_000 }), async (t) => {
  const W = 'LAND-1';
  // The quick fix with a person approving its code step, as journey F has it.
  const story = await journeyRepository(t, { configure: (configuration) => {
    configuration.workTypes['quick-fix'].phaseOverrides.implement = { ...(configuration.workTypes['quick-fix'].phaseOverrides.implement ?? {}),
      approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['implement'] } };
  } });
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  // A Story started from its seed, as one from Jira or a story file is: finalizing binds the seed's inputs.
  await story.write(`singularity/seeds/${W}.yml`, `story:\n  workId: ${W}\n  title: Change the value\n`);
  for (const args of [['add', `singularity/seeds/${W}.yml`], ['commit', '-qm', 'Story seed']]) {
    assert.equal(spawnSync('git', args, { cwd: story.root, encoding: 'utf8' }).status, 0, args.join(' '));
  }
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  const main = spawnSync('git', ['rev-parse', 'main'], { cwd: story.root, encoding: 'utf8' }).stdout.trim();
  const author = async ({ story: s, phase }) => {
    if (phase !== 'implement') return false;
    await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`] });
    return true;
  };
  const walk = await followRoutes(story, { label: 'landing', start: { copilot: '/sf-code' }, agent: { author, review: reviewer() },
    person: cooperativePerson(), detour: ({ finding, route }) => (['no-progress', 'dead-end', 'skill-skips-route'].includes(finding.kind) && route.shell ? { shell: route.shell } : null),
    done: ({ record }) => record?.status === 'closed', maxSteps: 40 });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, report(walk));
  const record = storyRecord(story);
  assert.equal(record.phases.implement.approvals.filter((entry) => !entry.invalidatedAt).length, 1, 'a person approved the code');
  const { landAfterLastApproval } = await import('../src/story-landing.mjs');
  const shown = record.lineage?.finalizations?.length === 1 ? '' : JSON.stringify(await landAfterLastApproval(story.root, W).catch((error) => String(error?.stack ?? error)));
  assert.equal(record.lineage?.finalizations?.length, 1, `finalized by itself when the Story ended\n${shown}`);
  assert.equal(record.lineage.deliveryStatus, 'finalized_for_review');
  // The remote here is a folder, so the pull request is not opened; the one route that opens it is named, and nothing merged.
  const pr = story.raw(['pr', W]);
  assert.equal(pr.status, 0, pr.stdout.slice(-2000) + pr.stderr.slice(-2000));
  assert.equal(spawnSync('git', ['rev-parse', 'main'], { cwd: story.root, encoding: 'utf8' }).stdout.trim(), main, 'SFlow never merges');
  // Asked again, it finalizes nothing twice and names the one route that opens the pull request here.
  const again = await landAfterLastApproval(story.root, W);
  assert.equal(again.finalized, true);
  assert.equal(again.pullRequest, null);
  assert.match(again.lines.join('\n'), /^The pull request was not opened here: .+\. Open it from its preview\. Merge it on your Git host when its checks pass; SFlow never merges\.$/u);
  assert.equal(again.next.command, `singularity-flow pr ${W}`);
  assert.equal(storyRecord(story).lineage.finalizations.length, 1);
});
