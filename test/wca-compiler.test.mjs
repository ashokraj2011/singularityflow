import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { openGitDraftStore } from '../src/wca-git-drafts.mjs';
import { captureWorkflowCompilerContext, captureWorkflowDraftCompilerSource, compileWorkflowDraftPackage, previewWorkflowDraftPackage, revalidateWorkflowDraftPackage, workflowCompilerCatalogChoices, workflowDraftPackageProposalFiles, captureWorkflowDraftPackageProposal, WCA_REQUEST_SCHEMA } from '../src/wca-compiler.mjs';
import { compileConfirmedSkillPhase, compileSkillPhaseProposal, configurationPhaseFromCompiledSkill, skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { configurationAssetPolicy } from '../src/configuration-assets.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { validateWorkflowSkillFinalizationRecord } from '../src/wca-skp-finalization.mjs';
import { workflowDefinitionSha256, phaseDefinitionSha256, agentTextSha256, templateDefinitionSha256,
  WCA_SHARED_PHASE_CHANGES_PROFILE, WCA_SHARED_AGENT_CHANGES_PROFILE, WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE,
  WCA_SHARED_SKILL_CONTRACT_CHANGES_PROFILE, WCA_SHARED_SKILL_CONTRACT_GROUP_PLAN_PROFILE,
  WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE, planSharedSkillContractGroupChanges,
  WCA_SHARED_TEMPLATE_CHANGES_PROFILE } from '../src/wca-workflow-changes.mjs';
import { sharedSkillContractCatalog } from '../src/wca-skill-contract-review.mjs';
import { parseAgentDependencies } from '../src/agents.mjs';
import { validateWorkflowDraftSubmissionSnapshot } from '../src/wca-submission.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { configurationReadSnapshot } from '../src/configuration-read-scope.mjs';
import { captureVerifiedConfigurationAssetBytes } from '../src/configuration-branch.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';

// These fixture workflows exercise configuration authoring, not delivery, and say so for each
// responsibility a Story would otherwise owe; omitting one a route does hold is only a warning.
const OMITS = ['scope', 'plan', 'implement', 'verify', 'review'].map((responsibility) => ({ responsibility, reason: 'A configuration-authoring fixture that exercises no delivery.', authority: 'reviewers' }));

function git(root, ...argv) { const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 30_000 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
const testDigest = (value) => `sha256:${recordSha256(value)}`;
const testDomainDigest = (domain, value) => `sha256:${createHash('sha256').update(`${domain}\0`).update(canonicalJson(value)).digest('hex')}`;
function resealGroupedHistorical(value) {
  const { subject, record, definition, files } = value;
  const { subjectSha256: omittedSubjectSha256, ...subjectCore } = subject;
  subject.subjectSha256 = testDomainDigest(subject.profile, subjectCore);
  const reviewCore = { schemaVersion: 1, kind: 'workflow-authoring-skp-consent-plan', subject,
    revision: subject.subjectSha256, effect: subject.intendedEffect,
    approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
  const reviewHash = recordSha256(reviewCore);
  const planId = `wca-skp-${reviewHash.slice(0, 24)}`;
  const actionId = `workflow-skp-confirm-${reviewHash.slice(0, 24)}`;
  record.preConsentSubjectSha256 = subject.subjectSha256;
  record.confirmation.actionPlanSha256 = `sha256:${reviewHash}`;
  record.confirmation.questionId = recordSha256({ planId, actionId, channel: 'terminal' }).slice(0, 24);
  const phases = subject.phases.map((row) => {
    const configuredPhase = definition.phases[row.phaseId];
    configuredPhase.skillBinding.bindingRefs.confirmation.planSha256 = subject.subjectSha256;
    const { kind: omittedKind, skillBinding, ...phasePolicy } = configuredPhase;
    skillBinding.compilationSha256 = testDigest({ compiler: skillBinding.compiler,
      phaseId: row.phaseId, phasePolicy, bindingRefs: skillBinding.bindingRefs });
    return { phaseId: row.phaseId, configuredPhase, compilationSha256: skillBinding.compilationSha256 };
  }).sort((a, b) => a.phaseId < b.phaseId ? -1 : a.phaseId > b.phaseId ? 1 : 0);
  record.confirmedBindingsSha256 = testDigest(phases);
  record.emittedDefinitionSha256 = testDigest(definition);
  const workflow = files.find((file) => file.path === 'singularity/workflow.yml');
  const bytes = Buffer.from(YAML.stringify(definition));
  Object.assign(workflow, { bytes: bytes.length,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    contentBase64: bytes.toString('base64') });
  record.emittedClosureSha256 = testDigest(files.map(({ path: file, mode, bytes: size, sha256 }) =>
    ({ path: file, mode, bytes: size, sha256 })));
  const { finalizationSha256: omittedFinalizationSha256, ...recordCore } = record;
  record.finalizationSha256 = testDomainDigest(record.profile, recordCore);
  return value;
}
function resealGroupedAsOrdinarySnapshot(value) {
  const subject = value.preview.skillFinalization.subject;
  const record = value.preview.skillFinalization.record;
  delete subject.replacementGroup;
  subject.kind = 'workflow-authoring-skp-preconsent-subject';
  subject.profile = 'wca-skp-preconsent/v1';
  record.kind = 'workflow-authoring-skp-finalization';
  record.profile = 'wca-skp-finalization/v1';
  record.bindingDialect = subject.profile;
  resealGroupedHistorical({ subject, record, definition: value.preview.candidateDefinition,
    files: value.files, retainedInputs: value.inputs });
  const pending = value.preConsentPreview;
  pending.skillFinalization.subject = structuredClone(subject);
  const reviewCore = { schemaVersion: 1, kind: 'workflow-authoring-skp-consent-plan', subject,
    revision: subject.subjectSha256, effect: subject.intendedEffect,
    approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
  const planHash = recordSha256(reviewCore);
  pending.skillFinalization.review = { plan: { ...reviewCore, planId: `wca-skp-${planHash.slice(0, 24)}`, planHash },
    action: { actionId: `workflow-skp-confirm-${planHash.slice(0, 24)}`, label: 'Review skill contracts',
      effect: subject.intendedEffect, confirmation: { required: true, mode: 'one-time-authorization' } } };
  const { planSha256: omittedPendingSha256, ...pendingCore } = pending;
  pending.planSha256 = testDigest(pendingCore);
  const workflowFile = value.files.find((file) => file.path === 'singularity/workflow.yml');
  const workflowAsset = value.preview.assets.find((asset) => asset.path === workflowFile.path);
  Object.assign(workflowAsset, { content: Buffer.from(workflowFile.contentBase64, 'base64').toString('utf8'),
    bytes: workflowFile.bytes, sha256: workflowFile.sha256 });
  value.preview.candidateAssetManifestSha256 = testDigest(value.preview.assets.map(({ path: file, bytes, sha256 }) =>
    ({ path: file, bytes, sha256 })));
  const { planSha256: omittedPreviewSha256, ...previewCore } = value.preview;
  value.preview.planSha256 = testDigest(previewCore);
  value.kind = 'workflow-authoring-skill-submission-snapshot';
  value.confirmation = structuredClone(record.confirmation);
  value.finalizationSha256 = record.finalizationSha256;
  value.snapshotId = record.finalizationSha256.slice(7);
  value.operationRef = { owner: 'configuration-proposal', operation: 'author', subject: value.snapshotId.slice(0, 24) };
  const { snapshotSha256: omittedSnapshotSha256, ...snapshotCore } = value;
  value.snapshotSha256 = testDigest(snapshotCore);
  return value;
}
async function fixture(t, configure = () => {}, approvedSkills = []) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-compiler-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'client'); const remote = path.join(base, 'authority.git'); await mkdir(root);
  git(base, 'init', '--bare', remote); git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Compiler Fixture'); git(root, 'config', 'user.email', 'compiler@example.test');
  const phase = (key) => ({ label: key, artifact: { path: `artifacts/${key}/${key}.md`, minimumBytes: 20, maximumBytes: 16_384 }, defaultTemplate: 'common/empty.md', inputs: [], approval: { mode: 'none' }, writeScope: 'artifact-only', generation: { requirement: 'optional', defaultProducer: 'human', allowedProducers: ['human'], task: 'analyze' } });
  const definition = { version: 2, templatesRoot: 'singularity/templates', worldModel: { views: ['architecture', 'development', 'testing', 'security', 'business', 'operations', 'release'] }, workTypes: { baseline: { label: 'Baseline', phases: ['intake', 'conformance'], omits: OMITS } }, phases: { intake: phase('intake'), conformance: phase('conformance') }, approvalSecurity: { profile: 'team' }, approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } } };
  const environmentDeclaration = configure(definition);
  await mkdir(path.join(root, definition.templatesRoot, 'common'), { recursive: true }); await mkdir(path.join(root, 'singularity'), { recursive: true }); await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(definition)); await writeFile(path.join(root, definition.templatesRoot, 'common/empty.md'), '# Exact approved template\n');
  if (environmentDeclaration) await writeFile(path.join(root, 'singularity/environments.yml'), YAML.stringify(environmentDeclaration));
  for (const [agent, phaseId] of [['product-owner', 'intake'], ['qa', 'conformance']]) await writeFile(path.join(root, `.github/agents/${agent}.agent.md`), `---\nname: ${agent}\ndescription: Exact base role\ntools: []\nmetadata:\n  sflow-phases: ${phaseId}\n  sflow-default-for: ${phaseId}\n---\nRead only the exact current approved inputs.\n`);
  for (const phaseId of Object.keys(definition.phases).filter((key) => !['intake', 'conformance'].includes(key))) await writeFile(path.join(root, `.github/agents/${phaseId}-owner.agent.md`), `---\nname: ${phaseId}-owner\ndescription: Exact additional role\ntools: []\nmetadata:\n  sflow-phases: ${phaseId}\n  sflow-default-for: ${phaseId}\n---\nRead only exact approved inputs.\n`);
  for (const relative of approvedSkills) {
    const file = path.join(root, 'singularity/skills/inert-note', relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, relative === 'SKILL.md' ? '---\nname: inert-note\ndescription: Approved existing procedure\n---\nReport the approved note.\n' : 'Approved retained resource.\n');
  }
  git(root, 'add', '.'); git(root, 'commit', '-m', 'approved test source'); git(root, 'branch', 'sflow/config'); git(root, 'remote', 'add', 'origin', remote); git(root, 'push', 'origin', 'main', 'sflow/config');
  const commit = git(root, 'rev-parse', 'HEAD'); const store = openGitDraftStore({ root, remote, workspaceId: 'configuration' });
  const request = { schema: WCA_REQUEST_SCHEMA, intent: 'create', id: 'team-notes', label: 'Team notes', baseRevision: commit, target: { governs: 'story', authority: 'selected-repository', hosts: [] }, bindings: { analysisTask: { kind: 'execution-task', id: 'analyze' }, review: { kind: 'approval-authority', id: 'reviewers' } }, definitions: { workflows: [{ id: 'team-notes', phases: ['intake', 'team-note', 'conformance'], omits: OMITS }], phases: [{ id: 'team-note', label: 'Team note', artifact: { path: 'artifacts/team-note/note.md', kind: 'custom:note', minimumBytes: 20, maximumBytes: 16_384 }, inputs: ['intake'], template: 'note-template', agent: 'note-writer', taskBinding: 'analysisTask', approvalBinding: 'review', qualityBindings: [], writeScope: 'artifact-only' }], agents: [{ id: 'note-writer', description: 'Write the selected note', prompt: 'Read the exact approved intake. Produce the selected note and stop for human review.', toolBindings: [], skillRefs: [] }], templates: [{ id: 'note-template', content: '# Team note\n\n## Inputs\n\n## Findings\n\n## Open questions\n' }] } };
  return { root, remote, commit, store, request, definition };
}
async function preview(f, request = f.request, operationId = 'create-preview', assets = []) {
  const created = await f.store.create({ draftId: 'WFD-COMPILER1', displayName: 'Compiler fixture', expectedHead: null, payload: request, assets, operationId });
  const context = await captureWorkflowCompilerContext(f.root); const source = await captureWorkflowDraftCompilerSource(context, { draftId: created.record.draftId });
  return { result: compileWorkflowDraftPackage({ context, source }), context, source, created };
}

