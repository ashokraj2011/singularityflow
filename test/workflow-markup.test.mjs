import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { parseWorkflowMarkup, WORKFLOW_MARKUP_LIMITS } from '../src/workflow-markup-parser.mjs';
import { compileWorkflowMarkup, lowerWorkflowMarkup } from '../src/workflow-markup.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { discoverAgents, renderAgentSkills } from '../src/agents.mjs';
import { planWorkflowImport, applyWorkflowImport, exportWorkflowBundle } from '../src/workflow-transfer.mjs';
import { decisionOutcome } from '../src/workflow-decisions.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { excludesActiveWorkspaceRouting } from '../src/cli-entry.mjs';
import { parseArgs } from '../src/util.mjs';

const example = await readFile(new URL('../examples/demo-tagged-workflow.xml', import.meta.url), 'utf8');
const CLI = new URL('../bin/singularity-flow.mjs', import.meta.url);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-markup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const agents = await discoverAgents(root);
  return { root, definition, agents };
}
const errorCode = error => /^WORKFLOW_MARKUP_/u.test(error.code);

test('strict parser handles Unicode, CRLF, comments, CDATA and exact source positions', () => {
  const source = '<!--before-->\r\n<workflow version="1"><description>A &amp; B &#x1F600; &lt;x&gt;<![CDATA[<literal>]]></description></workflow>';
  const parsed = parseWorkflowMarkup(source);
  assert.equal(parsed.line, 2); assert.equal(parsed.start, source.indexOf('<workflow'));
  assert.equal(parsed.end, source.length);
  assert.equal(parsed.children[0].children.join(''), 'A & B 😀 <x><literal>');
  assert.equal(Object.getPrototypeOf(parsed.attrs), null);
});

test('parser refuses browser-style recovery, entities, executable declarations and resource exhaustion', () => {
  for (const source of [
    '', '<workflow></phase>', '<workflow/>trailing', '<workflow/><workflow/>',
    '<workflow id="one" id="two"/>', '<workflow ID="one"/>', '<workflow id=unquoted/>',
    '<workflow id="one"other="two"/>', '<workflow>&unknown;</workflow>', '<workflow>&</workflow>',
    '<workflow>&#0;</workflow>', '<workflow>&#xD800;</workflow>', '<workflow>&#x110000;</workflow>',
    '<!DOCTYPE workflow SYSTEM "https://example.invalid/external"><workflow/>',
    '<?xml version="1.0"?><workflow/>', '<workflow><![CDATA[unterminated</workflow>',
    '<workflow>]]></workflow>', '<!--bad--comment--><workflow/>', '<workflow>\u0000</workflow>',
    '<workflow>\ud800</workflow>', '<workflow ' + Array.from({ length: 25 }, (_, i) => `a${i}="x"`).join(' ') + '/>',
    '<workflow>' + '<a>'.repeat(20) + '</a>'.repeat(20) + '</workflow>',
    '<workflow>' + '<a/>'.repeat(WORKFLOW_MARKUP_LIMITS.nodes) + '</workflow>',
    '<workflow>' + 'a'.repeat(WORKFLOW_MARKUP_LIMITS.bytes) + '</workflow>'
  ]) assert.throws(() => parseWorkflowMarkup(source), errorCode, source.slice(0, 80));
});

