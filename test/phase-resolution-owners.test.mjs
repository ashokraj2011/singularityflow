/**
 * Every finding a Story step can raise names who fixes it; none falls to "No automatic repair or waiver is registered
 * … give the maintainer" and /sf-doctor because no rule knew it (owner's d-story, 2026-11-23).
 *
 * On verification version 12, prepublish raised conformance.witness-uncited under the category 'evidence'. Its act told
 * the author to re-author every finding, and its resolution, for the same findings, told it to give them to the
 * maintainer. The author stopped with the draft unchanged.
 *
 * This walks every finding SFlow's source builds (a code and a category in one object, or a named *_CODE constant),
 * and the codes that reach a step's checks from a thrown error. Each must have its own route. A route to the
 * maintainer with its own reason is a decision, listed below. And the draft's author is never told to re-author
 * findings that are not its own.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { foreignFindingGuidance, phaseResolutionChoices } from '../src/phase-resolution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A finding no rule names: its own draft's to read and correct (no longer "give the maintainer this", owner 2026-11-28).
const GENERIC = 'No rule names this finding';
/** Findings whose route is the maintainer by decision, each with why. */
const MAINTAINER_BY_DECISION = Object.freeze({
  GENERATION_PUBLICATION_INVALID: 'the published commit or its file is missing from the repository; recovery names the same route',
  GENERATION_PUBLICATION_MISSING: 'the published commit or its file is missing from the repository; recovery names the same route',
  WCA_SKP_FINALIZATION_INVALID: 'a workflow compiler finding in Workflow Studio, never a Story step\'s'
});

/** Every finding the source builds: a code (or a *_CODE constant) and a category in one object literal. */
function sourceFindings() {
  const files = [];
  const walk = (folder) => { for (const name of readdirSync(folder)) { const file = path.join(folder, name); if (statSync(file).isDirectory()) walk(file); else if (name.endsWith('.mjs')) files.push(file); } };
  walk(path.join(root, 'src'));
  const constants = new Map();
  for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*'([A-Za-z][\w.-]+)'/gu)) constants.set(match[1], match[2]);
  const found = new Map();
  const add = (code, category, file) => { const key = `${code}|${category}`; if (!found.has(key)) found.set(key, { code, category, file: path.relative(root, file) }); };
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/code:\s*(?:[\w.?[\]]+\s*\?\?\s*)?['`]([A-Za-z][\w.-]+)['`][^{}]{0,300}?category:\s*['`]([a-z-]+)['`]|category:\s*['`]([a-z-]+)['`][^{}]{0,300}?code:\s*(?:[\w.?[\]]+\s*\?\?\s*)?['`]([A-Za-z][\w.-]+)['`]/gu)) {
      add(match[1] ?? match[4], match[2] ?? match[3], file);
    }
    for (const match of text.matchAll(/code:\s*([A-Z][A-Z0-9_]+_CODE)\b[^{}]{0,300}?category:\s*['`]([a-z-]+)['`]/gu)) {
      if (constants.has(match[1])) add(constants.get(match[1]), match[2], file);
    }
  }
  return [...found.values()];
}

const phaseOf = (id, extra = {}) => ({ id, status: 'in_progress', generation: 2, generationPolicy: { defaultProducer: 'governed-agent' }, ...extra });
const storyWith = (phase) => ({ workItem: { id: 'D-1' }, status: 'in_progress', currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: { phases: [] } });

