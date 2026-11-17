/**
 * The person's yes on the decisions card to a step's next version, and what comes after it (review of the opening flow,
 * 2026-11-17, findings 2 and 6). A yes is kept by `decisions record --version-consent`; it opens nothing by itself, so
 * the step it names next must be the one that opens it: the step's own work command, whose preview and confirmation the
 * kept yes lets through [D3, OSA:REQ-030]. Before, the next step named was /sf-submit's readiness read (the decision was
 * made without the step's task fact, so a change the person typed was invisible), and /sf-submit submitted the old
 * version while the yes expired; and the work command's entry asked the person the same question a second time.
 *
 * The walk here is the real one, on an isolated quick fix with a local bare remote (test/helpers/route-follower.mjs):
 * the person's yes on the card, the next step it names, the work command's entry, its preview and its confirmation, and
 * version 2 opened through the opening operation with the decisions-card receipt. Expected results are written out.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { copilotTurn, followRoutes, formatTrail, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { cooperativePerson, quickFixIntake, report } from './helpers/journey-scripts.mjs';
import { agentAct } from '../src/agent-output.mjs';

const W = 'CYN-1';
const json = (story, args, { fail = false } = {}) => {
  const ran = story.raw([...args, '--json']);
  if (!fail) assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-2000)}`);
  return { status: ran.status, value: JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null') };
};
const PREVIEW = 'singularity-flow phase rollover intake --json';
/** A refusal's route as a person and an agent read it: its next command, and its plan's first Copilot command. */
const routeOf = (refusal) => ({ command: typeof refusal.error.details.nextAction === 'string' ? refusal.error.details.nextAction : refusal.error.details.nextAction?.command ?? null,
  copilot: refusal.remediationPlan?.steps?.[0]?.copilotCommand ?? null });

/** A quick fix whose intake is published, and the person asked for a change: its next version is previewed. */
async function previewedSuccessor(t) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const preview = json(story, ['phase', 'rollover', 'intake', '--reason', 'Name the callers that read the value.']).value;
  assert.equal(preview.toGeneration, 2);
  return { story, preview };
}

/** The card's yes, as both cards record it (`decisions record --version-consent`). */
function cardYes(story) {
  const listed = json(story, ['decisions', W]).value;
  const opening = (listed.data ?? listed).versionOpening;
  assert.equal(opening?.version, 2, JSON.stringify(listed).slice(0, 1500));
  return { opening, recorded: json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest]).value };
}

test('after "Yes, start it" on the card, the next step named is the step\'s work command and its preview, never /sf-submit', async (t) => {
  const { story } = await previewedSuccessor(t);
  const { recorded } = cardYes(story);
  const [next] = recorded.next ?? [];
  assert.equal(next?.command, PREVIEW, JSON.stringify(recorded).slice(0, 3000));
  assert.equal(next.skill, '/sf-phase');
  assert.doesNotMatch(JSON.stringify(recorded), /submission-readiness|\/sf-submit/u);
  // The words say what really happens next: the work command starts it with the kept yes, without asking again.
  const data = recorded.data ?? recorded;
  assert.equal(data.words, 'Your yes to start version 2 of Scope and plan is kept for 30 minutes. Next, /sf-phase intake starts it with this yes, '
    + 'without asking you again, and makes the change.');
  assert.deepEqual(data.next, { command: PREVIEW, copilotCommand: '/sf-phase intake', skill: '/sf-phase' });

  // The list asks nothing more, and its next step is the same work command, never the old version's submission.
  const listed = json(story, ['decisions', W]).value;
  const packet = listed.data ?? listed;
  assert.equal(packet.versionOpening, undefined);
  assert.equal(packet.next?.command, PREVIEW, JSON.stringify(packet.next));
  assert.equal(packet.next.skill, '/sf-phase');
  assert.match(packet.next.title, /^Your yes to start version 2 of Scope and plan is kept: \/sf-phase intake starts it now, without asking again\./u);
});

