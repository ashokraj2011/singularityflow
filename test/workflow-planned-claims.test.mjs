import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { isSpecificationDefinitionPhase } from '../src/specifications.mjs';
import { onboardRepository } from '../src/onboard.mjs';
import { optionalWorkflowCatalog, validateWorkflowCatalog } from '../src/workflow-catalog.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

const SHIPPED_STORY_CONTRACTS = Object.freeze({
  feature: {
    mode: 'required', clausePhases: ['requirements', 'implementation-spec'],
    owners: { implementation: 'implementation-spec' }
  },
  bugfix: {
    mode: 'required', clausePhases: ['fix-spec'], owners: { implementation: 'fix-spec' }
  },
  chore: { mode: 'disabled' },
  'figma-mobile': {
    mode: 'required', clausePhases: ['mobile-spec'], owners: { implementation: 'mobile-spec' }
  },
  'quick-fix': { mode: 'opt-out' },
  'classic-delivery': {
    mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' }
  },
  'poc-lite': { mode: 'opt-out' },
  'benchmarking-a': {
    mode: 'required', clausePhases: ['intake'], owners: { implementation: 'design' }
  },
  'benchmarking-b': {
    mode: 'required', clausePhases: ['intake'], owners: { implementation: 'design' }
  },
  'poc-workflow': {
    mode: 'required', clausePhases: ['poc-intake'], owners: { 'poc-test-generation': 'poc-ui-exploration' }
  },
  'reference-driven-build': {
    mode: 'required', clausePhases: ['specification'], owners: { implementation: 'planning' }
  },
  'spec-driven-standard': {
    mode: 'required', clausePhases: ['specification'], owners: { implementation: 'planning' }
  }
});

async function installedStarter() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-claims-'));
  await initializeDefinition(root);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Workflow Validator'],
    ['config', 'user.email', 'workflow-validator@example.test'],
    ['add', '.'],
    ['commit', '-qm', 'initialize workflow catalog']
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, definition: await loadDefinition(root) };
}

test('every bundled Story workflow declares a complete current planned-claim contract', async () => {
  const { definition } = await installedStarter();
  assert.deepEqual(Object.keys(definition.workTypes), Object.keys(SHIPPED_STORY_CONTRACTS),
    'the shipped Story catalog changed without adding its planned-claim contract to this matrix');

  for (const [id, expected] of Object.entries(SHIPPED_STORY_CONTRACTS)) {
    const resolved = resolveWorkType(definition, id);
    const policy = resolved.plannedClaims;
    assert.notEqual(policy.mode, 'legacy-opt-out', `${id} still depends on the compatibility shim`);
    assert.equal(policy.mode, expected.mode, `${id} has the wrong planned-claim mode`);

    if (policy.mode === 'required') {
      assert.deepEqual(policy.clausePhases, expected.clausePhases, `${id} has the wrong clause authority`);
      assert.deepEqual(policy.owners, expected.owners, `${id} has the wrong plan owner`);

      const byId = new Map(resolved.phases.map((phase) => [phase.id, phase]));
      for (const phaseId of policy.clausePhases) {
        assert.ok(isSpecificationDefinitionPhase(byId.get(phaseId)),
          `${id}/${phaseId} is named as a clause source but is not authoritative`);
      }

      const codePhaseIds = resolved.phases.filter(phaseRequiresCodeDelivery).map((phase) => phase.id).sort();
      assert.deepEqual(Object.keys(policy.owners).sort(), codePhaseIds,
        `${id} does not map every code-delivery phase to a reviewed plan owner`);
      for (const [codeId, ownerId] of Object.entries(policy.owners)) {
        const code = byId.get(codeId);
        const owner = byId.get(ownerId);
        assert.ok(owner.order < code.order, `${id}/${ownerId} does not precede ${codeId}`);
        assert.ok(policy.clausePhases.some((phaseId) => byId.get(phaseId).order <= owner.order),
          `${id}/${ownerId} cannot bind any preceding authoritative clause phase`);
      }
    } else if (policy.mode === 'opt-out') {
      assert.ok(policy.reason.length >= 20, `${id} has no reviewable opt-out reason`);
      assert.equal(resolved.spec.acceptance, 'off', `${id} opt-out left the acceptance gate active`);
    } else {
      assert.deepEqual(resolved.phases.filter(phaseRequiresCodeDelivery), [],
        `${id} disabled planned claims despite containing code delivery`);
    }
  }
});

