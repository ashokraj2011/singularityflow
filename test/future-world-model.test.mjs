import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_FWM_READ_ACTIVATION,
  BUILTIN_FWM_READ_REGISTRY,
  assertInstalledFwmReadRegistry,
  executeFwmRead,
  fwmCanonicalJson,
  fwmReadRegistryInventory,
  fwmSemanticSha256,
  resolveFwmReadView,
  validateFwmReadResult
} from '../src/world-model/fwm/index.mjs';

const HASH = (character) => `sha256:${character.repeat(64)}`;

function envelope({
  facts = [], status = 'complete', nextCursor = null, degradation = [], assurance = 'syntax'
} = {}) {
  return {
    scope: {
      kind: 'paths', paths: ['src'], repositoryRevision: 'a'.repeat(40),
      definitionSha256: HASH('1'), coneSha256: HASH('2')
    },
    assurance, status,
    coverage: {
      selected: 1, processed: 1, skipped: degradation.length, bytes: 100,
      facts: facts.length, factsExamined: facts.length, factsMatched: facts.length,
      factsReturned: facts.length, byLanguage: { javascript: 1 }
    },
    facts,
    diagnostics: [], degradation, resumeHandle: null, nextCursor,
    page: {
      offset: 0, returned: facts.length, available: facts.length,
      hasMore: Boolean(nextCursor), maxFacts: 20, maxOutputBytes: 8192, outputBytes: 1000
    },
    provenance: { engine: 'sflow-ast', engineVersion: 4 }
  };
}

const EXTRACTOR = Object.freeze({ id: 'fixture-syntax', version: '1.0.0', stage: 'syntax' });

test('FWM semantic identity uses a namespace-separated canonical JSON payload', () => {
  assert.equal(fwmCanonicalJson({ z: 1, a: { d: 2, c: 1 } }), '{"a":{"c":1,"d":2},"z":1}');
  assert.equal(
    fwmSemanticSha256('fwm/test/v1', { z: 1, a: 2 }),
    fwmSemanticSha256('fwm/test/v1', { a: 2, z: 1 })
  );
  assert.notEqual(
    fwmSemanticSha256('fwm/test/v1', { a: 2 }),
    fwmSemanticSha256('fwm/other/v1', { a: 2 })
  );
  assert.throws(() => fwmCanonicalJson({ invalid: undefined }), /undefined/);
  assert.throws(() => fwmCanonicalJson({ invalid: Number.MAX_SAFE_INTEGER + 1 }), /unsafe integers/);
  assert.throws(() => fwmCanonicalJson({ invalid: '\ud800' }), /unpaired high surrogate/);
});

test('FWM read input refuses absolute and unbounded repository selectors', async () => {
  for (const selectedPath of ['/etc/passwd', 'C:\\Windows\\system.ini', '\\\\server\\share']) {
    await assert.rejects(
      executeFwmRead('/fixture/repository', 'ncg.map', { paths: [selectedPath] }),
      (error) => error.code === 'FWM_READ_PATH_INVALID'
    );
  }
  await assert.rejects(
    executeFwmRead('/fixture/repository', 'ncg.callers', { symbol: `SYM-${'x'.repeat(1100)}` }),
    (error) => error.code === 'FWM_READ_PARAMETER_INVALID'
  );
});

test('FWM registry activates only implemented structural reads and rejects substitutions', () => {
  const inventory = fwmReadRegistryInventory();
  assert.deepEqual(
    inventory.filter((entry) => entry.active).map((entry) => entry.id).sort(),
    ['ncg.callers', 'ncg.map', 'ncg.skeleton']
  );
  assert.deepEqual(
    inventory.filter((entry) => !entry.active).map((entry) => entry.id).sort(),
    ['ncg.blast', 'ncg.find', 'ncg.grep']
  );
  assert.ok(inventory.every((entry) => entry.model === 'never'));
  assert.ok(BUILTIN_FWM_READ_REGISTRY.descriptors.every(
    (entry) => entry.outputUse === 'advisory'
  ));
  assert.equal(resolveFwmReadView('ncg.skeleton').reference, 'ncg.skeleton@1');
  assert.throws(
    () => resolveFwmReadView('ncg.grep'),
    (error) => error.code === 'FWM_INVALID_VIEW'
  );
  assert.equal(
    resolveFwmReadView('ncg.grep@1', { requireActive: false }).descriptor.lifecycle,
    'draft'
  );

  const substituted = structuredClone(BUILTIN_FWM_READ_REGISTRY);
  substituted.descriptors[0].title = 'Unreviewed replacement';
  assert.throws(
    () => assertInstalledFwmReadRegistry(substituted, BUILTIN_FWM_READ_ACTIVATION),
    (error) => ['FWM_RECORD_HASH_MISMATCH', 'FWM_REGISTRY_NOT_INSTALLED'].includes(error.code)
  );
});

