import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { DEFAULT_CODE_DELIVERY_POLICY } from '../src/code-delivery-policy.mjs';
import {
  compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256
} from '../src/skp-contract.mjs';
import { previewSkillWorkflowRecipe } from '../src/skp-workflow-recipe.mjs';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { validateSafeSflowCommand } from '../src/safe-command-guidance.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { parseArgs } from '../src/util.mjs';
import {
  isSpecificationDefinitionPhase, selectActiveSpecRecords, skillPhasePrimaryOutputRole
} from '../src/specifications.mjs';

const H = (digit) => `sha256:${digit.repeat(64)}`;
const ORDER = ['intake', 'team-criteria', 'team-plan', 'team-code', 'conformance'];
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function authoringPhase(id, role, source, task = 'analyze') {
  return {
    id, kind: 'skill', label: id,
    skill: { id, packageSha256: H('a') },
    contract: {
      task, consumes: [{ phase: source, output: 'primary', required: true, state: 'approved' }],
      produces: [{
        id: 'primary', path: `artifacts/${id}/${id}.md`, kind: `custom:${id}`,
        minimumBytes: 200, maximumBytes: 16384, mediaType: 'text/markdown', encoding: 'utf-8',
        clauses: role === 'criteria' ? 'required' : 'optional', claimRole: role
      }],
      checks: task === 'code' ? ['unit'] : [],
      writeScope: task === 'code' ? 'source-and-artifact' : 'artifact-only',
      ...(task === 'code' ? { sourceScope: 'application' } : {}),
      readScope: { inputs: true, sourcePaths: [] },
      approval: { authorities: ['engineering-reviewers'], minimum: 1 }
    }
  };
}

function compile(phase, catalog, order = ORDER) {
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  return configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
    phase, catalog, phaseOrder: order,
    // Synthetic fixture identities exercise the compiler's stale binding checks. They are not
    // human approval or host qualification evidence; recipe preview must still report pending.
    confirmation: {
      contractSha256: skillContractSha256(phase.id, phase.contract), catalogSha256,
      packageSha256: phase.skill.packageSha256,
      candidateSha256: skillPhaseCandidateSha256(phase, order, catalogSha256),
      planSha256: H('b'), draftRevision: 2
    }
  }));
}

async function fixture() {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  definition.version = 3;
  const authoring = [
    authoringPhase('team-criteria', 'criteria', 'intake'),
    authoringPhase('team-plan', 'planning', 'team-criteria', 'reason'),
    authoringPhase('team-code', 'evidence', 'team-plan', 'code')
  ];
  const catalog = {
    skillPackages: Object.fromEntries(authoring.map((phase) => [phase.id, {
      packageSha256: H('a'), eligibility: 'candidate-producer'
    }])),
    phases: {
      intake: { outputs: [{ id: 'primary', path: definition.phases.intake.artifact.path }] },
      ...Object.fromEntries(authoring.map((phase) => [phase.id, { outputs: phase.contract.produces }]))
    },
    checks: { unit: {
      id: 'unit', argv: ['node', '--test'], modelPolicy: 'never', requirement: 'required',
      kind: 'test', result: {
        adapter: 'node-tap', path: 'artifacts/test-results/tap.txt',
        minimumDiscovered: 1, minimumPassed: 1
      }
    } },
    approvalAuthorities: definition.approvalAuthorities,
    approvalSecurity: definition.approvalSecurity,
    readPaths: [], sourceScopes: { application: { writeRoots: ['src'] } }, artifactSets: {},
    codeDelivery: DEFAULT_CODE_DELIVERY_POLICY
  };
  for (const phase of authoring) definition.phases[phase.id] = compile(phase, catalog);
  const workflow = {
    id: 'team-delivery', label: 'Team delivery',
    plannedClaims: {
      mode: 'required', clausePhases: ['team-criteria'], owners: { 'team-code': 'team-plan' }
    }
  };
  return { definition, workflow, phases: ORDER.slice(1, -1), authoring, catalog };
}

