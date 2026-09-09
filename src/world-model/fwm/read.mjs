import path from 'node:path';

import { astContext, astQuery } from '../../ast-intelligence.mjs';
import { optionBoolean, optionNumber, optionString, SingularityFlowError } from '../../util.mjs';
import { fwmCanonicalJson, fwmSemanticSha256 } from './canonical.mjs';
import {
  createFwmInputBinding, createFwmOrigin, createFwmReadResult, FWM_SHA256
} from './contracts.mjs';
import {
  BUILTIN_FWM_READ_ACTIVATION, BUILTIN_FWM_READ_REGISTRY, fwmReadRegistryInventory,
  resolveFwmReadView
} from './registry.mjs';

const DEFAULT_MAXIMUM_FACTS = 20;
const DEFAULT_MAXIMUM_BYTES = 16 * 1024;
const MAXIMUM_FACTS = 1000;
const MAXIMUM_BYTES = 64 * 1024;
const MAXIMUM_PATHS = 256;
const MAXIMUM_PATH_BYTES = 1024;
const MAXIMUM_SYMBOL_BYTES = 1024;
const CURSOR_VERSION = 1;

function fail(message, code = 'FWM_READ_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function boolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizedPaths(value) {
  const entries = Array.isArray(value) ? value : value == null ? [] : String(value).split(',');
  const normalized = entries.map((entry) => String(entry).trim().replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(Boolean);
  if (normalized.length > MAXIMUM_PATHS) {
    fail(`FWM read accepts at most ${MAXIMUM_PATHS} paths.`, 'FWM_READ_PATH_INVALID');
  }
  for (const entry of normalized) {
    if (Buffer.byteLength(entry, 'utf8') > MAXIMUM_PATH_BYTES
        || path.posix.isAbsolute(entry) || /^[A-Za-z]:\//.test(entry) || entry.startsWith('//')
        || path.posix.normalize(entry) !== entry || entry === '.' || entry === '..'
        || entry.startsWith('../') || /[\0\r\n]/.test(entry)) {
      fail(`FWM read path '${entry}' must be normalized and repository-relative.`, 'FWM_READ_PATH_INVALID');
    }
  }
  return [...new Set(normalized)].sort();
}

function normalizedSymbol(value, { required = false } = {}) {
  if (value == null) {
    if (required) fail('FWM ncg.callers requires an exact --symbol value.', 'FWM_READ_PARAMETER_REQUIRED');
    return null;
  }
  const selected = String(value).trim();
  if (!selected || Buffer.byteLength(selected, 'utf8') > MAXIMUM_SYMBOL_BYTES
      || /[\0\r\n]/.test(selected)) {
    fail('FWM symbol must be one bounded exact identity.', 'FWM_READ_PARAMETER_INVALID');
  }
  return selected;
}

function boundedInteger(value, fallback, label, minimum, maximum) {
  const selected = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`, 'FWM_READ_BUDGET_INVALID');
  }
  return selected;
}

function encodeCursor(payload) {
  const encoded = Buffer.from(fwmCanonicalJson(payload), 'utf8').toString('base64url');
  const digest = fwmSemanticSha256('fwm/read-continuation/v1', { encoded });
  return `fwm_${encoded}.${digest.slice('sha256:'.length)}`;
}

function decodeCursor(value) {
  const match = /^fwm_([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(value ?? ''));
  if (!match || match[1].length > 32768) fail('FWM continuation is malformed.', 'FWM_CONTINUATION_INVALID');
  const expected = fwmSemanticSha256('fwm/read-continuation/v1', { encoded: match[1] });
  if (expected.slice('sha256:'.length) !== match[2]) fail('FWM continuation integrity is invalid.', 'FWM_CONTINUATION_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
  catch { fail('FWM continuation payload is invalid.', 'FWM_CONTINUATION_INVALID'); }
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify([
    'accessViewSha256', 'astCursor', 'descriptorSha256', 'expiresAt', 'parameters',
    'version', 'viewRef'
  ])) fail('FWM continuation payload is invalid.', 'FWM_CONTINUATION_INVALID');
  if (payload?.version !== CURSOR_VERSION || typeof payload.astCursor !== 'string'
      || !payload.astCursor.length || Buffer.byteLength(payload.astCursor, 'utf8') > 32768
      || typeof payload.viewRef !== 'string' || typeof payload.descriptorSha256 !== 'string'
      || typeof payload.accessViewSha256 !== 'string' || !payload.parameters
      || !FWM_SHA256.test(payload.descriptorSha256) || !FWM_SHA256.test(payload.accessViewSha256)
      || typeof payload.expiresAt !== 'string' || Date.parse(payload.expiresAt) <= Date.now()) {
    fail('FWM continuation is invalid or expired.', 'FWM_CONTINUATION_INVALID');
  }
  return payload;
}

export function normalizeFwmReadParameters(reference, options = {}) {
  const cursor = options.cursor ?? null;
  if (cursor) {
    const payload = decodeCursor(cursor);
    const resolved = resolveFwmReadView(reference);
    if (payload.viewRef !== resolved.reference) {
      fail('FWM continuation belongs to another view.', 'FWM_CONTINUATION_INVALID');
    }
    const parameterKeys = Object.keys(payload.parameters).sort();
    if (JSON.stringify(parameterKeys)
        !== JSON.stringify(['all', 'maximumBytes', 'maximumFacts', 'paths', 'symbol'])) {
      fail('FWM continuation parameters are invalid.', 'FWM_CONTINUATION_INVALID');
    }
    if (typeof payload.parameters.all !== 'boolean') {
      fail('FWM continuation scope is invalid.', 'FWM_CONTINUATION_INVALID');
    }
    const paths = normalizedPaths(payload.parameters.paths);
    if (paths.length !== payload.parameters.paths.length
        || (payload.parameters.all && paths.length)) {
      fail('FWM continuation scope is invalid.', 'FWM_CONTINUATION_INVALID');
    }
    return Object.freeze({
      all: payload.parameters.all,
      paths,
      symbol: normalizedSymbol(payload.parameters.symbol, {
        required: resolved.descriptor.name === 'ncg.callers'
      }),
      maximumFacts: boundedInteger(payload.parameters.maximumFacts, null,
        'FWM maximumFacts', 1, MAXIMUM_FACTS),
      maximumBytes: boundedInteger(payload.parameters.maximumBytes, null,
        'FWM maximumBytes', 4096, MAXIMUM_BYTES),
      astCursor: payload.astCursor,
      cursorPayload: payload
    });
  }
  const resolved = resolveFwmReadView(reference);
  const paths = normalizedPaths(options.paths ?? options.path);
  const all = boolean(options.all);
  if (all && paths.length) fail('FWM read accepts either all=true or paths, not both.');
  const symbol = normalizedSymbol(options.symbol ?? options.value ?? null, {
    required: resolved.descriptor.name === 'ncg.callers'
  });
  return Object.freeze({
    all,
    paths,
    symbol,
    maximumFacts: boundedInteger(options.maximumFacts ?? options['max-facts'],
      DEFAULT_MAXIMUM_FACTS, 'FWM maximumFacts', 1, MAXIMUM_FACTS),
    maximumBytes: boundedInteger(options.maximumBytes ?? options['max-output-bytes'],
      DEFAULT_MAXIMUM_BYTES, 'FWM maximumBytes', 4096, MAXIMUM_BYTES),
    astCursor: null,
    cursorPayload: null
  });
}

function astOptions(parameters, maximumFacts) {
  return {
    ...(parameters.all ? { all: true } : {}),
    ...(parameters.paths.length ? { paths: parameters.paths } : {}),
    ...(parameters.astCursor ? { cursor: parameters.astCursor } : {}),
    'max-facts': maximumFacts,
    // Leave room for the FWM binding, provenance, and four-dimensional coverage envelope.
    'max-output-bytes': Math.max(4096, Math.floor(parameters.maximumBytes * 0.62))
  };
}

function handlerFacts(viewName, envelope) {
  if (viewName === 'ncg.skeleton') {
    return envelope.facts.filter((fact) => ['symbol', 'module', 'import', 'relationship'].includes(fact.kind));
  }
  if (viewName === 'ncg.callers') {
    return envelope.facts.filter((fact) => fact.kind === 'relationship'
      && ['calls', 'references', 'reads', 'writes', 'test-covers'].includes(fact.type));
  }
  if (viewName === 'ncg.map') {
    return envelope.facts.filter((fact) => ['file', 'module'].includes(fact.kind));
  }
  fail(`FWM view '${viewName}' has no installed read handler.`, 'FWM_VIEW_NOT_ACTIVE');
}

async function invokeHandler(root, descriptor, parameters, maximumFacts, { astContextFn, astQueryFn }) {
  const options = astOptions(parameters, maximumFacts);
  if (descriptor.name === 'ncg.callers') {
    return astQueryFn(root, {
      ...options,
      ...(parameters.astCursor ? {} : { predicate: 'references', value: parameters.symbol })
    });
  }
  return astContextFn(root, {
    ...options,
    ...(descriptor.name === 'ncg.skeleton' ? { priority: 'structural-first' } : {})
  });
}

function inputBinding(root, envelope, viewName) {
  const assuranceInsufficient = viewName !== 'ncg.map'
    && !['syntax', 'semantic'].includes(envelope.assurance);
  const limitations = [...new Set([
    ...envelope.degradation.map((entry) => String(entry.reason ?? 'degraded')),
    ...envelope.diagnostics.filter((entry) => entry.severity !== 'info')
      .map((entry) => String(entry.code ?? 'diagnostic').toLowerCase()),
    ...(assuranceInsufficient
      ? [`${envelope.assurance ?? 'unknown'}-assurance-cannot-prove-structural-absence`]
      : [])
  ])].sort();
  const scope = {
    repositoryRevision: envelope.scope.repositoryRevision,
    definitionSha256: envelope.scope.definitionSha256,
    coneSha256: envelope.scope.coneSha256 ?? envelope.scope.worktreeFingerprint,
    scope: { kind: envelope.scope.kind, paths: envelope.scope.paths }
  };
  const sourceSha256 = fwmSemanticSha256('fwm/source/working-tree-capture/v1', scope);
  return createFwmInputBinding({
    sourceDomainId: fwmSemanticSha256('fwm/source-domain/repository/v1', {
      repository: path.resolve(root)
    }),
    sourceKind: 'working-tree',
    sourceRefs: [{ kind: 'working-tree-capture', id: scope.coneSha256, sha256: sourceSha256 }],
    generationRefs: [],
    candidateRef: { status: 'not-required' },
    policyRef: FWM_SHA256.test(scope.definitionSha256)
      ? scope.definitionSha256 : fwmSemanticSha256('fwm/policy/ast-definition/v1', scope.definitionSha256),
    capabilityRef: null,
    ledgerPins: [],
    recordRoots: [],
    evaluationBoundary: { kind: 'capture', value: scope.coneSha256 },
    coverage: {
      status: envelope.status === 'complete' && !assuranceInsufficient ? 'complete'
        : envelope.status === 'disabled' ? 'unavailable' : 'partial',
      limitations
    },
    consistency: { kind: 'ast-cone', sha256: sourceSha256 }
  });
}

function originsFor(facts, binding) {
  const bySha = new Map();
  const items = facts.map((fact) => {
    const extractor = fact.extractor ?? {};
    const limitations = [
      ...(fact.assurance && !['syntax', 'semantic'].includes(fact.assurance)
        ? [`assurance-${fact.assurance}`] : []),
      ...(extractor.stage ? [] : ['extractor-stage-unavailable'])
    ].sort();
    const origin = createFwmOrigin({
      originClass: 'parsed',
      sourceRef: binding.sourceRefs[0].sha256,
      producerRef: `${extractor.id ?? 'builtin-ast'}@${extractor.version ?? 'unversioned'}`,
      validationRef: null,
      limitations
    });
    bySha.set(origin.originSha256, origin);
    return { record: structuredClone(fact), originSha256: origin.originSha256 };
  });
  return {
    items,
    origins: [...bySha.values()].sort((left, right) => left.originSha256 < right.originSha256 ? -1 : 1)
  };
}

function coverageFor(envelope, viewName) {
  const complete = envelope.status === 'complete';
  const structuralComplete = complete && (viewName === 'ncg.map'
    || ['syntax', 'semantic'].includes(envelope.assurance));
  const delivered = envelope.status === 'disabled' ? 'unavailable'
    : envelope.nextCursor ? 'partial' : 'complete';
  return {
    analysis: envelope.status === 'disabled' ? 'unavailable'
      : structuralComplete ? 'complete' : 'partial',
    scan: complete ? 'complete' : envelope.status === 'disabled' ? 'unavailable' : 'partial',
    traversal: viewName === 'ncg.callers'
      ? structuralComplete ? 'complete' : envelope.status === 'disabled' ? 'unavailable' : 'partial'
      : 'not-required',
    delivery: delivered
  };
}

function buildResult(resolved, parameters, envelope, facts, root, accessViewSha256) {
  const binding = inputBinding(root, envelope, resolved.descriptor.name);
  const normalizedQuery = {
    all: parameters.all,
    paths: parameters.paths,
    symbol: parameters.symbol,
    maximumFacts: parameters.maximumFacts,
    maximumBytes: parameters.maximumBytes
  };
  const semanticQueryId = fwmSemanticSha256('fwm/semantic-query/v1', {
    inputBindingSha256: binding.bindingSha256,
    descriptorSha256: resolved.descriptor.descriptorSha256,
    implementationSha256: resolved.descriptor.implementationSha256,
    registrySha256: resolved.registry.registrySha256,
    activationSha256: resolved.activation.activationSha256,
    parameters: normalizedQuery,
    consumer: 'sflow-structural-read',
    consumerClass: 'human',
    accessViewSha256,
    freshnessPolicyRef: resolved.descriptor.freshnessPolicyRef,
    admissibilityProfileRef: resolved.descriptor.admissibilityProfileRef,
    orderingProfileRef: resolved.descriptor.orderingProfileRef,
    budgetProfileRef: resolved.descriptor.budgetProfileRef,
    renderProfileRef: resolved.descriptor.renderProfileRef
  });
  const projected = originsFor(facts, binding);
  const coverage = coverageFor(envelope, resolved.descriptor.name);
  const partial = Object.values(coverage).some((entry) => entry === 'partial' || entry === 'unavailable');
  const reasons = [...new Set([
    ...binding.coverage.limitations,
    ...(envelope.status === 'disabled' ? ['ast-disabled'] : []),
    ...(envelope.nextCursor ? ['delivery-page-incomplete'] : [])
  ])].sort();
  const resultStatus = envelope.status === 'disabled' ? 'unavailable'
    : projected.items.length ? 'found'
      : !partial ? 'absent-in-complete-scope' : 'unknown';
  const continuation = envelope.nextCursor ? encodeCursor({
    version: CURSOR_VERSION,
    viewRef: resolved.reference,
    descriptorSha256: resolved.descriptor.descriptorSha256,
    accessViewSha256,
    parameters: normalizedQuery,
    astCursor: envelope.nextCursor,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  }) : null;
  const semanticResultDigest = fwmSemanticSha256('fwm/semantic-result/v1', {
    resolvedView: resolved.reference,
    inputBindingSha256: binding.bindingSha256,
    semanticQueryId,
    resultStatus,
    items: projected.items,
    coverage: { analysis: coverage.analysis, scan: coverage.scan, traversal: coverage.traversal }
  });
  const deliveredSliceDigest = fwmSemanticSha256('fwm/delivered-slice/v1', {
    semanticResultDigest,
    items: projected.items,
    origins: projected.origins,
    coverage,
    partial,
    reasons,
    continuation
  });
  return createFwmReadResult({
    resolvedView: {
      reference: resolved.reference,
      descriptorSha256: resolved.descriptor.descriptorSha256,
      registrySha256: resolved.registry.registrySha256,
      activationSha256: resolved.activation.activationSha256
    },
    inputBinding: binding,
    semanticQueryId,
    freshness: {
      sourceKind: binding.sourceKind,
      status: 'captured',
      bindingSha256: binding.bindingSha256
    },
    originSummary: [...new Set(projected.origins.map((entry) => entry.originClass))].sort(),
    admissibilityProfile: resolved.descriptor.admissibilityProfileRef,
    coverage,
    resultStatus,
    items: projected.items,
    origins: projected.origins,
    evidenceRefs: [],
    partial,
    reasons,
    continuation,
    semanticResultDigest,
    deliveredSliceDigest
  });
}

/**
 * One model-free structural read dispatch. The only supplied implementations are the existing AST
 * owner; test injection is explicit and cannot add a handler or widen descriptor permissions.
 */
export async function executeFwmRead(root, reference, options = {}, {
  astContextFn = astContext,
  astQueryFn = astQuery,
  accessViewSha256 = null
} = {}) {
  const resolved = resolveFwmReadView(reference);
  if (resolved.descriptor.permissions.model !== 'never'
      || resolved.descriptor.permissions.sourceWrites !== false
      || resolved.descriptor.permissions.domainWrites !== false) {
    fail('FWM structural read capability profile is not read-only.', 'FWM_VIEW_CAPABILITY_INVALID');
  }
  const parameters = normalizeFwmReadParameters(reference, options);
  const effectiveAccess = accessViewSha256 ?? fwmSemanticSha256('fwm/access/public-repository/v1', {
    sourceDomain: fwmSemanticSha256('fwm/source-domain/repository/v1', {
      repository: path.resolve(root)
    })
  });
  if (parameters.cursorPayload) {
    if (parameters.cursorPayload.descriptorSha256 !== resolved.descriptor.descriptorSha256
        || parameters.cursorPayload.accessViewSha256 !== effectiveAccess) {
      fail('FWM continuation access or descriptor binding changed.', 'FWM_ACCESS_CHANGED');
    }
  }
  let maximumFacts = parameters.maximumFacts;
  while (true) {
    const envelope = await invokeHandler(root, resolved.descriptor, parameters, maximumFacts, {
      astContextFn, astQueryFn
    });
    const facts = handlerFacts(resolved.descriptor.name, envelope);
    // The AST owner may need a smaller page to fit the FWM presentation envelope. Bind that
    // effective limit into the query and continuation; otherwise the next page would present the
    // caller's larger request against an AST cursor minted for the smaller page.
    const effectiveParameters = maximumFacts === parameters.maximumFacts
      ? parameters : { ...parameters, maximumFacts };
    const result = buildResult(
      resolved, effectiveParameters, envelope, facts, root, effectiveAccess
    );
    const bytes = Buffer.byteLength(fwmCanonicalJson(result), 'utf8');
    if (bytes <= parameters.maximumBytes) return result;
    if (maximumFacts <= 1 || parameters.astCursor) {
      fail(
        `FWM result envelope cannot fit the ${parameters.maximumBytes}-byte presentation budget.`,
        'FWM_BUDGET_TOO_SMALL', { bytes, maximumBytes: parameters.maximumBytes }
      );
    }
    maximumFacts = Math.max(1, Math.floor(maximumFacts / 2));
  }
}

export async function fwmReadCommand(root, reference, options = {}) {
  const result = await executeFwmRead(root, reference, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.resolvedView.reference}  ${result.resultStatus}`);
    console.log(`  source: ${result.inputBinding.sourceKind} · ${result.inputBinding.bindingSha256}`);
    console.log(`  coverage: analysis=${result.coverage.analysis} scan=${result.coverage.scan} traversal=${result.coverage.traversal} delivery=${result.coverage.delivery}`);
    result.items.forEach((item) => {
      const fact = item.record;
      console.log(`  ${fact.kind}  ${fact.path ?? fact.sourceId ?? fact.id ?? ''}  ${fact.name ?? fact.target ?? fact.type ?? ''}`.trimEnd());
    });
    if (result.continuation) console.log(`  continue: singularity-flow wm read ${result.resolvedView.reference} --cursor ${result.continuation}`);
  }
  return result;
}

export function fwmReadViewsCommand(options = {}) {
  const result = fwmReadRegistryInventory();
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else result.forEach((entry) => console.log(
    `${entry.reference}  ${entry.lifecycle}  model ${entry.model}  ${entry.title}`
  ));
  return result;
}

export function fwmReadContractCommand(reference, options = {}) {
  const resolved = resolveFwmReadView(reference, { requireActive: false });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(resolved.descriptor, null, 2));
  else process.stdout.write(`${JSON.stringify(resolved.descriptor, null, 2)}\n`);
  return resolved.descriptor;
}

export function fwmCliOptions(options = {}) {
  return {
    all: optionBoolean(options, 'all'),
    paths: optionString(options, 'paths') ?? optionString(options, 'path'),
    symbol: optionString(options, 'symbol') ?? optionString(options, 'value'),
    cursor: optionString(options, 'cursor'),
    maximumFacts: optionNumber(options, 'max-facts'),
    maximumBytes: optionNumber(options, 'max-output-bytes')
  };
}

export const FWM_READ_REGISTRY_SHA256 = BUILTIN_FWM_READ_REGISTRY.registrySha256;
export const FWM_READ_ACTIVATION_SHA256 = BUILTIN_FWM_READ_ACTIVATION.activationSha256;
