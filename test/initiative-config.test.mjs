import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  loadPortfolio, resolveInitiativeProfile, validatePortfolio,
  validatePortfolioWorldModelViews
} from '../src/initiative-config.mjs';
import {
  createInitiative, initiativeProgress, loadInitiative, prepareInitiativePhase
} from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-config-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Initiative\n');
  await initializeDefinition(root);
  const file = path.join(root, '.singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Initiative Owner', email: 'owner@example.com' }];
  }
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize portfolio'], { cwd: root });
  return root;
}

test('starter portfolio resolves lite and enterprise profiles with generic phase contracts', async () => {
  const root = await repository();
  const portfolio = await loadPortfolio(root);
  const lite = resolveInitiativeProfile(portfolio, 'initiative-lite');
  const enterprise = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  assert.deepEqual(lite.phases.map((phase) => phase.id), ['define', 'plan', 'build', 'release']);
  assert.deepEqual(enterprise.phases.map((phase) => phase.id), ['discover-define', 'design-iterate', 'pre-inception', 'inception', 'elaboration', 'construction', 'delivery']);
  assert.equal(enterprise.phases.find((phase) => phase.id === 'elaboration').checklist.length, 15);
  assert.equal(enterprise.phases.find((phase) => phase.id === 'delivery').checklist.find((check) => check.id === 'monitoring-healthy').freshness.validFor, '24h');
  assert.ok(enterprise.phases.every((phase) => phase.bundleApproval.allowSelfApproval));
  assert.doesNotMatch(await readFile(path.join(root, '.singularity/portfolio.yml'), 'utf8'), /brokerage/i);
});

test('portfolio validation rejects bad references, assurance, conditions, and empty profiles', () => {
  const base = {
    version: 1,
    repositories: {},
    approvalAuthorities: { owners: { members: [{ email: 'owner@example.com' }] } },
    initiativeProfiles: { lite: { phases: ['one', 'two'] } },
    initiativePhases: {
      one: { outputs: [{ id: 'brief', kind: 'markdown', path: 'brief.md', template: 'brief.md' }], bundleApproval: { authorities: ['owners'] } },
      two: { outputs: [{ id: 'plan', kind: 'markdown', path: 'plan.md', template: 'plan.md', consumes: ['one/brief'] }], checklist: [{ id: 'review', requirement: 'conditional', applicability: { policy: 'review-needed' }, acceptedAssurance: ['human-approved'] }], bundleApproval: { authorities: ['owners'] } }
    }
  };
  assert.doesNotThrow(() => validatePortfolio(structuredClone(base)));
  const future = structuredClone(base); future.initiativePhases.one.outputs[0].consumes = ['two/plan'];
  assert.throws(() => validatePortfolio(future), /earlier phase/);
  const assurance = structuredClone(base); assurance.initiativePhases.two.checklist[0].acceptedAssurance = ['maybe'];
  assert.throws(() => validatePortfolio(assurance), /unsupported assurance/);
  const condition = structuredClone(base); delete condition.initiativePhases.two.checklist[0].applicability;
  assert.throws(() => validatePortfolio(condition), /requires applicability/);
  const empty = structuredClone(base); empty.initiativeProfiles.lite.phases = [];
  assert.throws(() => validatePortfolio(empty), /at least one phase/);
});

test('initiative world-model views must be declared by the repository workflow', async () => {
  const root = await repository();
  const portfolio = await loadPortfolio(root);
  const definition = YAML.parse(await readFile(path.join(root, '.singularity/workflow.yml'), 'utf8'));
  assert.doesNotThrow(() => validatePortfolioWorldModelViews(portfolio, definition));
  portfolio.initiativePhases.define.worldModelViews.push('undeclared-view');
  assert.throws(
    () => validatePortfolioWorldModelViews(portfolio, definition),
    /define:undeclared-view/
  );
});

test('initiative creation snapshots the profile and prepares phase-specific outputs', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-100'], { cwd: root });
  const { initiative } = await createInitiative(root, {
    id: 'INIT-100',
    title: 'Cross-repository onboarding',
    profile: 'initiative-lite',
    persona: 'product-owner',
    source: { type: 'manual', description: 'Deliver onboarding across repositories.' }
  });
  assert.equal(initiative.currentPhase, 'define');
  assert.equal(initiative.resolution.profile, 'initiative-lite');
  assert.equal(initiative.resolution.approvalAuthorities['initiative-owners'].members[0].email, 'owner@example.com');
  const prepared = await prepareInitiativePhase(root, 'INIT-100', 'define', { persona: 'product-owner' });
  assert.equal(prepared.outputs.length, 3);
  assert.ok(prepared.outputs.every((output) => output.sha256));
  assert.match(await readFile(path.join(root, prepared.outputs[0].path), 'utf8'), /Cross-repository onboarding|INIT-100/);
  const loaded = (await loadInitiative(root, 'INIT-100')).initiative;
  assert.equal(initiativeProgress(loaded).percentage, 0);
  assert.equal(loaded.phases.define.outputs['business-case'].status, 'draft');
});

test('initiative start requires configured local authority membership', async () => {
  const root = await repository();
  const file = path.join(root, '.singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  portfolio.approvalAuthorities['product-approvers'].members = [];
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', file], { cwd: root });
  run('git', ['commit', '-m', 'Remove authority'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-EMPTY'], { cwd: root });
  await assert.rejects(() => createInitiative(root, { id: 'INIT-EMPTY', profile: 'initiative-lite' }), /require at least one local Git identity/);
});
