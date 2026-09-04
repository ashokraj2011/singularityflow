import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildProofGapAcceptance, evaluateLocalHermeticEvidence, M9_RECORD_FAMILIES,
  validateHighAssuranceRecord
} from '../src/delivery-modes/high-assurance.mjs';
import {
  currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot
} from '../src/schema-migrations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;

function evidence({ executionOutcome = 'passed', sameWitness = false, executions = true } = {}) {
  return {
    schemaVersion: 1,
    kind: 'gdp-local-hermetic-evidence',
    workId: 'GDP-M9',
    proofSubjectSha256: digest('a'),
    candidateSha256: digest('b'),
    regions: [{
      resourceIdSha256: digest('c'), regionSha256: digest('d'), executable: true, required: true
    }],
    executions: executions ? [{
      regionSha256: digest('d'), testIdentitySha256: digest('e'),
      resultSha256: digest('f'), outcome: executionOutcome
    }] : [],
    witnesses: [{
      witnessSha256: digest('1'), authorIdentitySha256: digest('2'),
      executorIdentitySha256: sameWitness ? digest('2') : digest('3')
    }],
    mutations: [{
      mutationIdSha256: digest('4'), targetRegionSha256: digest('d'),
      resultSha256: digest('5'), outcome: 'killed'
    }]
  };
}

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'GDP M9 Tester'
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}
function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }

test('M9 evaluates path-free local evidence without granting runner or lifecycle authority', () => {
  const result = evaluateLocalHermeticEvidence(evidence());
  assert.equal(result.mode, 'observe');
  assert.equal(result.authority, 'none');
  assert.equal(result.coverage.status, 'passed');
  assert.equal(result.independence.status, 'independent');
  assert.equal(result.verdict, 'observed-sufficient');
  assert.deepEqual(result.gaps, ['RUNNER_AUTHENTICATION_UNAVAILABLE']);
  assert.deepEqual(result.guarantees, {
    executesProductCode: false, noModel: true, pathFree: true,
    gateEligible: false, consumedByLifecycle: false
  });
  assert.equal(result.mutationObservations[0].authority, 'none');
  assert.equal(result.mutationObservations[0].gateEligible, false);
  assert.doesNotMatch(JSON.stringify(result), /(?:\/Users\/|[A-Za-z]:\\)/);
});

test('M9 preserves failed, unavailable, conflicting, and malformed observations', () => {
  assert.equal(evaluateLocalHermeticEvidence(evidence({ executionOutcome: 'failed' })).coverage.status, 'failed');
  assert.equal(evaluateLocalHermeticEvidence(evidence({ executions: false })).coverage.status, 'unavailable');
  assert.equal(evaluateLocalHermeticEvidence(evidence({ sameWitness: true })).independence.status, 'conflicting');
  const unknown = evidence();
  unknown.executions[0].regionSha256 = digest('9');
  assert.throws(() => evaluateLocalHermeticEvidence(unknown), /unknown changed region/);
});

test('M9 gap acceptance is an explicit expiring human decision and never implicit authority', () => {
  const record = buildProofGapAcceptance({
    workId: 'GDP-M9', proofSubjectSha256: digest('a'), gapSha256: digest('b'),
    decision: 'accepted-with-exception', reasonSha256: digest('c'),
    decidedBy: {
      kind: 'human', identitySha256: digest('d'), authoritySha256: digest('e')
    },
    expiresAt: '2027-01-01T00:00:00.000Z'
  });
  assert.deepEqual(validateHighAssuranceRecord('proof-gap-acceptance', record), record);
  assert.throws(() => buildProofGapAcceptance({
    workId: 'GDP-M9', proofSubjectSha256: digest('a'), gapSha256: digest('b'),
    decision: 'accepted-with-exception', reasonSha256: digest('c'),
    decidedBy: { kind: 'agent', identitySha256: digest('d'), authoritySha256: digest('e') },
    expiresAt: '2027-01-01T00:00:00.000Z'
  }), /requires human authority/);
});

test('M9 families are closed immutable v1 identities at the reserved paths', async () => {
  const records = evaluateLocalHermeticEvidence(evidence());
  const values = {
    'executable-change-map': records.changeMap,
    'changed-region-coverage': records.coverage,
    'witness-independence': records.independence,
    'mutation-observation': records.mutationObservations[0],
    'proof-gap-acceptance': buildProofGapAcceptance({
      workId: 'GDP-M9', proofSubjectSha256: digest('a'), gapSha256: digest('b'),
      decision: 'rejected', reasonSha256: digest('c'),
      decidedBy: { kind: 'human', identitySha256: digest('d'), authoritySha256: digest('e') },
      expiresAt: '2027-01-01T00:00:00.000Z'
    })
  };
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const [family, [, fields]] of Object.entries(M9_RECORD_FAMILIES)) {
    assert.equal(currentSchemaVersion(family), 1);
    assert.equal(registry.get(family).immutable, true);
    assert.deepEqual(Object.keys(values[family]).sort(), [...fields].sort());
    assert.deepEqual(validateHighAssuranceRecord(family, values[family]), values[family]);
    const schema = JSON.parse(await readFile(path.join(repositoryRoot, 'schemas', `gdp-${family}.schema.json`), 'utf8'));
    assert.deepEqual(Object.keys(values[family]).sort(), [...schema.required].sort());
    const plane = family === 'proof-gap-acceptance' ? 'decisions' : 'evidence';
    assert.equal(familyForStoredPath(
      `singularity/work-items/GDP-M9/gdp/${plane}/${family}/${'a'.repeat(64)}.json`
    )?.id, family);
  }
});

test('M9 CLI is a read-only model-free evaluation over a repository-relative input', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m9-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP M9 Tester');
  git(root, 'config', 'user.email', 'gdp-m9@example.com');
  sflow(root, 'init');
  await writeFile(path.join(root, 'evidence.json'), `${JSON.stringify(evidence(), null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize GDP M9 fixture');
  const before = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const output = JSON.parse(sflow(
    root, 'delivery', 'assurance-evaluate', '--evidence-file', 'evidence.json', '--json'
  ).stdout);
  assert.equal(output.data.coverage.status, 'passed');
  assert.equal(output.data.authority, 'none');
  assert.equal(output.effects.stateChanged, false);
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), before);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
});
