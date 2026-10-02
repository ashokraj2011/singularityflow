import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const { WORKFLOW_STUDIO_SCRIPT, workflowStudioBody } = await import(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts'));
const { contentSecurityPolicy, page } = await import(path.join(packageRoot, 'apps/vscode/src/views/webview.ts'));
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Studio Tester' };

function run(command, args, cwd, input = '') {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** The page's pure logic, loaded the way the webview loads it but with no document to render into. */
function studioLogic() {
  const posted = [];
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener() {} };
  const document = { getElementById: () => null };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, document);
  return { logic: window.__workflowStudio, posted };
}

async function repository({ edit = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-page-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Studio Tester'], root); run('git', ['config', 'user.email', 'studio@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Studio\n');
  run(process.execPath, [bin, 'init'], root);
  if (edit) {
    const YAML = (await import('yaml')).default;
    const file = path.join(root, 'singularity/workflow.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    edit(document);
    await writeFile(file, document.toString());
  }
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

/** A workflow whose design step reads requirements only when a branch did not skip them. */
function decisionDemo(document) {
  document.setIn(['workTypes', 'decide-demo'], document.createNode({
    label: 'Decision demo', phases: ['intake', 'requirements', 'design', 'implementation-spec'],
    phaseOverrides: {
      requirements: { inputs: ['intake'] },
      design: { inputs: ['intake', { phase: 'requirements', optional: true }] },
      'implementation-spec': { inputs: ['intake', { phase: 'design', projection: 'approved-summary', preserve: ['Proposed design', 'Alternatives and decisions'] }] }
    },
    decisions: [{
      id: 'needs-requirements', after: 'intake', kind: 'branch', label: 'Does this need full requirements?',
      inputs: [{ name: 'risk', label: 'Risk', values: ['low', 'medium', 'high'] }],
      routes: [{ id: 'risky', label: 'Risky', when: { risk: ['medium', 'high'] }, to: 'requirements' }, { id: 'simple', label: 'Simple', to: 'design' }]
    }]
  }));
}

const check = (root, changeSet) => JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', 'apply', '--change-set', '-', '--dry-run', '--json'], root, JSON.stringify(changeSet)).stdout);

test('the page loads without a document and says nothing changed until something is edited', () => {
  const { logic, posted } = studioLogic();
  assert.equal(typeof logic.changeSetFrom, 'function');
  assert.deepEqual(posted, [], 'without its root element the page neither renders nor asks for a model');
  assert.equal(logic.kebab('Vendor Assessment!'), 'vendor-assessment');
  // Composed the way the panel composes it.
  const html = page('Workflow Studio', workflowStudioBody('nonce123'),
    contentSecurityPolicy({ cspSource: 'vscode-resource:' }, 'nonce123'), 'nonce123', WORKFLOW_STUDIO_SCRIPT);
  assert.match(html, /<div id="studio-root"/);
  assert.match(html, /script-src 'nonce-nonce123'/);
  assert.match(html, /<style nonce="nonce123">\s*\.studio\{/, 'the Studio stylesheet carries the nonce');
  assert.doesNotMatch(WORKFLOW_STUDIO_SCRIPT, /setAttribute\('style'/, 'the nonce-only CSP would drop style attributes');
});

test('edits made in the page become one change set the engine accepts', async () => {
  const root = await repository();
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  assert.deepEqual(logic.changeSetFrom(model, draft).changes, [], 'an untouched draft changes nothing');

  // A new agent, a new step it drafts, and a new workflow using an existing step and the new one.
  draft.agents['vendor-analyst'] = { id: 'vendor-analyst', label: 'Vendor analyst', description: 'Compares vendor options against the approved intake.', tools: ['read', 'search', 'edit', 'ask_user'], views: ['business'], instructions: 'Compare vendors in one table.', scope: 'repository', isNew: true, role: 'analyst' };
  draft.phases['vendor-analysis'] = { id: 'vendor-analysis', label: 'Vendor analysis', output: 'analysis', views: [], clarification: 'off', agent: 'vendor-analyst', usedBy: ['vendor-assessment'], isNew: true, approval: { group: 'product-approvers', minimum: 1 }, inputs: ['intake'] };
  draft.workflows['vendor-assessment'] = { id: 'vendor-assessment', label: 'Vendor assessment', description: '', phases: ['intake', 'vendor-analysis'], reworkLoops: [{ from: 'vendor-analysis', to: 'intake', maxAttempts: 3 }], isNew: true, installFrom: null };
  draft.steps['vendor-assessment'] = {
    intake: { approval: { group: 'product-approvers', minimum: 1 }, inputs: [] },
    'vendor-analysis': { approval: { group: 'product-approvers', minimum: 1 }, inputs: ['intake'] }
  };
  // The design step moves to another agent, and Feature's verification step needs two approvals.
  draft.phases.design.agent = 'product-owner';
  draft.steps.feature.verification.approval.minimum = 2;
  // A person joins an approval group.
  draft.groups['architecture-reviewers'].members.push({ name: 'Ada Lovelace', email: 'ada@example.com', githubLogin: null });

  const changeSet = logic.changeSetFrom(model, draft);
  assert.equal(changeSet.schema, 'sflow-studio-change-set@1');
  assert.deepEqual(changeSet.base, model.base);
  assert.deepEqual(changeSet.changes.map((change) => change.op).sort(), [
    'agent.create', 'group.update', 'phase.agent', 'phase.create', 'phase.update', 'workflow.create', 'workflow.update'
  ].sort());
  assert.deepEqual(changeSet.changes.find((change) => change.op === 'phase.update'), { op: 'phase.update', id: 'verification', workflow: 'feature', approval: { group: 'quality-reviewers', minimum: 2 } });
  assert.ok(changeSet.changes.some((change) => change.op === 'workflow.update' && change.id === 'vendor-assessment' && change.reworkLoops.length === 1));
  const words = changeSet.changes.map((change) => logic.describe(change, draft));
  assert.ok(words.includes('New step Vendor analysis, drafted by Vendor analyst'));
  assert.ok(words.some((line) => /is now drafted by Product owner$/.test(line)));

  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.files.map((file) => file.path).sort(), [
    '.github/agents/architect.agent.md', '.github/agents/product-owner.agent.md', '.github/agents/vendor-analyst.agent.md',
    'singularity/templates/common/vendor-analysis.md', 'singularity/workflow.yml'
  ]);
});

test('a step that is used by other workflows can be copied so this workflow chooses its own agent', async () => {
  const root = await repository();
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  // What "Use a copy in this workflow" leaves behind: a new step copying design, with its own agent.
  draft.phases['design-feature'] = { ...structuredClone(draft.phases.design), id: 'design-feature', label: 'Architecture and design (Feature)', isNew: true, copyOf: 'design', agent: 'product-owner', usedBy: ['feature'] };
  draft.workflows.feature.phases = draft.workflows.feature.phases.map((phase) => (phase === 'design' ? 'design-feature' : phase));
  draft.steps.feature['design-feature'] = draft.steps.feature.design;
  delete draft.steps.feature.design;
  for (const settings of Object.values(draft.steps.feature)) settings.inputs = settings.inputs.map((input) => (input === 'design' ? 'design-feature' : input));
  const changeSet = logic.changeSetFrom(model, draft);
  assert.ok(changeSet.changes.some((change) => change.op === 'phase.create' && change.copyOf === 'design' && change.agent === 'product-owner'));
  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  const workflow = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  assert.doesNotMatch(workflow, /design-feature/, 'a check writes nothing');
});

test('"Use a copy in this workflow" keeps every input setting, so a branch that skips an optional input still checks', async () => {
  const YAML = (await import('yaml')).default;
  const root = await repository({ edit: decisionDemo });
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  assert.deepEqual(draft.steps['decide-demo'].design.inputs, ['intake', 'requirements'], 'the page keeps only step IDs');
  const id = logic.copyStep(model, draft, 'decide-demo', 'design');
  assert.equal(id, 'design-decide-demo');
  assert.equal(logic.copyStep(model, draft, 'decide-demo', 'design'), null, 'a workflow gets one copy of a step');
  assert.deepEqual(draft.workflows['decide-demo'].phases, ['intake', 'requirements', 'design-decide-demo', 'implementation-spec']);
  assert.equal(draft.workflows['decide-demo'].decisions[0].routes[1].to, 'design-decide-demo', 'the branch now skips to the copy');
  const changeSet = logic.changeSetFrom(model, draft);
  const create = changeSet.changes.find((change) => change.op === 'phase.create');
  assert.deepEqual([create.copyOf, create.copyFromWorkflow, create.inputs], ['design', 'decide-demo', ['intake', 'requirements']], 'the copy names the workflow whose settings it keeps');

  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  run(process.execPath, [bin, 'workflow', 'studio', 'apply', '--change-set', '-', '--json'], root, JSON.stringify(changeSet));
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(after.phases[id].inputs, ['intake', { phase: 'requirements', optional: true }]);
  assert.deepEqual(after.workTypes['decide-demo'].phaseOverrides['implementation-spec'].inputs[1],
    { phase: id, projection: 'approved-summary', preserve: ['Proposed design', 'Alternatives and decisions'] }, 'the step reading the copy keeps its summary settings');
  run(process.execPath, [bin, 'workflow', 'validate', 'decide-demo'], root);
});

test('copies keep their input settings when the workflow is a new duplicate and when two copies read each other', async () => {
  const YAML = (await import('yaml')).default;
  const root = await repository({ edit: decisionDemo });
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();

  // Duplicated in the page, then a step copied in the duplicate before either exists in the file.
  let draft = logic.initialDraft(model);
  draft.workflows['decide-copy'] = { ...structuredClone(draft.workflows['decide-demo']), id: 'decide-copy', label: 'Decide copy', isNew: true, copyOf: 'decide-demo' };
  draft.steps['decide-copy'] = structuredClone(draft.steps['decide-demo']);
  logic.copyStep(model, draft, 'decide-copy', 'design');
  let plan = check(root, logic.changeSetFrom(model, draft));
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));

  // Design copied first, then requirements: the first copy reads the second, and the optional flag
  // moves with it.
  draft = logic.initialDraft(model);
  logic.copyStep(model, draft, 'decide-demo', 'design');
  logic.copyStep(model, draft, 'decide-demo', 'requirements');
  const changeSet = logic.changeSetFrom(model, draft);
  assert.deepEqual(changeSet.changes.filter((change) => change.op === 'phase.create').map((change) => change.id), ['design-decide-demo', 'requirements-decide-demo']);
  plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  run(process.execPath, [bin, 'workflow', 'studio', 'apply', '--change-set', '-', '--json'], root, JSON.stringify(changeSet));
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(after.phases['design-decide-demo'].inputs, ['intake', { phase: 'requirements-decide-demo', optional: true }]);
  assert.deepEqual(after.workTypes['decide-demo'].decisions[0].routes.map((route) => route.to), ['requirements-decide-demo', 'design-decide-demo']);
});

test('a copy runs in its workflow exactly as the step it replaces, in each packaged workflow it is tried in', async () => {
  const { cp } = await import('node:fs/promises');
  const { loadDefinition, resolveWorkType } = await import(path.join(packageRoot, 'src/config.mjs'));
  const { fastPathProfile } = await import(path.join(packageRoot, 'src/fast-path.mjs'));
  const { planStudioChangeSet } = await import(path.join(packageRoot, 'src/workflow-studio.mjs'));
  const root = await repository();
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const before = await loadDefinition(root);
  const { logic } = studioLogic();
  // Every value naming the step should name the copy, except values that only look like a step ID
  // (an artifact kind, a knowledge view, a comparison identifier, an artifact-set role, a fixed
  // policy key) and what a copy changes on purpose (its name and artifact path).
  const rename = (value, from, to) => (Array.isArray(value) ? value.map((entry) => rename(entry, from, to))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key === from ? to : key, rename(entry, from, to)]))
      : value === from ? to : value);
  const differences = (a, b, at = '', out = []) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    if (a && b && typeof a === 'object' && typeof b === 'object') { for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], `${at}.${key}`, out); return out; }
    out.push(at);
    return out;
  };
  const expected = [/^\.phases\.\d+\.(label|defaultTemplate|artifact\.(path|kind)|inputs\.\d+\.path|worldModel\.views\.\d+|comparison\.identifiers\.\d+)$/,
    /^\.(artifactSets|harnessImports|verification|architectureIntent)\b/];
  // Each covers a different way a copy used to lose its settings: per-workflow template, write scope,
  // tool evidence and test evidence; summary inputs in both directions and the fast path; planned
  // claims; design sources; an artifact set's file name; global lists that allow the step.
  for (const [workflowId, phaseId] of [['spec-code-test-loop', 'testing'], ['spec-driven-standard', 'verification'], ['feature', 'implementation'],
    ['figma-mobile', 'conformance'], ['reference-driven-build', 'release'], ['classic-delivery', 'intake'], ['feature', 'design']]) {
    const draft = logic.initialDraft(model);
    const copyId = logic.copyStep(model, draft, workflowId, phaseId);
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-copy-'));
    await cp(root, scratch, { recursive: true });
    const plan = await planStudioChangeSet(scratch, logic.changeSetFrom(model, draft), { write: true }).catch((error) => ({ valid: false, problems: [error.message] }));
    assert.equal(plan.valid, true, `${workflowId} ${phaseId}: ${JSON.stringify(plan.problems)}`);
    const after = await loadDefinition(scratch);
    const changed = differences(rename(resolveWorkType(before, workflowId), phaseId, copyId), resolveWorkType(after, workflowId))
      .filter((at) => !expected.some((pattern) => pattern.test(at)));
    assert.deepEqual(changed, [], `${workflowId}: copying ${phaseId} changed how the workflow runs`);
    assert.deepEqual(fastPathProfile(after, workflowId), rename(fastPathProfile(before, workflowId), phaseId, copyId), `${workflowId}: fast path`);
    // Shared lists outside the workflow (its document steps are compared with the rest of it above).
    const allowLists = (definition) => new Map([
      ...Object.entries(definition.architectureIntent ?? {}).map(([key, value]) => [`architectureIntent.${key}`, value]),
      ...Object.entries(definition.mcpServers ?? {}).map(([id, server]) => [`mcpServers.${id}.phases`, server.phases])
    ]);
    const allowed = allowLists(after);
    for (const [name, list] of allowLists(before)) {
      if (Array.isArray(list) && list.includes(phaseId)) assert.ok(allowed.get(name).includes(copyId), `${workflowId}: ${name} allows ${copyId} as it allows ${phaseId}`);
    }
  }
});

