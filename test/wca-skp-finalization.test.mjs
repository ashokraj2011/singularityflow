import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill } from '../src/skp-contract.mjs';
import { issueActionAuthorization } from '../src/action-authorization.mjs';
import { removeTemporaryTree } from '../src/util.mjs';
import {
  WCA_SKP_PRECONSENT_PROFILE, WCA_SKP_FINALIZATION_PROFILE, WCA_SKP_LOCAL_PRODUCER_PROFILE,
  prepareWorkflowSkillFinalization, prepareWorkflowSkillConsent, workflowSkillFinalizationReview,
  assertWorkflowSkillPreConsentIdentity, consumeWorkflowSkillFinalizationConsent,
  compileConsentedWorkflowSkillPhases, workflowSkillFinalizedProjection, sealWorkflowSkillFinalization,
  renderWorkflowSkillCandidateAgent, validateWorkflowSkillFinalizationRecord
} from '../src/wca-skp-finalization.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const hash = (value) => `sha256:${recordSha256(value)}`;
const byteHash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const domainHash = (profile, value) => byteHash(Buffer.from(`${profile}\0${canonicalJson(value)}`));
const TERMINAL_UNAVAILABLE = process.platform !== 'darwin' || !existsSync('/usr/bin/expect');
const declaration = () => ({ profile: WCA_SKP_LOCAL_PRODUCER_PROFILE, eligibility: 'candidate-producer' });
function file(relative, value, withMode = false) {
  const bytes = Buffer.from(value);
  return { path: relative, bytes: bytes.length, sha256: byteHash(bytes), contentBase64: bytes.toString('base64'), ...(withMode ? { mode: '100644' } : {}) };
}
function bindSource(input) {
  input.source.payloadSha256 = hash(input.retainedInputs.request);
  const assets = input.retainedInputs.assets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const core = { schemaVersion: currentSchemaVersion('workflow-authoring-asset-manifest'), kind: 'workflow-authoring-asset-manifest', assets };
  input.source.assetManifestSha256 = hash({ ...core, assetManifestSha256: hash(core) });
  return input;
}
function bindAgent(input) {
  const agent = renderWorkflowSkillCandidateAgent(input.retainedInputs, input.phases[0].agent.id);
  input.phases[0].agent.text = agent.text;
  input.pendingFiles = input.pendingFiles.filter((item) => item.path !== agent.path);
  input.pendingFiles.push(file(agent.path, agent.text));
  return bindSource(input);
}
function fixture({ proposed = false, classified = false } = {}) {
  const contents = new Map([['SKILL.md', Buffer.from('---\nname: threat-model\ndescription: Produce an inert report\n---\nRead approved inputs and produce a report for human review.\n')],
    ['references/note.txt', Buffer.from('Exact inert reference bytes\r\n')]]);
  const { manifest } = inspectSkillPackageContents('threat-model', contents);
  const phase = { id: 'threat-model', kind: 'skill', label: 'Threat model', skill: { id: 'threat-model', packageSha256: manifest.packageSha256 },
    contract: { task: 'analyze', consumes: [{ phase: 'requirements', output: 'primary', required: true, state: 'approved' }],
      produces: [{ id: 'report', path: 'artifacts/threat-model/report.md', kind: 'custom:report', mediaType: 'text/markdown', encoding: 'utf-8', minimumBytes: 20, maximumBytes: 16384, clauses: 'none', claimRole: 'findings' }],
      checks: ['check-note'], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 }, clarification: { mode: 'off' } } };
  const catalog = { skillPackages: { 'threat-model': { packageSha256: manifest.packageSha256, eligibility: proposed ? 'proposed-candidate-producer' : 'candidate-producer' } },
    phases: { requirements: { outputs: [{ id: 'primary', path: 'artifacts/requirements/requirements.md' }] } },
    checks: { 'check-note': { id: 'check-note', argv: ['check-note', 'artifacts/threat-model/report.md'], modelPolicy: 'never', kind: 'lint', requirement: 'required' } },
    approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } },
    approvalSecurity: { profile: 'team' }, readPaths: [], sourceScopes: {}, artifactSets: {} };
  const phaseOrder = ['intake', 'requirements', 'threat-model', 'conformance'];
  const request = { schema: 'sflow-workflow-request@2', intent: 'create', id: 'threat-notes', label: 'Threat notes', baseRevision: 'a'.repeat(40),
    target: { governs: 'story', authority: 'selected-repository', hosts: [] },
    definitions: { workflows: [{ id: 'threat-notes', phases: phaseOrder }], phases: [{ ...structuredClone(phase), agent: 'note-writer' }],
      agents: [{ id: 'note-writer', description: 'Write notes', prompt: 'Exact selected agent body.\r\n', toolBindings: [], skillRefs: [] }],
      skills: [{ id: 'threat-model', description: 'Produce an inert report', instructions: 'Read approved inputs and produce a report for human review.', operationBindings: [], qualityBindings: [], resources: [], ...(classified ? { producerClassification: declaration() } : {}) }] } };
  return bindAgent({ source: { kind: 'workflow-authoring-draft-source', schemaVersion: 1, repository: '/exact/authority.git', workspaceId: 'configuration',
    draftId: 'WFD-SKPFINAL1', revision: 2, lifecycleEpoch: 1, revisionSha256: H('b'), head: 'c'.repeat(40), payloadSha256: H('d'), assetManifestSha256: H('e'), lifecycle: 'live' },
    approvedSource: { kind: 'configuration-branch', repository: '/exact/authority.git', ref: 'refs/heads/sflow/config', observedCommit: 'f'.repeat(40), baseRevision: 'a'.repeat(40), workflowSha256: H('f') },
    retainedInputs: { request, assets: [] }, phases: [{ phase, catalog, phaseOrder, agent: { id: 'note-writer', scope: 'repository', text: 'Exact selected agent body.\r\n' },
      package: { manifest, files: [...contents].map(([relative, bytes]) => file(relative, bytes)) } }], dependencyLocks: [{ source: 'approved-catalog', kind: 'phase', id: 'requirements', definitionSha256: H('a'), baseRevision: 'a'.repeat(40) }],
    policySha256: H('c'), candidateDefinition: { version: 2, phases: {}, workTypes: { 'threat-notes': { phases: phaseOrder } } },
    pendingFiles: [...contents].map(([relative, bytes]) => file(`singularity/skills/threat-model/${relative}`, bytes)),
    ...(classified ? { classificationRequests: [{ skillId: 'threat-model', packageSha256: manifest.packageSha256, ...declaration() }] } : {}) });
}
function adapter(input) {
  const entry = input.phases[0];
  return { source: input.source, approvedSource: input.approvedSource, request: input.retainedInputs.request, snapshotInputs: input.retainedInputs,
    candidateDefinition: { version: 2, phases: {}, workTypes: { 'threat-notes': { phases: entry.phaseOrder } } },
    pendingFiles: input.pendingFiles,
    entries: [{ phase: entry.phase, catalog: entry.catalog, phaseOrder: entry.phaseOrder, packageManifest: entry.package.manifest,
      agent: { ...entry.agent, definitionSha256: hash({ id: entry.agent.id, scope: entry.agent.scope, textSha256: byteHash(Buffer.from(entry.agent.text)) }) },
      ...(input.classificationRequests ? { producerClassification: declaration() } : {}) }], dependencyLocks: input.dependencyLocks, policySha256: input.policySha256 };
}
// This deliberately creates only historical structural JSON: it has no live owner brands or
// terminal witness, and the validator must never turn it into a consumed capability.
function historicalFixture(input = fixture()) {
  const prepared = prepareWorkflowSkillFinalization(input);
  const subject = structuredClone(prepared.subject);
  const definition = structuredClone(input.candidateDefinition);
  for (const entry of input.phases) {
    const row = subject.phases.find((item) => item.phaseId === entry.phase.id);
    definition.phases[entry.phase.id] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
      phase: entry.phase, catalog: entry.catalog, phaseOrder: entry.phaseOrder,
      confirmation: { contractSha256: row.contractSha256, catalogSha256: row.confirmationCatalogSha256,
        packageSha256: row.packageSha256, candidateSha256: row.confirmationCandidateSha256,
        planSha256: subject.subjectSha256, draftRevision: subject.source.revision }
    }));
  }
  const result = { subject, definition, files: [...input.pendingFiles.map((item) => ({ ...item, mode: '100644' })), file('singularity/workflow.yml', YAML.stringify(definition), true)],
    retainedInputs: structuredClone(input.retainedInputs), record: { schemaVersion: currentSchemaVersion('workflow-authoring-skp-finalization'),
      kind: 'workflow-authoring-skp-finalization', profile: WCA_SKP_FINALIZATION_PROFILE, source: subject.source, approvedSource: subject.approvedSource,
      bindingDialect: WCA_SKP_PRECONSENT_PROFILE, classificationDecisions: [],
      confirmation: { authorizationId: randomUUID(), channel: 'terminal', assurance: 'configured-local-review',
        actor: { name: 'Offline fixture', email: 'fixture@example.test', login: null, githubLookup: 'not-checked' }, authenticatedNativeHost: false },
      approval: 'not-granted', activation: 'inactive', execution: 'not-started', effects: structuredClone(prepared.effects) } };
  return resealHistorical(result);
}
function resealHistorical(value) {
  value.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const { subjectSha256, ...subjectCore } = value.subject;
  value.subject.pendingFilesSha256 = hash(value.files.filter((item) => item.path !== 'singularity/workflow.yml').map(({ mode, ...rest }) => rest));
  subjectCore.pendingFilesSha256 = value.subject.pendingFilesSha256;
  value.subject.subjectSha256 = domainHash(WCA_SKP_PRECONSENT_PROFILE, subjectCore);
  const planCore = { schemaVersion: 1, kind: 'workflow-authoring-skp-consent-plan', subject: value.subject,
    revision: value.subject.subjectSha256, effect: value.subject.intendedEffect, approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
  const planHash = recordSha256(planCore); const planId = `wca-skp-${planHash.slice(0, 24)}`; const actionId = `workflow-skp-confirm-${planHash.slice(0, 24)}`;
  value.record.preConsentSubjectSha256 = value.subject.subjectSha256;
  value.record.confirmation.actionPlanSha256 = `sha256:${planHash}`;
  value.record.confirmation.questionId = recordSha256({ planId, actionId, channel: 'terminal' }).slice(0, 24);
  const phases = value.subject.phases.map((row) => {
    const configured = value.definition.phases[row.phaseId];
    configured.skillBinding.bindingRefs.confirmation.planSha256 = value.subject.subjectSha256;
    const { kind, skillBinding, ...phasePolicy } = configured;
    skillBinding.compilationSha256 = hash({ compiler: skillBinding.compiler, phaseId: row.phaseId, phasePolicy, bindingRefs: skillBinding.bindingRefs });
    return { phaseId: row.phaseId, configuredPhase: configured, compilationSha256: skillBinding.compilationSha256 };
  });
  value.record.confirmedBindingsSha256 = hash(phases);
  value.record.emittedDefinitionSha256 = hash(value.definition);
  Object.assign(value.files.find((item) => item.path === 'singularity/workflow.yml'), file('singularity/workflow.yml', YAML.stringify(value.definition), true));
  value.record.emittedClosureSha256 = hash(value.files.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 })));
  const { finalizationSha256, ...recordCore } = value.record;
  value.record.finalizationSha256 = domainHash(WCA_SKP_FINALIZATION_PROFILE, recordCore);
  return value;
}

