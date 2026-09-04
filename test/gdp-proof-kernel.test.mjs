import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { projectLegacyGdpCompatibility } from '../src/delivery-modes/compatibility-projection.mjs';
import {
  buildEvaluationReceipt, buildGapItem, buildGapRegister, buildPredicateSpecification,
  buildProofInvalidation, buildProofProfileSelection, buildProofSummary,
  buildSignalObservation, evaluateProofPredicate, observeShadowProof, PROOF_KERNEL_LIMITS,
  PROOF_RECORD_FAMILIES, validateProofRecord
} from '../src/delivery-modes/proof-kernel.mjs';
import {
  listProofRecords, persistProofObservation, proofObservationWritePlan, readProofRecord
} from '../src/delivery-modes/proof-store.mjs';
import { buildShadowChangePassport } from '../src/delivery-modes/shadow-passport.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot, readRecord
} from '../src/schema-migrations.mjs';
import { createWorkflow, workflowPath } from '../src/state.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const candidateSha256 = `sha256:${'a'.repeat(64)}`;
const anotherCandidateSha256 = `sha256:${'b'.repeat(64)}`;
const policySha256 = `sha256:${'1'.repeat(64)}`;
const worldModelSha256 = `sha256:${'e'.repeat(64)}`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function observation(workId = 'GDP-M3') {
  const compatibility = projectLegacyGdpCompatibility({
    sourceKind: 'workflow-story',
    record: {
      workItem: { id: workId }, status: 'in_progress',
      candidate: { candidateSha256 },
      worldModelReference: { manifestSha256: worldModelSha256 }
    }
  });
  return observeShadowProof(buildShadowChangePassport({ compatibility, sourcePolicySha256: policySha256 }));
}

function allReasons(...extra) {
  return [
    'PFC_EXACT_INPUTS_EQUAL', 'PFC_EXACT_INPUTS_DIFFER', 'PFC_REQUIRED_INPUT_UNAVAILABLE',
    'PFC_DEADLINE_EXHAUSTED', 'PFC_INPUT_LIMIT_EXCEEDED', 'PFC_FUEL_EXHAUSTED',
    'PFC_INPUT_STALE', 'PFC_SIGNAL_NOT_PREDICATE', 'PFC_INPUT_KIND_UNSUPPORTED',
    'PFC_INPUT_CONTRADICTORY', 'PFC_PROFILE_NOT_APPLICABLE', 'PFC_OUTPUT_LIMIT_EXCEEDED',
    ...extra
  ];
}

function equalitySpecification(options = {}) {
  return buildPredicateSpecification({
    id: options.id ?? 'pfc.test-equality',
    algorithm: 'exact-digest-equality',
    acceptedInputs: [
      { kind: 'expected', required: true, maximumOccurrences: 1 },
      { kind: 'observed', required: true, maximumOccurrences: 1 }
    ],
    reasonCodes: allReasons(),
    ...(options.profiles ? { profiles: options.profiles } : {}),
    ...(options.limits ? { limits: options.limits } : {})
  });
}

function evaluate(specification, inputs, extra = {}) {
  return evaluateProofPredicate({
    specification,
    proofSubjectSha256: observation().proofSubject.proofSubjectSha256,
    proofProfile: 'standard',
    inputs,
    ...extra
  });
}

test('GDP M3 implements the frozen four-valued total predicate lattice', () => {
  const specification = equalitySpecification();
  const same = [
    { kind: 'expected', sha256: candidateSha256 },
    { kind: 'observed', sha256: candidateSha256 }
  ];
  const different = [
    { kind: 'expected', sha256: candidateSha256 },
    { kind: 'observed', sha256: anotherCandidateSha256 }
  ];
  assert.equal(evaluate(specification, same).verdict, 'pass');
  assert.equal(evaluate(specification, different).verdict, 'fail');
  assert.equal(evaluate(specification, same.slice(0, 1)).verdict, 'unavailable');
  const regulated = equalitySpecification({ id: 'pfc.regulated-only', profiles: ['regulated'] });
  assert.equal(evaluate(regulated, same).verdict, 'not-applicable');
});

