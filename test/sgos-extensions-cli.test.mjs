import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveOperation } from '../src/command-registry.mjs';
import { SGOS_SANDBOX_CAS_ABSENT_SHA256 } from '../src/sgos/devices.mjs';
import {
  createAcceptedTrace, createCapabilityPack, createLearningModule, createMemoryCandidate, createMemoryRef,
  createMetaToolCandidate, createMetaToolEvaluation, createPackReview, createPlatformEnvelope,
  openFilesystemAuthorityStore, platformPrincipalId, platformSha256, signPlatformRecord
} from '../src/sgos/platform/index.mjs';
import { publishSgosCandidateVerifierPolicy } from './helpers/sgos-candidate-authority.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const at = '2026-08-30T10:00:00.000Z';
const digest = (value) => platformSha256(`cli-fixture:${value}`);
const cliActorId = platformPrincipalId({ email: 'extension.cli.tester@example.com' });
const cliReviewerId = platformPrincipalId({ email: 'extension.cli.reviewer@example.com' });

function cliLearningModule() {
  return createLearningModule({
    kind: 'learning-module', id: 'finance-basics', version: 1, role: 'developer',
    title: 'Finance basics',
    objectives: [{ objectiveId: 'inspect-safely', statement: 'Inspect a result without granting authority.' }],
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: 'finance-read-fixture',
      fixtureSha256: digest('learning-fixture')
    },
    steps: [{
      stepId: 'inspect-result', title: 'Inspect the result', kind: 'evidence-exercise',
      instruction: 'Review the declared evidence without executing the fixture.',
      objectiveIds: ['inspect-safely'], evidenceIds: [], failureExerciseIds: [],
      completionCheckIds: ['cli-quiz', 'cli-teach'],
      change: { effect: 'none', description: 'This step changes no repository or Process state.' }
    }],
    expectedEvidence: [], failureExercises: [],
    completionChecks: [{
      checkId: 'cli-quiz', type: 'quiz', prompt: 'What does this lesson authorize?',
      options: [
        { optionId: 'nothing', label: 'Nothing; it is read-only guidance.' },
        { optionId: 'process', label: 'A governed Process transition.' }
      ],
      acceptedOptionIds: ['nothing'], explanation: 'Learning results never grant authority.'
    }, {
      checkId: 'cli-teach', type: 'teach-back', prompt: 'State the boundary.',
      requiredConcepts: ['no authority'], explanation: 'The answer must state the authority boundary.'
    }]
  });
}

function run(root, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Extension CLI Tester' }
  });
}

