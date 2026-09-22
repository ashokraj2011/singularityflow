import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  activateWorkflowConfigurationProposal, assertLocalConfigurationAuthoringAllowed,
  listWorkflowConfigurationProposals, proposeConfigurationChange
} from '../src/configuration-proposal.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { run } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('workflow proposal remote operations stay on the bounded asynchronous Git boundary', async () => {
  const source = await readFile(new URL('../src/configuration-proposal.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\brunRemoteGit\(/u);
  assert.doesNotMatch(source, /\.observe\(/u);
  assert.doesNotMatch(source, /runRemoteGitAsync\(\[\s*['"]ls-remote['"]/u,
    'remote advertisements must use the shared duplicate/malformed-safe session parser');
  assert.match(source, /\brunRemoteGitAsync\(/u);
  assert.match(source, /\.observeAsync\(/u);
  assert.match(source, /frozenRemoteTransport\(/u);
  assert.match(source, /createGitRuntime\(/u,
    'local retention observation must use the GAL ref reader');
});

async function fixture({ remoteName = 'application.git' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-'));
  const seed = path.join(base, 'seed');
  const remote = path.join(base, remoteName);
  const story = path.join(base, 'story');
  const outbox = path.join(base, 'transport-outbox');

  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Workflow Author'], { cwd: seed });
  run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  await writeFile(path.join(seed, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'application and configuration baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  const approved = run('git', ['rev-parse', 'HEAD'], { cwd: seed }).stdout.trim();

  run('git', ['switch', '-q', '-c', 'CFA-STORY'], { cwd: seed });
  await mkdir(path.join(seed, 'singularity'), { recursive: true });
  await writeFile(path.join(seed, 'singularity', 'configuration-source.json'), `${JSON.stringify({
    branch: 'sflow/config', commit: approved
  }, null, 2)}\n`);
  run('git', ['add', 'singularity/configuration-source.json'], { cwd: seed });
  run('git', ['commit', '-qm', 'pin Story configuration'], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'CFA-STORY'], { cwd: seed });

  run('git', ['clone', '-q', '-b', 'CFA-STORY', remote, story]);
  run('git', ['config', 'user.name', 'Workflow Author'], { cwd: story });
  run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: story });
  return { base, remote, story, outbox, approved };
}

test('configuration proposal clone failures never expose credential-shaped provider output', async () => {
  const item = await fixture();
  try {
    const realGit = run('which', ['git']).stdout.trim();
    const wrappers = path.join(item.base, 'clone-failure-bin');
    const wrapper = path.join(wrappers, 'git');
    await mkdir(wrappers, { recursive: true });
    await writeFile(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'clone') {
  process.stderr.write("fatal: could not read Username for 'https://alice:supersecret@git.example.test/private.git': terminal prompts disabled\\n");
  process.exit(128);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(), env: process.env, stdio: 'inherit'
});
process.exit(result.status == null ? 1 : result.status);
`);
    await chmod(wrapper, 0o755);
    await assert.rejects(
      () => proposeConfigurationChange(item.story, {
        operation: 'edit-workflow', subject: 'redaction-check', message: 'redaction check',
        async mutate() { throw new Error('clone refusal must happen before mutation'); }
      }, { env: { ...process.env, PATH: `${wrappers}${path.delimiter}${process.env.PATH}` } }),
      (error) => {
        assert.equal(error.code, 'CONFIGURATION_PROPOSAL_AUTHORITY_UNAVAILABLE');
        const serialized = JSON.stringify({ message: error.message, details: error.details });
        assert.doesNotMatch(serialized, /alice|supersecret|private\.git/iu);
        assert.match(error.message, /Sign in to Git|credential helper/iu);
        return true;
      }
    );
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration save proposals CAS approved authority without touching a divergent application checkout', async () => {
  const item = await fixture();
  try {
    const workflowPath = path.join(item.story, 'singularity', 'workflow.yml');
    const approvedText = run('git', [
      '--git-dir', item.remote, 'show', 'sflow/config:singularity/workflow.yml'
    ]).stdout;
    const applicationText = `${approvedText}\n# application branch projection differs\n`;
    await writeFile(workflowPath, applicationText);
    run('git', ['add', 'singularity/workflow.yml'], { cwd: item.story });
    run('git', ['commit', '-qm', 'diverge application configuration projection'], { cwd: item.story });
    const applicationHead = run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim();
    const desiredText = `${approvedText}\n# registered-v4 visual proposal\n`;
    const expectedSha256 = createHash('sha256').update(approvedText).digest('hex');

    const saved = spawnSync(process.execPath, [
      cli, 'configuration', 'save', 'singularity/workflow.yml',
      '--expected-sha256', expectedSha256,
      '--expected-authority-kind', 'approved-configuration-ref',
      '--expected-authority-commit', item.approved,
      '--expected-authority-source-commit', item.approved,
      '--expected-authority-remote-fingerprint', remoteFingerprint(item.remote),
      '--propose', '--json'
    ], {
      cwd: item.story,
      input: desiredText,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test', NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(saved.status, 0, `${saved.stderr}\n${saved.stdout}`);
    const proposal = JSON.parse(saved.stdout);
    assert.equal(proposal.reviewRequired, true);
    const subjectHash = createHash('sha256').update('singularity/workflow.yml').digest('hex').slice(0, 12);
    assert.match(proposal.branch, new RegExp(
      `^sflow/config-change/workflow/save-file-workflow\\.yml-${subjectHash}-`
    ));
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), applicationHead);
    assert.equal(await readFile(workflowPath, 'utf8'), applicationText);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');
    assert.equal(run('git', [
      '--git-dir', item.remote, 'show', `${proposal.branch}:singularity/workflow.yml`
    ]).stdout, desiredText);
    assert.equal(run('git', [
      '--git-dir', item.remote, 'rev-parse', `${proposal.branch}^`
    ]).stdout.trim(), item.approved);
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration proposal refuses an authority commit move even when file bytes are unchanged', async () => {
  const item = await fixture();
  let mutated = false;
  try {
    const tree = run('git', ['rev-parse', `${item.approved}^{tree}`], { cwd: item.story }).stdout.trim();
    const moved = run('git', [
      '-c', 'user.name=Authority mover', '-c', 'user.email=authority@example.test',
      'commit-tree', tree, '-p', item.approved, '-m', 'move authority without changing files'
    ], { cwd: item.story }).stdout.trim();
    run('git', ['push', '-q', '--force', 'origin', `${moved}:refs/heads/sflow/config`], { cwd: item.story });

    await assert.rejects(() => proposeConfigurationChange(item.story, {
      operation: 'save-file', subject: 'workflow.yml', message: 'must not mutate stale authority',
      expectedAuthority: {
        kind: 'approved-configuration-ref', commit: item.approved,
        sourceCommit: item.approved, remoteFingerprint: remoteFingerprint(item.remote)
      },
      async mutate() { mutated = true; }
    }), (error) => error.code === 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED'
      && /commit changed after this editor loaded/i.test(error.message));
    assert.equal(mutated, false, 'authority identity CAS runs before the proposed mutation');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration proposal refuses an authority remote switch with identical bytes', async () => {
  const item = await fixture();
  const replacement = path.join(item.base, 'replacement.git');
  let mutated = false;
  try {
    run('git', ['clone', '-q', '--bare', item.remote, replacement], { cwd: item.base });
    run('git', ['remote', 'set-url', 'origin', replacement], { cwd: item.story });
    await assert.rejects(() => proposeConfigurationChange(item.story, {
      operation: 'save-file', subject: 'workflow.yml', message: 'must not switch authority',
      expectedAuthority: {
        kind: 'approved-configuration-ref', commit: item.approved,
        sourceCommit: item.approved, remoteFingerprint: remoteFingerprint(item.remote)
      },
      async mutate() { mutated = true; }
    }), (error) => error.code === 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED'
      && /remote changed after this editor loaded/i.test(error.message));
    assert.equal(mutated, false);
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration proposal binds both commits of a verified state mirror before mutation', async () => {
  const item = await fixture();
  let mutated = false;
  try {
    run('git', ['push', '-q', 'origin', `${item.approved}:refs/heads/state`], { cwd: item.story });
    const tree = run('git', ['rev-parse', `${item.approved}^{tree}`], { cwd: item.story }).stdout.trim();
    const movedMirror = run('git', [
      '-c', 'user.name=Mirror mover', '-c', 'user.email=mirror@example.test',
      'commit-tree', tree, '-p', item.approved, '-m', 'move mirror without changing bytes'
    ], { cwd: item.story }).stdout.trim();
    run('git', ['push', '-q', '--force', 'origin', `${movedMirror}:refs/heads/state`], { cwd: item.story });

    await assert.rejects(() => proposeConfigurationChange(item.story, {
      operation: 'save-file', subject: 'workflow.yml', message: 'must not mutate stale mirror',
      expectedAuthority: {
        kind: 'verified-state-mirror', commit: item.approved,
        sourceCommit: item.approved, remoteFingerprint: remoteFingerprint(item.remote)
      },
      async mutate() { mutated = true; }
    }), (error) => error.code === 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED'
      && /state configuration mirror changed/i.test(error.message));
    assert.equal(mutated, false);
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration save proposal identities distinguish equal basenames in different paths', async () => {
  const item = await fixture();
  try {
    const paths = [
      'singularity/templates/feature/intake.md',
      'singularity/templates/chore/intake.md'
    ];
    const branches = [];
    for (const relative of paths) {
      const approvedText = run('git', [
        '--git-dir', item.remote, 'show', `sflow/config:${relative}`
      ]).stdout;
      const expectedSha256 = createHash('sha256').update(approvedText).digest('hex');
      const saved = spawnSync(process.execPath, [
        cli, 'configuration', 'save', relative,
        '--expected-sha256', expectedSha256, '--propose', '--json'
      ], {
        cwd: item.story,
        input: `${approvedText}\nProposal for ${relative}.\n`,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test', NO_COLOR: '1',
          SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
          SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
          SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
          SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
        }
      });
      assert.equal(saved.status, 0, `${saved.stderr}\n${saved.stdout}`);
      const proposal = JSON.parse(saved.stdout);
      const subjectHash = createHash('sha256').update(relative).digest('hex').slice(0, 12);
      assert.match(proposal.branch, new RegExp(`${subjectHash}-[0-9a-f]{8}$`));
      branches.push(proposal.branch);
    }

    assert.equal(new Set(branches).size, paths.length,
      'equal basenames in distinct repository paths must never share a proposal branch');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration save bounds long filename proposal refs and retains full-path identity', async () => {
  const item = await fixture();
  try {
    // Long enough to prove the branch label is bounded, while retaining headroom for the
    // repository writer's same-directory atomic temporary suffix on conservative filesystems.
    const basename = `${'long-name-'.repeat(16)}template.md`;
    assert.ok(Buffer.byteLength(basename) < 256,
      'the configuration filename itself must remain a legal filesystem component');
    const relative = `singularity/templates/feature/${basename}`;
    const saved = spawnSync(process.execPath, [
      cli, 'configuration', 'save', relative,
      '--expected-sha256', createHash('sha256').update('').digest('hex'),
      '--propose', '--json'
    ], {
      cwd: item.story,
      input: '# Long configuration template\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test', NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(saved.status, 0, `${saved.stderr}\n${saved.stdout}`);
    const proposal = JSON.parse(saved.stdout);
    const component = proposal.branch.split('/').at(-1);
    assert.ok(Buffer.byteLength(component) <= 96,
      `proposal ref component must remain conservatively portable, got ${Buffer.byteLength(component)} bytes`);
    const pathDigest = createHash('sha256').update(relative).digest('hex').slice(0, 12);
    assert.match(component, new RegExp(`${pathDigest}-[0-9a-f]{8}$`),
      'the bounded ref must preserve the full normalized path digest');
    assert.equal(run('git', [
      '--git-dir', item.remote, 'show-ref', '--verify', '--quiet', `refs/heads/${proposal.branch}`
    ], { allowFailure: true }).status, 0, 'the bounded proposal ref is published remotely');

    // Model an external review system that fast-forwards the approved authority and immediately
    // deletes the source branch. Status must still prove the exact saved commit through ancestry.
    run('git', ['--git-dir', item.remote, 'update-ref', 'refs/heads/sflow/config', proposal.commit]);
    run('git', ['--git-dir', item.remote, 'update-ref', '-d', `refs/heads/${proposal.branch}`]);
    const status = spawnSync(process.execPath, [
      cli, 'workflow', 'proposal-status', proposal.branch,
      '--commit', proposal.commit, '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test', NO_COLOR: '1',
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
    const observed = JSON.parse(status.stdout);
    assert.equal(observed.merged, true);
    assert.equal(observed.branchStatus, 'absent');
    assert.equal(observed.proposalCommit, proposal.commit);
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('configuration read prefers approved authority over a stale application projection', async () => {
  const item = await fixture();
  try {
    const relative = 'singularity/impact.yml';
    const target = path.join(item.story, relative);
    const approvedText = run('git', [
      '--git-dir', item.remote, 'show', `sflow/config:${relative}`
    ]).stdout;
    await writeFile(target, `${approvedText}\n# stale application projection\n`);
    const read = spawnSync(process.execPath, [cli, 'configuration', 'read', relative, '--json'], {
      cwd: item.story, encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', NO_COLOR: '1' }
    });
    assert.equal(read.status, 0, `${read.stderr}\n${read.stdout}`);
    assert.equal(JSON.parse(read.stdout).content, approvedText);
    assert.match(await readFile(target, 'utf8'), /stale application projection/,
      'the read-only authority overlay never rewrites the physical checkout');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposals publish from approved configuration without changing the selected Story', async () => {
  const item = await fixture();
  try {
    const storyHead = run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim();
    const storyWorkflow = await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8');
    const created = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'customer-onboarding',
      '--label', 'Customer onboarding', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
    const result = JSON.parse(created.stdout);

    assert.equal(result.reviewRequired, true);
    assert.equal(result.pushed, true);
    assert.match(result.branch, /^sflow\/config-change\/workflow\/create-workflow-customer-onboarding-/);
    assert.deepEqual(result.files, ['singularity/workflow.yml']);
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), storyHead);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: item.story }).stdout.trim(), 'CFA-STORY');
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');
    assert.equal(await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8'), storyWorkflow);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved,
      'approved configuration waits for review');

    const proposed = YAML.parse(run('git', [
      '--git-dir', item.remote, 'show', `${result.branch}:singularity/workflow.yml`
    ]).stdout);
    assert.deepEqual(proposed.workTypes['customer-onboarding'].phases, ['intake', 'implementation']);
    assert.equal(proposed.workTypes['customer-onboarding'].plannedClaims.mode, 'opt-out');
    assert.match(result.nextAction, /Merge .* into sflow\/config.*refresh-configuration/);

    const retried = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'customer-onboarding',
      '--label', 'Customer onboarding', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(retried.status, 0, `${retried.stderr}\n${retried.stdout}`);
    const recovered = JSON.parse(retried.stdout);
    assert.equal(recovered.branch, result.branch);
    assert.equal(recovered.commit, result.commit);
    assert.equal(recovered.transportStatus, 'succeeded-existing');
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), storyHead);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');

    const pendingList = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(pendingList.status, 0, pendingList.stderr || pendingList.stdout);
    const pendingWorkflow = JSON.parse(pendingList.stdout)
      .find((entry) => entry.id === 'customer-onboarding');
    assert.equal(pendingWorkflow.status, 'pending-review');
    assert.equal(pendingWorkflow.installed, false);
    assert.equal(pendingWorkflow.proposalBranch, result.branch);

    const startListBefore = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json', '--for-start'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(startListBefore.status, 0, startListBefore.stderr || startListBefore.stdout);
    assert.equal(JSON.parse(startListBefore.stdout)
      .some((entry) => entry.id === 'customer-onboarding' && entry.installed), false,
    'pending review is visible but cannot be selected for governed work');

    const inspected = spawnSync(process.execPath, [
      cli, 'workflow', 'proposal', result.branch, '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    const review = JSON.parse(inspected.stdout);
    assert.equal(review.proposalCommit, result.commit);
    assert.deepEqual(review.workflows.map((entry) => [entry.id, entry.change]), [
      ['customer-onboarding', 'added']
    ]);

    const unacknowledged = spawnSync(process.execPath, [
      cli, 'workflow', 'activate', result.branch, '--confirm', result.commit, '--json'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.notEqual(unacknowledged.status, 0);
    assert.match(unacknowledged.stderr, /cannot prove whether.*protected/is);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved,
      'an unprotected authority does not move without its separate acknowledgement');

    const realGit = run('which', ['git']).stdout.trim();
    const wrappers = path.join(item.base, 'git-wrappers');
    const pushLog = path.join(item.base, 'activation-push.jsonl');
    const wrapper = path.join(wrappers, 'git');
    await mkdir(wrappers, { recursive: true });
    await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'push') fs.appendFileSync(${JSON.stringify(pushLog)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(), env: process.env, stdio: 'inherit'
});
process.exit(result.status == null ? 1 : result.status);
`);
    await chmod(wrapper, 0o755);
    const activated = spawnSync(process.execPath, [
      cli, 'workflow', 'activate', result.branch, '--confirm', result.commit,
      '--acknowledge-unprotected', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env, NO_COLOR: '1', PATH: `${wrappers}${path.delimiter}${process.env.PATH}`
      }
    });
    assert.equal(activated.status, 0, activated.stderr || activated.stdout);
    const activation = JSON.parse(activated.stdout);
    assert.equal(activation.activated, true);
    assert.equal(activation.mergeEvidence, 'direct-exact-lease');
    assert.equal(activation.protection.enforced, false);
    assert.notEqual(activation.targetCommit, item.approved);
    const pushes = (await readFile(pushLog, 'utf8')).trim().split('\n').map(JSON.parse);
    const authorityPush = pushes.find((args) =>
      args.includes('HEAD:refs/heads/sflow/config'));
    assert.ok(authorityPush, 'activation must attempt one observable authority update');
    assert.ok(authorityPush.includes('--porcelain'));
    assert.ok(authorityPush.includes(
      `--force-with-lease=refs/heads/sflow/config:${item.approved}`));
    assert.equal(authorityPush.includes('--dry-run'), false,
      'a dry run is not branch-protection evidence and must not precede the exact update');
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: item.story }).stdout.trim(), storyHead,
      'activation never switches or commits the selected Story checkout');

    const startListAfter = spawnSync(process.execPath, [
      cli, 'workflow', 'list', '--json', '--for-start'
    ], { cwd: item.story, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(startListAfter.status, 0, startListAfter.stderr || startListAfter.stdout);
    const approvedWorkflow = JSON.parse(startListAfter.stdout)
      .find((entry) => entry.id === 'customer-onboarding');
    assert.equal(approvedWorkflow.status, 'local');
    assert.equal(approvedWorkflow.installed, true);

    const configurationSnapshot = spawnSync(process.execPath, [
      cli, 'snapshot', '--include', 'configuration', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      maxBuffer: 16 * 1024 * 1024
    });
    assert.equal(configurationSnapshot.status, 0,
      configurationSnapshot.stderr || configurationSnapshot.stdout);
    assert.ok(JSON.parse(configurationSnapshot.stdout)
      .configuration.definition.workTypes['customer-onboarding'],
    'Configuration Center reads newly approved authority even while an older Story stays selected');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow activation keeps a generic pre-receive refusal pending with its diagnostic', async () => {
  const item = await fixture();
  try {
    const created = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'security-scanned-flow',
      '--label', 'Security scanned flow', '--description', 'A reviewed delivery path.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const proposal = JSON.parse(created.stdout);
    const hook = path.join(item.remote, 'hooks', 'pre-receive');
    await writeFile(hook, `#!/bin/sh
echo "secret scanning rejected a credential in the proposed content" >&2
exit 1
`);
    await chmod(hook, 0o755);

    const waiting = await activateWorkflowConfigurationProposal(item.story, proposal.branch, {
      confirm: proposal.commit,
      acknowledgeUnprotected: true
    });
    assert.equal(waiting.status, 'activation-pending');
    assert.equal(waiting.activated, false);
    assert.equal(waiting.externalAction, null);
    assert.notEqual(waiting.failure.code, 'WORKFLOW_ACTIVATION_REVIEW_REQUIRED');
    assert.match(waiting.failure.diagnostic, /secret scanning rejected a credential/i);
    assert.match(waiting.failure.diagnostic, /pre-receive hook declined/i);
    assert.equal(run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(), item.approved);

    await writeFile(hook, `#!/bin/sh
echo "configuration review required before updating this protected branch" >&2
exit 1
`);
    await chmod(hook, 0o755);
    const protectedRefusal = await activateWorkflowConfigurationProposal(item.story, proposal.branch, {
      confirm: proposal.commit,
      acknowledgeUnprotected: true
    });
    assert.equal(protectedRefusal.status, 'review-required');
    assert.equal(protectedRefusal.failure.code, 'WORKFLOW_ACTIVATION_REVIEW_REQUIRED');
    assert.equal(protectedRefusal.protection.enforced, true);
    assert.equal(protectedRefusal.externalAction.action, 'merge-proposal');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal activation rejects a newly added migration-required Story workflow', async () => {
  const item = await fixture();
  const authoring = path.join(item.base, 'unsafe-proposal');
  const proposalBranch = 'sflow/config-change/workflow/unsafe-legacy-custom';
  try {
    run('git', ['clone', '-q', '-b', 'sflow/config', item.remote, authoring]);
    run('git', ['config', 'user.name', 'Workflow Author'], { cwd: authoring });
    run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: authoring });
    run('git', ['switch', '-q', '-c', proposalBranch], { cwd: authoring });
    const workflowPath = path.join(authoring, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
    definition.workTypes['legacy-custom'] = {
      ...structuredClone(definition.workTypes['quick-fix']),
      label: 'Legacy custom'
    };
    delete definition.workTypes['legacy-custom'].plannedClaims;
    await writeFile(workflowPath, YAML.stringify(definition));
    run('git', ['add', 'singularity/workflow.yml'], { cwd: authoring });
    run('git', ['commit', '-qm', 'propose unresolved legacy workflow'], { cwd: authoring });
    run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${proposalBranch}`], { cwd: authoring });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: authoring }).stdout.trim();

    await assert.rejects(
      () => activateWorkflowConfigurationProposal(item.story, proposalBranch, {
        confirm: commit,
        acknowledgeUnprotected: true
      }),
      (error) => error.code === 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED'
        && /cannot be added or materially changed/.test(error.message)
    );
    assert.equal(
      run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(),
      item.approved,
      'rejected proposal must not move approved configuration'
    );
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal activation refuses an environment declaration with an unknown quality-command ID', async () => {
  const item = await fixture();
  const authoring = path.join(item.base, 'invalid-environment-proposal');
  const proposalBranch = 'sflow/config-change/workflow/invalid-environment-check';
  try {
    run('git', ['clone', '-q', '-b', 'sflow/config', item.remote, authoring]);
    run('git', ['config', 'user.name', 'Workflow Author'], { cwd: authoring });
    run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: authoring });
    run('git', ['switch', '-q', '-c', proposalBranch], { cwd: authoring });
    await writeFile(path.join(authoring, 'singularity/environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
checks:
  unknown-quality-command:
    environment: qa
neverCommit:
  - .env.*
`);
    run('git', ['add', 'singularity/environments.yml'], { cwd: authoring });
    run('git', ['commit', '-qm', 'propose invalid environment check mapping'], { cwd: authoring });
    run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${proposalBranch}`], { cwd: authoring });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: authoring }).stdout.trim();

    await assert.rejects(
      () => activateWorkflowConfigurationProposal(item.story, proposalBranch, {
        confirm: commit,
        acknowledgeUnprotected: true
      }),
      (error) => error.code === 'ENVIRONMENT_DECLARATION_INVALID'
        && /unknown quality command ID.*unknown-quality-command/i.test(error.message)
    );
    assert.equal(
      run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(),
      item.approved,
      'invalid environment proposal must not move approved configuration'
    );
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal activation refuses only mapped conflicting quality-command IDs', async () => {
  const item = await fixture();
  const authoring = path.join(item.base, 'ambiguous-environment-proposal');
  const proposalBranch = 'sflow/config-change/workflow/ambiguous-environment-check';
  try {
    run('git', ['clone', '-q', '-b', 'sflow/config', item.remote, authoring]);
    run('git', ['config', 'user.name', 'Workflow Author'], { cwd: authoring });
    run('git', ['config', 'user.email', 'workflow@example.test'], { cwd: authoring });
    run('git', ['switch', '-q', '-c', proposalBranch], { cwd: authoring });
    // The packaged POC phases intentionally reuse git-diff-check with different timeouts. An
    // empty declaration is valid, but mapping that ambiguous ID must fail before authority moves.
    await writeFile(path.join(authoring, 'singularity/environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
checks:
  git-diff-check:
    environment: qa
neverCommit:
  - .env.*
`);
    run('git', ['add', 'singularity/environments.yml'], { cwd: authoring });
    run('git', ['commit', '-qm', 'propose ambiguous environment check mapping'], { cwd: authoring });
    run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${proposalBranch}`], { cwd: authoring });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: authoring }).stdout.trim();

    await assert.rejects(
      () => activateWorkflowConfigurationProposal(item.story, proposalBranch, {
        confirm: commit,
        acknowledgeUnprotected: true
      }),
      (error) => error.code === 'ENVIRONMENT_DECLARATION_INVALID'
        && /ambiguous quality command ID.*git-diff-check/i.test(error.message)
    );
    assert.equal(
      run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config']).stdout.trim(),
      item.approved,
      'ambiguous environment proposal must not move approved configuration'
    );
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal publication distinguishes local authorities whose display URLs collide', async () => {
  const item = await fixture({ remoteName: 'application.git?blue' });
  try {
    const collision = path.join(item.base, 'application.git?red');
    run('git', ['init', '-q', '--bare', '--initial-branch=main', collision]);
    run('git', ['remote', 'add', 'aaa-display-collision', collision], { cwd: item.story });

    const created = spawnSync(process.execPath, [
      cli, 'workflow', 'create', 'exact-authority',
      '--label', 'Exact authority', '--description', 'Publish only to the selected authority.',
      '--phases', 'intake,implementation', '--governs', 'story',
      '--planned-claims', 'opt-out', '--opt-out-reason',
      'This reviewed short workflow deliberately has no separate specification phase.',
      '--propose', '--json'
    ], {
      cwd: item.story,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NO_COLOR: '1',
        SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
        SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
      }
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const proposal = JSON.parse(created.stdout);
    assert.equal(run('git', [
      '--git-dir', item.remote, 'show-ref', '--verify', '--quiet', `refs/heads/${proposal.branch}`
    ], { allowFailure: true }).status, 0, 'the exact approved authority receives the proposal');
    assert.equal(run('git', [
      '--git-dir', collision, 'show-ref', '--verify', '--quiet', `refs/heads/${proposal.branch}`
    ], { allowFailure: true }).status, 1, 'the display-colliding authority receives nothing');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal authority ignores ambient URL rewrites and Git repository selectors', async () => {
  const item = await fixture();
  const decoy = path.join(item.base, 'decoy.git');
  const selector = path.join(item.base, 'selector.git');
  const globalConfig = path.join(item.base, 'ambient-gitconfig');
  try {
    run('git', ['clone', '-q', '--bare', item.remote, decoy], { cwd: item.base });
    run('git', ['init', '-q', '--bare', selector], { cwd: item.base });
    run('git', ['config', '--file', globalConfig, `url.${decoy}.insteadOf`, item.remote]);
    const operationEnv = {
      ...process.env,
      NODE_ENV: 'test',
      NO_COLOR: '1',
      GIT_DIR: selector,
      GIT_WORK_TREE: item.base,
      GIT_CONFIG_GLOBAL: globalConfig,
      SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Author',
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: item.outbox,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(item.base, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(item.base, 'active-workspace.json')
    };
    const proposal = await proposeConfigurationChange(item.story, {
      operation: 'create-workflow', subject: 'isolated-authority',
      message: 'Create isolated authority workflow',
      async mutate(scratch) {
        const workflowPath = path.join(scratch, 'singularity', 'workflow.yml');
        const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
        definition.workTypes['isolated-authority'] = {
          ...structuredClone(definition.workTypes['quick-fix']),
          label: 'Isolated authority'
        };
        await writeFile(workflowPath, YAML.stringify(definition));
        return { id: 'isolated-authority' };
      }
    }, { transport: { env: operationEnv } });
    const proposalRef = `refs/heads/${proposal.branch}`;
    const retainedRef = `refs/singularity/transport/configuration-proposals/${proposal.commit}`;
    assert.equal(run('git', [
      '--git-dir', item.remote, 'show-ref', '--verify', '--quiet', proposalRef
    ], { allowFailure: true }).status, 0, 'the reviewed authority receives the proposal');
    assert.equal(run('git', [
      '--git-dir', decoy, 'show-ref', '--verify', '--quiet', proposalRef
    ], { allowFailure: true }).status, 1, 'an ambient insteadOf destination receives nothing');
    assert.equal(run('git', [
      '--git-dir', path.join(item.story, '.git'), 'show-ref', '--verify', '--quiet', retainedRef
    ], { allowFailure: true }).status, 0, 'the selected repository retains the exact proposal');
    assert.equal(run('git', [
      '--git-dir', selector, 'show-ref', '--verify', '--quiet', retainedRef
    ], { allowFailure: true }).status, 1, 'ambient GIT_DIR receives no retention ref');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('workflow proposal listing refuses a duplicate remote advertisement', async () => {
  const item = await fixture();
  const realGit = run('which', ['git']).stdout.trim();
  const wrappers = path.join(item.base, 'duplicate-advert-wrapper');
  const calls = path.join(item.base, 'ls-remote-count');
  const wrapper = path.join(wrappers, 'git');
  try {
    await mkdir(wrappers, { recursive: true });
    await writeFile(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'ls-remote') {
  let count = 0;
  try { count = Number(fs.readFileSync(${JSON.stringify(calls)}, 'utf8')); } catch {}
  count += 1;
  fs.writeFileSync(${JSON.stringify(calls)}, String(count));
  if (count === 2) {
    const ref = 'refs/heads/sflow/config-change/workflow/duplicate-advert';
    const oid = ${JSON.stringify(item.approved)};
    process.stdout.write(oid + '\\t' + ref + '\\n' + oid + '\\t' + ref + '\\n');
    process.exit(0);
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: process.cwd(), env: process.env, stdio: 'inherit'
});
process.exit(result.status == null ? 1 : result.status);
`);
    await chmod(wrapper, 0o755);
    await assert.rejects(() => listWorkflowConfigurationProposals(item.story, {
      env: { ...process.env, PATH: `${wrappers}${path.delimiter}${process.env.PATH}` }
    }), (error) => error.code === 'REMOTE_PROTOCOL_INVALID'
      && /duplicate or malformed remote-reference advertisement/i.test(error.message));
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});

test('legacy workflow authoring refuses a pinned Story before it writes', async () => {
  const item = await fixture();
  try {
    const before = await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8');
    assert.throws(() => assertLocalConfigurationAuthoringAllowed(item.story), (error) => {
      assert.equal(error.code, 'WORKFLOW_AUTHORING_STORY_SNAPSHOT_REFUSED');
      assert.match(error.message, /--propose/);
      return true;
    });
    assert.equal(await readFile(path.join(item.story, 'singularity', 'workflow.yml'), 'utf8'), before);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: item.story }).stdout, '');
  } finally {
    await rm(item.base, { recursive: true, force: true });
  }
});