test('the publish command follows the authority the model came from', async () => {
  const { studioPublishArgs, STUDIO_MODEL_ARGS, STUDIO_PREVIEW_ARGS } = await import(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts'));
  assert.deepEqual(studioPublishArgs({ kind: 'working-tree' }), ['workflow', 'studio', 'apply', '--change-set', '-', '--json']);
  assert.deepEqual(studioPublishArgs(null), ['workflow', 'studio', 'apply', '--change-set', '-', '--json']);
  assert.deepEqual(studioPublishArgs({ kind: 'approved-configuration-ref', commit: 'a'.repeat(40), remoteFingerprint: 'sha256:abc', sourceCommit: 'b'.repeat(40) }), [
    'workflow', 'studio', 'apply', '--change-set', '-', '--propose',
    '--expected-authority-kind', 'approved-configuration-ref', '--expected-authority-commit', 'a'.repeat(40),
    '--expected-authority-remote-fingerprint', 'sha256:abc', '--expected-authority-source-commit', 'b'.repeat(40), '--json'
  ]);
  assert.throws(() => studioPublishArgs({ kind: 'verified-state-mirror' }), /recovery mirror/);
  assert.deepEqual([...STUDIO_MODEL_ARGS], ['workflow', 'studio', '--json']);
  assert.ok(STUDIO_PREVIEW_ARGS.includes('--dry-run'));
});

test('the host publishes through a proposal bound to the authority it read, and never writes configuration itself', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio.ts'), 'utf8');
  assert.match(source, /args = studioPublishArgs\(this\.model\?\.authority\)/, 'publishing follows the authority the model was read from');
  assert.match(source, /showWarningMessage\(\s*`Publish \$\{count\}/, 'a person confirms before anything is published');
  assert.doesNotMatch(source, /writeFile|fs\.promises/, 'the extension never writes configuration files');
  const extension = await readFile(path.join(packageRoot, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.openWorkflowStudio': async \(\) => \{\s*const \{ WorkflowStudioPanel \} = lazyPanels\(\);/);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'apps/vscode/package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.openWorkflowStudio' && /Workflow Studio/.test(entry.title)));
});

test('decisions are edited on the board and checked by the engine with its own people and dependency rules', async () => {
  const root = await repository();
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  const feature = draft.workflows.feature;
  assert.deepEqual(feature.decisions, [], 'a packaged workflow starts without decisions');
  const loop = model.workflows.flatMap((workflow) => workflow.reworkLoops).find((entry) => entry.resetOnPhase);
  if (loop) assert.ok(loop.resetOnPhase, 'a send-back rule keeps the step that resets its count');

  // An ask after requirements may finish the Story early; a loop after verification goes back to code.
  const ask = logic.newDecision(feature, 'requirements', 'ask');
  assert.deepEqual(ask.routes.map((route) => route.to), ['next', 'end']);
  const repeat = logic.newDecision(feature, 'verification', 'loop');
  assert.equal(repeat.back, 'implementation');
  feature.decisions = [ask, repeat];
  assert.deepEqual(logic.reachOf(feature, 'requirements', 'end').skips, ['design', 'implementation-spec', 'implementation', 'verification', 'conformance']);
  assert.match(logic.decisionLines(feature, repeat)[0], /^↩ implementation until Done is yes \(at most 3\)$/);
  const changeSet = logic.changeSetFrom(model, draft);
  const update = changeSet.changes.find((change) => change.op === 'workflow.update' && change.id === 'feature');
  assert.deepEqual(update.decisions.map((decision) => decision.kind), ['ask', 'loop']);
  assert.match(logic.describe(update, draft), /decisions changed/);
  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  const diff = plan.files.find((file) => file.path === 'singularity/workflow.yml').diff;
  assert.match(diff, /\+\s+decisions:/);
  assert.match(diff, /\+\s+kind: loop/);

  // A branch that skips requirements would strand design, which reads it: the engine refuses it.
  const branch = logic.newDecision(feature, 'intake', 'branch');
  branch.routes[1].to = 'design';
  feature.decisions = [branch];
  const refused = check(root, logic.changeSetFrom(model, draft));
  assert.equal(refused.valid, false);
  assert.ok(refused.problems.some((problem) => /skips 'requirements', which 'design' reads/.test(problem.message)), JSON.stringify(refused.problems));

  // Removing a step drops the decisions that used it; converting a decision keeps its name.
  feature.decisions = [logic.newDecision(feature, 'requirements', 'ask')];
  assert.deepEqual(logic.pruneDecisions(feature, 'requirements'), ['What should happen next?']);
  assert.deepEqual(feature.decisions, []);
  const converted = logic.convertDecision(feature, { ...logic.newDecision(feature, 'intake', 'branch'), label: 'Risky?' }, 'loop');
  assert.equal(converted.label, 'Risky?');
  assert.deepEqual(converted.goal, { outcome: 'yes' });
});

test('library imports queued in the page become engine operations the engine checks from staged bytes', async () => {
  const root = await repository();
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  assert.deepEqual(model.marketplaces, []);
  assert.deepEqual(model.imports, []);
  assert.ok(model.agents.find((agent) => agent.id === 'architect').resources, 'agents carry the resources their tables name');
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  assert.deepEqual(draft.imports, []);
  // The engine stages exactly what it previewed; the page only names the hash.
  const { stageImport } = await import(path.join(packageRoot, 'src/asset-import.mjs'));
  const bytes = Buffer.from('# Security review\n\n- Check every entry point.\n');
  const staged = await stageImport(root, { bytes, source: { kind: 'url', url: 'https://skills.example.org/s.md', resolvedUrl: 'https://skills.example.org/s.md' } });
  draft.imports.push({ op: 'import.skill', agent: 'architect', id: 'security-review', source: 'https://skills.example.org/s.md', sha256: staged.sha256, phases: ['design'], optional: false, replace: false });
  draft.imports.push({ op: 'marketplace.add', id: 'acme', label: 'Acme', index: 'https://catalog.example.org/index.json', allowedOrigins: ['https://cdn.example.org'] });
  const changeSet = logic.changeSetFrom(model, draft);
  assert.deepEqual(changeSet.changes.map((change) => change.op), ['import.skill', 'marketplace.add']);
  assert.equal(logic.describe(changeSet.changes[0], draft), 'Skill security-review for Architect in Architecture and design, from https://skills.example.org/s.md');
  assert.equal(logic.describe(changeSet.changes[1], draft), 'Trust marketplace Acme');
  assert.equal(logic.importKey(changeSet.changes[0]), 'import.skill:architect/security-review');
  assert.equal(logic.linkId('https://example.org/team/security-review/SKILL.md'), 'security-review');
  assert.equal(logic.linkId('https://example.org/templates/threat-model.md'), 'threat-model');
  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.files.map((file) => file.path).sort(), [
    '.github/agents/architect.agent.md', 'singularity/agents.lock.yml', 'singularity/imports.lock.yml',
    'singularity/imports/agents/architect/skill-security-review.md', 'singularity/workflow.yml'
  ]);
});

test('the host previews, browses and checks imports only through engine reads', async () => {
  const host = await readFile(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio.ts'), 'utf8');
  assert.match(host, /this\.client\.run<Record<string, unknown>>\(\['import', 'preview', reference, '--as', as, \.\.\.mcpFlags, '--json'\]\)/);
  // An MCP server is started only after the person allows it, with the engine's own description.
  assert.match(host, /if \(reference\.startsWith\('mcp:'\)\) \{[\s\S]{0,200}if \(!\(await this\.mcpConsentFor\(serverId\)\)\) return;[\s\S]{0,40}mcpFlags\.push\('--launch'\)/);
  assert.match(host, /\['mcp', 'sources', serverId, '--json'\]\)[\s\S]{0,400}Repeat with --launch[\s\S]{0,600}showWarningMessage\(`Allow MCP server/);
  assert.match(host, /if \(!id \|\| !\(await this\.mcpConsentFor\(id\)\)\) return;[\s\S]{0,120}\['mcp', 'sources', id, '--launch', '--json'\]/);
  assert.match(host, /'Add host entry'\);[\s\S]{0,120}if \(confirmed !== 'Add host entry'\) return;[\s\S]{0,200}\['mcp', 'host', 'add', id, '--json'\]/);
  assert.match(host, /this\.client\.run<Record<string, unknown>>\(\['marketplace', 'browse', id, '--json'\]\)/);
  assert.match(host, /this\.client\.run<Record<string, unknown>>\(\['imports', 'check', '--json'\]\)/);
  assert.match(host, /reference\.startsWith\('https:\/\/'\) \|\| reference\.startsWith\('market:'\) \|\| reference\.startsWith\('mcp:'\)/, 'only links, marketplace entries and MCP items are previewed');
  assert.doesNotMatch(host, /writeFile|fs\.promises/);
});

