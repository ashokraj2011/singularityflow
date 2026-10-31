/**
 * SDA acceptance (007, 010, 020) over real Stories, with the real CLI and a disposable bare remote.
 *
 * - SDA-AC-007, reader side: while a lifecycle commit is retained locally because its push was
 *   refused, the readers a person or agent asks next (`session candidates`, `nextsteps`, `status`)
 *   never present the retained transition as accepted. The writer side is
 *   test/publication-faults.test.mjs.
 * - SDA-AC-020: index rebuild, schema-migration reads and workspace retention leave the signed
 *   ledger, its pins and the Story's evidence byte-identical, locally and on the remote, and the
 *   ledger's commit signatures still verify.
 * - SDA-AC-010: an imported, a looped and a future-phase workflow definition publish every
 *   lifecycle transition through the one lifecycle adapter, into the same Story-record layout,
 *   with no phase-specific storage path. test/sda-lifecycle-boundary.test.mjs proves statically
 *   that the adapter is the only route; this proves the route carries these definitions.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { readPendingPublication } from '../src/publication-pending.mjs';
import { familyForStoredPath, readRecord } from '../src/schema-migrations.mjs';
import { exportWorkflowBundle, planWorkflowImport, applyWorkflowImport } from '../src/workflow-transfer.mjs';
import { readWorkspace, rememberWorkspace } from '../src/workspace.mjs';
import { runWorkspaceRetention, saveWorkspaceRetention } from '../src/workspace-retention.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/workflow.yml', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(command, args, cwd, { allowFailure = false, input = undefined, encoding = 'utf8' } = {}) {
  // Read at call time: a case may point Git at its own global configuration (the signing key).
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Packager',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, env, input, encoding, timeout: childTimeout(180_000), maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/**
 * A repository initialized by the CLI with lightweight approvals, its bare remote, and the
 * commands that drive it. `configure` edits the workflow before it is committed; `agent` adds one
 * user-written agent that owns the custom steps, as a team would.
 */
