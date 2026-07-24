import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
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
import { publishInitiativePhase } from '../src/initiative-evidence.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-config-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Initiative\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
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
  assert.doesNotMatch(await readFile(path.join(root, 'singularity/portfolio.yml'), 'utf8'), /brokerage/i);
});

test('starter portfolio resolves Epic planning and pins storage and repository delivery policy', async () => {
  const root = await repository();
  const file = path.join(root, 'singularity/portfolio.yml');
  const value = YAML.parse(await readFile(file, 'utf8'));
  value.repositories.mobile = {
    url: 'git@github.com:company/mobile.git',
    branchCompletionPolicy: 'either',
    requiredChecks: ['build', 'security']
  };
  value.storage = {
    defaultProvider: 'corporate-artifacts',
    maxBytes: 1048576,
    providers: {
      'corporate-artifacts': {
        type: 'artifactory',
        baseUrl: 'https://artifacts.example.com',
        repository: 'product-inputs'
      }
    }
  };
  await writeFile(file, YAML.stringify(value));
  const portfolio = await loadPortfolio(root);
  const epic = resolveInitiativeProfile(portfolio, 'epic-planning');
  assert.equal(epic.lifecycleMode, 'planning-only');
  assert.deepEqual(epic.phases.map((phase) => phase.id), [
    'epic-intake', 'epic-requirements', 'epic-plan', 'epic-spec', 'epic-create'
  ]);
  assert.equal(epic.repositories.mobile.branchCompletionPolicy, 'either');
  assert.deepEqual(epic.repositories.mobile.requiredChecks, ['build', 'security']);
  assert.equal(epic.storage.providers['corporate-artifacts'].type, 'artifactory');
});

test('portfolio loading rejects a symlinked governance file', async () => {
  const root = await repository();
  const portfolio = path.join(root, 'singularity/portfolio.yml');
  const original = `${portfolio}.original`;
  await rename(portfolio, original);
  await symlink(original, portfolio);
  await assert.rejects(() => loadPortfolio(root), /portfolio configuration cannot be a symbolic link/i);
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
  const duplicatePath = structuredClone(base);
  duplicatePath.initiativePhases.one.outputs.push({
    id: 'duplicate-brief',
    kind: 'markdown',
    path: 'brief.md',
    template: 'brief.md'
  });
  assert.throws(() => validatePortfolio(duplicatePath), /output paths contains duplicates/i);
});

test('portfolio repository metadata accepts App IDs, names, and scalar organization fields', () => {
  const portfolio = {
    version: 1,
    repositories: {
      mobile: {
        url: 'git@github.com:company/mobile.git',
        metadata: {
          appId: 'APP-1001',
          name: 'Mobile application',
          criticality: 1,
          regulated: true
        }
      }
    },
    approvalAuthorities: {},
    initiativeProfiles: { lite: { phases: ['define'] } },
    initiativePhases: { define: {} }
  };
  const validated = validatePortfolio(portfolio);
  assert.equal(validated.repositories.mobile.metadata.appId, 'APP-1001');
  assert.equal(validated.repositories.mobile.metadata.criticality, 1);
  const nested = structuredClone(portfolio);
  nested.repositories.mobile.metadata.owner = { team: 'Digital' };
  assert.throws(() => validatePortfolio(nested), /must be a string, number, or boolean/);
  const unsafe = structuredClone(portfolio);
  unsafe.repositories.mobile.metadata['../owner'] = 'Digital';
  assert.throws(() => validatePortfolio(unsafe), /metadata key/);
});

