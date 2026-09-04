import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bindReviewedJunit5Witnesses,
  buildEnvironmentAttestation, buildEnvironmentProfile, buildImpactDisposition,
  buildImpactShouldSet, buildNondeterminismProfile, M4_RECORD_FAMILIES,
  observeProofInputs, validateM4Record
} from '../src/delivery-modes/proof-observations.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot, readRecord
} from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (character) => `sha256:${character.repeat(64)}`;
const proofSubject = Object.freeze({
  proofSubjectSha256: digest('a'), candidateSha256: digest('b'),
  worldModel: {
    status: 'ready', baselineSha256: digest('c'), candidateDeltaSha256: digest('d'),
    reasonCode: null
  }
});

function observation(overrides = {}) {
  return observeProofInputs({
    proofSubject, policySha256: digest('e'),
    clauses: [{
      clauseId: 'GDP:AC-001', bodySha256: digest('f'), structural: true, witnessed: true
    }],
    checklistDecisions: [
      { article: 'completeness', decision: 'satisfied' },
      { article: 'ambiguity', decision: 'exception' }
    ],
    shouldSetItems: [{
      itemId: 'impact-1', resource: 'src/payment.java', basisSha256: digest('1'),
      status: 'observed'
    }],
    environment: {
      platform: 'linux', architecture: 'x64', runtime: 'java-21',
      toolchainSha256: digest('2'), dependencyLockSha256: digest('3'),
      localePolicy: 'en-US', clockPolicy: 'fixed'
    },
    junit: {
      adapter: 'junit5-surefire-v1', commandSha256: digest('4'), resultSha256: digest('5'),
      discovered: 2, failed: 0, skipped: 0, exact: false,
      retriesObserved: false, teardownProven: false, oracleProven: false,
      gaps: ['EXACT_STATIC_TEST_IDENTITY_UNAVAILABLE'],
      outcomes: [{ attempt: 1, resultSha256: digest('5'), outcome: 'passed' }]
    },
    ...overrides
  });
}

test('M4 keeps reviewer judgement, local Surefire names, and optional structure out of proof', () => {
  const current = observation();
  assert.equal(current.authority, 'none');
  assert.equal(current.gateEligible, false);
  assert.equal(current.clauses[0].status, 'observed');
  assert.equal(current.checklist.find((entry) => entry.article === 'completeness').status, 'reviewed');
  assert.equal(current.checklist.find((entry) => entry.article === 'consistency').status, 'human-review-required');
  assert.equal(current.environmentAttestation.status, 'unavailable');
  assert.ok(current.environmentAttestation.gaps.includes('TESTCASE_IDENTITY_NOT_EXACT'));
  assert.equal(current.nondeterminism.status, 'unavailable');
  assert.ok(current.gaps.includes('IMMEDIATE_RERUN_UNAVAILABLE'));
  assert.equal(current.guarantees.noModel, true);
  assert.equal(current.guarantees.astRequired, false);
  assert.equal(current.guarantees.worldModelRequired, false);
  assert.equal(current.guarantees.consumedByLifecycle, false);
  assert.deepEqual(observation(), current);
});

test('M4 World Model absence and unsupported test inputs are explicit and non-blocking', () => {
  const current = observation({
    proofSubject: {
      ...proofSubject,
      worldModel: {
        status: 'unavailable', baselineSha256: null, candidateDeltaSha256: null,
        reasonCode: 'GDP_WORLD_MODEL_UNAVAILABLE'
      }
    },
    clauses: [], checklistDecisions: [], shouldSetItems: [], environment: null, junit: null
  });
  assert.equal(current.shouldSet.worldModel.status, 'unavailable');
  assert.ok(current.gaps.includes('WORLD_MODEL_UNAVAILABLE_NON_BLOCKING'));
  assert.ok(current.gaps.includes('JUNIT5_SUREFIRE_OBSERVATION_UNAVAILABLE'));
  assert.equal(current.environmentAttestation, null);
  assert.equal(current.observationSha256, `sha256:${recordSha256(Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== 'observationSha256')
  ))}`);
});

test('M4 exact adapter inputs can pass, while skipped or contradictory reruns cannot', () => {
  const exact = observation({
    junit: {
      adapter: 'junit5-surefire-v1', commandSha256: digest('4'), resultSha256: digest('5'),
      discovered: 2, failed: 0, skipped: 0, exact: true,
      retriesObserved: false, teardownProven: true, oracleProven: true, gaps: [],
      outcomes: [
        { attempt: 1, resultSha256: digest('5'), outcome: 'passed' },
        { attempt: 2, resultSha256: digest('6'), outcome: 'passed' }
      ]
    }
  });
  assert.equal(exact.environmentAttestation.status, 'passed');
  assert.equal(exact.nondeterminism.status, 'stable');
  const conflict = observation({
    junit: {
      adapter: 'junit5-surefire-v1', commandSha256: digest('4'), resultSha256: digest('5'),
      discovered: 2, failed: 0, skipped: 1, exact: true,
      retriesObserved: true, teardownProven: true, oracleProven: true, gaps: [],
      outcomes: [
        { attempt: 1, resultSha256: digest('5'), outcome: 'passed' },
        { attempt: 2, resultSha256: digest('6'), outcome: 'failed' }
      ]
    }
  });
  assert.equal(conflict.environmentAttestation.status, 'unavailable');
  assert.equal(conflict.nondeterminism.status, 'conflicting');
});