test('missing, stale, contradictory, timed-out, fuel-exhausted, malformed, and oversized evidence never passes', () => {
  const specification = equalitySpecification();
  const same = [
    { kind: 'expected', sha256: candidateSha256 },
    { kind: 'observed', sha256: candidateSha256 }
  ];
  assert.equal(evaluate(specification, same, { changedInputSha256s: [candidateSha256] }).verdict, 'unavailable');
  assert.equal(evaluate(specification, same, { deadlineExceeded: true }).verdict, 'unavailable');
  assert.equal(evaluate(specification, same, { maximumFuel: 1 }).verdict, 'unavailable');
  assert.equal(evaluate(specification, [...same, { kind: 'observed', sha256: anotherCandidateSha256 }]).verdict, 'unavailable');
  const tiny = equalitySpecification({ limits: { maximumInputBytes: 128 } });
  assert.equal(evaluate(tiny, same).verdict, 'unavailable');
  assert.throws(() => evaluate(specification, [{ kind: 'expected', sha256: 'not-a-digest' }]), /sha256 digest/);
  assert.throws(() => evaluate(specification, Array.from({ length: 257 }, (_, index) => ({
    kind: `input-${index}`, sha256: `sha256:${index.toString(16).padStart(64, '0')}`
  }))), /exceeds 256/);
});

test('signals remain non-authoritative and cannot satisfy a Predicate or Proof Summary', () => {
  const subject = observation().proofSubject.proofSubjectSha256;
  const signal = buildSignalObservation({
    proofSubjectSha256: subject, signalId: 'mutation-kill-rate',
    inputs: [{ kind: 'candidate', sha256: candidateSha256 }],
    value: 0.71, unit: 'ratio', assurance: 'tool-reported'
  });
  assert.equal(signal.authority, 'none');
  assert.equal(signal.gateEligible, false);
  const summary = buildProofSummary({
    proofSubjectSha256: subject, proofProfile: 'standard', results: [], signals: [signal]
  });
  assert.equal(summary.verdict, 'proof-unavailable');
  assert.deepEqual(summary.predicateResults.passed, []);
  const specification = equalitySpecification();
  const result = evaluate(specification, [{
    kind: 'proof-signal-observation', sha256: signal.observationSha256
  }]);
  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.reasonCode, 'PFC_SIGNAL_NOT_PREDICATE');
});

test('GDP M3 observes legacy Candidates deterministically without claiming policy authority', async () => {
  const first = observation();
  const second = observation();
  assert.deepEqual(first, second);
  assert.equal(first.authority, 'none');
  assert.equal(first.status, 'proof-unavailable');
  assert.equal(first.results[0].verdict, 'pass');
  assert.equal(first.results[1].verdict, 'unavailable');
  assert.ok(first.gaps.some((gap) => gap.gapId === 'gdp-shadow-policy-authority'));
  assert.equal(first.guarantees.consumedByLifecycle, false);
  assert.equal(first.guarantees.noModel, true);

  const expected = JSON.parse(await readFile(path.join(
    repositoryRoot, 'test/fixtures/gdp-proof/m3-observation.json'
  ), 'utf8'));
  assert.equal(first.observationSha256, expected.observationSha256);
  assert.equal(first.summary.summarySha256, expected.summarySha256);
  assert.deepEqual(first.results.map((result) => result.resultSha256), expected.resultSha256s);
});

