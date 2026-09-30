import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import YAML from 'yaml';
import { parseAgentDependencies } from '../src/agents.mjs';
import { compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill, skillCandidateCatalogSha256,
  skillContractSha256, skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { recordSha256 } from '../src/records.mjs';
import { phaseDefinitionSha256, planSharedPhaseChanges, WCA_SHARED_PHASE_CHANGES_PROFILE,
  WCA_WORKFLOW_CHANGE_LIMITS } from '../src/wca-workflow-changes.mjs';

function fixture() {
  const phase = (id) => ({ label: id, artifact: { path: `artifacts/${id}.md`, minimumBytes: 1 },
    inputs: [], defaultTemplate: 'template:common', approval: { mode: 'none' },
    writeScope: 'artifact-only', generation: { task: 'analyze' }, qualityCommands: [] });
  const approvedDefinition = { version: 2, templatesRoot: 'singularity/templates',
    templates: { common: { path: 'common/empty.md' }, alternate: { path: 'common/alternate.md' } },
    phases: { intake: phase('Intake'), review: phase('Review'), auxiliary: phase('Auxiliary'), unrelated: phase('Unrelated') },
    approvalSecurity: { profile: 'team' },
    approvalAuthorities: { reviewers: { members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } },
    workTypes: { main: { label: 'Main', phases: ['intake', 'review'] },
      masked: { label: 'Masked', phases: ['intake'], phaseOverrides: { intake: { label: 'Pinned local label' } },
        templateOverrides: { intake: 'template:alternate' } },
      indirect: { label: 'Indirect', phases: ['auxiliary'] }, untouched: { label: 'Untouched', phases: ['unrelated'] } },
    mcpServers: { shared: { phases: ['intake', 'auxiliary'], agents: ['intake-role', 'auxiliary-role'], tools: [] } } };
  approvedDefinition.phases.review.inputs = ['intake'];
  approvedDefinition.phases.auxiliary.mcp = { requiredServers: ['shared'] };
  const agents = Object.keys(approvedDefinition.phases).map((id) => ({ id: `${id}-role`, scope: 'repository',
    text: `# Exact ${id} role\n`, phases: [id], defaultFor: [id],
    tools: ['intake', 'auxiliary'].includes(id) ? ['shared/*'] : [], worldModelViews: [], dependencies: [] }));
  agents.push({ id: 'support-role', scope: 'repository', text: '# Explicit support role\n',
    phases: ['intake'], defaultFor: [], tools: [], worldModelViews: [], dependencies: [] });
  const changes = [{ kind: 'phase', id: 'intake', operation: 'edit',
    expectedDefinitionSha256: phaseDefinitionSha256(approvedDefinition.phases.intake),
    replacement: { ...structuredClone(approvedDefinition.phases.intake), label: 'Reviewed shared intake' } }];
  return { approvedDefinition, agents, changes };
}
function blocked(input, code) {
  const result = planSharedPhaseChanges(input);
  assert.equal(result.status, 'blocked'); assert.equal(result.findings[0].code, code, JSON.stringify(result.findings));
  assert.deepEqual(result.replacements, []); assert.deepEqual(result.dependencyLocks, []);
  assert.deepEqual(result.graph.before, { nodes: [], edges: [] }); return result;
}

test('shared phase exact replacement discloses all reverse consumers and effective override masking without mutation', () => {
  const input = fixture(); const prior = structuredClone(input); const result = planSharedPhaseChanges(input);
  assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.equal(result.profile, WCA_SHARED_PHASE_CHANGES_PROFILE); assert.deepEqual(input, prior);
  assert.deepEqual(result.replacements[0].changedFields, ['label']);
  assert.deepEqual(result.replacements[0].definition, input.changes[0].replacement);
  assert.ok(result.impact.consumers.some((row) => row.kind === 'phase' && row.id === 'review'));
  assert.ok(result.impact.consumers.some((row) => row.kind === 'agent' && row.id === 'support-role'));
  assert.ok(result.impact.consumers.some((row) => row.kind === 'mcp-server' && row.id === 'shared'));
  assert.deepEqual(result.impact.affectedWorkflows.map((row) => row.id), ['indirect', 'main', 'masked']);
  assert.equal(result.impact.affectedWorkflows.find((row) => row.id === 'main').status, 'effective-phase-changed');
  assert.equal(result.impact.affectedWorkflows.find((row) => row.id === 'masked').status, 'effective-phase-unchanged');
  assert.equal(result.impact.affectedWorkflows.find((row) => row.id === 'indirect').status, 'declared-dependency-only');
  assert.equal(result.impact.retainedStories, 'unchanged-not-inventoried');
  assert.equal(result.impact.otherRepositories, 'unknown-not-inventoried');
  assert.equal(result.impact.submission, 'unavailable-from-this-planning-profile');
  assert.equal(result.impact.execution, 'not-run'); assert.equal(result.impact.permissions, 'not-granted');
  assert.equal(Object.isFrozen(result.replacements[0].definition.artifact), true);
  const { planSha256, ...core } = result; assert.equal(planSha256, `sha256:${recordSha256(core)}`);
});

test('template and nested artifact overrides can mask exact shared fallback changes', () => {
  const input = fixture(); input.changes[0].replacement.defaultTemplate = 'template:alternate';
  input.approvedDefinition.workTypes.masked.phaseOverrides.intake.artifact = { path: 'artifacts/pinned.md' };
  input.changes[0].replacement.artifact.path = 'artifacts/reviewed.md';
  const result = planSharedPhaseChanges(input); assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  const masked = result.impact.affectedWorkflows.find((row) => row.id === 'masked');
  assert.equal(masked.status, 'effective-phase-unchanged');
  assert.deepEqual(masked.effectivePhases[0].overrideFields, ['artifact', 'label']);
  assert.equal(masked.effectivePhases[0].templateOverride, true);
});

test('raw digest/source/order and exact agent content bind the complete plan, not temporary mount paths', () => {
  const input = fixture(); const first = planSharedPhaseChanges(input);
  input.agents[0].source = '/temporary/mount/one.agent.md'; input.agents[0].file = '/another/temporary/mount';
  assert.equal(planSharedPhaseChanges(input).planSha256, first.planSha256);
  input.approvedDefinition.phases.unrelated.label = 'Changed unrelated source';
  const second = planSharedPhaseChanges(input); assert.notEqual(second.planSha256, first.planSha256);
  input.agents[0].text += 'Changed role policy.\n';
  assert.notEqual(planSharedPhaseChanges(input).planSha256, second.planSha256);
  input.approvedDefinition.phases.intake.retainedExtension = { exact: true };
  blocked(input, 'WCA_CHANGE_PARENT_STALE');
});

test('unknown/duplicate/stale parents and deletion/forks/mixed object kinds refuse a whole transaction', () => {
  for (const change of [
    { id: 'absent' }, { operation: 'delete' }, { operation: 'fork' }, { kind: 'agent' },
    { expectedDefinitionSha256: `sha256:${'0'.repeat(64)}` }, { unexpected: true }
  ]) {
    const input = fixture(); Object.assign(input.changes[0], change);
    blocked(input, change.id ? 'WCA_SHARED_PHASE_SOURCE_UNAVAILABLE'
      : change.expectedDefinitionSha256 ? 'WCA_CHANGE_PARENT_STALE'
        : change.unexpected ? 'WCA_CHANGE_INVALID' : 'WCA_SHARED_PHASE_UNSUPPORTED');
  }
  const duplicate = fixture(); duplicate.changes.push(structuredClone(duplicate.changes[0])); blocked(duplicate, 'WCA_CHANGE_INVALID');
  const unpaired = fixture(); delete unpaired.changes[0].replacement; blocked(unpaired, 'WCA_CHANGE_INVALID');
});

test('execution, effect, producer and unknown extension updates are outside the shared structural profile', () => {
  for (const field of ['generation', 'qualityCommands', 'writeScope', 'sourceBoundary', 'mcp', 'nativeGrant', 'kind', 'comparison']) {
    const input = fixture(); input.changes[0].replacement[field] = field === 'writeScope' ? 'source-and-artifact' : { changed: true };
    blocked(input, 'WCA_SHARED_PHASE_EFFECT_CHANGE_UNSUPPORTED');
  }
  const nested = fixture(); nested.changes[0].replacement.artifact.nativeGrant = true;
  blocked(nested, 'WCA_SHARED_PHASE_EFFECT_CHANGE_UNSUPPORTED');
  const skill = fixture(); skill.changes[0].replacement.kind = 'skill'; blocked(skill, 'WCA_SHARED_PHASE_SKP_RECOMPILE_REQUIRED');
});

test('complete prospective owner validation refuses broken downstream inputs, missing templates and approval groups', () => {
  for (const mutate of [
    (phase) => { phase.inputs = ['review']; },
    (phase) => { phase.defaultTemplate = 'template:absent'; },
    (phase) => { phase.approval = { mode: 'required', authorities: ['absent'] }; },
    (phase) => { phase.artifact.path = '../escaped.md'; }
  ]) {
    const input = fixture(); mutate(input.changes[0].replacement);
    const result = planSharedPhaseChanges(input);
    assert.equal(result.status, 'blocked'); assert.equal(result.replacements.length, 0);
    assert.ok(['WCA_SHARED_PHASE_DEFINITION_INVALID', 'WCA_CHANGE_DEPENDENCY_UNAVAILABLE', 'WCA_CHANGE_INVALID'].includes(result.findings[0].code));
  }
});

test('ordinary producer structural changes cannot reuse a downstream confirmed skill binding', () => {
  const input = fixture(); const hash = (letter) => `sha256:${letter.repeat(64)}`;
  input.approvedDefinition.phases.intake.artifact.path = 'artifacts/intake/intake.md';
  input.changes[0].expectedDefinitionSha256 = phaseDefinitionSha256(input.approvedDefinition.phases.intake);
  input.changes[0].replacement.artifact.path = 'artifacts/intake/intake.md';
  const phase = { id: 'skill-note', kind: 'skill', label: 'Skill note', skill: { id: 'note', packageSha256: hash('a') },
    contract: { task: 'analyze', consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }],
      produces: [{ id: 'primary', path: 'artifacts/skill-note/skill-note.md', kind: 'custom:note', mediaType: 'text/markdown',
        encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384, clauses: 'optional', claimRole: 'findings' }],
      checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] },
      approval: { authorities: ['reviewers'], minimum: 1 } } };
  const catalog = { skillPackages: { note: { packageSha256: hash('a'), eligibility: 'candidate-producer' } },
    phases: { intake: { outputs: [{ id: 'primary', path: input.approvedDefinition.phases.intake.artifact.path }] } },
    checks: {}, readPaths: [], sourceScopes: {}, approvalAuthorities: input.approvedDefinition.approvalAuthorities,
    approvalSecurity: input.approvedDefinition.approvalSecurity };
  const phaseOrder = ['intake', 'skill-note']; const catalogSha256 = skillCandidateCatalogSha256(catalog);
  input.approvedDefinition.version = 3;
  input.approvedDefinition.phases['skill-note'] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({ phase, catalog, phaseOrder,
    confirmation: { contractSha256: skillContractSha256(phase.id, phase.contract), packageSha256: phase.skill.packageSha256,
      catalogSha256, candidateSha256: skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256), planSha256: hash('b'), draftRevision: 1 } }));
  input.approvedDefinition.workTypes['skill-workflow'] = { label: 'Skill workflow', phases: phaseOrder };
  input.agents.push({ id: 'skill-role', scope: 'repository', text: '# Exact skill role\n', phases: ['skill-note'],
    defaultFor: ['skill-note'], tools: [], worldModelViews: [], dependencies: [] });
  const labelOnly = planSharedPhaseChanges(input);
  assert.equal(labelOnly.status, 'ready-for-review', JSON.stringify(labelOnly.findings));
  input.changes[0].replacement.artifact.path = 'artifacts/replaced-producer.md';
  blocked(input, 'WCA_SHARED_PHASE_SKP_RECOMPILE_REQUIRED');
});

