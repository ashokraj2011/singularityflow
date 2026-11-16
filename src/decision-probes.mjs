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
 */
export const DEFAULT_SECONDS = 60;
export const LONGEST_SECONDS = 900;

const PROBES = Object.freeze({
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

/** Every item the list asks now whose answer waits on a check of its kind. */
export const itemsToCheck = (packet) => [...(packet.items ?? []), ...(packet.offered ?? [])]
  .filter((item) => item.check && item.check.status !== 'checked' && PROBES[item.kind] && item.decidedBy?.allowed !== false);

/**
 * Run each item's check within `seconds` in all, one after another, and say how many ran. A check that fails to start
 * or throws is left unknown: the card still asks, recommending "Check first". `say` hears one line before each check.
 */
export async function runDecisionProbes(root, packet, { seconds = DEFAULT_SECONDS, say = () => {}, now = Date.now, probes = PROBES } = {}) {
  const deadline = now() + seconds * 1000;
  const ran = [];
  for (const item of itemsToCheck(packet)) {
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
