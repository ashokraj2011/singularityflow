import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  renderTkrGeneratedSection,
  TKR_GENERATED_RENDERER_CONTRACT,
  TKR_GENERATED_RENDERER_REF,
  validateTkrGeneratedRendererContract
} from '../src/token-reduction/generated-renderer.mjs';
import { sha256 } from '../src/world-model/canonicalize.mjs';

const SUBJECT = Object.freeze({
  owner: 'fixture-owner',
  domain: 'repository:payments@abc123',
  kind: 'artifact',
  id: 'requirements',
  revision: 'revision-1',
  sourceRef: 'git:abc123:requirements.md'
});

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function alias(overrides = {}) {
  return {
    id: 'S1', namespace: 'S', scopeRef: 'packet:fixture@1', targetRef: SUBJECT,
    ...overrides
  };
}

function omission(overrides = {}) {
  return {
    sectionId: 'optional-ast-context',
    subjectRef: SUBJECT,
    reason: 'budget',
    originalRenderedRef: { sha256: `sha256:${'a'.repeat(64)}`, bytes: 4096 },
    expansionRefs: ['source:ast@revision-1'],
    limitations: [],
    ...overrides
  };
}

function hasCode(code) {
  return (error) => error?.name === 'SingularityFlowError' && error.code === code;
}

test('generated renderer contract and exact JSON bytes match reviewed goldens', () => {
  assert.equal(validateTkrGeneratedRendererContract(TKR_GENERATED_RENDERER_CONTRACT),
    TKR_GENERATED_RENDERER_CONTRACT);
  assert.equal(TKR_GENERATED_RENDERER_CONTRACT.contractSha256,
    'sha256:6cc281543e2ef8bf659aeaa7bdfa1b1d099266f582560156dad8261356316bee');
  assert.equal(TKR_GENERATED_RENDERER_REF,
    'sflow-core/tkr/renderer/worldmodel-prompt-generated.exact-json-v1@1'
      + '#sha256:6cc281543e2ef8bf659aeaa7bdfa1b1d099266f582560156dad8261356316bee');

  const aliasBytes = renderTkrGeneratedSection('alias-table', {
    aliases: [{
      id: 'S1', namespace: 'S', scopeRef: 'packet:fixture@1', targetRef: SUBJECT
    }]
  });
  assert.equal(aliasBytes.toString('utf8'),
    '{"entries":[{"id":"S1","namespace":"S","scopeRef":"packet:fixture@1",'
      + '"targetRef":{"domain":"repository:payments@abc123","id":"requirements",'
      + '"kind":"artifact","owner":"fixture-owner","revision":"revision-1",'
      + '"sourceRef":"git:abc123:requirements.md"}}],"kind":"tkr/alias-table",'
      + '"scopeRef":"packet:fixture@1","version":1}');
  assert.equal(digest(aliasBytes),
    'sha256:9191b41489497c6d87364131422d78a3f55886cfb726b28733609a4120d344eb');

  const omissionBytes = renderTkrGeneratedSection('omission-notices', {
    omissions: [omission()]
  });
  assert.equal(digest(omissionBytes),
    'sha256:67f6fd0b3f44e19eec56b625005e81e5a583dcf054d39b68efad32d13815252e');
  assert.equal(omissionBytes.at(-1), '}'.charCodeAt(0), 'format has no trailing newline');
});

test('generated renderer contract, reference, and algorithm tampering fail closed', () => {
  const staleHash = structuredClone(TKR_GENERATED_RENDERER_CONTRACT);
  staleHash.format.trailingNewline = true;
  assert.throws(() => validateTkrGeneratedRendererContract(staleHash), (error) => (
    error.code === 'TKR_RENDER_CONFLICT'
  ));

  const rehashedAlternative = structuredClone(TKR_GENERATED_RENDERER_CONTRACT);
  rehashedAlternative.generators[0].itemOrder = 'caller-order';
  const withoutHash = structuredClone(rehashedAlternative);
  delete withoutHash.contractSha256;
  // A newly calculated digest cannot turn an unregistered algorithm into the packaged renderer.
  rehashedAlternative.contractSha256 = sha256(withoutHash);
  assert.throws(() => validateTkrGeneratedRendererContract(rehashedAlternative), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
  ));

  assert.throws(() => renderTkrGeneratedSection('alias-table', { aliases: [] }, {
    rendererRef: TKR_GENERATED_RENDERER_REF.replace(/.$/u, '0')
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');
  assert.throws(() => renderTkrGeneratedSection('invented-generator'), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
  ));
});

test('alias items are exact, typed, scope-safe, ordered, and use alias-specific refusals', () => {
  for (const invalid of [
    null,
    { id: 'S1', namespace: 'S', scopeRef: 'packet:fixture@1' },
    { ...alias(), extra: true },
    alias({ id: 7 }),
    alias({ id: 'S0' }),
    alias({ namespace: 'T' }),
    alias({ targetRef: { ...SUBJECT, sourceRef: null } }),
    alias({ targetRef: { ...SUBJECT, checkoutPath: '/tmp/repository' } })
  ]) {
    assert.throws(() => renderTkrGeneratedSection('alias-table', { aliases: [invalid] }),
      hasCode('TKR_ALIAS_INVALID'));
  }

  const secondSubject = { ...SUBJECT, id: 'verification' };
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: [alias(), alias({ id: 'S2', targetRef: secondSubject,
      scopeRef: 'packet:other@1' })]
  }), hasCode('TKR_ALIAS_INVALID'));
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: [alias(), alias({ targetRef: secondSubject })]
  }), hasCode('TKR_ALIAS_INVALID'));
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: [alias({ id: 'S2', targetRef: secondSubject }), alias()]
  }), hasCode('TKR_ALIAS_INVALID'));
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: [alias({ targetRef: { ...SUBJECT, id: 'S1' } })]
  }), hasCode('TKR_ALIAS_INVALID'));
});

