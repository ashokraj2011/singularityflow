/**
 * Mapping an organisation, and building a workspace out of it.
 *
 * The two halves of the same model. A capability is mapped to a Git repository without anything
 * being checked out; a workspace is a set of those capabilities plus a local directory, and the
 * repositories it clones are what those capabilities ship from rather than a second list.
 *
 * These run against real repositories rather than stubs. Every claim here — the map reached the
 * remote, nothing was left on disk, the orphan branch exists — is only true of Git, so a fake would
 * be testing the fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { removeTemporaryTree, run } from '../src/util.mjs';
import { outsideBuilderScratch } from '../src/worldmodel.mjs';
import {
  activateCapabilityProposal, addCapabilityRepository, capabilityFsck, capabilityProposalCommands, discardStaleCapabilityProposal,
  editCapabilityInOrganisation, initializeWorkspaceState,
  inspectCapabilityProposal, inspectCapabilityRepository, listCapabilityProposals, mapCapability, readOrganisation,
  organisationCacheFile, proposeProgressiveCapabilityChange, publishOrganisationCapabilityMap, resolveWorkspacePlan
} from '../src/organisation.mjs';
import { listTransportIntents, retryTransportIntent } from '../src/transport-intents.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { readConfigurationSource } from '../src/configuration-branch.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';

/** Bare repositories with one commit each, standing in for an organisation's remotes. */
async function remotes(...names) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-org-'));
  const made = {};
  for (const name of names) {
    const bare = path.join(base, `${name}.git`);
    // -b main so the bare repo's HEAD names the branch that is actually pushed to it.
    run('git', ['init', '-q', '-b', 'main', '--bare', bare], { cwd: base });
    const seed = path.join(base, `${name}-seed`);
    run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
    run('git', ['config', 'user.email', 'a@b.com'], { cwd: seed });
    run('git', ['config', 'user.name', 'A B'], { cwd: seed });
    await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
    run('git', ['add', '-A'], { cwd: seed });
    run('git', ['commit', '-qm', 'Initial'], { cwd: seed });
    run('git', ['push', '-q', bare, 'main:main'], { cwd: seed });
    made[name] = bare;
  }
  return { base, ...made };
}

const registry = (base) => path.join(base, 'leads.json');

/** Simulate the repository's normal review merge without giving production code a bypass. */
async function mergeProposal(remote, proposal) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-'));
  try {
    run('git', ['clone', '-q', remote, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    run('git', ['fetch', '-q', 'origin', proposal.branch], { cwd: checkout });
    run('git', ['switch', '-q', proposal.baseBranch], { cwd: checkout });
    run('git', ['merge', '--ff-only', `origin/${proposal.branch}`], { cwd: checkout });
    run('git', ['push', '-q', 'origin', `HEAD:${proposal.baseBranch}`], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

async function mapAndMerge(remote, options) {
  const proposal = await mapCapability(remote, options);
  await mergeProposal(remote, proposal);
  return proposal;
}

async function startPinnedCapabilityStory(org, workId) {
  const workspacePath = path.join(org.base, `workspace-${workId.toLowerCase()}`);
  const checkout = path.join(workspacePath, 'repos', 'platform');
  await mkdir(path.dirname(checkout), { recursive: true });
  run('git', ['clone', '-q', '--branch', 'main', org.platform, checkout], { cwd: org.base });
  run('git', ['config', 'user.email', 'story@example.com'], { cwd: checkout });
  run('git', ['config', 'user.name', 'Story Author'], { cwd: checkout });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const env = {
    ...process.env,
    NO_COLOR: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Story Author',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(org.base, `${workId}-active-workspace.json`),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(org.base, `${workId}-workspaces.json`),
    SINGULARITY_FLOW_LEAD_REGISTRY: registry(org.base)
  };
  const output = execFileSync(process.execPath, [
    cli, 'start', workId, '--json', '--from-branch', 'main', '--work-type', 'quick-fix',
    '--capability', 'piassistnat', '--title', 'Exercise pinned capability provenance',
    '--description', 'Keep the exact approved capability authority bound to this Story.'
  ], { cwd: checkout, encoding: 'utf8', env });
  JSON.parse(output);
  return {
    checkout,
    workspace: {
      id: `workspace-${workId.toLowerCase()}`,
      name: `Workspace ${workId}`,
      path: workspacePath,
      leadRepository: 'platform',
      capabilityAuthority: { url: org.platform },
      capabilities: ['piassistnat'],
      repositories: {
        platform: {
          id: 'platform', url: org.platform, path: 'repos/platform', capabilities: ['piassistnat']
        }
      }
    },
    workflowFile: path.join(checkout, 'singularity/work-items', workId, 'workflow.json')
  };
}

function proposalRefs(remote) {
  return run('git', [
    'for-each-ref', '--format=%(refname) %(objectname)',
    'refs/heads/sflow/config-change/capability'
  ], { cwd: remote }).stdout.trim().split('\n').filter(Boolean);
}

/**
 * What the approved portfolio declares for one repository.
 *
 * Parsed rather than matched against the file's text. The starter portfolio is mostly commentary,
 * and its commented examples contain `defaultBranch:` lines of their own — a regex over the whole
 * file reads those as configuration, which is a test that can fail on a comment and pass on a real
 * defect.
 */
function declaredDefaultBranch(remote, repositoryId) {
  return YAML.parse(run('git', ['show', 'sflow/config:singularity/portfolio.yml'], {
    cwd: remote
  }).stdout)?.repositories?.[repositoryId]?.defaultBranch;
}

/** Rewrite the approved portfolio the way a version with the base-branch defect left it. */
async function recordDefaultBranchAs(remote, repositoryId, branch) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-affected-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', remote, checkout]);
    run('git', ['config', 'user.email', 'a@b.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'A B'], { cwd: checkout });
    const file = path.join(checkout, 'singularity/portfolio.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.setIn(['repositories', repositoryId, 'defaultBranch'], branch);
    await writeFile(file, document.toString());
    run('git', ['commit', '-qam', 'as an affected version left it'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

async function recordNativeAgentDisplayName(remote, agentId, displayName) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-display-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', remote, checkout]);
    run('git', ['config', 'user.email', 'a@b.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'A B'], { cwd: checkout });
    const file = path.join(checkout, '.github', 'agents', `${agentId}.agent.md`);
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace(/^name:\s*.*$/m, `name: ${displayName}`));
    run('git', ['add', '.github/agents'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Use native Copilot agent display name'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

test('the first progressive capability command materializes only a reviewed managed proposal', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  const proposal = await proposeProgressiveCapabilityChange(org.platform, {
    operation: 'add', capabilityId: 'payments', name: 'Payments',
    ownership: 'services/payments/**', teams: ['payments-team']
  });

  assert.equal(proposal.materialized, true);
  assert.equal(proposal.reviewRequired, true);
  assert.match(proposal.receipt.changeId, /^CAP-CHANGE-/);
  assert.equal(run('git', ['cat-file', '-e', 'sflow/config:singularity/capabilities.yml'], {
    cwd: org.platform, allowFailure: true
  }).status, 128, 'the approved configuration remains unchanged before review');

  const map = YAML.parse(run('git', [
    'show', `${proposal.commit}:singularity/capabilities.yml`
  ], { cwd: org.platform }).stdout);
  assert.equal(map.version, 2);
  assert.equal(map.management.mode, 'sflow-cli');
  assert.equal(map.capabilities['repository-root'].repository, 'platform');
  assert.deepEqual(map.capabilities['repository-root'].sourceRoots, []);
  assert.deepEqual(map.capabilities.payments.sourceRoots, ['services/payments']);

  const receipt = JSON.parse(run('git', [
    'show', `${proposal.commit}:${proposal.receiptPath}`
  ], { cwd: org.platform }).stdout);
  assert.equal(receipt.operation, 'add');
  assert.equal(receipt.afterSha256, proposal.afterSha256);
  assert.equal(receipt.materialization.equivalent, true);
});

test('managed capability Auto policy changes remain receipt-backed proposals', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const first = await proposeProgressiveCapabilityChange(org.platform, {
    operation: 'add', capabilityId: 'payments', name: 'Payments',
    ownership: 'services/payments/**'
  });
  await mergeProposal(org.platform, first);

  const proposal = await proposeProgressiveCapabilityChange(org.platform, {
    operation: 'auto', capabilityId: 'payments',
    auto: {
      eligibility: 'bounded', forbiddenWhenProtectedScopePredicted: true,
      maximumTouchedPaths: 6, maximumConcurrentFlights: 1
    }
  });
  assert.equal(proposal.reviewRequired, true);
  assert.equal(proposal.capabilityId, 'payments');
  const approved = YAML.parse(run('git', [
    'show', 'sflow/config:singularity/capabilities.yml'
  ], { cwd: org.platform }).stdout);
  assert.equal(approved.capabilities.payments.policy.auto, undefined,
    'the approved authority is unchanged until review');
  const proposed = YAML.parse(run('git', [
    'show', `${proposal.commit}:singularity/capabilities.yml`
  ], { cwd: org.platform }).stdout);
  assert.deepEqual(proposed.capabilities.payments.policy.auto, {
    eligibility: 'bounded', forbiddenWhenProtectedScopePredicted: true,
    maximumTouchedPaths: 6, maximumConcurrentFlights: 1
  });
  const receipt = JSON.parse(run('git', [
    'show', `${proposal.commit}:${proposal.receiptPath}`
  ], { cwd: org.platform }).stdout);
  assert.equal(receipt.operation, 'auto');
  assert.deepEqual(receipt.parameters.auto, proposed.capabilities.payments.policy.auto);

  await mergeProposal(org.platform, proposal);
  const inherited = await proposeProgressiveCapabilityChange(org.platform, {
    operation: 'auto', capabilityId: 'payments', auto: null
  });
  const cleared = YAML.parse(run('git', [
    'show', `${inherited.commit}:singularity/capabilities.yml`
  ], { cwd: org.platform }).stdout);
  assert.equal(cleared.capabilities.payments.policy.auto, undefined);
  assert.equal(inherited.receipt.parameters.auto, null);
});

test('the branch a capability is mapped on is not recorded as the repository default branch', async () => {
  /**
   * `withLeadCheckout` borrows the lead on the configuration authority branch, so the base branch it
   * hands the mutate callback is always `sflow/config`. That value reached `describeRepository`'s
   * `defaultBranch` argument, which is a different question with the same shape: `defaultBranch` is
   * what workspace creation clones, what Story branches are cut from, and what drift observation
   * compares `origin/<branch>` against. All three would have been pointed at the configuration
   * branch, and the symptom appears far from the cause.
   *
   * Asserted on the merged configuration rather than on the proposal, because that is what every
   * later reader actually loads.
   */
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  await mapAndMerge(org.platform, { capabilityId: 'commerce', name: 'Commerce', kind: 'collection' });

  assert.equal(declaredDefaultBranch(org.platform, 'platform'), 'main',
    'the configuration authority branch is not the branch work is cut from');
});

test('a repository already recorded against the configuration branch is repaired, and a healthy one is left alone', async () => {
  /**
   * Two claims, because fixing the argument and reaching an affected repository are different
   * problems. `describeRepository` runs once — when the first capability governs the repository —
   * so correcting what is passed to it cannot reach a repository that was already mapped. Those
   * would keep the wrong branch forever, which is why repair is its own step.
   *
   * The second claim is what keeps that step honest: it must write nothing on a healthy portfolio,
   * or every proposal from here on carries a configuration line nobody asked for.
   */
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, { capabilityId: 'commerce', name: 'Commerce', kind: 'collection' });

  const healthy = await mapCapability(org.platform, {
    capabilityId: 'billing', name: 'Billing', kind: 'collection'
  });
  const inspected = await inspectCapabilityProposal(org.platform, healthy.branch);
  assert.deepEqual(inspected.changedFiles.map((file) => file.paths.join('')),
    ['singularity/capabilities.yml'],
    'mapping into a healthy repository proposes the map and nothing else');
  await mergeProposal(org.platform, healthy);

  await recordDefaultBranchAs(org.platform, 'platform', 'sflow/config');
  assert.equal(declaredDefaultBranch(org.platform, 'platform'), 'sflow/config',
    'the affected state this repairs is real before the repair runs');

  const repair = await mapAndMerge(org.platform, {
    capabilityId: 'payments', name: 'Payments', kind: 'collection'
  });
  assert.ok(repair.branch, 'the repair travels as a reviewable proposal, not a silent write');
  assert.equal(declaredDefaultBranch(org.platform, 'platform'), 'main');
});

test('the first capability governs the repository it is mapped into', async () => {
  // The product's one circular dependency: mapping a capability needed a map, and the only way to
  // get a map was to map a capability. Refusing here is what made starting impossible.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  const mapTimer = commandTimer('capability-map', { commandClass: 'mutation' });
  const first = await withCommandTiming(mapTimer, () => mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection',
    metadata: { applicationId: 'APP-1001', costCenter: 'CC-42' }
  }));
  const mapCounters = mapTimer.finish().counters;
  assert.equal(mapCounters['git.remote.total'], 5,
    'first map combines authority and HEAD observation instead of probing them separately');
  assert.equal(mapCounters['git.remote.command.ls-remote'], 1);
  assert.equal(mapCounters['git.remote.command.clone'], 2);
  assert.equal(mapCounters['git.remote.command.push'], 2);
  assert.equal(first.capabilityId, 'commerce');

  const untouched = run('git', ['show', 'main:README.md'], { cwd: org.platform }).stdout;
  assert.equal(untouched, '# platform\n', 'the default branch remains untouched before review');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/state'], {
    cwd: org.platform, allowFailure: true
  }).status, 1, 'unreviewed configuration is not copied to the state branch');
  assert.match(first.branch, /^sflow\/config-change\/capability\/map-commerce-[0-9a-f]{8}$/);
  assert.equal(first.baseBranch, 'sflow/config');
  assert.match(run('git', ['show', `${first.branch}:singularity/capabilities.yml`], {
    cwd: org.platform
  }).stdout, /commerce:/, 'the complete proposal is available for review');

  await mergeProposal(org.platform, first);

  const governed = run('git', ['show', 'sflow/config:singularity/workflow.yml'], { cwd: org.platform }).stdout;
  assert.match(governed, /branch: state/, 'the orphan branch is named for a workspace to create');
  const map = run('git', ['show', 'sflow/config:singularity/capabilities.yml'], { cwd: org.platform }).stdout;
  assert.match(map, /commerce:/);
  assert.match(map, /applicationId: APP-1001/);
  assert.match(map, /costCenter: CC-42/);
  // The placeholder `init` writes gives way to the capability actually being mapped rather than
  // remaining as an unrelated starter entry.
  assert.doesNotMatch(map, /placeholder|your-capability/i);

  // And the second one finds the map already there rather than governing again.
  await mapAndMerge(org.platform, {
    capabilityId: 'payments', name: 'Payments', kind: 'collection', parent: 'commerce'
  });
  const both = run('git', ['show', 'sflow/config:singularity/capabilities.yml'], { cwd: org.platform }).stdout;
  assert.match(both, /parent: commerce/);
});

test('mapping another capability preserves an existing reviewed sparse clone strategy', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.platform,
    clone: { mode: 'blobless-sparse', sparseCone: ['src', 'pom.xml'], fallback: 'refuse' }
  });
  const next = await mapCapability(org.platform, {
    capabilityId: 'reporting', kind: 'delivery', repositoryUrl: org.platform
  });
  const portfolio = YAML.parse(run('git', [
    'show', `${next.branch}:singularity/portfolio.yml`
  ], { cwd: org.platform }).stdout);
  assert.equal(portfolio.repositories.platform.clone.mode, 'blobless-sparse');
  assert.equal(portfolio.repositories.platform.clone.fallback, 'refuse');
  assert.ok(portfolio.repositories.platform.clone.sparseCone.includes('src'));
  assert.ok(portfolio.repositories.platform.clone.sparseCone.includes('pom.xml'));
});

test('a repository can be added to an existing delivery through one reviewed proposal', async () => {
  const org = await remotes('platform', 'service');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.platform
  });
  const proposed = await addCapabilityRepository(org.platform, 'calculator', org.service, {
    clone: { mode: 'blobless-sparse', sparseCone: ['service'], fallback: 'refuse' }
  });
  const capability = YAML.parse(run('git', [
    'show', `${proposed.branch}:singularity/capabilities.yml`
  ], { cwd: org.platform }).stdout).capabilities.calculator;
  assert.deepEqual(capability.repositories, ['platform', 'service']);
  assert.equal(capability.leadRepository, 'platform');
  const repository = YAML.parse(run('git', [
    'show', `${proposed.branch}:singularity/portfolio.yml`
  ], { cwd: org.platform }).stdout).repositories.service;
  assert.equal(repository.url, org.service);
  assert.equal(repository.clone.mode, 'blobless-sparse');
});

test('mapping several delivery repositories observes every distinct remote exactly once', async () => {
  const org = await remotes('platform', 'service', 'web');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const timer = commandTimer('capability-map-many', { commandClass: 'mutation' });

  const proposed = await withCommandTiming(timer, () => mapCapability(org.platform, {
    capabilityId: 'calculator', kind: 'delivery',
    repositoryUrls: [org.service, org.web, org.service],
    leadRepositoryUrl: org.service
  }));

  assert.deepEqual(proposed.repositoryIds.sort(), ['service', 'web']);
  const counters = timer.finish().counters;
  assert.equal(counters['git.remote.command.ls-remote'], 3,
    'the lead, service, and web remotes each have one combined operation-scoped observation');
  assert.equal(counters['git.remote.total'], 7,
    'parallel validation does not add probes beyond configuration bootstrap and proposal publication');
});

test('repository inspection finds an exact URL in registered capability maps without mutation', async () => {
  const org = await remotes('platform', 'service', 'unmapped');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.service
  });
  await (await import('../src/lead-repositories.mjs')).rememberLeadRepository(org.platform);
  const refsBefore = proposalRefs(org.platform);

  const found = await inspectCapabilityRepository(org.service);
  assert.equal(found.status, 'already-mapped');
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].lead, org.platform);
  assert.equal(found.matches[0].repositoryId, 'service');
  assert.deepEqual(found.matches[0].capabilities, ['calculator']);
  assert.deepEqual(proposalRefs(org.platform), refsBefore, 'inspection created a proposal');
  assert.equal(found.authorityScope, 'registered');
  assert.equal(found.completeness, 'complete');
  assert.equal(found.proposalCoverage, 'complete');
  assert.deepEqual(found.proposalInspection, { total: 1, inspected: 1, limitPerAuthority: 64 });

  const missing = await inspectCapabilityRepository(org.unmapped, { leadUrl: org.platform });
  assert.equal(missing.status, 'not-onboarded');
  assert.deepEqual(missing.matches, []);

  const unreachable = await inspectCapabilityRepository(`${org.unmapped}.offline`, {
    leadUrl: org.platform
  });
  assert.equal(unreachable.status, 'inconclusive');
  assert.equal(unreachable.completeness, 'partial');
  assert.equal(unreachable.failures.length, 1);
  assert.equal(unreachable.failures[0].classification, 'remote-not-found');
  assert.equal(unreachable.failures[0].retryable, false);
  assert.match(unreachable.failures[0].evidence.diagnosticSha256, /^[a-f0-9]{64}$/);
  assert.match(unreachable.failures[0].diagnosticAction.command,
    /workspace doctor --network --repository/);

  await assert.rejects(readOrganisation(`${org.unmapped}.authority-offline`, { refresh: true }),
    (error) => {
      assert.equal(error.code, 'CAPABILITY_AUTHORITY_UNAVAILABLE');
      assert.equal(error.details.remoteFailure.classification, 'remote-not-found');
      assert.equal(error.details.remoteFailure.retryable, false);
      assert.match(error.details.remoteFailure.evidence.diagnosticSha256, /^[a-f0-9]{64}$/);
      assert.match(error.details.diagnosticAction.command,
        /workspace doctor --network --repository/);
      assert.doesNotMatch(JSON.stringify(error.details), /stderr|does not appear to be/);
      return true;
  });
});