test('duplicating a workflow keeps its per-step settings on the copy and leaves the original and shared steps alone', async () => {
  const YAML = (await import('yaml')).default;
  const root = await repository();
  const before = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  // Exactly what "Duplicate" then "Shape the steps" leaves in the draft.
  const source = draft.workflows.feature;
  draft.workflows['feature-copy'] = { ...JSON.parse(JSON.stringify(source)), id: 'feature-copy', label: 'Feature copy', isNew: true, installFrom: null, copyOf: 'feature' };
  draft.steps['feature-copy'] = JSON.parse(JSON.stringify(draft.steps.feature));
  let changeSet = logic.changeSetFrom(model, draft);
  assert.deepEqual(changeSet.changes.map((change) => change.op), ['workflow.create'], 'an unedited copy is one change');
  assert.equal(changeSet.changes[0].copyOf, 'feature');
  assert.match(logic.describe(changeSet.changes[0], draft), /^New workflow Feature copy, a copy of Feature: /);
  // Without copyOf (an older page), the per-step settings still land on the copy, never the shared step.
  delete draft.workflows['feature-copy'].copyOf;
  const legacy = logic.changeSetFrom(model, draft);
  assert.ok(legacy.changes.some((change) => change.op === 'phase.update' && change.workflow === 'feature-copy'));
  const legacyPlan = check(root, legacy);
  assert.equal(legacyPlan.valid, true, JSON.stringify(legacyPlan.problems));
  draft.workflows['feature-copy'].copyOf = 'feature';
  changeSet = logic.changeSetFrom(model, draft);
  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  run(process.execPath, [bin, 'workflow', 'studio', 'apply', '--change-set', '-', '--json'], root, JSON.stringify(changeSet));
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(after.workTypes['feature-copy'].phases, before.workTypes.feature.phases);
  assert.deepEqual(after.workTypes.feature, before.workTypes.feature, 'the original workflow is unchanged');
  assert.deepEqual(after.phases, before.phases, 'shared steps keep their own settings');
  // The copy is the whole source workflow under its new name: sign-off details, inputs, templates,
  // send-back rules and claims included.
  const { label: copyLabel, ...copy } = after.workTypes['feature-copy'];
  const { label: _label, description: _description, ...original } = before.workTypes.feature;
  assert.equal(copyLabel, 'Feature copy');
  assert.deepEqual(copy, original);
});

