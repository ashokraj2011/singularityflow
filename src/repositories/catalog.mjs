import { createHash } from 'node:crypto';

import { SingularityFlowError } from '../util.mjs';
import {
  RDS_DEFAULTS, RDS_PROFILE_VERSION, RDS_QUERY_PROFILE, RDS_ENVELOPE_VERSION,
  literalQueryMatches, normalizeLiteralQuery
} from './constants.mjs';
import { captureKnownRepositoryCatalog } from './local-sources.mjs';
import {
  githubProviderDescriptor, normalizeGitHubHost, probeGitHubViewer,
  readGitHubRepositoryById, readGitHubRepositoryPage
} from './github-provider.mjs';
import {
  clearRepositoryCatalogCache, consumeCatalogCursor, createCatalogSession,
  localFingerprint, readProviderCache, repositoryCatalogCacheStatus,
  repositoryCatalogEpoch, resolveCatalogSelection, writeProviderCache
} from './store.mjs';

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function fail(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export function normalizeRepositoryQuery(value, { required = false } = {}) {
  try { return normalizeLiteralQuery(value, { required }); }
  catch (error) { fail(error.message, error.code ?? 'REPOSITORY_QUERY_INVALID'); }
}

function normalizeScope(scope) {
  const value = String(scope ?? 'known').trim();
  if (!['known', 'provider', 'all'].includes(value)) {
    fail("Repository scope must be 'known', 'provider', or 'all'.", 'REPOSITORY_PROVIDER_NOT_SELECTED');
  }
  return value;
}

function normalizeAudience(audience) {
  const value = String(audience ?? 'terminal').trim();
  if (!['terminal', 'native', 'model'].includes(value)) {
    fail("Repository audience must be 'terminal', 'native', or 'model'.", 'REPOSITORY_DISCLOSURE_REFUSED');
  }
  return value;
}

function effectiveLimit(value, audience) {
  const ceiling = audience === 'model' ? RDS_DEFAULTS.maximumModelRows
    : audience === 'native' ? RDS_DEFAULTS.maximumNativeRows : RDS_DEFAULTS.maximumRows;
  const parsed = Number(value ?? RDS_DEFAULTS.returnedRows);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ceiling) {
    fail(`Repository result limit must be between 1 and ${ceiling} for the selected audience.`, 'REPOSITORY_CATALOG_LIMIT_REACHED');
  }
  return parsed;
}

function boundedInteger(value, fallback, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`${label} must be between 1 and ${maximum}.`, 'REPOSITORY_CATALOG_LIMIT_REACHED');
  }
  return parsed;
}

function contextBinding({
  scope, host, accountBinding, queryFingerprint, audience, limit, offline,
  discloseProviderResults
}) {
  return `sha256:${digest(JSON.stringify({
    scope, host: host ?? null, accountBinding: accountBinding ?? null,
    queryFingerprint: queryFingerprint ?? null, queryProfile: RDS_QUERY_PROFILE,
    audience, limit, offline: offline === true,
    discloseProviderResults: discloseProviderResults === true,
    profile: RDS_PROFILE_VERSION
  }))}`;
}

function providerRecord(node, host, accountBinding, knownByRemote, observedAt) {
  const identity = `github:${host}:${node.id}`;
  const known = knownByRemote.get(node.locators.https) ?? knownByRemote.get(node.locators.ssh) ?? null;
  return {
    recordRef: `rdsr_provider_${digest(identity).slice(0, 24)}`,
    recordRevision: `sha256:${digest(JSON.stringify({ identity, node, observedAt }))}`,
    repositoryIdentity: {
      type: 'provider-native', providerType: 'github',
      providerInstanceId: `github:${host}`, nativeRepositoryId: node.id
    },
    display: { nameWithOwner: node.nameWithOwner },
    locators: node.locators,
    providerFacts: {
      accountBinding, visibility: node.visibility, permission: node.permission,
      archived: node.isArchived, fork: node.isFork, defaultBranch: node.defaultBranch, observedAt
    },
    knownAssociations: known?.knownAssociations ?? [],
    inspection: 'required', limitations: [], conflicts: [],
    sourceRefs: [`rdssrc_github_${digest(`${host}\0${accountBinding}`).slice(0, 24)}`]
  };
}