test('suggested Git diagnostic commands use portable placeholders for unsafe remote operands', async () => {
  const remote = path.join(os.tmpdir(), 'missing-$(printf injected)-`printf tick`-& whoami.git');
  let command = null;
  await assert.rejects(readOrganisation(remote, { refresh: true }), (error) => {
    command = error.details.diagnosticAction.command;
    assert.match(command, /--repository\s+LEAD_URL/);
    assert.doesNotMatch(command, /printf|injected|tick|whoami|[`$()&]/);
    return true;
  });

  const parsed = spawnSync('sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], {
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stderr, '');
  assert.ok(parsed.stdout.split('\n').includes('LEAD_URL'), parsed.stdout);
});

test('the machine lead registry never returns or newly stores credential-bearing remotes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-safe-leads-'));
  const file = registry(root);
  const secret = 'legacy-registry-secret';
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    leads: [
      { url: 'https://git.example/safe.git', usedAt: '2026-01-01T00:00:00.000Z' },
      { url: `https://alice:${secret}@git.example/unsafe.git`, usedAt: '2026-01-01T00:00:00.000Z' }
    ]
  })}\n`);
  const {
    listLeadRepositories: listSafeLeads,
    listLeadRepositoryRegistryRecords,
    rememberLeadRepository
  } = await import('../src/lead-repositories.mjs');
  assert.deepEqual((await listSafeLeads(file)).map((lead) => lead.url),
    ['https://git.example/safe.git']);
  assert.equal((await listLeadRepositoryRegistryRecords(file)).length, 2,
    'the corrupt entry remains available to bounded integrity diagnosis');
  await assert.rejects(rememberLeadRepository(
    `https://bob:${secret}@git.example/new.git`, file
  ), (error) => error.code === 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
  assert.doesNotMatch(JSON.stringify(await listSafeLeads(file)), new RegExp(secret));
});

test('capability review commands use placeholders for shell-special lead paths', () => {
  const commands = capabilityProposalCommands(
    '/tmp/lead;echo-owned',
    'sflow/config-change/capability/map-safe',
    'a'.repeat(40)
  );
  assert.match(commands.review, /--lead LEAD_URL/);
  assert.match(commands.activate, /--lead LEAD_URL/);
  assert.doesNotMatch(JSON.stringify(commands), /echo-owned|[;&`$()]/);

  const powershellSplat = capabilityProposalCommands(
    '@args',
    'sflow/config-change/capability/map-safe',
    'a'.repeat(40)
  );
  assert.match(powershellSplat.review, /--lead LEAD_URL/);
  assert.match(powershellSplat.activate, /--lead LEAD_URL/);
  assert.doesNotMatch(JSON.stringify(powershellSplat), /@args/);
});

test('repository inspection blocks duplicate onboarding while an exact mapping awaits review', async () => {
  const org = await remotes('platform', 'service');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.service
  });
  await (await import('../src/lead-repositories.mjs')).rememberLeadRepository(org.platform);
  const refsBefore = proposalRefs(org.platform);

  const result = await inspectCapabilityRepository(org.service, { refresh: true });
  assert.equal(result.status, 'inconclusive', 'an unapproved proposal is not reported as approved');
  assert.deepEqual(result.matches, []);
  assert.equal(result.proposalCoverage, 'complete');
  assert.deepEqual(result.proposalInspection, { total: 1, inspected: 1, limitPerAuthority: 64 });
  assert.equal(result.pendingMatches.length, 1);
  assert.deepEqual(result.pendingMatches[0], {
    lead: org.platform,
    repositoryId: 'service',
    repositoryUrl: org.service,
    capabilities: ['calculator'],
    capabilityMetadataComplete: true,
    proposalBranch: proposed.branch,
    proposalCommit: proposed.commit,
    proposalStatus: 'pending-review',
    proposalValid: true
  });
  assert.deepEqual(proposalRefs(org.platform), refsBefore,
    'pending-proposal inspection moved or created a governance ref');

  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const displayed = execFileSync(process.execPath, [
    cli, 'capability', 'inspect-repository', org.service, '--lead', org.platform
  ], {
    cwd: org.base,
    env: { ...process.env, SINGULARITY_FLOW_LEAD_REGISTRY: registry(org.base), NO_COLOR: '1' },
    encoding: 'utf8'
  });
  assert.match(displayed, /inconclusive/);
  assert.match(displayed, /awaiting review/);
  assert.match(displayed, new RegExp(proposed.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a pending assignment takes precedence over an approved unassigned repository', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, { capabilityId: 'portfolio', kind: 'collection' });
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'platform-runtime', kind: 'delivery', repositoryUrl: org.platform
  });

  const result = await inspectCapabilityRepository(org.platform, {
    leadUrl: org.platform, refresh: true
  });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].capabilities, []);
  assert.equal(result.pendingMatches[0].proposalBranch, proposed.branch);
  assert.equal(result.status, 'inconclusive',
    'the approved unassigned entry cannot hide its pending assignment');
});

test('an unrelated proposal does not claim every repository inherited from its base', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'platform-runtime', kind: 'delivery', repositoryUrl: org.platform
  });
  await mapCapability(org.platform, { capabilityId: 'documentation', kind: 'collection' });

  const result = await inspectCapabilityRepository(org.platform, {
    leadUrl: org.platform, refresh: true
  });
  assert.equal(result.status, 'already-mapped');
  assert.deepEqual(result.matches[0].capabilities, ['platform-runtime']);
  assert.deepEqual(result.pendingMatches, [],
    'unchanged repository bytes inherited by another proposal are not a pending repository claim');
});

test('a proposal that removes a repository does not remain a pending claim on its old URL', async () => {
  const org = await remotes('platform', 'service');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.service
  });

  const authoring = path.join(org.base, 'remove-service-proposal');
  run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, authoring]);
  run('git', ['config', 'user.email', 'proposal@example.com'], { cwd: authoring });
  run('git', ['config', 'user.name', 'Proposal Author'], { cwd: authoring });
  const branch = 'sflow/config-change/capability/remove-calculator-repository';
  run('git', ['switch', '-q', '-c', branch], { cwd: authoring });
  const capabilitiesFile = path.join(authoring, 'singularity/capabilities.yml');
  const capabilities = YAML.parse(await readFile(capabilitiesFile, 'utf8'));
  delete capabilities.capabilities.calculator;
  await writeFile(capabilitiesFile, YAML.stringify(capabilities));
  const portfolioFile = path.join(authoring, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  delete portfolio.repositories.service;
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '-A'], { cwd: authoring });
  run('git', ['commit', '-qm', 'Remove calculator repository'], { cwd: authoring });
  run('git', ['push', '-q', 'origin', `HEAD:${branch}`], { cwd: authoring });

  const result = await inspectCapabilityRepository(org.service, {
    leadUrl: org.platform, refresh: true
  });
  assert.equal(result.status, 'already-mapped');
  assert.deepEqual(result.matches[0].capabilities, ['calculator']);
  assert.deepEqual(result.pendingMatches, [],
    'the proposal no longer claims the URL just because its base did');
});

test('a merged mapping does not remain pending after configuration is re-rooted to identical content', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapAndMerge(org.platform, {
    capabilityId: 'platform-runtime', kind: 'delivery', repositoryUrl: org.platform
  });
  const mergedConfiguration = run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim();
  const tree = run('git', ['rev-parse', 'sflow/config^{tree}'], {
    cwd: org.platform
  }).stdout.trim();
  const fixtureIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Configuration Recovery', GIT_AUTHOR_EMAIL: 'recovery@example.invalid',
    GIT_COMMITTER_NAME: 'Configuration Recovery', GIT_COMMITTER_EMAIL: 'recovery@example.invalid'
  };
  const replacement = run('git', [
    'commit-tree', tree, '-m', 'Re-root approved configuration without changing its content'
  ], { cwd: org.platform, env: fixtureIdentity }).stdout.trim();
  run('git', ['update-ref', 'refs/heads/sflow/config', replacement, mergedConfiguration], {
    cwd: org.platform
  });

  const catalog = await listCapabilityProposals(org.platform, {
    includeDiff: false, repositoryUrl: org.platform
  });
  const historical = catalog.find((entry) => entry.branch === proposed.branch);
  assert.ok(historical, 'the history-invalid proposal remains visible for exact-SHA cleanup');
  assert.equal(historical.status, 'unreadable');
  assert.equal(historical.failure.code, 'CAPABILITY_PROPOSAL_HISTORY_INVALID');
  assert.equal(historical.repositoryInspectionComplete, true);
  assert.deepEqual(historical.repositoryMatches, [],
    'content already approved under a replacement root is not a pending claim');

  const result = await inspectCapabilityRepository(org.platform, {
    leadUrl: org.platform, refresh: true
  });
  assert.equal(result.status, 'already-mapped');
  assert.deepEqual(result.matches[0].capabilities, ['platform-runtime']);
  assert.deepEqual(result.pendingMatches, []);
  assert.equal(result.proposalCoverage, 'complete');
});

test('an unreadable proposal without a provable base does not claim repositories from its tip', async () => {
  const org = await remotes('platform', 'service');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.service
  });
  const tree = run('git', ['rev-parse', `${proposed.commit}^{tree}`], {
    cwd: org.platform
  }).stdout.trim();
  const fixtureIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Unrelated Proposal', GIT_AUTHOR_EMAIL: 'proposal@example.invalid',
    GIT_COMMITTER_NAME: 'Unrelated Proposal', GIT_COMMITTER_EMAIL: 'proposal@example.invalid'
  };
  const unrelatedTip = run('git', [
    'commit-tree', tree, '-m', 'Re-root proposal without its reviewed base'
  ], { cwd: org.platform, env: fixtureIdentity }).stdout.trim();
  run('git', ['update-ref', `refs/heads/${proposed.branch}`, unrelatedTip, proposed.commit], {
    cwd: org.platform
  });

  const catalog = await listCapabilityProposals(org.platform, {
    includeDiff: false, repositoryUrl: org.service
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].status, 'unreadable');
  assert.equal(catalog[0].repositoryInspectionComplete, false);
  assert.deepEqual(catalog[0].repositoryMatches, [],
    'a tip snapshot cannot stand in for a missing base-vs-tip delta');

  const result = await inspectCapabilityRepository(org.service, {
    leadUrl: org.platform, refresh: true
  });
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.pendingMatches, [],
    'unrelated proposal history must not block onboarding with an unproven pending claim');
  assert.equal(result.proposalCoverage, 'partial');
  assert.equal(result.status, 'inconclusive');
});

test('bounded proposal lookup marks truncated coverage incomplete', async () => {
  const org = await remotes('platform', 'first-service', 'second-service');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapCapability(org.platform, {
    capabilityId: 'alpha', kind: 'delivery', repositoryUrl: org['first-service']
  });
  await mapCapability(org.platform, {
    capabilityId: 'beta', kind: 'delivery', repositoryUrl: org['second-service']
  });

  const result = await listCapabilityProposals(org.platform, {
    includeDiff: false,
    repositoryUrl: org['first-service'],
    maximumProposals: 1,
    withCoverage: true
  });
  assert.deepEqual(result.coverage, { status: 'partial', total: 2, inspected: 1, limit: 1 });
  assert.equal(result.proposals.length, 1);
});

test('repository inspection never returns a rejected registered lead URL', async () => {
  const org = await remotes('platform', 'unmapped');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'platform', kind: 'delivery', repositoryUrl: org.platform
  });
  const { rememberLeadRepository } = await import('../src/lead-repositories.mjs');
  await rememberLeadRepository(org.platform);
  const rejected = 'https://alice:super-secret@example.test/private.git';
  // Simulate a registry written by an older release. New writes reject this value at the boundary,
  // but inspection still has to diagnose a pre-existing corrupt entry without reflecting it.
  const registryPath = registry(org.base);
  const legacy = JSON.parse(await readFile(registryPath, 'utf8'));
  legacy.leads.push({ url: rejected, usedAt: new Date(0).toISOString() });
  await writeFile(registryPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const result = await inspectCapabilityRepository(org.unmapped, { refresh: true });
  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'inconclusive');
  assert.notEqual(result.completeness, 'no-authorities',
    'a rejected registry entry is unresolved authority, not proof that no authority exists');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].lead, /^registered-lead:sha256:[0-9a-f]{16}$/);
  assert.equal(result.failures[0].code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
  assert.doesNotMatch(serialized, /alice|super-secret|private\.git/);
});

test('repository inspection without known authorities is explicitly inconclusive', async () => {
  const org = await remotes('candidate');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const result = await inspectCapabilityRepository(org.candidate);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.completeness, 'no-authorities');
  assert.equal(result.authorityScope, 'repository-candidate');
  assert.deepEqual(result.checkedLeads, []);
  assert.deepEqual(result.candidateLeads, [org.candidate]);
});

test('repository inspection discovers a self-hosted approved map on a new laptop', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'platform-runtime', kind: 'delivery', repositoryUrl: org.platform
  });

  const result = await inspectCapabilityRepository(org.platform, { refresh: true });
  assert.equal(result.status, 'already-mapped');
  assert.equal(result.authorityScope, 'repository-candidate');
  assert.deepEqual(result.checkedLeads, [org.platform]);
  assert.deepEqual(result.matches[0].capabilities, ['platform-runtime']);
});

test('repository inspection reports ambiguity across registered organisations', async () => {
  const first = await remotes('first-lead', 'shared');
  const second = await remotes('second-lead');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(first.base);
  await mapAndMerge(first['first-lead'], {
    capabilityId: 'first-capability', kind: 'delivery', repositoryUrl: first.shared
  });
  await mapAndMerge(second['second-lead'], {
    capabilityId: 'second-capability', kind: 'delivery', repositoryUrl: first.shared
  });
  const { rememberLeadRepository } = await import('../src/lead-repositories.mjs');
  await rememberLeadRepository(first['first-lead']);
  await rememberLeadRepository(second['second-lead']);

  const result = await inspectCapabilityRepository(first.shared);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches.flatMap((match) => match.capabilities).sort(),
    ['first-capability', 'second-capability']);
});

test('repository inspection never treats stale cached absence as proof that a repository is new', async () => {
  const org = await remotes('platform', 'service', 'unmapped');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.service
  });
  const { rememberLeadRepository } = await import('../src/lead-repositories.mjs');
  await rememberLeadRepository(org.platform);
  await readOrganisation(org.platform, { refresh: true });

  const unavailable = `${org.platform}.offline`;
  await rm(unavailable, { recursive: true, force: true });
  await rename(org.platform, unavailable);

  const known = await inspectCapabilityRepository(org.service, { refresh: true });
  assert.equal(known.status, 'already-mapped', 'a cached positive match stays conservative');
  assert.equal(known.matches[0].stale, true);
  assert.equal(known.completeness, 'none');
  assert.deepEqual(known.staleLeads, [org.platform]);

  const absent = await inspectCapabilityRepository(org.unmapped, { refresh: true });
  assert.equal(absent.status, 'inconclusive', 'cached absence cannot authorize a new mapping');
  assert.equal(absent.completeness, 'none');
  assert.equal(absent.failures[0].code, 'CAPABILITY_AUTHORITY_STALE_CACHE');
});

test('mapping refuses repository identifier collisions without publishing a proposal', async () => {
  const organisation = await remotes('platform', 'service');
  const other = await remotes('service');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(organisation.base);
  await mapAndMerge(organisation.platform, {
    capabilityId: 'original', kind: 'delivery', repositoryUrl: organisation.service
  });
  const before = proposalRefs(organisation.platform);

  await assert.rejects(addCapabilityRepository(
    organisation.platform, 'original', other.service
  ), (error) => {
    assert.equal(error.code, 'CAPABILITY_REPOSITORY_ID_COLLISION');
    return true;
  });
  assert.deepEqual(proposalRefs(organisation.platform), before);

  await assert.rejects(mapCapability(organisation.platform, {
    capabilityId: 'replacement', kind: 'delivery', repositoryUrl: other.service
  }), (error) => {
    assert.equal(error.code, 'CAPABILITY_REPOSITORY_ID_COLLISION');
    assert.equal(error.details.state, 'repository-id-collision');
    return true;
  });
  assert.deepEqual(proposalRefs(organisation.platform), before);
  assert.equal((await readOrganisation(organisation.platform, { refresh: true }))
    .repositories.service.url, organisation.service);
});

test('capability inspect-repository CLI emits the read-only discovery result', async () => {
  const org = await remotes('platform', 'service', 'other-lead');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', kind: 'delivery', repositoryUrl: org.service
  });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'capability', 'inspect-repository', org.service,
    '--lead', org['other-lead'], '--lead', org.platform, '--json'], {
    cwd: org.base,
    env: { ...process.env, SINGULARITY_FLOW_LEAD_REGISTRY: registry(org.base), NO_COLOR: '1' },
    encoding: 'utf8'
  });
  const result = JSON.parse(output);
  assert.equal(result.status, 'already-mapped');
  assert.deepEqual(result.checkedLeads, [org['other-lead'], org.platform]);
  assert.deepEqual(result.matches[0].capabilities, ['calculator']);

  const partial = spawnSync(process.execPath, [
    cli, 'capability', 'inspect-repository', org.service,
    '--lead', org.platform, '--lead', `${org['other-lead']}.offline`
  ], {
    cwd: org.base,
    env: { ...process.env, SINGULARITY_FLOW_LEAD_REGISTRY: registry(org.base), NO_COLOR: '1' },
    encoding: 'utf8'
  });
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /already-mapped/);
  assert.match(partial.stderr, /pending proposal coverage: partial/);
  assert.match(partial.stderr, /no new mapping is authorized/);
  assert.match(partial.stderr, /Diagnose: singularity-flow workspace doctor --network --repository/);
});

test('capability proposal transport failures emit structured JSON diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-proposal-cli-failure-'));
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const unavailable = path.join(root, 'missing-authority.git');
  const result = spawnSync(process.execPath, [
    cli, 'capability', 'proposals', '--lead', unavailable, '--json'
  ], {
    cwd: root,
    env: { ...process.env, SINGULARITY_FLOW_LEAD_REGISTRY: registry(root), NO_COLOR: '1' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error.code, 'REMOTE_REMOTE_NOT_FOUND');
  assert.match(failure.error.diagnosticAction.command,
    /workspace doctor --network --repository/);

  const human = spawnSync(process.execPath, [
    cli, 'capability', 'proposals', '--lead', unavailable, '--json=false'
  ], {
    cwd: root,
    env: { ...process.env, SINGULARITY_FLOW_LEAD_REGISTRY: registry(root), NO_COLOR: '1' },
    encoding: 'utf8'
  });
  assert.match(human.stderr, /Singularity Flow error:/);
  assert.doesNotMatch(human.stderr, /^\s*\{/);

  const lastFlagWins = spawnSync(process.execPath, [
    cli, 'capability', 'proposals', '--lead', unavailable, '--json=false', '--json'
  ], {
    cwd: root,
    env: { ...process.env, SINGULARITY_FLOW_LEAD_REGISTRY: registry(root), NO_COLOR: '1' },
    encoding: 'utf8'
  });
  assert.equal(JSON.parse(lastFlagWins.stderr).error.code, 'REMOTE_REMOTE_NOT_FOUND');
});

test('an exact capability proposal can be reviewed, activated, and projected without touching main', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const mainBefore = run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim();
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'delivery',
    repositoryUrl: org.platform
  });

  const pending = await listCapabilityProposals(org.platform);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].branch, proposed.branch);
  assert.equal(pending[0].merged, false);
  assert.equal(pending[0].valid, true);
  assert.ok(pending[0].changedFiles.some((file) => file.paths.includes('singularity/capabilities.yml')));
  const summaryOnly = await listCapabilityProposals(org.platform, { includeDiff: false });
  assert.equal(summaryOnly[0].diff, null);
  assert.equal(summaryOnly[0].diffDeferred, true);

  const inspected = await inspectCapabilityProposal(org.platform, proposed.branch);
  assert.equal(inspected.proposalCommit, proposed.commit);
  assert.match(inspected.diff, /calculator/);
  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: inspected.proposalCommit.slice(0, 12) }),
    (error) => {
      assert.equal(error.code, 'CAPABILITY_PROPOSAL_CONFIRMATION_MISMATCH');
      assert.equal(error.details.proposalCommit, inspected.proposalCommit);
      assert.match(error.details.nextAction.command, new RegExp(inspected.proposalCommit));
      assert.deepEqual(error.details.preserved,
        ['proposal-branch', 'approved-configuration', 'application-branches']);
      return true;
    }
  );
  assert.equal(run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim(), mainBefore);

  const activationTimer = commandTimer('capability-activate', { commandClass: 'mutation' });
  const activated = await withCommandTiming(activationTimer, () => activateCapabilityProposal(
    org.platform, proposed.branch, {
      confirm: inspected.proposalCommit,
      acknowledgeUnprotected: true
    }
  ));
  const activationCounters = activationTimer.finish().counters;
  assert.equal(activationCounters['git.remote.command.clone'], 1,
    'activation projects from its validated checkout instead of cloning configuration twice');
  assert.equal(activationCounters['git.remote.command.fetch'], 3,
    'projection reuses its exact state fetch instead of immediately fetching the state ref again');
  assert.equal(activated.alreadyMerged, false);
  assert.equal(activated.targetBranch, 'sflow/config');
  assert.match(run('git', ['show', 'sflow/config:singularity/capabilities.yml'], {
    cwd: org.platform
  }).stdout, /calculator/);
  assert.equal(run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim(), mainBefore,
    'activating governed configuration never writes the application default branch');
  assert.equal(activated.projection.published, true);
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.audit.eventType, 'capability-configuration-activated');
  assert.equal(activated.protection.enforced, false);
  const activationEntryPath = run('git', [
    'ls-tree', '-r', '--name-only', 'state', 'ledger/entries/organisation'
  ], { cwd: org.platform }).stdout.trim().split('\n').find(Boolean);
  const activationEntry = JSON.parse(run('git', ['show', `state:${activationEntryPath}`], {
    cwd: org.platform
  }).stdout);
  assert.equal(activationEntry.eventType, 'capability-configuration-activated');
  assert.equal(activationEntry.payload.proposalCommit, proposed.commit);
  assert.equal(activationEntry.payload.targetCommit, activated.targetCommit);
  assert.ok(activationEntry.payload.changedFiles.some((file) =>
    file.paths.includes('singularity/capabilities.yml')));
  assert.ok('proposer' in activationEntry.payload);
  assert.ok('approver' in activationEntry.payload);
  assert.match(run('git', ['show', 'state:singularity/capabilities.yml'], {
    cwd: org.platform
  }).stdout, /calculator/);
  const mirror = JSON.parse(run('git', ['show', 'state:configuration/manifest.json'], {
    cwd: org.platform
  }).stdout);
  assert.equal(mirror.source.commit, activated.targetCommit);
  assert.ok(mirror.files['singularity/workflow.yml']);
  assert.ok(mirror.files['singularity/capabilities.yml']);
  assert.equal(mirror.assets['singularity/workflow.yml'].sha256,
    mirror.files['singularity/workflow.yml']);
  assert.match(mirror.assets['singularity/workflow.yml'].object, /^[0-9a-f]{40,64}$/);
  assert.match(mirror.assets['singularity/workflow.yml'].mode, /^100(?:644|755)$/);
  assert.deepEqual(Object.keys(mirror.files).sort(), run('git', [
    'ls-tree', '-r', '--name-only', 'state', '--', 'singularity', '.github/agents'
  ], { cwd: org.platform }).stdout.trim().split('\n').filter((file) =>
    !file.startsWith('singularity/work-items/') && !file.startsWith('singularity/world-model/')
      && !file.startsWith('singularity/ledger/')).sort());
  assert.deepEqual(await listCapabilityProposals(org.platform), []);
  const history = await listCapabilityProposals(org.platform, { includeMerged: true });
  assert.equal(history[0].merged, true);
  assert.match(history[0].diff, /calculator/, 'an activated proposal retains a reviewable exact diff');
});

test('capability review accepts configured templates but rejects generated world-model output', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, { capabilityId: 'commerce', name: 'Commerce', kind: 'collection' });
  const authoring = path.join(org.base, 'custom-root-proposal');
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, authoring]);
    run('git', ['config', 'user.email', 'custom-proposal@example.com'], { cwd: authoring });
    run('git', ['config', 'user.name', 'Custom Proposal'], { cwd: authoring });
    const base = run('git', ['rev-parse', 'HEAD'], { cwd: authoring }).stdout.trim();
    const branch = `sflow/config-change/capability/custom-governance-${base.slice(0, 8)}`;
    run('git', ['switch', '-q', '-c', branch], { cwd: authoring });
    const workflowFile = path.join(authoring, 'singularity/workflow.yml');
    const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
    workflow.templatesRoot = 'governance/templates';
    workflow.worldModel.outputDir = 'governance/world-model';
    await writeFile(workflowFile, YAML.stringify(workflow));
    const portfolioFile = path.join(authoring, 'singularity/portfolio.yml');
    const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
    portfolio.templatesRoot = 'governance/templates';
    await writeFile(portfolioFile, YAML.stringify(portfolio));
    await cp(path.join(authoring, 'singularity/templates'), path.join(authoring, 'governance/templates'), {
      recursive: true
    });
    await mkdir(path.join(authoring, 'governance/world-model'), { recursive: true });
    await writeFile(path.join(authoring, 'governance/world-model/manifest.json'), '{"reviewed":true}\n');
    await rm(path.join(authoring, 'singularity/templates'), { recursive: true });
    run('git', ['add', '-A'], { cwd: authoring });
    run('git', ['commit', '-qm', 'Review custom governance roots'], { cwd: authoring });
    run('git', ['push', '-q', 'origin', `HEAD:${branch}`], { cwd: authoring });

    const proposal = await inspectCapabilityProposal(org.platform, branch);
    assert.equal(proposal.valid, false);
    assert.ok(proposal.invalidFiles.includes('governance/world-model/manifest.json'));
    assert.ok(proposal.changedFiles.some((entry) =>
      entry.paths.includes('governance/templates/common/implementation.md')));
    assert.ok(proposal.changedFiles.some((entry) =>
      entry.paths.includes('governance/world-model/manifest.json')),
      'the generated file remains visible for review even though it cannot be approved as configuration');
  } finally {
    await rm(org.base, { recursive: true, force: true });
  }
});

test('capability activation accepts a native Copilot display name without changing governed identity', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await recordNativeAgentDisplayName(org.platform, 'poc-test-developer', 'Playwright Test Engineer');

  const proposed = await mapCapability(org.platform, {
    capabilityId: 'testing', name: 'Testing', kind: 'collection', parent: 'commerce'
  });
  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
  assert.match(run('git', [
    'show', 'sflow/config:.github/agents/poc-test-developer.agent.md'
  ], { cwd: org.platform }).stdout, /^name: Playwright Test Engineer$/m);
});

test('capability review and activation do not negotiate unrelated monorepo history', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  // Make the application ref incomplete after the proposal exists. `mktree --missing` expresses
  // that condition directly; deleting a presumed loose object was storage-layout dependent and
  // stopped working when newer Git versions packed the received blob automatically.
  const missingBlob = 'f'.repeat(40);
  const applicationTree = run('git', ['mktree', '--missing'], {
    cwd: org.platform,
    input: `100644 blob ${missingBlob}\tunrelated-application.bin\n`
  }).stdout.trim();
  const priorMain = run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim();
  const fixtureIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
  };
  const brokenMain = run('git', [
    'commit-tree', applicationTree, '-p', priorMain, '-m', 'reference unavailable application history'
  ], { cwd: org.platform, env: fixtureIdentity }).stdout.trim();
  run('git', ['update-ref', 'refs/heads/main', brokenMain, priorMain], { cwd: org.platform });
  assert.notEqual(run('git', ['cat-file', '-e', 'main:unrelated-application.bin'], {
    cwd: org.platform, allowFailure: true
  }).status, 0, 'the fixture application ref must be unreadable independently of object storage');

  const ordinaryClone = path.join(org.base, 'ordinary-full-clone');
  assert.notEqual(run('git', ['clone', '--quiet', '--no-local', org.platform, ordinaryClone], {
    cwd: org.base, allowFailure: true
  }).status, 0, 'an ordinary all-branch application clone is intentionally broken in this fixture');

  const inspected = await inspectCapabilityProposal(org.platform, proposed.branch);
  assert.equal(inspected.proposalCommit, proposed.commit,
    'review reads only the orphan configuration authority and exact proposal');
  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
});

test('capability activation records an identical concurrent authority update as external', {
  skip: process.platform === 'win32'
}, async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const targetBefore = run('git', ['--git-dir', org.platform, 'rev-parse', 'sflow/config']).stdout.trim();
  const realGit = run('which', ['git']).stdout.trim();
  const wrappers = path.join(org.base, 'git-race-wrapper');
  const wrapper = path.join(wrappers, 'git');
  const sentinel = path.join(org.base, 'configuration-race-fired');
  await mkdir(wrappers);
  await writeFile(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
if (args[0] === 'push' && args.includes('HEAD:refs/heads/sflow/config') && !fs.existsSync(${JSON.stringify(sentinel)})) {
  const resolved = spawnSync(realGit, ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' });
  if (resolved.status !== 0) process.exit(resolved.status || 1);
  const uploaded = spawnSync(realGit, [
    'push', ${JSON.stringify(org.platform)},
    resolved.stdout.trim() + ':refs/heads/sflow/test-race-object'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (uploaded.status !== 0) process.exit(uploaded.status || 1);
  const advanced = spawnSync(realGit, [
    '--git-dir', ${JSON.stringify(org.platform)}, 'update-ref', 'refs/heads/sflow/config',
    resolved.stdout.trim(), ${JSON.stringify(targetBefore)}
  ], { encoding: 'utf8' });
  if (advanced.status !== 0) process.exit(advanced.status || 1);
  fs.writeFileSync(${JSON.stringify(sentinel)}, 'advanced\\n');
}
const result = spawnSync(realGit, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
`);
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrappers}${path.delimiter}${previousPath}`;
  let activated;
  try {
    activated = await activateCapabilityProposal(org.platform, proposed.branch, {
      confirm: proposed.commit,
      acknowledgeUnprotected: true
    });
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(activated.status, 'activated', JSON.stringify(activated, null, 2));
  assert.equal(activated.alreadyMerged, true);
  assert.equal(activated.mergeEvidence, 'concurrent-identical-commit');
  assert.equal(activated.targetBefore, null,
    'the current reviewer must not be audited as owner of a transition performed externally');
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
});

test('protected activation returns a resumable review receipt and exact post-merge recovery', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const configBefore = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const hook = path.join(org.platform, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/sflow/config" ]; then
    echo "configuration review required" >&2
    exit 1
  fi
done
exit 0
`);
  await chmod(hook, 0o755);

  const waiting = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(waiting.status, 'review-required');
  assert.equal(waiting.activated, false);
  assert.equal(waiting.protection.enforced, true);
  assert.equal(waiting.targetCommit, configBefore);
  assert.equal(waiting.externalAction.sourceBranch, proposed.branch);
  assert.equal(waiting.externalAction.targetBranch, 'sflow/config');
  assert.match(waiting.nextAction.command, new RegExp(proposed.commit));
  assert.deepEqual(waiting.preserved,
    ['proposal-branch', 'approved-configuration', 'application-branches']);
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), configBefore);
  const pending = await listCapabilityProposals(org.platform);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].branch, proposed.branch);

  await rm(hook);
  await mergeProposal(org.platform, proposed);
  const recovered = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit
  });
  assert.equal(recovered.status, 'activated');
  assert.equal(recovered.activated, true);
  assert.equal(recovered.alreadyMerged, true);
  assert.equal(recovered.audit.recorded, true);
  assert.equal(recovered.projection.published, true);
});