test('the work command after a card yes asks nothing again: its entry goes to the preview and its confirmation, and version 2 opens with the decisions-card receipt', async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  const { opening } = cardYes(story);
  // The work command's entry, as /sf-phase runs it in the person's next turn.
  const entry = json(story, ['phase', 'enter', 'intake']).value;
  const act = agentAct(entry);
  assert.equal(entry.successor?.consent?.kept, true, JSON.stringify(entry.successor ?? entry.status).slice(0, 2000));
  assert.equal(entry.successor.consent.surface, 'decisions-card');
  assert.equal(act.ask, undefined, `the person is not asked again: ${JSON.stringify(act)}`);
  assert.equal(act.state, 'next', JSON.stringify(act));
  assert.equal(act.do.shell, PREVIEW);
  assert.match(act.said, /^The person already said yes to version 2 of intake on the decisions card: run do\.shell \(the preview\), then the confirmation it returns, without asking them again/u);

  // In the work command's own Copilot turn: the preview, then its confirmation, which the guard lets through on the card's yes.
  const turn = copilotTurn(story, 'card-yes-work');
  turn.prompt('/sf-phase intake');
  const again = json(story, ['phase', 'rollover', 'intake']).value;
  assert.equal(again.confirmation, preview.confirmation, 'the same proposal, so the kept yes is its own');
  const confirm = `singularity-flow phase rollover intake --confirm ${again.confirmation} --json`;
  // The preview says the yes is kept, and its act runs the confirmation with no question.
  assert.equal(again.consent?.kept, true, JSON.stringify(again).slice(0, 2000));
  const previewAct = agentAct(again);
  assert.equal(previewAct.ask, undefined, JSON.stringify(previewAct));
  assert.equal(previewAct.state, 'next');
  assert.equal(previewAct.do.shell, `singularity-flow phase rollover intake --confirm ${again.confirmation}`);
  assert.match(previewAct.said, /^The person's yes to version 2 is kept from the decisions card: run this confirmation now, without asking them again\./u);
  const guard = turn.tool('bash', { command: confirm });
  assert.notEqual(guard.permissionDecision ?? guard.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(guard).slice(0, 1500));
  const opened = json(story, ['phase', 'rollover', 'intake', '--confirm', again.confirmation]).value;
  assert.equal(opened.mutates, true, JSON.stringify(opened).slice(0, 2000));
  const record = JSON.parse(await readFile(path.join(story.root, story.item, 'context/version-openings/intake-v2.json'), 'utf8'));
  assert.deepEqual({ schema: record.consent.schema, digest: record.consent.proposalDigest, surface: record.consent.response.surface, assurance: record.consent.principal.assurance },
    { schema: 'version-opening-consent/v1', digest: opening.digest, surface: 'decisions-card', assurance: 'host-card' });
  assert.equal(storyRecord(story).phases.intake.versionOpening.version, 2);
});

test('a confirmation with no yes kept names the step\'s preview through its work command, and so does a yes refused because the Story moved', async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  // Run inside a Copilot turn bound to the Story with no answer: nothing opens, and the route is the preview, not /sf-submit.
  const turn = copilotTurn(story, 'no-yes');
  turn.prompt('/sf-phase intake');
  const refused = json(story, ['phase', 'rollover', 'intake', '--confirm', preview.confirmation], { fail: true }).value;
  assert.equal(refused?.error?.code, 'VERSION_CONSENT_REQUIRED', JSON.stringify(refused).slice(0, 2000));
  assert.deepEqual(routeOf(refused), { command: PREVIEW, copilot: '/sf-phase intake' }, JSON.stringify(refused).slice(0, 3000));
  // The Story moves after the card read: the yes is refused, and its route is the preview again, through the work command.
  const listed = json(story, ['decisions', W]).value;
  const opening = (listed.data ?? listed).versionOpening;
  story.git('commit', '-q', '--allow-empty', '-m', 'Another change on the Story');
  const stale = json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest], { fail: true }).value;
  assert.equal(stale.error.code, 'VERSION_OPENING_STALE', JSON.stringify(stale).slice(0, 2000));
  assert.deepEqual(routeOf(stale), { command: PREVIEW, copilot: '/sf-phase intake' }, JSON.stringify(stale).slice(0, 3000));
});

test('journey: from the card\'s yes, the routes alone open version 2 through the work command, and nobody asks the person again', async (t) => {
  const { story } = await previewedSuccessor(t);
  const { recorded } = cardYes(story);
  const [next] = recorded.next;
  // The person types what the card named; the agent follows SFlow's routes through the real guard, and any question to
  // the person about starting the version is a finding: the card's yes is theirs, given once.
  const asked = [];
  const person = cooperativePerson((context) => {
    if (/Start version 2\b/u.test(String(context.act?.ask?.question ?? context.act?.said ?? ''))) { asked.push(context.act); return { route: { shell: null } }; }
    return null;
  });
  const walk = await followRoutes(story, { label: 'card yes', start: { copilot: (recorded.data ?? recorded).next.copilotCommand, shell: next.command },
    agent: {}, person, done: ({ record }) => record?.phases?.intake?.versionOpening?.version === 2, maxSteps: 8 });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, report(walk));
  assert.deepEqual(walk.findings, [], report(walk));
  assert.deepEqual(asked, [], 'the person was not asked again');
  const opening = JSON.parse(await readFile(path.join(story.root, story.item, 'context/version-openings/intake-v2.json'), 'utf8'));
  assert.equal(opening.consent.response.surface, 'decisions-card');
  assert.equal(storyRecord(story).phases.intake.versionOpening.version, 2);
});
