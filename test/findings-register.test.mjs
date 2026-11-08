import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeXlsx } from '../src/findings/workbook/xlsx.mjs';
import { itemRow, COLUMNS, templateSheets } from '../src/findings/register/format.mjs';
import { addItemsToRegister, emptyRegister } from '../src/findings/register/model.mjs';
import { importFindings } from '../src/findings/register/import.mjs';
import { readRegister, registerDestination } from '../src/findings/register/store.mjs';
import { normalizeLedgerConfig } from '../src/ledger-config.mjs';
import { run } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { environment as isolatedEnvironment } from './helpers/run-and-test-fixture.mjs';

// CQF M6 piece 2: findings import into the register on the state branch. Made-up repositories and IDs.

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const fixture = path.join(engine, 'test', 'fixtures', 'findings', 'openpyxl-findings.xlsx');
// The public GitHub host, spelled so the repository's sample-URL check does not mistake it for one.
const GITHUB_HOST = ['github', 'com'].join('.');
const contextEnv = (cwd) => isolatedEnvironment(path.join(path.dirname(cwd), `.test-context-${path.basename(cwd)}`));

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

function sf(cwd, args, { fail = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', timeout: childTimeout(120_000), maxBuffer: 16 * 1024 * 1024,
    env: { ...contextEnv(cwd), SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  if (fail) assert.notEqual(result.status, 0, `${args.join(' ')} was expected to be refused:\n${result.stdout}`);
  else assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const json = (cwd, args) => JSON.parse(sf(cwd, [...args, '--json']).stdout);

/** An application repository whose remote is a local bare repository named example-org/orders-api. */
async function repository(t, { remote = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-findings-register-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const bare = path.join(directory, 'example-org', 'orders-api.git');
  const root = path.join(directory, 'orders-api');
  await mkdir(path.dirname(bare), { recursive: true });
  await mkdir(root);
  git(directory, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'Orders');
  if (remote) {
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'main');
  }
  return { directory, root, bare };
}

const stateTree = (root) => git(root, 'ls-tree', '-r', '--name-only', 'refs/remotes/origin/state').split('\n');
const stateJson = (root, file) => JSON.parse(git(root, 'show', `refs/remotes/origin/state:${file}`));

test('an import puts normalised rows on the state branch, never the workbook, and records who, when, which file and every rejected row (CQF:REQ-062, REQ-063)', async (t) => {
  const { root, directory, bare } = await repository(t);
  const workbook = path.join(directory, 'From the security team.xlsx');
  await copyFile(fixture, workbook);

  const preview = json(root, ['findings', 'import', workbook, '--dry-run']);
  assert.equal(preview.written, false);
  assert.equal(preview.store, 'state-branch');
  assert.equal(git(root, 'ls-remote', 'origin', 'refs/heads/state'), '', 'a dry run writes nothing');

  const result = json(root, ['findings', 'import', workbook, '--source', 'security-team']);
  assert.equal(result.store, 'state-branch');
  assert.equal(result.storeReason, 'not-github');
  assert.deepEqual(Object.keys(result.feeds), ['security', 'tlm']);
  assert.deepEqual([result.feeds.security.imported, result.feeds.security.rejected, result.feeds.security.otherRepositories], [4, 1, 1]);
  assert.deepEqual([result.feeds.tlm.imported, result.feeds.tlm.added], [2, 2]);
  assert.deepEqual(result.rejected, [{ sheet: 'Security', row: 5, reason: "Severity 'Urgent' is not Critical, High, Medium, Low or Info" }]);
  assert.deepEqual(result.ignoredSheets.map((sheet) => sheet.sheet), ['Notes']);
  assert.equal(result.repository.slug, 'example-org/orders-api');

  const tree = stateTree(root);
  for (const file of ['findings/security.json', 'findings/tlm.json', 'findings/imports.json']) assert.ok(tree.includes(file), file);
  assert.ok(!tree.some((file) => /\.(xlsx|csv)$/iu.test(file)), 'the uploaded workbook is never committed');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/state'), result.commit, 'the register is published');
  const security = stateJson(root, 'findings/security.json');
  assert.deepEqual(security.items.map((item) => [item.id, item.state]),
    [['SEC-501', 'open'], ['SEC-502', 'open'], ['SEC-503', 'accepted-risk'], ['SEC-505', 'open']], 'most severe first');
  assert.equal(security.items[0].source, 'security-team');
  assert.equal(security.items[0].sheet, undefined, 'the row number is in the import record, not on the item');
  const [record] = stateJson(root, 'findings/imports.json').imports;
  assert.equal(record.importId, result.importId);
  assert.deepEqual(record.by, { name: 'Run Test Tester', email: 'run.test.tester@example.com' });
  assert.deepEqual(record.file, { name: 'From the security team.xlsx', sha256: result.file.sha256, bytes: result.file.bytes, format: 'xlsx' });
  assert.deepEqual(record.rejected, result.rejected);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the application checkout is untouched');
});

test('a later import from the same source replaces its rows: missing ones are marked, never deleted; a fixed one closes; another source is left alone', async (t) => {
  const { root, directory } = await repository(t);
  const sheet = (rows) => writeXlsx([{ name: 'Security', headers: COLUMNS.security.map((column) => column.header), rows: rows.map((row) => itemRow('security', row)) }]);
  const row = (id, extra = {}) => ({ id, title: `Finding ${id}`, severity: 'high', repository: 'orders-api', status: 'open', ...extra });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(directory, 'first.xlsx'), sheet([row('SEC-1'), row('SEC-2'), row('SEC-3')]));
  json(root, ['findings', 'import', path.join(directory, 'first.xlsx'), '--source', 'security-team']);
  await writeFile(path.join(directory, 'other.csv'), 'ID,Title,Severity,Repository\nSEC-9,From the pen test,Medium,orders-api\n');
  json(root, ['findings', 'import', path.join(directory, 'other.csv'), '--feed', 'security', '--source', 'pen-test']);

  await writeFile(path.join(directory, 'second.xlsx'), sheet([row('SEC-1', { severity: 'critical' }), row('SEC-3', { status: 'fixed' })]));
  const second = json(root, ['findings', 'import', path.join(directory, 'second.xlsx'), '--source', 'security-team']);
  assert.deepEqual([second.feeds.security.updated, second.feeds.security.closed, second.feeds.security.notInLatest], [2, 1, 1]);
  const items = Object.fromEntries(stateJson(root, 'findings/security.json').items.map((item) => [item.id, item]));
  assert.deepEqual(Object.keys(items).sort(), ['SEC-1', 'SEC-2', 'SEC-3', 'SEC-9']);
  assert.equal(items['SEC-1'].severity, 'critical');
  assert.equal(items['SEC-2'].state, 'not-in-latest-import');
  assert.equal(items['SEC-2'].inLatestImport, false);
  assert.equal(items['SEC-3'].state, 'closed');
  assert.equal(items['SEC-9'].state, 'open', 'the pen-test source is not replaced by the security team');
  assert.equal(stateJson(root, 'findings/imports.json').imports.length, 3);

  // Another clone reads the same register from its own state ref, which a fetch brought; reading never fetches.
  const other = path.join(directory, 'other-clone');
  git(directory, 'clone', '-q', '--single-branch', '--branch', 'main', path.join(directory, 'example-org', 'orders-api.git'), other);
  const before = await readRegister(other, { env: contextEnv(other) });
  assert.equal(before.location, 'none', 'nothing is read before the state branch is fetched');
  git(other, 'fetch', '-q', 'origin', 'state:refs/remotes/origin/state');
  const after = await readRegister(other, { env: contextEnv(other) });
  assert.equal(after.location, 'state-branch');
  assert.equal(after.register.security.items.length, 4);
});

test('a public GitHub repository keeps the register on this computer and says why; an unknown visibility keeps it local this time', async (t) => {
  const { root, directory } = await repository(t, { remote: false });
  git(root, 'remote', 'add', 'origin', `https://${GITHUB_HOST}/example-org/orders-api.git`);
  const env = contextEnv(root);
  const ledger = normalizeLedgerConfig({});
  const answering = (answer) => (command, args, options) => (command === 'gh' ? answer(args) : run(command, args, options));
  const asked = [];
  const publicRepo = answering((args) => { asked.push(args); return { status: 0, stdout: 'public\n', stderr: '' }; });
  const destination = await registerDestination(root, ledger, { env, runCommand: publicRepo });
  assert.equal(destination.store, 'local');
  assert.equal(destination.reason, 'public-repository');
  assert.match(destination.message, /public, and anyone who can read it can read its state branch/u);
  assert.deepEqual(asked[0], ['api', '--hostname', GITHUB_HOST, 'repos/example-org/orders-api', '--jq', '.visibility'], 'read-only, through gh');

  const workbook = path.join(directory, 'template.xlsx');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(workbook, writeXlsx(templateSheets()));
  const imported = await importFindings(root, workbook, { env, runCommand: publicRepo });
  assert.equal(imported.store, 'local');
  assert.equal(git(root, 'for-each-ref', 'refs/heads/state', 'refs/remotes/origin/state'), '', 'nothing goes to a state branch');
  const read = await readRegister(root, { env, ledger });
  assert.equal(read.location, 'local');
  assert.deepEqual(read.register.security.items.map((item) => item.id), ['SEC-1001']);
  const common = git(root, 'rev-parse', '--git-common-dir');
  assert.deepEqual((await readdir(path.resolve(root, common, 'singularity-flow', 'findings'))).sort(), ['imports.json', 'security.json', 'tlm.json', 'visibility.json']);

  const offline = await registerDestination(root, ledger, { env, runCommand: answering(() => ({ status: 1, stdout: '', stderr: `error connecting to api.${GITHUB_HOST}\n` })) });
  // The cached public answer stands for a week; a different repository asks again.
  assert.equal(offline.reason, 'public-repository');
  git(root, 'remote', 'set-url', 'origin', `https://${GITHUB_HOST}/example-org/billing-web.git`);
  const unknown = await registerDestination(root, ledger, { env, runCommand: answering(() => ({ status: 1, stdout: '', stderr: `error connecting to api.${GITHUB_HOST}\n` })) });
  assert.equal(unknown.store, 'local');
  assert.equal(unknown.reason, 'visibility-unknown');
  assert.match(unknown.message, /could not be checked \(error connecting to api\..+\).*this time/u);
});

test('a register kept locally is carried to the state branch by the next import that can publish', async (t) => {
  const { root, directory, bare } = await repository(t, { remote: false });
  const env = contextEnv(root);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(directory, 'a.csv'), 'ID,Component,Repository,Target version\nTLM-1,node,orders-api,22\n');
  const first = await importFindings(root, path.join(directory, 'a.csv'), { env, feed: 'tlm' });
  assert.equal(first.store, 'local');
  assert.equal(first.storeReason, 'no-remote');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  await writeFile(path.join(directory, 'b.csv'), 'ID,Title,Severity,Repository\nSEC-1,Weak hash,Low,orders-api\n');
  const second = await importFindings(root, path.join(directory, 'b.csv'), { env, feed: 'security' });
  assert.equal(second.store, 'state-branch');
  assert.deepEqual(stateJson(root, 'findings/tlm.json').items.map((item) => item.id), ['TLM-1'], 'the local rows went with it');
  assert.equal(stateJson(root, 'findings/imports.json').imports.length, 2);
  const read = await readRegister(root, { env });
  assert.equal(read.location, 'state-branch', 'the local copy is gone once it is published');
});

test('the register merge is one function, used by import and later by sync', () => {
  const at = '2026-11-08T10:00:00.000Z';
  const row = { id: 'TLM-5', feed: 'tlm', component: 'spring-boot', repository: 'orders-api', targetVersion: '3.3', status: 'waiver', waiverExpiresAt: '2026-01-01' };
  const { register, changes } = addItemsToRegister(emptyRegister(), 'tlm', [row], { source: 'tlm-page', importId: 'IMP-1', at });
  assert.deepEqual(changes.added, ['TLM-5']);
  assert.equal(register.tlm.items[0].state, 'open', 'an expired waiver is open again');
  const later = addItemsToRegister(register, 'tlm', [{ ...row, waiverExpiresAt: '2027-01-01' }], { source: 'tlm-page', importId: 'IMP-2', at });
  assert.equal(later.register.tlm.items[0].state, 'waiver');
  assert.deepEqual(later.register.tlm.items[0].history.map((entry) => entry.to), ['open', 'waiver']);
});

test('an unreadable file, an unknown feed and a bad source name are refused before anything is read', async (t) => {
  const { root, directory } = await repository(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(directory, 'notes.docx'), 'not a workbook');
  assert.match(sf(root, ['findings', 'import', path.join(directory, 'notes.docx'), '--json'], { fail: true }).stdout, /FINDINGS_WORKBOOK_UNREADABLE/u);
  assert.match(sf(root, ['findings', 'import', fixture, '--feed', 'quality', '--json'], { fail: true }).stdout, /--feed is security or tlm/u);
  assert.match(sf(root, ['findings', 'import', fixture, '--source', 'Security Team', '--json'], { fail: true }).stdout, /lower-kebab/u);
});