test('workflow catalog validation reports the complete bundle and one requested workflow', async () => {
  const { root } = await installedStarter();
  const report = await validateWorkflowCatalog(root);
  assert.equal(report.valid, true);
  assert.deepEqual(report.workflows.map((entry) => entry.id), Object.keys(SHIPPED_STORY_CONTRACTS));
  assert.ok(report.workflows.every((entry) => entry.status !== 'legacy-compatibility'));
  assert.equal(report.workflows.find((entry) => entry.id === 'quick-fix').status, 'explicit-opt-out');
  assert.equal(report.workflows.find((entry) => entry.id === 'poc-lite').status, 'explicit-opt-out');
  assert.equal(report.workflows.find((entry) => entry.id === 'chore').status, 'not-applicable');
  assert.equal(
    report.workflows.filter((entry) => entry.status === 'protected').length,
    Object.values(SHIPPED_STORY_CONTRACTS).filter((contract) => contract.mode === 'required').length
  );

  const one = await validateWorkflowCatalog(root, 'poc-workflow');
  assert.equal(one.valid, true);
  assert.deepEqual(one.workflows, [{
    id: 'poc-workflow',
    label: 'POC workflow — enterprise Playwright',
    status: 'protected',
    clausePhases: ['poc-intake'],
    owners: { 'poc-test-generation': 'poc-ui-exploration' },
    reason: null
  }]);

  await assert.rejects(() => validateWorkflowCatalog(root, 'does-not-exist'), /Unknown workflow 'does-not-exist'/);
});

test('an advisory packaged catalog failure cannot suppress installed Story workflows', async () => {
  const result = await optionalWorkflowCatalog(async () => {
    throw new Error(`Provider failed for https://alice:LEAKMARK@example.test/repo ${'x'.repeat(2_000)}`);
  });
  assert.deepEqual(result.workflows, []);
  assert.match(result.reason, /Installed Story workflows remain available/);
  assert.doesNotMatch(result.reason, /LEAKMARK/);
  assert.ok(result.reason.length < 700, 'the optional failure reason was not bounded');
});

test('workflow validate is a public JSON CLI surface for all and one workflow', async () => {
  const { root } = await installedStarter();
  const run = (...args) => spawnSync(process.execPath, [bin, 'workflow', 'validate', ...args, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });

  const all = run();
  assert.equal(all.status, 0, all.stderr);
  const allReport = JSON.parse(all.stdout);
  assert.equal(allReport.valid, true);
  assert.deepEqual(allReport.workflows.map((entry) => entry.id).sort(), Object.keys(SHIPPED_STORY_CONTRACTS).sort());

  const one = run('feature');
  assert.equal(one.status, 0, one.stderr);
  const oneReport = JSON.parse(one.stdout);
  assert.deepEqual(oneReport.workflows.map((entry) => entry.id), ['feature']);
  assert.deepEqual(oneReport.workflows[0].owners, { implementation: 'implementation-spec' });
});

test('validation reports an old custom workflow without making the catalog unreadable or allowing new work', async () => {
  const { root } = await installedStarter();
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.workTypes['legacy-custom'] = {
    ...structuredClone(definition.workTypes['quick-fix']),
    label: 'Legacy custom'
  };
  delete definition.workTypes['legacy-custom'].plannedClaims;
  await writeFile(workflowPath, YAML.stringify(definition), 'utf8');
  assert.equal(spawnSync('git', ['add', 'singularity/workflow.yml'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'add old custom workflow'], { cwd: root }).status, 0);

  const loaded = await loadDefinition(root);
  assert.equal(resolveWorkType(loaded, 'legacy-custom').plannedClaims.mode, 'migration-required');
  const report = await validateWorkflowCatalog(root, 'legacy-custom');
  assert.equal(report.valid, false);
  assert.equal(report.workflows[0].status, 'migration-required');

  const cli = spawnSync(process.execPath, [bin, 'workflow', 'validate', 'legacy-custom', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).valid, false);
});