test('three skill code recipe expands concrete ordered boundaries and pins the existing claim owner', async () => {
  const value = await fixture();
  const before = structuredClone(value);
  const preview = previewSkillWorkflowRecipe(value);
  assert.deepEqual(value, before, 'a preview must not edit the effective definition or supplied selections');
  assert.deepEqual(preview.sequence.map((phase) => phase.id), ORDER);
  assert.deepEqual(preview.plannedClaims, { ...value.workflow.plannedClaims, reason: null });
  assert.equal(preview.status, 'candidate');
  assert.equal(preview.readiness.configuration, 'candidate');
  assert.equal(preview.readiness.host, 'unavailable');
  assert.equal(preview.readiness.humanAvailability, 'not-checked');
  assert.equal(preview.conformance.codeTraceability, 'pending');
  assert.equal(preview.conformance.checks, 'not-run');
  assert.equal(preview.conformance.humanApproval, 'pending');
  assert.match(preview.planSha256, /^sha256:[a-f0-9]{64}$/);
  const normalized = resolveWorkType(preview.candidateDefinition, 'team-delivery');
  assert.equal(normalized.phases.find((phase) => phase.id === 'team-code').generation.task, 'code');
  assert.deepEqual(previewSkillWorkflowRecipe(value), preview, 'expansion is deterministic');
});

test('mixed recipe preserves catalog and compiled skill phase contracts through normal validation', async () => {
  const value = await fixture();
  value.phases.splice(1, 0, 'requirements', 'design');
  const normalizedBase = validateDefinition(structuredClone(value.definition));
  const preview = previewSkillWorkflowRecipe(value);
  assert.deepEqual(preview.sequence.map((phase) => phase.id),
    ['intake', 'team-criteria', 'requirements', 'design', 'team-plan', 'team-code', 'conformance']);
  assert.deepEqual(preview.candidateDefinition.phases, normalizedBase.phases);
  assert.deepEqual(preview.candidateDefinition.workTypes.feature, normalizedBase.workTypes.feature);
  assert.deepEqual(preview.candidateDefinition.phases['team-code'].qualityCommands,
    normalizedBase.phases['team-code'].qualityCommands);
});

test('management, unclassified, and wrong package candidates are refused before recipe admission for either origin', async () => {
  for (const origin of ['catalog', 'user']) {
    for (const eligibility of ['management-orchestration', 'unclassified', undefined]) {
      const value = await fixture();
      const entry = value.catalog.skillPackages['team-criteria'];
      entry.origin = origin;
      if (eligibility === undefined) delete entry.eligibility;
      else entry.eligibility = eligibility;
      assert.throws(() => compile(value.authoring[0], value.catalog),
        { code: 'SKP_SKILL_NOT_PHASE_PRODUCER' });
    }
    const value = await fixture();
    value.catalog.skillPackages['team-criteria'].packageSha256 = H('c');
    assert.throws(() => compile(value.authoring[0], value.catalog),
      { code: 'SKP_SKILL_NOT_PHASE_PRODUCER' });
  }
});

test('custom criteria role is authoritative without impersonating a catalog phase name', async () => {
  const value = await fixture();
  const preview = previewSkillWorkflowRecipe(value);
  const phase = resolveWorkType(preview.candidateDefinition, value.workflow.id).phases[1];
  assert.equal(phase.artifact.kind, 'custom:team-criteria');
  assert.equal(skillPhasePrimaryOutputRole(phase), 'criteria');
  assert.equal(isSpecificationDefinitionPhase(phase), true);
  const statePhase = {
    id: phase.id, kind: phase.kind, skillBinding: phase.skillBinding,
    requiredArtifact: phase.artifact, generation: 1
  };
  const index = { workId: 'WORK-1', phase: phase.id, generation: 1, clauses: [{ id: 'WORK-1:REQ-001' }] };
  const active = selectActiveSpecRecords({ indexes: [index] }, {
    workItem: { id: 'WORK-1' }, phases: { [phase.id]: statePhase },
    resolution: { plannedClaims: preview.plannedClaims }
  });
  assert.deepEqual(active.indexes, [index]);
});

