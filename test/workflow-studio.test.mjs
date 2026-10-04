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

async function repository({ dropWorkflow = null, edit = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-studio-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Studio Tester'], root); run('git', ['config', 'user.email', 'studio@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Studio\n');
  flow(root, ['init']);
  if (dropWorkflow || edit) {
    const file = path.join(root, 'singularity/workflow.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    if (dropWorkflow) document.deleteIn(['workTypes', dropWorkflow]);
    edit?.(document);
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
  // An analysis-only draft saves, and says plainly why no Story can start from it yet.
  assert.ok(plan.warnings.some((warning) => warning.code === 'OBLIGATION_ROUTE_DROPS_RESPONSIBILITY'
    && /^Stories cannot start from this workflow yet: /.test(warning.message)), JSON.stringify(plan.warnings));
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
  const validation = flow(root, ['workflow', 'validate', 'vendor-assessment'], { allowFailure: true });
  assert.equal(validation.status, 1, 'a workflow whose route drops responsibilities is not valid for new Stories');
  assert.match(validation.stdout, /finishing after 'vendor-analysis' ends the Story without defined requirements \(scope\), a plan, implementation and verification/);
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
  assert.deepEqual(model.workflows.find((workflow) => workflow.id === 'quick-fix').steps.map((step) => step.agent), ['product-owner', 'developer', 'qa']);
});

/** A workflow whose design step reads requirements only when a branch did not skip them. */
function decisionDemo(document) {
  document.setIn(['workTypes', 'decide-demo'], document.createNode({
    label: 'Decision demo', phases: ['intake', 'requirements', 'design', 'implementation-spec'],
    // It plans a change and stops before any code, so it declares what it leaves undone.
    omits: ['implement', 'verify'].map((responsibility) => ({ responsibility, reason: 'Decision demo plans a change and stops before any code is written.', authority: 'architecture-reviewers' })),
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

test('a step copied for one workflow keeps every input setting it has there, so a branch may still skip an optional input', async () => {
  const root = await repository({ edit: decisionDemo });
  const before = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const model = json(root, ['workflow', 'studio']);
  const demo = before.workTypes['decide-demo'];
  // Exactly what "Use a copy in this workflow" sends: the copy reads step IDs, the branch and the
  // step after it name the copy.
  const file = await changeSet(root, [
    { op: 'phase.create', id: 'design-decide-demo', label: 'Architecture and design (Decision demo)', output: 'document', inputs: ['intake', 'requirements'],
      approval: { group: 'architecture-reviewers', minimum: 1 }, views: before.phases.design.worldModel.views, clarification: before.phases.design.clarification.mode,
      agent: 'architect', copyOf: 'design', copyFromWorkflow: 'decide-demo' },
    { op: 'workflow.update', id: 'decide-demo', phases: ['intake', 'requirements', 'design-decide-demo', 'implementation-spec'],
      decisions: [{ ...demo.decisions[0], routes: [demo.decisions[0].routes[0], { ...demo.decisions[0].routes[1], to: 'design-decide-demo' }] }] },
    { op: 'phase.update', id: 'implementation-spec', workflow: 'decide-demo', inputs: ['intake', 'design-decide-demo'] }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.ok(plan.summary.includes('New step Architecture and design (Decision demo), a copy of Architecture and design, drafted by Architect.'), plan.summary.join('\n'));

  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const copy = after.phases['design-decide-demo'];
  assert.deepEqual(copy.inputs, ['intake', { phase: 'requirements', optional: true }], 'the copy keeps the optional input');
  assert.deepEqual(after.workTypes['decide-demo'].phaseOverrides['implementation-spec'].inputs,
    ['intake', { phase: 'design-decide-demo', projection: 'approved-summary', preserve: ['Proposed design', 'Alternatives and decisions'] }],
    'a step reading the copy keeps its summary projection and preserved headings');
  assert.equal(after.workTypes['decide-demo'].phaseOverrides.design, undefined, "the workflow's settings for the step moved into the copy");
  assert.deepEqual(copy.approval.rejectTo, before.phases.design.approval.rejectTo.map((id) => (id === 'design' ? 'design-decide-demo' : id)), 'the copy can be sent back to itself');
  assert.deepEqual(copy.worldModel, before.phases.design.worldModel, 'the copy keeps its knowledge depth, not only its views');
  assert.deepEqual(copy.clarification, before.phases.design.clarification, 'and every clarifying-question setting');
  assert.deepEqual(after.phases.design, before.phases.design, 'the shared step is unchanged');
  assert.deepEqual(after.workTypes.feature, before.workTypes.feature, 'other workflows are unchanged');
  flow(root, ['workflow', 'validate', 'decide-demo']);
});

test('a copy drafts with the skill the step has in its workflow, automatic included', async () => {
  const root = await repository({ edit: (document) => {
    decisionDemo(document);
    // The shared step names a skill of its own; this workflow says automatic over it.
    document.setIn(['phases', 'design', 'authoringSkill'], 'sf-design');
    document.setIn(['workTypes', 'decide-demo', 'phaseOverrides', 'design', 'authoringSkill'], null);
  } });
  const model = json(root, ['workflow', 'studio']);
  const demo = model.workflows.find((workflow) => workflow.id === 'decide-demo');
  assert.equal(demo.steps.find((step) => step.id === 'design').effectiveAuthoringSkill, '/sf-phase');
  const file = await changeSet(root, [
    { op: 'phase.create', id: 'design-decide-demo', label: 'Architecture and design (Decision demo)', inputs: ['intake', 'requirements'], copyOf: 'design', copyFromWorkflow: 'decide-demo' },
    { op: 'workflow.update', id: 'decide-demo', phases: ['intake', 'requirements', 'design-decide-demo', 'implementation-spec'] },
    { op: 'phase.update', id: 'implementation-spec', workflow: 'decide-demo', inputs: ['intake', 'design-decide-demo'] }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(Object.hasOwn(after.phases['design-decide-demo'], 'authoringSkill'), false, 'automatic, as the workflow had it');
  assert.equal(after.phases.design.authoringSkill, 'sf-design', 'the shared step keeps its own skill');
  assert.equal(after.workTypes['decide-demo'].decisions[0].routes[1].to, 'design-decide-demo', 'a change set that names only the steps still moves the branch to the copy');
  const copied = json(root, ['workflow', 'studio']).workflows.find((workflow) => workflow.id === 'decide-demo').steps.find((step) => step.id === 'design-decide-demo');
  assert.deepEqual([copied.effectiveAuthoringSkill, copied.authoringSkillSource], ['/sf-phase', 'automatic']);
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
    // Form fields are read by attribute, with or without a tag: '[data-agent-label]', 'input[data-agent-id]'.
    querySelector(selector) { const key = /^[a-z]*\[([a-z-]+)\]$/.exec(selector)?.[1]; return key && key in formValues ? { value: formValues[key] } : null; },
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

test('a setting for a step the same change set adds to another workflow stays that workflow\'s own', async () => {
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const workflowFile = (root) => path.join(root, 'singularity/workflow.yml');
  const publish = async (root, changes) => {
    const changeSet = { schema: 'sflow-studio-change-set@1', changes };
    const plan = await planStudioChangeSet(root, changeSet);
    assert.equal(plan.valid, true, JSON.stringify(plan.problems));
    await planStudioChangeSet(root, changeSet, { write: true });
    return plan;
  };
  const stepIn = (model, workflowId, phaseId) => model.workflows.find((workflow) => workflow.id === workflowId).steps.find((step) => step.id === phaseId);

  // Requirements is Feature's alone; the page adds it to Chore and changes it there. Steps are
  // updated before workflows change their lists, so Chore does not list it yet at that moment.
  let root = await repository();
  const before = YAML.parse(await readFile(workflowFile(root), 'utf8'));
  assert.deepEqual(Object.keys(before.workTypes).filter((id) => before.workTypes[id].phases.includes('requirements')), ['feature']);
  const chore = [...before.workTypes.chore.phases];
  chore.splice(1, 0, 'requirements');
  const plan = await publish(root, [
    { op: 'workflow.update', id: 'chore', phases: chore },
    { op: 'phase.update', id: 'requirements', workflow: 'chore', approval: { group: 'quality-reviewers', minimum: 2 }, inputs: [], authoringSkill: 'sf-design' }
  ]);
  assert.ok(plan.summary.includes('Requirements: inputs, sign-off, drafting skill changed for Chore only.'), plan.summary.join('\n'));
  let after = YAML.parse(await readFile(workflowFile(root), 'utf8'));
  assert.deepEqual(after.phases.requirements, before.phases.requirements, 'the step itself, so Feature too, is unchanged');
  let model = await buildStudioModel(root);
  assert.deepEqual(stepIn(model, 'feature', 'requirements').approval, { mode: 'required', authorities: ['product-approvers'], minimum: 1 });
  assert.equal(stepIn(model, 'feature', 'requirements').effectiveAuthoringSkill, '/sf-phase');
  const inChore = stepIn(model, 'chore', 'requirements');
  assert.deepEqual([inChore.approval.authorities, inChore.approval.minimum, inChore.inputs, inChore.effectiveAuthoringSkill], [['quality-reviewers'], 2, [], '/sf-design']);

  // The other way round: Feature's own change in the same change set stays Feature's, and Chore
  // takes the step up as it is.
  root = await repository();
  await publish(root, [
    { op: 'workflow.update', id: 'chore', phases: chore },
    { op: 'phase.update', id: 'requirements', workflow: 'feature', approval: { group: 'architecture-reviewers', minimum: 1 } }
  ]);
  after = YAML.parse(await readFile(workflowFile(root), 'utf8'));
  assert.deepEqual(after.phases.requirements, before.phases.requirements);
  model = await buildStudioModel(root);
  assert.deepEqual(stepIn(model, 'feature', 'requirements').approval.authorities, ['architecture-reviewers']);
  assert.deepEqual(stepIn(model, 'chore', 'requirements').approval.authorities, ['product-approvers']);

  // A workflow that does not use the step has no settings for it: the change is refused, not
  // written to the step every other workflow uses.
  const refused = await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'phase.update', id: 'design', workflow: 'chore', approval: { group: 'quality-reviewers', minimum: 2 } }
  ] });
  assert.deepEqual(refused.problems.map((problem) => problem.code), ['STUDIO_PHASE_UNKNOWN']);
});

test('changing what a step produces drops a skill of its own that cannot draft the new output', async () => {
  const { buildStudioModel, planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const publish = async (changes) => {
    const changeSet = { schema: 'sflow-studio-change-set@1', changes };
    const plan = await planStudioChangeSet(root, changeSet);
    assert.equal(plan.valid, true, JSON.stringify(plan.problems));
    await planStudioChangeSet(root, changeSet, { write: true });
    return plan;
  };
  await publish([
    { op: 'phase.create', id: 'brief-input', label: 'Brief input', agent: 'architect', approval: 'none' },
    { op: 'phase.create', id: 'brief', label: 'Brief', agent: 'architect', approval: 'none', inputs: ['brief-input'], authoringSkill: 'sf-release' },
    { op: 'phase.create', id: 'notes', label: 'Notes', agent: 'architect', approval: 'none', inputs: ['brief-input'], authoringSkill: 'sf-design' },
    ...['brief-one', 'brief-two'].map((id) => ({ op: 'workflow.create', id, label: id, phases: ['brief-input', 'brief', 'notes'] }))
  ]);
  // Only the outputs change: no workflow has to send an automatic of its own to hide the old skill.
  const plan = await publish([{ op: 'phase.update', id: 'brief', output: 'analysis' }, { op: 'phase.update', id: 'notes', output: 'analysis' }]);
  assert.ok(plan.summary.includes('Brief now produces an analysis, which /sf-release cannot draft, so its drafting skill is automatic again.'), plan.summary.join('\n'));
  assert.ok(!plan.summary.some((line) => line.startsWith('Notes now')), 'a skill that drafts the new output stays');
  let saved = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(Object.hasOwn(saved.phases.brief, 'authoringSkill'), false);
  assert.equal(saved.phases.notes.authoringSkill, 'sf-design');
  assert.equal(saved.workTypes['brief-one'].phaseOverrides, undefined, 'no explicit automatic is left in any workflow');
  const model = await buildStudioModel(root);
  assert.equal(model.phases.find((phase) => phase.id === 'brief').authoringSkill, null);

  // A sign-off-only step names no skill at all, and a workflow taking the step up later is valid.
  const none = await publish([{ op: 'phase.update', id: 'notes', output: 'none' }]);
  assert.ok(none.summary.includes('Notes now drafts nothing, so it no longer names /sf-design.'), none.summary.join('\n'));
  await publish([{ op: 'workflow.create', id: 'brief-three', label: 'Brief three', phases: ['brief-input', 'brief', 'notes'] }]);
  saved = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(Object.hasOwn(saved.phases.notes, 'authoringSkill'), false);
});

test('a change leaves a null list as it is and refuses a list that is not one', async () => {
  const { planStudioChangeSet } = await import('../src/workflow-studio.mjs');
  const root = await repository();
  const check = (changes) => planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes });
  // Null means not given, as in phase.update: a new step reads nothing, a copy keeps its source's lists.
  for (const field of ['inputs', 'views']) {
    const plan = await check([{ op: 'phase.create', id: `null-${field}`, label: `Null ${field}`, agent: 'architect', approval: 'none', [field]: null }]);
    assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  }
  await planStudioChangeSet(root, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'phase.create', id: 'listed', label: 'Listed', agent: 'architect', approval: 'none', inputs: ['intake'], views: ['business'] },
    { op: 'workflow.create', id: 'listed-flow', label: 'Listed flow', phases: ['intake', 'listed'] }
  ] }, { write: true });
  const copy = { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'phase.create', id: 'listed-copy', label: 'Listed copy', copyOf: 'listed', inputs: null, views: null },
    { op: 'workflow.create', id: 'copy-flow', label: 'Copy flow', phases: ['intake', 'listed-copy'] }
  ] };
  assert.equal((await planStudioChangeSet(root, copy)).valid, true);
  await planStudioChangeSet(root, copy, { write: true });
  const saved = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual([saved.phases['listed-copy'].inputs, saved.phases['listed-copy'].worldModel.views], [['intake'], ['business']]);
  // Anything else that is not a list is refused with the Studio's own code, never a TypeError.
  for (const [change, code] of [
    [{ op: 'phase.create', id: 'text-inputs', label: 'Text inputs', agent: 'architect', approval: 'none', inputs: 'intake' }, 'STUDIO_PHASE_UNKNOWN'],
    [{ op: 'phase.create', id: 'text-views', label: 'Text views', agent: 'architect', approval: 'none', views: 'business' }, 'STUDIO_VIEWS_INVALID'],
    [{ op: 'phase.update', id: 'design', inputs: 'intake' }, 'STUDIO_PHASE_UNKNOWN'],
    [{ op: 'phase.update', id: 'design', views: 'business' }, 'STUDIO_VIEWS_INVALID']
  ]) {
    const plan = await check([change]);
    assert.deepEqual(plan.problems.map((problem) => problem.code), [code], JSON.stringify(plan.problems));
    assert.match(plan.problems[0].message, /must be a list\.$/);
  }
});

test('integration targets and the actions a step sends after it are edited from the Studio as one reviewed change', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  assert.deepEqual(model.integrations.targets, []);
  assert.ok(model.choices.integrationKinds.some((kind) => kind.id === 'webhook' && kind.available));
  const { INTEGRATION_TARGET_KINDS } = await import('../src/step-actions.mjs');
  for (const [id, entry] of Object.entries(INTEGRATION_TARGET_KINDS)) {
    assert.equal(model.choices.integrationKinds.find((kind) => kind.id === id)?.available, entry.available, `${id} is offered exactly when this build can deliver to it`);
  }
  assert.deepEqual(model.choices.actionTriggers, ['submitted', 'approved', 'rejected']);

  // intake is shared by several workflows, so an action set for Feature is Feature's alone.
  const file = await changeSet(root, [
    { op: 'integration.target.create', id: 'team-events', target: { kind: 'webhook', url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_SECRET_EVENTS_KEY' } },
    { op: 'phase.update', id: 'intake', workflow: 'feature', afterStep: [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events', send: 'event' }] }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.ok(plan.summary.some((line) => /actions after the step changed for Feature only/.test(line)), JSON.stringify(plan.summary));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(written.integrations.targets['team-events'], { kind: 'webhook', url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_SECRET_EVENTS_KEY' });
  assert.deepEqual(written.workTypes.feature.phaseOverrides.intake.afterStep, [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events' }]);
  assert.equal(written.phases.intake.afterStep, undefined, 'the shared step itself is unchanged');
  const after = json(root, ['workflow', 'studio']);
  const step = (workflowId) => after.workflows.find((entry) => entry.id === workflowId).steps.find((entry) => entry.id === 'intake');
  assert.deepEqual(step('feature').afterStep, [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events', send: 'event' }]);
  assert.equal(step('feature').afterStepSetByWorkflow, true);
  assert.deepEqual(step('bugfix').afterStep, []);
  assert.deepEqual(after.integrations.targets.map((target) => target.id), ['team-events']);

  // A target still in use cannot be removed, and a secret value is refused where it is typed.
  const inUse = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [{ op: 'integration.target.remove', id: 'team-events' }], after.base), '--dry-run']);
  assert.equal(inUse.valid, false);
  assert.equal(inUse.problems[0].code, 'STUDIO_TARGET_IN_USE');
  assert.match(inUse.problems[0].message, /Intake in Feature/);
  const inline = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'integration.target.create', id: 'leaky', target: { kind: 'webhook', url: 'https://hooks.example.com/x', token: 'abc' } }
  ], after.base), '--dry-run']);
  assert.equal(inline.valid, false);
  assert.equal(inline.problems[0].code, 'INTEGRATION_SECRET_INLINE');
  const unknown = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.update', id: 'design', afterStep: [{ id: 'x', on: ['approved'], target: 'missing' }] }
  ], after.base), '--dry-run']);
  assert.equal(unknown.valid, false);
  assert.ok(unknown.problems.some((problem) => problem.code === 'STEP_ACTION_TARGET_UNKNOWN'), JSON.stringify(unknown.problems));

  // Removing the action and then the target in one change set is fine.
  const cleared = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.update', id: 'intake', workflow: 'feature', afterStep: [] },
    { op: 'integration.target.remove', id: 'team-events' }
  ], after.base), '--dry-run']);
  assert.equal(cleared.valid, true, JSON.stringify(cleared.problems));
});