test('semantic hashes survive another process and exclude operational receipt clocks', () => {
  const kernelUrl = new URL('../src/delivery-modes/proof-kernel.mjs', import.meta.url).href;
  const compatibilityUrl = new URL('../src/delivery-modes/compatibility-projection.mjs', import.meta.url).href;
  const passportUrl = new URL('../src/delivery-modes/shadow-passport.mjs', import.meta.url).href;
  const script = `
    import { observeShadowProof } from ${JSON.stringify(kernelUrl)};
    import { projectLegacyGdpCompatibility } from ${JSON.stringify(compatibilityUrl)};
    import { buildShadowChangePassport } from ${JSON.stringify(passportUrl)};
    const c = projectLegacyGdpCompatibility({ sourceKind: 'workflow-story', record: { workItem: { id: 'GDP-M3' }, status: 'in_progress', candidate: { candidateSha256: ${JSON.stringify(candidateSha256)} }, worldModelReference: { manifestSha256: ${JSON.stringify(worldModelSha256)} } } });
    process.stdout.write(JSON.stringify(observeShadowProof(buildShadowChangePassport({ compatibility: c, sourcePolicySha256: ${JSON.stringify(policySha256)} }))));
  `;
  const run = (cwd) => spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd, encoding: 'utf8' });
  const first = run(repositoryRoot);
  const second = run(path.dirname(repositoryRoot));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);

  const result = observation().results[0];
  const receiptA = buildEvaluationReceipt({
    proofSubjectSha256: result.proofSubjectSha256, resultSha256: result.resultSha256,
    startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:00:00.010Z',
    durationMilliseconds: 10, deadlineMilliseconds: 1000
  });
  const receiptB = buildEvaluationReceipt({
    proofSubjectSha256: result.proofSubjectSha256, resultSha256: result.resultSha256,
    startedAt: '2026-09-04T00:01:00.000Z', completedAt: '2026-09-04T00:01:00.020Z',
    durationMilliseconds: 20, deadlineMilliseconds: 1000
  });
  assert.notEqual(receiptA.receiptSha256, receiptB.receiptSha256);
  assert.equal(result.resultSha256, observation().results[0].resultSha256);
  assert.throws(() => buildEvaluationReceipt({
    proofSubjectSha256: result.proofSubjectSha256, resultSha256: result.resultSha256,
    startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:00:00.010Z',
    durationMilliseconds: 9, deadlineMilliseconds: 1000
  }), /duration must equal/);
});

test('changed semantic inputs invalidate dependent Results and Proof Summaries transitively', () => {
  const current = observation();
  const invalidation = buildProofInvalidation({
    proofSubjectSha256: current.proofSubject.proofSubjectSha256,
    changedInputs: [candidateSha256],
    results: current.results,
    summaries: [current.summary]
  });
  assert.deepEqual(invalidation.invalidatedResults, [current.results[0].resultSha256]);
  assert.deepEqual(invalidation.invalidatedSummaries, [current.summary.summarySha256]);
  assert.equal(invalidation.reasonCode, 'PFC_INPUT_CHANGED');
  assert.doesNotMatch(JSON.stringify(invalidation), /passportSha256/);
});

