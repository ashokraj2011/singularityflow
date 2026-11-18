/**
 * Checks SFlow runs itself before a person sees the decisions card [owner, 2026-11-16].
 *
 * On a real Story the card asked "Implementation's tests need another Node", said whether the tests pass on Node 22
 * was not known, and told the person to run `singularity-flow tests node` to find out: a read-only check SFlow could
 * run itself, and the item then recommended nothing. So an item whose right answer depends on such a check carries
 * `check` (decision-list.mjs), and the hosts' read of the card (`decisions --probe`) runs it first:
 *
 * - read-only: the check records nothing, as evidence or otherwise; it only keeps its answer beside the checkout's Git
 *   data, with the code it was found on;
 * - bounded: it gets `seconds` in all (DEFAULT_SECONDS for a card, up to LONGEST_SECONDS when the person chose "Check
 *   first"), and each kind's check ends on time by itself and cleans up after itself;
 * - cached: an answer found on the same code is the answer (each kind's own reader), so it never runs twice.
 *
 * The list is then read again and the item recommends from the result ("Tests pass on Node 22 (checked)"). A check
 * that cannot finish in time leaves "Check first" recommended, offered as the item's first option.
 *
 * Which kinds have one: PROBE_KINDS: a Node pin (`tests node`: do the tests pass on that Node?) and a test-run risk
 * (`tests base`: does the command fail without this change too?). A kind joins by naming what runs its check, below.
 * Its item carries `check` until its own reader finds an answer kept for it.
 *
 * A visual sign-off whose plan names no file (an owed sign-off, or an evidence row at the Story's end) has SFlow take
 * the screenshot of what was published (visual-sign-off-capture.mjs) [owner, 2026-11-18]. It builds the app, so its
 * check is `onRequest`: it runs only when the person asks for it ("Take the screenshot", which every host sends with
 * more than DEFAULT_SECONDS), never on a card's first read. Its answer is the screenshot itself, written untracked in
 * the Story's folder; nothing is recorded until the person signs it off.
 */
export const DEFAULT_SECONDS = 60;
export const LONGEST_SECONDS = 900;

const screenshot = async (root, packet, item, seconds) => {
  const { takeSignOffCapture } = await (await import('./verification/witness-records.mjs')).visualSignOffCapture();
  await takeSignOffCapture(root, { workId: packet.workId, clauseId: item.check.criterion, slot: item.check.slot, seconds });
};

const PROBES = Object.freeze({
  // SFlow's own screenshot of what the step published, for a visual sign-off the plan names no file for.
  'owed-decision': screenshot,
  'evidence-obligation': screenshot,
  // Would the tests pass on the Node a pin would give them (`tests node`, commands/tests.mjs)?
  'node-pin': async (root, packet, item, seconds) => {
    const { tryStoryNode } = await import('./commands/tests.mjs');
    await tryStoryNode(root, { 'work-id': packet.workId, phase: item.details.phase, node: String(item.details.version), within: String(seconds) });
  },
  // Does the command fail without this change too, on the commit the Story started from (`tests base`)?
  'test-run-risk': async (root, packet, item, seconds) => {
    const { tryStoryBase } = await import('./commands/tests.mjs');
    await tryStoryBase(root, { 'work-id': packet.workId, phase: item.details.phase, command: item.details.commandId, within: String(seconds) });
  }
});

/** The item kinds whose answer SFlow checks itself before it asks. */
export const PROBE_KINDS = Object.freeze(Object.keys(PROBES));

/** How long a host's read may check, in whole seconds: DEFAULT_SECONDS, or what was asked, never more than LONGEST_SECONDS. */
export function probeSeconds(value) {
  if (value === undefined || value === null || value === true || value === '') return DEFAULT_SECONDS;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 ? Math.min(seconds, LONGEST_SECONDS) : DEFAULT_SECONDS;
}

/** Whether a read with `seconds` is a person asking for a check, not a card's first read: only then does an `onRequest` one run. */
export const askedFor = (seconds) => probeSeconds(seconds) > DEFAULT_SECONDS;

/** Every item the list asks now whose answer waits on a check of its kind; one that runs only on request when `asked`. */
export const itemsToCheck = (packet, { asked = false } = {}) => [...(packet.items ?? []), ...(packet.offered ?? [])]
  .filter((item) => item.check && item.check.status !== 'checked' && PROBES[item.kind] && item.decidedBy?.allowed !== false
    && (item.check.kind === 'screenshot' ? item.check.onRequest === true && asked : !item.check.onRequest || asked));

/**
 * Run each item's check within `seconds` in all, one after another, and say how many ran. A check that fails to start
 * or throws is left unknown: the card still asks, recommending "Check first". `say` hears one line before each check.
 */
export async function runDecisionProbes(root, packet, { seconds = DEFAULT_SECONDS, say = () => {}, now = Date.now, probes = PROBES, asked = seconds > DEFAULT_SECONDS } = {}) {
  const deadline = now() + seconds * 1000;
  const ran = [];
  for (const item of itemsToCheck(packet, { asked })) {
    const left = Math.floor((deadline - now()) / 1000);
    if (left < 1) break;
    say(`${item.check.label.replace(/^Check first: /u, 'Checking: ')} (up to ${left} seconds; nothing is recorded).`);
    try {
      await probes[item.kind](root, packet, item, left);
      ran.push(item.id);
    } catch { /* Not checked: the item keeps "Check first". */ }
  }
  return { ran };
}
