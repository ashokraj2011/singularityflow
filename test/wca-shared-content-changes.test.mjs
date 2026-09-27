import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseAgentDependencies } from '../src/agents.mjs';
import { compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill, skillCandidateCatalogSha256,
  skillContractSha256, skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { recordSha256 } from '../src/records.mjs';
import { agentTextSha256, templateDefinitionSha256, planSharedAgentChanges, planSharedTemplateChanges,
  WCA_SHARED_AGENT_CHANGES_PROFILE, WCA_SHARED_TEMPLATE_CHANGES_PROFILE } from '../src/wca-workflow-changes.mjs';

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
function fixture() {
  const phase = (id, template = 'template:shared') => ({ label: id,
    artifact: { path: `artifacts/${id}/${id}.md`, minimumBytes: 20, maximumBytes: 16384 },
    inputs: [], defaultTemplate: template, approval: { mode: 'none' }, writeScope: 'artifact-only', generation: { task: 'analyze' } });
  const approvedDefinition = { version: 2, templatesRoot: 'singularity/templates', worldModel: { views: ['security'] },
    templates: { shared: { path: 'common/shared.md', label: 'Shared', kind: 'note', description: 'Exact source' },
      alias: 'common/shared.md', alternate: { path: 'common/alternate.md' } },
    phases: { intake: phase('intake'), review: phase('review', 'template:alias'), auxiliary: phase('auxiliary', 'common/shared.md'),
      unrelated: phase('unrelated', 'template:alternate') },
    workTypes: { main: { label: 'Main', phases: ['intake', 'review'] }, masked: { label: 'Masked', phases: ['intake'],
      templateOverrides: { intake: 'template:alternate' } }, indirect: { label: 'Indirect', phases: ['auxiliary'] },
      untouched: { label: 'Untouched', phases: ['unrelated'] } },
    approvalSecurity: { profile: 'team' }, approvalAuthorities: { reviewers: { members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } }, mcpServers: {}, harnessImports: { mode: 'record' } };
  approvedDefinition.phases.review.inputs = [{ phase: 'intake', projection: 'approved-summary', preserve: ['Findings'], optional: false }];
  const agents = Object.keys(approvedDefinition.phases).map((id) => {
    const source = `.github/agents/${id}-role.agent.md`;
    const text = `---\nname: ${id}-role\ndescription: Exact role\ntools: []\nmetadata:\n  sflow-phases: ${id}\n  sflow-default-for: ${id}\ncustom-native-field:\n  preserved: true\n---\nRead exact approved inputs.\n`;
    return { ...parseAgentDependencies(text, { source }), scope: 'repository', text };
  });
  const templateContents = [{ path: 'singularity/templates/common/shared.md', content: '# Note\n\n## Findings\n\nReviewed body.\n' },
    { path: 'singularity/templates/common/alternate.md', content: '# Alternative\n\n## Findings\n\nPinned template.\n' }];
  return { approvedDefinition, agents, templateContents };
}
function agentInput(f = fixture(), id = 'intake-role') {
  const source = f.agents.find((agent) => agent.id === id);
  return { ...f, changes: [{ kind: 'agent', id, operation: 'edit', expectedTextSha256: agentTextSha256(source.text),
    replacement: { text: source.text.replace('Read exact approved inputs.', 'Read only exact retained inputs. Stop for governed review.') } }] };
}
function templateInput(f = fixture(), reference = 'template:shared') {
  const raw = reference.startsWith('template:') ? f.approvedDefinition.templates[reference.slice(9)] : null;
  return { ...f, changes: [{ kind: 'template', id: reference, operation: 'edit',
    expectedDefinitionSha256: raw === null ? null : templateDefinitionSha256(raw), expectedContentSha256: sha(f.templateContents[0].content),
    replacement: { content: '# Note {{work.id}}\n\n## Findings\n\nExact reviewed replacement.\n' } }] };
}
function blocked(plan, input, code) {
  const result = plan(input); assert.equal(result.status, 'blocked');
  if (code) assert.equal(result.findings[0].code, code, JSON.stringify(result.findings));
  assert.deepEqual(result.replacements, []); assert.deepEqual(result.dependencyLocks, []);
  assert.deepEqual(result.graph.before, { nodes: [], edges: [] }); return result;
}

test('exact agent body edit discloses default, eligible and transitive consumers without metadata mutation', () => {
  const input = agentInput(); const before = structuredClone(input); const result = planSharedAgentChanges(input);
  assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.equal(result.profile, WCA_SHARED_AGENT_CHANGES_PROFILE); assert.deepEqual(input, before);
  assert.deepEqual(result.impact.affectedWorkflows.map((row) => row.id), ['main', 'masked']);
  assert.ok(result.impact.consumers.some((row) => row.kind === 'phase' && row.id === 'intake'));
  assert.ok(result.impact.consumers.some((row) => row.kind === 'phase' && row.id === 'review'));
  assert.equal(result.impact.affectedWorkflows[0].effectivePhases[0].agentSelection, 'existing-default');
  assert.equal(result.replacements[0].path, '.github/agents/intake-role.agent.md');
  assert.equal(result.replacements[0].beforeTextSha256, input.changes[0].expectedTextSha256);
  const { planSha256, ...core } = result; assert.equal(planSha256, `sha256:${recordSha256(core)}`);
  assert.equal(result.impact.permissions, 'not-granted'); assert.equal(result.impact.execution, 'not-run');
  assert.equal(Object.isFrozen(result.replacements[0]), true);
});

test('eligible alternative and unrestricted roles are impact consumers, not automatically selected roles', () => {
  const f = fixture(); f.agents[0].text = f.agents[0].text.replace('sflow-default-for: intake', 'sflow-default-for: "-"');
  Object.assign(f.agents[0], parseAgentDependencies(f.agents[0].text, { source: f.agents[0].source }));
  const fallback = structuredClone(f.agents[0]); fallback.id = 'default-role'; fallback.source = '.github/agents/default-role.agent.md';
  fallback.text = fallback.text.replace('name: intake-role', 'name: default-role').replace('sflow-default-for: "-"', 'sflow-default-for: intake');
  Object.assign(fallback, parseAgentDependencies(fallback.text, { source: fallback.source })); f.agents.push(fallback);
  const result = planSharedAgentChanges(agentInput(f)); assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.equal(result.impact.affectedWorkflows[0].effectivePhases[0].agentSelection, 'eligible-alternative-not-selected');
  const unrestricted = fixture(); unrestricted.agents[0].text = unrestricted.agents[0].text.replace('sflow-phases: intake', 'sflow-phases: "*"');
  Object.assign(unrestricted.agents[0], parseAgentDependencies(unrestricted.agents[0].text, { source: unrestricted.agents[0].source }));
  assert.deepEqual(planSharedAgentChanges(agentInput(unrestricted)).impact.affectedWorkflows.map((row) => row.id), ['indirect', 'main', 'masked', 'untouched']);
});

test('agent frontmatter, native unknown fields and remote resource identities cannot change through prose profile', () => {
  for (const [from, to] of [['tools: []', 'tools: ["shell/*"]'], ['preserved: true', 'preserved: false'],
    ['description: Exact role', 'description: New prose metadata'], ['sflow-phases: intake', 'sflow-phases: "*"']]) {
    const input = agentInput(); input.changes[0].replacement.text = input.changes[0].replacement.text.replace(from, to);
    blocked(planSharedAgentChanges, input, 'WCA_SHARED_AGENT_EFFECT_CHANGE_UNSUPPORTED');
  }
  const f = fixture(); const table = '\n## Remote skills\n\n| ID | URL | Phases | Optional | Max bytes |\n| --- | --- | --- | --- | --- |\n| guide | https://example.test/guide.md | intake | true | 1024 |\n';
  f.agents[0].text += table; Object.assign(f.agents[0], parseAgentDependencies(f.agents[0].text, { source: f.agents[0].source }));
  const good = agentInput(f); assert.equal(planSharedAgentChanges(good).status, 'ready-for-review');
  good.changes[0].replacement.text = good.changes[0].replacement.text.replace('guide.md', 'changed.md');
  blocked(planSharedAgentChanges, good, 'WCA_SHARED_AGENT_EFFECT_CHANGE_UNSUPPORTED');
  const rowBytes = agentInput(f); rowBytes.changes[0].replacement.text = rowBytes.changes[0].replacement.text.replace('| guide |', '|  guide |');
  blocked(planSharedAgentChanges, rowBytes, 'WCA_SHARED_AGENT_EFFECT_CHANGE_UNSUPPORTED');
});

test('agent parent is exact text including whitespace, source must be repository-owned and output is source-bound', () => {
  const stale = agentInput(); stale.agents[0].text += '\n'; blocked(planSharedAgentChanges, stale, 'WCA_CHANGE_PARENT_STALE');
  for (const patch of [{ scope: 'plugin' }, { source: '../../packaged.agent.md' }]) {
    const input = agentInput(); Object.assign(input.agents[0], patch); blocked(planSharedAgentChanges, input, 'WCA_SHARED_CONTENT_SOURCE_UNAVAILABLE');
  }
  const mismatch = agentInput(); mismatch.agents[0].tools = ['shell/*']; blocked(planSharedAgentChanges, mismatch, 'WCA_SHARED_CONTENT_SOURCE_INVALID');
  const views = agentInput(); views.changes[0].replacement.text += 'Read views/undeclared.md.\n';
  blocked(planSharedAgentChanges, views, 'WCA_SHARED_CONTENT_CONTRACT_INVALID');
});

test('template content edit includes aliases, legacy paths, transitive headings and masked overrides', () => {
  const input = templateInput(); const before = structuredClone(input); const result = planSharedTemplateChanges(input);
  assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings)); assert.deepEqual(input, before);
  assert.equal(result.profile, WCA_SHARED_TEMPLATE_CHANGES_PROFILE);
  assert.ok(result.impact.consumers.some((row) => row.kind === 'template' && row.id === 'alias'));
  assert.deepEqual(result.impact.affectedWorkflows.map((row) => row.id), ['indirect', 'main', 'masked']);
  assert.equal(result.impact.affectedWorkflows.find((row) => row.id === 'masked').effectivePhases.length, 0);
  assert.deepEqual(result.impact.affectedWorkflows.find((row) => row.id === 'main').effectivePhases.map((row) => row.id), ['intake', 'review']);
  assert.equal(result.replacements[0].path, 'singularity/templates/common/shared.md');
  assert.equal(planSharedTemplateChanges(templateInput(fixture(), 'path:common/shared.md')).status, 'ready-for-review');
});

