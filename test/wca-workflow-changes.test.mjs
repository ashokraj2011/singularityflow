import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import YAML from 'yaml';
import { parseAgentDependencies } from '../src/agents.mjs';
import { planWorkflowOnlyChanges, workflowDefinitionSha256, WCA_WORKFLOW_CHANGE_LIMITS } from '../src/wca-workflow-changes.mjs';
import { recordSha256 } from '../src/records.mjs';

function fixture() {
  const phase = (id) => ({ label: id, inputs: [], defaultTemplate: 'template:common',
    approval: { mode: 'none' }, generation: { task: 'analyze', defaultProducer: 'human' } });
  const approvedDefinition = { version: 2, templatesRoot: 'singularity/templates',
    worldModel: { views: ['architecture', 'development'] },
    phases: { intake: phase('intake'), analyze: phase('analyze'), conformance: phase('conformance') },
    templates: { common: { path: 'common/empty.md', label: 'Common template' } },
    approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } },
    workTypes: {
      baseline: { label: 'Baseline', description: 'Original', phases: ['intake', 'analyze', 'conformance'],
        plannedClaims: { mode: 'off' }, reworkLoops: [],
        intelligence: { profile: 'strict', views: ['architecture'] },
        templateOverrides: { analyze: 'template:common' },
        phaseOverrides: { analyze: { approval: { mode: 'required', authorities: ['reviewers'], minimum: 1 } } },
        retainedExtra: { exact: ['keep', { future: true }] } },
      sibling: { label: 'Sibling', phases: ['intake', 'analyze', 'conformance'] }
    } };
  approvedDefinition.phases.analyze.inputs = ['intake'];
  approvedDefinition.phases.conformance.inputs = ['analyze'];
  const agents = [{ id: 'writer', scope: 'repository', source: '.github/agents/writer.agent.md', file: '/temporary/authority/writer.agent.md',
    text: '# Exact author role\n', phases: ['analyze'], defaultFor: ['analyze'], tools: [], worldModelViews: ['development'], dependencies: [] }];
  const request = { schema: 'sflow-workflow-request@2', intent: 'edit', id: 'change-package', label: 'Change package',
    target: { governs: 'story', authority: 'selected-repository' },
    changes: [{ kind: 'workflow', id: 'baseline', operation: 'edit', expectedDefinitionSha256: workflowDefinitionSha256(approvedDefinition.workTypes.baseline) }],
    definitions: { workflows: [{ id: 'baseline', label: 'Reviewed label' }] } };
  return { approvedDefinition, request, agents };
}
function refusal(input, code) {
  const result = planWorkflowOnlyChanges(input);
  assert.equal(result.status, 'blocked'); assert.equal(result.findings[0].code, code);
  assert.deepEqual(result.replacements, []); assert.deepEqual(result.dependencyLocks, []);
  assert.deepEqual(result.graph, { nodes: [], edges: [] }); return result;
}
function node(result, kind, id) { return result.graph.nodes.find((entry) => entry.kind === kind && entry.id === id); }

test('exact raw parent identity is stable and omitted workflow fields survive an inert edit', () => {
  const input = fixture(); const before = structuredClone(input); const result = planWorkflowOnlyChanges(input);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.findings, []);
  const replacement = result.replacements[0];
  assert.deepEqual(replacement.definition, { ...before.approvedDefinition.workTypes.baseline, label: 'Reviewed label' });
  assert.equal(replacement.expectedDefinitionSha256, workflowDefinitionSha256(before.approvedDefinition.workTypes.baseline));
  assert.equal(replacement.beforeDefinitionSha256, replacement.expectedDefinitionSha256);
  assert.equal(replacement.afterDefinitionSha256, workflowDefinitionSha256(replacement.definition));
  assert.deepEqual(replacement.policyRelevantFields, []);
  assert.deepEqual(input, before); assert.equal(Object.isFrozen(replacement.definition.retainedExtra.exact), true);
  assert.equal(result.impact.retainedStories, 'unchanged-not-inventoried');
  assert.equal(result.impact.otherRepositories, 'unknown-not-inventoried');
  assert.equal(result.impact.sharedDefinitions, 'unchanged');
  assert.equal(result.impact.permissions, 'not-granted'); assert.equal(result.impact.execution, 'not-run');
  assert.equal(result.impact.activation, 'inactive');
  const { planSha256, ...core } = result; assert.equal(planSha256, `sha256:${recordSha256(core)}`);
  assert.equal(workflowDefinitionSha256({ b: 2, a: 1 }), workflowDefinitionSha256({ a: 1, b: 2 }));
  assert.notEqual(workflowDefinitionSha256({ label: 'X', phases: ['intake'] }), workflowDefinitionSha256({ label: 'X', phases: ['intake'], plannedClaims: { mode: 'off' } }));
});