function sharedPhaseRequest(f, phaseId = 'intake') {
  return { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'shared-phase-review', label: 'Reviewed shared phase',
    baseRevision: f.commit, target: f.request.target,
    changes: [{ profile: WCA_SHARED_PHASE_CHANGES_PROFILE, kind: 'phase', id: phaseId,
      operation: 'edit', expectedDefinitionSha256: phaseDefinitionSha256(f.definition.phases[phaseId]) }],
    definitions: { phases: [{ id: phaseId, replacement: { ...structuredClone(f.definition.phases[phaseId]), label: 'Exact reviewed shared phase' } }] } };
}

async function sharedAgentRequest(f) {
  const text = await readFile(path.join(f.root, '.github/agents/product-owner.agent.md'), 'utf8');
  return { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'shared-agent-review', label: 'Reviewed shared agent prose',
    baseRevision: f.commit, target: f.request.target,
    changes: [{ profile: WCA_SHARED_AGENT_CHANGES_PROFILE, kind: 'agent', id: 'product-owner', operation: 'edit', expectedTextSha256: agentTextSha256(text) }],
    definitions: { agents: [{ id: 'product-owner', text: text.replace('Read only the exact current approved inputs.', 'Read only the exact retained approved inputs. Stop for governed human review.') }] } };
}
async function sharedTemplateRequest(f, reference = 'path:common/empty.md') {
  const content = await readFile(path.join(f.root, f.definition.templatesRoot, 'common/empty.md'), 'utf8');
  const raw = reference.startsWith('template:') ? f.definition.templates[reference.slice(9)] : null;
  return { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'shared-template-review', label: 'Reviewed shared template content',
    baseRevision: f.commit, target: f.request.target,
    changes: [{ profile: WCA_SHARED_TEMPLATE_CHANGES_PROFILE, kind: 'template', id: reference, operation: 'edit',
      expectedDefinitionSha256: raw === null ? null : templateDefinitionSha256(raw), expectedContentSha256: `sha256:${createHash('sha256').update(content).digest('hex')}` }],
    definitions: { templates: [{ id: reference, content: '# Exact reviewed template {{work.id}}\n\n## Findings\n\nRead only exact approved inputs.\n' }] } };
}

async function skillContractFixture(t) {
  const contents = new Map([['SKILL.md', Buffer.from('---\nname: inert-note\ndescription: Approved existing procedure\n---\nReport the approved note.\n')],
    ['references/note.txt', Buffer.from('Approved retained resource.\n')]]);
  const { manifest } = inspectSkillPackageContents('inert-note', contents);
  const phase = { id: 'skill-note', kind: 'skill', label: 'Skill note',
    skill: { id: 'inert-note', packageSha256: manifest.packageSha256 }, contract: { task: 'analyze',
      consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }],
      produces: [{ id: 'report', path: 'artifacts/skill-note/report.md', kind: 'custom:note', mediaType: 'text/markdown', encoding: 'utf-8',
        minimumBytes: 20, maximumBytes: 16384, clauses: 'none', claimRole: 'findings' }], checks: [], writeScope: 'artifact-only',
      readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 }, clarification: { mode: 'off' } } };
  const phaseOrder = ['intake', 'skill-note', 'conformance'];
  const f = await fixture(t, (definition) => {
    definition.version = 3;
    const catalog = { skillPackages: { 'inert-note': { packageSha256: manifest.packageSha256, eligibility: 'candidate-producer' } },
      phases: { intake: { outputs: [{ id: 'primary', path: definition.phases.intake.artifact.path }] } }, checks: {},
      approvalAuthorities: definition.approvalAuthorities, approvalSecurity: definition.approvalSecurity, artifactSets: {}, readPaths: [], sourceScopes: {} };
    const proposal = compileSkillPhaseProposal({ phase, catalog, phaseOrder });
    definition.phases['skill-note'] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({ phase, catalog, phaseOrder,
      confirmation: { contractSha256: proposal.bindingRefs.contractSha256, catalogSha256: proposal.bindingRefs.catalogSha256,
        packageSha256: manifest.packageSha256, candidateSha256: proposal.candidateSha256, planSha256: `sha256:${'a'.repeat(64)}`, draftRevision: 1 } }));
    definition.workTypes.baseline.phases = phaseOrder;
    definition.workTypes.sibling = { label: 'Sibling', phases: [...phaseOrder], omits: OMITS };
  }, ['SKILL.md', 'references/note.txt']);
  const replacement = structuredClone(phase); replacement.contract.produces[0].minimumBytes = 32;
  return { ...f, replacementRequest: { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'skill-contract-review', label: 'Reviewed skill note contract',
    baseRevision: f.commit, target: f.request.target,
    changes: [{ profile: WCA_SHARED_SKILL_CONTRACT_CHANGES_PROFILE, kind: 'phase', id: phase.id, operation: 'edit',
      expectedDefinitionSha256: phaseDefinitionSha256(f.definition.phases[phase.id]) }],
    definitions: { phases: [{ ...replacement, agent: { source: 'catalog', kind: 'agent', id: 'skill-note-owner' } }] } } };
}

async function multiSkillContractFixture(t, { distinctPackages = false, templateOverrides = false } = {}) {
  const f = await skillContractFixture(t);
  const first = structuredClone(f.replacementRequest.definitions.phases[0]);
  first.contract.produces[0].minimumBytes = 20;
  const second = structuredClone(first);
  second.id = 'skill-summary'; second.label = 'Skill summary';
  second.contract.consumes = [{ phase: 'skill-note', output: 'report', required: true, state: 'approved' }];
  second.contract.produces[0].path = 'artifacts/skill-summary/report.md';
  second.agent = { source: 'catalog', kind: 'agent', id: 'skill-summary-owner' };
  const order = ['intake', 'skill-note', 'skill-summary', 'conformance'];
  const declaration = ({ agent, ...phase }) => phase;
  const initialCatalog = sharedSkillContractCatalog(f.definition, 'skill-note');
  if (distinctPackages) {
    const contents = new Map([['SKILL.md', Buffer.from('---\nname: summary-note\ndescription: Approved summary procedure\n---\nSummarize only approved inputs.\n')]]);
    const { manifest } = inspectSkillPackageContents('summary-note', contents);
    second.skill = { id: 'summary-note', packageSha256: manifest.packageSha256 };
    initialCatalog.skillPackages['summary-note'] = { packageSha256: manifest.packageSha256, eligibility: 'candidate-producer' };
    await mkdir(path.join(f.root, 'singularity/skills/summary-note'), { recursive: true });
    await writeFile(path.join(f.root, 'singularity/skills/summary-note/SKILL.md'), contents.get('SKILL.md'));
  }
  const initialProposal = compileSkillPhaseProposal({ phase: declaration(second), catalog: initialCatalog, phaseOrder: order });
  f.definition.phases['skill-summary'] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
    phase: declaration(second), catalog: initialCatalog, phaseOrder: order,
    confirmation: { contractSha256: initialProposal.bindingRefs.contractSha256, catalogSha256: initialProposal.bindingRefs.catalogSha256,
      packageSha256: second.skill.packageSha256, candidateSha256: initialProposal.candidateSha256,
      planSha256: `sha256:${'b'.repeat(64)}`, draftRevision: 1 } }));
  for (const workflow of Object.values(f.definition.workTypes)) workflow.phases = [...order];
  for (const phase of [first, second]) {
    const catalog = sharedSkillContractCatalog(f.definition, phase.id);
    const proposal = compileSkillPhaseProposal({ phase: declaration(phase), catalog, phaseOrder: order });
    f.definition.phases[phase.id] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
      phase: declaration(phase), catalog, phaseOrder: order,
      confirmation: { contractSha256: proposal.bindingRefs.contractSha256, catalogSha256: proposal.bindingRefs.catalogSha256,
        packageSha256: phase.skill.packageSha256, candidateSha256: proposal.candidateSha256,
        planSha256: `sha256:${'c'.repeat(64)}`, draftRevision: 2 } }));
  }
  if (templateOverrides) {
    f.definition.workTypes.baseline.templateOverrides = { intake: 'common/alternate.md' };
    await writeFile(path.join(f.root, f.definition.templatesRoot, 'common/alternate.md'), '# Exact approved alternate template\n');
  }
  await writeFile(path.join(f.root, 'singularity/workflow.yml'), YAML.stringify(f.definition));
  await writeFile(path.join(f.root, '.github/agents/skill-summary-owner.agent.md'),
    '---\nname: skill-summary-owner\ndescription: Exact summary role\ntools: []\nmetadata:\n  sflow-phases: skill-summary\n  sflow-default-for: skill-summary\n---\nRead only exact approved inputs.\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'approved dependent skill');
  git(f.root, 'branch', '-f', 'sflow/config', 'HEAD'); git(f.root, 'push', 'origin', 'main', 'sflow/config');
  f.commit = git(f.root, 'rev-parse', 'HEAD');
  const replacements = [first, second].map((phase) => {
    const replacement = structuredClone(phase); replacement.contract.produces[0].minimumBytes = 32;
    return replacement;
  });
  f.groupRequest = { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'skill-group-plan', label: 'Dependent skill contract impact',
    baseRevision: f.commit, target: f.request.target,
    changes: replacements.map((phase) => ({ profile: WCA_SHARED_SKILL_CONTRACT_GROUP_PLAN_PROFILE,
      kind: 'phase', id: phase.id, operation: 'edit', expectedDefinitionSha256: phaseDefinitionSha256(f.definition.phases[phase.id]) })),
    definitions: { phases: replacements } };
  return f;
}

test('shared metadata review binds display and complete default-agent changes to all affected simulations', async (t) => {
  const f = await fixture(t, (definition) => { definition.workTypes.sibling = structuredClone(definition.workTypes.baseline); });
  const request = await sharedAgentRequest(f); request.changes[0].profile = WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE;
  const original = await readFile(path.join(f.root, '.github/agents/product-owner.agent.md'), 'utf8');
  request.definitions.agents[0].text = original.replace('description: Exact base role', 'description: Reviewed shared metadata')
    .replace('sflow-phases: intake', 'sflow-phases: intake,conformance').replace('sflow-default-for: intake', 'sflow-default-for: conformance');
  const qa = await readFile(path.join(f.root, '.github/agents/qa.agent.md'), 'utf8');
  request.changes.push({ profile: WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE, kind: 'agent', id: 'qa', operation: 'edit', expectedTextSha256: agentTextSha256(qa) });
  request.definitions.agents.push({ id: 'qa', text: qa.replace('sflow-phases: conformance', 'sflow-phases: intake,conformance').replace('sflow-default-for: conformance', 'sflow-default-for: intake') });
  const p = await preview(f, request);
  assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
  assert.equal(p.result.simulation.workflows.length, 2); assert.equal(p.result.simulation.status, 'complete-for-profile');
  const phase = p.result.sharedObjectChanges.impact.affectedWorkflows[0].effectivePhases.find((row) => row.id === 'intake');
  assert.equal(phase.beforeDefaultAgent, 'product-owner'); assert.equal(phase.afterDefaultAgent, 'qa');
  assert.deepEqual(p.result.permissions.addedOperations, []); assert.equal(p.result.assets.length, 3);
  assert.equal(p.result.assets.find((asset) => asset.path === 'singularity/workflow.yml').content,
    await readFile(path.join(f.root, 'singularity/workflow.yml'), 'utf8'));
});

test('metadata profile refuses body, tools, native identity, invalid default mapping and mixed profile changes without bytes', async (t) => {
  for (const [kind, edit] of [
    ['body', (text) => text.replace('Read only the exact current approved inputs.', 'Changed body.')],
    ['tool', (text) => text.replace('tools: []', 'tools: [shell]')],
    ['identity', (text) => text.replace('name: product-owner', 'name: another-id')],
    ['defaults', (text) => text.replace('sflow-default-for: intake', 'sflow-default-for: "-"')]
  ]) await t.test(kind, async (child) => {
    const f = await fixture(child); const request = await sharedAgentRequest(f); request.changes[0].profile = WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE;
    request.definitions.agents[0].text = edit(await readFile(path.join(f.root, '.github/agents/product-owner.agent.md'), 'utf8'));
    const p = await preview(f, request); assert.notEqual(p.result.readiness.authoring, 'valid');
    assert.deepEqual(p.result.assets, []); assert.deepEqual(p.result.fileOperations, []);
  });
});