test('findings and evidence never become criteria because the kind or text looks normative', async () => {
  for (const role of ['findings', 'evidence', 'planning', 'none']) {
    const value = await fixture();
    const phase = value.authoring[0];
    phase.contract.produces[0].claimRole = role;
    phase.contract.produces[0].kind = 'requirements';
    value.definition.phases[phase.id] = compile(phase, value.catalog);
    assert.equal(isSpecificationDefinitionPhase(value.definition.phases[phase.id]), false);
    assert.throws(() => previewSkillWorkflowRecipe(value),
      { code: 'SKP_CLAIM_TOPOLOGY_UNRESOLVED' });
  }
});

test('role projections refuse unsupported or malformed compiled binding headers through the same reader', async () => {
  const value = await fixture();
  for (const edit of [
    (binding) => { binding.schemaVersion = 2; },
    (binding) => { binding.compiler = 'skp-contract/future'; },
    (binding) => { binding.parserProfile = 'unreviewed-text/v9'; },
    (binding) => { binding.compilationSha256 = 'not-a-digest'; },
    (binding) => { binding.unknown = true; }
  ]) {
    const phase = structuredClone(value.definition.phases['team-criteria']);
    edit(phase.skillBinding);
    assert.equal(skillPhasePrimaryOutputRole(phase), null);
    assert.equal(isSpecificationDefinitionPhase(phase), false);
  }
});

test('code recipe refuses inferred topology, automatic or reviewed opt-out, missing ownership, and post-code criteria', async () => {
  for (const policy of [
    undefined, 'auto', { mode: 'auto' },
    { mode: 'opt-out', reason: 'This team has not declared any planned claim topology.' },
    { mode: 'required', clausePhases: ['team-criteria'], owners: {} },
    { mode: 'required', clausePhases: ['team-criteria'], owners: { 'team-code': 'team-criteria' } },
    { mode: 'required', clausePhases: ['team-criteria'], owners: { 'team-code': 'conformance' } }
  ]) {
    const value = await fixture();
    if (policy === undefined) delete value.workflow.plannedClaims;
    else value.workflow.plannedClaims = policy;
    assert.throws(() => previewSkillWorkflowRecipe(value),
      { code: 'SKP_CLAIM_TOPOLOGY_UNRESOLVED' });
  }
  const late = await fixture();
  late.phases = ['team-plan', 'team-code', 'team-criteria'];
  assert.throws(() => previewSkillWorkflowRecipe(late),
    { code: 'SKP_CLAIM_TOPOLOGY_UNRESOLVED' });
});

test('configured skill code workflow cannot bypass role admission with a findings planning owner or opt-out', async () => {
  const value = await fixture();
  value.definition.workTypes[value.workflow.id] = { ...value.workflow, phases: ORDER };
  const findingPlan = structuredClone(value.authoring[1]);
  findingPlan.contract.produces[0].claimRole = 'findings';
  value.definition.phases['team-plan'] = compile(findingPlan, value.catalog);
  assert.throws(() => validateDefinition(value.definition), /must declare the primary output role planning/);

  const optOut = await fixture();
  optOut.definition.workTypes[optOut.workflow.id] = {
    label: 'Unsafe opt-out', phases: ORDER,
    plannedClaims: { mode: 'opt-out', reason: 'This workflow would disable planned claims for imported implementation.' }
  };
  assert.throws(() => validateDefinition(optOut.definition), { code: 'SKP_CLAIM_TOPOLOGY_UNRESOLVED' });
});