test('the Studio lists templates with where they are used, and artifact sets with the steps that use them', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  assert.equal(model.templatesRoot, 'singularity/templates');
  const intake = model.templates.find((template) => template.path === 'common/intake.md');
  assert.ok(intake, JSON.stringify(model.templates.map((template) => template.path)));
  assert.equal(intake.scope, 'repository');
  assert.match(intake.content, /\S/);
  assert.ok(intake.usedBy.includes('phase intake'));
  const specification = model.artifactSets.find((set) => set.id === 'spec-driven-specification');
  assert.equal(specification.primary, 'spec.md');
  assert.deepEqual(specification.members.find((member) => member.role === 'specification-quality'),
    { path: 'checklists/requirements.md', role: 'specification-quality', required: false, authority: 'advisory' });
  assert.ok(specification.usedBy.length >= 1);
  assert.equal(model.phases.find((phase) => phase.id === specification.usedBy[0]).artifactSet, 'spec-driven-specification');
  const feature = model.workflows.find((workflow) => workflow.id === 'feature');
  assert.ok(feature.steps.every((step) => Array.isArray(step.optionalInputs) && Object.hasOwn(step, 'template')));
});

test('templates are made and changed in the change set, and a step chooses one for its workflow', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  const before = await readFile(path.join(root, 'singularity/templates/common/intake.md'), 'utf8');
  const file = await changeSet(root, [
    { op: 'template.create', path: 'common/vendor-brief.md', content: '# {{work.id}} — Vendor brief\n\n## Vendors compared\n' },
    { op: 'template.update', path: 'common/intake.md', content: `${before.trimEnd()}\n\n## Vendor notes\n` },
    { op: 'phase.update', id: 'intake', workflow: 'feature', template: 'common/vendor-brief.md' }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.files.map((entry) => [entry.path, entry.action]).sort(), [
    ['singularity/templates/common/intake.md', 'update'],
    ['singularity/templates/common/vendor-brief.md', 'create'],
    ['singularity/workflow.yml', 'update']
  ]);
  assert.match(plan.files.find((entry) => entry.path === 'singularity/templates/common/intake.md').diff, /\+## Vendor notes/);
  assert.ok(plan.summary.some((line) => /New template common\/vendor-brief\.md/.test(line)));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const after = json(root, ['workflow', 'studio']);
  assert.equal(after.workflows.find((workflow) => workflow.id === 'feature').steps.find((step) => step.id === 'intake').template,
    'common/vendor-brief.md', 'Feature uses its own template for the shared step');
  assert.equal(after.phases.find((phase) => phase.id === 'intake').template, 'common/intake.md', 'other workflows keep the step\'s template');
  const written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(written.workTypes.feature.templateOverrides.intake, 'common/vendor-brief.md');

  const refusals = await changeSet(root, [
    { op: 'template.create', path: 'common/vendor-brief.md', content: 'again' },
    { op: 'template.update', path: 'feature/never-copied.md', content: 'x' },
    { op: 'template.create', path: '../escape.md', content: 'x' },
    { op: 'phase.update', id: 'design', template: 'common/does-not-exist.md' }
  ], after.base);
  const refused = json(root, ['workflow', 'studio', 'apply', '--change-set', refusals, '--dry-run']);
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.problems.map((problem) => problem.code).sort(),
    ['STUDIO_TEMPLATE_EXISTS', 'STUDIO_TEMPLATE_INVALID', 'STUDIO_TEMPLATE_UNKNOWN', 'STUDIO_TEMPLATE_UNKNOWN'].sort());
});

