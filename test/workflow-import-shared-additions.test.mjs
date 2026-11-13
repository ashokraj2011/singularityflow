/**
 * A workflow whose new steps a shipped agent drafts, and a shipped MCP server covers, imports into a
 * fresh repository [owner, 2026-11-13]. The bundle's agent and server differ from the repository's
 * only by the steps the import adds, so they are reused and those steps are added to them, exactly
 * as Workflow Studio adds a new step to an existing agent or server. Anything else that differs is
 * still a conflict.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';
import { applyWorkflowImport, exportWorkflowBundle, importPlanText, planWorkflowImport } from '../src/workflow-transfer.mjs';

process.env.NODE_ENV = 'test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const QA = '.github/agents/qa.agent.md';
const SHIPPED_QA_STEPS = 'reproduction,verify,verification,testing,test-run,visual-verification,conformance,release';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return root;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function committed(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Shared Additions Test');
  git(root, 'config', 'user.email', 'shared-additions@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initialize workflow configuration');
  return root;
}

function flow(root, ...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Shared Additions Test',
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(root, '.git', 'test-transfer-outbox'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
    }
  });
}

/**
 * The owner's workflow: intake → a copy of Testing that only reports → a copy of Run the tests, both
 * drafted by qa. Like the shipped Test run it changes no code, and says so, so it is valid as written.
 */
const OMITS = [
  ['scope', 'A QA report checks the product as it is; it defines no new requirements.'],
  ['plan', 'A QA report changes no code, so there is no change to plan.'],
  ['implement', 'A QA report changes no code; a failure it finds is fixed in a Story of its own.']
].map(([responsibility, reason]) => ({ responsibility, reason, authority: 'quality-reviewers' }));
async function qaReportSource(t, extra = []) {
  const source = await repository(t, 'sflow-shared-additions-source-');
  const plan = await planStudioChangeSet(source, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [
    { op: 'phase.create', id: 'testing-report', label: 'Testing report', copyOf: 'testing', changesCode: false, agent: 'qa',
      approval: { groups: ['quality-reviewers'], minimum: 1, rejectTo: ['testing-report'] } },
    { op: 'phase.create', id: 'test-gaps', label: 'Test gaps', copyOf: 'test-run', agent: 'qa' },
    { op: 'workflow.create', id: 'qa-report', label: 'QA report', phases: ['intake', 'testing-report', 'test-gaps'], omits: OMITS },
    ...extra
  ] }, { write: true });
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  return source;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** A hand-edited bundle with every digest recomputed, so only the edit itself is under test. */
function edited(bundle, edit) {
  const copy = structuredClone(bundle);
  edit(copy);
  for (const asset of copy.assets) {
    asset.size = Buffer.byteLength(asset.content, 'utf8');
    asset.sha256 = `sha256:${sha256(asset.content)}`;
  }
  delete copy.bundleSha256;
  copy.bundleSha256 = `sha256:${sha256(JSON.stringify(canonical(copy)))}`;
  return copy;
}
const carriedQa = (bundle) => bundle.assets.find((asset) => asset.kind === 'agent' && asset.id === 'qa');
const configuration = async (root) => YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
const subjects = (plan) => plan.unresolved.map((item) => item.subject ?? item.id).sort();