test('linked fork selects a new workflow identity while exposing existing direct dependents', () => {
  const input = fixture(); input.request.intent = 'fork';
  input.request.changes[0] = { ...input.request.changes[0], id: 'new-workflow', operation: 'fork', sourceId: 'baseline' };
  input.request.definitions.workflows[0] = { id: 'new-workflow', description: 'A linked fork' };
  const result = planWorkflowOnlyChanges(input); assert.equal(result.status, 'ready');
  assert.equal(result.replacements[0].sourceId, 'baseline'); assert.equal(result.replacements[0].beforeDefinitionSha256, null);
  assert.equal(result.replacements[0].dependencyMaterialization, 'linked-no-shared-object-change');
  assert.equal(result.replacements[0].definition.label, 'Baseline');
  assert.ok(node(result, 'candidate-workflow', 'new-workflow')); assert.ok(node(result, 'agent', 'writer'));
  const shared = result.impact.sharedDependencies.find((entry) => entry.kind === 'phase' && entry.id === 'analyze');
  assert.ok(shared.directDependents.some((entry) => entry.kind === 'workflow' && entry.id === 'baseline'));
  assert.ok(shared.directDependents.some((entry) => entry.kind === 'workflow' && entry.id === 'sibling'));
  assert.ok(shared.directDependents.some((entry) => entry.kind === 'phase' && entry.id === 'conformance'));
  assert.ok(result.graph.edges.some((entry) => entry.from === 'candidate-workflow:new-workflow' && entry.to === 'phase:analyze'));
  assert.equal(input.approvedDefinition.workTypes['new-workflow'], undefined);
});

