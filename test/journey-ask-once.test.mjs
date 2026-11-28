/**
 * Journey Y, slow lane (ask once, owner 2026-11-28): a cloned Story's reviewer never re-raises what SFlow wrote or what the
 * person already answered. On the graph-plotter Story (2026-11-20) SFlow had written "Supporting documents were not
 * copied. Attach needed documents and images to this new Story." into the clone's request; its reviewer read that as an
 * open requirement in three rounds: four versions, five answers, four typed reviews. Clones no longer carry the note
 * (story-clone.mjs); a Story an older build cloned still does, so its reviewer is told those lines are SFlow's, and every
 * later review is given the person's answers so far (answered-questions.mjs).
 *
 * The reviewer here is scripted as that reviewer was: every request line that asks for documents is an open requirement,
 * unless the packet says SFlow wrote it; and the same question is raised again unless an answer the packet carries
 * settles it. The person's send-back opens the next version on its own (journey F).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { documentReport, retainStepReview } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ASKS_FOR_DOCUMENTS = /Attach needed documents|supporting documents?|attach(?:ed)? (?:a |the )?(?:picture|image|screenshot)/iu;

/** The graph-plotter reviewer: a blocking finding for each request line asking for documents that the packet leaves open. */
function documentsReviewer(packet) {
  const settledBySflow = (source, line) => (packet.sflowNotes ?? []).some((note) => note.sourceId === source.id && note.line === line);
  const answered = (packet.answeredEarlier ?? []).some((entry) => /inspiration only|no picture/iu.test(entry.answer));
  const asks = packet.sources.flatMap((source) => source.text.split(/\r?\n/u).map((text, index) => ({ source, line: index + 1, text })))
    .filter((entry) => ASKS_FOR_DOCUMENTS.test(entry.text) && !settledBySflow(entry.source, entry.line) && !answered);
  const report = documentReport(packet);
  return { ...report, findings: asks.slice(0, 1).map((entry) => ({ id: 'missing-supporting-material', severity: 'blocking',
    message: 'The request asks for supporting documents and images; none are attached. Please confirm the intended reference.',
    sourceId: entry.source.id, line: entry.line, quote: entry.text.trim().slice(0, 200) })) };
}

test('journey Y: a Story an older build cloned is reviewed once, its copy note read as SFlow\'s, and a send-back\'s answer is never asked again', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRN-Y';
  const story = await journeyRepository(t);
  // The request as an older build's clone wrote it: the person's own words, then SFlow's two lines about the copy.
  const request = path.join(story.base, 'clone-request.json');
  await writeFile(request, JSON.stringify({ title: 'Change the value', description: 'The value module must return 2.',
    notes: ['Keep the existing export name.', '', 'Request copied from Story JRN-X at 0123456789abcdef0123456789abcdef01234567.', '',
      'Supporting documents were not copied. Attach needed documents and images to this new Story.'].join('\n') }));
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  story.cli('start', W, '--from-branch', 'main', '--work-type', 'quick-fix', '--story-file', request);
  const json = (args) => JSON.parse(story.cli(...args));
  const publishIntake = async (words) => {
    story.cli('prepare', 'intake');
    await story.write(`${story.item}/artifacts/intake/intake.md`, `${quickFixIntake(W)}\n${words}\n`);
    story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  };
  const rounds = [];
  const review = () => {
    const packet = json(['review-source', 'context', 'intake', '--json']);
    const report = documentsReviewer(packet);
    const status = retainStepReview(json, 'intake', report);
    rounds.push({ version: packet.generation, findings: report.findings.length, status: status.status });
    return { packet, status };
  };

  // Version 1: SFlow's two lines are named as its own, so the reviewer raises neither.
  await publishIntake('Version 1.');
  const first = review();
  assert.deepEqual((first.packet.sflowNotes ?? []).map((note) => note.text.slice(0, 24)), ['Request copied from Stor', 'Supporting documents wer'], JSON.stringify(first.packet.sflowNotes ?? null));
  assert.match(first.packet.answeredGuidance ?? '', /SFlow's own note, not the person's request: never a requirement, a gap or a finding/u);
  assert.equal(first.status.status, 'ready', JSON.stringify(first.status.findings ?? first.status).slice(0, 2000));

  // The person sends it back with their answer to what a reviewer might ask; version 2 opens on that send-back, and its
  // review is given the answer, so the question is not raised again.
  story.cli('submit', 'intake');
  story.cli('reject', 'intake', '--to', 'intake', '--reason', 'Functional inspiration only: no picture is needed. Name the export in the scope.');
  const entry = JSON.parse(story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']).stdout);
  assert.equal(entry.act?.state, 'next', JSON.stringify(entry.act ?? entry).slice(0, 1500));
  assert.match(entry.act.do?.shell ?? '', /phase rollover intake --sent-back --json/u);
  const opened = json(['phase', 'rollover', 'intake', '--sent-back', '--json']);
  assert.match(opened.line, /^Using your answer from .* version 1: "Functional inspiration only: no picture is needed\. Name the export in the scope\." SFlow started version 2 /u);
  await publishIntake('Version 2: the scope names the export.');
  const second = review();
  assert.ok((second.packet.answeredEarlier ?? []).some((answer) => answer.kind === 'send-back' && /inspiration only/u.test(answer.answer)), JSON.stringify(second.packet.answeredEarlier ?? null));
  assert.equal(second.status.status, 'ready', JSON.stringify(second.status.findings ?? second.status).slice(0, 2000));

  // What it cost: one review per version, no finding on the note or the answered question, no version question asked
  // (graph-plotter Story: four versions, five answers, four typed reviews for the same note).
  t.diagnostic(`rounds: ${JSON.stringify(rounds)}`);
  assert.deepEqual(rounds.map((round) => round.findings), [0, 0]);
  assert.equal(storyRecord(story).phases.intake.generation, 2);
  assert.ok((storyRecord(story).settledDecisions ?? []).some((settled) => settled.kind === 'sent-back' && settled.phase === 'intake'));
});
