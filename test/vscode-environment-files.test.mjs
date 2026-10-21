import { pathToFileURL } from 'node:url';
/**
 * Environment files in VS Code: the page's rows, the actions each status offers, the exact argv of
 * every `env files` command, the run pre-flight, and the entries from Run & test and the Run/Debug
 * Configurations editor. [docs/SPEC-ENVIRONMENT-FILES-v1.md, milestone 2]
 *
 * The fixtures have the shape the spec's command table gives `env files --json`: per file
 * { repository, app, environment, path, kind, template, source, location, status, excluded }.
 * Everything here is pure: no `vscode`, no process, no file is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const model = await import(pathToFileURL(source('views/environment-files-model.ts')).href);
const { environmentFilesHtml, ENVIRONMENT_FILES_SCRIPT, ENVIRONMENT_FILES_STYLE } = await import(pathToFileURL(source('views/environment-files-page.ts')).href);
const runModel = await import(pathToFileURL(source('views/run-and-test-model.ts')).href);
const { runAndTestHtml } = await import(pathToFileURL(source('views/run-and-test-page.ts')).href);
const { tabsRegionHtml } = await import(pathToFileURL(source('views/run-configurations-page.ts')).href);
const { commandClass } = await import(pathToFileURL(source('cli/client.ts')).href);

const STORE = '/Users/someone/shop/.git/singularity-flow/environment-files/v1';
/** A secret a real file could hold; it must never reach a row, the page or a message. */
const SECRET = 'Zk3q9Vb7Lp2Xw8Rt5Ny1Hc6Md4Gs0Jf';
const file = (overrides = {}) => ({
  repository: 'shop', app: 'payments-api', environment: 'dev', path: 'services/api/src/main/resources/application-dev.yml', kind: 'declared',
  template: 'services/api/src/main/resources/application-dev.example.yml', source: 'store',
  location: `${STORE}/dev/services/api/src/main/resources/application-dev.yml`, status: 'placed-here', excluded: true,
  placedFor: 'dev', placement: 'symlink', problem: null, ...overrides
});
const FILES = [
  file(),
  file({ app: 'payments-web', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example', source: 'store', location: `${STORE}/dev/apps/web/.env.dev`, status: 'missing',
    excluded: false, placedFor: null, placement: null }),
  file({ app: null, path: '.env.local', kind: 'personal', template: null, location: `${STORE}/dev/.env.local`, status: 'ready', excluded: false, placedFor: null, placement: null }),
  file({ environment: 'uat', app: 'payments-web', path: 'apps/web/.env.uat', template: null, source: 'linked', location: '/Users/someone/secrets/web-uat.env', status: 'linked', placedFor: null, placement: null }),
  file({ environment: 'uat', path: 'services/api/src/main/resources/application-uat.yml', template: 'services/api/src/main/resources/application-uat.example.yml',
    source: 'store', location: `${STORE}/uat/services/api/src/main/resources/application-uat.yml`, status: 'unmanaged', excluded: false, placedFor: null, placement: null })
];
const answer = (files = FILES, extra = {}) => ({ schemaVersion: 1, resultType: 'sflow-env-files', scope: 'repository', environment: null, environments: [],
  roots: {}, files, repositories: [], workspace: null, ...extra });
const reading = (files = FILES, extra = {}) => model.environmentFilesFrom(answer(files, extra));
const HERE = { activeRepository: 'shop', scope: 'repository' };

test('env files reads (the list, a location, suggestions) are reads; every action that changes a file is not', async () => {
  const reads = [['env', 'files', '--json'], ['env', 'files', 'dev', '--json'], ['env', 'files', '--workspace', '--json'], ['env', 'files', 'uat', '--repository', 'shop', '--json'],
    ['env', 'files', 'path', 'dev', '.env.dev', '--json'], ['env', 'files', 'suggest', '--json']];
  const changes = [['env', 'files', 'create', 'dev', '.env.dev', '--from-template', '--json'], ['env', 'files', 'link', 'dev', '.env.dev', '--to', '/x/y', '--json'],
    ['env', 'files', 'unlink', 'dev', '.env.dev', '--json'], ['env', 'files', 'adopt', 'dev', '.env.dev', '--json'], ['env', 'files', 'add', 'dev', '.env.local', '--personal', '--json'],
    ['env', 'files', 'remove', 'dev', '.env.local', '--personal', '--json'], ['env', 'files', 'root', 'uat', '/x', '--json'], ['env', 'files', 'root', 'uat', '--clear', '--json'],
    ['env', 'files', 'place', 'dev', '--json']];
  for (const args of reads) assert.equal(commandClass(args), 'read', args.join(' '));
  for (const args of changes) assert.equal(commandClass(args), 'mutation', args.join(' '));
  assert.equal(commandClass(['env', 'bind', 'dev', '--stdin']), 'mutation', 'the rest of env is unchanged');
  const client = await readFile(source('cli/client.ts'), 'utf8');
  const cacheable = client.slice(client.indexOf('function cacheableRead'), client.indexOf('export function commandClass'));
  assert.match(cacheable, /!\(args\[0\] === 'env' && args\[1\] === 'files'\)/, 'a list is never replayed from the read cache');
});

test('VS Code classifies every env files command as the engine does', async (t) => {
  const reads = [['env', 'files', '--json'], ['env', 'files', 'dev', '--json'], ['env', 'files', '--workspace', '--json'], ['env', 'files', 'path', 'dev', '.env.dev', '--json'],
    ['env', 'files', 'suggest', '--json']];
  const changes = [['env', 'files', 'create', 'dev', '.env.dev', '--from-template', '--json'], ['env', 'files', 'link', 'dev', '.env.dev', '--to', '/x/y', '--json'],
    ['env', 'files', 'unlink', 'dev', '.env.dev', '--json'], ['env', 'files', 'adopt', 'dev', '.env.dev', '--json'], ['env', 'files', 'add', 'dev', '.env.local', '--personal', '--json'],
    ['env', 'files', 'remove', 'dev', '.env.local', '--personal', '--json'], ['env', 'files', 'root', 'uat', '--clear', '--json'], ['env', 'files', 'place', 'dev', '--json']];
  const { ENV_SUBCOMMANDS, resolveOperation } = await import(pathToFileURL(path.join(root, 'src', 'command-registry.mjs')).href);
  if (!ENV_SUBCOMMANDS.includes('files')) return t.skip('this engine has no env files yet: VS Code and engine parity is checked once it does');
  const { parseArgs } = await import(pathToFileURL(path.join(root, 'src', 'util.mjs')).href);
  for (const args of [...reads, ...changes]) {
    assert.equal(commandClass(args), resolveOperation({ requestedCommand: args[0], ...parseArgs(args) }).classification, `engine and VS Code: ${args.join(' ')}`);
  }
});

