import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { applyCapabilityPolicyToWorkResolution, resolveLifecycleCapability } from '../src/capability-context.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { setAgentSession } from '../src/session.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { commitAndPublish, createWorkflow, loadConfig, publishGeneration, scanArtifacts, workDir } from '../src/state.mjs';
import { normalizeTestRecoveryPolicy, previewTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { planStoryTestSelection } from '../src/commands/story-test-selection.mjs';
import { TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const actor = { name: 'TRP Lifecycle', email: 'trp.lifecycle@example.com', login: null };
const context = (root, invoke) => withOperationContext({ root, command: 'test',
  operation: { id: 'test.trp-lifecycle', command: 'test', modelPolicy: 'never' },
  modelMode: { enabled: false, source: 'test' } }, invoke);
const authorship = buildGenerationAuthorship({ options: normalizeAuthorshipOptions({ producer: 'human',
  channel: 'manual-in-place', externalAiUse: 'none' }), actor, governedAgentContext: 'developer', source: null });

async function confirmInTerminal(value, confirmation) {
  const input = path.join(value.root, '.git/trp-confirm-test-input.json');
  await writeFile(input, JSON.stringify({ root: value.root, config: value.config, workflow: value.workflow, confirmation }));
  const code = `
    import {readFile} from 'node:fs/promises';
    import {confirmStoryTestSelection} from ${JSON.stringify(new URL('../src/commands/story-test-selection.mjs', import.meta.url).href)};
    import {withOperationContext} from ${JSON.stringify(new URL('../src/operation-context.mjs', import.meta.url).href)};
    const {root,config,workflow,confirmation}=JSON.parse(await readFile(${JSON.stringify(input)},'utf8'));
    try {
      const result=await withOperationContext({root,command:'test',operation:{id:'test.trp-confirm',command:'test',modelPolicy:'never'},
        modelMode:{enabled:false,source:'test'}},()=>confirmStoryTestSelection(root,config,workflow,{confirmation}));
      console.log('TRP_CONFIRM_RESULT:'+JSON.stringify({ok:true,status:result.status,executed:result.executed}));
    } catch(error) {console.log('TRP_CONFIRM_RESULT:'+JSON.stringify({ok:false,code:error.code,message:error.message,stack:error.stack}));}
  `;
  const script = `
    set timeout 35
    log_user 1
    spawn -noecho $env(SF_TRP_NODE) --input-type=module -e $env(SF_TRP_CODE)
    expect {
      "Type Confirm test scope to confirm this exact action, or Enter to cancel:" { send -- "Confirm test scope\\r" }
      timeout {exit 124}
      eof {exit 125}
    }
    expect eof
    catch wait result
    exit [lindex $result 3]
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const output = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: value.root,
      env: { ...env, SF_TRP_NODE: process.execPath, SF_TRP_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let transcript = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Confirmation PTY timed out: ${transcript.slice(-3000)}`)); }, 40000);
    child.stdout.on('data', bytes => { transcript += bytes; }); child.stderr.on('data', bytes => { transcript += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); status === 0 ? resolve(transcript) : reject(new Error(transcript.slice(-4000))); });
  });
  const match = output.match(/TRP_CONFIRM_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(match, output.slice(-4000));
  const result = JSON.parse(match[1]); assert.equal(result.ok, true, result.stack ?? result.message);
  return result;
}