test('a step change for a workflow that does not exist is refused instead of creating one', async () => {
  const root = await repository();
  const plan = check(root, { schema: 'sflow-studio-change-set@1', changes: [{ op: 'phase.update', id: 'design', workflow: 'ghost', approval: 'none' }] });
  assert.equal(plan.valid, false);
  assert.equal(plan.problems[0].code, 'STUDIO_WORKFLOW_UNKNOWN');
});

test('the canvas lays steps out in order and draws send-back rules and decision routes around them', () => {
  const { logic } = studioLogic();
  const workflow = {
    phases: ['intake', 'design', 'build', 'review'],
    reworkLoops: [{ from: 'build', to: 'intake', maxAttempts: 2 }],
    decisions: [
      { id: 'risk', after: 'design', kind: 'branch', label: 'How risky?', inputs: [{ name: 'risk', label: 'Risk', values: ['high', 'low'] }],
        routes: [{ id: 'rule-1', label: 'Risk is low', when: { risk: 'low' }, to: 'review' }, { id: 'otherwise', label: 'Otherwise', to: 'next' }] },
      { id: 'again', after: 'review', kind: 'loop', label: 'Repeat until done', inputs: [{ name: 'done', label: 'Done', values: ['yes', 'no'] }],
        goal: { done: 'yes' }, back: 'build', maxRounds: 3 }
    ]
  };
  const layout = logic.canvasLayout(workflow);
  assert.deepEqual(layout.nodes.map((node) => node.id), workflow.phases, 'steps keep the workflow order');
  const xs = layout.nodes.map((node) => node.x);
  assert.ok(xs.every((x, index) => index === 0 || x > xs[index - 1]), 'left to right');
  assert.ok(xs[2] - xs[1] > xs[1] - xs[0], 'a step followed by a decision leaves room for its diamond');
  assert.ok(layout.finishX > xs[3], 'the Story finishes after the last step');

  const next = layout.edges.filter((edge) => edge.kind === 'next');
  assert.deepEqual(next.map((edge) => [edge.from, edge.to]), [[0, 1], [1, 2], [2, 3], [3, 4]], 'each step leads to the next, the last to Finish');
  assert.equal(next[1].decision, 'risk', 'the diamond sits on the arrow after its step');
  assert.equal(next[3].decision, 'again');

  const skip = layout.edges.find((edge) => edge.kind === 'decision-skip');
  assert.deepEqual([skip.from, skip.to, skip.depth, skip.label], [1, 3, 1, 'Risk is low'], 'a route that skips ahead runs above the row');
  assert.ok(!layout.edges.some((edge) => edge.label === 'Otherwise'), 'a route to the next step follows the arrow already drawn');

  const below = layout.edges.filter((edge) => edge.kind === 'send-back' || edge.kind === 'decision-back');
  assert.deepEqual(below.map((edge) => [edge.kind, edge.from, edge.to, edge.depth]), [['send-back', 2, 0, 1], ['decision-back', 3, 2, 2]],
    'send-back rules and routes that go back run below, one lane each');
  assert.equal(below[0].label, 'If rejected, back to intake');
  assert.equal(below[1].label, 'Until Done is yes');
  assert.ok(layout.rowY > 40, 'the row moves down to make room for routes above it');
  assert.ok(layout.height > layout.rowY + 124 + 2 * 26, 'and the canvas grows for the lanes below it');

  const plain = logic.canvasLayout({ phases: ['intake'], reworkLoops: [], decisions: [] });
  assert.equal(plain.rowY, 40, 'with nothing above, the row starts at the padding');
  assert.deepEqual(plain.edges.map((edge) => edge.kind), ['next']);
});

