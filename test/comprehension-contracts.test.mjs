import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildChangeRegionManifest,
  CMP_CAUSE_KINDS,
  CMP_DISPOSITIONS,
  CMP_PROPOSER_KINDS,
  CMP_RELATIONSHIPS,
  evaluateComprehensionCoverage,
  validateChangeCauseBinding
} from '../src/comprehension/contracts.mjs';
import { recordSha256 } from '../src/records.mjs';
import { repositoryChangeSetDigest } from '../src/repository-change-set.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const SHA = (character) => `sha256:${character.repeat(64)}`;

function canonicalHash(value) {
  return `sha256:${recordSha256(value)}`;
}

function textHash(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function entry(value) {
  const core = {
    status: value.status,
    similarity: value.similarity ?? null,
    oldPath: value.oldPath ?? null,
    newPath: value.newPath ?? null,
    oldMode: value.oldMode ?? (value.oldPath ? '100644' : '000000'),
    newMode: value.newMode ?? (value.newPath ? '100644' : '000000'),
    oldObject: value.oldObject ?? (value.oldPath ? '1'.repeat(40) : null),
    newObject: value.newObject ?? (value.newPath ? '2'.repeat(40) : null),
    ...(value.untracked === true ? { untracked: true } : {}),
    newContent: value.newPath
      ? value.newContent ?? { kind: 'regular-file', sha256: SHA('a'), bytes: 24 }
      : null
  };
  return { ...core, changeId: canonicalHash(core) };
}

function changeSet(entries = [entry({ status: 'modified', oldPath: 'src/a.js', newPath: 'src/a.js' })]) {
  const core = {
    schemaVersion: currentSchemaVersion('repository-change-set'),
    kind: 'repository-change-set',
    subject: 'CMP-TEST',
    base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    target: {
      head: 'c'.repeat(40),
      includesIndex: true,
      includesWorktree: true,
      includesUntracked: true,
      caseInsensitivePaths: false
    },
    entries
  };
  return { ...core, digest: repositoryChangeSetDigest(core) };
}

function rehashCause(value) {
  const cause = structuredClone(value);
  delete cause.refSha256;
  return { ...cause, refSha256: canonicalHash(cause) };
}

function causeFor(manifest, overrides = {}) {
  const statement = overrides.statement ?? 'Duplicate payment capture must be prevented.';
  return rehashCause({
    schemaVersion: 1,
    kind: 'cause-ref',
    causeKind: 'acceptance-clause',
    causeId: 'AC-003',
    authority: {
      status: 'approved',
      recordRef: 'sfref:acceptance:AC-003',
      recordSha256: SHA('3'),
      inForce: true
    },
    statement,
    statementSha256: textHash(statement),
    validity: {
      policySha256: SHA('4'),
      subjectSha256: manifest.compatibilityCandidateSha256,
      stale: false
    },
    ...overrides
  });
}

function rehashBinding(value) {
  const binding = structuredClone(value);
  delete binding.bindingSha256;
  return { ...binding, bindingSha256: canonicalHash(binding) };
}

function bindingFor(manifest, cause, overrides = {}) {
  const region = manifest.regions[0];
  return rehashBinding({
    schemaVersion: 1,
    kind: 'change-cause-binding',
    bindingId: 'CCB-017',
    candidateSha256: manifest.compatibilityCandidateSha256,
    regionSha256: region.regionSha256,
    causeRefs: [{
      causeKind: cause.causeKind,
      causeId: cause.causeId,
      recordSha256: cause.authority.recordSha256
    }],
    relationship: 'implements',
    corroboration: { structural: [], evidence: [] },
    proposedBy: { kind: 'execution-unit', id: 'copilot-cli' },
    confirmation: {
      required: true,
      status: 'confirmed',
      decisionSha256: SHA('5')
    },
    assurance: {
      declared: true,
      structurallyCorroborated: false,
      evidenceCorroborated: false,
      humanAccepted: true
    },
    ...overrides
  });
}

function disposition(manifest, name, extra = {}) {
  const core = {
    schemaVersion: 1,
    kind: 'change-disposition',
    candidateSha256: manifest.compatibilityCandidateSha256,
    regionSha256: manifest.regions[0].regionSha256,
    disposition: name,
    ...extra
  };
  return { ...core, dispositionSha256: canonicalHash(core) };
}

function transformationReceipt(manifest, region = manifest.regions[0]) {
  const core = {
    schemaVersion: 1,
    kind: 'deterministic-transformation-receipt',
    transformation: {
      id: 'prettier-format',
      version: '3.4.2',
      executableSha256: SHA('6'),
      configurationSha256: SHA('7')
    },
    candidateSha256: manifest.compatibilityCandidateSha256,
    inputManifestSha256: SHA('8'),
    outputManifestSha256: manifest.manifestSha256,
    regions: [region.regionId],
    semanticChange: false,
    verification: { status: 'passed', verifier: 'format-only-diff-v1' }
  };
  return { ...core, receiptSha256: canonicalHash(core) };
}

function nonmaterialManifest(source) {
  const manifest = structuredClone(source);
  const region = manifest.regions[0];
  region.classification.material = false;
  const regionCore = { ...region };
  delete regionCore.regionId;
  delete regionCore.regionSha256;
  region.regionSha256 = canonicalHash(regionCore);
  region.regionId = `REG-${region.regionSha256.slice(7, 27).toUpperCase()}`;
  const manifestCore = { ...manifest };
  delete manifestCore.manifestSha256;
  manifest.manifestSha256 = canonicalHash(manifestCore);
  return manifest;
}

test('CMP vocabularies are closed, exact, and immutable', () => {
  assert.deepEqual(CMP_CAUSE_KINDS, [
    'requirement', 'acceptance-clause', 'clarification-answer', 'architecture-decision',
    'design-decision', 'risk-treatment', 'defect', 'incident', 'refusal-repair',
    'verification-repair', 'challenge-resolution', 'amendment', 'recovery',
    'performance-objective', 'security-objective', 'compliance-obligation',
    'approved-deviation', 'deterministic-transformation', 'reverse-converged-intent'
  ]);
  assert.deepEqual(CMP_RELATIONSHIPS, [
    'implements', 'repairs', 'implements-and-repairs', 'satisfies', 'mitigates',
    'explains-transformation'
  ]);
  assert.deepEqual(CMP_DISPOSITIONS, [
    'explained', 'approved-deviation', 'split', 'revert', 'excluded-from-publication',
    'deterministic-transformation', 'legacy-untouched', 'unresolved'
  ]);
  assert.deepEqual(CMP_PROPOSER_KINDS, [
    'human', 'agent', 'governed-agent', 'model', 'execution-unit', 'copilot',
    'copilot-cli', 'deterministic-tool'
  ]);
  assert.ok(Object.isFrozen(CMP_CAUSE_KINDS));
  assert.throws(() => CMP_CAUSE_KINDS.push('free-text'));
});

test('resource fallback projects every exact change kind in canonical order without claiming AST assurance', () => {
  const input = changeSet([
    entry({ status: 'renamed', oldPath: 'src/z.js', newPath: 'src/a.js', similarity: 92 }),
    entry({ status: 'deleted', oldPath: 'docs/old.md', newPath: null }),
    entry({
      status: 'added', oldPath: null, newPath: 'bin/link', oldMode: '000000', newMode: '120000',
      oldObject: null, newObject: null,
      newContent: { kind: 'symlink', sha256: SHA('b'), bytes: 9 }, untracked: true
    }),
    entry({
      status: 'type-changed', oldPath: 'assets/blob.dat', newPath: 'assets/blob.dat',
      newContent: { kind: 'non-regular', sha256: null, bytes: 2048 }
    }),
    entry({
      status: 'modified', oldPath: 'assets/binary.bin', newPath: 'assets/binary.bin',
      newContent: { kind: 'regular-file', sha256: SHA('c'), bytes: 4096 }
    })
  ]);
  const first = buildChangeRegionManifest(input);
  const second = buildChangeRegionManifest(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.compatibilityCandidateSha256, input.digest);
  assert.equal(first.candidateSha256, input.digest);
  assert.equal(first.changeSetSha256, input.digest);
  assert.deepEqual(first.regions.map((region) => region.location.pathBefore ?? region.location.pathAfter), [
    'bin/link', 'assets/binary.bin', 'assets/blob.dat', 'docs/old.md', 'src/z.js'
  ]);
  for (const region of first.regions) {
    assert.equal(region.schemaVersion, 1);
    assert.match(region.regionId, /^REG-[A-F0-9]{20}$/);
    assert.match(region.regionSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(region.classification.material, true);
    assert.equal(region.classification.ownership, 'conservatively-in-scope');
    assert.equal(region.classification.assurance, 'diff-derived');
    assert.equal(region.classification.granularity, 'resource');
    assert.equal(region.classification.structuralAssurance, 'unavailable');
    assert.deepEqual(region.location.symbolRefs, []);
    assert.deepEqual(region.location.semanticAnchors, []);
  }
  assert.equal(first.regions.find((region) => region.location.pathAfter === 'bin/link').location.fileTypeAfter, 'symlink');
  assert.equal(first.regions.find((region) => region.operation === 'deleted').location.contentAfterSha256, null);
  assert.equal(first.regions.find((region) => region.location.pathAfter === 'assets/binary.bin').location.contentAfterSha256, SHA('c'));
  assert.equal(first.counts.inScope, first.regions.length);
  assert.equal(Object.isFrozen(first.regions[0].classification), true);
  assert.equal(Object.isFrozen(first.regions[0].location.symbolRefs), true);
});

test('region projection rejects a tampered change set or entry identity', () => {
  const input = changeSet();
  assert.throws(
    () => buildChangeRegionManifest({ ...input, digest: SHA('f') }),
    (error) => error.code === 'CMP_CHANGE_SET_INVALID'
  );
  const tampered = structuredClone(input);
  tampered.entries[0].newPath = 'src/tampered.js';
  tampered.digest = repositoryChangeSetDigest({ ...tampered, digest: undefined });
  assert.throws(
    () => buildChangeRegionManifest(tampered),
    (error) => error.code === 'CMP_CHANGE_SET_INVALID'
  );
  const future = changeSet();
  future.schemaVersion = 999;
  future.digest = repositoryChangeSetDigest(future);
  assert.throws(
    () => buildChangeRegionManifest(future),
    (error) => error.code === 'CMP_CHANGE_SET_INVALID'
  );
  const wrongKind = changeSet();
  wrongKind.kind = 'caller-defined-change-set';
  wrongKind.digest = repositoryChangeSetDigest(wrongKind);
  assert.throws(
    () => buildChangeRegionManifest(wrongKind),
    (error) => error.code === 'CMP_CHANGE_SET_INVALID'
  );
});

test('a governed candidate-bound cause binding validates without trusting binding prose', () => {
  const manifest = buildChangeRegionManifest(changeSet());
  const cause = causeFor(manifest);
  const binding = bindingFor(manifest, cause);
  const result = validateChangeCauseBinding(binding, {
    manifest,
    causes: [cause],
    decisions: [SHA('5')]
  });
  assert.equal(result.valid, true, JSON.stringify(result.failures));
  assert.equal(result.authoritative, false);

  const freeTextOnly = rehashBinding({
    ...binding,
    causeRefs: [{ causeKind: 'acceptance-clause', causeId: 'AC-003', statement: cause.statement }]
  });
  const rejected = validateChangeCauseBinding(freeTextOnly, {
    manifest,
    decisions: [SHA('5')]
  });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.failures.some((failure) => failure.code === 'CMP_CAUSE_REFERENCE_MISSING'));
});

test('binding validation rejects unknown, placeholder, stale, unauthoritative, unconfirmed, and cross-candidate causes', () => {
  const manifest = buildChangeRegionManifest(changeSet());
  const baseCause = causeFor(manifest);
  const cases = [
    {
      label: 'unknown cause kind',
      cause: rehashCause({ ...baseCause, causeKind: 'whatever' }),
      code: 'CMP_CAUSE_KIND_INVALID'
    },
    {
      label: 'placeholder statement',
      cause: rehashCause({ ...baseCause, statement: 'refactor', statementSha256: textHash('refactor') }),
      code: 'CMP_CAUSE_REFERENCE_INVALID'
    },
    {
      label: 'stale cause',
      cause: rehashCause({ ...baseCause, validity: { ...baseCause.validity, stale: true } }),
      code: 'CMP_CAUSE_REFERENCE_STALE'
    },
    {
      label: 'unauthorized cause',
      cause: rehashCause({ ...baseCause, authority: { ...baseCause.authority, status: 'proposed' } }),
      code: 'CMP_CAUSE_AUTHORITY_INVALID'
    },
    {
      label: 'cross-candidate cause',
      cause: rehashCause({ ...baseCause, validity: { ...baseCause.validity, subjectSha256: SHA('e') } }),
      code: 'CMP_CAUSE_REFERENCE_STALE'
    }
  ];
  for (const fixture of cases) {
    const binding = bindingFor(manifest, fixture.cause);
    const result = validateChangeCauseBinding(binding, {
      manifest,
      causes: [fixture.cause],
      decisions: [SHA('5')]
    });
    assert.equal(result.valid, false, fixture.label);
    assert.ok(result.failures.some((failure) => failure.code === fixture.code), fixture.label);
  }

  const unconfirmed = bindingFor(manifest, baseCause, {
    confirmation: { required: false, status: 'not-required', decisionSha256: null }
  });
  const result = validateChangeCauseBinding(unconfirmed, {
    manifest,
    causes: [baseCause]
  });
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((failure) => failure.code === 'CMP_BINDING_CONFIRMATION_REQUIRED'));

  const wrongRelationship = bindingFor(manifest, baseCause, { relationship: 'kind-of' });
  const relationship = validateChangeCauseBinding(wrongRelationship, {
    manifest, causes: [baseCause], decisions: [SHA('5')]
  });
  assert.equal(relationship.valid, false);
  assert.ok(relationship.failures.some((failure) => failure.code === 'CMP_BINDING_RELATIONSHIP_INVALID'));

  const missingProposerKind = bindingFor(manifest, baseCause, {
    proposedBy: { id: 'copilot-cli' },
    confirmation: null
  });
  const proposer = validateChangeCauseBinding(missingProposerKind, {
    manifest, causes: [baseCause]
  });
  assert.equal(proposer.valid, false);
  assert.ok(proposer.failures.some((failure) => failure.code === 'CMP_BINDING_INVALID'));
});