test('existing skill contract preview discards old binding, retains exact parent/package review and requires fresh terminal consent', async (t) => {
  const f = await skillContractFixture(t); const p = await preview(f, f.replacementRequest);
  assert.equal(p.result.readiness.authoring, 'review-required', JSON.stringify(p.result.findings));
  assert.equal(p.result.skillFinalization.status, 'requires-exact-terminal-consent');
  assert.equal(p.result.skillFinalization.subject.kind, 'workflow-authoring-skp-replacement-preconsent-subject');
  assert.equal(p.result.skillFinalization.subject.replacement.beforeDefinitionSha256, f.replacementRequest.changes[0].expectedDefinitionSha256);
  assert.equal(p.result.candidateDefinition.phases['skill-note'], undefined);
  assert.equal(p.result.skillProposals.length, 1); assert.equal(p.result.skillProposals[0].phasePolicy.artifact.minimumBytes, 32);
  assert.equal(Object.hasOwn(p.result.skillProposals[0].bindingRefs, 'confirmation'), false);
  assert.deepEqual(p.result.sharedObjectChanges.impact.affectedWorkflows.map((row) => row.id), ['baseline', 'sibling']);
  assert.deepEqual(p.result.assets, []); assert.deepEqual(p.result.fileOperations, []);
  assert.throws(() => workflowDraftPackageProposalFiles(p.result), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
});

test('multi-skill impact preview binds dependent phase plans to one exact saved source without offering submission', async (t) => {
  const f = await multiSkillContractFixture(t);
  const approved = await readFile(path.join(f.root, 'singularity/workflow.yml'));
  const p = await preview(f, f.groupRequest);
  assert.equal(p.result.sharedObjectChanges.status, 'ready-for-impact-review', JSON.stringify(p.result.findings));
  assert.deepEqual(p.result.sharedObjectChanges.impact.selectedSkillPhaseIds, ['skill-note', 'skill-summary']);
  assert.deepEqual(p.result.sharedObjectChanges.impact.affectedWorkflows.map((row) => row.id), ['baseline', 'sibling']);
  assert.ok(p.result.sharedObjectChanges.impact.consumerEdges.some((row) => row.from === 'phase:skill-summary' && row.to === 'phase:skill-note'));
  assert.ok(p.result.findings.some((finding) => finding.code === 'WCA_SHARED_SKILL_CONTRACT_GROUP_OWNER_UNAVAILABLE'));
  assert.equal(p.result.readiness.authoring, 'unavailable');
  assert.equal(Object.hasOwn(p.result, 'skillFinalization'), false);
  assert.deepEqual(p.result.skillProposals, []);
  assert.deepEqual(p.result.assets, []); assert.deepEqual(p.result.fileOperations, []);
  assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), approved);
  assert.throws(() => workflowDraftPackageProposalFiles(p.result), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
});

test('grouped artifact-only skill replacement prepares one exact terminal subject for all selected bindings', async (t) => {
  const f = await multiSkillContractFixture(t);
  const request = structuredClone(f.groupRequest);
  for (const change of request.changes) change.profile = WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE;
  const p = await preview(f, request);
  assert.equal(p.result.readiness.authoring, 'review-required', JSON.stringify(p.result.findings));
  assert.equal(p.result.skillFinalization.status, 'requires-exact-terminal-consent');
  assert.equal(p.result.skillFinalization.subject.kind, 'workflow-authoring-skp-group-replacement-preconsent-subject');
  assert.equal(p.result.skillFinalization.subject.phases.length, 2);
  assert.deepEqual(p.result.skillFinalization.subject.replacementGroup.phaseReplacements.map((row) => row.phaseId),
    ['skill-note', 'skill-summary']);
  assert.equal(p.result.skillProposals.length, 2);
  assert.equal(p.result.candidateDefinition.phases['skill-note'], undefined);
  assert.equal(p.result.candidateDefinition.phases['skill-summary'], undefined);
  assert.deepEqual(p.result.assets, []); assert.deepEqual(p.result.fileOperations, []);
  assert.throws(() => workflowDraftPackageProposalFiles(p.result), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
});

test('grouped review captures effective template overrides as exact approved byte locks', async (t) => {
  const f = await multiSkillContractFixture(t, { templateOverrides: true });
  const request = structuredClone(f.groupRequest);
  for (const change of request.changes) change.profile = WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE;
  const p = await preview(f, request);
  assert.equal(p.result.readiness.authoring, 'review-required', JSON.stringify(p.result.findings));
  const subject = p.result.skillFinalization.subject;
  const paths = subject.replacementGroup.approvedTemplateFiles.map((file) => file.path);
  assert.deepEqual(paths, ['singularity/templates/common/alternate.md', 'singularity/templates/common/empty.md']);
  assert.deepEqual(subject.dependencyLocks.filter((lock) => lock.kind === 'template-content').map((lock) => lock.id), paths);
});

test('grouped review captures two distinct retained packages and refuses effect or parent drift without candidate bytes', async (t) => {
  for (const [name, mutate, expected] of [
    ['distinct', () => {}, 'review-required'],
    ['parent', (request) => { request.changes[1].expectedDefinitionSha256 = `sha256:${'0'.repeat(64)}`; }, 'invalid'],
    ['effect', (request) => { request.definitions.phases[1].contract.produces[0].path = 'artifacts/skill-summary/new.md'; }, 'invalid'],
    ['read-scope', (request) => { request.definitions.phases[1].contract.readScope.inputs = false; }, 'invalid'],
    ['mixed', (request) => { request.definitions.templates = [{ id: 'unreviewed', content: '# Not paired' }]; }, 'invalid']
  ]) await t.test(name, async (child) => {
    const f = await multiSkillContractFixture(child, { distinctPackages: true });
    const request = structuredClone(f.groupRequest);
    for (const change of request.changes) change.profile = WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE;
    mutate(request);
    const p = await preview(f, request);
    assert.equal(p.result.readiness.authoring, expected, JSON.stringify(p.result.findings));
    assert.deepEqual(p.result.assets, []); assert.deepEqual(p.result.fileOperations, []);
    if (name === 'distinct') {
      assert.deepEqual(p.result.skillFinalization.subject.packages.map((item) => item.skillId), ['inert-note', 'summary-note']);
      assert.equal(p.result.skillFinalization.subject.phases.length, 2);
    } else assert.equal(p.result.skillFinalization, undefined);
  });
});

test('grouped review refuses executable mode in any selected retained package before consent', async (t) => {
  const f = await multiSkillContractFixture(t, { distinctPackages: true });
  git(f.root, 'update-index', '--chmod=+x', 'singularity/skills/summary-note/SKILL.md');
  git(f.root, 'commit', '-m', 'Approved executable summary resource mode');
  git(f.root, 'branch', '-f', 'sflow/config', 'HEAD'); git(f.root, 'push', 'origin', 'main', 'sflow/config');
  const request = structuredClone(f.groupRequest);
  request.baseRevision = git(f.root, 'rev-parse', 'HEAD');
  for (const change of request.changes) change.profile = WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE;
  const created = await f.store.create({ draftId: 'WFD-COMPILER1', displayName: 'Grouped mode refusal',
    expectedHead: null, payload: request, operationId: 'grouped-mode-refusal' });
  const context = await captureWorkflowCompilerContext(f.root);
  await assert.rejects(captureWorkflowDraftCompilerSource(context, { draftId: created.record.draftId }),
    { code: 'SKP_PACKAGE_MODE_UNSUPPORTED' });
  assert.equal(git(f.root, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/sflow/config-change/'), '');
});

test('multi-skill group planner refuses stale catalogs, stale parents and effect changes as a whole', async (t) => {
  const f = await multiSkillContractFixture(t);
  const agentIds = ['product-owner', 'skill-note-owner', 'skill-summary-owner', 'qa'];
  const agents = await Promise.all(agentIds.map(async (agentId) => {
    const source = `.github/agents/${agentId}.agent.md`;
    const text = await readFile(path.join(f.root, source), 'utf8');
    const parsed = parseAgentDependencies(text, { source });
    return { id: agentId, source, scope: 'repository', text, phases: parsed.phases, defaultFor: parsed.defaultFor,
      tools: parsed.tools, worldModelViews: parsed.worldModelViews, dependencies: parsed.dependencies };
  }));
  const input = { approvedDefinition: f.definition, agents,
    changes: f.groupRequest.changes.map((change, index) => {
      const { profile, ...row } = change;
      return { ...row, replacement: f.groupRequest.definitions.phases[index] };
    }), catalogs: Object.fromEntries(f.groupRequest.changes.map((change) =>
      [change.id, sharedSkillContractCatalog(f.definition, change.id)])) };
  const source = structuredClone(input);
  const ready = planSharedSkillContractGroupChanges(input);
  assert.equal(ready.status, 'ready-for-impact-review', JSON.stringify(ready.findings));
  assert.deepEqual(input, source);
  assert.equal(ready.impact.submission, 'unavailable-from-this-planning-profile');
  assert.equal(Object.isFrozen(ready.replacements[0].proposal), true);
  const staleCatalog = structuredClone(input); staleCatalog.catalogs['skill-summary'].phases['skill-note'].outputs[0].path = 'artifacts/wrong.md';
  assert.equal(planSharedSkillContractGroupChanges(staleCatalog).findings[0].code, 'WCA_SHARED_SKILL_CONTRACT_CATALOG_STALE');
  const staleParent = structuredClone(input); staleParent.changes[0].expectedDefinitionSha256 = `sha256:${'0'.repeat(64)}`;
  assert.equal(planSharedSkillContractGroupChanges(staleParent).findings[0].code, 'WCA_CHANGE_PARENT_STALE');
  const effect = structuredClone(input); effect.changes[1].replacement.contract.produces[0].path = 'artifacts/skill-summary/changed.md';
  assert.equal(planSharedSkillContractGroupChanges(effect).findings[0].code, 'WCA_SHARED_SKILL_CONTRACT_EFFECT_CHANGE_UNSUPPORTED');
  const duplicate = structuredClone(input); duplicate.changes[1] = structuredClone(duplicate.changes[0]);
  assert.equal(planSharedSkillContractGroupChanges(duplicate).findings[0].code, 'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');

  const omitted = structuredClone(input);
  const third = structuredClone(omitted.changes[1].replacement);
  third.id = 'skill-audit'; third.label = 'Skill audit';
  third.agent = { source: 'catalog', kind: 'agent', id: 'skill-audit-owner' };
  third.contract.consumes = [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }];
  third.contract.produces[0].path = 'artifacts/skill-audit/report.md';
  third.contract.produces[0].minimumBytes = 20;
  const { agent: unusedAgent, ...thirdPhase } = third;
  const order = ['intake', 'skill-note', 'skill-summary', 'skill-audit', 'conformance'];
  const firstCatalog = sharedSkillContractCatalog(omitted.approvedDefinition, 'skill-note');
  const firstProposal = compileSkillPhaseProposal({ phase: thirdPhase, catalog: firstCatalog, phaseOrder: order });
  omitted.approvedDefinition.phases['skill-audit'] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
    phase: thirdPhase, catalog: firstCatalog, phaseOrder: order,
    confirmation: { contractSha256: firstProposal.bindingRefs.contractSha256,
      catalogSha256: firstProposal.bindingRefs.catalogSha256, candidateSha256: firstProposal.candidateSha256,
      packageSha256: third.skill.packageSha256, planSha256: `sha256:${'d'.repeat(64)}`, draftRevision: 3 } }));
  for (const workflow of Object.values(omitted.approvedDefinition.workTypes)) workflow.phases = [...order];
  const text = '---\nname: skill-audit-owner\ndescription: Exact audit role\ntools: []\nmetadata:\n  sflow-phases: skill-audit\n  sflow-default-for: skill-audit\n---\nRead only approved inputs.\n';
  const parsed = parseAgentDependencies(text, { source: '.github/agents/skill-audit-owner.agent.md' });
  omitted.agents.push({ id: 'skill-audit-owner', source: '.github/agents/skill-audit-owner.agent.md',
    scope: 'repository', text, phases: parsed.phases, defaultFor: parsed.defaultFor, tools: parsed.tools,
    worldModelViews: parsed.worldModelViews, dependencies: parsed.dependencies });
  third.contract.produces[0].minimumBytes = 32;
  omitted.changes = [omitted.changes[0], { kind: 'phase', id: 'skill-audit', operation: 'edit',
    expectedDefinitionSha256: phaseDefinitionSha256(omitted.approvedDefinition.phases['skill-audit']), replacement: third }];
  omitted.catalogs = Object.fromEntries(omitted.changes.map((change) =>
    [change.id, sharedSkillContractCatalog(omitted.approvedDefinition, change.id)]));
  assert.equal(planSharedSkillContractGroupChanges(omitted).findings[0].code,
    'WCA_SHARED_SKILL_CONTRACT_DEPENDENT_RECOMPILE_REQUIRED');
});

