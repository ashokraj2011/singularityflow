import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import {
  CURRENT_PACKAGED_ASSET_SHA256,
  isCurrentPackagedAssetHash,
  isKnownPackagedAssetHash,
  packagedAssetRegistryPath,
  packagedAssetSha256
} from '../src/packaged-asset-history.mjs';
import {
  CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256,
  isKnownPackagedWorkflowValue, packagedWorkflowValueSha256
} from '../src/packaged-workflow-history.mjs';
import { refreshPackagedConfiguration } from '../src/workspace-configuration-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_TEMPLATES = path.join(ROOT, 'templates');
const FIXED_ASSETS = Object.freeze([
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', 'singularity/prompts/copilot-planning.md']
]);

async function walkAssets(sourceRoot, targetRoot, output) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.posix.join(targetRoot, entry.name);
    if (entry.isDirectory()) await walkAssets(source, target, output);
    else if (entry.isFile() && !entry.isSymbolicLink()) output.set(target, await readFile(source));
  }
}

async function currentPackagedAssets() {
  const assets = new Map();
  for (const [source, target] of FIXED_ASSETS) {
    assets.set(target, await readFile(path.join(PACKAGE_TEMPLATES, source)));
  }
  await walkAssets(
    path.join(PACKAGE_TEMPLATES, 'artifacts'), 'singularity/templates', assets
  );
  await walkAssets(path.join(PACKAGE_TEMPLATES, 'agents'), '.github/agents', assets);
  return new Map([...assets.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function repositoryFixture(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await initializeDefinition(root);
  await refreshPackagedConfiguration(root);
  return root;
}

test('release registry contains every current packaged configuration asset at its exact digest', async () => {
  const assets = await currentPackagedAssets();
  assert.deepEqual(
    Object.keys(CURRENT_PACKAGED_ASSET_SHA256).sort(), [...assets.keys()],
    'adding, removing, or moving a packaged asset requires an explicit registry update'
  );
  for (const [relative, bytes] of assets) {
    const digest = packagedAssetSha256(bytes);
    assert.equal(CURRENT_PACKAGED_ASSET_SHA256[relative], digest, relative);
    assert.equal(isCurrentPackagedAssetHash(relative, digest), true, relative);
    assert.equal(isKnownPackagedAssetHash(relative, digest), true, relative);
  }
});

test('release registry contains every current packaged workflow node at its canonical digest', async () => {
  const workflow = YAML.parse(await readFile(path.join(PACKAGE_TEMPLATES, 'workflow.yml'), 'utf8'));
  for (const section of ['workTypes', 'phases', 'artifactSets', 'mcpServers']) {
    assert.deepEqual(
      Object.keys(CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section]).sort(),
      Object.keys(workflow[section] ?? {}).sort(),
      `adding, removing, or renaming a packaged ${section} node requires a registry update`
    );
    for (const [id, value] of Object.entries(workflow[section] ?? {})) {
      const digest = packagedWorkflowValueSha256(value);
      assert.equal(CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256[section][id], digest,
        `${section}.${id}`);
      assert.equal(isKnownPackagedWorkflowValue(section, id, value), true,
        `${section}.${id}`);
    }
  }
});

test('custom templatesRoot canonicalizes only explicitly rooted template assets', async () => {
  const prior = await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/common-implementation.md'
  ));
  const digest = packagedAssetSha256(prior);
  assert.equal(packagedAssetRegistryPath(
    'company/config/templates/common/implementation.md',
    { templatesRoot: 'company/config/templates' }
  ), 'singularity/templates/common/implementation.md');
  assert.equal(isKnownPackagedAssetHash(
    'company/config/templates/common/implementation.md', digest,
    { templatesRoot: 'company/config/templates' }
  ), true);
  assert.equal(isKnownPackagedAssetHash(
    'company/config/templates/common/implementation.md', digest
  ), false, 'a suffix match without the validated root must not grant framework ownership');
  assert.equal(packagedAssetRegistryPath(
    'company/config/prompts/copilot-planning.md',
    { templatesRoot: 'company/config/templates' }
  ), 'company/config/prompts/copilot-planning.md', 'fixed prompts remain exact-path scoped');
  assert.equal(isKnownPackagedAssetHash(
    'company/config/templates/common/implementation.md', packagedAssetSha256(
      Buffer.concat([prior, Buffer.from(' ')])
    ), { templatesRoot: 'company/config/templates' }
  ), false, 'one changed byte must remain repository-owned under a custom root');
});

