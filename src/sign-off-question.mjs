/**
 * A sign-off asked as one question [owner, 2026-11-18: "sf-decide are so confusing"]: "Does this screenshot show what
 * AC-002 asks for?" with Yes, No (say what's wrong) or Not sure, the file open beside it. On new-ash-graph one sign-off
 * asked six questions in the engine's words ("Did you look at it?", three checks, "What did you inspect?", "I reviewed
 * this exact change"). Opening the file and answering is the looking.
 *
 * What each answer records, in the witness record's unchanged shape (verification/witness-records.mjs):
 *   Yes       all three checks confirmed (states-the-outcome, matches-the-criterion, current-for-this-change), with the
 *             person's note, or CONFIRMED_ON_CARD when they leave none; the file's bytes are bound as before.
 *   No        states-the-outcome and matches-the-criterion denied, current-for-this-change confirmed (it is the file
 *             in front of them), with their note, which is required: what is wrong.
 *   Not sure  nothing; UNSURE_WORDS says what to do.
 * Pure. The Copilot CLI card keeps its own copy (plugin/extensions/decisions/card.mjs), held equal by a test.
 */
export const SIGN_OFF_ANSWERS = Object.freeze({ yes: 'Yes', no: 'No (say what\'s wrong)', unsure: 'Not sure' });
// What a Yes with no note records as its reason: the engine asks for one of 10 to 1000 characters.
export const CONFIRMED_ON_CARD = 'Confirmed on the decision card: it shows what the criterion asks for.';
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/iu;

const shortName = (clauseId) => String(clauseId ?? '').slice(String(clauseId ?? '').lastIndexOf(':') + 1);

/** The one question: about "this screenshot" for an image or a visual sign-off, else about the file by name. */
export function signOffQuestion(review, file = review?.files?.[0] ?? null) {
  const subject = review?.method === 'visual' || IMAGE.test(String(file ?? '')) ? 'this screenshot' : file;
  return `Does ${subject} show what ${shortName(review?.clauseId)} asks for?`;
}

/** What not being sure records (nothing) and what to do instead. */
// Never a route back to /sf-decide: a chat's /sf-decide calls this review, and the card that asked it is still open
// [hardening C, F6]. The sign-off stays open on the Decide card until someone answers it.
export const unsureWords = (workId) => `Nothing was recorded for ${workId}. Ask someone who knows that screen, or take the screenshot again; the sign-off stays open on the Decide card.`;

/**
 * The witness command's answers for one answer (`yes`, `no` or `unsure`) and the person's note: `{ unsure: true }`,
 * `{ problem }` (a No without a note, or a note outside 10 to 1000 characters) or `{ reason, answers }`, `answers`
 * being [check, confirmed] pairs.
 */
export function signOffAnswers(answer, note = '') {
  const text = String(note ?? '').trim();
  if (answer === 'unsure') return { unsure: true };
  if (answer === 'no' && !text) return { problem: 'Say what is wrong with it (10 to 1000 characters).' };
  if (text && (text.length < 10 || text.length > 1000)) return { problem: 'Keep the note to 10 to 1000 characters.' };
  if (answer === 'yes') return { reason: text || CONFIRMED_ON_CARD, answers: [['states-the-outcome', true], ['matches-the-criterion', true], ['current-for-this-change', true]] };
  if (answer === 'no') return { reason: text, answers: [['states-the-outcome', false], ['matches-the-criterion', false], ['current-for-this-change', true]] };
  return { problem: `Answer ${SIGN_OFF_ANSWERS.yes}, ${SIGN_OFF_ANSWERS.no} or ${SIGN_OFF_ANSWERS.unsure}.` };
}