test('a workflow whose new steps a shipped agent drafts imports into a fresh repository: qa and playwright are reused and get the steps', async (t) => {
  const bundle = await exportWorkflowBundle(await qaReportSource(t), ['qa-report']);
  const target = await repository(t, 'sflow-shared-additions-target-');
  const qaBefore = await readFile(path.join(target, QA), 'utf8');
  const before = await configuration(target);

  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.added.filter((item) => item.kind.endsWith('-additions')), [
    { kind: 'agent-phase-additions', id: 'qa', path: QA, phases: ['testing-report', 'test-gaps'], defaultFor: ['testing-report', 'test-gaps'] },
    { kind: 'mcp-server-additions', id: 'playwright', phases: ['testing-report'], agents: [] }
  ]);
  assert.ok(plan.reused.some((item) => item.kind === 'agent' && item.id === QA));
  assert.ok(plan.reused.some((item) => item.kind === 'story.mcpServers' && item.id === 'playwright'));
  assert.deepEqual(plan.changedPaths, [QA, 'singularity/workflow.yml']);
  const text = importPlanText(plan, 'qa-report.json');
  assert.ok(text.includes('  Reuses agent qa and adds testing-report, test-gaps to it.'), text.join('\n'));
  assert.ok(text.includes('  Reuses MCP server playwright and adds testing-report to it.'), text.join('\n'));
  assert.ok(text.find((line) => line.startsWith('  Adds: ')).includes('steps test-gaps, testing-report'));
  assert.match(plan.addsText, /testing-report, test-gaps to agent qa · testing-report to MCP server playwright/u);
  assert.ok(!text.filter((line) => line.includes('Reuses')).some((line) => /sha256|[a-f0-9]{40}/u.test(line)), 'plain words, never a hash');

  const applied = await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(applied.status, 'imported');
  assert.deepEqual(applied.paths, [QA, 'singularity/workflow.yml']);
  // Only qa's two step lines change, each keeping every shipped step and its own `,` separator.
  assert.equal(await readFile(path.join(target, QA), 'utf8'), qaBefore.replaceAll(`"${SHIPPED_QA_STEPS}"`, `"${SHIPPED_QA_STEPS},testing-report,test-gaps"`));
  const after = await configuration(target);
  assert.deepEqual(after.mcpServers.playwright, bundle.objects.story.mcpServers.playwright, 'the server reads as the bundle has it');
  assert.ok(before.mcpServers.playwright.phases.every((phase) => after.mcpServers.playwright.phases.includes(phase)));
  assert.deepEqual(after.workTypes['qa-report'].phases, ['intake', 'testing-report', 'test-gaps']);
  for (const [id, workflow] of Object.entries(before.workTypes)) assert.deepEqual(after.workTypes[id], workflow, `shipped workflow ${id} is unchanged`);
  for (const [id, phase] of Object.entries(before.phases)) assert.deepEqual(after.phases[id], phase, `shipped step ${id} is unchanged`);
  const definition = await loadDefinition(target);
  assert.ok(definition.agents.qa.defaultFor.includes('testing-report') && definition.agents.qa.defaultFor.includes('test-gaps'));
  assert.ok(definition.agents.qa.defaultFor.includes('release'), 'qa keeps its shipped steps');

  // The same bundle again finds everything here: nothing to add, nothing to write.
  const again = await planWorkflowImport(target, bundle);
  assert.equal(again.status, 'ready', JSON.stringify(again.unresolved));
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.changedPaths, []);
});

test('the added steps go into the agent file\'s own list style, and a new agent the import brings is added to the server', async (t) => {
  const source = await qaReportSource(t, [
    { op: 'agent.create', id: 'gap-finder', label: 'Gap finder', description: 'Finds the tests a change is missing.', from: 'qa' },
    { op: 'phase.agent', phase: 'test-gaps', agent: 'gap-finder' }
  ]);
  // The new agent may use the browser, as one of the server's agents.
  const sourceConfiguration = await configuration(source);
  sourceConfiguration.mcpServers.playwright.agents.push('gap-finder');
  await writeFile(path.join(source, 'singularity/workflow.yml'), YAML.stringify(sourceConfiguration));
  const bundle = await exportWorkflowBundle(source, ['qa-report']);
  const target = await repository(t, 'sflow-shared-additions-style-');
  // This repository writes its lists with `, ` and single quotes; the added steps follow suit.
  const own = (await readFile(path.join(target, QA), 'utf8'))
    .replaceAll(`"${SHIPPED_QA_STEPS}"`, `'${SHIPPED_QA_STEPS.split(',').join(', ')}'`);
  await writeFile(path.join(target, QA), own);

  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.deepEqual(plan.added.filter((item) => item.kind.endsWith('-additions')), [
    { kind: 'agent-phase-additions', id: 'qa', path: QA, phases: ['testing-report', 'test-gaps'], defaultFor: ['testing-report'] },
    { kind: 'mcp-server-additions', id: 'playwright', phases: ['testing-report'], agents: ['gap-finder'] }
  ]);
  assert.ok(importPlanText(plan, 'qa-report.json').includes('  Reuses MCP server playwright and adds testing-report and agent gap-finder to it.'));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  const shipped = SHIPPED_QA_STEPS.split(',').join(', ');
  assert.equal(await readFile(path.join(target, QA), 'utf8'), own
    .replace(`sflow-phases: '${shipped}'`, `sflow-phases: '${shipped}, testing-report, test-gaps'`)
    .replace(`sflow-default-for: '${shipped}'`, `sflow-default-for: '${shipped}, testing-report'`));
  const definition = await loadDefinition(target);
  assert.ok(definition.agents['gap-finder'].defaultFor.includes('test-gaps'));
  assert.ok(definition.mcpServers.playwright.agents.includes('gap-finder'));
});