function flow(root, ...args) {
  const result = run(root, ...args, '--json');
  if (result.status !== 0) throw new Error(`${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.resultType, 'command-result');
  return envelope;
}

function flowAs(root, identity, ...args) {
  const result = spawnSync(process.execPath, [bin, ...args, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: identity }
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.resultType, 'command-result');
  return envelope;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-extension-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Extension CLI Tester');
  git(root, 'config', 'user.email', 'extension.cli@example.test');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), [
    'version: 2',
    'approvalAuthorities:',
    '  architecture-reviewers:',
    '    members: [{ email: extension.cli.tester@example.com }, { email: extension.cli.reviewer@example.com }]',
    '  engineering-reviewers:',
    '    members: [{ email: extension.cli.tester@example.com }, { email: extension.cli.reviewer@example.com }]',
    '  quality-reviewers:',
    '    members: [{ email: extension.cli.tester@example.com }, { email: extension.cli.reviewer@example.com }]',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'README.md'), 'governed extension fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture authority');
  git(root, 'branch', 'sflow/config');
  return root;
}

function state(envelope) {
  return envelope.data.result;
}

test('Authority Store recovery preview and apply resolve to different operation classes', () => {
  const preview = resolveOperation({
    requestedCommand: 'authority-store',
    positionals: ['authority-store', 'recover'], options: {}
  });
  assert.equal(preview.id, 'authority-store.recover.plan');
  assert.equal(preview.classification, 'read');
  const apply = resolveOperation({
    requestedCommand: 'authority-store',
    positionals: ['authority-store', 'recover'], options: { confirm: digest('recovery-plan') }
  });
  assert.equal(apply.id, 'authority-store.recover');
  assert.equal(apply.classification, 'mutation');
});

test('Authority Store CLI refuses non-portable directory identifiers before creating state', async (t) => {
  const root = await repository(t);
  for (const id of ['team:store', 'store.', 'con', 'nul.json']) {
    const result = run(root, 'authority-store', 'init', '--store', id, '--json');
    assert.notEqual(result.status, 0, id);
    assert.match(result.stderr, /portable canonical lower-case identifier/, id);
  }
  const commonDirectory = path.resolve(root, git(root, 'rev-parse', '--git-common-dir'));
  await assert.rejects(readFile(path.join(commonDirectory, 'singularity-flow', 'sgos',
    'platform-authority', 'con', 'state.json')));
});

test('extension CLI exposes model-free manifests, typed Devices, and an explicit local Authority Store', async (t) => {
  const root = await repository(t);
  const absent = run(root, 'authority-store', 'status', '--store', 'cli-store', '--json');
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /not initialized/);
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'governed extension fixture\n');

  const initialized = flow(root, 'authority-store', 'init', '--store', 'cli-store');
  assert.equal(initialized.operation.id, 'authority-store.init');
  assert.equal(state(initialized).revision, 0);
  const status = flow(root, 'authority-store', 'status', '--store', 'cli-store');
  assert.equal(status.operation.classification, 'read');
  assert.equal(state(status).stateSha256, state(initialized).stateSha256);
  assert.equal(state(flow(root, 'authority-store', 'verify', '--store', 'cli-store')).valid, true);

  const commonDirectory = path.resolve(root, git(root, 'rev-parse', '--git-common-dir'));
  const authorityRoot = path.join(commonDirectory, 'singularity-flow', 'sgos',
    'platform-authority', 'cli-store');
  const store = await openFilesystemAuthorityStore({ root: authorityRoot, storeId: 'cli-store' });
  const genesis = await store.read();
  await store.transact({
    expectedRevision: genesis.revision, expectedStateSha256: genesis.recordSha256,
    actorId: 'operator-a', changes: [{ op: 'put', key: 'policy:one', value: { enabled: true } }]
  });
  // Simulate a crash after the immutable event was synced but before the state head advanced.
  await writeFile(path.join(authorityRoot, 'state.json'), JSON.stringify(createPlatformEnvelope(genesis)));
  const recoveryPlan = flow(root, 'authority-store', 'recover', '--store', 'cli-store');
  assert.equal(recoveryPlan.operation.id, 'authority-store.recover.plan');
  assert.equal(recoveryPlan.operation.classification, 'read');
  assert.equal(state(recoveryPlan).required, true);
  const recoveredStore = flow(root, 'authority-store', 'recover', '--store', 'cli-store',
    '--confirm', state(recoveryPlan).recoveryPlan.confirmationSha256);
  assert.equal(recoveredStore.operation.id, 'authority-store.recover');
  assert.equal(recoveredStore.operation.classification, 'mutation');
  assert.equal(state(recoveredStore).recovered, true);
  assert.equal(state(flow(root, 'authority-store', 'verify', '--store', 'cli-store')).revision, 1);

  assert.equal(state(flow(root, 'execution-unit', 'list')).length, 2);
  assert.equal(state(flow(root, 'execution-unit', 'doctor', 'deterministic-translator'))[0].status, 'ready');
  const devices = state(flow(root, 'device', 'list'));
  assert.equal(devices.length, 2);
  assert.equal(state(flow(root, 'device', 'doctor', 'filesystem-read')).status, 'ready');
  assert.equal(state(flow(root, 'device', 'doctor', 'sandbox-cas')).status, 'ready');

  const request = {
    deviceId: 'filesystem-read', processId: 'PRC-cli', taskInstanceId: 'TSK-cli',
    attemptId: 'ATT-cli', operation: 'read-file', arguments: { path: 'README.md' },
    scope: ['README.md'], authorizationSha256: digest('device-authorization'), createdAt: at
  };
  await writeFile(path.join(root, 'device-request.json'), JSON.stringify(request));
  const invoked = state(flow(root, 'device', 'invoke', '--request', 'device-request.json'));
  assert.equal(invoked.result.status, 'observed');
  assert.equal(state(flow(root, 'device', 'intent', invoked.intent.intentSha256)).intentSha256,
    invoked.intent.intentSha256);
  assert.equal(state(flow(root, 'device', 'result', invoked.intent.intentSha256)).resultSha256,
    invoked.result.resultSha256);
  const recovered = state(flow(root, 'device', 'recover', invoked.intent.intentSha256,
    '--request', 'device-request.json'));
  assert.equal(recovered.result.resultSha256, invoked.result.resultSha256);

  const casManifest = devices.find((entry) => entry.id === 'sandbox-cas');
  const casRequest = {
    deviceId: 'sandbox-cas', processId: 'PRC-cli-cas', taskInstanceId: 'TSK-cli-cas',
    attemptId: 'ATT-cli-cas', operation: 'compare-and-swap-put',
    arguments: {
      key: 'cli-key', expectedValueSha256: SGOS_SANDBOX_CAS_ABSENT_SHA256,
      value: { source: 'focused CLI test' }
    },
    scope: ['sandbox-cas:cli-key'], authorizationSha256: casManifest.manifestSha256,
    createdAt: at
  };
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'cas-request.json'), JSON.stringify(casRequest));
  const statusWithRequest = git(root, 'status', '--porcelain');
  const casInvoked = state(flow(root, 'device', 'invoke', '--request', 'cas-request.json'));
  assert.equal(casInvoked.result.status, 'observed');
  assert.equal(casInvoked.result.effect.class, 'local-consequential');
  assert.equal(casInvoked.result.verification.status, 'passed');
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), statusWithRequest);

  const filesystemManifest = devices.find((entry) => entry.id === 'filesystem-read');
  const plan = flow(root, 'device', 'revoke', filesystemManifest.manifestSha256, '--reason', 'retire fixture');
  assert.equal(plan.operation.id, 'device.revoke.plan');
  assert.equal(plan.operation.classification, 'read');
  const revoked = flow(root, 'device', 'revoke', filesystemManifest.manifestSha256, '--reason', 'retire fixture',
    '--confirm', state(plan).confirmationSha256);
  assert.equal(state(revoked).revoked, true);

  const secretArg = run(root, 'authority-store', 'status', '--store', 'cli-store',
    '--private-key', 'forbidden', '--json');
  assert.notEqual(secretArg.status, 0);
  assert.match(secretArg.stderr, /never accepted/);
});

test('Candidate CLI retains, verifies, previews, and publishes one exact Git tree', async (t) => {
  const root = await repository(t);
  const approvedCommands = [[
    process.execPath, '-e',
    "process.exit(require('node:fs').readFileSync('app.txt','utf8').trim()==='after'?0:1)"
  ]];
  await writeFile(path.join(root, 'app.txt'), 'before\n');
  await writeFile(path.join(root, 'approved-verify-commands.json'), JSON.stringify(approvedCommands));
  await writeFile(path.join(root, 'unauthorized-verify-commands.json'), JSON.stringify([
    [process.execPath, '-e', 'process.exit(99)']
  ]));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'candidate baseline');
  await publishSgosCandidateVerifierPolicy(root, { commands: approvedCommands });
  const baseline = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'app.txt'), 'after\n');

  const frozen = state(flow(root, 'candidate', 'freeze', '--subject', 'cli-repository'));
  const candidateId = frozen.candidate.candidateId;
  assert.equal(frozen.repository.baselineCommit, baseline);
  const shown = state(flow(root, 'candidate', 'show', candidateId));
  assert.equal(shown.retainedCandidateSha256, frozen.retainedCandidateSha256);
  assert.equal(state(flow(root, 'candidate', 'list')).some((entry) =>
    entry.candidate?.candidateId === candidateId), true);
  const callerSelected = run(root, 'candidate', 'verify', candidateId,
    '--commands', 'unauthorized-verify-commands.json', '--json');
  assert.notEqual(callerSelected.status, 0);
  assert.match(callerSelected.stderr, /do not equal approved/i);
  const verified = state(flow(root, 'candidate', 'verify', candidateId,
    '--commands', 'approved-verify-commands.json', '--timeout-ms', '30000'));
  assert.equal(verified.status, 'passed');

  const preview = flow(root, 'candidate', 'publish', candidateId);
  assert.equal(preview.operation.id, 'candidate.publish.plan');
  assert.equal(preview.operation.classification, 'mutation');
  assert.equal(preview.effects.filesChanged, true);
  const publicationEnvelope = flow(root, 'candidate', 'publish', candidateId,
    '--confirm', state(preview).packetSha256);
  const published = state(publicationEnvelope);
  assert.equal(published.status, 'published');
  assert.equal(publicationEnvelope.effects.publicationCreated, true);
  assert.equal(publicationEnvelope.effects.externalSystemsChanged, false);
  assert.equal(git(root, 'rev-parse', 'HEAD'), frozen.repository.candidateCommit);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('signed Pack, role lesson, and typed Memory CLI preserve exact CAS and review boundaries', async (t) => {
  const root = await repository(t);
  const storeId = 'platform-cli';
  let current = state(flow(root, 'authority-store', 'init', '--store', storeId));
  const keys = generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(path.join(root, 'publisher-trust.json'), JSON.stringify({ 'publisher-key': publicKeyPem }));

  const learningModule = cliLearningModule();
  await writeFile(path.join(root, 'learning-module.json'), JSON.stringify(learningModule));
  const pack = createCapabilityPack({
    packId: 'finance-core', version: '1.0.0', domain: 'finance', operations: ['finance.inspect'],
    permissions: [], files: [], lessons: [{
      lessonId: 'finance-basics', roles: ['developer'], title: 'Finance basics',
      contentSha256: learningModule.moduleSha256
    }], provenanceSha256: digest('provenance'), sbomSha256: digest('sbom'),
    publisherKeyId: 'publisher-key', createdAt: at
  });
  const signedPack = signPlatformRecord(pack, { privateKeyPem, keyId: 'publisher-key' });
  await writeFile(path.join(root, 'signed-pack.json'), JSON.stringify(signedPack));
  const spoofedActor = run(root, 'pack', 'propose', '--store', storeId,
    '--trust', 'publisher-trust.json', '--signed-pack', 'signed-pack.json',
    '--actor', 'attacker', '--expected-revision', String(current.revision),
    '--expected-state-sha256', current.stateSha256, '--json');
  assert.notEqual(spoofedActor.status, 0);
  assert.match(spoofedActor.stderr, /caller-supplied identity options are refused/i);
  flow(root, 'pack', 'propose', '--store', storeId, '--trust', 'publisher-trust.json',
    '--signed-pack', 'signed-pack.json',
    '--expected-revision', String(current.revision), '--expected-state-sha256', current.stateSha256);

  current = state(flow(root, 'authority-store', 'status', '--store', storeId));
  const review = createPackReview({
    packSha256: pack.recordSha256, reviewerId: cliActorId, decision: 'approved',
    reason: 'reviewed', reviewedAt: at
  });
  await writeFile(path.join(root, 'pack-review.json'), JSON.stringify(review));
  flow(root, 'pack', 'review', '--store', storeId, '--trust', 'publisher-trust.json',
    '--review', 'pack-review.json', '--expected-revision', String(current.revision),
    '--expected-state-sha256', current.stateSha256);

  current = state(flow(root, 'authority-store', 'status', '--store', storeId));
  flow(root, 'pack', 'activate', '--store', storeId, '--trust', 'publisher-trust.json',
    '--domain', pack.domain, '--pack', pack.recordSha256, '--review-sha256', review.recordSha256,
    '--confirm', pack.recordSha256,
    '--expected-revision', String(current.revision), '--expected-state-sha256', current.stateSha256);
  assert.equal(state(flow(root, 'pack', 'list', '--store', storeId,
    '--trust', 'publisher-trust.json'))[0].recordSha256, pack.recordSha256);
  assert.equal(state(flow(root, 'learn', 'show', 'finance-basics', '--role', 'developer',
    '--store', storeId, '--trust', 'publisher-trust.json')).packSha256, pack.recordSha256);
  const beforeLearning = new Set(git(root, 'status', '--porcelain').split('\n').filter(Boolean));
  const beforeLearningHead = git(root, 'rev-parse', 'HEAD');
  const missionEnvelope = flow(root, 'learn', 'start', 'finance-basics', '--role', 'developer',
    '--pack', 'finance-core', '--module', 'learning-module.json',
    '--store', storeId, '--trust', 'publisher-trust.json');
  const mission = state(missionEnvelope);
  assert.equal(missionEnvelope.operation.classification, 'read');
  assert.deepEqual(missionEnvelope.effects, {
    stateChanged: false, filesChanged: false, publicationCreated: false,
    externalSystemsChanged: false
  });
  assert.equal(mission.sandbox.materialization, 'not-performed');
  assert.equal(mission.boundary.modelInvocations, 0);
  assert.equal(state(flow(root, 'learn', 'inspect', 'finance-basics', '--role', 'developer',
    '--module', 'learning-module.json', '--store', storeId,
    '--trust', 'publisher-trust.json')).counts.steps, 1);
  assert.equal(state(flow(root, 'learn', 'explain-change', 'finance-basics', 'inspect-result',
    '--role', 'developer', '--module', 'learning-module.json', '--store', storeId,
    '--trust', 'publisher-trust.json')).effects.repository, 'none');
  await writeFile(path.join(root, 'quiz-answer.json'), JSON.stringify({ selectedOptionIds: ['nothing'] }));
  await writeFile(path.join(root, 'teach-answer.json'), JSON.stringify({ text: 'The lesson grants no authority.' }));
  assert.equal(state(flow(root, 'learn', 'quiz', 'finance-basics', 'cli-quiz', '--role', 'developer',
    '--module', 'learning-module.json', '--answers', 'quiz-answer.json', '--store', storeId,
    '--trust', 'publisher-trust.json')).status, 'passed');
  const teachBack = state(flow(root, 'learn', 'teach-back', 'finance-basics', 'cli-teach',
    '--role', 'developer', '--module', 'learning-module.json', '--answers', 'teach-answer.json',
    '--store', storeId, '--trust', 'publisher-trust.json'));
  assert.equal(teachBack.status, 'passed');
  assert.doesNotMatch(JSON.stringify(teachBack), /The lesson grants/);
  const afterLearning = new Set(git(root, 'status', '--porcelain').split('\n').filter(Boolean));
  assert.deepEqual([...afterLearning].filter((entry) => !beforeLearning.has(entry)).sort(),
    ['?? quiz-answer.json', '?? teach-answer.json']);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeLearningHead);

  const ref = createMemoryRef({
    memoryId: 'repository-guidance', version: 1, class: 'approved-guidance', scope: 'repository',
    contentSha256: digest('memory'), authorityStoreId: storeId, sensitivity: 'internal',
    dependencies: [], createdAt: at
  });
  const candidate = createMemoryCandidate({
    candidateId: 'memory-candidate-one', proposedRef: ref, sourceRefs: [digest('source')],
    evidenceRefs: [digest('evidence')], proposerId: 'proposer-a', createdAt: at
  });
  await writeFile(path.join(root, 'memory-candidate.json'), JSON.stringify(candidate));
  current = state(flow(root, 'authority-store', 'status', '--store', storeId));
  flow(root, 'memory', 'register', '--store', storeId, '--candidate', 'memory-candidate.json',
    '--expected-revision', String(current.revision),
    '--expected-state-sha256', current.stateSha256);
  current = state(flow(root, 'authority-store', 'status', '--store', storeId));
  flow(root, 'memory', 'promote', candidate.candidateId, '--store', storeId,
    '--confirm', candidate.recordSha256, '--reason', 'approved guidance',
    '--expected-revision', String(current.revision), '--expected-state-sha256', current.stateSha256);
  const inspected = state(flow(root, 'memory', 'inspect', ref.memoryId, '--store', storeId));
  assert.equal(inspected.valid, true);
  assert.deepEqual(state(flow(root, 'memory', 'dependencies', ref.memoryId,
    '--store', storeId)).dependencies, []);
});

test('Meta-tool CLI accepts only signed traces and evaluation before independent promotion', async (t) => {
  const root = await repository(t);
  const storeId = 'meta-cli';
  let current = state(flow(root, 'authority-store', 'init', '--store', storeId));
  const issuerKeys = generateKeyPairSync('ed25519');
  const evaluatorKeys = generateKeyPairSync('ed25519');
  const issuerPrivate = issuerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const evaluatorPrivate = evaluatorKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(path.join(root, 'trace-trust.json'), JSON.stringify({
    'trace-issuer': issuerKeys.publicKey.export({ type: 'spki', format: 'pem' })
  }));
  await writeFile(path.join(root, 'evaluator-trust.json'), JSON.stringify({
    'evaluator-key': evaluatorKeys.publicKey.export({ type: 'spki', format: 'pem' })
  }));
  const traces = ['one', 'two'].map((name) => createAcceptedTrace({
    traceSha256: digest(`trace-${name}`), evidenceSha256: digest(`evidence-${name}`),
    verificationReceiptSha256: digest(`verification-${name}`),
    outcomeAcceptanceSha256: digest(`acceptance-${name}`), containsSecrets: false,
    unresolvedGaps: 0, issuerKeyId: 'trace-issuer', acceptedAt: at
  })).sort((left, right) => left.traceSha256.localeCompare(right.traceSha256));
  const signedTraces = traces.map((trace) => signPlatformRecord(trace, {
    privateKeyPem: issuerPrivate, keyId: 'trace-issuer'
  }));
  const candidate = createMetaToolCandidate({
    candidateId: 'meta-candidate-one', operationId: 'finance-inspect',
    traceRefs: traces.map((trace) => trace.traceSha256), proposerId: cliActorId, createdAt: at
  });
  await writeFile(path.join(root, 'meta-candidate.json'), JSON.stringify(candidate));
  await writeFile(path.join(root, 'signed-traces.json'), JSON.stringify(signedTraces));
  flow(root, 'meta-tool', 'propose', '--store', storeId,
    '--trace-trust', 'trace-trust.json', '--evaluator-trust', 'evaluator-trust.json',
    '--candidate', 'meta-candidate.json', '--traces', 'signed-traces.json',
    '--expected-revision', String(current.revision), '--expected-state-sha256', current.stateSha256);

  const evaluation = createMetaToolEvaluation({
    candidateSha256: candidate.recordSha256, securityGate: 'passed', qualityGate: 'passed',
    costGate: 'passed', holdoutSha256: digest('independent-holdout'),
    evaluatorKeyId: 'evaluator-key', evaluatedAt: at
  });
  const signedEvaluation = signPlatformRecord(evaluation, {
    privateKeyPem: evaluatorPrivate, keyId: 'evaluator-key'
  });
  await writeFile(path.join(root, 'signed-evaluation.json'), JSON.stringify(signedEvaluation));
  current = state(flow(root, 'authority-store', 'status', '--store', storeId));
  flow(root, 'meta-tool', 'evaluation', '--store', storeId,
    '--trace-trust', 'trace-trust.json', '--evaluator-trust', 'evaluator-trust.json',
    '--evaluation', 'signed-evaluation.json',
    '--expected-revision', String(current.revision), '--expected-state-sha256', current.stateSha256);

  current = state(flow(root, 'authority-store', 'status', '--store', storeId));
  const promoted = state(flowAs(root, 'Extension CLI Reviewer', 'meta-tool', 'promote', '--store', storeId,
    '--trace-trust', 'trace-trust.json', '--evaluator-trust', 'evaluator-trust.json',
    '--candidate-sha256', candidate.recordSha256, '--evaluation-sha256', evaluation.recordSha256,
    '--confirm-candidate', candidate.recordSha256, '--confirm-evaluation', evaluation.recordSha256,
    '--decision', 'approved', '--reason', 'independent review',
    '--expected-revision', String(current.revision), '--expected-state-sha256', current.stateSha256));
  assert.equal(promoted.status, 'pack-review-required');
  assert.equal(promoted.reviewerId, cliReviewerId);
  assert.equal(state(flow(root, 'meta-tool', 'list', '--store', storeId)).length, 3);
});
