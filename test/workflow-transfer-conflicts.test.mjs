/**
 * Importing a workflow into a repository that already has objects with the same names.
 *
 * Every dependent object travels with the workflow: steps, templates, artifact sets, approval
 * groups (including those only a decision or an exception names), MCP servers and their imported
 * descriptors, agents with their imported skills, and the records of where those came from. A
 * same-name conflict blocks the import until the person keeps the repository's own, replaces it,
 * or imports the bundle's under a new name, which is written through every reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { discoverAgents, parseAgentDependencies } from '../src/agents.mjs';
import {
  applyWorkflowImport, exportWorkflowBundle, importResolutionOptions, planWorkflowImport, workflowTransferProposal
} from '../src/workflow-transfer.mjs';
import { renameBundleSubjects, renameRefusal } from '../src/workflow-transfer-resolution.mjs';
import { addReleaseWorkflow, DESCRIPTOR_TEXT, skillText } from './helpers/release-workflow-fixture.mjs';

process.env.NODE_ENV = 'test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const VENDORED = 'singularity/imports/agents/release-manager/skill-store-checklist.md';
const DESCRIPTOR = 'singularity/imports/mcp/app-store-connect.json';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** A hand-edited bundle with every digest recomputed, so only the edit itself is under test. */
function resealed(bundle) {
  for (const asset of bundle.assets) {
    asset.size = Buffer.byteLength(asset.content, 'utf8');
    asset.sha256 = `sha256:${sha256(asset.content)}`;
  }
  const copy = structuredClone(bundle);
  delete copy.bundleSha256;
  bundle.bundleSha256 = `sha256:${sha256(JSON.stringify(canonical(copy)))}`;
  return bundle;
}

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return root;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** A committed Git repository, as the CLI requires. */
function committed(root) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Workflow Transfer Test');
  git(root, 'config', 'user.email', 'workflow-transfer@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initialize workflow configuration');
  return root;
}

const configuration = async (root) => YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
const lockFile = async (root) => YAML.parse(await readFile(path.join(root, 'singularity/agents.lock.yml'), 'utf8'));
const ledger = async (root) => YAML.parse(await readFile(path.join(root, 'singularity/imports.lock.yml'), 'utf8'));

async function releaseBundle(t, options = {}) {
  const source = await repository(t, 'sflow-transfer-conflicts-source-');
  await addReleaseWorkflow(source, 'source', options);
  return { source, bundle: await exportWorkflowBundle(source, ['mobile-release']) };
}

test('export carries every dependent object, including groups and reviewers only a decision, exception or source review names', async (t) => {
  const { source, bundle } = await releaseBundle(t);
  assert.equal(bundle.schemaVersion, 6);
  assert.deepEqual(Object.keys(bundle.objects.story.approvalAuthorities).sort(),
    ['architecture-reviewers', 'product-approvers', 'release-leads', 'release-managers']);
  assert.deepEqual(bundle.assets.filter((asset) => asset.kind === 'agent').map((asset) => asset.id).sort(),
    ['product-owner', 'release-manager', 'release-reviewer']);
  assert.deepEqual(bundle.assets.filter((asset) => asset.kind === 'vendored').map((asset) => [asset.path, asset.owner]), [
    [VENDORED, { kind: 'agent', id: 'release-manager' }],
    [DESCRIPTOR, { kind: 'mcp-server', id: 'app-store-connect' }]
  ]);
  assert.deepEqual(Object.keys(bundle.imports), [
    'generated:release-manager/release-notes', 'mcp-server:app-store-connect', 'skill:release-manager/store-checklist'
  ]);
  assert.equal(bundle.agentLocks['release-manager'].dependencies[0].vendored, VENDORED);
  assert.equal(bundle.requirements.dependencyMaterialization, 'vendored');

  // A packaged reviewer is installed everywhere, so it does not travel.
  const packaged = await configuration(source);
  packaged.workTypes['mobile-release'].sourceReview.reviewerAgent = 'sflow-source-reviewer';
  await writeFile(path.join(source, 'singularity/workflow.yml'), YAML.stringify(packaged));
  const withPackagedReviewer = await exportWorkflowBundle(source, ['mobile-release']);
  assert.deepEqual(withPackagedReviewer.assets.filter((asset) => asset.kind === 'agent').map((asset) => asset.id).sort(),
    ['product-owner', 'release-manager']);
});

