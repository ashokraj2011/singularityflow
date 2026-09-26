import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';
import { excludesActiveWorkspaceRouting } from '../src/cli-entry.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { parseArgs } from '../src/util.mjs';
import { readWorkflowAuthorInput, validateWorkflowAuthorRequest,
  WORKFLOW_AUTHOR_INPUT_MAX_BYTES } from '../src/commands/workflow-author.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const ID = 'WFD-CLIDRAFT1';
const GIT_HEAD = 'a'.repeat(40);
function request(...argv) { return parseArgs(['workflow', 'author', ...argv]); }

test('workflow author preflight has closed routes, targets, numeric options, and no authority shortcuts', () => {
  assert.equal(validateWorkflowAuthorRequest(request()), 'list');
  for (const argv of [
    ['list', '--limit', '64', '--cursor', '0', '--json'],
    ['read', ID, '--revision', '1'], ['history', ID], ['show', ID],
    ['op-status', 'create:one'], ['delete', ID],
    ['create', ID, '--expected-head', 'empty', '--operation-id', 'create-one'],
    ['save', ID, '--name', 'Partial draft', '--expected-head', GIT_HEAD, '--epoch', '1', '--operation-id', 'save-one'],
    ['create', ID, '--expected-head', 'empty', '--operation-id', 'create-bound', '--expected-authority', '/exact/shared.git']
  ]) assert.doesNotThrow(() => validateWorkflowAuthorRequest(request(...argv)));
  for (const argv of [
    ['submit', ID], ['read'], ['read', ID, ID], ['read', '../draft'], ['create'],
    ['create', '--expected-head', GIT_HEAD], ['save', ID, '--expected-head', 'empty', '--operation-id', 's', '--epoch', '1', '--name', 'name'],
    ['save', ID, '--expected-head', GIT_HEAD, '--operation-id', 's', '--epoch', '1'],
    ['list', '--limit', '65'], ['list', '--cursor', '0.5'], ['list', '--limit', '01'],
    ['read', ID, '--revision', '0'], ['read', ID, '--revision', '1', '--revision', '2'],
    ['list', '--json=false'], ['list', '--json', '--json'],
    ['delete', ID, '--yes'], ['delete', ID, '--confirmed', 'true'],
    ['delete', ID, '--confirm', `sha256:${'b'.repeat(64)}`],
    ['delete', ID, '--authorization', 'opaque-looking-token'],
    ['create', ID, '--actor', 'human'], ['list', '--remote', 'other'], ['list', '--model'],
    ['list', '--expected-authority', '/other'],
    ['create', ID, '--expected-head', 'empty', '--operation-id', 'create-bound', '--expected-authority', '/exact/one', '--expected-authority', '/exact/two']
  ]) assert.throws(() => validateWorkflowAuthorRequest(request(...argv)), { code: 'WCA_AUTHOR_REQUEST_INVALID' });
});

test('actual parsed author commands register deterministic model-free read and draft-write boundaries', () => {
  assert.equal(excludesActiveWorkspaceRouting('workflow', 'author'), true,
    'shared authoring must use the explicit caller repository, not a home-selected fallback');
  for (const [action, target] of [['list'], ['read', ID], ['show', ID], ['history', ID],
    ['op-status', 'op-one'], ['create', ID], ['save', ID], ['delete', ID]]) {
    const parsed = request(action, ...(target ? [target] : []));
    const operation = resolveOperation({ requestedCommand: 'workflow', ...parsed });
    assert.equal(operation.id, `workflow.author.${action}`);
    assert.equal(operation.modelPolicy, 'never');
    assert.equal(operation.classification, ['create', 'save', 'delete'].includes(action) ? 'mutation' : 'read');
  }
});

test('draft input retains incomplete definitions and literal inline assets without resolving paths', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-input-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'input.json');
  const input = { payload: { definitions: { workflows: [{ id: 'candidate', phases: ['unknown-stage'] }] },
    missingReviewer: null }, assets: [{ path: '.github/skills/candidate/SKILL.md', content: 'Literal candidate instructions\n' }] };
  await writeFile(file, JSON.stringify(input));
  assert.deepEqual(await readWorkflowAuthorInput(file), input);
  await assert.rejects(stat(path.join(base, '.github')), { code: 'ENOENT' });
});

