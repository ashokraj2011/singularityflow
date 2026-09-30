import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSpecIndex, canonicalJson, deriveObservedClaimMap, normalizeClaimMap
} from '../src/specifications.mjs';
import { assertFinalCodeSpecificationCoverage } from '../src/state.mjs';

const ID = 'COVER-1';
const ITEM = `singularity/work-items/${ID}`;
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-code-coverage-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Coverage Test');
  git(root, 'config', 'user.email', 'coverage@example.invalid');
  await write(root, 'README.md', '# Project\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const baseCommit = git(root, 'rev-parse', 'HEAD');

  const sourcePath = `${ITEM}/artifacts/specification/spec.md`;
  await write(root, sourcePath, [
    '# Specification', '',
    '## Requirements', '',
    '[COVER-1:REQ-001]', 'Implement the first behavior.', '',
    '[COVER-1:REQ-002]', 'Implement the second behavior.', ''
  ].join('\n'));
  const indexPath = `${ITEM}/context/spec-indexes/specification-gen1.json`;
  const index = await buildSpecIndex(root, sourcePath, {
    workId: ID, phase: 'specification', generation: 1, outputPath: indexPath,
    policy: { mode: 'enforce', coverage: 'enforce' }
  });
  const ids = index.clauses.map((clause) => clause.id);
  const plannedPath = `${ITEM}/context/claims/planning-gen1-planned.json`;
  const planned = {
    ...normalizeClaimMap({ claims: {
      'COVER-1:REQ-001': {
        expectedPaths: ['src/first.mjs'], tests: [], testDisposition: 'not-applicable',
        testReason: 'The required compile-time contract is checked without a runtime test.'
      },
      'COVER-1:REQ-002': {
        expectedPaths: ['src/second.mjs'], tests: [], testDisposition: 'not-applicable',
        testReason: 'The required compile-time contract is checked without a runtime test.'
      }
    } }, { kind: 'planned', clauseIds: ids }),
    workId: ID, phase: 'planning', generation: 1
  };
  await write(root, plannedPath, canonicalJson(planned));

  await write(root, 'src/first.mjs', '// @clause:COVER-1:REQ-001\nexport const first = true;\n');
  const observedPath = `${ITEM}/context/claims/implementation-gen1-observed.json`;
  const observedRecord = (paths) => ({
    ...deriveObservedClaimMap(planned, {
      sourcePaths: paths,
      traceability: { sourceBindings: paths.map((sourcePath) => ({
        clauseId: sourcePath === 'src/first.mjs' ? 'COVER-1:REQ-001' : 'COVER-1:REQ-002',
        sourcePath
      })) }
    }, { clauseIds: ids, requireSourceBindings: true, generationCommit: baseCommit }),
    workId: ID, phase: 'implementation', generation: 1
  });
  const observed = observedRecord(['src/first.mjs']);
  await write(root, observedPath, canonicalJson(observed));
  const workflow = {
    workItem: { id: ID, workType: 'spec-driven-standard', baseCommit, baseBranch: 'main' },
    phaseOrder: ['specification', 'planning', 'implementation'],
    resolution: {
      spec: { mode: 'enforce', coverage: 'enforce' },
      plannedClaims: {
        mode: 'required', clausePhases: ['specification'],
        owners: { implementation: 'planning' }
      }
    },
    phases: {
      specification: {
        id: 'specification', generation: 1,
        requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'requirements' },
        artifacts: [{ path: sourcePath, status: 'approved', sha256: index.source.sha256, size: index.source.bytes }],
        specIndex: {
          path: indexPath, generation: 1, clauses: index.clauses.length,
          indexSha256: index.indexSha256, sourceSha256: index.source.sha256
        }
      },
      planning: {
        id: 'planning', generation: 1,
        claimMaps: { planned: { path: plannedPath, generation: 1, sha256: digest(planned) } }
      },
      implementation: {
        id: 'implementation', generation: 1,
        requiredArtifact: { kind: 'implementation-summary' },
        claimMaps: { observed: { path: observedPath, generation: 1, sha256: digest(observed) } }
      }
    }
  };
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'partial implementation evidence');
  return { root, config: { workItemRoot: 'singularity/work-items' }, workflow, observedPath, observedRecord };
}

test('final code approval refuses incomplete pinned clause coverage, then accepts exact completion', async () => {
  const { root, config, workflow, observedPath, observedRecord } = await fixture();
  const phase = workflow.phases.implementation;
  const partialCommit = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, partialCommit),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.unimplemented.includes('COVER-1:REQ-002')
      && /COVER-1:REQ-002/.test(error.message)
  );
  assert.equal(git(root, 'status', '--porcelain'), '', 'the refusal changed committed evidence');

  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  const complete = observedRecord(['src/first.mjs', 'src/second.mjs']);
  await write(root, observedPath, canonicalJson(complete));
  phase.claimMaps.observed.sha256 = digest(complete);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'complete second clause');
  const coverage = await assertFinalCodeSpecificationCoverage(
    root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')
  );
  assert.equal(coverage.complete, true);
  assert.equal(coverage.totals.observed, 2);

  // A changed source-bound claim after submission cannot be quietly accepted at approval.
  await write(root, observedPath, `${await readFile(path.join(root, observedPath), 'utf8')}\n`);
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPECIFICATION_INPUT_NOT_COMMITTED'
  );
});

test('historical and intermediate code phases retain their pinned coverage boundary', async () => {
  const { root, config, workflow } = await fixture();
  const phase = workflow.phases.implementation;
  const revision = git(root, 'rev-parse', 'HEAD');
  workflow.resolution.spec.coverage = 'off';
  assert.equal(await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, revision), null);
  workflow.resolution.spec.coverage = 'enforce';
  workflow.phases.finalization = {
    id: 'finalization', generation: 0,
    requiredArtifact: { kind: 'implementation-summary' }
  };
  workflow.phaseOrder.push('finalization');
  assert.equal(await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, revision), null);
});