test('a generic pre-receive hook refusal remains activation-pending with its safe diagnostic', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const configBefore = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const hook = path.join(org.platform, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
echo "secret scanning rejected a credential in the proposed content" >&2
exit 1
`);
  await chmod(hook, 0o755);

  const waiting = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(waiting.status, 'activation-pending');
  assert.equal(waiting.activated, false);
  assert.equal(waiting.protection.enforced, null);
  assert.equal(waiting.externalAction, null);
  assert.notEqual(waiting.failure.code, 'CAPABILITY_ACTIVATION_REVIEW_REQUIRED');
  assert.match(waiting.failure.diagnostic,
    /^Capability activation was refused \(exit 1; diagnostic sha256:[0-9a-f]{16}\)$/);
  assert.doesNotMatch(waiting.failure.diagnostic, /secret scanning|credential|pre-receive/i,
    'provider and hook output must not enter durable or returned diagnostics');
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), configBefore);
});

test('capability review cannot be redirected by ambient repository selectors', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'review-boundary', name: 'Review boundary', kind: 'collection'
  });
  const attacker = path.join(org.base, 'attacker-review-repository');
  run('git', ['init', '-q', '-b', 'attacker', attacker], { cwd: org.base });
  await writeFile(path.join(attacker, 'README.md'), 'unrelated repository\n');
  run('git', ['add', '-A'], { cwd: attacker });
  run('git', ['-c', 'user.email=attacker@example.test', '-c', 'user.name=Attacker',
    'commit', '-qm', 'Attacker review'], { cwd: attacker });

  const previous = new Map(['GIT_DIR', 'GIT_WORK_TREE']
    .map((key) => [key, process.env[key]]));
  process.env.GIT_DIR = path.join(attacker, '.git');
  process.env.GIT_WORK_TREE = attacker;
  let reviewed;
  try {
    reviewed = await inspectCapabilityProposal(org.platform, proposed.branch);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(reviewed.proposalCommit, proposed.commit);
  assert.equal(reviewed.status, 'pending-review');
});

test('a transient activation push failure is recoverable without pretending repository review is required', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const configBefore = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const hook = path.join(org.platform, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
echo "fatal: Could not resolve host: git.example.test" >&2
exit 1
`);
  await chmod(hook, 0o755);

  const waiting = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(waiting.status, 'activation-pending');
  assert.equal(waiting.activated, false);
  assert.equal(waiting.failure.classification, 'network-transient');
  assert.equal(waiting.externalAction, null);
  assert.match(waiting.nextAction.command, new RegExp(proposed.commit));
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), configBefore);
});

test('an unprotected configuration authority requires an explicit recorded acknowledgement', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const before = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();

  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: proposed.commit }),
    /cannot prove whether.*--acknowledge-unprotected/s
  );
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), before);
  assert.equal((await listCapabilityProposals(org.platform)).length, 1);
});

test('an advanced configuration still requires explicit direct-push acknowledgement', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const review = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-advance-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, review]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: review });
    run('git', ['config', 'user.name', 'Review User'], { cwd: review });
    run('git', ['commit', '--allow-empty', '-qm', 'Advance approved configuration'], { cwd: review });
    run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: review });
  } finally {
    await rm(review, { recursive: true, force: true });
  }
  const advanced = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();

  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: proposed.commit }),
    /cannot prove whether.*--acknowledge-unprotected/s
  );
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), advanced);
  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(activated.targetBefore, advanced);
  assert.equal(activated.protection.enforced, false);
});

test('an externally merged proposal can append its activation audit and projection', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  await mergeProposal(org.platform, proposed);

  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit
  });
  assert.equal(activated.alreadyMerged, true);
  assert.equal(activated.targetBefore, null);
  assert.equal(activated.protection.enforced, null);
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
  const event = JSON.parse(run('git', [
    'show', `state:ledger/events/${activated.audit.eventId}.json`
  ], { cwd: org.platform }).stdout);
  assert.equal(event.eventId, activated.audit.eventId);
});

test('activation recovers an exact merged proposal after the provider deletes its source branch', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-deleted-proposal-review-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    run('git', ['fetch', '-q', 'origin', proposed.branch], { cwd: checkout });
    run('git', ['merge', '--no-ff', '--no-edit', `origin/${proposed.branch}`], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:sflow/config'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', `:${proposed.branch}`], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${proposed.branch}`], {
    cwd: org.platform, allowFailure: true
  }).status, 1, 'the provider removed the reviewed source branch');
  const mergeCommit = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: mergeCommit }),
    (error) => error?.code === 'CAPABILITY_PROPOSAL_NOT_FOUND'
  );

  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.alreadyMerged, true);
  assert.equal(activated.mergeEvidence, 'commit-ancestry');
  assert.equal(activated.proposalCommit, proposed.commit);
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
});

test('a squash-merged proposal is recognized without moving approved configuration again', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-squash-proposal-review-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    run('git', ['fetch', '-q', 'origin', proposed.branch], { cwd: checkout });
    run('git', ['merge', '--squash', `origin/${proposed.branch}`], { cwd: checkout });
    run('git', ['commit', '-qm', 'Squash reviewed capability proposal'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:sflow/config'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
  const approved = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const inspected = await inspectCapabilityProposal(org.platform, proposed.branch);
  assert.equal(inspected.merged, true);
  assert.equal(inspected.mergeEvidence, 'content-equivalent');
  run('git', ['update-ref', '-d', `refs/heads/${proposed.branch}`], { cwd: org.platform });
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${proposed.branch}`], {
    cwd: org.platform, allowFailure: true
  }).status, 1, 'the provider deleted the squash-merged source branch');

  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.alreadyMerged, true);
  assert.equal(activated.mergeEvidence, 'content-equivalent');
  assert.equal(activated.targetCommit, approved);
  assert.equal(run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim(), approved, 'retrospective acknowledgement must not create a second merge');
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
});

