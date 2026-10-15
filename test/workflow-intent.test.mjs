import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { withWorkflowIntentCatalog, queryWorkflowIntentCatalog, selectWorkflowIntentAsset } from '../src/workflow-intent-catalog.mjs';
import { WORKFLOW_INTENT_PATTERNS, WORKFLOW_INTENT_FAMILIES } from '../src/workflow-intent-patterns.mjs';
import { compileWorkflowMarkup, lowerWorkflowMarkup } from '../src/workflow-markup.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { renderAgentSkills } from '../src/agents.mjs';
import { planWorkflowImport, applyWorkflowImport } from '../src/workflow-transfer.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { parseArgs } from '../src/util.mjs';
import { instructionText, parseInstruction } from '../src/instruction-library.mjs';
import { librarySkillText, parseLibrarySkill, readSkillAttachments, skillAttachmentsText, SKILL_ATTACHMENTS_PATH } from '../src/skill-library.mjs';
import { planStudioChangeSet } from '../src/workflow-studio.mjs';
import { derivedMcpPolicy } from '../src/workflow-markup-mcp.mjs';

const example = await readFile(new URL('../examples/demo-tagged-workflow.xml', import.meta.url), 'utf8');
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const original = 'Test screenshots, repair failures, retest at most three times, then obtain human acceptance.';
const capture = action => withWorkflowIntentCatalog(null, { source: 'installed' }, action);
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function draft(catalog, { family = 'visual-acceptance', patterns = ['test-repair', 'bounded-loop', 'human-checkpoint'] } = {}) {
  let source = example.replace('version="1"', `version="2" catalog="${catalog.sourceSha256}" catalog-source="installed"`);
  source = source.replace('</workflow>', `<intent family="${family}"><description>${escape(original)}</description>
    <requirement id="check-behavior" maps-to="phase:demo-tagged-test">Compare fresh behavior with the supplied screenshots.</requirement>
    <requirement id="bounded-repair" maps-to="decision:demo-tagged-repair-result">Repair and return to the independent tester at most three times.</requirement>
    ${patterns.map(id => `<pattern ref="${id}"/>`).join('')}
    </intent></workflow>`);
  const parents = { analyst: 'demo-instruction-analyst', checker: 'demo-instruction-tester', developer: 'demo-instruction-developer', closer: 'demo-instruction-closer' };
  for (const [name, parent] of Object.entries(parents)) source = source.replace(new RegExp(`<agent id="demo-tagged-${name}"[\\s\\S]*?<\\/agent>`, 'u'), `<agent id="demo-tagged-${name}" from="${parent}" />`);
  return source.replace(/\s*<instruction id="demo-tagged-[\s\S]*?<\/instruction>/gu, '')
    .replace(/\s*<skill id="demo-tagged-check"[\s\S]*?<\/skill>/u, '');
}
function git(root, ...argv) { const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intent-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'workflow-fixture@example.invalid'); git(root, 'config', 'user.name', 'Workflow fixture');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Fixture configuration');
  git(root, 'remote', 'add', 'origin', root); git(root, 'branch', 'sflow/config');
  return root;
}

test('the complete typed catalog is deterministic and paginated without loading bodies into its index', async () => {
  const first = await capture(catalog => queryWorkflowIntentCatalog(catalog, { kind: 'skill', limit: 2 }));
  const second = await capture(catalog => queryWorkflowIntentCatalog(catalog, { kind: 'skill', cursor: 2, limit: 2 }));
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.equal(first.entries.length, 2); assert.equal(first.nextCursor, 2);
  assert.ok(first.counts['command-skill'] > 100); assert.ok(first.counts.agent > 10); assert.ok(first.counts.instruction >= 3);
  assert.ok(first.entries.every(item => !Object.hasOwn(item, 'value') && !Object.hasOwn(item, 'instructions')));
  assert.ok(!first.entries.some(item => second.entries.some(next => next.id === item.id)));
  assert.equal(first.permissionEffect, 'none'); assert.equal(first.membership, 'not-verified');
  assert.ok(first.patterns.some(item => item.id === 'parallel' && item.status === 'requires-qualified-runtime'));
  assert.ok(first.families.some(item => item.id === 'review-audit'));
});