test('safe reinitialization upgrades exact prior package assets and modern workflow nodes', async (t) => {
  const root = await repositoryFixture('sflow-provenance-upgrade-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  const priorWorkflow = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/packaged-workflow-prior-v2.yml'
  ), 'utf8'));
  for (const section of ['workTypes', 'phases', 'artifactSets', 'mcpServers']) {
    for (const [id, value] of Object.entries(priorWorkflow[section])) {
      assert.equal(isKnownPackagedWorkflowValue(section, id, value), true,
        `fixture is not registered: ${section}.${id}`);
      workflow[section][id] = structuredClone(value);
    }
  }
  await writeFile(workflowFile, YAML.stringify(workflow));

  const priorTemplate = await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/common-implementation.md'
  ));
  const priorPrompt = await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/copilot-planning.md'
  ));
  await writeFile(path.join(root, 'singularity/templates/common/implementation.md'), priorTemplate);
  await writeFile(path.join(root, 'singularity/prompts/copilot-planning.md'), priorPrompt);

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const currentWorkflow = YAML.parse(await readFile(path.join(PACKAGE_TEMPLATES, 'workflow.yml'), 'utf8'));
  const observed = YAML.parse(await readFile(workflowFile, 'utf8'));
  for (const section of ['workTypes', 'phases', 'artifactSets', 'mcpServers']) {
    for (const id of Object.keys(priorWorkflow[section])) {
      assert.deepEqual(observed[section][id], currentWorkflow[section][id], `${section}.${id}`);
    }
  }
  assert.deepEqual(
    await readFile(path.join(root, 'singularity/templates/common/implementation.md')),
    await readFile(path.join(PACKAGE_TEMPLATES, 'artifacts/common/implementation.md'))
  );
  assert.deepEqual(
    await readFile(path.join(root, 'singularity/prompts/copilot-planning.md')),
    await readFile(path.join(PACKAGE_TEMPLATES, 'copilot-planning.md'))
  );
  for (const expected of [
    'singularity/workflow.yml',
    'singularity/templates/common/implementation.md',
    'singularity/prompts/copilot-planning.md'
  ]) assert.ok(result.files.includes(expected), expected);
});

test('safe reinitialization preserves one-byte and one-field prior-package customizations', async (t) => {
  const root = await repositoryFixture('sflow-provenance-custom-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  const priorWorkflow = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/packaged-workflow-prior-v2.yml'
  ), 'utf8'));
  const custom = {
    workTypes: structuredClone(priorWorkflow.workTypes['classic-delivery']),
    phases: structuredClone(priorWorkflow.phases.planning),
    artifactSets: structuredClone(priorWorkflow.artifactSets['spec-driven-specification']),
    mcpServers: structuredClone(priorWorkflow.mcpServers.playwright)
  };
  custom.workTypes.description += ' Repository choice.';
  custom.phases.label += ' — repository choice';
  custom.artifactSets.members[1].role += '-repository';
  // The historical server predates the packaged Testing phase binding. Adding that one phase is
  // both a valid repository customization and enough to remove exact package provenance.
  custom.mcpServers.phases.push('testing');
  workflow.workTypes['classic-delivery'] = structuredClone(custom.workTypes);
  workflow.phases.planning = structuredClone(custom.phases);
  workflow.artifactSets['spec-driven-specification'] = structuredClone(custom.artifactSets);
  workflow.mcpServers.playwright = structuredClone(custom.mcpServers);
  await writeFile(workflowFile, YAML.stringify(workflow));

  const priorTemplate = Buffer.concat([await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/common-implementation.md'
  )), Buffer.from(' ')]);
  const priorPrompt = Buffer.concat([await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/copilot-planning.md'
  )), Buffer.from(' ')]);
  const templateFile = path.join(root, 'singularity/templates/common/implementation.md');
  const promptFile = path.join(root, 'singularity/prompts/copilot-planning.md');
  await writeFile(templateFile, priorTemplate);
  await writeFile(promptFile, priorPrompt);

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const observed = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(observed.workTypes['classic-delivery'], custom.workTypes);
  assert.deepEqual(observed.phases.planning, custom.phases);
  assert.deepEqual(observed.artifactSets['spec-driven-specification'], custom.artifactSets);
  assert.deepEqual(observed.mcpServers.playwright, custom.mcpServers);
  assert.deepEqual(await readFile(templateFile), priorTemplate);
  assert.deepEqual(await readFile(promptFile), priorPrompt);
  for (const expected of [
    'workflow.workTypes.classic-delivery',
    'workflow.phases.planning',
    'workflow.artifactSets.spec-driven-specification',
    'workflow.mcpServers.playwright',
    'singularity/templates/common/implementation.md',
    'singularity/prompts/copilot-planning.md'
  ]) {
    assert.ok(result.conflicts.some((entry) =>
      entry.path === expected && entry.resolution === 'preserved-local'), expected);
  }
});
