import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { prepareTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { assertStoryTestRecoveryFeatureAdmission, beginPhaseGeneration, commitAndPublish, createWorkflow,
  loadStoryTestRecoveryAgreement, publishGeneration, scanArtifacts, workDir } from '../src/state.mjs';
import { saveStoryDraft } from '../src/state-stores.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { planStoryTestSelection } from '../src/commands/story-test-selection.mjs';
import { loadTrpRecords } from '../src/test-recovery-store.mjs';
import { revokeStoryTestRisk } from '../src/story-test-risk.mjs';
import { reviewStoryBaselineAdmission } from '../src/story-baseline-admission.mjs';
import { qualifiedTrpBaselineTestPaths } from '../src/test-recovery-admission.mjs';
import { setAgentSession } from '../src/session.mjs';
import { TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const workId = 'KNOWN-BASELINE-1';
const actor = { name: 'Baseline Reviewer', email: 'baseline.reviewer@example.invalid', login: null };
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const invoke = (root, fn) => withOperationContext({ root, command: 'test', operation: {
  id: 'test.known-baseline', command: 'test', modelPolicy: 'never' }, modelMode: { enabled: false, source: 'test' } }, fn);

async function terminal(root, body, labels) {
  const code = `const {withOperationContext:runContext}=await import(${JSON.stringify(new URL('../src/operation-context.mjs', import.meta.url).href)});
    try { await runContext({root:${JSON.stringify(root)},command:'test',operation:{id:'test.known-baseline',command:'test',modelPolicy:'never'},modelMode:{enabled:false,source:'test'}},async()=>{ ${body}; }); }
    catch(error) { console.log('BASELINE_RESULT:'+JSON.stringify({ok:false,code:error.code,message:error.message,stack:error.stack,details:error.details})); }`;
  const script = `set timeout 40
    log_user 1
    set runner $env(SF_BASELINE_NODE)
    set code $env(SF_BASELINE_CODE)
    unset env(SF_BASELINE_NODE)
    unset env(SF_BASELINE_CODE)
    spawn -noecho $runner --input-type=module -e $code
    expect {
      ${labels.map(label => `"Type ${label} to confirm this exact action, or Enter to cancel:" {send -- "${label}\\r"; exp_continue}`).join('\n')}
      timeout {exit 124}
      eof {}
    }
    catch wait result
    exit [lindex $result 3]`;
  const output = await new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: root,
      env: { ...env, SF_BASELINE_NODE: process.execPath, SF_BASELINE_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(text.slice(-8000))); }, 45_000);
    child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
    child.on('error', reject); child.on('close', status => { clearTimeout(timer); resolve({ status, text }); });
  });
  assert.equal(output.status, 0, output.text.slice(-8000));
  const match = output.text.match(/BASELINE_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(match, output.text.slice(-8000));
  return JSON.parse(match[1]);
}