test('non-code recipe marks code conformance not applicable while artifact/check/approval evidence remains pending', async () => {
  const value = await fixture();
  value.phases = ['team-criteria'];
  delete value.workflow.plannedClaims;
  // A recipe that writes no code must say so, with the group that records why that does not apply.
  assert.throws(() => previewSkillWorkflowRecipe(value), { code: 'WORKFLOW_OBLIGATIONS_UNMET' });
  value.workflow.omits = ['implement', 'verify'].map((responsibility) => ({
    responsibility, reason: 'The team delivers reviewed criteria documents and changes no repository code.', authority: 'product-approvers'
  }));
  const preview = previewSkillWorkflowRecipe(value);
  assert.equal(preview.plannedClaims.mode, 'disabled');
  assert.equal(preview.plannedClaims.disabledBecause, 'no-code-delivery-phases');
  assert.equal(preview.conformance.codeTraceability, 'not-applicable');
  assert.deepEqual(preview.conformance.codePhases, []);
  assert.equal(preview.conformance.artifacts, 'pending');
  assert.equal(preview.conformance.checks, 'not-run');
  assert.equal(preview.conformance.humanApproval, 'pending');
});

test('unbound local authoring objects, placeholders, duplicate phase names, and shared recipe identities cannot materialize', async () => {
  const value = await fixture();
  for (const phases of [[], ['<skill phases>'], ['intake', 'team-criteria'], ['team-criteria', 'conformance'], ['team-criteria', 'team-criteria']]) {
    assert.throws(() => previewSkillWorkflowRecipe({ ...value, phases }), { code: 'SKP_RECIPE_INVALID' });
  }
  for (const id of ['skills-workflow', 'feature']) {
    assert.throws(() => previewSkillWorkflowRecipe({ ...value, workflow: { ...value.workflow, id } }),
      { code: 'SKP_RECIPE_INVALID' });
  }
  value.definition.phases['team-criteria'] = value.authoring[0];
  assert.throws(() => previewSkillWorkflowRecipe(value), { code: 'SKP_PHASE_BINDING_INVALID' });
});

test('recipe plans become stale when selected contracts or the explicit workflow order change', async () => {
  const value = await fixture();
  const first = previewSkillWorkflowRecipe(value);
  const renamed = previewSkillWorkflowRecipe({ ...value, workflow: { ...value.workflow, label: 'New label' } });
  assert.notEqual(renamed.planSha256, first.planSha256);
  const mixed = previewSkillWorkflowRecipe({ ...value, phases: ['team-criteria', 'design', 'team-plan', 'team-code'] });
  assert.notEqual(mixed.planSha256, first.planSha256);
});