async function repository(t, { root: place = (base) => path.join(base, 'app'), configure = () => {}, agent = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-acceptance-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const root = place(base);
  const remote = path.join(base, 'remote.git');
  await mkdir(root, { recursive: true });
  const git = (cwd, ...args) => run('git', args, cwd).stdout.trim();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Packager');
  git(root, 'config', 'user.email', 'packager@example.com');
  await writeFile(path.join(root, '.gitattributes'), '* text eol=lf\n');
  run(process.execPath, [CLI, '--no-model', 'init'], root);
  const file = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(file, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configure(configuration);
  await writeFile(file, YAML.stringify(configuration));
  if (agent) {
    await mkdir(path.join(root, '.github/agents'), { recursive: true });
    await writeFile(path.join(root, `.github/agents/${agent.id}.agent.md`), [
      '---', `name: ${agent.id}`, 'description: "Records one reviewed document step from the Story\'s own inputs."',
      'metadata:', `  sflow-phases: "${agent.phases.join(',')}"`, `  sflow-default-for: "${agent.phases.join(',')}"`, '---',
      `# ${agent.id}`, '', 'Write the step\'s one document from the Story\'s own inputs, and nothing else.', ''
    ].join('\n'));
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initialize the acceptance fixture');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const cli = (cwd, ...args) => run(process.execPath, [CLI, '--no-model', ...args], cwd);
  const remoteRef = (ref) => run('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref], base, { allowFailure: true }).stdout.trim();
  return { base, root, remote, git, cli, remoteRef };
}

/** Author a step's document, record it and publish its generation, as a person does by hand. */
async function publishStep(f, cwd, workId, phase, text) {
  const file = path.join(cwd, 'singularity/work-items', workId, 'artifacts', phase, `${phase}.md`);
  await writeFile(file, text);
  f.cli(cwd, 'artifact', 'scan', '--phase', phase);
  f.cli(cwd, 'phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place');
}

async function publishIntake(f, cwd, workId) {
  const file = path.join(cwd, 'singularity/work-items', workId, 'artifacts/intake/intake.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu,
    'Keep every reader on the published phase while a lifecycle commit waits for its push.'));
  f.cli(cwd, 'artifact', 'scan', '--phase', 'intake');
  f.cli(cwd, 'phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
}

test('a retained approval is read as pending, never as accepted (SDA-AC-007)', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await repository(t);
  const WORK = 'READ-7';
  f.cli(f.root, 'start', WORK, '--from-branch', 'main', '--work-type', 'feature', '--title', 'Reader consistency',
    '--description', 'Readers never present a retained transition as accepted.');
  await publishIntake(f, f.root, WORK);
  f.cli(f.root, 'submit', 'intake', '--skip-checks');
  const published = f.remoteRef(`refs/heads/${WORK}`);
  assert.equal(published, f.git(f.root, 'rev-parse', 'HEAD'), 'the submitted intake is on the remote');

  // The remote refuses the approval's push: the transition is committed here and nowhere else.
  const hook = path.join(f.remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'intake', '--yes', '--json'], f.root, { allowFailure: true });
  assert.notEqual(refused.status, 0, 'the approval could not be published');
  assert.match(refused.stdout + refused.stderr, /singularity-flow sync/u);
  assert.equal(f.remoteRef(`refs/heads/${WORK}`), published, 'the remote still holds the submitted intake');
  const retained = f.git(f.root, 'rev-parse', 'HEAD');
  assert.notEqual(retained, published);
  assert.match(f.git(f.root, 'log', '-1', '--format=%s'), /\[phase:intake\]\[approve\]/u);
  assert.ok(await readPendingPublication(f.root, { kind: 'story', id: WORK, migrate: false }), 'a pending-publication marker holds the transition');

  await t.test('session candidates lists the published intake, awaiting approval', () => {
    const listed = JSON.parse(f.cli(f.root, 'session', 'candidates', '--json').stdout);
    const story = listed.find((entry) => entry.id === WORK);
    assert.ok(story, JSON.stringify(listed));
    assert.equal(story.phase, 'intake');
    assert.equal(story.progress.current.status, 'awaiting_approval');
    assert.equal(story.progress.approved, 0);
    assert.equal(story.commitOid, published, 'the listing names the published revision, not the retained one');
  });

  await t.test('nextsteps routes to sync before anything else', () => {
    const next = JSON.parse(f.cli(f.root, 'nextsteps', '--json').stdout);
    assert.equal(next.state, 'publication_pending');
    assert.equal(next.pending.next.kind, 'story-publication');
    assert.match(next.actions[0].command, /^singularity-flow sync\b/u);
    // No step of the phase the retained approval opened is offered while it is unpublished.
    assert.deepEqual(next.actions.filter((action) => /\b(?:prepare|publish|submit|approve)\b/u.test(action.command ?? '')), []);
  });

  // Status prints the local record as it is, the retained approval included, so it must say beside
  // it that this transition has not reached the remote and route to sync, as nextsteps does.
  await t.test('status marks the retained approval as not yet published and routes to sync', () => {
    const status = JSON.parse(f.cli(f.root, 'status', '--json').stdout);
    assert.equal(status.workItem.id, WORK);
    assert.ok(status.publicationPending, 'status --json presents the retained approval without saying it is unpublished');
    assert.equal(status.publicationPending.commit, retained);
    assert.equal(status.publicationPending.nextAction.command, 'singularity-flow sync');
    const text = f.cli(f.root, 'status').stdout;
    assert.match(text, /Publication: pending\. .*not accepted until it reaches the remote\. Publish it: singularity-flow sync/u,
      'status names the retained phase as current without saying the approval is not published');
  });
});

/** The raw bytes of every object the ledger, its pins and the Story branch reach, with their refs. */
function ledgerAndEvidence(gitArgs, cwd, story) {
  const refs = run('git', [...gitArgs, 'for-each-ref', '--format=%(refname) %(objectname)',
    'refs/heads/state', 'refs/singularity/pins', `refs/heads/${story}`], cwd).stdout.trim();
  const names = refs.split('\n').map((line) => line.split(' ')[0]);
  const ids = run('git', [...gitArgs, 'rev-list', '--objects', ...names], cwd).stdout
    .split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
  const bytes = run('git', [...gitArgs, 'cat-file', '--batch'], cwd, { input: Buffer.from(`${ids.join('\n')}\n`), encoding: 'buffer' }).stdout;
  return { refs, objects: ids.length, sha256: sha256(bytes) };
}

test('index rebuild, schema-migration reads and retention keep signed ledger and evidence bytes (SDA-AC-020)', slowLane({ timeout: 600_000 }), async (t) => {
  const probe = spawnSync('ssh-keygen', ['-V'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') { t.skip('ssh-keygen is unavailable'); return; }
  // The ledger signs each of its commits (ledger.signing: commit) with a key of this case's own,
  // named in a global configuration that includes the run's own, so no repository setting changes.
  const previous = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'SINGULARITY_FLOW_WORKSPACE_REGISTRY', 'SINGULARITY_FLOW_ACTIVE_WORKSPACE',
    'SINGULARITY_FLOW_LEAD_REGISTRY'].map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const f = await repository(t, {
    root: (base) => path.join(base, 'workspace/repos/app'),
    configure: (configuration) => { configuration.ledger.signing = 'commit'; }
  });
  const keys = path.join(f.base, 'keys');
  await mkdir(keys);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'packager@example.com', '-f', path.join(keys, 'ledger')], keys);
  const publicKey = (await readFile(path.join(keys, 'ledger.pub'), 'utf8')).trim();
  await writeFile(path.join(keys, 'allowed-signers'), `packager@example.com namespaces="git" ${publicKey}\n`);
  // Git writes the file, so each path is encoded as Git reads it: a Windows path written raw has
  // backslashes Git takes for escapes, and every Git command then refuses the configuration.
  const globalConfiguration = path.join(f.base, 'signing.gitconfig');
  const configure = (key, value) => run('git', ['config', '--file', globalConfiguration, key, value], f.base);
  if (previous.GIT_CONFIG_GLOBAL) configure('include.path', previous.GIT_CONFIG_GLOBAL);
  configure('gpg.format', 'ssh');
  configure('user.signingkey', path.join(keys, 'ledger'));
  configure('gpg.ssh.allowedSignersFile', path.join(keys, 'allowed-signers'));
  process.env.GIT_CONFIG_GLOBAL = globalConfiguration;
  Object.assign(process.env, { SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'active.json'), SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.base, 'leads.json') });
  const workspacePath = path.join(f.base, 'workspace');
  const now = new Date().toISOString();
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({ version: 1, id: 'evidence', name: 'Evidence',
    createdAt: now, updatedAt: now, anchor: { provider: 'workspace', key: 'evidence', title: 'Evidence', fetchedAt: now },
    leadRepository: 'app', capabilities: [], repositories: { app: { url: f.remote, path: 'repos/app', defaultBranch: 'main', capabilities: [] } } }));
  await rememberWorkspace(process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(workspacePath));

  // A Story in its own worktree: its intake published, reviewed and approved, then cancelled, so
  // retention may remove the worktree once it has proved every byte is published.
  const WORK = 'SIGNED-1', BRANCH = 'delivery/signed-1';
  const started = JSON.parse(f.cli(f.root, 'start', WORK, '--isolated-worktree', '--from-branch', 'main', '--ref', BRANCH,
    '--work-type', 'feature', '--title', 'Signed evidence', '--description', 'Maintenance never rewrites signed evidence.', '--json').stdout);
  const worktree = (started.data ?? started).repositoryPath;
  await publishIntake(f, worktree, WORK);
  f.cli(worktree, 'submit', 'intake', '--skip-checks');
  f.cli(worktree, 'approve', 'intake', '--yes');
  f.cli(worktree, 'cancel', '--reason', 'Evidence qualification', '--confirm', WORK, '--json');
  assert.equal(f.remoteRef(`refs/heads/${BRANCH}`), f.git(worktree, 'rev-parse', 'HEAD'), 'the cancelled Story is published');
  assert.match(f.git(f.root, 'cat-file', 'commit', 'refs/heads/state'), /^gpgsig /mu, 'the ledger commits are signed');
  const submissions = f.git(f.root, 'ls-tree', '-r', '--name-only', BRANCH, `singularity/work-items/${WORK}/submissions`);
  assert.ok(submissions.split('\n').some(Boolean), 'the Story carries its review packet as evidence');

  const local = () => ledgerAndEvidence([], f.root, BRANCH);
  const remote = () => ledgerAndEvidence(['--git-dir', f.remote], f.base, BRANCH);
  const verified = (cwd) => {
    const result = JSON.parse(f.cli(cwd, 'ledger', 'verify', '--json').stdout);
    assert.equal(result.valid, true, JSON.stringify(result));
    return result.entries;
  };
  const before = { local: local(), remote: remote(), entries: verified(worktree) };
  assert.ok(before.local.objects > 0 && before.entries > 0);
  const unchanged = (step, cwd) => {
    assert.deepEqual(local(), before.local, `${step}: local ledger, pins or evidence changed`);
    assert.deepEqual(remote(), before.remote, `${step}: remote ledger, pins or evidence changed`);
    assert.equal(verified(cwd), before.entries, `${step}: the ledger no longer verifies with the same entries`);
  };

  for (const cwd of [worktree, f.root]) f.cli(cwd, 'index', 'rebuild', '--json');
  unchanged('index rebuild', worktree);

  // Every stored record read through its family's migrations, in-process and by the CLI readers.
  const families = new Set();
  for (const [ref, prefix] of [['refs/heads/state', '$state/'], [BRANCH, '']]) {
    for (const line of f.git(f.root, 'ls-tree', '-r', ref).split('\n')) {
      const [meta, stored] = line.split('\t');
      const [, type, object] = meta.split(' ');
      const family = type === 'blob' && stored.endsWith('.json') ? familyForStoredPath(`${prefix}${stored}`) : null;
      if (!family) continue;
      const bytes = run('git', ['cat-file', 'blob', object], f.root, { encoding: 'buffer' }).stdout;
      assert.ok(readRecord(family.id, bytes).record, `${stored} reads as ${family.id}`);
      families.add(family.id);
    }
  }
  assert.ok(families.has('ledger-entry') && families.has('story-workflow'), [...families].join(', '));
  for (const args of [['status', '--json'], ['nextsteps', '--json'], ['session', 'candidates', '--json']]) f.cli(worktree, ...args);
  unchanged('schema-migration reads', worktree);

  await saveWorkspaceRetention(workspacePath, { cancelledDays: 0 });
  const retention = await runWorkspaceRetention(workspacePath, { force: true });
  assert.ok(retention.removed.some((item) => item.root === worktree && item.status === 'cancelled'), JSON.stringify(retention));
  unchanged('retention', f.root);
});

