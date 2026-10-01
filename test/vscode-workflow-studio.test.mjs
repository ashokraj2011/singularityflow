import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const { WORKFLOW_STUDIO_SCRIPT, workflowStudioHtml } = await import(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts'));
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
  const html = workflowStudioHtml({ cspSource: 'vscode-resource:' }, 'nonce123');
  assert.match(html, /<div id="studio-root"/);
  assert.match(html, /script-src 'nonce-nonce123'/);
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