test('a fresh import brings the imported copies and where they came from, so nothing is fetched again', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-fresh-');
  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.ok(plan.changedPaths.includes('singularity/imports.lock.yml'));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(await readFile(path.join(target, VENDORED), 'utf8'), skillText('source'));
  assert.equal(await readFile(path.join(target, DESCRIPTOR), 'utf8'), DESCRIPTOR_TEXT);
  assert.equal((await lockFile(target)).agents['release-manager'].dependencies[0].vendored, VENDORED);
  assert.deepEqual(Object.keys((await ledger(target)).imports).sort(), Object.keys(bundle.imports));
  const definition = await loadDefinition(target);
  assert.ok(definition.workTypes['mobile-release']);
  assert.ok(definition.approvalAuthorities['release-leads']);
});

test('the bundle reader refuses imported copies and records that do not match what it carries', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-reader-');
  const variant = (edit) => resealed(edit(structuredClone(bundle)) ?? bundle);
  const cases = [
    ['a locked copy is missing', (copy) => { copy.assets = copy.assets.filter((asset) => asset.path !== VENDORED); return copy; },
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'],
    ['a copy differs from its lock', (copy) => { copy.assets.find((asset) => asset.path === VENDORED).content += '- Extra\n'; return copy; },
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'],
    ['a copy no lock names', (copy) => {
      copy.assets.push({ ...structuredClone(copy.assets.find((asset) => asset.path === VENDORED)),
        path: 'singularity/imports/agents/release-manager/skill-unlisted.md' });
      return copy;
    }, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA'],
    ['a record for a file it does not carry', (copy) => {
      copy.imports['skill:release-manager/elsewhere'] = { ...structuredClone(copy.imports['skill:release-manager/store-checklist']),
        target: { agent: 'release-manager', id: 'elsewhere', path: 'singularity/imports/agents/release-manager/skill-elsewhere.md' } };
      return copy;
    }, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA'],
    ['a version-3 bundle that names a copy', (copy) => {
      copy.schemaVersion = 3; delete copy.imports; delete copy.objects.story.integrations;
      copy.assets = copy.assets.filter((asset) => asset.kind !== 'vendored');
      return copy;
    }, 'WORKFLOW_AGENT_LOCK_INVALID'],
    ['a version-3 bundle that carries a copy', (copy) => { copy.schemaVersion = 3; delete copy.imports; delete copy.objects.story.integrations; return copy; },
      'WORKFLOW_BUNDLE_INVALID']
  ];
  for (const [label, edit, code] of cases) {
    await assert.rejects(() => planWorkflowImport(target, variant(edit)), (error) => error.code === code, label);
  }
});

test('export refuses an imported copy edited after it was imported', async (t) => {
  const source = await repository(t, 'sflow-transfer-conflicts-edited-');
  await addReleaseWorkflow(source);
  await writeFile(path.join(source, VENDORED), `${skillText('source')}- Edited here\n`);
  await assert.rejects(() => exportWorkflowBundle(source, ['mobile-release']),
    (error) => error.code === 'WORKFLOW_VENDORED_COPY_CHANGED');
});

test('an imported copy is reused only with exactly its bytes, because its lock pins their hash', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-crlf-');
  await addReleaseWorkflow(target);
  await writeFile(path.join(target, VENDORED), skillText('source').replaceAll('\n', '\r\n'));
  const plan = await planWorkflowImport(target, bundle);
  assert.deepEqual(plan.conflicts.map((item) => `${item.kind}:${item.id}`), [`vendored:${VENDORED}`]);
  assert.equal(plan.conflicts[0].subject, 'agent:release-manager');
});

test('a same-name conflict names its subject, who uses it here, and each choice with a free new name', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-local-');
  await addReleaseWorkflow(target, 'local');
  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'blocked');
  const bySubject = Object.fromEntries(plan.unresolved.map((item) => [item.subject, item]));
  assert.deepEqual(Object.keys(bySubject).sort(), [
    'agent:release-manager', 'agent:release-reviewer', 'approval-group:release-managers', 'phase:release-plan',
    'template-file:singularity/templates/mobile-release/intake.md',
    'template-file:singularity/templates/mobile-release/release-plan.md'
  ]);
  const phase = bySubject['phase:release-plan'];
  assert.deepEqual(phase.choices, ['keep', 'replace', 'rename']);
  assert.equal(phase.suggested, 'rename');
  assert.equal(phase.renameTo, 'release-plan-imported');
  assert.deepEqual(phase.usedBy, ['story:mobile-release']);
  // People are not duplicated by default: the repository's own group is kept.
  assert.equal(bySubject['approval-group:release-managers'].suggested, 'keep');
  // Everything an agent brings follows it: its file, lock, imported copy and that copy's record.
  assert.deepEqual(bySubject['agent:release-manager'].reasons.map((reason) => reason.split(':')[0]).sort(),
    ['agent file .github/agents/release-manager.agent.md', 'dependency lock', `import record skill`, `imported copy ${VENDORED}`].sort());
  assert.equal(bySubject['template-file:singularity/templates/mobile-release/intake.md'].renameTo,
    'singularity/templates/mobile-release/intake-imported.md');
  await assert.rejects(() => applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 }),
    (error) => error.code === 'WORKFLOW_IMPORT_CONFLICT' && /unresolved conflicts; nothing was changed/.test(error.message));
});

