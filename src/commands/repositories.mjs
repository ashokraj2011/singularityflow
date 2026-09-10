import {
  clearRepositoryCatalogCache, repositoryCatalog, repositoryCatalogCacheStatus,
  prepareRepositorySelection, repositoryProviders, repositoryProviderStatus
} from '../repositories/catalog.mjs';
import {
  optionBoolean, optionNumber, optionString, requirePositional, SingularityFlowError
} from '../util.mjs';
import { recordRepositoryDiscoveryAudit } from '../repositories/store.mjs';

const MAXIMUM_STDIN_QUERY_BYTES = 4 * 1024;

async function readQueryStdin() {
  if (process.stdin.isTTY) throw new SingularityFlowError(
    '--query-stdin requires a piped literal query.', { code: 'REPOSITORY_QUERY_REQUIRED' }
  );
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAXIMUM_STDIN_QUERY_BYTES) throw new SingularityFlowError(
      'Repository query input exceeds the reviewed stdin limit.',
      { code: 'REPOSITORY_QUERY_INVALID' }
    );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestOptions(positionals, options, operation) {
  return {
    operation,
    scope: optionString(options, 'scope', 'known'),
    host: optionString(options, 'host'),
    account: optionString(options, 'account'),
    cursor: optionString(options, 'cursor'),
    audience: optionString(options, 'audience', 'terminal'),
    offline: optionBoolean(options, 'offline'),
    limit: optionNumber(options, 'limit'),
    providerPageSize: optionNumber(options, 'provider-page-size'),
    providerQueries: optionNumber(options, 'provider-queries')
      ?? optionNumber(options, 'provider-pages'),
    discloseProviderResults: optionBoolean(options, 'disclose-provider-results'),
    query: operation === 'search' ? positionals[2] : null
  };
}

function providerName(_positionals, options) {
  const provider = optionString(options, 'provider', 'github');
  if (provider !== 'github') throw new SingularityFlowError(
    `Unsupported repository provider '${provider}'. Supported: github.`,
    { code: 'REPOSITORY_PROVIDER_UNSUPPORTED' }
  );
  return provider;
}

function requestSurface(options) {
  const surface = optionString(options, 'surface', 'cli');
  if (!['cli', 'copilot', 'vscode'].includes(surface)) throw new SingularityFlowError(
    "--surface must be 'cli', 'copilot', or 'vscode'.", { code: 'REPOSITORY_QUERY_INVALID' }
  );
  return surface;
}

async function audit(event, options) {
  // Local content-free metrics are diagnostic only. Storage pressure must not turn repository
  // discovery into a blocker or change provider/capability authority.
  await recordRepositoryDiscoveryAudit(event, options).catch(() => {});
}

function renderProviders(result) {
  console.log('PROVIDER  PROFILE                 AUTHENTICATION  NETWORK');
  for (const provider of result.providers) {
    console.log(`${provider.provider.padEnd(8)}  ${provider.profile.padEnd(22)}  ${provider.authentication.padEnd(14)}  required`);
  }
  console.log('\nNo provider or authentication check was run. Use repositories status --provider github --host <HOST> --check.');
}