test('imported, looped and future-phase workflows publish every transition through the lifecycle adapter (SDA-AC-010)', slowLane({ timeout: 900_000 }), async (t) => {
  const packaged = YAML.parse(await readFile(TEMPLATE, 'utf8'));
  const step = (id, label, rejectTo = [id]) => ({ label, defaultTemplate: 'common/intake.md',
    artifact: { path: `artifacts/${id}/${id}.md`, kind: 'report', minimumBytes: 50 }, writeScope: 'artifact-only',
    approval: { authorities: ['product-approvers'], minimum: 1, rejectTo } });
  // One document step per route: the fixture delivers no product change, and says so.
  const omits = ['scope', 'plan', 'implement', 'verify'].map((responsibility) => ({ responsibility,
    reason: 'A storage acceptance fixture records one document step and delivers no product change.', authority: 'quality-reviewers' }));
  const custom = ['team-handover', 'team-future', 'team-review', 'team-close'];
  for (const id of custom) assert.ok(!Object.hasOwn(packaged.phases, id), `${id} is not a packaged step`);

  // The imported definition is authored in another repository and arrives as a workflow bundle.
  const source = await repository(t, {
    configure: (configuration) => {
      configuration.phases['team-handover'] = step('team-handover', 'Team handover');
      configuration.workTypes['imported-handover'] = { label: 'Imported handover', phases: ['team-handover'], omits };
    },
    agent: { id: 'handover-steward', phases: ['team-handover'] }
  });
  const f = await repository(t, {
    configure: (configuration) => {
      configuration.phases['team-future'] = step('team-future', 'Team future step');
      configuration.phases['team-review'] = step('team-review', 'Team review', ['team-future', 'team-review']);
      configuration.phases['team-close'] = step('team-close', 'Team close');
      configuration.workTypes['future-close'] = { label: 'Future close', phases: ['team-future'], omits };
      configuration.workTypes['team-loop'] = { label: 'Team loop', phases: ['team-future', 'team-review', 'team-close'],
        reworkLoops: [{ from: 'team-review', to: 'team-future', maxAttempts: 2 }], omits };
    },
    agent: { id: 'loop-steward', phases: ['team-future', 'team-review', 'team-close'] }
  });
  const bundle = path.join(source.base, 'imported-handover.json');
  await exportWorkflowBundle(source.root, ['imported-handover'], bundle);
  const plan = await planWorkflowImport(f.root, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  const imported = await applyWorkflowImport(f.root, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(imported.status, 'imported');
  f.git(f.root, 'add', '.');
  f.git(f.root, 'commit', '-qm', 'Import the imported-handover workflow');
  f.git(f.root, 'push', '-q', 'origin', 'main');

  /** The transition just made is on the remote with the ledger, and stored only in the Story's record. */
  const landed = async (workId, label) => {
    const head = f.git(f.root, 'rev-parse', 'HEAD');
    assert.equal(f.remoteRef(`refs/heads/${workId}`), head, `${label}: the lifecycle commit is on the remote Story branch`);
    assert.equal(f.remoteRef('refs/heads/state'), f.git(f.root, 'rev-parse', 'refs/heads/state'), `${label}: the ledger is published with it`);
    assert.equal(await readPendingPublication(f.root, { kind: 'story', id: workId, migrate: false }), null, `${label}: nothing is retained`);
    const changed = f.git(f.root, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
    assert.ok(changed.length && changed.every((file) => file.startsWith(`singularity/work-items/${workId}/`)),
      `${label}: stored outside the Story's record: ${changed.join(', ')}`);
    return f.git(f.root, 'log', '-1', '--format=%s');
  };
  const document = (phase) => `# ${phase}\n\nThis step records one reviewed document for the storage acceptance fixture, and nothing else.\n`;

  for (const [workId, workType, phase] of [['IMP-1', 'imported-handover', 'team-handover'],
    ['FUT-1', 'future-close', 'team-future'], ['LOOP-1', 'team-loop', 'team-future']]) {
    f.git(f.root, 'switch', '-q', 'main');
    f.cli(f.root, 'start', workId, '--from-branch', 'main', '--work-type', workType, '--title', `${workType} acceptance`,
      '--description', 'Publish each lifecycle step through the adapter.');
    assert.equal(f.remoteRef(`refs/heads/${workId}`), f.git(f.root, 'rev-parse', 'HEAD'), `${workType}: the start is on the remote`);
    await publishStep(f, f.root, workId, phase, document(phase));
    assert.match(await landed(workId, `${workType} ${phase} publish`), new RegExp(`\\[phase:${phase}\\]\\[generated:1\\]`, 'u'));
  }

  // Round the declared rework loop once: approve the first step, review the second, send it back.
  f.cli(f.root, 'submit', 'team-future', '--skip-checks');
  assert.match(await landed('LOOP-1', 'team-future submit'), /\[phase:team-future\]\[submit\]/u);
  f.cli(f.root, 'approve', 'team-future', '--yes');
  assert.match(await landed('LOOP-1', 'team-future approve'), /\[phase:team-future\]\[approve\]/u);
  f.cli(f.root, 'prepare', 'team-review');
  await publishStep(f, f.root, 'LOOP-1', 'team-review', document('team-review'));
  await landed('LOOP-1', 'team-review publish');
  f.cli(f.root, 'submit', 'team-review', '--skip-checks');
  await landed('LOOP-1', 'team-review submit');
  f.cli(f.root, 'reject', 'team-review', '--to', 'team-future', '--reason', 'Round the declared rework loop once.');
  assert.match(await landed('LOOP-1', 'team-review reject'), /\[phase:team-review\]\[reject\] return to team-future/u);
  const looped = JSON.parse(f.cli(f.root, 'status', '--json').stdout);
  assert.equal(looped.currentPhase, 'team-future');
  assert.equal(looped.phases['team-future'].status, 'in_progress');
});