test('new Story workflow has one coherent list, validate, simulate, and diff explanation', async () => {
  const { root } = await installedStarter();
  const run = (...args) => spawnSync(process.execPath, [bin, 'workflow', ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
  const created = run('create', 'hotfix', '--phases', 'requirements,implementation-spec,implementation', '--json');
  assert.equal(created.status, 0, created.stderr);
  const creation = JSON.parse(created.stdout);
  assert.equal(creation.plannedClaims.mode, 'required');
  const authored = YAML.parse(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'));
  assert.deepEqual(authored.workTypes.hotfix.plannedClaims.clausePhases,
    creation.plannedClaims.clausePhases, 'inferred clause authority must be pinned in the authored workflow');
  assert.deepEqual(authored.workTypes.hotfix.plannedClaims.owners,
    creation.plannedClaims.owners, 'inferred owners must be pinned in the authored workflow');

  const listed = run('list', '--json');
  const validated = run('validate', 'hotfix', '--json');
  const simulated = run('simulate', 'hotfix', '--json');
  for (const result of [listed, validated, simulated]) assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(listed.stdout).find((item) => item.id === 'hotfix').status, 'local');
  assert.equal(JSON.parse(validated.stdout).workflows[0].status, 'protected');
  assert.equal(JSON.parse(simulated.stdout)[0].id, 'hotfix');

  const diff = run('diff', 'hotfix');
  assert.notEqual(diff.status, 0);
  assert.match(diff.stderr, /compares a packaged workflow with your copy; 'hotfix' is custom/);
  assert.match(diff.stderr, /workflow simulate hotfix/);

  const readable = run('create', 'hotfix-readable', '--phases', 'requirements,implementation-spec,implementation');
  assert.equal(readable.status, 0, readable.stderr);
  assert.match(readable.stdout, /Hotfix-readable \(hotfix-readable\)/i);
  assert.match(readable.stdout, /template=.*inputs=.*approvals=.*world-model=/);
});

test('phase add defaults to Story and incorrect clause phase lists eligible phases', async () => {
  const { root } = await installedStarter();
  const run = (...args) => spawnSync(process.execPath, [bin, 'workflow', ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
  const before = await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8');
  const added = run('phase', 'add', 'writing', '--json');
  assert.notEqual(added.status, 0);
  assert.match(added.stderr, /Phase 'writing' has no default governed agent/);
  assert.equal(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'), before,
    'a missing default Story agent must be caught before writing a broken workflow');

  const badClause = run('create', 'bad-clause', '--phases', 'intake,specification,implementation',
    '--governs', 'story', '--planned-claims', 'required', '--clause-phases', 'intake');
  assert.notEqual(badClause.status, 0);
  assert.match(badClause.stderr, /Eligible phases in this workflow: specification/);

  const unknown = run('create', 'misspelled', '--phases', 'intake,writting');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /not defined for story work: writting/);
  assert.match(unknown.stderr, /workflow phase add <ID> --governs story/);
});

test('explicit local FOS authority authors --propose as an uncommitted local change', async () => {
  const { root } = await installedStarter();
  assert.equal(spawnSync('git', ['branch', 'sflow/config'], { cwd: root }).status, 0);
  await onboardRepository(root, { authorityLocal: true });
  const onApplicationBranch = spawnSync(process.execPath, [bin, 'workflow', 'create', 'wrong-branch',
    '--phases', 'requirements,implementation-spec,implementation', '--propose', '--json'], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
  assert.notEqual(onApplicationBranch.status, 0);
  assert.equal(JSON.parse(onApplicationBranch.stderr).error.code, 'WORKFLOW_LOCAL_AUTHORITY_BRANCH_REQUIRED');
  assert.equal((await loadDefinition(root)).workTypes['wrong-branch'], undefined);
  assert.equal(spawnSync('git', ['switch', '-q', 'sflow/config'], { cwd: root }).status, 0);
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(process.execPath, [bin, 'workflow', 'create', 'local-story',
    '--phases', 'requirements,implementation-spec,implementation', '--propose', '--json'], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const authored = JSON.parse(result.stdout);
  assert.equal(authored.authorityMode, 'local');
  assert.equal(authored.reviewRequired, false);
  assert.match(authored.nextAction, /Review the configuration diff and commit it on 'sflow\/config'/);
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), before);
  assert.ok((await loadDefinition(root)).workTypes['local-story']);

  const templatePath = path.join(root, 'singularity', 'templates', 'common', 'verification.md');
  const template = await readFile(templatePath, 'utf8');
  const saved = spawnSync(process.execPath, [bin, 'configuration', 'save',
    'singularity/templates/common/verification.md', '--propose', '--json'], {
    cwd: root, encoding: 'utf8', input: `${template}\n<!-- Local review note -->\n`, env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).authorityMode, 'local');
  assert.match(await readFile(templatePath, 'utf8'), /Local review note/);
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), before);
});