async function fixture(t, { mode = 'changed-and-affected', testOnly = false, extraQualityCommands = [], expectIntakeBlock = false } = {}) {
  const beforeEnv = { NODE_ENV: process.env.NODE_ENV, SINGULARITY_FLOW_TEST_IDENTITY: process.env.SINGULARITY_FLOW_TEST_IDENTITY };
  process.env.NODE_ENV = 'test'; process.env.SINGULARITY_FLOW_TEST_IDENTITY = actor.name;
  t.after(() => { for (const [key, value] of Object.entries(beforeEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', actor.name); git(root, 'config', 'user.email', actor.email);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'trp-lifecycle', version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'trp-lifecycle', version: '1.0.0', lockfileVersion: 3,
    requires: true, packages: { '': { name: 'trp-lifecycle', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/selected.test.mjs'), "import test from 'node:test'; test('selected cohort', () => {});\n");
  await writeFile(path.join(root, 'test/other.test.mjs'), [
    "import test from 'node:test'; import {existsSync,writeFileSync} from 'node:fs';",
    "test('outside narrow cohort',()=>{ if(existsSync('.sflow/results/check-cohort')) writeFileSync('.sflow/results/other-ran','yes'); });", ''
  ].join('\n'));
  await initializeDefinition(root); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Baseline application');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const readinessPlan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  assert.deepEqual(readinessPlan.blockers, []);
  await executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: readinessPlan.planId });
  const repositoryReadiness = await collectRepositoryReadinessEvidence([{ id: 'lifecycle', root, baseCommit }], { scope: 'dependency-test' });
  assert.equal(repositoryReadiness.repositories.lifecycle.status, 'pass');
  git(root, 'switch', '-q', '-c', 'TRP-COHORT');
  const config = await loadConfig(root); config.git.publish = 'off';
  config.approvalAuthorities['trp-reviewers'] = { label: 'TRP reviewers', allowAnyGitIdentity: false,
    members: [{ name: actor.name, email: actor.email, githubLogin: null }] };
  config.testRecovery = normalizeTestRecoveryPolicy({ enabled: true, riskAuthorities: ['trp-reviewers'] });
  const resolved = resolveWorkType(config, 'feature');
  resolved.plannedClaims = { mode: 'opt-out', clausePhases: [], owners: {}, reason: 'Isolated execution fixture with no specification phase.' };
  resolved.spec = { ...resolved.spec, acceptance: 'off' };
  const implementation = resolved.phases.find(phase => phase.id === 'implementation');
  resolved.phases = [{ ...implementation, order: 0, inputs: [], clarification: { ...implementation.clarification, mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] },
    sourceBoundary: testOnly ? 'test-automation' : 'unrestricted',
    qualityCommands: [...extraQualityCommands, { id: 'node-tests', kind: 'test', argv: [process.execPath, '--test', '--test-reporter=tap', 'test/selected.test.mjs', 'test/other.test.mjs'],
      workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'node-tap', path: '.sflow/results/selected.tap', minimumDiscovered: 1, minimumPassed: 1 } }] }];
  const readinessRepositories = [{ id: 'lifecycle', baseCommit, baseBranch: 'main' }];
  const testRecoveryPlan = previewTestRecoveryIntake({ definition: config, workId: 'TRP-COHORT', workType: 'feature',
    repositories: readinessRepositories, repositoryReadiness,
    choices: { baselineDisposition: 'fix', executionMode: mode, baselineScope: 'reuse' },
    phaseDefinitions: applyCapabilityPolicyToWorkResolution(resolved, await resolveLifecycleCapability(root)).phases });
  if (expectIntakeBlock) {
    assert.equal(testRecoveryPlan.ready, false);
    assert.ok(testRecoveryPlan.blockers.some(message => /structured test commands/u.test(message)));
    return { root, config, testRecoveryPlan };
  }
  assert.equal(testRecoveryPlan.ready, true);
  await setAgentSession(root, config, actor, 'developer', 'TRP-COHORT', { phaseId: 'implementation', source: 'test' });
  const workflow = await context(root, () => createWorkflow(root, config, { id: 'TRP-COHORT', title: 'Prove exact test cohort',
    source: { type: 'manual', key: 'TRP-COHORT', title: 'Prove exact test cohort', description: 'Run only the reviewed test selection.',
      acceptanceCriteria: ['The declared test cohort is enforced before publication.'] },
    baseBranch: 'main', baseCommit, workType: 'feature', agent: 'developer', resolved,
    readinessRepositories, repositoryReadiness, testRecoveryPlan }));
  await context(root, () => commitAndPublish(root, config, workflow, { type: 'binding' }, 'Bind opted-in TRP Story'));
  const phase = workflow.phases.implementation;
  const artifact = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
  await writeFile(artifact, ['# Implementation', '', 'Implemented the bounded source or test-source change requested by the Story.', '',
    '## Delivery evidence', '', 'The real Node runner executes the selected tests and returns a current structured TAP result. The cohort is sealed before execution and its binding remains available in the delivery evidence.', '',
    '## Residual risk', '', 'Only the selected cohort is claimed. Unselected tests are not reported as passing and a full expansion requires a separate reviewed decision.', ''].join('\n'));
  await mkdir(path.join(root, '.sflow/results'), { recursive: true });
  await writeFile(path.join(root, '.sflow/results/check-cohort'), 'observe');
  await writeFile(path.join(root, 'test/selected.test.mjs'), "import test from 'node:test'; test('selected cohort changed', () => {});\n");
  if (!testOnly) await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 2;\n');
  const publish = () => context(root, async () => {
    await scanArtifacts(root, config, workflow, phase.id);
    const payload = await generationStartPublicationBinding(root, workflow, phase);
    return commitAndPublish(root, config, workflow, { type: 'artifact-generated', phaseId: phase.id,
      generation: phase.generation + 1, payload }, 'Publish reviewed test cohort',
    [...phase.artifacts.map(entry => entry.path), 'test/selected.test.mjs', ...(!testOnly ? ['src/service.mjs'] : [])], {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow,
        { phaseId: phase.id, authorship, persist: false, publicationTransaction: { publicationEvent,
          transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead } })
    });
  });
  return { root, config, workflow, phase, publish };
}

test('opted-in test-source publication executes only the precise changed-file cohort', async (t) => {
  const value = await fixture(t, { testOnly: true });
  await value.publish();
  assert.equal(value.phase.generation, 1);
  assert.ok(value.phase.deliveryEvidence.trpSelection?.recordSha256);
  const selection = JSON.parse(await readFile(path.join(value.root, value.phase.deliveryEvidence.trpSelection.path), 'utf8'));
  assert.equal(selection.expansion, 'none'); assert.equal(selection.effectiveMode, 'changed-and-affected');
  const preview = await planStoryTestSelection(value.root, value.config, value.workflow);
  assert.equal(preview.preview.generation, 1, 'a consumed generation intent must not preview the next generation');
  assert.equal(preview.planDigest, value.phase.deliveryEvidence.trpSelection.planDigest);
  await assert.rejects(access(path.join(value.root, '.sflow/results/other-ran')), { code: 'ENOENT' });
});

test('opted-in source publication cannot run an unconfirmed hidden full suite', async (t) => {
  const value = await fixture(t);
  await assert.rejects(value.publish(), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
  assert.equal(value.phase.generation, 0);
  await assert.rejects(access(path.join(value.root, '.sflow/results/other-ran')), { code: 'ENOENT' });
});

test('affected intake refuses a legacy full-suite gate before Story creation', async (t) => {
  const value = await fixture(t, { testOnly: true, extraQualityCommands: ['npm test'], expectIntakeBlock: true });
  assert.equal(value.testRecoveryPlan.ready, false);
  await assert.rejects(access(workDir(value.root, value.config, 'TRP-COHORT')), { code: 'ENOENT' });
});

test('explicit all-configured intake runs the full configured cohort during source publication', async (t) => {
  const value = await fixture(t, { mode: 'all-configured' });
  await value.publish();
  assert.equal(value.phase.generation, 1);
  assert.equal(await readFile(path.join(value.root, '.sflow/results/other-ran'), 'utf8'), 'yes');
  const selection = JSON.parse(await readFile(path.join(value.root, value.phase.deliveryEvidence.trpSelection.path), 'utf8'));
  assert.equal(selection.requestedMode, 'all-configured'); assert.equal(selection.effectiveMode, 'all-configured');
});

test('real terminal confirmation commits exact scope without tests, then publication replays host-qualified consent',
  { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
    const value = await fixture(t);
    const plan = await planStoryTestSelection(value.root, value.config, value.workflow);
    const confirmed = await confirmInTerminal(value, plan.planDigest);
    assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.executed, false);
    await assert.rejects(access(path.join(value.root, '.sflow/results/other-ran')), { code: 'ENOENT' });
    const saved = JSON.parse(await readFile(path.join(workDir(value.root, value.config, 'TRP-COHORT'), 'workflow.json'), 'utf8'));
    const entry = saved.testRecovery.selectionConfirmations.at(-1);
    assert.equal(entry.planDigest, plan.planDigest);
    assert.ok(entry.selection.recordSha256); assert.ok(entry.authorityReceipt.recordSha256);
    Object.assign(value.workflow, saved); Object.assign(value.phase, saved.phases.implementation);
    value.workflow.phases.implementation = value.phase;
    await value.publish();
    assert.equal(value.phase.generation, 1);
    assert.equal(await readFile(path.join(value.root, '.sflow/results/other-ran'), 'utf8'), 'yes');
  });

test('same-plan terminal re-review supersedes an older confirmation whose local proof is unavailable',
  { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
    const value = await fixture(t);
    const plan = await planStoryTestSelection(value.root, value.config, value.workflow);
    const reload = async () => {
      const saved = JSON.parse(await readFile(path.join(workDir(value.root, value.config, 'TRP-COHORT'), 'workflow.json'), 'utf8'));
      Object.assign(value.workflow, saved); Object.assign(value.phase, saved.phases.implementation);
      value.workflow.phases.implementation = value.phase;
      return saved.testRecovery.selectionConfirmations;
    };
    assert.equal((await confirmInTerminal(value, plan.planDigest)).status, 'confirmed');
    const original = (await reload())[0];
    // Only remove this disposable fixture's exact proof, simulating loss of local-origin storage.
    await rm(path.join(value.root, '.git/singularity-flow/trp-review-origins',
      `${original.authorityReceipt.recordSha256.slice(7)}.origin`));
    const recoveryPlan = await planStoryTestSelection(value.root, value.config, value.workflow);
    assert.equal(recoveryPlan.planDigest, plan.planDigest);
    assert.equal(recoveryPlan.status, 'blocked');
    assert.equal((await confirmInTerminal(value, recoveryPlan.planDigest)).status, 'confirmed');
    const confirmations = await reload();
    assert.equal(confirmations.length, 2);
    assert.deepEqual(confirmations[0], original, 'the unavailable receipt remains historical evidence');
    const recovered = await planStoryTestSelection(value.root, value.config, value.workflow);
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.selection.recordSha256, confirmations[1].selection.recordSha256);
    await assert.rejects(access(path.join(value.root, '.sflow/results/other-ran')), { code: 'ENOENT' });
    await value.publish();
    assert.equal(value.phase.generation, 1);
    assert.equal(await readFile(path.join(value.root, '.sflow/results/other-ran'), 'utf8'), 'yes');
  });
