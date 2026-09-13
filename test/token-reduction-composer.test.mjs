import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  composeTokenReductionContext as composeTokenReductionContextRaw,
  TKR_ERROR_CODES,
  tokenReductionByteRef,
  validateTkrAliases,
  validateTkrComposerContract
} from '../src/token-reduction-composer.mjs';
import {
  createTkrComposerContract,
  createTkrDeduplicationRules,
  createTkrNormalizationRules,
  createTkrOrderingRules,
  createTkrProtectedTextRules,
  createTkrRepresentationRules,
  tkrContractReference,
  validateTkrContractSet
} from '../src/token-reduction/contracts.mjs';
import {
  TKR_GENERATED_RENDERER_REF
} from '../src/token-reduction/generated-renderer.mjs';
import {
  createTkrRuntimeRendererRegistration
} from '../src/token-reduction/renderer-contracts.mjs';

function exactRef(name, character = 'a') {
  return `sflow-core/tkr/renderer/${name}@1#sha256:${character.repeat(64)}`;
}

const REFS = Object.freeze({
  plain: exactRef('plain-renderer', '6'),
  brief: exactRef('brief-renderer', '7'),
  reference: exactRef('reference-renderer', '8'),
  omissions: TKR_GENERATED_RENDERER_REF,
  aliases: TKR_GENERATED_RENDERER_REF
});

const CONTRACTS_BY_COMPOSER = new WeakMap();

function composeTokenReductionContext(options) {
  const registered = CONTRACTS_BY_COMPOSER.get(options.contract);
  return composeTokenReductionContextRaw({
    ...options,
    contracts: options.contracts ?? registered?.contracts,
    rendererContracts: options.rendererContracts ?? registered?.rendererContracts
  });
}

function runtimeRendererContracts() {
  return [
    ['plain-renderer', REFS.plain, 'source-pass-through', 'literal-utf8'],
    ['brief-renderer', REFS.brief, 'source-pass-through', 'literal-utf8'],
    ['reference-renderer', REFS.reference, 'source-pass-through', 'literal-utf8'],
    ['worldmodel-prompt-generated.exact-json-v1', TKR_GENERATED_RENDERER_REF,
      'generated-framing', 'canonical-json-utf8']
  ].map(([rendererId, rendererRef, mode, format]) => (
    createTkrRuntimeRendererRegistration({
      owner: 'sflow-core', rendererId, rendererRef, mode, format,
      implementationSha256: rendererRef.slice(rendererRef.indexOf('#') + 1)
    })
  ));
}

function rule(id, {
  slot = 'context-data', orderGroup = 'context', stability = 'dynamic',
  permittedRoles = ['context-data'], dependencies = [], generator = undefined,
  rendererRef = undefined
} = {}) {
  return {
    id, slot, orderGroup, stability, permittedRoles, dependencies,
    generator: generator ?? null,
    rendererRef: generator ? rendererRef : null
  };
}

function ruleContracts() {
  const common = { owner: 'sflow-core', contractId: 'tkr.composer-tests' };
  return [
    createTkrRepresentationRules({
      ...common,
      representations: [
        { id: 'full', completeness: 'complete', expansion: 'not-required' },
        { id: 'exact-excerpt', completeness: 'selected', expansion: 'required' },
        { id: 'deterministic-brief', completeness: 'selected', expansion: 'required' },
        { id: 'reference-only', completeness: 'selected', expansion: 'required' }
      ],
      undeclaredInputBehavior: 'preserve-existing-required-representation',
      emptyContentBehavior: 'refuse',
      unknownRequiredApplicabilityBehavior: 'refuse'
    }),
    createTkrDeduplicationRules({
      ...common,
      identity: 'owner-qualified-subject-revision-role',
      textEqualitySufficient: false,
      coverageProofRequired: true,
      revalidateAfterBudgeting: true,
      carrierRemoval: 'refuse-when-required-claims-depend'
    }),
    createTkrProtectedTextRules({
      ...common,
      sourceModes: ['verbatim', 'lossless-encoded'],
      normalizationScope: 'generated-framing-only',
      continuityProofRequired: true,
      verifyAfterComposition: true
    }),
    createTkrOrderingRules({
      ...common,
      stableOrder: 'declared-section-order',
      dynamicOrder: 'purpose-rule-qualified-subject',
      dependencyPolicy: 'preserve',
      rolePolicy: 'preserve',
      setOrdering: 'unicode-code-point'
    }),
    createTkrNormalizationRules({
      ...common,
      scope: 'generated-framing-only',
      sourceBytes: 'unchanged',
      authorityBytes: 'unchanged',
      generatedLineEndings: 'lf',
      generatedWhitespace: 'preserve'
    })
  ];
}

function contractSet(sectionRules, limits = {}) {
  const contracts = ruleContracts();
  const rendererContracts = runtimeRendererContracts();
  const byKind = new Map(contracts.map((entry) => [entry.kind, entry]));
  const composer = createTkrComposerContract({
    owner: 'sflow-core',
    contractId: 'tkr.composer-tests',
    sectionRules,
    representationRulesRef: tkrContractReference(byKind.get('tkr/representation-rules')),
    deduplicationRulesRef: tkrContractReference(byKind.get('tkr/deduplication-rules')),
    renderers: [...new Set([
      REFS.plain, REFS.brief, REFS.reference, REFS.omissions, REFS.aliases
    ])],
    protectedTextRulesRef: tkrContractReference(byKind.get('tkr/protected-text-rules')),
    orderingRulesRef: tkrContractReference(byKind.get('tkr/ordering-rules')),
    normalizationRulesRef: tkrContractReference(byKind.get('tkr/normalization-rules')),
    limits: {
      maximumSections: 32,
      maximumCandidatesPerSubject: 4,
      maximumCoverageClaims: 128,
      maximumAliases: 32,
      maximumWorkingMetadataBytes: 1024 * 1024,
      ...limits
    }
  }, { contracts, rendererContracts });
  CONTRACTS_BY_COMPOSER.set(composer, { contracts, rendererContracts });
  return { composer, contracts, rendererContracts };
}