test('pre-consent subject is deterministic, bounded, byte-exact and contains no future receipt or final hash', () => {
  const input = fixture(); const before = structuredClone(input);
  const first = prepareWorkflowSkillFinalization(input); const second = prepareWorkflowSkillFinalization(input);
  assert.deepEqual(first, second); assert.deepEqual(input, before); assert.ok(Object.isFrozen(first.subject.phases[0].phase.contract));
  assert.equal(first.subject.profile, WCA_SKP_PRECONSENT_PROFILE);
  assert.match(first.subject.subjectSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.subject.consent, 'absent'); assert.equal(first.subject.approval, 'not-granted');
  assert.equal(first.subject.sourceProvenance, 'requires-approved-compiler-capture');
  assert.deepEqual(Object.values(first.effects), [false, false, false, false, false]);
  assert.equal(JSON.stringify(first.subject).includes('contentBase64'), false);
  assert.equal(JSON.stringify(first.subject).includes('Exact selected agent body'), false);
  assert.equal(JSON.stringify(first.subject).includes('reviewer@example.test'), false);
  assert.equal(Object.hasOwn(first.subject, 'finalizationSha256'), false);
  assert.equal(Object.hasOwn(first.subject.phases[0].bindingRefs, 'confirmation'), false);
  const review = workflowSkillFinalizationReview(first);
  assert.equal(review.plan.revision, first.subject.subjectSha256, 'the existing terminal owner requires a scalar revision');
  assert.equal(review.plan.subject.subjectSha256, first.subject.subjectSha256);
  assert.equal(review.action.confirmation.required, true);
  assert.equal(assertWorkflowSkillPreConsentIdentity(first, second.subject.subjectSha256), true);
});