test('unrestricted agent and server scopes are visible as eligibility, never executed usage or permission', () => {
  const input = fixture(); input.agents.at(-1).phases = [];
  input.approvedDefinition.mcpServers.global = { phases: [], agents: [], tools: [] };
  for (const agent of input.agents) agent.tools.push('global/*');
  const result = planSharedPhaseChanges(input); assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.ok(result.impact.consumers.some((row) => row.kind === 'mcp-server' && row.id === 'global'));
  assert.ok(result.impact.affectedWorkflows.some((row) => row.id === 'untouched'));
  assert.ok(result.graph.before.edges.some((row) => row.relation === 'unrestricted-server-phase-scope'));
  assert.equal(result.impact.coverage, 'complete-declared-catalog-reference-impact-within-bounds;eligibility-is-not-execution');
});

test('declared global policy and remote agent-resource phase scopes are disclosed without fetching', () => {
  const input = fixture();
  input.approvedDefinition.documents = { allowedPhases: ['intake'] };
  input.approvedDefinition.contextPolicy = { phaseOverrides: { intake: 'keep' } };
  input.agents.find((agent) => agent.id === 'unrelated-role').dependencies = [{ id: 'generated-note', type: 'generated',
    phase: 'intake', target: 'artifacts/intake/remote.md', url: 'https://example.test/{workId}/note.md', optional: true, maxBytes: 1024 }];
  const result = planSharedPhaseChanges(input); assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.ok(result.impact.consumers.some((row) => row.kind === 'policy' && row.id === 'repository'));
  assert.ok(result.impact.consumers.some((row) => row.kind === 'agent-dependency' && row.id === 'unrelated-role/generated-note'));
  assert.ok(result.impact.affectedWorkflows.some((row) => row.id === 'untouched'));
  assert.equal(result.dependencyLocks.find((row) => row.kind === 'agent-dependency').availability, 'declared-not-fetched');
});