test('lowering preserves inherited contracts, prose, scope and human policies without mutating the starter', async t => {
  const context = await fixture(t); const original = structuredClone(context.definition);
  const result = lowerWorkflowMarkup(example, context);
  assert.deepEqual(context.definition, original);
  assert.deepEqual(result.workflow.phases, ['demo-tagged-intake', 'demo-tagged-test', 'demo-tagged-repair', 'demo-tagged-close']);
  assert.deepEqual(result.workflow.plannedClaims, { mode: 'required', clausePhases: ['demo-tagged-intake'], owners: { 'demo-tagged-repair': 'demo-tagged-intake' } });
  assert.deepEqual(result.phases['demo-tagged-close'].inputs, ['demo-tagged-intake', 'demo-tagged-test', { phase: 'demo-tagged-repair', optional: true }]);
  assert.deepEqual(result.phases['demo-tagged-repair'].qualityCommands, original.phases['demo-instruction-repair'].qualityCommands);
  assert.equal(result.phases['demo-tagged-repair'].writeScope, 'source-and-artifact');
  assert.equal(result.phases['demo-tagged-test'].writeScope, 'artifact-only');
  assert.deepEqual(result.phases['demo-tagged-close'].approval.rejectTo, ['demo-tagged-repair']);
  assert.ok(result.skills.some(skill => skill.id === 'demo-tagged-repair-guidance' && /Keep the changed files/u.test(skill.instructions)));
  assert.deepEqual(result.attachments.find(item => item.skill === 'demo-tagged-repair-guidance'), { skill: 'demo-tagged-repair-guidance', workflow: 'demo-tagged', steps: ['demo-tagged-repair'] });
  for (const mapping of result.sourceMap) assert.ok(example.slice(mapping.start, mapping.end).startsWith('<'));
});

test('closed semantic grammar refuses ambiguous tags, discarded text, dangling dependencies and undeclared routing', async t => {
  const context = await fixture(t);
  const cases = [
    example.replace('version="1"', 'version="2"'),
    example.replace('version="1"', 'version="1" onclick="run()"'),
    example.replace('<description>Intake', '<script>Intake').replace('escalation.</description>', 'escalation.</script>'),
    example.replace('extends="demo-instruction-test-loop"', 'extends="missing"'),
    example.replace('id="demo-tagged-intake"', 'id="outside-intake"'),
    example.replace('from="demo-instruction-intake"', 'from="demo-instruction-test"'),
    example.replace('next="demo-tagged-close"', 'next="missing-checkpoint"'),
    example.replace('source="verdict"', 'source="test.outcome"'),
    example.replace('authority="quality-reviewers" on-reject', 'authority="human" on-reject'),
    example.replace('<skill ref="demo-tagged-check" />', '<skill ref="missing" />'),
    example.replace('<instruction>demo-tagged-evidence</instruction>', '<instruction>unknown</instruction>'),
    example.replace('<instruction>demo-tagged-evidence</instruction>', '`<instruction>demo-tagged-evidence</instruction>`'),
    example.replace('<skill ref="demo-tagged-check" />', '<skill ref="demo-tagged-check">ignored instructions</skill>'),
    example.replace('max-attempts="3"', 'max-attempts="0"'),
    example.replaceAll(' max-attempts="3"', ''),
    example.replace('<otherwise id="blocked"', '<when id="blocked"'),
    example.replace('next="demo-tagged-test" />', 'next="demo-tagged-repair" />'),
    example.replace('</workflow>', '<checkpoint id="setup-review" authority="human" /></workflow>'),
    example.replace('</workflow>', '<skill id="demo-tagged-unused" description="Unused">Do not drop me.</skill></workflow>'),
    example.replace('</workflow>', '<instruction id="demo-tagged-unused" description="Unused">Do not drop me.</instruction></workflow>')
  ];
  for (const source of cases) assert.throws(() => lowerWorkflowMarkup(source, context), errorCode);
});

test('compilation is deterministic and produces the dependency-complete normal bundle', async () => {
  const first = await compileWorkflowMarkup(example); const second = await compileWorkflowMarkup(example);
  assert.equal(first.status, 'portable-ready'); assert.equal(first.bundleSha256, second.bundleSha256);
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.deepEqual(first.bundle, second.bundle);
  assert.equal(first.bundle.kind, 'sflow-workflow-bundle');
  for (const kind of ['agent', 'skill', 'instruction', 'template']) assert.ok(first.bundle.assets.some(asset => asset.kind === kind));
  assert.equal(first.bundle.assets.filter(asset => asset.kind === 'agent').length, 4);
  assert.equal(first.bundle.assets.filter(asset => asset.kind === 'instruction').length, 3);
  assert.deepEqual(first.effects, { configurationChanged: false, storyChanged: false, approvalRecorded: false, bundleWritten: false });
  assert.equal(first.routeSimulation.status, 'passed');
  for (const kind of ['pass', 'repair', 'exhausted', 'unavailable-evidence', 'rejection']) assert.ok(first.routeSimulation.counts[kind] > 0);
});