test('partial content from a multi-commit proposal is not mistaken for a squash merge', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const authoring = await mkdtemp(path.join(os.tmpdir(), 'sflow-multi-commit-proposal-'));
  let proposalCommit;
  try {
    run('git', ['clone', '-q', '--branch', proposed.branch, org.platform, authoring]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: authoring });
    run('git', ['config', 'user.name', 'Review User'], { cwd: authoring });
    const impactFile = path.join(authoring, 'singularity/impact.yml');
    await writeFile(impactFile, `${await readFile(impactFile, 'utf8')}\n# reviewed follow-up\n`);
    run('git', ['add', 'singularity/impact.yml'], { cwd: authoring });
    run('git', ['commit', '-qm', 'Follow up on capability proposal'], { cwd: authoring });
    proposalCommit = run('git', ['rev-parse', 'HEAD'], { cwd: authoring }).stdout.trim();
    run('git', ['push', '-q', 'origin', `HEAD:${proposed.branch}`], { cwd: authoring });
  } finally {
    await rm(authoring, { recursive: true, force: true });
  }

  // Apply only the follow-up commit to the authority. Its one changed file now matches the proposal
  // tip, but the capability introduced by the proposal's first commit is still absent.
  const review = await mkdtemp(path.join(os.tmpdir(), 'sflow-partial-squash-review-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, review]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: review });
    run('git', ['config', 'user.name', 'Review User'], { cwd: review });
    run('git', ['fetch', '-q', 'origin', proposed.branch], { cwd: review });
    run('git', ['cherry-pick', `origin/${proposed.branch}`], { cwd: review });
    run('git', ['push', '-q', 'origin', 'HEAD:sflow/config'], { cwd: review });
  } finally {
    await rm(review, { recursive: true, force: true });
  }
  const approved = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const inspected = await inspectCapabilityProposal(org.platform, proposed.branch);
  assert.equal(inspected.proposalCommit, proposalCommit);
  assert.equal(inspected.merged, false);
  assert.equal(inspected.mergeEvidence, null);
  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: proposalCommit }),
    (error) => error?.code === 'CAPABILITY_CONFIGURATION_UNPROTECTED'
  );
  assert.equal(run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim(), approved, 'partial content evidence must never advance approved configuration');
});

test('an externally merged invalid capability map is refused before audit or projection', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-invalid-external-review-'));
  let invalidCommit;
  try {
    run('git', ['clone', '-q', org.platform, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    run('git', ['fetch', '-q', 'origin', proposed.branch], { cwd: checkout });
    run('git', ['switch', '-q', '-C', proposed.branch, `origin/${proposed.branch}`], { cwd: checkout });
    const file = path.join(checkout, 'singularity/capabilities.yml');
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    document.setIn(['capabilities', 'calculator', 'parent'], 'calculator');
    await writeFile(file, document.toString());
    run('git', ['add', file], { cwd: checkout });
    run('git', ['commit', '-qm', 'introduce invalid capability cycle'], { cwd: checkout });
    invalidCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', '--force', 'origin', `HEAD:${proposed.branch}`], { cwd: checkout });
    run('git', ['switch', '-q', '-C', 'sflow/config', 'origin/sflow/config'], { cwd: checkout });
    run('git', ['merge', '--ff-only', proposed.branch], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:sflow/config'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }

  await assert.rejects(
    () => activateCapabilityProposal(org.platform, proposed.branch, { confirm: invalidCommit }),
    (error) => error.code === 'CAPABILITY_PROPOSAL_CONFIGURATION_INVALID'
  );
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/state'], {
    cwd: org.platform, allowFailure: true
  }).status, 1);
});

test('activation success survives a later projection failure with an exact repair command', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const first = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await mergeProposal(org.platform, first);
  await publishOrganisationCapabilityMap(org.platform);

  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection', parent: 'commerce'
  });
  const hook = path.join(org.platform, 'hooks', 'pre-receive');
  const counter = path.join(org.platform, 'hooks', 'state-push-count');
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/state" ]; then
    count=0
    if [ -f "${counter}" ]; then count=$(cat "${counter}"); fi
    count=$((count + 1))
    echo "$count" > "${counter}"
    if [ "$count" -ge 2 ]; then
      echo "state projection temporarily unavailable" >&2
      exit 1
    fi
  fi
done
exit 0
`);
  await chmod(hook, 0o755);

  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit,
    acknowledgeUnprotected: true
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.status, 'activation-complete-projection-pending');
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, false);
  assert.equal(activated.projection.pending, true);
  assert.match(activated.nextAction.command, /capability publish/);
  assert.match(run('git', ['show', 'sflow/config:singularity/capabilities.yml'], {
    cwd: org.platform
  }).stdout, /calculator/);
});

test('mapping leaves nothing behind: the lead is borrowed, not checked out', async () => {
  // Nobody chose a folder, so nothing may be left in one. The temporary clone is the whole point of
  // this being callable from a window with no repository open.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const before = await readdir(org.base);

  await mapCapability(org.platform, { capabilityId: 'commerce', kind: 'collection' });

  assert.deepEqual((await readdir(org.base)).sort(), before.sort());
});

test('delivery repository reachability is proven before mapping mutates any authority ref', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const missing = path.join(org.base, 'delivery-does-not-exist.git');
  const before = run('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], {
    cwd: org.platform
  }).stdout;

  await assert.rejects(
    mapCapability(org.platform, {
      capabilityId: 'calculator', name: 'Calculator', kind: 'delivery', repositoryUrl: missing
    }),
    (error) => error?.code === 'REMOTE_REMOTE_NOT_FOUND'
  );
  assert.equal(run('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], {
    cwd: org.platform
  }).stdout, before, 'a failed delivery probe must not initialize configuration or publish a proposal');

  const empty = path.join(org.base, 'empty-delivery.git');
  run('git', ['init', '-q', '--bare', empty], { cwd: org.base });
  await assert.rejects(
    mapCapability(org.platform, {
      capabilityId: 'calculator', name: 'Calculator', kind: 'delivery', repositoryUrl: empty
    }),
    (error) => error?.code === 'CAPABILITY_REPOSITORY_DEFAULT_BRANCH_UNKNOWN'
  );
  assert.equal(run('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], {
    cwd: org.platform
  }).stdout, before, 'an empty delivery repository must not be guessed as main');
});

test('capability mapping preserves literal remote identities while keeping recovery commands portable', async (t) => {
  const org = await remotes('platform');
  // A local receive-pack can launch transient Git auto-maintenance while a bare repository is
  // being removed. Use the same bounded-retry cleanup as production scratch repositories so
  // macOS and Linux teardown do not turn that harmless race into an ENOTEMPTY suite failure.
  t.after(() => removeTemporaryTree(org.base));
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const makeLiteralRemote = async (suffix, branch) => {
    const bare = path.join(org.base, `delivery.git?${suffix}`);
    const seed = path.join(org.base, `${suffix}-seed`);
    run('git', ['init', '-q', '-b', branch, '--bare', bare], { cwd: org.base });
    run('git', ['init', '-q', '-b', branch, seed], { cwd: org.base });
    run('git', ['config', 'user.email', 'literal@example.com'], { cwd: seed });
    run('git', ['config', 'user.name', 'Literal Remote'], { cwd: seed });
    await writeFile(path.join(seed, 'README.md'), `# ${suffix}\n`);
    run('git', ['add', '-A'], { cwd: seed });
    run('git', ['commit', '-qm', `Seed ${suffix}`], { cwd: seed });
    run('git', ['push', '-q', bare, `${branch}:${branch}`], { cwd: seed });
    return bare;
  };
  const blue = await makeLiteralRemote('blue', 'blue-main');
  const red = await makeLiteralRemote('red', 'red-main');
  assert.equal(blue.replace(/[?#].*$/, ''), red.replace(/[?#].*$/, ''),
    'the fixture proves both legal local remotes share one display-sanitized label');

  const proposed = await mapCapability(org.platform, {
    capabilityId: 'literal-deliveries', kind: 'delivery', repositoryUrls: [blue, red]
  });
  const portfolio = YAML.parse(run('git', [
    'show', `${proposed.branch}:singularity/portfolio.yml`
  ], { cwd: org.platform }).stdout);
  const deliveries = Object.values(portfolio.repositories ?? {})
    .filter((repository) => [blue, red].includes(repository.url));
  assert.deepEqual(deliveries.map((repository) => [repository.url, repository.defaultBranch]).sort(), [
    [blue, 'blue-main'], [red, 'red-main']
  ].sort(), 'each exact authority keeps its own observation and default branch');

  await assert.rejects(() => mapCapability(blue, { capabilityId: '' }), (error) => {
    assert.match(error.details.nextAction.command, /--lead\s+LEAD_URL/,
      'a remote with shell-special path bytes uses an explicit portable placeholder');
    assert.doesNotMatch(error.details.nextAction.command, /\?blue/,
      'the suggested command cannot reinterpret literal path bytes in a shell');
    return true;
  });
});

test('adding an unreachable repository does not create a capability proposal', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'delivery', repositoryUrl: org.platform
  });
  const before = proposalRefs(org.platform);

  await assert.rejects(
    addCapabilityRepository(
      org.platform, 'calculator', path.join(org.base, 'second-delivery-does-not-exist.git')
    ),
    (error) => error?.code === 'REMOTE_REMOTE_NOT_FOUND'
  );
  assert.deepEqual(proposalRefs(org.platform), before);
});

test('a repeated mapping points to the preserved proposal instead of becoming a dead end', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'commerce', kind: 'collection'
  });

  await assert.rejects(mapCapability(org.platform, {
    capabilityId: 'commerce', kind: 'collection'
  }), (error) => {
    assert.equal(error.code, 'CAPABILITY_PROPOSAL_ALREADY_EXISTS');
    assert.equal(error.details.state, 'proposal-already-exists');
    assert.equal(error.details.proposalBranch, proposed.branch);
    assert.match(error.details.nextAction.command, /capability proposal/);
    return true;
  });
  assert.equal((await listCapabilityProposals(org.platform)).length, 1);
});

test('proposal clone and fetch failures retain structured remote diagnosis and an exact doctor action', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, { capabilityId: 'commerce', kind: 'collection' });
  const configurationCommit = run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim();
  const proposalBranch = 'sflow/config-change/capability/missing-proposal';
  const advertisedOnly = {
    env: process.env,
    async observeAsync() {
      return {
        ok: true,
        refs: new Map([
          ['refs/heads/sflow/config', configurationCommit],
          [`refs/heads/${proposalBranch}`, 'a'.repeat(40)]
        ])
      };
    }
  };
  const failProposalFetch = (args, options) => {
    if (args[0] !== 'fetch') return runRemoteGitAsync(args, options);
    return Promise.resolve({
      status: 128, stdout: '', stderr: '', signal: null, timedOut: false, blocked: false,
      failure: {
        code: 'REMOTE_BRANCH_NOT_FOUND', classification: 'branch-not-found', retryable: false,
        branch: null, advice: 'Choose a branch that exists on the remote or publish the expected branch, then retry.',
        evidence: {
          exitCode: 128, signal: null, timedOut: false, blocked: false,
          diagnosticSha256: 'b'.repeat(64), diagnosticBytes: 37
        }
      }
    });
  };

  const unavailable = path.join(org.base, 'authority-does-not-exist.git');
  await assert.rejects(listCapabilityProposals(unavailable, {
    remoteSession: advertisedOnly
  }), (error) => {
    assert.equal(error.details.remoteFailure.classification, 'remote-not-found');
    assert.match(error.details.remoteFailure.evidence.diagnosticSha256, /^[a-f0-9]{64}$/);
    assert.match(error.details.diagnosticAction.command,
      /workspace doctor --network --repository/);
    return true;
  });

  const proposals = await listCapabilityProposals(org.platform, {
    remoteSession: advertisedOnly,
    runRemoteCommand: failProposalFetch
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, 'unreadable');
  assert.equal(proposals[0].failure.classification, 'branch-not-found',
    JSON.stringify(proposals[0].failure));
  assert.equal(proposals[0].failure.remoteFailure.classification, 'branch-not-found');
  assert.match(proposals[0].failure.evidence.diagnosticSha256, /^[a-f0-9]{64}$/);
  assert.match(proposals[0].failure.diagnosticAction.command,
    /workspace doctor --network --repository/);
  assert.doesNotMatch(JSON.stringify(proposals[0].failure), /stderr|couldn't find remote ref/i);

  await mapCapability(org.platform, { capabilityId: 'pending-review', kind: 'collection' });
  const inspection = await inspectCapabilityRepository(org.platform, {
    leadUrl: org.platform,
    proposalRemoteCommand: failProposalFetch
  });
  assert.equal(inspection.proposalCoverage, 'partial');
  const transportFailure = inspection.failures.find(
    (failure) => failure.classification === 'branch-not-found'
  );
  assert.ok(transportFailure, 'the shared proposal transport failure reaches repository inspection');
  assert.match(transportFailure.evidence.diagnosticSha256, /^[a-f0-9]{64}$/);
  assert.match(transportFailure.diagnosticAction.command,
    /workspace doctor --network --repository/);
});

test('one unreadable proposal remains visible without hiding healthy proposals', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const healthy = await mapCapability(org.platform, {
    capabilityId: 'commerce', kind: 'collection'
  });
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-invalid-proposal-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, checkout]);
    run('git', ['config', 'user.email', 'a@b.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'A B'], { cwd: checkout });
    run('git', ['switch', '-q', '--orphan', 'sflow/config-change/capability/invalid-review'], { cwd: checkout });
    await writeFile(path.join(checkout, 'README.md'), '# not governed configuration\n');
    run('git', ['add', 'README.md'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Invalid proposal fixture'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }

  const proposals = await listCapabilityProposals(org.platform);
  assert.equal(proposals.length, 2);
  assert.equal(proposals.find((entry) => entry.branch === healthy.branch)?.valid, true);
  const invalid = proposals.find((entry) => entry.branch.endsWith('/invalid-review'));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.status, 'unreadable');
  assert.equal(invalid.discardable, true);
  assert.match(invalid.failure.message, /does not share history|rev-parse|unknown revision/i);
  assert.match(invalid.failure.nextAction.command, /capability discard-proposal/);

  const fsck = await capabilityFsck(org.platform);
  assert.equal(fsck.valid, false);
  const finding = fsck.checks.find((entry) => entry.branch === invalid.branch);
  assert.equal(finding.status, 'fail');
  assert.equal(finding.commit, invalid.proposalCommit);
  assert.match(finding.remediation, /discard-proposal/);
  assert.match(finding.remediation, new RegExp(invalid.proposalCommit));
  assert.ok(finding.details.alternatives.some((entry) => /Recreate the capability/.test(entry)));
  const protectedRefs = Object.fromEntries(['main', 'sflow/config'].map((branch) => [
    branch,
    run('git', ['rev-parse', `refs/heads/${branch}`], { cwd: org.platform }).stdout.trim()
  ]));

  await assert.rejects(
    discardStaleCapabilityProposal(org.platform, invalid.branch, {
      confirm: invalid.proposalCommit.slice(0, 12), reason: 'obsolete configuration root'
    }),
    (error) => error?.code === 'CAPABILITY_PROPOSAL_DISCARD_CONFIRMATION_MISMATCH'
  );
  await assert.rejects(
    discardStaleCapabilityProposal(org.platform, healthy.branch, {
      confirm: healthy.commit, reason: 'must not delete a reviewable proposal'
    }),
    (error) => error?.code === 'CAPABILITY_PROPOSAL_DISCARD_NOT_STALE'
  );

  // A full confirmation is still only for one observed revision. If somebody moves the proposal
  // between fsck and discard, the old exact SHA cannot delete the new branch tip.
  const movedCheckout = await mkdtemp(path.join(os.tmpdir(), 'sflow-moved-stale-proposal-'));
  try {
    run('git', ['clone', '-q', '--branch', invalid.branch, org.platform, movedCheckout]);
    run('git', ['config', 'user.email', 'mover@example.test'], { cwd: movedCheckout });
    run('git', ['config', 'user.name', 'Proposal Mover'], { cwd: movedCheckout });
    await writeFile(path.join(movedCheckout, 'README.md'), '# still unrelated, but moved\n');
    run('git', ['add', 'README.md'], { cwd: movedCheckout });
    run('git', ['commit', '-qm', 'Move stale proposal'], { cwd: movedCheckout });
    run('git', ['push', '-q', 'origin', `HEAD:${invalid.branch}`], { cwd: movedCheckout });
  } finally {
    await rm(movedCheckout, { recursive: true, force: true });
  }
  await assert.rejects(
    discardStaleCapabilityProposal(org.platform, invalid.branch, {
      confirm: invalid.proposalCommit, reason: 'configuration authority was intentionally re-rooted'
    }),
    (error) => error?.code === 'CAPABILITY_PROPOSAL_DISCARD_CONFIRMATION_MISMATCH'
  );
  const moved = (await listCapabilityProposals(org.platform))
    .find((entry) => entry.branch === invalid.branch);
  assert.notEqual(moved.proposalCommit, invalid.proposalCommit);

  const discarded = await discardStaleCapabilityProposal(org.platform, invalid.branch, {
    confirm: moved.proposalCommit, reason: 'configuration authority was intentionally re-rooted'
  });
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.proposalCommit, moved.proposalCommit);
  assert.deepEqual(discarded.preserved,
    ['approved-configuration', 'state-projection', 'application-branches', 'other-proposal-branches']);
  assert.equal(run('git', ['show-ref', '--verify', `refs/heads/${invalid.branch}`], {
    cwd: org.platform, allowFailure: true
  }).status === 0, false);
  const remaining = await listCapabilityProposals(org.platform);
  assert.deepEqual(remaining.map((entry) => entry.branch), [healthy.branch]);
  for (const [branch, commit] of Object.entries(protectedRefs)) {
    assert.equal(run('git', ['rev-parse', `refs/heads/${branch}`], {
      cwd: org.platform
    }).stdout.trim(), commit, `discard must not move ${branch}`);
  }
});

