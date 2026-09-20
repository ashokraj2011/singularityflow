import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildCodeExplanation } from '../src/comprehension/code-explanation.mjs';
import { buildChangeRegionManifest } from '../src/comprehension/contracts.mjs';
import { buildComprehensionDiffPreview } from '../src/comprehension/diff-preview.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

const SHA = (character) => `sha256:${character.repeat(64)}`;

function canonicalHash(value) {
  return `sha256:${recordSha256(value)}`;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function cachedStructure(symbols) {
  const core = {
    schemaVersion: 1,
    kind: 'ast-cached-symbol-projection',
    authoritative: false,
    lifecycleGate: false,
    status: 'available',
    reason: null,
    assurance: 'syntax',
    symbols,
    counts: {
      requestedPaths: 3, selectedPaths: 3, cacheHits: 3, cacheMisses: 0,
      symbols: symbols.length
    },
    truncated: false
  };
  return { ...core, projectionSha256: canonicalHash(core) };
}

function graphFor(manifest, region) {
  const causeId = 'cause:acceptance-clause:AC-2';
  const regionId = `region:${region.regionSha256}`;
  const core = {
    schemaVersion: 1,
    kind: 'comprehension-intent-graph',
    authoritative: false,
    authority: 'unverified-observation',
    lifecycleGate: false,
    candidateBinding: manifest.candidateBinding,
    candidateSha256: manifest.compatibilityCandidateSha256,
    manifestSha256: manifest.manifestSha256,
    coverageResultSha256: SHA('9'),
    nodes: [{
      id: causeId,
      type: 'cause',
      causeKind: 'acceptance-clause',
      causeId: 'AC-2',
      statement: 'Exercise the changed service path.',
      statementSha256: SHA('8'),
      authorityRecordSha256: SHA('7'),
      authorityStatus: 'approved'
    }, {
      id: regionId,
      type: 'change-region',
      regionId: region.regionId,
      regionSha256: region.regionSha256,
      pathBefore: region.location.pathBefore,
      pathAfter: region.location.pathAfter,
      operation: region.operation,
      assurance: 'diff-derived'
    }],
    edges: [{
      id: `edge:test:${region.regionSha256}`,
      type: 'cause-to-change-region',
      from: causeId,
      to: regionId,
      relationship: 'implements',
      bindingSha256: SHA('6'),
      confirmationDecisionSha256: SHA('5')
    }],
    counts: { nodes: 2, causes: 1, regions: 1, edges: 1 },
    availability: {
      causeGraph: 'available', structure: 'unavailable',
      structureReason: 'resource-fallback-no-ast-required', durableAuthority: 'unavailable'
    },
    diagnosticCodes: []
  };
  return { ...core, graphSha256: canonicalHash(core) };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-code-explanation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Code Explanation');
  git(root, 'config', 'user.email', 'code-explanation@example.test');
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'bin'));
  const baseline = Array.from({ length: 40 }, (_, index) => {
    if (index === 0) return 'export function service() {';
    if (index === 39) return '}';
    return `  const line${index + 1} = ${index + 1};`;
  });
  await writeFile(path.join(root, 'src', 'service.js'), `${baseline.join('\n')}\n`);
  await writeFile(path.join(root, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(root, 'bin', 'run.sh'), 0o644);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');

  const changed = [...baseline];
  changed[1] = '  const line2 = 200;';
  changed[34] = '  const line35 = 3500;';
  await writeFile(path.join(root, 'src', 'service.js'), `${changed.join('\n')}\n`);
  await chmod(path.join(root, 'bin', 'run.sh'), 0o755);
  await writeFile(path.join(root, 'src', 'untracked.js'), 'export const privateLocal = true;\n');

  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: 'HEAD', subject: { kind: 'comprehension-observation' }
  });
  const manifest = buildChangeRegionManifest(changeSet);
  const diff = buildComprehensionDiffPreview(root, changeSet);
  const serviceRegion = manifest.regions.find((region) => region.location.pathAfter === 'src/service.js');
  const structure = cachedStructure([{
    id: 'src/service.js#unrelated',
    name: 'unrelated',
    qualifiedName: 'fixture.unrelated',
    declarationKind: 'function',
    signature: 'function unrelated()',
    path: 'src/service.js',
    line: 20,
    assurance: 'syntax',
    extractor: 'fixture-syntax'
  }, {
    id: 'src/service.js#service',
    name: 'service',
    qualifiedName: 'fixture.service',
    declarationKind: 'function',
    signature: 'function service()',
    path: 'src/service.js',
    line: 1,
    assurance: 'syntax',
    extractor: 'fixture-syntax'
  }, {
    id: 'bin/run.sh#run',
    name: 'run',
    qualifiedName: null,
    declarationKind: 'script',
    signature: null,
    path: 'bin/run.sh',
    line: 1,
    assurance: 'text',
    extractor: 'fixture-text'
  }]);
  return {
    context: {
      base: changeSet.base.commit,
      source: 'working-tree-head',
      workId: 'PAY-142',
      phase: 'implement',
      repository: '/machine-specific/path/must-not-escape'
    },
    manifest,
    diff,
    structure,
    evidence: null,
    graph: graphFor(manifest, serviceRegion)
  };
}