test('a drafting skill chosen in the page becomes a per-workflow change, and a copy takes it along', async () => {
  const root = await repository();
  const model = JSON.parse(run(process.execPath, [bin, 'workflow', 'studio', '--json'], root).stdout);
  const { logic } = studioLogic();
  assert.ok(model.choices.authoringSkills.some((choice) => choice.id === 'sf-design'));
  const draft = logic.initialDraft(model);
  assert.equal(draft.steps.feature.design.authoringSkill, null, 'automatic until a skill is chosen');

  draft.steps.feature.design.authoringSkill = 'sf-design';
  let changeSet = logic.changeSetFrom(model, draft);
  assert.deepEqual(changeSet.changes, [{ op: 'phase.update', id: 'design', workflow: 'feature', authoringSkill: 'sf-design' }]);
  assert.equal(logic.describe(changeSet.changes[0], draft), 'Architecture and design: drafting skill changed in Feature');
  assert.equal(check(root, changeSet).valid, true);

  // "Use a copy in this workflow": the copy is created with the skill it had in that workflow.
  const copy = logic.initialDraft(model);
  copy.phases['design-feature'] = { ...structuredClone(copy.phases.design), id: 'design-feature', label: 'Design (Feature)', isNew: true, copyOf: 'design', usedBy: ['feature'], authoringSkill: 'sf-design' };
  copy.workflows.feature.phases = copy.workflows.feature.phases.map((id) => (id === 'design' ? 'design-feature' : id));
  copy.steps.feature['design-feature'] = { ...structuredClone(copy.steps.feature.design), authoringSkill: 'sf-design', authoringSkillSetByWorkflow: false };
  delete copy.steps.feature.design;
  // As the page's copy does: later steps read the copy, and send-back rules aim at it.
  for (const settings of Object.values(copy.steps.feature)) settings.inputs = settings.inputs.map((input) => (input === 'design' ? 'design-feature' : input));
  copy.workflows.feature.reworkLoops = copy.workflows.feature.reworkLoops.map((loop) => ({ ...loop, from: loop.from === 'design' ? 'design-feature' : loop.from, to: loop.to === 'design' ? 'design-feature' : loop.to }));
  changeSet = logic.changeSetFrom(model, copy);
  const create = changeSet.changes.find((change) => change.op === 'phase.create');
  assert.deepEqual([create.id, create.copyOf, create.authoringSkill], ['design-feature', 'design', 'sf-design']);
  assert.match(logic.describe(create, copy), /with \/sf-design$/);
  assert.equal(check(root, changeSet).valid, true, JSON.stringify(check(root, changeSet).problems));
});