test('the list is the engine\'s flat files[]; repository null is this repository, or in a workspace read the workspace\'s own file', () => {
  const flat = reading();
  assert.equal(flat.files.length, 5);
  assert.deepEqual(flat.environments, ['dev', 'uat']);
  assert.equal(flat.dropped, 0);
  assert.deepEqual(flat.files[1], { repository: 'shop', workspaceLevel: false, app: 'payments-web', environment: 'dev', path: 'apps/web/.env.dev', kind: 'declared',
    template: 'apps/web/.env.dev.example', source: 'store', location: `${STORE}/dev/apps/web/.env.dev`, status: 'missing', excluded: false,
    placedFor: null, placement: null, problem: null });
  assert.deepEqual(model.environmentFilesFrom({ data: answer() }).files, flat.files, 'a command-result envelope is read too');

  const alone = reading([file({ repository: null })]);
  assert.deepEqual([alone.scope, alone.files[0].repository, alone.files[0].workspaceLevel], ['repository', null, false],
    'a repository that belongs to no workspace has no ID; its files are not the workspace\'s');
  const workspace = model.environmentFilesFrom(answer([file({ repository: 'billing', path: 'config/dev.yml' }), file({ repository: null, app: null, path: '.env', excluded: null })],
    { scope: 'workspace', environments: ['dev', 'uat', 'prod'], roots: { uat: '/Volumes/secure/uat', qa: 'relative/not-allowed' } }));
  assert.deepEqual(workspace.files.map((entry) => [entry.repository, entry.workspaceLevel, entry.path]), [['billing', false, 'config/dev.yml'], [null, true, '.env']]);
  assert.deepEqual(workspace.environments, ['dev', 'uat', 'prod'], 'declared environments without files are tabs too');
  assert.deepEqual(workspace.roots, { uat: '/Volumes/secure/uat' }, 'a folder is an absolute path');

  const odd = reading([
    file({ path: '/etc/passwd' }), file({ path: '../outside/.env' }), file({ path: 'apps/*/.env.dev' }), file({ environment: 'no spaces' }),
    file({ path: 'apps/web/.env.qa', status: 'exploded', location: 'relative/location', placement: 'teleport', problem: 'weird' }), file({ repository: 'bad repo' }), { path: 'x' }, null
  ]);
  assert.equal(odd.files.length, 1, 'absolute, escaping and glob paths, bad names and non-entries are not rows');
  assert.equal(odd.dropped, 7);
  assert.deepEqual([odd.files[0].status, odd.files[0].location, odd.files[0].placement, odd.files[0].problem], ['unknown', null, null, null]);
  assert.deepEqual(model.fileActions(odd.files[0]), [], 'an unknown status offers nothing');
  assert.equal(reading([file(), file()]).files.length, 1, 'one row per repository, environment and path');
  assert.equal(model.environmentFilesFrom({ resultType: 'something-else' }), null, 'not a file list at all');
  assert.equal(model.environmentFilesFrom(null), null);
});

test('each status offers its actions; Open and Reveal only where a real file is, Adopt only for an unmanaged one', () => {
  const actions = (overrides) => model.fileActions(model.environmentFilesFrom([file(overrides)]).files[0]);
  assert.deepEqual(actions({ status: 'missing', source: null }), ['create', 'link']);
  assert.deepEqual(actions({ status: 'missing', source: null, template: null }), ['create-empty', 'link'], 'no template: an empty file');
  assert.deepEqual(actions({ status: 'missing', source: 'linked' }), ['link', 'unlink'], 'a linked file that went away: another one, or stop using it');
  assert.deepEqual(actions({ status: 'ready' }), ['open', 'reveal', 'link']);
  assert.deepEqual(actions({ status: 'placed-here', source: 'root' }), ['open', 'reveal', 'link']);
  assert.deepEqual(actions({ status: 'linked', source: 'linked' }), ['open', 'reveal', 'unlink']);
  assert.deepEqual(actions({ status: 'placed-here', source: 'linked' }), ['open', 'reveal', 'unlink']);
  assert.deepEqual(actions({ status: 'unmanaged', source: null }), ['adopt']);
  assert.deepEqual(actions({ status: 'ready', kind: 'personal' }), ['open', 'reveal', 'link', 'remove'], 'a personal file can be removed');
  assert.deepEqual(actions({ status: 'missing', kind: 'personal', template: null, source: null }), ['create-empty', 'link', 'remove']);
  assert.deepEqual([...model.CHANGING_ACTIONS].sort(), ['adopt', 'create', 'create-empty', 'link', 'remove', 'unlink'], 'Open and Reveal change nothing');
  assert.deepEqual(model.ACTION_LABELS, { create: 'Create from template', 'create-empty': 'Create empty file', open: 'Open', link: 'Use existing file…',
    adopt: 'Adopt', reveal: 'Reveal', unlink: 'Stop using linked file', remove: 'Remove personal file' });
});

