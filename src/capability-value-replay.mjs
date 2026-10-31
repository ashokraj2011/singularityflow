/**
 * Re-apply a capability proposal onto the current approved authority, value by value.
 *
 * A capability proposal is a typed change to configuration records. What it changed is the
 * difference between its own exact base and its tip; activation re-applies exactly that onto the
 * current authority's records (the same record-level rebase `capability rebase-proposal` performs,
 * done at activation instead of in a second review). A textual Git merge decides nothing here.
 *
 * Per changed path:
 * - unchanged on the authority since the proposal's base: the proposal's object is taken as-is;
 * - already equal on both sides: nothing to do;
 * - changed on both sides in a YAML or JSON file: re-applied field by field
 *   (src/configuration-intent-replay.mjs, `conflictPolicy: 'reject'`), so another capability or
 *   repository added meanwhile is kept and the same field changed differently is a conflict. The
 *   file's mode is one more of its values: a mode only one side changed is kept;
 * - any other change on both sides (Markdown, a removed file, a created file, a binary): a conflict.
 *
 * A conflict is a value the two sides changed differently. That includes cases a line merge would
 * have resolved silently: a list edited at both ends (a list is one value), or one side removing a
 * record the other side edited.
 */
import { replayConfigurationJson, replayConfigurationYaml, replayFileMode } from './configuration-intent-replay.mjs';
import { configurationTreeChanges, readConfigurationObjects } from './git-configuration-objects.mjs';

/** Refusal code for a proposal whose values conflict with the current authority. */
export const CAPABILITY_VALUE_CONFLICT_CODE = 'CAPABILITY_PROPOSAL_VALUE_CONFLICT';

const same = (left, right) => (left == null && right == null)
  || (left != null && right != null && left.mode === right.mode && left.oid === right.oid);
const structured = (relative, ...sides) => /\.(?:ya?ml|json)$/iu.test(relative)
  && sides.every((side) => /^100(?:644|755)$/u.test(side.mode));
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/**
 * `{ status, changes, conflicts }` for the proposal `base..proposal` re-applied onto `target`.
 * `changes` are `{ path, mode, oid }` (an existing object), `{ path, mode, bytes }` (a re-applied
 * file) or `{ path, mode: null }` (a removal), relative to `target`'s tree. `conflicts` name each
 * path and, for YAML or JSON, the JSON pointers both sides changed differently.
 */
export function replayCapabilityProposal(root, { base, proposal, target, env = process.env }) {
  const proposed = configurationTreeChanges(root, base, proposal, { env });
  const moved = base === target ? new Map()
    : new Map(configurationTreeChanges(root, base, target, { env }).map((entry) => [entry.path, entry]));
  const changes = [];
  const conflicts = [];
  const replays = [];
  for (const entry of proposed) {
    const original = entry.before;
    const wanted = entry.after;
    const current = moved.has(entry.path) ? moved.get(entry.path).after : original;
    if (same(wanted, current)) continue;
    if (same(original, current)) {
      changes.push(wanted ? { path: entry.path, mode: wanted.mode, oid: wanted.oid } : { path: entry.path, mode: null });
      continue;
    }
    if (original && wanted && current && structured(entry.path, original, wanted, current)) {
      const mode = replayFileMode(original.mode, wanted.mode, current.mode);
      if (mode == null) {
        conflicts.push({ path: entry.path, pointers: ['/mode'] });
        continue;
      }
      replays.push({ path: entry.path, original, wanted, current, mode });
      continue;
    }
    conflicts.push({ path: entry.path, pointers: ['/'] });
  }
  if (replays.length) {
    const blobs = readConfigurationObjects(root,
      replays.flatMap(({ original, wanted, current }) => [original.oid, wanted.oid, current.oid]), { env });
    for (const { path: relative, original, wanted, current, mode } of replays) {
      let replayed;
      try {
        const texts = [original, wanted, current].map((side) => decode(blobs.get(side.oid)));
        replayed = (/\.json$/iu.test(relative) ? replayConfigurationJson : replayConfigurationYaml)(
          ...texts, { conflictPolicy: 'reject' });
      } catch (error) {
        conflicts.push({
          path: relative,
          pointers: error?.code === 'CONFIGURATION_ENTITY_CONFLICT' ? error.details?.pointers ?? ['/'] : ['/'],
          ...(error?.code === 'CONFIGURATION_ENTITY_CONFLICT' ? {} : { reason: 'unreadable' })
        });
        continue;
      }
      const bytes = Buffer.from(replayed.text, 'utf8');
      // The authority's own bytes in another mode are still a change.
      if (mode === current.mode && bytes.equals(blobs.get(current.oid))) continue;
      changes.push({ path: relative, bytes, mode });
    }
  }
  return { status: conflicts.length ? 'conflicting' : 'clean', changes, conflicts };
}