test('keep and replace write exactly what was chosen', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-keep-');
  await addReleaseWorkflow(target, 'local');
  const before = await readFile(path.join(target, '.github/agents/release-manager.agent.md'), 'utf8');
  const resolutions = {
    'agent:release-manager': 'keep', 'agent:release-reviewer': 'keep', 'approval-group:release-managers': 'keep',
    'phase:release-plan': 'replace', 'template-file:singularity/templates/mobile-release/intake.md': 'keep',
    'template-file:singularity/templates/mobile-release/release-plan.md': 'replace'
  };
  const plan = await planWorkflowImport(target, bundle, { resolutions });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.deepEqual(plan.replaced.map((item) => item.subject).sort(),
    ['phase:release-plan', 'template-file:singularity/templates/mobile-release/release-plan.md']);
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256, resolutions });
  const after = await configuration(target);
  assert.equal(after.phases['release-plan'].label, 'Release plan');
  assert.equal(after.approvalAuthorities['release-managers'].label, 'Release managers (local)');
  assert.equal(await readFile(path.join(target, 'singularity/templates/mobile-release/release-plan.md'), 'utf8'),
    '# {{work.id}} release plan (source)\n\n## Rollout\n\n## Rollback\n');
  assert.match(await readFile(path.join(target, 'singularity/templates/mobile-release/intake.md'), 'utf8'), /\(local\)/);
  assert.equal(await readFile(path.join(target, '.github/agents/release-manager.agent.md'), 'utf8'), before);
  assert.equal(await readFile(path.join(target, VENDORED), 'utf8'), skillText('local'));
  await loadDefinition(target);
});