test('every env files command is exact argv; another repository or a workspace file is named only in workspace scope', () => {
  const [ready, missing, personal, linked, unmanaged] = reading().files;
  assert.deepEqual(model.envFilesArgv(), ['env', 'files', '--json']);
  assert.deepEqual(model.envFilesArgv({ environment: 'uat', scope: 'workspace' }), ['env', 'files', 'uat', '--workspace', '--json']);
  assert.deepEqual(model.envFilesPathArgv(ready, HERE), ['env', 'files', 'path', 'dev', 'services/api/src/main/resources/application-dev.yml', '--json']);
  assert.deepEqual(model.envFilesCreateArgv(missing, true, HERE), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template', '--json']);
  assert.deepEqual(model.envFilesCreateArgv(missing, false, HERE), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--json']);
  assert.deepEqual(model.envFilesLinkArgv(missing, '/Users/someone/secrets/web-dev.env', HERE),
    ['env', 'files', 'link', 'dev', 'apps/web/.env.dev', '--to', '/Users/someone/secrets/web-dev.env', '--json']);
  assert.deepEqual(model.envFilesUnlinkArgv(linked, HERE), ['env', 'files', 'unlink', 'uat', 'apps/web/.env.uat', '--json']);
  assert.deepEqual(model.envFilesAdoptArgv(unmanaged, HERE), ['env', 'files', 'adopt', 'uat', 'services/api/src/main/resources/application-uat.yml', '--json']);
  assert.deepEqual(model.envFilesAddArgv('dev', '.env.local'), ['env', 'files', 'add', 'dev', '.env.local', '--personal', '--json']);
  assert.deepEqual(model.envFilesRemoveArgv(personal, HERE), ['env', 'files', 'remove', 'dev', '.env.local', '--personal', '--json']);
  assert.deepEqual(model.envFilesRootArgv('uat', '/Volumes/secure/uat'), ['env', 'files', 'root', 'uat', '/Volumes/secure/uat', '--json']);
  assert.deepEqual(model.envFilesRootArgv('uat', null), ['env', 'files', 'root', 'uat', '--clear', '--json']);
  assert.deepEqual(model.envFilesSuggestArgv(), ['env', 'files', 'suggest', '--json']);
  assert.deepEqual(model.actionArgv('link', missing, HERE), null, 'linking needs the chosen file');
  assert.deepEqual(model.actionArgv('open', ready, HERE), model.envFilesPathArgv(ready, HERE), 'Open asks where the real file is now');

  const workspace = { activeRepository: 'shop', scope: 'workspace' };
  const billing = { ...missing, repository: 'billing' };
  assert.deepEqual(model.envFilesCreateArgv(missing, true, workspace), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template', '--json'], 'this window\'s own repository');
  assert.deepEqual(model.envFilesCreateArgv(billing, true, workspace), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template', '--repository', 'billing', '--json']);
  assert.deepEqual(model.envFilesPathArgv({ ...ready, repository: null, workspaceLevel: true }, workspace), ['env', 'files', 'path', 'dev', 'services/api/src/main/resources/application-dev.yml', '--workspace', '--json']);
  assert.deepEqual(model.envFilesPathArgv({ ...ready, repository: null }, workspace), ['env', 'files', 'path', 'dev', 'services/api/src/main/resources/application-dev.yml', '--json'],
    'a repository of no workspace is this checkout');

  for (const bad of [() => model.envFilesAddArgv('dev', '../outside'), () => model.envFilesAddArgv('dev', '/abs/.env'), () => model.envFilesAddArgv('d e v', '.env'),
    () => model.envFilesLinkArgv(missing, 'relative/file', HERE), () => model.envFilesRootArgv('uat', 'relative'), () => model.envFilesAddArgv('dev', 'apps/*/.env')]) {
    assert.throws(bad, /is invalid/);
  }
  assert.equal(model.personalPathProblem('apps/web/.env.local'), null);
  assert.match(model.personalPathProblem('../x'), /inside the repository/);
  assert.match(model.personalPathProblem('apps/*.env'), /pattern only protects/);
  assert.match(model.personalPathProblem('  '), /Type the file/);
});

test('the page groups by repository then app under environment tabs, with each file\'s status, source, location and template', () => {
  const view = model.buildEnvironmentFilesView(reading(), { appNames: { 'payments-api': 'Payments API' }, activeRepository: 'shop' });
  assert.equal(view.environment, 'dev', 'the first environment, with nothing asked or remembered');
  assert.deepEqual(view.tabs, [{ name: 'dev', total: 3, missing: 1, selected: true }, { name: 'uat', total: 2, missing: 0, selected: false }]);
  assert.deepEqual(view.repositories.map((group) => [group.label, group.total, group.missing, group.apps.map((app) => app.label)]),
    [['shop (this window)', 3, 1, ['Payments API (payments-api)', 'payments-web', 'Whole repository']]]);
  const html = environmentFilesHtml(view);
  assert.match(html, /role="tab" class="ef-tab" data-ef-environment="dev" aria-selected="true">dev <small class="muted">3 files · 1 missing<\/small>/);
  assert.match(html, /data-ef-status="missing">[\s\S]*?<code class="ef-path">apps\/web\/\.env\.dev<\/code>[\s\S]*?<span class="pill bad" data-ef-badge>Missing<\/span>/);
  assert.match(html, /<dt>Template<\/dt><dd><code>apps\/web\/\.env\.dev\.example<\/code><\/dd>/);
  assert.match(html, /<dt>Kept in<\/dt><dd>Private store on this computer<\/dd><dt>Real file<\/dt><dd><code class="ef-location">\/Users\/someone\/shop\/\.git\/singularity-flow\/environment-files\/v1\/dev\/services/);
  assert.match(html, /<dt>Git<\/dt><dd>Git ignores it in this clone \(\.git\/info\/exclude\)<\/dd>/);
  assert.match(html, /data-ef-kind="personal">Personal, this computer only/);
  assert.match(html, /data-ef-action="create" data-ef-key="[^"]+">Create from template<\/button>/);
  assert.match(html, /Set folder for dev…<\/button>/);
  assert.doesNotMatch(html, /data-ef-workspace="root-clear"/, 'Clear only when a folder is set');
  assert.doesNotMatch(html, /application-uat/, 'only the selected environment\'s files');

  const uat = model.buildEnvironmentFilesView(reading(FILES, { roots: { uat: '/Volumes/secure/uat' } }), { environment: 'uat', remembered: 'dev' });
  assert.equal(uat.environment, 'uat', 'the requested environment wins over the remembered one');
  const uatHtml = environmentFilesHtml(uat);
  assert.match(uatHtml, /<strong>Folder for uat<\/strong> <code class="ef-location">\/Volumes\/secure\/uat<\/code>/);
  assert.match(uatHtml, /data-ef-workspace="root-clear">Clear<\/button>/);
  assert.match(uatHtml, /data-ef-status="unmanaged">[\s\S]*?Not managed[\s\S]*?Adopt moves it into the private store and links it back[\s\S]*?<dt>Adopt moves it to<\/dt>/);
  assert.match(uatHtml, /data-ef-status="linked">[\s\S]*?A file you chose[\s\S]*?\/Users\/someone\/secrets\/web-uat\.env[\s\S]*?Stop using linked file/);

  const asked = model.buildEnvironmentFilesView(reading(), { environment: 'qa' });
  assert.deepEqual(asked.tabs.map((tab) => tab.name), ['dev', 'uat', 'qa'], 'an environment a run asked for is a tab even with no files');
  assert.match(environmentFilesHtml(asked), /No environment files for qa\./);
  assert.equal(model.buildEnvironmentFilesView(reading(), { remembered: 'uat' }).environment, 'uat');
  const nothing = environmentFilesHtml(model.buildEnvironmentFilesView(reading([])));
  assert.match(nothing, /No environment files\.[\s\S]*Declare for the team drafts them/);
  assert.match(nothing, /data-ef-workspace="suggest">[\s\S]*Declare for the team<\/button>/, 'with nothing declared, the team\'s draft is still offered');
  assert.doesNotMatch(nothing, /data-ef-workspace="add"/, 'a personal file needs an environment');

  const workspace = model.buildEnvironmentFilesView(model.environmentFilesFrom(answer([
    file({ repository: 'billing', path: 'config/.env.dev' }), file({ repository: null, app: null, path: '.env' }), file({ path: '.env.dev' })
  ], { scope: 'workspace' })), { activeRepository: 'shop', scope: 'workspace' });
  assert.deepEqual(workspace.repositories.map((group) => [group.id, group.label, group.apps.map((app) => app.label)]),
    [['shop', 'shop (this window)', ['payments-api']], ['billing', 'billing', ['payments-api']], ['', 'Workspace', ['Workspace root']]],
    'this window\'s repository first, workspace-level files last');
  const listed = model.environmentFilesFrom(answer([file()], { scope: 'workspace', repositories: [{ id: 'billing', checkout: '/private/tmp/ws/repos/billing' },
    { id: 'shop', checkout: '/private/tmp/ws/repos/shop' }, { id: 'odd', checkout: 'relative' }] }));
  assert.deepEqual(listed.checkouts, { billing: '/private/tmp/ws/repos/billing', shop: '/private/tmp/ws/repos/shop' });
  assert.equal(model.repositoryAt(listed, '/tmp/ws/repos/shop/'), 'shop', 'a window that does not know its repository finds it by its checkout');
  assert.equal(model.repositoryAt(listed, '/elsewhere'), null);
  const alone = model.buildEnvironmentFilesView(reading([file({ repository: null })]), { activeRepository: null });
  assert.deepEqual(alone.repositories.map((group) => [group.id, group.label]), [['.', 'This repository']], 'a repository of no workspace is this repository');
});

test('untrusted, busy and unsupported pages change nothing; the page escapes everything and never holds contents', () => {
  const untrusted = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { trusted: false }));
  assert.match(untrusted, /data-ef-untrusted/);
  assert.match(untrusted, /data-ef-action="create"[^>]*disabled title="Trust this workspace to change files">Create from template/);
  assert.match(untrusted, /data-ef-action="open" data-ef-key="[^"]+">Open<\/button>/, 'Open still works');
  assert.match(untrusted, /data-ef-workspace="root-set" disabled>/);
  const busy = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { busy: true }));
  assert.ok(!/data-ef-action="open" data-ef-key="[^"]+">/.test(busy), 'every action waits while one runs');
  const unsupported = environmentFilesHtml(model.buildEnvironmentFilesView(null, { unsupported: true }));
  assert.match(unsupported, /This Singularity Flow has no environment files commands\./);
  assert.equal(model.environmentFilesUnsupported({ result: { error: { code: 'UNKNOWN_SUBCOMMAND' } } }), true);
  assert.equal(model.environmentFilesUnsupported({ message: 'Unknown subcommand: env files' }), true);
  assert.equal(model.environmentFilesUnsupported({ result: { error: { code: 'ENV_FILE_MISSING' } }, message: 'unknown command' }), false);

  // Whatever an engine answer carries, only paths and statuses become rows.
  const leaky = reading([file({ contents: `PASSWORD=${SECRET}`, value: SECRET, preview: SECRET, path: '<b>apps/web/.env.dev</b>'.replace(/[<>]/g, '') })]);
  const view = model.buildEnvironmentFilesView(leaky);
  assert.ok(!JSON.stringify(view).includes(SECRET), 'no field of the view can hold what a file contains');
  assert.ok(!environmentFilesHtml(view).includes(SECRET));
  const hostile = environmentFilesHtml(model.buildEnvironmentFilesView(reading([file({ app: '<img src=x onerror=alert(1)>', location: '/tmp/"><script>x</script>' })])));
  assert.doesNotMatch(hostile, /<img src=x|<script>x/);
});

