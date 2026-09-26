import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  applyWorkflowImport,
  copyWorkflow,
  exportWorkflowBundle,
  planWorkflowCopy,
  planWorkflowImport,
  readWorkflowBundle
} from '../src/workflow-transfer.mjs';

process.env.NODE_ENV = 'test';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function bundleDigest(bundle) {
  const copy = structuredClone(bundle);
  delete copy.bundleSha256;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(copy))).digest('hex')}`;
}

function objectDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function initializedRepository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return root;
}

async function workflowConfiguration(root) {
  return YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
}

async function writeWorkflowConfiguration(root, configuration) {
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(configuration));
}

async function portfolioConfiguration(root) {
  return YAML.parse(await readFile(path.join(root, 'singularity/portfolio.yml'), 'utf8'));
}

async function writePortfolioConfiguration(root, configuration) {
  await writeFile(path.join(root, 'singularity/portfolio.yml'), YAML.stringify(configuration));
}

function refreshAgentAsset(bundle, agentId, content) {
  const asset = bundle.assets.find((candidate) => candidate.kind === 'agent' && candidate.id === agentId);
  asset.content = content;
  asset.size = Buffer.byteLength(content, 'utf8');
  asset.sha256 = `sha256:${sha256(content)}`;
  bundle.agentLocks[agentId].sourceSha256 = sha256(content);
}

async function addPortableFeature(root, label = 'Portable feature') {
  const configuration = await workflowConfiguration(root);
  configuration.workTypes['portable-feature'] = structuredClone(configuration.workTypes.feature);
  configuration.workTypes['portable-feature'].label = label;
  await writeWorkflowConfiguration(root, configuration);
}

test('workflow export captures a deduplicated multi-workflow dependency closure', async (t) => {
  const root = await initializedRepository(t, 'sflow-workflow-export-');
  const output = path.join(root, 'exports', 'delivery-workflows.json');

  const result = await exportWorkflowBundle(root, ['feature', 'spec-driven-standard'], output);
  assert.equal(result.status, 'exported');
  assert.deepEqual(result.workflows.map(({ governs, id }) => `${governs}:${id}`), [
    'story:feature', 'story:spec-driven-standard'
  ]);
  assert.equal(result.summary.workflows, 2);
  assert.deepEqual(result.dependencies.workflows, [
    'story:feature', 'story:spec-driven-standard'
  ]);
  assert.ok(result.dependencies.phases.includes('story:implementation'));
  assert.ok(result.dependencies.agents.includes('developer'));

  const bundle = await readWorkflowBundle(output);
  assert.deepEqual(Object.keys(bundle.objects.story.workTypes).sort(), [
    'feature', 'spec-driven-standard'
  ]);
  assert.ok(Object.hasOwn(bundle.objects.story.phases, 'implementation'));
  assert.ok(Object.hasOwn(bundle.objects.story.phases, 'specification'));
  assert.ok(Object.hasOwn(bundle.objects.story.artifactSets, 'spec-driven-specification'));
  assert.ok(Object.hasOwn(bundle.objects.story.artifactSets, 'spec-driven-planning'));
  assert.ok(Object.hasOwn(bundle.objects.story.artifactSets, 'spec-driven-verification'));
  assert.ok(Object.hasOwn(bundle.objects.story.approvalAuthorities, 'product-approvers'));
  assert.ok(Object.hasOwn(bundle.objects.story.approvalAuthorities, 'architecture-reviewers'));
  assert.ok(Object.hasOwn(bundle.objects.story.mcpServers, 'playwright'));

  const identities = bundle.assets.map((asset) => `${asset.kind}:${asset.governs ?? ''}:${asset.path}`);
  assert.equal(new Set(identities).size, identities.length, 'shared dependencies are emitted once');
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'developer'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'product-owner'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template'
    && asset.reference === 'common/implementation.md'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template'
    && asset.reference === 'spec-driven/spec.md'));
  assert.ok(bundle.requirements.worldModelViews.includes('architecture'));

  await assert.rejects(
    () => exportWorkflowBundle(root, ['feature'], output),
    (error) => error.code === 'WORKFLOW_EXPORT_OUTPUT_EXISTS'
  );
});

test('workflow bundle v1 refuses skill phases until it can carry exact approved package bytes', async (t) => {
  const source = await initializedRepository(t, 'sflow-skp-transfer-source-');
  const bundle = await exportWorkflowBundle(source, ['story:feature']);

  // An imported or hand-authored v1 bundle must not appear portable merely because its
  // phase binding and outer bundle digest are internally consistent.
  const incomplete = structuredClone(bundle);
  incomplete.objects.story.phases.implementation.kind = 'skill';
  incomplete.objects.story.phases.implementation.skillBinding = {
    bindingRefs: { skill: { id: 'example', packageSha256: `sha256:${'a'.repeat(64)}` } }
  };
  incomplete.bundleSha256 = bundleDigest(incomplete);
  await assert.rejects(
    () => planWorkflowImport(source, incomplete),
    (error) => error.code === 'SKP_WORKFLOW_TRANSFER_UNSUPPORTED'
  );

  const overridden = structuredClone(bundle);
  overridden.objects.story.workTypes.feature.phaseOverrides ??= {};
  overridden.objects.story.workTypes.feature.phaseOverrides.implementation = {
    kind: 'skill', skillBinding: incomplete.objects.story.phases.implementation.skillBinding
  };
  overridden.workflows[0].definitionSha256 = objectDigest(
    overridden.objects.story.workTypes.feature
  );
  overridden.bundleSha256 = bundleDigest(overridden);
  await assert.rejects(
    () => planWorkflowImport(source, overridden),
    (error) => error.code === 'SKP_WORKFLOW_TRANSFER_UNSUPPORTED'
  );

  const configuration = await workflowConfiguration(source);
  configuration.phases.implementation = incomplete.objects.story.phases.implementation;
  await writeWorkflowConfiguration(source, configuration);
  await assert.rejects(
    () => exportWorkflowBundle(source, ['story:feature']),
    (error) => error.code === 'SKP_WORKFLOW_TRANSFER_UNSUPPORTED'
  );
});

test('workflow bundles support Initiative-only and mixed Story/Initiative selections', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-initiative-source-');
  const target = await initializedRepository(t, 'sflow-workflow-initiative-target-');
  const storyAuthorityTarget = await initializedRepository(t, 'sflow-workflow-story-authority-target-');
  const initiativeAuthorityTarget = await initializedRepository(t, 'sflow-workflow-initiative-authority-target-');
  for (const id of ['epic-planning', 'initiative-lite', 'enterprise-delivery']) {
    const single = await exportWorkflowBundle(source, [`initiative:${id}`]);
    assert.deepEqual(single.workflows.map((workflow) => `${workflow.governs}:${workflow.id}`),
      [`initiative:${id}`]);
    assert.ok(Object.keys(single.objects.initiative.initiativePhases).length > 0);
    assert.deepEqual(Object.keys(single.objects.story.approvalAuthorities), [],
      'Initiative-only exports must not capture same-named Story authorities');
  }

  const storyOnly = await exportWorkflowBundle(source, ['story:feature']);
  assert.deepEqual(Object.keys(storyOnly.objects.initiative.approvalAuthorities), [],
    'Story-only exports must not capture same-named Initiative authorities');

  const storyTargetPortfolio = await portfolioConfiguration(storyAuthorityTarget);
  storyTargetPortfolio.approvalAuthorities['product-approvers'].members = [
    { name: 'Initiative only', email: 'initiative-only@example.test' }
  ];
  await writePortfolioConfiguration(storyAuthorityTarget, storyTargetPortfolio);
  const storyOnlyPlan = await planWorkflowImport(storyAuthorityTarget, storyOnly);
  assert.equal(storyOnlyPlan.status, 'ready');
  assert.equal(storyOnlyPlan.conflicts.length, 0,
    'a different same-named Initiative authority must not block a Story import');

  const initiativeOnly = await exportWorkflowBundle(source, ['initiative:epic-planning']);
  const initiativeTargetWorkflow = await workflowConfiguration(initiativeAuthorityTarget);
  initiativeTargetWorkflow.approvalAuthorities['product-approvers'].members = [
    { name: 'Story only', email: 'story-only@example.test' }
  ];
  await writeWorkflowConfiguration(initiativeAuthorityTarget, initiativeTargetWorkflow);
  const initiativeOnlyPlan = await planWorkflowImport(initiativeAuthorityTarget, initiativeOnly);
  assert.equal(initiativeOnlyPlan.status, 'ready');
  assert.equal(initiativeOnlyPlan.conflicts.length, 0,
    'a different same-named Story authority must not block an Initiative import');

  const mixed = await exportWorkflowBundle(source, [
    'story:feature', 'initiative:epic-planning', 'initiative:enterprise-delivery'
  ]);
  assert.deepEqual(mixed.workflows.map((workflow) => `${workflow.governs}:${workflow.id}`), [
    'initiative:enterprise-delivery', 'initiative:epic-planning', 'story:feature'
  ]);
  assert.ok(mixed.assets.some((asset) => asset.kind === 'agent'));
  assert.ok(mixed.assets.some((asset) => asset.kind === 'template' && asset.governs === 'initiative'));
  const plan = await planWorkflowImport(target, mixed);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.conflicts.length, 0);
  const applied = await applyWorkflowImport(target, mixed, { expectedPlanSha256: plan.planSha256 });
  assert.equal(applied.status, 'current', 'the packaged target already contains the exact closure');
});

test('Initiative import refuses view assignments absent from the target Story catalog', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-view-source-');
  const target = await initializedRepository(t, 'sflow-workflow-view-target-');
  const sourceWorkflow = await workflowConfiguration(source);
  sourceWorkflow.worldModel.views = [...sourceWorkflow.worldModel.views, 'source-only'];
  await writeWorkflowConfiguration(source, sourceWorkflow);

  const sourcePortfolio = await portfolioConfiguration(source);
  const profile = structuredClone(sourcePortfolio.initiativeProfiles['epic-planning']);
  profile.label = 'Source-only view initiative';
  profile.phaseOverrides = {
    ...(profile.phaseOverrides ?? {}),
    [profile.phases[0]]: {
      ...(profile.phaseOverrides?.[profile.phases[0]] ?? {}),
      worldModelViews: ['source-only']
    }
  };
  sourcePortfolio.initiativeProfiles['source-only-view'] = profile;
  await writePortfolioConfiguration(source, sourcePortfolio);

  const bundle = await exportWorkflowBundle(source, ['initiative:source-only-view']);
  const workflowBefore = await readFile(path.join(target, 'singularity/workflow.yml'), 'utf8');
  const portfolioBefore = await readFile(path.join(target, 'singularity/portfolio.yml'), 'utf8');
  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.conflicts.some((item) => item.kind === 'initiative.configuration'
    && /undeclared repository world-model views/.test(item.reason)
    && /source-only/.test(item.reason)));
  await assert.rejects(
    () => applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 }),
    (error) => error.code === 'WORKFLOW_IMPORT_CONFLICT'
  );
  assert.equal(await readFile(path.join(target, 'singularity/workflow.yml'), 'utf8'), workflowBefore);
  assert.equal(await readFile(path.join(target, 'singularity/portfolio.yml'), 'utf8'), portfolioBefore);
});

test('workflow bundle rejects content tampering and non-portable asset paths', async (t) => {
  const root = await initializedRepository(t, 'sflow-workflow-integrity-');
  const bundle = await exportWorkflowBundle(root, ['feature']);

  const tampered = structuredClone(bundle);
  tampered.assets[0].content += '\nforged\n';
  tampered.bundleSha256 = bundleDigest(tampered);
  await assert.rejects(
    () => planWorkflowImport(root, tampered),
    (error) => error.code === 'WORKFLOW_BUNDLE_ASSET_INVALID'
  );

  const escaped = structuredClone(bundle);
  escaped.assets.find((asset) => asset.kind === 'template').path = '../outside.md';
  escaped.bundleSha256 = bundleDigest(escaped);
  await assert.rejects(
    () => planWorkflowImport(root, escaped),
    (error) => error.code === 'WORKFLOW_BUNDLE_PATH_INVALID'
  );

  const future = structuredClone(bundle);
  future.schemaVersion = 2;
  future.bundleSha256 = bundleDigest(future);
  await assert.rejects(
    () => planWorkflowImport(root, future),
    (error) => error.code === 'SCHEMA_VERSION_FUTURE'
  );

  const incomplete = structuredClone(bundle);
  delete incomplete.objects.story.phases.intake;
  incomplete.bundleSha256 = bundleDigest(incomplete);
  await assert.rejects(
    () => planWorkflowImport(root, incomplete),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'
  );

  const missingTemplate = structuredClone(bundle);
  const templateIndex = missingTemplate.assets.findIndex((asset) => asset.kind === 'template'
    && asset.reference === 'common/intake.md');
  assert.notEqual(templateIndex, -1);
  missingTemplate.assets.splice(templateIndex, 1);
  missingTemplate.bundleSha256 = bundleDigest(missingTemplate);
  await assert.rejects(
    () => planWorkflowImport(root, missingTemplate),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'
  );
});

test('workflow bundle binds direct and catalog templates to their governed source roots', async (t) => {
  const directSource = await initializedRepository(t, 'sflow-workflow-direct-binding-');
  const directBundle = await exportWorkflowBundle(directSource, ['feature']);
  const directAsset = directBundle.assets.find((asset) => asset.kind === 'template'
    && asset.reference === 'common/intake.md');
  directAsset.rootRelative = 'forged/intake.md';
  directBundle.bundleSha256 = bundleDigest(directBundle);
  await assert.rejects(
    () => planWorkflowImport(directSource, directBundle),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH'
      && /governed reference/.test(error.message)
  );

  const catalogSource = await initializedRepository(t, 'sflow-workflow-catalog-binding-');
  const catalogConfiguration = await workflowConfiguration(catalogSource);
  catalogConfiguration.templates = {
    ...(catalogConfiguration.templates ?? {}),
    'portable-intake': { path: 'portable/intake.md', label: 'Portable intake' }
  };
  catalogConfiguration.workTypes['portable-feature'] = structuredClone(
    catalogConfiguration.workTypes.feature
  );
  catalogConfiguration.workTypes['portable-feature'].templateOverrides = {
    ...catalogConfiguration.workTypes['portable-feature'].templateOverrides,
    intake: 'template:portable-intake'
  };
  await writeWorkflowConfiguration(catalogSource, catalogConfiguration);
  await mkdir(path.join(catalogSource, 'singularity/templates/portable'), { recursive: true });
  await writeFile(path.join(catalogSource, 'singularity/templates/portable/intake.md'),
    '# Portable intake\n');
  const catalogBundle = await exportWorkflowBundle(catalogSource, ['portable-feature']);
  catalogBundle.objects.story.templates['portable-intake'].path = 'portable/forged.md';
  catalogBundle.bundleSha256 = bundleDigest(catalogBundle);
  await assert.rejects(
    () => planWorkflowImport(catalogSource, catalogBundle),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH'
      && /governed reference/.test(error.message)
  );

  const crossRootSource = await initializedRepository(t, 'sflow-workflow-cross-root-');
  const portfolio = await portfolioConfiguration(crossRootSource);
  portfolio.templatesRoot = 'singularity/initiative-templates';
  await writePortfolioConfiguration(crossRootSource, portfolio);
  await cp(path.join(crossRootSource, 'singularity/templates'),
    path.join(crossRootSource, 'singularity/initiative-templates'), { recursive: true });
  const crossRootBundle = await exportWorkflowBundle(crossRootSource,
    ['story:feature', 'initiative:epic-planning']);
  assert.notEqual(crossRootBundle.requirements.templateRoots.story,
    crossRootBundle.requirements.templateRoots.initiative);
  const storyAsset = crossRootBundle.assets.find((asset) => asset.kind === 'template'
    && asset.governs === 'story');
  storyAsset.path = `${crossRootBundle.requirements.templateRoots.initiative}/${storyAsset.rootRelative}`;
  crossRootBundle.bundleSha256 = bundleDigest(crossRootBundle);
  await assert.rejects(
    () => planWorkflowImport(crossRootSource, crossRootBundle),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH'
      && /governed reference/.test(error.message)
  );
});

test('workflow bundle refuses unrelated governed objects outside its dependency closure', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-minimal-source-');
  const target = await initializedRepository(t, 'sflow-workflow-minimal-target-');
  const bundle = await exportWorkflowBundle(source, ['story:feature']);
  const workflow = await workflowConfiguration(source);
  const portfolio = await portfolioConfiguration(source);
  const donor = await exportWorkflowBundle(source, ['story:figma-mobile']);
  const extraAgent = donor.assets.find((asset) => asset.kind === 'agent'
    && !bundle.assets.some((candidate) => candidate.kind === 'agent' && candidate.id === asset.id));
  assert.ok(extraAgent, 'the packaged configuration has an unrelated Initiative agent fixture');

  const extraPhaseId = Object.keys(workflow.phases)
    .find((id) => !Object.hasOwn(bundle.objects.story.phases, id));
  const extraAuthorityId = Object.keys(workflow.approvalAuthorities)
    .find((id) => !Object.hasOwn(bundle.objects.story.approvalAuthorities, id));
  const extraPolicyId = Object.keys(portfolio.applicabilityPolicies)
    .find((id) => !Object.hasOwn(bundle.objects.initiative.applicabilityPolicies, id));
  assert.ok(extraPhaseId && extraAuthorityId && extraPolicyId);

  const mutations = [
    (candidate) => { candidate.objects.story.phases[extraPhaseId] = workflow.phases[extraPhaseId]; },
    (candidate) => {
      candidate.objects.story.approvalAuthorities[extraAuthorityId]
        = workflow.approvalAuthorities[extraAuthorityId];
    },
    (candidate) => {
      candidate.objects.story.templates['unrelated-template'] = 'unrelated/template.md';
    },
    (candidate) => {
      candidate.objects.story.mcpServers['unrelated-server'] = {
        command: 'unrelated-server', phases: []
      };
    },
    (candidate) => {
      candidate.objects.initiative.applicabilityPolicies[extraPolicyId]
        = portfolio.applicabilityPolicies[extraPolicyId];
    },
    (candidate) => {
      candidate.assets.push(structuredClone(extraAgent));
      if (donor.agentLocks[extraAgent.id]) {
        candidate.agentLocks[extraAgent.id] = structuredClone(donor.agentLocks[extraAgent.id]);
      }
    }
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(bundle);
    mutate(candidate);
    candidate.bundleSha256 = bundleDigest(candidate);
    await assert.rejects(
      () => planWorkflowImport(target, candidate),
      (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA'
    );
  }
});

test('workflow import previews, requires exact confirmation, round-trips, and refuses collisions', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-import-source-');
  const target = await initializedRepository(t, 'sflow-workflow-import-target-');
  await addPortableFeature(source);
  const bundle = await exportWorkflowBundle(source, ['portable-feature']);

  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.added.some((item) => item.kind === 'story.workTypes'
    && item.id === 'portable-feature'));
  assert.ok(plan.changedPaths.includes('singularity/workflow.yml'));
  assert.ok(plan.reused.some((item) => item.kind === 'story.phases'
    && item.id === 'implementation'));
  assert.ok(plan.reused.some((item) => item.kind === 'template'
    && item.id === 'singularity/templates/common/implementation.md'));

  const before = await readFile(path.join(target, 'singularity/workflow.yml'), 'utf8');
  await assert.rejects(
    () => applyWorkflowImport(target, bundle, { expectedPlanSha256: 'sha256:not-the-plan' }),
    (error) => error.code === 'WORKFLOW_TRANSFER_PLAN_STALE'
  );
  assert.equal(await readFile(path.join(target, 'singularity/workflow.yml'), 'utf8'), before);

  const applied = await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(applied.status, 'imported');
  assert.equal(applied.changed, true);
  assert.equal((await workflowConfiguration(target)).workTypes['portable-feature'].label, 'Portable feature');

  const current = await planWorkflowImport(target, bundle);
  assert.equal(current.status, 'ready');
  assert.equal(current.added.length, 0);
  assert.equal(current.conflicts.length, 0);
  assert.ok(current.reused.some((item) => item.kind === 'story.workTypes'
    && item.id === 'portable-feature'));
  const noOp = await applyWorkflowImport(target, bundle, { expectedPlanSha256: current.planSha256 });
  assert.equal(noOp.status, 'current');
  assert.equal(noOp.changed, false);

  const conflictingTarget = await initializedRepository(t, 'sflow-workflow-import-conflict-');
  await addPortableFeature(conflictingTarget, 'Locally different feature');
  const conflictingBefore = await readFile(path.join(conflictingTarget, 'singularity/workflow.yml'), 'utf8');
  const conflict = await planWorkflowImport(conflictingTarget, bundle);
  assert.equal(conflict.status, 'blocked');
  assert.ok(conflict.conflicts.some((item) => item.kind === 'story.workTypes'
    && item.id === 'portable-feature'));
  await assert.rejects(
    () => applyWorkflowImport(conflictingTarget, bundle, {
      expectedPlanSha256: conflict.planSha256
    }),
    (error) => error.code === 'WORKFLOW_IMPORT_CONFLICT'
  );
  assert.equal(await readFile(path.join(conflictingTarget, 'singularity/workflow.yml'), 'utf8'),
    conflictingBefore);
});

test('workflow import reuses pure LF/CRLF text and refuses ambiguous text encodings', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-line-endings-source-');
  const target = await initializedRepository(t, 'sflow-workflow-line-endings-target-');
  const bundle = await exportWorkflowBundle(source, ['feature']);
  const asset = bundle.assets.find((candidate) => candidate.kind === 'template'
    && candidate.reference === 'common/intake.md');
  assert.ok(asset);
  assert.equal(asset.content.includes('\r'), false, 'the exported canonical fixture uses LF');
  assert.ok((asset.content.match(/\n/g) ?? []).length > 1, 'the fixture can exercise mixed endings');

  const targetFile = path.join(target, asset.path);
  const crlf = Buffer.from(asset.content.replaceAll('\n', '\r\n'), 'utf8');
  await writeFile(targetFile, crlf);
  const reusable = await planWorkflowImport(target, bundle);
  assert.equal(reusable.status, 'ready');
  assert.ok(reusable.reused.some((item) => item.kind === 'template'
    && item.id === asset.path && item.sha256 === asset.sha256));
  const applied = await applyWorkflowImport(target, bundle, {
    expectedPlanSha256: reusable.planSha256
  });
  assert.equal(applied.status, 'current');
  assert.deepEqual(await readFile(targetFile), crlf,
    'reuse does not rewrite the target or normalize canonical bundle bytes');

  await writeFile(targetFile, asset.content.replace('\n', '\r\n'));
  const mixed = await planWorkflowImport(target, bundle);
  assert.equal(mixed.status, 'blocked');
  assert.ok(mixed.conflicts.some((item) => item.id === asset.path
    && /mixed or ambiguous line endings/.test(item.reason)));

  await writeFile(targetFile, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(asset.content, 'utf8')
  ]));
  const bom = await planWorkflowImport(target, bundle);
  assert.equal(bom.status, 'blocked');
  assert.ok(bom.conflicts.some((item) => item.id === asset.path
    && /byte-order mark/.test(item.reason)));

  for (const invalidContent of [
    asset.content.replace('\n', '\r\n'),
    `\ufeff${asset.content}`
  ]) {
    const invalidBundle = structuredClone(bundle);
    const invalidAsset = invalidBundle.assets.find((candidate) => candidate.path === asset.path);
    invalidAsset.content = invalidContent;
    invalidAsset.size = Buffer.byteLength(invalidContent, 'utf8');
    invalidAsset.sha256 = `sha256:${sha256(invalidContent)}`;
    invalidBundle.bundleSha256 = bundleDigest(invalidBundle);
    await assert.rejects(
      () => planWorkflowImport(target, invalidBundle),
      (error) => error.code === 'WORKFLOW_BUNDLE_ASSET_INVALID'
    );
  }
});

test('workflow bundles carry named templates and hash-locked agent template dependencies', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-catalog-source-');
  const target = await initializedRepository(t, 'sflow-workflow-catalog-target-');
  const configuration = await workflowConfiguration(source);
  configuration.templates = {
    ...(configuration.templates ?? {}),
    'portable-intake': {
      path: 'portable/intake.md', label: 'Portable intake', kind: 'requirements'
    }
  };
  configuration.workTypes['portable-feature'] = structuredClone(configuration.workTypes.feature);
  configuration.workTypes['portable-feature'].label = 'Portable catalog feature';
  configuration.workTypes['portable-feature'].templateOverrides = {
    ...(configuration.workTypes['portable-feature'].templateOverrides ?? {}),
    intake: 'template:portable-intake',
    requirements: 'agent:portable-owner/intake'
  };
  await writeWorkflowConfiguration(source, configuration);
  await mkdir(path.join(source, 'singularity/templates/portable'), { recursive: true });
  await writeFile(path.join(source, 'singularity/templates/portable/intake.md'), '# Portable intake\n');

  const agent = `---