test('draft input rejects malformed, duplicated, oversized, unsafe transport shapes without echoing content', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-input-refuse-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'input.json');
  const invalid = [
    '{"payload":{"sentinel-private-content":1},"payload":{}}',
    '{"payload":{"a":1,"a":2}}', '{"payload":{"a":1,"\\u0061":2}}',
    '{"payload":{},"actor":"human"}', '{"payload":{},"confirmed":true}',
    '{"payload":{},"authorizationToken":"not-a-capability"}', '[]', '{}',
    '{"payload":[],"assets":[]}', '{"payload":{},"assets":[{"path":"a","file":"/home/private"}]}',
    '{"payload":{},"assets":[{"path":"a","content":"\\ud800"}]}',
    JSON.stringify({ payload: { text: 'x'.repeat(256 * 1024) } }),
    JSON.stringify({ payload: {}, assets: [{ path: 'a', content: 'x'.repeat(4 * 1024 * 1024 + 1) }] }),
    `{"payload":${'['.repeat(33)}0${']'.repeat(33)}}`,
    Buffer.from([0xff, 0xfe, 0x00])
  ];
  for (const value of invalid) {
    await writeFile(file, value);
    await assert.rejects(readWorkflowAuthorInput(file), (error) => {
      assert.ok(/^WCA_INPUT_/u.test(error.code));
      assert.ok(!error.message.includes('sentinel-private-content'));
      return true;
    });
  }
  await writeFile(file, ' '.repeat(WORKFLOW_AUTHOR_INPUT_MAX_BYTES + 1));
  await assert.rejects(readWorkflowAuthorInput(file), { code: 'WCA_INPUT_LIMIT' });
  const link = path.join(base, 'linked.json');
  await symlink(file, link);
  await assert.rejects(readWorkflowAuthorInput(link), { code: 'WCA_INPUT_LIMIT' });
  await assert.rejects(readWorkflowAuthorInput(base), { code: 'WCA_INPUT_LIMIT' });
});

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr.slice(0, 2000));
  return result.stdout.trim();
}
function flowEnvironment(root) {
  return { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'WCA CLI Test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json'),
      SINGULARITY_FLOW_DISABLE_MODELS: '1' };
}
function flow(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: flowEnvironment(root) });
}
function author(root, ...args) {
  const result = flow(root, 'workflow', 'author', ...args, '--json');
  assert.equal(result.status, 0, result.stderr.slice(0, 2000));
  return JSON.parse(result.stdout);
}
async function clients(t, { environmentPolicy = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = path.join(base, 'first');
  const remote = path.join(base, 'shared.git');
  const second = path.join(base, 'second');
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  await mkdir(first);
  await initializeDefinition(first);
  if (environmentPolicy) await writeFile(path.join(first, 'singularity/environments.yml'), JSON.stringify({
    schemaVersion: 1, environments: { development: { requires: [{ name: 'LOCAL_DATA', kind: 'secret' }],
      localFiles: ['.runtime-env/**'] } }, neverCommit: ['private-runtime/**']
  }));
  git(first, 'init', '-q', '-b', 'main');
  git(first, 'config', 'user.name', 'WCA CLI First');
  git(first, 'config', 'user.email', 'wca-first@example.test');
  git(first, 'add', '.');
  git(first, 'commit', '-qm', 'approved fixture');
  git(first, 'branch', 'sflow/config');
  git(first, 'remote', 'add', 'origin', remote);
  git(first, 'push', '-q', 'origin', 'main', 'sflow/config');
  git(base, 'clone', '-q', remote, second);
  git(second, 'config', 'user.name', 'WCA CLI Second');
  git(second, 'config', 'user.email', 'wca-second@example.test');
  return { base, first, second, remote };
}

test('actual shell clients share one draft identity, preserve partial content, and keep approved files inert', async (t) => {
  const { base, first, second, remote } = await clients(t);
  for (const root of [first, second]) {
    await writeFile(path.join(root, 'contributor-note.txt'), 'Unrelated staged contributor bytes must remain unchanged.\n');
    git(root, 'add', 'contributor-note.txt');
  }
  const firstHead = git(first, 'rev-parse', 'HEAD');
  const secondHead = git(second, 'rev-parse', 'HEAD');
  const firstRefs = git(first, 'for-each-ref', '--format=%(refname) %(objectname)');
  const secondRefs = git(second, 'for-each-ref', '--format=%(refname) %(objectname)');
  const firstIndex = await readFile(path.join(first, '.git/index'));
  const secondIndex = await readFile(path.join(second, '.git/index'));
  const configuration = await readFile(path.join(first, 'singularity/workflow.yml'));
  const inputFile = path.join(base, 'candidate.json');
  const input = { payload: { id: 'partial-candidate', label: 'Partial candidate',
    definitions: { workflows: [{ id: 'partial-candidate', phases: ['unclassified-stage', 'unknown-stage'] }] },
    reviewer: null }, assets: [{ path: '.github/skills/candidate/SKILL.md', content: 'Never execute or install this draft asset.\n' }] };
  await writeFile(inputFile, JSON.stringify(input));
  const initial = author(first, 'list');
  assert.equal(initial.operation.modelPolicy, 'never');
  assert.deepEqual(initial.data.drafts, []);
  assert.equal(initial.data.head, null);
  const created = author(first, 'create', ID, '--name', 'Shared partial draft', '--input', inputFile,
    '--operation-id', 'cli-create-one', '--expected-head', 'empty');
  assert.equal(created.status, 'shared-acknowledged');
  assert.equal(created.data.record.draftId, ID);
  assert.equal(created.effects.stateChanged, true);
  assert.equal(created.effects.externalSystemsChanged, true);
  assert.equal(created.effects.filesChanged, false);
  assert.equal(created.effects.publicationCreated, false);
  assert.equal(created.capability.authorization, 'native-provider-repository-acl');
  assert.equal(created.capability.authenticatedPrincipal, 'provider-unavailable');
  const read = author(second, 'read', ID);
  assert.deepEqual(read.data.payload, input.payload);
  assert.equal(Buffer.from(read.data.assets[0].contentBase64, 'base64').toString('utf8'), input.assets[0].content);
  assert.equal(read.scope.workspaceId, created.scope.workspaceId);
  assert.deepEqual(read.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
  await assert.rejects(stat(path.join(second, '.github/skills/candidate/SKILL.md')), { code: 'ENOENT' });
  const replay = author(first, 'create', ID, '--name', 'Shared partial draft', '--input', inputFile,
    '--operation-id', 'cli-create-one', '--expected-head', 'empty');
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.effects, read.effects);
  const saved = author(second, 'save', ID, '--name', 'Renamed partial draft', '--epoch', '1',
    '--operation-id', 'cli-save-one', '--expected-head', read.data.head);
  assert.equal(saved.data.record.revision, 2);
  const firstRead = author(first, 'read', ID);
  assert.equal(firstRead.data.record.displayName, 'Renamed partial draft');
  const history = author(first, 'history', ID, '--limit', '1');
  assert.equal(history.data.revisions.length, 1);
  assert.equal(history.data.nextCursor, 1);
  const status = author(second, 'op-status', 'cli-create-one');
  assert.equal(status.data.record.revision, 1);
  assert.equal(status.data.operationHead, created.data.head);
  const shown = author(second, 'show', ID);
  assert.equal(shown.data.view.subject.revision, 2);
  assert.equal(shown.data.view.assessment.execution, 'not-started');
  assert.equal(shown.data.view.assessment.coverage, 'complete-package-validation-unavailable');
  assert.ok(shown.data.view.missingDecisions.some((decision) => decision.fieldPath === 'description'));
  assert.equal(shown.data.view.graph.coverage, 'unavailable');
  assert.ok(!JSON.stringify(shown).includes('Never execute or install'));
  const deleted = author(second, 'delete', ID, '--operation-id', 'cli-delete-one');
  assert.equal(deleted.status, 'needs-human-input');
  assert.equal(deleted.data.code, 'WCA_NEEDS_HUMAN_INPUT');
  assert.equal(deleted.data.review.revisionSha256, saved.data.record.revisionSha256);
  assert.equal(deleted.data.review.expectedHead, saved.data.head);
  assert.equal(deleted.data.review.physicalErasure, 'not-promised');
  assert.deepEqual(deleted.effects, read.effects);
  assert.deepEqual(deleted.data.handoff.argv.slice(0, 4), ['workflow', 'author', 'delete', ID]);
  assert.ok(!JSON.stringify(deleted).includes('authorizationToken'));
  assert.equal(author(first, 'read', ID).data.head, saved.data.head, 'headless deletion must not move the canonical ref');
  const other = author(first, 'create', 'WFD-OTHER123', '--expected-head', saved.data.head,
    '--operation-id', 'cli-create-other');
  const sameRevision = author(second, 'show', ID);
  assert.equal(sameRevision.data.view.durability.head, other.data.head);
  assert.equal(sameRevision.data.view.viewSha256, shown.data.view.viewSha256,
    'another draft advancing transport must not change this exact revision assessment');
  assert.equal(git(first, 'rev-parse', 'HEAD'), firstHead);
  assert.equal(git(second, 'rev-parse', 'HEAD'), secondHead);
  assert.equal(git(first, 'for-each-ref', '--format=%(refname) %(objectname)'), firstRefs);
  assert.equal(git(second, 'for-each-ref', '--format=%(refname) %(objectname)'), secondRefs);
  assert.deepEqual(await readFile(path.join(first, '.git/index')), firstIndex);
  assert.deepEqual(await readFile(path.join(second, '.git/index')), secondIndex);
  assert.deepEqual(await readFile(path.join(first, 'singularity/workflow.yml')), configuration);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), firstHead);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/sflow/config'), firstHead);
});