test('importing under new names rewrites every reference, and nothing that exists changes', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-rename-');
  await addReleaseWorkflow(target, 'local');
  const ownBefore = await configuration(target);
  const managerBefore = await readFile(path.join(target, '.github/agents/release-manager.agent.md'), 'utf8');
  const plan = await planWorkflowImport(target, bundle, { resolveAll: 'suggested' });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.equal(plan.bundleSha256, bundle.bundleSha256, 'the plan binds the bundle as read, not its rewrite');
  // A new name changes what refers to it, which then differs from the repository's own: the
  // workflow listing the renamed step, the step sending work back to it, the server its agent uses.
  assert.deepEqual(Object.fromEntries((plan.renamed ?? []).map((item) => [item.subject, item.to])), {
    'agent:release-manager': 'release-manager-imported',
    'agent:release-reviewer': 'release-reviewer-imported',
    'mcp-server:app-store-connect': 'app-store-connect-imported',
    'phase:release-plan': 'release-plan-imported',
    'phase:store-submission': 'store-submission-imported',
    'template-file:singularity/templates/mobile-release/intake.md': 'singularity/templates/mobile-release/intake-imported.md',
    'template-file:singularity/templates/mobile-release/release-plan.md': 'singularity/templates/mobile-release/release-plan-imported.md',
    'template:release-intake': 'release-intake-imported',
    'workflow:mobile-release': 'mobile-release-imported'
  });
  assert.deepEqual(plan.kept.map((item) => item.subject), ['approval-group:release-managers']);
  const applied = await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256, resolutions: plan.resolutions });
  assert.equal(applied.renamed.length, 9);

  const after = await configuration(target);
  for (const [catalog, id] of [['workTypes', 'mobile-release'], ['phases', 'release-plan'], ['phases', 'store-submission'],
    ['templates', 'release-intake'], ['mcpServers', 'app-store-connect'], ['approvalAuthorities', 'release-managers']]) {
    assert.deepEqual(after[catalog][id], ownBefore[catalog][id], `${catalog}.${id} is unchanged`);
  }
  assert.equal(await readFile(path.join(target, '.github/agents/release-manager.agent.md'), 'utf8'), managerBefore);
  const imported = after.workTypes['mobile-release-imported'];
  assert.equal(imported.label, 'Mobile release (imported)');
  assert.deepEqual(imported.phases, ['intake', 'release-plan-imported', 'store-submission-imported']);
  assert.deepEqual(imported.templateOverrides, { intake: 'template:release-intake-imported' });
  assert.equal(imported.decisions[0].after, 'release-plan-imported');
  assert.deepEqual(imported.decisions[0].by, ['release-managers']);
  assert.deepEqual(imported.sourceReview, { mode: 'enforce', phases: ['release-plan-imported'], reviewerAgent: 'release-reviewer-imported' });
  const plan2 = after.phases['release-plan-imported'];
  assert.equal(plan2.artifact.path, 'artifacts/release-plan-imported/release-plan.md');
  assert.equal(plan2.artifact.kind, 'requirements', 'a kind is vocabulary, not a reference');
  assert.deepEqual(plan2.approval.rejectTo, ['intake', 'release-plan-imported']);
  assert.equal(plan2.defaultTemplate, 'mobile-release/release-plan-imported.md');
  assert.deepEqual(after.phases['store-submission-imported'].approval.rejectTo, ['release-plan-imported', 'store-submission-imported']);
  assert.equal(after.templates['release-intake-imported'].path, 'mobile-release/intake-imported.md');
  assert.match(await readFile(path.join(target, 'singularity/templates/mobile-release/intake-imported.md'), 'utf8'), /\(source\)/);
  assert.deepEqual(after.artifactSets['release-bundle'].members[1].authority, 'advisory');

  // The renamed agent drafts only the steps that are new here; yours still drafts your own.
  const agents = new Map((await discoverAgents(target)).map((agent) => [agent.id, agent]));
  const renamed = agents.get('release-manager-imported');
  assert.deepEqual(renamed.defaultFor, ['release-plan-imported', 'store-submission-imported']);
  assert.deepEqual(agents.get('release-manager').defaultFor, ['release-plan', 'store-submission']);
  // A server that arrived with its descriptor is theirs to run, under its new host entry.
  assert.deepEqual(renamed.tools, ['app-store-connect-imported/upload_build', 'app-store-connect-imported/submit_review']);
  const server = after.mcpServers['app-store-connect-imported'];
  assert.equal(server.hostReference, 'app-store-connect-imported');
  assert.deepEqual(server.agents, ['release-manager-imported']);
  assert.equal(await readFile(path.join(target, 'singularity/imports/mcp/app-store-connect-imported.json'), 'utf8'), DESCRIPTOR_TEXT);
  assert.deepEqual(renamed.generated.map((entry) => [entry.phase, entry.target]),
    [['store-submission-imported', 'artifacts/store-submission-imported/generated-notes.md']]);

  const lock = (await lockFile(target)).agents['release-manager-imported'];
  assert.equal(lock.source, '.github/agents/release-manager-imported.agent.md');
  assert.equal(lock.sourceSha256, sha256(await readFile(path.join(target, '.github/agents/release-manager-imported.agent.md'), 'utf8')));
  assert.equal(lock.dependencies[0].vendored, 'singularity/imports/agents/release-manager-imported/skill-store-checklist.md');
  assert.equal(await readFile(path.join(target, lock.dependencies[0].vendored), 'utf8'), skillText('source'));
  const records = (await ledger(target)).imports;
  assert.equal(records['skill:release-manager-imported/store-checklist'].target.agent, 'release-manager-imported');
  assert.equal(records['mcp-server:app-store-connect-imported'].target.path, 'singularity/imports/mcp/app-store-connect-imported.json');
  assert.deepEqual(records['mcp-server:app-store-connect-imported'].target.tools,
    ['app-store-connect-imported/upload_build', 'app-store-connect-imported/submit_review']);
  assert.equal(records['generated:release-manager-imported/release-notes'].target.phase, 'store-submission-imported');
  assert.equal(records['skill:release-manager/store-checklist'].target.agent, 'release-manager', 'your own record stays');
  await loadDefinition(target);
});