test('exact retrieval exposes selected definitions and dependency closure, not authority or live replacement', async () => {
  await capture(catalog => {
    const agent = selectWorkflowIntentAsset(catalog, 'agent', 'demo-instruction-tester');
    assert.ok(agent.dependencies.some(item => item.kind === 'skill'));
    const skill = selectWorkflowIntentAsset(catalog, 'skill', agent.dependencies[0].id);
    assert.equal(skill.dependencies.length, 3);
    for (const ref of skill.dependencies) assert.ok(selectWorkflowIntentAsset(catalog, ref.kind, ref.id).value.instructions.length);
    assert.ok(selectWorkflowIntentAsset(catalog, 'command-skill', 'sflow-code').value.attachable === false);
    assert.throws(() => selectWorkflowIntentAsset(catalog, 'instruction', 'missing'), { code: 'WORKFLOW_INTENT_ASSET_UNKNOWN' });
    assert.throws(() => queryWorkflowIntentCatalog(catalog, { kind: '__proto__' }));
    assert.throws(() => queryWorkflowIntentCatalog(catalog, { limit: 1000 }));
  });
  await assert.rejects(withWorkflowIntentCatalog(null, { source: 'installed', expectedSource: 'sha256:' + 'f'.repeat(64) }, () => {}), { code: 'WORKFLOW_INTENT_CATALOG_STALE' });
});

test('catalog-bound derivation compiles, imports, composes retained instructions and preserves the original agent', async t => {
  const source = await capture(catalog => draft(catalog));
  const compiled = await compileWorkflowMarkup(source);
  assert.equal(compiled.status, 'portable-ready'); assert.equal(compiled.intent.text, original);
  assert.equal(compiled.intent.structuralOnly, true); assert.equal(compiled.intent.humanReviewRequired, true);
  assert.ok(compiled.reusedAssets.some(item => item.kind === 'agent' && item.id === 'demo-instruction-tester' && item.as === 'demo-tagged-checker'));
  assert.ok(compiled.reusedAssets.filter(item => item.kind === 'instruction').length >= 3);
  assert.equal(compiled.routeSimulation.status, 'passed');
  const root = await repository(t);
  const before = await readFile(path.join(root, '.github/agents/demo-instruction-tester.agent.md'));
  const plan = await planWorkflowImport(root, compiled.bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(root, compiled.bundle, { expectedPlanSha256: plan.planSha256 });
  const definition = await loadDefinition(root); const resolved = resolveWorkType(definition, 'demo-tagged');
  const phase = resolved.phases.find(item => item.id === 'demo-tagged-test');
  const prompt = await renderAgentSkills(root, { workItem: { id: 'NEW', workType: 'demo-tagged' } }, phase, { agent: 'demo-tagged-checker' });
  assert.match(prompt.text, /demo-fresh-test-evidence/u);
  assert.deepEqual(await readFile(path.join(root, '.github/agents/demo-instruction-tester.agent.md')), before);
});

test('original intent, exact targets, finite loops, known asset kinds and unsupported capabilities cannot be discarded', async () => {
  const source = await capture(catalog => draft(catalog));
  const bad = [source.replace('catalog="sha256:', 'catalog="wrong:'), source.replace('from="demo-instruction-tester"', 'from="invented-tester"'),
    source.replace('from="demo-instruction-tester"', 'from="demo-instruction-developer"'),
    source.replace('maps-to="phase:demo-tagged-test"', 'maps-to="phase:missing"'),
    source.replace('id="bounded-repair"', 'id="check-behavior"'), source.replace(/<intent[\s\S]*?<\/intent>/u, ''),
    source.replace('<pattern ref="test-repair"/>', '<pattern ref="parallel"/>'),
    source.replace('<pattern ref="test-repair"/>', '<pattern ref="subprocess"/>'),
    source.replace('<pattern ref="test-repair"/>', '<pattern ref="event-wait"/>'),
    source.replace('<agent id="demo-tagged-closer"', '<agent tools="unreviewed-tool" id="demo-tagged-closer"')];
  for (const value of bad) await assert.rejects(compileWorkflowMarkup(value));
});

test('the family corpus reports reviewed runtime requirements instead of pretending unsupported work is sequential', async () => {
  await capture(catalog => {
    const context = { definition: catalog.definition, agents: catalog.agents, catalog: { ...catalog, WORKFLOW_INTENT_PATTERNS, WORKFLOW_INTENT_FAMILIES } };
    for (const family of WORKFLOW_INTENT_FAMILIES) {
      const source = draft(catalog, { family: family.id, patterns: family.patterns });
      if (family.patterns.some(id => WORKFLOW_INTENT_PATTERNS.find(pattern => pattern.id === id).status !== 'supported')) {
        assert.throws(() => lowerWorkflowMarkup(source, context), { code: 'WORKFLOW_MARKUP_CAPABILITY_REQUIRED' });
      } else assert.equal(lowerWorkflowMarkup(source, context).intent.family, family.id);
    }
  });
});

test('approved catalog reads registered framework tags, refuses stale source and ignores dirty app checkout edits', async t => {
  const root = await repository(t);
  const folder = path.join(root, 'singularity/instruction-library/angular-style'); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'INSTRUCTIONS.md'), '---\nname: angular-style\ndescription: Team UI conventions\nmetadata:\n  sflow-tags: [framework:angular, activity:review]\n---\nUse the team Angular conventions.\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Add framework instruction'); git(root, 'branch', '-f', 'sflow/config', 'HEAD');
  const before = await withWorkflowIntentCatalog(root, {}, catalog => queryWorkflowIntentCatalog(catalog, { kind: 'instruction', tags: ['framework:angular'] }));
  assert.equal(before.total, 1); assert.equal(before.entries[0].id, 'angular-style');
  await writeFile(path.join(folder, 'INSTRUCTIONS.md'), 'dirty app checkout bytes');
  const unchanged = await withWorkflowIntentCatalog(root, { expectedSource: before.sourceSha256 }, catalog => queryWorkflowIntentCatalog(catalog));
  assert.equal(unchanged.sourceSha256, before.sourceSha256);
});