test('all M3 families have closed schemas, immutable MIG v1 registrations, and current builders', async () => {
  const registered = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  const current = observation();
  const result = current.results[0];
  const records = {
    'proof-profile-selection': buildProofProfileSelection({
      workId: 'GDP-M3', proofProfile: 'standard', policyRefs: [policySha256], status: 'shadow'
    }),
    'proof-predicate-specification': current.predicateSpecifications[0],
    'proof-predicate-result': result,
    'proof-evaluation-receipt': buildEvaluationReceipt({
      proofSubjectSha256: result.proofSubjectSha256, resultSha256: result.resultSha256,
      startedAt: '2026-09-04T00:00:00Z', completedAt: '2026-09-04T00:00:00.001Z',
      durationMilliseconds: 1, deadlineMilliseconds: 1000
    }),
    'proof-signal-observation': buildSignalObservation({
      proofSubjectSha256: result.proofSubjectSha256, signalId: 'example',
      inputs: [{ kind: 'candidate', sha256: candidateSha256 }], value: true, unit: 'boolean'
    }),
    'proof-summary': current.summary,
    'proof-evidence-invalidation': buildProofInvalidation({
      proofSubjectSha256: result.proofSubjectSha256,
      changedInputs: [candidateSha256], results: current.results, summaries: [current.summary]
    }),
    'proof-gap-item': current.gaps[0],
    'proof-gap-register': current.gapRegister
  };
  for (const [family, record] of Object.entries(records)) {
    assert.equal(currentSchemaVersion(family), 1, family);
    assert.equal(registered.get(family).immutable, true, family);
    assert.deepEqual(validateProofRecord(family, record), record, family);
    assert.equal(readRecord(family, record).storedVersion, 1, family);
    const schema = JSON.parse(await readFile(path.join(repositoryRoot, `schemas/gdp-${family}.schema.json`), 'utf8'));
    assert.equal(schema.additionalProperties, false, family);
    assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort(), family);
    assert.equal(record[schema['x-sflow-selfHash']], `sha256:${recordSha256(Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== schema['x-sflow-selfHash'])
    ))}`, family);
    assert.throws(() => readRecord(family, { ...record, schemaVersion: 2 }), /above this build's readable range/);
  }
  assert.equal(Object.keys(PROOF_RECORD_FAMILIES).length, 9);
  assert.equal(familyForStoredPath(`$git/gdp/operations/${'a'.repeat(64)}/proof-evaluation-receipt/${'b'.repeat(64)}.json`)?.id,
    'proof-evaluation-receipt');
});

test('append store rolls back partial writes, retries idempotently, and retains immutable records', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m3-store-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '-q', '-b', 'GDP-M3-STORE');
  git(repository, 'config', 'user.name', 'GDP M3 Tester');
  git(repository, 'config', 'user.email', 'gdp-m3@example.test');
  await writeFile(path.join(repository, 'README.md'), '# GDP M3 Store\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'initialize');
  const current = observation('GDP-M3-STORE');
  const plan = proofObservationWritePlan(current);
  assert.throws(() => proofObservationWritePlan({
    ...current, predicateSpecifications: current.predicateSpecifications.slice(1)
  }), /no exact Specification/);
  await assert.rejects(() => persistProofObservation(repository, current, {
    fault: async (boundary, { index }) => {
      if (boundary === 'after-proof-record-write' && index === 0) throw new Error('injected crash');
    }
  }), /injected crash/);
  for (const item of plan.records) assert.equal(existsSync(path.join(repository, item.path)), false, item.path);

  const receipt = buildEvaluationReceipt({
    proofSubjectSha256: current.proofSubject.proofSubjectSha256,
    resultSha256: current.results[0].resultSha256,
    startedAt: '2026-09-04T00:00:00Z', completedAt: '2026-09-04T00:00:00.001Z',
    durationMilliseconds: 1, deadlineMilliseconds: 1000
  });
  const foreignReceipt = buildEvaluationReceipt({
    proofSubjectSha256: current.proofSubject.proofSubjectSha256,
    resultSha256: anotherCandidateSha256,
    startedAt: '2026-09-04T00:00:00Z', completedAt: '2026-09-04T00:00:00.001Z',
    durationMilliseconds: 1, deadlineMilliseconds: 1000
  });
  await assert.rejects(() => persistProofObservation(repository, current, {
    evaluationReceipts: [foreignReceipt]
  }), /outside this observation/);
  const first = await persistProofObservation(repository, current, { evaluationReceipts: [receipt] });
  const second = await persistProofObservation(repository, current, { evaluationReceipts: [receipt] });
  assert.deepEqual(first.paths, second.paths);
  assert.equal(first.lifecycleChanged, false);
  assert.equal(first.publicationCreated, false);
  assert.equal(second.operational[0].created, false);
  const summaries = await listProofRecords(repository, 'GDP-M3-STORE', 'proof-summary');
  assert.deepEqual(summaries, [current.summary]);
  assert.deepEqual(await readProofRecord(
    repository, 'GDP-M3-STORE', 'proof-summary', current.summary.summarySha256
  ), current.summary);
});