test('anything else that differs stays a conflict: the agent\'s body or tools, a step it lacks, another server field', async (t) => {
  const bundle = await exportWorkflowBundle(await qaReportSource(t), ['qa-report']);
  const target = await repository(t, 'sflow-shared-additions-conflicts-');
  const blocked = async (name, candidate, subject) => {
    const plan = await planWorkflowImport(target, candidate);
    assert.equal(plan.status, 'blocked', name);
    assert.ok(subjects(plan).includes(subject), `${name}: ${subjects(plan).join(', ')}`);
    const [kind, id] = subject.split(':');
    assert.ok(!plan.added.some((item) => item.kind === `${kind}-${kind === 'agent' ? 'phase-' : ''}additions` && item.id === id), name);
  };
  await blocked('an instruction added to qa', edited(bundle, (copy) => { carriedQa(copy).content += '\nAlso check the release notes.\n'; }), 'agent:qa');
  await blocked('a tool added to qa', edited(bundle, (copy) => {
    carriedQa(copy).content = carriedQa(copy).content.replace('tools: [read,', 'tools: [web, read,');
  }), 'agent:qa');
  await blocked('another playwright field', edited(bundle, (copy) => { copy.objects.story.mcpServers.playwright.required = true; }), 'mcp-server:playwright');
  // Figma still covers design-intake, so the bundle still carries the step.
  await blocked('a step playwright covers here dropped from it', edited(bundle, (copy) => {
    const server = copy.objects.story.mcpServers.playwright;
    server.phases = server.phases.filter((phase) => phase !== 'design-intake');
  }), 'mcp-server:playwright');
  // This repository's qa may also draft design-intake, a step the bundle carries and its qa does
  // not list: the bundle's qa lacks a step qa has here, which no added step explains.
  const file = path.join(target, QA);
  await writeFile(file, (await readFile(file, 'utf8')).replace(`sflow-phases: "${SHIPPED_QA_STEPS}"`, `sflow-phases: "${SHIPPED_QA_STEPS},design-intake"`));
  assert.ok(bundle.objects.story.phases['design-intake'] && !carriedQa(bundle).content.includes('design-intake'));
  await blocked('a step qa has here missing from the bundle\'s qa', bundle, 'agent:qa');
});

test('the CLI previews the additions in plain words, applies them, and --propose carries them to review', async (t) => {
  const source = await qaReportSource(t);
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-shared-additions-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bundleFile = path.join(base, 'qa-report.sflow-workflows.json');
  await exportWorkflowBundle(source, ['qa-report'], bundleFile);

  const local = committed(await repository(t, 'sflow-shared-additions-local-'));
  const preview = flow(local, 'workflow', 'import', bundleFile, '--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Workflow import preview: ready\./u);
  assert.match(preview.stdout, /Reuses agent qa and adds testing-report, test-gaps to it\./u);
  assert.match(preview.stdout, /Reuses MCP server playwright and adds testing-report to it\./u);
  const plan = JSON.parse(flow(local, 'workflow', 'import', bundleFile, '--dry-run', '--json').stdout);
  const applied = flow(local, 'workflow', 'import', bundleFile, '--confirm', plan.planSha256);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.match(await readFile(path.join(local, QA), 'utf8'), /sflow-default-for: ".*,release,testing-report,test-gaps"/u);
  const validated = flow(local, 'workflow', 'validate');
  assert.equal(validated.status, 0, validated.stderr + validated.stdout);

  // Through review: the proposal holds the same two edits, and this checkout is untouched.
  const root = committed(await repository(t, 'sflow-shared-additions-propose-'));
  const remote = path.join(base, 'authority.git');
  git(base, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'push', '-q', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config');
  git(root, 'remote', 'add', 'origin', remote);
  const reviewed = JSON.parse(flow(root, 'workflow', 'import', bundleFile, '--dry-run', '--propose', '--json').stdout);
  assert.equal(reviewed.status, 'ready', JSON.stringify(reviewed.unresolved));
  const proposed = flow(root, 'workflow', 'import', bundleFile, '--confirm', reviewed.planSha256, '--propose', '--json');
  assert.equal(proposed.status, 0, proposed.stderr + proposed.stdout);
  const proposal = JSON.parse(proposed.stdout);
  assert.equal(proposal.reviewRequired, true);
  const show = (file) => git(base, '--git-dir', remote, 'show', `${proposal.branch}:${file}`);
  assert.match(show(QA), /sflow-phases: ".*,release,testing-report,test-gaps"/u);
  assert.ok(YAML.parse(show('singularity/workflow.yml')).mcpServers.playwright.phases.includes('testing-report'));
  assert.equal(git(root, 'status', '--porcelain=v1'), '');
});