test('normal import/export retains instructions, workflow-local guidance and native bounded routing', async t => {
  const { root } = await fixture(t); const { bundle } = await compileWorkflowMarkup(example);
  const plan = await planWorkflowImport(root, bundle); assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(root, bundle, { expectedPlanSha256: plan.planSha256 });
  const definition = await loadDefinition(root); const resolved = resolveWorkType(definition, 'demo-tagged');
  const workflow = { workItem: { id: 'EXAMPLE', workType: 'demo-tagged' } };
  const checker = await renderAgentSkills(root, workflow, resolved.phases[1], { agent: 'demo-tagged-checker' });
  for (const text of ['Compare against pinned screenshots', 'Record the tested revision', 'only authorized humans']) assert.ok(checker.text.includes(text));
  const repair = await renderAgentSkills(root, workflow, resolved.phases[2], { agent: 'demo-tagged-developer' });
  assert.ok(repair.text.includes('Keep the changed files')); assert.ok(!repair.text.includes('Compare against pinned screenshots'));
  const outside = await renderAgentSkills(root, { workItem: { id: 'OTHER', workType: 'demo-instruction-test-loop' } }, { id: 'demo-instruction-repair' }, { agent: 'demo-instruction-developer' });
  assert.ok(!outside.text.includes('Keep the changed files'));
  const reexport = await exportWorkflowBundle(root, ['demo-tagged']);
  assert.deepEqual(reexport.objects.story.workTypes['demo-tagged'], bundle.objects.story.workTypes['demo-tagged']);
  assert.deepEqual(reexport.assets.filter(item => ['skill', 'instruction'].includes(item.kind)), bundle.assets.filter(item => ['skill', 'instruction'].includes(item.kind)));
  const order = resolved.phases.map(phase => phase.id);
  for (const [value, target] of [['pass', 'demo-tagged-close'], ['repair', 'demo-tagged-repair'], ['blocked', 'demo-tagged-test']]) {
    const phase = resolved.phases[1]; const decision = resolved.decisions.find(item => item.after === phase.id);
    const state = { resolution: resolved, phaseOrder: order, phases: Object.fromEntries(resolved.phases.map(item => [item.id, { ...item, generation: 1, status: 'awaiting_approval', decisionInputs: { decision: decision.id, values: { verdict: value } } }])) };
    assert.equal(decisionOutcome(state, state.phases[phase.id]).target, target);
    if (value === 'blocked') {
      state.decisionRounds = { [decision.id]: { count: 3 } };
      assert.equal(decisionOutcome(state, state.phases[phase.id]).kind, 'pause');
    }
  }
});

test('native validation refuses rules outside values, missing authorities and routes that lose obligations', async () => {
  for (const source of [
    example.replace('equals="pass"', 'equals="invented-pass"'),
    example.replace('by="quality-reviewers"', 'by="unknown-group"'),
    example.replace(/\s*<omit responsibility="implement"[^>]+\/>/u, ''),
    example.replace('next="demo-tagged-close"', 'next="end"')
  ]) await assert.rejects(compileWorkflowMarkup(source));
});