function contract(sectionRules, limits = {}) {
  return contractSet(sectionRules, limits).composer;
}

function subject(id = 'requirements', overrides = {}) {
  return {
    owner: 'fixture-owner',
    domain: 'repository:payments@abc123',
    kind: 'artifact',
    id,
    revision: 'revision-1',
    sourceRef: `git:abc123:${id}.md`,
    ...overrides
  };
}

function byteRef(content) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.length
  };
}

function candidate(content, {
  representation = 'full', rendererRef = REFS.plain, coverage = ['AC-001'],
  expansionRefs = [], limitations = [], protectedSpans = [], aliasUses = []
} = {}) {
  return {
    representation,
    rendererRef,
    content,
    renderedRef: byteRef(content),
    coverage,
    expansionRefs,
    limitations,
    protectedSpans,
    aliasUses
  };
}

function offer(sectionId, {
  subjectRef = subject(sectionId), evidenceRole = 'context-data',
  assuranceRef = 'assurance:captured@1', requirementRef = `requirement:${sectionId}@1`,
  applicability = 'required', permittedRepresentations = ['full'], coverage = ['AC-001'],
  representations = [candidate(sectionId, { coverage })], priority = 0, limitations = []
} = {}) {
  return {
    sectionId,
    subjectRef,
    evidenceRole,
    assuranceRef,
    requirementRef,
    applicability,
    permittedRepresentations,
    coverage,
    representations,
    priority,
    limitations
  };
}

test('M1 composer is deterministic, honors slot/role/order/dependencies, and seals exact UTF-8 ranges', () => {
  const policy = 'Pinned invariant policy.';
  const context = 'Requirement: Caf\u00e9 \ud83d\udee0\ufe0f\n<!-- meaningful -->';
  const contextBytes = Buffer.from(context, 'utf8');
  const protectedStart = contextBytes.indexOf(Buffer.from('Caf\u00e9', 'utf8'));
  const registered = contractSet([
    rule('policy', {
      slot: 'developer-instructions', orderGroup: 'instructions', stability: 'invariant',
      permittedRoles: ['developer']
    }),
    rule('requirements', { dependencies: ['policy'] })
  ]);
  const composer = registered.composer;
  assert.equal(validateTkrContractSet(registered).composer.contractSha256, composer.contractSha256);
  const offers = [
    offer('requirements', {
      representations: [candidate(context, {
        protectedSpans: [{
          sourceRef: 'git:abc123:requirements.md#bytes=0-5',
          sourceBytes: 'Caf\u00e9', sourceStart: 0, sourceEnd: 5,
          renderedStart: protectedStart, renderedEnd: protectedStart + 5,
          encoding: 'literal-utf8'
        }]
      })]
    }),
    offer('policy', {
      evidenceRole: 'developer',
      representations: [candidate(policy)]
    })
  ];

  const first = composeTokenReductionContext({
    contract: composer, contracts: registered.contracts, offers, maximumBytes: 4096
  });
  const second = composeTokenReductionContext({
    contract: composer, contracts: registered.contracts,
    offers: [...offers].reverse(), maximumBytes: 4096
  });
  assert.equal(first.content, `${policy}\n\n${context}`);
  assert.equal(first.content, second.content);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.composerSha256, composer.contractSha256);
  assert.equal(first.sha256, tokenReductionByteRef(first.content).sha256);
  assert.deepEqual(first.segments.map(({ id, role, slot }) => ({ id, role, slot })), [
    { id: 'policy', role: 'developer', slot: 'developer-instructions' },
    { id: 'requirements', role: 'context-data', slot: 'context-data' }
  ]);
  const completeBytes = Buffer.from(first.content, 'utf8');
  assert.deepEqual(first.segments.map(({ start, end }) => (
    completeBytes.subarray(start, end).toString('utf8')
  )), [
    policy, context
  ]);
  const protectedBinding = first.protectedText[0];
  assert.equal(
    Buffer.from(first.content).subarray(
      protectedBinding.blockRange.start, protectedBinding.blockRange.end
    ).toString('utf8'),
    'Caf\u00e9'
  );
  assert.equal(first.separators.length, 1);
  assert.deepEqual(first.separators[0], {
    start: Buffer.byteLength(policy),
    end: Buffer.byteLength(policy) + 2,
    bytes: 2,
    sha256: byteRef('\n\n').sha256
  });
});