test('the page and model never read, write or send a file: no file system, no contents', async () => {
  for (const name of ['views/environment-files-model.ts', 'views/environment-files-page.ts', 'views/environment-files.ts']) {
    const text = await readFile(source(name), 'utf8');
    assert.doesNotMatch(text, /from 'node:fs|require\('fs|readFile|writeFile|createReadStream|fs\.promises/, `${name} touches no file itself`);
    assert.doesNotMatch(text, /(?:^|[{,;(]\s*)contents?\??\s*:/m, `${name} has no contents field`);
  }
  const controller = await readFile(source('views/environment-files.ts'), 'utf8');
  assert.match(controller, /openTextDocument\(vscode\.Uri\.file\(location\)\)/, 'Open opens the real file the engine names, in an editor tab');
  assert.match(controller, /showTextDocument\(document, \{ preview: false \}\)/);
});

test('the narrow layout stacks a file\'s actions under it, and its rules come after the ones they override', () => {
  const style = ENVIRONMENT_FILES_STYLE;
  const media = style.indexOf('@media (max-width: 640px)');
  assert.ok(media > 0);
  for (const rule of ['.ef-file { display:grid', '.ef-file > .ef-actions { grid-column:2', '.ef-facts { display:grid', '.ef-workspace { display:flex']) {
    const at = style.indexOf(rule);
    assert.ok(at >= 0 && at < media, `${rule} is before the narrow rules that override it`);
  }
  const narrow = style.slice(media);
  assert.match(narrow, /\.ef-file \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(narrow, /\.ef-file > \.ef-actions \{ grid-column:1; grid-row:auto; flex-direction:row; flex-wrap:wrap; \}/);
  assert.equal(style.slice(media).match(/@media/g).length, 1, 'the narrow block is the last thing in the style');
});

test('the page script posts only what the markup names; a disabled button posts nothing', () => {
  assert.doesNotThrow(() => new Function(ENVIRONMENT_FILES_SCRIPT));
  const listeners = {};
  const posted = [];
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) } };
  const document = { addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); } };
  new Function('window', 'document', ENVIRONMENT_FILES_SCRIPT)(window, document);
  const element = (dataset, extra = {}) => ({ dataset, ...extra });
  const click = (target) => { for (const listener of listeners.click) listener({ target: { closest: () => target }, preventDefault() {} }); };
  click(element({ efAction: 'create', efKey: '["shop","dev","apps/web/.env.dev"]' }));
  click(element({ efAction: 'adopt', efKey: 'k' }, { disabled: true }));
  click(element({ efWorkspace: 'root-set' }));
  click(element({ efEnvironment: 'uat' }));
  click(element({ efScope: 'workspace' }));
  click(element({ efRefresh: '' }));
  assert.deepEqual(posted, [
    { type: 'envFiles.action', action: 'create', key: '["shop","dev","apps/web/.env.dev"]' },
    { type: 'envFiles.workspace', action: 'root-set' },
    { type: 'envFiles.environment', environment: 'uat' },
    { type: 'envFiles.scope', scope: 'workspace' },
    { type: 'envFiles.refresh' }
  ]);
  const { files } = reading();
  assert.equal(model.fileByKey(files, model.fileKey(files[1])), files[1]);
  assert.equal(model.fileByKey(files, '["shop","dev","nope"]'), null);
  assert.equal(model.fileByKey(files, { not: 'a key' }), null);
});