test('ordinary context/catalog/preview performs zero extra package captures and executable retained modes refuse only explicit replacements', async (t) => {
  const f = await skillContractFixture(t);
  git(f.root, 'update-index', '--chmod=+x', 'singularity/skills/inert-note/references/note.txt');
  git(f.root, 'commit', '-m', 'Approved existing executable resource mode');
  git(f.root, 'branch', '-f', 'sflow/config', 'HEAD'); git(f.root, 'push', 'origin', 'main', 'sflow/config');
  f.commit = git(f.root, 'rev-parse', 'HEAD'); f.request.baseRevision = f.commit; f.replacementRequest.baseRevision = f.commit;
  const counts = new Map(); const timer = { increment(name, amount) { counts.set(name, (counts.get(name) ?? 0) + amount); } };
  await withCommandTiming(timer, async () => {
    const context = await captureWorkflowCompilerContext(f.root); workflowCompilerCatalogChoices(context);
    const ordinary = await preview(f); assert.equal(ordinary.result.readiness.authoring, 'valid', JSON.stringify(ordinary.result.findings));
    assert.equal(counts.get('wca.replacement-package-capture') ?? 0, 0, 'ordinary authoring never adds package hydration/seals');
    const created = await f.store.create({ draftId: 'WFD-PACKAGEMODE1', displayName: 'Exact package mode', expectedHead: ordinary.created.head,
      payload: f.replacementRequest, operationId: 'create-package-mode' });
    await assert.rejects(captureWorkflowDraftCompilerSource(context, { draftId: created.record.draftId }), { code: 'SKP_PACKAGE_MODE_UNSUPPORTED' });
    assert.equal(counts.get('wca.replacement-package-capture'), 1, 'the explicit one-phase request owns one selected package capture');
    assert.equal(git(f.root, '--git-dir', f.remote, 'ls-tree', 'refs/heads/sflow/config', 'singularity/skills/inert-note/references/note.txt').split(' ')[0], '100755');
    assert.equal(git(f.root, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/sflow/config-change/'), '');
  });
});

test('skill contract replacement refuses stale parent, scope/check/package/order changes and mixed object creation', async (t) => {
  for (const [kind, edit] of [
    ['stale', (r) => { r.changes[0].expectedDefinitionSha256 = `sha256:${'b'.repeat(64)}`; }],
    ['path', (r) => { r.definitions.phases[0].contract.produces[0].path = 'artifacts/skill-note/new.md'; }],
    ['package', (r) => { r.definitions.phases[0].skill.packageSha256 = `sha256:${'c'.repeat(64)}`; }],
    ['source', (r) => { r.definitions.phases[0].contract.readScope.sourcePaths = ['src/index.mjs']; }],
    ['mixed', (r) => { r.definitions.agents = [{ id: 'another-role', prompt: 'Unreviewed' }]; }]
  ]) await t.test(kind, async (child) => {
    const f = await skillContractFixture(child); edit(f.replacementRequest); const p = await preview(f, f.replacementRequest);
    assert.equal(p.result.readiness.authoring, 'invalid', JSON.stringify(p.result.findings));
    assert.deepEqual(p.result.assets, []); assert.equal(p.result.skillFinalization, undefined);
  });
});

test('real terminal skill replacement recompiles one binding, simulates every consumer and retains a closed inactive proposal',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/expect') }, async (t) => {
    const f = await skillContractFixture(t); const p = await preview(f, f.replacementRequest);
    const before = { yaml: await readFile(path.join(f.root, 'singularity/workflow.yml')), index: await readFile(path.join(f.root, '.git/index')),
      head: git(f.root, 'rev-parse', 'HEAD'), approved: git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config') };
    const code = `
      import {previewWorkflowDraftPackage} from ${JSON.stringify(new URL('../src/wca-compiler.mjs', import.meta.url).href)};
      import {workflowDraftSubmissionPlan,createWorkflowDraftReviewProposal} from ${JSON.stringify(new URL('../src/wca-submission.mjs', import.meta.url).href)};
      import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
      const root=${JSON.stringify(f.root)};
      try {
        const pending=await previewWorkflowDraftPackage(root,{draftId:'WFD-COMPILER1',revision:1});
        const review=workflowDraftSubmissionPlan(pending);
        const grant=await captureTerminalActionAuthorization(root,review.plan,review.action,{label:'Review replacement contract'});
        const result=await createWorkflowDraftReviewProposal(root,{draftId:'WFD-COMPILER1',revision:1,expectedPlanSha256:pending.planSha256,confirmation:grant.token});
        let replay;try{await createWorkflowDraftReviewProposal(root,{draftId:'WFD-COMPILER1',revision:1,expectedPlanSha256:pending.planSha256,confirmation:grant.token});}catch(e){replay=e.code;}
        console.log('SKILL_REPLACEMENT_RESULT:'+JSON.stringify({ok:true,result,replay}));
      }catch(e){console.log('SKILL_REPLACEMENT_RESULT:'+JSON.stringify({ok:false,code:e.code,message:e.message}));}
    `;
    const script = 'set timeout 45\nspawn -noecho $env(SF_REPLACEMENT_NODE) --input-type=module -e $env(SF_REPLACEMENT_CODE)\nexpect {\n -exact {Type Review replacement contract} { send -- "Review replacement contract\\r" }\n timeout {exit 124}\n eof {exit 125}\n}\nexpect {eof {} timeout {exit 124}}\nset result [wait]\nexit [lindex $result 3]\n';
    const observed = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.root, env: { ...process.env, NODE_ENV: 'test',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Replacement Fixture', SINGULARITY_FLOW_DISABLE_MODELS: '1',
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.root, '.test-workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.root, '.test-active-workspace.json'),
        SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.root, '.test-leads.json'),
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(path.dirname(f.root), 'transport-outbox'),
        SF_REPLACEMENT_NODE: process.execPath, SF_REPLACEMENT_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Replacement PTY fixture timed out')); }, 50000);
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); }); child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
    });
    assert.equal(observed.status, 0, observed.output);
    const marker = observed.output.split(/\r?\n/u).find((line) => line.startsWith('SKILL_REPLACEMENT_RESULT:')); assert.ok(marker, observed.output);
    const acknowledged = JSON.parse(marker.slice('SKILL_REPLACEMENT_RESULT:'.length)); assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    assert.ok(acknowledged.replay, 'the consumed terminal token cannot authorize another proposal');
    const result = acknowledged.result;
    const retained = validateWorkflowDraftSubmissionSnapshot(JSON.parse(git(f.root, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`)));
    assert.equal(retained.kind, 'workflow-authoring-skill-replacement-submission-snapshot');
    assert.match(result.snapshotPath, /^singularity\/workflow-authoring-skill-replacements\/[a-f0-9]{64}\.json$/u);
    assert.equal(retained.preview.simulation.workflows.length, 2); assert.equal(retained.preview.simulation.status, 'complete-for-profile');
    assert.equal(retained.preview.skillFinalization.record.kind, 'workflow-authoring-skp-replacement-finalization');
    const configured = retained.preview.candidateDefinition.phases['skill-note'];
    assert.equal(configured.artifact.minimumBytes, 32);
    assert.notEqual(configured.skillBinding.compilationSha256, f.definition.phases['skill-note'].skillBinding.compilationSha256);
    assert.equal(configured.skillBinding.bindingRefs.confirmation.planSha256, retained.preview.skillFinalization.subject.subjectSha256);
    assert.equal(configured.skillBinding.bindingRefs.confirmation.draftRevision, 1);
    assert.deepEqual(retained.inputs.request, f.replacementRequest);
    assert.deepEqual(git(f.root, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(),
      ['singularity/workflow.yml', result.snapshotPath].sort(), 'the unchanged retained package is verified without creating new package bytes');
    assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), before.approved);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.head); assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before.index);
    assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), before.yaml);
    for (const mutate of [
      (value) => { value.kind = 'workflow-authoring-skill-submission-snapshot'; },
      (value) => { value.preview.skillFinalization.subject.replacement.beforeDefinition.label = 'Forged source'; },
      (value) => { value.preview.candidateDefinition.phases['skill-note'].skillBinding = structuredClone(f.definition.phases['skill-note'].skillBinding); }
    ]) {
      const changed = structuredClone(retained); mutate(changed); assert.throws(() => validateWorkflowDraftSubmissionSnapshot(changed));
    }
  });

test('one terminal review finalizes a grouped dependent skill replacement and retains an independently checked inactive proposal',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/expect') }, async (t) => {
    const f = await multiSkillContractFixture(t);
    const request = structuredClone(f.groupRequest);
    for (const change of request.changes) change.profile = WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE;
    const pending = await preview(f, request);
    assert.equal(pending.result.readiness.authoring, 'review-required', JSON.stringify(pending.result.findings));
    const before = { yaml: await readFile(path.join(f.root, 'singularity/workflow.yml')),
      index: await readFile(path.join(f.root, '.git/index')),
      head: git(f.root, 'rev-parse', 'HEAD'), approved: git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config') };
    const code = `
      import {previewWorkflowDraftPackage} from ${JSON.stringify(new URL('../src/wca-compiler.mjs', import.meta.url).href)};
      import {workflowDraftSubmissionPlan,createWorkflowDraftReviewProposal} from ${JSON.stringify(new URL('../src/wca-submission.mjs', import.meta.url).href)};
      import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
      const root=${JSON.stringify(f.root)};
      try {
        const pending=await previewWorkflowDraftPackage(root,{draftId:'WFD-COMPILER1',revision:1});
        const review=workflowDraftSubmissionPlan(pending);
        const grant=await captureTerminalActionAuthorization(root,review.plan,review.action,{label:'Review grouped contracts'});
        const result=await createWorkflowDraftReviewProposal(root,{draftId:'WFD-COMPILER1',revision:1,expectedPlanSha256:pending.planSha256,confirmation:grant.token});
        let replay;try{await createWorkflowDraftReviewProposal(root,{draftId:'WFD-COMPILER1',revision:1,expectedPlanSha256:pending.planSha256,confirmation:grant.token});}catch(e){replay=e.code;}
        console.log('SKILL_GROUP_RESULT:'+JSON.stringify({ok:true,result,replay}));
      }catch(e){console.log('SKILL_GROUP_RESULT:'+JSON.stringify({ok:false,code:e.code,message:e.message}));}
    `;
    const script = 'set timeout 45\nspawn -noecho $env(SF_GROUP_NODE) --input-type=module -e $env(SF_GROUP_CODE)\nexpect {\n -exact {Type Review grouped contracts} { send -- "Review grouped contracts\\r" }\n timeout {exit 124}\n eof {exit 125}\n}\nexpect {eof {} timeout {exit 124}}\nset result [wait]\nexit [lindex $result 3]\n';
    const observed = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.root, env: { ...process.env, NODE_ENV: 'test',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Group Fixture', SINGULARITY_FLOW_DISABLE_MODELS: '1',
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.root, '.test-workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.root, '.test-active-workspace.json'),
        SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.root, '.test-leads.json'),
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(path.dirname(f.root), 'transport-outbox'),
        SF_GROUP_NODE: process.execPath, SF_GROUP_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Grouped PTY fixture timed out')); }, 50000);
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); }); child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
    });
    assert.equal(observed.status, 0, observed.output);
    const marker = observed.output.split(/\r?\n/u).find((line) => line.startsWith('SKILL_GROUP_RESULT:')); assert.ok(marker, observed.output);
    const acknowledged = JSON.parse(marker.slice('SKILL_GROUP_RESULT:'.length)); assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    assert.ok(acknowledged.replay, 'one terminal authorization cannot finalize the group twice');
    const result = acknowledged.result;
    const retained = validateWorkflowDraftSubmissionSnapshot(JSON.parse(git(f.root, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`)));
    assert.equal(retained.kind, 'workflow-authoring-skill-group-replacement-submission-snapshot');
    assert.match(result.snapshotPath, /^singularity\/workflow-authoring-skill-group-replacements\/[a-f0-9]{64}\.json$/u);
    assert.equal(retained.preview.skillFinalization.record.kind, 'workflow-authoring-skp-group-replacement-finalization');
    assert.equal(retained.preview.simulation.status, 'complete-for-profile');
    assert.equal(retained.preview.simulation.workflows.length, 2);
    for (const phaseId of ['skill-note', 'skill-summary']) {
      const configured = retained.preview.candidateDefinition.phases[phaseId];
      assert.equal(configured.artifact.minimumBytes, 32);
      assert.notEqual(configured.skillBinding.compilationSha256, f.definition.phases[phaseId].skillBinding.compilationSha256);
      assert.equal(configured.skillBinding.bindingRefs.confirmation.planSha256, retained.preview.skillFinalization.subject.subjectSha256);
    }
    assert.deepEqual(git(f.root, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(),
      ['singularity/workflow.yml', result.snapshotPath].sort());
    assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), before.approved);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.head);
    assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before.index);
    assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), before.yaml);
    const evidence = { subject: structuredClone(retained.preview.skillFinalization.subject),
      record: structuredClone(retained.preview.skillFinalization.record),
      definition: structuredClone(retained.preview.candidateDefinition),
      files: structuredClone(retained.files), retainedInputs: structuredClone(retained.inputs) };
    assert.equal(validateWorkflowSkillFinalizationRecord(evidence).structurallyConsistent, true);
    for (const mutate of [
      (value) => { value.subject.replacementGroup.phaseReplacements[0].beforeDefinition.label = 'Forged reviewed parent'; },
      (value) => { value.subject.replacementGroup.consumerImpactSha256 = `sha256:${'f'.repeat(64)}`; },
      (value) => { value.subject.replacementGroup.agentImpactCatalog.find((agent) => agent.id === 'skill-summary-owner').defaultFor = []; },
      (value) => { value.subject.dependencyLocks.find((lock) => lock.kind === 'phase').definitionSha256 = `sha256:${'e'.repeat(64)}`; },
      (value) => { value.subject.dependencyLocks.find((lock) => lock.kind === 'template-content').definitionSha256 = `sha256:${'d'.repeat(64)}`; },
      (value) => { delete value.subject.replacementGroup; value.subject.kind = 'workflow-authoring-skp-preconsent-subject';
        value.subject.profile = 'wca-skp-preconsent/v1'; value.record.kind = 'workflow-authoring-skp-finalization';
        value.record.profile = 'wca-skp-finalization/v1'; value.record.bindingDialect = value.subject.profile; }
    ]) {
      const changed = structuredClone(evidence); mutate(changed); resealGroupedHistorical(changed);
      assert.throws(() => validateWorkflowSkillFinalizationRecord(changed), (error) =>
        ['WCA_SKP_SOURCE_STALE', 'WCA_SKP_FINALIZATION_INVALID'].includes(error.code));
    }
    for (const mutate of [
      (value) => { value.kind = 'workflow-authoring-skill-replacement-submission-snapshot'; },
      (value) => { value.preview.skillFinalization.subject.replacementGroup.phaseReplacements[0].beforeDefinition.label = 'Forged'; },
      (value) => { value.preview.candidateDefinition.phases['skill-summary'].skillBinding = structuredClone(f.definition.phases['skill-summary'].skillBinding); }
    ]) { const changed = structuredClone(retained); mutate(changed); assert.throws(() => validateWorkflowDraftSubmissionSnapshot(changed)); }
    const downgraded = resealGroupedAsOrdinarySnapshot(structuredClone(retained));
    const { snapshotSha256, ...snapshotCore } = downgraded;
    assert.equal(snapshotSha256, testDigest(snapshotCore), 'downgrade regression must reseal the outer snapshot');
    assert.equal(downgraded.preConsentPreview.planSha256, testDigest((({ planSha256, ...core }) => core)(downgraded.preConsentPreview)));
    assert.equal(downgraded.preview.planSha256, testDigest((({ planSha256, ...core }) => core)(downgraded.preview)));
    assert.throws(() => validateWorkflowDraftSubmissionSnapshot(downgraded), { code: 'WCA_SUBMISSION_INVALID' });
  });