test('protected source text is byte-exact and cannot be normalized or split inside UTF-8', () => {
  const composer = contract([rule('requirements')]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    maximumBytes: 4096,
    offers: [offer('requirements', {
      representations: [candidate('e\u0301', {
        protectedSpans: [{
          sourceRef: 'git:abc123:requirements.md#bytes=0-2',
          sourceBytes: '\u00e9', sourceStart: 0, sourceEnd: 2,
          renderedStart: 0, renderedEnd: 3, encoding: 'literal-utf8'
        }]
      })]
    })]
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED'
      && error.details.expectedSha256 !== error.details.actualSha256);

  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    maximumBytes: 4096,
    offers: [offer('requirements', {
      representations: [candidate('\ud83d\udee0\ufe0f', {
        protectedSpans: [{
          sourceRef: 'git:abc123:requirements.md#bytes=1-7',
          sourceBytes: '\ud83d\udee0\ufe0f', sourceStart: 1, sourceEnd: 7,
          renderedStart: 1, renderedEnd: 7, encoding: 'literal-utf8'
        }]
      })]
    })]
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED'
      && /UTF-8 byte boundaries/.test(error.message));

  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    maximumBytes: 4096,
    offers: [offer('requirements', {
      representations: [candidate('exact', {
        protectedSpans: [{
          sourceRef: 'git:abc123:another-owner.md#bytes=0-5',
          sourceBytes: 'exact', sourceStart: 0, sourceEnd: 5,
          renderedStart: 0, renderedEnd: 5, encoding: 'literal-utf8'
        }]
      })]
    })]
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED'
      && /enclosing owner subject/u.test(error.message));
});

test('qualified coverage cannot escape its enclosing subject, role, or requirement', () => {
  const composer = contract([rule('requirements')]);
  const enclosing = subject('requirements');
  const validCoverage = [{
    claimRef: 'AC-001',
    subjectRef: enclosing,
    evidenceRole: 'context-data',
    requirementRef: 'requirement:requirements@1'
  }];
  const foreignCoverage = [{
    ...validCoverage[0],
    subjectRef: subject('foreign'),
    requirementRef: 'requirement:foreign@1'
  }];
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      subjectRef: enclosing,
      coverage: foreignCoverage,
      representations: [candidate('requirements', { coverage: foreignCoverage })]
    })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.mismatched.includes('subjectRef'));
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      subjectRef: enclosing,
      coverage: validCoverage,
      representations: [candidate('requirements', { coverage: foreignCoverage })]
    })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.mismatched.includes('subjectRef'));
});

test('coverage-proof dedup removes only an exactly bound duplicate and annotates its carrier', () => {
  const shared = subject('approved-requirements');
  const composer = contract([rule('capsule'), rule('input-preview')]);
  const exactPresentation = 'Capsule contains exact AC-001.';
  const offers = [
    offer('capsule', {
      subjectRef: shared,
      requirementRef: 'requirement:approved-input@1',
      representations: [candidate(exactPresentation)]
    }),
    offer('input-preview', {
      subjectRef: shared,
      requirementRef: 'requirement:approved-input@1',
      representations: [candidate(exactPresentation)]
    })
  ];
  const proof = {
    removedSectionId: 'input-preview',
    removedRepresentation: 'full',
    carrierSectionId: 'capsule',
    carrierRepresentation: 'full',
    coverage: ['AC-001'],
    ruleRef: composer.deduplicationRulesRef
  };
  const result = composeTokenReductionContext({
    contract: composer, offers, deduplicationProofs: [proof], maximumBytes: 4096
  });
  assert.equal(result.content, 'Capsule contains exact AC-001.');
  assert.deepEqual(result.segments.map((entry) => entry.id), ['capsule']);
  assert.equal(result.segments[0].carried[0].sectionId, 'input-preview');
  assert.equal(result.segments[0].carried[0].evidenceRole, 'context-data');
  assert.equal(result.omissions[0].reason, 'duplicate');
  assert.equal(result.omissions[0].carrierSectionId, 'capsule');
  assert.match(result.deduplication[0].coverageProofSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('dedup refuses matching words when qualified evidence-role coverage is absent', () => {
  const shared = subject('approved-requirements');
  const composer = contract([
    rule('capsule', { permittedRoles: ['capsule'] }),
    rule('review-evidence', { permittedRoles: ['review-evidence'] })
  ]);
  const offers = [
    offer('capsule', {
      subjectRef: shared, evidenceRole: 'capsule',
      representations: [candidate('same text')]
    }),
    offer('review-evidence', {
      subjectRef: shared, evidenceRole: 'review-evidence',
      representations: [candidate('same text')]
    })
  ];
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers,
    deduplicationProofs: [{
      removedSectionId: 'review-evidence', removedRepresentation: 'full',
      carrierSectionId: 'capsule', carrierRepresentation: 'full',
      coverage: ['AC-001'], ruleRef: composer.deduplicationRulesRef
    }],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.unsatisfiedCoverage[0].evidenceRole === 'review-evidence');
});

test('budgeting selects only a later permitted representation with identical required coverage', () => {
  const composer = contract([rule('implementation')]);
  const full = `Full requirements ${'x'.repeat(500)}`;
  const brief = `Brief ${'y'.repeat(80)}`;
  const result = composeTokenReductionContext({
    contract: composer,
    offers: [offer('implementation', {
      permittedRepresentations: ['full', 'deterministic-brief'],
      representations: [
        candidate(full),
        candidate(brief, {
          representation: 'deterministic-brief', rendererRef: REFS.brief,
          expansionRefs: ['source:implementation@revision-1#bytes=0-1024']
        })
      ]
    })],
    maximumBytes: 128
  });
  assert.equal(result.content, brief);
  assert.equal(result.segments[0].representation, 'deterministic-brief');
  assert.equal(result.segments[0].coverage[0].claimRef, 'AC-001');
  assert.deepEqual(result.reduction.accepted.map((entry) => entry.action), ['representation']);
  assert.ok(result.reduction.initialBytes > result.reduction.finalBytes);
});

test('optional omission is reverse deterministic, expandable, visible, and budget-accounted', () => {
  const composer = contract([
    rule('required'),
    rule('valuable', { dependencies: ['required'] }),
    rule('background', { dependencies: ['required'] }),
    rule('omission-notices', {
      generator: 'omission-notices', rendererRef: REFS.omissions,
      dependencies: ['required']
    })
  ]);
  const background = `Background ${'b'.repeat(700)}`;
  const result = composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('required', { representations: [candidate('Required core.')] }),
      offer('valuable', {
        applicability: 'optional', priority: 1,
        representations: [candidate('Keep valuable context.', {
          expansionRefs: ['wmp:packet-1:valuable']
        })]
      }),
      offer('background', {
        applicability: 'optional', priority: 100,
        representations: [candidate(background, {
          expansionRefs: ['wmp:packet-1:background'],
          limitations: ['Historical background; not current authority.']
        })]
      })
    ],
    maximumBytes: 620
  });
  assert.match(result.content, /Required core\./u);
  assert.match(result.content, /Keep valuable context\./u);
  assert.doesNotMatch(result.content, /Background bbbbb/u);
  assert.match(result.content, /tkr\/omission-notices/u);
  assert.match(result.content, /wmp:packet-1:background/u);
  assert.match(result.content, /Historical background; not current authority\./u);
  assert.deepEqual(result.omissions.filter((entry) => entry.reason === 'budget')
    .map((entry) => entry.sectionId), ['background']);
  assert.deepEqual(result.segments.map((entry) => entry.id), [
    'required', 'valuable', 'omission-notices'
  ]);
  assert.ok(result.bytes <= 620);
});