test('incomplete catalogs, malformed exact JSON, controls and resource limits never yield partial success', () => {
  let input = fixture(); delete input.agents[0].text; blocked(input, 'WCA_SHARED_PHASE_CATALOG_INCOMPLETE');
  input = fixture(); input.changes[0].replacement.label = 'Injected\u001b[2J'; blocked(input, 'WCA_CHANGE_INVALID');
  input = fixture(); input.changes[0].replacement.description = '\ud800'; blocked(input, 'WCA_CHANGE_INVALID');
  input = fixture(); let hooks = 0; Object.defineProperty(input.changes[0], 'replacement', { enumerable: true,
    get() { hooks += 1; throw new Error('Accessor must not run'); } }); blocked(input, 'WCA_CHANGE_INVALID'); assert.equal(hooks, 0);
  input = fixture(); input.agents = new Proxy(input.agents, { ownKeys() { hooks += 1; throw new Error('Proxy must not run'); } });
  blocked(input, 'WCA_CHANGE_INVALID'); assert.equal(hooks, 0);
  input = fixture(); input.changes[0].replacement.description = 'x'.repeat(WCA_WORKFLOW_CHANGE_LIMITS.inputBytes); blocked(input, 'WCA_CHANGE_LIMIT');
  input = fixture(); input.changes = Array.from({ length: 17 }, () => structuredClone(input.changes[0])); blocked(input, 'WCA_CHANGE_LIMIT');
});