test('copied step drafts retain effective workflow policy and save explicit automatic and empty edits', async () => {
  const YAML = (await import('yaml')).default;
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  const apply = (changes) => planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes }, { write: true });
  await apply([
    { op: 'phase.create', id: 'copy-input', label: 'Copy input', agent: 'architect', approval: 'none' },
    { op: 'phase.create', id: 'copy-source', label: 'Copy source', agent: 'architect', approval: 'none', inputs: ['copy-input'], views: ['business'], authoringSkill: 'sf-design' },
    ...['copy-one', 'copy-two'].map((id) => ({ op: 'workflow.create', id, label: id, phases: ['copy-input', 'copy-source'] }))
  ]);
  const file = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(file, 'utf8'));
  configuration.workTypes['copy-one'].phaseOverrides = { 'copy-source': {
    authoringSkill: null, generation: { task: 'analyze' }, clarification: { mode: 'required' },
    worldModel: { views: ['security'], depth: 'deep' }, artifact: { minimumBytes: 345 },
    approval: { authorities: ['architecture-reviewers', 'product-approvers'], minimum: 1 }
  } };
  configuration.workTypes['copy-one'].templateOverrides = { 'copy-source': 'common/copy-input.md' };
  await writeFile(file, YAML.stringify(configuration));
  const model = await buildStudioModel(root);
  const { logic } = studioLogic();
  const draft = logic.initialDraft(model);
  draft.phases['copy-result'] = logic.copiedPhaseDraft(model, draft, 'copy-one', 'copy-source', 'copy-result');
  assert.deepEqual([draft.phases['copy-result'].output, draft.phases['copy-result'].views, draft.phases['copy-result'].clarification], ['analysis', ['security'], 'required']);
  draft.workflows['copy-one'].phases = ['copy-input', 'copy-result'];
  draft.steps['copy-one']['copy-result'] = { ...structuredClone(draft.steps['copy-one']['copy-source']), inputs: [], authoringSkill: null };
  delete draft.steps['copy-one']['copy-source'];
  draft.phases['copy-result'].output = 'document';
  draft.phases['copy-result'].views = [];
  draft.phases['copy-result'].clarification = 'off';
  const changeSet = logic.changeSetFrom(model, draft);
  const created = changeSet.changes.find((change) => change.op === 'phase.create');
  assert.equal(created.copyFromWorkflow, 'copy-one');
  assert.equal(created.authoringSkill, null);
  assert.equal(created.clarification, 'off');
  await planStudioChangeSet(root, changeSet, { write: true });
  const after = await buildStudioModel(root);
  const copied = after.workflows.find((workflow) => workflow.id === 'copy-one').steps.find((phase) => phase.id === 'copy-result');
  assert.deepEqual([copied.output, copied.inputs, copied.authoringSkill, copied.clarification, copied.views], ['document', [], null, 'off', []]);
  const saved = YAML.parse(await readFile(file, 'utf8'));
  assert.equal(saved.phases['copy-result'].artifact.minimumBytes, 345, 'unshown effective artifact policy survives');
  assert.equal(saved.phases['copy-result'].worldModel.depth, 'deep', 'clearing views preserves other world-model policy');
  assert.equal(saved.phases['copy-result'].defaultTemplate, 'common/copy-input.md');
  assert.deepEqual(saved.phases['copy-result'].approval.authorities, ['architecture-reviewers', 'product-approvers'], 'the unchanged sign-off picker does not discard additional authorities');
  assert.equal(saved.phases['copy-source'].authoringSkill, 'sf-design', 'the shared source remains unchanged');
  assert.deepEqual(saved.phases['copy-source'].inputs, ['copy-input']);
});