test('named template label/description may change but paths, kinds, unknown fields and conflicting aliases refuse', () => {
  const input = templateInput(); input.changes[0].replacement.definition = { ...input.approvedDefinition.templates.shared, label: 'Reviewed name', description: 'Reviewed display prose' };
  const result = planSharedTemplateChanges(input); assert.equal(result.status, 'ready-for-review', JSON.stringify(result.findings));
  assert.deepEqual(result.replacements[0].definition, input.changes[0].replacement.definition);
  for (const patch of [{ path: 'new.md' }, { kind: 'executable' }, { nativeHook: true }]) {
    const bad = templateInput(); bad.changes[0].replacement.definition = { ...bad.approvedDefinition.templates.shared, ...patch };
    blocked(planSharedTemplateChanges, bad);
  }
  const alias = templateInput(); alias.changes.push({ ...structuredClone(alias.changes[0]), id: 'template:alias', expectedDefinitionSha256: templateDefinitionSha256(alias.approvedDefinition.templates.alias) });
  blocked(planSharedTemplateChanges, alias, 'WCA_CHANGE_INVALID');
});

test('template candidate validates preserved-heading/tokens/view contracts rather than just JSON structure', () => {
  for (const content of ['# Missing\n', '# Note\n## Findings\n## Findings\n', '# Note\n<!-- unclosed\n## Findings\n',
    '# Note {{shell.command}}\n## Findings\n', '# Note\n## Findings\nRead views/undeclared.md.\n']) {
    const input = templateInput(); input.changes[0].replacement.content = content;
    blocked(planSharedTemplateChanges, input, 'WCA_SHARED_CONTENT_CONTRACT_INVALID');
  }
});