test('explicit phase selection is catalog-only and ordered; the ordinary validator still owns readiness', () => {
  const input = fixture(); input.request.definitions.workflows[0].phases = ['intake', { source: 'catalog', kind: 'phase', id: 'conformance' }];
  const result = planWorkflowOnlyChanges(input); assert.equal(result.status, 'ready');
  assert.deepEqual(result.replacements[0].definition.phases, ['intake', 'conformance']);
  assert.deepEqual(result.replacements[0].policyRelevantFields, ['phases']);
  // Missing an earlier producer is not quietly removed from the impact graph, nor validated here.
  assert.ok(node(result, 'phase', 'analyze'));
  input.request.definitions.workflows[0].phases = ['intake', { ref: { source: 'catalog', kind: 'phase', id: 'conformance' } }];
  assert.equal(planWorkflowOnlyChanges(input).planSha256, result.planSha256, 'the existing compiler ref wrapper has the same exact catalog identity');
  input.request.definitions.workflows[0].phases = [{ source: 'candidate', kind: 'phase', id: 'analyze' }];
  refusal(input, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED');
  input.request.definitions.workflows[0].phases = ['not-installed']; refusal(input, 'WCA_CHANGE_PHASE_UNAVAILABLE');
  input.request.definitions.workflows[0].phases = ['intake', 'intake']; refusal(input, 'WCA_CHANGE_INVALID');
});

test('changed or missing exact parents cannot be replaced, and hash objects are not coerced', () => {
  const input = fixture(); input.approvedDefinition.workTypes.baseline.retainedExtra.exact.push('new-parent');
  refusal(input, 'WCA_CHANGE_PARENT_STALE');
  delete input.request.changes[0].expectedDefinitionSha256; refusal(input, 'WCA_CHANGE_PARENT_STALE');
  input.request.changes[0].expectedDefinitionSha256 = { value: workflowDefinitionSha256(input.approvedDefinition.workTypes.baseline) };
  refusal(input, 'WCA_CHANGE_PARENT_STALE');
});

test('change and patch rows are closed, paired and explicit with no deletes or shared-object updates', () => {
  for (const change of [
    { kind: 'phase', id: 'analyze', operation: 'edit', expectedDefinitionSha256: `sha256:${'0'.repeat(64)}` },
    { kind: 'workflow', id: 'baseline', operation: 'delete', expectedDefinitionSha256: `sha256:${'0'.repeat(64)}` }
  ]) { const input = fixture(); input.request.changes = [change]; refusal(input, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED'); }
  let input = fixture(); input.request.changes[0].delete = false; refusal(input, 'WCA_CHANGE_INVALID');
  input = fixture(); input.request.definitions.workflows[0].phaseOverrides = {}; refusal(input, 'WCA_CHANGE_INVALID');
  input = fixture(); input.request.definitions.workflows[0].id = 'orphan'; refusal(input, 'WCA_CHANGE_INVALID');
  for (const group of ['phases', 'agents', 'skills', 'templates']) {
    input = fixture(); input.request.definitions[group] = [{ id: 'new-shared-object' }]; refusal(input, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED');
  }
  for (const name of ['assets', 'executionProposals']) {
    input = fixture(); input.request[name] = [{ path: 'ignored.md' }]; refusal(input, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED');
  }
});

test('forks require a new nonprivileged ID and an existing explicitly named source', () => {
  const input = fixture(); input.request.intent = 'fork'; input.request.changes[0].operation = 'fork';
  input.request.changes[0].sourceId = 'baseline'; refusal(input, 'WCA_CHANGE_TARGET_EXISTS');
  input.request.changes[0].id = 'sibling'; input.request.definitions.workflows[0].id = 'sibling'; refusal(input, 'WCA_CHANGE_TARGET_EXISTS');
  input.request.changes[0].id = 'fresh'; input.request.definitions.workflows[0].id = 'fresh'; input.request.changes[0].sourceId = 'absent';
  refusal(input, 'WCA_CHANGE_SOURCE_UNAVAILABLE');
  input.request.changes[0].sourceId = 'baseline'; input.request.changes[0].id = 'sf-admin'; input.request.definitions.workflows[0].id = 'sf-admin';
  refusal(input, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED');
});

test('unchanged SKP phase order is linked but any SKP membership/order change requires recompilation', () => {
  const input = fixture(); input.approvedDefinition.phases.analyze = { ...input.approvedDefinition.phases.analyze, kind: 'skill',
    skillBinding: { bindingRefs: { skill: { id: 'team-analysis', packageSha256: `sha256:${'a'.repeat(64)}` }, inputs: [{ phase: 'intake' }] } } };
  assert.equal(planWorkflowOnlyChanges(input).status, 'ready');
  assert.ok(node(planWorkflowOnlyChanges(input), 'skill-package', `team-analysis/sha256:${'a'.repeat(64)}`));
  for (const phases of [['intake', 'conformance', 'analyze'], ['intake', 'conformance'], ['analyze', 'conformance']]) {
    input.request.definitions.workflows[0].phases = phases; refusal(input, 'WCA_CHANGE_SKP_RECOMPILE_REQUIRED');
  }
  input.request.definitions.workflows[0].phases = ['intake', 'analyze', 'conformance'];
  input.request.intent = 'fork'; input.request.changes[0] = { ...input.request.changes[0], id: 'linked-skp', operation: 'fork', sourceId: 'baseline' };
  input.request.definitions.workflows[0].id = 'linked-skp'; assert.equal(planWorkflowOnlyChanges(input).status, 'ready');
});

test('the full declared closure includes auxiliary MCP scope, outputs, sets, views, agents and inert checks', () => {
  const input = fixture(); const definition = input.approvedDefinition;
  definition.phases.auxiliary = { label: 'Auxiliary', inputs: ['intake'], defaultTemplate: 'common/auxiliary.md',
    artifactSet: 'deliverables', worldModelViews: ['architecture'], qualityCommands: [{ id: 'quality', command: 'node', args: ['check.mjs'] }] };
  definition.artifactSets = { deliverables: { outputs: [{ id: 'report', template: 'common/report.md', consumes: ['analyze/note'] }] } };
  definition.phases.analyze.mcp = { requiredServers: ['knowledge'] };
  definition.mcpServers = { knowledge: { agents: ['writer', 'aux-writer'], phases: ['analyze', 'auxiliary'], tools: ['read'] } };
  input.agents[0].dependencies.push({ id: 'remote-note', type: 'skill', url: 'https://example.test/private-source', phases: ['analyze'], optional: true, maxBytes: 100 });
  input.agents.push({ id: 'aux-writer', scope: 'repository', text: '# Aux role\n', defaultFor: ['auxiliary'], phases: ['auxiliary'], dependencies: [] });
  const result = planWorkflowOnlyChanges(input); assert.equal(result.status, 'ready', JSON.stringify(result.findings));
  for (const [kind, id] of [['phase', 'auxiliary'], ['agent', 'aux-writer'], ['artifact-set', 'deliverables'],
    ['template-path', 'common/report.md'], ['quality-command', 'auxiliary/quality'], ['mcp-server', 'knowledge'],
    ['world-model-view', 'architecture'], ['world-model-view', 'development'], ['execution-task', 'analyze']]) assert.ok(node(result, kind, id), `${kind}:${id}`);
  const dependency = node(result, 'agent-dependency', 'writer/remote-note');
  assert.equal(dependency.availability, 'declared-not-fetched'); assert.equal(dependency.packageBinding, 'unbound');
  assert.equal(JSON.stringify(result).includes('https://example.test'), false);
  assert.equal(JSON.stringify(result).includes('reviewer@example.test'), false);
  assert.equal(JSON.stringify(result).includes('/temporary/authority'), false);
  assert.ok(result.graph.edges.some((edge) => edge.from === 'artifact-set:deliverables' && edge.to === 'phase:analyze' && edge.relation === 'output-input'));
});

test('candidate closure discloses existing default roles and exact hashes without temporary path identities', () => {
  const input = fixture(); const first = planWorkflowOnlyChanges(input);
  input.agents[0].file = '/different/private/authority/writer.agent.md'; input.agents[0].source = '/other/temporary/mount/writer.agent.md';
  assert.equal(planWorkflowOnlyChanges(input).planSha256, first.planSha256);
  input.agents[0].text += 'Changed role policy.\n'; assert.notEqual(planWorkflowOnlyChanges(input).planSha256, first.planSha256);
  const shared = first.impact.sharedDependencies.find((entry) => entry.kind === 'agent' && entry.id === 'writer');
  assert.ok(shared.directDependents.some((entry) => entry.kind === 'phase' && entry.id === 'analyze'));
});

test('unknown dependencies and ambiguous agent identities block the entire multi-change transaction', () => {
  const input = fixture(); input.request.changes.push({ kind: 'workflow', id: 'sibling', operation: 'edit', expectedDefinitionSha256: `sha256:${'f'.repeat(64)}` });
  input.request.definitions.workflows.push({ id: 'sibling', label: 'Sibling edit' });
  refusal(input, 'WCA_CHANGE_PARENT_STALE');
  const missing = fixture(); missing.approvedDefinition.phases.analyze.defaultTemplate = 'template:absent'; refusal(missing, 'WCA_CHANGE_DEPENDENCY_UNAVAILABLE');
  const ambiguous = fixture(); ambiguous.agents.push({ ...ambiguous.agents[0] }); refusal(ambiguous, 'WCA_CHANGE_DEPENDENCY_AMBIGUOUS');
  const noSkill = fixture(); noSkill.approvedDefinition.phases.analyze.kind = 'skill'; refusal(noSkill, 'WCA_CHANGE_DEPENDENCY_UNAVAILABLE');
});

test('bounds refuse full plans with no truncation, including a graph node or edge overflow', () => {
  let input = fixture();
  for (let i = 0; i < WCA_WORKFLOW_CHANGE_LIMITS.workflows; i += 1) input.approvedDefinition.workTypes[`extra-${i}`] = { label: 'Extra', phases: ['intake'] };
  refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); for (let i = 0; i < WCA_WORKFLOW_CHANGE_LIMITS.phases; i += 1) input.approvedDefinition.phases[`extra-${i}`] = { label: 'Extra', inputs: [] };
  refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); for (let i = 0; i < WCA_WORKFLOW_CHANGE_LIMITS.agents; i += 1) input.agents.push({ id: `extra-${i}` }); refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); for (let i = 0; i < 16; i += 1) {
    input.request.changes.push({ ...input.request.changes[0], id: `extra-${i}` }); input.request.definitions.workflows.push({ id: `extra-${i}` });
  } refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); for (let i = 0; i < 500; i += 1) input.approvedDefinition.phases[`extra-${i}`] = {
    label: 'Extra', qualityCommands: Array.from({ length: 8 }, (_, index) => ({ id: `check-${index}`, command: 'node' })) };
  refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); for (let i = 0; i < 64; i += 1) input.approvedDefinition.phases[`extra-${i}`] = { label: 'Extra' };
  const allPhases = Object.keys(input.approvedDefinition.phases);
  input.agents = Array.from({ length: 128 }, (_, index) => ({ id: `agent-${index}`, defaultFor: allPhases }));
  refusal(input, 'WCA_CHANGE_LIMIT');
});

test('cyclic, accessor, malformed UTF-8, depth and byte overflows are refusals, never implicit JSON migration', () => {
  let input = fixture(); input.request.loop = input.request; refusal(input, 'WCA_CHANGE_INVALID');
  input = fixture(); let reads = 0; Object.defineProperty(input.request, 'value', { enumerable: true, get() { reads += 1; return 'no'; } });
  refusal(input, 'WCA_CHANGE_INVALID'); assert.equal(reads, 0);
  input = fixture(); input.request.label = '\ud800'; refusal(input, 'WCA_CHANGE_INVALID');
  input = fixture(); let deep = {}; const first = deep; for (let i = 0; i < 33; i += 1) { deep.child = {}; deep = deep.child; }
  input.request.extra = first; refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); input.request.extra = 'x'.repeat(WCA_WORKFLOW_CHANGE_LIMITS.inputBytes); refusal(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); input.request.definitions.workflows[0].label = 'Injected\u001b[2J'; refusal(input, 'WCA_CHANGE_INVALID');
});

