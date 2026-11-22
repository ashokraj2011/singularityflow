/**
 * A visual sign-off in the person's own terminal walkthrough (`decisions record`, interactive) [owner, 2026-11-18]: the
 * person is there, so "Take the screenshot now?" takes it with them at SFlow's browser (takeSignOffCapture, its full
 * wait: nobody capturing or a closed browser takes nothing), then asks the sign-off's one question as the Copilot CLI
 * card does (sign-off-question.mjs) and records it with `decision witness`. "r" takes it again (`--replace`). Loaded only
 * when the person says yes; never from a card's check or a probe, and never from a chat turn, which is refused
 * `decisions record` and has no terminal to answer in.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { lineReader } from './decisions.mjs';
import { attestQuestion, signOffAnswers, signOffQuestion, unsureWords } from '../sign-off-question.mjs';

const WAIT_WORDS = 'up to 10 minutes; closing the browser takes nothing';

/** Runs this same CLI in the Story's own checkout, as the cards run it, and answers its JSON result; a refusal throws with its own words. */
async function runSelf(args, cwd) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs'), ...args],
      { cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 120000 });
    return JSON.parse(stdout);
  } catch (error) {
    let refusal = null;
    try { refusal = JSON.parse(String(error.stdout ?? '')).error; } catch { /* not JSON: its own words below */ }
    throw Object.assign(new Error(refusal?.message ?? String(error.stderr || error.message).trim()), { code: refusal?.code ?? null });
  }
}

/** Puts the screenshot in front of the person: its path always, and their own viewer when the machine has one. */
async function openFile(file) {
  const { openBrowser } = await import('../local-evidence-review.mjs');
  await openBrowser(pathToFileURL(file).href).catch(() => undefined);
}

const signOffOf = (packet, request) => (packet.items ?? []).find((item) => (request.subject ? item.subject === request.subject : item.id === request.item)) ?? null;
const reviewOf = (item) => item?.options.find((option) => option.action?.humanReview && option.available !== false && option.decidedBy?.allowed)?.action.humanReview ?? null;

/**
 * Take the screenshot (unless `request.take` is false: it was taken already), then sign it off, in this terminal.
 * `deps` ({ take, record, open }) stand in for the capture, the witness command and the viewer in a test.
 */
