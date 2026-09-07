import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildChangeRegionManifest, evaluateComprehensionCoverage
} from '../src/comprehension/contracts.mjs';
import { buildComprehensionGraph } from '../src/comprehension/graph.mjs';
import {
  buildComprehensionWalkthroughDraft, CMP_WALKTHROUGH_ASSERTION_TYPES,
  CMP_WALKTHROUGH_CLAIM_CLASSES, CMP_WALKTHROUGH_LIMITS,
  revalidateComprehensionWalkthroughDraft, validateComprehensionWalkthroughDraft
} from '../src/comprehension/walkthrough.mjs';
import { recordSha256 } from '../src/records.mjs';
import { repositoryChangeSetDigest } from '../src/repository-change-set.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const SHA = (character) => `sha256:${character.repeat(64)}`;
const hash = (value) => `sha256:${recordSha256(value)}`;
const textHash = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function source() {
  const entryCore = {
    status: 'modified', similarity: null,
    oldPath: 'src/service.js', newPath: 'src/service.js',
    oldMode: '100644', newMode: '100644',
    oldObject: '1'.repeat(40), newObject: '2'.repeat(40),
    newContent: { kind: 'regular-file', sha256: SHA('a'), bytes: 24 }
  };
  const core = {
    schemaVersion: currentSchemaVersion('repository-change-set'),
    kind: 'repository-change-set', subject: 'CMP-WALKTHROUGH',
    base: { commit: 'b'.repeat(40), tree: 'c'.repeat(40) },
    target: {
      head: 'd'.repeat(40), includesIndex: true, includesWorktree: true,
      includesUntracked: true, caseInsensitivePaths: false
    },
    entries: [{ ...entryCore, changeId: hash(entryCore) }]
  };
  return { ...core, digest: repositoryChangeSetDigest(core) };
}

function context() {
  const changeSet = source();
  const manifest = buildChangeRegionManifest(changeSet);
  const coverage = evaluateComprehensionCoverage({ changeSet, manifest });
  const graph = buildComprehensionGraph({ manifest, coverage });
  return { changeSet, manifest, coverage, graph };
}

function claim(value) {
  const core = {
    schemaVersion: 1,
    kind: 'walkthrough-claim',
    claimId: value.claimId,
    text: value.text,
    textSha256: textHash(value.text),
    claimClass: value.claimClass,
    assertionType: value.assertionType,
    subjectRefs: value.subjectRefs ?? [],
    regionRefs: value.regionRefs ?? [],
    causeRefs: value.causeRefs ?? [],
    evidenceRefs: value.evidenceRefs ?? [],
    verification: { status: 'proposed', verifier: null, resultSha256: null },
    assurance: value.claimClass === 'model-advisory' ? 'model-advisory' : 'unavailable'
  };
  return { ...core, claimSha256: hash(core) };
}

function draft(manifest, graph, overrides = {}) {
  const narrative = overrides.narrative ?? 'The service file changed to implement the selected behavior.';
  const claims = overrides.claims ?? [
    claim({
      claimId: 'WCL-001', text: 'The service resource changed in this Candidate.',
      claimClass: 'diff-fact', assertionType: 'file-changed',
      subjectRefs: ['file:src/service.js'], regionRefs: [manifest.regions[0].regionId]
    }),
    claim({
      claimId: 'WCL-002', text: 'The implementation may be easier to maintain.',
      claimClass: 'model-advisory', assertionType: 'candidate-subject-match'
    }),
    claim({
      claimId: 'WCL-003', text: 'A nonexistent symbol is claimed to exist.',
      claimClass: 'structural-fact', assertionType: 'symbol-exists',
      subjectRefs: ['symbol:Missing.example'], regionRefs: [manifest.regions[0].regionId]
    })
  ];
  const dependencyManifest = {
    causeGraphSha256: graph.graphSha256,
    changeRegionManifestSha256: manifest.manifestSha256,
    structuralViewManifestSha256: null,
    evidenceManifestSha256: null,
    policySha256: null,
    extractorVersionsSha256: null
  };
  const core = {
    schemaVersion: 1,
    kind: 'comprehension-walkthrough-draft',
    walkthroughId: 'WLK-CHANGE-001',
    subject: { candidateSha256: manifest.compatibilityCandidateSha256, sourceTreeSha256: null },
    audience: 'maintainer',
    mode: 'change-walkthrough',
    narrative: { content: narrative, contentSha256: textHash(narrative) },
    claims,
    dependencyManifest,
    dependencyManifestSha256: hash(dependencyManifest)
  };
  return { ...core, draftSha256: hash(core) };
}

