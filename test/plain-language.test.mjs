/**
 * Plain language: the words a person reads may only get plainer (scripts/plain-language-check.mjs).
 *
 * The owner could not understand what SFlow showed in a real Story (2026-11-16): a decisions card that
 * counted "1 still need a decision from you" without naming it and said "No recommendation" three
 * times, a next step to "review the guarded code successor boundary; preserve the published
 * generation", a refusal whose only way out was generic help. Existing violations are the committed
 * baseline; a new text passes the rules or names its exception with a reason.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_PATH, EXCEPTIONS, JARGON, KINDS, baselineOf, compare, scan, textViolations, textsOfSkill, textsOfSource
} from '../scripts/plain-language-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = 'node scripts/plain-language-check.mjs --update';
// One read of every source serves both tests that need it.
let scanned = null;
const scanOnce = () => (scanned ??= scan(root));

test('person-facing text gains no plain-language violation, and a fixed one is locked in', async () => {
  const result = await scanOnce();
  const committed = JSON.parse(await readFile(path.join(root, BASELINE_PATH), 'utf8'));
  const { rose, fell } = compare(committed, baselineOf(result), result.texts);
  assert.deepEqual(rose, [], 'say it in plain words (scripts/plain-language-check.mjs names each rule), '
    + 'or add an exception with its reason to EXCEPTIONS there');
  assert.deepEqual(fell, [], `fewer violations: lock the fall in with ${UPDATE}`);
  assert.deepEqual(result.unusedExceptions.map((entry) => `${entry.file}: ${entry.includes}`), [],
    'an exception that matches no text needing it: remove it');
  assert.deepEqual(committed.caps, Object.fromEntries(Object.entries(KINDS).map(([kind, { cap }]) => [kind, cap])),
    `the caps changed: regenerate the baseline with ${UPDATE}`);
});

test('every kind of person-facing text is found, so a broken reader cannot pass by finding nothing', async () => {
  const result = await scanOnce();
  const counted = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, result.texts.filter((entry) => entry.kind === kind).length]));
  // Measured 2026-11-16: narration 317, refusal 7561, refusal-step 262, next-label 480, next-reason 343, decision 633,
  // vscode-view 5573, skill-line 600. Each floor is about half, so moving texts around never trips it.
  const floors = { narration: 150, refusal: 3500, 'refusal-step': 120, 'next-label': 200, 'next-reason': 150, decision: 300, 'vscode-view': 2500, 'skill-line': 300 };
  for (const [kind, floor] of Object.entries(floors)) assert.ok(counted[kind] >= floor, `${kind}: found ${counted[kind]} texts, expected at least ${floor}`);
});

test('the owner\'s examples of 2026-11-16 each break a rule', () => {
  const [nextStep] = textsOfSource('src/source-review-continuation.mjs', `
    const action = (skill, command, reason) => ({ skill, command, reason });
    action('/sf-recover', 'singularity-flow recover X', 'Review the guarded code successor boundary; preserve the published generation and its tests.');`);
  assert.deepEqual(textViolations(nextStep).filter((rule) => rule.startsWith('jargon:')).sort(),
    ['jargon:generation', 'jargon:published-generation', 'jargon:successor']);

  const [refusal] = textsOfSource('src/example.mjs', `
    throw new SingularityFlowError(\`Phase '\${phaseId}' must have a published generation before source review.\`, { code: 'EXAMPLE_GENERATION_REQUIRED' });`);
  assert.ok(textViolations(refusal).includes('generic-route'), 'only generic help gets past it');
  assert.ok(textViolations(refusal).includes('jargon:generation'));
  const [routed] = textsOfSource('src/example.mjs', `
    throw new SingularityFlowError('The step has no published version yet.', { code: 'EXAMPLE_REQUIRED', details: { nextAction: { command: 'singularity-flow prepare x' } } });`);
  assert.deepEqual(textViolations(routed), [], 'a refusal that names its way out, in plain words, passes');
  const [malformed] = textsOfSource('src/example.mjs', `
    throw new SingularityFlowError('Use: singularity-flow example <WORK-ID>.', { code: 'EXAMPLE_USAGE' });`);
  assert.deepEqual(textViolations(malformed), [], 'a malformed command is answered with the command\'s own forms');

  const card = textsOfSource('plugin/extensions/decisions/card.mjs', `
    const message = \`\${open ? \`\${open} still need a decision from you.\` : 'Nothing here waits on a decision from you.'}\`;
    const named = \`\${open} still need a decision from you: \${titles.join(', ')}.\`;`);
  assert.deepEqual(card.map((entry) => textViolations(entry).includes('count-without-name')), [true, false]);

  const [none] = textsOfSource('src/decision-advice.mjs', `
    const none = (why) => ({ option: null, why, words: \`No recommendation: \${why}\` });
    none('whether the change ships at this screen size at all.');`);
  assert.ok(textViolations(none).includes('no-recommendation'));
});

test('caps are measured per kind and a label is one line', () => {
  const label = (text) => ({ kind: 'next-label', file: 'src/x.mjs', text });
  assert.deepEqual(textViolations(label('Write the Specification')), []);
  assert.deepEqual(textViolations(label('Run the allowlisted acceptance commands on the code as it is now; fix what fails, then run them again.')), ['length']);
  for (const [kind, { cap, what }] of Object.entries(KINDS)) assert.ok(Number.isInteger(cap) && cap >= 60 && what, kind);
});

test('a step\'s generation is a version: "draft" stays the unpublished working copy', () => {
  const label = (text) => textViolations({ kind: 'next-label', file: 'src/x.mjs', text }).includes('draft-for-version');
  const [template] = textsOfSource('src/x.mjs', 'const next = { command: c, label: `Start draft ${next} of ${id}` };');
  assert.equal(textViolations(template).includes('draft-for-version'), true, 'draft {next}');
  assert.deepEqual(['Start draft 2 of Implementation', 'start draft N+1 for this change', 'Test the published draft'].map(label), [true, true, true]);
  assert.deepEqual(['Start version 2 of Implementation', 'Write the prepared draft, then check it', 'Discard draft {#number} of the configuration',
    '{agent} cannot draft {label}'].map(label), [false, false, false, false]);
});

test('jargon is read from the words, never from a command, a flag, a path or a slot', () => {
  const reason = (text) => ({ kind: 'next-reason', file: 'src/x.mjs', text });
  assert.deepEqual(textViolations(reason('Run singularity-flow phase show --generation 2 to see it.')), []);
  assert.deepEqual(textViolations(reason('Open {generation} in `src/kernel.mjs` and docs/ledger.md.')), []);
  assert.deepEqual(textViolations(reason('Keep the retained commit.')), ['jargon:retained']);
  for (const { term, pattern, instead } of JARGON) assert.ok(pattern instanceof RegExp && instead, term);
});

test('a skill\'s fixed lines are its quoted sentences, not its frontmatter', () => {
  const texts = textsOfSkill('plugin/skills/sflow-x/SKILL.md', '---\nargument-hint: "<WORK-ID> --phase <PHASE> --reason <TEXT>"\n---\nSay exactly: "The Story package is ready for review."\n');
  assert.deepEqual(texts.map((entry) => entry.text), ['The Story package is ready for review.']);
});

test('every exception names the rules it keeps and why', () => {
  for (const exception of EXCEPTIONS) {
    assert.ok(exception.file && exception.includes && exception.rules.length && exception.reason?.length > 10, JSON.stringify(exception));
  }
});