test('every finding a step can raise names who fixes it, never the maintainer for want of a rule', () => {
  const findings = sourceFindings();
  assert.ok(findings.length >= 50, `${findings.length} findings found in src`);
  assert.ok(findings.some((entry) => entry.code === 'conformance.witness-uncited'), 'the d-story finding, built with a named constant, is walked');
  // And the codes that come from a thrown error, with the category each check gives them.
  const thrown = [['CHANGE_SET_POLICY_VIOLATION', 'change-scope'], ['PHASE_ARTIFACT_ONLY_CHANGES', 'change-scope'], ['PHASE_SOURCE_CHANGE_UNGOVERNED', 'change-scope'],
    ['TRP_PHASE_GATE_BLOCKED', 'code-delivery'], ['TRP_RISK_REVIEW_STALE', 'code-delivery'], ['TRP_DOCUMENT_GATE_BLOCKED', 'code-delivery'],
    ['PHASE_QUALITY_RISK_INTEGRITY', 'records'], ['EVIDENCE_TEST_RECEIPT_UNREADABLE', 'records'], ['GENERATION_BOUNDARY_UNVERIFIED', 'lifecycle']]
    .map(([code, category]) => ({ code, category, file: 'thrown' }));
  const missing = [];
  for (const phase of [phaseOf('verification'), phaseOf('implementation', { generationPolicy: { defaultProducer: 'governed-agent', task: 'code' } })]) {
    for (const { code, category, file } of [...findings, ...thrown]) {
      const { choices } = phaseResolutionChoices(storyWith(phase), phase, { code, category, path: `singularity/work-items/D-1/artifacts/${phase.id}/report.md`, message: `${code} in the draft.` });
      const [lead] = choices;
      if (lead.detail.startsWith(GENERIC) && !MAINTAINER_BY_DECISION[code]) missing.push(`${code} (${category}, ${file}) on ${phase.id}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'each needs its owner in phase-resolution.mjs or phase-finding-policy.mjs');
  // Each listed decision still names a finding the source builds, so the list cannot go stale.
  for (const code of Object.keys(MAINTAINER_BY_DECISION)) assert.ok(findings.some((entry) => entry.code === code), code);
});

test('the owners SFlow already knew lead: the risk reviewers, an assignment, where the step stands, and the exact preserved state', () => {
  const phase = phaseOf('implementation', { generationPolicy: { defaultProducer: 'governed-agent', task: 'code' } });
  const story = storyWith(phase);
  const lead = (finding) => phaseResolutionChoices(story, phase, finding).choices[0];
  // A Story with test-run risk recovery: its exact observation, then its delegated reviewers. Without it, where the step stands.
  const risky = { ...story, testRecovery: { enabled: true } };
  assert.deepEqual(phaseResolutionChoices(risky, phase, { code: 'TRP_PHASE_GATE_BLOCKED', category: 'code-delivery' }).choices[0].argv,
    ['story', 'test-policy', 'risks', '--work-id', 'D-1', '--phase', 'implementation', '--operation', 'publish', '--json']);
  assert.deepEqual(lead({ code: 'TRP_PHASE_GATE_BLOCKED', category: 'code-delivery' }).argv, ['nextsteps', 'D-1', '--json']);
  const assignment = phaseResolutionChoices(story, phase, { code: 'phase.assignment.required', category: 'collaboration' });
  assert.deepEqual([assignment.choices[0].argv, assignment.choices[0].skill, assignment.status], [['assign', 'implementation', '<assignee>'], '/sf-assign', 'needs-human']);
  assert.deepEqual(lead({ code: 'phase.lifecycle.not-publishable', category: 'lifecycle' }).argv, ['nextsteps', 'D-1', '--json']);
  for (const finding of [{ code: 'code.generation.intent-unverified', category: 'lifecycle' }, { code: 'EVIDENCE_RECORDS_UNTRUSTED', category: 'records' }]) {
    assert.deepEqual(lead(finding).argv, ['recover', 'D-1', '--phase', 'implementation', '--json'], finding.code);
  }
  assert.equal(lead({ code: 'CHANGE_SET_POLICY_VIOLATION', category: 'change-scope' }).kind, 'worktree-review');
  assert.equal(lead({ code: 'phase.evidence-contract.not-ready', category: 'evidence-contract', path: 'evidence/a.png' }).kind, 'human-review');
  // A finding that names its own next command keeps it; a quoted one is never split into words.
  assert.deepEqual(lead({ code: 'SOMETHING_NEW', category: 'inspection-unavailable', details: { nextAction: { command: 'singularity-flow decisions D-1', label: 'Decide it.', skill: '/sf-decide' } } }).argv, ['decisions', 'D-1']);
  assert.ok(lead({ code: 'SOMETHING_NEW', category: 'inspection-unavailable', details: { nextAction: 'singularity-flow note "two words"' } }).detail.startsWith(GENERIC));
  // Changed code with no test signal: its own author adds the assertion; a later step reports it as advisory.
  assert.equal(lead({ code: 'code.verification.corner-case-uncovered', category: 'verification', message: 'Changed branch has no test.' }).kind, 'author-correction');
  const later = phaseOf('verification');
  assert.equal(phaseResolutionChoices(storyWith(later), later, { code: 'code.verification.corner-case-uncovered', category: 'verification' }).choices[0].kind, 'inspect');
});

test('an author is never told to re-author findings none of which is its own; its own still lead', () => {
  const phase = phaseOf('verification');
  const story = storyWith(phase);
  const assignment = { code: 'phase.assignment.required', category: 'collaboration', message: 'Assign it.' };
  assert.match(foreignFindingGuidance(story, phase, [assignment]),
    /^No finding here is this draft's to re-author\. Assign who owns verification, then recheck\. Nothing in the draft changes\. Next: singularity-flow assign verification <assignee>$/u);
  const own = { code: 'conformance.witness-uncited', category: 'evidence', path: 'singularity/work-items/D-1/artifacts/verification/test-evidence.md', message: 'Cite WIT-001 there.' };
  assert.equal(foreignFindingGuidance(story, phase, [assignment, own]), null, 'with one of its own, the author repairs it first');
  assert.equal(foreignFindingGuidance(story, phase, []), null);
});