test('FWM skeleton read uses the existing AST owner and returns bound provenance and coverage', async () => {
  let calls = 0;
  const result = await executeFwmRead('/fixture/repository', 'ncg.skeleton', {
    paths: ['src'], maximumBytes: 65536
  }, {
    astContextFn: async (_root, options) => {
      calls += 1;
      assert.deepEqual(options.paths, ['src']);
      assert.equal(options.priority, 'structural-first');
      return envelope({ facts: [
        { kind: 'file', path: 'src/app.js', language: 'javascript', assurance: 'text', extractor: EXTRACTOR },
        { kind: 'symbol', id: 'SYM-1', path: 'src/app.js', name: 'run', assurance: 'syntax', extractor: EXTRACTOR },
        { kind: 'relationship', type: 'calls', sourceId: 'SYM-1', target: 'SYM-2', path: 'src/app.js', assurance: 'syntax', extractor: EXTRACTOR }
      ] });
    },
    astQueryFn: async () => { throw new Error('query must not run'); }
  });

  assert.equal(calls, 1);
  assert.equal(result.resolvedView.reference, 'ncg.skeleton@1');
  assert.deepEqual(result.items.map((item) => item.record.kind), ['symbol', 'relationship']);
  assert.equal(result.resultStatus, 'found');
  assert.deepEqual(result.coverage, {
    analysis: 'complete', scan: 'complete', traversal: 'not-required', delivery: 'complete'
  });
  assert.equal(result.inputBinding.sourceKind, 'working-tree');
  assert.match(result.inputBinding.bindingSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.originSummary, ['parsed']);
  assert.ok(result.items.every((item) => result.origins.some(
    (origin) => origin.originSha256 === item.originSha256
  )));
  assert.equal(validateFwmReadResult(result), result);
});

test('FWM callers binds the query, preserves unknown on partial coverage, and never infers absence', async () => {
  let received;
  const result = await executeFwmRead('/fixture/repository', 'ncg.callers', {
    symbol: 'SYM-target', maximumBytes: 65536
  }, {
    astContextFn: async () => { throw new Error('context must not run'); },
    astQueryFn: async (_root, options) => {
      received = options;
      return envelope({ status: 'partial', degradation: [{ reason: 'language-unsupported' }] });
    }
  });
  assert.equal(received.predicate, 'references');
  assert.equal(received.value, 'SYM-target');
  assert.equal(result.resultStatus, 'unknown');
  assert.equal(result.partial, true);
  assert.ok(result.reasons.includes('language-unsupported'));
  assert.notEqual(result.coverage.traversal, 'complete');
});

test('FWM text assurance cannot be misreported as structural absence', async () => {
  const result = await executeFwmRead('/fixture/repository', 'ncg.skeleton', {
    paths: ['src'], maximumBytes: 65536
  }, { astContextFn: async () => envelope({ assurance: 'text' }) });
  assert.equal(result.resultStatus, 'unknown');
  assert.equal(result.coverage.analysis, 'partial');
  assert.equal(result.coverage.scan, 'complete');
  assert.ok(result.reasons.includes('text-assurance-cannot-prove-structural-absence'));
});

test('FWM continuation is bound to view and current access identity', async () => {
  let resumed = false;
  const first = await executeFwmRead('/fixture/repository', 'ncg.skeleton', {
    maximumBytes: 65536
  }, {
    astContextFn: async () => envelope({
      facts: [{ kind: 'symbol', id: 'SYM-1', path: 'src/app.js', name: 'run', assurance: 'syntax', extractor: EXTRACTOR }],
      nextCursor: 'ast_fixture_cursor'
    })
  });
  assert.match(first.continuation, /^fwm_/);

  const second = await executeFwmRead('/fixture/repository', 'ncg.skeleton', {
    cursor: first.continuation
  }, {
    astContextFn: async (_root, options) => {
      resumed = true;
      assert.equal(options.cursor, 'ast_fixture_cursor');
      return envelope();
    }
  });
  assert.equal(resumed, true);
  assert.equal(second.resultStatus, 'absent-in-complete-scope');
  await assert.rejects(
    executeFwmRead('/fixture/repository', 'ncg.map', { cursor: first.continuation }),
    (error) => error.code === 'FWM_CONTINUATION_INVALID'
  );
});

test('FWM byte fitting binds the reduced page size into its continuation', async () => {
  const facts = Array.from({ length: 20 }, (_, index) => ({
    kind: 'symbol', id: `SYM-${index}`, path: `src/${index}.js`,
    name: `symbol-${index}-${'x'.repeat(180)}`, assurance: 'syntax', extractor: EXTRACTOR
  }));
  const attempted = [];
  const first = await executeFwmRead('/fixture/repository', 'ncg.skeleton', {
    paths: ['src'], maximumFacts: 20, maximumBytes: 4096
  }, {
    astContextFn: async (_root, options) => {
      attempted.push(options['max-facts']);
      const selected = facts.slice(0, options['max-facts']);
      return envelope({ facts: selected, nextCursor: 'ast_reduced_cursor' });
    }
  });
  assert.ok(attempted.length > 1);
  const effectiveMaximum = attempted.at(-1);
  assert.ok(effectiveMaximum < 20);

  await executeFwmRead('/fixture/repository', 'ncg.skeleton', { cursor: first.continuation }, {
    astContextFn: async (_root, options) => {
      assert.equal(options['max-facts'], effectiveMaximum);
      assert.equal(options.cursor, 'ast_reduced_cursor');
      return envelope();
    }
  });
});

test('FWM validation rejects a resealed result with an inconsistent inner digest', async () => {
  const result = await executeFwmRead('/fixture/repository', 'ncg.skeleton', {
    maximumBytes: 65536
  }, { astContextFn: async () => envelope() });
  const tampered = structuredClone(result);
  tampered.semanticResultDigest = HASH('f');
  assert.throws(
    () => validateFwmReadResult(tampered),
    (error) => ['FWM_SEMANTIC_DIGEST_MISMATCH', 'FWM_RECORD_HASH_MISMATCH'].includes(error.code)
  );
});
