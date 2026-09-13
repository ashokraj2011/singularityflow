import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  composePromptSectionsWithTokenReduction,
  promptSectionsToTokenReductionOffers
} from '../src/token-reduction-prompt-adapter.mjs';
import { defaultTokenReductionContractSet } from '../src/token-reduction/default-contract.mjs';
import { recordSha256 } from '../src/world-model/canonicalize.mjs';

const contractSet = defaultTokenReductionContractSet();

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function subject(sectionId, overrides = {}) {
  return {
    owner: 'prompt-owner',
    domain: 'repository:payments/api@abc123',
    kind: 'prompt-section',
    id: sectionId,
    revision: 'git:abc123',
    sourceRef: `git:abc123:prompt/${sectionId}.md`,
    ...overrides
  };
}

function ownerBinding(sectionId, sourceText, overrides = {}) {
  const rule = contractSet.logicalComposer.sectionRules.find((entry) => entry.id === sectionId);
  assert.ok(rule, `unknown fixture rule ${sectionId}`);
  const applicability = overrides.applicability ?? 'required';
  const notApplicable = applicability === 'not-applicable';
  const subjectRef = overrides.subjectRef ?? subject(sectionId);
  const evidenceRole = overrides.evidenceRole ?? rule.permittedRoles[0];
  const requirementRef = overrides.requirementRef ?? `requirement:${sectionId}@abc123`;
  const captured = notApplicable ? null : Buffer.from(sourceText, 'utf8');
  const core = {
    kind: 'tkr/prompt-section-owner-binding',
    version: 1,
    sectionId,
    subjectRef,
    applicability,
    applicabilityDecisionRef: notApplicable
      ? (overrides.applicabilityDecisionRef ?? `decision:${sectionId}@abc123`)
      : (overrides.applicabilityDecisionRef ?? null),
    evidenceRole,
    assuranceRef: overrides.assuranceRef ?? `assurance:${sectionId}:owner-captured@1`,
    requirementRef,
    coverage: overrides.coverage ?? (notApplicable ? [] : [{
      claimRef: `claim:${sectionId}@abc123`,
      subjectRef,
      evidenceRole,
      requirementRef
    }]),
    sourceRef: Object.hasOwn(overrides, 'sourceRef')
      ? overrides.sourceRef : subjectRef.sourceRef,
    sourceBytes: Object.hasOwn(overrides, 'sourceBytes')
      ? overrides.sourceBytes : (notApplicable ? null : sourceText),
    sourceSha256: Object.hasOwn(overrides, 'sourceSha256')
      ? overrides.sourceSha256 : (notApplicable ? null : digest(captured)),
    sourceByteLength: Object.hasOwn(overrides, 'sourceByteLength')
      ? overrides.sourceByteLength : (notApplicable ? 0 : captured.length),
    expansionRefs: overrides.expansionRefs ?? [],
    limitations: overrides.limitations ?? [],
    rendererRef: overrides.rendererRef ?? contractSet.rendererRef,
    priority: overrides.priority ?? 100
  };
  return { ...core, bindingSha256: overrides.bindingSha256 ?? recordSha256(core) };
}

function resolver(bindings, requests = []) {
  const byId = new Map(bindings.map((entry) => [entry.sectionId, entry]));
  return (request) => {
    requests.push(request);
    return byId.get(request.sectionId);
  };
}

function hasCode(code) {
  return (error) => error.code === code;
}

test('adapter uses only owner-bound facts and protects every exact UTF-8 byte', () => {
  const phaseText = '  # Phase contract\n\nDo exactly this.\n';
  const sourceText = '# Work source\n\nCaf\u00e9 \ud83d\udee0\ufe0f\n';
  const phase = ownerBinding('phase-contract', phaseText, {
    assuranceRef: 'assurance:workflow-owner-signature@3', priority: 0
  });
  const work = ownerBinding('work-source', sourceText, {
    assuranceRef: 'assurance:work-source-owner@7',
    limitations: ['semantic completeness not attested'], priority: 0
  });
  const requests = [];
  const adapted = promptSectionsToTokenReductionOffers([
    { id: 'work-source', text: sourceText },
    { id: 'phase-contract', text: phaseText }
  ], { resolveOwnerBinding: resolver([work, phase], requests) });

  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[0], 'text'), false);
  assert.equal(Object.isFrozen(requests[0]), true);
  assert.deepEqual(adapted.offers.map((entry) => entry.sectionId), [
    'work-source', 'phase-contract'
  ]);
  for (const [index, expected] of [sourceText, phaseText].entries()) {
    const candidate = adapted.offers[index].representations[0];
    assert.equal(candidate.content, expected);
    assert.deepEqual(candidate.renderedRef, {
      sha256: digest(Buffer.from(expected)), bytes: Buffer.byteLength(expected)
    });
    assert.equal(candidate.protectedSpans[0].sourceStart, 0);
    assert.equal(candidate.protectedSpans[0].sourceEnd, Buffer.byteLength(expected));
    assert.equal(candidate.protectedSpans[0].renderedEnd, Buffer.byteLength(expected));
  }
  assert.equal(adapted.offers[0].assuranceRef, work.assuranceRef);
  assert.deepEqual(adapted.offers[0].coverage, work.coverage);
  assert.deepEqual(adapted.offers[0].limitations, work.limitations);
  assert.equal(adapted.inputs[0].ownerBindingRef, work.bindingSha256);
});