test('workflow-level skill conditions and step selectors survive derivation without leaking into other workflows', async t => {
  const root = await repository(t);
  await mkdir(path.join(root, 'singularity/skill-library/workflow-only-rule'), { recursive: true });
  await writeFile(path.join(root, 'singularity/skill-library/workflow-only-rule/SKILL.md'), librarySkillText({
    id: 'workflow-only-rule', description: 'Only this workflow test step', instructions: 'Retain the supplied screenshot evidence at this step.' }));
  const originalAttachments = await readSkillAttachments(root);
  await writeFile(path.join(root, SKILL_ATTACHMENTS_PATH), skillAttachmentsText([...originalAttachments,
    { id: 'workflow-only-rule', workflow: 'demo-instruction-test-loop', phases: ['demo-instruction-test'], use: 'When screenshot evidence is supplied.' }]));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Add a workflow-scoped conditional skill'); git(root, 'branch', '-f', 'sflow/config', 'HEAD');
  const source = await withWorkflowIntentCatalog(root, {}, catalog => {
    const entry = selectWorkflowIntentAsset(catalog, 'workflow', 'demo-instruction-test-loop');
    assert.ok(entry.dependencies.some(item => item.kind === 'skill' && item.id === 'workflow-only-rule'));
    return draft(catalog).replace('catalog-source="installed"', 'catalog-source="approved"');
  });
  const compiled = await compileWorkflowMarkup(source, { repository: root });
  const plan = await planWorkflowImport(root, compiled.bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(root, compiled.bundle, { expectedPlanSha256: plan.planSha256 });
  const rows = (await readSkillAttachments(root)).filter(item => item.id === 'workflow-only-rule');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(item => item.workflow === 'demo-tagged').phases, ['demo-tagged-test']);
  assert.equal(rows.find(item => item.workflow === 'demo-tagged').use, 'When screenshot evidence is supplied.');
  assert.ok(rows.every(item => !item.agent));
});