function shellQuote(value, platform = process.platform) {
  const text = String(value);
  if (/^[A-Za-z0-9._/@:=,+-]+$/.test(text)) return text;
  return platform === 'win32'
    ? `'${text.replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function repositoryContinuationCommand(result, {
  action = 'list', query = null, surface = 'cli', platform = process.platform
} = {}) {
  if (!result?.nextCursor) return null;
  const request = result.request;
  const prefix = platform === 'win32' ? '& singularity-flow repositories' : 'singularity-flow repositories';
  const parts = [
    prefix,
    action,
    action === 'search' ? shellQuote(query, platform) : null,
    `--scope ${shellQuote(request.scope, platform)}`,
    request.providerInstanceId
      ? `--host ${shellQuote(request.providerInstanceId.replace(/^github:/, ''), platform)}` : null,
    request.accountBinding ? `--account ${shellQuote(request.accountBinding, platform)}` : null,
    `--audience ${shellQuote(request.audience, platform)}`,
    request.providerDisclosure === 'explicit' ? '--disclose-provider-results' : null,
    `--limit ${request.limit}`,
    request.offline ? '--offline' : null,
    surface !== 'cli' ? `--surface ${shellQuote(surface, platform)}` : null,
    `--cursor ${shellQuote(result.nextCursor, platform)}`
  ].filter(Boolean);
  return parts.join(' ');
}

function renderPage(result, continuation = {}) {
  console.log(`Repository catalog: ${result.enumeration} · ${result.delivery.returned} returned`
    + `${result.delivery.withheld ? ` · ${result.delivery.withheld} withheld from model output` : ''}`);
  if (result.repositories.length) {
    console.log(`\n${'REPOSITORY'.padEnd(52)}SOURCE / ACCESS`);
    for (const record of result.repositories) {
      const access = record.providerFacts?.permission ?? 'known locally';
      console.log(`${record.display.nameWithOwner.slice(0, 50).padEnd(52)}${access}`);
    }
  }
  for (const source of result.sources) {
    console.log(`\n${source.sourceKind}: ${source.enumeration} (${source.acceptedRecords} observed)`);
    for (const reason of source.reasons ?? []) console.log(`  - ${reason}`);
  }
  for (const reason of result.reasons ?? []) console.log(`\nWarning: ${reason}`);
  if (result.nextCursor) {
    console.log(`\nMore results: ${repositoryContinuationCommand(result, continuation)}`);
  }
}

function emit(value, json, renderer) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else renderer(value);
  return value;
}

export async function run(_argv, { positionals, options }) {
  const action = positionals[1] ?? 'list';
  const json = optionBoolean(options, 'json');
  const surface = requestSurface(options);
  if (action === 'providers') return emit(repositoryProviders(), json, renderProviders);
  if (action === 'status') {
    providerName(positionals, options);
    const result = await repositoryProviderStatus({
      host: optionString(options, 'host'), check: optionBoolean(options, 'check'),
      audience: optionString(options, 'audience', 'terminal')
    });
    return emit(result, json, (value) => {
      console.log(`GitHub repository provider: ${value.status}`);
      console.log(value.authenticationChecked
        ? `Host ${value.host}; active stored identity verified; account binding ${value.accountBinding}.`
        : 'No authentication or network check was run. Add --host <HOST> --check to verify it.');
    });
  }
  if (action === 'cache') {
    const cacheAction = positionals[2] ?? 'status';
    if (cacheAction === 'status') return emit(await repositoryCatalogCacheStatus(), json,
      (value) => console.log(`Repository catalog cache: ${value.status} · ${value.entries} entries · ${value.records} observations`));
    if (cacheAction === 'clear') return emit(await clearRepositoryCatalogCache(), json,
      (value) => console.log(`Repository catalog cache cleared: ${value.removedCacheEntries} cache entries; ${value.invalidatedSessions} cursors invalidated.`));
    throw new SingularityFlowError("repositories cache supports 'status' or 'clear'.", { code: 'UNKNOWN_SUBCOMMAND' });
  }
  if (action === 'select') {
    const selectionRef = requirePositional(positionals, 2, 'selection reference');
    const selectionAction = optionString(options, 'action', 'inspect');
    if (!['inspect', 'copy-url'].includes(selectionAction)) throw new SingularityFlowError(
      "--action must be 'inspect' or 'copy-url'.", { code: 'REPOSITORY_SELECTION_STALE' }
    );
    const startedAt = Date.now();
    const prepared = await prepareRepositorySelection(selectionRef, selectionAction);
    await audit({
      surface, operation: 'select', scope: 'known', provider: null,
      enumeration: 'exhausted', resultCount: 1, providerRequestCount: 0,
      latencyMs: Date.now() - startedAt, selectedAction: selectionAction
    });
    return emit(prepared, json,
      (value) => {
        console.log(`Repository selection: ${value.status}`);
        console.log(selectionAction === 'copy-url'
          ? value.locator
          : `Validated for inspection. Run: ${value.inspection.command.join(' ')}`);
      });
  }
  if (!['list', 'search'].includes(action)) throw new SingularityFlowError(
    `Unknown repositories action '${action}'. Supported: providers, status, list, search, select, cache.`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  const request = requestOptions(positionals, options, action);
  if (request.scope !== 'known') providerName(positionals, options);
  if (action === 'search') {
    if (optionBoolean(options, 'query-stdin')) request.query = await readQueryStdin();
    else request.query = requirePositional(positionals, 2, 'literal repository query');
  }
  const startedAt = Date.now();
  let result;
  try { result = await repositoryCatalog(request); }
  catch (error) {
    await audit({
      surface, operation: action, scope: request.scope,
      provider: request.scope === 'known' ? null : 'github', host: request.host,
      cacheOutcome: request.offline ? 'miss' : 'not-used', enumeration: 'failed',
      resultCount: 0, providerRequestCount: 0, latencyMs: Date.now() - startedAt,
      failureCode: error?.code, selectedAction: 'none'
    });
    throw error;
  }
  await audit({
    surface, operation: action, scope: request.scope,
    provider: request.scope === 'known' ? null : 'github', host: request.host,
    cacheOutcome: result.usage?.cache === 'hit' ? 'hit' : 'not-used',
    enumeration: result.enumeration, resultCount: result.repositories.length,
    providerRequestCount: result.usage?.providerQueries ?? 0,
    latencyMs: Date.now() - startedAt, selectedAction: 'none'
  });
  emit(result, json, (value) => renderPage(value, {
    action, query: request.query, surface
  }));
  if (result.enumeration === 'failed') process.exitCode = 3;
  return result;
}
