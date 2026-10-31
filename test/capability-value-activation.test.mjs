/**
 * Capability edits and activation decide by configuration values, never by a textual Git merge
 * (SDA-AC-013): an edit projects the authority from exact objects instead of cloning it, and
 * activation re-applies the proposal's own records onto the current authority.
 *
 * Real bare repositories, as in organisation.test.mjs. Git processes are counted by verb through a
 * PATH wrapper, so the assertions cover every launch, synchronous or asynchronous.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { removeTemporaryTree, run } from '../src/util.mjs';
import {
  activateCapabilityProposal, addCapabilityRepository, adoptManagedCapabilityMap, discardStaleCapabilityProposal,
  editCapabilityInOrganisation, inspectCapabilityProposal, listCapabilityProposals, mapCapability, mapCapabilityTeam,
  previewManagedCapabilityAdoption, proposeProgressiveCapabilityChange, publishOrganisationCapabilityMap,
  readOrganisation, rebaseCapabilityProposal
} from '../src/organisation.mjs';
import { workspaceRemoteCapabilities } from '../src/workspace.mjs';
import { editCapability } from '../src/capabilities.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { replayCapabilityProposal } from '../src/capability-value-replay.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

process.env.SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE = 'off';
const posixOnly = { skip: process.platform === 'win32' };

async function remotes(t, ...names) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-value-'));
  t.after(() => removeTemporaryTree(base));
  const previous = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(base, 'leads.json');
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
    else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = previous;
  });
  const made = { base };
  for (const name of names) {
    const bare = path.join(base, `${name}.git`);
    run('git', ['init', '-q', '-b', 'main', '--bare', bare], { cwd: base });
    const seed = path.join(base, `${name}-seed`);
    run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
    await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
    run('git', ['add', '-A'], { cwd: seed });
    run('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'Initial'], { cwd: seed });
    run('git', ['push', '-q', bare, 'main:main'], { cwd: seed });
    made[name] = bare;
  }
  return made;
}

/** The repository's own review merge, outside production code. */
async function mergeProposal(remote, proposal) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-value-review-'));
  try {
    run('git', ['clone', '-q', '--no-local', '--branch', proposal.baseBranch, remote, checkout]);
    run('git', ['fetch', '-q', 'origin', proposal.branch], { cwd: checkout });
    run('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', `HEAD:${proposal.baseBranch}`], { cwd: checkout });
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

/** Change approved configuration directly, as another reviewed activation would have. */
async function changeAuthority(remote, edit, message = 'Approved elsewhere') {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-value-authority-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', remote, checkout]);
    await edit(checkout);
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['-c', 'user.name=Reviewer', '-c', 'user.email=reviewer@example.test', 'commit', '-qm', message], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:sflow/config'], { cwd: checkout });
    return run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

/** A hand-written single-commit proposal on the current authority, named as the product names it. */
async function handProposal(remote, prefix, edit) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-value-proposal-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', remote, checkout]);
    const base = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    await edit(checkout);
    run('git', ['add', '-A'], { cwd: checkout });
    run('git', ['-c', 'user.name=Author', '-c', 'user.email=author@example.test', 'commit', '-qm', 'Hand proposal'], { cwd: checkout });
    const branch = `sflow/config-change/capability/${prefix}-${base.slice(0, 8)}`;
    run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: checkout });
    return { branch, commit: run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim(), base };
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

const approved = (remote, file = 'capabilities.yml') => YAML.parse(run('git', [
  'show', `sflow/config:singularity/${file}`
], { cwd: remote }).stdout);

/**
 * Every Git verb `action` launches, through a PATH wrapper around the real Git. Leading global
 * options (`-c k=v`, `-C dir`, `--git-dir=…`) are skipped so the verb is the subcommand.
 */