test('new steps save required clarification and shared steps can clear every inherited input', async () => {
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  const apply = (changes) => planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes }, { write: true });
  await apply([
    { op: 'phase.create', id: 'clear-input', label: 'Clear input', agent: 'architect', approval: 'none' },
    { op: 'phase.create', id: 'clear-source', label: 'Clear source', agent: 'architect', approval: 'none', inputs: ['clear-input'] },
    ...['clear-one', 'clear-two', 'clear-three'].map((id) => ({ op: 'workflow.create', id, label: id, phases: ['clear-input', 'clear-source'] })),
    { op: 'phase.update', id: 'clear-source', workflow: 'clear-two', approval: 'none' }
  ]);
  let model = await buildStudioModel(root);
  const { logic } = studioLogic();
  let draft = logic.initialDraft(model);
  draft.phases['required-step'] = { id: 'required-step', label: 'Required step', output: 'document', views: [], clarification: 'required', agent: 'architect', isNew: true, usedBy: ['clear-one'], approval: { group: null, minimum: 1 }, inputs: [] };
  draft.workflows['clear-one'].phases.push('required-step');
  draft.steps['clear-one']['required-step'] = { approval: { group: null, minimum: 1 }, inputs: [], authoringSkill: null };
  for (const id of ['clear-one', 'clear-two']) {
    draft.steps[id]['clear-source'].inputs = [];
    draft.workflows[id].phases = draft.workflows[id].phases.filter((phase) => phase !== 'clear-input');
  }
  const changeSet = logic.changeSetFrom(model, draft);
  assert.equal(changeSet.changes.find((change) => change.id === 'required-step').clarification, 'required');
  await planStudioChangeSet(root, changeSet, { write: true });
  model = await buildStudioModel(root);
  assert.equal(model.phases.find((phase) => phase.id === 'required-step').clarification, 'required');
  for (const id of ['clear-one', 'clear-two']) {
    assert.deepEqual(model.workflows.find((workflow) => workflow.id === id).steps.find((phase) => phase.id === 'clear-source').inputs, []);
  }
  assert.deepEqual(model.workflows.find((workflow) => workflow.id === 'clear-three').steps.find((phase) => phase.id === 'clear-source').inputs, ['clear-input']);
  draft = logic.initialDraft(model);
  assert.deepEqual(logic.changeSetFrom(model, draft).changes, [], 'a reload has no phantom changes');
});

/**
 * The page with a model loaded the way the host sends it, so the inspector's own draft operations
 * run against it. Rendering a control needs a document; nothing else does.
 */
function loadedStudio(model, document = { getElementById: () => null }) {
  const listeners = {};
  const window = { __sfVscode: { postMessage() {} }, addEventListener(type, listener) { listeners[type] = listener; } };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, document);
  listeners.message({ data: { type: 'studio.model', model } });
  return window.__workflowStudio;
}

test('a step\'s new output sends a skill that cannot draft it back to automatic once, and changing it back restores it', async () => {
  const YAML = (await import('yaml')).default;
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'phase.create', id: 'brief-input', label: 'Brief input', agent: 'architect', approval: 'none' },
    { op: 'phase.create', id: 'brief', label: 'Brief', agent: 'architect', approval: 'none', inputs: ['brief-input'], authoringSkill: 'sf-release' },
    ...['brief-one', 'brief-two', 'brief-own'].map((id) => ({ op: 'workflow.create', id, label: id, phases: ['brief-input', 'brief'] })),
    { op: 'phase.update', id: 'brief', workflow: 'brief-own', authoringSkill: 'sf-design' }
  ] }, { write: true });
  const model = await buildStudioModel(root);
  const page = loadedStudio(model);
  const state = page.state();
  page.setStepOutput('brief', 'analysis');
  assert.equal(state.status, 'Drafted with is automatic again: /sf-release cannot draft what this step now produces.', 'named once, though two workflows had it');
  assert.deepEqual([state.draft.phases.brief.authoringSkill, state.draft.steps['brief-one'].brief.authoringSkill, state.draft.steps['brief-two'].brief.authoringSkill], [null, null, null]);
  assert.equal(state.draft.steps['brief-own'].brief.authoringSkill, 'sf-design', 'a workflow\'s own skill that drafts analyses stays');
  // The engine drops the step's own skill with the output, so no workflow sends an automatic of its own.
  assert.deepEqual(page.changeSetFrom(model, state.draft).changes, [{ op: 'phase.update', id: 'brief', output: 'analysis' }]);

  // Changing the output back before publishing restores the earlier choice and leaves nothing to publish.
  page.setStepOutput('brief', 'document');
  assert.equal(state.status, 'Drafted with is /sf-release again.');
  assert.deepEqual([state.draft.phases.brief.authoringSkill, state.draft.steps['brief-one'].brief.authoringSkill], ['sf-release', 'sf-release']);
  assert.deepEqual(page.changeSetFrom(model, state.draft).changes, []);

  // Published, every workflow drafts as the page showed it, and no explicit automatic is left behind.
  page.setStepOutput('brief', 'analysis');
  const changeSet = page.changeSetFrom(model, state.draft);
  assert.equal(check(root, changeSet).valid, true);
  await planStudioChangeSet(root, changeSet, { write: true });
  const saved = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(Object.hasOwn(saved.phases.brief, 'authoringSkill'), false);
  assert.equal(saved.workTypes['brief-one'].phaseOverrides, undefined);
  const after = await buildStudioModel(root);
  const skillIn = (workflowId) => after.workflows.find((workflow) => workflow.id === workflowId).steps.find((step) => step.id === 'brief').effectiveAuthoringSkill;
  assert.deepEqual(['brief-one', 'brief-two', 'brief-own'].map(skillIn), ['/sf-phase', '/sf-phase', '/sf-design']);
  const reload = loadedStudio(after);
  assert.deepEqual(reload.changeSetFrom(after, reload.state().draft).changes, [], 'a reload has no phantom changes');
});