test('composition reports exact owner binding and assurance references', () => {
  const phaseText = '  PHASE\n';
  const sourceText = 'SOURCE\n\n';
  const phase = ownerBinding('phase-contract', phaseText, {
    assuranceRef: 'assurance:policy-owner@2', priority: 0
  });
  const work = ownerBinding('work-source', sourceText, {
    assuranceRef: 'assurance:source-owner@9', priority: 0
  });
  const result = composePromptSectionsWithTokenReduction({
    sections: [
      { id: 'work-source', text: sourceText },
      { id: 'phase-contract', text: phaseText }
    ],
    maximumBytes: 4096,
    resolveOwnerBinding: resolver([work, phase])
  });

  assert.equal(result.composition.content, `${phaseText}\n\n${sourceText}`);
  assert.deepEqual(result.composition.segments.map((entry) => entry.id), [
    'phase-contract', 'work-source'
  ]);
  assert.deepEqual(result.sectionReport.ownerAssuranceRefs, [
    work.assuranceRef, phase.assuranceRef
  ]);
  assert.equal(result.sectionReport.sources[0].ownerBindingRef, work.bindingSha256);
  assert.equal(result.sectionReport.sources[0].sourceSha256, work.sourceSha256);
  assert.equal(result.sectionReport.measurement.assurance,
    'owner-declared-assurance-with-exact-byte-verification');
  assert.equal(result.sectionReport.measurement.tokens, null);
  for (const entry of result.sectionReport.sections) {
    assert.deepEqual(entry.originalRenderedRef, entry.finalRenderedRef);
  }
});

test('missing and asynchronous resolvers fail closed', () => {
  const sections = [{ id: 'phase-contract', text: 'contract' }];
  assert.throws(() => promptSectionsToTokenReductionOffers(sections), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && error.details.missingCapability === 'prompt-section-owner-resolution'
  ));
  assert.throws(() => promptSectionsToTokenReductionOffers(sections, {
    resolveOwnerBinding: async () => ownerBinding('phase-contract', 'contract')
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && /asynchronous/u.test(error.message));
});

test('empty section input is not a successful owner-bound preview', () => {
  let calls = 0;
  assert.throws(() => promptSectionsToTokenReductionOffers([], {
    resolveOwnerBinding() { calls += 1; return null; }
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.reason === 'empty-context');
  assert.equal(calls, 0);
});

test('bare section text cannot provide governance or provenance fields', () => {
  const valid = ownerBinding('phase-contract', 'contract');
  for (const field of [
    'subjectRef', 'applicability', 'evidenceRole', 'assuranceRef', 'requirementRef',
    'coverage', 'sourceRef', 'rendererRef', 'priority', 'expandHandle'
  ]) {
    assert.throws(() => promptSectionsToTokenReductionOffers([{
      id: 'phase-contract', text: 'contract', [field]: 'invented'
    }], { resolveOwnerBinding: resolver([valid]) }), (error) => (
      error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && error.details.unknownFields.includes(field)
    ));
  }
});

test('source bytes, source reference, digest, and length must match the owner capture', () => {
  const exactText = 'owner bytes';
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'changed bytes' }
  ], {
    resolveOwnerBinding: resolver([ownerBinding('phase-contract', exactText)])
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED'
      && /differs/u.test(error.message));

  const mismatchedRef = ownerBinding('phase-contract', exactText, {
    sourceRef: 'git:abc123:different.md'
  });
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: exactText }
  ], { resolveOwnerBinding: resolver([mismatchedRef]) }), (error) => (
    error.code === 'TKR_PROTECTED_CONTENT_CHANGED' && /sourceRef/u.test(error.message)
  ));

  const wrongDigest = ownerBinding('phase-contract', exactText, {
    sourceSha256: `sha256:${'0'.repeat(64)}`
  });
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: exactText }
  ], { resolveOwnerBinding: resolver([wrongDigest]) }), (error) => (
    error.code === 'TKR_RENDER_CONFLICT' && /digest or byte length/u.test(error.message)
  ));

  const wrongLength = ownerBinding('phase-contract', exactText, {
    sourceByteLength: Buffer.byteLength(exactText) + 1
  });
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: exactText }
  ], { resolveOwnerBinding: resolver([wrongLength]) }), hasCode('TKR_RENDER_CONFLICT'));
});

