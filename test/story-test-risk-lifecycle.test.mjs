import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { applyCapabilityPolicyToWorkResolution, resolveLifecycleCapability } from '../src/capability-context.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, materializeConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { verifyCodeDeliveryReceipt } from '../src/delivery-evidence.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { governedCommitIdentity } from '../src/git.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { runQualityCommand } from '../src/quality-command-runner.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { setAgentSession } from '../src/session.mjs';
import { approvePhase, commitAndPublish, createWorkflow, preparePhaseInputs, publishGeneration, scanArtifacts, submitPhase, workDir } from '../src/state.mjs';
import { createStoryReviewPacket, readStoryReviewPacket } from '../src/story-lineage.mjs';
import { acceptStoryTestRisk, attestStoryTestRisk, planStoryTestRisk, revokeStoryTestRisk } from '../src/story-test-risk.mjs';
import { previewTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { assertStoryTestRiskGate, beginStoryTestRiskRun, captureStoryTestRiskObservation, loadStoryTestRiskContext, verifiedStoryTestRiskReviewCommits } from '../src/test-recovery-runtime.mjs';
import { normalizeTrpDeliveryCommands } from '../src/trp-delivery-selection.mjs';
import { TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const workId = 'RISK-LOCAL-1';
const author = { name: 'Risk Author', email: 'risk.author@example.com', login: null };
const riskReviewer = { name: 'Risk Reviewer', email: 'risk.reviewer@example.com', login: null };
const phaseReviewer = { name: 'Phase Reviewer', email: 'phase.reviewer@example.com', login: null };
const git = (root, ...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const invoke = (root, callback) => withOperationContext({ root, command: 'test',
  operation: { id: 'test.story-risk', command: 'test', modelPolicy: 'never' },
  modelMode: { enabled: false, source: 'test' } }, callback);
const reason = 'The configured executable is absent on this host. Accept only the displayed unverified transition while runtime installation is tracked separately.';
const terms = { phaseId: 'implementation', repositoryId: 'application', reason,
  followUpOwner: 'runtime-maintainer', remediationRef: 'RUNTIME-REPAIR-1' };

function setActor(root, actor) {
  git(root, 'config', 'user.name', actor.name);
  git(root, 'config', 'user.email', actor.email);
  // Isolate account lookup as well as Git configuration: never query the host's signed-in account.
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = actor.name;
}

/** Real Git/CLI/PTY fixture with an actual ENOENT launch, not a fabricated failed test report. */
async function fixture(t, { unavailable = true, danglingRuntime = false, downstream = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-risk-lifecycle-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'application');
  const remote = path.join(base, 'remote.git');
  const runtimeTarget = path.join(base, 'installed-test-runtime');
  await mkdir(root);
  const environment = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: author.name,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(base, 'configuration-cache') };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  git(root, 'init', '-q', '-b', 'main'); setActor(root, author);
  await initializeDefinition(root);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'risk-fixture', version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap test/*.test.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'risk-fixture', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name: 'risk-fixture', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/service.test.mjs'), "import test from 'node:test'; test('baseline', () => {});\n");
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.approvalSecurity = { profile: 'team', allowSelfApproval: false, autoEnrollNewIdentities: false };
  for (const [id, actor] of [['engineering-reviewers', phaseReviewer], ['risk-reviewers', riskReviewer]]) {
    definition.approvalAuthorities[id] = { label: id, allowAnyGitIdentity: false,
      members: [{ name: actor.name, email: actor.email, githubLogin: null }] };
  }
  definition.testRecovery = { enabled: true, riskAuthorities: ['risk-reviewers'],
    enabledRiskCategories: ['validation-unavailable'], allowEvidenceReuse: false, maxRiskDays: 7 };
  definition.workTypes.feature = { label: 'Feature', phases: downstream ? ['implementation', 'testing'] : ['implementation'],
    plannedClaims: { mode: 'opt-out', reason: 'Isolated unavailable-runner fixture without a specification phase.' },
    spec: { acceptance: 'off' } };
  if (downstream) {
    Object.assign(definition.phases.testing, { inputs: ['implementation'], writeScope: 'artifact-only',
      testEvidenceFrom: 'implementation', clarification: { mode: 'off' }, qualityCommands: [],
      approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['implementation', 'testing'] } });
  }
  const phase = definition.phases.implementation;
  phase.inputs = []; phase.clarification = { mode: 'off' };
  phase.qualityCommands = [{ id: '.-python-tests', kind: 'test',
    argv: unavailable ? [path.join(root, 'tools', 'missing-test-runtime')]
      : [process.execPath, '--test', '--test-reporter=tap', 'test/service.test.mjs'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'node-tap', path: '.sflow/results/required.tap', minimumDiscovered: 1, minimumPassed: 1 } }];
  await writeFile(definitionPath, YAML.stringify(definition));
  if (danglingRuntime) {
    await mkdir(path.join(root, 'tools'));
    await symlink(runtimeTarget, path.join(root, 'tools', 'missing-test-runtime'));
  }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Application and approved unavailable-validation policy');
  git(base, 'clone', '-q', '--bare', root, remote); git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`);
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  await materializeConfigurationSnapshot(root, { snapshot: approved });
  git(root, 'add', 'singularity'); git(root, 'commit', '-qm', 'Materialize exact approved risk policy');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const readiness = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  assert.deepEqual(readiness.blockers, []);
  const ready = await executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: readiness.planId });
  assert.equal(ready.receipt.status, 'pass', 'baseline admission is backed by actual passing Node execution');
  const readinessRepositories = [{ id: 'application', root, baseCommit, baseBranch: 'main' }];
  const repositoryReadiness = await collectRepositoryReadinessEvidence(readinessRepositories, { scope: 'dependency-test' });
  const config = await loadDefinition(root);
  const resolved = resolveWorkType(config, 'feature');
  const testRecoveryPlan = previewTestRecoveryIntake({ definition: config, workId, workType: 'feature',
    repositories: readinessRepositories, repositoryReadiness,
    choices: { baselineDisposition: 'fix', executionMode: 'all-configured', baselineScope: 'reuse' },
    phaseDefinitions: applyCapabilityPolicyToWorkResolution(resolved, await resolveLifecycleCapability(root)).phases });
  assert.equal(testRecoveryPlan.ready, true);
  git(root, 'switch', '-q', '-c', workId);
  await setAgentSession(root, config, author, 'developer', workId, { phaseId: 'implementation', source: 'test' });
  const workflow = await invoke(root, () => createWorkflow(root, config, { id: workId, title: 'Retain an unavailable test observation',
    source: { type: 'manual', key: workId, title: 'Retain an unavailable test observation',
      description: 'Keep generated source intact and require distinct human authority for unverified validation.',
      acceptanceCriteria: ['The service implements the requested value.'] },
    baseBranch: 'main', baseCommit, workType: 'feature', agent: 'developer', resolved,
    readinessRepositories, repositoryReadiness, testRecoveryPlan, approvedConfigurationSnapshot: approved }));
  await invoke(root, () => commitAndPublish(root, config, workflow, { type: 'binding' }, 'Bind the exact Story risk policy'));
  const artifact = path.join(workDir(root, config, workId), workflow.phases.implementation.requiredArtifact.path);
  await writeFile(artifact, '# Implementation\n\nImplemented the requested service value and an executable assertion.\n\n## Validation limitation\n\nThe configured test runtime is unavailable. No current candidate test pass is claimed. Each permitted transition requires its exact reviewed decision; ordinary phase approval remains separate.\n');
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 2;\n');
  await writeFile(path.join(root, 'test/service.test.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/service.mjs';",
    `test('service contract', () => { assert.equal(value, ${unavailable ? '2' : '3'}); });`, ''
  ].join('\n'));
  git(root, 'add', 'src/service.mjs', 'test/service.test.mjs');
  git(root, 'commit', '-qm', 'Retain generated application source before risk review');
  await mkdir(path.join(root, '.sflow/results'), { recursive: true });
  const oldReport = 'TAP version 13\n1..1\nok 1 - historical unrelated execution\n';
  await writeFile(path.join(root, '.sflow/results/required.tap'), oldReport);
  const value = { root, remote, config, workflow, artifact, baseCommit, oldReport, runtimeTarget };
  value.reload = async () => {
    const loaded = await loadAcceptedStoryExecution(root, workId);
    value.config = loaded.config; value.workflow = loaded.workflow;
  };
  const authorship = buildGenerationAuthorship({ options: normalizeAuthorshipOptions({ producer: 'human',
    channel: 'manual-in-place', externalAiUse: 'none' }), actor: author, governedAgentContext: 'developer', source: null });
  value.publish = () => invoke(root, async () => {
    const current = value.workflow.phases.implementation;
    await scanArtifacts(root, value.config, value.workflow, current.id);
    const payload = await generationStartPublicationBinding(root, value.workflow, current);
    return commitAndPublish(root, value.config, value.workflow, { type: 'artifact-generated', phaseId: current.id,
      generation: current.generation + 1, payload }, 'Publish with the explicitly reviewed unavailable validation',
    current.artifacts.map(entry => entry.path), { beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, value.config, value.workflow,
      { phaseId: current.id, authorship, persist: false, publicationTransaction: { publicationEvent,
        transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead } }) });
  });
  return value;
}

async function terminalReview(value, method, options, label) {
  const code = `
    import {loadAcceptedStoryExecution} from ${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)};
    import * as risk from ${JSON.stringify(new URL('../src/story-test-risk.mjs', import.meta.url).href)};
    import {withOperationContext} from ${JSON.stringify(new URL('../src/operation-context.mjs', import.meta.url).href)};
    const root=${JSON.stringify(value.root)};
    try { const {config,workflow}=await loadAcceptedStoryExecution(root,${JSON.stringify(workId)});
      const result=await withOperationContext({root,command:'test',operation:{id:'test.story-risk',command:'test',modelPolicy:'never'},modelMode:{enabled:false,source:'test'}},
        ()=>risk[${JSON.stringify(method)}](root,config,workflow,${JSON.stringify(options)}));
      console.log('TRP_LIFECYCLE_RESULT:'+JSON.stringify({ok:true,result}));
    } catch(error) {console.log('TRP_LIFECYCLE_RESULT:'+JSON.stringify({ok:false,code:error.code,message:error.message,stack:error.stack}));}
  `;
  const script = `set timeout 40
    log_user 1
    set runner $env(SF_RISK_NODE)
    set code $env(SF_RISK_CODE)
    unset env(SF_RISK_NODE)
    unset env(SF_RISK_CODE)
    spawn -noecho $runner --input-type=module -e $code
    expect {
      "Type ${label} to confirm this exact action, or Enter to cancel:" {send -- "${label}\\r"; exp_continue}
      timeout {exit 124}
      eof {}
    }
    catch wait result
    exit [lindex $result 3]`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const output = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: value.root,
      env: { ...env, SF_RISK_NODE: process.execPath, SF_RISK_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let transcript = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(transcript.slice(-6000))); }, 45_000);
    child.stdout.on('data', bytes => { transcript += bytes; }); child.stderr.on('data', bytes => { transcript += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, transcript }); });
  });
  assert.equal(output.status, 0, output.transcript.slice(-6000));
  const matched = output.transcript.match(/TRP_LIFECYCLE_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(matched, output.transcript.slice(-6000));
  return JSON.parse(matched[1]);
}

async function authorizeAgreement(value) {
  setActor(value.root, riskReviewer);
  const preview = await attestStoryTestRisk(value.root, value.config, value.workflow, {});
  assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
  const result = await terminalReview(value, 'attestStoryTestRisk', { apply: true, confirmation: preview.planDigest }, 'Re-attest Story test risk');
  assert.equal(result.ok, true, result.stack ?? result.message);
  await value.reload();
}

async function riskPlan(value, operation, extra = {}) {
  const inspected = await planStoryTestRisk(value.root, value.config, value.workflow, { ...terms, ...extra, operation });
  const issue = inspected.issues.find(entry => entry.category === 'validation-unavailable' && entry.riskEligible);
  assert.ok(issue, JSON.stringify(inspected));
  const options = { ...terms, ...extra, operation, issueId: issue.id };
  const plan = await planStoryTestRisk(value.root, value.config, value.workflow, options);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  return { plan, options };
}

async function acceptRisk(value, operation, extra = {}) {
  setActor(value.root, riskReviewer);
  const { plan, options } = await riskPlan(value, operation, extra);
  const result = await terminalReview(value, 'acceptStoryTestRisk', { ...options, confirmation: plan.planDigest }, 'Accept Story test risk');
  assert.equal(result.ok, true, result.stack ?? result.message);
  assert.equal(result.result.status, 'accepted');
  await value.reload();
  return result.result;
}

async function submit(value) {
  return invoke(value.root, () => commitAndPublish(value.root, value.config, value.workflow,
    { type: 'approval-requested', phaseId: 'implementation', generation: value.workflow.phases.implementation.generation },
    'Request independent review of explicitly unverified tests', [], { beforeStateWrite: async () => {
      const phase = await submitPhase(value.root, value.config, value.workflow, { phaseId: 'implementation', actor: author, agent: 'developer', persist: false });
      await createStoryReviewPacket(value.root, value.config, value.workflow, phase);
    } }));
}

function detachedReviewMutation(value, reviewedCommit, relative, contents) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(path.dirname(value.root), 'adversarial-review-index') };
  const isolatedGit = (argv, input) => execFileSync('git', argv, { cwd: value.root, env, input, encoding: 'utf8' }).trim();
  isolatedGit(['read-tree', reviewedCommit]);
  const blob = isolatedGit(['hash-object', '-w', '--stdin'], contents);
  isolatedGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${relative}`]);
  const tree = isolatedGit(['write-tree']);
  return isolatedGit(['commit-tree', tree, '-p', git(value.root, 'rev-parse', `${reviewedCommit}^`)],
    git(value.root, 'show', '-s', '--format=%B', reviewedCommit));
}

test('actual unavailable runner stays unverified through independent approval, downstream preparation and explicit receipt replay',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const value = await fixture(t, { downstream: true });
    const source = await readFile(path.join(value.root, 'src/service.mjs'), 'utf8');
    await assert.rejects(value.publish(), { code: 'TRP_PHASE_GATE_BLOCKED' });
    await value.reload();
    assert.equal(value.workflow.phases.implementation.generation, 0);
    assert.equal(await readFile(path.join(value.root, '.sflow/results/required.tap'), 'utf8'), value.oldReport);
    await authorizeAgreement(value);
    await assert.rejects(loadStoryTestRiskContext(value.root, value.config, value.workflow,
      { repositoryId: 'different-repository', operation: 'publish' }), { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' });
    const initial = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
    assert.equal(initial.observations.length, 1);
    const observation = initial.observations[0];
    assert.equal(observation.observedOutcome, 'unavailable');
    assert.equal(observation.processExitCode, null);
    assert.equal(observation.identityCompleteness, 'incomplete');
    assert.deepEqual(observation.cases, []); assert.deepEqual(observation.reportSha256s, []);
    await acceptRisk(value, 'publish');
    await value.publish(); await value.reload();
    assert.equal(value.workflow.phases.implementation.generation, 1);
    assert.equal(value.workflow.phases.implementation.status, 'in_progress');
    assert.equal(value.workflow.phases.implementation.approvals.length, 0);
    await assert.rejects(submit(value), { code: 'TRP_PHASE_GATE_BLOCKED' }, 'publish permission must not imply submit permission');
    await value.reload();
    await acceptRisk(value, 'submit');
    await submit(value); await value.reload();
    assert.equal(value.workflow.phases.implementation.status, 'awaiting_approval');
    const current = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'submit' });
    assert.equal(current.observations[0].recordSha256, observation.recordSha256, 'no implicit runner retry or replacement observation');
    assert.equal(current.evaluation.dispositions[0].observedOutcome, 'unavailable');
    assert.equal(current.evaluation.dispositions[0].disposition, 'accepted-risk');
    assert.equal(current.evaluation.normalApprovalRequired, true);
    await assert.rejects(invoke(value.root, () => approvePhase(value.root, value.config, value.workflow,
      { phaseId: 'implementation', actor: phaseReviewer, agent: null, persist: false })),
    { code: 'TRP_PHASE_GATE_BLOCKED' }, 'submit permission must not imply approve permission');
    await acceptRisk(value, 'approve');
    const reviewedCommit = git(value.root, 'rev-parse', 'HEAD');
    const realIndexTree = git(value.root, 'write-tree');
    const approvalContext = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'approve' });
    const allowed = await verifiedStoryTestRiskReviewCommits(value.root, value.config, value.workflow, approvalContext, [reviewedCommit]);
    assert.ok(allowed.has(reviewedCommit), 'the exact authenticated risk-only review commit is admissible');
    const workflowPath = `${value.config.workItemRoot}/${workId}/workflow.json`;
    const changedWorkflow = JSON.parse(git(value.root, 'show', `${reviewedCommit}:${workflowPath}`));
    changedWorkflow.phases.implementation.generation += 1;
    const forgeries = [
      detachedReviewMutation(value, reviewedCommit, 'src/unreviewed-product-change.mjs', 'export const unreviewed = true;\n'),
      detachedReviewMutation(value, reviewedCommit, workflowPath, JSON.stringify(changedWorkflow))
    ];
    for (const forged of forgeries) {
      assert.equal(governedCommitIdentity(value.root, forged).eventSha256,
        governedCommitIdentity(value.root, reviewedCommit).eventSha256, 'the adversarial commit retains the genuine event binding');
      const rejected = await verifiedStoryTestRiskReviewCommits(value.root, value.config, value.workflow, approvalContext, [forged]);
      assert.equal(rejected.size, 0, 'a genuine risk event cannot authorize unrelated source or semantic workflow changes');
    }
    assert.equal(git(value.root, 'rev-parse', 'HEAD'), reviewedCommit);
    assert.equal(git(value.root, 'write-tree'), realIndexTree, 'detached adversarial fixtures do not change the real index');
    setActor(value.root, phaseReviewer);
    await invoke(value.root, () => commitAndPublish(value.root, value.config, value.workflow,
      { type: 'phase-approved', phaseId: 'implementation', generation: 1, actor: phaseReviewer, agent: null,
        authorityGroup: 'engineering-reviewers' }, 'Approve current generation while retaining the unavailable validation risk', [], {
        beforeStateWrite: () => approvePhase(value.root, value.config, value.workflow,
          { phaseId: 'implementation', actor: phaseReviewer, agent: null, persist: false })
      })).catch(error => {
        t.diagnostic(git(value.root, 'diff', 'HEAD^', 'HEAD', '--',
          `${value.config.workItemRoot}/${workId}/workflow.json`));
        t.diagnostic(git(value.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'));
        throw error;
      });
    await value.reload();
    assert.equal(value.workflow.phases.implementation.status, 'approved');
    assert.equal(value.workflow.currentPhase, 'testing');
    const latest = value.workflow.lineage.submissions.at(-1);
    const packet = await readStoryReviewPacket(value.root, value.config, value.workflow, latest.packetSha256);
    const receiptPath = packet.submissionEvidence.codeDelivery.path;
    const receipt = JSON.parse(git(value.root, 'show', `${packet.evidenceCommit}:${receiptPath}`));
    const replayOptions = { configurationSource: value.workflow.resolution.configurationSource,
      evidenceCommit: packet.evidenceCommit, testRecovery: { config: value.config, workflow: value.workflow, operation: 'replay' } };
    const unacceptedReplay = await verifyCodeDeliveryReceipt(value.root, receipt, replayOptions);
    assert.equal(unacceptedReplay.valid, false, 'approval does not implicitly authorize direct replay');
    assert.ok(unacceptedReplay.errors.some(message => /TRP unavailable validation/u.test(message)), JSON.stringify(unacceptedReplay));
    await acceptRisk(value, 'replay');
    const replayed = await verifyCodeDeliveryReceipt(value.root, receipt,
      { ...replayOptions, testRecovery: { config: value.config, workflow: value.workflow, operation: 'replay' } });
    assert.equal(replayed.valid, true, JSON.stringify(replayed.errors));
    assert.equal(replayed.executions[0].status, 'unavailable');
    assert.equal(replayed.executions[0].disposition, 'accepted-risk');
    await assert.rejects(invoke(value.root, () => preparePhaseInputs(value.root, value.config, value.workflow, 'testing')),
      { code: 'TRP_PHASE_GATE_BLOCKED' }, 'approval and replay permissions do not authorize downstream preparation');
    await acceptRisk(value, 'downstream');
    const prepared = await invoke(value.root, () => preparePhaseInputs(value.root, value.config, value.workflow, 'testing'));
    assert.equal(prepared.phase.id, 'testing');
    const clone = path.join(path.dirname(value.root), 'independent-checkout');
    git(path.dirname(value.root), 'clone', '-q', '--no-local', '--branch', workId, value.root, clone);
    const copied = await loadAcceptedStoryExecution(clone, workId);
    const copiedContext = await loadStoryTestRiskContext(clone, copied.config, copied.workflow,
      { phaseId: 'implementation', operation: 'replay' });
    assert.equal(copiedContext.observations[0].recordSha256, observation.recordSha256,
      'the copied durable observation remains readable history');
    assert.equal(copiedContext.verifyEvidence(copiedContext.observations[0]), null,
      'copying Git records does not transfer private execution origin to another checkout');
    assert.equal(copiedContext.evaluation.gateDecision, 'block');
    assert.equal(await readFile(path.join(value.root, 'src/service.mjs'), 'utf8'), source);
    assert.equal(await readFile(path.join(value.root, '.sflow/results/required.tap'), 'utf8'), value.oldReport);
  });

test('a real failing test cannot be accepted as an unavailable test runtime', async t => {
  const value = await fixture(t, { unavailable: false });
  await assert.rejects(value.publish());
  await value.reload();
  const context = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
  assert.equal(context.observations.length, 0, 'exit-one assertions are not infrastructure-unavailable observations');
  const result = await planStoryTestRisk(value.root, value.config, value.workflow, { ...terms, operation: 'publish' });
  assert.equal(result.ready, false);
  assert.equal(value.workflow.phases.implementation.generation, 0);
});

test('public capture calls cannot authenticate a fabricated launch failure', async t => {
  const value = await fixture(t);
  await assert.rejects(value.publish());
  await value.reload();
  const context = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
  assert.equal(context.observations.length, 1, 'one real unavailable launch was retained');
  const phase = value.workflow.phases.implementation;
  const commands = normalizeTrpDeliveryCommands(value.workflow, phase, phase.qualityCommands);
  const run = await beginStoryTestRiskRun(value.root, value.config, value.workflow, phase,
    { commands, selection: context.selection });
  const result = await captureStoryTestRiskObservation(value.root, value.config, value.workflow, phase, {
    run, check: { id: '.-python-tests', status: 'blocked', exitCode: null, infrastructureUnavailable: true,
      timedOut: false, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), stderr: 'fabricated ENOENT' },
    result: { status: 'blocked', exitCode: null, infrastructureUnavailable: true, timedOut: false }
  });
  assert.equal(result, null, 'plain objects and a public begin token cannot mint runner origin proof');
  const second = await beginStoryTestRiskRun(value.root, value.config, value.workflow, phase,
    { commands, selection: context.selection });
  const unrelatedCommand = path.join(value.root, 'unrelated-missing-runtime');
  const actualUnrelatedLaunch = await runQualityCommand(unrelatedCommand, [], { cwd: second.cwd });
  await assert.rejects(captureStoryTestRiskObservation(value.root, value.config, value.workflow, phase, {
    run: { ...second, command: unrelatedCommand, args: [] },
    check: { id: '.-python-tests', status: 'blocked', exitCode: null, infrastructureUnavailable: true,
      timedOut: false, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), stderr: 'unrelated command ENOENT' },
    result: actualUnrelatedLaunch
  }), { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' },
  'mutating public run fields cannot relabel an unrelated native launch as the approved command');
  const third = await beginStoryTestRiskRun(value.root, value.config, value.workflow, phase,
    { commands, selection: context.selection });
  const changedEnvironment = { ...process.env, SF_TRP_CHILD_ENVIRONMENT: 'not-the-reviewed-environment' };
  delete changedEnvironment.NODE_TEST_CONTEXT;
  const changedLaunch = await runQualityCommand(third.command, third.args, { cwd: third.cwd, env: changedEnvironment });
  assert.equal(await captureStoryTestRiskObservation(value.root, value.config, value.workflow, phase, {
    run: third, check: { id: '.-python-tests', status: 'blocked', exitCode: null, infrastructureUnavailable: true,
      timedOut: false, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), stderr: 'different child environment ENOENT' },
    result: changedLaunch
  }), null, 'a genuine child launch with different environment cannot authenticate the reviewed environment');
  await assert.rejects(beginStoryTestRiskRun(value.root, value.config, value.workflow, phase, {
    commands: commands.map(command => ({ ...command, argv: [unrelatedCommand] })),
    selection: context.selection
  }), { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' },
  'the public begin API cannot replace the approved executable while retaining its suite ID and selection digest');
  const after = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
  assert.deepEqual(after.observations.map(item => item.recordSha256), context.observations.map(item => item.recordSha256));
});

test('risk previews require delegated live review and cannot accept changed runner evidence',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const value = await fixture(t);
    await assert.rejects(value.publish()); await value.reload();
    await authorizeAgreement(value);
    await assert.rejects(planStoryTestRisk(value.root, value.config, value.workflow,
      { ...terms, repositoryId: 'wrong-repository', operation: 'publish' }),
    { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' }, 'an explicit unknown repository cannot silently select the only known repository');
    const { plan, options } = await riskPlan(value, 'publish');
    const initialHead = git(value.root, 'rev-parse', 'HEAD');
    setActor(value.root, phaseReviewer);
    await assert.rejects(acceptStoryTestRisk(value.root, value.config, value.workflow,
      { ...options, confirmation: plan.planDigest }), /authority|authorized|member|delegat/iu,
    'ordinary phase approval authority is not risk authority');
    setActor(value.root, riskReviewer);
    await assert.rejects(acceptStoryTestRisk(value.root, value.config, value.workflow,
      { ...options, confirmation: plan.planDigest }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
    const changedEnvironment = 'PATH';
    const previous = process.env[changedEnvironment];
    process.env[changedEnvironment] = `${previous ?? ''}${path.delimiter}${path.join(value.root, 'different-runner-directory')}`;
    try {
      await assert.rejects(assertStoryTestRiskGate(value.root, value.config, value.workflow,
        { operation: 'publish' }), { code: 'TRP_PHASE_GATE_BLOCKED' });
      await assert.rejects(acceptStoryTestRisk(value.root, value.config, value.workflow,
        { ...options, confirmation: plan.planDigest }), error =>
        ['TRP_RISK_REVIEW_STALE', 'TRP_RISK_NOT_ELIGIBLE'].includes(error.code));
    } finally {
      if (previous === undefined) delete process.env[changedEnvironment]; else process.env[changedEnvironment] = previous;
    }
    assert.equal(git(value.root, 'rev-parse', 'HEAD'), initialHead, 'refusals do not commit a decision');
    const current = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
    assert.equal(current.decisions.length, 0);
    assert.equal(value.workflow.phases.implementation.generation, 0);
  });

test('a separately confirmed revocation blocks the exact unavailable transition without changing its observation',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const value = await fixture(t);
    await assert.rejects(value.publish()); await value.reload();
    await authorizeAgreement(value);
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const accepted = await acceptRisk(value, 'publish', { expiresAt });
    const before = await assertStoryTestRiskGate(value.root, value.config, value.workflow, { operation: 'publish' });
    assert.equal(before.evaluation.gateDecision, 'allow-with-risk');
    await assert.rejects(assertStoryTestRiskGate(value.root, value.config, value.workflow,
      { operation: 'publish', at: new Date(Date.parse(expiresAt) + 1).toISOString() }),
    { code: 'TRP_PHASE_GATE_BLOCKED' }, 'the explicit expiry applies independently of report freshness');
    const options = { recordSha256: accepted.record.recordSha256,
      reason: 'The remediation owner withdrew authorization before publication; retain the unavailable execution as unverified.' };
    const preview = await revokeStoryTestRisk(value.root, value.config, value.workflow, options);
    assert.equal(preview.ready, true);
    const result = await terminalReview(value, 'revokeStoryTestRisk',
      { ...options, apply: true, confirmation: preview.planDigest }, 'Revoke Story test risk');
    assert.equal(result.ok, true, result.stack ?? result.message);
    await value.reload();
    await assert.rejects(assertStoryTestRiskGate(value.root, value.config, value.workflow,
      { operation: 'publish' }), { code: 'TRP_PHASE_GATE_BLOCKED' });
    const after = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
    assert.equal(after.observations[0].recordSha256, before.observations[0].recordSha256);
    assert.equal(after.observations[0].observedOutcome, 'unavailable');
    assert.equal(value.workflow.phases.implementation.generation, 0);
  });

test('installing an existing executable symlink target invalidates retained unavailable evidence',
  { skip: !TRP_TERMINAL_AVAILABLE || process.platform === 'win32' }, async t => {
    const value = await fixture(t, { danglingRuntime: true });
    await assert.rejects(value.publish()); await value.reload();
    await authorizeAgreement(value); await acceptRisk(value, 'publish');
    const before = await assertStoryTestRiskGate(value.root, value.config, value.workflow, { operation: 'publish' });
    assert.equal(before.evaluation.gateDecision, 'allow-with-risk');
    await writeFile(value.runtimeTarget, '#!/bin/sh\nexit 0\n'); await chmod(value.runtimeTarget, 0o755);
    const after = await loadStoryTestRiskContext(value.root, value.config, value.workflow, { operation: 'publish' });
    assert.equal(after.candidate.sourceManifestSha256, before.candidate.sourceManifestSha256,
      'installing a runtime outside the repository does not alter the candidate source');
    assert.equal(after.observations[0].recordSha256, before.observations[0].recordSha256);
    assert.equal(after.evaluation.gateDecision, 'block', 'the executable target changed even though the symlink itself did not');
    assert.equal(value.workflow.phases.implementation.generation, 0);
  });