test('a user-created artifact-only review contract is selected from approved configuration without inventing code phases', async t => {
  const root = await repository(t); const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  for (const [index, id] of ['review-analysis', 'review-findings'].entries()) {
    definition.phases[id] = { ...structuredClone(definition.phases.intake), label: id, agents: ['review-owner'],
      generation: { ...definition.phases.intake.generation, task: 'analyze' }, writeScope: 'artifact-only',
      inputs: index ? ['review-analysis'] : [], artifact: { ...definition.phases.intake.artifact, path: `artifacts/${id}/report.md`, kind: 'custom:review-note' },
      approval: { mode: 'required', authorities: ['quality-reviewers'], minimum: 1, rejectTo: index ? ['review-analysis'] : [] } };
  }
  definition.workTypes['document-review'] = { label: 'Document review', phases: ['review-analysis', 'review-findings'],
    omits: ['scope', 'plan', 'implement', 'verify', 'review'].map(responsibility => ({ responsibility, reason: 'An authoring qualification fixture that performs no application delivery.', authority: 'quality-reviewers' })) };
  await writeFile(workflowPath, YAML.stringify(definition));
  await writeFile(path.join(root, '.github/agents/review-owner.agent.md'), '---\nname: review-owner\ndescription: Reads approved documents and writes findings only\ntools: [read, search, edit]\nmetadata:\n  sflow-phases: review-analysis, review-findings\n  sflow-default-for: review-analysis, review-findings\n---\nRead the approved inputs; write findings without modifying application code.\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Add reviewed document contract'); git(root, 'branch', '-f', 'sflow/config', 'HEAD');
  const sha = await withWorkflowIntentCatalog(root, {}, catalog => catalog.sourceSha256);
  const source = `<workflow version="2" id="review-flow" label="Review flow" extends="document-review" catalog="${sha}" catalog-source="approved">
    <agent id="review-flow-owner" from="review-owner" />
    <phase id="review-flow-analyze" from="review-analysis" agent="review-flow-owner" />
    <phase id="review-flow-findings" from="review-findings" agent="review-flow-owner" />
    <intent family="review-audit"><description>Review the documents without changing application code.</description>
      <requirement id="read-only" maps-to="phase:review-flow-analyze phase:review-flow-findings">Only produce review artifacts.</requirement>
      <pattern ref="sequence"/><pattern ref="human-checkpoint"/>
    </intent></workflow>`;
  const compiled = await compileWorkflowMarkup(source, { repository: root });
  assert.equal(compiled.status, 'portable-ready'); assert.equal(compiled.workflow.phases.length, 2);
  for (const phase of Object.values(compiled.bundle.objects.story.phases)) assert.equal(phase.writeScope, 'artifact-only');
  assert.match(compiled.bundle.objects.story.workTypes['review-flow'].description, /Review the documents without changing application code/u);
});

test('discovery tags round-trip and ordinary Studio edits preserve them without changing instruction placement', async t => {
  const root = await repository(t);
  const tags = ['framework:angular', 'activity:test'];
  const instruction = instructionText({ id: 'tagged-rule', description: 'A tagged rule', instructions: 'Use the team convention.', tags });
  const skill = librarySkillText({ id: 'tagged-skill', description: 'A tagged procedure', instructions: 'Follow <instruction>tagged-rule</instruction>.', tags });
  await mkdir(path.join(root, 'singularity/instruction-library/tagged-rule'), { recursive: true });
  await mkdir(path.join(root, 'singularity/skill-library/tagged-skill'), { recursive: true });
  await writeFile(path.join(root, 'singularity/instruction-library/tagged-rule/INSTRUCTIONS.md'), instruction);
  await writeFile(path.join(root, 'singularity/skill-library/tagged-skill/SKILL.md'), skill);
  assert.deepEqual(parseInstruction(instruction).tags, tags); assert.deepEqual(parseLibrarySkill(skill).tags, tags);
  const plan = await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'skill.update', id: 'tagged-skill', description: 'Updated description' },
    { op: 'instruction.update', id: 'tagged-rule', description: 'Updated rule description' }
  ] }, { write: true });
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  for (const file of plan.files.filter(item => /tagged-(?:skill|rule)/u.test(item.path))) assert.match(await readFile(path.join(root, file.path), 'utf8'), /framework:angular/u);
  assert.throws(() => instructionText({ id: 'bad', description: 'Bad tags', instructions: 'Do not interpret tags.', tags: ['../path'] }));
});

