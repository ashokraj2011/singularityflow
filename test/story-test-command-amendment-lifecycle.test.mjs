import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { applyCapabilityPolicyToWorkResolution, resolveLifecycleCapability } from '../src/capability-context.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, materializeConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { authoredArtifactText } from '../src/publication-preflight.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { withConfirmationPort } from '../src/sequence.mjs';
import { setAgentSession } from '../src/session.mjs';
import { approvePhase, commitAndPublish, createWorkflow, publishGeneration, scanArtifacts, submitPhase, workDir } from '../src/state.mjs';
import { createStoryReviewPacket } from '../src/story-lineage.mjs';
import { previewTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { previewStoryTestCommandAmendment, verifyAcceptedTestCommandAmendment } from '../src/story-test-command-amendment.mjs';
import { inspectWorkflowTestCommandReviews, verifyWorkflowSnapshot } from '../src/workflow-snapshots.mjs';
import { TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const author = { name: 'Command Author', email: 'command.author@example.com', login: null };
const reviewer = { name: 'Command Reviewer', email: 'command.reviewer@example.com', login: null };
const reason = 'The approved command fixes the missing test path while retaining the test adapter, thresholds and generated implementation.';
const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const git = (root, ...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const context = (root, invoke) => withOperationContext({ root, command: 'test',
  operation: { id: 'test.test-command-amendment', command: 'test', modelPolicy: 'never' },
  modelMode: { enabled: false, source: 'test' } }, invoke);
const authorship = buildGenerationAuthorship({ options: normalizeAuthorshipOptions({ producer: 'human',
  channel: 'manual-in-place', externalAiUse: 'none' }), actor: author, governedAgentContext: 'developer', source: null });

function setActor(root, actor) {
  git(root, 'config', 'user.name', actor.name); git(root, 'config', 'user.email', actor.email);
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = actor.name;
}

async function fixture(t, { oldCommandWorks = false, testRecovery = true, noExplicitTestCommand = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-command-amendment-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'application'); const remote = path.join(base, 'remote.git');
  const publisher = path.join(base, 'publisher');
  await mkdir(root);
  const environment = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: author.name,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(base, 'configuration-cache') };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  git(root, 'init', '-q', '-b', 'main'); setActor(root, author);
  await initializeDefinition(root);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'command-amendment', version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap test/*.test.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'command-amendment', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name: 'command-amendment', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/generated.test.mjs'), "import test from 'node:test'; test('baseline', () => {});\n");
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.approvalSecurity = { profile: 'team', allowSelfApproval: false, autoEnrollNewIdentities: false };
  definition.approvalAuthorities['engineering-reviewers'] = { label: 'Engineering reviewers', allowAnyGitIdentity: false,
    members: [{ name: reviewer.name, email: reviewer.email, githubLogin: null }] };
  if (testRecovery) definition.testRecovery = { enabled: true, riskAuthorities: ['engineering-reviewers'] };
  else delete definition.testRecovery;
  definition.workTypes.feature = { label: 'Feature', phases: ['implementation'], 
    omits: ['scope', 'plan', 'review'].map((responsibility) => ({ responsibility, reason: 'Isolated command amendment fixture with no specification, plan or review step.', authority: 'engineering-reviewers' })),
    spec: { acceptance: 'off' } };
  const phase = definition.phases.implementation;
  phase.inputs = []; phase.clarification = { mode: 'off' };
  const initialTestCommand = { id: 'node-tests', kind: 'test',
    argv: [process.execPath, '--test', '--test-reporter=tap', oldCommandWorks ? 'test/generated.test.mjs' : 'test/missing.test.mjs'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'node-tap', path: '.sflow/results/generated.tap', minimumDiscovered: 1, minimumPassed: 1 } };
  phase.qualityCommands = noExplicitTestCommand ? [] : [initialTestCommand];
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Application and approved initial policy');
  git(base, 'clone', '-q', '--bare', root, remote); git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`);
  git(base, 'clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher);
  git(publisher, 'config', 'user.name', 'Configuration Publisher');
  git(publisher, 'config', 'user.email', 'configuration.publisher@example.invalid');
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  await materializeConfigurationSnapshot(root, { snapshot: approved });
  git(root, 'add', 'singularity'); git(root, 'commit', '-qm', 'Materialize exact approved configuration');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const readinessPlan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  assert.deepEqual(readinessPlan.blockers, []);
  await executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: readinessPlan.planId });
  const repositoryReadiness = await collectRepositoryReadinessEvidence([{ id: 'application', root, baseCommit }], { scope: 'dependency-test' });
  assert.equal(repositoryReadiness.repositories.application.status, 'pass');
  const config = await loadDefinition(root);
  const resolved = resolveWorkType(config, 'feature');
  const readinessRepositories = [{ id: 'application', baseCommit, baseBranch: 'main' }];
  const testRecoveryPlan = previewTestRecoveryIntake({ definition: config, workId: 'COMMAND-FIX-1', workType: 'feature',
    repositories: readinessRepositories, repositoryReadiness,
    choices: { baselineDisposition: 'fix', executionMode: 'all-configured', baselineScope: 'reuse' },
    phaseDefinitions: applyCapabilityPolicyToWorkResolution(resolved, await resolveLifecycleCapability(root)).phases });
  if (testRecovery) assert.equal(testRecoveryPlan.ready, true);
  git(root, 'switch', '-q', '-c', 'COMMAND-FIX-1');
  await setAgentSession(root, config, author, 'developer', 'COMMAND-FIX-1', { phaseId: 'implementation', source: 'test' });
  const workflow = await context(root, () => createWorkflow(root, config, { id: 'COMMAND-FIX-1', title: 'Preserve generated feature through command repair',
    source: { type: 'manual', key: 'COMMAND-FIX-1', title: 'Preserve generated feature through command repair',
      description: 'Correct a pinned test invocation without discarding authored source or lowering verification.',
      acceptanceCriteria: ['The generated feature passes the corrected structured test command.'] },
    baseBranch: 'main', baseCommit, workType: 'feature', agent: 'developer', resolved,
    readinessRepositories, repositoryReadiness, testRecoveryPlan: testRecovery ? testRecoveryPlan : null,
    approvedConfigurationSnapshot: approved }));
  await context(root, () => commitAndPublish(root, config, workflow, { type: 'binding' }, 'Bind Story under original approved command'));
  assert.equal(workflow.phases.implementation.generation, 0);
  assert.equal(workflow.phases.implementation.generationIntent.status, 'open');
  const artifact = path.join(workDir(root, config, workflow.workItem.id), workflow.phases.implementation.requiredArtifact.path);
  await writeFile(artifact, ['# Implementation', '', 'Implemented the requested service value and the generated test that verifies it.', '',
    '## Delivery evidence', '', 'The generated test imports the actual service and checks the requested value. A corrected structured command must run this existing test before publication; the command amendment itself must not execute it.', '',
    '## Residual risk', '', 'This fixture claims only the configured Node test inventory. Its original baseline, generation intent and authored implementation remain unchanged during policy amendment.', ''].join('\n'));
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 2;\n');
  await writeFile(path.join(root, 'test/generated.test.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/service.mjs';",
    "import {mkdirSync,appendFileSync} from 'node:fs';",
    "test('generated feature',()=>{ mkdirSync('.sflow/results',{recursive:true}); appendFileSync('.sflow/results/corrected-runner-ran','ran\\n'); assert.equal(value,2); });", ''
  ].join('\n'));
  if (noExplicitTestCommand) {
    // This application has a real custom launcher, but no supported inference
    // contract. The correction must adopt an explicit runner rather than claim
    // that the unknown wrapper's output is already verified test evidence.
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts/run-suite.mjs'), "import '../test/generated.test.mjs';\n");
    await writeFile(path.join(root, 'test/service-contract.test.ts'), [
      "const test = require('node:test'); const assert = require('node:assert/strict');",
      "test('generated value supports the consumer contract', async () => { const {value} = await import('../src/service.mjs'); assert.equal(value * 2, 4); });", ''
    ].join('\n'));
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    manifest.scripts.test = 'node scripts/run-suite.mjs';
    await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    git(root, 'add', 'package.json', 'scripts/run-suite.mjs', 'test/service-contract.test.ts');
  }
  git(root, 'add', 'src/service.mjs', 'test/generated.test.mjs');
  git(root, 'commit', '-qm', 'Preserve generated application source and tests before policy review');
  const value = { root, remote, publisher, config, workflow, artifact, baseCommit,
    marker: path.join(root, '.sflow/results/corrected-runner-ran') };
  value.candidate = async (change = null) => {
    const file = path.join(publisher, 'singularity/workflow.yml');
    const next = YAML.parse(await readFile(file, 'utf8'));
    if (!next.phases.implementation.qualityCommands.length) next.phases.implementation.qualityCommands = [structuredClone(initialTestCommand)];
    next.phases.implementation.qualityCommands[0].argv = [process.execPath, '--test', '--test-reporter=tap', 'test/generated.test.mjs'];
    if (noExplicitTestCommand) next.phases.implementation.qualityCommands[0].argv.push('test/service-contract.test.ts');
    if (change) change(next);
    await writeFile(file, YAML.stringify(next)); git(publisher, 'add', 'singularity/workflow.yml');
    git(publisher, 'commit', '-qm', 'Approve bounded test-command correction'); git(publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
    return loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  };
  value.reload = async () => {
    const loaded = await loadAcceptedStoryExecution(root, 'COMMAND-FIX-1').catch(error => {
      const relative = path.relative(root, path.join(workDir(root, config, 'COMMAND-FIX-1'), 'workflow.json'));
      const priorPhase = JSON.parse(git(root, 'show', `HEAD^:${relative}`)).phases.implementation;
      const currentPhase = JSON.parse(git(root, 'show', `HEAD:${relative}`)).phases.implementation;
      const changed = [...new Set([...Object.keys(priorPhase), ...Object.keys(currentPhase)])]
        .filter(key => JSON.stringify(priorPhase[key]) !== JSON.stringify(currentPhase[key]));
      error.message += `\nAccepted phase fields changed from parent: ${changed.join(', ')}`;
      throw error;
    });
    value.config = loaded.config; value.workflow = loaded.workflow;
    return loaded;
  };
  value.publish = () => context(root, async () => {
    const current = value.workflow.phases.implementation;
    await scanArtifacts(root, value.config, value.workflow, current.id);
    const payload = await generationStartPublicationBinding(root, value.workflow, current);
    return commitAndPublish(root, value.config, value.workflow, { type: 'artifact-generated', phaseId: current.id,
      generation: current.generation + 1, payload }, 'Publish generated feature with corrected runner', current.artifacts.map(entry => entry.path), {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, value.config, value.workflow,
        { phaseId: current.id, authorship, persist: false, publicationTransaction: { publicationEvent,
          transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead } })
    });
  });
  setActor(root, reviewer);
  return value;
}

async function preserved(value) {
  const { root, config, workflow } = value;
  const accepted = await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true, retainBytes: true });
  const intent = workflow.phases.implementation.generationIntent;
  return { head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'),
    source: await readFile(path.join(root, 'src/service.mjs'), 'utf8'),
    test: await readFile(path.join(root, 'test/generated.test.mjs'), 'utf8'), draft: await readFile(value.artifact, 'utf8'),
    intent: structuredClone(intent), intentBytes: await readFile(path.join(root, intent.path), 'utf8'),
    baseCommit: workflow.workItem.baseCommit, intervalBase: workflow.workIntervals.current.sourceBaseCommit,
    intervalPath: workflow.workIntervals.current.path,
    intervalBytes: await readFile(path.join(root, workflow.workIntervals.current.path), 'utf8'),
    snapshot: structuredClone(workflow.workflowSnapshot), policy: structuredClone(accepted.policy),
    manifestBytes: await readFile(path.join(root, workflow.workflowSnapshot.manifestPath), 'utf8'),
    workflow: await readFile(path.join(workDir(root, config, workflow.workItem.id), 'workflow.json'), 'utf8') };
}

async function confirmInTerminal(value, planSha256, candidate, { reviewReason = reason } = {}) {
  const code = `
    import {loadAcceptedStoryExecution} from ${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)};
    import {loadStoryConfigurationSnapshot,CONFIGURATION_BRANCH} from ${JSON.stringify(new URL('../src/configuration-branch.mjs', import.meta.url).href)};
    import {applyStoryTestCommandAmendment} from ${JSON.stringify(new URL('../src/story-test-command-amendment.mjs', import.meta.url).href)};
    import {withOperationContext} from ${JSON.stringify(new URL('../src/operation-context.mjs', import.meta.url).href)};
    const root=${JSON.stringify(value.root)};
    try {
      const {config,workflow}=await loadAcceptedStoryExecution(root,'COMMAND-FIX-1');
      const approvedConfigurationSnapshot=await loadStoryConfigurationSnapshot({remote:${JSON.stringify(value.remote)},branch:CONFIGURATION_BRANCH,commit:${JSON.stringify(candidate.sourceCommit)}});
      const result=await withOperationContext({root,command:'test',operation:{id:'test.command-amendment',command:'test',modelPolicy:'never'},modelMode:{enabled:false,source:'test'}},
        ()=>applyStoryTestCommandAmendment(root,config,workflow,{approvedConfigurationSnapshot,reason:${JSON.stringify(reviewReason)},confirm:${JSON.stringify(planSha256)}}));
      console.log('COMMAND_AMENDMENT_RESULT:'+JSON.stringify({ok:true,status:result.status,applied:result.applied}));
    } catch(error) {console.log('COMMAND_AMENDMENT_RESULT:'+JSON.stringify({ok:false,code:error.code,message:error.message,stack:error.stack}));}
  `;
  return runInTerminal(value.root, code, 'Amend test command');
}

async function runInTerminal(root, code, label) {
  const script = `
    set timeout 40
    log_user 1
    spawn -noecho $env(SF_COMMAND_NODE) --input-type=module -e $env(SF_COMMAND_CODE)
    expect {
      "Type ${label} to confirm this exact action, or Enter to cancel:" { send -- "${label}\\r"; exp_continue }
      timeout {exit 124}
      eof {}
    }
    catch wait result
    exit [lindex $result 3]
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const output = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: root,
      env: { ...env, SF_COMMAND_NODE: process.execPath, SF_COMMAND_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let transcript = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Amendment PTY timed out: ${transcript.slice(-5000)}`)); }, 45000);
    child.stdout.on('data', bytes => { transcript += bytes; }); child.stderr.on('data', bytes => { transcript += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); status === 0 ? resolve(transcript) : reject(new Error(transcript.slice(-5000))); });
  });
  const match = output.match(/COMMAND_AMENDMENT_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(match, output.slice(-5000));
  return JSON.parse(match[1]);
}

async function reattestInTerminal(root, reviewSha256) {
  const code = `
    import {spawnSync} from 'node:child_process';
    const result=spawnSync(process.execPath,${JSON.stringify([cli, 'story', 'test-policy', 'attest', 'COMMAND-FIX-1', '--apply', '--confirm', reviewSha256, '--json'])},
      {cwd:${JSON.stringify(root)},stdio:'inherit',env:process.env});
    console.log('COMMAND_AMENDMENT_RESULT:'+JSON.stringify({ok:result.status===0,exitCode:result.status,error:result.error?.message}));
  `;
  return runInTerminal(root, code, 'Restore local test-command review');
}

async function assertCloneRecovery(value) {
  const root = path.join(path.dirname(value.root), 'second-checkout');
  git(path.dirname(value.root), 'clone', '-q', '--no-hardlinks', '-b', 'COMMAND-FIX-1', value.root, root);
  setActor(root, reviewer);
  const before = { head: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    workflow: await readFile(path.join(workDir(root, value.config, 'COMMAND-FIX-1'), 'workflow.json'), 'utf8') };
  assert.equal(git(root, 'status', '--porcelain'), '');
  await assert.rejects(loadAcceptedStoryExecution(root, 'COMMAND-FIX-1'), { code: 'TCA_AUTHORITY_ORIGIN_UNAVAILABLE' });
  const config = await loadDefinition(root);
  const inspection = await inspectWorkflowTestCommandReviews(root, config, 'COMMAND-FIX-1');
  assert.equal(inspection.reviews.length, 1);
  assert.equal(inspection.reviews[0].originPresent, false);
  assert.equal(inspection.reviews[0].review.actor.email, reviewer.email);
  assert.notDeepEqual(inspection.reviews[0].previousCommands, inspection.reviews[0].adoptedCommands);
  const preview = JSON.parse(execFileSync(process.execPath, [cli, 'story', 'test-policy', 'attest', 'COMMAND-FIX-1', '--json'],
    { cwd: root, encoding: 'utf8' })).data;
  assert.equal(preview.status, 'review-required'); assert.equal(preview.executed, false);
  assert.equal(preview.reviews[0].sha256, inspection.reviews[0].sha256);
  setActor(root, author);
  const rejected = await reattestInTerminal(root, inspection.reviews[0].sha256);
  assert.equal(rejected.ok, false);
  assert.notEqual(rejected.exitCode, 0);
  await assert.rejects(loadAcceptedStoryExecution(root, 'COMMAND-FIX-1'), { code: 'TCA_AUTHORITY_ORIGIN_UNAVAILABLE' });
  setActor(root, reviewer);
  const restored = await reattestInTerminal(root, inspection.reviews[0].sha256);
  assert.equal(restored.ok, true, restored.stack ?? restored.message);
  const accepted = await loadAcceptedStoryExecution(root, 'COMMAND-FIX-1');
  assert.equal(accepted.workflow.workflowSnapshot.snapshotHash, value.workflow.workflowSnapshot.snapshotHash);
  assert.equal((await inspectWorkflowTestCommandReviews(root, config, 'COMMAND-FIX-1')).reviews[0].originPresent, true);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), before.tree);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(workDir(root, config, 'COMMAND-FIX-1'), 'workflow.json'), 'utf8'), before.workflow);
  assert.equal(await readFile(path.join(root, 'src/service.mjs'), 'utf8'), await readFile(path.join(value.root, 'src/service.mjs'), 'utf8'));
  await assert.rejects(access(path.join(root, '.sflow/results/corrected-runner-ran')), { code: 'ENOENT' });
}

async function submitCurrent(value) {
  const generation = value.workflow.phases.implementation.generation;
  await context(value.root, () => commitAndPublish(value.root, value.config, value.workflow,
    { type: 'approval-requested', phaseId: 'implementation', generation }, 'Submit corrected generation for independent approval', [], {
      beforeStateWrite: async () => {
        const phase = await submitPhase(value.root, value.config, value.workflow, { phaseId: 'implementation',
          actor: author, agent: 'developer', persist: false });
        await createStoryReviewPacket(value.root, value.config, value.workflow, phase);
      }
    }));
  await value.reload();
}

async function approveCurrent(value) {
  const generation = value.workflow.phases.implementation.generation;
  await context(value.root, () => commitAndPublish(value.root, value.config, value.workflow,
    { type: 'phase-approved', phaseId: 'implementation', generation, actor: reviewer, agent: null,
      authorityGroup: 'engineering-reviewers' }, 'Approve exact corrected generation', [], {
      beforeStateWrite: () => approvePhase(value.root, value.config, value.workflow,
        { phaseId: 'implementation', actor: reviewer, agent: null, persist: false })
    }));
  await value.reload();
}

async function retainedValidationBytes(value) {
  const phase = value.workflow.phases.implementation;
  const evidence = phase.deliveryEvidence;
  const paths = new Set([
    evidence.receiptPath, evidence.changeSetPath, phase.testCommandValidation?.path,
    ...(evidence.testExecutions ?? []).map(entry => entry.receiptPath),
    ...(value.workflow.lineage.submissions ?? []).map(entry => entry.path)
  ].filter(Boolean));
  for (const execution of evidence.testExecutions ?? []) {
    const receipt = JSON.parse(await readFile(path.join(value.root, execution.receiptPath), 'utf8'));
    // Node TAP currently has no durable testcase-observation adapter. Where a
    // supported adapter supplies raw reports, preserve those bytes as well.
    for (const report of receipt.testcaseObservation?.rawReports ?? []) paths.add(report.path);
  }
  return new Map(await Promise.all([...paths].map(async relative => [relative,
    await readFile(path.join(value.root, relative))])));
}

async function assertRetainedValidationBytes(value, retained) {
  for (const [relative, bytes] of retained) assert.deepEqual(await readFile(path.join(value.root, relative)), bytes,
    `revalidation must not overwrite historical evidence: ${relative}`);
}

test('real dual-authority terminal amendment preserves generated work and publishes with the corrected runner',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
  const value = await fixture(t);
  await assert.rejects(value.publish(), error => /test|quality|command/iu.test(error.message),
    'the originally pinned broken runner must genuinely refuse publication');
  await value.reload();
  const before = await preserved(value);
  const candidate = await value.candidate();
  assert.notEqual(candidate.sourceCommit, before.policy.configurationSource.commit);
  const plan = await context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
    { approvedConfigurationSnapshot: candidate, reason }));
  assert.equal(plan.status, 'ready'); assert.equal(plan.executed, false);
  assert.equal(plan.from.validationEpoch, 1); assert.equal(plan.to.validationEpoch, 2);
  assert.deepEqual(before, await preserved(value));
  await assert.rejects(access(value.marker), { code: 'ENOENT' });
  const applied = await confirmInTerminal(value, plan.planSha256, candidate);
  assert.equal(applied.ok, true, applied.stack ?? applied.message);
  assert.equal(applied.status, 'applied'); assert.equal(applied.applied, true);
  await value.reload();
  for (const strip of [true, false]) {
    const tampered = structuredClone(value.workflow);
    if (strip) { delete tampered.testCommandAmendments; delete tampered.resolution.testRecoveryValidationEpoch; }
    else tampered.testRecovery.validationEpoch = 1;
    await assert.rejects(verifyAcceptedTestCommandAmendment(value.root, value.config, tampered), { code: 'TCA_AMENDMENT_STALE' });
  }
  const after = await preserved(value);
  for (const field of ['source', 'test', 'draft', 'intent', 'intentBytes', 'baseCommit', 'intervalBase']) {
    assert.deepEqual(after[field], before[field], `amendment must preserve ${field}`);
  }
  assert.equal(await readFile(path.join(value.root, before.intervalPath), 'utf8'), before.intervalBytes,
    'the old interval baseline is append-only evidence');
  assert.equal(await readFile(path.join(value.root, before.snapshot.manifestPath), 'utf8'), before.manifestBytes,
    'the accepted original workflow manifest remains byte-identical');
  assert.notEqual(after.intervalPath, before.intervalPath, 'new command qualification uses a distinct interval record');
  assert.equal(after.snapshot.revision, before.snapshot.revision + 1);
  assert.equal(value.workflow.phases.implementation.generation, 0);
  assert.equal(value.workflow.resolution.testRecoveryValidationEpoch, 2);
  assert.equal(value.workflow.testRecovery.validationEpoch, 2);
  assert.equal(value.workflow.testCommandAmendments.length, 1);
  assert.equal(value.workflow.testCommandAmendments[0].from.snapshotHash, before.snapshot.snapshotHash);
  await assert.rejects(access(value.marker), { code: 'ENOENT' });
  const committed = git(value.root, 'show', '--pretty=format:', '--name-only', 'HEAD').split('\n').filter(Boolean);
  assert.ok(committed.every(file => !file.startsWith('src/') && !file.startsWith('test/')),
    `policy transaction must not stage application paths: ${committed.join(', ')}`);
  await value.publish();
  assert.equal(value.workflow.phases.implementation.generation, 1);
  assert.equal(await readFile(value.marker, 'utf8'), 'ran\n', 'normal publication executes the real corrected runner exactly once');
  assert.equal(value.workflow.workItem.baseCommit, before.baseCommit);
  assert.equal(await readFile(path.join(value.root, 'src/service.mjs'), 'utf8'), before.source);
  assert.equal(authoredArtifactText(await readFile(value.artifact, 'utf8')).trim(), authoredArtifactText(before.draft).trim(),
    'ordinary publication may update only its managed metadata envelope');
  await verifyWorkflowSnapshot(value.root, value.config, value.workflow, { requireAccepted: true });
  await assertCloneRecovery(value);
  await submitCurrent(value);
  assert.equal(value.workflow.phases.implementation.status, 'awaiting_approval');
  await approveCurrent(value);
  assert.equal(value.workflow.phases.implementation.status, 'approved');
  assert.equal(value.workflow.status, 'complete');
  assert.equal(value.workflow.testRecovery.validationEpoch, 2);
  assert.equal(await readFile(path.join(value.root, 'src/service.mjs'), 'utf8'), before.source);
});

test('stale exact amendment preview refuses without changing authored work or policy',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const value = await fixture(t); const candidate = await value.candidate();
    const plan = await context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
      { approvedConfigurationSnapshot: candidate, reason }));
    await writeFile(value.artifact, `${await readFile(value.artifact, 'utf8')}\nAdditional authored evidence after review.\n`);
    const before = await preserved(value);
    const result = await confirmInTerminal(value, plan.planSha256, candidate);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TCA_AMENDMENT_CONFIRMATION_REQUIRED');
    assert.deepEqual(await preserved(value), before);
    await assert.rejects(access(value.marker), { code: 'ENOENT' });
  });

test('an enrolled non-TRP Story can repair its command without opting into a test-recovery agreement',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const value = await fixture(t, { testRecovery: false });
    assert.equal(value.workflow.testRecovery, undefined);
    assert.equal(value.workflow.resolution.testRecovery, undefined);
    const before = await preserved(value);
    const candidate = await value.candidate();
    const plan = await context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
      { approvedConfigurationSnapshot: candidate, reason }));
    const applied = await confirmInTerminal(value, plan.planSha256, candidate);
    assert.equal(applied.ok, true, applied.stack ?? applied.message);
    await value.reload();
    assert.equal(value.workflow.testRecovery, undefined);
    assert.equal(value.workflow.resolution.testRecovery, undefined);
    assert.equal(value.workflow.resolution.testRecoveryAgreement, undefined);
    assert.equal(value.workflow.resolution.testRecoveryValidationEpoch, 2);
    assert.deepEqual(value.workflow.phases.implementation.generationIntent, before.intent);
    assert.equal(await readFile(value.artifact, 'utf8'), before.draft);
    await assert.rejects(access(value.marker), { code: 'ENOENT' });
    await value.publish();
    assert.equal(value.workflow.phases.implementation.generation, 1);
    assert.equal(await readFile(value.marker, 'utf8'), 'ran\n');
    assert.equal(value.workflow.testRecovery, undefined);
  });

test('a non-TRP Story with no explicit or supported inferred runner adopts an approved structured contract without losing work',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const value = await fixture(t, { testRecovery: false, noExplicitTestCommand: true });
    assert.deepEqual(value.workflow.phases.implementation.qualityCommands, []);
    await assert.rejects(value.publish(), { code: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED' },
      'the custom launcher cannot be silently treated as a verified inferred runner');
    await value.reload();
    const before = await preserved(value);
    const candidate = await value.candidate();
    const plan = await context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
      { approvedConfigurationSnapshot: candidate, reason }));
    const applied = await confirmInTerminal(value, plan.planSha256, candidate);
    assert.equal(applied.ok, true, applied.stack ?? applied.message);
    await value.reload();
    const after = await preserved(value);
    for (const field of ['source', 'test', 'draft', 'intent', 'intentBytes', 'baseCommit', 'intervalBase']) {
      assert.deepEqual(after[field], before[field], `explicit runner adoption must preserve ${field}`);
    }
    assert.equal(value.workflow.testRecovery, undefined);
    assert.equal(value.workflow.resolution.testRecoveryAgreement, undefined);
    assert.equal(value.workflow.phases.implementation.qualityCommands[0].kind, 'test');
    await assert.rejects(access(value.marker), { code: 'ENOENT' });
    await value.publish();
    assert.equal(value.workflow.phases.implementation.generation, 1);
    assert.equal(await readFile(value.marker, 'utf8'), 'ran\n');
    assert.equal(value.workflow.testRecovery, undefined);
  });

test('unrelated approved phase policy delta cannot be carried by a test-command amendment', async t => {
  const value = await fixture(t);
  const candidate = await value.candidate(next => { next.phases.implementation.sourceBoundary = 'test-automation'; });
  const before = await preserved(value);
  await assert.rejects(context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
    { approvedConfigurationSnapshot: candidate, reason })), error => /^TCA_|^WFA_/u.test(error.code));
  assert.deepEqual(await preserved(value), before);
  await assert.rejects(access(value.marker), { code: 'ENOENT' });
});

test('new configuration cannot self-grant reviewer authority absent from the original Story pin', async t => {
  const value = await fixture(t);
  const outsider = { name: 'Newly Granted Reviewer', email: 'newly.granted@example.invalid', login: null };
  const candidate = await value.candidate(next => {
    next.approvalAuthorities['engineering-reviewers'].members.push({ name: outsider.name, email: outsider.email, githubLogin: null });
  });
  setActor(value.root, outsider);
  const before = await preserved(value);
  await assert.rejects(context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
    { approvedConfigurationSnapshot: candidate, reason })), { code: 'TCA_AMENDMENT_AUTHORITY_CHANGED' });
  assert.deepEqual(await preserved(value), before);
  await assert.rejects(access(value.marker), { code: 'ENOENT' });
});

test('a published submitted generation adopts a corrected command only through fresh same-generation epoch validation',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
  const value = await fixture(t, { oldCommandWorks: true });
  await value.publish();
  await submitCurrent(value);
  const before = await preserved(value);
  const priorPhase = structuredClone(value.workflow.phases.implementation);
  const priorSubmissions = structuredClone(value.workflow.lineage.submissions);
  const priorEvidence = structuredClone(priorPhase.deliveryEvidence);
  const retainedBytes = await retainedValidationBytes(value);
  const oldRunCount = (await readFile(value.marker, 'utf8')).trim().split('\n').length;
  const candidate = await value.candidate(next => {
    next.phases.implementation.qualityCommands[0].argv.splice(1, 0, '--no-warnings');
  });
  const plan = await context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
    { approvedConfigurationSnapshot: candidate, reason }));
  assert.equal(plan.status, 'ready');
  const applied = await confirmInTerminal(value, plan.planSha256, candidate);
  assert.equal(applied.ok, true, applied.stack ?? applied.message);
  await value.reload();
  const phase = value.workflow.phases.implementation;
  const after = await preserved(value);
  for (const field of ['source', 'test', 'draft', 'intent', 'intentBytes', 'baseCommit', 'intervalBase']) {
    assert.deepEqual(after[field], before[field], `postpublication amendment must preserve ${field}`);
  }
  assert.equal(phase.status, 'in_progress');
  assert.equal(phase.generation, 1);
  assert.equal(phase.generationIntent.status, 'consumed');
  assert.deepEqual(phase.generationPublications, priorPhase.generationPublications);
  assert.deepEqual(phase.approvals, priorPhase.approvals);
  assert.deepEqual(phase.deliveryEvidence, priorEvidence, 'old passing evidence remains historical, not rewritten under the new command');
  assert.deepEqual(value.workflow.lineage.submissions, priorSubmissions);
  assert.equal(phase.testCommandRevalidation.validationEpoch, 2);
  assert.equal(phase.testCommandRevalidation.generation, 1);
  assert.equal(value.workflow.workflowSnapshot.revision, 2);
  assert.equal((await readFile(value.marker, 'utf8')).trim().split('\n').length, oldRunCount,
    'policy amendment executes no tests');
  await assert.rejects(context(value.root, () => approvePhase(value.root, value.config, value.workflow,
    { phaseId: 'implementation', actor: reviewer, agent: null, persist: false })),
  'an old-epoch submission cannot approve the newly amended policy');
  await assertRetainedValidationBytes(value, retainedBytes);
  await submitCurrent(value);
  const revalidated = value.workflow.phases.implementation;
  assert.equal(revalidated.generation, 1, 'test-only revalidation must not fabricate a new content generation');
  assert.equal(revalidated.status, 'awaiting_approval');
  assert.deepEqual(revalidated.generationPublications, priorPhase.generationPublications);
  assert.equal(value.workflow.lineage.submissions.length, priorSubmissions.length + 1);
  assert.deepEqual(value.workflow.lineage.submissions.slice(0, -1), priorSubmissions);
  assert.notEqual(value.workflow.lineage.submissions.at(-1).packetSha256, priorSubmissions.at(-1).packetSha256);
  assert.notEqual(revalidated.deliveryEvidence.receiptPath, priorEvidence.receiptPath,
    'the new validation epoch must use a distinct receipt path');
  assert.ok((await readFile(value.marker, 'utf8')).trim().split('\n').length > oldRunCount,
    'normal resubmission must run the actual corrected command');
  await assertRetainedValidationBytes(value, retainedBytes);
  const firstEpochEvidence = await retainedValidationBytes(value);
  const firstEpochReference = structuredClone(revalidated.testCommandValidation);
  const firstEpochReceipt = revalidated.deliveryEvidence.receiptPath;
  const firstEpochRuns = (await readFile(value.marker, 'utf8')).trim().split('\n').length;
  await assert.rejects(submitCurrent(value), { code: 'SEQUENCE_CONFIRMATION_REQUIRED' });
  await assertRetainedValidationBytes(value, firstEpochEvidence);
  await withConfirmationPort((_message, gate) => {
    assert.equal(gate, 'phaseStatus', 'a repeat submit must not silently override another gate');
    return true;
  }, () => submitCurrent(value));
  assert.equal(value.workflow.sequenceOverrides.at(-1).gate, 'phaseStatus');
  assert.equal(value.workflow.phases.implementation.generation, 1);
  assert.equal(value.workflow.phases.implementation.status, 'awaiting_approval');
  assert.equal(value.workflow.lineage.submissions.length, priorSubmissions.length + 2);
  assert.notEqual(value.workflow.phases.implementation.testCommandValidation.path, firstEpochReference.path,
    'another submission needs a distinct immutable epoch execution record');
  assert.notEqual(value.workflow.phases.implementation.deliveryEvidence.receiptPath, firstEpochReceipt);
  assert.ok((await readFile(value.marker, 'utf8')).trim().split('\n').length > firstEpochRuns,
    'another submission executes fresh validation rather than relabeling prior evidence');
  await assertRetainedValidationBytes(value, retainedBytes);
  await assertRetainedValidationBytes(value, firstEpochEvidence);
  await approveCurrent(value);
  assert.equal(value.workflow.status, 'complete');
  assert.equal(value.workflow.phases.implementation.generation, 1);
  assert.equal(value.workflow.testRecovery.validationEpoch, 2);
  assert.equal(await readFile(path.join(value.root, 'src/service.mjs'), 'utf8'), before.source);
});

test('a completed approved generation cannot be reopened by a test-command amendment', async t => {
  const value = await fixture(t, { oldCommandWorks: true });
  await value.publish();
  await submitCurrent(value);
  await approveCurrent(value);
  assert.equal(value.workflow.phases.implementation.generation, 1);
  const candidate = await value.candidate(next => {
    next.phases.implementation.qualityCommands[0].argv.splice(1, 0, '--no-warnings');
  });
  const before = await preserved(value);
  await assert.rejects(context(value.root, () => previewStoryTestCommandAmendment(value.root, value.config, value.workflow,
    { approvedConfigurationSnapshot: candidate, reason })), { code: 'TCA_PRIOR_PUBLICATION_UNSUPPORTED' });
  assert.deepEqual(await preserved(value), before);
  assert.equal(value.workflow.status, 'complete');
});