test('Declare for the team shows the engine\'s environments.yml draft and the proposal command; VS Code writes neither', () => {
  const document = 'schemaVersion: 1\nenvironments:\n  dev:\n    requires:\n      - { name: API_BASE_URL, kind: endpoint, value: "https://dev.example.test" }\n    localFiles: [apps/web/.env.dev]\n';
  const engine = { schemaVersion: 1, resultType: 'sflow-env-files-suggest', repository: null, checkout: '/x', declaration: 'ready',
    candidates: [
      { framework: 'node', environment: 'dev', path: 'apps/web/.env.dev', app: null, template: 'apps/web/.env.dev.example', exists: false, tracked: false, declared: false, protected: false },
      { framework: 'spring', environment: 'uat', path: 'services/api/src/main/resources/application-uat.yml', app: null, template: null, exists: true, tracked: true, declared: false, protected: false },
      { framework: 'node', environment: null, path: '.env', app: null, template: null, exists: true, tracked: false, declared: true, protected: true },
      { framework: 'bad', path: '/etc/hosts' }
    ],
    draft: { path: 'singularity/environments.yml', localFiles: { dev: ['apps/web/.env.dev', '../escape'] }, undeclaredEnvironments: { qa: ['apps/web/.env.qa'] }, document, valid: true },
    proposal: { command: 'singularity-flow configuration save singularity/environments.yml --propose', stdin: 'draft.document' },
    notes: ['Environment(s) qa are not declared; declaring one needs at least one requires entry, so they are not in the draft.'], truncated: false };
  const suggestion = model.suggestionFrom(engine);
  assert.deepEqual(suggestion.candidates.map((entry) => [entry.path, entry.declared, entry.tracked]),
    [['apps/web/.env.dev', false, false], ['services/api/src/main/resources/application-uat.yml', false, true], ['.env', true, false]]);
  assert.equal(suggestion.draft, document, 'the whole file, as the engine drafted it');
  assert.equal(suggestion.valid, true);
  assert.deepEqual(suggestion.additions, [{ environment: 'dev', paths: ['apps/web/.env.dev'], declared: true }, { environment: 'qa', paths: ['apps/web/.env.qa'], declared: false }]);
  assert.equal(suggestion.command, 'singularity-flow configuration save singularity/environments.yml --propose');
  const html = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { suggestion }));
  assert.match(html, /The draft is the whole singularity\/environments\.yml with these paths added:[\s\S]*<pre class="ef-draft" data-ef-draft><code>schemaVersion: 1\nenvironments:/);
  assert.match(html, /data-ef-workspace="copy-draft">Copy the draft/);
  assert.match(html, /<code>singularity-flow configuration save singularity\/environments\.yml --propose<\/code> <button[^>]*data-ef-workspace="copy-command">Copy/);
  assert.match(html, /<strong>qa<\/strong> <small class="muted">\(not declared yet: not in the draft\)<\/small>/);
  assert.match(html, /tracked in Git<\/span>/);
  assert.match(html, /every environment · node/);
  assert.match(html, /Environment\(s\) qa are not declared/);
  assert.match(html, /VS Code never writes singularity\/environments\.yml\./);

  const invalid = model.suggestionFrom({ ...engine, draft: { ...engine.draft, valid: false, error: 'bad' }, proposal: null });
  assert.deepEqual([invalid.valid, invalid.command], [false, null]);
  const invalidHtml = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { suggestion: invalid }));
  assert.match(invalidHtml, /does not pass its own check, so it is not offered for review/);
  assert.doesNotMatch(invalidHtml, /copy-draft|copy-command/);
  const nothing = model.suggestionFrom({ ...engine, candidates: [], draft: { path: 'x', localFiles: {}, undeclaredEnvironments: {}, document: null, valid: true }, proposal: null,
    notes: ['No framework environment file was found by name.'] });
  assert.match(environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { suggestion: nothing })), /No framework environment file was found[\s\S]*There is nothing to add to singularity\/environments\.yml\./);
  assert.equal(model.suggestionFrom({ ...engine, proposal: { command: 'rm -rf /' } }).command, null, 'only a singularity-flow command is shown');
  assert.equal(model.suggestionFrom({ resultType: 'x' }), null);
});

