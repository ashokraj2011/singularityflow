/**
 * Stamp the resolved model ladder into agent frontmatter. `[ADP:REQ-033]` `[ADP:CON-008]`
 *
 * The kernel routes by task and resolves inside `invokeModel`. The host — Copilot — owns its own
 * session model and cannot be made to obey that, so the most we can do on that side is *advise*:
 * write the tier's current models into the agent file the host reads. `[ADP:CON-003]`
 *
 * Where that advice goes was the open question the specification deferred to implementation time
 * (D3), and the answer changes the design it sketched:
 *
 *   - `SKILL.md` does NOT support a `model:` field. It is an open proposal
 *     (github/copilot-cli#3095, May 2026), so stamping skills would have written an inert key into
 *     119 files — a field that validates, ships, and is read by nobody.
 *   - `.agent.md` DOES support it, and takes a *prioritized array* that the host tries in order
 *     until one is available. That is the fallback ladder, host-side, at no cost.
 *
 * So agents are stamped and skills are not. Agents declare a task the same way they already declare
 * views — `metadata.sflow-model-task` — and never a model: the file names what kind of work it
 * does, and the mapping alone says which vendor answers `[ADP:CON-002]`.
 *
 * Mechanical, like the contract text beside it: hand-editing the stamped line is drift, and `check`
 * fails on it rather than letting one agent quietly pin a model nobody approved.
 *
 * Usage: `node scripts/stamp-agent-models.mjs [--check]`
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

import { normalizeModelTiers, tierLadder } from '../src/model-tiers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/** The generated line, so both the writer and the drift check agree on one shape. */
export function modelLine(models) {
  return `model: [${models.join(', ')}]`;
}

function splitFrontmatter(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  return { source: match[1], parsed: YAML.parse(match[1]) ?? {}, body: match[2] };
}

/**
 * Replace or insert the stamped line, leaving every hand-authored line exactly as written.
 *
 * Rewritten as text rather than re-serialized from the parsed object on purpose: dumping YAML would
 * reformat the whole file — quoting, ordering, flow style — and turn a one-model change into a diff
 * nobody can review.
 */
function stamp(source, models) {
  const line = modelLine(models);
  const lines = source.split(/\r?\n/);
  const existing = lines.findIndex((entry) => /^model:/.test(entry));
  if (existing >= 0) {
    if (lines[existing] === line) return { source, changed: false };
    lines[existing] = line;
    return { source: lines.join('\n'), changed: true };
  }
  // After `description`, where a reader looks for what the agent is before how it runs.
  const after = lines.findIndex((entry) => entry.startsWith('description:'));
  lines.splice(after >= 0 ? after + 1 : 0, 0, line);
  return { source: lines.join('\n'), changed: true };
}

const listing = spawnSync('git', ['ls-files', '*.agent.md'], { cwd: root, encoding: 'utf8' });
if (listing.status !== 0) {
  console.error(`Unable to list agent files: ${listing.stderr.trim()}`);
  process.exit(1);
}

const mapping = normalizeModelTiers(YAML.parse(await readFile(path.join(root, 'templates/modelTiers.yml'), 'utf8')));
const drifted = [];
const stamped = [];
const untasked = [];

for (const relative of listing.stdout.split('\n').filter(Boolean)) {
  const file = path.join(root, relative);
  const text = await readFile(file, 'utf8');
  const { source, parsed, body } = splitFrontmatter(text, relative);
  const task = parsed.metadata?.['sflow-model-task'] ?? null;
  if (!task) {
    // An agent with no declared task is not stamped and not an error — it inherits whatever the
    // host is already using, which is the behaviour that existed before any of this.
    untasked.push(relative);
    continue;
  }
  const ladder = tierLadder(mapping, task);
  const result = stamp(source, ladder.models);
  if (!result.changed) continue;
  if (CHECK_ONLY) { drifted.push(`${relative}: expected \`${modelLine(ladder.models)}\` for task '${task}'`); continue; }
  await writeFile(file, `---\n${result.source}\n---\n${body}`);
  stamped.push(`${relative} → ${ladder.models.join(' → ')}`);
}

if (CHECK_ONLY) {
  if (drifted.length) {
    console.error(`Agent model stamps are out of date (run: node scripts/stamp-agent-models.mjs):\n- ${drifted.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Agent model stamps current: ${listing.stdout.split('\n').filter(Boolean).length - untasked.length} stamped, ${untasked.length} untasked.`);
} else {
  console.log(stamped.length ? `Stamped ${stamped.length} agent(s):\n- ${stamped.join('\n- ')}` : 'Agent model stamps already current.');
}