test('walkthrough validation distinguishes exact diff facts, unavailable structure, and model advice', () => {
  const { manifest, graph } = context();
  const input = draft(manifest, graph);
  const first = validateComprehensionWalkthroughDraft(input, { manifest, graph });
  const second = validateComprehensionWalkthroughDraft(structuredClone(input), { manifest, graph });

  assert.deepEqual(second, first);
  assert.equal(first.status, 'incomplete');
  assert.equal(first.authoritative, false);
  assert.equal(first.lifecycleGate, false);
  assert.equal(first.modelInvoked, false);
  assert.deepEqual(first.counts, {
    claims: 3, passed: 1, advisory: 1, unavailable: 1, contradicted: 0
  });
  assert.equal(first.claims[0].assurance, 'diff-verified');
  assert.equal(first.claims[0].sources[0].pathAfter, 'src/service.js');
  assert.deepEqual(first.claims[0].sources[0].exactSourceRefs.map((entry) => entry.side),
    ['before', 'after']);
  assert.ok(first.claims[0].sources[0].exactSourceRefs.every((entry) =>
    entry.ref.startsWith('sfref:comprehension:source:')));
  assert.equal(first.claims[1].assurance, 'model-advisory');
  assert.equal(first.claims[2].assurance, 'unavailable');
  assert.ok(first.diagnostics.some((entry) => entry.code === 'CMP_STRUCTURE_UNAVAILABLE'));
  assert.ok(Object.isFrozen(first.claims));
  assert.deepEqual(CMP_WALKTHROUGH_CLAIM_CLASSES, [
    'structural-fact', 'diff-fact', 'evidence-supported', 'human-judgment', 'model-advisory'
  ]);
  assert.ok(CMP_WALKTHROUGH_ASSERTION_TYPES.includes('file-changed'));
});

test('walkthrough drafting creates a deterministic model-free exact resource baseline', () => {
  const { manifest, graph } = context();
  const first = buildComprehensionWalkthroughDraft({ manifest, graph });
  const second = buildComprehensionWalkthroughDraft({
    manifest: structuredClone(manifest), graph: structuredClone(graph)
  });
  assert.deepEqual(second, first);
  assert.equal(first.claims.length, manifest.regions.length);
  assert.equal(first.claims[0].claimClass, 'diff-fact');
  assert.equal(first.claims[0].assertionType, 'file-changed');
  assert.deepEqual(first.claims[0].subjectRefs, ['file:src/service.js']);
  assert.deepEqual(first.claims[0].regionRefs, [manifest.regions[0].regionId]);
  const validation = validateComprehensionWalkthroughDraft(first, { manifest, graph });
  assert.equal(validation.status, 'validated');
  assert.equal(validation.counts.passed, 1);
  assert.equal(validation.modelInvoked, false);
  assert.equal(validation.authoritative, false);
});

test('walkthrough validation rejects self-awarded assurance, stale Candidate, and broken hashes', () => {
  const { manifest, graph } = context();
  const input = draft(manifest, graph);
  const selfAwarded = structuredClone(input);
  selfAwarded.claims[0].verification = {
    status: 'passed', verifier: 'model-says-so', resultSha256: SHA('f')
  };
  selfAwarded.claims[0].assurance = 'diff-verified';
  selfAwarded.claims[0].claimSha256 = hash(
    Object.fromEntries(Object.entries(selfAwarded.claims[0]).filter(([key]) => key !== 'claimSha256'))
  );
  selfAwarded.draftSha256 = hash(
    Object.fromEntries(Object.entries(selfAwarded).filter(([key]) => key !== 'draftSha256'))
  );
  const rejected = validateComprehensionWalkthroughDraft(selfAwarded, { manifest, graph });
  assert.equal(rejected.status, 'failed');
  assert.ok(rejected.diagnostics.some((entry) =>
    entry.code === 'CMP_WALKTHROUGH_ASSURANCE_INVALID'));

  const stale = structuredClone(input);
  stale.subject.candidateSha256 = SHA('e');
  stale.draftSha256 = hash(
    Object.fromEntries(Object.entries(stale).filter(([key]) => key !== 'draftSha256'))
  );
  const staleResult = validateComprehensionWalkthroughDraft(stale, { manifest, graph });
  assert.equal(staleResult.status, 'failed');
  assert.ok(staleResult.diagnostics.some((entry) =>
    entry.code === 'CMP_WALKTHROUGH_CANDIDATE_INVALID'));
});

test('walkthrough dual hashes separate narrative drift from dependency identity', () => {
  const { manifest, graph } = context();
  const original = validateComprehensionWalkthroughDraft(draft(manifest, graph), { manifest, graph });
  const changed = validateComprehensionWalkthroughDraft(
    draft(manifest, graph, { narrative: 'The same exact facts are presented with revised wording.' }),
    { manifest, graph }
  );
  assert.equal(changed.status, 'incomplete');
  assert.equal(changed.dependencyManifestSha256, original.dependencyManifestSha256);
  assert.notEqual(changed.walkthroughContentSha256, original.walkthroughContentSha256);
  assert.notEqual(changed.walkthroughSha256, original.walkthroughSha256);
});

