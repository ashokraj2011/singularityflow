import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  phaseAuthoringContract, phaseAuthoringContractLines, UPSTREAM_DISCREPANCY_PROTOCOL
} from '../src/phase-authoring-contract.mjs';
import { phaseRepairLoopSummary } from '../src/phase-repair-journal.mjs';
import { phaseUpstreamDiscrepancies, upstreamDiscrepanciesFromMarkdown } from '../src/phase-upstream-discrepancies.mjs';
import { REFUSAL_HANDLING_CONTRACT, refusalHandlingApplies } from '../scripts/skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('an author records a wrong approved input and continues instead of editing it or stopping', () => {
  const workflow = { workItem: { id: 'UPS-1' }, phaseOrder: ['specification', 'planning'],
    phases: { specification: { id: 'specification' }, planning: { id: 'planning' } } };
  const contract = phaseAuthoringContract({}, workflow, workflow.phases.planning);
  assert.equal(contract.revision, 'phase-authoring-v6');
  assert.equal(contract.recovery.upstreamDefect, 'record-and-continue');
  const lines = phaseAuthoringContractLines(contract).join('\n');
  assert.ok(lines.includes(UPSTREAM_DISCREPANCY_PROTOCOL));
  assert.match(UPSTREAM_DISCREPANCY_PROTOCOL, /do not edit it and do not stop/u);
  assert.match(UPSTREAM_DISCREPANCY_PROTOCOL, /## Upstream discrepancies/u);
  assert.match(UPSTREAM_DISCREPANCY_PROTOCOL, /Stop only for a refusal about changed or unapproved input bytes/u);
  // A kernel-generated artifact is not authored, so it carries no instruction to write into it.
  assert.ok(!phaseAuthoringContractLines(contract, { deterministicOnly: true }).join('\n')
    .includes(UPSTREAM_DISCREPANCY_PROTOCOL));
});

test('recorded discrepancies are read from bullets and tables, naming only earlier phases', () => {
  const markdown = [
    '# Implementation summary', '',
    '## Upstream discrepancies', '',
    '| Producer phase | Section | Problem | Assumption | Impact | Owner action |',
    '|---|---|---|---|---|---|',
    '| specification | REQ-002 | No error case | Empty input is an error | AC-003 untestable | Amend REQ-002 |', '',
    '- planning: the plan names `src/a.js`, the code lives in `src/b.js`',
    '- implementation names itself, which is not upstream', '',
    '## Tests', '- none of these are discrepancies'
  ].join('\n');
  const workflow = { phaseOrder: ['specification', 'planning', 'implementation'] };
  const found = phaseUpstreamDiscrepancies([{ path: 'impl.md', content: markdown }], workflow, 'implementation');
  assert.deepEqual(found.map((item) => item.phase), ['specification', 'planning', null]);
  assert.match(found[0].text, /REQ-002 — No error case/u);
  assert.equal(found[0].path, 'impl.md');
  assert.deepEqual(upstreamDiscrepanciesFromMarkdown('## Upstream discrepancies\n\nNone.\n', ['specification']), []);
  assert.deepEqual(upstreamDiscrepanciesFromMarkdown('# No section here\n- planning: x\n', ['planning']), []);
  assert.deepEqual(phaseUpstreamDiscrepancies([{ path: 'b.png', binary: true, content: null }], workflow, 'planning'), []);
});

test('the repair protocol lets authors correct their own draft without a reservation or a person', async () => {
  const summary = await phaseRepairLoopSummary(process.cwd(), { workItem: { id: 'UPS-2' } },
    { id: 'planning', generation: 1, repairBudget: { maxAttempts: 3 } }).catch(() => null);
  const text = summary?.protocol ?? (await readFile(path.join(root, 'src/phase-repair-journal.mjs'), 'utf8'));
  assert.match(text, /correct them directly and recheck; no reservation is needed/u);
  assert.match(text, /stops automation only: keep correcting your own draft/u);
  assert.match(text, /A person is needed only for risk, authority or integrity decisions/u);
  assert.match(text, /Never edit an earlier phase to clear a finding/u);
});

test('every Story authoring and mutation skill carries the engine refusal contract, and only those', async () => {
  const registry = YAML.parse(await readFile(path.join(root, 'plugin/skills/registry.yml'), 'utf8'));
  let carrying = 0;
  for (const [name, rule] of Object.entries(registry.skills)) {
    const body = await readFile(path.join(root, 'plugin/skills', name, 'SKILL.md'), 'utf8').catch(() => null);
    if (body == null) continue;
    assert.equal(body.includes(REFUSAL_HANDLING_CONTRACT), refusalHandlingApplies(rule), name);
    if (refusalHandlingApplies(rule)) carrying += 1;
  }
  assert.ok(carrying >= 30, `${carrying} skills carry the refusal contract`);
  for (const name of ['sflow-phase', 'sflow-code', 'sflow-plan', 'sflow-next', 'sflow-recover']) {
    assert.ok(refusalHandlingApplies(registry.skills[name]), name);
  }
  // Approval and review turns never run automatic actions.
  for (const name of ['sflow-approve', 'sflow-submit', 'sflow-reject']) {
    assert.equal(refusalHandlingApplies(registry.skills[name]), false, name);
  }
  assert.match(REFUSAL_HANDLING_CONTRACT, /never retry an unchanged condition or edit an earlier phase/u);
});
