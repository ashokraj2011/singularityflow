import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { openGitDraftStore } from '../src/wca-git-drafts.mjs';
import { captureWorkflowCompilerContext, captureWorkflowDraftCompilerSource, compileWorkflowDraftPackage, previewWorkflowDraftPackage, revalidateWorkflowDraftPackage, workflowCompilerCatalogChoices, workflowDraftPackageProposalFiles, captureWorkflowDraftPackageProposal, WCA_REQUEST_SCHEMA } from '../src/wca-compiler.mjs';
import { compileConfirmedSkillPhase, compileSkillPhaseProposal, configurationPhaseFromCompiledSkill, skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { configurationAssetPolicy } from '../src/configuration-assets.mjs';
import { recordSha256 } from '../src/records.mjs';

function git(root, ...argv) { const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 30_000 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
async function fixture(t, configure = () => {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-compiler-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'client'); const remote = path.join(base, 'authority.git'); await mkdir(root);
  git(base, 'init', '--bare', remote); git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Compiler Fixture'); git(root, 'config', 'user.email', 'compiler@example.test');
  const phase = (key) => ({ label: key, artifact: { path: `artifacts/${key}/${key}.md`, minimumBytes: 20, maximumBytes: 16_384 }, defaultTemplate: 'common/empty.md', inputs: [], approval: { mode: 'none' }, writeScope: 'artifact-only', generation: { requirement: 'optional', defaultProducer: 'human', allowedProducers: ['human'], task: 'analyze' } });
  const definition = { version: 2, templatesRoot: 'singularity/templates', worldModel: { views: ['architecture', 'development', 'testing', 'security', 'business', 'operations', 'release'] }, workTypes: { baseline: { label: 'Baseline', phases: ['intake', 'conformance'] } }, phases: { intake: phase('intake'), conformance: phase('conformance') }, approvalSecurity: { profile: 'team' }, approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } } };
  const environmentDeclaration = configure(definition);
  await mkdir(path.join(root, definition.templatesRoot, 'common'), { recursive: true }); await mkdir(path.join(root, 'singularity'), { recursive: true }); await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(definition)); await writeFile(path.join(root, definition.templatesRoot, 'common/empty.md'), '# Exact approved template\n');
  if (environmentDeclaration) await writeFile(path.join(root, 'singularity/environments.yml'), YAML.stringify(environmentDeclaration));
  for (const [agent, phaseId] of [['product-owner', 'intake'], ['qa', 'conformance']]) await writeFile(path.join(root, `.github/agents/${agent}.agent.md`), `---\nname: ${agent}\ndescription: Exact base role\ntools: []\nmetadata:\n  sflow-phases: ${phaseId}\n  sflow-default-for: ${phaseId}\n---\nRead only the exact current approved inputs.\n`);
  git(root, 'add', '.'); git(root, 'commit', '-m', 'approved test source'); git(root, 'branch', 'sflow/config'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', 'main', 'sflow/config');
  const commit = git(root, 'rev-parse', 'HEAD'); const store = openGitDraftStore({ root, remote, workspaceId: 'configuration' });
  const request = { schema: WCA_REQUEST_SCHEMA, intent: 'create', id: 'team-notes', label: 'Team notes', baseRevision: commit, target: { governs: 'story', authority: 'selected-repository', hosts: [] }, bindings: { analysisTask: { kind: 'execution-task', id: 'analyze' }, review: { kind: 'approval-authority', id: 'reviewers' } }, definitions: { workflows: [{ id: 'team-notes', phases: ['intake', 'team-note', 'conformance'] }], phases: [{ id: 'team-note', label: 'Team note', artifact: { path: 'artifacts/team-note/note.md', kind: 'custom:note', minimumBytes: 20, maximumBytes: 16_384 }, inputs: ['intake'], template: 'note-template', agent: 'note-writer', taskBinding: 'analysisTask', approvalBinding: 'review', qualityBindings: [], writeScope: 'artifact-only' }], agents: [{ id: 'note-writer', description: 'Write the selected note', prompt: 'Read the exact approved intake. Produce the selected note and stop for human review.', toolBindings: [], skillRefs: [] }], templates: [{ id: 'note-template', content: '# Team note\n\n## Inputs\n\n## Findings\n\n## Open questions\n' }] } };
  return { root, remote, commit, store, request, definition };
}
async function preview(f, request = f.request, operationId = 'create-preview', assets = []) {
  const created = await f.store.create({ draftId: 'WFD-COMPILER1', displayName: 'Compiler fixture', expectedHead: null, payload: request, assets, operationId });
  const context = await captureWorkflowCompilerContext(f.root); const source = await captureWorkflowDraftCompilerSource(context, { draftId: created.record.draftId });
  return { result: compileWorkflowDraftPackage({ context, source }), context, source, created };
}

