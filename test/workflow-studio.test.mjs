import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Studio Tester' };

function run(command, args, cwd, { input = '', allowFailure = false, env: extra = {} } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...env, ...extra }, input });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const json = (root, args, options) => JSON.parse(flow(root, [...args, '--json'], options).stdout);

async function repository({ dropWorkflow = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Studio Tester'], root); run('git', ['config', 'user.email', 'studio@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Studio\n');
  flow(root, ['init']);
  if (dropWorkflow) {
    const file = path.join(root, 'singularity/workflow.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.deleteIn(['workTypes', dropWorkflow]);
    await writeFile(file, document.toString());
  }
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

async function changeSet(root, changes, base = null) {
  const file = path.join(root, '..', `${path.basename(root)}-change-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify({ schema: 'sflow-studio-change-set@1', ...(base ? { base } : {}), changes }));
  return file;
}

test('the Studio shows every workflow with the agent that really drafts each step', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  assert.equal(model.resultType, 'workflow-studio');
  assert.equal(model.authority.kind, 'working-tree');
  const feature = model.workflows.find((workflow) => workflow.id === 'feature');
  assert.deepEqual(feature.steps.slice(0, 3).map((step) => [step.id, step.agent]), [['intake', 'product-owner'], ['requirements', 'product-owner'], ['design', 'architect']]);
  assert.equal(feature.steps.find((step) => step.id === 'implementation').output, 'code');
  assert.ok(model.agents.some((agent) => agent.id === 'developer' && agent.defaultFor.includes('implementation')));
  assert.ok(!model.agents.some((agent) => agent.scope === 'plugin'), 'workflow plumbing agents are not offered');
  const product = model.groups.find((group) => group.id === 'product-approvers');
  assert.equal(product.status, 'auto', 'an empty group with automatic enrolment is not a dead end');
  assert.ok(product.approves.includes('intake'));
  assert.ok(model.blueprints.some((blueprint) => blueprint.id === 'quick-fix'));
  assert.ok(model.choices.roles.some((role) => role.id === 'analyst'));
  assert.match(model.base.workflowSha256, /^[a-f0-9]{64}$/);
});

test('a workflow, a new step and its new agent land together, and a dry run writes nothing', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  const file = await changeSet(root, [
    { op: 'workflow.create', id: 'vendor-assessment', label: 'Vendor assessment', phases: ['intake', 'vendor-analysis'] },
    { op: 'phase.create', id: 'vendor-analysis', label: 'Vendor analysis', output: 'analysis', inputs: ['intake'], approval: { group: 'product-approvers', minimum: 1 }, agent: 'vendor-analyst' },
    { op: 'agent.create', id: 'vendor-analyst', label: 'Vendor analyst', description: 'Compares vendor options against the approved intake.', role: 'analyst' }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.files.map((entry) => [entry.path, entry.action]).sort(), [
    ['.github/agents/vendor-analyst.agent.md', 'create'],
    ['singularity/templates/common/vendor-analysis.md', 'create'],
    ['singularity/workflow.yml', 'update']
  ]);
  assert.ok(plan.summary.some((line) => /New step Vendor analysis: drafted by Vendor analyst, signed off by Product approvers/.test(line)));
  assert.match(plan.files.find((entry) => entry.path === 'singularity/workflow.yml').diff, /\+\s+vendor-assessment:/);
  assert.equal(existsSync(path.join(root, '.github/agents/vendor-analyst.agent.md')), false, 'a dry run writes nothing');

  const applied = json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  assert.deepEqual(applied.written.sort(), plan.files.map((entry) => entry.path).sort());
  const agent = await readFile(path.join(root, '.github/agents/vendor-analyst.agent.md'), 'utf8');
  assert.match(agent, /sflow-default-for: "vendor-analysis"/);
  assert.match(agent, /sflow-phases: "vendor-analysis"/, "a new agent is eligible for exactly the steps it drafts");
  assert.match(agent, /tools: \[ ?read, search, edit, ask_user ?\]/);
  assert.match(agent, /singularity-flow session current --json/, 'a new agent carries the shared operating rules');
  const after = json(root, ['workflow', 'studio']);
  const created = after.workflows.find((workflow) => workflow.id === 'vendor-assessment');
  assert.deepEqual(created.steps.map((step) => [step.id, step.agent, step.output]), [['intake', 'product-owner', 'document'], ['vendor-analysis', 'vendor-analyst', 'analysis']]);
  assert.deepEqual(created.steps[1].inputs, ['intake']);
  flow(root, ['workflow', 'validate', 'vendor-assessment']);
});

test('moving a step to another agent changes both agents in one valid change', async () => {
  const root = await repository();
  const file = await changeSet(root, [{ op: 'phase.agent', phase: 'design', agent: 'product-owner' }]);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.files.map((entry) => entry.path).sort(), ['.github/agents/architect.agent.md', '.github/agents/product-owner.agent.md']);
  assert.ok(plan.summary.some((line) => /^Architecture and design is now drafted by Product owner \(was Architect\), in all \d+ workflows that use it\.$/.test(line)));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const model = json(root, ['workflow', 'studio']);
  assert.equal(model.workflows.find((workflow) => workflow.id === 'feature').steps.find((step) => step.id === 'design').agent, 'product-owner');
  const architect = await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8');
  assert.equal(architect.match(/sflow-default-for: "([^"]*)"/)[1].split(',').includes('design'), false);
  assert.match(architect, /# Architect agent/, 'the agent keeps its own instructions');
});

test('problems name the step to fix, and a stale base is refused', async () => {
  const root = await repository();
  const orphan = await changeSet(root, [{ op: 'phase.create', id: 'lonely-step', label: 'Lonely step', agent: 'nobody-here' }]);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', orphan, '--dry-run']);
  assert.equal(plan.valid, false);
  assert.match(plan.problems[0].message, /There is no agent 'nobody-here'/);
  assert.deepEqual(plan.files, []);
  const refused = flow(root, ['workflow', 'studio', 'apply', '--change-set', orphan], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Workflow Studio changes were not applied: There is no agent 'nobody-here'/);

  const stale = await changeSet(root, [{ op: 'workflow.update', id: 'feature', label: 'Feature work' }], { workflowSha256: '0'.repeat(64) });
  const stalePlan = flow(root, ['workflow', 'studio', 'apply', '--change-set', stale, '--dry-run', '--json'], { allowFailure: true });
  assert.notEqual(stalePlan.status, 0);
  assert.match(stalePlan.stderr, /changed since Workflow Studio loaded it/);
});

test('people, sign-off and send-back rules are edited from the Studio', async () => {
  const root = await repository();
  const file = await changeSet(root, [
    { op: 'group.update', id: 'architecture-reviewers', members: [{ name: 'Ada Lovelace', email: 'Ada@Example.com' }] },
    { op: 'phase.update', id: 'design', workflow: 'feature', approval: { group: 'architecture-reviewers', minimum: 1 } },
    { op: 'workflow.update', id: 'feature', reworkLoops: [{ from: 'verification', to: 'implementation', maxAttempts: 2 }] }
  ]);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(workflow.approvalAuthorities['architecture-reviewers'].members, [{ name: 'Ada Lovelace', email: 'ada@example.com', githubLogin: null }]);
  assert.deepEqual(workflow.workTypes.feature.reworkLoops, [{ from: 'verification', to: 'implementation', maxAttempts: 2 }]);
  const model = json(root, ['workflow', 'studio']);
  assert.equal(model.groups.find((group) => group.id === 'architecture-reviewers').status, 'people');
  assert.match(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), /^# /m, 'comments in workflow.yml survive the edit');
});

test('a packaged blueprint that is not installed comes in with its steps, templates and agents', async () => {
  const root = await repository({ dropWorkflow: 'quick-fix' });
  assert.equal(json(root, ['workflow', 'studio']).blueprints.find((blueprint) => blueprint.id === 'quick-fix').installed, false);
  const file = await changeSet(root, [{ op: 'workflow.install', id: 'quick-fix' }]);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.ok(plan.summary.some((line) => /^Installed blueprint Quick fix: /.test(line)));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const model = json(root, ['workflow', 'studio']);
  assert.deepEqual(model.workflows.find((workflow) => workflow.id === 'quick-fix').steps.map((step) => step.agent), ['developer', 'qa']);
});

test('from a Story checkout, Studio changes become one review proposal on the approved configuration', async () => {
  const { initializeDefinition } = await import('../src/config.mjs');
  const { remoteFingerprint } = await import('../src/git-remote-diagnostics.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-proposal-'));
  const seed = path.join(base, 'seed'); const remote = path.join(base, 'application.git'); const story = path.join(base, 'story');
  run('git', ['init', '-q', '-b', 'main', seed], base);
  run('git', ['config', 'user.name', 'Studio Tester'], seed); run('git', ['config', 'user.email', 'studio@example.com'], seed);
  await initializeDefinition(seed);
  await writeFile(path.join(seed, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], seed); run('git', ['commit', '-qm', 'baseline'], seed);
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote], base);
  run('git', ['remote', 'add', 'origin', remote], seed); run('git', ['push', '-q', '-u', 'origin', 'main'], seed);
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], seed);
  const approved = run('git', ['rev-parse', 'HEAD'], seed).stdout.trim();
  run('git', ['switch', '-q', '-c', 'STUDIO-STORY'], seed);
  await writeFile(path.join(seed, 'singularity', 'configuration-source.json'), `${JSON.stringify({ branch: 'sflow/config', commit: approved }, null, 2)}\n`);
  run('git', ['add', 'singularity/configuration-source.json'], seed); run('git', ['commit', '-qm', 'pin Story configuration'], seed);
  run('git', ['push', '-q', 'origin', 'STUDIO-STORY'], seed);
  run('git', ['clone', '-q', '-b', 'STUDIO-STORY', remote, story], base);
  run('git', ['config', 'user.name', 'Studio Tester'], story); run('git', ['config', 'user.email', 'studio@example.com'], story);
  const storyHead = run('git', ['rev-parse', 'HEAD'], story).stdout.trim();
  const proposalEnv = { SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox') };
  const studio = (args) => JSON.parse(run(process.execPath, [bin, ...args, '--json'], story, { env: proposalEnv }).stdout);

  const model = studio(['workflow', 'studio']);
  assert.equal(model.authority.kind, 'approved-configuration-ref');
  assert.equal(model.authority.commit, approved);
  const file = await changeSet(story, [
    { op: 'workflow.create', id: 'vendor-assessment', label: 'Vendor assessment', phases: ['intake', 'vendor-analysis'] },
    { op: 'phase.create', id: 'vendor-analysis', label: 'Vendor analysis', output: 'analysis', inputs: ['intake'], approval: { group: 'product-approvers' }, agent: 'vendor-analyst' },
    { op: 'agent.create', id: 'vendor-analyst', label: 'Vendor analyst', description: 'Compares vendor options against the approved intake.', role: 'analyst' }
  ], model.base);
  const proposal = studio(['workflow', 'studio', 'apply', '--change-set', file, '--propose',
    '--expected-authority-kind', model.authority.kind, '--expected-authority-commit', model.authority.commit,
    '--expected-authority-remote-fingerprint', remoteFingerprint(remote), '--expected-authority-source-commit', model.authority.sourceCommit ?? approved]);
  assert.equal(proposal.reviewRequired, true, JSON.stringify(proposal));
  assert.match(proposal.branch, /^sflow\/config-change\/workflow\/studio-/);
  assert.deepEqual([...proposal.files].sort(), ['.github/agents/vendor-analyst.agent.md', 'singularity/templates/common/vendor-analysis.md', 'singularity/workflow.yml']);
  assert.match(run('git', ['--git-dir', remote, 'show', `${proposal.branch}:.github/agents/vendor-analyst.agent.md`], base).stdout, /sflow-default-for: "vendor-analysis"/);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'], base).stdout.trim(), approved, 'approved configuration is unchanged until review');
  assert.equal(run('git', ['rev-parse', 'HEAD'], story).stdout.trim(), storyHead, 'the Story checkout is unchanged');
  assert.equal(run('git', ['status', '--porcelain'], story).stdout, '');
});

test('the Studio shows what each step really produces and which skill drafts it', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  const step = (workflowId, id) => model.workflows.find((workflow) => workflow.id === workflowId).steps.find((entry) => entry.id === id);
  // Write scope no longer implies code: these steps write against source without delivering it.
  assert.equal(step('feature', 'verification').output, 'document');
  assert.equal(step('chore', 'implementation').output, 'analysis');
  assert.equal(step('feature', 'implementation').output, 'code');
  assert.deepEqual(
    [step('feature', 'design').authoringSkill, step('feature', 'design').effectiveAuthoringSkill, step('feature', 'design').authoringSkillSource],
    [null, '/sf-phase', 'automatic']
  );
  assert.equal(step('feature', 'implementation').effectiveAuthoringSkill, '/sf-code');
  assert.equal(step('spec-driven-standard', 'convergence').authoringSkillSource, 'fixed');
  const design = model.choices.authoringSkills.find((choice) => choice.id === 'sf-design');
  assert.deepEqual([design.label, design.produces, design.legacyPhases], ['/sf-design', ['document', 'analysis'], ['design']]);
  assert.match(design.description, /architecture and design artifact/i);
});

test('the drafting skill of a shared step is set for one workflow, cleared again, and kept by a copy', async () => {
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const apply = async (changes) => {
    const file = await changeSet(root, changes);
    const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
    assert.equal(plan.valid, true, JSON.stringify(plan.problems));
    json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
    return YAML.parse(await readFile(workflowFile, 'utf8'));
  };
  // design is used by several workflows, so the choice is the Feature workflow's own.
  let workflow = await apply([{ op: 'phase.update', id: 'design', workflow: 'feature', authoringSkill: 'sf-design' }]);
  assert.equal(workflow.workTypes.feature.phaseOverrides.design.authoringSkill, 'sf-design');
  assert.equal(workflow.phases.design.authoringSkill, undefined);
  let model = json(root, ['workflow', 'studio']);
  const designIn = (id) => model.workflows.find((entry) => entry.id === id).steps.find((entry) => entry.id === 'design');
  assert.deepEqual([designIn('feature').effectiveAuthoringSkill, designIn('feature').authoringSkillSetByWorkflow], ['/sf-design', true]);
  const other = model.workflows.find((entry) => entry.id !== 'feature' && entry.steps.some((candidate) => candidate.id === 'design'));
  assert.equal(designIn(other.id).effectiveAuthoringSkill, '/sf-phase', 'other workflows are untouched');

  workflow = await apply([{ op: 'phase.update', id: 'design', workflow: 'feature', authoringSkill: null }]);
  assert.equal(Object.hasOwn(workflow.workTypes.feature.phaseOverrides.design ?? {}, 'authoringSkill'), false);

  // A new step names its skill; a copy made for one workflow takes the value it had there.
  workflow = await apply([
    { op: 'phase.create', id: 'vendor-analysis', label: 'Vendor analysis', output: 'analysis', agent: 'architect', authoringSkill: 'sf-design' },
    { op: 'phase.create', id: 'design-feature', label: 'Design (Feature)', copyOf: 'design', authoringSkill: 'sf-design' },
    { op: 'workflow.create', id: 'vendor-review', label: 'Vendor review', phases: ['intake', 'vendor-analysis', 'design-feature'] }
  ]);
  assert.equal(workflow.phases['vendor-analysis'].authoringSkill, 'sf-design');
  assert.equal(workflow.phases['design-feature'].authoringSkill, 'sf-design');

  // A skill that cannot draft the step is a problem the check names, not a silent write.
  const refused = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.update', id: 'implementation', workflow: 'feature', authoringSkill: 'sf-design' }
  ]), '--dry-run']);
  assert.equal(refused.valid, false);
  assert.match(JSON.stringify(refused.problems), /PHASE_AUTHORING_SKILL_OUTPUT_MISMATCH/);
});

test('naming a step\'s output keeps the write scope of a step that writes against source', async () => {
  const root = await repository();
  const file = await changeSet(root, [{ op: 'phase.update', id: 'verification', output: 'analysis' }]);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(workflow.phases.verification.generation.task, 'analyze');
  assert.equal(workflow.phases.verification.writeScope, 'source-and-artifact', 'only moving to or from code changes write scope');
});

test('a Studio agent save refuses a changed agent baseline without overwriting concurrent instructions', async () => {
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  const original = await buildStudioModel(root);
  const instructions = original.agents.find((agent) => agent.id === 'architect').instructions;
  const request = (instructions, base) => ({ schema: 'sflow-studio-change-set@1', base, changes: [{ op: 'agent.update', id: 'architect', instructions }] });
  await planStudioChangeSet(root, request(`${instructions}\n\nConcurrent instruction.`, original.base), { write: true });
  const updated = await buildStudioModel(root);
  assert.equal(updated.base.workflowSha256, original.base.workflowSha256);
  assert.notEqual(updated.base.agentsSha256, original.base.agentsSha256);
  await assert.rejects(planStudioChangeSet(root, request(`${instructions}\n\nStale instruction.`, original.base), { write: true }), { code: 'STUDIO_BASE_CHANGED' });
  assert.match((await buildStudioModel(root)).agents.find((agent) => agent.id === 'architect').instructions, /Concurrent instruction\./);
  await planStudioChangeSet(root, request(`${instructions}\n\nReviewed instruction.`, updated.base), { write: true });
  assert.match((await buildStudioModel(root)).agents.find((agent) => agent.id === 'architect').instructions, /Reviewed instruction\./);
});

test('the agent designer saves block YAML tools without dropping model preferences or custom metadata', async () => {
  const { parseAgent, renderAgent, validateAgent, instructionCatalog } = await import('../apps/vscode/src/views/instruction-designer-model.ts');
  const { instructionDesignerHtml, INSTRUCTION_DESIGNER_SCRIPT } = await import('../apps/vscode/src/views/instruction-designer-page.ts');
  const { loadDefinition } = await import('../src/config.mjs');
  const { parseAgentDependencies } = await import('../src/agents.mjs');
  const { saveConfigurationFile } = await import('../src/editor.mjs');
  const root = await repository();
  const original = (await readFile(path.join(packageRoot, 'templates/agents/architect.agent.md'), 'utf8'))
    .replace('tools: [read, search, edit, bash, ask_user]', 'tools:\n  - read\n  - search\n  - edit\n  - bash\n  - ask_user\n  - vendor/tool')
    .replace('  sflow-model-task: "reason"', '  sflow-model-task: "reason"\n  custom-routing: "keep this"');
  const relative = '.github/agents/architect.agent.md';
  await saveConfigurationFile(root, relative, original);
  const draft = parseAgent(await readFile(path.join(root, relative), 'utf8'), 'architect');
  assert.deepEqual(draft.tools, ['read', 'search', 'edit', 'bash', 'ask_user', 'vendor/tool']);
  assert.deepEqual(validateAgent(draft), []);
  assert.equal(renderAgent(draft), original, 'an untouched editor is byte-preserving');
  draft.description += ' Updated description.';
  const catalog = instructionCatalog({ definition: await loadDefinition(root), agents: [{ id: 'architect', path: relative, content: original, editable: true }] });
  const html = instructionDesignerHtml(catalog, { tab: 'agents', selected: catalog.agents[0], agent: draft, prompt: null, skill: null, errors: [], notice: null, configurationBlockedReason: null });
  const formValues = { 'data-agent-id': draft.id, 'data-agent-label': draft.label, 'data-agent-description': draft.description, 'data-agent-body': draft.body };
  let click;
  const messages = [];
  const document = {
    addEventListener(name, listener) { if (name === 'click') click = listener; },
    querySelector(selector) { const key = selector.slice(1, -1); return key in formValues ? { value: formValues[key] } : null; },
    querySelectorAll(selector) {
      const name = /^input\[name="([^"]+)"\]:checked$/.exec(selector)?.[1];
      if (!name) return [];
      return [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag)
        .filter((tag) => tag.includes(`name="${name}"`) && /\schecked(?:\s|>)/.test(tag))
        .map((tag) => ({ value: /value="([^"]*)"/.exec(tag)[1] }));
    }
  };
  new Function('window', 'document', INSTRUCTION_DESIGNER_SCRIPT)({ __sfVscode: { postMessage(message) { messages.push(message); } } }, document);
  click({ target: { closest() { return { dataset: { saveAgent: '1' } }; } } });
  const submitted = messages[0];
  assert.deepEqual(submitted.tools, draft.tools, 'the real form includes bash, ask_user and custom tools');
  assert.equal(submitted.sourceText, undefined, 'original Markdown stays in the host');
  const rendered = renderAgent(submitted, original);
  await saveConfigurationFile(root, relative, rendered);
  const before = parseAgentDependencies(original);
  const afterText = await readFile(path.join(root, relative), 'utf8');
  const after = parseAgentDependencies(afterText);
  assert.deepEqual(after.tools, before.tools);
  assert.deepEqual(after.frontmatter.model, before.frontmatter.model);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(after.prompt, before.prompt);
  assert.doesNotMatch(afterText, /## Remote skills/, 'editing ordinary instructions does not append empty resource tables');
  assert.match(after.description, /Updated description\.$/);
  const host = await readFile(path.join(packageRoot, 'apps/vscode/src/views/instruction-designer.ts'), 'utf8');
  assert.match(host, /renderAgent\(draft, this\.sourceText\)/, 'save uses the host baseline rather than webview-provided source text');
});

test('agent edits preserve instructions after remote tables and retain native display names', async () => {
  const { parseAgent, renderAgent } = await import('../apps/vscode/src/views/instruction-designer-model.ts');
  const original = '---\nname: "Native Reviewer"\ndescription: Review documents.\ntools: [read]\nmetadata:\n  custom: retained\n---\n\n# Reviewer\n\nUse evidence.\n\n## Remote skills\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n| guide | https://example.test/guide.md | - | true | 1024 |\n\n## Final instruction\n\nStop for human review.\n';
  const draft = parseAgent(original, 'native-reviewer');
  assert.equal(draft.id, 'native-reviewer');
  assert.match(draft.body, /Stop for human review\./);
  assert.equal(renderAgent(draft), original);
  draft.body += '\n\nExplain uncertainty.';
  const rendered = renderAgent(draft);
  assert.equal((rendered.match(/## Remote skills/g) ?? []).length, 1);
  assert.match(rendered, /name: "Native Reviewer"/);
  assert.match(rendered, /Stop for human review\./);
  assert.match(rendered, /Explain uncertainty\./);
  assert.doesNotMatch(rendered, /## Remote artifact templates|## Remote generated artifacts/);
  assert.equal(parseAgent(rendered, 'native-reviewer').remoteSkills.length, 1);
});
