/**
 * SFlow fills what it knows: no new instruction tells an agent to copy a value SFlow holds [owner, 2026-11-20].
 *
 * Every refusal that said "copy … exactly" (a review's binding hashes, a plan row's pinned fields, a receipt token, a
 * staging path) showed that SFlow already had the value; the model copied it, slipped, and spent a repair or stopped.
 * Those are now written by SFlow (the review check, filled commands, confirm codes, default files). This ratchet keeps
 * the class closed: in src/ and the plugin's skills and agents, the count of each pattern per file may only go down.
 * The counts left are help text a person reads, a person's own deliberate retype (`return --apply --confirm
 * <WORK-ID>`), routes not yet filled (Epic and initiative receipts, admin digests), and path-correction refusals that
 * hand back the exact path. Lower a count when you remove one; never raise one: fill the value instead.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS = {
  'copy-exactly': /\bcop(?:y|ied|ying)\b[^.\n`]{0,80}\b(?:exactly|verbatim)\b/giu,
  'copy-each': /\bCopy each\b/gu,
  'token-placeholder': /<TOKEN>/gu,
  'path-placeholder': /<that-path>|<stagingPath>/gu,
  'confirm-placeholder': /--confirm <(?!CODE>)[A-Z0-9-]+>/gu
};

const BASELINE = {
  "plugin/skills/sflow-adhoc/SKILL.md": { 'confirm-placeholder': 2 },
  "plugin/skills/sflow-auto/SKILL.md": { 'confirm-placeholder': 4 },
  "plugin/skills/sflow-cancel/SKILL.md": { 'confirm-placeholder': 2 },
  "plugin/skills/sflow-capability-depend/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-capability-map/SKILL.md": { 'confirm-placeholder': 2 },
  "plugin/skills/sflow-capability-protect/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-continue/SKILL.md": { 'token-placeholder': 1, 'confirm-placeholder': 1 },
  "plugin/skills/sflow-epic-complete/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-epic-publish/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-epic-review-decision/SKILL.md": { 'token-placeholder': 3 },
  "plugin/skills/sflow-epic-start/SKILL.md": { 'token-placeholder': 2 },
  "plugin/skills/sflow-fix/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-initiative-approve/SKILL.md": { 'token-placeholder': 2 },
  "plugin/skills/sflow-initiative-materialize/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-initiative-start/SKILL.md": { 'token-placeholder': 2 },
  "plugin/skills/sflow-jira-initiative/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-jira-update/SKILL.md": { 'confirm-placeholder': 6 },
  "plugin/skills/sflow-mcp/SKILL.md": { 'confirm-placeholder': 3 },
  "plugin/skills/sflow-return/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-revision-attachments/SKILL.md": { 'confirm-placeholder': 1 },
  "plugin/skills/sflow-start/SKILL.md": { 'token-placeholder': 1 },
  "plugin/skills/sflow-story-start/SKILL.md": { 'token-placeholder': 1 },
  "plugin/skills/sflow-workflows/SKILL.md": { 'confirm-placeholder': 3 },
  "plugin/skills/sflow-workspace-bootstrap/SKILL.md": { 'confirm-placeholder': 1 },
  "src/auto/auto-flight-store.mjs": { 'confirm-placeholder': 1 },
  "src/commands/lock.mjs": { 'token-placeholder': 3, 'confirm-placeholder': 3 },
  "src/commands/revision.mjs": { 'confirm-placeholder': 1 },
  "src/commands/sgos.mjs": { 'confirm-placeholder': 1 },
  "src/config.mjs": { 'copy-exactly': 1 },
  "src/configuration-restore.mjs": { 'confirm-placeholder': 1 },
  "src/confirm-code.mjs": { 'confirm-placeholder': 1 },
  "src/copilot-mutation-guard.mjs": { 'copy-exactly': 3, 'token-placeholder': 2, 'confirm-placeholder': 1 },
  "src/evidence/responsibilities.mjs": { 'copy-exactly': 1 },
  "src/help-pages.mjs": { 'confirm-placeholder': 9 },
  "src/help-text.mjs": { 'token-placeholder': 5, 'confirm-placeholder': 51 },
  "src/phase-roles.mjs": { 'copy-exactly': 1 },
  "src/presence/store-seals.mjs": { 'confirm-placeholder': 3 },
  "src/recovery-set-aside.mjs": { 'copy-exactly': 2 },
  "src/reference-prefetch.mjs": { 'copy-exactly': 1 },
  "src/refusal-remediation.mjs": { 'copy-exactly': 1 },
  "src/sgos/platform/authority-store.mjs": { 'token-placeholder': 1, 'confirm-placeholder': 1 },
  "src/spec-library/proposals.mjs": { 'copy-exactly': 2 },
  "src/workflow-assess/index.mjs": { 'copy-exactly': 2 },
  "src/workflow-transfer.mjs": { 'copy-exactly': 1 }
};

function scanned() {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.mjs$/u.test(name) || /^SKILL\.md$|\.agent\.md$/u.test(name)) files.push(full);
    }
  };
  for (const folder of ['src', 'plugin/skills', 'plugin/agents']) walk(path.join(ROOT, folder));
  const counts = {};
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      const count = [...text.matchAll(pattern)].length;
      if (count) (counts[path.relative(ROOT, file).split(path.sep).join('/')] ??= {})[name] = count;
    }
  }
  return counts;
}

test('no new instruction tells an agent to copy a value SFlow already holds', () => {
  const counts = scanned();
  const raised = [];
  const lowered = [];
  for (const file of new Set([...Object.keys(counts), ...Object.keys(BASELINE)])) {
    for (const name of Object.keys(PATTERNS)) {
      const now = counts[file]?.[name] ?? 0;
      const allowed = BASELINE[file]?.[name] ?? 0;
      if (now > allowed) raised.push(`${file}: ${name} ${allowed} -> ${now}`);
      if (now < allowed) lowered.push(`${file}: ${name} ${allowed} -> ${now}`);
    }
  }
  assert.deepEqual(raised, [], 'A new "copy it exactly" instruction, <TOKEN>, <that-path> or --confirm <VALUE>: have SFlow write the value (a filled command, a confirm code, a default file, or the review check) instead.');
  assert.deepEqual(lowered, [], 'Fewer than the baseline: lower BASELINE in this test to the new count.');
});
