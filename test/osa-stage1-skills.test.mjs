/**
 * SPEC-OSA v1.1 AC-008 for the Stage 1 cohort: the work, next, recover and review skills name only supported routes,
 * keep no lifecycle test of their own beyond the one declared restatement below, and the work command follows the
 * entry's `act`, which the kernel's decision now decides [OSA:AC-008, REQ-021, REQ-023].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = ['code', 'phase', 'next', 'recover', 'review-source'];
const skill = (name) => readFileSync(path.join(root, 'plugin', 'skills', `sflow-${name}`, 'SKILL.md'), 'utf8');

/**
 * The one place a cohort skill still restates a lifecycle test: /sf-code's "open intent" lines, which agree with the
 * kernel (version 1 or a returned step opens with `phase begin`) and which Stage 4 replaces with the issued action alone
 * (decision inventory c7; plugin, skill-efficiency and phase-authoring-skills pin the wording until then).
 */
const DECLARED = [{ skill: 'code', text: 'Require open intent.', owner: 'Stage 4 (c7, REQ-024)' },
  { skill: 'code', text: 'Absent: `singularity-flow phase begin <phase> --json`', owner: 'Stage 4 (c7, REQ-024)' }];

test('every SFlow command the cohort\'s skills name is a supported route [OSA:AC-008, AC-003]', () => {
  for (const name of SKILLS) {
    const commands = [...skill(name).matchAll(/`(singularity-flow [^`]+)`/gu)].map((match) => match[1]);
    assert.ok(commands.length > 0, name);
    for (const command of commands) {
      const concrete = command.replace(/<[^>]+>|\$ARGUMENTS/gu, 'X-1').replace(/"[^"]*"/gu, 'why');
      assert.ok(safeCommandGuidance({ command: concrete }), `${name}: ${command}`);
    }
  }
});

test('the cohort\'s skills read no lifecycle field themselves; the work command follows the entry\'s act [OSA:AC-008]', () => {
  for (const name of SKILLS) {
    let text = skill(name);
    for (const declared of DECLARED.filter((entry) => entry.skill === name)) {
      assert.ok(text.includes(declared.text), `${name}: the declared restatement "${declared.text}" is gone: delete its entry`);
      text = text.replace(declared.text, '');
    }
    // A raw read of the opening, the counters or the version arithmetic is the kernel's, never a skill's.
    assert.doesNotMatch(text, /generationIntent|generationHighWatermark|generation\s*[+-]\s*1|intent\.status|status\s*===?\s*['"`]open/iu, name);
    // Recovery is offered for damage or an unverified policy only, never as a healthy step's way on [OSA:REQ-003].
    for (const [sentence] of text.matchAll(/[^.\n]*(?:\/sf-recover|singularity-flow recover)[^.\n]*/gu)) {
      if (name === 'recover') continue;
      assert.match(sentence, /repair|policyVerified|damag|interrupt/iu, `${name}: "${sentence.trim()}"`);
    }
  }
  assert.match(skill('code'), /Consumed intent: follow the entry's `act`/u);
});
