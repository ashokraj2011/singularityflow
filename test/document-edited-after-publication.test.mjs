/**
 * A published document edited afterwards (review of the opening flow, 2026-11-17, finding 5). Publishing or preparing it
 * is refused, since its next version opens only on the person's yes, and the refusal names the step's preview. Before,
 * that preview found no plan and no typed words, refused GENERATION_CHANGE_NOT_REQUESTED ("published and unchanged") and
 * routed to `--reason "<what to change>"`, so an agent wrote words of its own that were then kept as the person's. Now
 * the edit itself is the preview's reason, as changed code files already are: SFlow's own words, never kept as typed
 * words, and only the person's yes opens the version [D3, OSA:REQ-030].
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';

const W = 'DEA-1';
const json = (story, args, { fail = false } = {}) => {
  const ran = story.raw([...args, '--json']);
  if (!fail) assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-2000)}`);
  return { status: ran.status, value: JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null') };
};
const routeOf = (refusal) => ({ command: typeof refusal.error.details.nextAction === 'string' ? refusal.error.details.nextAction : refusal.error.details.nextAction?.command ?? null,
  label: refusal.remediationPlan?.steps?.[0]?.label ?? refusal.error.details.nextAction?.label ?? null });

test('an edited published document is its own reason for the next version: the preview asks the person, and nothing is kept as their words', async (t) => {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  const file = `${story.item}/artifacts/intake/intake.md`;
  await story.write(file, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  // The person edits the published document.
  await story.write(file, `${await readFile(path.join(story.root, file), 'utf8')}\nThe callers that read the value are listed in the plan.\n`);

  const refused = json(story, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'], { fail: true }).value;
  assert.equal(refused.error?.code, 'VERSION_CONSENT_REQUIRED', JSON.stringify(refused).slice(0, 2000));
  const route = routeOf(refused);
  assert.equal(route.command, 'singularity-flow phase rollover intake --json');
  assert.doesNotMatch(JSON.stringify(refused), /The person asked for a change/u, 'nobody typed a change: the document was edited');

  const preview = json(story, ['phase', 'rollover', 'intake']).value;
  assert.equal(preview.mutates, false, JSON.stringify(preview).slice(0, 2000));
  assert.equal(preview.kind, 'changed-after-publication');
  assert.match(preview.question, /^Start version 2 of Scope and plan\? /u);
  assert.deepEqual(preview.requestedChange.requests, ['artifacts/intake/intake.md was edited after version 1 was published.']);
  assert.equal(preview.requestedChange.keptAs, 'the edited document itself; nothing is kept as typed words');
  // Nothing was kept as the person's typed words for version 2.
  const listed = json(story, ['decisions', W]).value;
  assert.equal((listed.data ?? listed).versionOpening?.version, 2, 'the card asks it');
  assert.deepEqual(await readdir(path.join(story.root, '.git', 'singularity-flow', 'asked-for')).catch(() => []), []);

  // The person's yes in their own terminal (here: outside every Copilot turn) opens version 2 with the edit kept.
  const opened = json(story, ['phase', 'rollover', 'intake', '--confirm', preview.confirmation]).value;
  assert.equal(opened.mutates, true, JSON.stringify(opened).slice(0, 2000));
  assert.equal(storyRecord(story).phases.intake.versionOpening.version, 2);
  assert.match(await readFile(path.join(story.root, file), 'utf8'), /The callers that read the value are listed in the plan\./u);
});