test('mandatory bytes and notices never clip when no permitted composition fits', () => {
  const composer = contract([rule('required')]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('required', { representations: [candidate('x'.repeat(512))] })],
    maximumBytes: 128
  }), (error) => error.code === 'WMP_BUDGET_TOO_SMALL'
      && error.details.maximumBytes === 128
      && error.details.measuredResidualBytes === 512
      && error.details.remainingRequiredRepresentations[0].sectionId === 'required');

  const withNotice = contract([
    rule('required'),
    rule('optional'),
    rule('omission-notices', {
      generator: 'omission-notices', rendererRef: REFS.omissions,
      dependencies: ['required']
    })
  ]);
  assert.throws(() => composeTokenReductionContext({
    contract: withNotice,
    offers: [
      offer('required', { representations: [candidate('required')] }),
      offer('optional', {
        applicability: 'optional',
        representations: [candidate('z'.repeat(500), {
          expansionRefs: ['wmp:packet-1:optional'],
          limitations: ['L'.repeat(500)]
        })]
      })
    ],
    maximumBytes: 120
  }), (error) => error.code === 'WMP_BUDGET_TOO_SMALL'
      && error.details.attemptedPermittedAlternatives.some((entry) => (
        entry.action === 'omit-optional' && entry.accepted === false
      )));
});

test('composer limits, contract refs, renderer identities, and render conflicts fail closed', () => {
  assert.deepEqual(TKR_ERROR_CODES, [
    'TKR_ALIAS_INVALID', 'TKR_CONTRACT_UNSUPPORTED', 'TKR_COVERAGE_UNPROVEN',
    'TKR_LIMIT_EXCEEDED', 'TKR_PROTECTED_CONTENT_CHANGED', 'TKR_RENDER_CONFLICT'
  ]);
  assert.throws(() => validateTkrComposerContract({
    kind: 'tkr/composer-contract', version: 1,
    sectionRules: [rule('required')]
  }), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
  ));

  const capped = contract([rule('required')], { maximumCandidatesPerSubject: 1 });
  assert.throws(() => composeTokenReductionContext({
    contract: capped,
    offers: [offer('required', {
      permittedRepresentations: ['full', 'deterministic-brief'],
      representations: [candidate('full'), candidate('brief', {
        representation: 'deterministic-brief', rendererRef: REFS.brief
      })]
    })],
    maximumBytes: 100
  }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumCandidatesPerSubject');

  const conflicted = contract([rule('required')]);
  assert.throws(() => composeTokenReductionContext({
    contract: conflicted,
    offers: [offer('required', {
      representations: [candidate('one'), candidate('two')]
    })],
    maximumBytes: 100
  }), (error) => error.code === 'TKR_RENDER_CONFLICT'
      && error.details.sectionId === 'required');
});

test('aliases are target-sorted, typed, packet-scoped, rendered, and checked at every use', () => {
  const targetA = subject('a-handle', { kind: 'handle' });
  const targetB = subject('b-handle', { kind: 'handle' });
  const aliases = [
    { id: 'H2', namespace: 'H', scopeRef: 'packet-scope-1', targetRef: targetB },
    { id: 'H1', namespace: 'H', scopeRef: 'packet-scope-1', targetRef: targetA }
  ];
  assert.deepEqual(validateTkrAliases(aliases, {
    compositionScopeRef: 'packet-scope-1'
  }).map((entry) => entry.id), ['H1', 'H2']);
  const composer = contract([
    rule('requirements'),
    rule('alias-table', { generator: 'alias-table', rendererRef: REFS.aliases })
  ]);
  const result = composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      representations: [candidate('Use H1.', {
        aliasUses: [{ id: 'H1', scopeRef: 'packet-scope-1', targetRef: targetA }]
      })]
    })],
    aliases,
    compositionScopeRef: 'packet-scope-1',
    maximumBytes: 4096
  });
  assert.deepEqual(result.aliases.map((entry) => entry.id), ['H1']);
  assert.equal(result.segments.at(-1).id, 'alias-table');
  assert.match(result.content, /"id":"H1"/u);
  assert.doesNotMatch(result.content, /"id":"H2"/u);

  assert.throws(() => validateTkrAliases([
    { id: 'H2', namespace: 'H', scopeRef: 'packet-scope-1', targetRef: targetA }
  ], { compositionScopeRef: 'packet-scope-1' }), (error) => (
    error.code === 'TKR_ALIAS_INVALID' && error.details.expectedId === 'H1'
  ));
  assert.throws(() => validateTkrAliases(aliases, {
    compositionScopeRef: 'packet-scope-2'
  }), (error) => error.code === 'TKR_ALIAS_INVALID'
      && /expected composition scope/u.test(error.message));
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      representations: [candidate('Use H1.', {
        aliasUses: [{ id: 'H1', scopeRef: 'another-packet', targetRef: targetA }]
      })]
    })],
    aliases,
    compositionScopeRef: 'packet-scope-1',
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_ALIAS_INVALID' && /cross-scope/.test(error.message));
});

