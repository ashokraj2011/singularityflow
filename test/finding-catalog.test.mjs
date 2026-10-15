/**
 * Every blocking finding is documented. `[recoverable-findings M1]`
 *
 * A refusal named a code and routed the author back to repair it, with nothing saying what the code
 * meant or who else could act. This fails when a code the recovery routes or the finding policy
 * name, or any finding class, has no entry in the `findings` topic.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadTopics, sectionOf } from '../src/docs-topics.mjs';
import { findingCatalogSections, findingDocumentation, specificFindingDocumentation } from '../src/finding-catalog.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';

const source = (relative) => readFile(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
const topic = async () => (await loadTopics()).find((entry) => entry.id === 'findings');

test('every catalog section and every finding class has an entry in the findings topic', async () => {
  const { body } = await topic();
  const policy = await source('phase-finding-policy.mjs');
  const classes = [...new Set([...policy.matchAll(/classification = '([a-z-]+)'/gu)].map((match) => match[1]))];
  assert.ok(classes.length >= 10, classes.join(', '));
  for (const section of [...findingCatalogSections(), ...classes]) {
    assert.ok(sectionOf(body, section), `findings topic has no section '${section}'`);
  }
});

test('every code the recovery routes or the finding policy name has its own entry, not just its class', async () => {
  const resolution = await source('phase-resolution.mjs');
  const policy = await source('phase-finding-policy.mjs');
  const literals = new Set([
    ...[...resolution.matchAll(/code === '([^']+)'/gu)].map((match) => match[1]),
    ...[...resolution.matchAll(/code\.startsWith\('([^']+)'\)/gu)].map((match) => `${match[1]}_example`),
    ...[...`${resolution}\n${policy}`.matchAll(/new Set\(\[([^\]]+)\]\)/gu)]
      .flatMap((match) => [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]))
      // Category names share these sets' syntax; they are documented by their class.
      .filter((value) => /[._]/u.test(value) && !/^(?:integration|transport|external-evidence)$/u.test(value))
  ]);
  assert.ok(literals.size >= 25, [...literals].join(', '));
  const undocumented = [...literals].filter((code) => !specificFindingDocumentation(code));
  assert.deepEqual(undocumented, []);
});

test('a finding without its own entry is documented by its class, and every route carries its entry', () => {
  const workflow = { workItem: { id: 'DOC-1' }, currentPhase: 'implementation', status: 'in_progress',
    phases: { implementation: { id: 'implementation', status: 'in_progress', generationIntent: { status: 'open' } } } };
  const phase = workflow.phases.implementation;
  assert.equal(findingDocumentation({ code: 'A_CODE_NOBODY_REGISTERED' }).section, 'owner-resolution');
  assert.equal(findingDocumentation({ code: 'protected_path_changed' }).section, 'integrity-or-authority');
  const choices = phaseResolutionChoices(workflow, phase, { code: 'CODE_DELIVERY_EVIDENCE_REQUIRED' });
  assert.equal(choices.documentation.command, 'singularity-flow explain findings --section CODE_DELIVERY_EVIDENCE_REQUIRED');
  assert.deepEqual(choices.documentation.argv, ['explain', 'findings', '--section', 'CODE_DELIVERY_EVIDENCE_REQUIRED']);
});

test('a refusal with a catalogued code names its entry; others are unchanged', () => {
  const plan = (code) => refusalRemediationPlan(Object.assign(new Error('refused'), { code, details: { phase: 'implementation' } }),
    ['phase', 'publish', 'implementation']);
  const documented = plan('CODE_DELIVERY_EVIDENCE_REQUIRED');
  assert.equal(documented.documentation.section, 'CODE_DELIVERY_EVIDENCE_REQUIRED');
  assert.match(renderRefusalPlan(documented), /\n {2}Documentation: singularity-flow explain findings --section CODE_DELIVERY_EVIDENCE_REQUIRED\n {2}Then: /u);
  const other = plan('WORKSPACE_SOMETHING_ELSE');
  assert.equal(other.documentation, undefined);
  assert.doesNotMatch(renderRefusalPlan(other), /Documentation:/u);
});

test('the explain command serves one finding entry', async () => {
  const { resolveHelp } = await import('../src/help-service.mjs');
  const served = await resolveHelp('findings', { section: 'code_delivery_evidence_required' });
  assert.match(served.served.text, /\n### CODE_DELIVERY_EVIDENCE_REQUIRED\n/u);
  assert.match(served.served.text, /outside every recognised test folder/u);
});