test('a six-phase delivery contract carries scoped MCP policy forward without importing unrelated source phases', async () => {
  const source = await capture(catalog => {
    const base = catalog.definition.workTypes['spec-driven-standard'];
    const agents = base.phases.map(phase => catalog.agents.find(agent => agent.defaultFor.includes(phase)));
    assert.ok(agents.every(Boolean));
    return `<workflow version="2" id="delivery-intent" label="Delivery intent" extends="spec-driven-standard" catalog="${catalog.sourceSha256}" catalog-source="installed">
      ${base.phases.map((phase, index) => `<agent id="delivery-intent-${phase}-owner" from="${agents[index].id}" />`).join('')}
      ${base.phases.map(phase => `<phase id="delivery-intent-${phase}" from="${phase}" agent="delivery-intent-${phase}-owner" />`).join('')}
      <intent family="software-change"><description>Deliver an approved software change with human checkpoints.</description>
        <requirement id="delivery" maps-to="workflow:delivery-intent">Keep the approved delivery contract.</requirement><pattern ref="sequence"/><pattern ref="human-checkpoint"/>
      </intent></workflow>`;
  });
  const result = await compileWorkflowMarkup(source);
  assert.equal(result.workflow.phases.length, 6);
  const servers = result.bundle.objects.story.mcpServers;
  assert.ok(servers['delivery-intent-playwright']);
  assert.ok(servers['delivery-intent-playwright'].phases.every(id => id.startsWith('delivery-intent-')));
  assert.ok(servers['delivery-intent-playwright'].agents.every(id => id.startsWith('delivery-intent-')));
  assert.equal(servers['delivery-intent-playwright'].hostReference, 'playwright');
  assert.equal(servers['delivery-intent-playwright'].approval, 'confirm');
  assert.equal(servers.playwright, undefined);
  assert.ok(Object.keys(result.bundle.objects.story.phases).every(id => id.startsWith('delivery-intent-')));
});

test('derived MCP permissions intersect parent phase and agent policy and retain source-only classification', () => {
  const context = { id: 'flow', phaseMap: new Map([['test', 'flow-test'], ['repair', 'flow-repair']]),
    phaseAgents: { 'flow-test': 'flow-checker', 'flow-repair': 'flow-developer' },
    agents: [{ id: 'flow-checker', parentId: 'checker' }, { id: 'flow-developer', parentId: 'developer' }], workflow: {}, phases: {} };
  const result = derivedMcpPolicy({ ...context, definition: { mcpServers: {
    browser: { phases: ['test'], agents: ['checker'], tools: ['screenshot'], approval: 'confirm' },
    mismatch: { phases: ['test'], agents: ['developer'], tools: ['edit'] },
    docs: { phases: [], agents: [], tools: [], sources: { root: 'docs' } }
  } } });
  assert.deepEqual(result.servers['flow-browser'].phases, ['flow-test']);
  assert.deepEqual(result.servers['flow-browser'].agents, ['flow-checker']);
  assert.equal(result.servers['flow-mismatch'], undefined);
  assert.deepEqual(result.servers['flow-docs'].agents, []);
  assert.deepEqual(result.servers['flow-docs'].tools, []);
  assert.throws(() => derivedMcpPolicy({ ...context, workflow: { requiredServers: ['mismatch'] },
    definition: { mcpServers: { mismatch: { phases: ['test'], agents: ['developer'] } } } }), /no compatible derived/u);
});