test('before a run: the files of its environment it places, by repository, app, source roots or working directory', () => {
  const files = model.environmentFilesFrom(answer([
    file({ path: 'services/api/application-dev.yml', status: 'missing', app: 'payments-api', template: 'services/api/application-dev.example.yml' }),
    file({ path: 'apps/web/.env.dev', status: 'missing', app: null, template: null }),
    file({ path: '.env', status: 'missing', app: null, template: '.env.example' }),
    file({ path: 'apps/web/.env.local', status: 'ready', app: null }),
    file({ repository: 'billing', path: 'billing/.env.dev', status: 'missing', app: null }),
    file({ repository: null, path: 'workspace/.env', status: 'missing', app: null, template: null }),
    file({ environment: 'uat', path: 'apps/web/.env.uat', status: 'missing', app: null }),
    file({ path: 'apps/web/config.yml', status: 'unmanaged', app: null, problem: 'tracked' })
  ], { scope: 'workspace' })).files;
  const paths = (scope) => model.missingForRun(files, { environment: 'dev', capability: 'payments-web', repositories: ['shop'], ...scope }).map((entry) => entry.path);
  assert.deepEqual(paths({ sourceRoots: [], workingDirectories: [] }), ['services/api/application-dev.yml', 'apps/web/.env.dev', '.env'],
    'no roots: the whole repository; never another repository, a workspace-level file or another environment');
  assert.deepEqual(paths({ sourceRoots: ['apps/web'] }), ['apps/web/.env.dev'], 'a monorepo app: its source roots');
  assert.deepEqual(paths({ sourceRoots: [], workingDirectories: ['apps/web'] }), ['apps/web/.env.dev'], 'no source roots: the start entry\'s working directory');
  assert.deepEqual(paths({ sourceRoots: [], workingDirectories: ['apps/web', '.'] }), ['services/api/application-dev.yml', 'apps/web/.env.dev', '.env'], '"." is the repository root');
  assert.deepEqual(model.missingForRun(files, { environment: 'dev', capability: 'payments-api', repositories: ['shop'], sourceRoots: ['apps/web'] }).map((entry) => entry.path),
    ['services/api/application-dev.yml', 'apps/web/.env.dev'], 'a file the engine names for the capability is its file');
  assert.deepEqual(model.missingForRun(files, { environment: 'dev', capability: 'payments-web', repositories: [], sourceRoots: ['billing'] }).map((entry) => entry.path),
    ['billing/.env.dev'], 'a capability naming no repository is not filtered by one');
  assert.deepEqual(model.missingForRun(files, { environment: 'dev', capability: 'payments-web', repositories: ['shop'], sourceRoots: ['apps'] })[0],
    { repository: 'shop', workspaceLevel: false, environment: 'dev', path: 'apps/web/.env.dev', template: null, commands: [] });
  assert.deepEqual(model.missingAtWorkspaceLevel(files, 'dev'), [{ repository: null, workspaceLevel: true, environment: 'dev', path: 'workspace/.env', template: null, commands: [] }],
    'the workspace\'s own file: every run of a member repository places it');
  assert.deepEqual(model.missingAtWorkspaceLevel(files, 'uat'), []);

  assert.deepEqual(model.environmentFileCounts(files, { capability: 'payments-web', repositories: ['shop'], sourceRoots: [], workingDirectories: [] }, ['dev', 'uat', 'qa']), [
    { environment: 'dev', total: 5, missing: 3, words: '5 files · 3 missing' }, { environment: 'uat', total: 1, missing: 1, words: '1 file · 1 missing' }
  ], 'an environment with no file is not counted');
  assert.deepEqual(model.trackedForRun(files, { environment: 'dev', capability: 'payments-web', repositories: ['shop'], sourceRoots: ['apps/web'] }), ['apps/web/config.yml'],
    'a path Git tracks is not missing; the run is refused for it all the same');
  assert.equal(model.trackedMessage({ kind: 'start', label: 'web' }, 'dev', ['apps/web/config.yml']),
    'web was not started: environment dev uses apps/web/config.yml, which Git tracks, so it cannot be an environment file. Remove the path from the repository (git rm --cached) and keep its values in an environment file. Nothing ran.');
});