test('forged, tampered, and wrong-renderer bindings fail closed', () => {
  const valid = ownerBinding('phase-contract', 'contract');
  const tampered = { ...valid, assuranceRef: 'assurance:forged@1' };
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], { resolveOwnerBinding: resolver([tampered]) }), (error) => (
    error.code === 'TKR_RENDER_CONFLICT' && /content-integrity/u.test(error.message)
  ));

  const malformed = { ...valid, bindingSha256: 'sha256:bad' };
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], { resolveOwnerBinding: resolver([malformed]) }), hasCode('TKR_CONTRACT_UNSUPPORTED'));

  const wrongRenderer = ownerBinding('phase-contract', 'contract', {
    rendererRef: contractSet.generatedRendererRef
  });
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], { resolveOwnerBinding: resolver([wrongRenderer]) }), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED' && /rendererRef/u.test(error.message)
  ));
});

test('qualified coverage retains the exact subject, role, and requirement', () => {
  for (const override of [
    { subjectRef: subject('phase-contract', { revision: 'git:different' }) },
    { evidenceRole: 'source' },
    { requirementRef: 'requirement:different@1' }
  ]) {
    const subjectRef = subject('phase-contract');
    const binding = ownerBinding('phase-contract', 'contract', {
      subjectRef,
      coverage: [{
        claimRef: 'claim:phase-contract@abc123',
        subjectRef,
        evidenceRole: 'policy',
        requirementRef: 'requirement:phase-contract@abc123',
        ...override
      }]
    });
    assert.throws(() => promptSectionsToTokenReductionOffers([
      { id: 'phase-contract', text: 'contract' }
    ], { resolveOwnerBinding: resolver([binding]) }), hasCode('TKR_COVERAGE_UNPROVEN'));
  }
});

test('optional applicability and omission metadata come only from the owner binding', () => {
  const optionalText = `Optional reference ${'x'.repeat(5000)}`;
  const phase = ownerBinding('phase-contract', 'Required phase.', { priority: 0 });
  const optional = ownerBinding('approved-reference-previews', optionalText, {
    applicability: 'optional',
    expansionRefs: ['wmp:packet-1:approved-reference-previews'],
    assuranceRef: 'assurance:reference-owner@4',
    priority: 100
  });
  const result = composePromptSectionsWithTokenReduction({
    sections: [
      { id: 'phase-contract', text: 'Required phase.' },
      { id: 'approved-reference-previews', text: optionalText }
    ],
    maximumBytes: 1400,
    resolveOwnerBinding: resolver([phase, optional])
  });
  const omitted = result.sectionReport.sections.find((entry) => (
    entry.id === 'approved-reference-previews'
  ));
  assert.equal(omitted.applicability, 'optional');
  assert.equal(omitted.outcome, 'omitted');
  assert.equal(omitted.omission.reason, 'budget');
  assert.deepEqual(omitted.omission.expansionRefs,
    ['wmp:packet-1:approved-reference-previews']);
  assert.equal(omitted.assuranceRef, optional.assuranceRef);
});