test('caller-supplied self-consistent records remain non-authoritative observations', () => {
  const source = changeSet();
  const manifest = buildChangeRegionManifest(source);
  const cause = causeFor(manifest);
  const binding = bindingFor(manifest, cause);
  const bindingResult = validateChangeCauseBinding(binding, {
    manifest,
    causes: [cause],
    decisions: [SHA('5')]
  });
  assert.equal(bindingResult.valid, true);
  assert.equal(bindingResult.authoritative, false);

  const coverage = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    causes: [cause],
    bindings: [binding],
    decisions: [SHA('5')],
    dispositions: [disposition(manifest, 'explained')]
  });
  assert.equal(coverage.verdict, 'complete');
  assert.equal(coverage.authoritative, false);
  assert.equal(coverage.lifecycleGate, false);
  assert.equal('authorityVerified' in coverage, false);
});

test('coverage completes an observation only through valid exact bindings', () => {
  const source = changeSet();
  const manifest = buildChangeRegionManifest(source);
  const cause = causeFor(manifest);
  const binding = bindingFor(manifest, cause);
  const complete = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    causes: [cause],
    bindings: [binding],
    decisions: [SHA('5')],
    dispositions: [disposition(manifest, 'explained')]
  });
  assert.equal(complete.verdict, 'complete');
  assert.equal(complete.counts.explained, 1);
  assert.equal(complete.counts.unresolved, 0);
  assert.equal(complete.schemaVersion, 1);
  assert.equal(complete.authoritative, false);
  assert.equal(Object.isFrozen(complete), true);

  const incomplete = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    dispositions: [disposition(manifest, 'explained')]
  });
  assert.equal(incomplete.verdict, 'incomplete');
  assert.equal(incomplete.unresolved[0].code, 'CMP_CAUSE_COVERAGE_INCOMPLETE');
});