test('artifact sets are made for a step, refused while used, and an input can be optional', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  const file = await changeSet(root, [
    { op: 'artifactSet.create', id: 'vendor-pack', primary: 'vendor-analysis.md', members: [
      { path: 'vendor-analysis.md', role: 'analysis', required: true },
      { path: 'notes.md', role: 'notes', required: false, authority: 'advisory' }
    ] },
    { op: 'workflow.create', id: 'vendor-assessment', label: 'Vendor assessment', phases: ['intake', 'vendor-analysis'] },
    { op: 'phase.create', id: 'vendor-analysis', label: 'Vendor analysis', output: 'analysis', inputs: [{ phase: 'intake', optional: true }],
      approval: { group: 'product-approvers', minimum: 1 }, agent: 'product-owner', artifactSet: 'vendor-pack' }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  const written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(written.artifactSets['vendor-pack'], { primary: 'vendor-analysis.md', members: [
    { path: 'vendor-analysis.md', role: 'analysis', required: true },
    { path: 'notes.md', role: 'notes', authority: 'advisory' }
  ] });
  assert.equal(written.phases['vendor-analysis'].artifactSet, 'vendor-pack');
  assert.deepEqual(written.phases['vendor-analysis'].inputs, [{ phase: 'intake', optional: true }]);
  const after = json(root, ['workflow', 'studio']);
  assert.deepEqual(after.phases.find((phase) => phase.id === 'vendor-analysis').optionalInputs, ['intake']);

  const blocked = await changeSet(root, [
    { op: 'artifactSet.remove', id: 'vendor-pack' },
    { op: 'artifactSet.create', id: 'bad-pack', primary: 'missing.md', members: [{ path: 'other.md', role: 'x' }] },
    { op: 'phase.update', id: 'design', artifactSet: 'no-such-set' }
  ], after.base);
  const refused = json(root, ['workflow', 'studio', 'apply', '--change-set', blocked, '--dry-run']);
  assert.equal(refused.valid, false);
  assert.ok(refused.problems.some((problem) => problem.code === 'STUDIO_ARTIFACT_SET_IN_USE' && /Vendor analysis/.test(problem.message)));
  assert.ok(refused.problems.some((problem) => /primary 'missing\.md' is not among its members/.test(problem.message)));
  assert.ok(refused.problems.some((problem) => problem.code === 'STUDIO_ARTIFACT_SET_UNKNOWN'));

  // Taking the set off the step first lets it go; making the input required again drops the flag.
  const released = await changeSet(root, [
    { op: 'phase.update', id: 'vendor-analysis', artifactSet: null, inputs: [{ phase: 'intake', optional: false }] },
    { op: 'artifactSet.remove', id: 'vendor-pack' }
  ], after.base);
  const ok = json(root, ['workflow', 'studio', 'apply', '--change-set', released, '--dry-run']);
  assert.equal(ok.valid, true, JSON.stringify(ok.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', released]);
  const final = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(final.artifactSets?.['vendor-pack'], undefined);
  assert.deepEqual(final.phases['vendor-analysis'].inputs, ['intake']);
});

test('a step in an artifact set writes the set\'s primary member, and a step\'s file can be renamed in its folder', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  const designFile = model.phases.find((phase) => phase.id === 'design').artifact;
  const folder = path.posix.dirname(designFile);
  const file = await changeSet(root, [
    { op: 'artifactSet.create', id: 'brief-pack', primary: 'brief.md', members: [
      { path: 'brief.md', role: 'brief', required: true },
      { path: 'appendix.md', role: 'appendix' }
    ] },
    { op: 'phase.update', id: 'design', artifactSet: 'brief-pack' },
    { op: 'phase.update', id: 'requirements', artifactFile: 'requirements-brief.md' }
  ], model.base);
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', file, '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', file]);
  let written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(written.phases.design.artifact.path, `${folder}/brief.md`, 'the step keeps its folder and writes the primary member');
  assert.equal(written.phases.requirements.artifact.path, `${path.posix.dirname(model.phases.find((phase) => phase.id === 'requirements').artifact)}/requirements-brief.md`);

  // A new primary moves the steps in the set with it.
  const after = json(root, ['workflow', 'studio']);
  const moved = await changeSet(root, [
    { op: 'artifactSet.update', id: 'brief-pack', primary: 'appendix.md', members: [
      { path: 'brief.md', role: 'brief' },
      { path: 'appendix.md', role: 'appendix', required: true }
    ] }
  ], after.base);
  const movedPlan = json(root, ['workflow', 'studio', 'apply', '--change-set', moved, '--dry-run']);
  assert.equal(movedPlan.valid, true, JSON.stringify(movedPlan.problems));
  json(root, ['workflow', 'studio', 'apply', '--change-set', moved]);
  written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(written.phases.design.artifact.path, `${folder}/appendix.md`);

  const latest = json(root, ['workflow', 'studio']);
  const refusals = await changeSet(root, [
    { op: 'phase.update', id: 'design', artifactFile: 'other.md' },
    { op: 'phase.update', id: 'requirements', artifactFile: 'nested/requirements.md' },
    { op: 'artifactSet.update', id: 'brief-pack', primary: 'parts/brief.md', members: [
      { path: 'parts/brief.md', role: 'brief' }, { path: 'appendix.md', role: 'appendix' }
    ] }
  ], latest.base);
  const refused = json(root, ['workflow', 'studio', 'apply', '--change-set', refusals, '--dry-run']);
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.problems.map((problem) => problem.code).sort(),
    ['STUDIO_ARTIFACT_INVALID', 'STUDIO_ARTIFACT_INVALID', 'STUDIO_ARTIFACT_SET_INVALID']);
});