test('template source missing, raw/content drift and unselected/remote paths are not empty successes', () => {
  for (const mutate of [(f) => { f.templateContents.shift(); }, (f) => { f.templateContents[0].content += '\n'; },
    (f) => { f.approvedDefinition.templates.shared.label = 'Changed raw'; }]) {
    const input = templateInput(); mutate(input); blocked(planSharedTemplateChanges, input);
  }
  for (const id of ['agent:intake-role/remote', 'path:../escape.md', 'path:unselected.md']) {
    const input = templateInput(); input.changes[0].id = id; blocked(planSharedTemplateChanges, input);
  }
});

function withSkill(f) {
  const hash = (letter) => `sha256:${letter.repeat(64)}`;
  const phase = { id: 'skill-note', kind: 'skill', label: 'Skill note', skill: { id: 'note', packageSha256: hash('a') },
    contract: { task: 'analyze', consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }],
      produces: [{ id: 'primary', path: 'artifacts/skill-note/skill-note.md', kind: 'custom:note', mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384, clauses: 'optional', claimRole: 'findings' }],
      checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 } } };
  const catalog = { skillPackages: { note: { packageSha256: hash('a'), eligibility: 'candidate-producer' } },
    phases: { intake: { outputs: [{ id: 'primary', path: f.approvedDefinition.phases.intake.artifact.path }] } },
    checks: {}, readPaths: [], sourceScopes: {}, approvalAuthorities: f.approvedDefinition.approvalAuthorities, approvalSecurity: f.approvedDefinition.approvalSecurity };
  const phaseOrder = ['intake', 'skill-note']; const catalogSha256 = skillCandidateCatalogSha256(catalog);
  f.approvedDefinition.version = 3;
  f.approvedDefinition.phases['skill-note'] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({ phase, catalog, phaseOrder,
    confirmation: { contractSha256: skillContractSha256(phase.id, phase.contract), packageSha256: phase.skill.packageSha256,
      catalogSha256, candidateSha256: skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256), planSha256: hash('b'), draftRevision: 1 } }));
  f.approvedDefinition.workTypes.skill = { label: 'Skill', phases: phaseOrder };
  const text = '---\nname: skill-role\ndescription: Exact skill role\ntools: []\nmetadata:\n  sflow-phases: skill-note\n  sflow-default-for: skill-note\n---\nExact approved skill instructions.\n';
  f.agents.push({ ...parseAgentDependencies(text, { source: '.github/agents/skill-role.agent.md' }), scope: 'repository', text }); return f;
}