test('copied skills and instructions retain inline placement and credential-shaped guidance is not exposed', async t => {
  let parentSkill;
  const source = await capture(catalog => {
    const parentId = selectWorkflowIntentAsset(catalog, 'agent', 'demo-instruction-tester').dependencies[0].id;
    parentSkill = selectWorkflowIntentAsset(catalog, 'skill', parentId).value;
    return draft(catalog).replace('<phase id="demo-tagged-intake"',
      `<instruction id="demo-tagged-existing-rule" from="demo-fresh-test-evidence" />
       <skill id="demo-tagged-copied-check" from="${parentId}" />
       <skill id="demo-tagged-additional-check" description="Check with an existing instruction">At the evidence step: <instruction>demo-tagged-existing-rule</instruction>.</skill>
       <phase id="demo-tagged-intake"`).replace('from="demo-instruction-tester" />',
      'from="demo-instruction-tester"><skill ref="demo-tagged-copied-check"/><skill ref="demo-tagged-additional-check"/></agent>');
  });
  const compiled = await compileWorkflowMarkup(source);
  const copied = parseLibrarySkill(compiled.bundle.assets.find(item => item.kind === 'skill' && item.id === 'demo-tagged-copied-check').content);
  assert.equal(copied.instructions, parentSkill.instructions);
  assert.equal(copied.loading, parentSkill.loading);
  assert.deepEqual(copied.instructionRefs, parentSkill.instructionRefs);
  assert.ok(compiled.reusedAssets.some(item => item.kind === 'instruction' && item.as === 'demo-tagged-existing-rule'));
  const root = await repository(t); const folder = path.join(root, 'singularity/instruction-library/blocked-rule');
  await mkdir(folder, { recursive: true });
  const credential = `ghp_${'X'.repeat(36)}`;
  await writeFile(path.join(folder, 'INSTRUCTIONS.md'), instructionText({ id: 'blocked-rule', description: 'Unavailable credential fixture', instructions: credential }));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Credential screening fixture'); git(root, 'branch', '-f', 'sflow/config', 'HEAD');
  await withWorkflowIntentCatalog(root, {}, catalog => {
    const result = queryWorkflowIntentCatalog(catalog, { kind: 'instruction', query: 'blocked-rule' });
    assert.equal(result.entries[0].available, false);
    assert.ok(!JSON.stringify(result).includes(credential));
    assert.throws(() => selectWorkflowIntentAsset(catalog, 'instruction', 'blocked-rule'), { code: 'WORKFLOW_INTENT_ASSET_UNAVAILABLE' });
  });
});

test('catalog commands are model-free, bounded, root-explicit and refuse repeated options or stale retrieval', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intent-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath, [CLI, 'workflow', 'intent', ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
  const list = run(['catalog', '--source', 'installed', '--kind', 'skill', '--limit', '2', '--json']); assert.equal(list.status, 0, list.stderr);
  const catalog = JSON.parse(list.stdout);
  const show = run(['show', 'skill', catalog.entries[0].id, '--source', 'installed', '--expected-source', catalog.sourceSha256, '--json']); assert.equal(show.status, 0, show.stderr);
  assert.ok(JSON.parse(show.stdout).asset.value.instructions);
  assert.equal(JSON.parse(show.stdout).asset.value.text, undefined);
  assert.match(catalog.commandGuidance.copilotCommand, /^\/sf-workflows intent show/u);
  const exampleResult = run(['example', '--source', 'installed', '--json']); assert.equal(exampleResult.status, 0, exampleResult.stderr);
  const boundExample = JSON.parse(exampleResult.stdout);
  assert.equal((await compileWorkflowMarkup(boundExample.source)).intent.family, 'visual-acceptance');
  const xml = path.join(root, 'generated.workflow.xml'); await writeFile(xml, boundExample.source);
  const check = spawnSync(process.execPath, [CLI, 'workflow', 'markup', 'compile', xml, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr); assert.equal(JSON.parse(check.stdout).bundle, undefined);
  for (const args of [['catalog', '--source', 'installed', '--limit', '65'], ['show', 'skill', 'x', '--source', 'installed'],
    ['catalog', '--source', 'installed', '--source', 'approved'], ['catalog', '--source', 'installed', '--cursor', '2']]) assert.notEqual(run(args).status, 0);
  assert.deepEqual(await readdir(root), ['generated.workflow.xml']);
  for (const action of ['catalog', 'show', 'example']) {
    const operation = resolveOperation({ requestedCommand: 'workflow', ...parseArgs(['workflow', 'intent', action]) });
    assert.equal(operation.classification, 'read'); assert.equal(operation.modelPolicy, 'never');
  }
});