function sourceForProvider(state, enumeration, overrides = {}) {
  return {
    sourceRef: state.providerSourceRef,
    sourceKind: 'github-affiliated-repositories',
    sourceAvailability: overrides.availability ?? 'available',
    enumeration,
    consistency: overrides.consistency ?? 'live_provider_traversal',
    freshness: {
      origin: overrides.origin ?? 'live', viewerChecked: overrides.viewerChecked !== false,
      observedFrom: state.observedFrom, observedTo: overrides.observedTo ?? new Date().toISOString(),
      ...(overrides.cacheAgeMs == null ? {} : { cacheAgeMs: overrides.cacheAgeMs })
    },
    acceptedRecords: state.seenProviderIds?.length ?? 0,
    omittedRecords: 0,
    reasons: overrides.reasons ?? []
  };
}

function aggregateEnumeration(sources, hasBuffered = false) {
  if (sources.some((source) => source.enumeration === 'cancelled')) return 'cancelled';
  if (sources.some((source) => source.enumeration === 'failed'
      || ['unavailable', 'unsupported'].includes(source.sourceAvailability))) return 'failed';
  if (sources.some((source) => source.enumeration === 'limited')) return 'limited';
  if (hasBuffered || sources.some((source) => source.enumeration === 'more')) return 'more';
  return 'exhausted';
}

function pageEnvelope(state, records, sources, {
  reasons = [], enumeration = null, delivery = 'complete_page'
} = {}) {
  const deliveredRecords = state.audience === 'model' && state.discloseProviderResults !== true
    ? records.filter((record) => record.providerFacts == null) : records;
  const withheld = records.length - deliveredRecords.length;
  const privateOrInternal = deliveredRecords.filter((record) =>
    ['private', 'internal'].includes(record.providerFacts?.visibility)).length;
  return {
    schemaVersion: RDS_ENVELOPE_VERSION,
    kind: 'repository-catalog-page',
    sessionRef: state.sessionRef,
    pageRef: `rdsp_${digest(JSON.stringify({
      sessionRef: state.sessionRef,
      records: records.map((record) => record.recordRevision),
      sources: sources.map((source) => source.sourceRef)
    })).slice(0, 24)}`,
    request: {
      scope: state.requestedScope ?? state.scope, provider: state.provider ?? null,
      providerInstanceId: state.host ? `github:${state.host}` : null,
      accountBinding: state.accountBinding ?? null, queryProfile: RDS_QUERY_PROFILE,
      queryFingerprint: state.queryFingerprint ?? null, limit: state.limit,
      audience: state.audience, offline: state.offline === true,
      providerDisclosure: state.discloseProviderResults === true ? 'explicit'
        : state.audience === 'model' && records.some((record) => record.providerFacts != null)
          ? 'withheld' : 'not_applicable'
    },
    sources,
    repositories: deliveredRecords,
    recordUpdates: [],
    enumeration: enumeration ?? aggregateEnumeration(sources),
    consistency: sources.length === 1 ? sources[0].consistency : 'mixed-source-observations',
    delivery: {
      state: withheld ? 'withheld' : delivery,
      returned: deliveredRecords.length,
      withheld,
      privateOrInternal
    },
    reasons: [...new Set([...reasons, ...(withheld ? ['REPOSITORY_DISCLOSURE_REFUSED'] : [])])],
    usage: state.usage ?? {},
    nextCursor: null
  };
}

function matches(query, record) {
  return literalQueryMatches(query, record.display?.nameWithOwner,
    record.locators?.https, record.locators?.ssh);
}