test('changed agent eligibility or producer template closure cannot silently reuse confirmed SKP consent', () => {
  const f = withSkill(fixture()); blocked(planSharedAgentChanges, agentInput(f, 'skill-role'), 'WCA_SHARED_CONTENT_SKP_RECOMPILE_REQUIRED');
  blocked(planSharedAgentChanges, agentInput(f, 'intake-role'), 'WCA_SHARED_CONTENT_SKP_RECOMPILE_REQUIRED');
  blocked(planSharedTemplateChanges, templateInput(f), 'WCA_SHARED_CONTENT_SKP_RECOMPILE_REQUIRED');
});

test('template profile cannot impersonate native Agent/skill/configuration objects or executable files through approved root overlap', () => {
  for (const [root, relative] of [['.github/agents', 'intake-role.agent.md'], ['.github/workflows', 'pipeline.md'],
    ['.github/skills', 'SKILL.md'], ['.private-agent', 'instructions.md'], ['.private-notes', 'ordinary.md'],
    ['singularity/templates', 'script.mjs']]) {
    const f = fixture(); f.approvedDefinition.templatesRoot = root;
    f.approvedDefinition.templates.shared.path = relative; f.approvedDefinition.templates.alias = relative;
    f.approvedDefinition.templates.alternate.path = relative; f.approvedDefinition.phases.auxiliary.defaultTemplate = relative;
    f.templateContents = [{ path: `${root}/${relative}`, content: '# Exact source\n## Findings\n' }];
    const input = templateInput(f); blocked(planSharedTemplateChanges, input, 'WCA_SHARED_CONTENT_UNSUPPORTED');
  }
});

test('closed profiles, exact Unicode, caller mutation and aggregate limits refuse without partial disclosure', () => {
  for (const patch of [{ operation: 'delete' }, { kind: 'phase' }, { unexpected: true }]) {
    const input = agentInput(); Object.assign(input.changes[0], patch); blocked(planSharedAgentChanges, input);
  }
  const invalid = agentInput(); invalid.changes[0].replacement.text += '\ud800'; blocked(planSharedAgentChanges, invalid, 'WCA_CHANGE_INVALID');
  let invoked = false; const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; return Object.prototype; } });
  blocked(planSharedAgentChanges, proxy, 'WCA_CHANGE_INVALID'); assert.equal(invoked, false);
  const oversized = templateInput(); oversized.changes[0].replacement.content = '# Note\n## Findings\n' + 'x'.repeat(2 * 1024 * 1024);
  blocked(planSharedTemplateChanges, oversized, 'WCA_CHANGE_LIMIT');
  const input = templateInput(); const result = planSharedTemplateChanges(input); input.changes[0].replacement.content = 'Later mutable bytes';
  assert.notEqual(result.replacements[0].content, input.changes[0].replacement.content);
});