test('actual CLI refuses unknown authority flags before discovery and blocks secret sharing before a ref exists', async (t) => {
  const { base, first, remote } = await clients(t);
  for (const args of [['delete', ID, '--yes'], ['list', '--actor', 'human'], ['list', '--json=false']]) {
    const result = flow(base, 'workflow', 'author', ...args, '--json');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WCA_AUTHOR_REQUEST_INVALID/u);
  }
  const input = path.join(base, 'unsafe.json');
  await writeFile(input, JSON.stringify({ payload: { note: `api_key=sk-${'a'.repeat(48)}` } }));
  const blocked = flow(first, 'workflow', 'author', 'create', ID, '--input', input,
    '--operation-id', 'secret-create', '--expected-head', 'empty', '--json');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /WCA_DRAFT_CONTENT_BLOCKED/u);
  assert.ok(!blocked.stderr.includes(`sk-${'a'.repeat(48)}`));
  const blockedName = flow(first, 'workflow', 'author', 'create', ID,
    '--name', `api_key=sk-${'a'.repeat(48)}`, '--operation-id', 'secret-name-create',
    '--expected-head', 'empty', '--json');
  assert.notEqual(blockedName.status, 0);
  assert.match(blockedName.stderr, /WCA_DRAFT_CONTENT_BLOCKED/u);
  assert.ok(!blockedName.stderr.includes(`sk-${'a'.repeat(48)}`));
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/sflow/drafts'), '');
});