test('current packaged raw workflow, Agent Markdown, MCP scopes and legacy path templates retain owner shapes', async () => {
  const approvedDefinition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const agents = [];
  for (const name of await readdir(new URL('../templates/agents/', import.meta.url))) {
    if (!name.endsWith('.agent.md')) continue;
    const text = await readFile(new URL(`../templates/agents/${name}`, import.meta.url), 'utf8');
    agents.push({ ...parseAgentDependencies(text, { source: `templates/agents/${name}` }), text, scope: 'bundled' });
  }
  const original = structuredClone(approvedDefinition.workTypes.feature);
  const request = { intent: 'edit', changes: [{ kind: 'workflow', id: 'feature', operation: 'edit', expectedDefinitionSha256: workflowDefinitionSha256(original) }],
    definitions: { workflows: [{ id: 'feature', label: 'Exact reviewed feature' }] } };
  const result = planWorkflowOnlyChanges({ approvedDefinition, agents, request });
  assert.equal(result.status, 'ready', JSON.stringify(result.findings));
  assert.deepEqual(result.replacements[0].definition, { ...original, label: 'Exact reviewed feature' });
  assert.ok(node(result, 'template-path', 'common/intake.md'));
  assert.ok(node(result, 'agent', 'product-owner'));
  assert.equal(node(result, 'agent', 'product-owner').source, 'installed-agent-registry');
  for (const path of result.graph.nodes.filter((entry) => entry.kind === 'template-path')) assert.equal(path.availability, 'content-verified-by-compiler');
  assert.deepEqual(approvedDefinition.workTypes.feature, original);
  assert.equal(result.impact.coverage, 'declared-approved-graph-complete-within-bounds;content-and-runtime-readiness-owned-by-compiler');
});