test('a competing M3 append is serialized or safely refused, then converges on retry', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m3-race-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '-q', '-b', 'GDP-M3-RACE');
  await writeFile(path.join(repository, 'README.md'), '# race\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'initialize');
  const current = observation('GDP-M3-RACE');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = persistProofObservation(repository, current, {
    fault: async (boundary, { index }) => {
      if (boundary === 'after-proof-record-write' && index === 0) await held;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = persistProofObservation(repository, current);
  const secondResult = await second.then(() => 'succeeded', (error) => error.code);
  assert.equal(secondResult, 'SUBJECT_LOCK_BUSY');
  release();
  await first;
  await persistProofObservation(repository, current);
  assert.equal((await listProofRecords(repository, 'GDP-M3-RACE', 'proof-summary')).length, 1);
});

test('proof CLI is read-only, model-free, and leaves Story duration and publication state unchanged', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m3-cli-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'GDP M3 Tester');
  git(repository, 'config', 'user.email', 'gdp-m3@example.test');
  await writeFile(path.join(repository, 'README.md'), '# GDP M3 CLI\n');
  await initializeDefinition(repository);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'initialize');
  git(repository, 'switch', '-qc', 'GDP-M3-CLI');
  const definition = await loadDefinition(repository);
  const workflow = await createWorkflow(repository, definition, {
    id: 'GDP-M3-CLI', title: 'Observe deterministic proof',
    source: {
      type: 'manual', key: 'GDP-M3-CLI', title: 'Observe deterministic proof',
      description: 'Inspect deterministic proof without changing Story lifecycle state.',
      acceptanceCriteria: ['Proof observation does not mutate the Story.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'developer'
  });
  const file = workflowPath(repository, definition, workflow.workItem.id);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.candidate = { candidateSha256 };
  stored.worldModelReference = { manifestSha256: worldModelSha256 };
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  const beforeBytes = await readFile(file, 'utf8');
  const beforeStatus = git(repository, 'status', '--porcelain=v1');
  for (const args of [
    ['proof', 'status', 'GDP-M3-CLI', '--json'],
    ['proof', 'gaps', 'GDP-M3-CLI', '--json'],
    ['proof', 'signals', 'GDP-M3-CLI', '--json'],
    ['proof', 'explain', 'GDP-M3-CLI', 'pfc.candidate-binding', '--json']
  ]) {
    const result = spawnSync(process.execPath, [bin, '--no-model', ...args], {
      cwd: repository, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.operation.classification, 'read');
    assert.equal(response.data.authority, 'none');
    assert.deepEqual(response.effects, {
      stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false
    });
  }
  assert.equal(await readFile(file, 'utf8'), beforeBytes);
  assert.equal(git(repository, 'status', '--porcelain=v1'), beforeStatus);
});

test('M3 proof modules remain absent from lifecycle, gate, approval, and publisher consumers', async () => {
  for (const relative of [
    'src/state.mjs', 'src/governance.mjs', 'src/approval-authority.mjs',
    'src/publication-unit-of-work.mjs', 'src/story-lineage.mjs', 'src/gate.mjs'
  ]) {
    const file = path.join(repositoryRoot, relative);
    if (!existsSync(file)) continue;
    assert.doesNotMatch(await readFile(file, 'utf8'), /proof-(?:kernel|store)\.mjs/u, relative);
  }
  assert.equal(PROOF_KERNEL_LIMITS.maximumPredicates, 64);
  assert.equal(PROOF_KERNEL_LIMITS.maximumDepth, 16);
  assert.equal(PROOF_KERNEL_LIMITS.maximumFanOut, 256);
  const diagnostics = await readFile(path.join(repositoryRoot, 'apps/vscode/src/views/diagnostics.ts'), 'utf8');
  assert.match(diagnostics, /\['proof', 'status', '--json'\]/);
  assert.match(diagnostics, /Deterministic proof observation/);
  assert.match(diagnostics, /Signals cannot approve, publish, or change Story state/);
});