test('a missing file is said plainly with the two fixes; the engine\'s ENV_FILE_MISSING refusal reads the same', () => {
  const one = [{ repository: 'shop', workspaceLevel: false, environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example', commands: [] }];
  assert.equal(model.preflightMessage({ kind: 'start', label: 'web' }, 'dev', one),
    'web was not started: environment dev needs apps/web/.env.dev, which is missing on this computer. Create it from its template apps/web/.env.dev.example, or use an existing file. Nothing ran.');
  assert.deepEqual(model.preflightButtons(one), ['Create from template', 'Use existing file…', 'Open Environment Files']);
  const bare = [{ ...one[0], template: null }];
  assert.equal(model.preflightMessage({ kind: 'debug', label: 'web' }, 'dev', bare),
    'web was not started with its debugger: environment dev needs apps/web/.env.dev, which is missing on this computer. Create it, or use an existing file. Nothing ran.');
  assert.deepEqual(model.preflightButtons(bare), ['Use existing file…', 'Open Environment Files'], 'no template: no Create from template');
  const two = [...one, { repository: 'shop', workspaceLevel: false, environment: 'dev', path: '.env', template: '.env.example', commands: [] }];
  assert.equal(model.preflightMessage({ kind: 'tests', label: 'Tests for payments-web' }, 'dev', two),
    'Tests for payments-web were not run: environment dev needs 2 files that are missing on this computer: apps/web/.env.dev, .env. Create them from their templates, or use existing files, on Environment Files. Nothing ran.');
  assert.deepEqual(model.preflightButtons(two), ['Create from template', 'Open Environment Files']);
  assert.match(model.preflightMessage({ kind: 'start', label: 'web', exitCode: 1 }, 'dev', one), /^web ended with exit code 1: environment dev needs apps\/web\/\.env\.dev[\s\S]*existing file\.$/);
  assert.ok(!model.preflightMessage({ kind: 'start', label: 'web' }, 'dev', one).includes(SECRET));

  const refused = model.missingFromRefusal({ schemaVersion: 1, status: 'failed', error: { code: 'ENV_FILE_MISSING', message: 'Environment file missing.',
    details: { environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example',
      commands: ['singularity-flow env files create dev apps/web/.env.dev --from-template', 'singularity-flow env files link dev apps/web/.env.dev --to <FILE>', 'rm -rf /'] } } });
  assert.deepEqual(refused, [{ repository: null, workspaceLevel: false, environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example',
    commands: ['singularity-flow env files create dev apps/web/.env.dev --from-template', 'singularity-flow env files link dev apps/web/.env.dev --to <FILE>'] }]);
  assert.deepEqual(model.missingFromRefusal({ error: { code: 'ENV_FILE_MISSING', details: { environment: 'uat', files: [{ path: 'a/.env.uat' }, { path: '/abs' }] } } })
    .map((entry) => [entry.environment, entry.path]), [['uat', 'a/.env.uat']]);
  assert.deepEqual(model.missingFromRefusal({ error: { code: 'APP_COMMAND_CHANGED', details: { environment: 'dev', path: 'x' } } }), []);
  const level = model.missingFromRefusal({ error: { code: 'ENV_FILE_MISSING', details: { environment: 'dev', path: '.env', template: null,
    commands: ['singularity-flow env files create dev .env --workspace', 'singularity-flow env files link dev .env --workspace --to <FILE>'] } } });
  assert.equal(level[0].workspaceLevel, true, 'the engine names a workspace file\'s fixes with --workspace');
  assert.deepEqual(model.actionArgv('create-empty', model.missingAsFile(level[0]), { activeRepository: 'mono', scope: 'repository' }),
    ['env', 'files', 'create', 'dev', '.env', '--workspace', '--json'], 'its fixes act on the workspace\'s own file');
  assert.equal(model.preflightMessage({ kind: 'start', label: 'web' }, 'dev', level),
    'web was not started: environment dev needs the workspace\'s .env, which is missing on this computer. Create it, or use an existing file. Nothing ran.');
  assert.deepEqual(model.missingAsFile(one[0]), { repository: 'shop', workspaceLevel: false, app: null, environment: 'dev', path: 'apps/web/.env.dev', kind: 'declared',
    template: 'apps/web/.env.dev.example', source: null, location: null, status: 'missing', excluded: null, placedFor: null, placement: null, problem: null });
  assert.equal(model.locationFrom({ data: { location: '/Users/someone/x/.env.dev' } }), '/Users/someone/x/.env.dev');
  assert.equal(model.locationFrom({ location: 'relative/path' }), null);
});

test('Run & test counts each environment\'s files and opens the page at one; an engine without env files shows nothing', () => {
  const capability = { id: 'payments-web', name: 'Payments web', kind: 'delivery', delivery: true, repository: 'shop', repositories: ['shop'], sourceRoots: ['apps/web'], children: [] };
  const plan = [{ capability: 'payments-web', repository: 'shop', id: 'web', name: null, type: null, argv: ['npm', 'run', 'dev'], workingDirectory: 'apps/web', url: null, ready: null,
    environments: [{ name: 'dev', status: 'bound', default: true }, { name: 'uat', status: 'bound', default: false }], commandSha256: `sha256:${'a'.repeat(64)}`,
    arguments: {}, resolvedArgv: {}, launch: {}, debug: null, debugIssue: null }];
  const files = reading([file({ app: null, path: 'apps/web/.env.dev', status: 'missing' }), file({ app: null, path: 'apps/web/.env.local', status: 'ready' }),
    file({ app: null, environment: 'uat', path: 'apps/web/.env.uat', status: 'linked', source: 'linked' }), file({ app: null, path: 'services/api/.env.dev', status: 'missing' })]).files;
  const view = runModel.buildRunAndTestView(capability, 'here', { plan, environmentFiles: files, environment: 'uat' });
  assert.deepEqual(view.environmentFiles, [
    { environment: 'dev', words: '2 files · 1 missing', missing: 1, current: false }, { environment: 'uat', words: '1 file', missing: 0, current: true }
  ], 'only the files a run of this capability places');
  const html = runAndTestHtml(view);
  assert.match(html, /<p class="rt-env-files">[\s\S]*Environment files:<\/span> <button type="button" class="link rt-env-missing" data-rt="env-files" data-rt-capability="payments-web" data-rt-environment="dev">dev: 2 files · 1 missing<\/button>/);
  assert.match(html, /data-rt="env-files" data-rt-capability="payments-web" data-rt-environment="uat">uat: 1 file<\/button>/);
  const none = runAndTestHtml(runModel.buildRunAndTestView(capability, 'here', { plan, environmentFiles: [] }));
  assert.match(none, /data-rt="env-files" data-rt-capability="payments-web" data-rt-environment="dev">none declared; open Environment Files<\/button>/);
  assert.doesNotMatch(runAndTestHtml(runModel.buildRunAndTestView(capability, 'here', { plan, environmentFiles: null })), /rt-env-files/,
    'an engine without env files: nothing to count or open');
});

test('the Run/Debug Configurations editor links each environment tab to its files', () => {
  const entry = { id: 'api', type: 'spring-boot', environments: ['dev', 'uat'] };
  const state = (tab) => ({ capability: 'payments-api', draft: { configurations: [{ key: 'k1', entry }] }, block: {}, facts: [], selected: 'k1', tab });
  assert.match(tabsRegionHtml(state('uat')), /<button type="button" class="link" data-cf-action="env-files" data-cf-environment="uat">Environment files for uat…<\/button>/);
  assert.match(tabsRegionHtml(state('base')), /data-cf-environment="dev">Environment files for dev…<\/button>/, 'Base: the default environment');
});

test('a tracked path offers nothing but says why; a path placed for another environment and a copy are said plainly', () => {
  const [tracked, elsewhere, copy, missing] = reading([
    file({ path: 'apps/web/.env.dev', status: 'unmanaged', problem: 'tracked', placedFor: null, placement: null }),
    file({ environment: 'uat', path: '.env', status: 'ready', placedFor: 'dev', placement: 'symlink' }),
    file({ path: 'apps/web/.env.local', status: 'placed-here', placement: 'copy' }),
    file({ path: 'apps/web/.env.qa', status: 'missing', placedFor: null, placement: null, problem: 'no-longer-declared', kind: 'personal', template: null })
  ]).files;
  assert.deepEqual(model.fileActions(tracked), [], 'nothing is created, linked or adopted while Git tracks the path');
  const view = model.buildEnvironmentFilesView(reading([tracked, elsewhere, copy, missing].map((entry) => ({ ...entry }))), { environment: 'dev' });
  const rows = view.repositories.flatMap((group) => group.apps.flatMap((app) => app.files));
  assert.match(rows.find((row) => row.path === 'apps/web/.env.dev').detail, /^Git tracks this path, so it cannot be an environment file/);
  assert.match(rows.find((row) => row.path === 'apps/web/.env.local').detail, /as a copy, refreshed at each run/);
  const retired = rows.find((row) => row.path === 'apps/web/.env.qa');
  assert.match(retired.detail, /The team no longer declares it; its real file is kept\.$/);
  assert.equal(retired.locationLabel, 'Expected at', 'a missing file\'s location is where it will be');
  const html = environmentFilesHtml(view);
  assert.match(html, /<dt>Expected at<\/dt><dd><code class="ef-location">[^<]*\/dev\/apps\/web\/\.env\.dev<\/code>|<dt>Expected at<\/dt>/);
  const root = model.buildEnvironmentFilesView(model.environmentFilesFrom(answer([file({ repository: null, app: null, path: '.env', excluded: null })], { scope: 'workspace' })))
    .repositories[0].apps[0].files[0];
  assert.equal(root.detail, 'It is in place at the workspace root, linked to the real file, for runs in this environment.');
  const uat = model.buildEnvironmentFilesView(reading([elsewhere]), { environment: 'uat' }).repositories[0].apps[0].files[0];
  assert.match(uat.detail, /In this checkout the path is placed for dev now; a run in uat switches it\./);
  assert.equal(uat.locationLabel, 'Real file');
});

test('the engine\'s refusals of an action or a run are said plainly, with what to do next', () => {
  const refusal = (code, details = {}, message = 'engine words.') => Object.assign(new Error(message), { result: { schemaVersion: 1, status: 'failed', error: { code, message, details } } });
  assert.equal(model.refusalWords(refusal('ENV_FILE_TRACKED', { paths: ['apps/web/.env.dev'] })),
    'Git tracks apps/web/.env.dev, so it cannot be an environment file. Remove it from the repository (git rm --cached), keep its values in an environment file, then try again.');
  assert.equal(model.refusalWords(refusal('ENV_FILE_IN_USE', { paths: ['.env'], startId: 'web', capability: 'shop-web', runningEnvironment: 'dev',
    recoveryCommand: 'singularity-flow app stop web --capability shop-web' })),
  '.env is in use by web of shop-web, running in dev. Stop it first (singularity-flow app stop web --capability shop-web), then try again.');
  assert.match(model.refusalWords(refusal('ENV_FILES_WORKSPACE_REQUIRED')), /^A folder for an environment belongs to a workspace, and this repository is not open from one\. Open it from Workspaces/);
  assert.equal(model.refusalWords(refusal('ENV_FILES_ROOT_INVALID', {}, "/x is inside repository 'mono', where Git could pick its files up. Choose a folder outside every checkout.")),
    "That folder cannot hold environment files: /x is inside repository 'mono', where Git could pick its files up. Choose a folder outside every checkout.");
  assert.match(model.refusalWords(refusal('ENVIRONMENT_POLICY_UNAVAILABLE')), /could not read which paths are environment files, so it changed and admitted nothing/);
  assert.equal(model.refusalWords(refusal('ENV_FILE_EXISTS', {}, 'apps/web/.env.dev already exists for \'dev\'.')), 'apps/web/.env.dev already exists for \'dev\'.', 'any other refusal: the engine\'s words');
  assert.equal(model.refusalWords(new Error('plain failure')), 'plain failure');
});

test('the real engine\'s answers read into the page: list, create, path, suggest and the missing-file refusal', { timeout: 180_000 }, async (t) => {
  const { repository } = await import(pathToFileURL(path.join(root, 'test', 'helpers', 'environment-files-fixture.mjs')).href);
  const repo = await repository(t, { files: {
    'apps/web/.env.dev.example': 'API_TOKEN=CHANGE_ME\n',
    'services/api/src/main/resources/application-uat.example.yml': 'spring:\n  datasource:\n    password: CHANGE_ME\n'
  } });
  const listed = repo.json(['env', 'files']);
  assert.equal(listed.status, 0, listed.stderr);
  const reading = model.environmentFilesFrom(listed.value);
  assert.equal(reading.scope, 'repository');
  assert.deepEqual(reading.environments, ['dev', 'uat']);
  const web = reading.files.find((entry) => entry.environment === 'dev' && entry.path === 'apps/web/.env.dev');
  assert.deepEqual([web.repository, web.workspaceLevel, web.status, web.source, web.template], [null, false, 'missing', 'store', 'apps/web/.env.dev.example']);
  assert.match(web.location.replaceAll('\\', '/'), /\/\.git\/singularity-flow\/environment-files\/v1\/dev\/apps\/web\/\.env\.dev$/);
  assert.deepEqual(model.fileActions(web), ['create', 'link']);
  const view = model.buildEnvironmentFilesView(reading, { environment: 'dev' });
  assert.deepEqual(view.repositories.map((group) => group.label), ['This repository']);
  assert.equal(reading.files.some((entry) => /\*/.test(entry.path)), false, 'a glob only protects; it is not a row');

  // The exact argv the page runs, against the engine.
  const here = { activeRepository: null, scope: 'repository' };
  const created = repo.json(model.envFilesCreateArgv(web, true, here).slice(0, -1));
  assert.equal(created.status, 0, created.stderr);
  assert.equal(model.locationFrom(created.value), web.location);
  assert.equal(created.value.entry.status, 'placed-here');
  const where = repo.json(model.envFilesPathArgv(web, here).slice(0, -1));
  assert.equal(model.locationFrom(where.value), web.location);
  const after = model.environmentFilesFrom(repo.json(['env', 'files']).value).files.find((entry) => entry.path === 'apps/web/.env.dev' && entry.environment === 'dev');
  assert.deepEqual([after.status, after.placement, after.excluded],
    ['placed-here', process.platform === 'win32' ? 'copy' : 'symlink', true]);
  assert.deepEqual(model.fileActions(after), ['open', 'reveal', 'link']);
  const outside = path.join(repo.base, 'mine-uat.env');
  await (await import('node:fs/promises')).writeFile(outside, 'API_TOKEN=x\n', { mode: 0o600 });
  const uat = model.environmentFilesFrom(repo.json(['env', 'files']).value).files.find((entry) => entry.environment === 'uat' && entry.path === 'apps/web/.env.uat');
  assert.equal(repo.json(model.envFilesLinkArgv(uat, outside, here).slice(0, -1)).status, 0);
  assert.equal(repo.json(model.envFilesUnlinkArgv(uat, here).slice(0, -1)).status, 0);
  assert.equal(repo.json(model.envFilesAddArgv('dev', 'apps/web/.env.local').slice(0, -1)).status, 0);
  const personal = model.environmentFilesFrom(repo.json(['env', 'files']).value).files.find((entry) => entry.path === 'apps/web/.env.local');
  assert.deepEqual([personal.kind, model.fileActions(personal)], ['personal', ['create-empty', 'link', 'remove']]);
  assert.equal(repo.json(model.envFilesRemoveArgv(personal, here).slice(0, -1)).status, 0);
  const noWorkspace = repo.json(model.envFilesRootArgv('uat', repo.base).slice(0, -1));
  assert.equal(noWorkspace.value.error.code, 'ENV_FILES_WORKSPACE_REQUIRED');
  assert.match(model.refusalWords({ message: noWorkspace.value.error.message, result: noWorkspace.value }), /belongs to a workspace/);
  const workspaceRead = repo.json(model.envFilesArgv({ scope: 'workspace' }).slice(0, -1));
  assert.equal(workspaceRead.value.error.code, 'ENV_FILES_WORKSPACE_REQUIRED', '--workspace is accepted as a flag, then refused without a workspace');

  const suggested = repo.json(model.envFilesSuggestArgv().slice(0, -1));
  assert.equal(suggested.status, 0, suggested.stderr);
  const suggestion = model.suggestionFrom(suggested.value);
  assert.ok(suggestion, 'the engine\'s suggest answer is read');
  assert.ok(suggestion.candidates.some((candidate) => candidate.path === 'apps/web/.env.dev' && candidate.declared));

  // A run's refusal for a missing file reads as the pre-flight's rows.
  const refused = repo.json(['env', 'files', 'place', 'uat']);
  const missing = model.missingFromRefusal(refused.value);
  assert.equal(refused.value.error.code, 'ENV_FILE_MISSING');
  assert.deepEqual(missing.map((entry) => [entry.environment, entry.path, entry.template]), [['uat', '.env', null], ['uat', 'apps/web/.env.uat', null],
    ['uat', 'services/api/src/main/resources/application-uat.yml', 'services/api/src/main/resources/application-uat.example.yml']]);
  assert.deepEqual(missing[1].commands, ['singularity-flow env files create uat apps/web/.env.uat', 'singularity-flow env files link uat apps/web/.env.uat --to <FILE>']);
});