test('draft, approved authority, package, order, agent, effect policy and dependency drift each change the subject', () => {
  const original = prepareWorkflowSkillFinalization(fixture());
  const edits = [
    (f) => { f.source.revision += 1; }, (f) => { f.source.head = 'd'.repeat(40); },
    (f) => { f.source.repository = '/different/authority.git'; f.approvedSource.repository = f.source.repository; },
    (f) => { f.approvedSource.observedCommit = 'b'.repeat(40); },
    (f) => { f.retainedInputs.request.definitions.agents[0].prompt += ' Changed.'; bindAgent(f); },
    (f) => { f.phases[0].phase.label = 'Changed label'; },
    (f) => { f.phases[0].phaseOrder = ['requirements', 'intake', 'threat-model', 'conformance']; },
    (f) => { f.phases[0].phase.contract.produces[0].minimumBytes += 1; },
    (f) => { f.policySha256 = H('d'); },
    (f) => { f.dependencyLocks[0].definitionSha256 = H('b'); }
  ];
  for (const edit of edits) {
    const input = fixture(); edit(input); const changed = prepareWorkflowSkillFinalization(input);
    assert.notEqual(changed.subject.subjectSha256, original.subject.subjectSha256);
    assert.throws(() => assertWorkflowSkillPreConsentIdentity(changed, original.subject.subjectSha256), { code: 'WCA_SKP_SUBJECT_STALE' });
  }
  const input = fixture();
  const changedContents = new Map(input.phases[0].package.files.map((item) => [item.path, Buffer.from(item.contentBase64, 'base64')]));
  changedContents.set('references/note.txt', Buffer.from('Changed exact package bytes'));
  const inspected = inspectSkillPackageContents('threat-model', changedContents);
  input.phases[0].package = { manifest: inspected.manifest, files: [...changedContents].map(([relative, bytes]) => file(relative, bytes)) };
  input.phases[0].phase.skill.packageSha256 = inspected.manifest.packageSha256;
  input.phases[0].catalog.skillPackages['threat-model'].packageSha256 = inspected.manifest.packageSha256;
  assert.notEqual(prepareWorkflowSkillFinalization(input).subject.subjectSha256, original.subject.subjectSha256);
});

test('source and retained-input mismatches fail before any consent or rows can be used', () => {
  for (const edit of [
    (f) => { f.retainedInputs.request.label = 'Uncaptured request'; },
    (f) => { f.retainedInputs.assets = [file('references/new.txt', 'Uncaptured bytes')]; },
    (f) => { f.approvedSource.repository = '/different/authority.git'; },
    (f) => { f.retainedInputs.request.baseRevision = 'b'.repeat(40); bindSource(f); },
    (f) => { f.source.lifecycle = 'deleted'; }, (f) => { f.source.lifecycleEpoch = 2; }
  ]) {
    const input = fixture(); edit(input);
    assert.throws(() => prepareWorkflowSkillFinalization(input), { code: 'WCA_SKP_SOURCE_STALE' });
  }
  const changed = fixture(); changed.phases[0].package.files[0].contentBase64 = Buffer.from('different').toString('base64');
  assert.throws(() => prepareWorkflowSkillFinalization(changed), { code: 'WCA_SKP_FINALIZATION_INVALID' });
});