test('a valid proposal from a replaced configuration root remains exactly discardable', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const oldConfiguration = run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim();
  const tree = run('git', ['rev-parse', 'sflow/config^{tree}'], { cwd: org.platform }).stdout.trim();
  const fixtureIdentity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Configuration Recovery', GIT_AUTHOR_EMAIL: 'recovery@example.invalid',
    GIT_COMMITTER_NAME: 'Configuration Recovery', GIT_COMMITTER_EMAIL: 'recovery@example.invalid'
  };
  const replacement = run('git', [
    'commit-tree', tree, '-m', 'Replace configuration authority root'
  ], { cwd: org.platform, env: fixtureIdentity }).stdout.trim();
  run('git', ['update-ref', 'refs/heads/sflow/config', replacement, oldConfiguration], {
    cwd: org.platform
  });

  const proposal = (await listCapabilityProposals(org.platform, {
    includeMerged: true, includeDiff: false
  })).find((entry) => entry.branch === proposed.branch);
  assert.equal(proposal.status, 'unreadable');
  assert.equal(proposal.failure.code, 'CAPABILITY_PROPOSAL_HISTORY_INVALID');
  assert.equal(proposal.discardable, true);
  const discarded = await discardStaleCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit, reason: 'proposal belongs to the replaced configuration authority root'
  });
  assert.equal(discarded.discarded, true);
  assert.equal(run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim(), replacement);
});

test('a same-history invalid proposal is visible and safely discardable by exact commit', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposed = await mapCapability(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'collection'
  });
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-invalid-same-history-'));
  let invalidCommit;
  try {
    run('git', ['clone', '-q', '--branch', proposed.branch, org.platform, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    await writeFile(path.join(checkout, 'NOT-CONFIG.txt'), 'must never enter approved configuration\n');
    run('git', ['add', 'NOT-CONFIG.txt'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Introduce invalid proposal content'], { cwd: checkout });
    invalidCommit = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    run('git', ['push', '-q', 'origin', `HEAD:${proposed.branch}`], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
  const approved = run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim();
  const proposal = (await listCapabilityProposals(org.platform, {
    includeMerged: true, includeDiff: false
  })).find((entry) => entry.branch === proposed.branch);
  assert.equal(proposal.proposalCommit, invalidCommit);
  assert.equal(proposal.valid, false);
  assert.equal(proposal.status, 'invalid');
  assert.equal(proposal.discardable, true);
  assert.deepEqual(proposal.invalidFiles, ['NOT-CONFIG.txt']);

  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: invalidCommit }),
    (error) => error?.code === 'CAPABILITY_PROPOSAL_FILES_INVALID'
  );
  const discarded = await discardStaleCapabilityProposal(org.platform, proposed.branch, {
    confirm: invalidCommit, reason: 'proposal contains a non-configuration file'
  });
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.proposalCommit, invalidCommit);
  assert.equal(run('git', ['rev-parse', 'sflow/config'], {
    cwd: org.platform
  }).stdout.trim(), approved, 'discard must leave approved configuration untouched');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${proposed.branch}`], {
    cwd: org.platform, allowFailure: true
  }).status, 1);
});

test('capability fsck detects machine workspace bindings absent from approved configuration', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'calculator', name: 'Calculator', kind: 'delivery', repositoryUrl: org.platform
  });
  const fsck = await capabilityFsck(org.platform, {
    workspaces: [{
      id: 'office-work', name: 'Office work', path: '/workspaces/office-work',
      capabilityAuthority: { url: org.platform },
      capabilities: ['calculator'],
      repositories: {
        platform: { url: org.platform, capabilities: ['calculator', 'missing-office-capability'] }
      }
    }]
  });
  assert.equal(fsck.valid, false);
  const binding = fsck.checks.find((entry) => entry.id === 'workspace:office-work:capability-binding');
  assert.equal(binding.status, 'fail');
  assert.match(binding.summary, /missing-office-capability/);
  assert.match(binding.remediation, /capability map/);
  assert.deepEqual(binding.details.unknown, ['missing-office-capability']);
  assert.ok(binding.details.alternatives.some((entry) => /workspace update/.test(entry)));
});

test('capability fsck detects an unpinned canonical map that diverges from approved configuration', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'piassistnat', name: 'PI Assistant Native', kind: 'delivery',
    repositoryUrl: org.platform
  });

  const workspacePath = path.join(org.base, 'office-workspace');
  const checkout = path.join(workspacePath, 'repos', 'platform');
  await mkdir(path.dirname(checkout), { recursive: true });
  run('git', ['clone', '-q', '--branch', 'main', org.platform, checkout], { cwd: org.base });
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await writeFile(path.join(checkout, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      enterprise: { kind: 'collection', parent: null, policy: {} },
      product: { kind: 'collection', parent: 'enterprise', policy: {} }
    }
  }));

  const fsck = await capabilityFsck(org.platform, {
    workspaces: [{
      id: 'office-work',
      name: 'Office work',
      path: workspacePath,
      leadRepository: 'platform',
      capabilityAuthority: { url: org.platform },
      capabilities: ['piassistnat'],
      repositories: {
        platform: {
          id: 'platform', url: org.platform, path: 'repos/platform',
          capabilities: ['piassistnat']
        }
      }
    }]
  });

  assert.equal(fsck.valid, false);
  const divergence = fsck.checks.find((entry) =>
    entry.id === 'workspace:office-work:canonical-capability-map');
  assert.equal(divergence.status, 'fail');
  assert.match(divergence.summary, /diverges from approved 'sflow\/config'/);
  assert.deepEqual(divergence.details.localCapabilities, ['enterprise', 'product']);
  assert.ok(divergence.details.approvedCapabilities.includes('piassistnat'));
  assert.match(divergence.details.note, /runtime ignores this unproven local map/i);
  assert.match(divergence.remediation, /normal source control/);
  assert.match(divergence.remediation, /No automatic deletion is performed/);
  assert.doesNotMatch(divergence.remediation, /refresh-configuration/,
    'configuration refresh cannot remove an application-branch shadow map');
});

test('capability fsck accepts an older pinned Story map only when its workflow binds the same authority', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'piassistnat', name: 'PI Assistant Native', kind: 'delivery',
    repositoryUrl: org.platform
  });
  const story = await startPinnedCapabilityStory(org, 'PINNED-CAP-1');
  const pinned = await readConfigurationSource(story.checkout, { verify: true });
  const workflow = JSON.parse(await readFile(story.workflowFile, 'utf8'));
  assert.equal(pinned.repository, org.platform);
  assert.equal(workflow.workItem.branch, 'PINNED-CAP-1');
  assert.equal(workflow.lineage.canonicalBranch, 'PINNED-CAP-1');
  assert.equal(workflow.resolution.configurationSource.repository, pinned.repository);
  assert.equal(workflow.resolution.configurationSource.commit, pinned.commit);
  assert.equal(workflow.resolution.configurationSource.filesSha256, pinned.filesSha256);

  // Advance approved policy after the Story started. The older exact Story snapshot remains a
  // valid intentional pin; it must not be reported as application-branch divergence.
  await mapAndMerge(org.platform, {
    capabilityId: 'later-policy', name: 'Later policy', kind: 'collection'
  });
  const fsck = await capabilityFsck(org.platform, { workspaces: [story.workspace] });
  const canonical = fsck.checks.find((entry) =>
    entry.id === `workspace:${story.workspace.id}:canonical-capability-map`);
  assert.equal(canonical.status, 'info');
  assert.equal(canonical.branch, 'PINNED-CAP-1');
  assert.equal(canonical.commit, pinned.commit);
  assert.match(canonical.summary, /older Story snapshot is intentional/);
  assert.doesNotMatch(canonical.summary, /diverge/i);
});

test('capability fsck rejects a self-consistent configuration-source copied without Story binding', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, {
    capabilityId: 'piassistnat', name: 'PI Assistant Native', kind: 'delivery',
    repositoryUrl: org.platform
  });
  const story = await startPinnedCapabilityStory(org, 'UNBOUND-CAP-1');
  const pinned = await readConfigurationSource(story.checkout, { verify: true });
  assert.match(pinned.filesSha256, /^[0-9a-f]{64}$/,
    'the copied source record and every configuration asset verify before Story binding is checked');
  const workflow = JSON.parse(await readFile(story.workflowFile, 'utf8'));
  workflow.resolution.configurationSource = {
    ...workflow.resolution.configurationSource,
    commit: '0'.repeat(40)
  };
  await writeFile(story.workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  const stillSelfConsistent = await readConfigurationSource(story.checkout, { verify: true });
  assert.equal(stillSelfConsistent.filesSha256, pinned.filesSha256);

  const fsck = await capabilityFsck(org.platform, { workspaces: [story.workspace] });
  const canonical = fsck.checks.find((entry) =>
    entry.id === `workspace:${story.workspace.id}:canonical-capability-map`);
  assert.equal(canonical.status, 'fail');
  assert.match(canonical.summary, /not bound to this branch's governed Story resolution/);
  assert.match(canonical.remediation, /workspace refresh-configuration/);
});

test('capability fsck warns without inventing unknown bindings or divergence when authority is unavailable', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  await mapAndMerge(org.platform, {
    capabilityId: 'piassistnat', name: 'PI Assistant Native', kind: 'delivery',
    repositoryUrl: org.platform
  });
  const current = await readOrganisation(org.platform, { refresh: true });
  assert.equal(current.stale, false);

  const workspacePath = path.join(org.base, 'offline-office-workspace');
  const checkout = path.join(workspacePath, 'repos', 'platform');
  await mkdir(path.dirname(checkout), { recursive: true });
  run('git', ['clone', '-q', '--branch', 'main', org.platform, checkout], { cwd: org.base });
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await writeFile(path.join(checkout, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      enterprise: { kind: 'collection', parent: null, policy: {} }
    }
  }));
  const workspace = {
    id: 'offline-office', name: 'Offline office', path: workspacePath,
    leadRepository: 'platform', capabilityAuthority: { url: org.platform },
    capabilities: ['new-office-capability'],
    repositories: {
      platform: {
        id: 'platform', url: org.platform, path: 'repos/platform',
        capabilities: ['new-office-capability']
      }
    }
  };
  await rename(org.platform, `${org.platform}.offline`);
  const stale = await readOrganisation(org.platform, { refresh: true });
  assert.equal(stale.stale, true);

  const fsck = await capabilityFsck(org.platform, { workspaces: [workspace] });
  const approved = fsck.checks.find((entry) => entry.id === 'approved-capability-map');
  const binding = fsck.checks.find((entry) =>
    entry.id === 'workspace:offline-office:capability-binding');
  const canonical = fsck.checks.find((entry) =>
    entry.id === 'workspace:offline-office:canonical-capability-map');
  assert.equal(approved.status, 'warn');
  assert.match(approved.summary, /previously validated capability map/);
  assert.equal(binding.status, 'warn');
  assert.match(binding.summary, /could not be compared/);
  assert.doesNotMatch(binding.summary, /absent|unknown/i);
  assert.equal(canonical.status, 'warn');
  assert.match(canonical.summary, /was not compared/);
  assert.match(canonical.summary, /no divergence conclusion was inferred/);
});

test('mapping succeeds against a protected default branch and preserves existing singularity files', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  // An existing Singularity directory may contain organisation-specific policy that initialization
  // must not replace. Put one on main before the proposal.
  const seed = path.join(org.base, 'existing-governance');
  run('git', ['clone', '-q', org.platform, seed], { cwd: org.base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: seed });
  run('git', ['config', 'user.name', 'A B'], { cwd: seed });
  await mkdir(path.join(seed, 'singularity'), { recursive: true });
  await writeFile(path.join(seed, 'singularity', 'company-policy.md'), '# Keep me\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'Existing organisation policy'], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'main'], { cwd: seed });
  const mainBefore = run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim();

  // Simulate branch protection. A direct default-branch push would make the operation fail.
  const hook = path.join(org.platform, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo "main is protected" >&2
    exit 1
  fi
done
exit 0
`);
  await chmod(hook, 0o755);

  const proposal = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  assert.equal(run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim(), mainBefore);
  assert.equal(run('git', ['show', `${proposal.branch}:singularity/company-policy.md`], {
    cwd: org.platform
  }).stdout, '# Keep me\n');
  assert.match(run('git', ['show', `${proposal.branch}:singularity/capabilities.yml`], {
    cwd: org.platform
  }).stdout, /commerce:/);
});

test('a capability that ships declares its repository; a grouping declares none', async () => {
  const org = await remotes('platform', 'api');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, { capabilityId: 'commerce', kind: 'collection' });
  await mapAndMerge(org.platform, {
    capabilityId: 'payments-api', name: 'Payments API', parent: 'commerce', repositoryUrl: org.api
  });

  const read = await readOrganisation(org.platform);
  assert.equal(read.capabilities[0].id, 'commerce');
  assert.equal(read.capabilities[0].repository, null, 'a grouping ships from nothing');
  assert.equal(read.capabilities[0].children[0].repository, 'api');
  // Declared in the portfolio in the same edit, so the capability can never name a repository that
  // has nowhere to be cloned from.
  assert.equal(read.repositories.api.url, org.api);
});

test('organisation reads prefer the state mirror and reuse a SHA-validated durable cache', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  const proposal = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await mergeProposal(org.platform, proposal);
  await publishOrganisationCapabilityMap(org.platform);

  const first = await readOrganisation(org.platform, { refresh: true });
  assert.equal(first.sourceBranch, 'state');
  assert.equal(first.cached, false);
  assert.equal(first.stale, false);
  const second = await readOrganisation(org.platform);
  assert.equal(second.cached, true);
  assert.equal(second.stale, false);
  assert.equal(second.sourceCommit, first.sourceCommit);
  assert.deepEqual(second.capabilities, first.capabilities);

  const stateAdvance = path.join(org.base, 'advance-state-only');
  run('git', ['clone', '-q', '--branch', 'state', org.platform, stateAdvance], { cwd: org.base });
  run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: stateAdvance });
  run('git', ['config', 'user.name', 'Review User'], { cwd: stateAdvance });
  run('git', ['commit', '--allow-empty', '-qm', 'Advance state receipt only'], { cwd: stateAdvance });
  run('git', ['push', '-q', 'origin', 'HEAD:state'], { cwd: stateAdvance });
  const advancedState = run('git', ['rev-parse', 'HEAD'], { cwd: stateAdvance }).stdout.trim();
  const afterStateAdvance = await readOrganisation(org.platform);
  assert.equal(afterStateAdvance.cached, false,
    'the configuration cache must observe its independently moving state source');
  assert.equal(afterStateAdvance.sourceCommit, advancedState);
  assert.deepEqual(afterStateAdvance.capabilities, first.capabilities);

  const cacheFile = organisationCacheFile(org.platform);
  const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
  cached.organisation.capabilities[0].name = 'Poisoned cache fixture';
  await writeFile(cacheFile, `${JSON.stringify(cached)}\n`);
  const checkout = path.join(org.base, 'refresh-cli');
  run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, checkout], { cwd: org.base });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const refreshed = JSON.parse(execFileSync(process.execPath, [
    cli, 'capability', 'organisation', org.platform, '--refresh', '--json'
  ], { cwd: checkout, encoding: 'utf8', env: process.env }));
  assert.equal(refreshed.capabilities[0].name, 'Commerce',
    'the CLI refresh flag bypasses a same-tip durable cache entry');
});