async function fixture(t, { phaseOverride = false, storyBranch = true, requiredDependency = false, runReadiness = true } = {}) {
  const container = await mkdtemp(path.join(os.tmpdir(), 'sflow-known-baseline-'));
  const root = path.join(container, 'repo'); await mkdir(root);
  t.after(() => rm(container, { recursive: true, force: true }));
  const priorIdentity = process.env.SINGULARITY_FLOW_TEST_IDENTITY;
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = actor.name;
  t.after(() => { if (priorIdentity === undefined) delete process.env.SINGULARITY_FLOW_TEST_IDENTITY; else process.env.SINGULARITY_FLOW_TEST_IDENTITY = priorIdentity; });
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', actor.name); git(root, 'config', 'user.email', actor.email);
  await initializeDefinition(root); await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), '.sflow/results/\nnode_modules/\n');
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/service.test.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/service.mjs';",
    "test('existing contract', () => { assert.equal(2, 3); });",
    "test('service smoke', () => { assert.equal(typeof value, 'number'); });", ''
  ].join('\n'));
  if (requiredDependency) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'known-baseline-prerequisites', version: '1.0.0', private: true,
      scripts: { test: 'node --test --test-reporter=tap test/service.test.mjs' } }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'known-baseline-prerequisites', version: '1.0.0',
      lockfileVersion: 3, packages: { '': { name: 'known-baseline-prerequisites', version: '1.0.0' } } }));
  }
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  if (requiredDependency) definition.repositoryReadiness.dependencyHydration = 'required';
  definition.approvalAuthorities['risk-reviewers'] = { label: 'Explicit baseline reviewers', allowAnyGitIdentity: false,
    members: [{ name: actor.name, email: actor.email, githubLogin: null }] };
  definition.testRecovery = { enabled: true, riskAuthorities: ['risk-reviewers'], enabledRiskCategories: ['known-test-failure'],
    allowEvidenceReuse: true, maxRiskDays: 7, caseInventory: [{ phaseId: 'implementation', commandId: '.-baseline-tests',
      dependencyScope: 'repository-and-node-builtins-only', baselineMutableRoots: ['src'],
      tests: [{ id: 'existing-contract', path: 'test/service.test.mjs', name: 'existing contract' },
        { id: 'service-smoke', path: 'test/service.test.mjs', name: 'service smoke' }] }] };
  definition.workTypes.feature = { label: 'Feature', phases: ['implementation'],
    omits: ['scope', 'plan', 'review'].map((responsibility) => ({ responsibility, reason: 'Isolated baseline acceptance fixture without a specification, plan or review step.', authority: 'engineering-reviewers' })), spec: { acceptance: 'off' } };
  Object.assign(definition.phases.implementation, { inputs: [], clarification: { mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] },
    qualityCommands: [{ id: '.-baseline-tests', kind: 'test',
      argv: [process.execPath, '--test', '--test-reporter=junit', 'test/service.test.mjs'],
      workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: '.sflow/results/baseline.xml', minimumDiscovered: 2, minimumPassed: 1 } }] });
  if (phaseOverride) definition.workTypes.feature.phaseOverrides = { implementation: {
    qualityCommands: definition.phases.implementation.qualityCommands.map(command => ({ ...command,
      result: { ...command.result, path: '.sflow/results/effective-work-type.xml' } }))
  } };
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Exact approved baseline failure and source compatibility roots');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const config = await loadDefinition(root);
  if (requiredDependency && runReadiness) {
    const { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan, loadRepositoryTestBaseline } = await import('../src/initialization/runtime-readiness.mjs');
    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    assert.equal(plan.status, 'ready', JSON.stringify(plan.blockers));
    await assert.rejects(executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: plan.planId }), { code: 'REPOSITORY_READINESS_COMMAND_FAILED' });
    const retained = (await loadRepositoryTestBaseline(root, { scope: 'dependency-test' })).baseline;
    assert.equal(retained.status, 'failing-tests');
    assert.ok(retained.commandResults.some(result => result.purpose === 'dependency' && result.status === 'pass'));
  }
  const { captureTrpIntakeBaseline } = await import('../src/test-recovery-runtime.mjs');
  const captured = await captureTrpIntakeBaseline(root, config, { workId, workType: 'feature', phaseId: 'implementation', repositoryId: 'lifecycle', baseCommit });
  assert.equal(captured.record.observedOutcome, 'failed');
  assert.equal(captured.record.counts.failed, 1); assert.equal(captured.record.counts.passed, 1);
  const readinessRepositories = [{ id: 'lifecycle', root, baseCommit, baseBranch: 'main' }];
  const repositoryReadiness = { repositories: {} };
  const choices = { baselineDisposition: 'accept-known-failures', executionMode: 'all-configured', baselineScope: 'reuse',
    baselineRecords: [captured.recordSha256], reason: 'Accept the exact longstanding assertion failure while preserving every failed label and all other test obligations.',
    followUpOwner: 'baseline-maintainer', remediationRef: 'REPAIR-EXISTING-1', expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const args = { definition: config, workId, workType: 'feature', repositories: readinessRepositories, repositoryReadiness,
    choices, phaseDefinitions: resolveWorkType(config, 'feature').phases };
  const testRecoveryPlan = await prepareTestRecoveryIntake(root, args);
  assert.equal(testRecoveryPlan.ready, !requiredDependency || runReadiness, JSON.stringify(testRecoveryPlan.blockers));
  const options = { id: workId, title: 'Carry exact existing failure through genuine feature work', source: {
    type: 'manual', key: workId, title: 'Carry exact existing failure through genuine feature work',
    description: 'Bound baseline acceptance to the reviewed native failed assertion and fresh current execution.',
    acceptanceCriteria: ['Keep the existing failure visible and block any new failure.'] },
    baseBranch: 'main', baseCommit, workType: 'feature', agent: 'developer', readinessRepositories, repositoryReadiness, testRecoveryPlan };
  if (storyBranch) git(root, 'switch', '-q', '-c', workId);
  return { root, config, captured, options, args };
}