test('a server configured by hand keeps naming its host entry under a new name', async (t) => {
  const { bundle } = await releaseBundle(t, { descriptor: false });
  const target = await repository(t, 'sflow-transfer-conflicts-host-');
  const resolutions = { 'mcp-server:app-store-connect': 'rename' };
  const plan = await planWorkflowImport(target, bundle, { resolutions });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256, resolutions });
  const after = await configuration(target);
  assert.equal(after.mcpServers['app-store-connect-imported'].hostReference, 'app-store-connect');
  assert.equal(after.mcpServers['app-store-connect'], undefined);
  const agent = parseAgentDependencies(await readFile(path.join(target, '.github/agents/release-manager.agent.md'), 'utf8'));
  assert.deepEqual(agent.tools, ['app-store-connect/upload_build', 'app-store-connect/submit_review']);
});

test('choices that cannot apply are refused before anything is written', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-refuse-');
  await addReleaseWorkflow(target, 'local');
  const before = await readFile(path.join(target, 'singularity/workflow.yml'));
  const refuse = async (resolutions, code, pattern) => assert.rejects(() => planWorkflowImport(target, bundle, { resolutions }),
    (error) => error.code === code && pattern.test(error.message), JSON.stringify(resolutions));
  await refuse({ 'approval-group:product-approvers': 'keep' }, 'WORKFLOW_IMPORT_RESOLUTION_UNUSED', /does not conflict/);
  await refuse({ 'phase:release-plan': { action: 'rename', to: 'store-submission' } }, 'WORKFLOW_IMPORT_RESOLUTION_INVALID', /already exists/);
  await refuse({ 'phase:planning': 'rename' }, 'WORKFLOW_IMPORT_RESOLUTION_INVALID', /bundle has no step 'planning'/);
  await refuse({ 'template-file:singularity/templates/mobile-release/intake.md': { action: 'rename', to: 'elsewhere/intake.md' } },
    'WORKFLOW_IMPORT_RESOLUTION_INVALID', /must be a repository path under singularity\/templates\//);
  await refuse({ 'stage:x': 'keep' }, 'WORKFLOW_IMPORT_RESOLUTION_INVALID', /not something an import can resolve/);
  assert.throws(() => importResolutionOptions(['phase:release-plan']), /--resolve takes/);
  assert.throws(() => importResolutionOptions([], true), /--resolve-all takes one of/);
  assert.deepEqual(importResolutionOptions(['phase:a=rename:b', 'agent:c=keep'], 'suggested'), {
    resolutions: { 'agent:c': { action: 'keep' }, 'phase:a': { action: 'rename', to: 'b' } }, resolveAll: 'suggested'
  });
  assert.deepEqual(await readFile(path.join(target, 'singularity/workflow.yml')), before);

  // A skill step is compiled against its own ID, and Epic steps keep their canonical IDs.
  const skill = { objects: { story: { phases: { compiled: { kind: 'skill' } } }, initiative: {} } };
  assert.match(renameRefusal('phase', 'compiled', skill), /Skill step 'compiled'/);
  assert.match(renameRefusal('initiative-phase', 'epic-planning', skill), /canonical ID/);
  assert.equal(renameRefusal('phase', 'release-plan', skill), null);
});