test('loop and human-choice tags lower to native decisions, not executable markup', async t => {
  const context = await fixture(t);
  const loopSource = example.replace(/<decision id="demo-tagged-repair-result"[\s\S]*?<\/decision>/u,
    '<loop id="demo-tagged-until-ready" label="Return until ready" source="ready" values="yes no" goal="yes" back="demo-tagged-test" max-attempts="2" by="engineering-reviewers" />');
  const loop = lowerWorkflowMarkup(loopSource, context).workflow.decisions.find(item => item.id === 'demo-tagged-until-ready');
  assert.deepEqual(loop.goal, { ready: 'yes' }); assert.equal(loop.back, 'demo-tagged-test'); assert.equal(loop.maxRounds, 2);
  assert.equal((await compileWorkflowMarkup(loopSource)).routeSimulation.status, 'passed');
  const askSource = example.replace(/<decision id="demo-tagged-repair-result"[\s\S]*?<\/decision>/u,
    '<decision id="demo-tagged-human-route" kind="ask" label="Where next?" by="engineering-reviewers"><option id="retest" next="demo-tagged-test"/><option id="scope" next="demo-tagged-intake"/></decision>');
  const ask = lowerWorkflowMarkup(askSource, context).workflow.decisions.find(item => item.id === 'demo-tagged-human-route');
  assert.equal(ask.kind, 'ask'); assert.equal(ask.inputs, undefined); assert.equal(ask.maxRounds, undefined);
  assert.equal((await compileWorkflowMarkup(askSource)).routeSimulation.status, 'passed');
  assert.throws(() => lowerWorkflowMarkup(loopSource.replace('<loop id=', '<loop kind="ask" id='), context), errorCode);
  assert.throws(() => lowerWorkflowMarkup(example.replace('agent="demo-tagged-developer"', 'agent="demo-tagged-checker"'), context), errorCode);
});

test('one skill can be attached locally in several phases without duplicate attachment records', async () => {
  const source = example.replace('next="demo-tagged-test" />', 'next="demo-tagged-test"><skill ref="demo-tagged-check" /></phase>')
    .replace('<phase id="demo-tagged-test" label="Test" from="demo-instruction-test" agent="demo-tagged-checker">',
      '<phase id="demo-tagged-test" label="Test" from="demo-instruction-test" agent="demo-tagged-checker"><skill ref="demo-tagged-check" />');
  const result = await compileWorkflowMarkup(source);
  assert.equal(result.status, 'portable-ready');
  assert.deepEqual(result.bundle.workflowSkillAttachments.find(item => item.id === 'demo-tagged-check').phases, ['demo-tagged-intake', 'demo-tagged-test']);
});

test('output is exclusive, invalid sources cannot create files, and command operations never use models', async t => {
  const { root } = await fixture(t); const out = path.join(root, 'bundle.json');
  const first = await compileWorkflowMarkup(example, { out }); assert.equal(first.outputPath, out);
  const original = await readFile(out);
  await assert.rejects(compileWorkflowMarkup(example, { out }), { code: 'WORKFLOW_EXPORT_OUTPUT_EXISTS' });
  assert.deepEqual(await readFile(out), original);
  await assert.rejects(compileWorkflowMarkup('<script/>', { out: path.join(root, 'invalid.json') }));
  assert.ok(!(await readdir(root)).includes('invalid.json'));
  assert.equal(excludesActiveWorkspaceRouting('workflow', 'markup'), true);
  for (const [args, expected, classification] of [
    [['example'], 'example', 'read'], [['compile', '-'], 'compile', 'read'], [['compile', '-', '--out', out], 'write', 'mutation']
  ]) {
    const operation = resolveOperation({ requestedCommand: 'workflow', ...parseArgs(['workflow', 'markup', ...args]) });
    assert.equal(operation.id, `workflow.markup.${expected}`); assert.equal(operation.modelPolicy, 'never'); assert.equal(operation.classification, classification);
  }
});

test('actual CLI works outside any repository and rejects unsafe file and option inputs', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-markup-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workflow.xml'); await writeFile(file, example);
  const invoke = (args, input = '') => spawnSync(process.execPath, [CLI.pathname, 'workflow', 'markup', ...args], { cwd: directory, input, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_DISABLE_MODELS: '1' } });
  const result = invoke(['compile', '-', '--json'], example);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'portable-ready');
  const exampleResult = invoke(['example', '--json']); assert.equal(exampleResult.status, 0, exampleResult.stderr); assert.equal(JSON.parse(exampleResult.stdout).source, example);
  const link = path.join(directory, 'symlink.xml'); await symlink(file, link);
  for (const args of [['compile', link, '--json'], ['compile', directory, '--json'], ['compile', file, '--yes'],
    ['compile', file, '--out', 'one.json', '--out', 'two.json'], ['compile', file, '--json', '--json'], ['compile', file, 'extra'], ['example', '--out', 'output']]) {
    assert.notEqual(invoke(args).status, 0, args.join(' '));
  }
});