name: portable-owner
description: Supplies the locked portable intake template
tools: []
---

Use the governed remote intake template.

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| intake | https://cdn.example.com/portable-intake.md | requirements | false | 4096 |
`;
  await mkdir(path.join(source, '.github/agents'), { recursive: true });
  await writeFile(path.join(source, '.github/agents/portable-owner.agent.md'), agent);
  const remoteSha = 'b'.repeat(64);
  await writeFile(path.join(source, 'singularity/agents.lock.yml'), YAML.stringify({
    version: 1,
    agents: {
      'portable-owner': {
        source: '.github/agents/portable-owner.agent.md',
        sourceSha256: sha256(agent),
        lockedAt: '2026-09-22T00:00:00.000Z',
        dependencies: [{
          id: 'intake', type: 'template', url: 'https://cdn.example.com/portable-intake.md',
          phases: ['requirements'], optional: false, maxBytes: 4096,
          sha256: remoteSha, size: 24,
          resolvedUrl: 'https://cdn.example.com/portable-intake.md'
        }]
      }
    }
  }));

  const bundle = await exportWorkflowBundle(source, ['portable-feature']);
  assert.deepEqual(bundle.objects.story.templates['portable-intake'], {
    path: 'portable/intake.md', label: 'Portable intake', kind: 'requirements'
  });
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template'
    && asset.reference === 'template:portable-intake'
    && asset.rootRelative === 'portable/intake.md'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'portable-owner'));
  assert.equal(bundle.agentLocks['portable-owner'].sourceSha256, sha256(agent));
  assert.equal(bundle.requirements.dependencyMaterialization, 'hash-verified-refetch');

  const missingTemplate = structuredClone(bundle);
  missingTemplate.objects.story.workTypes['portable-feature']
    .templateOverrides.requirements = 'agent:portable-owner/missing';
  missingTemplate.workflows.find((workflow) => workflow.governs === 'story'
    && workflow.id === 'portable-feature').definitionSha256 = objectDigest(
    missingTemplate.objects.story.workTypes['portable-feature']
  );
  missingTemplate.bundleSha256 = bundleDigest(missingTemplate);
  await assert.rejects(
    () => planWorkflowImport(target, missingTemplate),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'
      && /does not declare remote template 'missing'/.test(error.message)
  );

  const wrongType = structuredClone(bundle);
  const wrongTypeAsset = wrongType.assets.find((asset) => asset.kind === 'agent'
    && asset.id === 'portable-owner');
  const skillContent = wrongTypeAsset.content.replace(
    '## Remote artifact templates', '## Remote skills'
  );
  refreshAgentAsset(wrongType, 'portable-owner', skillContent);
  wrongType.agentLocks['portable-owner'].dependencies[0].type = 'skill';
  wrongType.bundleSha256 = bundleDigest(wrongType);
  await assert.rejects(
    () => planWorkflowImport(target, wrongType),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH'
      && /not a template/.test(error.message)
  );

  const wrongPhase = structuredClone(bundle);
  const wrongPhaseAsset = wrongPhase.assets.find((asset) => asset.kind === 'agent'
    && asset.id === 'portable-owner');
  const phaseContent = wrongPhaseAsset.content.replace(
    '| intake | https://cdn.example.com/portable-intake.md | requirements | false | 4096 |',
    '| intake | https://cdn.example.com/portable-intake.md | design | false | 4096 |'
  );
  refreshAgentAsset(wrongPhase, 'portable-owner', phaseContent);
  wrongPhase.bundleSha256 = bundleDigest(wrongPhase);
  await assert.rejects(
    () => planWorkflowImport(target, wrongPhase),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH'
      && /not scoped to phase 'requirements'/.test(error.message)
  );

  const targetConfiguration = await workflowConfiguration(target);
  targetConfiguration.templatesRoot = 'custom/templates';
  await writeWorkflowConfiguration(target, targetConfiguration);

  const collisionTarget = await initializedRepository(t, 'sflow-workflow-case-collision-');
  const collisionConfiguration = await workflowConfiguration(collisionTarget);
  collisionConfiguration.templatesRoot = 'custom/templates';
  await writeWorkflowConfiguration(collisionTarget, collisionConfiguration);
  await mkdir(path.join(collisionTarget, 'custom/templates/portable'), { recursive: true });
  await writeFile(path.join(collisionTarget, 'custom/templates/portable/Intake.md'), '# Other case\n');
  const collisionPlan = await planWorkflowImport(collisionTarget, bundle);
  assert.equal(collisionPlan.status, 'blocked');
  assert.ok(collisionPlan.conflicts.some((item) => item.kind === 'template'
    && item.id === 'custom/templates/portable/intake.md'
    && /portable path identity/.test(item.reason)));

  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready');
  for (const expected of [
    '.github/agents/portable-owner.agent.md', 'custom/templates/portable/intake.md',
    'singularity/agents.lock.yml', 'singularity/workflow.yml'
  ]) assert.ok(plan.changedPaths.includes(expected), `missing predicted changed path ${expected}`);
  assert.ok(plan.added.some((item) => item.kind === 'story.templates'
    && item.id === 'portable-intake'));
  assert.ok(plan.added.some((item) => item.kind === 'agent-lock'
    && item.id === 'portable-owner'));
  assert.ok(plan.added.some((item) => item.kind === 'template'
    && item.id === 'custom/templates/portable/intake.md'));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(await readFile(path.join(target, 'custom/templates/portable/intake.md'), 'utf8'),
    '# Portable intake\n');
  const importedLock = YAML.parse(await readFile(path.join(target, 'singularity/agents.lock.yml'), 'utf8'));
  assert.equal(importedLock.agents['portable-owner'].dependencies[0].sha256, remoteSha);
  assert.deepEqual((await workflowConfiguration(target)).templates['portable-intake'], {
    path: 'portable/intake.md', label: 'Portable intake', kind: 'requirements'
  });

  const incompatible = structuredClone(bundle);
  const agentAsset = incompatible.assets.find((asset) => asset.kind === 'agent'
    && asset.id === 'portable-owner');
  agentAsset.content = agentAsset.content.replace('tools: []',
    'tools: []\nmetadata:\n  sflow-phases: missing-phase');
  agentAsset.size = Buffer.byteLength(agentAsset.content, 'utf8');
  agentAsset.sha256 = `sha256:${sha256(agentAsset.content)}`;
  incompatible.agentLocks['portable-owner'].sourceSha256 = sha256(agentAsset.content);
  incompatible.bundleSha256 = bundleDigest(incompatible);
  const refused = await planWorkflowImport(await initializedRepository(t,
    'sflow-workflow-agent-preflight-'), incompatible);
  assert.equal(refused.status, 'blocked');
  assert.ok(refused.conflicts.some((item) => item.kind === 'story.configuration'
    && /unknown phase 'missing-phase'/.test(item.reason)));
});

test('workflow copy is a confirmed linked duplicate that preserves the source and shared phases', async (t) => {
  const root = await initializedRepository(t, 'sflow-workflow-copy-');
  const before = await workflowConfiguration(root);
  const source = structuredClone(before.workTypes.feature);
  const phaseCount = Object.keys(before.phases).length;
  const plan = await planWorkflowCopy(root, {
    sourceId: 'feature', targetId: 'feature-team', label: 'Feature — Team'
  });

  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.changedPaths, ['singularity/workflow.yml']);
  assert.equal(plan.sharedDependencies.linked, true);
  assert.equal(plan.sharedDependencies.phases, source.phases.length);
  assert.deepEqual(plan.added, [{ kind: 'story.workflow', id: 'feature-team' }]);
  assert.deepEqual(plan.reused.filter((item) => item.kind === 'story.phase').map((item) => item.id),
    [...source.phases].sort());

  await assert.rejects(
    () => copyWorkflow(root, {
      sourceId: 'feature', targetId: 'feature-team', label: 'Feature — Team',
      expectedPlanSha256: 'sha256:not-the-plan'
    }),
    (error) => error.code === 'WORKFLOW_TRANSFER_PLAN_STALE'
  );
  assert.equal(Object.hasOwn((await workflowConfiguration(root)).workTypes, 'feature-team'), false);

  const copied = await copyWorkflow(root, {
    sourceId: 'feature', targetId: 'feature-team', label: 'Feature — Team',
    expectedPlanSha256: plan.planSha256
  });
  assert.equal(copied.status, 'copied');
  const after = await workflowConfiguration(root);
  assert.deepEqual(after.workTypes.feature, source, 'the source workflow is untouched');
  assert.deepEqual(after.workTypes['feature-team'], { ...source, label: 'Feature — Team' });
  assert.equal(Object.keys(after.phases).length, phaseCount, 'copy links to existing phases');

  const collision = await planWorkflowCopy(root, {
    sourceId: 'feature', targetId: 'feature-team', label: 'Another label'
  });
  assert.equal(collision.status, 'blocked');
  assert.deepEqual(collision.conflicts, [{
    kind: 'story.workflow', id: 'feature-team', reason: 'target workflow already exists'
  }]);
});

test('workflow copy accepts a governed selector when Story and Initiative IDs overlap', async (t) => {
  const root = await initializedRepository(t, 'sflow-workflow-copy-selector-');
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  const sourceProfile = Object.values(portfolio.initiativeProfiles)[0];
  portfolio.initiativeProfiles.feature = { ...structuredClone(sourceProfile), label: 'Initiative feature' };
  await writeFile(portfolioFile, YAML.stringify(portfolio));

  await assert.rejects(
    () => planWorkflowCopy(root, {
      sourceId: 'feature', targetId: 'feature-copy', label: 'Feature copy'
    }),
    (error) => error.code === 'WORKFLOW_SELECTOR_AMBIGUOUS'
  );
  const plan = await planWorkflowCopy(root, {
    sourceId: 'story:feature', targetId: 'feature-copy', label: 'Feature copy'
  });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.sourceSelector, 'story:feature');
  assert.ok(plan.reused.some((item) => item.kind === 'story.approval-authority'));
  assert.ok(plan.reused.some((item) => item.kind === 'agent'));

  const complete = await planWorkflowCopy(root, {
    sourceId: 'story:spec-driven-standard', targetId: 'spec-copy', label: 'Spec copy'
  });
  assert.ok(complete.reused.some((item) => item.kind === 'artifact-set'));
});