export async function screenshotWalkthrough(root, { workId, packet, request, reread, io, deps = {} }) {
  const reader = lineReader(io.input);
  const say = (line) => io.output.write(`${line}\n`);
  const ask = async (question) => { io.output.write(question); const line = await reader.next(); return line === null ? null : line.trim(); };
  const take = deps.take ?? (async (input) => (await (await import('../verification/witness-records.mjs')).visualSignOffCapture()).takeSignOffCapture(root, input));
  // A sign-off with no screenshot: the person's own check, their note saying what they checked (owner, 2026-11-22).
  const attestHere = async (review, current) => {
    if (!review?.clauseId || !review.slot || !review.contextBinding) { say('   That sign-off is no longer on the list; nothing was recorded.'); return { status: 'gone' }; }
    const reply = String(await ask(`   ${attestQuestion(review)} y = yes, n = no, s = not sure [s]: `) ?? '').toLowerCase();
    const answer = /^(?:y|yes)$/u.test(reply) ? 'yes' : /^(?:n|no)$/u.test(reply) ? 'no' : 'unsure';
    if (answer === 'unsure') { say(`   ${unsureWords(workId)}`); return { status: 'not-sure' }; }
    let given = signOffAnswers(answer, await ask('   What did you check, where and how? (20 to 1000 characters): '), { attest: true });
    for (let tries = 0; given.problem && tries < 2; tries += 1) {
      say(`   ${given.problem}`);
      given = signOffAnswers(answer, await ask('   What did you check? '), { attest: true });
    }
    if (given.problem) { say(`   Nothing was recorded: ${given.problem}`); return { status: 'no-reason' }; }
    const args = ['decision', 'witness', '--work-id', workId, '--criterion', review.clauseId, '--slot', review.slot, '--attest', '--reason', given.reason,
      '--expected-context-sha256', review.contextBinding, ...given.answers.flatMap(([id, yes]) => [yes ? '--confirm' : '--deny', id]), '--json'];
    const name = review.clauseId.slice(review.clauseId.lastIndexOf(':') + 1);
    try {
      const result = await (deps.record ?? ((list) => runSelf(list, current.repositoryPath ?? root)))(args);
      const record = result?.data?.record ?? null;
      say(`   Recorded ${record?.id ?? 'the sign-off'}: ${record?.outcome === 'met' ? `${name} is signed off, from your own check` : `${name} is not signed off: what is wrong is recorded`}.`);
      return { status: 'recorded', record: record?.id ?? null };
    } catch (error) {
      say(`   The sign-off was not recorded: ${error.message}`);
      return { status: 'refused' };
    }
  };
  try {
    let current = packet;
    let again = false;
    for (let round = 0; round < 3; round += 1) {
      const item = signOffOf(current, request);
      const shot = item?.check?.kind === 'screenshot' ? item.check : null;
      if (request.take || again) {
        const criterion = shot?.criterion ?? reviewOf(item)?.clauseId;
        const slot = shot?.slot ?? reviewOf(item)?.slot;
        if (!criterion || !slot) { say('   That sign-off is no longer on the list; nothing was taken.'); return { status: 'gone' }; }
        say(`   Opening your app in SFlow's browser: bring up the screen ${criterion.slice(criterion.lastIndexOf(':') + 1)} is about, then click "Capture this screen" on SFlow's bar (${WAIT_WORDS}).`);
        try {
          await take({ workId, clauseId: criterion, slot, again });
        } catch (error) {
          say(`   No screenshot was taken: ${error.message}`);
          return { status: 'not-taken' };
        }
        current = await reread();
      }
      const review = reviewOf(signOffOf(current, request));
      // No screenshot: the person may sign it off from their own check, saying what they checked (owner, 2026-11-22).
      if (!review?.files?.length) return attestHere(review, current);
      const file = review.files[0];
      const absolute = path.join(current.repositoryPath ?? root, file);
      say(`   Look at ${absolute}`);
      await (deps.open ?? openFile)(absolute);
      const name = review.clauseId.slice(review.clauseId.lastIndexOf(':') + 1);
      // One question, the file open beside it [owner, 2026-11-18]; r takes the screenshot again.
      const reply = String(await ask(`   ${signOffQuestion(review, file)} y = yes, n = no (say what's wrong), s = not sure, r = take it again, c = I checked it myself (no screenshot) [s]: `) ?? '').toLowerCase();
      if (reply === 'r') { again = true; continue; }
      if (reply === 'c') return attestHere(review, current);
      const answer = /^(?:y|yes)$/u.test(reply) ? 'yes' : /^(?:n|no)$/u.test(reply) ? 'no' : 'unsure';
      if (answer === 'unsure') { say(`   ${unsureWords(workId)}`); return { status: 'not-sure' }; }
      let given = signOffAnswers(answer, await ask(answer === 'no' ? '   What is wrong with it? (10 to 1000 characters): ' : '   A note, if you want one (Enter to skip): '));
      for (let tries = 0; given.problem && tries < 2; tries += 1) {
        say(`   ${given.problem}`);
        given = signOffAnswers(answer, await ask(answer === 'no' ? '   What is wrong with it? ' : '   A note, or Enter to skip: '));
      }
      if (given.problem) { say(`   Nothing was recorded: ${given.problem}`); return { status: 'no-reason' }; }
      const { reason, answers } = given;
      const digest = `sha256:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`;
      const args = ['decision', 'witness', '--work-id', workId, '--criterion', review.clauseId, '--slot', review.slot, '--file', file, '--reason', reason,
        '--expected-context-sha256', review.contextBinding, '--expected-file-sha256', digest, ...answers.flatMap(([id, yes]) => [yes ? '--confirm' : '--deny', id]), '--json'];
      try {
        const result = await (deps.record ?? ((list) => runSelf(list, current.repositoryPath ?? root)))(args);
        const record = result?.data?.record ?? null;
        say(`   Recorded ${record?.id ?? 'the sign-off'}: ${record?.outcome === 'met' ? `${name} is signed off` : `${name} is not signed off by this review`}.`);
        return { status: 'recorded', record: record?.id ?? null };
      } catch (error) {
        say(`   The sign-off was not recorded: ${error.message}`);
        return { status: 'refused' };
      }
    }
    say('   Nothing was recorded.');
    return { status: 'not-now' };
  } finally {
    reader.close();
  }
}
