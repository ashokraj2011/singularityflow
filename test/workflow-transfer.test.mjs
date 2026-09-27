import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { discoverAgents, parseAgentDependencies } from '../src/agents.mjs';
import { mcpServersForContext } from '../src/mcp.mjs';
import {
  applyWorkflowImport,
  copyWorkflow,
  exportWorkflowBundle,
  planWorkflowCopy,
  planWorkflowImport,
  readWorkflowBundle,
  WORKFLOW_BUNDLE_SCHEMA_VERSION
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

async function repositoryFilesSnapshot(root) {
  const queue = ['']; const result = [];
  for (const directory of queue) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { result.push({ path: relative, kind: 'directory' }); queue.push(relative); }
      else if (entry.isFile()) result.push({ path: relative, kind: 'file', sha256: sha256(await readFile(path.join(root, relative))) });
      else result.push({ path: relative, kind: 'other' });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
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

async function mcpClosureFixture(t, { transitive = false } = {}) {
  const source = await initializedRepository(t, 'sflow-workflow-mcp-closure-source-');
  const target = await initializedRepository(t, 'sflow-workflow-mcp-closure-target-');
  const configuration = await workflowConfiguration(source);
  configuration.templates ??= {};
  const addPhase = async (id, agent, tools = []) => {
    const templateId = `${id}-template`; const relative = `portable-mcp/${id}.md`;
    configuration.templates[templateId] = { path: relative, label: `${id} output` };
    configuration.phases[id] = {
      label: id, artifact: { path: `artifacts/${id}/output.md`, minimumBytes: 20, maximumBytes: 4096 },
      defaultTemplate: `template:${templateId}`, inputs: ['intake'],
      approval: { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1 },
      writeScope: 'artifact-only',
      generation: { requirement: 'optional', defaultProducer: 'human', allowedProducers: ['human', 'governed-agent'], task: 'analyze' }
    };
    await mkdir(path.join(source, configuration.templatesRoot, 'portable-mcp'), { recursive: true });
    await writeFile(path.join(source, configuration.templatesRoot, relative), `# ${id}\n\n## Inputs\n\n## Findings\n`);
    await writeFile(path.join(source, `.github/agents/${agent}.agent.md`), `---\n${YAML.stringify({
      name: agent, description: `Reviewed ${id} role`, tools,
      metadata: { 'sflow-phases': id, 'sflow-default-for': id, 'sflow-world-model-views': 'architecture' }
    })}---\nRead the exact approved inputs and produce only the selected artifact.\n`);
  };
  const server = (hostReference, agents, phases) => ({ hostReference, agents, phases,
    tools: ['inspect'], required: false, approval: 'confirm', evidence: { captureToolCalls: true, captureResults: false } });

  await addPhase('portable-note', 'portable-producer', transitive
    ? ['portable-bridge-server/inspect', 'portable-cycle-server/inspect']
    : ['portable-agent-server/inspect']);
  configuration.workTypes['portable-mcp-feature'] = structuredClone(configuration.workTypes.feature);
  configuration.workTypes['portable-mcp-feature'].label = 'Portable MCP feature';
  configuration.workTypes['portable-mcp-feature'].phases.splice(
    configuration.workTypes['portable-mcp-feature'].phases.indexOf('conformance'), 0, 'portable-note');
  if (transitive) {
    await addPhase('extra-note', 'extra-owner', ['portable-bridge-server/inspect', 'portable-tail-server/inspect']);
    await addPhase('tail-note', 'tail-owner', ['portable-tail-server/inspect', 'portable-cycle-server/inspect']);
    configuration.phases['portable-note'].mcp = { requiredServers: ['portable-bridge-server'] };
    configuration.phases['extra-note'].mcp = { requiredServers: ['portable-tail-server'] };
    configuration.phases['extra-note'].inputs = ['tail-note'];
    configuration.phases['extra-note'].artifactSet = 'portable-extra-set';
    configuration.phases['extra-note'].qualityCommands = [{ id: 'portable-exact-check', argv: ['node', '--version'], modelPolicy: 'never' }];
    configuration.artifactSets ??= {};
    configuration.artifactSets['portable-extra-set'] = { primary: 'output.md',
      members: [{ path: 'output.md', role: 'findings', required: true }] };
    configuration.phases['tail-note'].mcp = { requiredServers: ['portable-cycle-server'] };
    configuration.mcpServers['portable-bridge-server'] = server('portable-bridge-server', ['portable-producer', 'extra-owner'], ['portable-note', 'extra-note']);
    configuration.mcpServers['portable-tail-server'] = server('portable-tail-server', ['extra-owner', 'tail-owner'], ['extra-note', 'tail-note']);
    configuration.mcpServers['portable-cycle-server'] = server('portable-cycle-server', ['tail-owner', 'portable-producer'], ['tail-note', 'portable-note']);
  } else configuration.mcpServers['portable-agent-server'] = server('portable-agent-server', ['portable-producer'], []);

  await addPhase('unrelated-note', 'unrelated-owner', ['unrelated-server/inspect']);
  configuration.mcpServers['unrelated-server'] = server('unrelated-server', ['unrelated-owner'], ['unrelated-note']);
  await writeWorkflowConfiguration(source, configuration);
  const validated = await loadDefinition(source);
  return { source, target, configuration, validated };
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

test('workflow export includes an unrestricted MCP server assigned only to a selected agent without widening its scope', async (t) => {
  const f = await mcpClosureFixture(t);
  assert.ok(mcpServersForContext(f.validated, { agent: 'portable-producer', phase: 'portable-note' })
    .some((server) => server.id === 'portable-agent-server'), 'the valid source runtime actually exposes this server');
  const bundle = await exportWorkflowBundle(f.source, ['story:portable-mcp-feature']);
  assert.deepEqual(bundle.objects.story.mcpServers['portable-agent-server'], f.configuration.mcpServers['portable-agent-server']);
  assert.deepEqual(bundle.objects.story.mcpServers['portable-agent-server'].phases, [], 'do not narrow unrestricted server semantics');
  assert.equal(Object.hasOwn(bundle.objects.story.mcpServers, 'unrelated-server'), false);
  assert.equal(Object.hasOwn(bundle.objects.story.phases, 'unrelated-note'), false);
  assert.equal(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'unrelated-owner'), false);
  const plan = await planWorkflowImport(f.target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(f.target, bundle, { expectedPlanSha256: plan.planSha256 });
  const imported = await loadDefinition(f.target);
  assert.deepEqual(imported.mcpServers['portable-agent-server'].phases, []);
  assert.deepEqual(imported.mcpServers['portable-agent-server'].agents, ['portable-producer']);
  assert.equal(imported.mcpServers['portable-agent-server'].approval, 'confirm');
});

test('workflow export reaches a fixed point through cyclic MCP agent and phase references and retains all added phase dependencies', async (t) => {
  const f = await mcpClosureFixture(t, { transitive: true });
  const bundle = await exportWorkflowBundle(f.source, ['story:portable-mcp-feature']);
  for (const server of ['portable-bridge-server', 'portable-tail-server', 'portable-cycle-server']) {
    assert.deepEqual(bundle.objects.story.mcpServers[server], f.configuration.mcpServers[server], 'full server scope must remain exact');
  }
  for (const phase of ['portable-note', 'extra-note', 'tail-note']) {
    assert.deepEqual(bundle.objects.story.phases[phase], f.configuration.phases[phase]);
    assert.deepEqual(bundle.objects.story.templates[`${phase}-template`], f.configuration.templates[`${phase}-template`]);
    assert.equal(bundle.assets.filter((asset) => asset.kind === 'template'
      && asset.reference === `template:${phase}-template`).length, 1);
  }
  for (const agent of ['portable-producer', 'extra-owner', 'tail-owner']) {
    assert.equal(bundle.assets.filter((asset) => asset.kind === 'agent' && asset.id === agent).length, 1, 'cycles must deduplicate assets');
  }
  assert.deepEqual(bundle.objects.story.artifactSets['portable-extra-set'], f.configuration.artifactSets['portable-extra-set']);
  assert.ok(Object.hasOwn(bundle.objects.story.approvalAuthorities, 'engineering-reviewers'));
  assert.ok(bundle.requirements.worldModelViews.includes('architecture'));
  assert.equal(Object.hasOwn(bundle.objects.story.mcpServers, 'unrelated-server'), false);
  assert.equal(Object.hasOwn(bundle.objects.story.phases, 'unrelated-note'), false);
  assert.equal(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'unrelated-owner'), false);
  assert.equal(bundle.workflows.length, 1, 'closure must not copy unrelated workflow rows');
  assert.equal(bundle.objects.story.workTypes['portable-mcp-feature'].phases.includes('extra-note'), false,
    'additional scope phases are dependencies, not newly scheduled workflow steps');
  f.configuration.mcpServers = Object.fromEntries(Object.entries(f.configuration.mcpServers).reverse());
  await writeWorkflowConfiguration(f.source, f.configuration);
  await loadDefinition(f.source);
  const reordered = await exportWorkflowBundle(f.source, ['story:portable-mcp-feature']);
  assert.deepEqual(reordered.objects, bundle.objects, 'declaration order must not change graph closure');
  assert.deepEqual(reordered.assets, bundle.assets);
  assert.deepEqual(reordered.requirements, bundle.requirements);
  const plan = await planWorkflowImport(f.target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(f.target, bundle, { expectedPlanSha256: plan.planSha256 });
  const imported = await loadDefinition(f.target);
  assert.ok(imported.phases['extra-note'] && imported.phases['tail-note']);
  assert.equal(imported.agentCatalog.find((agent) => agent.id === 'extra-owner').defaultFor[0], 'extra-note');
  assert.deepEqual(imported.mcpServers['portable-bridge-server'].phases, ['portable-note', 'extra-note']);
  assert.deepEqual(imported.phases['extra-note'].qualityCommands[0].argv, ['node', '--version']);
});

test('workflow bundle closure rejects self-rehashed missing transitive MCP phase agent server template and artifact references before writes', async (t) => {
  const f = await mcpClosureFixture(t, { transitive: true });
  const bundle = await exportWorkflowBundle(f.source, ['story:portable-mcp-feature']);
  const before = await readFile(path.join(f.target, 'singularity/workflow.yml'));
  const removals = [
    ['MCP scope phase', (candidate) => { delete candidate.objects.story.phases['extra-note']; }],
    ['MCP assigned agent', (candidate) => { candidate.assets = candidate.assets.filter((asset) => asset.kind !== 'agent' || asset.id !== 'tail-owner'); }],
    ['phase-required MCP server', (candidate) => { delete candidate.objects.story.mcpServers['portable-tail-server']; }],
    ['phase template catalog', (candidate) => { delete candidate.objects.story.templates['extra-note-template']; }],
    ['phase artifact set', (candidate) => { delete candidate.objects.story.artifactSets['portable-extra-set']; }]
  ];
  for (const [label, remove] of removals) {
    const candidate = structuredClone(bundle); remove(candidate); candidate.bundleSha256 = bundleDigest(candidate);
    await assert.rejects(() => planWorkflowImport(f.target, candidate),
      (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING', label);
    assert.deepEqual(await readFile(path.join(f.target, 'singularity/workflow.yml')), before);
  }
});

test('v3 dependency closure never treats inherited constructor keys as retained declarations before target writes', async (t) => {
  const f = await mcpClosureFixture(t);
  const bundle = await exportWorkflowBundle(f.source, ['story:portable-mcp-feature']);
  assert.equal(bundle.schemaVersion, 3);
  for (const catalog of ['workTypes', 'phases', 'mcpServers', 'artifactSets', 'templates']) {
    assert.equal(Object.hasOwn(bundle.objects.story[catalog], 'constructor'), false);
    assert.equal(typeof bundle.objects.story[catalog].constructor, 'function', 'the ordinary object still has the inherited key');
  }
  const defaultAgentContent = `---\n${YAML.stringify({
    name: 'constructor-producer', description: 'Exact parsed role binding used to probe closure admission', tools: [],
    metadata: { 'sflow-phases': 'constructor', 'sflow-default-for': 'constructor' }
  })}---\nOnly describe the claimed phase; never execute or approve it.\n`;
  const parsedDefaultAgent = parseAgentDependencies(defaultAgentContent, {
    source: '.github/agents/constructor-producer.agent.md', agentId: 'constructor-producer'
  });
  assert.deepEqual(parsedDefaultAgent.phases, ['constructor']);
  assert.deepEqual(parsedDefaultAgent.defaultFor, ['constructor'], 'a missing default role must not mask the inherited phase lookup');
  const before = await repositoryFilesSnapshot(f.target);
  const mutations = [
    ['workflow', (candidate) => { candidate.workflows[0].id = 'constructor'; }],
    ['phase with a correctly parsed default agent', (candidate) => {
      candidate.objects.story.workTypes['portable-mcp-feature'].phases.push('constructor');
      candidate.workflows[0].definitionSha256 = objectDigest(candidate.objects.story.workTypes['portable-mcp-feature']);
      candidate.assets.push({
        kind: 'agent', id: 'constructor-producer', path: '.github/agents/constructor-producer.agent.md',
        mediaType: 'text/markdown; charset=utf-8', content: defaultAgentContent,
        size: Buffer.byteLength(defaultAgentContent, 'utf8'), sha256: `sha256:${sha256(defaultAgentContent)}`
      });
    }],
    ['MCP server', (candidate) => { candidate.objects.story.phases['portable-note'].mcp = { requiredServers: ['constructor'] }; }],
    ['artifact set', (candidate) => { candidate.objects.story.phases['portable-note'].artifactSet = 'constructor'; }],
    ['template catalog entry', (candidate) => { candidate.objects.story.phases['portable-note'].defaultTemplate = 'template:constructor'; }]
  ];
  for (const [label, mutate] of mutations) {
    const candidate = structuredClone(bundle); mutate(candidate); candidate.bundleSha256 = bundleDigest(candidate);
    await assert.rejects(() => planWorkflowImport(f.target, candidate),
      (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING' && /constructor/.test(error.message), label);
    assert.deepEqual(await repositoryFilesSnapshot(f.target), before, `${label} refusal must precede every target write`);
  }
});

test('own declarations named constructor remain valid workflow phase MCP artifact and template dependencies', async (t) => {
  const f = await mcpClosureFixture(t);
  const targetBefore = await workflowConfiguration(f.target);
  const targetDefinition = await loadDefinition(f.target);
  assert.throws(() => resolveWorkType(targetDefinition, 'constructor'),
    (error) => error.name === 'SingularityFlowError'
      && error.toJSON().message === "Unknown work type 'constructor'.", 'an inherited work type must report the structured unknown-work-type error');
  // Keep the stock profiles and ordinary empty override maps: inherited constructor values
  // in any of those maps must neither invalidate nor replace this own phase declaration.
  f.configuration.workTypes.constructor = {
    label: 'Own constructor workflow', phases: ['intake', 'constructor'], phaseOverrides: {}, templateOverrides: {}
  };
  assert.equal(Object.hasOwn(f.configuration.workTypes.constructor.phaseOverrides, 'constructor'), false);
  assert.equal(typeof f.configuration.workTypes.constructor.phaseOverrides.constructor, 'function');
  assert.equal(Object.hasOwn(f.configuration.workTypes.constructor.templateOverrides, 'constructor'), false);
  assert.equal(typeof f.configuration.workTypes.constructor.templateOverrides.constructor, 'function');
  f.configuration.phases.constructor = structuredClone(f.configuration.phases['portable-note']);
  f.configuration.phases.constructor.label = 'Own constructor phase';
  f.configuration.phases.constructor.artifact.path = 'artifacts/constructor/output.md';
  f.configuration.phases.constructor.artifactSet = 'constructor';
  f.configuration.phases.constructor.defaultTemplate = 'template:constructor';
  f.configuration.phases.constructor.mcp = { requiredServers: ['constructor'] };
  f.configuration.templates.constructor = { path: 'portable-mcp/constructor.md', label: 'Own constructor template' };
  f.configuration.artifactSets.constructor = {
    primary: 'output.md', members: [{ path: 'output.md', role: 'findings', required: true }]
  };
  f.configuration.mcpServers.constructor = {
    hostReference: 'constructor', agents: ['constructor-producer'], phases: ['constructor'], tools: ['inspect'],
    required: false, approval: 'confirm', evidence: { captureToolCalls: true, captureResults: false }
  };
  await writeFile(path.join(f.source, f.configuration.templatesRoot, 'portable-mcp/constructor.md'), '# Own declaration\n\n## Findings\n');
  await writeFile(path.join(f.source, '.github/agents/constructor-producer.agent.md'), `---\n${YAML.stringify({
    name: 'constructor-producer', description: 'Reviewed role for the own constructor phase', tools: ['constructor/inspect'],
    metadata: { 'sflow-phases': 'constructor', 'sflow-default-for': 'constructor', 'sflow-world-model-views': 'architecture' }
  })}---\nProduce only the selected artifact without granting approvals or host access.\n`);
  await writeWorkflowConfiguration(f.source, f.configuration);
  await loadDefinition(f.source);
  const bundle = await exportWorkflowBundle(f.source, ['story:constructor']);
  for (const catalog of ['workTypes', 'phases', 'mcpServers', 'artifactSets', 'templates']) {
    assert.equal(Object.hasOwn(bundle.objects.story[catalog], 'constructor'), true, catalog);
    assert.deepEqual(bundle.objects.story[catalog].constructor, f.configuration[catalog].constructor);
  }
  const plan = await planWorkflowImport(f.target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(f.target, bundle, { expectedPlanSha256: plan.planSha256 });
  const imported = await loadDefinition(f.target);
  assert.equal(Object.hasOwn(imported.phases, 'constructor'), true);
  assert.equal(imported.mcpServers.constructor.approval, 'confirm');
  assert.deepEqual(imported.workTypes.constructor.phases, ['intake', 'constructor']);
  const resolved = resolveWorkType(imported, 'constructor');
  assert.deepEqual(resolved.phases.map((phase) => phase.id), ['intake', 'constructor']);
  const phase = resolved.phases.find((candidate) => candidate.id === 'constructor');
  assert.equal(phase.label, 'Own constructor phase');
  assert.equal(phase.template, 'portable-mcp/constructor.md');
  assert.equal(phase.artifact.path, 'artifacts/constructor/output.md');
  assert.equal(phase.artifactSet, 'constructor');
  assert.equal(phase.writeScope, 'artifact-only');
  assert.equal(phase.defaultAgent, 'constructor-producer');
  assert.equal(phase.generation.defaultProducer, 'human');
  assert.equal(phase.generation.task, 'analyze');
  assert.deepEqual(phase.mcp.requiredServers, ['constructor']);
  assert.equal(phase.inputs[0].path, f.configuration.phases.intake.artifact.path);
  assert.deepEqual((await workflowConfiguration(f.target)).workTypes.feature, targetBefore.workTypes.feature,
    'adding the own constructor workflow must leave the stock workflow declarations unchanged');
  assert.deepEqual(resolveWorkType(imported, 'feature').phases.map((candidate) => candidate.id),
    targetBefore.workTypes.feature.phases);
});

test('workflow export excludes an unreferenced globally applicable MCP declaration rather than copying the whole host catalog', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-global-mcp-source-');
  const configuration = await workflowConfiguration(source);
  configuration.mcpServers['unassigned-global-server'] = {
    hostReference: 'unassigned-global-server', agents: [], phases: [], tools: ['inspect'],
    required: false, approval: 'confirm', evidence: { captureToolCalls: true, captureResults: false }
  };
  await writeWorkflowConfiguration(source, configuration);
  for (const agent of await discoverAgents(source)) {
    const file = path.join(source, '.github/agents', `${agent.id}.agent.md`);
    const content = agent.text;
    const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    assert.ok(frontMatter);
    const metadata = YAML.parse(frontMatter[1]);
    metadata.tools = [...metadata.tools, 'unassigned-global-server/inspect'];
    await writeFile(file, `---\n${YAML.stringify(metadata)}---\n${content.slice(frontMatter[0].length)}`);
  }
  const validated = await loadDefinition(source);
  assert.ok(mcpServersForContext(validated, { agent: 'developer', phase: 'implementation' })
    .some((server) => server.id === 'unassigned-global-server'));
  const bundle = await exportWorkflowBundle(source, ['story:feature']);
  assert.equal(Object.hasOwn(bundle.objects.story.mcpServers, 'unassigned-global-server'), false);
  assert.equal((await planWorkflowImport(source, bundle)).status, 'ready');
  const extra = structuredClone(bundle);
  extra.objects.story.mcpServers['unassigned-global-server'] = configuration.mcpServers['unassigned-global-server'];
  extra.bundleSha256 = bundleDigest(extra);
  await assert.rejects(() => planWorkflowImport(source, extra),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
});

test('historical v1 and v2 bundles retain their one-pass MCP scope and original identity while v3 requires complete scope dependencies', async (t) => {
  const f = await mcpClosureFixture(t);
  f.configuration.workTypes['historical-mcp'] = {
    label: 'Historical MCP sample', phases: ['intake', 'portable-note']
  };
  f.configuration.phases['portable-note'].mcp = { requiredServers: ['portable-agent-server'] };
  f.configuration.mcpServers['portable-agent-server'].phases = ['portable-note', 'unrelated-note'];
  f.configuration.mcpServers['portable-agent-server'].agents = ['portable-producer', 'unrelated-owner'];
  await writeFile(path.join(f.source, '.github/agents/unrelated-owner.agent.md'), `---\n${YAML.stringify({
    name: 'unrelated-owner', description: 'Shared historical MCP scope role',
    tools: ['unrelated-server/inspect', 'portable-agent-server/inspect'],
    metadata: { 'sflow-phases': 'unrelated-note', 'sflow-default-for': 'unrelated-note', 'sflow-world-model-views': 'architecture' }
  })}---\nRead the approved shared scope without granting access or running tools.\n`);
  await writeWorkflowConfiguration(f.source, f.configuration);
  await loadDefinition(f.source);
  const complete = await exportWorkflowBundle(f.source, ['story:historical-mcp']);
  assert.equal(complete.schemaVersion, 3);
  assert.ok(complete.objects.story.phases['unrelated-note']);
  assert.ok(complete.objects.story.mcpServers['unrelated-server']);

  // Historic export retained the exact shared row and its assigned Agent Markdown, but did not
  // follow the row's other phase or the assigned agent's additional MCP rows. Derive only that
  // bounded, pre-v3 inventory: no missing bytes, source approval or dependency proof is invented.
  const historical = structuredClone(complete);
  delete historical.objects.story.phases['unrelated-note'];
  delete historical.objects.story.templates['unrelated-note-template'];
  delete historical.objects.story.mcpServers['unrelated-server'];
  historical.assets = historical.assets.filter((asset) => asset.kind !== 'template'
    || asset.reference !== 'template:unrelated-note-template');
  assert.ok(historical.assets.some((asset) => asset.kind === 'agent' && asset.id === 'unrelated-owner'));
  assert.deepEqual(historical.objects.story.mcpServers['portable-agent-server'],
    f.configuration.mcpServers['portable-agent-server'], 'historic server scope must not be narrowed');
  const sourceBefore = await readFile(path.join(f.source, 'singularity/workflow.yml'));
  for (const version of [1, 2]) {
    const stored = structuredClone(historical);
    stored.schemaVersion = version;
    if (version === 1) { delete stored.skillPackages; delete stored.semantics; }
    stored.bundleSha256 = bundleDigest(stored);
    const bytes = Buffer.from(`${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    const file = path.join(f.source, `historical-mcp-v${version}.json`);
    await writeFile(file, bytes);
    const read = await readWorkflowBundle(file);
    assert.deepEqual(read, stored, 'reading must not project or reseal the stored record');
    assert.equal(read.schemaVersion, version);
    assert.equal(read.bundleSha256, stored.bundleSha256);
    assert.equal(Object.hasOwn(read.objects.story.phases, 'unrelated-note'), false);
    const plan = await planWorkflowImport(f.source, file);
    assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
    assert.equal(plan.bundleSha256, stored.bundleSha256);
    assert.equal(plan.added.length, 0, 'the full source already contains every historical retained object');
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readFile(path.join(f.source, 'singularity/workflow.yml')), sourceBefore);
  }
  const strict = structuredClone(historical);
  strict.schemaVersion = 3;
  strict.bundleSha256 = bundleDigest(strict);
  await assert.rejects(() => planWorkflowImport(f.source, strict),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'
      && /unrelated-note/.test(error.message));
  assert.deepEqual(await readFile(path.join(f.source, 'singularity/workflow.yml')), sourceBefore);
});

test('workflow bundle v1 cannot acquire skill authority through a self-rehashed binding', async (t) => {
  const source = await initializedRepository(t, 'sflow-skp-transfer-source-');
  const historicalSource = await workflowConfiguration(source);
  historicalSource.mcpServers = {};
  await writeWorkflowConfiguration(source, historicalSource);
  const bundle = await exportWorkflowBundle(source, ['story:feature']);

  // An imported or hand-authored v1 bundle must not appear portable merely because its
  // phase binding and outer bundle digest are internally consistent.
  const incomplete = structuredClone(bundle);
  incomplete.schemaVersion = 1;
  delete incomplete.skillPackages;
  delete incomplete.semantics;
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
  overridden.schemaVersion = 1;
  delete overridden.skillPackages;
  delete overridden.semantics;
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
    (error) => error.code === 'SKP_PHASE_BINDING_INVALID'
  );

  const configuration = await workflowConfiguration(source);
  configuration.phases.implementation = incomplete.objects.story.phases.implementation;
  await writeWorkflowConfiguration(source, configuration);
  await assert.rejects(
    () => exportWorkflowBundle(source, ['story:feature']),
    (error) => error.code === 'SKP_PHASE_BINDING_INVALID'
  );
});

test('workflow bundles support Initiative-only and mixed Story/Initiative selections', async (t) => {
  const source = await initializedRepository(t, 'sflow-workflow-initiative-source-');
  const target = await initializedRepository(t, 'sflow-workflow-initiative-target-');
  const storyAuthorityTarget = await initializedRepository(t, 'sflow-workflow-story-authority-target-');
  const initiativeAuthorityTarget = await initializedRepository(t, 'sflow-workflow-initiative-authority-target-');
  const isolatedSource = await workflowConfiguration(source);
  isolatedSource.mcpServers = {};
  await writeWorkflowConfiguration(source, isolatedSource);
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

test('Initiative shared-agent MCP scope retains auxiliary Story phases in the Story namespace with their full dependencies', async (t) => {
  const f = await mcpClosureFixture(t, { transitive: true });
  const portfolio = await portfolioConfiguration(f.source);
  portfolio.initiativePhases['extra-note'] = structuredClone(portfolio.initiativePhases['epic-intake']);
  portfolio.initiativePhases['extra-note'].label = 'Same-named Initiative intake';
  portfolio.initiativePhases['extra-note'].agents = ['initiative-shared-owner'];
  portfolio.initiativeProfiles['portable-initiative'] = {
    label: 'Portable shared-agent initiative', lifecycleMode: 'planning-only', phases: ['extra-note']
  };
  await writePortfolioConfiguration(f.source, portfolio);
  await writeFile(path.join(f.source, '.github/agents/initiative-shared-owner.agent.md'), `---\n${YAML.stringify({
    name: 'initiative-shared-owner', description: 'Shared Initiative and MCP-scoped Story role',
    tools: ['initiative-shared-server/inspect']
  })}---\nRead the exact approved Initiative inputs without approving or running anything.\n`);
  await loadDefinition(f.source);
  const namespaceOnly = await exportWorkflowBundle(f.source, ['initiative:portable-initiative']);
  assert.deepEqual(namespaceOnly.objects.story.phases, {},
    'a same-named Initiative phase must not select the Story default agent or its MCP graph');
  assert.equal(namespaceOnly.assets.some((asset) => asset.kind === 'agent' && asset.id === 'extra-owner'), false);
  const defaultAgentContent = await readFile(path.join(f.source, '.github/agents/extra-owner.agent.md'), 'utf8');
  const wrongNamespace = structuredClone(namespaceOnly);
  wrongNamespace.assets.push({
    kind: 'agent', id: 'extra-owner', path: '.github/agents/extra-owner.agent.md',
    mediaType: 'text/markdown; charset=utf-8', content: defaultAgentContent,
    size: Buffer.byteLength(defaultAgentContent, 'utf8'), sha256: `sha256:${sha256(defaultAgentContent)}`
  });
  wrongNamespace.requirements.worldModelViews = [...new Set([
    ...wrongNamespace.requirements.worldModelViews, 'architecture'
  ])].sort();
  wrongNamespace.bundleSha256 = bundleDigest(wrongNamespace);
  await assert.rejects(() => planWorkflowImport(f.source, wrongNamespace),
    (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA',
    'the reader must not treat a same-named Story default role as an Initiative dependency');
  f.configuration.mcpServers['initiative-shared-server'] = {
    hostReference: 'initiative-shared-server', agents: ['initiative-shared-owner'], phases: ['extra-note'],
    tools: ['inspect'], required: false, approval: 'confirm',
    evidence: { captureToolCalls: true, captureResults: false }
  };
  await writeWorkflowConfiguration(f.source, f.configuration);
  await loadDefinition(f.source);

  const bundle = await exportWorkflowBundle(f.source, ['initiative:portable-initiative']);
  assert.deepEqual(bundle.workflows.map((workflow) => `${workflow.governs}:${workflow.id}`),
    ['initiative:portable-initiative']);
  assert.deepEqual(bundle.objects.story.workTypes, {}, 'auxiliary phases must not select a Story workflow');
  assert.deepEqual(bundle.objects.initiative.initiativePhases['extra-note'], portfolio.initiativePhases['extra-note']);
  assert.deepEqual(bundle.objects.story.phases['extra-note'], f.configuration.phases['extra-note']);
  assert.notDeepEqual(bundle.objects.story.phases['extra-note'], bundle.objects.initiative.initiativePhases['extra-note']);
  assert.deepEqual(bundle.objects.story.mcpServers['initiative-shared-server'],
    f.configuration.mcpServers['initiative-shared-server']);
  assert.ok(bundle.objects.story.phases['tail-note'] && bundle.objects.story.phases['portable-note']);
  assert.deepEqual(bundle.objects.story.artifactSets['portable-extra-set'], f.configuration.artifactSets['portable-extra-set']);
  assert.ok(Object.hasOwn(bundle.objects.story.approvalAuthorities, 'engineering-reviewers'));
  assert.equal(bundle.requirements.templateRoots.story, f.configuration.templatesRoot);
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'extra-owner'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template' && asset.governs === 'story'
    && asset.reference === 'template:extra-note-template'));
  assert.equal(Object.hasOwn(bundle.objects.story.mcpServers, 'unrelated-server'), false);
  const plan = await planWorkflowImport(f.target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(f.target, bundle, { expectedPlanSha256: plan.planSha256 });
  const imported = await loadDefinition(f.target);
  const importedPortfolio = await portfolioConfiguration(f.target);
  assert.equal(imported.phases['extra-note'].label, 'extra-note');
  assert.equal(importedPortfolio.initiativePhases['extra-note'].label, 'Same-named Initiative intake');
  assert.deepEqual(imported.mcpServers['initiative-shared-server'].phases, ['extra-note']);
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
  future.schemaVersion = WORKFLOW_BUNDLE_SCHEMA_VERSION + 1;
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
  const workflow = await workflowConfiguration(source);
  const portfolio = await portfolioConfiguration(source);
  const extraPhaseId = 'unrelated-private-phase';
  const extraAuthorityId = 'unrelated-private-reviewers';
  workflow.approvalAuthorities[extraAuthorityId] = {
    label: 'Disconnected private review group', allowAnyGitIdentity: false, members: []
  };
  workflow.phases[extraPhaseId] = structuredClone(workflow.phases.intake);
  workflow.phases[extraPhaseId].artifact.path = 'artifacts/unrelated-private.md';
  workflow.phases[extraPhaseId].approval.authorities = [extraAuthorityId];
  await writeWorkflowConfiguration(source, workflow);
  const agentContent = `---\n${YAML.stringify({
    name: 'unrelated-private-owner', description: 'Disconnected private role', tools: [],
    metadata: { 'sflow-phases': extraPhaseId, 'sflow-default-for': extraPhaseId }
  })}---\nOnly handle the disconnected private phase.\n`;
  const extraAgent = {
    kind: 'agent', id: 'unrelated-private-owner', path: '.github/agents/unrelated-private-owner.agent.md',
    mediaType: 'text/markdown; charset=utf-8', content: agentContent,
    size: Buffer.byteLength(agentContent, 'utf8'), sha256: `sha256:${sha256(agentContent)}`
  };
  await writeFile(path.join(source, extraAgent.path), agentContent);
  await loadDefinition(source);
  const bundle = await exportWorkflowBundle(source, ['story:feature']);
  assert.equal(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === extraAgent.id), false);
  assert.equal(Object.hasOwn(bundle.objects.story.phases, extraPhaseId), false);
  assert.equal(Object.hasOwn(bundle.objects.story.approvalAuthorities, extraAuthorityId), false);
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
  configuration.mcpServers['portable-template-server'] = {
    hostReference: 'portable-template-server', agents: ['portable-owner'], phases: [], tools: ['inspect'],
    required: false, approval: 'confirm', evidence: { captureToolCalls: true, captureResults: false }
  };
  await writeWorkflowConfiguration(source, configuration);
  await mkdir(path.join(source, 'singularity/templates/portable'), { recursive: true });
  await writeFile(path.join(source, 'singularity/templates/portable/intake.md'), '# Portable intake\n');

  const agent = `---
name: portable-owner
description: Supplies the locked portable intake template
tools: [portable-template-server/inspect]
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

  await loadDefinition(source);
  const bundle = await exportWorkflowBundle(source, ['portable-feature']);
  assert.deepEqual(bundle.objects.story.templates['portable-intake'], {
    path: 'portable/intake.md', label: 'Portable intake', kind: 'requirements'
  });
  assert.ok(bundle.assets.some((asset) => asset.kind === 'template'
    && asset.reference === 'template:portable-intake'
    && asset.rootRelative === 'portable/intake.md'));
  assert.ok(bundle.assets.some((asset) => asset.kind === 'agent' && asset.id === 'portable-owner'));
  assert.deepEqual(bundle.objects.story.mcpServers['portable-template-server'],
    configuration.mcpServers['portable-template-server'], 'an agent referenced only by a template still brings its MCP declaration');
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
  agentAsset.content = agentAsset.content.replace('tools: [portable-template-server/inspect]',
    'tools: [portable-template-server/inspect]\nmetadata:\n  sflow-phases: missing-phase');
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
  const exported = await exportWorkflowBundle(root, ['story:feature']);
  const dependencyPhases = Object.keys(exported.objects.story.phases).sort();
  const plan = await planWorkflowCopy(root, {
    sourceId: 'feature', targetId: 'feature-team', label: 'Feature — Team'
  });

  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.changedPaths, ['singularity/workflow.yml']);
  assert.equal(plan.sharedDependencies.linked, true);
  assert.equal(plan.sharedDependencies.phases, dependencyPhases.length);
  assert.deepEqual(plan.added, [{ kind: 'story.workflow', id: 'feature-team' }]);
  assert.deepEqual(plan.reused.filter((item) => item.kind === 'story.phase').map((item) => item.id),
    dependencyPhases);

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