test('a plan binds its choices, and the proposal replays exactly them', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-bind-');
  await addReleaseWorkflow(target, 'local');
  const keep = { 'agent:release-manager': 'keep', 'agent:release-reviewer': 'keep', 'approval-group:release-managers': 'keep',
    'phase:release-plan': 'keep', 'template-file:singularity/templates/mobile-release/intake.md': 'keep',
    'template-file:singularity/templates/mobile-release/release-plan.md': 'keep' };
  const replace = { ...keep, 'phase:release-plan': 'replace' };
  const kept = await planWorkflowImport(target, bundle, { resolutions: keep });
  const replaced = await planWorkflowImport(target, bundle, { resolutions: replace });
  assert.notEqual(kept.planSha256, replaced.planSha256);
  await assert.rejects(() => applyWorkflowImport(target, bundle, { expectedPlanSha256: kept.planSha256, resolutions: replace }),
    (error) => error.code === 'WORKFLOW_TRANSFER_PLAN_STALE');

  const copy = await mkdtemp(path.join(os.tmpdir(), 'sflow-transfer-conflicts-proposal-'));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(target, copy, { recursive: true });
  const { mutate } = workflowTransferProposal(replaced, { expectedPlanSha256: replaced.planSha256 });
  const result = await mutate(copy);
  assert.deepEqual(result.replaced.map((item) => item.subject), ['phase:release-plan']);
  assert.equal((await configuration(copy)).phases['release-plan'].label, 'Release plan');
});

test('the CLI lists each conflict with its --resolve choices and imports with the choices it printed', async (t) => {
  const { bundle } = await releaseBundle(t);
  const target = await repository(t, 'sflow-transfer-conflicts-cli-');
  await addReleaseWorkflow(target, 'local');
  committed(target);
  const file = path.join(target, 'release.bundle.json');
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
  const flow = (...args) => spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'), ...args], {
    cwd: target, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Transfer Test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(target, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(target, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(target, '.test-leads.json')
    }
  });
  const blocked = flow('workflow', 'import', 'release.bundle.json', '--dry-run');
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.stdout, /blocked; 6 conflicts need choices/);
  assert.match(blocked.stdout, /--resolve phase:release-plan=rename:release-plan-imported {2}import theirs as release-plan-imported; yours stays as it is \(suggested\)/);
  assert.match(blocked.stdout, /--resolve phase:release-plan=replace {2}replace yours with theirs; this also changes story:mobile-release/);
  assert.match(blocked.stdout, /--resolve approval-group:release-managers=keep {2}keep yours; the import uses your approval group \(suggested\)/);
  assert.doesNotMatch(blocked.stdout, /Confirm plan/);

  const refused = flow('workflow', 'import', 'release.bundle.json', '--confirm', `sha256:${'0'.repeat(64)}`);
  assert.notEqual(refused.status, 0);
  const ready = flow('workflow', 'import', 'release.bundle.json', '--dry-run', '--resolve-all', 'suggested');
  assert.equal(ready.status, 0, ready.stderr);
  const apply = /Apply it: singularity-flow (.+)$/m.exec(ready.stdout)?.[1];
  assert.ok(apply, ready.stdout);
  const applied = flow(...apply.split(' '));
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.match(applied.stdout, /New names: 9/);
  assert.ok((await configuration(target)).workTypes['mobile-release-imported']);

  const unresolved = await repository(t, 'sflow-transfer-conflicts-cli-refused-');
  await addReleaseWorkflow(unresolved, 'local');
  committed(unresolved);
  await writeFile(path.join(unresolved, 'release.bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  const preview = JSON.parse(spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'),
    'workflow', 'import', 'release.bundle.json', '--dry-run', '--json'], { cwd: unresolved, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }).stdout);
  const confirm = spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'),
    'workflow', 'import', 'release.bundle.json', '--confirm', preview.planSha256], { cwd: unresolved, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.notEqual(confirm.status, 0);
  const output = `${confirm.stdout}${confirm.stderr}`;
  assert.match(output, /6 unresolved conflicts; nothing was changed/);
  assert.match(output, /singularity-flow workflow import release\.bundle\.json --dry-run/);
});