test('required applicability and dependencies cannot be guessed or budget-evicted', () => {
  const composer = contract([
    rule('foundation'),
    rule('implementation', { dependencies: ['foundation'] }),
    rule('omission-notices', {
      generator: 'omission-notices', rendererRef: REFS.omissions,
      dependencies: ['foundation']
    })
  ]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('foundation', { applicability: 'unknown' })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.reason === 'applicability-unknown');

  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('foundation', {
        applicability: 'optional', priority: 100,
        representations: [candidate('f'.repeat(400), {
          expansionRefs: ['wmp:packet-1:foundation']
        })]
      }),
      offer('implementation', {
        representations: [candidate('i'.repeat(400))]
      })
    ],
    maximumBytes: 500
  }), (error) => error.code === 'WMP_BUDGET_TOO_SMALL'
      && error.details.attemptedPermittedAlternatives.some((entry) => (
        entry.sectionId === 'foundation' && entry.reason === 'active-dependency'
      )));
});

test('composition refuses empty input and requires the complete five-contract semantic closure', () => {
  const registered = contractSet([rule('requirements')]);
  assert.throws(() => composeTokenReductionContextRaw(), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && /composition input must be an object/u.test(error.message)
  ));
  assert.throws(() => composeTokenReductionContextRaw({
    contract: registered.composer,
    contracts: registered.contracts,
    rendererContracts: registered.rendererContracts,
    offers: [offer('requirements')],
    maximumBytes: 4096,
    surprise: true
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && error.details.unknownFields.includes('surprise'));
  assert.throws(() => composeTokenReductionContextRaw({
    contract: registered.composer,
    offers: [offer('requirements')],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && error.details.missingCapability === 'tkr-semantic-contract-closure');
  assert.throws(() => composeTokenReductionContextRaw({
    contract: registered.composer,
    contracts: registered.contracts.slice(0, 4),
    rendererContracts: registered.rendererContracts,
    offers: [offer('requirements')],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'TKR referenced contracts');
  assert.throws(() => composeTokenReductionContext({
    contract: registered.composer,
    offers: [],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.reason === 'empty-context');
});

test('every selected representation that promises expansion carries an exact non-whitespace ref', () => {
  for (const [representation, rendererRef] of [
    ['exact-excerpt', REFS.brief],
    ['deterministic-brief', REFS.brief],
    ['reference-only', REFS.reference]
  ]) {
    const composer = contract([rule('requirements')]);
    assert.throws(() => composeTokenReductionContext({
      contract: composer,
      offers: [offer('requirements', {
        permittedRepresentations: [representation],
        representations: [candidate(`${representation} bytes`, {
          representation, rendererRef
        })]
      })],
      maximumBytes: 4096
    }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
        && error.details.reason === 'expansion-reference-unavailable');
  }
  const composer = contract([rule('requirements')]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      permittedRepresentations: ['deterministic-brief'],
      representations: [candidate('brief', {
        representation: 'deterministic-brief', rendererRef: REFS.brief,
        expansionRefs: ['  \n']
      })]
    })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && /non-whitespace/u.test(error.message));
});

test('all subject, assurance, requirement, source, scope, and decision references reject whitespace', () => {
  for (const key of ['owner', 'domain', 'kind', 'id', 'revision', 'sourceRef']) {
    const composer = contract([rule('requirements')]);
    assert.throws(() => composeTokenReductionContext({
      contract: composer,
      offers: [offer('requirements', { subjectRef: subject('requirements', { [key]: '   ' }) })],
      maximumBytes: 4096
    }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && error.details.subject.endsWith(`.${key}`));
  }
  for (const field of ['assuranceRef', 'requirementRef']) {
    const composer = contract([rule('requirements')]);
    assert.throws(() => composeTokenReductionContext({
      contract: composer,
      offers: [offer('requirements', { [field]: '\t' })],
      maximumBytes: 4096
    }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && error.details.subject.endsWith(`.${field}`));
  }
  assert.throws(() => validateTkrAliases([{
    id: 'H1', namespace: 'H', scopeRef: ' ', targetRef: subject('handle', { kind: 'handle' })
  }], { compositionScopeRef: 'packet:one' }), (error) => (
    error.code === 'TKR_ALIAS_INVALID' && /non-whitespace/u.test(error.message)
  ));
});

test('alias mappings forbid chains and retain only the deterministic prefix used after reduction', () => {
  const self = subject('H1', { kind: 'handle' });
  assert.throws(() => validateTkrAliases([{
    id: 'H1', namespace: 'H', scopeRef: 'packet:one', targetRef: self
  }], { compositionScopeRef: 'packet:one' }), (error) => (
    error.code === 'TKR_ALIAS_INVALID' && /chains and cycles/u.test(error.message)
  ));

  const targetA = subject('a-handle', { kind: 'handle' });
  const targetB = subject('b-handle', { kind: 'handle' });
  const aliases = [
    { id: 'H1', namespace: 'H', scopeRef: 'packet:one', targetRef: targetA },
    { id: 'H2', namespace: 'H', scopeRef: 'packet:one', targetRef: targetB }
  ];
  const composer = contract([
    rule('required'),
    rule('optional'),
    rule('alias-table', { generator: 'alias-table', rendererRef: REFS.aliases }),
    rule('omission-notices', { generator: 'omission-notices', rendererRef: REFS.omissions })
  ]);
  const result = composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('required', { representations: [candidate('Use H1.', {
        aliasUses: [{ id: 'H1', scopeRef: 'packet:one', targetRef: targetA }]
      })] }),
      offer('optional', {
        applicability: 'optional', priority: 100,
        representations: [candidate(`Use H2. ${'x'.repeat(800)}`, {
          expansionRefs: ['packet:one:optional'],
          aliasUses: [{ id: 'H2', scopeRef: 'packet:one', targetRef: targetB }]
        })]
      })
    ],
    aliases,
    compositionScopeRef: 'packet:one',
    maximumBytes: 800
  });
  assert.deepEqual(result.aliases.map((entry) => entry.id), ['H1']);
  assert.doesNotMatch(result.content, /"id":"H2"/u);
  assert.equal(result.omissions.find((entry) => entry.sectionId === 'optional').reason, 'budget');
  assert.equal(result.processing.aliasEntries, 2);
  assert.equal(result.processing.retainedAliasEntries, 1);
});

test('ordinary candidates cannot impersonate the kernel-generated renderer', () => {
  const composer = contract([rule('requirements')]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      representations: [candidate('arbitrary generated-looking bytes', {
        rendererRef: TKR_GENERATED_RENDERER_REF
      })]
    })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && /reserved for composer-generated/u.test(error.message));
});

test('candidate and coverage limits count supplied ineligible alternatives before filtering', () => {
  const composer = contract([rule('requirements')], { maximumCoverageClaims: 3 });
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [offer('requirements', {
      permittedRepresentations: ['full', 'deterministic-brief'],
      representations: [
        candidate('complete'),
        candidate('ineligible brief', {
          representation: 'deterministic-brief', rendererRef: REFS.brief,
          coverage: ['AC-OTHER', 'AC-UNUSED'], expansionRefs: ['source:requirements@1']
        })
      ]
    })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumCoverageClaims'
      && error.details.required === 4);
});

test('section and nested candidate collection limits fail before mapping hostile entries', () => {
  const oneSection = contract([rule('only')], { maximumSections: 4 });
  assert.throws(() => composeTokenReductionContext({
    contract: oneSection,
    offers: [offer('only'), null, null, null, null],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumSections'
      && error.details.required === 5);

  const bounded = contract([rule('requirements')], {
    maximumCoverageClaims: 3,
    maximumAliases: 2
  });
  for (const [field, value, expectedLimit] of [
    ['expansionRefs', ['one', 'two', 'three', 'four'], 'maximumCoverageClaims'],
    ['limitations', ['one', 'two', 'three', 'four'], 'maximumCoverageClaims'],
    ['protectedSpans', [null, null, null, null], 'maximumCoverageClaims'],
    ['aliasUses', [null, null, null], 'maximumAliases']
  ]) {
    assert.throws(() => composeTokenReductionContext({
      contract: bounded,
      offers: [offer('requirements', {
        representations: [candidate('requirements', { [field]: value })]
      })],
      maximumBytes: 4096
    }), (error) => error.code === 'TKR_LIMIT_EXCEEDED'
        && error.details.limit === expectedLimit, field);
  }
  for (const field of ['protectedSpans', 'aliasUses']) {
    assert.throws(() => composeTokenReductionContext({
      contract: bounded,
      offers: [offer('requirements', {
        representations: [candidate('requirements', { [field]: 'not-an-array' })]
      })],
      maximumBytes: 4096
    }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && /must be an array/u.test(error.message), field);
  }
});

test('four phase candidates keep the invariant prefix and an instruction change ends it', () => {
  const composer = contract([
    rule('phase-contract', { stability: 'invariant', permittedRoles: ['policy'] }),
    rule('phase-input', { dependencies: ['phase-contract'] })
  ]);
  const invariant = 'Pinned instruction revision one.';
  const outputs = ['requirements', 'design', 'implementation', 'verification'].map((phase) => (
    composeTokenReductionContext({
      contract: composer,
      offers: [
        offer('phase-contract', {
          evidenceRole: 'policy', representations: [candidate(invariant)]
        }),
        offer('phase-input', { representations: [candidate(`Dynamic ${phase} input.`)] })
      ],
      maximumBytes: 4096
    })
  ));
  const invariantBytes = Buffer.from(invariant, 'utf8');
  for (const output of outputs) {
    assert.deepEqual(Buffer.from(output.content, 'utf8').subarray(0, invariantBytes.length),
      invariantBytes);
    assert.equal(output.segments[0].id, 'phase-contract');
    assert.equal(output.segments[0].stability, 'invariant');
  }
  const changed = composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('phase-contract', {
        evidenceRole: 'policy',
        representations: [candidate('Pinned instruction revision two.')]
      }),
      offer('phase-input')
    ],
    maximumBytes: 4096
  });
  assert.notEqual(changed.segments[0].sha256, outputs[0].segments[0].sha256);
  assert.notEqual(changed.sha256, outputs[0].sha256);
});

function dedupProof(composer, removedSectionId = 'duplicate', carrierSectionId = 'carrier', {
  removedRepresentation = 'full', carrierRepresentation = 'full', coverage = ['AC-001']
} = {}) {
  return {
    removedSectionId,
    removedRepresentation,
    carrierSectionId,
    carrierRepresentation,
    coverage,
    ruleRef: composer.deduplicationRulesRef
  };
}

function dedupResult({
  carrierContent = 'carrier bytes', removedContent = 'removed bytes',
  assuranceRef = 'assurance:captured@1', limitations = [], subjectRef = subject('shared')
} = {}) {
  const composer = contract([rule('carrier'), rule('duplicate')]);
  const offers = [
    offer('carrier', {
      subjectRef, assuranceRef, requirementRef: 'requirement:shared@1',
      applicability: 'optional', limitations,
      representations: [candidate(carrierContent, { limitations })]
    }),
    offer('duplicate', {
      subjectRef, assuranceRef, requirementRef: 'requirement:shared@1',
      applicability: 'optional', limitations,
      representations: [candidate(removedContent, { limitations })]
    })
  ];
  return composeTokenReductionContext({
    contract: composer,
    offers,
    deduplicationProofs: [dedupProof(composer)],
    maximumBytes: 4096
  });
}

test('dedup proof identity binds rendered refs, assurance, limitations, and exact subject provenance', () => {
  const baseline = dedupResult();
  const variants = [
    dedupResult({ carrierContent: 'changed carrier bytes' }),
    dedupResult({ assuranceRef: 'assurance:reviewed@2' }),
    dedupResult({ limitations: ['Discovery lead only.'] }),
    dedupResult({ subjectRef: subject('shared', { revision: 'revision-2' }) })
  ];
  const proof = baseline.deduplication[0];
  assert.match(proof.removedCandidateRef, /^sha256:[a-f0-9]{64}$/u);
  assert.match(proof.carrierCandidateRef, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(proof.removedBinding.assuranceRef, 'assurance:captured@1');
  for (const variant of variants) {
    assert.notEqual(variant.deduplication[0].coverageProofSha256, proof.coverageProofSha256);
  }
});

test('dedup cannot cross role, order-group, stability, assurance, subject, or completeness', () => {
  const shared = subject('shared');
  const cases = [
    {
      name: 'role',
      rules: [
        rule('carrier', { permittedRoles: ['capsule'] }),
        rule('duplicate', { permittedRoles: ['review-evidence'] })
      ],
      carrier: { evidenceRole: 'capsule' }, duplicate: { evidenceRole: 'review-evidence' },
      expected: 'evidence-role'
    },
    {
      name: 'order group',
      rules: [rule('carrier', { orderGroup: 'one' }), rule('duplicate', { orderGroup: 'two' })],
      carrier: {}, duplicate: {}, expected: 'order-group'
    },
    {
      name: 'stability',
      rules: [rule('carrier', { stability: 'invariant' }), rule('duplicate', { stability: 'dynamic' })],
      carrier: {}, duplicate: {}, expected: 'stability'
    },
    {
      name: 'assurance',
      rules: [rule('carrier'), rule('duplicate')],
      carrier: { assuranceRef: 'assurance:a@1' },
      duplicate: { assuranceRef: 'assurance:b@1' }, expected: 'assurance'
    },
    {
      name: 'subject',
      rules: [rule('carrier'), rule('duplicate')],
      carrier: { subjectRef: subject('other') }, duplicate: {}, expected: 'subject'
    }
  ];
  for (const scenario of cases) {
    const composer = contract(scenario.rules);
    const carrierOptions = {
      subjectRef: shared, requirementRef: 'requirement:shared@1',
      applicability: 'optional', ...scenario.carrier
    };
    const duplicateOptions = {
      subjectRef: shared, requirementRef: 'requirement:shared@1',
      applicability: 'optional', ...scenario.duplicate
    };
    const coverageFor = (options) => [{
      claimRef: 'AC-001',
      subjectRef: options.subjectRef,
      evidenceRole: options.evidenceRole ?? 'context-data',
      requirementRef: options.requirementRef
    }];
    const carrierCoverage = coverageFor(carrierOptions);
    const removedCoverage = coverageFor(duplicateOptions);
    carrierOptions.coverage = carrierCoverage;
    carrierOptions.representations = [candidate('same', { coverage: carrierCoverage })];
    duplicateOptions.coverage = removedCoverage;
    duplicateOptions.representations = [candidate('same', { coverage: removedCoverage })];
    assert.throws(() => composeTokenReductionContext({
      contract: composer,
      offers: [offer('carrier', carrierOptions), offer('duplicate', duplicateOptions)],
      deduplicationProofs: [dedupProof(composer, 'duplicate', 'carrier', {
        coverage: removedCoverage
      })],
      maximumBytes: 4096
    }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
        && (error.details.incompatibleBoundary?.includes(scenario.expected)
          || error.details.unsatisfiedCoverage?.length > 0), scenario.name);
  }

  const composer = contract([rule('carrier'), rule('duplicate')]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('carrier', {
        subjectRef: shared, requirementRef: 'requirement:shared@1', applicability: 'optional'
      }),
      offer('duplicate', {
        subjectRef: shared, requirementRef: 'requirement:shared@1', applicability: 'optional',
        permittedRepresentations: ['deterministic-brief'],
        representations: [candidate('same', {
          representation: 'deterministic-brief', rendererRef: REFS.brief,
          expansionRefs: ['source:shared@1']
        })]
      })
    ],
    deduplicationProofs: [dedupProof(composer, 'duplicate', 'carrier', {
      removedRepresentation: 'deterministic-brief'
    })],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.incompatibleBoundary.includes('completeness'));
});

test('dedup never erases required bytes, protected continuity, limitations, expansion refs, or aliases', () => {
  const shared = subject('shared');
  const composer = contract([rule('carrier'), rule('duplicate')]);
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('carrier', {
        subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('carrier bytes')]
      }),
      offer('duplicate', {
        subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('required bytes')]
      })
    ],
    deduplicationProofs: [dedupProof(composer)],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED');

  const protectedSpan = [{
    sourceRef: 'git:abc123:shared.md#bytes=0-5', sourceBytes: 'exact',
    sourceStart: 0, sourceEnd: 5, renderedStart: 0, renderedEnd: 5,
    encoding: 'literal-utf8'
  }];
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('carrier', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        applicability: 'optional',
        representations: [candidate('carrier')] }),
      offer('duplicate', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        applicability: 'optional',
        representations: [candidate('exact duplicate', { protectedSpans: protectedSpan })] })
    ],
    deduplicationProofs: [dedupProof(composer)],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_PROTECTED_CONTENT_CHANGED'
      && error.details.missingProtectedContinuity.length === 1);

  for (const [name, removedCandidateOptions, carrierCandidateOptions, code] of [
    ['limitation', { limitations: ['retain me'] }, {}, 'TKR_COVERAGE_UNPROVEN'],
    ['expansion', { expansionRefs: ['source:shared@1'] }, {}, 'TKR_COVERAGE_UNPROVEN']
  ]) {
    assert.throws(() => composeTokenReductionContext({
      contract: composer,
      offers: [
        offer('carrier', { subjectRef: shared, requirementRef: 'requirement:shared@1',
          applicability: 'optional',
          representations: [candidate('carrier', carrierCandidateOptions)] }),
        offer('duplicate', { subjectRef: shared, requirementRef: 'requirement:shared@1',
          applicability: 'optional',
          representations: [candidate('duplicate', removedCandidateOptions)] })
      ],
      deduplicationProofs: [dedupProof(composer)],
      maximumBytes: 4096
    }), (error) => error.code === code, name);
  }

  const target = subject('handle', { kind: 'handle' });
  assert.throws(() => composeTokenReductionContext({
    contract: composer,
    offers: [
      offer('carrier', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        applicability: 'optional',
        representations: [candidate('H1 carrier')] }),
      offer('duplicate', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        applicability: 'optional',
        representations: [candidate('H1 duplicate', {
          aliasUses: [{ id: 'H1', scopeRef: 'packet:one', targetRef: target }]
        })] })
    ],
    aliases: [{ id: 'H1', namespace: 'H', scopeRef: 'packet:one', targetRef: target }],
    compositionScopeRef: 'packet:one',
    deduplicationProofs: [dedupProof(composer)],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_ALIAS_INVALID' && /retain every alias/u.test(error.message));
});