test('organisation reads completely verify a configured non-default state branch', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  const mapped = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await mergeProposal(org.platform, mapped);
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-custom-state-configuration-'));
  try {
    run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    const workflowFile = path.join(checkout, 'singularity/workflow.yml');
    const workflow = YAML.parseDocument(await readFile(workflowFile, 'utf8'));
    workflow.setIn(['ledger', 'branch'], 'organisation-state');
    await writeFile(workflowFile, workflow.toString());
    run('git', ['add', 'singularity/workflow.yml'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Use configured organisation state branch'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:sflow/config'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
  await publishOrganisationCapabilityMap(org.platform);

  const organisation = await readOrganisation(org.platform, { refresh: true });
  assert.equal(organisation.sourceBranch, 'organisation-state');
  assert.equal(organisation.stateProjection.status, 'current');
  assert.equal(organisation.capabilities[0].id, 'commerce');
});

test('organisation fsck rejects a self-consistent state mirror that diverges from its claimed source', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  const mapped = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await mergeProposal(org.platform, mapped);
  await publishOrganisationCapabilityMap(org.platform);

  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-divergent-state-mirror-'));
  try {
    run('git', ['clone', '-q', '--branch', 'state', org.platform, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    const relative = '.github/agents/developer.agent.md';
    const file = path.join(checkout, relative);
    const contents = `${await readFile(file, 'utf8')}\n<!-- divergent mirror fixture -->\n`;
    await writeFile(file, contents);
    const manifestFile = path.join(checkout, 'configuration/manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const sha256 = createHash('sha256').update(contents).digest('hex');
    const object = run('git', ['hash-object', file], { cwd: checkout }).stdout.trim();
    manifest.files[relative] = sha256;
    manifest.assets[relative] = { ...manifest.assets[relative], sha256, object };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run('git', ['add', relative, 'configuration/manifest.json'], { cwd: checkout });
    run('git', ['commit', '-qm', 'Diverge state configuration mirror'], { cwd: checkout });
    run('git', ['push', '-q', 'origin', 'HEAD:state'], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }

  const organisation = await readOrganisation(org.platform, { refresh: true });
  assert.equal(organisation.sourceBranch, 'sflow/config');
  assert.equal(organisation.stateProjection.status, 'invalid');
  assert.match(organisation.stateProjection.error, /complete asset set does not match/);
  const fsck = await capabilityFsck(org.platform);
  assert.equal(fsck.valid, false);
  const projection = fsck.checks.find((entry) => entry.id === 'state-projection');
  assert.equal(projection.status, 'fail');
  assert.match(projection.summary, /mirror is invalid/);
  assert.match(projection.remediation, /capability publish/);
});

test('a reachable but lagging state mirror cannot override newer approved configuration', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  const mapped = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await mergeProposal(org.platform, mapped);
  await publishOrganisationCapabilityMap(org.platform);
  assert.equal((await readOrganisation(org.platform, { refresh: true })).sourceBranch, 'state');

  const edited = await editCapabilityInOrganisation(org.platform, 'commerce', {
    name: 'Commerce Platform'
  });
  await mergeProposal(org.platform, edited);
  const read = await readOrganisation(org.platform, { refresh: true });
  assert.equal(read.sourceBranch, 'sflow/config');
  assert.equal(read.capabilities[0].name, 'Commerce Platform');
});

test('organisation reads fall back to configuration when no state mirror exists', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  await mapAndMerge(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });

  const read = await readOrganisation(org.platform, { refresh: true });
  assert.equal(read.sourceBranch, 'sflow/config');
  assert.equal(read.governed, true);
  assert.equal(read.capabilities[0].id, 'commerce');
});

test('an unreachable lead serves the last validated organisation as explicitly stale', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = path.join(org.base, 'organisation-cache');
  await mapAndMerge(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  const live = await readOrganisation(org.platform, { refresh: true });
  assert.equal(live.stale, false);

  const unavailable = `${org.platform}.offline`;
  await rm(unavailable, { recursive: true, force: true });
  await rename(org.platform, unavailable);
  const offline = await readOrganisation(org.platform, { refresh: true });
  assert.equal(offline.cached, true);
  assert.equal(offline.stale, true);
  assert.ok(offline.cacheAgeMs >= 0);
  assert.match(offline.remoteError, /not.*repository|does not exist|unable|failed/i);
  assert.deepEqual(offline.capabilities, live.capabilities);
});

test('a workspace plan is what the chosen capabilities ship from, not a second list', () => {
  const organisation = {
    capabilities: [{
      id: 'commerce', name: 'Commerce', repository: null, children: [
        { id: 'payments', name: 'Payments', repository: null, children: [
          { id: 'payments-api', name: 'Payments API', repository: 'api', children: [] }
        ] },
        { id: 'storefront-web', name: 'Storefront Web', repository: 'web', children: [] }
      ]
    }],
    repositories: {
      api: { url: 'https://example.com/api.git', defaultBranch: 'main' },
      web: { url: 'https://example.com/web.git', defaultBranch: 'trunk' }
    }
  };

  // Choosing a grouping means everything beneath it, the way choosing a directory means its
  // contents.
  const whole = resolveWorkspacePlan(organisation, { capabilities: ['commerce'] });
  assert.deepEqual(Object.keys(whole.repositories).sort(), ['api', 'web']);
  assert.equal(whole.repositories.web.defaultBranch, 'trunk');
  assert.deepEqual(whole.capabilities, ['commerce'], 'the selection is recorded, not its expansion');

  const part = resolveWorkspacePlan(organisation, { capabilities: ['payments'] });
  assert.deepEqual(Object.keys(part.repositories), ['api']);

  // The lead is the workspace's centre of gravity, and defaults rather than being demanded.
  assert.equal(part.leadCapability, 'payments-api');
  assert.equal(part.leadRepository, 'api');
  assert.equal(
    resolveWorkspacePlan(organisation, { capabilities: ['commerce'], leadCapability: 'storefront-web' })
      .leadRepository, 'web');
});

test('a capability that ships from several repositories brings all of them into the workspace', () => {
  // The map stopped being one-repository-per-capability, and the planner kept reading the first.
  // A product with a web app and a service produced a workspace with half the work missing in it.
  const organisation = {
    capabilities: [{
      id: 'commerce', name: 'Commerce', repositories: [], children: [{
        id: 'checkout', name: 'Checkout',
        repositories: ['checkout-api', 'checkout-web'], leadRepository: 'checkout-api', children: []
      }]
    }],
    repositories: {
      'checkout-api': { url: 'https://example.com/checkout-api.git', defaultBranch: 'main' },
      'checkout-web': { url: 'https://example.com/checkout-web.git', defaultBranch: 'trunk' }
    }
  };

  const plan = resolveWorkspacePlan(organisation, { capabilities: ['commerce'] });
  assert.deepEqual(Object.keys(plan.repositories).sort(), ['checkout-api', 'checkout-web']);
  assert.equal(plan.repositories['checkout-web'].defaultBranch, 'trunk');
  assert.equal(plan.repositories['checkout-web'].path, 'repos/checkout-web');
  // The state branch goes in one repository, and which one is recorded on the capability rather
  // than decided by the order the list happens to be written in.
  assert.equal(plan.leadRepository, 'checkout-api');

  const named = resolveWorkspacePlan(organisation, { capabilities: ['commerce'], leadCapability: 'checkout' });
  assert.equal(named.leadRepository, 'checkout-api');

  // A repository the portfolio never declared is refused by name, not by position.
  assert.throws(
    () => resolveWorkspacePlan(
      { ...organisation, repositories: { 'checkout-api': organisation.repositories['checkout-api'] } },
      { capabilities: ['commerce'] }),
    /ships from 'checkout-web'/);
});

test('a workspace plan refuses what would produce nothing to work in', () => {
  const organisation = {
    capabilities: [{ id: 'commerce', name: 'Commerce', repository: null, children: [] }],
    repositories: {}
  };
  assert.throws(() => resolveWorkspacePlan(organisation, { capabilities: [] }), /at least one capability/);
  assert.throws(() => resolveWorkspacePlan(organisation, { capabilities: ['nope'] }), /Unknown capability/);
  assert.throws(() => resolveWorkspacePlan(organisation, { capabilities: ['commerce'] }),
    /ships from a repository/);

  // A grouping cannot lead: leading means carrying the state branch, and it has no repository.
  const shipping = {
    capabilities: [{
      id: 'commerce', repository: null,
      children: [{ id: 'api-service', repository: 'api', children: [] }]
    }],
    repositories: { api: { url: 'https://example.com/api.git' } }
  };
  assert.throws(
    () => resolveWorkspacePlan(shipping, { capabilities: ['commerce'], leadCapability: 'commerce' }),
    /does not ship from a repository/);

  // A capability naming a repository the portfolio does not declare is named, not silently dropped.
  assert.throws(
    () => resolveWorkspacePlan({ ...shipping, repositories: {} }, { capabilities: ['commerce'] }),
    /does not declare/);
});

test('initialising a workspace creates the orphan state branch, and checks before it does', async () => {
  const org = await remotes('api');
  const work = path.join(org.base, 'work');
  run('git', ['clone', '-q', org.api, work], { cwd: org.base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: work });
  run('git', ['config', 'user.name', 'A B'], { cwd: work });

  // A checkout with nothing on it is refused in words rather than in git's.
  const empty = path.join(org.base, 'empty');
  run('git', ['init', '-q', empty], { cwd: org.base });
  await assert.rejects(() => initializeWorkspaceState(empty), /no branch checked out/);

  const transport = {
    env: { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(org.base, 'transport-outbox') },
    home: org.base
  };
  const first = await initializeWorkspaceState(work, { transport });
  assert.equal(first.governed, false, 'a delivery repository is not governed in its own right');
  assert.equal(first.existed, false);
  assert.equal(first.created, true);
  assert.equal(first.governancePublished, true);
  assert.match(first.governanceBranch, /^sflow\/govern\/api-/);
  assert.ok(existsSync(path.join(work, 'singularity/workflow.yml')));
  assert.match(run('git', ['ls-remote', '--heads', 'origin', 'state'], { cwd: work }).stdout,
    /refs\/heads\/state/, 'and it reached the remote');
  assert.equal(
    run('git', ['cat-file', '-e', 'origin/main:singularity/workflow.yml'], { cwd: work, allowFailure: true }).status,
    128,
    'workspace initialization does not commit governance onto the application branch'
  );
  assert.equal(
    run('git', ['cat-file', '-e', `origin/${first.governanceBranch}:singularity/workflow.yml`], { cwd: work, allowFailure: true }).status,
    0,
    'the governance proposal contains the initialized definition'
  );
  assert.equal(
    run('git', ['--git-dir', org.api, 'cat-file', '-e', 'sflow/config:singularity/workflow.yml'], {
      allowFailure: true
    }).status,
    0,
    'configuration authority is seeded from the proposal rather than from main'
  );

  // The branch is an orphan: no shared ancestry with the code branch, so a rebase of the work
  // cannot rewrite the record of it.
  assert.equal(
    run('git', ['merge-base', 'origin/main', 'origin/state'], { cwd: work, allowFailure: true }).status,
    1);

  // Re-running finds both and does nothing, which is what makes it safe to call on every create.
  const second = await initializeWorkspaceState(work, { transport });
  assert.equal(second.governed, true);
  assert.equal(second.existed, true);
});

test('workspace initialization selects HEAD and origin only inside the sanitized repository boundary', async () => {
  const org = await remotes('safe-origin-api');
  const work = path.join(org.base, 'safe-origin-work');
  run('git', ['clone', '-q', org['safe-origin-api'], work], { cwd: org.base });
  run('git', ['config', 'user.email', 'safe-origin@example.test'], { cwd: work });
  run('git', ['config', 'user.name', 'Safe Origin Tester'], { cwd: work });

  const attacker = path.join(org.base, 'attacker-repository');
  run('git', ['init', '-q', '-b', 'attacker', attacker], { cwd: org.base });
  await writeFile(path.join(attacker, 'sentinel.txt'), 'attacker repository\n');
  run('git', ['add', '-A'], { cwd: attacker });
  run('git', ['-c', 'user.email=attacker@example.test', '-c', 'user.name=Attacker',
    'commit', '-qm', 'Attacker head'], { cwd: attacker });
  run('git', ['remote', 'add', 'origin', '/credentialed/attacker/repository.git'], { cwd: attacker });
  const attackerHead = run('git', ['rev-parse', 'HEAD'], { cwd: attacker }).stdout.trim();

  const keys = ['GIT_DIR', 'GIT_WORK_TREE'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_DIR = path.join(attacker, '.git');
  process.env.GIT_WORK_TREE = attacker;
  let result;
  try {
    result = await initializeWorkspaceState(work, { push: false });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(result.root, work);
  assert.match(result.governanceBranch, /^sflow\/govern\/safe-origin-api-/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: attacker }).stdout.trim(), attackerHead,
    'ambient repository selectors redirected an onboarding mutation');
  assert.equal(run('git', ['remote', 'get-url', 'origin'], { cwd: work }).stdout.trim(),
    org['safe-origin-api'], 'workspace initialization selected the legitimate origin');
});

test('workspace initialization resumes the same governance publication before it advances', async () => {
  const org = await remotes('resume-api');
  const work = path.join(org.base, 'resume-work');
  run('git', ['clone', '-q', org['resume-api'], work], { cwd: org.base });
  run('git', ['config', 'user.email', 'resume@example.test'], { cwd: work });
  run('git', ['config', 'user.name', 'Resume Tester'], { cwd: work });
  const transport = {
    env: { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(org.base, 'resume-outbox') },
    home: org.base
  };
  let failPush = true;
  const runCommand = (command, args, options) => {
    if (failPush && args[0] === 'push' && !args.includes('--dry-run')) {
      return { status: 1, stdout: '', stderr: 'connection reset by peer', signal: null };
    }
    return run(command, args, options);
  };
  const first = await initializeWorkspaceState(work, { transport: { ...transport, runCommand } });
  assert.equal(first.governancePublished, false);
  assert.equal(first.publicationIntent.status, 'pending');
  const intentId = first.publicationIntent.intentId;
  failPush = false;
  const resumed = await initializeWorkspaceState(work, { transport: { ...transport, runCommand } });
  assert.equal(resumed.governancePublished, true);
  assert.equal(resumed.publicationIntent.intentId, intentId, 'resume created a duplicate governance intent');
  assert.match(run('git', ['ls-remote', '--heads', 'origin', resumed.governanceBranch], { cwd: work }).stdout,
    new RegExp(`refs/heads/${resumed.governanceBranch}`));
  assert.match(run('git', ['ls-remote', '--heads', 'origin', 'sflow/config'], { cwd: work }).stdout,
    /refs\/heads\/sflow\/config/);
  const intents = await listTransportIntents({ ...transport, includeSucceeded: true });
  assert.equal(intents.filter((intent) => intent.targetRef === `refs/heads/${resumed.governanceBranch}`).length, 1);
});

test('configuration initialization exposes and resumes its exact transport intent', async () => {
  const org = await remotes('config-resume-api');
  const work = path.join(org.base, 'config-resume-work');
  run('git', ['clone', '-q', org['config-resume-api'], work], { cwd: org.base });
  run('git', ['config', 'user.email', 'config-resume@example.test'], { cwd: work });
  run('git', ['config', 'user.name', 'Config Resume Tester'], { cwd: work });
  const transport = {
    env: { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(org.base, 'config-resume-outbox') },
    home: org.base
  };
  let failConfigurationPush = true;
  const runCommand = (command, args, options) => {
    const configurationTarget = args.some((entry) => String(entry).endsWith(':refs/heads/sflow/config'));
    if (failConfigurationPush && args[0] === 'push' && !args.includes('--dry-run') && configurationTarget) {
      return { status: 1, stdout: '', stderr: 'connection reset by peer', signal: null };
    }
    return run(command, args, options);
  };

  let publicationFailure;
  try {
    await initializeWorkspaceState(work, { transport: { ...transport, runCommand } });
  } catch (error) {
    publicationFailure = error;
  }
  assert.equal(publicationFailure?.code, 'CONFIGURATION_PUBLICATION_PENDING');
  assert.match(publicationFailure?.details?.intentId ?? '', /^psh_/);
  const intentId = publicationFailure.details.intentId;
  const retained = (await listTransportIntents({ ...transport, includeSucceeded: true }))
    .find((intent) => intent.intentId === intentId);
  assert.equal(retained?.targetRef, 'refs/heads/sflow/config');
  assert.equal(run('git', ['cat-file', '-e', `${retained.sourceCommit}^{commit}`], {
    cwd: work, allowFailure: true
  }).status, 0, 'the exact unpublished configuration commit remains reachable locally');

  failConfigurationPush = false;
  const pushed = await retryTransportIntent(intentId, {
    ...transport, runCommand, allowNeedsUser: true
  });
  assert.equal(pushed.status, 'succeeded');
  const resumed = await initializeWorkspaceState(work, { transport: { ...transport, runCommand } });
  assert.equal(resumed.governancePublished, true);
  assert.match(run('git', ['ls-remote', '--heads', 'origin', 'sflow/config'], { cwd: work }).stdout,
    /refs\/heads\/sflow\/config/);
  assert.equal((await listTransportIntents({ ...transport, includeSucceeded: true }))
    .filter((intent) => intent.targetRef === 'refs/heads/sflow/config').length, 1);
});

/**
 * Every governed action must be runnable without a terminal.
 *
 * A lens is prompt context — not identity, not approval authority — so asking for it interactively
 * is a convenience, and making it mandatory turned seven commands into things only a human at a TTY
 * could run. That is what made them unreachable from the editor, which is the surface this product
 * is being built on.
 */
test('no governed command is reachable only from a terminal', async () => {
  // The usage block now lives in help-text.mjs so per-command `--help` can read it without importing
  // the CLI. Together these two files are what cli.mjs used to be, which is what this test scans.
  const cli = [
    await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/help-text.mjs', import.meta.url), 'utf8')
  ].join('\n');
  const lines = cli.split('\n');

  const missing = [];
  lines.forEach((line, index) => {
    if (!line.includes('selectAgent(')) return;
    // The escape is on the options object, within a few lines of the call.
    const block = lines.slice(index, index + 8).join('\n');
    if (!/options, 'agent'/.test(block)) missing.push(index + 1);
  });
  assert.deepEqual(missing, [], `selectAgent with no --agent escape at line(s) ${missing.join(', ')}`);

  // The same for the exact-confirmation guard: its refusal names --confirm as the way through, and
  // a call site that does not pass its options makes that instruction a lie.
  const ignored = [];
  lines.forEach((line, index) => {
    if (!line.includes('confirmInitiativeExact(') || line.includes('async function')) return;
    const block = lines.slice(index, index + 6).join('\n');
    if (!/\boptions\b/.test(block)) ignored.push(index + 1);
  });
  assert.deepEqual(ignored, [], `confirmInitiativeExact ignoring --confirm at line(s) ${ignored.join(', ')}`);
});

/**
 * Evidence that cannot satisfy the check it is filed against.
 *
 * A checklist item states which assurance tiers can satisfy it. Recording evidence at any other
 * tier used to succeed: it was stored, listed as active, and permanently inert — the check stayed
 * missing and nothing said why. Found by walking the lifecycle, where a driver filed the same
 * useless attestation thirty times before anyone noticed.
 */
test('evidence is refused at an assurance tier the check cannot accept', async () => {
  const { registerInitiativeEvidence } = await import('../src/initiative-evidence.mjs');
  assert.equal(typeof registerInitiativeEvidence, 'function');

  // The rule itself, stated where the reader of this file can check it against the engine.
  const source = await readFile(new URL('../src/initiative-evidence.mjs', import.meta.url), 'utf8');
  assert.match(source, /check\.acceptedAssurance\.includes\(assurance\)/,
    'the accepted tiers are checked before the evidence is written');
  assert.match(source, /cannot be satisfied by \$\{assurance\} evidence/,
    'and the refusal names the tier that was offered');
  assert.match(source, /It accepts: \$\{check\.acceptedAssurance\.join\(', '\)\}/,
    'and the tiers that would work');
  // A waiver is a decision about the check rather than evidence for it, so it stays exempt.
  assert.match(source, /if \(!decision && !check\.acceptedAssurance/);
});

/**
 * A published Story plan has to contain Stories.
 *
 * The plan template calls itself machine-validated and lists its rules; nothing enforced any of
 * them. The lifecycle walk published the unfilled template — every title empty — through seven
 * governed phases with every artifact pack signed off by three separate authorities, and
 * `initiative breakdown` then reported zero epics and zero stories. The governance was real and it
 * was guarding an empty file.
 */
test('the story plan is validated, so an unfilled template cannot be published', async () => {
  const source = await readFile(new URL('../src/initiative-evidence.mjs', import.meta.url), 'utf8');

  assert.match(source, /async function verifyInitiativeStoryPlan\(/);
  // Wired into publication, beside the impact map, rather than left as a function nobody calls —
  // which is the shape of the bug it exists to prevent.
  assert.match(source, /const plan = await verifyInitiativeStoryPlan\(root, portfolio, initiative, phaseId\);/);
  assert.match(source, /story plan cannot be materialized/);

  // Each rule the template promises.
  assert.match(source, /declares no epics/);
  assert.match(source, /has no title/);
  assert.match(source, /has no stories/);
  assert.match(source, /reuses plan id/);
  assert.match(source, /which the portfolio does not declare/);
  assert.match(source, /which is not in this plan/);
  assert.match(source, /dependencies form a cycle/);
});

/**
 * Starting a materialized Story asks nothing a terminal is needed for.
 *
 * A materialized Story arrives on a branch carrying a governed seed: the title, the description,
 * the acceptance criteria and the suggested work type were all decided during planning and
 * hash-pinned there. `start` asked for every one of them again, interactively, so the last leg of
 * the no-Jira path — plan, materialize, work, merge — could not be reached from any GUI at all.
 * Asking twice also invites a second, divergent answer to a settled question.
 */
test('a seeded Story supplies its own intake, work type and lens', async () => {
  // The usage block now lives in help-text.mjs so per-command `--help` can read it without importing
  // the CLI. Together these two files are what cli.mjs used to be, which is what this test scans.
  const cli = [
    await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/help-text.mjs', import.meta.url), 'utf8')
  ].join('\n');

  // The seed is read, and it decides the intake source rather than a prompt.
  assert.match(cli, /const seeded = existsSync\(path\.join\(root, 'singularity', 'seeds', `\$\{id\}\.yml`\)\)/);
  assert.match(cli, /\?\? \(seeded \? 'manual' : null\)/);
  // Its content answers the manual questions.
  assert.match(cli, /title: seed\.title \?\? id/);
  assert.match(cli, /acceptanceCriteria: \(seed\.acceptanceCriteria \?\? \[\]\)\.join/);
  // And its suggested work type answers the template question.
  assert.match(cli, /seed\?\.suggestedWorkType \?\? null/);

  // Every remaining interactive selection on this path names a flag that avoids it.
  for (const hint of [
    /Pass --jira, or --title with --description/,
    /Pass --work-type <id> to choose one without a terminal/,
    /Pass --agent <id> to choose one without a terminal/
  ]) assert.match(cli, hint);
});

/**
 * A no-tracker Epic can reach its first Story.
 *
 * The plan could only be grown, never started: `adopt` needs a Jira key, `split` needs a Story to
 * split, and the `story-plan.yml` artifact is written *from* the breakdown rather than read into
 * it, so hand-authoring it is overwritten. Planning was therefore a dead end for every Epic without
 * a tracker — which is half the paths the product offers.
 */
test('epic stories add creates the first planned Story without a tracker', async () => {
  const lifecycle = await readFile(new URL('../src/epic-lifecycle.mjs', import.meta.url), 'utf8');
  // The usage block now lives in help-text.mjs so per-command `--help` can read it without importing
  // the CLI. Together these two files are what cli.mjs used to be, which is what this test scans.
  const cli = [
    await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/help-text.mjs', import.meta.url), 'utf8')
  ].join('\n');

  assert.match(lifecycle, /export async function addEpicStory\(/);
  // The epic is created on demand: a plan with no epic is where every new Epic starts.
  assert.match(lifecycle, /breakdown\.epics\.push\(epic\)/);
  // A Story ships from a declared repository, or materialization has nowhere to put the branch.
  assert.match(lifecycle, /is not declared in singularity\/portfolio\.yml/);
  // Wired into the CLI, and documented in the usage where the other subcommands are.
  assert.match(cli, /if \(action === 'add'\) \{/);
  assert.match(cli, /list\|show\|add\|update\|split\|adopt/);
});

/**
 * Parallel discovery is not an escape from its own isolation.
 *
 * Discovery workers must not touch the repository outside their packets, and the builder snapshots
 * the tree before and after to enforce it. But the checkpoint those workers write into lives under
 * the world-model output directory — inside the very tree being watched — so parallel discovery,
 * which is the default, failed its own check by doing exactly what it is designed to do. Every
 * build in the walks that succeeded had passed `--no-parallel`, which never creates a checkpoint;
 * the default path was broken and the workaround hid it.
 */
test('the builder does not flag its own checkpoint as a worker escape', async () => {
  const source = await readFile(new URL('../src/worldmodel.mjs', import.meta.url), 'utf8');

  // Ordinary checkouts retain the output-local checkpoint excluded below. A disposable linked
  // branch worktree uses durable common-Git storage so resume data survives worktree removal.
  assert.match(source, /const checkpointRoot = linkedWorktree/);
  assert.match(source, /path\.join\(outputDirectory, '\.checkpoints'\)/);
  assert.match(source, /path\.join\(commonGitDirectory\(root\), 'singularity-flow', 'world-model-checkpoints'\)/);

  // Asserted as behaviour rather than as a source line. This used to pin the exact text of the
  // exclusion, so tightening it from a substring match to a path-prefix one broke a test that had
  // no opinion about the property it was guarding.
  const config = { outputDir: 'singularity/world-model' };
  assert.deepEqual(outsideBuilderScratch(['singularity/world-model/.checkpoints/k/packets/a.md'], config), []);
  assert.deepEqual(outsideBuilderScratch(['singularity/world-model/.checkpoints'], config), []);

  // The reason the match is by segment rather than by prefix, and the reason it is not by substring
  // either. Some model hosts mirror an absolute path beneath the analysis checkout, so the builder's
  // own packet arrives with the whole home directory in front of it; a prefix test called that a
  // repository mutation and hard-failed the parallel build. Neither property had a test, so the
  // repair could have regressed to either neighbour silently.
  assert.deepEqual(outsideBuilderScratch(['Users/me/repo/singularity/world-model/.checkpoints/k/packets/a.md'], config), []);
  const sibling = 'singularity/world-model/.checkpoints-notes.md';
  assert.deepEqual(outsideBuilderScratch([sibling], config), [sibling], 'a path that merely starts with the checkpoint name is not scratch');

  // Anything else a worker touches is still an escape.
  assert.deepEqual(outsideBuilderScratch(['testfile.md'], config), ['testfile.md']);
  assert.deepEqual(outsideBuilderScratch(['src/app.js'], config), ['src/app.js']);

  // Both guards share one definition. Fixing only the discovery one meant discovery passed and
  // synthesis then failed on the identical file, twenty minutes and 48 AI credits later.
  const guarded = [...source.matchAll(/outsideBuilderScratch\(\s*\n?\s*changedSnapshotPaths|outsideBuilderScratch\(changedSnapshotPaths/g)];
  assert.ok(guarded.length >= 2, `both the discovery and the synthesis guard use it (found ${guarded.length})`);

  // Reading the model already treats .checkpoints as builder-internal; the two agree now.
  const grounding = await readFile(new URL('../src/grounding.mjs', import.meta.url), 'utf8');
  assert.match(grounding, /entry\.name === '\.checkpoints'/);

  // And the guard still names what it found, in both places.
  assert.match(source, /World-model discovery left the analysis worktree modified/);
  assert.match(source, /World-model synthesis modified the analysis worktree/);
});

/**
 * The workspace is the context everything else hangs off.
 *
 * Work happens in a workspace: it says which capabilities are being worked on and where. So it is
 * the first thing chosen and the first section in the navigation surface, and the governed repository is
 * resolved from it before the open folder is even consulted. It used to be the last view, below the
 * things that depend on it, and a fallback for whatever folder happened to be open.
 */
test('choosing a workspace is what scopes the rest', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const views = manifest.contributes.views.singularityFlowNavigator.map((view) => view.id);
  assert.equal(views[0], 'singularityFlow.navigation', 'one navigation surface leads');
  const sidebar = await readFile(new URL('../apps/vscode/src/views/sidebar.ts', import.meta.url), 'utf8');
  assert.ok(sidebar.indexOf("'workspaces'") < sidebar.indexOf("'lifecycle'"),
    'workspaces lead the sections inside the navigation surface');

  // Choosing one is an action on the row, and it is the CLI's own machine-wide selection so the
  // terminal and the editor agree about where you are.
  const commands = manifest.contributes.commands.map((entry) => entry.command);
  assert.ok(commands.includes('singularityFlow.switchWorkspace'));
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /\['workspace', 'use', target,[\s\S]*'--json'\]/);

  // Choosing never opens a folder or creates another window. If activation started with no active
  // workspace, the same window reloads once so Lifecycle and Configuration can bind to the selected
  // repository instead of remaining stuck in their empty state.
  const selecting = extension.slice(extension.indexOf('async function selectWorkspace'),
    extension.indexOf("registerCommand('singularityFlow.openWorkspace'"));
  assert.doesNotMatch(selecting, /vscode\.openFolder/,
    'selecting a workspace never opens a folder or creates another window');
  assert.match(selecting, /if \(!workspaceSelected\.length\)[\s\S]*reloadWindow/,
    'the first selection reloads the same window only when repository services were never created');

  // Resolution consults the active workspace before the open folder, not after it.
  const active = extension.indexOf('const active = await activeWorkspaceRepository(context, output);');
  const folder = extension.indexOf('const folder = vscode.workspace.workspaceFolders?.[0];',
    extension.indexOf('async function resolveGovernedRepository'));
  assert.ok(active > 0 && folder > active, 'the active workspace is consulted first');

  // And it reads the shape the CLI emits. Ordering two lines correctly is worth nothing if the
  // first one reads a field that does not exist: this looked for `workspace.path` in a flat object
  // and therefore resolved to nothing every time, so the open folder always won.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapAndMerge(org.platform, { capabilityId: 'commerce', kind: 'delivery', repositoryUrl: org.platform });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  // Both the registry and the selection are redirected: the selection is machine-wide, and a test
  // that wrote to the real one would change which workspace the person running it is working in.
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(org.base, 'registry.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(org.base, 'active-workspace.json')
  };
  const created = JSON.parse(execFileSync(process.execPath,
    [cli, 'workspace', 'create', '--local', '--json', '--id', 'commerce',
      '--base', path.join(org.base, 'workspaces'), '--lead', 'platform',
      '--repository', `platform=${org.platform}`, '--confirm', 'commerce', '--no-clone'],
    { encoding: 'utf8', env }));
  execFileSync(process.execPath, [cli, 'workspace', 'use', created.workspace.id, '--json'],
    { encoding: 'utf8', env });
  const shape = JSON.parse(execFileSync(process.execPath, [cli, 'workspace', 'current', '--json'],
    { encoding: 'utf8', env }));
  assert.equal(shape.workspace, undefined, 'the payload is flat, not nested under `workspace`');
  const resolver = extension.slice(extension.indexOf('async function activeWorkspaceRepository'));
  const code = resolver.slice(0, resolver.indexOf('\n}'))
    // Comments name the field that used to be read, which is the whole point of the comment.
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const read = [...code.matchAll(/current\.(\w+)/g)].map((match) => match[1]);
  assert.ok(read.length, 'the resolver reads the payload');
  for (const field of read) {
    assert.ok(field in shape, `\`workspace current --json\` emits '${field}'`);
  }

  // Lifecycle now points up to the Workspace surface instead of duplicating its setup actions.
  const tree = await readFile(new URL('../apps/vscode/src/views/tree-model.ts', import.meta.url), 'utf8');
  assert.match(tree, /label: nothingSelected \? 'Choose a workspace to begin' : label/);
  assert.match(tree, /description: repositoryUnavailable \? 'repository required' : 'intake and delivery'/);
});

/**
 * Exactly one workspace is the one being worked in.
 *
 * The registry de-duplicates by path, so creating the same `--id` in two directories keeps both
 * entries with that id. `workspace list` matched the active selection on id alone and marked every
 * one of them — four rows all reading "working here", which is the one question that column exists
 * to answer. The selection records the path too, so matching on both is exact.
 */
test('the active workspace is matched on identifier and path, not identifier alone', async () => {
  // The usage block now lives in help-text.mjs so per-command `--help` can read it without importing
  // the CLI. Together these two files are what cli.mjs used to be, which is what this test scans.
  const cli = [
    await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/help-text.mjs', import.meta.url), 'utf8')
  ].join('\n');
  assert.match(cli, /workspace\.id === active\?\.workspaceId/);
  assert.match(cli, /path\.resolve\(workspace\.path\) === path\.resolve\(active\.workspacePath\)/);

  // A registry that already holds duplicate ids is shown rather than silently tolerated: every
  // lookup by id is ambiguous, including `workspace use`.
  const model = await readFile(
    new URL('../apps/vscode/src/views/workspaces-model.ts', import.meta.url), 'utf8');
  assert.match(model, /sharesId: \(ids\.get\(\(entry\.id \?\? ''\)\.toLowerCase\(\)\) \?\? 0\) > 1/);
  const trees = await readFile(
    new URL('../apps/vscode/src/views/navigation-trees.ts', import.meta.url), 'utf8');
  assert.match(trees, /shares the id \$\{row\.id\}/);
  assert.match(trees, /row\.collides \|\| row\.sharesId \|\| unavailable \? 'statusWarning'/);
});

/**
 * A world model may live on the state branch, in the working tree, or in both.
 *
 * The state branch wins. It is the governed copy — written deliberately, and never rewritten by a
 * rebase of the code — whereas a working tree holds whatever the last local build happened to
 * leave. Reading whichever was checked out is how two people on the same commit ground a phase
 * differently and never find out.
 */
test('the state branch world model takes precedence over the working tree', async () => {
  const { resolveWorldModelSource } = await import('../src/grounding.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-'));
  const repo = path.join(base, 'repo');
  run('git', ['init', '-q', '-b', 'main', repo], { cwd: base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'A B'], { cwd: repo });

  const outputDir = 'singularity/world-model';
  const write = async (text) => {
    await mkdir(path.join(repo, outputDir, 'core'), { recursive: true });
    await writeFile(path.join(repo, outputDir, 'manifest.json'), '{"schema_version":1}');
    await writeFile(path.join(repo, outputDir, 'core', 'summary.md'), text);
    run('git', ['add', '-A'], { cwd: repo });
    run('git', ['commit', '-qm', 'model'], { cwd: repo });
  };
  await write('from the working tree\n');
  run('git', ['checkout', '-q', '--orphan', 'state'], { cwd: repo });
  run('git', ['rm', '-rqf', '.'], { cwd: repo, allowFailure: true });
  await write('from the state branch\n');
  run('git', ['checkout', '-q', 'main'], { cwd: repo });

  const summary = async (found) =>
    (await readFile(path.join(found.directory, 'core', 'summary.md'), 'utf8')).trim();

  const governed = await resolveWorldModelSource(repo, { outputDir, ledger: { branch: 'state' } });
  assert.equal(governed.source, 'state-branch');
  assert.equal(await summary(governed), 'from the state branch');

  // A branch that carries no model is the ordinary state of a repository built only locally, so it
  // falls back rather than failing.
  const absent = await resolveWorldModelSource(repo, { outputDir, ledger: { branch: 'nowhere' } });
  assert.equal(absent.source, 'worktree');
  assert.equal(await summary(absent), 'from the working tree');

  // And with no branch configured at all, the working tree is simply the answer.
  const plain = await resolveWorldModelSource(repo, { outputDir });
  assert.equal(plain.source, 'worktree');
  assert.equal(await summary(plain), 'from the working tree');
});

/**
 * Editing a set of links changes the entries you named.
 *
 * `documentation` and `resources` are sets, and the first version of this replaced the whole set on
 * every edit: adding a runbook silently dropped the Confluence page somebody had recorded weeks
 * earlier, and nothing said so. An entry given an empty value is removed, which is how one is
 * cleared deliberately rather than by accident.
 */
test('documentation and resources merge on edit rather than replacing', async () => {
  const { editCapability } = await import('../src/capabilities.mjs');
  const { CAPABILITIES_PATH } = await import('../src/capabilities.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-links-'));
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, CAPABILITIES_PATH), [
    'version: 1',
    'capabilities:',
    '  payments: { kind: collection, type: tech, parent: null }',
    ''
  ].join('\n'));

  const read = async () => (await import('yaml')).default
    .parse(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8')).capabilities.payments;

  await editCapability(root, 'payments', { documentation: { confluence: 'https://wiki/pay' } });
  await editCapability(root, 'payments', { documentation: { runbook: 'docs/run.md' } });
  const both = await read();
  assert.deepEqual(both.documentation, {
    confluence: 'https://wiki/pay', runbook: 'docs/run.md'
  }, 'adding one link keeps the others');

  // An empty value clears that entry and only that entry.
  await editCapability(root, 'payments', { documentation: { confluence: '' } });
  assert.deepEqual((await read()).documentation, { runbook: 'docs/run.md' });

  // And a map emptied of every entry is absent rather than an empty object.
  await editCapability(root, 'payments', { documentation: { runbook: '' } });
  assert.equal((await read()).documentation, undefined);
});

test('capability readiness shares one asynchronous remote session across its worker pool', async () => {
  const source = await readFile(new URL('../src/organisation.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function capabilityReadiness(');
  const end = source.indexOf('\nexport function composeCapabilityWorldModel(', start);
  assert.ok(start >= 0 && end > start, 'capability readiness implementation is present');
  const implementation = source.slice(start, end);

  const session = implementation.indexOf('const session = new GitRemoteSession({ env: gitEnv });');
  const workers = implementation.indexOf('const resolved = await mapLimit(');
  assert.ok(session >= 0 && session < workers,
    'the operation-scoped session must be created before workers fan out');
  assert.match(implementation, /await session\.observeAsync\(/,
    'remote advertisements must not block the event loop inside a worker');
  assert.equal((implementation.match(/new GitRemoteSession\(\{ env: gitEnv \}\)/g) ?? []).length, 1,
    'identical remotes must share and coalesce through one session');
  assert.doesNotMatch(implementation, /session\.observe\(/,
    'the synchronous remote probe must not return to the readiness critical path');
});

test('capability onboarding and review keep every direct remote Git call off the event loop', async () => {
  const source = await readFile(new URL('../src/organisation.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function recoverMergedProposalRef(');
  const end = source.indexOf('\nexport async function initializeWorkspaceState(', start);
  assert.ok(start >= 0 && end > start, 'capability onboarding implementation is present');
  const capabilityOperations = source.slice(start, end);

  assert.match(capabilityOperations, /await runRemoteGitAsync\(/,
    'capability operations must cross the supervised asynchronous Git boundary');
  assert.doesNotMatch(capabilityOperations, /\brunRemoteGit\(/,
    'an async capability operation still blocks the event loop with remote Git');
  assert.doesNotMatch(capabilityOperations, /\.observe\(/,
    'an async capability operation still uses the synchronous remote observation API');
});

test('an unreachable capability authority reaches its deadline without blocking the event loop', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-deadline-'));
  const bin = path.join(root, 'bin');
  const cache = path.join(root, 'cache');
  await mkdir(bin, { recursive: true });
  const fakeGit = path.join(bin, 'git');
  await writeFile(fakeGit, [
    '#!/usr/bin/env node',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));
  await chmod(fakeGit, 0o755);

  const keys = [
    'PATH',
    'SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS',
    'SINGULARITY_FLOW_GIT_TERMINATION_GRACE_MS',
    'SINGULARITY_FLOW_ORGANISATION_CACHE'
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS = '30';
  process.env.SINGULARITY_FLOW_GIT_TERMINATION_GRACE_MS = '40';
  process.env.SINGULARITY_FLOW_ORGANISATION_CACHE = cache;

  let eventLoopAdvanced = false;
  const tick = setTimeout(() => { eventLoopAdvanced = true; }, 5);
  const startedAt = performance.now();
  try {
    await assert.rejects(
      readOrganisation('https://performance.invalid/capability-authority.git', { refresh: true }),
      (error) => error?.code === 'CAPABILITY_AUTHORITY_UNAVAILABLE'
    );
  } finally {
    clearTimeout(tick);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  assert.equal(eventLoopAdvanced, true,
    'the event loop could not advance while capability Git waited for its deadline');
  assert.ok(elapsedMs < 500, `capability remote deadline escaped its bounded grace (${elapsedMs}ms)`);
});

/**
 * A grouping's world model is composed from its children, and stored nowhere.
 *
 * A capability that ships has one: the model in its lead repository. A capability that groups
 * others has no repository to hold one, so its model is the union of what is beneath it, computed
 * when asked.
 *
 * Storing it would be the obvious alternative and it is the wrong one. A grouping's model contains
 * nothing that is not already in its children, so a stored copy is a second thing to build, to
 * invalidate when a child rebuilds, and to be wrong. Composition cannot go stale because there is
 * nothing to go stale.
 */
test('a grouping composes its world model from the capabilities beneath it', async () => {
  const { composeCapabilityWorldModel } = await import('../src/organisation.mjs');
  const organisation = {
    capabilities: [{
      id: 'commerce', name: 'Commerce', repositories: [], children: [
        {
          id: 'payments', name: 'Payments', repositories: ['api', 'web'], leadRepository: 'api',
          children: [{ id: 'payments-api', name: 'Payments API', repositories: [], children: [] }]
        },
        { id: 'storefront', name: 'Storefront', repositories: ['shop'], children: [] },
        { id: 'research', name: 'Research', repositories: [], children: [] }
      ]
    }]
  };
  const readiness = {
    api: { worldModel: 'state-branch' },
    shop: { worldModel: null },
    web: { worldModel: 'main' }
  };

  const commerce = composeCapabilityWorldModel(organisation, 'commerce', readiness);
  assert.equal(commerce.composed, true);
  // Every shipping capability beneath it, however deep — and only the shipping ones.
  assert.deepEqual(commerce.sources.map((source) => source.capability), ['payments', 'storefront']);
  assert.equal(commerce.sources[0].branch, 'state-branch');
  // A child with no model built is reported as absent rather than omitted: a partial view that
  // looks complete is worse than one that says it is partial.
  assert.equal(commerce.sources[1].present, false);

  // A capability that ships has its lead's model. The other repositories are where its code lives,
  // not where its understanding of itself lives.
  const payments = composeCapabilityWorldModel(organisation, 'payments', readiness);
  assert.equal(payments.composed, false);
  assert.deepEqual(payments.sources.map((source) => source.repository), ['api']);
  assert.deepEqual(payments.alsoShipsFrom, ['web']);

  // A grouping with nothing shipping beneath it composes from nothing, which is a state to report
  // rather than an error.
  const research = composeCapabilityWorldModel(organisation, 'research', readiness);
  assert.equal(research.composed, true);
  assert.deepEqual(research.sources, []);

  assert.throws(() => composeCapabilityWorldModel(organisation, 'nope', readiness), /Unknown capability/);
});

/**
 * Work does not always begin at the beginning.
 *
 * An Initiative whose discovery happened elsewhere — in a document, in another tool, last quarter —
 * should enter at the stage it has actually reached. The alternative is faking the earlier phases
 * to get past them, which puts approvals in the record that nobody gave.
 *
 * So the phases before the entry point are marked skipped, never approved, and they carry the
 * reason. A gate that never happened must never look like one that did.
 */
test('an initiative can enter its lifecycle at a later phase', async () => {
  const source = await readFile(new URL('../src/initiative-state.mjs', import.meta.url), 'utf8');

  // Skipped, with a reason, and explicitly not approved.
  assert.match(source, /phase\.status = 'skipped';/);
  assert.match(source, /phase\.skippedReason = `Initiative entered the lifecycle at \$\{entryPhase\}\.`/);
  assert.doesNotMatch(source, /phase\.status = 'approved';\s*\n\s*phase\.skipped/);
  // The entry point drives both the current phase and the opening history entry, so the record says
  // where it began rather than implying the first phase.
  assert.match(source, /currentPhase: entryPhase,/);
  assert.match(source, /skipping \$\{skipped\.join\(', '\)\}/);
  // An unknown phase is refused with the ones that exist, rather than silently starting at the top.
  assert.match(source, /has no phase '\$\{startPhase\}'\. Its phases are:/);

  // And a skipped phase reads differently from a completed one.
  // The usage block now lives in help-text.mjs so per-command `--help` can read it without importing
  // the CLI. Together these two files are what cli.mjs used to be, which is what this test scans.
  const cli = [
    await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/help-text.mjs', import.meta.url), 'utf8')
  ].join('\n');
  assert.match(cli, /skipped: '–'/);
  assert.match(cli, /\[--start-phase ID\]/);
});

test('only reviewed capability configuration can be published to the state branch', async () => {
  // A proposal is neither default-branch configuration nor governed state. Only after the normal
  // review merge may the explicit publisher refresh the orphan projection.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  const mapped = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  assert.equal(mapped.state.published, false);
  assert.match(mapped.state.reason, /awaiting review/);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/state'], {
    cwd: org.platform, allowFailure: true
  }).status, 1);
  await mergeProposal(org.platform, mapped);

  const publishedInitial = await publishOrganisationCapabilityMap(org.platform);
  assert.equal(publishedInitial.published, true);
  assert.equal(publishedInitial.branch, 'state');

  const lead = path.join(org.base, 'lead');
  run('git', ['clone', '-q', org.platform, lead], { cwd: org.base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: lead });
  run('git', ['config', 'user.name', 'A B'], { cwd: lead });

  const edited = await editCapabilityInOrganisation(org.platform, 'commerce', { name: 'Commerce platform' });
  assert.equal(edited.state.published, false);

  // Neither governed copy sees the unreviewed edit.
  run('git', ['fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state'], { cwd: lead });
  assert.doesNotMatch(
    run('git', ['show', 'origin/state:singularity/capabilities.yml'], { cwd: lead }).stdout,
    /Commerce platform/);
  run('git', ['fetch', '-q', 'origin', '+refs/heads/sflow/config:refs/remotes/origin/sflow/config'], { cwd: lead });
  assert.doesNotMatch(
    run('git', ['show', 'origin/sflow/config:singularity/capabilities.yml'], { cwd: lead }).stdout,
    /Commerce platform/);

  await mergeProposal(org.platform, edited);
  const publishedEdit = await publishOrganisationCapabilityMap(org.platform);
  assert.equal(publishedEdit.published, true);
  assert.equal(publishedEdit.branch, 'state');

  // Readable straight from the remote, with no checkout — which is how the readers reach it.
  run('git', ['fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state'], { cwd: lead });
  const published = run('git', ['show', 'origin/state:singularity/capabilities.yml'], { cwd: lead }).stdout;
  assert.match(published, /Commerce platform/);

  // And the reviewed configuration branch has it: the state branch is the projection, not a bypass.
  run('git', ['fetch', '-q', 'origin', '+refs/heads/sflow/config:refs/remotes/origin/sflow/config'], { cwd: lead });
  assert.match(run('git', ['show', 'origin/sflow/config:singularity/capabilities.yml'], { cwd: lead }).stdout,
    /Commerce platform/);

  // Create and remove use the same reviewed authority path. The VS Code designer must not fall
  // back to editing whichever application branch happens to be checked out for these operations.
  const added = await editCapabilityInOrganisation(org.platform, 'catalog', {
    name: 'Catalog', kind: 'collection', parent: 'commerce'
  }, { mode: 'add' });
  assert.equal(added.reviewRequired, true);
  await mergeProposal(org.platform, added);
  await publishOrganisationCapabilityMap(org.platform);
  assert.match((await readOrganisation(org.platform)).capabilities[0].children[0].name, /Catalog/);

  const nested = await editCapabilityInOrganisation(org.platform, 'catalog-search', {
    name: 'Catalog search', kind: 'collection', parent: 'catalog'
  }, { mode: 'add' });
  await mergeProposal(org.platform, nested);
  await publishOrganisationCapabilityMap(org.platform);

  const removed = await editCapabilityInOrganisation(org.platform, 'catalog', {}, {
    mode: 'remove', reparentChildrenTo: 'commerce'
  });
  assert.equal(removed.reviewRequired, true);
  assert.deepEqual(removed.reparentedChildren, ['catalog-search']);
  await mergeProposal(org.platform, removed);
  await publishOrganisationCapabilityMap(org.platform);
  const afterRemoval = await readOrganisation(org.platform);
  assert.deepEqual(afterRemoval.capabilities[0].children.map((child) => child.id), ['catalog-search'],
    'remote authority receives the removal and reverse relationship update as one proposal');

  await assert.rejects(
    () => editCapabilityInOrganisation(org.platform, 'commerce', {}, { mode: 'overwrite' }),
    /must be 'add', 'set', or 'remove'/);
});

test('local capability authoring never creates or moves governed state', async () => {
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const proposal = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection'
  });
  await mergeProposal(org.platform, proposal);
  await publishOrganisationCapabilityMap(org.platform);
  const stateBefore = run('git', ['rev-parse', 'state'], { cwd: org.platform }).stdout.trim();
  const checkout = path.join(org.base, 'local-authoring');
  run('git', ['clone', '-q', '--branch', 'sflow/config', org.platform, checkout], { cwd: org.base });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

  const result = JSON.parse(execFileSync(process.execPath, [
    cli, 'capability', 'set', 'commerce', '--name', 'Local draft', '--json'
  ], { cwd: checkout, encoding: 'utf8', env: process.env }));

  assert.equal(result.state.published, false);
  assert.match(result.state.reason, /local authoring never publishes/);
  assert.match(await readFile(path.join(checkout, 'singularity/capabilities.yml'), 'utf8'), /Local draft/);
  assert.equal(run('git', ['rev-parse', 'state'], { cwd: org.platform }).stdout.trim(), stateBefore);
  assert.doesNotMatch(run('git', ['show', 'state:singularity/capabilities.yml'], {
    cwd: org.platform
  }).stdout, /Local draft/);
});

test('a published world model is the one that gets read, including from a clone that only fetched', async () => {
  // Closing the loop the other way round. The reader preferred the state branch and nothing wrote
  // it, so the preference never fired; this asserts that what the publisher produces is what the
  // reader accepts, rather than testing a branch built by hand in the test.
  const { resolveWorldModelSource } = await import('../src/grounding.mjs');
  const { publishToStateBranch } = await import('../src/ledger.mjs');
  const org = await remotes('api');
  const repo = path.join(org.base, 'work');
  run('git', ['clone', '-q', org.api, repo], { cwd: org.base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'A B'], { cwd: repo });

  const outputDir = 'singularity/world-model';
  const ledger = { enabled: true, branch: 'state', remote: 'origin' };
  await mkdir(path.join(repo, outputDir, 'core'), { recursive: true });
  await writeFile(path.join(repo, outputDir, 'manifest.json'), '{"schema_version":1}');
  await writeFile(path.join(repo, outputDir, 'core', 'summary.md'), 'from the working tree\n');

  const published = await publishToStateBranch(repo, ledger, {
    [`${outputDir}/manifest.json`]: '{"schema_version":1}',
    [`${outputDir}/core/summary.md`]: 'from the state branch\n'
  }, '[world-model] repository');
  assert.equal(published.changed, true);

  const summary = async (found) =>
    (await readFile(path.join(found.directory, 'core', 'summary.md'), 'utf8')).trim();

  // On the machine that published it. The push updates the remote, so a local ref left behind here
  // would mean the publisher is the one party that cannot see what it just published.
  const here = await resolveWorldModelSource(repo, { outputDir, ledger });
  assert.equal(here.source, 'state-branch');
  assert.equal(here.authority, 'remote-governed');
  assert.equal(here.refresh, 'refreshed');
  assert.equal(await summary(here), 'from the state branch');

  // And on a clone that has fetched the branch without checking it out — which is every machine
  // that has never published. Naming the branch plainly finds nothing there.
  const fresh = path.join(org.base, 'fresh');
  run('git', ['clone', '-q', org.api, fresh], { cwd: org.base });
  run('git', ['fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state'], { cwd: fresh });
  assert.equal(run('git', ['rev-parse', '--verify', 'refs/heads/state'], { cwd: fresh, allowFailure: true }).status,
    128, 'no local branch, which is the case this covers');
  const elsewhere = await resolveWorldModelSource(fresh, { outputDir, ledger });
  assert.equal(elsewhere.source, 'state-branch');
  assert.equal(elsewhere.authority, 'remote-governed');
  assert.equal(await summary(elsewhere), 'from the state branch');
});

test('world-model resolution reports remote, local, offline, unpublished, absent, and diverged authority precisely', async () => {
  const { resolveWorldModelSource } = await import('../src/grounding.mjs');
  const { publishToStateBranch } = await import('../src/ledger.mjs');
  const outputDir = 'singularity/world-model';
  const ledger = { enabled: true, branch: 'state', remote: 'origin' };
  const model = (summary) => ({
    [`${outputDir}/manifest.json`]: '{"schema_version":1}',
    [`${outputDir}/core/summary.md`]: `${summary}\n`
  });

  // A reachable remote with no state branch is an ordinary first run, not an offline failure.
  const emptyOrg = await remotes('empty');
  const empty = path.join(emptyOrg.base, 'empty-work');
  run('git', ['clone', '-q', emptyOrg.empty, empty], { cwd: emptyOrg.base });
  const absent = await resolveWorldModelSource(empty, { outputDir, ledger });
  assert.equal(absent.authority, 'absent');
  assert.equal(absent.refresh, 'remote-absent');

  // A repository with no remote can still have a deliberate local state branch, but it must not
  // be described as remote-governed.
  const local = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-local-authority-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: local });
  run('git', ['config', 'user.email', 'local@example.com'], { cwd: local });
  run('git', ['config', 'user.name', 'Local User'], { cwd: local });
  await writeFile(path.join(local, 'README.md'), '# local\n');
  run('git', ['add', '.'], { cwd: local });
  run('git', ['commit', '-qm', 'initialize'], { cwd: local });
  await publishToStateBranch(local, ledger, model('local state'), '[world-model] local');
  const localOnly = await resolveWorldModelSource(local, { outputDir, ledger });
  assert.equal(localOnly.authority, 'local-only');
  assert.equal(localOnly.ref, 'refs/heads/state');

  const org = await remotes('shared');
  const repo = path.join(org.base, 'shared-work');
  run('git', ['clone', '-q', org.shared, repo], { cwd: org.base });
  run('git', ['config', 'user.email', 'publisher@example.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'Publisher'], { cwd: repo });
  await publishToStateBranch(repo, ledger, model('remote state'), '[world-model] remote');
  const governed = await resolveWorldModelSource(repo, { outputDir, ledger });
  assert.equal(governed.authority, 'remote-governed');

  // Retain a valid tracking ref, then make the configured remote unreachable. The cached governed
  // copy remains usable, but the result must say that freshness could not be verified.
  run('git', ['remote', 'set-url', 'origin', path.join(org.base, 'missing.git')], { cwd: repo });
  const offline = await resolveWorldModelSource(repo, { outputDir, ledger, stateFetchTimeoutMs: 500 });
  assert.equal(offline.authority, 'offline-unverified');
  assert.equal(offline.refresh, 'offline-cached');
  assert.equal(offline.ref, 'refs/remotes/origin/state');
  run('git', ['remote', 'set-url', 'origin', org.shared], { cwd: repo });

  // A local state commit that has not reached the remote is observable even though readers keep
  // selecting the remote-governed snapshot as their materialization base.
  const localStateWorktree = path.join(org.base, 'local-state-worktree');
  run('git', ['worktree', 'add', '-q', localStateWorktree, 'state'], { cwd: repo });
  await writeFile(path.join(localStateWorktree, outputDir, 'core', 'summary.md'), 'unpublished local state\n');
  run('git', ['add', '.'], { cwd: localStateWorktree });
  run('git', ['commit', '-qm', 'local state change'], { cwd: localStateWorktree });
  run('git', ['worktree', 'remove', '-f', localStateWorktree], { cwd: repo });
  const unpublished = await resolveWorldModelSource(repo, { outputDir, ledger });
  assert.equal(unpublished.authority, 'unpublished-local-state');
  assert.equal(unpublished.ref, 'refs/remotes/origin/state');

  // A second contributor advances the remote from the old common parent. The first contributor's
  // unpublished state and the remote are now siblings, which must be surfaced as divergence.
  const other = path.join(org.base, 'other-work');
  run('git', ['clone', '-q', org.shared, other], { cwd: org.base });
  run('git', ['config', 'user.email', 'other@example.com'], { cwd: other });
  run('git', ['config', 'user.name', 'Other User'], { cwd: other });
  run('git', ['fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state'], { cwd: other });
  const remoteStateWorktree = path.join(org.base, 'remote-state-worktree');
  run('git', ['worktree', 'add', '-q', '-b', 'remote-state-change', remoteStateWorktree, 'origin/state'], { cwd: other });
  await writeFile(path.join(remoteStateWorktree, outputDir, 'core', 'summary.md'), 'independent remote state\n');
  run('git', ['add', '.'], { cwd: remoteStateWorktree });
  run('git', ['commit', '-qm', 'remote state change'], { cwd: remoteStateWorktree });
  run('git', ['push', '-q', 'origin', 'HEAD:state'], { cwd: remoteStateWorktree });
  run('git', ['worktree', 'remove', '-f', remoteStateWorktree], { cwd: other });
  const diverged = await resolveWorldModelSource(repo, { outputDir, ledger });
  assert.equal(diverged.authority, 'diverged');
  assert.equal(diverged.diverged, true);
});

test('the state-branch world model resolves without a shell on PATH', async () => {
  // This read used `bash -c 'git archive … | tar -x'` and falls back to the working tree on
  // failure by design. On a machine with no bash — every stock Windows one — that fallback fired
  // every time, so "the state branch wins" quietly stopped holding: two people on the same commit
  // grounded a phase from different bytes and nothing reported it.
  const { resolveWorldModelSource } = await import('../src/grounding.mjs');
  const { publishToStateBranch } = await import('../src/ledger.mjs');
  const org = await remotes('api');
  const repo = path.join(org.base, 'work');
  run('git', ['clone', '-q', org.api, repo], { cwd: org.base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'A B'], { cwd: repo });

  const outputDir = 'singularity/world-model';
  const ledger = { enabled: true, branch: 'state', remote: 'origin' };
  await mkdir(path.join(repo, outputDir), { recursive: true });
  await writeFile(path.join(repo, outputDir, 'manifest.json'), '{"schema_version":1}');
  await writeFile(path.join(repo, outputDir, 'summary.md'), 'from the working tree\n');
  await publishToStateBranch(repo, ledger, {
    [`${outputDir}/manifest.json`]: '{"schema_version":1}',
    [`${outputDir}/summary.md`]: 'from the state branch\n'
  }, '[world-model] repository');

  // The extraction is cached in the temp directory by tree hash, so a previous run would answer
  // this test instead of the code under it.
  const treeSha = run('git', ['rev-parse', `state:${outputDir}`], { cwd: repo }).stdout.trim();
  const cache = path.join(os.tmpdir(), `singularity-flow-world-model-${treeSha}`);
  await rm(cache, { recursive: true, force: true });
  // Simulate a process dying after it wrote the manifest but before it extracted the rest. Merely
  // finding manifest.json used to bless this partial directory permanently.
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'manifest.json'), '{"schema_version":1}');

  // A PATH with none of the usual shells on it. `git` and `tar` are resolved from their real
  // locations, so the only thing missing is the shell the old implementation needed.
  const shellless = await mkdtemp(path.join(os.tmpdir(), 'sflow-noshell-'));
  for (const tool of ['git', 'tar']) {
    const resolved = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
    await symlink(resolved, path.join(shellless, tool));
  }
  const realPath = process.env.PATH;
  process.env.PATH = shellless;
  try {
    const found = await resolveWorldModelSource(repo, { outputDir, ledger });
    assert.equal(found.source, 'state-branch', 'the governed copy is what gets read');
    assert.equal(found.authority, 'remote-governed');
    assert.equal((await readFile(path.join(found.directory, 'summary.md'), 'utf8')).trim(),
      'from the state branch');
  } finally {
    process.env.PATH = realPath;
  }
});