test('real failed intake needs live delegated review and durable records before feature coding', { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
  const value = await fixture(t);
  for (const changed of [
    { ...value.args, repositories: [{ ...value.args.repositories[0], id: 'wrong-repository' }] },
    { ...value.args, repositories: [{ ...value.args.repositories[0], baseCommit: 'a'.repeat(40) }] },
    { ...value.args, workId: 'OTHER-STORY' },
    { ...value.args, choices: { ...value.args.choices, expiresAt: '2020-01-01T00:00:00Z' } }
  ]) assert.equal((await prepareTestRecoveryIntake(value.root, changed)).ready, false);
  for (const [key, purpose] of [['dependencyHydration', 'dependency'], ['build', 'build'], ['applicationStart', 'start']]) {
    const definition = structuredClone(value.config);
    definition.repositoryReadiness[key] = 'required';
    const strict = await prepareTestRecoveryIntake(value.root, { ...value.args, definition,
      repositoryReadiness: { repositories: { lifecycle: { status: 'pass', sourceCommit: value.options.baseCommit,
        receiptSha256: `sha256:${'a'.repeat(64)}`, commandResults: [{ purpose, status: 'pass' }] } } },
      nonTestReadiness: [{ repositoryId: 'lifecycle', sourceCommit: value.options.baseCommit,
        receiptSha256: `sha256:${'a'.repeat(64)}`, purposes: [purpose] }] });
    assert.equal(strict.ready, false, `${purpose} readiness cannot be supplied by a caller's JSON`);
    assert.ok(strict.blockers.some(message => message.includes('test risk cannot waive these prerequisites')));
    assert.deepEqual(strict.nonTestReadiness, []);
  }
  const originalEmail = git(value.root, 'config', 'user.email');
  git(value.root, 'config', 'user.email', 'not-delegated@example.invalid');
  await assert.rejects(createWorkflow(value.root, value.config, value.options));
  git(value.root, 'config', 'user.email', originalEmail);
  await assert.rejects(createWorkflow(value.root, value.config, value.options), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  await assert.rejects(access(path.join(workDir(value.root, value.config, workId), 'workflow.json')), { code: 'ENOENT' });
  const result = await terminal(value.root, `
    const state=await import(${JSON.stringify(new URL('../src/state.mjs', import.meta.url).href)});
    const {withOperationContext}=await import(${JSON.stringify(new URL('../src/operation-context.mjs', import.meta.url).href)});
    const root=${JSON.stringify(value.root)}, config=await state.loadConfig(root), options=${JSON.stringify(value.options)};
    await withOperationContext({root,command:'test',operation:{id:'test.known-baseline',command:'test',modelPolicy:'never'},modelMode:{enabled:false,source:'test'}},async()=>{
      const workflow=await state.createWorkflow(root,config,options);
      let before=null; try {await state.assertStoryTestRecoveryFeatureAdmission(root,config,workflow,workflow.phases.implementation);}catch(error){before=error.code;}
      if(!before) throw new Error('An uncommitted intake decision opened feature admission');
      const {qualifiedTrpBaselineTestPaths}=await import(${JSON.stringify(new URL('../src/test-recovery-admission.mjs', import.meta.url).href)});
      let uncommittedPaths; try {uncommittedPaths=await qualifiedTrpBaselineTestPaths(root,config,workflow,workflow.phases.implementation);}catch{uncommittedPaths=[];}
      if(uncommittedPaths.length) throw new Error('An uncommitted intake decision supplied first-generation testcase evidence');
      await state.commitAndPublish(root,config,workflow,{type:'binding'},'Record live exact baseline acceptance');
      console.log('BASELINE_RESULT:'+JSON.stringify({ok:true,before,generation:workflow.phases.implementation.generation}));
    });`, ['Authorize Story test agreement', 'Accept known baseline failures']);
  assert.equal(result.ok, true, result.stack ?? result.message); assert.equal(result.generation, 0);
  const loaded = await loadAcceptedStoryExecution(value.root, workId);
  value.config = loaded.config; value.workflow = loaded.workflow;
  assert.equal(value.workflow.testRecovery.readiness.repositories[0].status, 'failing-tests');
  const admitted = await assertStoryTestRecoveryFeatureAdmission(value.root, value.config, value.workflow, value.workflow.phases.implementation);
  assert.equal(admitted.featureCodingAllowed, true);
  assert.deepEqual(await qualifiedTrpBaselineTestPaths(value.root, value.config, value.workflow, value.workflow.phases.implementation), ['test/service.test.mjs']);
  const wrongPin = structuredClone(value.workflow);
  wrongPin.testRecovery.agreementSha256 = `sha256:${'a'.repeat(64)}`;
  await assert.rejects(qualifiedTrpBaselineTestPaths(value.root, value.config, wrongPin, wrongPin.phases.implementation));
  const disabled = structuredClone(value.workflow);
  disabled.resolution.testRecovery.enabled = false;
  assert.deepEqual(await qualifiedTrpBaselineTestPaths(value.root, value.config, disabled, disabled.phases.implementation), []);
  const records = await loadTrpRecords(workDir(value.root, value.config, workId));
  const decision = records.find(record => record.kind === 'phase-risk-decision');
  assert.equal(decision.category, 'known-test-failure');
  assert.equal(decision.anchorObservationDigest, value.captured.recordSha256);
  assert.deepEqual([...decision.transitions].sort(), ['generation-admission', 'publish', 'submit', 'approve', 'downstream', 'replay'].sort());
  assert.equal(records.find(record => record.kind === 'test-baseline-manifest').observedOutcome, 'failed');
  await setAgentSession(value.root, value.config, actor, 'developer', workId, { phaseId: 'implementation', source: 'test' });
  await invoke(value.root, () => beginPhaseGeneration(value.root, value.config, value.workflow, { phaseId: 'implementation' }));
  await invoke(value.root, () => saveStoryDraft(value.root, value.config, value.workflow));
  await writeFile(path.join(value.root, 'src/service.mjs'), 'export const value = 2;\n');
  git(value.root, 'add', 'src/service.mjs'); git(value.root, 'commit', '-qm', 'Feature changes only explicitly approved mutable source');
  const artifact = path.join(workDir(value.root, value.config, workId), value.workflow.phases.implementation.requiredArtifact.path);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, '# Implementation\n\nUpdated the service value from one to two within the explicitly approved mutable source root. The existing contract assertion remains failed under its exact reviewed baseline decision.\n\n## Validation\n\nThe unchanged independent service smoke test still passes. Publication executes the complete native JUnit cohort again; it never relabels the longstanding assertion failure as a passing check. New failures, changed assertions, missing cases and changed execution dependencies remain blockers.\n');
  { const reloaded = await loadAcceptedStoryExecution(value.root, workId); value.config = reloaded.config; value.workflow = reloaded.workflow; }
  const scope = await planStoryTestSelection(value.root, value.config, value.workflow, {});
  if (scope.preview.requiredConfirmation?.length) {
    const consent = await terminal(value.root, `
      const {loadAcceptedStoryExecution}=await import(${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)});
      const {confirmStoryTestSelection}=await import(${JSON.stringify(new URL('../src/commands/story-test-selection.mjs', import.meta.url).href)});
      const root=${JSON.stringify(value.root)}, {config,workflow}=await loadAcceptedStoryExecution(root,${JSON.stringify(workId)});
      const result=await confirmStoryTestSelection(root,config,workflow,{confirmation:${JSON.stringify(scope.planDigest)}});
      console.log('BASELINE_RESULT:'+JSON.stringify({ok:true,result}));`, ['Confirm test scope']);
    assert.equal(consent.ok, true, consent.stack ?? consent.message);
    const reloaded = await loadAcceptedStoryExecution(value.root, workId); value.config = reloaded.config; value.workflow = reloaded.workflow;
  }
  const authorship = buildGenerationAuthorship({ options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
    actor, governedAgentContext: 'developer', source: null });
  await invoke(value.root, async () => {
    const phase = value.workflow.phases.implementation; await scanArtifacts(value.root, value.config, value.workflow, phase.id);
    const payload = await generationStartPublicationBinding(value.root, value.workflow, phase);
    await commitAndPublish(value.root, value.config, value.workflow, { type: 'artifact-generated', phaseId: phase.id, generation: phase.generation + 1, payload },
      'Publish feature with exact existing baseline failure', phase.artifacts.map(entry => entry.path), {
        beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(value.root, value.config, value.workflow, {
          phaseId: phase.id, authorship, persist: false, publicationTransaction: { publicationEvent,
            transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead } }) });
  });
  const { assertStoryTestRiskGate, loadStoryTestRiskContext } = await import('../src/test-recovery-runtime.mjs');
  for (const operation of ['publish', 'submit', 'approve', 'downstream', 'replay']) {
    const gate = await assertStoryTestRiskGate(value.root, value.config, value.workflow, { phaseId: 'implementation', operation });
    assert.equal(gate.evaluation.gateDecision, 'allow-with-risk', operation);
    assert.equal(gate.observations[0].observedOutcome, 'failed');
  }
  const cloned = await mkdtemp(path.join(os.tmpdir(), 'sflow-known-baseline-clone-'));
  t.after(() => rm(cloned, { recursive: true, force: true }));
  git(value.root, 'clone', '-q', '--no-hardlinks', value.root, cloned);
  git(cloned, 'config', 'user.name', actor.name); git(cloned, 'config', 'user.email', actor.email);
  const copied = await loadAcceptedStoryExecution(cloned, workId);
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(cloned, copied.config, copied.workflow, copied.workflow.phases.implementation),
    error => ['TRP_AUTHORITY_REQUIRED', 'TRP_FEATURE_ADMISSION_BLOCKED', 'ENOENT'].includes(error.code));
  const testPath = path.join(value.root, 'test/service.test.mjs');
  const originalTests = await readFile(testPath, 'utf8');
  await writeFile(testPath, originalTests.replace('assert.equal(2, 3)', 'assert.equal(4, 5)'));
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(value.root, value.config, value.workflow, value.workflow.phases.implementation));
  const stale = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { phaseId: 'implementation', operation: 'publish' });
  assert.equal(stale.evaluation.gateDecision, 'block');
  await writeFile(testPath, originalTests);
  assert.equal((await loadStoryTestRiskContext(value.root, value.config, value.workflow, { phaseId: 'implementation', operation: 'publish' })).evaluation.gateDecision, 'allow-with-risk');
  { const reloaded = await loadAcceptedStoryExecution(value.root, workId); value.config = reloaded.config; value.workflow = reloaded.workflow; }
  const revokeOptions = { recordSha256: decision.recordSha256, reason: 'Revoke this baseline grant to verify a distinct fresh human admission review is required.' };
  const revocationPlan = await revokeStoryTestRisk(value.root, value.config, value.workflow, revokeOptions);
  const revoked = await terminal(value.root, `
    const {loadAcceptedStoryExecution}=await import(${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)});
    const {revokeStoryTestRisk}=await import(${JSON.stringify(new URL('../src/story-test-risk.mjs', import.meta.url).href)});
    const root=${JSON.stringify(value.root)}, {config,workflow}=await loadAcceptedStoryExecution(root,${JSON.stringify(workId)});
    const result=await revokeStoryTestRisk(root,config,workflow,${JSON.stringify({ ...revokeOptions, apply: true, confirmation: revocationPlan.planDigest })});
    console.log('BASELINE_RESULT:'+JSON.stringify({ok:true,result}));`, ['Revoke Story test risk']);
  assert.equal(revoked.ok, true, revoked.stack ?? revoked.message);
  { const reloaded = await loadAcceptedStoryExecution(value.root, workId); value.config = reloaded.config; value.workflow = reloaded.workflow; }
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(value.root, value.config, value.workflow, value.workflow.phases.implementation), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  const renewOptions = { phaseId: 'implementation', repositoryId: 'lifecycle', recordSha256: value.captured.recordSha256,
    reason: 'Re-review the retained exact existing failure for feature admission only; later transition grants remain revoked.',
    followUpOwner: 'baseline-maintainer', remediationRef: 'REPAIR-EXISTING-2', expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const renewedPlan = await reviewStoryBaselineAdmission(value.root, value.config, value.workflow, renewOptions);
  assert.equal(renewedPlan.ready, true, JSON.stringify(renewedPlan));
  await assert.rejects(reviewStoryBaselineAdmission(value.root, value.config, value.workflow, { ...renewOptions, apply: true, confirmation: renewedPlan.planDigest }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  const renewed = await terminal(value.root, `
    const {loadAcceptedStoryExecution}=await import(${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)});
    const {reviewStoryBaselineAdmission}=await import(${JSON.stringify(new URL('../src/story-baseline-admission.mjs', import.meta.url).href)});
    const root=${JSON.stringify(value.root)}, {config,workflow}=await loadAcceptedStoryExecution(root,${JSON.stringify(workId)});
    const result=await reviewStoryBaselineAdmission(root,config,workflow,${JSON.stringify({ ...renewOptions, apply: true, confirmation: renewedPlan.planDigest })});
    console.log('BASELINE_RESULT:'+JSON.stringify({ok:true,result}));`, ['Re-review baseline admission']);
  assert.equal(renewed.ok, true, renewed.stack ?? renewed.message);
  { const reloaded = await loadAcceptedStoryExecution(value.root, workId); value.config = reloaded.config; value.workflow = reloaded.workflow; }
  assert.equal((await assertStoryTestRecoveryFeatureAdmission(value.root, value.config, value.workflow, value.workflow.phases.implementation)).featureCodingAllowed, true);
  const afterRenewal = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { phaseId: 'implementation', operation: 'publish' });
  assert.equal(afterRenewal.evaluation.gateDecision, 'block', 'admission renewal cannot revive revoked publication authority');
});