test('alias target ordering uses canonical UTF-8 bytes rather than JavaScript UTF-16 order', () => {
  const privateUse = alias({ targetRef: { ...SUBJECT, id: '\uE000' } });
  const supplementary = alias({
    id: 'S2', targetRef: { ...SUBJECT, id: '\u{10000}' }
  });
  assert.doesNotThrow(() => renderTkrGeneratedSection('alias-table', {
    aliases: [privateUse, supplementary]
  }));
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: [
      { ...supplementary, id: 'S1' },
      { ...privateUse, id: 'S2' }
    ]
  }), hasCode('TKR_ALIAS_INVALID'));
});

test('omission items require exact subjects, rendered refs, reasons, and string arrays', () => {
  for (const invalid of [
    null,
    { ...omission(), limitations: undefined },
    { ...omission(), extra: true },
    omission({ sectionId: 'Not Valid' }),
    omission({ subjectRef: { ...SUBJECT, revision: 2 } }),
    omission({ subjectRef: { ...SUBJECT, extra: true } }),
    omission({ reason: 'duplicate' }),
    omission({ originalRenderedRef: { sha256: 'not-a-digest', bytes: 1 } }),
    omission({ originalRenderedRef: { sha256: `sha256:${'a'.repeat(64)}`, bytes: -1 } }),
    omission({ expansionRefs: 'source:ast@revision-1' }),
    omission({ expansionRefs: [] }),
    omission({ limitations: [null] }),
    omission({ evidenceRole: 'status' })
  ]) {
    assert.throws(() => renderTkrGeneratedSection('omission-notices', {
      omissions: [invalid]
    }), hasCode('TKR_CONTRACT_UNSUPPORTED'));
  }

  const unavailable = omission({
    reason: 'unavailable', originalRenderedRef: null, expansionRefs: [],
    evidenceRole: 'status', requirementRef: 'phase-policy:world-model-status@1'
  });
  assert.doesNotThrow(() => renderTkrGeneratedSection('omission-notices', {
    omissions: [unavailable]
  }));
  assert.throws(() => renderTkrGeneratedSection('omission-notices', {
    omissions: [unavailable, unavailable]
  }), hasCode('TKR_RENDER_CONFLICT'));
});

test('generated renderer enforces finite inputs before iteration or canonical rendering', () => {
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: Array.from({ length: 1025 }, () => alias())
  }), hasCode('TKR_LIMIT_EXCEEDED'));
  assert.throws(() => renderTkrGeneratedSection('omission-notices', {
    omissions: Array.from({ length: 257 }, () => omission())
  }), hasCode('TKR_LIMIT_EXCEEDED'));
  assert.throws(() => renderTkrGeneratedSection('alias-table', {
    aliases: [alias({ scopeRef: 'x'.repeat((64 * 1024) + 1) })]
  }), hasCode('TKR_LIMIT_EXCEEDED'));
});

test('malformed payload, options, ignored sibling arrays, and contracts never leak raw TypeError', () => {
  const malformedContract = structuredClone(TKR_GENERATED_RENDERER_CONTRACT);
  malformedContract.generators[0].itemFields[0] = undefined;
  for (const invoke of [
    () => renderTkrGeneratedSection('alias-table', null),
    () => renderTkrGeneratedSection('alias-table', {}, null),
    () => renderTkrGeneratedSection(Symbol('alias-table'), {}, { rendererRef: 'invalid' }),
    () => renderTkrGeneratedSection('alias-table', { aliases: [], omissions: 'invalid' }),
    () => renderTkrGeneratedSection('alias-table', {}, { rendererContract: malformedContract })
  ]) {
    assert.throws(invoke, (error) => (
      error?.name === 'SingularityFlowError'
        && ['TKR_CONTRACT_UNSUPPORTED', 'TKR_LIMIT_EXCEEDED'].includes(error.code)
    ));
  }
});
