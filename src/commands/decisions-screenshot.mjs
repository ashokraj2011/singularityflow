/**
 * A visual sign-off in the person's own terminal walkthrough (`decisions record`, interactive) [owner, 2026-11-18]: the
 * person is there, so "Take the screenshot now?" takes it with them at SFlow's browser (takeSignOffCapture, its full
 * wait: nobody capturing or a closed browser takes nothing), then asks the sign-off's three questions and their reason
 * as the Copilot CLI card does, and records it with `decision witness`. "r" takes it again (`--replace`). Loaded only
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

// The same three questions as the Copilot CLI card's and VS Code's review.
export const WITNESS_QUESTIONS = Object.freeze([
  ['states-the-outcome', 'Does this file show the acceptance criterion\'s observable outcome?'],
  ['matches-the-criterion', 'Does the evidence match the acceptance criterion as written?'],
  ['current-for-this-change', 'Is this evidence current for this change?']
]);
const WAIT_WORDS = 'up to 10 minutes; closing the browser takes nothing';

/** Runs this same CLI, as the cards run it, and answers its JSON result; a refusal throws with its own words. */
async function runSelf(args) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs'), ...args],
      { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 120000 });
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
      if (!review?.files?.length) { say('   There is no screenshot to sign off yet; nothing was recorded.'); return { status: 'no-file' }; }
      const file = review.files[0];
      const absolute = path.join(current.repositoryPath ?? root, file);
      say(`   Look at ${absolute}`);
      await (deps.open ?? openFile)(absolute);
      const name = review.clauseId.slice(review.clauseId.lastIndexOf(':') + 1);
      const answer = String(await ask(`   Is this the screen ${name} is about? y = sign it off, r = take it again, n = not now [n]: `) ?? '').toLowerCase();
      if (answer === 'r') { again = true; continue; }
      if (answer !== 'y' && answer !== 'yes') { say(`   Nothing was recorded. Sign it off later on the Decide card (/sf-decide ${workId}).`); return { status: 'not-now' }; }
      const answers = [];
      for (const [id, question] of WITNESS_QUESTIONS) {
        const reply = await ask(`   ${question} [y/n]: `);
        if (reply === null) { say('   Input ended; nothing was recorded.'); return { status: 'ended' }; }
        answers.push([id, /^(?:y|yes)$/iu.test(reply)]);
      }
      let reason = '';
      for (let tries = 0; tries < 3 && (reason.length < 10 || reason.length > 1000); tries += 1) {
        reason = String(await ask('   What did you look at? In your own words (10 to 1000 characters): ') ?? '').trim();
      }
      if (reason.length < 10 || reason.length > 1000) { say('   Nothing was recorded: say what you looked at in 10 to 1000 characters.'); return { status: 'no-reason' }; }
      say(`   File: ${file}`);
      for (const [id, yes] of answers) say(`   ${id}: ${yes ? 'yes' : 'no'}`);
      if (!/^(?:y|yes)$/iu.test(String(await ask(`   Record this review of ${name} under your name? It is a witness, not the step's approval. [y/N]: `) ?? ''))) {
        say('   Nothing was recorded.');
        return { status: 'not-now' };
      }
      const digest = `sha256:${createHash('sha256').update(await readFile(absolute)).digest('hex')}`;
      const args = ['decision', 'witness', '--work-id', workId, '--criterion', review.clauseId, '--slot', review.slot, '--file', file, '--reason', reason,
        '--expected-context-sha256', review.contextBinding, '--expected-file-sha256', digest, ...answers.flatMap(([id, yes]) => [yes ? '--confirm' : '--deny', id]), '--json'];
      try {
        const result = await (deps.record ?? runSelf)(args);
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