test('effective work-type baseline can be re-reviewed before any generation or current observation exists', { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
  const value = await fixture(t, { phaseOverride: true });
  assert.equal(value.args.phaseDefinitions[0].qualityCommands[0].result.path, '.sflow/results/effective-work-type.xml');
  const accepted = await terminal(value.root, `
    const state=await import(${JSON.stringify(new URL('../src/state.mjs', import.meta.url).href)});
    const root=${JSON.stringify(value.root)}, config=await state.loadConfig(root);
    const workflow=await state.createWorkflow(root,config,${JSON.stringify(value.options)});
    await state.commitAndPublish(root,config,workflow,{type:'binding'},'Record generation-zero baseline acceptance');
    console.log('BASELINE_RESULT:'+JSON.stringify({ok:true,generation:workflow.phases.implementation.generation}));`,
  ['Authorize Story test agreement', 'Accept known baseline failures']);
  assert.equal(accepted.ok, true, accepted.stack ?? accepted.message);
  assert.equal(accepted.generation, 0);
  let { config, workflow } = await loadAcceptedStoryExecution(value.root, workId);
  let records = await loadTrpRecords(workDir(value.root, config, workId));
  const initialDecision = records.find(record => record.kind === 'phase-risk-decision');
  assert.equal(records.some(record => record.kind === 'phase-check-observation'), false);
  const revokeOptions = { recordSha256: initialDecision.recordSha256,
    reason: 'Withdraw the initial known-failure grant before any feature generation begins.' };
  const revokePlan = await revokeStoryTestRisk(value.root, config, workflow, revokeOptions);
  const revoked = await terminal(value.root, `
    const {loadAcceptedStoryExecution}=await import(${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)});
    const {revokeStoryTestRisk}=await import(${JSON.stringify(new URL('../src/story-test-risk.mjs', import.meta.url).href)});
    const root=${JSON.stringify(value.root)}, {config,workflow}=await loadAcceptedStoryExecution(root,${JSON.stringify(workId)});
    await revokeStoryTestRisk(root,config,workflow,${JSON.stringify({ ...revokeOptions, apply: true, confirmation: revokePlan.planDigest })});
    console.log('BASELINE_RESULT:'+JSON.stringify({ok:true}));`, ['Revoke Story test risk']);
  assert.equal(revoked.ok, true, revoked.stack ?? revoked.message);
  ({ config, workflow } = await loadAcceptedStoryExecution(value.root, workId));
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(value.root, config, workflow, workflow.phases.implementation), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  assert.deepEqual(await qualifiedTrpBaselineTestPaths(value.root, config, workflow, workflow.phases.implementation), []);
  const renewOptions = { phaseId: 'implementation', repositoryId: 'lifecycle', recordSha256: value.captured.recordSha256,
    reason: 'Independently re-review this retained exact baseline for admission before feature coding starts.',
    followUpOwner: 'baseline-maintainer', remediationRef: 'REPAIR-ZERO-1', expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const renewedPlan = await reviewStoryBaselineAdmission(value.root, config, workflow, renewOptions);
  assert.equal(renewedPlan.ready, true);
  for (const invalid of [
    { ...renewOptions, repositoryId: 'unselected-repository' },
    { ...renewOptions, phaseId: 'planning' },
    { ...renewOptions, recordSha256: `sha256:${'b'.repeat(64)}` }
  ]) await assert.rejects(reviewStoryBaselineAdmission(value.root, config, workflow, invalid));
  const renewed = await terminal(value.root, `
    const {loadAcceptedStoryExecution}=await import(${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)});
    const {reviewStoryBaselineAdmission}=await import(${JSON.stringify(new URL('../src/story-baseline-admission.mjs', import.meta.url).href)});
    const root=${JSON.stringify(value.root)}, {config,workflow}=await loadAcceptedStoryExecution(root,${JSON.stringify(workId)});
    await reviewStoryBaselineAdmission(root,config,workflow,${JSON.stringify({ ...renewOptions, apply: true, confirmation: renewedPlan.planDigest })});
    console.log('BASELINE_RESULT:'+JSON.stringify({ok:true}));`, ['Re-review baseline admission']);
  assert.equal(renewed.ok, true, renewed.stack ?? renewed.message);
  ({ config, workflow } = await loadAcceptedStoryExecution(value.root, workId));
  assert.equal(workflow.phases.implementation.generation, 0);
  assert.equal((await assertStoryTestRecoveryFeatureAdmission(value.root, config, workflow, workflow.phases.implementation)).featureCodingAllowed, true);
  assert.deepEqual(await qualifiedTrpBaselineTestPaths(value.root, config, workflow, workflow.phases.implementation), ['test/service.test.mjs']);
  records = await loadTrpRecords(workDir(value.root, config, workId));
  assert.equal(records.some(record => record.kind === 'phase-check-observation'), false, 're-review must not synthesize a current test execution');
  const decisions = records.filter(record => record.kind === 'phase-risk-decision');
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.find(record => record.recordSha256 !== initialDecision.recordSha256).transitions, ['generation-admission']);
});