async function gitVerbs(base, action) {
  const directory = await mkdtemp(path.join(base, 'git-verbs-'));
  const log = path.join(directory, 'verbs.log');
  const realGit = run('which', ['git']).stdout.trim();
  await mkdir(path.join(directory, 'bin'));
  const wrapper = path.join(directory, 'bin', 'git');
  await writeFile(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let index = 0;
while (index < args.length && args[index].startsWith('-')) index += ['-c', '-C'].includes(args[index]) ? 2 : 1;
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args.slice(index)) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
`);
  await chmod(wrapper, 0o755);
  await writeFile(log, '');
  const previous = process.env.PATH;
  process.env.PATH = `${path.dirname(wrapper)}${path.delimiter}${previous}`;
  let result;
  try { result = await action(); }
  finally { process.env.PATH = previous; }
  const commands = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { result, commands, verbs: commands.map((command) => command[0] ?? '') };
}

const count = (verbs, verb) => verbs.filter((entry) => entry === verb).length;

test('maps that add different capabilities are mergeable by value and activate without a Git merge or a rebase', posixOnly, async (t) => {
  const org = await remotes(t, 'platform');
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', kind: 'collection' }));
  const first = await mapCapability(org.platform, { capabilityId: 'first-service', kind: 'collection' });
  const second = await mapCapability(org.platform, { capabilityId: 'second-service', kind: 'collection' });
  const third = await mapCapability(org.platform, { capabilityId: 'third-service', kind: 'collection' });
  await mergeProposal(org.platform, first);

  // A line merge called these conflicting: every map appends to the end of the same file. They
  // add different records, so each re-applies onto the advanced authority unchanged.
  const pending = await listCapabilityProposals(org.platform, { includeDiff: false });
  for (const original of [second, third]) {
    const proposal = pending.find((entry) => entry.branch === original.branch);
    assert.equal(proposal.valid, true);
    assert.equal(proposal.mergeable, true);
    assert.equal(proposal.mergeability.status, 'mergeable');
    assert.deepEqual(proposal.conflictFiles, []);
    assert.equal(proposal.rebaseAction, null);
    assert.equal(proposal.discardable, false);
  }
  await assert.rejects(rebaseCapabilityProposal(org.platform, second.branch),
    (error) => error.code === 'CAPABILITY_PROPOSAL_REBASE_NOT_REQUIRED');

  const targetBefore = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const { result: activated, verbs } = await gitVerbs(org.base, () => activateCapabilityProposal(
    org.platform, second.branch, { confirm: second.commit, acknowledgeUnprotected: true }));
  assert.equal(activated.status, 'activated');
  assert.equal(activated.alreadyMerged, false);
  assert.equal(count(verbs, 'merge'), 0, 'no textual merge decides the approved configuration');
  assert.equal(count(verbs, 'merge-tree'), 0);
  assert.ok(count(verbs, 'commit-tree') >= 1, 'the activation commit is written from exact objects');
  assert.equal(count(verbs, 'clone'), 1, 'only the review checkout that carries the audit; no probe clone');
  assert.deepEqual(run('git', ['rev-list', '--parents', '-n', '1', activated.targetCommit], {
    cwd: org.platform
  }).stdout.trim().split(' ').slice(1), [targetBefore, second.commit],
  'the reviewed proposal stays in authority history as the second parent');
  assert.deepEqual(Object.keys(approved(org.platform).capabilities).sort(),
    ['first-service', 'foundation', 'second-service']);

  const thirdActivation = await activateCapabilityProposal(org.platform, third.branch, {
    confirm: third.commit, acknowledgeUnprotected: true
  });
  assert.equal(thirdActivation.status, 'activated');
  assert.deepEqual(Object.keys(approved(org.platform).capabilities).sort(),
    ['first-service', 'foundation', 'second-service', 'third-service']);
  assert.equal((await mapCapability(org.platform, { capabilityId: 'third-service', kind: 'collection' })).status,
    'already-mapped');
});

test('value-level activation carries only the proposal\'s own delivery repository record', async (t) => {
  const org = await remotes(t, 'platform', 'service', 'worker');
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', kind: 'collection' }));
  const first = await mapCapability(org.platform, { capabilityId: 'service-api', kind: 'delivery', repositoryUrl: org.service });
  const second = await mapCapability(org.platform, { capabilityId: 'worker-api', kind: 'delivery', repositoryUrl: org.worker });
  await mergeProposal(org.platform, first);
  const activated = await activateCapabilityProposal(org.platform, second.branch, {
    confirm: second.commit, acknowledgeUnprotected: true
  });
  assert.equal(activated.status, 'activated');
  const repositories = approved(org.platform, 'portfolio.yml').repositories;
  assert.equal(repositories.service.url, org.service);
  assert.equal(repositories.worker.url, org.worker);
  assert.equal(approved(org.platform).capabilities['worker-api'].repository, 'worker');
});

test('a field both sides changed differently is a value conflict, including a list a line merge would combine', posixOnly, async (t) => {
  const org = await remotes(t, 'platform');
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', kind: 'collection' }));
  const owned = ['docs/a', 'docs/b', 'docs/c', 'docs/d', 'docs/e'];
  const setOwns = (list) => async (checkout) => {
    const file = path.join(checkout, 'singularity/capabilities.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.setIn(['capabilities', 'foundation', 'owns'], document.createNode(list));
    await writeFile(file, document.toString(), 'utf8');
  };
  await changeAuthority(org.platform, setOwns(owned), 'Record owned paths');
  // The proposal drops the first entry; the authority then appends one. The two hunks are far
  // apart, so Git's line merge combines them silently — but the same list changed differently.
  const proposal = await handProposal(org.platform, 'set-foundation', setOwns(owned.slice(1)));
  await changeAuthority(org.platform, setOwns([...owned, 'docs/f']), 'Own one more path');
  const target = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  assert.equal(run('git', ['merge-tree', '--write-tree', '--quiet', target, proposal.commit], {
    cwd: org.platform, allowFailure: true
  }).status, 0, 'a textual merge would have resolved this silently');

  const { result: replay, verbs } = await gitVerbs(org.base, () => replayCapabilityProposal(org.platform, {
    base: proposal.base, proposal: proposal.commit, target
  }));
  assert.equal(replay.status, 'conflicting');
  assert.deepEqual(replay.conflicts, [{ path: 'singularity/capabilities.yml', pointers: ['/capabilities/foundation/owns'] }]);
  assert.deepEqual([...new Set(verbs)].filter((verb) => ['merge', 'merge-tree', 'clone', 'checkout'].includes(verb)), [],
    'mergeability reads exact objects only');

  const inspected = await inspectCapabilityProposal(org.platform, proposal.branch);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.mergeable, false);
  assert.deepEqual(inspected.conflictFiles, ['singularity/capabilities.yml']);
  assert.deepEqual(inspected.mergeability.conflicts[0].pointers, ['/capabilities/foundation/owns']);
  assert.equal(inspected.discardable, true);
  // C4: a value conflict is exactly what a record rebase cannot settle. The view and the refusal
  // name the discard at the exact commit, then the same edit made again; never rebase-proposal.
  assert.equal(inspected.rebaseAction, null);
  assert.match(inspected.discardAction.command, new RegExp(`^singularity-flow capability discard-proposal ${proposal.branch} --lead \\S+ --confirm ${proposal.commit} --reason <REASON> --json$`));
  assert.match(inspected.remapAction.command, /^singularity-flow capability edit foundation --lead \S+ --mode set <CHANGED-OPTIONS> --json$/);
  let refusal;
  await assert.rejects(activateCapabilityProposal(org.platform, proposal.branch, {
    confirm: proposal.commit, acknowledgeUnprotected: true
  }), (error) => {
    refusal = error;
    assert.equal(error.code, 'CAPABILITY_PROPOSAL_VALUE_CONFLICT');
    assert.match(error.message, /\/capabilities\/foundation\/owns/);
    assert.deepEqual(error.details.mergeability.conflictFiles, ['singularity/capabilities.yml']);
    return true;
  });
  const plan = refusalRemediationPlan(refusal, ['capability', 'activate', proposal.branch]);
  assert.deepEqual(plan.steps.slice(0, 2).map((entry) => entry.command), [inspected.discardAction.command, inspected.remapAction.command]);
  assert.ok(plan.steps.every((entry) => !entry.commandRejected && !String(entry.command).includes('rebase-proposal')), 'no step loops back to a rebase');
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), target,
    'a refused activation changes nothing');
  assert.equal((await discardStaleCapabilityProposal(org.platform, proposal.branch, {
    confirm: proposal.commit, reason: 'The approved list moved on'
  })).status, 'discarded');
});

test('an unrelated field changed on the authority keeps a capability edit activatable', async (t) => {
  const org = await remotes(t, 'platform');
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', name: 'Foundation', kind: 'collection' }));
  const edited = await editCapabilityInOrganisation(org.platform, 'foundation', { name: 'Foundation platform' });
  await changeAuthority(org.platform, async (checkout) => {
    const file = path.join(checkout, 'singularity/capabilities.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.setIn(['capabilities', 'foundation', 'metadata'], document.createNode({ purpose: 'Shared services' }));
    await writeFile(file, document.toString(), 'utf8');
  });
  const activated = await activateCapabilityProposal(org.platform, edited.branch, {
    confirm: edited.commit, acknowledgeUnprotected: true
  });
  assert.equal(activated.status, 'activated');
  const foundation = approved(org.platform).capabilities.foundation;
  assert.equal(foundation.name, 'Foundation platform');
  assert.deepEqual(foundation.metadata, { purpose: 'Shared services' });
});

test('a capability edit builds the clone path\'s exact tree without cloning or checking out the lead', posixOnly, async (t) => {
  const org = await remotes(t, 'platform');
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', name: 'Foundation', kind: 'collection' }));
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'payments', name: 'Payments', kind: 'collection', parent: 'foundation' }));
  const changes = { name: 'Payments platform', metadata: { purpose: 'Card and ledger flows' } };
  const { result: edited, verbs } = await gitVerbs(org.base, () =>
    editCapabilityInOrganisation(org.platform, 'payments', changes));
  for (const verb of ['clone', 'checkout', 'switch', 'merge', 'commit']) {
    assert.equal(count(verbs, verb), 0, `a capability edit runs no '${verb}'`);
  }
  assert.equal(count(verbs, 'fetch'), 1, 'one exact transfer of the authority tip');
  assert.equal(count(verbs, 'push'), 1);
  assert.equal(edited.branch, `sflow/config-change/capability/set-payments-${edited.baseCommit.slice(0, 8)}`);
  assert.deepEqual(run('git', ['rev-list', '--parents', '-n', '1', edited.commit], { cwd: org.platform })
    .stdout.trim().split(' ').slice(1), [edited.baseCommit]);
  assert.equal(run('git', ['log', '-1', '--format=%s', edited.commit], { cwd: org.platform }).stdout.trim(),
    'Update capability payments');

  // The clone-based path, reproduced here as the oracle: the same initialization, typed edit and
  // staging in an ordinary clone of the same authority commit.
  const oracle = await mkdtemp(path.join(org.base, 'clone-oracle-'));
  run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, oracle]);
  run('git', ['checkout', '-q', '--detach', edited.baseCommit], { cwd: oracle });
  await initializeDefinition(oracle);
  await editCapability(oracle, 'payments', changes, {
    mode: 'set', portfolio: YAML.parse(await readFile(path.join(oracle, 'singularity/portfolio.yml'), 'utf8'))
  });
  run('git', ['add', '-A'], { cwd: oracle });
  assert.equal(
    run('git', ['rev-parse', `${edited.commit}^{tree}`], { cwd: org.platform }).stdout.trim(),
    run('git', ['write-tree'], { cwd: oracle }).stdout.trim(),
    'byte-equal tree to the clone-based edit');

  const removal = await editCapabilityInOrganisation(org.platform, 'foundation', {}, {
    mode: 'remove', reparentChildrenTo: null
  });
  assert.deepEqual(removal.reparentedChildren, ['payments']);
  run('git', ['checkout', '-q', '--detach', removal.baseCommit], { cwd: oracle });
  run('git', ['reset', '-q', '--hard'], { cwd: oracle });
  await editCapability(oracle, 'foundation', {}, {
    mode: 'remove', reparentChildrenTo: null,
    portfolio: YAML.parse(await readFile(path.join(oracle, 'singularity/portfolio.yml'), 'utf8'))
  });
  run('git', ['add', '-A'], { cwd: oracle });
  assert.equal(
    run('git', ['rev-parse', `${removal.commit}^{tree}`], { cwd: org.platform }).stdout.trim(),
    run('git', ['write-tree'], { cwd: oracle }).stdout.trim());
});

test('map, team, repository, adoption and policy proposals are built from exact objects, with no clone or checkout', posixOnly, async (t) => {
  // The same projection as an edit (SDA-AC-013). Each was compared, commit for commit, with the
  // clone path it replaces; the line-level shape of each proposal is pinned in organisation.test.mjs.
  const org = await remotes(t, 'platform', 'worker');
  await mergeProposal(org.platform, await mapCapability(org.platform, {
    capabilityId: 'platform-app', name: 'Platform app', kind: 'delivery', repositoryUrl: org.platform
  }));
  const projected = async (label, action) => {
    const { result, verbs } = await gitVerbs(org.base, action);
    for (const verb of ['clone', 'checkout', 'switch', 'merge', 'commit']) {
      assert.equal(count(verbs, verb), 0, `${label} runs no '${verb}'`);
    }
    assert.equal(count(verbs, 'commit-tree'), 1, `${label} writes its proposal commit from exact objects`);
    assert.equal(count(verbs, 'push'), 1, label);
    assert.deepEqual(run('git', ['rev-list', '--parents', '-n', '1', result.commit], { cwd: org.platform })
      .stdout.trim().split(' ').slice(1), [result.baseCommit], `${label} sits on the authority it read`);
    return result;
  };
  const mapped = await projected('a map', () => mapCapability(org.platform, {
    capabilityId: 'worker-api', name: 'Worker API', kind: 'delivery', repositoryUrl: org.worker
  }));
  assert.equal(YAML.parse(run('git', ['show', `${mapped.commit}:singularity/portfolio.yml`], { cwd: org.platform }).stdout)
    .repositories.worker.url, org.worker);
  const added = await projected('a repository addition', () => addCapabilityRepository(org.platform, 'platform-app', org.worker));
  assert.deepEqual(YAML.parse(run('git', ['show', `${added.commit}:singularity/capabilities.yml`], { cwd: org.platform }).stdout)
    .capabilities['platform-app'].repositories, ['platform', 'worker']);
  const team = await projected('a team map', () => mapCapabilityTeam(org.platform, {
    teamId: 'worker-team', name: 'Worker Team',
    members: [{ capabilityId: 'worker-app', name: 'Worker App', repositoryUrl: org.worker }], links: ['platform-app']
  }));
  assert.equal(YAML.parse(run('git', ['show', `${team.commit}:singularity/capabilities.yml`], { cwd: org.platform }).stdout)
    .capabilities['platform-app'].parent, 'worker-team');
  const preview = await previewManagedCapabilityAdoption(org.platform);
  const adoption = await projected('a managed adoption', () => adoptManagedCapabilityMap(org.platform, {
    confirm: preview.plan.planSha256
  }));
  await mergeProposal(org.platform, adoption);
  const policy = await projected('a policy change', () => proposeProgressiveCapabilityChange(org.platform, {
    operation: 'auto', capabilityId: 'platform-app',
    auto: { eligibility: 'bounded', forbiddenWhenProtectedScopePredicted: true, maximumTouchedPaths: 6 }
  }));
  assert.equal(YAML.parse(run('git', ['show', `${policy.commit}:singularity/capabilities.yml`], { cwd: org.platform }).stdout)
    .capabilities['platform-app'].policy.auto.eligibility, 'bounded');
});

test('the capability map and a lead\'s catalog are read from exact objects in place, and match the clone', posixOnly, async (t) => {
  const org = await remotes(t, 'platform', 'worker');
  await mergeProposal(org.platform, await mapCapability(org.platform, {
    capabilityId: 'platform-app', name: 'Platform app', kind: 'delivery', repositoryUrl: org.platform
  }));
  await mergeProposal(org.platform, await mapCapability(org.platform, {
    capabilityId: 'worker-api', name: 'Worker API', kind: 'delivery', repositoryUrl: org.worker
  }));
  await publishOrganisationCapabilityMap(org.platform);
  // The pool lives in the repository a command runs in; this file otherwise keeps it off.
  const cacheRoot = path.join(org.base, 'platform-seed');
  const pooled = async (action) => {
    const previous = process.env.SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE;
    process.env.SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE = 'on';
    try { return await gitVerbs(org.base, action); }
    finally { process.env.SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE = previous; }
  };
  const clonesOf = (commands, branch) => commands.filter((command) => command[0] === 'clone' && command.includes(branch));

  const { result: organisation, commands } = await pooled(() => readOrganisation(org.platform, { refresh: true, cacheRoot }));
  assert.deepEqual(clonesOf(commands, 'sflow/config'), [], 'the approved configuration is read in place, not cloned');
  assert.equal(organisation.stateProjection.status, 'current', 'the asset comparison with the state mirror ran on pool objects');
  assert.deepEqual(organisation.capabilities.map((capability) => capability.id).sort(), ['platform-app', 'worker-api']);
  assert.deepEqual(organisation, await readOrganisation(org.platform, { refresh: true, cacheRoot }),
    'the pool and the clone read the same organisation');

  const { result: catalog, verbs } = await pooled(() => workspaceRemoteCapabilities(org.platform, {
    cacheRoot, env: { ...process.env, SINGULARITY_FLOW_CONFIGURATION_OBJECT_STORE: 'on' }
  }));
  assert.equal(count(verbs, 'clone'), 0, 'a lead\'s catalog is read in place, not cloned');
  assert.deepEqual(catalog.deliveries.map((delivery) => [delivery.id, delivery.url]).sort(),
    [['platform-app', org.platform], ['worker-api', org.worker]]);
  assert.deepEqual(catalog, await workspaceRemoteCapabilities(org.platform, { cacheRoot }),
    'the pool and the clone read the same catalog');
});

test('a capability edit still refuses an unknown capability and a map with nothing to edit', async (t) => {
  const org = await remotes(t, 'platform');
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', kind: 'collection' }));
  const before = run('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: org.platform }).stdout;
  await assert.rejects(editCapabilityInOrganisation(org.platform, 'missing', { name: 'Missing' }),
    /Unknown capability 'missing'/);
  await assert.rejects(editCapabilityInOrganisation(org.platform, 'foundation', { name: 'Foundation' }, { mode: 'add' }),
    /already exists/);
  assert.equal(run('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: org.platform }).stdout, before,
    'a refused edit publishes nothing');
});

// C4/E9 (sweep 2026-10-31): a value conflict routed to `capability proposal`, which offered only
// rebase-proposal; rebase was refused and routed back. As a person runs it: the refusal, the view
// and the rebase refusal of a conflicting map all name the discard at the exact commit, then the
// change made again; rebase is never offered for a value conflict.
test('a conflicting capability proposal names its discard and fresh change on every surface, never a rebase loop', posixOnly, async (t) => {
  const org = await remotes(t, 'platform');
  const { spawnSync } = await import('node:child_process');
  const cli = path.resolve('bin/singularity-flow.mjs');
  const flow = (...args) => spawnSync(process.execPath, [cli, ...args, '--lead', org.platform], {
    cwd: org.base, env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 120_000 });
  await mergeProposal(org.platform, await mapCapability(org.platform, { capabilityId: 'foundation', name: 'Foundation', kind: 'collection' }));
  const edited = await editCapabilityInOrganisation(org.platform, 'foundation', { name: 'Foundation platform' });
  // Another clone maps `ledger` while this one maps it differently, and that one is approved first.
  const ours = await mapCapability(org.platform, { capabilityId: 'ledger', name: 'Ledger', kind: 'collection' });
  await changeAuthority(org.platform, async (checkout) => {
    const file = path.join(checkout, 'singularity/capabilities.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.setIn(['capabilities', 'foundation', 'name'], 'Foundation core');
    document.setIn(['capabilities', 'ledger'], document.createNode({ name: 'General ledger', kind: 'collection' }));
    await writeFile(file, document.toString(), 'utf8');
  });

  const activate = flow('capability', 'activate', edited.branch, '--confirm', edited.commit);
  assert.equal(activate.status, 1, activate.stdout);
  assert.match(activate.stderr, /CAPABILITY_PROPOSAL_VALUE_CONFLICT|changed differently/);
  const discard = `singularity-flow capability discard-proposal ${edited.branch} --lead`;
  assert.ok(activate.stderr.includes(discard) && activate.stderr.includes(`--confirm ${edited.commit} --reason <REASON>`), activate.stderr);
  assert.match(activate.stderr, /singularity-flow capability edit foundation --lead \S+ --mode set <CHANGED-OPTIONS> --json/);
  assert.doesNotMatch(activate.stderr, /rebase-proposal/);

  const view = flow('capability', 'proposal', edited.branch);
  assert.equal(view.status, 0, view.stderr);
  assert.match(view.stdout, /status: conflicting — discard, then map again/);
  assert.match(view.stdout, /changed differently: singularity\/capabilities\.yml \/capabilities\/foundation\/name/);
  assert.ok(view.stdout.includes(discard), view.stdout);
  assert.doesNotMatch(view.stdout, /rebase-proposal/);
  const listed = flow('capability', 'proposals');
  assert.doesNotMatch(listed.stdout, /rebase-proposal|rebase or discard/);

  // A typed map whose capability the authority now holds differently: its rebase is refused for the
  // record, and that refusal names the same discard and `capability map` again, not the view alone.
  const rebase = flow('capability', 'rebase-proposal', ours.branch);
  assert.equal(rebase.status, 1, rebase.stdout);
  assert.match(rebase.stderr, /differing record for ledger/);
  assert.ok(rebase.stderr.includes(`singularity-flow capability discard-proposal ${ours.branch} --lead`), rebase.stderr);
  assert.match(rebase.stderr, /singularity-flow capability map ledger --lead \S+ --kind <KIND> --json/);

  // The named discard works at that exact commit, and nothing approved changed.
  const discarded = flow('capability', 'discard-proposal', edited.branch, '--confirm', edited.commit, '--reason', 'The approved name moved on', '--json');
  assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
  assert.equal(approved(org.platform).capabilities.foundation.name, 'Foundation core');
});
