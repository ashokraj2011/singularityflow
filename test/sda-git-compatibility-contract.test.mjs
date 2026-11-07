import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util.mjs';
import { createGitCompatibilityAdapter } from '../src/sda/git-compatibility-adapter.mjs';
import { GIT_COMPATIBILITY_CONTRACT, gitCompatibilityDescriptor } from '../src/sda/git-compatibility-contract.mjs';
import { validateNamespaceStore } from '../src/sda/namespace/contract.mjs';
import { selectLifecycleAuthority } from '../src/sda/lifecycle-authority-contract.mjs';
import { selectSharedStateAuthority } from '../src/sda/shared-state-contract.mjs';

const root = path.join(os.tmpdir(), 'sflow-unopened-git-binding');
const scope = Object.freeze({ projectId: 'project-a' });
const binding = () => createGitCompatibilityAdapter({ root, scope });

test('the compatibility profile names the existing owners without claiming generic transactions or authority', () => {
  const adapter = binding();
  assert.equal(adapter.descriptor.contract, GIT_COMPATIBILITY_CONTRACT);
  assert.equal(adapter.descriptor.authorityEligible, false);
  assert.equal(adapter.descriptor.namespaceStoreEligible, false);
  assert.equal(adapter.descriptor.rawTransactions, false);
  assert.equal(adapter.descriptor.crossNamespaceAtomicity, false);
  assert.deepEqual(adapter.descriptor.ports.map(({ namespace, role }) => [namespace, role]),
    [['config', 'configuration'], ['state', 'lifecycle']]);
  assert.equal(Object.isFrozen(adapter), true);
  assert.equal(Object.isFrozen(adapter.descriptor.ports[0].operations), true);
  assert.doesNotMatch(JSON.stringify(adapter.descriptor), /sflow-unopened|refs\/|\/tmp\//u);
  assert.equal('transact' in adapter, false, 'arbitrary record writes cannot bypass native owners');
  assert.throws(() => validateNamespaceStore(adapter));
  for (const select of [selectLifecycleAuthority, selectSharedStateAuthority]) {
    assert.throws(() => select(adapter), { code: 'SDA_ADAPTER_CONTRACT_MISMATCH' });
  }
  assert.throws(() => gitCompatibilityDescriptor({ scope, proof: 'yes' }), { code: 'SDA_NAMESPACE_INPUT_INVALID' });
});

test('binding validation requires an explicit root and stable project and refuses owner injection', () => {
  for (const value of [undefined, {}, { root: '.', scope }, { root, scope: { projectId: '../project' } },
    { root, scope, owner: {} }, { root, scope, proof: null },
    { root, scope, proof: { config: null } }, { root, scope, proof: { config: {}, options: { authority: {} } } },
    { root, scope, proof: { config: { callback() {} } } },
    { root, scope, proof: { config: {}, options: { env: null } } }]) {
    assert.throws(() => createGitCompatibilityAdapter(value), { code: 'SDA_NAMESPACE_INPUT_INVALID' });
  }
  const original = { projectId: scope.projectId };
  const adapter = createGitCompatibilityAdapter({ root, scope: original });
  original.projectId = 'project-b';
  assert.deepEqual(adapter.descriptor.scope, scope);
});

test('wrong project, unavailable namespaces, wrong roles and disabled proof fail before opening any owner', async () => {
  const adapter = binding();
  await assert.rejects(adapter.open({ projectId: 'project-b' }, { namespace: 'state', role: 'lifecycle' }),
    error => error.code === 'SDA_NAMESPACE_INPUT_INVALID' && error.details.expectedProjectId === scope.projectId);
  for (const address of [
    { namespace: 'local', role: 'configuration' }, { namespace: 'runtime', role: 'lifecycle' },
    { namespace: 'evidence', role: 'proof' }, { namespace: 'config', role: 'lifecycle' },
    { namespace: 'state', role: 'configuration' }, { namespace: 'state', role: 'proof' },
    { namespace: 'state', role: '__proto__' }
  ]) await assert.rejects(adapter.open(scope, address), { code: 'SDA_NAMESPACE_UNSUPPORTED' });
  await assert.rejects(adapter.open(scope, { namespace: 'state', role: 'lifecycle', root: 'another' }),
    { code: 'SDA_NAMESPACE_INPUT_INVALID' });
  for (const role of [null, {}, Symbol('role'), 'x'.repeat(129)]) {
    await assert.rejects(adapter.open(scope, { namespace: 'state', role }), { code: 'SDA_NAMESPACE_INPUT_INVALID' });
  }
});

test('construction, rejected opens and cancelled configuration calls never load concrete Git owners', () => {
  // A loader fails immediately if a native owner or Git infrastructure is imported. This checks
  // executed import paths, including later dynamic imports, in a fresh process on supported Node.
  const loader = `export async function resolve(specifier, context, next) {
    const owners = ['story-branch-authority', 'git-ledger-adapter', 'configuration-proposal', 'approved-configuration-reader', 'git'];
    if (owners.some(name => specifier.endsWith('/' + name + '.mjs'))) {
      throw new Error('Eager native owner: ' + specifier);
    }
    return next(specifier, context);
  }`;
  const entry = new URL('../src/sda/git-compatibility-adapter.mjs', import.meta.url).href;
  const code = `import { register } from 'node:module';
    import assert from 'node:assert/strict';
    register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url);
    const { createGitCompatibilityAdapter } = await import(${JSON.stringify(entry)});
    const scope = ${JSON.stringify(scope)};
    const adapter = createGitCompatibilityAdapter({ root: ${JSON.stringify(root)}, scope, proof: {config:{enabled:true}} });
    const controller = new AbortController(); controller.abort();
    const options = {signal: controller.signal};
    await assert.rejects(adapter.open({projectId:'other'}, {namespace:'state',role:'lifecycle'}), {code:'SDA_NAMESPACE_INPUT_INVALID'});
    await assert.rejects(adapter.open(scope, {namespace:'local',role:'proof'}), {code:'SDA_NAMESPACE_UNSUPPORTED'});
    await assert.rejects(adapter.open(scope, {namespace:'state',role:'lifecycle'}, options), {code:'SDA_OPERATION_CANCELLED'});
    await assert.rejects(adapter.open(scope, {namespace:'state',role:'proof'}, options), {code:'SDA_OPERATION_CANCELLED'});
    const config = await adapter.open(scope, {namespace:'config',role:'configuration'});
    assert.equal(config, await adapter.open(scope, {namespace:'config',role:'configuration'}));
    const calls = [
      () => config.withRead(() => {}, options), () => config.withCommitRead({}, () => {}, options),
      () => config.propose({}, options), () => config.listProposals(options),
      () => config.inspectProposal('branch', options), () => config.activateProposal('branch', options),
      () => config.transactions(options), () => config.reconcileTransaction('id', options)
    ];
    for (const call of calls) await assert.rejects(call(), {code:'SDA_OPERATION_CANCELLED'});
    console.log('lazy and cancelled');`;
  const result = run(process.execPath, ['--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url))
  });
  assert.equal(result.stdout.trim(), 'lazy and cancelled');
});
