import * as remote from '../../src/remote-fetch.mjs';
import * as marketplaces from '../../src/marketplace.mjs';
import * as authority from '../../src/state-authority.mjs';
import { recordSha256 } from '../../src/records.mjs';

export const marketplacePolicyModules = { remote, marketplaces, authority };

function result(id, run) {
  try { return { id, value: run() }; }
  catch (error) { return { id, error: { name: error.name, message: error.message, code: error.code ?? null,
    details: error.details ?? null, exitCode: error.exitCode ?? null } }; }
}

function addressValue(address) {
  if (address.includes('.')) return address.split('.').reduce((sum, value) => sum * 256n + BigInt(value), 0n);
  const halves = address.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const fields = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return fields.reduce((sum, value) => sum * 65536n + BigInt('0x' + value), 0n);
}

function formatAddress(value, family) {
  const shifts = family === 'ipv4' ? [24n, 16n, 8n, 0n] : [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n];
  const mask = family === 'ipv4' ? 255n : 65535n;
  return shifts.map(shift => ((value >> shift) & mask).toString(family === 'ipv4' ? 10 : 16)).join(family === 'ipv4' ? '.' : ':');
}

export function remoteAddressResults(subnets, api = remote) {
  const inputs = [undefined, null, false, 123, {}, '', 'public.example.org', '8.8.8.8', '1.1.1.1',
    '256.1.1.1', '01.2.3.4', '::ffff:127.0.0.1', '::FFFF:8.8.8.8', '::ffff:808:808',
    '2001:4860:4860::8888', '2606:4700:4700::1111', 'fe80::1%en0', '2001:4860::1%eth0'];
  for (const [family, entries] of Object.entries(subnets)) for (const [network, prefix] of entries) {
    const bits = family === 'ipv4' ? 32n : 128n, maximum = (1n << bits) - 1n;
    const first = addressValue(network), last = first + (1n << (bits - BigInt(prefix))) - 1n;
    for (const value of [first - 1n, first, last, last + 1n]) if (value >= 0n && value <= maximum) inputs.push(formatAddress(value, family));
  }
  return inputs.map((value, index) => result(String(index), () => api.isPublicRemoteAddress(value)));
}

export function remoteUrlResults(api = remote) {
  const inputs = [undefined, null, '', 'not a URL', 'https://market.example.org/index.json', ' https://market.example.org/index.json ',
    'http://market.example.org', 'file:///local', 'https://user:pass@market.example.org', 'https://localhost', 'https://app.localhost',
    'https://app.local', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://10.0.0.1', 'https://8.8.8.8',
    'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[2001:db8::1]', 'https://[2001:4860:4860::8888]/',
    'https://market.example.org/{workId}', 'https://market.example.org/{unknown}', 'https://market.example.org/{}'];
  const results = inputs.map((value, index) => result(String(index), () => api.validatePublicHttpsUrl(value, 'Source')));
  for (const [value, options] of [
    ['https://market.example.org/{workId}', { dynamic: true, allowedTokens: ['workId'] }],
    ['https://market.example.org/{unknown}', { dynamic: true, allowedTokens: ['workId'] }],
    ['https://{host}/index.json', { dynamic: true, allowedTokens: ['host'] }],
    ['https://localhost/{workId}', { dynamic: true, allowedTokens: ['workId'] }]
  ]) results.push(result('dynamic-' + results.length, () => api.validatePublicHttpsUrl(value, 'Source', options)));
  return results;
}

export function marketplaceConfigurationResults(api = marketplaces) {
  const cases = [
    ['default', () => undefined], ['null', () => null], ['empty', () => ({})], ['array', () => []], ['text', () => 'market'],
    ['ordinary', () => ({ team: { index: 'https://market.example.org/index.json' } })],
    ['with-origins', () => ({ team: { label: '  Team   assets  ', index: 'https://market.example.org/index.json', allowedOrigins: ['https://cdn.example.org', 'https://cdn.example.org/'] } })],
    ['null-prototype', () => Object.assign(Object.create(null), { team: { index: 'https://market.example.org/index.json' } })],
    ['empty-id', () => ({ '': {} })], ['uppercase-id', () => ({ Team: {} })], ['null-entry', () => ({ team: null })],
    ['array-entry', () => ({ team: [] })], ['extra-field', () => ({ team: { index: 'https://market.example.org', approved: true } })],
    ['missing-index', () => ({ team: {} })], ['private-index', () => ({ team: { index: 'https://127.0.0.1/index.json' } })],
    ['public-literal-index', () => ({ team: { index: 'https://8.8.8.8/index.json' } })],
    ['null-origins', () => ({ team: { index: 'https://market.example.org', allowedOrigins: null } })],
    ['text-origins', () => ({ team: { index: 'https://market.example.org', allowedOrigins: 'https://cdn.example.org' } })],
    ['object-origins', () => ({ team: { index: 'https://market.example.org', allowedOrigins: {} } })],
    ['path-origin', () => ({ team: { index: 'https://market.example.org', allowedOrigins: ['https://cdn.example.org/path'] } })],
    ['query-origin', () => ({ team: { index: 'https://market.example.org', allowedOrigins: ['https://cdn.example.org/?x=1'] } })],
    ['hash-origin', () => ({ team: { index: 'https://market.example.org', allowedOrigins: ['https://cdn.example.org/#x'] } })],
    ['private-origin', () => ({ team: { index: 'https://market.example.org', allowedOrigins: ['https://[::1]'] } })],
    ['empty-label', () => ({ team: { index: 'https://market.example.org', label: ' ' } })],
    ['long-label', () => ({ team: { index: 'https://market.example.org', label: 'x'.repeat(121) } })],
    ['numeric-label', () => ({ team: { index: 'https://market.example.org', label: 123 } })],
    ['templated-index', () => ({ team: { index: 'https://market.example.org/{workId}' } })]
  ];
  return cases.map(([id, make]) => result(id, () => {
    const value = api.normalizeMarketplaces(make());
    return { value, sha256: recordSha256(value), frozenEntries: Object.values(value).every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.allowedOrigins)) };
  }));
}

export function stateAuthorityResults(api = authority) {
  const cases = [
    ['default', {}, {}], ['world-model', { worldModel: { stateBranch: 'model-state', remote: 'model-origin' } }, {}],
    ['ledger', { ledger: { branch: 'ledger-state', remote: 'ledger-origin' } }, {}],
    ['application', { git: { remote: 'code-origin' } }, {}],
    ['precedence', { worldModel: { stateBranch: 'model-state', remote: 'model-origin' }, ledger: { branch: 'ledger-state', remote: 'ledger-origin' }, git: { remote: 'code-origin' } }, { branch: 'fallback-state', remote: 'fallback-origin' }],
    ['fallback', {}, { branch: 'fallback-state', remote: 'fallback-origin' }],
    ['fallback-before-ledger-branch', { ledger: { branch: 'ledger-state' } }, { branch: 'fallback-state' }],
    ['empty-strings', { worldModel: { stateBranch: '', remote: '' } }, {}],
    ['null-values', { worldModel: { stateBranch: null, remote: null }, ledger: { branch: null, remote: null }, git: { remote: null } }, {}]
  ];
  return cases.map(([id, definition, options]) => result(id, () => {
    const value = api.worldModelStateAuthority(definition, options);
    return { value, frozen: Object.isFrozen(value) };
  }));
}
