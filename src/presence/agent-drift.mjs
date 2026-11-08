/**
 * SF Guard's agent-file drift label [SPEC-SFG-v1 CON-002, AC-011, G4]: a stamped agent file whose
 * stamping hook was removed or edited since `guard` stamped it. Its stamps no longer prove which
 * agent ran, so every place a label shows says so. Read at label time from the bytes on disk and
 * `guard`'s manifest of the stamped files; nothing is rewritten and nothing is refused.
 *
 * - `stamp-removed`: the file no longer carries SF Guard's stamp for its agent;
 * - `stamp-edited`: a stamp is there but is not the exact hook SF Guard wrote, or stamps another agent;
 * - `file-removed`: the stamped file is gone.
 * A file whose other bytes changed with its stamp intact is G2's `changed` (`guard status`), not drift.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../foundation/record-schema.mjs';

export const SF_GUARD_AGENT_DRIFT = Object.freeze(['stamp-removed', 'stamp-edited', 'file-removed']);
const STAMP = 'singularity-flow hook agent-stamp ';
const MAX_BYTES = 256 * 1024;
const LISTED = 8;
const lines = (entry) => [entry?.command, entry?.bash, entry?.windows, entry?.powershell].filter((line) => typeof line === 'string');

/**
 * The drift of one agent file's parsed frontmatter `hooks` (null when it has none) against the stamp
 * `stampingHooks(agent, { events })` writes: null when every stamp-like entry is exactly SF Guard's
 * for this agent and one stamps its prompts, else `stamp-removed` or `stamp-edited`. Pure.
 */
export function agentStampDrift(hooks, agent, stampingHooks) {
  const found = [];
  for (const [event, entries] of Object.entries(hooks && typeof hooks === 'object' ? hooks : {})) {
    for (const entry of Array.isArray(entries) ? entries : []) if (lines(entry).some((line) => line.includes(STAMP))) found.push([event, entry]);
  }
  if (!found.length) return 'stamp-removed';
  const exact = ([event, entry]) => {
    const expected = stampingHooks(agent, { events: [event] })[event]?.[0];
    return expected != null && canonicalJson(entry) === canonicalJson(expected);
  };
  return found.every(exact) && found.some(([event]) => event === 'userPromptSubmitted') ? null : 'stamp-edited';
}

/** The drift of an agent file's text (null text: the file is gone). */
export async function agentFileDrift(text, agent) {
  if (text == null) return 'file-removed';
  const [{ splitAgentText }, { sfGuardStampingHooks }] = await Promise.all([import('../agent-file.mjs'), import('../comprehension/xpl2/sf-guard-recorder.mjs')]);
  let hooks;
  // Frontmatter that no longer parses: a stamp still in its text was edited, none there was removed.
  try { hooks = splitAgentText(text, agent).document.get('hooks')?.toJSON?.() ?? null; } catch { return text.includes(STAMP) ? 'stamp-edited' : 'stamp-removed'; }
  return agentStampDrift(hooks, agent, sfGuardStampingHooks);
}

/**
 * Each stamped agent file here that drifted: `[{ id, path, drift }]`, from `guard`'s manifest and the
 * working tree. Unchanged bytes are never parsed. Empty where nothing was stamped. Never throws.
 */
export async function readAgentDrift(root) {
  try {
    const recorder = await import('../comprehension/xpl2/sf-guard-recorder.mjs');
    const stamped = await recorder.readSfGuardStampedAgents(root);
    const drifted = [];
    for (const entry of stamped ?? []) {
      const file = path.join(entry.root, entry.path);
      const info = await lstat(file).catch(() => null);
      const bytes = info?.isFile() && !info.isSymbolicLink() && info.size <= MAX_BYTES ? await readFile(file).catch(() => null) : null;
      if (bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256) continue;
      const drift = info && !bytes ? 'stamp-edited' : await agentFileDrift(bytes ? bytes.toString('utf8') : null, entry.id);
      if (drift) drifted.push({ id: entry.id, path: entry.path, drift });
    }
    return drifted;
  } catch {
    return [];
  }
}

/** The drift as the packet keeps it: the first eight, sorted, so its digest is stable. */
export function agentDriftEntries(drift = []) {
  return [...drift].sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path)).slice(0, LISTED)
    .map(({ id, path: file, drift: kind }) => ({ id, path: file, drift: kind }));
}