test('initiative world-model views must be declared by the repository workflow', async () => {
  const root = await repository();
  const portfolio = await loadPortfolio(root);
  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
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

test('initiative preparation enforces its immutable template snapshot', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-PIN'], { cwd: root });
  const { initiative } = await createInitiative(root, {
    id: 'INIT-PIN',
    title: 'Pinned initiative',
    profile: 'initiative-lite',
    persona: 'product-owner'
  });
  const template = initiative.resolution.templates['define/business-case'];
  await writeFile(path.join(root, template.path), '# changed after initiative start\n');
  await assert.rejects(
    () => prepareInitiativePhase(root, 'INIT-PIN', 'define', { persona: 'product-owner' }),
    /changed after INIT-PIN was created/
  );
});

test('template-less binary outputs wait for an upload and publish with an actionable path', async () => {
  const root = await repository();
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  portfolio.initiativePhases.define.outputs.push({
    id: 'research-bundle',
    label: 'Research bundle',
    kind: 'binary-bundle',
    path: 'research/research-bundle.zip',
    approval: { mode: 'none' }
  });
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', file], { cwd: root });
  run('git', ['commit', '-m', 'Add binary initiative output'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-BINARY'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-BINARY',
    title: 'Binary evidence initiative',
    profile: 'initiative-lite',
    persona: 'product-owner'
  });

  const prepared = await prepareInitiativePhase(root, 'INIT-BINARY', 'define', { persona: 'product-owner' });
  const pending = prepared.outputs.find((output) => output.id === 'research-bundle');
  assert.deepEqual(
    { awaitingUpload: pending.awaitingUpload, sha256: pending.sha256, bytes: pending.bytes },
    { awaitingUpload: true, sha256: null, bytes: 0 }
  );
  assert.equal(prepared.phase.outputs['research-bundle'].status, 'awaiting_upload');
  const expected = path.join(root, 'singularity/initiatives/INIT-BINARY/artifacts/define/research/research-bundle.zip');
  assert.equal((await stat(path.dirname(expected))).isDirectory(), true);
  await assert.rejects(
    () => publishInitiativePhase(root, 'INIT-BINARY', 'define'),
    /research-bundle \(artifacts\/define\/research\/research-bundle\.zip\)/
  );

  await writeFile(expected, Buffer.from('PK mocked governed bundle'));
  const uploaded = await prepareInitiativePhase(root, 'INIT-BINARY', 'define', { persona: 'product-owner' });
  const record = uploaded.outputs.find((output) => output.id === 'research-bundle');
  assert.equal(record.awaitingUpload, false);
  assert.ok(record.sha256);
  assert.equal(uploaded.phase.outputs['research-bundle'].status, 'draft');
  await assert.doesNotReject(() => publishInitiativePhase(root, 'INIT-BINARY', 'define'));
});

test('initiative creation and loading reject symlink escapes from the repository', async () => {
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-outside-'));
  const initiatives = path.join(root, 'singularity/initiatives');
  await symlink(outside, initiatives);
  run('git', ['switch', '-c', 'INIT-ESCAPE'], { cwd: root });
  await assert.rejects(
    () => createInitiative(root, { id: 'INIT-ESCAPE', profile: 'initiative-lite' }),
    /initiative.*resolves outside the repository/i
  );
  await assert.rejects(
    () => stat(path.join(outside, 'INIT-ESCAPE/state.json')),
    /ENOENT/
  );
});

test('initiative creation does not overwrite a pre-existing partial directory', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-PARTIAL'], { cwd: root });
  const directory = path.join(root, 'singularity/initiatives/INIT-PARTIAL');
  await mkdir(directory, { recursive: true });
  const sentinel = path.join(directory, 'recovery-notes.md');
  await writeFile(sentinel, '# Preserve me\n');
  await assert.rejects(
    () => createInitiative(root, { id: 'INIT-PARTIAL', profile: 'initiative-lite' }),
    /already contains files.*will not be overwritten/i
  );
  assert.equal(await readFile(sentinel, 'utf8'), '# Preserve me\n');
});

test('initiative output preparation rejects a symlinked artifact target', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-OUTPUT-LINK'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-OUTPUT-LINK',
    title: 'Protected output initiative',
    profile: 'initiative-lite'
  });
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-output-outside-')), 'business-case.md');
  await writeFile(outside, '# Outside repository\n');
  const target = path.join(root, 'singularity/initiatives/INIT-OUTPUT-LINK/artifacts/define/business-case.md');
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(outside, target);
  await assert.rejects(
    () => prepareInitiativePhase(root, 'INIT-OUTPUT-LINK', 'define'),
    /initiative output.*cannot be a symbolic link/i
  );
});

test('initiative output preparation rejects a tampered path outside its initiative directory', async () => {
  const root = await repository();
  run('git', ['switch', '-c', 'INIT-OUTPUT-ESCAPE'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-OUTPUT-ESCAPE',
    title: 'Protected output boundary',
    profile: 'initiative-lite'
  });
  const statePath = path.join(root, 'singularity/initiatives/INIT-OUTPUT-ESCAPE/state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.phases.define.outputs['business-case'].path = '../../../README.md';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  await assert.rejects(
    () => prepareInitiativePhase(root, 'INIT-OUTPUT-ESCAPE', 'define'),
    /output 'define\/business-case' differs from its immutable resolution/i
  );
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), readme);
});

test('initiative start requires configured local authority membership', async () => {
  const root = await repository();
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  portfolio.approvalAuthorities['product-approvers'].members = [];
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', file], { cwd: root });
  run('git', ['commit', '-m', 'Remove authority'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-EMPTY'], { cwd: root });
  await assert.rejects(() => createInitiative(root, { id: 'INIT-EMPTY', profile: 'initiative-lite' }), /require at least one local Git identity/);
});