test('prior packaged raw workTypes keep historical omissions, rework and policy instead of receiving current defaults', async () => {
  // The recorded historical fixture is a set of exact replaced catalog entries, not a full YAML.
  const approvedDefinition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const prior = YAML.parse(await readFile(new URL('./fixtures/packaged-workflow-prior-v2.yml', import.meta.url), 'utf8'));
  for (const [name, entries] of Object.entries(prior)) Object.assign(approvedDefinition[name], entries);
  const agents = [];
  const historicalNames = new Set(await readdir(new URL('./fixtures/packaged-agents/ba513/', import.meta.url)));
  for (const name of await readdir(new URL('../templates/agents/', import.meta.url))) {
    if (!name.endsWith('.agent.md')) continue;
    const text = await readFile(new URL(historicalNames.has(name) ? `./fixtures/packaged-agents/ba513/${name}` : `../templates/agents/${name}`, import.meta.url), 'utf8');
    agents.push({ ...parseAgentDependencies(text, { source: `.github/agents/${name}` }), text, scope: 'repository' });
  }
  const sourceId = 'classic-delivery'; const source = structuredClone(approvedDefinition.workTypes[sourceId]);
  const request = { intent: 'fork', changes: [{ kind: 'workflow', id: 'historical-linked', sourceId, operation: 'fork', expectedDefinitionSha256: workflowDefinitionSha256(source) }],
    definitions: { workflows: [{ id: 'historical-linked', description: 'Keep the exact historical source' }] } };
  const result = planWorkflowOnlyChanges({ approvedDefinition, agents, request });
  assert.equal(result.status, 'ready', JSON.stringify(result.findings));
  assert.deepEqual(result.replacements[0].definition, { ...source, description: 'Keep the exact historical source' });
  assert.equal(Object.hasOwn(result.replacements[0].definition, 'plannedClaims'), Object.hasOwn(source, 'plannedClaims'));
  assert.deepEqual(approvedDefinition.workTypes[sourceId], source);
  assert.ok(result.impact.sharedDependencies.find((entry) => entry.kind === 'phase' && entry.id === 'intake').directDependents.some((entry) => entry.kind === 'workflow' && entry.id === sourceId));
});