test('a new step two workflows use in one draft keeps each workflow\'s sign-off, inputs and drafting skill', async () => {
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  for (const [made, added] of [['chore', 'feature'], ['feature', 'chore']]) {
    const root = await repository();
    const model = await buildStudioModel(root);
    const page = loadedStudio(model);
    const state = page.state();
    const id = page.createStep(made, 'Vendor notes', 'document', 'architect', 'intake');
    page.chooseAuthoringSkill(made, id, 'sf-design');
    page.addExistingStep(added, id, 'intake');
    // The second workflow starts from what the step is created with, which is what the engine gives it.
    const second = state.draft.steps[added][id];
    assert.deepEqual([second.authoringSkill, second.approval, second.inputs], ['sf-design', { group: 'product-approvers', minimum: 1 }, ['intake']], `${made} then ${added}`);
    const picker = page.skillPicker(added, id, second, [made]);
    assert.equal(picker.value, 'sf-design');
    assert.ok(picker.hint.endsWith(`Only this workflow changes; ${state.draft.workflows[made].label} keeps its own.`), picker.hint);
    let changes = page.changeSetFrom(model, state.draft).changes;
    assert.equal(changes.find((change) => change.op === 'phase.create').authoringSkill, 'sf-design');
    assert.ok(!changes.some((change) => change.op === 'phase.update' && change.id === id), 'an unchanged second workflow sends nothing of its own');

    // What the second workflow sets itself is sent as its own, and the engine keeps it there.
    page.chooseAuthoringSkill(added, id, 'sf-requirements');
    second.approval = { group: 'quality-reviewers', minimum: 2 };
    second.inputs = [];
    const changeSet = page.changeSetFrom(model, state.draft);
    changes = changeSet.changes.filter((change) => change.op === 'phase.update' && change.id === id);
    assert.deepEqual(changes, [{ op: 'phase.update', id, workflow: added, approval: { group: 'quality-reviewers', minimum: 2 }, inputs: [], authoringSkill: 'sf-requirements' }]);
    const plan = await planStudioChangeSet(root, changeSet, { write: true });
    assert.equal(plan.valid, true, JSON.stringify(plan.problems));
    const after = await buildStudioModel(root);
    const stepIn = (workflowId) => after.workflows.find((workflow) => workflow.id === workflowId).steps.find((step) => step.id === id);
    assert.deepEqual([stepIn(made).effectiveAuthoringSkill, stepIn(made).approval.authorities, stepIn(made).approval.minimum, stepIn(made).inputs], ['/sf-design', ['product-approvers'], 1, ['intake']]);
    assert.deepEqual([stepIn(added).effectiveAuthoringSkill, stepIn(added).approval.authorities, stepIn(added).approval.minimum, stepIn(added).inputs], ['/sf-requirements', ['quality-reviewers'], 2, []]);
    const reload = loadedStudio(after);
    assert.deepEqual(reload.changeSetFrom(after, reload.state().draft).changes, [], 'a reload has no phantom changes');
  }
});

test('the page offers no drafting skill where the engine refuses one, and a copy keeps that', async () => {
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  const model = await buildStudioModel(root);
  const page = loadedStudio(model);
  const picker = (studio, workflowId, phaseId) => studio.skillPicker(workflowId, phaseId, studio.stepSettings(workflowId, phaseId), []);
  assert.deepEqual(picker(page, 'spec-driven-standard', 'convergence'), { fixed: '/sf-converge', hint: 'Deterministic convergence always uses /sf-converge.' });
  for (const [workflowId, phaseId] of [['quick-fix', 'implement'], ['quick-fix', 'verify'], ['poc-lite', 'poc-lite-plan']]) {
    assert.deepEqual(picker(page, workflowId, phaseId), { fixed: 'Generated by the engine', hint: 'Only the engine\'s deterministic generator produces this step, so no drafting skill can be chosen.' }, `${workflowId}/${phaseId}`);
  }
  // "Use a copy in this workflow" on convergence: the copy is generated too, offers no skill, and the engine accepts it.
  page.copyStepForWorkflow('spec-driven-standard', 'convergence');
  assert.equal(picker(page, 'spec-driven-standard', 'convergence-spec-driven-standard').fixed, 'Generated by the engine');
  const changeSet = page.changeSetFrom(model, page.state().draft);
  assert.equal(changeSet.changes.find((change) => change.op === 'phase.create').authoringSkill, null);
  const plan = check(root, changeSet);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));

  // A compiled skill step is drafted as its binding says, also in a workflow that takes it up in the draft.
  const compiled = structuredClone(model);
  compiled.workflows.find((workflow) => workflow.id === 'feature').steps.find((step) => step.id === 'design').compiledSkill = true;
  compiled.phases.find((phase) => phase.id === 'design').compiledSkill = true;
  const compiledPage = loadedStudio(compiled);
  const fixed = { fixed: 'Its compiled skill', hint: 'This step\'s compiled skill binding decides how it is drafted, so no drafting skill can be chosen.' };
  assert.deepEqual(picker(compiledPage, 'feature', 'design'), fixed);
  compiledPage.addExistingStep('chore', 'design', 'intake');
  assert.deepEqual(picker(compiledPage, 'chore', 'design'), fixed);
});

test('a workflow that sets what a step produces keeps it when the step\'s own output changes', async () => {
  const YAML = (await import('yaml')).default;
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'phase.create', id: 'own-input', label: 'Own input', agent: 'architect', approval: 'none' },
    { op: 'phase.create', id: 'own-step', label: 'Own step', agent: 'architect', approval: 'none', inputs: ['own-input'] },
    ...['own-a', 'own-b', 'own-c'].map((id) => ({ op: 'workflow.create', id, label: id, phases: ['own-input', 'own-step'] }))
  ] }, { write: true });
  const file = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(file, 'utf8'));
  configuration.workTypes['own-b'].phaseOverrides = { 'own-step': { generation: { requirement: 'none' } } };
  configuration.workTypes['own-c'].phaseOverrides = { 'own-step': { clarification: { mode: 'required' } } };
  await writeFile(file, YAML.stringify(configuration));
  const model = await buildStudioModel(root);
  const page = loadedStudio(model);
  const state = page.state();
  const outputs = (phaseId) => ['own-a', 'own-b', 'own-c'].map((workflowId) => page.stepOutput(workflowId, phaseId));
  assert.deepEqual(outputs('own-step'), ['document', 'none', 'document']);
  // Changed in own-a: own-b is still sign-off only, so it still offers no skill; own-c, which sets
  // something else of its own, follows the step.
  page.setStepOutput('own-step', 'analysis');
  assert.deepEqual(outputs('own-step'), ['analysis', 'none', 'analysis']);
  assert.equal(page.skillPicker('own-b', 'own-step', state.draft.steps['own-b']['own-step'], ['own-a', 'own-c']), null);
  // A copy is the step as its workflow runs it, and then a step of its own.
  page.copyStepForWorkflow('own-b', 'own-step');
  page.copyStepForWorkflow('own-c', 'own-step');
  assert.deepEqual([page.stepOutput('own-b', 'own-step-own-b'), page.stepOutput('own-c', 'own-step-own-c')], ['none', 'analysis']);
  page.chooseAuthoringSkill('own-a', 'own-step', 'sf-design');
  const plan = check(root, page.changeSetFrom(model, state.draft));
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
});
