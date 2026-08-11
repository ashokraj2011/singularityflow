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
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { outsideBuilderScratch } from '../src/worldmodel.mjs';
import {
  activateCapabilityProposal, editCapabilityInOrganisation, initializeWorkspaceState,
  inspectCapabilityProposal, listCapabilityProposals, mapCapability, readOrganisation,
  publishOrganisationCapabilityMap, resolveWorkspacePlan
} from '../src/organisation.mjs';

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

test('the first capability governs the repository it is mapped into', async () => {
  // The product's one circular dependency: mapping a capability needed a map, and the only way to
  // get a map was to map a capability. Refusing here is what made starting impossible.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  const first = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'collection',
    metadata: { applicationId: 'APP-1001', costCenter: 'CC-42' }
  });
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
  // The placeholder root `init` writes gives way to the capability actually being mapped, rather
  // than colliding with it — a tree may have exactly one root.
  assert.doesNotMatch(map, /placeholder|your-capability/i);

  // And the second one finds the map already there rather than governing again.
  await mapAndMerge(org.platform, {
    capabilityId: 'payments', name: 'Payments', kind: 'collection', parent: 'commerce'
  });
  const both = run('git', ['show', 'sflow/config:singularity/capabilities.yml'], { cwd: org.platform }).stdout;
  assert.match(both, /parent: commerce/);
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

  const inspected = await inspectCapabilityProposal(org.platform, proposed.branch);
  assert.equal(inspected.proposalCommit, proposed.commit);
  assert.match(inspected.diff, /calculator/);
  await assert.rejects(
    activateCapabilityProposal(org.platform, proposed.branch, { confirm: inspected.proposalCommit.slice(0, 12) }),
    /Confirmation must be the exact proposal commit/
  );
  assert.equal(run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim(), mainBefore);

  const activated = await activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: inspected.proposalCommit
  });
  assert.equal(activated.alreadyMerged, false);
  assert.equal(activated.targetBranch, 'sflow/config');
  assert.match(run('git', ['show', 'sflow/config:singularity/capabilities.yml'], {
    cwd: org.platform
  }).stdout, /calculator/);
  assert.equal(run('git', ['rev-parse', 'main'], { cwd: org.platform }).stdout.trim(), mainBefore,
    'activating governed configuration never writes the application default branch');
  assert.equal(activated.projection.published, true);
  assert.match(run('git', ['show', 'state:singularity/capabilities.yml'], {
    cwd: org.platform
  }).stdout, /calculator/);
  assert.deepEqual(await listCapabilityProposals(org.platform), []);
  const history = await listCapabilityProposals(org.platform, { includeMerged: true });
  assert.equal(history[0].merged, true);
  assert.match(history[0].diff, /calculator/, 'an activated proposal retains a reviewable exact diff');
});

test('capability activation respects configuration branch protection and retains the proposal', async () => {
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

  await assert.rejects(activateCapabilityProposal(org.platform, proposed.branch, {
    confirm: proposed.commit
  }), /rejected the normal push.*review controls/s);
  assert.equal(run('git', ['rev-parse', 'sflow/config'], { cwd: org.platform }).stdout.trim(), configBefore);
  const pending = await listCapabilityProposals(org.platform);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].branch, proposed.branch);
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

  const first = await initializeWorkspaceState(work);
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
  const second = await initializeWorkspaceState(work);
  assert.equal(second.governed, true);
  assert.equal(second.existed, true);
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

  // The checkpoint genuinely lives under the output directory, which is why the exclusion is needed
  // rather than merely convenient.
  assert.match(source, /const checkpointRoot = path\.join\(outputDirectory, '\.checkpoints'\)/);

  // Asserted as behaviour rather than as a source line. This used to pin the exact text of the
  // exclusion, so tightening it from a substring match to a path-prefix one broke a test that had
  // no opinion about the property it was guarding.
  const config = { outputDir: 'singularity/world-model' };
  assert.deepEqual(outsideBuilderScratch(['singularity/world-model/.checkpoints/k/packets/a.md'], config), []);
  assert.deepEqual(outsideBuilderScratch(['singularity/world-model/.checkpoints'], config), []);
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
  assert.match(extension, /\['workspace', 'use', target, '--json'\]/);

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
  const active = extension.indexOf('const active = await activeWorkspaceLead(context, output);');
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
  const resolver = extension.slice(extension.indexOf('async function activeWorkspaceLead'));
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

  const removed = await editCapabilityInOrganisation(org.platform, 'catalog', {}, { mode: 'remove' });
  assert.equal(removed.reviewRequired, true);
  await mergeProposal(org.platform, removed);
  await publishOrganisationCapabilityMap(org.platform);
  assert.equal((await readOrganisation(org.platform)).capabilities[0].children.length, 0);

  await assert.rejects(
    () => editCapabilityInOrganisation(org.platform, 'commerce', {}, { mode: 'overwrite' }),
    /must be 'add', 'set', or 'remove'/);
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
