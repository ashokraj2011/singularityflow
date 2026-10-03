import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSpecIndex, canonicalJson, deriveObservedClaimMap, normalizeClaimMap
} from '../src/specifications.mjs';
import { inspectUnclaimedChangedPaths } from '../src/spec-coverage-preview.mjs';
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

async function fixture({ baselineFirst = false, supportingFiles = [], steps = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-code-coverage-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Coverage Test');
  git(root, 'config', 'user.email', 'coverage@example.invalid');
  await write(root, 'README.md', '# Project\n');
  if (baselineFirst) await write(root, 'src/first.mjs', 'export const first = false;\n');
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
        testReason: 'The required compile-time contract is checked without a runtime test.',
        ...(steps ? { steps: [steps[0]] } : {})
      },
      'COVER-1:REQ-002': {
        expectedPaths: ['src/second.mjs'], tests: [], testDisposition: 'not-applicable',
        testReason: 'The required compile-time contract is checked without a runtime test.',
        ...(steps ? { steps: [steps[1]] } : {})
      }
    }, supportingFiles }, { kind: 'planned', clauseIds: ids }),
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

test('an earlier code step answers for the rows allocated to it, and only those', async () => {
  const { root, config, workflow } = await fixture({ steps: ['implementation', 'finalization'] });
  workflow.phases.finalization = { id: 'finalization', generation: 0, requiredArtifact: { kind: 'implementation-summary' } };
  workflow.phaseOrder.push('finalization');
  workflow.resolution.plannedClaims.owners.finalization = 'planning';
  const revision = git(root, 'rev-parse', 'HEAD');
  // REQ-001 is allocated here and implemented; REQ-002 belongs to the later step.
  const coverage = await assertFinalCodeSpecificationCoverage(root, config, workflow, workflow.phases.implementation, revision);
  assert.deepEqual(coverage.unimplemented, ['COVER-1:REQ-002']);

  const swapped = await fixture({ steps: ['finalization', 'implementation'] });
  swapped.workflow.phases.finalization = { id: 'finalization', generation: 0, requiredArtifact: { kind: 'implementation-summary' } };
  swapped.workflow.phaseOrder.push('finalization');
  swapped.workflow.resolution.plannedClaims.owners.finalization = 'planning';
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(swapped.root, swapped.config, swapped.workflow, swapped.workflow.phases.implementation,
      git(swapped.root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE' && error.details.open.join() === 'COVER-1:REQ-002'
      && /rows the plan allocates to it are not implemented/.test(error.message)
  );
});

test('final code approval refuses a claimed source path reverted to its pre-Story bytes', async () => {
  const { root, config, workflow, observedRecord } = await fixture({ baselineFirst: true });
  const finalPath = `${ITEM}/context/claims/finalization-gen1-observed.json`;
  workflow.phaseOrder.push('finalization');
  workflow.resolution.plannedClaims.owners.finalization = 'planning';
  const phase = workflow.phases.finalization = {
    id: 'finalization', generation: 1,
    requiredArtifact: { kind: 'implementation-summary' },
    claimMaps: { observed: { path: finalPath, generation: 1 } }
  };
  await write(root, 'src/first.mjs', 'export const first = false;\n');
  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  const observed = { ...observedRecord(['src/first.mjs', 'src/second.mjs']), phase: 'finalization' };
  await write(root, finalPath, canonicalJson(observed));
  phase.claimMaps.observed.sha256 = digest(observed);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'revert first clause while implementing second');

  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.invalidEvidence.some((message) =>
        message.includes('COVER-1:REQ-001') && message.includes('src/first.mjs'))
  );
});

test('final code approval retains exact source deletion as implementation evidence', async () => {
  const { root, config, workflow, observedPath, observedRecord } = await fixture({ baselineFirst: true });
  const phase = workflow.phases.implementation;
  await unlink(path.join(root, 'src/first.mjs'));
  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  const observed = observedRecord(['src/first.mjs', 'src/second.mjs']);
  await write(root, observedPath, canonicalJson(observed));
  phase.claimMaps.observed.sha256 = digest(observed);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'delete obsolete first source and implement second');

  const coverage = await assertFinalCodeSpecificationCoverage(
    root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')
  );
  assert.equal(coverage.complete, true);
});

test('a changed file the plan lists under Supporting files needs no clause, and prepublish names any other', async () => {
  const { root, config, workflow, observedPath, observedRecord } = await fixture({ supportingFiles: ['package.json'] });
  const phase = workflow.phases.implementation;
  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  await write(root, 'package.json', '{ "name": "ledger", "dependencies": { "ledger-client": "1.0.0" } }\n');
  await write(root, 'Makefile', 'build:\n\ttrue\n');
  const complete = observedRecord(['src/first.mjs', 'src/second.mjs']);
  await write(root, observedPath, canonicalJson(complete));
  phase.claimMaps.observed.sha256 = digest(complete);

  // Before submission: the preview names the one path approval would refuse.
  const preview = await inspectUnclaimedChangedPaths(root, config, workflow, phase);
  assert.equal(preview.coverage.status, 'unclaimed');
  assert.deepEqual(preview.advisories.map((advisory) => advisory.path), ['Makefile']);
  assert.equal(preview.advisories[0].blocking, false);
  assert.match(preview.advisories[0].message, /not under the plan's Supporting files; approving this phase would refuse it/);

  git(root, 'add', '.');
  git(root, 'commit', '-m', 'complete with supporting files');
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.unclaimedChangedPaths.join() === 'Makefile'
      && error.details.coverage.supportingChangedPaths.join() === 'package.json'
  );
  git(root, 'rm', '-q', 'Makefile');
  git(root, 'commit', '-q', '-m', 'drop the unplanned change');
  const coverage = await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD'));
  assert.equal(coverage.complete, true);
  assert.equal((await inspectUnclaimedChangedPaths(root, config, workflow, phase)).coverage.status, 'ready');
});
