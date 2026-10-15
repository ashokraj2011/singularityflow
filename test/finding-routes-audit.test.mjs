/**
 * No finding is a dead end. `[recoverable-findings M4]`
 *
 * Owner rule (2026-10-15): any issue in any phase is recoverable with correct documentation and
 * appeal. Every finding the recovery routes can name carries its documentation entry and at least
 * one route someone other than the step's own author can act on, so an author who cannot fix it
 * (an earlier step owns it, a person must decide, or the check misreads correct work) is never
 * routed only back to itself.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { phaseResolutionChoices } from '../src/phase-resolution.mjs';

const source = (relative) => readFile(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
const workflow = { workItem: { id: 'AUDIT-1' }, currentPhase: 'implementation', status: 'in_progress',
  phaseOrder: ['intake', 'implementation'],
  phases: { intake: { id: 'intake', status: 'approved' },
    implementation: { id: 'implementation', status: 'in_progress', writeScope: 'source-and-artifact', generationIntent: { status: 'open' } } } };
const phase = workflow.phases.implementation;

async function representativeFindings() {
  const resolution = await source('phase-resolution.mjs');
  const policy = await source('phase-finding-policy.mjs');
  const codes = new Set([
    ...[...resolution.matchAll(/code === '([^']+)'/gu)].map((match) => match[1]),
    ...[...resolution.matchAll(/code\.startsWith\('([^']+)'\)/gu)].map((match) => `${match[1]}_example`),
    ...[...`${resolution}\n${policy}`.matchAll(/new Set\(\[([^\]]+)\]\)/gu)]
      .flatMap((match) => [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])).filter((value) => /[._]/u.test(value))
  ]);
  const categories = new Set([...`${policy}`.matchAll(/'([a-z][a-z-]*)'/gu)].map((match) => match[1])
    .filter((value) => !/^(?:owned-author|owner-review|quality|integrity-or-authority|upstream-defect|raise-upstream-issue|current-phase-preparation|prepare-current-generation|worktree-review|review-and-scoped-commit|scope-or-evidence-review|author-correction|human-input|record-real-answer|operational-prerequisite|configured-owner-action|lifecycle|resume-or-successor|owner-resolution|authenticated-restoration-or-amendment)$/u.test(value)));
  for (const extra of ['integrity', 'configuration', 'worktree', 'clarification', 'lifecycle', 'coverage', 'appeal', 'quality-coverage', 'inputs']) categories.add(extra);
  return [
    ...[...codes].flatMap((code) => [{ code }, { code: code.toUpperCase() }]),
    ...[...categories].map((category) => ({ code: 'A_FINDING', category })),
    { code: 'A_CODE_NOBODY_REGISTERED' }
  ];
}

test('every finding carries its documentation and a route for someone other than its author', async () => {
  const findings = await representativeFindings();
  assert.ok(findings.length >= 60, String(findings.length));
  const deadEnds = [];
  for (const finding of findings) {
    const choices = phaseResolutionChoices(workflow, phase, finding);
    assert.match(choices.documentation?.command ?? '', /^singularity-flow explain findings --section /u, JSON.stringify(finding));
    if (!choices.choices.some((choice) => choice.owner !== phase.id)) deadEnds.push(JSON.stringify(finding));
  }
  assert.deepEqual(deadEnds, []);
});

test('the dispute route names the canonical gate whatever case the finding used, and the maintainer route only fills a gap', () => {
  for (const code of ['CODE_DELIVERY_EVIDENCE_REQUIRED', 'code_delivery_evidence_required']) {
    const dispute = phaseResolutionChoices(workflow, phase, { code }).choices.find((choice) => choice.kind === 'dispute');
    assert.equal(dispute.owner, 'phase-approval-authority');
    assert.equal(dispute.argv[dispute.argv.indexOf('--finding') + 1], 'CODE_DELIVERY_EVIDENCE_REQUIRED', code);
    assert.ok(!phaseResolutionChoices(workflow, phase, { code }).choices.some((choice) => choice.kind === 'maintainer-escalation'),
      'a disputable finding already has its approvers');
  }
  const brief = phaseResolutionChoices(workflow, phase, { code: 'AGENT_BRIEF_SUMMARY_REQUIRED' }).choices;
  assert.deepEqual(brief.map((choice) => choice.kind), ['author-correction', 'inspect', 'maintainer-escalation', 'preserve-checkpoint']);
  assert.match(brief[2].detail, /explain findings --section "Agent brief findings"/u);
  const unclaimed = phaseResolutionChoices(workflow, phase, { code: 'SPEC_COVERAGE_INCOMPLETE',
    details: { coverage: { unclaimedChangedPaths: ['src/extra.mjs'] } } }).choices;
  assert.ok(!unclaimed.some((choice) => choice.kind === 'maintainer-escalation'), 'the plan approvers are already named');
});