test('XPL enumerates exact hunks and opaque regions without promoting unavailable authority', async (t) => {
  const input = await fixture(t);
  const explanation = buildCodeExplanation(input);

  assert.equal(explanation.kind, 'comprehension-code-explanation');
  assert.equal(explanation.mode, 'observe-only');
  assert.equal(explanation.authoritative, false);
  assert.equal(explanation.authority, 'none');
  assert.equal(explanation.lifecycleGate, false);
  assert.equal(explanation.candidate.sha256, input.manifest.compatibilityCandidateSha256);
  assert.equal(explanation.candidate.truth, 'working-tree');
  assert.deepEqual(explanation.candidate.context, {
    workId: 'PAY-142', phase: 'implement', base: input.context.base, source: 'working-tree-head'
  });
  assert.doesNotMatch(JSON.stringify(explanation), /machine-specific/u);

  assert.deepEqual(explanation.counts, {
    regions: 3,
    trackedFiles: 2,
    untrackedRegions: 1,
    unclassifiedRegions: 0,
    diffHunks: 2,
    opaqueUnits: 2,
    explanationUnits: 4,
    declarationLinks: 1,
    causeBoundHunks: 0,
    unexplainedHunks: 2,
    returnedUnits: 4,
    returnedHunks: 2,
    returnedOpaqueUnits: 2
  });
  const hunks = explanation.whyEachChange.filter((unit) => unit.unitKind === 'diff-hunk');
  assert.deepEqual(hunks.map((unit) => unit.unitId), ['H-001', 'H-002']);
  assert.deepEqual(hunks.map((unit) => unit.hunk.header), input.diff.files
    .find((file) => file.pathAfter === 'src/service.js').hunks.map((hunk) => hunk.header));
  assert.deepEqual(explanation.unexplained.hunkIds, ['H-001', 'H-002']);
  assert.ok(hunks.every((unit) => unit.explanationStatus === 'unexplained'));
  assert.deepEqual(hunks[0].declarations.map((symbol) => symbol.name), ['service']);
  assert.equal(hunks[0].declarations[0].match, 'declaration-line-overlap');
  assert.deepEqual(hunks[1].declarations, []);
  assert.equal(hunks[1].structure.reason, 'no-declaration-line-overlap');
  assert.ok(hunks.every((unit) => unit.cause.status === 'unavailable'));
  assert.ok(hunks.every((unit) => unit.cause.reason === 'region-cause-not-hunk-bound'));
  assert.ok(hunks.every((unit) => unit.cause.references.every((reference) => reference.hunkBound === false)));

  const opaque = explanation.whyEachChange.filter((unit) => unit.unitKind !== 'diff-hunk');
  assert.deepEqual(opaque.map((unit) => unit.unitKind).sort(), [
    'tracked-file-opaque', 'untracked-region-opaque'
  ]);
  assert.equal(opaque.find((unit) => unit.unitKind === 'tracked-file-opaque').opacity.reason,
    'tracked-file-has-no-text-hunks');
  assert.equal(opaque.find((unit) => unit.unitKind === 'untracked-region-opaque').opacity.reason,
    'untracked-content-not-projected');
  assert.equal(explanation.impact.status, 'unavailable');
  assert.equal(explanation.impact.truth, null);
  assert.equal(explanation.proof.status, 'unavailable');
  assert.deepEqual(explanation.proof.vocabulary, ['passed-current', 'ready', 'owed', 'stale']);
  assert.doesNotMatch(JSON.stringify(explanation.proof), /\bmet\b/iu);
  assert.equal(explanation.availability.cause.status, 'unavailable');
  assert.equal(explanation.availability.structure.status, 'partial');
  assert.equal(Object.isFrozen(explanation.whyEachChange), true);
  assert.equal(Object.isFrozen(explanation.whyEachChange[0]), true);

  const { explanationSha256, ...core } = explanation;
  assert.equal(explanationSha256, canonicalHash(core));
  assert.match(explanation.explanationSetSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('XPL is byte-stable and drill-downs preserve the exact computed unit records', async (t) => {
  const input = await fixture(t);
  const first = buildCodeExplanation(input);
  const reorderedDiff = { ...input.diff, files: [...input.diff.files].reverse() };
  const second = buildCodeExplanation({ ...structuredClone(input), diff: reorderedDiff });
  assert.equal(canonicalJson(first), canonicalJson(second));

  const byHunk = buildCodeExplanation(input, { hunk: 'H-002' });
  assert.equal(byHunk.query.status, 'available');
  assert.equal(byHunk.counts.returnedUnits, 1);
  assert.equal(byHunk.whyEachChange[0].explanationUnitSha256,
    first.whyEachChange.find((unit) => unit.unitId === 'H-002').explanationUnitSha256);
  assert.equal(byHunk.explanationSetSha256, first.explanationSetSha256);

  const bySymbol = buildCodeExplanation(input, { symbol: 'service' });
  assert.deepEqual(bySymbol.whyEachChange.map((unit) => unit.unitId), ['H-001']);
  assert.equal(bySymbol.whyEachChange[0].explanationUnitSha256,
    first.whyEachChange.find((unit) => unit.unitId === 'H-001').explanationUnitSha256);

  const byClause = buildCodeExplanation(input, { clause: 'AC-2' });
  assert.deepEqual(byClause.whyEachChange.map((unit) => unit.unitId), ['H-001', 'H-002']);
  assert.ok(byClause.whyEachChange.every((unit) => unit.cause.status === 'unavailable'));

  const unknown = buildCodeExplanation(input, { clause: 'AC-404' });
  assert.equal(unknown.status, 'unavailable');
  assert.equal(unknown.reason, 'drilldown-subject-unavailable');
  assert.deepEqual(unknown.whyEachChange, []);
  assert.equal(unknown.counts.diffHunks, 2, 'drill-down totals retain the complete projection counts');
  assert.equal(unknown.counts.returnedUnits, 0);

  assert.throws(
    () => buildCodeExplanation(input, { hunk: 'H-001', symbol: 'service' }),
    (error) => error.code === 'CMP_EXPLANATION_QUERY_INVALID'
  );
  assert.throws(
    () => buildCodeExplanation(input, { hunk: '../H-001' }),
    (error) => error.code === 'CMP_EXPLANATION_QUERY_INVALID'
  );
});

test('a counterfeit diff degrades every tracked region to an opaque unit instead of omitting it', async (t) => {
  const input = await fixture(t);
  const counterfeit = structuredClone(input.diff);
  const service = counterfeit.files.find((file) => file.pathAfter === 'src/service.js');
  service.hunks[0].afterStart += 1;

  const explanation = buildCodeExplanation({ ...input, diff: counterfeit });
  assert.equal(explanation.availability.diff.status, 'unavailable');
  assert.equal(explanation.availability.diff.reason, 'diff-preview-integrity-invalid');
  assert.equal(explanation.counts.regions, 3);
  assert.equal(explanation.counts.diffHunks, 0);
  assert.equal(explanation.counts.opaqueUnits, 3);
  assert.equal(explanation.counts.explanationUnits, 3);
  assert.equal(explanation.counts.untrackedRegions, 1);
  assert.ok(explanation.whyEachChange.some((unit) =>
    unit.unitKind === 'tracked-file-opaque'
      && unit.opacity.reason === 'diff-preview-integrity-invalid'));
  assert.ok(explanation.whyEachChange.some((unit) =>
    unit.unitKind === 'untracked-region-opaque'
      && unit.opacity.reason === 'untracked-content-not-projected'));
});