test('dedup carriers and every carried dependency preserve final declared order', () => {
  const shared = subject('shared');
  const invalid = contract([
    rule('carrier'),
    rule('foundation'),
    rule('duplicate', { dependencies: ['foundation'] })
  ]);
  assert.throws(() => composeTokenReductionContext({
    contract: invalid,
    offers: [
      offer('carrier', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('same')] }),
      offer('foundation'),
      offer('duplicate', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('same')] })
    ],
    deduplicationProofs: [dedupProof(invalid)],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.reason === 'dependency-order');

  const valid = contract([
    rule('foundation'),
    rule('carrier'),
    rule('duplicate', { dependencies: ['foundation'] })
  ]);
  const result = composeTokenReductionContext({
    contract: valid,
    offers: [
      offer('foundation'),
      offer('carrier', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('same')] }),
      offer('duplicate', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('same')] })
    ],
    deduplicationProofs: [dedupProof(valid)],
    maximumBytes: 4096
  });
  assert.deepEqual(result.segments.map((entry) => entry.id), ['foundation', 'carrier']);
  assert.deepEqual(result.segments[1].carried[0].dependencies, ['foundation']);

  const later = contract([rule('duplicate'), rule('carrier')]);
  assert.throws(() => composeTokenReductionContext({
    contract: later,
    offers: [
      offer('duplicate', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('same')] }),
      offer('carrier', { subjectRef: shared, requirementRef: 'requirement:shared@1',
        representations: [candidate('same')] })
    ],
    deduplicationProofs: [dedupProof(later)],
    maximumBytes: 4096
  }), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && error.details.incompatibleBoundary.includes('carrier-order'));
});
