/**
 * The repository never holds a secret (docs/SPEC-ENVIRONMENT-FILES-v2.md, "Attachments"). What SFlow can
 * read it scans, and what it cannot read stays out of Git. Real CLI, real repositories, fake values.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { proseValueFindings } from '../src/config-values.mjs';
import { scanEntries, scannablePath, scanText } from '../src/secrets.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { docx, zip } from './helpers/office-fixtures.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const actor = 'Attachment Tester', actorEmail = 'attachments@example.invalid';
const KEY = 'AKIAQX7MP2VL9ST4KR8W', PASSWORD = 'Xq7mP2vL9sT4kR8wZb3N';
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor, SINGULARITY_FLOW_NO_MODEL: '1',
  SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
const run = (cwd, command, args) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(120_000), maxBuffer: 1 << 26 });
const git = (cwd, ...args) => { const result = run(cwd, 'git', args); assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`); return result.stdout; };
const flow = (cwd, ...args) => run(cwd, process.execPath, [bin, ...args, '--json']);
const outcome = (result) => {
  if (result.status === 0) return 'stored';
  try { return JSON.parse(result.stdout).error?.code; } catch { return `${result.stdout}${result.stderr}`.slice(0, 200); }
};
const everywhereInGit = (root, needle) => git(root, 'log', '--all', '-p', '--text', '-S', needle, '--format=%h').includes(needle);

// A real PDF header: binary bytes follow the version line, as every PDF writer's do.
const binaryPdf = (text = '') => Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), Buffer.from([0x78, 0x9c, 0xff, 0xfe, 0x80]), Buffer.from(text)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]), Buffer.from(`tEXtComment\0${KEY}`)]);
const oleDocument = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00]), Buffer.from(`${KEY}\0`)]);

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', actor);
  git(root, 'config', 'user.email', actorEmail);
  await writeFile(path.join(root, 'README.md'), '# Attachments\n');
  assert.equal(run(root, process.execPath, [bin, 'init']).status, 0);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git.publish = 'off'; workflow.worldModel.grounding = 'off'; workflow.documents.allowedPhases = ['intake'];
  workflow.documents.storage = { allowed: ['git', 'local'], default: 'git' };
  workflow.approvalSecurity = { profile: 'poc' }; workflow.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(workflowFile, YAML.stringify(workflow));
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: actor, email: actorEmail }];
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Initialize');
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

async function attachment(t, name, content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-attachment-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  await writeFile(file, content);
  return file;
}

test('a Story document is scanned wherever it is kept, and what cannot be read stays out of Git', async (t) => {
  const root = await repository(t);
  assert.equal(flow(root, 'start', 'ATT-1', '--from-branch', 'main', '--title', 'Attachments').status, 0);
  const secretText = {
    'notes.md': `aws_access_key_id = ${KEY}\n`, 'prose.md': `Log in with password: ${PASSWORD} on the staging box.\n`, 'sentence.txt': `The password is ${PASSWORD}.\n`,
    'dump.sql': `CREATE USER app IDENTIFIED BY '${PASSWORD}';\n`, 'export.csv': `name,token\nprod,token=${PASSWORD}\n`, 'noextension': `api key: ${PASSWORD}\n`,
    'text-named.pdf': `%PDF-1.4\n(aws_access_key_id = ${KEY}) Tj\n`, 'brief.docx': docx(['Setup', `aws_access_key_id = ${KEY}`])
  };
  for (const [name, content] of Object.entries(secretText)) {
    const file = await attachment(t, name, content);
    for (const store of ['git', 'local']) assert.equal(outcome(flow(root, 'documents', 'upload', file, '--name', `${name} ${store}`, '--store', store)), 'SECRET_DETECTED', `${name} --store ${store}`);
  }
  for (const [name, content] of Object.entries({ 'brief.pdf': binaryPdf(KEY), 'shot.png': png, 'old.doc': oleDocument, 'bundle.zip': zip([['.env', `A=${KEY}\n`]]) })) {
    const file = await attachment(t, name, content);
    const refused = flow(root, 'documents', 'upload', file, '--name', `${name} git`, '--store', 'git');
    assert.equal(outcome(refused), 'DOCUMENT_UNREADABLE_IN_GIT', name);
    assert.match(JSON.parse(refused.stdout).error.message, /--store local/u, 'the refusal names the way forward');
    assert.equal(outcome(flow(root, 'documents', 'upload', file, '--name', `${name} local`, '--store', 'local')), 'stored', `${name} stays on this laptop`);
  }
  assert.equal(outcome(flow(root, 'documents', 'store', 'brief.pdf local', '--store', 'git')), 'DOCUMENT_UNREADABLE_IN_GIT', 'moving it into Git is the same door');
  const clean = await attachment(t, 'clean.md', '# The password is required, and token = getToken() is how we read it.\n');
  assert.equal(outcome(flow(root, 'documents', 'upload', clean, '--name', 'Clean', '--store', 'git')), 'stored');
  assert.ok(git(root, 'log', '--all', '-p', '--text', '--format=%h').includes('token = getToken()'), 'a clean document is committed');
  for (const needle of [KEY, PASSWORD]) assert.equal(everywhereInGit(root, needle), false);
});

test('a document given at Story start follows the same rule', async (t) => {
  const root = await repository(t);
  const pdf = await attachment(t, 'brief.pdf', binaryPdf());
  assert.equal(outcome(flow(root, 'start', 'ATT-2', '--from-branch', 'main', '--title', 'x', '--document', pdf, '--document-name', 'Brief')), 'DOCUMENT_UNREADABLE_IN_GIT');
  const leaky = await attachment(t, 'notes.md', `password: ${PASSWORD}\n`);
  assert.equal(outcome(flow(root, 'start', 'ATT-3', '--from-branch', 'main', '--title', 'x', '--document', leaky, '--document-name', 'Notes')), 'SECRET_DETECTED');
  assert.equal(everywhereInGit(root, PASSWORD), false);
  assert.equal(outcome(flow(root, 'start', 'ATT-4', '--from-branch', 'main', '--title', 'x', '--document', pdf, '--document-name', 'Brief', '--document-store', 'local')), 'stored');
});

test('an Epic source and an Epic note are scanned, and the provider that commits takes only what can be read', async (t) => {
  const root = await repository(t);
  const started = flow(root, 'epic', 'start', '--local', '--title', 'Attachments', '--description', 'd', '--goal', 'g');
  assert.equal(started.status, 0, started.stdout.slice(0, 500));
  const value = JSON.parse(started.stdout);
  const epic = value.initiative?.id ?? value.initiativeId ?? value.epicId ?? value.epic?.id ?? value.id;
  assert.ok(epic, Object.keys(value).join(','));
  const add = async (name, content) => outcome(flow(root, 'epic', 'sources', 'add', '--epic', epic, '--provider', 'local', '--file', await attachment(t, name, content)));
  assert.equal(await add('notes.md', `aws_access_key_id = ${KEY}\n`), 'SECRET_DETECTED');
  assert.equal(await add('prose.md', `password: ${PASSWORD}\n`), 'SECRET_DETECTED');
  assert.equal(await add('brief.docx', docx([`aws_access_key_id = ${KEY}`])), 'SECRET_DETECTED');
  assert.equal(await add('.env.backup', `A=${KEY}\n`), 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
  for (const [name, content] of [['brief.pdf', binaryPdf()], ['shot.png', png], ['bundle.zip', zip([['a.txt', 'a\n']])]]) {
    const refused = flow(root, 'epic', 'sources', 'add', '--epic', epic, '--provider', 'local', '--file', await attachment(t, name, content));
    assert.equal(outcome(refused), 'DOCUMENT_UNREADABLE_IN_GIT', name);
    assert.match(JSON.parse(refused.stdout).error.message, /epic sources note/u, 'an Epic has no laptop-only store, so its way forward says what does work');
  }
  const note = (text) => attachment(t, 'note.txt', text).then((file) => outcome(flow(root, 'epic', 'sources', 'note', '--epic', epic, '--text-file', file, '--label', 'Notes')));
  assert.equal(await note(`Log in with password: ${PASSWORD}\n`), 'SECRET_DETECTED');
  assert.equal(await note('We ship on Friday.\n'), 'stored');
  assert.equal(await add('brief.md', '# A clean brief\n'), 'stored');
  for (const needle of [KEY, PASSWORD]) assert.equal(everywhereInGit(root, needle), false);
});

test('a value in a sentence is found, and what only looks like one is not', () => {
  const values = (line) => proseValueFindings(line).map((finding) => finding.name);
  for (const [line, name] of [
    [`The password is ${PASSWORD}.`, 'password'], [`password: ${PASSWORD} on staging`, 'password'], [`API key: ${PASSWORD}`, 'API_key'],
    [`client secret = "${PASSWORD}"`, 'client_secret'], [`CREATE USER a IDENTIFIED BY '${PASSWORD}';`, 'password'], [`ALTER ROLE a WITH PASSWORD '${PASSWORD}';`, 'password'],
    ['password: hunter2', 'password']
  ]) assert.deepEqual(values(line), [name], line);
  for (const line of ['The password is required.', 'password: required', 'token = getToken()', 'password: ${DB_PASSWORD}', 'token: <your token>', 'password: changeme123', 'password is strong.',
    'secret: process.env.API_SECRET', 'A token: see the vault.', 'password: example-Xq7mP2vL9sT4', 'api key: {{ .Values.apiKey }}', 'password = os.environ["DB"]']) {
    assert.deepEqual(values(line), [], line);
  }
});

test('notes, logs and dumps are read that way at a commit too, with the usual marker and warn for what Git already has', () => {
  const blocked = (path, content, options = {}) => scanEntries([{ path, content, ...options }]).blocking.length;
  for (const file of ['notes.md', 'NOTES.TXT', 'run.log', 'a.csv', 'dump.sql', 'guide.adoc']) assert.equal(blocked(file, `password: ${PASSWORD}\n`), 1, file);
  assert.equal(blocked('src/app.js', `// password: ${PASSWORD}\n`), 0, 'source files keep the rules they had');
  assert.equal(blocked('notes.md', `password: ${PASSWORD} <!-- sflow-allow-secret: a documented sample -->\n`), 0);
  assert.equal(scanText(`password: ${PASSWORD}\n`, { path: 'notes.md', inGit: [`password: ${PASSWORD}\n`] })[0].alreadyInGit, true);
  assert.equal(blocked('noextension', `password: ${PASSWORD}\n`), 0);
  assert.equal(blocked('noextension', `password: ${PASSWORD}\n`, { attached: true }), 1, 'an attachment is read that way whatever it is called');
});

test('VS Code does not offer Git for what the engine would refuse', async () => {
  const { unreadableInGit } = await import(pathToFileURL(path.join(packageRoot, 'apps/vscode/src/evidence.ts')).href);
  for (const file of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.ico', 'a.pdf', 'a.zip', 'a.gz', 'a.tgz', 'a.mp4', 'a.mov', 'a.webp', 'a.bmp', 'a.tif', 'a.tiff', 'a.heic', 'a.fig', 'a.doc', 'a.xls', 'a.ppt', 'A.PDF']) {
    assert.equal(unreadableInGit(file), true, file);
    assert.equal(scannablePath(file.toLowerCase()), false, `${file}: the engine skips it too`);
  }
  for (const file of ['a.md', 'a.txt', 'a.svg', 'a.csv', 'a.docx', 'a.xlsx', 'a.pptx', 'a.yml', 'a.sql']) {
    assert.equal(unreadableInGit(file), false, file);
    assert.equal(scannablePath(file), true, file);
  }
});