function git(root, ...argv) {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cli(root, ...argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
}

async function approvedRepository(t, { authority = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-recipe-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const value = await fixture();
  for (const phase of value.authoring) {
    const bytes = Buffer.from(`# ${phase.id}\n\nApproved test package with exact retained bytes.\n`);
    const capture = inspectSkillPackageContents(phase.id, new Map([['SKILL.md', bytes]]));
    phase.skill.packageSha256 = capture.manifest.packageSha256;
    value.catalog.skillPackages[phase.id].packageSha256 = capture.manifest.packageSha256;
    const directory = path.join(root, 'singularity', 'skills', phase.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), bytes);
  }
  for (const phase of value.authoring) value.definition.phases[phase.id] = compile(phase, value.catalog);
  await writeFile(path.join(root, '.github', 'agents', 'team-producer.agent.md'), [
    '---', 'name: team-producer', 'description: Governed test producer role.', 'model: [auto]',
    'tools: [read, search, edit, bash, ask_user]', 'metadata:',
    '  sflow-label: "Team producer"',
    '  sflow-phases: "team-criteria,team-plan,team-code"',
    '  sflow-default-for: "team-criteria,team-plan,team-code"',
    '  sflow-world-model-views: ""', '  sflow-model-task: "reason"',
    '---', '', '# Team producer', '', 'Produce only the governed candidate.', ''
  ].join('\n'));
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  await writeFile(workflowFile, YAML.stringify(value.definition));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Recipe Tester');
  git(root, 'config', 'user.email', 'recipe@example.test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'approve recipe source configuration');
  const commit = git(root, 'rev-parse', 'HEAD');
  if (authority) git(root, 'branch', 'sflow/config');
  return { root, commit, workflowFile };
}

test('actual skills-recipe CLI uses the approved commit, returns a separate proposal route, and performs no policy write', async (t) => {
  const { root, commit, workflowFile } = await approvedRepository(t);
  // The live checkout cannot substitute malformed/newer policy for the approved branch.
  await writeFile(workflowFile, 'version: 999\n');
  const before = await readFile(workflowFile, 'utf8');
  const beforeStatus = git(root, 'status', '--porcelain');
  const result = cli(root, 'workflow', 'skills-recipe', 'team-delivery',
    '--label', 'Team delivery', '--phases', 'team-criteria,team-plan,team-code',
    '--planned-claims', 'required', '--clause-phases', 'team-criteria',
    '--claim-owners', 'team-code=team-plan', '--json');
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'workflow.skills-recipe');
  assert.equal(response.operation.classification, 'read');
  assert.deepEqual(Object.values(response.effects), [false, false, false, false]);
  const preview = response.data.recipe;
  assert.equal(preview.source.commit, commit);
  assert.deepEqual(preview.sequence.map((phase) => phase.id), ORDER);
  assert.equal(preview.readiness.configuration, 'candidate');
  assert.equal(preview.readiness.host, 'unavailable');
  assert.equal(preview.conformance.humanApproval, 'pending');
  assert.equal(Object.hasOwn(preview, 'candidateDefinition'), false);
  assert.equal(result.stdout.includes('Approved test package with exact retained bytes.'), false);
  assert.match(preview.planSha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(response.next.some((next) => next.command.includes('workflow create team-delivery')
    && next.command.includes(ORDER.join(',')) && next.command.includes('--propose')));
  const nextCommand = validateSafeSflowCommand(response.next[0].command);
  assert.ok(nextCommand?.copyable);
  const parsed = parseArgs(nextCommand.argv);
  const operation = resolveOperation({ requestedCommand: parsed.positionals[0], ...parsed });
  assert.equal(operation.id, 'workflow.create');
  assert.equal(operation.classification, 'mutation');
  assert.deepEqual(parsed.positionals, ['workflow', 'create', 'team-delivery']);
  assert.equal(parsed.options.phases, ORDER.join(','));
  assert.equal(parsed.options['planned-claims'], 'required');
  assert.equal(parsed.options['claim-owners'], 'team-code=team-plan');
  assert.equal(parsed.options.propose, true);
  assert.equal(Object.hasOwn(parsed.options, 'confirm'), false);
  assert.equal(result.stdout.includes('[object Object]'), false);
  assert.equal(await readFile(workflowFile, 'utf8'), before);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.equal(git(root, 'rev-parse', 'HEAD'), commit);
  assert.equal(git(root, 'rev-parse', 'sflow/config'), commit);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('actual recipe CLI refuses mutable checkout authority and confirmation/execution flags', async (t) => {
  const { root, workflowFile } = await approvedRepository(t, { authority: false });
  const before = await readFile(workflowFile, 'utf8');
  const missing = cli(root, 'workflow', 'skills-recipe', 'team-analysis',
    '--label', 'Team analysis', '--phases', 'team-criteria', '--json');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SKP_APPROVED_AUTHORITY_UNAVAILABLE/);
  const confirmed = cli(root, 'workflow', 'skills-recipe', 'team-analysis',
    '--label', 'Team analysis', '--phases', 'team-criteria', '--confirm', H('b'), '--json');
  assert.notEqual(confirmed.status, 0);
  assert.match(confirmed.stderr, /SKP_OPTION_UNSUPPORTED/);
  assert.equal(await readFile(workflowFile, 'utf8'), before);
});
