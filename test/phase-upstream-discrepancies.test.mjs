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
import {
  AUTHORING_TURN_CONTRACT, AUTOMATIC_ACTION_CONTRACT, REFUSAL_HANDLING_CONTRACT, authoringTurnApplies, automaticActionApplies,
  refusalHandlingApplies
} from '../scripts/skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('an author records a wrong approved input and continues instead of editing it or stopping', () => {
  const workflow = { workItem: { id: 'UPS-1' }, phaseOrder: ['specification', 'planning'],
    phases: { specification: { id: 'specification' }, planning: { id: 'planning' } } };
  const contract = phaseAuthoringContract({}, workflow, workflow.phases.planning);
  assert.equal(contract.revision, 'phase-authoring-v8');
  assert.equal(contract.recovery.upstreamDefect, 'record-and-continue');
  const lines = phaseAuthoringContractLines(contract).join('\n');
  assert.ok(lines.includes(UPSTREAM_DISCREPANCY_PROTOCOL));
  assert.match(UPSTREAM_DISCREPANCY_PROTOCOL, /do not edit it and do not stop/u);
  assert.match(UPSTREAM_DISCREPANCY_PROTOCOL, /## Upstream discrepancies/u);
  assert.match(UPSTREAM_DISCREPANCY_PROTOCOL, /singularity-flow upstream-issue raise --from-artifact/u);
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
    // Only a turn that may run a kernel mutation is told it may run the returned `sync`.
    assert.equal(body.includes(AUTOMATIC_ACTION_CONTRACT), automaticActionApplies(name, rule), name);
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
  // The refusal contract says only how to read a refusal; it gives no turn a reason to stop and relay.
  // Widening it ("On a refusal or any stop, relay the returned route ...") made a live /sf-phase run
  // relay its own route three turns running instead of writing the document.
  assert.equal(REFUSAL_HANDLING_CONTRACT, 'On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it.');
  assert.equal(AUTOMATIC_ACTION_CONTRACT, 'One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once.');
  for (const name of ['sflow-next', 'sflow-phase', 'sflow-pr']) assert.ok(automaticActionApplies(name, registry.skills[name]), name);
  // A publish-only, review-decision-only or read turn refuses `sync`, so its skill is never told to run it.
  for (const name of ['sflow-publish', 'sflow-review-decide', 'sflow-hook']) {
    assert.ok(refusalHandlingApplies(registry.skills[name]), name);
    assert.equal(automaticActionApplies(name, registry.skills[name]), false, name);
  }
});

test('only skills that write their own document are told a route back to them is their own work', async () => {
  const registry = YAML.parse(await readFile(path.join(root, 'plugin/skills/registry.yml'), 'utf8'));
  for (const [name, rule] of Object.entries(registry.skills)) {
    const body = await readFile(path.join(root, 'plugin/skills', name, 'SKILL.md'), 'utf8').catch(() => null);
    if (body == null) continue;
    assert.equal(body.includes(AUTHORING_TURN_CONTRACT), authoringTurnApplies(rule), name);
    assert.equal(authoringTurnApplies(rule), rule.class === 'generative', name);
    // No skill is told to end its turn on any stop, or to relay a route it should run.
    assert.doesNotMatch(body, /On a refusal or any stop/u, name);
  }
  for (const name of ['sflow-phase', 'sflow-code', 'sflow-specify', 'sflow-epic-requirements', 'sflow-initiative-phase']) {
    assert.ok(authoringTurnApplies(registry.skills[name]), name);
  }
  // A skill whose returned route waits on a person never gets it: running that route would capture,
  // register, decide or confirm for them.
  for (const name of ['sflow-revise', 'sflow-revision-attachments', 'sflow-story-skill-version', 'sflow-review-decide',
    'sflow-next', 'sflow-recover', 'sflow-approve', 'sflow-confirm']) {
    assert.equal(authoringTurnApplies(registry.skills[name]), false, name);
  }
  assert.match(AUTHORING_TURN_CONTRACT, /routes back to this skill with nothing for a person to answer, edit, review or confirm, that is this turn's own work: do it, never relay it/u);
  assert.match(AUTHORING_TURN_CONTRACT, /A file edit that does not match is not a refusal: read those lines again and redo the edit/u);
  // An edit's replaced text comes from the file as it is now: a paraphrase from memory never matches.
  assert.match(AUTHORING_TURN_CONTRACT, /Copy the text an edit replaces from the file as it is now, read after your last edit of it, never from memory, a finding or a search result/u);
});