test('coverage refuses false disposition coverage and observes exact typed alternatives', () => {
  const source = changeSet();
  const manifest = buildChangeRegionManifest(source);
  const decision = SHA('d');
  const deviationMissing = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    dispositions: [disposition(manifest, 'approved-deviation', { decisionSha256: decision })]
  });
  assert.equal(deviationMissing.unresolved[0].code, 'CMP_DEVIATION_DECISION_REQUIRED');
  assert.equal(evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    decisions: [decision],
    dispositions: [disposition(manifest, 'approved-deviation', { decisionSha256: decision })]
  }).verdict, 'complete');

  const receipt = transformationReceipt(manifest);
  assert.equal(evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    transformationReceipts: [receipt],
    dispositions: [disposition(manifest, 'deterministic-transformation', { receiptSha256: receipt.receiptSha256 })]
  }).verdict, 'complete');
  const tamperedReceipt = { ...receipt, semanticChange: true };
  const tampered = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    transformationReceipts: [tamperedReceipt],
    dispositions: [disposition(manifest, 'deterministic-transformation', { receiptSha256: receipt.receiptSha256 })]
  });
  assert.equal(tampered.unresolved[0].code, 'CMP_TRANSFORMATION_RECEIPT_INVALID');
  assert.ok(tampered.diagnostics.some((entry) => entry.code === 'CMP_TRANSFORMATION_RECEIPT_INVALID'));

  const split = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    dispositions: [disposition(manifest, 'split', { targetCandidateSha256: SHA('e') })]
  });
  assert.equal(split.verdict, 'incomplete');
  assert.equal(split.unresolved[0].code, 'CMP_SPLIT_PENDING');

  for (const [name, code] of [
    ['revert', 'CMP_REVERT_PENDING'],
    ['excluded-from-publication', 'CMP_EXCLUSION_PENDING'],
    ['legacy-untouched', 'CMP_LEGACY_TOUCHED'],
    ['unresolved', 'CMP_CAUSE_COVERAGE_INCOMPLETE']
  ]) {
    const result = evaluateComprehensionCoverage({
      changeSet: source,
      manifest,
      dispositions: [disposition(manifest, name)]
    });
    assert.equal(result.verdict, 'incomplete', name);
    assert.equal(result.unresolved[0].code, code, name);
  }
});