test('actual CLI takes environment-local storage exclusions from refreshed approved scope, not mutable checkout or draft input', async (t) => {
  const { base, first, remote } = await clients(t, { environmentPolicy: true });
  await writeFile(path.join(first, 'singularity/environments.yml'), JSON.stringify({
    schemaVersion: 1, environments: { development: { requires: [{ name: 'LOCAL_DATA', kind: 'secret' }],
      localFiles: [] } }, neverCommit: []
  }));
  const input = path.join(base, 'local-exclusion.json');
  await writeFile(input, JSON.stringify({ payload: { environmentDeclaration: { neverCommit: [] } },
    assets: [{ path: '.runtime-env/settings.json', content: 'Harmless literal, but this approved path is local-only.\n' }] }));
  const refused = flow(first, 'workflow', 'author', 'create', ID, '--input', input,
    '--expected-head', 'empty', '--operation-id', 'approved-environment-block', '--json');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /WCA_DRAFT_CONTENT_BLOCKED/u);
  assert.ok(!refused.stderr.includes('Harmless literal'));
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/sflow/drafts'), '');
});

test('actual CLI refuses stale observed authority even when the replacement is an exact clone with the same draft head', async (t) => {
  const { base, first, remote } = await clients(t);
  const observed = author(first, 'list');
  const created = author(first, 'create', ID, '--expected-head', 'empty', '--operation-id', 'authority-create',
    '--expected-authority', observed.capability.repository);
  const alternate = path.join(base, 'alternate.git');
  git(base, 'clone', '-q', '--mirror', remote, alternate);
  assert.equal(git(alternate, 'rev-parse', 'refs/heads/sflow/drafts/configuration'), created.data.head);
  const originalHeads = git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
  const alternateHeads = git(alternate, 'for-each-ref', '--format=%(refname) %(objectname)');
  git(first, 'remote', 'set-url', 'origin', alternate);
  const replacement = author(first, 'list');
  assert.equal(replacement.data.head, created.data.head);
  assert.equal(replacement.capability.repository, alternate);
  assert.notEqual(replacement.capability.repository, observed.capability.repository);
  for (const args of [
    ['save', ID, '--name', 'Must not replace cloned authority', '--epoch', '1', '--operation-id', 'authority-stale-save'],
    ['create', 'WFD-STALE123', '--operation-id', 'authority-stale-create']
  ]) {
    const refused = flow(first, 'workflow', 'author', ...args, '--expected-head', created.data.head,
      '--expected-authority', observed.capability.repository, '--json');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /WCA_DRAFT_AUTHORITY_CHANGED/u);
  }
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)'), originalHeads);
  assert.equal(git(alternate, 'for-each-ref', '--format=%(refname) %(objectname)'), alternateHeads);
  const saved = author(first, 'save', ID, '--name', 'Explicitly reloaded replacement', '--epoch', '1',
    '--operation-id', 'authority-current-save', '--expected-head', replacement.data.head,
    '--expected-authority', replacement.capability.repository);
  assert.equal(saved.status, 'shared-acknowledged');
  assert.equal(saved.capability.repository, alternate);
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)'), originalHeads);
});