test('the aggregate output byte ceiling refuses a complete oversized graph rather than returning a partial disclosure', () => {
  const approvedDefinition = { workTypes: { baseline: { label: 'Baseline', phases: ['intake'] } },
    phases: { intake: { label: 'Intake', mcp: { requiredServers: ['knowledge'] } } },
    mcpServers: { knowledge: { phases: ['intake'], agents: [] } } };
  const agents = Array.from({ length: 180 }, (_, index) => ({ id: `agent-${index}-${'x'.repeat(50)}`,
    dependencies: Array.from({ length: 9 }, (_, dependency) => ({ id: `dependency-${dependency}-${'y'.repeat(48)}`, url: 'https://example.test/private' })) }));
  approvedDefinition.mcpServers.knowledge.agents = agents.map((agent) => agent.id);
  const request = { intent: 'edit', changes: [{ kind: 'workflow', id: 'baseline', operation: 'edit', expectedDefinitionSha256: workflowDefinitionSha256(approvedDefinition.workTypes.baseline) }],
    definitions: { workflows: [{ id: 'baseline', label: 'Reviewed baseline' }] } };
  // Fewer than 4096 nodes, 8192 edges, 256 agents, 100000 JSON nodes or 8 MiB input.
  // The repeated complete node/lock/consumer disclosure itself exceeds the output ceiling.
  refusal({ request, approvedDefinition, agents }, 'WCA_CHANGE_LIMIT');
  for (const [index, agent] of agents.entries()) {
    agent.id = `agent-${index}`;
    for (const [dependency, entry] of agent.dependencies.entries()) entry.id = `dependency-${dependency}`;
  }
  approvedDefinition.mcpServers.knowledge.agents = agents.map((agent) => agent.id);
  const result = planWorkflowOnlyChanges({ request, approvedDefinition, agents });
  assert.equal(result.status, 'ready', JSON.stringify(result.findings));
  assert.equal(result.graph.nodes.filter((entry) => entry.kind === 'agent-dependency').length, 180 * 9);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= WCA_WORKFLOW_CHANGE_LIMITS.outputBytes);
});
