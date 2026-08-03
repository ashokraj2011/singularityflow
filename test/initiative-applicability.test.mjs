import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { validatePortfolio } from '../src/initiative-config.mjs';
import {
  createInitiative, initiativeApplicabilityState, loadInitiative, setInitiativeApplicability
} from '../src/initiative-state.mjs';
import { evaluateInitiativeChecklist } from '../src/initiative-evidence.mjs';
import { run } from '../src/util.mjs';

const shipped = YAML.parse(await readFile(new URL('../templates/portfolio.yml', import.meta.url), 'utf8'));

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-applicability-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Applicability\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: 'owner@example.com' }];
  }
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'initialize'], { cwd: root });
  return root;
}

test('the shipped portfolio declares every policy its conditional checks reference', () => {
  const portfolio = validatePortfolio(structuredClone(shipped));
  const declared = new Set(Object.keys(portfolio.applicabilityPolicies));
  const referenced = new Set();
  for (const phase of Object.values(portfolio.initiativePhases)) {
    for (const check of phase.checklist ?? []) if (check.applicability) referenced.add(check.applicability.policy);
  }
  assert.ok(referenced.size >= 4, 'the template exercises conditional checks');
  for (const policy of referenced) assert.ok(declared.has(policy), `policy '${policy}' must be declared`);
  for (const policy of declared) {
    assert.ok(portfolio.applicabilityPolicies[policy].question, 'every policy states the question it asks');
  }
});

test('a conditional check referencing an undeclared policy is rejected', () => {
  // Before this, the policy id was accepted as a bare identifier and never used, so a typo silently
  // produced a check nobody could satisfy except by hand-waiving it.
  const value = structuredClone(shipped);
  value.initiativePhases['discover-define'].checklist.push({
    id: 'typo-check', requirement: 'conditional', applicability: { policy: 'secuirty-review-required' },
    acceptedAssurance: ['human-approved']
  });
  assert.throws(() => validatePortfolio(value), /unknown applicability policy 'secuirty-review-required'/);
});

test('a portfolio written before applicabilityPolicies existed still loads', () => {
  // The declarations were added after repositories had already been initialized with the phases
  // that reference them. Requiring the block turned every one of those into a portfolio that would
  // not load at all — not a degraded screen, no screen: the snapshot failed and the editor showed
  // the message where the whole product used to be.
  //
  // The four the shipped phases ask about are the product's own, so they are always available. A
  // policy nobody has ever heard of is still a typo, and still refused.
  const value = structuredClone(shipped);
  delete value.applicabilityPolicies;
  const portfolio = validatePortfolio(value);
  assert.equal(portfolio.applicabilityPolicies['ux-required'].label, 'UX design required');
  assert.match(portfolio.applicabilityPolicies['security-review-required'].question, /authentication/);

  // A repository that words the question differently keeps its own wording.
  const reworded = structuredClone(shipped);
  reworded.applicabilityPolicies = { 'ux-required': { label: 'Design review', question: 'Does a designer need to look at this?' } };
  const own = validatePortfolio(reworded);
  assert.equal(own.applicabilityPolicies['ux-required'].label, 'Design review');
  // And the rest of the built-in vocabulary is still there beside it.
  assert.ok(own.applicabilityPolicies['ai-use-case']);
});

test('an unanswered policy leaves its check unanswered, and answering resolves it', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-1'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-1', title: 'Applicability', profile: 'enterprise-delivery', persona: 'product-owner',
    source: { type: 'manual', description: 'Applicability engine.' }
  });

  const conditionalStatus = async (phaseId, checkId) => {
    const { portfolio: current, initiative } = await loadInitiative(root, 'INIT-1');
    const checklist = await evaluateInitiativeChecklist(root, initiative, current, phaseId);
    return checklist.find((check) => check.id === checkId);
  };

  // `inception` carries the conditional ux-concept-approved check.
  let check = await conditionalStatus('inception', 'ux-concept-approved');
  assert.equal(check.status, 'unanswered', 'an unasked question is reported as such, not as missing evidence');
  assert.equal(check.applicabilityPolicy, 'ux-required');

  await setInitiativeApplicability(root, 'INIT-1', 'ux-required', false, { reason: 'no user-facing change' });
  check = await conditionalStatus('inception', 'ux-concept-approved');
  assert.equal(check.status, 'not_applicable', 'answering no resolves the check without evidence');

  // Answering yes puts the control back in scope: it now needs real evidence.
  await setInitiativeApplicability(root, 'INIT-1', 'ux-required', true, { reason: 'redesigns checkout' });
  check = await conditionalStatus('inception', 'ux-concept-approved');
  assert.equal(check.status, 'missing', 'answering yes makes the check behave like a required control');
});

test('applicability state reports every declared policy and its answer', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-2'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-2', title: 'State', profile: 'enterprise-delivery', persona: 'product-owner',
    source: { type: 'manual', description: 'Applicability state.' }
  });
  let loaded = await loadInitiative(root, 'INIT-2');
  let state = initiativeApplicabilityState(loaded.portfolio, loaded.initiative);
  assert.equal(state.length, Object.keys(loaded.portfolio.applicabilityPolicies).length);
  assert.ok(state.every((policy) => policy.answered === false));

  await setInitiativeApplicability(root, 'INIT-2', 'security-review-required', true, { reason: 'touches auth' });
  loaded = await loadInitiative(root, 'INIT-2');
  state = initiativeApplicabilityState(loaded.portfolio, loaded.initiative);
  const security = state.find((policy) => policy.id === 'security-review-required');
  assert.equal(security.answered, true);
  assert.equal(security.applicable, true);
  assert.equal(security.reason, 'touches auth');
  assert.equal(security.actor, 'owner@example.com');

  await assert.rejects(
    () => setInitiativeApplicability(root, 'INIT-2', 'not-a-policy', true),
    /Unknown applicability policy 'not-a-policy'/);
});