test('missing manual producer classification remains proposal-only and generic consent cannot promote it', async () => {
  const input = fixture({ proposed: true }); const prepared = prepareWorkflowSkillFinalization(input);
  assert.equal(prepared.finalization, 'producer-classification-unavailable');
  assert.equal(prepared.subject.phases[0].producerEligibility, 'proposed-candidate-producer');
  await assert.rejects(consumeWorkflowSkillFinalizationConsent('/not-read', prepared, randomUUID()), { code: 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE' });
  assert.throws(() => compileConsentedWorkflowSkillPhases(prepared, { confirmed: true }), { code: 'WCA_SKP_CONSENT_REQUIRED' });
  assert.equal(input.phases[0].catalog.skillPackages['threat-model'].eligibility, 'proposed-candidate-producer');
});

test('explicit classification binds retained declaration, complete manifest and artifact-only effect policy', () => {
  const input = fixture({ proposed: true, classified: true }); const before = structuredClone(input);
  const prepared = prepareWorkflowSkillFinalization(input);
  assert.equal(prepared.finalization, 'requires-exact-terminal-consent');
  assert.equal(prepared.subject.phases[0].producerEligibility, 'proposed-candidate-producer');
  assert.equal(prepared.subject.classificationDecisions[0].profile, WCA_SKP_LOCAL_PRODUCER_PROFILE);
  assert.deepEqual(prepared.subject.classificationDecisions[0].manifest, input.phases[0].package.manifest);
  assert.equal(prepared.subject.classificationDecisions[0].approvedCatalogChanged, false);
  assert.notEqual(prepared.subject.phases[0].catalogSha256, prepared.subject.phases[0].confirmationCatalogSha256);
  assert.deepEqual(input, before, 'only a private intended catalog is derived; approved/candidate inputs remain unchanged');
  for (const edit of [
    (f) => { delete f.retainedInputs.request.definitions.skills[0].producerClassification; bindSource(f); },
    (f) => { f.classificationRequests[0].packageSha256 = H('a'); },
    (f) => { f.classificationRequests[0].profile = 'trust-skill-prose'; },
    (f) => { f.retainedInputs.request.definitions.skills[0].operationBindings = ['shell']; bindSource(f); },
    (f) => { f.retainedInputs.request.target.hosts = ['native-host']; bindSource(f); },
    (f) => { f.phases[0].catalog.readPaths = ['src/index.mjs']; f.phases[0].phase.contract.readScope.sourcePaths = ['src/index.mjs']; }
  ]) {
    const changed = fixture({ proposed: true, classified: true }); edit(changed);
    assert.throws(() => prepareWorkflowSkillFinalization(changed), { code: 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE' });
  }
  assert.throws(() => prepareWorkflowSkillFinalization(fixture({ classified: true })), { code: 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE' }, 'an explicit request cannot reclassify approved eligibility');
});

test('compiler adapter binds ordinary candidate and pending closure without accepting copied projections', () => {
  const input = adapter(fixture({ proposed: true, classified: true }));
  const prepared = prepareWorkflowSkillConsent(input);
  assert.equal(prepared.subject.candidateDefinitionSha256, hash(input.candidateDefinition));
  assert.match(prepared.subject.pendingFilesSha256, /^sha256:[a-f0-9]{64}$/u);
  const changed = structuredClone(input); changed.candidateDefinition.workTypes['threat-notes'].label = 'Changed ordinary workflow';
  assert.notEqual(prepareWorkflowSkillConsent(changed).subject.subjectSha256, prepared.subject.subjectSha256);
  changed.request.label = 'Different request';
  assert.throws(() => prepareWorkflowSkillConsent(changed), { code: 'WCA_SKP_SOURCE_STALE' });
  const wrongAgent = structuredClone(input); wrongAgent.entries[0].agent.definitionSha256 = H('a');
  assert.throws(() => prepareWorkflowSkillConsent(wrongAgent), { code: 'WCA_SKP_SOURCE_STALE' });
  assert.throws(() => workflowSkillFinalizationReview(structuredClone(prepared)), { code: 'WCA_SKP_SUBJECT_UNAVAILABLE' });
  assert.throws(() => workflowSkillFinalizedProjection(prepared, { phases: [], confirmed: true }), { code: 'WCA_SKP_CONSENT_REQUIRED' });
  assert.throws(() => sealWorkflowSkillFinalization({ phases: [] }, { definition: {}, files: [] }), { code: 'WCA_SKP_CONSENT_REQUIRED' });
});

test('selected candidate agent captures full exact document and rejects request, file, default and origin substitutions', () => {
  const input = fixture(); const prepared = prepareWorkflowSkillFinalization(input); const selected = prepared.subject.phases[0].selectedAgent;
  assert.equal(selected.source, 'candidate'); assert.equal(selected.path, '.github/agents/threat-notes-note-writer.agent.md');
  assert.equal(Buffer.from(selected.bodyBase64, 'base64').toString('utf8'), input.phases[0].agent.text);
  assert.equal(selected.textSha256, byteHash(Buffer.from(input.phases[0].agent.text)));
  assert.equal(selected.bytes, Buffer.byteLength(input.phases[0].agent.text));
  for (const edit of [
    (value) => { value.phases[0].agent.text += '\nUnreviewed prompt.'; },
    (value) => { const emitted = value.pendingFiles.find((item) => item.path === selected.path); Object.assign(emitted, file(selected.path, 'Unreviewed document')); },
    (value) => { value.pendingFiles = value.pendingFiles.filter((item) => item.path !== selected.path); },
    (value) => { value.retainedInputs.request.definitions.agents.push(structuredClone(value.retainedInputs.request.definitions.agents[0])); bindSource(value); },
    (value) => { value.retainedInputs.request.definitions.phases[0].agent = { source: 'catalog', kind: 'agent', id: 'note-writer' }; bindSource(value); },
    (value) => { value.phases[0].agent.scope = 'global'; },
    (value) => { value.retainedInputs.request.definitions.agents[0].unexpected = 'Cannot normalize advanced bytes'; bindSource(value); }
  ]) assert.throws(() => prepareWorkflowSkillFinalization(editAndReturn(fixture(), edit)), /selected|agent|candidate|shape|phase/iu);
  function editAndReturn(value, edit) { edit(value); return value; }
});

test('candidate agent reconstruction binds retained prompt assets and inline request assets without changing their bytes', () => {
  for (const inline of [false, true]) {
    const input = fixture(); const definition = input.retainedInputs.request.definitions.agents[0];
    delete definition.prompt; definition.promptAsset = 'prompts/notes.md';
    const literal = 'Literal asset body\r\nWith a final newline\r\n';
    if (inline) input.retainedInputs.request.assets = [{ path: 'prompts/notes.md', mediaType: 'text/markdown', content: literal }];
    else input.retainedInputs.assets = [file('prompts/notes.md', literal)];
    bindAgent(input);
    assert.ok(input.phases[0].agent.text.endsWith(`${literal}\n`));
    const historical = historicalFixture(input);
    assert.equal(validateWorkflowSkillFinalizationRecord(historical).authority, 'none');
    if (inline) historical.retainedInputs.request.assets[0].content = 'Changed literal';
    else historical.retainedInputs.assets[0] = file('prompts/notes.md', 'Changed asset');
    assert.throws(() => validateWorkflowSkillFinalizationRecord(historical), { code: 'WCA_SKP_FINALIZATION_INVALID' });
  }
});

test('fully resealed changed candidate agent cannot hide an unchanged retained prompt or default mapping', () => {
  const original = historicalFixture();
  assert.equal(validateWorkflowSkillFinalizationRecord(original).structurallyConsistent, true);
  for (const mutation of ['file-only', 'body-and-hash', 'missing-default', 'different-source', 'different-path']) {
    const changed = structuredClone(original); const row = changed.subject.phases[0];
    const agent = changed.files.find((item) => item.path === row.selectedAgent.path);
    const literal = Buffer.from(agent.contentBase64, 'base64').toString('utf8');
    const modified = mutation === 'missing-default' ? literal.replace('sflow-default-for: threat-model', 'sflow-default-for: conformance') : `${literal}\nUnreviewed historical prompt.\n`;
    Object.assign(agent, file(agent.path, modified, true));
    if (mutation !== 'file-only') Object.assign(row.selectedAgent, { bytes: agent.bytes, textSha256: agent.sha256, bodyBase64: agent.contentBase64 });
    if (mutation === 'different-source') row.selectedAgent.source = 'approved-catalog';
    if (mutation === 'different-path') row.selectedAgent.path = '.github/agents/another-note-writer.agent.md';
    resealHistorical(changed);
    assert.equal(changed.retainedInputs.request.definitions.agents[0].prompt, original.retainedInputs.request.definitions.agents[0].prompt);
    assert.throws(() => validateWorkflowSkillFinalizationRecord(changed), /selected|agent/iu, mutation);
  }
  assert.throws(() => validateWorkflowSkillFinalizationRecord({ subject: original.subject, record: original.record, definition: original.definition, files: original.files }), { code: 'WCA_SKP_FINALIZATION_INVALID' });
  assert.throws(() => compileConsentedWorkflowSkillPhases(prepareWorkflowSkillFinalization(fixture()), validateWorkflowSkillFinalizationRecord(original)), { code: 'WCA_SKP_CONSENT_REQUIRED' });
});

test('approved and installed agents retain exact body, original scope, captured lock and declared phase default without live reads', () => {
  for (const scope of ['repository', 'installed', 'global']) {
    const input = fixture(); delete input.retainedInputs.request.definitions.agents;
    input.retainedInputs.request.definitions.phases[0].agent = { ref: { source: 'catalog', kind: 'agent', id: 'note-writer' } };
    input.phases[0].agent.scope = scope;
    input.pendingFiles = input.pendingFiles.filter((item) => !item.path.startsWith('.github/agents/'));
    input.dependencyLocks.push({ source: scope === 'repository' ? 'approved-catalog' : 'installed-agent-registry', kind: 'agent', id: 'note-writer',
      definitionSha256: hash({ id: 'note-writer', scope, textSha256: byteHash(Buffer.from(input.phases[0].agent.text)) }), baseRevision: input.approvedSource.baseRevision });
    bindSource(input);
    const prepared = prepareWorkflowSkillFinalization(input); const selected = prepared.subject.phases[0].selectedAgent;
    assert.equal(selected.scope, scope); assert.equal(selected.path, null);
    assert.equal(selected.source, scope === 'repository' ? 'approved-catalog' : 'installed-agent-registry');
    const retained = historicalFixture(input); assert.equal(validateWorkflowSkillFinalizationRecord(retained).authority, 'none');
    const changed = structuredClone(retained); const row = changed.subject.phases[0];
    const modified = Buffer.concat([Buffer.from(row.selectedAgent.bodyBase64, 'base64'), Buffer.from('Unreviewed captured body.')]);
    Object.assign(row.selectedAgent, { bytes: modified.length, textSha256: byteHash(modified), bodyBase64: modified.toString('base64') });
    assert.throws(() => validateWorkflowSkillFinalizationRecord(resealHistorical(changed)), { code: 'WCA_SKP_SOURCE_STALE' });
    const noDefault = structuredClone(input); noDefault.phases[0].agent.text = noDefault.phases[0].agent.text.replace('sflow-default-for: threat-model', 'sflow-default-for: conformance');
    noDefault.dependencyLocks.at(-1).definitionSha256 = hash({ id: 'note-writer', scope, textSha256: byteHash(Buffer.from(noDefault.phases[0].agent.text)) });
    assert.throws(() => prepareWorkflowSkillFinalization(noDefault), { code: 'WCA_SKP_FINALIZATION_INVALID' });
    const missingLock = structuredClone(input); missingLock.dependencyLocks.pop();
    assert.throws(() => prepareWorkflowSkillFinalization(missingLock), { code: 'WCA_SKP_SOURCE_STALE' });
  }
});

test('closed bounded JSON rejects accessors, cycles, symbols, sparse arrays and receipt/boolean extensions', () => {
  let reads = 0; const getter = fixture(); Object.defineProperty(getter, 'confirmed', { enumerable: true, get() { reads += 1; return true; } });
  assert.throws(() => prepareWorkflowSkillFinalization(getter), { code: 'WCA_SKP_FINALIZATION_INVALID' }); assert.equal(reads, 0);
  const symbol = fixture(); symbol[Symbol('receipt')] = 'x';
  assert.throws(() => prepareWorkflowSkillFinalization(symbol), { code: 'WCA_SKP_FINALIZATION_INVALID' });
  const cycle = fixture(); cycle.circular = cycle;
  assert.throws(() => prepareWorkflowSkillFinalization(cycle), { code: 'WCA_SKP_FINALIZATION_INVALID' });
  const sparse = fixture(); sparse.phases = Array(2);
  assert.throws(() => prepareWorkflowSkillFinalization(sparse), { code: 'WCA_SKP_FINALIZATION_INVALID' });
  for (const extra of [{ confirmed: true }, { authorization: { token: randomUUID() } }, { finalizationSha256: H('b') }]) {
    assert.throws(() => prepareWorkflowSkillFinalization({ ...fixture(), ...extra }), { code: 'WCA_SKP_FINALIZATION_INVALID' });
  }
  const many = fixture(); many.phases = Array(65).fill(many.phases[0]);
  assert.throws(() => prepareWorkflowSkillFinalization(many), { code: 'WCA_SKP_FINALIZATION_LIMIT' });
  const hugeSparse = fixture(); hugeSparse.phases = Array(2 ** 32 - 1);
  assert.throws(() => prepareWorkflowSkillFinalization(hugeSparse), { code: 'WCA_SKP_FINALIZATION_LIMIT' });
  const oversized = fixture(); oversized.phases[0].agent.text = 'x'.repeat(12 * 1024 * 1024 + 1);
  assert.throws(() => prepareWorkflowSkillFinalization(oversized), { code: 'WCA_SKP_FINALIZATION_LIMIT' });
});

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-finalization-')); t.after(() => removeTemporaryTree(root));
  const result = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  for (const [key, value] of [['user.name', 'SKP Finalization Fixture'], ['user.email', 'skp.fixture@example.test']]) {
    const configured = spawnSync('git', ['config', key, value], { cwd: root, encoding: 'utf8' }); assert.equal(configured.status, 0, configured.stderr);
  }
  return root;
}

test('public issuer and fabricated durable receipt cannot mint the live consumed capability', async (t) => {
  const root = await repository(t); const prepared = prepareWorkflowSkillFinalization(fixture()); const review = workflowSkillFinalizationReview(prepared);
  const previous = { NODE_ENV: process.env.NODE_ENV, SINGULARITY_FLOW_TEST_IDENTITY: process.env.SINGULARITY_FLOW_TEST_IDENTITY };
  process.env.NODE_ENV = 'test'; process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'SKP Finalization Fixture';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const record = await issueActionAuthorization(root, review.plan, review.action, { confirmation: review.action.actionId, channel: 'terminal' });
  await assert.rejects(consumeWorkflowSkillFinalizationConsent(root, prepared, record.token), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  const forged = { ...record, token: randomUUID(), authorizationId: randomUUID() };
  forged.answerReceipt = recordSha256({ token: forged.token, authorizationId: forged.authorizationId, planHash: forged.planHash, actionId: forged.actionId });
  const directory = path.join(root, '.git/singularity-flow/action-authorizations'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${forged.token}.json`), canonicalJson(forged));
  await assert.rejects(consumeWorkflowSkillFinalizationConsent(root, prepared, forged.token), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  for (const fake of [true, record, forged, { kind: 'workflow-authoring-skp-consumed-consent', subjectSha256: prepared.subject.subjectSha256 }]) {
    assert.throws(() => compileConsentedWorkflowSkillPhases(prepared, fake), { code: 'WCA_SKP_CONSENT_REQUIRED' });
  }
});

async function terminal(t, { cancel = false, changedCard = false, proposed = false } = {}) {
  const root = await repository(t); const input = fixture({ proposed, classified: proposed });
  const module = new URL('../src/wca-skp-finalization.mjs', import.meta.url).href;
  const authModule = new URL('../src/action-authorization.mjs', import.meta.url).href;
  const recordsModule = new URL('../src/records.mjs', import.meta.url).href;
  const code = `
    import YAML from 'yaml';
    import {createHash} from 'node:crypto';
    import {canonicalJson,recordSha256} from ${JSON.stringify(recordsModule)};
    import * as owner from ${JSON.stringify(module)};
    import {captureTerminalActionAuthorization} from ${JSON.stringify(authModule)};
    const input=${JSON.stringify(input)};
    const f=(p,b)=>{b=Buffer.from(b);return{path:p,mode:'100644',bytes:b.length,sha256:'sha256:'+createHash('sha256').update(b).digest('hex'),contentBase64:b.toString('base64')};};
    const prepared=owner.prepareWorkflowSkillFinalization(input);
    const review=owner.workflowSkillFinalizationReview(prepared);
    const presented=${changedCard} ? structuredClone(review) : review;
    if(${changedCard}) presented.plan.subject.phases[0].selectedAgent.textSha256='sha256:'+'0'.repeat(64);
    const grant=await captureTerminalActionAuthorization(${JSON.stringify(root)},presented.plan,presented.action,{label:'Review skill contracts'});
    let result;
    if(!grant) result={cancelled:true};
    else try {
      const consent=await owner.consumeWorkflowSkillFinalizationConsent(${JSON.stringify(root)},prepared,grant.token);
      const projection=owner.compileConsentedWorkflowSkillPhases(prepared,consent);
      let replay,copy;
      try {owner.compileConsentedWorkflowSkillPhases(prepared,consent);}catch(e){replay=e.code;}
      try {owner.compileConsentedWorkflowSkillPhases(prepared,structuredClone(consent));}catch(e){copy=e.code;}
      const definition={version:2,phases:Object.fromEntries(projection.phases.map(p=>[p.phaseId,p.configuredPhase])),workTypes:{'threat-notes':{phases:input.phases[0].phaseOrder}}};
      const files=input.pendingFiles.map(p=>({...p,mode:'100644'}));
      files.push(f('singularity/workflow.yml',YAML.stringify(definition)));
      const sealed=owner.sealWorkflowSkillFinalization(projection,{definition,files});
      const repeated=owner.sealWorkflowSkillFinalization(projection,{definition,files});
      const offline=owner.validateWorkflowSkillFinalizationRecord(JSON.parse(JSON.stringify({subject:prepared.subject,record:sealed,definition,files,retainedInputs:input.retainedInputs})));
      let offlineCannotGrant;try{owner.compileConsentedWorkflowSkillPhases(prepared,offline);}catch(e){offlineCannotGrant=e.code;}
      const rehash=(r)=>{const{finalizationSha256,...core}=r;return{...core,finalizationSha256:'sha256:'+createHash('sha256').update(owner.WCA_SKP_FINALIZATION_PROFILE+'\\0').update(canonicalJson(core)).digest('hex')};};
      const offlineRefusals=[];
      for(const kind of ['native','approval','ordinary','bytes']){
        let r=structuredClone(sealed),d=structuredClone(definition),fs=structuredClone(files);
        if(kind==='native')r.confirmation.authenticatedNativeHost=true;
        if(kind==='approval')r.approval='granted';
        if(kind==='ordinary'){d.workTypes['threat-notes'].label='Unreviewed policy';fs[fs.length-1]=f('singularity/workflow.yml',YAML.stringify(d));r.emittedDefinitionSha256='sha256:'+recordSha256(d);r.emittedClosureSha256='sha256:'+recordSha256(fs.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(({path,mode,bytes,sha256})=>({path,mode,bytes,sha256})));}
        if(kind==='bytes')fs[0]=f(fs[0].path,'Changed retained byte closure');
        r=rehash(r);
        try{owner.validateWorkflowSkillFinalizationRecord({subject:prepared.subject,record:r,definition:d,files:fs,retainedInputs:input.retainedInputs});}catch(e){offlineRefusals.push(e.code);}
      }
      const newPrepared=owner.prepareWorkflowSkillFinalization(input);
      let recaptured=owner.workflowSkillFinalizedProjection(newPrepared,projection)===projection;
      const changed=structuredClone(input);changed.source.head='d'.repeat(40);let changedSource;
      try {owner.workflowSkillFinalizedProjection(owner.prepareWorkflowSkillFinalization(changed),projection);}catch(e){changedSource=e.code;}
      const invalid=[];
      for(const kind of ['binding','package','native','workflow']){
        const d=structuredClone(definition),fs=structuredClone(files);
        if(kind==='binding'){d.phases['threat-model'].label='Changed';fs[fs.length-1]=f('singularity/workflow.yml',YAML.stringify(d));}
        if(kind==='package')fs[0]=f(fs[0].path,'Unreviewed bytes');
        if(kind==='native')fs.push(f('.github/skills/surprise/SKILL.md','Native install'));
        if(kind==='workflow')fs[fs.length-1]=f('singularity/workflow.yml','phases: {}');
        try{owner.sealWorkflowSkillFinalization(projection,{definition:d,files:fs});}catch(e){invalid.push(e.code);}
      }
      const changedDefinition=structuredClone(definition);changedDefinition.workTypes['threat-notes'].label='Ordinary exact emitted change';
      const changedFiles=structuredClone(files);changedFiles[changedFiles.length-1]=f('singularity/workflow.yml',YAML.stringify(changedDefinition));
      let ordinaryDrift;try{owner.sealWorkflowSkillFinalization(projection,{definition:changedDefinition,files:changedFiles});}catch(e){ordinaryDrift=e.code;}
      const whitespaceFiles=structuredClone(files);whitespaceFiles[whitespaceFiles.length-1]=f('singularity/workflow.yml',YAML.stringify(definition)+'\\n');
      const other=owner.sealWorkflowSkillFinalization(projection,{definition,files:whitespaceFiles});
      result={projection,sealed,repeated,other,ordinaryDrift,replay,copy,recaptured,changedSource,invalid,offline,offlineCannotGrant,offlineRefusals,sourceEligibility:input.phases[0].catalog.skillPackages['threat-model'].eligibility,subject:prepared.subject};
    }catch(e){result={error:{code:e.code,message:e.message}};}
    console.log('SKP_FINALIZATION_RESULT:'+JSON.stringify(result));
  `;
  const script = 'set timeout 20\nspawn -noecho $env(SF_SKP_FINALIZATION_NODE) --input-type=module -e $env(SF_SKP_FINALIZATION_CODE)\nexpect {\n -exact {Type Review skill contracts} { send -- "$env(SF_SKP_FINALIZATION_ANSWER)\\r" }\n timeout {exit 124}\n eof {exit 125}\n}\nexpect {eof {} timeout {exit 124}}\nset result [wait]\nexit [lindex $result 3]\n';
  const observed = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'SKP Finalization Fixture', SF_SKP_FINALIZATION_NODE: process.execPath,
      SF_SKP_FINALIZATION_CODE: code, SF_SKP_FINALIZATION_ANSWER: cancel ? '' : 'Review skill contracts' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Exact terminal fixture timed out.')); }, 30000);
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, errors }); });
  });
  assert.equal(observed.status, 0, `${observed.output.slice(-2000)}\n${observed.errors.slice(-2000)}`);
  const match = observed.output.match(/SKP_FINALIZATION_RESULT:(\{[^\r\n]+\})/u); assert.ok(match, observed.output.slice(-2000));
  return { ...JSON.parse(match[1]), output: observed.output };
}

test('actual direct-terminal consent lowers once and seals separate binding/closure identities without circularity', { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  const result = await terminal(t);
  assert.equal(result.error, undefined); assert.equal(result.projection.confirmation.assurance, 'configured-local-review');
  assert.equal(result.projection.confirmation.authenticatedNativeHost, false); assert.equal(result.replay, 'WCA_SKP_CONSENT_REQUIRED'); assert.equal(result.copy, 'WCA_SKP_CONSENT_REQUIRED');
  assert.equal(result.sealed.profile, WCA_SKP_FINALIZATION_PROFILE); assert.deepEqual(result.sealed, result.repeated);
  assert.notEqual(result.sealed.finalizationSha256, result.subject.subjectSha256);
  const binding = result.projection.phases[0].configuredPhase.skillBinding.bindingRefs.confirmation;
  assert.equal(binding.planSha256, result.subject.subjectSha256); assert.equal(binding.draftRevision, 2);
  assert.equal(JSON.stringify(result.projection.phases).includes(result.sealed.finalizationSha256), false);
  assert.notEqual(result.sealed.finalizationSha256, result.other.finalizationSha256, 'only final emitted closure changes the final identity');
  assert.equal(result.ordinaryDrift, 'WCA_SKP_FINALIZATION_INVALID', 'the distinct final hash never authorizes an unreviewed ordinary policy change');
  assert.equal(result.other.preConsentSubjectSha256, result.sealed.preConsentSubjectSha256);
  assert.equal(result.recaptured, true); assert.equal(result.changedSource, 'WCA_SKP_CONSENT_REQUIRED');
  assert.deepEqual(result.invalid, Array(4).fill('WCA_SKP_FINALIZATION_INVALID'));
  assert.equal(result.offline.structurallyConsistent, true); assert.equal(result.offline.authority, 'none');
  assert.equal(result.offlineCannotGrant, 'WCA_SKP_CONSENT_REQUIRED'); assert.deepEqual(result.offlineRefusals, Array(4).fill('WCA_SKP_FINALIZATION_INVALID'));
  assert.equal(result.sealed.confirmation.actor.email, 'skp.finalization.fixture@example.com');
  assert.match(result.sealed.confirmation.actionPlanSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(Object.values(result.sealed.effects), [false, false, false, false, false]);
  assert.equal(result.sealed.approval, 'not-granted'); assert.equal(result.sealed.activation, 'inactive'); assert.equal(result.sealed.execution, 'not-started');
});

test('actual local classification is explicit exact-manifest inactive review, never catalog approval or runtime admission', { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  const result = await terminal(t, { proposed: true }); assert.equal(result.error, undefined);
  assert.equal(result.sourceEligibility, 'proposed-candidate-producer');
  assert.equal(result.subject.phases[0].producerEligibility, 'proposed-candidate-producer');
  assert.equal(result.projection.classificationDecisions[0].eligibility, 'candidate-producer');
  assert.equal(result.projection.classificationDecisions[0].approvedCatalogChanged, false);
  assert.deepEqual(result.sealed.classificationDecisions, result.projection.classificationDecisions);
  assert.match(result.output, /local-reviewed-artifact-producer\/v1/u);
});

test('Cancel has no consumed capability and altered presented card cannot authorize the original subject', { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  assert.equal((await terminal(t, { cancel: true })).cancelled, true);
  assert.equal((await terminal(t, { changedCard: true })).error.code, 'ACTION_TERMINAL_PRESENTATION_REQUIRED');
});
