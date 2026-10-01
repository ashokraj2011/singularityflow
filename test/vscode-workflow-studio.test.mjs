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

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-page-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Studio Tester'], root); run('git', ['config', 'user.email', 'studio@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Studio\n');
  run(process.execPath, [bin, 'init'], root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
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
  assert.ok(layout.height > layout.rowY + 112 + 2 * 26, 'and the canvas grows for the lanes below it');

  const plain = logic.canvasLayout({ phases: ['intake'], reworkLoops: [], decisions: [] });
  assert.equal(plain.rowY, 40, 'with nothing above, the row starts at the padding');
  assert.deepEqual(plain.edges.map((edge) => edge.kind), ['next']);
});