test('reviewed JUnit 5 binder upgrades only unique exact declarations with an oracle', () => {
  const source = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    'final class InterestTest {',
    '  @Test void calculatesInterest() { assertEquals(12, 6 + 6); }',
    '}'
  ].join('\n');
  const exact = bindReviewedJunit5Witnesses([
    { path: 'src/test/java/example/InterestTest.java', contents: source }
  ], [{ className: 'example.InterestTest', name: 'calculatesInterest', outcome: 'passed' }]);
  assert.equal(exact.exact, true);
  assert.equal(exact.bindings.length, 1);
  assert.match(exact.bindings[0].declarationSha256, /^sha256:[a-f0-9]{64}$/);

  const noOracle = bindReviewedJunit5Witnesses([
    { path: 'src/test/java/example/InterestTest.java', contents: source.replace('assertEquals(12, 6 + 6);', 'int result = 6 + 6;') }
  ], [{ className: 'example.InterestTest', name: 'calculatesInterest', outcome: 'passed' }]);
  assert.equal(noOracle.exact, false);
  assert.ok(noOracle.gaps.includes('ORACLE_IDENTITY_UNAVAILABLE'));

  const displayOnly = bindReviewedJunit5Witnesses([
    { path: 'src/test/java/example/InterestTest.java', contents: source }
  ], [{ className: null, name: 'calculatesInterest', outcome: 'passed' }]);
  assert.equal(displayOnly.exact, false);
  assert.ok(displayOnly.gaps.includes('REPORT_TEST_IDENTITY_UNAVAILABLE'));

  const parameterized = bindReviewedJunit5Witnesses([
    { path: 'src/test/java/example/InterestTest.java', contents: source.replace('@Test', '@ParameterizedTest') }
  ], [{ className: 'example.InterestTest', name: 'calculatesInterest', outcome: 'passed' }]);
  assert.equal(parameterized.exact, false);
  assert.ok(parameterized.gaps.includes('UNSUPPORTED_JUNIT5_CONSTRUCT'));
});

test('all M4 families have closed schemas, immutable MIG identities, and bounded builders', async () => {
  const subject = proofSubject.proofSubjectSha256;
  const shouldSet = buildImpactShouldSet({
    proofSubjectSha256: subject, policySha256: digest('e'), worldModel: proofSubject.worldModel,
    items: [], assurance: 'observed'
  });
  const profile = buildEnvironmentProfile({
    proofSubjectSha256: subject, platform: 'linux', architecture: 'x64', runtime: 'java-21'
  });
  const records = {
    'impact-should-set': shouldSet,
    'impact-disposition': buildImpactDisposition({
      proofSubjectSha256: subject, shouldSetSha256: shouldSet.shouldSetSha256,
      decidedBy: { kind: 'human', identitySha256: digest('7'), authoritySha256: null },
      items: [{ itemId: 'impact-1', disposition: 'claimed', reason: 'Covered by the reviewed scope.' }]
    }),
    'environment-profile': profile,
    'environment-attestation': buildEnvironmentAttestation({
      proofSubjectSha256: subject, candidateSha256: digest('b'),
      environmentProfileSha256: profile.profileSha256, commandSha256: digest('4'),
      adapter: 'junit5-surefire-v1', resultSha256: null, status: 'unavailable',
      gaps: ['TESTCASE_IDENTITY_NOT_EXACT']
    }),
    'nondeterminism-profile': buildNondeterminismProfile({
      proofSubjectSha256: subject, witnessSha256: digest('5'), attempts: 0, outcomes: [],
      status: 'unavailable', gaps: ['IMMEDIATE_RERUN_UNAVAILABLE']
    })
  };
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const [family, record] of Object.entries(records)) {
    assert.equal(currentSchemaVersion(family), 1, family);
    assert.equal(registry.get(family).immutable, true, family);
    assert.deepEqual(validateM4Record(family, record), record, family);
    assert.equal(readRecord(family, record).storedVersion, 1, family);
    const schema = JSON.parse(await readFile(path.join(root, `schemas/gdp-${family}.schema.json`), 'utf8'));
    assert.equal(schema.additionalProperties, false, family);
    assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort(), family);
    assert.throws(() => validateM4Record(family, { ...record, unexpected: true }), /invalid field set/);
  }
  assert.equal(Object.keys(M4_RECORD_FAMILIES).length, 5);
  assert.equal(familyForStoredPath(
    `singularity/work-items/WRK/gdp/evidence/environment-attestation/${'a'.repeat(64)}.json`
  )?.id, 'environment-attestation');
});
