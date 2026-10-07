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
  isRetiredPackagedAssetHash,
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
  await walkAssets(
    path.join(PACKAGE_TEMPLATES, 'starter-packs'), 'singularity/templates/starter-packs', assets
  );
  await walkAssets(path.join(PACKAGE_TEMPLATES, 'agents'), '.github/agents', assets);
  await walkAssets(path.join(PACKAGE_TEMPLATES, 'skill-library'), 'singularity/skill-library', assets);
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
    Object.keys(CURRENT_PACKAGED_ASSET_SHA256).sort(), [...assets.keys()].sort(),
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

test('starter pack assets install, restore when missing, and preserve repository edits', async (t) => {
  const starterAssets = new Map();
  await walkAssets(
    path.join(PACKAGE_TEMPLATES, 'starter-packs'),
    'singularity/templates/starter-packs', starterAssets
  );
  assert.ok(starterAssets.size > 0, 'the packaged starter pack must contain files');

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-starter-pack-seeding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'), { recursive: true });
  const installed = await initializeDefinition(root);
  assert.ok(installed.includes('singularity/templates/starter-packs'));
  for (const [relative, bytes] of starterAssets) {
    assert.deepEqual(await readFile(path.join(root, relative)), bytes, relative);
  }
  assert.deepEqual(await initializeDefinition(root), [], 'fresh initialization is idempotent');

  await refreshPackagedConfiguration(root);
  const [relative, packagedBytes] = starterAssets.entries().next().value;
  const target = path.join(root, relative);
  await rm(target);
  const restored = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  assert.ok(restored.files.includes(relative), 'safe reinitialize restores a missing starter asset');
  assert.deepEqual(await readFile(target), packagedBytes);

  const repositoryBytes = Buffer.concat([packagedBytes, Buffer.from('\nRepository customization.\n')]);
  await writeFile(target, repositoryBytes);
  const preserved = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  assert.deepEqual(await readFile(target), repositoryBytes);
  assert.ok(preserved.conflicts.some((entry) =>
    entry.path === relative && entry.resolution === 'preserved-local'));
  const repeated = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  assert.equal(repeated.changed, false, 'repeat reinitialization is idempotent');
  assert.deepEqual(await readFile(target), repositoryBytes);
});

test('planning path-role fixes retain exact upgrade provenance without claiming customized templates', async () => {
  for (const [name, priorDigest] of [
    ['spec-driven/plan.md', 'd18e7af418ac8b89af1df8214c015d23828e5c0d9cfad65123c1d37579f295e5'],
    ['bugfix/fix-spec.md', 'fceed5a1f12fc2be09ec56f0bd1c165efabe8f335df4cf88e6258694bb513e18'],
    ['feature/implementation-spec.md', '033e2f8d2af5e8d762fb1cdbd1bcb5fcb8ba7ec629d158761be832f875cc6014'],
    ['benchmark/design.md', '9c06dcf0182701345b6f4f6af8fe4b7740fc080afe23776d4a6d8749196cca26'],
    ['figma-mobile/mobile-spec.md', '9a8203f044109f068ea6282a7352ac6a69eb8cc90139252610f60e106cb6b521'],
    ['poc-workflow/ui-exploration.md', '43e53c4476249bdd4a9b8af681ca77529d163ec66680d6c4514b0731b9cb1182']
  ]) {
    const relative = `singularity/templates/${name}`;
    const bytes = await readFile(path.join(PACKAGE_TEMPLATES, 'artifacts', name));
    assert.equal(isRetiredPackagedAssetHash(relative, priorDigest), true, name);
    assert.equal(isCurrentPackagedAssetHash(relative, packagedAssetSha256(bytes)), true, name);
    assert.equal(isKnownPackagedAssetHash(relative, packagedAssetSha256(
      Buffer.concat([bytes, Buffer.from('\nTeam-specific plan.\n')])
    )), false, 'repository customization remains owned by its team');
  }
});

test('the first released starter remains an exact upgradeable package revision', () => {
  for (const [relative, digest] of [
    ['singularity/templates/starter-packs/skp-team-notes/README.md',
      '1880cb24e0dbc1ce84677b183dfd672ed7e85ae86e5735a1e8b9f1cb94817f4c'],
    ['singularity/templates/starter-packs/skp-team-notes/draft-input.json',
      '14b4b8deafa8a5434edd7046e7203e4520792c5951350f9d7a7f5c4b904d7ced']
  ]) {
    assert.equal(isRetiredPackagedAssetHash(relative, digest), true, relative);
    assert.equal(isRetiredPackagedAssetHash(relative, '0'.repeat(64)), false,
      'custom content must not acquire framework ownership');
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
  const starterPath = 'singularity/templates/starter-packs/skp-team-notes/README.md';
  const starterDigest = packagedAssetSha256(await readFile(path.join(
    ROOT, 'templates/starter-packs/skp-team-notes/README.md'
  )));
  assert.equal(packagedAssetRegistryPath(starterPath, {
    templatesRoot: 'singularity/templates/starter-packs'
  }), starterPath, 'a custom artifact root must not remap the fixed starter location');
  assert.equal(isKnownPackagedAssetHash(starterPath, starterDigest, {
    templatesRoot: 'singularity/templates/starter-packs'
  }), true, 'the exact packaged starter remains upgradeable with a nested artifact root');
  assert.equal(packagedAssetRegistryPath(
    'singularity/templates/starter-packs/common/implementation.md',
    { templatesRoot: 'singularity/templates/starter-packs' }
  ), 'singularity/templates/common/implementation.md',
  'other files below the starter-pack tree still use the configured artifact root');
  assert.equal(isKnownPackagedAssetHash(
    'company/config/templates/common/implementation.md', packagedAssetSha256(
      Buffer.concat([prior, Buffer.from(' ')])
    ), { templatesRoot: 'company/config/templates' }
  ), false, 'one changed byte must remain repository-owned under a custom root');
});

test('safe reinitialization upgrades a historical artifact under a nested starter-pack root', async (t) => {
  const root = await repositoryFixture('sflow-provenance-nested-template-root-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.templatesRoot = 'singularity/templates/starter-packs';
  await writeFile(workflowFile, YAML.stringify(workflow));
  await refreshPackagedConfiguration(root);

  const relative = 'singularity/templates/starter-packs/common/implementation.md';
  const target = path.join(root, relative);
  const historical = await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/common-implementation.md'
  ));
  assert.equal(isKnownPackagedAssetHash(relative, packagedAssetSha256(historical), {
    templatesRoot: workflow.templatesRoot
  }), true, 'historical artifact bytes retain package provenance below the nested root');
  await writeFile(target, historical);

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  assert.deepEqual(await readFile(target), await readFile(path.join(
    PACKAGE_TEMPLATES, 'artifacts/common/implementation.md'
  )));
  assert.ok(result.files.includes(relative));
  assert.equal(result.conflicts.some((entry) => entry.path === relative), false);
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