test('not-applicable is an explicit owner decision with no hidden content', () => {
  const phase = ownerBinding('phase-contract', 'Required phase.', { priority: 0 });
  const decisionRef = 'decision:WRK-101:ast-context:not-applicable@revision-1';
  const notApplicable = ownerBinding('optional-ast-context', null, {
    applicability: 'not-applicable', applicabilityDecisionRef: decisionRef
  });
  const result = composePromptSectionsWithTokenReduction({
    sections: [
      { id: 'phase-contract', text: 'Required phase.' },
      { id: 'optional-ast-context', text: null }
    ],
    maximumBytes: 4096,
    resolveOwnerBinding: resolver([phase, notApplicable])
  });
  const ast = result.sectionReport.sections.find((entry) => (
    entry.id === 'optional-ast-context'
  ));
  assert.equal(ast.outcome, 'omitted');
  assert.equal(ast.omission.reason, 'not-applicable');
  assert.equal(ast.applicabilityDecisionRef, decisionRef);
  assert.equal(ast.ownerBindingRef, notApplicable.bindingSha256);

  for (const binding of [
    ownerBinding('optional-ast-context', null, {
      applicability: 'not-applicable', applicabilityDecisionRef: '   '
    }),
    ownerBinding('optional-ast-context', null, {
      applicability: 'not-applicable', sourceBytes: 'hidden bytes'
    }),
    ownerBinding('optional-ast-context', null, {
      applicability: 'not-applicable', expansionRefs: ['ast:expand']
    })
  ]) {
    assert.throws(() => promptSectionsToTokenReductionOffers([
      { id: 'optional-ast-context', text: null }
    ], { resolveOwnerBinding: resolver([binding]) }), (error) => (
      ['TKR_CONTRACT_UNSUPPORTED', 'TKR_PROTECTED_CONTENT_CHANGED'].includes(error.code)
    ));
  }
});

test('fake semantic and renderer closures fail before owner resolution', () => {
  let calls = 0;
  const fakeComposer = structuredClone(contractSet.composer);
  fakeComposer.contractSha256 = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], {
    contractSet: {
      composer: fakeComposer,
      contracts: contractSet.contracts,
      rendererContracts: contractSet.rendererContracts
    },
    resolveOwnerBinding() {
      calls += 1;
      return ownerBinding('phase-contract', 'contract');
    }
  }), (error) => ['TKR_RENDER_CONFLICT', 'TKR_CONTRACT_UNSUPPORTED'].includes(error.code));
  assert.equal(calls, 0);

  const fakeRenderer = structuredClone(contractSet.rendererContracts[0]);
  fakeRenderer.registrationSha256 = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], {
    contractSet: {
      composer: contractSet.composer,
      contracts: contractSet.contracts,
      rendererContracts: [fakeRenderer, contractSet.rendererContracts[1]]
    },
    resolveOwnerBinding() {
      calls += 1;
      return ownerBinding('phase-contract', 'contract');
    }
  }), (error) => ['TKR_RENDER_CONFLICT', 'TKR_CONTRACT_UNSUPPORTED'].includes(error.code));
  assert.equal(calls, 0);
});

test('section and working-byte ceilings run before owner resolution', () => {
  let calls = 0;
  const tooManySections = Array.from({ length: 257 }, (_, index) => ({
    id: `section-${index}`, text: 'x'
  }));
  assert.throws(() => promptSectionsToTokenReductionOffers(tooManySections, {
    resolveOwnerBinding() { calls += 1; return null; }
  }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumSections');
  assert.equal(calls, 0);

  const hugeText = 'x'.repeat(
    contractSet.logicalComposer.limits.maximumWorkingMetadataBytes + 1
  );
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: hugeText }
  ], {
    resolveOwnerBinding() { calls += 1; return null; }
  }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumWorkingMetadataBytes');
  assert.equal(calls, 0);
});

test('raw coverage and expansion counts are bounded before mapping', () => {
  const base = ownerBinding('phase-contract', 'contract');
  const tooMuchCoverage = {
    ...base,
    coverage: Array.from({ length: 2049 }, (_, index) => ({
      claimRef: `claim:${index}`,
      subjectRef: base.subjectRef,
      evidenceRole: base.evidenceRole,
      requirementRef: base.requirementRef
    }))
  };
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], { resolveOwnerBinding: () => tooMuchCoverage }), (error) => (
    error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumCoverageClaims'
  ));

  const tooManyExpansions = {
    ...base,
    expansionRefs: Array.from({ length: 4097 }, (_, index) => `expand:${index}`)
  };
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], { resolveOwnerBinding: () => tooManyExpansions }), (error) => (
    error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumExpansionRefs'
  ));
});

test('oversized owner metadata is refused before digest or composition work', () => {
  const base = ownerBinding('phase-contract', 'contract');
  const largeValue = 'm'.repeat(4096);
  const oversized = {
    ...base,
    limitations: Array.from({ length: 4096 }, (_, index) => `${index}:${largeValue}`)
  };
  assert.throws(() => promptSectionsToTokenReductionOffers([
    { id: 'phase-contract', text: 'contract' }
  ], { resolveOwnerBinding: () => oversized }), hasCode('TKR_LIMIT_EXCEEDED'));
});