test('shared agent body and legacy template byte edits use retained capture, simulate all consumers and preserve raw YAML', async (t) => {
  for (const kind of ['agent', 'template']) await t.test(kind, async (child) => {
    const f = await fixture(child, (definition) => { definition.workTypes.sibling = { ...structuredClone(definition.workTypes.baseline), label: 'Sibling' }; });
    const request = kind === 'agent' ? await sharedAgentRequest(f) : await sharedTemplateRequest(f);
    const before = await readFile(path.join(f.root, 'singularity/workflow.yml')); const p = await preview(f, request);
    assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
    assert.equal(p.result.readiness.simulation, 'complete-for-profile'); assert.equal(p.result.simulation.workflows.length, 2);
    assert.deepEqual(p.result.sharedObjectChanges.impact.affectedWorkflows.map((row) => row.id), ['baseline', 'sibling']);
    assert.deepEqual(Buffer.from(p.result.assets.find((asset) => asset.path === 'singularity/workflow.yml').content), before);
    const replacement = p.result.sharedObjectChanges.replacements[0];
    assert.equal(p.result.assets.find((asset) => asset.path === replacement.path).content, replacement.text ?? replacement.content);
    assert.equal(p.result.assets.length, 2); assert.equal(p.result.effects.executed, false); assert.equal(p.result.effects.approvalGranted, false);
    const captured = workflowDraftPackageProposalFiles(p.result); assert.deepEqual(captured.snapshotInputs.request, request);
    assert.deepEqual(captured.files.map((file) => file.path), [replacement.path, 'singularity/workflow.yml'].sort());
    assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), before);
  });
});

test('named shared template metadata edits retain aliases and exact masked effective overrides', async (t) => {
  const f = await fixture(t, (definition) => {
    definition.templates = { shared: { path: 'common/empty.md', label: 'Shared', kind: 'note' }, alias: 'common/empty.md' };
    definition.phases.intake.defaultTemplate = 'template:shared'; definition.phases.conformance.defaultTemplate = 'template:alias';
    definition.workTypes.masked = { label: 'Masked', phases: ['intake'], templateOverrides: { intake: 'common/empty.md' }, omits: OMITS };
  });
  const request = await sharedTemplateRequest(f, 'template:shared'); request.definitions.templates[0].definition = { ...f.definition.templates.shared, label: 'Reviewed shared label', description: 'Exact display prose' };
  const p = await preview(f, request); assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
  assert.equal(p.result.simulation.workflows.length, 2);
  assert.ok(p.result.sharedObjectChanges.impact.consumers.some((row) => row.kind === 'template' && row.id === 'alias'));
  const raw = YAML.parse(p.result.assets.find((asset) => asset.path === 'singularity/workflow.yml').content);
  const expected = structuredClone(f.definition); expected.templates.shared = request.definitions.templates[0].definition;
  assert.deepEqual(raw, expected); assert.equal(raw.templates.alias, 'common/empty.md');
});

test('shared template review preserves the existing owner exception for untouched exact packaged repository agents only', async (t) => {
  const f = await fixture(t);
  const packaged = await readFile(new URL('../templates/agents/product-owner.agent.md', import.meta.url), 'utf8');
  await writeFile(path.join(f.root, '.github/agents/product-owner.agent.md'), packaged);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'Historical exact packaged role with dormant extra phases');
  git(f.root, 'branch', '-f', 'sflow/config', 'HEAD'); git(f.root, 'push', 'origin', 'main', 'sflow/config');
  f.commit = git(f.root, 'rev-parse', 'HEAD');
  const p = await preview(f, await sharedTemplateRequest(f));
  assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
  assert.equal(p.result.simulation.status, 'complete-for-profile');
  assert.ok(!p.result.assets.some((asset) => asset.path === '.github/agents/product-owner.agent.md'));
  const request = await sharedAgentRequest(f);
  request.definitions.agents[0].text = `${packaged}\nAdditional reviewed body prose.\n`;
  const changed = await f.store.appendRevision({ draftId: p.source.draftId, expectedHead: p.created.head,
    epoch: 1, operationId: 'review-edited-packaged-role', patch: { payload: request } });
  const source = await captureWorkflowDraftCompilerSource(p.context, { draftId: changed.record.draftId });
  const refused = compileWorkflowDraftPackage({ context: p.context, source });
  assert.ok(refused.findings.some((finding) => finding.code === 'AGENT_PHASE_UNKNOWN'), JSON.stringify(refused.findings));
  assert.deepEqual(refused.assets, []); assert.deepEqual(refused.fileOperations, []);
});

test('shared content metadata/effect/mixed-profile/stale-byte/undeclared-view proposals refuse without files', async (t) => {
  for (const [kind, name, mutate, code] of [
    ['agent', 'frontmatter', (r) => { r.definitions.agents[0].text = r.definitions.agents[0].text.replace('tools: []', 'tools: ["shell/*"]'); }, 'WCA_SHARED_AGENT_EFFECT_CHANGE_UNSUPPORTED'],
    ['agent', 'stale', (r) => { r.changes[0].expectedTextSha256 = `sha256:${'0'.repeat(64)}`; }, 'WCA_CHANGE_PARENT_STALE'],
    ['agent', 'mixed', (r) => { r.definitions.templates = [{ id: 'new', content: '# Inert' }]; }, 'WCA_SHARED_CONTENT_UNSUPPORTED'],
    ['agent', 'no-profile', (r) => { delete r.changes[0].profile; }, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED'],
    ['template', 'token', (r) => { r.definitions.templates[0].content += '{{native.command}}\n'; }, 'WCA_SHARED_CONTENT_CONTRACT_INVALID'],
    ['template', 'view', (r) => { r.definitions.templates[0].content += 'Read views/unapproved-view.md.\n'; }, 'WCA_SHARED_CONTENT_CONTRACT_INVALID'],
    ['template', 'stale', (r) => { r.changes[0].expectedContentSha256 = `sha256:${'0'.repeat(64)}`; }, 'WCA_CHANGE_PARENT_STALE']
  ]) await t.test(`${kind}:${name}`, async (child) => {
    const f = await fixture(child); const request = kind === 'agent' ? await sharedAgentRequest(f) : await sharedTemplateRequest(f); mutate(request);
    const p = await preview(f, request); assert.ok(p.result.findings.some((finding) => finding.code === code), JSON.stringify(p.result.findings));
    assert.deepEqual(p.result.assets, []); assert.deepEqual(p.result.fileOperations, []);
    assert.throws(() => workflowDraftPackageProposalFiles(p.result), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
  });
});

test('ordinary approved reads omit authoring byte work and only explicit opt-in snapshots expose the private raw profile', async (t) => {
  const f = await fixture(t); const counts = new Map();
  const timer = { increment(name, amount) { counts.set(name, (counts.get(name) ?? 0) + amount); } };
  await withCommandTiming(timer, () => withApprovedConfigurationRead(f.root, () => {
    assert.throws(() => captureVerifiedConfigurationAssetBytes(configurationReadSnapshot(f.root), {
      selectPaths: ['singularity/workflow.yml']
    }), { code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE' });
  }, { freshOwnerCapture: true }));
  assert.equal(counts.get('configuration.authoring-byte-capture') ?? 0, 0);
  await withCommandTiming(timer, () => withApprovedConfigurationRead(f.root, async () => {
    const snapshot = configurationReadSnapshot(f.root);
    assert.equal(captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: ['singularity/workflow.yml'] }).length, 1);
    await withApprovedConfigurationRead(f.root, () => {
      assert.equal(configurationReadSnapshot(f.root), snapshot, 'normal nested readers retain the same private captured snapshot');
    }, { captureAuthoringBytes: true });
  }, { freshOwnerCapture: true, captureAuthoringBytes: true }));
  assert.equal(counts.get('configuration.authoring-byte-capture'), 1, 'one opt-in owner capture, no nested recapture');
});

test('exact byte extraction refuses counterfeit snapshots and public Buffer hooks without changing source bytes', async (t) => {
  const f = await fixture(t);
  await withApprovedConfigurationRead(f.root, () => {
    const snapshot = configurationReadSnapshot(f.root); const paths = ['singularity/workflow.yml', '.github/agents/product-owner.agent.md'];
    assert.throws(() => captureVerifiedConfigurationAssetBytes({ ...snapshot }, { selectPaths: paths }), { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' });
    assert.throws(() => captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: paths.slice(1) }), { code: 'APPROVED_CONFIGURATION_SELECTION_INVALID' });
    const original = snapshot.assets.find((asset) => asset.relative === paths[1]).contents;
    let invoked = false; Object.defineProperty(original, 'valueOf', { configurable: true, value() { invoked = true; throw new Error('public hook'); } });
    Object.defineProperty(original, 'length', { configurable: true, get() { invoked = true; throw new Error('public hook'); } });
    const captured = captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: paths }); assert.equal(invoked, false);
    const entry = captured.find((asset) => asset.relative === paths[1]); entry.contents.fill(0);
    const again = captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: paths });
    assert.notDeepEqual(again.find((asset) => asset.relative === paths[1]).contents, entry.contents);
    delete original.valueOf; delete original.length;
  }, { freshOwnerCapture: true, captureAuthoringBytes: true });
});