test('complete-package compiler resolves forward candidate agent/template references and emits exact deterministic inert candidate bytes', async (t) => {
  const f = await fixture(t); const before = { head: git(f.root, 'rev-parse', 'HEAD'), index: await readFile(path.join(f.root, '.git/index')), remote: git(f.root, 'ls-remote', '--heads', f.remote, 'main', 'sflow/config') };
  const p = await preview(f);
  assert.deepEqual(p.result.findings, []);
  assert.equal(p.result.readiness.authoring, 'valid'); assert.equal(p.result.readiness.simulation, 'complete-for-profile'); assert.equal(p.result.readiness.confirmation, 'absent'); assert.equal(p.result.readiness.execution, 'not-run'); assert.equal(p.result.effects.approvalGranted, false);
  assert.equal(p.result.simulation.profile, 'story-structural-lifecycle/v1');
  assert.equal(p.result.simulation.workflows.length, 1);
  assert.equal(p.result.simulation.workflows[0].effects.executed, false);
  assert.ok(p.result.simulation.workflows[0].scenarios.some((scenario) => scenario.id === 'happy-path'));
  assert.deepEqual(p.result.assets.map((asset) => asset.path), ['.github/agents/team-notes-note-writer.agent.md', 'singularity/templates/team-notes/note-template.md', 'singularity/workflow.yml']);
  assert.match(p.result.assets.find((asset) => asset.path.endsWith('.agent.md')).content, /tools: \[\]/u);
  assert.ok(p.result.dependencyLocks.some((lock) => lock.id === 'reviewers' && lock.source === 'approved-catalog'));
  assert.ok(p.result.graph.some((node) => node.phaseId === 'team-note' && node.humanReview));
  assert.equal(Object.isFrozen(p.result), true); assert.equal(Object.isFrozen(p.result.assets), true);
  assert.deepEqual(compileWorkflowDraftPackage({ context: p.context, source: p.source }), p.result);
  assert.deepEqual(await previewWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1' }), p.result, 'temporary approved-read roots do not alter identity');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.head); assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before.index); assert.equal(git(f.root, 'ls-remote', '--heads', f.remote, 'main', 'sflow/config'), before.remote);
  assert.equal(p.result.fileOperations.find((operation) => operation.path === 'singularity/workflow.yml').beforeSha256, p.context.source.workflowSha256);
  const proposal = workflowDraftPackageProposalFiles(p.result);
  assert.equal(proposal.expectedAuthority.sourceCommit, f.commit); assert.equal(proposal.expectedAuthority.commit, f.commit); assert.match(proposal.expectedAuthority.remoteFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(proposal.snapshotInputs.request, f.request); assert.deepEqual(proposal.snapshotInputs.assets, []); assert.equal(Object.isFrozen(proposal.snapshotInputs.request), true);
  assert.deepEqual(proposal.files.map((file) => ({ path: file.path, content: Buffer.from(file.contentBase64, 'base64').toString('utf8'), bytes: file.bytes, sha256: file.sha256 })), p.result.assets);
  assert.ok(proposal.files.every((file) => file.mode === '100644')); assert.equal(Object.isFrozen(proposal.files), true);
  assert.throws(() => workflowDraftPackageProposalFiles(JSON.parse(JSON.stringify(p.result))), (error) => error.code === 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  assert.deepEqual(await captureWorkflowDraftPackageProposal(f.root, { draftId: p.source.draftId, revision: p.source.revision, expectedPlanSha256: p.result.planSha256 }), proposal);
});

test('catalog choices are bounded source-pinned navigation, not reviewer membership or tool/host permission', async (t) => {
  const f = await fixture(t); const p = await preview(f); const choices = workflowCompilerCatalogChoices(p.context, { limit: 1 });
  assert.deepEqual(choices.approvedSource, p.context.source); assert.equal(choices.permissionEffect, 'none'); assert.equal(choices.membership, 'not-verified'); assert.equal(choices.hostMapping, 'not-verified');
  assert.deepEqual(choices.groups.map((group) => group.kind), ['phase', 'template', 'agent', 'workflow', 'execution-task', 'quality-command', 'approval-authority']);
  assert.ok(choices.groups.every((group) => group.choices.length <= 1));
  const authorities = choices.groups.find((group) => group.kind === 'approval-authority');
  assert.deepEqual(authorities.choices, [{ ref: { source: 'catalog', kind: 'approval-authority', id: 'reviewers' }, label: 'Reviewers' }]);
  assert.equal(JSON.stringify(choices).includes('reviewer@example.test'), false);
  const tasks = choices.groups.find((group) => group.kind === 'execution-task');
  assert.equal(tasks.nextCursor, 1); const second = workflowCompilerCatalogChoices(p.context, { kind: 'execution-task', cursor: tasks.nextCursor, limit: 1 });
  assert.notEqual(second.groups[0].choices[0].ref.id, tasks.choices[0].ref.id); assert.equal(Object.isFrozen(second.groups[0].choices), true);
  assert.throws(() => workflowCompilerCatalogChoices({ ...p.context, approved: true }), (error) => error.code === 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  assert.throws(() => workflowCompilerCatalogChoices(p.context, { kind: 'native-tools' }), (error) => error.code === 'WCA_REQUEST_INVALID');
  assert.throws(() => workflowCompilerCatalogChoices(p.context, { limit: 65 }), (error) => error.code === 'WCA_REQUEST_INVALID');
  assert.deepEqual(p.result.catalogChoices, workflowCompilerCatalogChoices(p.context));
});

test('custom managed roots retain only the exact approved asset policy in immutable preview and proposal captures', async (t) => {
  const f = await fixture(t, (definition) => { definition.templatesRoot = 'company/templates'; definition.worldModel.outputDir = 'company/templates/generated'; });
  // A mutable application projection is not permission to add another transport root.
  const live = structuredClone(f.definition); live.templatesRoot = 'unapproved/templates';
  await writeFile(path.join(f.root, 'singularity/workflow.yml'), YAML.stringify(live));
  const p = await preview(f); const expected = configurationAssetPolicy(f.definition);
  assert.deepEqual(p.result.findings, []); assert.equal(p.result.readiness.authoring, 'valid');
  assert.ok(p.result.assets.some((asset) => asset.path === 'company/templates/team-notes/note-template.md'));
  assert.deepEqual(p.result.approvedAssetPolicy, expected);
  assert.equal(Object.isFrozen(p.result.approvedAssetPolicy), true);
  assert.equal(Object.isFrozen(p.result.approvedAssetPolicy.runtimeRoots), true);
  const proposal = workflowDraftPackageProposalFiles(p.result);
  assert.deepEqual(proposal.assetPolicy, expected); assert.equal(Object.isFrozen(proposal.assetPolicy.roots), true);
  assert.equal(proposal.assetPolicy.roots.includes('unapproved/templates'), false);
  const { planSha256, ...core } = p.result;
  assert.equal(planSha256, `sha256:${recordSha256(core)}`);
  const altered = structuredClone(core); altered.approvedAssetPolicy.roots.push('unapproved/templates');
  assert.notEqual(`sha256:${recordSha256(altered)}`, planSha256, 'exact review identity binds the approved policy');
  const alteredSimulation = structuredClone(core);
  alteredSimulation.simulation.profile = 'different-lifecycle-profile';
  assert.notEqual(`sha256:${recordSha256(alteredSimulation)}`, planSha256, 'exact review identity binds simulation profile and scenarios');
  assert.deepEqual(await captureWorkflowDraftPackageProposal(f.root, { draftId: p.source.draftId,
    revision: p.source.revision, expectedPlanSha256: planSha256 }), proposal);
});

test('safe incomplete storage is separate from complete-package gaps and JSON approval flags cannot forge compiler provenance', async (t) => {
  const f = await fixture(t); const p = await preview(f, { description: 'Safe incomplete text', unresolved: ['phase'] });
  assert.equal(p.result.readiness.authoring, 'invalid'); assert.equal(p.result.assets.length, 0); assert.equal(p.result.fileOperations.length, 0);
  assert.throws(() => compileWorkflowDraftPackage({ context: { ...p.context, approved: true }, source: p.source }), (error) => error.code === 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  assert.throws(() => compileWorkflowDraftPackage({ context: p.context, source: { ...p.source } }), (error) => error.code === 'WCA_COMPILER_SOURCE_UNAVAILABLE');
});

test('compiler refuses stale bases, unknown references, duplicate phases, input cycles and new native tool grants without emitting files', async (t) => {
  const cases = [
    ['stale-base', (r) => { r.baseRevision = 'b'.repeat(40); }, 'WCA_BASE_REVISION_STALE'],
    ['missing-reviewer', (r) => { r.bindings.review.id = 'invented-reviewers'; }, 'WCA_REFERENCE_MISSING'],
    ['duplicate-order', (r) => { r.definitions.workflows[0].phases.splice(2, 0, 'team-note'); }, 'WCA_GRAPH_INVALID'],
    ['cycle', (r) => { r.definitions.phases[0].inputs = ['team-note']; }, 'WCA_INPUT_ORDER_INVALID'],
    ['tool-grant', (r) => { r.definitions.agents[0].toolBindings = ['shell']; }, 'WCA_OPERATION_MAPPING_UNAVAILABLE'],
    ['source-write', (r) => { r.definitions.phases[0].writeScope = 'source-and-artifact'; }, 'WCA_PERMISSION_UNAPPROVED'],
    ['shadow', (r) => { r.definitions.templates[0].id = 'sf-privileged'; }, 'WCA_OBJECT_COLLISION'],
    ['old-version', (r) => { r.schema = 'sflow-workflow-request@1'; }, 'WCA_REQUEST_UNSUPPORTED'],
    ['malformed-change', (r) => { r.changes = { delete: 'intake' }; }, 'WCA_REQUEST_INVALID'],
    ['malformed-execution', (r) => { r.executionProposals = { command: 'arbitrary' }; }, 'WCA_REQUEST_INVALID'],
    ['unclaimed-asset', (r) => { r.assets = [{ path: 'unclaimed.md', content: '# Must not be silently lost' }]; }, 'WCA_ASSET_UNCLAIMED'],
    ['candidate-catalog-alias', (r) => { r.bindings.proposedAgent = { source: 'candidate', kind: 'agent', id: 'note-writer' }; }, 'WCA_CATALOG_REFERENCE_INVALID'],
    ['malformed-empty-skillrefs', (r) => { r.definitions.agents[0].skillRefs = ''; }, 'WCA_REQUEST_INVALID']
  ];
  for (const [label, change, expected] of cases) await t.test(label, async (child) => {
    const f = await fixture(child); change(f.request); const p = await preview(f);
    assert.ok(p.result.findings.some((finding) => finding.code === expected), JSON.stringify(p.result.findings));
    assert.equal(p.result.assets.length, 0); assert.equal(p.result.fileOperations.length, 0); assert.equal(p.result.effects.executed, false);
  });
});

test('captured content attachments are consumed exactly and explicit candidate agent references preserve default mapping', async (t) => {
  const f = await fixture(t); const template = f.request.definitions.templates[0]; const content = template.content;
  delete template.content; template.contentAsset = 'chosen-template.md';
  f.request.assets = [{ path: 'chosen-template.md', mediaType: 'text/markdown', content }];
  f.request.definitions.phases[0].agent = { ref: { source: 'candidate', kind: 'agent', id: 'note-writer' } };
  const p = await preview(f); assert.deepEqual(p.result.findings, []);
  assert.equal(p.result.assets.find((asset) => asset.path.endsWith('note-template.md')).content, content);
  assert.match(p.result.assets.find((asset) => asset.path.endsWith('.agent.md')).content, /sflow-default-for: team-note/u);
});

test('proposal capture independently retains literal request and stored content bytes after the shared draft moves', async (t) => {
  const f = await fixture(t); const template = f.request.definitions.templates[0]; const content = template.content;
  delete template.content; template.contentAsset = 'retained-template.md';
  const p = await preview(f, f.request, 'create-retained-preview', [{ path: 'retained-template.md', content: Buffer.from(content) }]);
  const proposal = workflowDraftPackageProposalFiles(p.result); const retained = proposal.snapshotInputs.assets[0];
  assert.equal(retained.path, 'retained-template.md'); assert.equal(Buffer.from(retained.contentBase64, 'base64').toString('utf8'), content);
  assert.equal(retained.bytes, Buffer.byteLength(content)); assert.match(retained.sha256, /^sha256:[a-f0-9]{64}$/u);
  const changed = structuredClone(f.request); changed.definitions.templates[0] = { id: 'note-template', content: '# Replacement, separately retained' };
  await f.store.appendRevision({ draftId: p.source.draftId, expectedHead: p.created.head, epoch: 1, operationId: 'move-retained-draft', patch: { payload: changed, assets: [] } });
  assert.deepEqual(proposal.snapshotInputs.request, f.request); assert.equal(Buffer.from(proposal.snapshotInputs.assets[0].contentBase64, 'base64').toString('utf8'), content);
  await assert.rejects(captureWorkflowDraftPackageProposal(f.root, { draftId: p.source.draftId, revision: p.source.revision, expectedPlanSha256: p.result.planSha256 }), (error) => error.code === 'WCA_PREVIEW_STALE');
});

test('approved environment-local output policy cannot be removed by editing the live application declaration', async (t) => {
  const declaration = { schemaVersion: 1, environments: { local: { requires: [{ name: 'FEATURE_ENABLED', kind: 'flag', default: 'false' }], localFiles: [] } }, neverCommit: ['singularity/templates/team-notes/*.md'] };
  const f = await fixture(t, () => declaration);
  await writeFile(path.join(f.root, 'singularity/environments.yml'), YAML.stringify({ ...declaration, neverCommit: [] }));
  const p = await preview(f); assert.ok(p.result.findings.some((finding) => finding.code === 'WCA_ENVIRONMENT_LOCAL_CONTENT_UNADMITTED'));
  assert.equal(p.result.assets.length, 0); assert.equal(p.result.effects.configurationWritten, false);
});

test('exact existing check IDs need not be candidate path IDs and ambiguous approved bodies are not selectable', async (t) => {
  const command = { id: 'check:lint', argv: ['node', '--version'], modelPolicy: 'never', kind: 'lint', requirement: 'required' };
  const f = await fixture(t, (definition) => { definition.phases.intake.qualityCommands = [command]; });
  f.request.bindings.lint = { ref: { source: 'catalog', kind: 'quality-command', id: 'check:lint' } }; f.request.definitions.phases[0].qualityBindings = ['lint'];
  const p = await preview(f); assert.deepEqual(p.result.findings, []);
  assert.deepEqual(p.result.candidateDefinition.phases['team-note'].qualityCommands[0].argv, command.argv);
  assert.ok(p.result.catalogChoices.groups.find((group) => group.kind === 'quality-command').choices.some((choice) => choice.ref.id === command.id));
  const ambiguous = await fixture(t, (definition) => { definition.phases.intake.qualityCommands = [command]; definition.phases.conformance.qualityCommands = [{ ...command, argv: ['node', '--help'] }]; });
  ambiguous.request.bindings.lint = { kind: 'quality-command', id: command.id }; const q = await preview(ambiguous);
  assert.ok(q.result.findings.some((finding) => finding.code === 'WCA_REFERENCE_MISSING'));
  const choices = q.result.catalogChoices.groups.find((group) => group.kind === 'quality-command'); assert.equal(choices.unavailable, 1); assert.deepEqual(choices.choices, []);
});

test('exact preview revalidation refuses changed draft contents and changed approved source without rebasing the plan', async (t) => {
  const f = await fixture(t); const p = await preview(f);
  assert.equal((await revalidateWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1', revision: 1, expectedPlanSha256: p.result.planSha256 })).planSha256, p.result.planSha256);
  const changed = structuredClone(f.request); changed.definitions.agents[0].prompt += ' Changed literal instructions.';
  await f.store.appendRevision({ draftId: 'WFD-COMPILER1', expectedHead: p.created.head, epoch: 1, operationId: 'change-preview', patch: { payload: changed } });
  await assert.rejects(revalidateWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1', revision: 1, expectedPlanSha256: p.result.planSha256 }), (error) => error.code === 'WCA_PREVIEW_STALE');
  const newer = await previewWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1' });
  const replaced = structuredClone(f.definition); replaced.approvalAuthorities.reviewers.label = 'Changed approved reviewer catalog';
  await writeFile(path.join(f.root, 'singularity/workflow.yml'), YAML.stringify(replaced));
  git(f.root, 'add', 'singularity/workflow.yml'); git(f.root, 'commit', '-m', 'changed approved policy'); git(f.root, 'push', 'origin', 'HEAD:refs/heads/sflow/config');
  await assert.rejects(revalidateWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1', revision: 2, expectedPlanSha256: newer.planSha256 }), (error) => error.code === 'WCA_PREVIEW_STALE');
});

test('a complete new skill package is lowered proposal-only with exact output roles and no fabricated confirmed runtime binding', async (t) => {
  const f = await fixture(t, (definition) => { definition.phases.intake.qualityCommands = [{ id: 'check:lint', argv: ['node', '--version'], modelPolicy: 'never', kind: 'lint', requirement: 'required' }]; });
  f.request.definitions.skills = [{ id: 'analysis-procedure', description: 'Produce the exact findings artifact', instructions: 'Read the approved intake. Record explicit findings. Do not edit source. Stop for review.', operationBindings: [], resources: [] }];
  f.request.definitions.phases[0] = { id: 'team-note', kind: 'skill', label: 'Team findings', agent: 'note-writer', skill: { id: 'analysis-procedure' }, contract: { task: 'analyze', consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }], produces: [{ id: 'primary', path: 'artifacts/team-note/note.md', kind: 'custom:note', mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16_384, clauses: 'optional', claimRole: 'findings' }], checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 } } };
  f.request.definitions.phases[0].contract.checks = ['check:lint'];
  const p = await preview(f);
  assert.equal(p.result.skillProposals.length, 1, JSON.stringify(p.result.findings));
  const proposal = p.result.skillProposals[0];
  assert.equal(proposal.eligibility, 'proposed-candidate-producer'); assert.equal(proposal.bindingRefs.confirmation, undefined);
  assert.equal(proposal.bindingRefs.outputs[0].claimRole, 'findings'); assert.equal(proposal.bindingRefs.readScope.inputs, true);
  assert.equal(proposal.bindingRefs.checks[0].id, 'check:lint'); assert.deepEqual(proposal.phasePolicy.qualityCommands[0].argv, ['node', '--version']);
  assert.match(proposal.bindingRefs.skill.packageSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(p.result.findings.some((finding) => finding.code === 'WCA_SKP_CONFIRMATION_BINDING_PENDING'));
  assert.ok(p.result.graph.some((node) => node.kind === 'skill-proposal' && node.runtimeBinding === 'absent'));
  assert.equal(p.result.assets.length, 0); assert.equal(p.result.effects.approvalGranted, false);
  assert.throws(() => workflowDraftPackageProposalFiles(p.result), (error) => error.code === 'WCA_PACKAGE_NOT_SUBMITTABLE');
});

test('proposal-only SKP lowering preserves confirmed policy but cannot create a runtime binding or accept proposed eligibility as approval', () => {
  const h = (c) => `sha256:${c.repeat(64)}`;
  const phase = { id: 'note', kind: 'skill', label: 'Note', skill: { id: 'note', packageSha256: h('a') }, contract: { task: 'analyze', consumes: [], produces: [{ id: 'primary', path: 'artifacts/note/note.md', kind: 'custom:note', mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 4000, clauses: 'none', claimRole: 'findings' }], checks: [], writeScope: 'artifact-only', readScope: { inputs: false, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 } } };
  const catalog = { skillPackages: { note: { packageSha256: h('a'), eligibility: 'candidate-producer' } }, phases: {}, checks: {}, readPaths: [], sourceScopes: {}, approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } }, approvalSecurity: { profile: 'team' } };
  const phaseOrder = ['intake', 'note', 'conformance']; const catalogSha256 = skillCandidateCatalogSha256(catalog);
  const confirmation = { contractSha256: skillContractSha256('note', phase.contract), packageSha256: h('a'), catalogSha256, candidateSha256: skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256), planSha256: h('b'), draftRevision: 1 };
  const confirmed = compileConfirmedSkillPhase({ phase, catalog, phaseOrder, confirmation }); const proposed = compileSkillPhaseProposal({ phase, catalog, phaseOrder });
  assert.deepEqual(proposed.phasePolicy, confirmed.phasePolicy);
  const { confirmation: ignored, ...refs } = confirmed.bindingRefs; assert.deepEqual(proposed.bindingRefs, refs);
  assert.equal(proposed.status, 'proposal-only'); assert.equal(proposed.confirmation, 'absent'); assert.equal(proposed.compilationSha256, undefined);
  assert.throws(() => configurationPhaseFromCompiledSkill(proposed));
  assert.throws(() => compileSkillPhaseProposal({ phase, catalog, phaseOrder, confirmation }), (error) => error.code === 'SKP_CONTRACT_CONFLICT');
  catalog.skillPackages.note.eligibility = 'proposed-candidate-producer';
  assert.equal(compileSkillPhaseProposal({ phase, catalog, phaseOrder }).eligibility, 'proposed-candidate-producer');
  assert.throws(() => compileConfirmedSkillPhase({ phase, catalog, phaseOrder, confirmation }), (error) => error.code === 'SKP_SKILL_NOT_PHASE_PRODUCER');
});