test('walkthrough validation refuses oversized drafts before they can become authority', () => {
  const { manifest, graph } = context();
  const input = draft(manifest, graph, {
    narrative: 'x'.repeat(CMP_WALKTHROUGH_LIMITS.maximumDraftBytes)
  });
  const result = validateComprehensionWalkthroughDraft(input, { manifest, graph });
  assert.equal(result.status, 'failed');
  assert.ok(result.diagnostics.some((entry) => entry.code === 'CMP_WALKTHROUGH_LIMIT'));
  assert.equal(result.authoritative, false);
  assert.equal(result.lifecycleGate, false);
});

test('walkthrough revalidation separates presentation drift from exact claim dependencies', () => {
  const { manifest, graph } = context();
  const originalDraft = draft(manifest, graph);
  const previous = validateComprehensionWalkthroughDraft(originalDraft, { manifest, graph });
  const presentationDraft = draft(manifest, graph, {
    narrative: 'The presentation changed while every exact typed claim remained the same.'
  });
  const result = revalidateComprehensionWalkthroughDraft(
    previous, presentationDraft, { manifest, graph }
  );

  assert.equal(result.status, 'revalidated');
  assert.equal(result.presentationChanged, true);
  assert.equal(result.candidateChanged, false);
  assert.deepEqual(result.changedDependencies, []);
  assert.equal(result.counts.invalidated, 0);
  assert.equal(result.counts.unchanged, 3);
  assert.ok(result.claims.every((entry) => entry.outcome === 'unchanged'));
  assert.equal(result.authoritative, false);
  assert.equal(result.lifecycleGate, false);
  assert.equal(result.modelInvoked, false);
});

test('walkthrough revalidation invalidates only claims bound to a changed precise dependency', () => {
  const { manifest, graph } = context();
  const claims = [
    claim({
      claimId: 'WCL-001', text: 'The exact service resource changed.',
      claimClass: 'diff-fact', assertionType: 'file-changed',
      subjectRefs: ['file:src/service.js'], regionRefs: [manifest.regions[0].regionId]
    }),
    claim({
      claimId: 'WCL-002', text: 'The Candidate matches the accepted human intent.',
      claimClass: 'human-judgment', assertionType: 'candidate-subject-match'
    })
  ];
  const originalDraft = draft(manifest, graph, { claims });
  const previous = validateComprehensionWalkthroughDraft(originalDraft, { manifest, graph });
  const changedGraphCore = structuredClone(graph);
  delete changedGraphCore.graphSha256;
  changedGraphCore.availability.causeGraph = 'available';
  const changedGraph = { ...changedGraphCore, graphSha256: hash(changedGraphCore) };
  const currentDraft = draft(manifest, changedGraph, { claims });
  const result = revalidateComprehensionWalkthroughDraft(
    previous, currentDraft, { manifest, graph: changedGraph }
  );

  assert.deepEqual(result.changedDependencies, ['causeGraphSha256']);
  assert.equal(result.claims[0].outcome, 'unchanged');
  assert.equal(result.claims[0].invalidated, false);
  assert.equal(result.claims[1].outcome, 'invalidated');
  assert.deepEqual(result.claims[1].reasons, ['dependency-changed:causeGraphSha256']);
  assert.equal(result.counts.invalidated, 1);
  assert.equal(result.status, 'incomplete');
});

test('walkthrough revalidation refuses a counterfeit previous result', () => {
  const { manifest, graph } = context();
  const input = draft(manifest, graph);
  const previous = structuredClone(
    validateComprehensionWalkthroughDraft(input, { manifest, graph })
  );
  previous.counts.passed = 99;
  const result = revalidateComprehensionWalkthroughDraft(previous, input, { manifest, graph });
  assert.equal(result.status, 'failed');
  assert.equal(result.previousResultSha256, null);
  assert.ok(result.diagnostics.some((entry) =>
    entry.code === 'CMP_WALKTHROUGH_REVALIDATION_INVALID'));
});

test('walkthrough validation bounds expanded result sources across all claims', () => {
  const { manifest, graph } = context();
  const claims = Array.from({ length: CMP_WALKTHROUGH_LIMITS.maximumResultSources + 1 }, (_, index) =>
    claim({
      claimId: `WCL-${String(index + 1).padStart(3, '0')}`,
      text: `Advisory observation ${index + 1}.`,
      claimClass: 'model-advisory',
      assertionType: 'candidate-subject-match'
    }));
  const result = validateComprehensionWalkthroughDraft(
    draft(manifest, graph, { claims }), { manifest, graph }
  );
  assert.equal(result.status, 'failed');
  assert.ok(result.diagnostics.some((entry) => entry.code === 'CMP_WALKTHROUGH_LIMIT'));
  assert.equal(result.claims.reduce((total, entry) => total + entry.sources.length, 0),
    CMP_WALKTHROUGH_LIMITS.maximumResultSources);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8')
    <= CMP_WALKTHROUGH_LIMITS.maximumValidationBytes);
});
