/**
 * SFlow's text checks on SFlow's own text [OMK §7, probe P7]: a team's skill that is written like SFlow's own (it names
 * SFlow's commands, tells the person what to run, carries SFlow's template markers) must not be refused. So every tracked
 * text under plugin/skills/ and templates/ gives no block, and the lines to look at stay within a counted allowance.
 *
 * What the allowance holds, measured 2026-11-26 (checker sflow-text-checks/2): only `sflow-command` lines, in the skills
 * whose own job is a person's approval, decision, confirmation, appeal or pause (/sf-approve, /sf-decide, /sf-confirm,
 * /sf-appeal, /sf-pause, /sf-review-source, /sf-task …), the registry's notes about them, and one template comment that
 * names a person's approval. Each names a command a person runs; that is what the look asks a reader to confirm. The
 * allowance only falls: lower it when a change removes one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkImportText, IMPORT_SAFETY_CHECKER } from '../src/import-safety.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWANCE = Object.freeze({ files: 26, lines: 46, checks: ['sflow-command'] });

test("every tracked text of SFlow's own skills and templates gets no block from SFlow's text checks, and few looks", () => {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'plugin/skills', 'templates'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter((file) => /\.(?:md|ya?ml)$/u.test(file));
  assert.ok(files.length >= 300, `every skill and template is read (${files.length})`);
  const blocks = [];
  const looks = [];
  for (const file of files) {
    const result = checkImportText(readFileSync(path.join(ROOT, file), 'utf8'));
    assert.equal(result.checker, IMPORT_SAFETY_CHECKER);
    for (const entry of result.blocks) blocks.push(`${file}:${entry.line} [${entry.check}] ${entry.text}`);
    for (const entry of result.looks) looks.push({ file, line: entry.line, check: entry.check });
  }
  assert.deepEqual(blocks, [], "SFlow's own text is refused: fix the rule, or the text if it really tells an agent to get around a rule");
  const lookFiles = new Set(looks.map((entry) => entry.file));
  assert.deepEqual([...new Set(looks.map((entry) => entry.check))].filter((check) => !ALLOWANCE.checks.includes(check)), [],
    `only ${ALLOWANCE.checks.join(', ')} may ask for a look in SFlow's own text`);
  assert.ok(lookFiles.size <= ALLOWANCE.files && looks.length <= ALLOWANCE.lines,
    `${lookFiles.size} files and ${looks.length} lines ask for a look; the allowance is ${ALLOWANCE.files} files and ${ALLOWANCE.lines} lines:\n${looks.map((entry) => `${entry.file}:${entry.line} [${entry.check}]`).join('\n')}`);
});