test('coverage rejects a rehashed nonmaterial claim because exact fallback remains material', () => {
  const source = changeSet();
  const manifest = nonmaterialManifest(buildChangeRegionManifest(source));
  const result = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    dispositions: [disposition(manifest, 'deterministic-transformation', { receiptSha256: SHA('a') })]
  });
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.diagnostics.some((entry) => entry.code === 'CMP_REGION_FALLBACK_INVALID'));
  assert.ok(result.diagnostics.some((entry) => entry.code === 'CMP_MANIFEST_SOURCE_MISMATCH'));
});

test('coverage refuses a tampered manifest before evaluating dispositions', () => {
  const source = changeSet();
  const manifest = structuredClone(buildChangeRegionManifest(source));
  manifest.regions[0].location.pathAfter = 'src/other.js';
  const result = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    dispositions: [disposition(manifest, 'split', { targetCandidateSha256: SHA('e') })]
  });
  assert.equal(result.verdict, 'incomplete');
  assert.ok(result.diagnostics.some((failure) => failure.code === 'CMP_MANIFEST_INTEGRITY_INVALID'));
  assert.ok(result.diagnostics.some((failure) => failure.code === 'CMP_REGION_IDENTITY_INVALID'));
});

test('empty exact manifests are not applicable and can never report a pass', () => {
  const source = changeSet([]);
  const manifest = buildChangeRegionManifest(source);
  const result = evaluateComprehensionCoverage({ changeSet: source, manifest });
  assert.equal(result.verdict, 'not-applicable');
  assert.equal(result.authoritative, false);
  assert.equal(result.lifecycleGate, false);
  assert.equal(result.counts.regions, 0);
});

test('malformed and orphan evidence makes an otherwise complete observation incomplete', () => {
  const source = changeSet();
  const manifest = buildChangeRegionManifest(source);
  const cause = causeFor(manifest);
  const orphanCause = causeFor(manifest, { causeId: 'AC-ORPHAN' });
  const binding = bindingFor(manifest, cause);
  const orphanReceipt = transformationReceipt(manifest);
  const orphanDisposition = disposition(manifest, 'explained', { regionSha256: SHA('f') });
  const result = evaluateComprehensionCoverage({
    changeSet: source,
    manifest,
    causes: [cause, orphanCause],
    bindings: [binding],
    decisions: [SHA('5'), SHA('5'), SHA('e')],
    transformationReceipts: [orphanReceipt],
    dispositions: [disposition(manifest, 'explained'), orphanDisposition]
  });
  assert.equal(result.verdict, 'incomplete');
  assert.equal(result.counts.explained, 1);
  assert.ok(result.diagnostics.some((entry) => entry.code === 'CMP_EVIDENCE_ORPHAN'));
  assert.ok(result.diagnostics.some((entry) => entry.code === 'CMP_EVIDENCE_AMBIGUOUS'));
});