function sliceKnown(state) {
  const matching = state.buffer.filter((entry) => matches(state.query, entry));
  const deliveredBefore = state.usage?.deliveredRecords ?? 0;
  const remainingBudget = Math.max(0, RDS_DEFAULTS.maximumRows - deliveredBefore);
  const rows = matching.slice(0, Math.min(state.limit, remainingBudget));
  const delivered = new Set(rows.map((entry) => entry.recordRef));
  const remaining = state.buffer.filter((entry) => !delivered.has(entry.recordRef));
  const more = remaining.some((entry) => matches(state.query, entry));
  const limited = more && deliveredBefore + rows.length >= RDS_DEFAULTS.maximumRows;
  const sources = state.knownSources.map((source) => ({
    ...source,
    enumeration: source.enumeration === 'failed' ? 'failed'
      : source.enumeration === 'limited' || limited ? 'limited' : more ? 'more' : 'exhausted'
  }));
  return {
    rows, remaining, sources, more, limited,
    reasons: [...state.knownReasons, ...(limited ? ['REPOSITORY_CATALOG_LIMIT_REACHED'] : [])]
  };
}

async function nextPage(state, options) {
  if (state.scope === 'known') {
    const page = sliceKnown(state);
    const usage = {
      ...state.usage,
      deliveredRecords: (state.usage?.deliveredRecords ?? 0) + page.rows.length
    };
    return {
      result: pageEnvelope({ ...state, usage }, page.rows, page.sources, { reasons: page.reasons }),
      nextState: page.more && !page.limited ? { ...state, buffer: page.remaining, usage } : null
    };
  }

  const rows = [];
  let buffer = [...state.buffer];
  let providerCursor = state.providerCursor;
  let providerHasNext = state.providerHasNext;
  let queries = 0;
  const queryCountBefore = state.usage?.providerQueries ?? 0;
  const deliveredBefore = state.usage?.deliveredRecords ?? 0;
  const remainingRecordBudget = Math.max(0, RDS_DEFAULTS.maximumRows - deliveredBefore);
  const queryBudget = Math.max(0, state.maximumProviderPages - queryCountBefore);
  const deadlineAt = Number.isFinite(state.invocationDeadlineAt)
    ? state.invocationDeadlineAt : Date.now() + RDS_DEFAULTS.aggregateTimeoutMs;
  const seen = new Set(state.seenProviderIds);
  while (rows.length < Math.min(state.limit, remainingRecordBudget)) {
    while (buffer.length && rows.length < Math.min(state.limit, remainingRecordBudget)) {
      const record = buffer.shift();
      if (matches(state.query, record)) rows.push(record);
    }
    if (rows.length >= state.limit || !providerHasNext
        || queries >= queryBudget || Date.now() >= deadlineAt) break;
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const page = await readGitHubRepositoryPage({
      host: state.host, expectedViewerId: state.viewerId,
      first: state.providerPageSize, after: providerCursor
    }, {
      ...options.providerOptions,
      timeoutMs: Math.min(options.providerOptions?.timeoutMs ?? RDS_DEFAULTS.requestTimeoutMs, remainingMs)
    });
    const actualBinding = await localFingerprint(
      'github-viewer', `${state.host}\0${page.viewer.id}`, options.storeOptions
    );
    if (actualBinding !== state.accountBinding) {
      fail('The active GitHub account changed during repository discovery. Start a fresh read with the intended account.', 'REPOSITORY_PROVIDER_ACCOUNT_CHANGED');
    }
    queries += 1;
    const observedAt = new Date().toISOString();
    for (const node of page.nodes) {
      const providerId = `${state.host}:${node.id}`;
      if (seen.has(providerId)) continue;
      seen.add(providerId);
      buffer.push(providerRecord(node, state.host, state.accountBinding,
        new Map(state.knownByRemote), observedAt));
    }
    if (page.pageInfo.hasNextPage && page.pageInfo.endCursor === providerCursor) {
      fail('The GitHub provider returned a non-progressing cursor.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
    }
    providerCursor = page.pageInfo.endCursor;
    providerHasNext = page.pageInfo.hasNextPage;
  }

  const providerMore = buffer.some((record) => matches(state.query, record)) || providerHasNext;
  const totalProviderQueries = queryCountBefore + queries;
  const providerLimited = providerMore && (
    totalProviderQueries >= state.maximumProviderPages
    || deliveredBefore + rows.length >= RDS_DEFAULTS.maximumRows
    || Date.now() >= deadlineAt
  );
  const providerEnumeration = providerLimited ? 'limited' : providerMore ? 'more' : 'exhausted';
  const providerSource = sourceForProvider(
    { ...state, seenProviderIds: [...seen] }, providerEnumeration,
    providerLimited ? { reasons: ['REPOSITORY_CATALOG_LIMIT_REACHED'] } : {}
  );
  const knownRows = state.scope === 'all' && !state.knownDelivered
    ? state.knownBuffer.filter((record) => matches(state.query, record)) : [];
  const selectedKnown = knownRows.slice(0, Math.max(0, state.limit - rows.length));
  const remainingKnown = knownRows.slice(selectedKnown.length);
  const knownMore = remainingKnown.length > 0;
  const knownSources = state.scope === 'all'
    ? state.knownSources.map((source) => ({
      ...source,
      enumeration: source.enumeration === 'failed' ? 'failed'
        : source.enumeration === 'limited' ? 'limited' : knownMore ? 'more' : 'exhausted'
    })) : [];
  let sources = [...knownSources, providerSource];
  const delivered = [...selectedKnown, ...rows].slice(
    0, Math.min(state.limit, remainingRecordBudget)
  );
  const hasMore = providerMore || knownMore;
  const recordLimitReached = hasMore
    && deliveredBefore + delivered.length >= RDS_DEFAULTS.maximumRows;
  if (recordLimitReached) {
    sources = sources.map((source) => source.enumeration === 'more'
      ? { ...source, enumeration: 'limited', reasons: [...new Set([
        ...(source.reasons ?? []), 'REPOSITORY_CATALOG_LIMIT_REACHED'
      ])] }
      : source);
  }
  const usage = {
    ...state.usage,
    providerQueries: totalProviderQueries,
    deliveredRecords: deliveredBefore + delivered.length
  };
  const result = pageEnvelope({ ...state, usage }, delivered, sources, {
    reasons: [...state.knownReasons,
      ...(providerLimited || recordLimitReached ? ['REPOSITORY_CATALOG_LIMIT_REACHED'] : [])],
    enumeration: aggregateEnumeration(sources, hasMore)
  });
  const nextState = hasMore && !providerLimited && !recordLimitReached ? {
    ...state, buffer, providerCursor, providerHasNext,
    seenProviderIds: [...seen], knownBuffer: remainingKnown, knownDelivered: true,
    invocationDeadlineAt: null,
    usage
  } : null;
  return { result, nextState };
}

async function requestContext(request = {}, options = {}) {
  const scope = normalizeScope(request.scope);
  const audience = normalizeAudience(request.audience);
  const query = normalizeRepositoryQuery(request.query, { required: request.operation === 'search' });
  const limit = effectiveLimit(request.limit, audience);
  const host = scope === 'known' ? null : normalizeGitHubHost(request.host);
  const discloseProviderResults = audience === 'model'
    && request.discloseProviderResults === true && scope !== 'known';
  const queryFingerprint = query == null ? null
    : await localFingerprint('repository-query', `${RDS_QUERY_PROFILE}\0${query}`, options.storeOptions);
  return { scope, audience, query, limit, host, queryFingerprint, discloseProviderResults };
}

export function repositoryProviders(options = {}) {
  return {
    schemaVersion: RDS_ENVELOPE_VERSION, kind: 'repository-provider-descriptors',
    providers: [githubProviderDescriptor(options.providerOptions)],
    networkActivity: false, authenticationChecked: false
  };
}

export async function repositoryProviderStatus(request = {}, options = {}) {
  const descriptor = githubProviderDescriptor(options.providerOptions);
  if (request.check !== true) return {
    schemaVersion: RDS_ENVELOPE_VERSION, status: 'unchecked', provider: descriptor,
    networkActivity: false, authenticationChecked: false
  };
  const host = normalizeGitHubHost(request.host);
  const probed = await probeGitHubViewer(host, options.providerOptions);
  return {
    schemaVersion: RDS_ENVELOPE_VERSION, status: 'ready', provider: descriptor,
    providerInstanceId: probed.providerInstanceId, host,
    accountBinding: await localFingerprint(
      'github-viewer', `${host}\0${probed.viewer.id}`, options.storeOptions
    ),
    activeViewer: request.audience === 'model' ? null : probed.viewer.login,
    networkActivity: true, authenticationChecked: true,
    rateLimit: probed.rateLimit, durationMs: probed.durationMs
  };
}

async function knownCatalog(context, known, options) {
  const binding = contextBinding({ ...context, accountBinding: null, offline: false });
  const created = await createCatalogSession({
    contextBinding: binding, scope: 'known', provider: null, host: null,
    accountBinding: null, queryFingerprint: context.queryFingerprint, query: null,
    audience: context.audience, limit: context.limit, offline: false,
    discloseProviderResults: context.discloseProviderResults,
    buffer: known.repositories, knownSources: known.sources,
    knownReasons: known.reasons, usage: { ...known.usage, deliveredRecords: 0 }
  }, options.storeOptions);
  return consumeCatalogCursor(created.cursor, { contextBinding: binding },
    (state) => nextPage({ ...state, sessionRef: created.sessionRef, query: context.query }, options),
    options.storeOptions);
}

async function offlineCatalog(context, known, request, options) {
  if (!request.account) {
    fail('Offline provider catalog use requires the exact prior account binding.', 'REPOSITORY_PROVIDER_NOT_SELECTED');
  }
  const cacheKey = digest(JSON.stringify({
    host: context.host, accountBinding: request.account, profile: RDS_PROFILE_VERSION
  }));
  const cached = await readProviderCache(cacheKey, options.storeOptions);
  if (!cached) {
    fail('No permitted retained provider observation is available for this host and account.', 'REPOSITORY_PROVIDER_UNAVAILABLE');
  }
  const age = Math.max(0, Date.now() - Date.parse(cached.observedAt));
  const limited = cached.complete !== true;
  const providerSource = {
    sourceRef: `rdssrc_github_${digest(`${context.host}\0${request.account}`).slice(0, 24)}`,
    sourceKind: 'github-affiliated-repositories', sourceAvailability: 'available',
    enumeration: limited ? 'limited' : 'exhausted', consistency: 'retained_observation',
    freshness: { origin: 'cache', viewerChecked: false, observedAt: cached.observedAt, cacheAgeMs: age },
    acceptedRecords: cached.records.length, omittedRecords: 0,
    reasons: ['HISTORICAL_ACCESS_NOT_REVALIDATED',
      ...(limited ? ['HISTORICAL_PARTIAL_OBSERVATION'] : [])]
  };
  const binding = contextBinding({ ...context, accountBinding: request.account, offline: true });
  const combined = context.scope === 'all'
    ? [...known.repositories, ...cached.records] : cached.records;
  const sources = context.scope === 'all' ? [...known.sources, providerSource] : [providerSource];
  const created = await createCatalogSession({
    contextBinding: binding, scope: 'known', requestedScope: context.scope,
    provider: 'github', host: context.host, accountBinding: request.account,
    queryFingerprint: context.queryFingerprint, query: null, audience: context.audience,
    limit: context.limit, offline: true,
    discloseProviderResults: context.discloseProviderResults,
    buffer: combined, knownSources: sources,
    knownReasons: [...known.reasons, ...providerSource.reasons],
    usage: { ...known.usage, cache: 'hit' }
  }, options.storeOptions);
  return consumeCatalogCursor(created.cursor, { contextBinding: binding },
    (state) => nextPage({ ...state, scope: 'known', sessionRef: created.sessionRef,
      query: context.query }, options), options.storeOptions);
}

export async function repositoryCatalog(request = {}, options = {}) {
  const context = await requestContext(request, options);
  if (request.cursor) {
    const accountBinding = request.account ?? null;
    const binding = contextBinding({ ...context, accountBinding, offline: request.offline === true });
    return consumeCatalogCursor(request.cursor, { contextBinding: binding },
      (state) => nextPage({ ...state, query: context.query }, options), options.storeOptions);
  }

  const known = await captureKnownRepositoryCatalog(options.localOptions);
  if (context.scope === 'known') return knownCatalog(context, known, options);
  if (request.offline === true) return offlineCatalog(context, known, request, options);

  const knownByRemote = new Map();
  for (const record of known.repositories) {
    if (record.locators.https) knownByRemote.set(record.locators.https, record);
    if (record.locators.ssh) knownByRemote.set(record.locators.ssh, record);
  }
  const providerPageSize = boundedInteger(
    request.providerPageSize, RDS_DEFAULTS.providerPageSize,
    RDS_DEFAULTS.maximumProviderPageSize, 'Provider page size'
  );
  const maximumProviderPages = boundedInteger(
    request.providerQueries, RDS_DEFAULTS.providerQueries,
    RDS_DEFAULTS.maximumProviderQueries, 'Provider query count'
  );
  const epoch = await repositoryCatalogEpoch(options.storeOptions);
  let first;
  const invocationStartedAt = Date.now();
  try {
    first = await readGitHubRepositoryPage({
      host: context.host, first: providerPageSize, after: null
    }, {
      ...options.providerOptions,
      timeoutMs: Math.min(
        options.providerOptions?.timeoutMs ?? RDS_DEFAULTS.requestTimeoutMs,
        RDS_DEFAULTS.aggregateTimeoutMs
      )
    });
  } catch (error) {
    if (context.scope !== 'all') throw error;
    const source = {
      sourceRef: `rdssrc_github_${digest(context.host).slice(0, 24)}`,
      sourceKind: 'github-affiliated-repositories', sourceAvailability: 'unavailable',
      enumeration: 'failed', consistency: 'live_provider_traversal',
      freshness: { origin: 'live', viewerChecked: false, observedAt: null },
      acceptedRecords: 0, omittedRecords: 0,
      reasons: [error.code ?? 'REPOSITORY_PROVIDER_UNAVAILABLE']
    };
    const state = {
      sessionRef: `rdss_failed_${digest(Date.now()).slice(0, 24)}`,
      scope: 'all', provider: 'github', host: context.host, accountBinding: null,
      queryFingerprint: context.queryFingerprint, audience: context.audience,
      limit: context.limit, offline: false,
      discloseProviderResults: context.discloseProviderResults,
      usage: known.usage
    };
    const filtered = known.repositories.filter((record) => matches(context.query, record))
      .slice(0, context.limit);
    return pageEnvelope(state, filtered, [...known.sources, source], {
      reasons: [...known.reasons, error.code ?? 'REPOSITORY_PROVIDER_UNAVAILABLE'],
      enumeration: 'failed', delivery: filtered.length ? 'partial_page' : 'complete_page'
    });
  }

  const accountBinding = await localFingerprint(
    'github-viewer', `${context.host}\0${first.viewer.id}`, options.storeOptions
  );
  if (request.account && request.account !== accountBinding) {
    fail('The active GitHub account differs from the requested account binding.', 'REPOSITORY_PROVIDER_ACCOUNT_CHANGED');
  }
  const observedAt = new Date().toISOString();
  const buffer = first.nodes.map((node) => providerRecord(
    node, context.host, accountBinding, knownByRemote, observedAt
  ));
  const cacheKey = digest(JSON.stringify({
    host: context.host, accountBinding, profile: RDS_PROFILE_VERSION
  }));
  await writeProviderCache(cacheKey, {
    provider: { type: 'github', host: context.host, profile: RDS_PROFILE_VERSION },
    accountBinding, observedAt, complete: first.pageInfo.hasNextPage !== true, records: buffer
  }, { ...options.storeOptions, expectedEpoch: epoch });
  const binding = contextBinding({ ...context, accountBinding, offline: false });
  const created = await createCatalogSession({
    contextBinding: binding, scope: context.scope, provider: 'github', host: context.host,
    viewerId: first.viewer.id, accountBinding, queryFingerprint: context.queryFingerprint,
    query: null, audience: context.audience, limit: context.limit, offline: false,
    discloseProviderResults: context.discloseProviderResults,
    providerSourceRef: `rdssrc_github_${digest(`${context.host}\0${accountBinding}`).slice(0, 24)}`,
    observedFrom: observedAt, providerPageSize, maximumProviderPages,
    providerCursor: first.pageInfo.endCursor, providerHasNext: first.pageInfo.hasNextPage,
    invocationDeadlineAt: invocationStartedAt + RDS_DEFAULTS.aggregateTimeoutMs,
    buffer, seenProviderIds: first.nodes.map((node) => `${context.host}:${node.id}`),
    knownByRemote: [...knownByRemote.entries()],
    knownBuffer: context.scope === 'all' ? known.repositories : [], knownDelivered: false,
    knownSources: known.sources, knownReasons: known.reasons,
    usage: {
      ...known.usage, providerQueries: 1, providerDurationMs: first.durationMs,
      deliveredRecords: 0
    }
  }, options.storeOptions);
  return consumeCatalogCursor(created.cursor, { contextBinding: binding },
    (state) => nextPage({ ...state, sessionRef: created.sessionRef, query: context.query }, options),
    options.storeOptions);
}

export async function prepareRepositorySelection(selectionRef, action = 'inspect', options = {}) {
  const selection = await resolveCatalogSelection(selectionRef, action, options.storeOptions);
  let locator = selection.observedLocator;
  let revalidatedAt = new Date().toISOString();
  if (selection.repositoryIdentity?.type === 'provider-native') {
    if (!selection.providerHost || !selection.expectedViewerId
        || !selection.repositoryIdentity.nativeRepositoryId) {
      fail('Repository selection has incomplete provider identity.', 'REPOSITORY_SELECTION_STALE');
    }
    const current = await readGitHubRepositoryById({
      host: selection.providerHost,
      expectedViewerId: selection.expectedViewerId,
      repositoryId: selection.repositoryIdentity.nativeRepositoryId
    }, options.providerOptions);
    const currentLocator = current.node.locators.https ?? current.node.locators.ssh;
    if (currentLocator !== selection.observedLocator) {
      fail('The selected repository target changed after it was listed. Review and select the current target again.', 'REPOSITORY_SELECTION_STALE');
    }
    locator = currentLocator;
  } else {
    const known = await captureKnownRepositoryCatalog(options.localOptions);
    const current = known.repositories.find((record) => record.recordRef === selection.recordRef);
    if (!current || current.recordRevision !== selection.recordRevision
        || !current.sourceRefs.some((sourceRef) => selection.sourceRefs.includes(sourceRef))) {
      fail('The selected known-repository observation changed after it was listed. Refresh and select it again.', 'REPOSITORY_SELECTION_STALE');
    }
    locator = current.locators.https ?? current.locators.ssh;
  }
  if (!locator) fail('The selected repository has no admitted credential-free locator.', 'REPOSITORY_SELECTION_STALE');
  return {
    schemaVersion: RDS_ENVELOPE_VERSION,
    kind: 'repository-selection-preparation',
    selectionRef,
    action,
    status: 'ready',
    repositoryIdentity: selection.repositoryIdentity,
    locator,
    revalidatedAt,
    inspection: {
      required: action === 'inspect',
      command: action === 'inspect'
        ? ['singularity-flow', 'capability', 'inspect-repository', locator, '--json'] : null,
      searchKnown: false,
      includeProposals: false
    },
    effects: { mapped: false, cloned: false, workspaceCreated: false, proposalCreated: false }
  };
}

export { clearRepositoryCatalogCache, repositoryCatalogCacheStatus };