// macOS expect supplies an actual terminal; the simulated human answer is sent only after the
// current exact review is displayed. No test-only confirmation flag or model receipt is admitted.
test('actual terminal deletion captures one named action and current shell reads refuse the tombstone',
  { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/expect') }, async (t) => {
    const { first, second } = await clients(t);
    const created = author(first, 'create', ID, '--expected-head', 'empty', '--operation-id', 'terminal-create');
    let output;
    for (const answer of ['', 'Delete draft']) {
      output = await new Promise((resolve, reject) => {
      const fixture = [
        'set timeout 30',
        'spawn -noecho $env(SF_WCA_TEST_NODE) $env(SF_WCA_TEST_CLI) workflow author delete $env(SF_WCA_TEST_DRAFT) --operation-id terminal-delete',
        'expect {',
        '  -exact "Type Delete draft" { send -- "$env(SF_WCA_TEST_ANSWER)\\r" }',
        '  timeout { exit 124 }',
        '  eof { exit 125 }',
        '}',
        'expect { eof {} timeout { exit 124 } }',
        'set result [wait]',
        'exit [lindex $result 3]'
      ].join('\n');
      const child = spawn('/usr/bin/expect', ['-c', fixture],
      { cwd: first, env: { ...flowEnvironment(first), SF_WCA_TEST_NODE: process.execPath,
        SF_WCA_TEST_CLI: CLI, SF_WCA_TEST_DRAFT: ID, SF_WCA_TEST_ANSWER: answer },
      stdio: ['pipe', 'pipe', 'pipe'] });
      let captured = '';
      let answered = false;
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Terminal review did not finish.')); }, 30_000);
      function receive(chunk) {
        captured += chunk.toString();
        if (captured.length > 512 * 1024) { child.kill('SIGTERM'); reject(new Error('Terminal review output exceeded its test bound.')); }
        if (!answered && captured.includes('Type Delete draft')) {
          answered = true;
        }
      }
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (status) => {
        clearTimeout(timer);
        if (!answered || status !== 0) reject(new Error(`Terminal deletion failed: ${captured.slice(-2000)}`));
        else resolve(captured);
      });
      });
      if (!answer) {
        assert.match(output, /workflow\.author\.delete: cancelled/u);
        assert.equal(author(second, 'read', ID).data.head, created.data.head);
        assert.equal(author(second, 'op-status', 'terminal-delete').data.status, 'not-found');
      }
    }
    assert.match(output, /workflow\.author\.delete: shared-acknowledged/u);
    assert.ok(output.includes(created.data.record.revisionSha256));
    assert.ok(output.includes(created.data.record.content.payloadSha256));
    assert.ok(!output.includes('answerReceipt') && !output.includes('authorizationToken'));
    assert.deepEqual(author(second, 'list').data.drafts, []);
    for (const action of ['read', 'show']) {
      const refused = flow(second, 'workflow', 'author', action, ID, '--json');
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /WCA_DRAFT_DELETED/u);
    }
    const historic = author(second, 'show', ID, '--revision', '1');
    assert.equal(historic.data.view.subject.lifecycle, 'deleted');
    assert.equal(historic.data.view.primaryAction, null);
    const history = author(second, 'history', ID);
    assert.equal(history.data.tombstone.status, 'deleted');
    assert.equal(history.data.revisions.length, 1);
    const status = author(second, 'op-status', 'terminal-delete');
    assert.equal(status.data.tombstone.status, 'deleted');
  });