test('new names reach Epic steps through their <step>/<output> references, and agent files keep their line endings', () => {
  const agent = '---\r\nname: drafter\r\ndescription: Drafts.\r\ntools: [hub/read]\r\nmetadata:\r\n  sflow-phases: "alpha"\r\n'
    + '  sflow-default-for: "alpha"\r\n---\r\n\r\n# Drafter\r\n\r\nDraft.\r\n';
  const bundle = {
    workflows: [{ governs: 'initiative', id: 'epic' }],
    objects: {
      story: {
        workTypes: {}, templates: {}, artifactSets: {}, approvalAuthorities: {},
        phases: { alpha: { label: 'Alpha', artifact: { path: 'artifacts/alpha/a.md', kind: 'alpha' } } },
        mcpServers: { hub: { hostReference: 'hub', agents: ['drafter'], phases: ['alpha'] } }
      },
      initiative: {
        approvalAuthorities: {}, applicabilityPolicies: {},
        initiativeProfiles: { epic: {
          phases: ['scope', 'plan'], templateOverrides: { 'scope/brief': 'epic/brief.md' },
          packs: [{ members: ['scope/brief', 'plan/index'] }],
          phaseOverrides: { scope: { outputs: { brief: { consumes: ['plan/index'] } } } }
        } },
        initiativePhases: {
          scope: { outputs: [{ id: 'brief' }] },
          plan: { outputs: [{ id: 'index', consumes: ['scope/brief'] }], checklist: [{ id: 'fresh', freshness: { revalidateAt: ['scope'] } }] }
        }
      }
    },
    assets: [{ kind: 'agent', id: 'drafter', path: '.github/agents/drafter.agent.md', content: agent }],
    agentLocks: {}, imports: {}, requirements: { templateRoots: {} }
  };
  renameBundleSubjects(bundle, new Map([
    ['initiative-phase:scope', 'scope-imported'], ['phase:alpha', 'alpha-imported'], ['mcp-server:hub', 'hub-imported']
  ]), { targetPhases: new Set(['alpha']), targetAgents: new Set(['drafter']), targetPath: () => '' });
  const profile = bundle.objects.initiative.initiativeProfiles.epic;
  assert.deepEqual(profile.phases, ['scope-imported', 'plan']);
  assert.deepEqual(Object.keys(profile.templateOverrides), ['scope-imported/brief']);
  assert.deepEqual(profile.packs[0].members, ['scope-imported/brief', 'plan/index']);
  assert.deepEqual(Object.keys(profile.phaseOverrides), ['scope-imported']);
  assert.deepEqual(bundle.objects.initiative.initiativePhases.plan.outputs[0].consumes, ['scope-imported/brief']);
  assert.deepEqual(bundle.objects.initiative.initiativePhases.plan.checklist[0].freshness.revalidateAt, ['scope-imported']);
  const alpha = bundle.objects.story.phases['alpha-imported'];
  assert.deepEqual(alpha, { label: 'Alpha (imported)', artifact: { path: 'artifacts/alpha-imported/a.md', kind: 'alpha' } });
  // An agent this repository already has keeps its step and gains the renamed one beside it.
  const text = bundle.assets[0].content;
  assert.match(text, /sflow-phases: "alpha,alpha-imported"\r\n/);
  assert.match(text, /sflow-default-for: "alpha,alpha-imported"\r\n/);
  assert.doesNotMatch(text, /[^\r]\n/, 'every line still ends in CRLF');
  // Configured by hand, without a descriptor: it keeps naming the host entry, and so do the tools.
  assert.match(text, /tools: \[hub\/read\]/);
  assert.equal(bundle.objects.story.mcpServers['hub-imported'].hostReference, 'hub');
  assert.deepEqual(bundle.objects.story.mcpServers['hub-imported'].phases, ['alpha-imported']);
});