test('new replacement byte capture retains raw Git objects and refuses transformed checkout parents without changing historical projection', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.gitattributes'), '.github/agents/*.md text eol=crlf\n');
  git(f.root, 'add', '.gitattributes'); git(f.root, 'commit', '-m', 'Approved explicit EOL projection');
  git(f.root, 'branch', '-f', 'sflow/config', 'HEAD'); git(f.root, 'push', 'origin', 'main', 'sflow/config');
  const raw = git(f.root, '--git-dir', f.remote, 'show', 'refs/heads/sflow/config:.github/agents/product-owner.agent.md');
  await withApprovedConfigurationRead(f.root, () => {
    const snapshot = configurationReadSnapshot(f.root); const relative = '.github/agents/product-owner.agent.md';
    const historical = snapshot.assets.find((asset) => asset.relative === relative).contents;
    assert.ok(historical.includes(Buffer.from('\r\n')), 'old snapshot keeps its historical materialized-EOL projection');
    const exact = captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: ['singularity/workflow.yml', relative] }).find((asset) => asset.relative === relative).contents;
    assert.equal(exact.toString('utf8').trimEnd(), raw); assert.equal(exact.includes(Buffer.from('\r\n')), false);
    assert.notDeepEqual(exact, historical);
  }, { freshOwnerCapture: true, captureAuthoringBytes: true });
  f.commit = git(f.root, 'rev-parse', 'HEAD'); f.request.baseRevision = f.commit;
  const ordinary = await preview(f);
  assert.equal(ordinary.result.readiness.authoring, 'valid', 'additive raw-byte strictness must not reinterpret ordinary historical CRLF capture');
  const request = await sharedAgentRequest(f);
  const changed = await f.store.appendRevision({ draftId: ordinary.source.draftId, expectedHead: ordinary.created.head,
    epoch: 1, operationId: 'review-exact-crlf-parent', patch: { payload: request } });
  const source = await captureWorkflowDraftCompilerSource(ordinary.context, { draftId: changed.record.draftId });
  const refused = compileWorkflowDraftPackage({ context: ordinary.context, source });
  assert.ok(refused.findings.some((finding) => finding.code === 'WCA_COMPILER_SOURCE_UNAVAILABLE'));
  assert.deepEqual(refused.assets, []); assert.deepEqual(refused.fileOperations, []);
});

test('exact authoring capture counts repeated Git blob bytes per retained path without blocking ordinary requests', async (t) => {
  const f = await fixture(t); const contents = Buffer.alloc(6 * 1024 * 1024, 65);
  for (const id of ['first', 'second', 'third']) await writeFile(path.join(f.root, f.definition.templatesRoot, `common/${id}.md`), contents);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'Repeated exact blob paths exceed new raw retention profile');
  git(f.root, 'branch', '-f', 'sflow/config', 'HEAD'); git(f.root, 'push', 'origin', 'main', 'sflow/config');
  assert.equal(new Set(['first', 'second', 'third'].map((id) => git(f.root, 'rev-parse', `HEAD:${f.definition.templatesRoot}/common/${id}.md`))).size, 1);
  await withApprovedConfigurationRead(f.root, () => {
    const snapshot = configurationReadSnapshot(f.root);
    assert.ok(snapshot.assets.some((asset) => asset.relative.endsWith('/third.md')), 'historical Story capture still retains its existing asset closure');
    assert.throws(() => captureVerifiedConfigurationAssetBytes(snapshot, { selectPaths: ['singularity/workflow.yml'] }),
      { code: 'APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE' }, 'three repeated six-MiB paths exceed sixteen-MiB retention, despite only one unique blob');
  }, { freshOwnerCapture: true, captureAuthoringBytes: true });
  f.commit = git(f.root, 'rev-parse', 'HEAD'); f.request.baseRevision = f.commit;
  const ordinary = await preview(f); assert.equal(ordinary.result.readiness.authoring, 'valid', JSON.stringify(ordinary.result.findings));
  const request = await sharedTemplateRequest(f);
  const changed = await f.store.appendRevision({ draftId: ordinary.source.draftId, expectedHead: ordinary.created.head,
    epoch: 1, operationId: 'review-unavailable-raw-parent', patch: { payload: request } });
  const source = await captureWorkflowDraftCompilerSource(ordinary.context, { draftId: changed.record.draftId });
  const refused = compileWorkflowDraftPackage({ context: ordinary.context, source });
  assert.ok(refused.findings.some((finding) => finding.code === 'WCA_COMPILER_SOURCE_UNAVAILABLE'));
  assert.deepEqual(refused.assets, []); assert.deepEqual(refused.fileOperations, []);
});

test('shared replacement ignores tampered current checkout text and refuses changed exact authority bytes', async (t) => {
  const f = await fixture(t); const request = await sharedAgentRequest(f);
  await writeFile(path.join(f.root, '.github/agents/product-owner.agent.md'), '---\nname: wrong\ndescription: Unapproved current checkout\ntools: ["shell/*"]\n---\nUnapproved instructions.\n');
  const p = await preview(f, request); assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
  assert.equal(p.result.sharedObjectChanges.replacements[0].beforeTextSha256, request.changes[0].expectedTextSha256);
  git(f.root, 'restore', '--worktree', '.github/agents/product-owner.agent.md'); git(f.root, 'switch', 'sflow/config');
  const original = await readFile(path.join(f.root, '.github/agents/product-owner.agent.md'), 'utf8');
  await writeFile(path.join(f.root, '.github/agents/product-owner.agent.md'), `${original}\nChanged approved source.\n`);
  git(f.root, 'add', '.github/agents/product-owner.agent.md'); git(f.root, 'commit', '-m', 'Changed exact approved role bytes'); git(f.root, 'push', 'origin', 'sflow/config'); git(f.root, 'switch', 'main');
  await assert.rejects(revalidateWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1', revision: 1, expectedPlanSha256: p.result.planSha256 }), { code: 'WCA_PREVIEW_STALE' });
});

test('actual terminal shared agent body/metadata/template review proposals retain literal bytes without app/index/Story repins',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/expect') }, async (t) => {
    for (const kind of ['agent', 'metadata', 'template']) await t.test(kind, async (childTest) => {
      const f = await fixture(childTest); const request = kind === 'template' ? await sharedTemplateRequest(f) : await sharedAgentRequest(f);
      if (kind === 'metadata') {
        request.changes[0].profile = WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE;
        request.definitions.agents[0].text = (await readFile(path.join(f.root, '.github/agents/product-owner.agent.md'), 'utf8'))
          .replace('description: Exact base role', 'description: Reviewed shared metadata');
      }
      const p = await preview(f, request); assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
      const replacement = p.result.sharedObjectChanges.replacements[0];
      const storyPath = path.join(f.root, 'singularity/work-items/KEEP/context/exact-pin.json');
      await mkdir(path.dirname(storyPath), { recursive: true }); await writeFile(storyPath, '{"retainedPin":"unchanged"}\n');
      await writeFile(path.join(f.root, 'private-note.txt'), 'Private staged application bytes\n'); git(f.root, 'add', 'private-note.txt');
      const before = { head: git(f.root, 'rev-parse', 'HEAD'), status: git(f.root, 'status', '--porcelain'), index: await readFile(path.join(f.root, '.git/index')),
        yaml: await readFile(path.join(f.root, 'singularity/workflow.yml')), content: await readFile(path.join(f.root, replacement.path)), story: await readFile(storyPath),
        approved: git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), main: git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main') };
      const code = `
        import {previewWorkflowDraftPackage} from ${JSON.stringify(new URL('../src/wca-compiler.mjs', import.meta.url).href)};
        import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
        import {createWorkflowDraftReviewProposal,workflowDraftSubmissionPlan} from ${JSON.stringify(new URL('../src/wca-submission.mjs', import.meta.url).href)};
        const root=${JSON.stringify(f.root)};
        try {
          const preview=await previewWorkflowDraftPackage(root,{draftId:'WFD-COMPILER1',revision:1});
          const review=workflowDraftSubmissionPlan(preview);
          const grant=await captureTerminalActionAuthorization(root,review.plan,review.action,{label:'Create review proposal'});
          const result=await createWorkflowDraftReviewProposal(root,{draftId:'WFD-COMPILER1',revision:1,
            expectedPlanSha256:${JSON.stringify(p.result.planSha256)},confirmation:grant.token});
          console.log('SHARED_CONTENT_RESULT:'+JSON.stringify({ok:true,result}));
        }catch(error){console.log('SHARED_CONTENT_RESULT:'+JSON.stringify({ok:false,error:{code:error.code,message:error.message}}));}
      `;
      const script = 'set timeout 40\nspawn -noecho $env(SF_CONTENT_NODE) --input-type=module -e $env(SF_CONTENT_CODE)\nexpect {\n -exact {Type Create review proposal} { send -- "Create review proposal\\r" }\n timeout { exit 124 }\n eof { exit 125 }\n}\nexpect { eof {} timeout { exit 124 } }\nset result [wait]\nexit [lindex $result 3]\n';
      const observed = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.root, env: { ...process.env, NODE_ENV: 'test',
          SINGULARITY_FLOW_TEST_IDENTITY: 'Shared Content Fixture', SINGULARITY_FLOW_DISABLE_MODELS: '1',
          SF_CONTENT_NODE: process.execPath, SF_CONTENT_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private shared-content PTY fixture timed out')); }, 50000);
        child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', (error) => { clearTimeout(timer); reject(error); }); child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
      });
      assert.equal(observed.status, 0, observed.output);
      const marker = observed.output.split(/\r?\n/u).find((line) => line.startsWith('SHARED_CONTENT_RESULT:')); assert.ok(marker, observed.output);
      const acknowledged = JSON.parse(marker.slice('SHARED_CONTENT_RESULT:'.length)); assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
      const result = acknowledged.result;
      const snapshot = validateWorkflowDraftSubmissionSnapshot(JSON.parse(git(f.root, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`)));
      assert.deepEqual(snapshot.inputs.request, request); assert.deepEqual(snapshot.preview.sharedObjectChanges, p.result.sharedObjectChanges);
      assert.equal(git(f.root, '--git-dir', f.remote, 'show', `${result.commit}:${replacement.path}`), (replacement.text ?? replacement.content).trimEnd());
      assert.deepEqual(git(f.root, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(),
        [replacement.path, result.snapshotPath].sort(), 'unchanged exact YAML is selected/verified but is not a changed file');
      assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), before.approved);
      assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), before.main);
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.head); assert.equal(git(f.root, 'status', '--porcelain'), before.status);
      assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before.index); assert.deepEqual(await readFile(storyPath), before.story);
      assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), before.yaml); assert.deepEqual(await readFile(path.join(f.root, replacement.path)), before.content);
    });
  });

test('explicit shared phase preview binds every captured consumer and emits only exact raw replacements', async (t) => {
  const f = await fixture(t, (definition) => {
    definition.workTypes.baseline.description = 'Preserve exact raw policy';
    definition.workTypes.baseline.retainedExtension = { exact: true };
    definition.workTypes.masked = { ...structuredClone(definition.workTypes.baseline), label: 'Masked workflow',
      phaseOverrides: { intake: { label: 'Exact local label' } } };
    definition.workTypes.sibling = { ...structuredClone(definition.workTypes.baseline), label: 'Sibling workflow' };
  });
  const request = sharedPhaseRequest(f); const beforeRefs = git(f.root, 'show-ref');
  const beforeHead = git(f.root, 'rev-parse', 'HEAD'); const beforeStatus = git(f.root, 'status', '--porcelain');
  const beforeBytes = await readFile(path.join(f.root, 'singularity/workflow.yml'));
  const p = await preview(f, request);
  assert.equal(p.result.readiness.authoring, 'valid', JSON.stringify(p.result.findings));
  assert.equal(p.result.readiness.simulation, 'complete-for-profile');
  assert.equal(p.result.workflowChanges, null);
  assert.equal(p.result.sharedObjectChanges.profile, WCA_SHARED_PHASE_CHANGES_PROFILE);
  assert.deepEqual(p.result.sharedObjectChanges.impact.affectedWorkflows.map((row) => row.id), ['baseline', 'masked', 'sibling']);
  assert.equal(p.result.sharedObjectChanges.impact.affectedWorkflows.find((row) => row.id === 'masked').status, 'effective-phase-unchanged');
  assert.equal(p.result.simulation.workflows.length, 3);
  const raw = YAML.parse(p.result.assets.find((asset) => asset.path === 'singularity/workflow.yml').content);
  const expected = structuredClone(f.definition); expected.phases.intake = request.definitions.phases[0].replacement;
  assert.deepEqual(raw, expected, 'unrelated catalog policy and advanced raw workflow fields are not normalized or rewritten');
  assert.equal(p.result.assets.length, 1); assert.equal(p.result.effects.approvalGranted, false);
  const closure = workflowDraftPackageProposalFiles(p.result); assert.deepEqual(closure.snapshotInputs.request, request);
  assert.equal(closure.files[0].path, 'singularity/workflow.yml');
  assert.equal(closure.expectedAuthority.sourceCommit, f.commit);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(f.root, 'status', '--porcelain'), beforeStatus);
  assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), beforeBytes);
  const afterRefs = git(f.root, 'show-ref').split('\n').filter((row) => !row.includes('/sflow/drafts/'));
  assert.deepEqual(afterRefs, beforeRefs.split('\n'), 'only the explicit inert draft create writes its dedicated shared ref');
});

test('shared phase requests cannot mix implicit definitions, widen effects, skip exact profile or omit affected simulations', async (t) => {
  for (const [name, mutate, code] of [
    ['stale', (r) => { r.changes[0].expectedDefinitionSha256 = `sha256:${'0'.repeat(64)}`; }, 'WCA_CHANGE_PARENT_STALE'],
    ['effect', (r) => { r.definitions.phases[0].replacement.writeScope = 'source-and-artifact'; }, 'WCA_SHARED_PHASE_EFFECT_CHANGE_UNSUPPORTED'],
    ['mixed', (r) => { r.definitions.agents = [{ id: 'new-agent' }]; }, 'WCA_SHARED_PHASE_UNSUPPORTED'],
    ['delete', (r) => { r.changes[0].operation = 'delete'; }, 'WCA_SHARED_PHASE_UNSUPPORTED'],
    ['profile', (r) => { delete r.changes[0].profile; }, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED']
  ]) await t.test(name, async (child) => {
    const f = await fixture(child); const request = sharedPhaseRequest(f); mutate(request); const p = await preview(f, request);
    assert.ok(p.result.findings.some((finding) => finding.code === code), JSON.stringify(p.result.findings));
    assert.equal(p.result.assets.length, 0); assert.equal(p.result.fileOperations.length, 0);
    assert.throws(() => workflowDraftPackageProposalFiles(p.result), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
  });
});

test('shared impact recompilation refuses byte-identical raw parent at a changed approved commit', async (t) => {
  const f = await fixture(t); const request = sharedPhaseRequest(f); const p = await preview(f, request);
  git(f.root, 'switch', 'sflow/config'); git(f.root, 'commit', '--allow-empty', '-m', 'Move exact authority commit');
  git(f.root, 'push', 'origin', 'sflow/config'); git(f.root, 'switch', 'main');
  await assert.rejects(revalidateWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1', revision: 1,
    expectedPlanSha256: p.result.planSha256 }), { code: 'WCA_PREVIEW_STALE' });
});

test('actual terminal shared phase submission uses existing proposal fences and preserves app/index/Story bytes',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/expect') }, async (t) => {
    const f = await fixture(t, (definition) => {
      definition.workTypes.sibling = { ...structuredClone(definition.workTypes.baseline), label: 'Sibling' };
    });
    const request = sharedPhaseRequest(f); const p = await preview(f, request);
    const storyPath = path.join(f.root, 'singularity/work-items/KEEP/context/retained-skill-pin.json');
    await mkdir(path.dirname(storyPath), { recursive: true }); await writeFile(storyPath, '{"exactPrivateSentinel":"unchanged"}\n');
    await writeFile(path.join(f.root, 'contributor-note.txt'), 'Private staged application bytes\n'); git(f.root, 'add', 'contributor-note.txt');
    const before = { refs: git(f.root, 'show-ref'), head: git(f.root, 'rev-parse', 'HEAD'), status: git(f.root, 'status', '--porcelain'),
      index: await readFile(path.join(f.root, '.git/index')), workflow: await readFile(path.join(f.root, 'singularity/workflow.yml')),
      story: await readFile(storyPath) };
    const code = `
      import {previewWorkflowDraftPackage} from ${JSON.stringify(new URL('../src/wca-compiler.mjs', import.meta.url).href)};
      import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
      import {createWorkflowDraftReviewProposal,workflowDraftSubmissionPlan} from ${JSON.stringify(new URL('../src/wca-submission.mjs', import.meta.url).href)};
      const root=${JSON.stringify(f.root)};
      try {
        const preview=await previewWorkflowDraftPackage(root,{draftId:'WFD-COMPILER1',revision:1});
        const review=workflowDraftSubmissionPlan(preview);
        const grant=await captureTerminalActionAuthorization(root,review.plan,review.action,{label:'Create review proposal'});
        const result=await createWorkflowDraftReviewProposal(root,{draftId:'WFD-COMPILER1',revision:1,
          expectedPlanSha256:${JSON.stringify(p.result.planSha256)},confirmation:grant.token});
        console.log('SHARED_PHASE_RESULT:'+JSON.stringify({ok:true,result}));
      }catch(error){console.log('SHARED_PHASE_RESULT:'+JSON.stringify({ok:false,error:{code:error.code,message:error.message}}));}
    `;
    const script = `set timeout 40\nspawn -noecho $env(SF_SHARED_NODE) --input-type=module -e $env(SF_SHARED_CODE)\nexpect {\n -exact {Type Create review proposal} { send -- "Create review proposal\\r" }\n timeout { exit 124 }\n eof { exit 125 }\n}\nexpect { eof {} timeout { exit 124 } }\nset result [wait]\nexit [lindex $result 3]\n`;
    const observed = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.root, env: { ...process.env,
        NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Shared Phase Fixture', SINGULARITY_FLOW_DISABLE_MODELS: '1',
        SF_SHARED_NODE: process.execPath, SF_SHARED_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private shared-phase PTY fixture timed out')); }, 50000);
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
    });
    assert.equal(observed.status, 0, observed.output.slice(-2000));
    const matched = observed.output.match(/SHARED_PHASE_RESULT:(\{[^\r\n]+\})/u); assert.ok(matched, observed.output.slice(-2000));
    const answer = JSON.parse(matched[1]); assert.equal(answer.ok, true, JSON.stringify(answer)); const result = answer.result;
    assert.equal(result.reviewRequired, true); assert.equal(result.approval, 'not-granted'); assert.equal(result.activation, 'inactive');
    assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), f.commit);
    assert.equal(git(f.root, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.commit);
    const snapshot = JSON.parse(git(f.root, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`));
    assert.deepEqual(validateWorkflowDraftSubmissionSnapshot(snapshot), snapshot);
    assert.deepEqual(snapshot.inputs.request, request); assert.deepEqual(snapshot.preview.sharedObjectChanges, p.result.sharedObjectChanges);
    const candidate = YAML.parse(git(f.root, '--git-dir', f.remote, 'show', `${result.commit}:singularity/workflow.yml`));
    const expected = structuredClone(f.definition); expected.phases.intake = request.definitions.phases[0].replacement;
    assert.deepEqual(candidate, expected);
    assert.deepEqual(git(f.root, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(),
      ['singularity/workflow.yml', result.snapshotPath].sort());
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), before.head); assert.equal(git(f.root, 'status', '--porcelain'), before.status);
    assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before.index);
    assert.deepEqual(await readFile(path.join(f.root, 'singularity/workflow.yml')), before.workflow);
    assert.deepEqual(await readFile(storyPath), before.story);
    for (const ref of before.refs.split('\n').filter((row) => row.endsWith('refs/heads/main') || row.endsWith('refs/heads/sflow/config'))) {
      assert.ok(git(f.root, 'show-ref').split('\n').includes(ref));
    }
  });

test('workflow-only edit and linked fork bind exact raw parent and preserve omitted advanced policy with full impact', async (t) => {
  for (const intent of ['edit', 'fork']) await t.test(intent, async (child) => {
    const f = await fixture(child, (definition) => {
      definition.workTypes.baseline.description = 'Original description';
      definition.workTypes.baseline.templateOverrides = { intake: 'common/empty.md' };
      definition.workTypes.baseline.documents = { allowedPhases: ['intake'] };
      definition.workTypes.baseline.phaseOverrides = { intake: { label: 'Preserved intake' } };
    });
    const target = intent === 'edit' ? 'baseline' : 'baseline-copy';
    const request = { schema: WCA_REQUEST_SCHEMA, intent, id: 'change-baseline', label: 'Reviewed change',
      baseRevision: f.commit, target: f.request.target,
      definitions: { workflows: [{ id: target, label: 'New label' }] },
      changes: [{ kind: 'workflow', id: target, operation: intent, ...(intent === 'fork' ? { sourceId: 'baseline' } : {}),
        expectedDefinitionSha256: workflowDefinitionSha256(f.definition.workTypes.baseline) }] };
    const p = await preview(f, request);
    assert.deepEqual(p.result.findings, []); assert.equal(p.result.compiler, 'wca-complete-package/v4');
    assert.equal(p.result.workflowChanges.status, 'ready'); assert.equal(p.result.simulation.status, 'complete-for-profile');
    assert.equal(p.result.workflowChanges.impact.sharedDefinitions, 'unchanged');
    assert.equal(p.result.workflowChanges.impact.retainedStories, 'unchanged-not-inventoried');
    assert.ok(p.result.workflowChanges.impact.sharedDependencies.some((row) => row.kind === 'phase'
      && row.id === 'intake' && row.directDependents.some((value) => value.id === 'baseline')));
    const result = YAML.parse(p.result.assets.find((asset) => asset.path === 'singularity/workflow.yml').content);
    assert.equal(result.workTypes[target].label, 'New label');
    assert.equal(result.workTypes[target].description, 'Original description');
    assert.deepEqual(result.workTypes[target].templateOverrides, f.definition.workTypes.baseline.templateOverrides);
    assert.deepEqual(result.workTypes[target].documents, f.definition.workTypes.baseline.documents);
    assert.deepEqual(result.workTypes[target].phaseOverrides, f.definition.workTypes.baseline.phaseOverrides);
    assert.equal(workflowDefinitionSha256(result.workTypes[target]), p.result.workflowChanges.replacements[0].afterDefinitionSha256);
    const unchanged = structuredClone(result); const original = structuredClone(f.definition);
    delete unchanged.workTypes[target]; delete original.workTypes[target];
    assert.deepEqual(unchanged, original, 'unrelated raw shared definitions and original fork source are not normalized or rewritten');
    assert.equal(p.result.assets.length, 1, 'linked dependencies are unchanged, not copied as native skill files');
    assert.deepEqual(workflowDraftPackageProposalFiles(p.result).snapshotInputs.request, request);
    assert.deepEqual(await previewWorkflowDraftPackage(f.root, { draftId: 'WFD-COMPILER1' }), p.result);
  });
});

test('workflow-only preview refuses stale parent, mismatched operation and shared edits before candidate files', async (t) => {
  for (const [name, change, code] of [
    ['stale', (r) => { r.changes[0].expectedDefinitionSha256 = `sha256:${'0'.repeat(64)}`; }, 'WCA_CHANGE_PARENT_STALE'],
    ['shared', (r) => { r.definitions.phases = [{ id: 'intake', label: 'replace' }]; }, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED'],
    ['operation', (r) => { r.changes[0].operation = 'delete'; }, 'WCA_CHANGE_SHARED_OBJECT_UNSUPPORTED']
  ]) await t.test(name, async (child) => {
    const f = await fixture(child); const r = { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'change-baseline',
      label: 'Reviewed change', baseRevision: f.commit, target: f.request.target,
      definitions: { workflows: [{ id: 'baseline', label: 'Changed' }] },
      changes: [{ kind: 'workflow', id: 'baseline', operation: 'edit', expectedDefinitionSha256: workflowDefinitionSha256(f.definition.workTypes.baseline) }] };
    change(r); const p = await preview(f, r);
    assert.ok(p.result.findings.some((finding) => finding.code === code), JSON.stringify(p.result.findings));
    assert.equal(p.result.assets.length, 0); assert.equal(p.result.fileOperations.length, 0);
  });
});

test('workflow-only checks and graph use effective phase inputs, output and approval rather than the base phase', async (t) => {
  const f = await fixture(t, (definition) => {
    definition.phases.helper = { ...structuredClone(definition.phases.intake), label: 'Helper',
      artifact: { path: 'artifacts/helper/helper.md', minimumBytes: 20, maximumBytes: 16384 } };
    definition.phases.conformance.inputs = ['helper'];
    definition.workTypes.baseline.phaseOverrides = { conformance: { inputs: ['intake'],
      approval: { mode: 'required', authorities: ['reviewers'], minimum: 1 },
      artifact: { path: 'artifacts/conformance/effective.md' } } };
  });
  const request = { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'change-baseline', label: 'Reviewed change',
    baseRevision: f.commit, target: f.request.target, definitions: { workflows: [{ id: 'baseline', label: 'New label' }] },
    changes: [{ kind: 'workflow', id: 'baseline', operation: 'edit', expectedDefinitionSha256: workflowDefinitionSha256(f.definition.workTypes.baseline) }] };
  const p = await preview(f, request); assert.deepEqual(p.result.findings, []);
  const row = p.result.graph.find((phase) => phase.phaseId === 'conformance');
  assert.deepEqual(row.inputs, ['intake']); assert.equal(row.humanReview, true);
  assert.equal(row.artifact, 'artifacts/conformance/effective.md');
});

test('unassigned candidate skill bytes are emitted only into inert canonical configuration storage', async (t) => {
  const f = await fixture(t); f.request.definitions.skills = [{ id: 'inert-note', description: 'Unassigned procedure candidate',
    instructions: 'Read the admitted note and report only its stated findings.', operationBindings: [], resources: [] }];
  const p = await preview(f); assert.deepEqual(p.result.findings, []);
  assert.ok(p.result.assets.some((asset) => asset.path === 'singularity/skills/inert-note/SKILL.md'));
  assert.ok(p.result.assets.every((asset) => !asset.path.startsWith('.github/skills/')));
  assert.equal(p.result.readiness.activation, 'inactive'); assert.equal(p.result.readiness.execution, 'not-run');
  assert.ok(!Object.values(p.result.candidateDefinition.phases).some((phase) => phase.kind === 'skill'));
});

test('candidate skill IDs cannot shadow an unassigned approved package, even when output resource paths differ', async (t) => {
  for (const resources of [['SKILL.md'], ['references/retained.md']]) await t.test(resources[0], async (child) => {
    const f = await fixture(child, () => {}, resources);
    f.request.definitions.skills = [{ id: 'inert-note', description: 'Replacement candidate',
      instructions: 'Report a different note.', operationBindings: [], resources: [] }];
    const p = await preview(f);
    assert.ok(p.result.findings.some((finding) => finding.code === 'WCA_OBJECT_COLLISION'), JSON.stringify(p.result.findings));
    assert.equal(p.result.assets.length, 0); assert.equal(p.result.fileOperations.length, 0);
    assert.equal(p.result.effects.configurationWritten, false);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.commit);
  });
});

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

test('packaged SKP notes starter previews a dedicated reviewed finish, with reviewer capacity checked before consent', async (t) => {
  const starter = JSON.parse(await readFile(new URL('../templates/starter-packs/skp-team-notes/draft-input.json', import.meta.url), 'utf8'));
  const reviewer = { name: 'Product reviewer', email: 'product@example.test' };
  const configured = await fixture(t, (definition) => {
    definition.approvalAuthorities['product-approvers'] = { label: 'Product approvers', members: [reviewer] };
    definition.phases.intake.approval = { authorities: ['product-approvers'], minimum: 1 };
  });
  starter.payload.baseRevision = configured.commit;
  const ready = await preview(configured, starter.payload);
  assert.deepEqual(ready.result.findings.map((finding) => finding.code), ['WCA_SKP_CONFIRMATION_BINDING_PENDING']);
  assert.equal(ready.result.readiness.authoring, 'review-required');
  assert.equal(ready.result.skillFinalization.status, 'requires-exact-terminal-consent');
  assert.deepEqual(ready.result.graph.map((node) => node.phaseId),
    ['intake', 'skp-team-note', 'skp-team-review']);
  assert.equal(ready.result.graph.at(-1).humanReview, true);
  assert.deepEqual(ready.result.candidateDefinition.phases['skp-team-review'].inputs,
    [{ phase: 'intake', optional: false }, { phase: 'skp-team-note', optional: false }]);
  assert.equal(ready.result.candidateDefinition.workTypes['skp-team-notes'].phases.at(-1), 'skp-team-review');

  const unconfigured = await fixture(t, (definition) => {
    definition.approvalAuthorities['product-approvers'] = { label: 'Product approvers', members: [] };
    definition.phases.intake.approval = { authorities: ['product-approvers'], minimum: 1 };
  });
  starter.payload.baseRevision = unconfigured.commit;
  const blocked = await preview(unconfigured, starter.payload);
  assert.ok(blocked.result.findings.some((finding) => finding.code === 'WCA_REVIEWER_CAPACITY_UNATTAINABLE'));
  assert.equal(blocked.result.skillFinalization, undefined);
  assert.equal(blocked.result.assets.length, 0);
});

test('code delivery cannot use the new reviewed non-code finish in place of Conformance', async (t) => {
  const f = await fixture(t, (definition) => {
    definition.phases['code-work'] = {
      label: 'Code work',
      artifact: { path: 'artifacts/code-work/summary.md', kind: 'implementation-summary', minimumBytes: 20 },
      defaultTemplate: 'common/empty.md', inputs: ['intake'], approval: { mode: 'none' },
      writeScope: 'source-and-artifact', generation: { task: 'code' }
    };
  });
  f.request.definitions.phases.push({
    id: 'team-review', label: 'Team review',
    artifact: { path: 'artifacts/team-review/review.md', kind: 'custom:review', minimumBytes: 20, maximumBytes: 16384 },
    inputs: ['code-work'], template: 'note-template', agent: 'note-writer',
    taskBinding: 'analysisTask', approvalBinding: 'review', qualityBindings: [], writeScope: 'artifact-only'
  });
  f.request.definitions.workflows[0].phases = ['intake', 'code-work', 'team-review'];
  const p = await preview(f);
  assert.ok(p.result.findings.some((finding) => finding.code === 'WCA_GRAPH_INVALID'), JSON.stringify(p.result.findings));
  assert.deepEqual(p.result.assets, []);
});

test('an ordinary source-writing verification phase cannot use the non-code reviewed finish', async (t) => {
  const f = await fixture(t, (definition) => {
    definition.phases.verification = {
      label: 'Verification',
      artifact: { path: 'artifacts/verification/report.md', kind: 'verification-report', minimumBytes: 20 },
      defaultTemplate: 'common/empty.md', inputs: ['intake'], approval: { mode: 'none' },
      writeScope: 'source-and-artifact', generation: { task: 'analyze' }
    };
  });
  f.request.definitions.phases.push({
    id: 'team-review', label: 'Team review',
    artifact: { path: 'artifacts/team-review/review.md', kind: 'custom:review', minimumBytes: 20, maximumBytes: 16384 },
    inputs: ['verification'], template: 'note-template', agent: 'note-writer',
    taskBinding: 'analysisTask', approvalBinding: 'review', qualityBindings: [], writeScope: 'artifact-only'
  });
  f.request.definitions.workflows[0].phases = ['intake', 'verification', 'team-review'];
  const p = await preview(f);
  assert.ok(p.result.findings.some((finding) => finding.code === 'WCA_GRAPH_INVALID'), JSON.stringify(p.result.findings));
  assert.deepEqual(p.result.assets, []);
});

test('an activated non-code reviewed finish remains editable through the workflow-only route', async (t) => {
  const f = await fixture(t, (definition) => {
    definition.phases['team-review'] = {
      label: 'Team review',
      artifact: { path: 'artifacts/team-review/review.md', kind: 'custom:review', minimumBytes: 20 },
      defaultTemplate: 'common/empty.md', inputs: ['intake'],
      approval: { authorities: ['reviewers'], minimum: 1 }, writeScope: 'artifact-only',
      generation: { task: 'analyze' }
    };
    definition.workTypes.baseline.phases = ['intake', 'team-review'];
  });
  const request = { schema: WCA_REQUEST_SCHEMA, intent: 'edit', id: 'change-reviewed-flow',
    label: 'Reviewed label change', baseRevision: f.commit, target: f.request.target,
    definitions: { workflows: [{ id: 'baseline', label: 'Updated reviewed flow' }] },
    changes: [{ kind: 'workflow', id: 'baseline', operation: 'edit',
      expectedDefinitionSha256: workflowDefinitionSha256(f.definition.workTypes.baseline) }] };
  const p = await preview(f, request);
  assert.deepEqual(p.result.findings, []);
  assert.equal(p.result.simulation.status, 'complete-for-profile');
  assert.deepEqual(p.result.candidateDefinition.workTypes.baseline.phases, ['intake', 'team-review']);
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

test('mixed-package SKP proposals see earlier ordinary candidate outputs independently of declaration order and ref wrapping', async (t) => {
  const f = await fixture(t);
  const ordinary = structuredClone(f.request.definitions.phases[0]);
  const skill = { id: 'team-skill', kind: 'skill', label: 'Findings', agent: 'note-writer',
    skill: { id: 'analysis-procedure' }, contract: { task: 'analyze',
      consumes: [{ phase: 'team-note', output: 'primary', required: true, state: 'approved' }],
      produces: [{ id: 'primary', path: 'artifacts/team-skill/findings.md', kind: 'custom:note',
        mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384,
        clauses: 'optional', claimRole: 'findings' }], checks: [], writeScope: 'artifact-only',
      readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 } } };
  f.request.definitions.phases = [skill, ordinary];
  f.request.definitions.skills = [{ id: 'analysis-procedure', description: 'Produce findings',
    instructions: 'Read the approved note and record findings.', operationBindings: [], resources: [] }];
  f.request.definitions.workflows[0].phases = ['intake', 'team-note', 'team-skill', 'conformance'].map((id) => ({ ref: {
    source: ['team-note', 'team-skill'].includes(id) ? 'candidate' : 'catalog', kind: 'phase', id } }));
  const p = await preview(f);
  assert.equal(p.result.skillProposals.length, 1, JSON.stringify(p.result.findings));
  assert.deepEqual(p.result.findings.map((finding) => finding.code), ['WCA_SKP_CONFIRMATION_BINDING_PENDING'], JSON.stringify(p.result.findings));
  assert.equal(p.result.skillProposals[0].bindingRefs.inputs[0].phase, 'team-note');
  assert.equal(p.result.assets.length, 0); assert.equal(p.result.readiness.activation, 'inactive');
});
