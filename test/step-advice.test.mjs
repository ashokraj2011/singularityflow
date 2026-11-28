/**
 * One internal advice table, keyed by what a step is for (src/step-advice.mjs) [owner, 2026-11-28: "these things should be
 * part of sf-phase, sf-code etc and some kind of internal advice to each phase so this will be generic"]. Every approval
 * and stop surface reads its why line there, never by workflow or work type; a custom workflow gets the same lines.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADVICE_FIELDS, ADVICE_INTENTS, adviceForStep, GENERIC_INTENT, STEP_ADVICE, STOP_KINDS, stepAdvice, stepIntentOf, stopAdvice, WHEN_ADVICE }
  from '../src/step-advice.mjs';
import { storyStepIntent } from '../src/step-advice-intent.mjs';
import { STEP_INTENTS } from '../src/phase-roles.mjs';
import { JARGON } from '../scripts/plain-language-check.mjs';
import { approvalReviewPage } from './helpers/approval-review-page.mjs';

// The page runs in its own context (approval-review-page.mjs): its objects compare by their values.
const plain = (value) => JSON.parse(JSON.stringify(value));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every intent has every field, and every stop its way forward, in plain short words', () => {
  assert.deepEqual(Object.keys(STEP_ADVICE).sort(), [...ADVICE_INTENTS].sort());
  assert.deepEqual(ADVICE_INTENTS, [...STEP_INTENTS, GENERIC_INTENT], 'the ten step intents and the generic one');
  for (const intent of ADVICE_INTENTS) {
    const entry = STEP_ADVICE[intent];
    assert.deepEqual(Object.keys(entry).sort(), [...ADVICE_FIELDS].sort(), intent);
    assert.deepEqual(Object.keys(entry.stops).sort(), [...STOP_KINDS].sort(), intent);
    const filled = stepAdvice(intent, { step: 'Implementation spec' });
    const lines = [...ADVICE_FIELDS.filter((field) => field !== 'stops').map((field) => [field, filled[field]]),
      ...STOP_KINDS.map((kind) => [`stops.${kind}`, filled.stops[kind]])];
    for (const [field, line] of lines) {
      assert.equal(typeof line, 'string', `${intent}.${field}`);
      assert.ok(line.length >= 20 && line.length <= 160, `${intent}.${field} is ${line.length} characters: ${line}`);
      assert.match(line, /\.$/u, `${intent}.${field} is one sentence`);
      assert.doesNotMatch(line, /\{step\}/u, `${intent}.${field} is filled`);
      for (const { term, pattern } of JARGON) assert.doesNotMatch(line, pattern, `${intent}.${field} uses "${term}"`);
    }
    // Each button's line starts with the button it is about.
    assert.match(filled.yes, /^Yes: /u, intent);
    assert.match(filled.sendBack, /^Send back: /u, intent);
    assert.match(filled.notNow, /^Not now: /u, intent);
  }
  // Lines that replace an intent's for a fact about the step (never a workflow's name): every one a known intent's field.
  for (const [fact, intents] of Object.entries(WHEN_ADVICE)) {
    for (const [intent, lines] of Object.entries(intents)) {
      assert.ok(ADVICE_INTENTS.includes(intent), `${fact}: ${intent}`);
      for (const [field, line] of Object.entries(lines)) {
        assert.ok(ADVICE_FIELDS.includes(field) && field !== 'stops', `${fact}.${intent}.${field}`);
        assert.ok(line.length <= 160, `${fact}.${intent}.${field}`);
        assert.equal(stepAdvice(intent, { when: [fact] })[field], line);
      }
    }
  }
});

test('/sf-task v1.2\'s approval lines are the table\'s: the task keeps only its size choice', async () => {
  const shape = await readFile(path.join(ROOT, 'src/task-shape.mjs'), 'utf8');
  assert.match(shape, /stepAdvice\(step\.intent, \{ when: \[refactor \? 'keeps-behaviour' : 'tests-approved-by-sflow'\] \}\)/u);
  assert.doesNotMatch(shape, /You decide (?:how|what|whether)/u, 'no approval why of its own');
  assert.match(shape, /const SIZE_YES = /u, 'the size choice stays the task\'s');
}); 

test('a step\'s intent: what it names, else the one SFlow ships, else the step-intent inference, else the generic lines', async () => {
  const workflow = (phases, resolved = phases) => ({ phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, { label: phase.label ?? phase.id }])),
    resolution: { phases: resolved } });
  // Named on the step (a version 4 workflow's `intent:`, pinned in the resolution).
  assert.equal(stepIntentOf(workflow([{ id: 'checks', intent: 'test' }]), 'checks'), 'test');
  // A shipped step by its ID.
  assert.equal(stepIntentOf(workflow([{ id: 'implementation' }]), 'implementation'), 'code');
  // A custom workflow's step that names nothing: inferred from what it does, with no change to its definition.
  const custom = workflow([{ id: 'gather-needs', label: 'Gather needs' }, { id: 'make-it', label: 'Make it', generation: { task: 'code' }, writeScope: 'source-and-artifact' },
    { id: 'try-it-out', label: 'Try it out', repositoryTests: 'run' }]);
  assert.equal(await storyStepIntent(custom, 'make-it'), 'code');
  assert.equal(await storyStepIntent(custom, 'try-it-out'), 'test');
  assert.equal(adviceForStep(custom, 'make-it', await storyStepIntent(custom, 'make-it')).decides, STEP_ADVICE.code.decides);
  // Nothing to tell from: the generic lines, never a guess and never a throw.
  assert.equal(stepIntentOf(null, 'something-new'), GENERIC_INTENT);
  assert.equal(await storyStepIntent({}, 'something-new'), GENERIC_INTENT);
  assert.equal(stepAdvice('not-an-intent').intent, GENERIC_INTENT);
  assert.equal(stopAdvice('plan', 'changed', { step: 'Planning' }), 'Planning changed after it was reviewed, so this is not what was reviewed: Send back so the change is reviewed.');
});

/** Every approval and stop surface, and how it reads the table: an import of it, or the line the CLI carried from it. */
const SURFACES = Object.freeze({
  'src/decision-list.mjs': /adviceForStep\(workflow, phase\.id, context\.facts\?\.stepIntent/u,
  'src/decision-plain.mjs': /const asked = typeof details\.advice\?\.decides === 'string'/u,
  'src/decision-list-reads.mjs': /'step-advice-intent\.mjs'\)\)\.href\)\s+\.then\(\(module\) => module\.storyStepIntent\(workflow, phase\.id\)/u,
  'src/commands/approval-packet.mjs': /adviceForStep\(workflow, phaseId, await storyStepIntent\(workflow, phaseId\)\)/u,
  'src/agent-output.mjs': /why: result\.advice\.decides/u,
  'src/needs-you-items.mjs': /adviceForStep\(workflow, phaseId\)\.decides/u,
  'src/refusal-remediation.mjs': /stopAdvice\(stepIntentOf\(null, phase\), 'changed'/u,
  'src/finding-escalation.mjs': /stopAdvice\(stepIntentOf\(null, phaseId\), 'repeated'/u,
  'src/task-shape.mjs': /stepAdvice\(step\.intent, /u,
  'src/phase-publication-readiness.mjs': /stopAdvice\(advice\.stepIntentOf\(workflow, phase\.id\), 'browser'/u,
  'apps/vscode/src/views/approval-review.ts': /const advice = approvalAdvice\(request\);/u,
  'apps/vscode/src/actions.ts': /advice = \(await import\('\.\/views\/approval-review\.ts'\)\)\.adviceOf\(listed\)/u,
  'plugin/skills/sflow-approve/SKILL.md': /Say `act\.ask\.why`\. Ask `act\.ask\.question`/u
});

async function sourceFiles(directory) {
  const entries = await readdir(path.join(ROOT, directory), { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(relative);
    return /\.(?:mjs|ts|md)$/u.test(entry.name) ? [relative] : [];
  }))).flat();
}

test('every approval and stop surface reads its why line from the table, and no surface writes one itself', async () => {
  for (const [file, reads] of Object.entries(SURFACES)) assert.match(await readFile(path.join(ROOT, file), 'utf8'), reads, `${file} reads the advice table`);
  // A table line copied anywhere else would drift from it: each line's words, split at the step's name, live only in the table.
  const fragments = ADVICE_INTENTS.flatMap((intent) => {
    const entry = STEP_ADVICE[intent];
    return [...ADVICE_FIELDS.filter((field) => field !== 'stops').map((field) => entry[field]), ...Object.values(entry.stops)];
  }).concat(Object.values(WHEN_ADVICE).flatMap((intents) => Object.values(intents).flatMap((lines) => Object.values(lines))))
    .flatMap((line) => line.split('{step}')).map((part) => part.trim()).filter((part) => part.length >= 30);
  const copies = [];
  for (const file of [...await sourceFiles('src'), ...await sourceFiles('apps/vscode/src'), ...await sourceFiles('plugin/skills')]) {
    if (file === 'src/step-advice.mjs' || file === 'src/step-advice-intent.mjs') continue;
    const text = await readFile(path.join(ROOT, file), 'utf8');
    for (const fragment of new Set(fragments)) if (text.includes(fragment)) copies.push(`${file}: "${fragment}"`);
  }
  assert.deepEqual(copies, [], 'a why line written outside src/step-advice.mjs');
  // And the surfaces build no why line of their own in the table's words.
  for (const file of Object.keys(SURFACES).filter((name) => !name.endsWith('.md'))) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /['"`]You decide if /u, `${file} writes a "You decide if" line itself`);
    assert.doesNotMatch(text, /Why you are asked:<\/strong> [A-Za-z]/u, `${file} writes its why after the label itself`);
  }
});

test('the approval page says why the person is asked and what each button does, from the step\'s advice', async () => {
  const page = await approvalReviewPage();
  const request = { title: 'Approve Planning', expected: 'planning', workId: 'ADV-1', phaseId: 'planning', phaseLabel: 'Planning', generation: 2,
    artifact: null, articles: [], findings: [], witnessedClauses: null, priorExceptions: [], selfApproval: false };
  const advice = adviceForStep({ phases: { planning: { label: 'Planning' } } }, 'planning');
  const html = page.approvalReviewBody({ ...request, advice });
  const escaped = (text) => text.replaceAll('\'', '&#39;');
  assert.ok(html.includes(`<strong>Why you are asked:</strong> ${escaped(advice.decides)}`), html);
  for (const [line, label] of [[advice.yes, 'Yes'], [advice.sendBack, 'Send back'], [advice.notNow, 'Not now']]) {
    assert.ok(html.includes(escaped(page.afterLabel(line, label))), line);
  }
  // A list without advice (an older engine): the extension gives the page the table's generic lines; the page writes none itself.
  assert.doesNotMatch(page.approvalReviewBody(request), /Why you are asked/u);
  assert.match(await readFile(path.join(ROOT, 'apps/vscode/src/actions.ts'), 'utf8'), /\?\? \(await import\('\.\.\/\.\.\/\.\.\/src\/step-advice\.mjs'\)\)\.stepAdvice\('generic'/u);
  // The decision list's approval item carries the advice the page reads.
  assert.deepEqual(plain(page.adviceOf({ items: [{ kind: 'approval', details: { advice } }] })), { decides: advice.decides, yes: advice.yes,
    sendBack: advice.sendBack, notNow: advice.notNow, settles: advice.settles, stops: advice.stops });
  assert.equal(page.adviceOf({ items: [{ kind: 'approval', details: {} }] }), null);
});