test('isolated baseline CLI previews without creating a worktree and captures only in its exact reviewed target', async t => {
  const value = await fixture(t, { phaseOverride: true });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const args = ['--no-model', 'story', 'test-policy', 'baseline', workId, '--phase', 'implementation',
    '--repository', 'lifecycle', '--base', value.options.baseCommit, '--work-type', 'feature', '--isolated-worktree', '--json'];
  const runCli = extra => JSON.parse(execFileSync(process.execPath, [cli, ...args, ...extra], {
    cwd: value.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const preview = runCli([]);
  assert.equal(preview.executed, false); assert.equal(preview.stateChanged, false);
  assert.equal(preview.isolatedWorktree, true);
  assert.equal(preview.command[0].result.path, '.sflow/results/effective-work-type.xml');
  assert.ok(preview.legalActions[0].args.includes('--isolated-worktree'));
  await assert.rejects(access(preview.targetRepository), { code: 'ENOENT' });
  const beforeHead = git(value.root, 'rev-parse', 'HEAD'); const beforeStatus = git(value.root, 'status', '--porcelain');
  assert.throws(() => runCli(['--run', '--confirm', `sha256:${'a'.repeat(64)}`]));
  await assert.rejects(access(preview.targetRepository), { code: 'ENOENT' });
  const captured = runCli(['--run', '--confirm', preview.confirmation]);
  assert.equal(captured.executed, true); assert.equal(captured.storyChanged, false);
  assert.equal(captured.stateChanged, true); assert.equal(captured.filesChanged, true);
  assert.equal(captured.targetRepository, preview.targetRepository);
  assert.equal(await realpath(captured.worktree.repositoryPath), preview.targetRepository);
  assert.equal(captured.record.observedOutcome, 'failed'); assert.equal(captured.record.counts.failed, 1);
  assert.equal(git(captured.targetRepository, 'rev-parse', 'HEAD'), value.options.baseCommit);
  assert.equal(git(value.root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(value.root, 'status', '--porcelain'), beforeStatus);
  await assert.rejects(access(path.join(workDir(captured.targetRepository, value.config, workId), 'workflow.json')), { code: 'ENOENT' });
  const { inspectTrpIntakeBaseline } = await import('../src/test-recovery-runtime.mjs');
  const inspected = await inspectTrpIntakeBaseline(captured.targetRepository, { recordSha256: captured.recordSha256,
    workId, workType: 'feature', phaseId: 'implementation', repositoryId: 'lifecycle',
    baseCommit: value.options.baseCommit, definition: value.config });
  assert.equal(inspected.authenticated, true);
  await assert.rejects(inspectTrpIntakeBaseline(value.root, { recordSha256: captured.recordSha256,
    workId, workType: 'feature', phaseId: 'implementation', repositoryId: 'lifecycle',
    baseCommit: value.options.baseCommit, definition: value.config }));
  assert.throws(() => runCli(['--run', '--confirm', preview.confirmation]), error => {
    const failure = JSON.parse(error.stdout.toString());
    assert.equal(failure.error.code, 'CODE_TEST_RESULT_REQUIRED');
    assert.ok(failure.error.message.includes('managed baseline checkout was retained at'));
    return true;
  });
  await access(captured.targetRepository);
});

for (const requiredDependency of [false, true]) test(`isolated Story start consumes only its target-native baseline and durable live intake review${requiredDependency ? ' after required dependency proof' : ''}`, { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
  const value = await fixture(t, { phaseOverride: true, storyBranch: false, requiredDependency, runReadiness: false });
  const remote = path.join(path.dirname(value.root), 'origin.git');
  git(value.root, 'init', '--bare', '-q', remote);
  git(value.root, 'remote', 'add', 'origin', remote);
  git(value.root, 'push', '-q', '-u', 'origin', 'main');
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const args = ['--no-model', 'story', 'test-policy', 'baseline', workId, '--phase', 'implementation',
    '--repository', 'lifecycle', '--base', value.options.baseCommit, '--work-type', 'feature', '--isolated-worktree', '--json'];
  const runCli = extra => JSON.parse(execFileSync(process.execPath, [cli, ...args, ...extra], {
    cwd: value.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const plan = runCli([]); let captured = runCli(['--run', '--confirm', plan.confirmation]);
  const target = captured.targetRepository;
  let choices = { ...value.args.choices, baselineRecords: [captured.recordSha256] };
  let preview = await prepareTestRecoveryIntake(value.root, { ...value.args, choices, isolatedWorktree: true });
  const optionsFor = currentPreview => ({ title: value.options.title, description: value.options.source.description,
    'acceptance-criteria': value.options.source.acceptanceCriteria.join('\n'), 'from-branch': 'main',
    'work-type': 'feature', agent: 'developer', 'isolated-worktree': true, json: true,
    'test-baseline-disposition': 'accept-known-failures', 'test-execution-mode': 'all-configured', 'test-baseline-scope': 'reuse',
    'test-baseline-record': captured.recordSha256, 'test-baseline-reason': choices.reason,
    'test-baseline-owner': choices.followUpOwner, 'test-baseline-remediation': choices.remediationRef,
    'test-baseline-expires-at': choices.expiresAt, 'test-policy-confirm': currentPreview.planDigest });
  if (requiredDependency) {
    assert.equal(preview.ready, false);
    const refused = await terminal(value.root, `
      const {startCommand}=await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
      await startCommand(['start',${JSON.stringify(workId)}],${JSON.stringify(optionsFor(preview))});
      console.log('BASELINE_RESULT:'+JSON.stringify({ok:true}));`, []);
    assert.equal(refused.ok, false, 'required dependency proof cannot be substituted by a test-risk review');
    assert.equal(refused.code, 'TRP_INTAKE_CONFIRMATION_REQUIRED');
    await access(target);
    await assert.rejects(access(path.join(workDir(target, value.config, workId), 'workflow.json')), { code: 'ENOENT' });
    // This is a fixture-owned generated report. Removing this exact transport output
    // permits a new real native capture after dependency execution changes local state.
    await rm(path.join(target, '.sflow/results/effective-work-type.xml'));
    const { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } = await import('../src/initialization/runtime-readiness.mjs');
    const readinessPlan = await buildRepositoryReadinessPlan(target, { scope: 'dependency-test' });
    await assert.rejects(executeRepositoryReadinessPlan(target, { scope: 'dependency-test', confirmation: readinessPlan.planId }), { code: 'REPOSITORY_READINESS_COMMAND_FAILED' });
    captured = runCli(['--run', '--confirm', plan.confirmation]);
    choices = { ...choices, baselineRecords: [captured.recordSha256] };
    const { collectRepositoryReadinessEvidence } = await import('../src/repository-readiness-evidence.mjs');
    const repositoryReadiness = await collectRepositoryReadinessEvidence([{ id: 'lifecycle', root: target,
      baseCommit: value.options.baseCommit }], { scope: 'dependency-test' });
    preview = await prepareTestRecoveryIntake(value.root, { ...value.args, repositoryReadiness, choices, isolatedWorktree: true });
    assert.equal(preview.nonTestReadiness[0].receiptSha256, null);
    assert.ok(preview.nonTestReadiness[0].baselineSha256);
  }
  assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
  const options = optionsFor(preview);
  const started = await terminal(value.root, `
    const {startCommand}=await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
    await startCommand(['start',${JSON.stringify(workId)}],${JSON.stringify(options)});
    console.log('BASELINE_RESULT:'+JSON.stringify({ok:true}));`, ['Authorize Story test agreement', 'Accept known baseline failures']);
  assert.equal(started.ok, true, started.stack ?? started.message);
  const { config, workflow } = await loadAcceptedStoryExecution(target, workId);
  assert.equal(workflow.phases.implementation.generation, 0);
  assert.equal(workflow.testRecovery.readiness.repositories[0].status, 'failing-tests');
  assert.equal((await assertStoryTestRecoveryFeatureAdmission(target, config, workflow, workflow.phases.implementation)).featureCodingAllowed, true);
  const records = await loadTrpRecords(workDir(target, config, workId));
  assert.ok(records.some(record => record.kind === 'test-baseline-manifest' && record.recordSha256 === captured.recordSha256));
  assert.equal(records.some(record => record.kind === 'test-baseline-manifest' && record.recordSha256 === value.captured.recordSha256), false);
  assert.equal(git(value.root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(value.root, 'rev-parse', 'HEAD'), value.options.baseCommit);
  assert.equal(git(value.root, 'status', '--porcelain'), '');
  await assert.rejects(access(path.join(workDir(value.root, value.config, workId), 'workflow.json')), { code: 'ENOENT' });
});

test('native failing readiness can qualify independently passed required dependencies without a green test claim', async t => {
  const value = await fixture(t, { requiredDependency: true });
  const preview = await prepareTestRecoveryIntake(value.root, value.args);
  assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
  assert.equal(preview.nonTestReadiness.length, 1);
  assert.equal(preview.nonTestReadiness[0].receiptSha256, null);
  assert.match(preview.nonTestReadiness[0].baselineSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(preview.nonTestReadiness[0].purposes, ['dependency']);
  assert.equal(value.captured.record.observedOutcome, 'failed');
  const packagePath = path.join(value.root, 'package.json'); const original = await readFile(packagePath, 'utf8');
  await writeFile(packagePath, `${original}\n`);
  const stale = await prepareTestRecoveryIntake(value.root, value.args);
  assert.equal(stale.ready, false); assert.deepEqual(stale.nonTestReadiness, []);
  await writeFile(packagePath, original);
  assert.equal((await prepareTestRecoveryIntake(value.root, value.args)).ready, true);
});