test('the complete shared before/after/consumer disclosure is bounded without truncation', () => {
  const input = fixture();
  input.agents.push(...Array.from({ length: 180 }, (_, index) => ({ id: `extra-${index}-${'x'.repeat(48)}`,
    scope: 'bundled', text: '# Inert exact role\n', phases: ['intake'], defaultFor: [], tools: ['shared/*'],
    worldModelViews: [], dependencies: Array.from({ length: 9 }, (_, item) => ({ id: `dependency-${item}-${'y'.repeat(46)}`,
      url: 'https://example.test/inert-dependency' })) })));
  input.approvedDefinition.mcpServers.shared.agents.push(...input.agents.slice(5).map((agent) => agent.id));
  blocked(input, 'WCA_CHANGE_LIMIT');
});

test('current packaged catalog shared replacement preserves exact raw extensions and all captured consumers', async () => {
  const approvedDefinition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const agents = [];
  for (const name of await readdir(new URL('../templates/agents/', import.meta.url))) {
    if (!name.endsWith('.agent.md')) continue;
    const text = await readFile(new URL(`../templates/agents/${name}`, import.meta.url), 'utf8');
    agents.push({ ...parseAgentDependencies(text, { source: `templates/agents/${name}` }), text, scope: 'bundled' });
  }
  for (const name of await readdir(new URL('../plugin/agents/', import.meta.url))) {
    if (!name.endsWith('.agent.md')) continue;
    const text = await readFile(new URL(`../plugin/agents/${name}`, import.meta.url), 'utf8');
    agents.push({ ...parseAgentDependencies(text, { source: `plugin/agents/${name}` }), text, scope: 'plugin' });
  }
  const original = structuredClone(approvedDefinition.phases.requirements);
  const changes = [{ kind: 'phase', id: 'requirements', operation: 'edit', expectedDefinitionSha256: phaseDefinitionSha256(original),
    replacement: { ...original, label: 'Exact shared requirements' } }];
  const result = planSharedPhaseChanges({ approvedDefinition, agents, changes });
  assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.ok(result.impact.affectedWorkflows.length > 1);
  assert.deepEqual(approvedDefinition.phases.requirements, original);
  assert.deepEqual(result.replacements[0].definition, changes[0].replacement);
});
