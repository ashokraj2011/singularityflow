// docs/SPEC-ENVIRONMENT-FILES-v2.md: what is private with no setup. Every value here is made up.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configValueFindings, settingHoldsSecret } from '../src/config-values.mjs';
import { environmentFilesToolGuard } from '../src/copilot-environment-files-guard.mjs';
import { assertDocumentInputContainsNoSecret, assertNotPrivateEnvironmentName } from '../src/document-admission.mjs';
import { matchEnvironmentLocalPath } from '../src/environment-declaration.mjs';
import { excludeAlwaysLocalNames } from '../src/git.mjs';
import { ALWAYS_LOCAL_EXCLUDE_COMMENT, ALWAYS_LOCAL_EXCLUDES, alwaysLocalName, configShapedPath } from '../src/local-config-policy.mjs';
import { scanEntries, secretRefusal } from '../src/secrets.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const VALUE = 'Xq7mA2pLz9vB';
const TOKEN = 'abc123xyz987LMNopq456';

async function repository(t, files = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-local-config-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Local Config'); git('config', 'user.email', 'local-config@example.test');
  await writeFiles(root, { 'README.md': 'x\n', ...files });
  return { root, git };
}

async function writeFiles(root, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

// Its own home: the CLI follows the machine's active workspace, whatever the working directory is.
const cli = (root, args) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8',
  env: { ...process.env, HOME: path.join(root, '.git', 'home'), SINGULARITY_FLOW_HOME: path.join(root, '.git', 'home', 'sf'), COPILOT_HOME: path.join(root, '.git', 'home', 'copilot'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git', 'home', 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git', 'home', 'active.json') } });
const read = (root, file) => environmentFilesToolGuard({ cwd: root, toolName: 'view', toolArgs: { path: file } }, { env: process.env });
const shell = (root, command) => environmentFilesToolGuard({ cwd: root, toolName: 'bash', toolArgs: { command } }, { env: process.env });

test('always-local names need no setup, in any folder, and a template is shared', () => {
  for (const file of ['.env', 'apps/web/.env', '.env.local', '.env.test', '.ENV', 'application-local.yml', 'src/main/resources/application-local.properties', 'config.local.yaml', 'appsettings.Local.json']) {
    assert.ok(alwaysLocalName(file), file);
    assert.equal(matchEnvironmentLocalPath(null, file)?.kind, 'always-local', file);
  }
  for (const file of ['.env.', '.env ', '.env::$DATA', 'dir\\.env']) assert.ok(alwaysLocalName(file), `Windows reads ${file} as .env`);
  for (const file of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.local.example', '.env.production.sample', '.env.defaults', '.env.schema', 'application.yml', 'config.yaml', 'application-test.yml', 'process.env', 'src/env.ts', '.envrc']) {
    assert.equal(alwaysLocalName(file), null, file);
    assert.equal(matchEnvironmentLocalPath(null, file), null, file);
  }
});

test('a declared rule still names itself before the always-local name', () => {
  const declaration = { neverCommit: ['.env*'], environments: {} };
  assert.equal(matchEnvironmentLocalPath(declaration, '.env').kind, 'never-commit');
  assert.equal(matchEnvironmentLocalPath(declaration, '.env.example').kind, 'never-commit', 'a repository can add to the list');
  assert.equal(matchEnvironmentLocalPath({ neverCommit: [], environments: {} }, '.env').kind, 'always-local', 'and cannot remove from it');
});

test('shared config is recognised by name, and JSON only as settings', () => {
  for (const file of ['application.yml', 'config.yaml', 'src/test/resources/application-test.yml', 'app.properties', 'x.toml', 'x.ini', 'x.conf', '.envrc', '.env.example', 'appsettings.json', 'appsettings.Development.json', 'config.json', 'jest.config.json', 'local.settings.json']) {
    assert.ok(configShapedPath(file), file);
  }
  for (const file of ['package.json', 'tsconfig.json', 'fixtures/orders.json', 'src/config.ts', 'README.md']) assert.equal(configShapedPath(file), false, file);
});

test('a setting holds a value when its name and its value both say so', () => {
  for (const [name, value] of [
    ['password', VALUE], ['spring.datasource.password', VALUE], ['DB_PASSWORD', VALUE], ['api-key', TOKEN], ['apiKey', TOKEN], ['client_secret', TOKEN],
    ['internal.api.key', TOKEN], ['key', TOKEN], ['token', TOKEN], ['password', `\${DB_PASSWORD:${VALUE}}`], ['Db', `Server=x;Password=${VALUE};`],
    ['url', 'https://x.io/a?sig=Zx9fK2mQ7vLp4Tn8'], ['password', 'Welcome1'], ['DB_PASS', VALUE], ['spring.mail.pass', VALUE], ['DBPassword', VALUE], ['JWTSecret', VALUE],
    ['dbpassword', VALUE], ['password_prod', VALUE], ['password2', VALUE], ['password', '$ecr3tP4ss'], ['api-key', '3fa85f64-5717-4562-b3fc-2c963f66afa6'], ['redis', 'redis://:Xq7mA2pLz9vB@cache.x.io'],
    ['storage', `DefaultEndpointsProtocol=https;AccountKey=${TOKEN};`], ['Authorization', `Basic ${TOKEN}`], ['auth', TOKEN], ['password', `\${DB_PASSWORD:-${VALUE}}`]
  ]) assert.equal(settingHoldsSecret(name, value), true, `${name}: ${value}`);
  for (const [name, value] of [
    ['password', '${DB_PASSWORD}'], ['password', '${DB_PASSWORD:}'], ['password', 'ENC(abc123XYZ)'], ['password', '{cipher}abc123XYZ'], ['password', 'vault:secret/data/x'],
    ['client_secret', 'arn:aws:secretsmanager:eu:1:secret:x'], ['password', 'changeme'], ['password', 'CHANGE_ME'], ['password', '<your-key>'], ['password', '****'],
    ['password', 'postgres'], ['password', 'test1234'], ['password', 'true'], ['token', ''], ['token_ttl', '3600'], ['auth_mode', 'oauth'], ['secret_name', 'prod-db-2'], ['secret', 'prod-db-2'],
    ['checksum', '3fa85f645717a4562b3fc2c963f66afa6'], ['token-uri', 'https://x.io/oauth/token'], ['url', 'https://x.io/a?auth=true'], ['url', 'https://x.example.com/a?sig=Zx9fK2mQ7vLp4Tn8'],
    ['token-provider', 'com.example.security.TokenProviderImpl'], ['password', 'correct horse battery staple'], ['server.port', '8080'], ['name', TOKEN],
    ['password', 'Password'], ['login.password', 'Password'], ['key', 'build-cache-v2-linux-x64-22'], ['secretName', 'my-app-tls-certificate-v2'], ['existingSecret', 'my-secret-v2'], ['existingSecret', 'DB_CREDENTIALS'],
    ['password-encoder', 'BCryptPasswordEncoder'], ['client-key', 'certs/client.key'], ['secret', 'kv/data/app'], ['public-key', TOKEN], ['password', '${POSTGRES_PASSWORD:-postgres}'],
    ['password', 'ENC[AES256_GCM,data:abc123]'], ['password', '@Microsoft.KeyVault(SecretUri=x)'], ['password', '@db.password@'], ['password', '__DbPassword__']
  ]) assert.equal(settingHoldsSecret(name, value), false, `${name}: ${value}`);
});

test('every way of writing a setting is read, and only in shared config', () => {
  const found = (file, content) => configValueFindings(file, content).map(({ name, line }) => [name, line]);
  assert.deepEqual(found('application.yml', `spring:\n  datasource:\n    password: ${VALUE}\napi-key: ${TOKEN} # local\n`), [['password', 3], ['api-key', 4]]);
  assert.deepEqual(found('a.yaml', `password: "${VALUE}"\ntoken: '${TOKEN}'\n`), [['password', 1], ['token', 2]]);
  assert.deepEqual(found('app.properties', `db.password=${VALUE}\ninternal.api.key = ${TOKEN}\n# password=${VALUE}\n`), [['db.password', 1], ['internal.api.key', 2]]);
  assert.deepEqual(found('.env.example', `export API_KEY=${TOKEN}\nTOKEN_TTL=3600\n`), [['API_KEY', 1]]);
  assert.deepEqual(found('x.toml', `[db]\npassword = "${VALUE}"\n`), [['password', 2]]);
  assert.deepEqual(found('x.ini', `[db]\n; password = ${VALUE}\npassword = ${VALUE}\n`), [['password', 3]]);
  assert.deepEqual(found('appsettings.Development.json', `{"ApiKey":"${TOKEN}","Logging":{"Level":"Info"}}\n`), [['ApiKey', 1]]);
  assert.deepEqual(found('deploy.yml', `env:\n  - name: DB_PASSWORD\n    value: ${VALUE}\n  - name: LOG_LEVEL\n    value: info\n`), [['DB_PASSWORD', 3]]);
  assert.deepEqual(found('compose.yml', `environment:\n  - POSTGRES_PASSWORD=${VALUE}\n`), [['POSTGRES_PASSWORD', 2]]);
  assert.deepEqual(found('crlf.yml', `password: ${VALUE}\r\nserver: x\r\n`), [['password', 1]], 'a Windows line ending changes nothing');
  assert.deepEqual(found('a.yml', `password: &pw ${VALUE}\ntoken: !!str ${TOKEN}\n`), [['password', 1], ['token', 2]]);
  assert.deepEqual(found('prod.env', `DB_PASSWORD=${VALUE}\nSENDGRID_KEY=SG.x.y\nAUTH=${VALUE}\n`), [['DB_PASSWORD', 1], ['SENDGRID_KEY', 2], ['AUTH', 3]], 'env-style by its extension, read as widely as .env');
  assert.deepEqual(found('.envrc', `API_TOKEN_NAME=Abc12345\nTZ=America/Argentina/Buenos_Aires\n`), [['API_TOKEN_NAME', 1]]);
  assert.deepEqual(found('appsettings.json', `{"a":"${'x'.repeat(5_000)}","ApiKey":"${TOKEN}"}\n`), [['ApiKey', 1]], 'minified settings are read too');
  assert.deepEqual(found('src/config.ts', `password: ${VALUE}\n`), [], 'not shared config');
});

test('the scanner refuses a new value, warns on one already in Git or when held off, and lets a waived line pass', () => {
  const entries = [{ path: 'application.yml', content: `password: ${VALUE}\n` }];
  const refused = scanEntries(entries, { env: {} });
  assert.deepEqual([refused.blocking.length, refused.warnings.length, refused.clean], [1, 0, false]);
  assert.equal(refused.blocking[0].rule, 'config-value');
  assert.ok(!JSON.stringify(refused.blocking).includes(VALUE), 'never the value');
  assert.equal(refused.blocking[0].preview, `(${VALUE.length} chars)`, 'a model reads this: its length and no more');
  assert.match(secretRefusal(refused), /Replace it with \$\{NAME\}/u);
  const held = scanEntries(entries, { env: { SINGULARITY_FLOW_CONFIG_VALUES: 'warn' } });
  assert.deepEqual([held.blocking.length, held.warnings.length, held.clean], [0, 1, true]);
  assert.equal(secretRefusal(held), null);
  const known = scanEntries([{ ...entries[0], inGit: [`server: x\npassword: ${VALUE}\n`] }], { env: {} });
  assert.deepEqual([known.blocking.length, known.warnings.length], [0, 1], 'the same name and value in Git');
  assert.equal(known.warnings[0].alreadyInGit, true);
  assert.deepEqual(scanEntries([{ ...entries[0], inGit: [`password: ${VALUE}x\n`] }], { env: {} }).blocking.length, 1, 'a changed value is a new one');
  const waived = scanEntries([{ path: 'application.yml', content: `password: ${VALUE} # sflow-allow-secret: a local fixture\n` }], { env: {} });
  assert.deepEqual([waived.blocking.length, waived.warnings.length, waived.waived.length], [0, 0, 1]);
  const above = scanEntries([{ path: 'app.properties', content: `# sflow-allow-secret: a local fixture\ndb.password=${VALUE}\nother.password=${VALUE}\n` }], { env: {} });
  assert.deepEqual([above.waived.map((entry) => entry.line), above.blocking.map((entry) => entry.line)], [[2], [3]], 'the line above excuses only the next one');
  const quoted = scanEntries([{ path: 'application.yml', content: `password: "${VALUE}#4"\n` }], { env: { SINGULARITY_FLOW_CONFIG_VALUES: 'warn' } }); // sflow-allow-secret: a made-up value
  assert.deepEqual([quoted.blocking.length, quoted.warnings.length], [1, 0], 'what the scanner refused before it still refuses, once');
});

test('the commit gate refuses an always-local name, warns on a value, and lets a committed one leave', async (t) => {
  const repo = await repository(t, { '.env': `API_KEY=${TOKEN}\n`, 'application.yml': `password: ${VALUE}\n` });
  repo.git('add', 'README.md'); repo.git('commit', '-q', '-m', 'first');
  const commit = (paths, env) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
    `import { commit } from ${JSON.stringify(path.resolve('src/git.mjs'))}; commit(process.cwd(), 'change', ${JSON.stringify(paths)});`],
  { cwd: repo.root, encoding: 'utf8', env: { ...process.env, ...env } });

  repo.git('add', '-f', '.env');
  const named = commit(null);
  assert.notEqual(named.status, 0);
  assert.match(named.stderr, /ENVIRONMENT_LOCAL_CONTENT_REFUSED|must never enter Git/u);
  assert.match(named.stderr, /\.env matches the always-local name rule '\.env'/u);
  assert.match(named.stderr, /git rm --cached/u);
  repo.git('rm', '-q', '--cached', '.env');

  repo.git('add', 'application.yml');
  const refused = commit(null);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /a value for password/u);
  assert.ok(!refused.stderr.includes(VALUE), 'never the value');
  const held = commit(null, { SINGULARITY_FLOW_CONFIG_VALUES: 'warn' });
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stderr, /Warning: this change holds what look like real values/u);
  assert.match(held.stderr, /application\.yml:1 — a value for password/u);
  assert.match(held.stderr, /SINGULARITY_FLOW_CONFIG_VALUES is warn/u);
  assert.ok(!held.stderr.includes(VALUE), 'never the value');
  assert.match(repo.git('ls-files'), /application\.yml/u);
});

const gateCommit = (repo, paths = null) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
  `import { commit } from ${JSON.stringify(path.resolve('src/git.mjs'))}; commit(process.cwd(), 'change', ${JSON.stringify(paths)});`], { cwd: repo.root, encoding: 'utf8' });

test('a file a team already tracks stays shared config: it commits and edits, and its values are still read', async (t) => {
  const repo = await repository(t, { '.env.test': 'LOG_LEVEL=info\n', 'tsconfig.local.json': '{}\n' });
  repo.git('add', '-f', '.'); repo.git('commit', '-q', '-m', 'first');
  await writeFile(path.join(repo.root, 'README.md'), 'y\n');
  repo.git('add', 'README.md');
  const unrelated = gateCommit(repo);
  assert.equal(unrelated.status, 0, unrelated.stderr);
  await writeFile(path.join(repo.root, 'tsconfig.local.json'), '{"a":1}\n');
  await writeFile(path.join(repo.root, '.env.test'), 'LOG_LEVEL=debug\n');
  repo.git('add', 'tsconfig.local.json', '.env.test');
  const edited = gateCommit(repo);
  assert.equal(edited.status, 0, edited.stderr);
  await writeFile(path.join(repo.root, '.env.test'), `API_KEY=${TOKEN}\n`);
  repo.git('add', '.env.test');
  const leaked = gateCommit(repo);
  assert.notEqual(leaked.status, 0, 'a new value in it is refused');
  assert.match(leaked.stderr, /\.env\.test:1 — a value for API_KEY/u);
  repo.git('rm', '-q', '--cached', '.env.test');
  const removed = gateCommit(repo);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(repo.git('ls-files', '.env.test'), '');
});

test('a value already in Git warns and stops neither an unrelated edit nor a merge, and a new one is refused', async (t) => {
  const repo = await repository(t, { 'application.yml': `password: ${VALUE}\nserver: a\n`, 'other.yml': 'x: 1\n' });
  repo.git('add', '.'); repo.git('commit', '-q', '-m', 'first');
  await writeFile(path.join(repo.root, 'application.yml'), `password: ${VALUE}\nserver: b\n`);
  repo.git('add', 'application.yml');
  const edited = gateCommit(repo);
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(edited.stderr, /application\.yml:1 — a value for password \(12 chars\) \(already in Git\)/u);
  assert.match(edited.stderr, /so rotate it/u);
  assert.ok(!edited.stderr.includes(VALUE), 'never the value');
  await writeFile(path.join(repo.root, 'application.yml'), `password: ${VALUE}\nserver: b\ntoken: ${TOKEN}\n`);
  repo.git('add', 'application.yml');
  const added = gateCommit(repo);
  assert.notEqual(added.status, 0, 'a second value beside the old one is new');
  assert.match(added.stderr, /application\.yml:3 — a value for token/u);
  repo.git('checkout', '-q', 'HEAD', '--', 'application.yml');
  repo.git('checkout', '-q', '-b', 'teammate');
  await writeFile(path.join(repo.root, 'other.yml'), `api-key: ${TOKEN}\n`);
  repo.git('add', 'other.yml'); repo.git('commit', '-q', '-m', 'their value');
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-commit', '--no-ff', 'teammate');
  const merged = gateCommit(repo);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stderr, /other\.yml:1 — a value for api-key/u);
});

test('a .env.* file is private until a person classifies it, and its values are read either way', async (t) => {
  const repo = await repository(t, { '.env.test': 'LOG_LEVEL=info\n', '.env.local': `API_KEY=${TOKEN}\n`, 'tsconfig.local.json': '{}\n', 'application.yml': 'x: 1\n' });
  repo.git('add', 'README.md'); repo.git('commit', '-q', '-m', 'first');
  excludeAlwaysLocalNames(repo.root);
  assert.doesNotMatch(repo.git('status', '--porcelain'), /\.env\.test/u, 'Git does not offer it');

  repo.git('add', '-f', '.env.test');
  const refused = gateCommit(repo);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /env files classify <path> shared --reason <why>/u, 'the refusal names the way forward');
  repo.git('rm', '-q', '--cached', '.env.test');

  const listed = JSON.parse(cli(repo.root, ['env', 'files', 'classify', '--json']).stdout);
  assert.deepEqual(listed.files.map(({ path: file, class: kind, values }) => [file, kind, values]),
    [['.env.local', 'private', 1], ['.env.test', 'private', 0], ['tsconfig.local.json', 'private', 0]]);
  assert.match(listed.files[1].next, /classify \.env\.test shared/u);
  assert.ok(!JSON.stringify(listed).includes(TOKEN), 'never a value');

  assert.equal(JSON.parse(cli(repo.root, ['env', 'files', 'classify', '.env.test', 'shared', '--json']).stdout).error.code, 'ENV_FILE_CLASS_REASON_REQUIRED');
  const holding = JSON.parse(cli(repo.root, ['env', 'files', 'classify', '.env.local', 'shared', '--reason', 'x', '--json']).stdout);
  assert.equal(holding.error.code, 'ENV_FILE_HOLDS_VALUES');
  assert.match(holding.error.message, /API_KEY on line 1/u);
  assert.ok(!JSON.stringify(holding).includes(TOKEN), 'never a value');
  assert.equal(JSON.parse(cli(repo.root, ['env', 'files', 'classify', 'application.yml', 'shared', '--reason', 'x', '--json']).stdout).error.code, 'ENV_FILE_CLASS_NOT_NEEDED');
  assert.equal(JSON.parse(cli(repo.root, ['env', 'files', 'classify', 'tsconfig.local.json', 'shared', '--reason', 'x', '--json']).stdout).error.code, 'ENV_FILE_CLASS_BY_HAND');

  const shared = JSON.parse(cli(repo.root, ['env', 'files', 'classify', '.env.test', 'shared', '--reason', 'non-secret test defaults', '--json']).stdout);
  assert.deepEqual([shared.class, shared.changed], ['shared', true]);
  assert.equal(await readFile(path.join(repo.root, '.env.test'), 'utf8'), '# sflow-shared: non-secret test defaults\nLOG_LEVEL=info\n');
  assert.equal(JSON.parse(cli(repo.root, ['env', 'files', 'classify', '.env.test', 'shared', '--reason', 'again', '--json']).stdout).changed, false, 'once');
  assert.match(repo.git('status', '--porcelain'), /\.env\.test/u, 'Git offers this one again');
  assert.doesNotMatch(repo.git('status', '--porcelain'), /\.env\.local/u, 'and no other');
  assert.equal(await read(repo.root, '.env.test'), null, 'Copilot reads a classified file, even untracked');
  assert.match((await shell(repo.root, 'singularity-flow env files classify .env.test shared --reason x')).permissionDecisionReason, /^ENVIRONMENT_FILE_PRIVATE/u, 'what may leave the laptop is a person\'s call');

  repo.git('add', '.env.test');
  const committed = gateCommit(repo);
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(repo.git('ls-files', '.env.test'), /\.env\.test/u);

  await writeFile(path.join(repo.root, '.env.test'), `# sflow-shared: non-secret test defaults\nAPI_KEY=${TOKEN}\n`);
  repo.git('add', '.env.test');
  const leaked = gateCommit(repo);
  assert.notEqual(leaked.status, 0, 'a class never stops the value check');
  assert.match(leaked.stderr, /a value for API_KEY/u);
  assert.match((await read(repo.root, '.env.test')).permissionDecisionReason, /^CONFIG_VALUE_PRIVATE/u);
  repo.git('reset', '-q', 'HEAD', '.env.test'); repo.git('checkout', '-q', '--', '.env.test');

  const back = JSON.parse(cli(repo.root, ['env', 'files', 'classify', '.env.test', 'private', '--json']).stdout);
  assert.deepEqual([back.class, back.changed], ['private', true]);
  assert.match(back.next, /git rm --cached \.env\.test/u);
  assert.equal(await readFile(path.join(repo.root, '.env.test'), 'utf8'), 'LOG_LEVEL=info\n');
  assert.doesNotMatch(await readFile(path.join(repo.root, '.git/info/exclude'), 'utf8'), /^!\/\.env\.test$/mu);
  assert.deepEqual(JSON.parse(cli(repo.root, ['env', 'files', 'classify', '--json']).stdout).files.find((file) => file.path === '.env.test').class, 'unclassified');
});

test('a scoped commit cannot take a force-added file, and says so when Git itself refuses the name', async (t) => {
  const repo = await repository(t, { '.env': 'X=1\n', 'conf/.env': 'X=1\n', 'conf/a.txt': 'a\n' });
  repo.git('add', 'README.md'); repo.git('commit', '-q', '-m', 'first');
  excludeAlwaysLocalNames(repo.root);
  const commit = (paths) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
    `import { commit } from ${JSON.stringify(path.resolve('src/git.mjs'))}; commit(process.cwd(), 'change', ${JSON.stringify(paths)});`], { cwd: repo.root, encoding: 'utf8' });
  repo.git('add', '-f', 'conf/.env');
  const folder = commit(['conf']);
  assert.notEqual(folder.status, 0, 'a folder does not carry it in');
  assert.match(folder.stderr, /conf\/\.env matches the always-local name rule/u);
  assert.equal(repo.git('ls-files', 'conf/.env'), 'conf/.env\n', 'still only staged');
  assert.equal(repo.git('log', '--format=%s').trim(), 'first');
  repo.git('rm', '-q', '--cached', 'conf/.env');
  const named = commit(['.env']);
  assert.notEqual(named.status, 0);
  assert.match(named.stderr, /named to stay on this laptop/u);
  assert.match(named.stderr, /git rm --cached/u);
});

test('secrets scan --staged refuses a name and a new value, so the pre-commit hook does too', async (t) => {
  const repo = await repository(t, { '.env.local': 'X=1\n', 'application.yml': `password: ${VALUE}\n` });
  repo.git('add', '-f', 'application.yml');
  const refused = cli(repo.root, ['secrets', 'scan', '--staged']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /application\.yml:1 — a value for password/u);
  repo.git('commit', '-q', '--no-verify', '-m', 'an old mistake');
  await writeFile(path.join(repo.root, 'application.yml'), `password: ${VALUE}\nserver: b\n`);
  repo.git('add', 'application.yml');
  const known = cli(repo.root, ['secrets', 'scan', '--staged']);
  assert.equal(known.status, 0, 'a value already in Git only warns');
  assert.match(known.stderr, /already in Git/u);
  assert.match(known.stdout, /Not refused/u);
  repo.git('add', '-f', '.env.local');
  const named = cli(repo.root, ['secrets', 'scan', '--staged']);
  assert.equal(named.status, 1);
  assert.match(named.stderr, /\.env\.local — a file that stays on this laptop/u);
  assert.match(named.stderr, /git rm --cached/u);
  assert.match(named.stderr, /env files classify/u);
});

test('Git stops offering an always-local file, once, and the team\'s .gitignore is untouched', async (t) => {
  const repo = await repository(t, { '.env': 'X=1\n', '.env.example': 'X=\n', 'config.local.yml': 'x: 1\n', '.gitignore': 'dist/\n' });
  assert.equal(excludeAlwaysLocalNames(repo.root), true);
  assert.equal(excludeAlwaysLocalNames(repo.root), false, 'once');
  const status = repo.git('status', '--porcelain');
  assert.doesNotMatch(status, /\.env\n/u);
  assert.doesNotMatch(status, /config\.local\.yml/u);
  assert.match(status, /\.env\.example/u, 'a template is still shared');
  assert.equal(await readFile(path.join(repo.root, '.gitignore'), 'utf8'), 'dist/\n');
});

test('Copilot is refused an always-local file with no setup, and a real value until it is moved out', async (t) => {
  const repo = await repository(t, { '.env': `API_KEY=${TOKEN}\n`, '.env.example': 'API_KEY=\n', 'apps/web/.env': `API_KEY=${TOKEN}\n`, 'application.yml': `server:\n  port: 8080\npassword: ${VALUE}\n`, 'clean.yml': 'password: \${DB_PASSWORD}\n',
    'waived.yml': `password: ${VALUE} # sflow-allow-secret: a local fixture\n`, 'crlf.yml': `password: ${VALUE}\r\n`, 'compose.yml': 'url: postgres://postgres:postgres@db/app\n', 'src/App.java': 'class App {}\n' });
  await symlink('.env', path.join(repo.root, 'notes.txt'));
  assert.match((await read(repo.root, '.env')).permissionDecisionReason, /^ENVIRONMENT_FILE_PRIVATE/u);
  assert.match((await read(repo.root, 'notes.txt')).permissionDecisionReason, /^ENVIRONMENT_FILE_PRIVATE/u, 'through a link');
  assert.match((await read(repo.root, '.env.new')).permissionDecisionReason, /^ENVIRONMENT_FILE_PRIVATE/u, 'a file tool may not create one either');
  for (const command of ['cat .env', 'cat .env*', 'cat .env.*', 'cd apps/web && cat .env', 'find . -name .env -exec cat {} +', 'git show HEAD:.env', 'python3 -c "print(open(\'.env\').read())"', 'tool --file=.env', 'dd if=.env',
    'F=.env; cat "$F"', 'rg -g .env foo', 'grep -n foo .env', 'echo x > .env', 'source .env']) {
    assert.match((await shell(repo.root, command))?.permissionDecisionReason ?? 'allowed', /^ENVIRONMENT_FILE_PRIVATE/u, command);
  }
  for (const [toolName, toolArgs] of [['grep', { pattern: 'x', glob: '.env' }], ['grep', { pattern: 'x', include: '.env*' }], ['grep_search', { query: 'x', includePattern: '.env' }], ['apply_patch', { patch: '*** Move to: .env\n' }],
    ['apply_patch', { patch: '+++ .env\n' }], ['apply_patch', { patch: '--- a/.env\t2026-01-01\n' }], ['write_bash', { command: 'cat .env' }]]) {
    const refused = await environmentFilesToolGuard({ cwd: repo.root, toolName, toolArgs }, { env: process.env });
    assert.match(refused?.permissionDecisionReason ?? 'allowed', /^ENVIRONMENT_FILE_PRIVATE/u, `${toolName} ${JSON.stringify(toolArgs)}`);
  }
  for (const command of ['grep -n ".env" src/App.java', 'echo .env >> .gitignore', 'test -f .env', 'ls -a', 'git status', 'git rm --cached .env', 'git check-ignore .env', 'node -e "process.env.X"', 'cat README.md', 'sed -n 1p src/App.java']) {
    assert.equal(await shell(repo.root, command), null, `${command} shows nothing of the file`);
  }
  const held = await read(repo.root, 'application.yml');
  assert.match(held.permissionDecisionReason, /^CONFIG_VALUE_PRIVATE: application\.yml holds what looks like a real value \(a value for password, line 3\)/u);
  assert.ok(!held.permissionDecisionReason.includes(VALUE), 'never the value');
  assert.ok(!held.permissionDecisionReason.includes(VALUE.slice(0, 4)), 'nor its first characters');
  for (const command of ['grep port application.yml', 'git show HEAD:application.yml', 'cat crlf.yml']) assert.match((await shell(repo.root, command))?.permissionDecisionReason ?? 'allowed', /^CONFIG_VALUE_PRIVATE/u, command);
  for (const file of ['.env.example', 'clean.yml', 'waived.yml', 'compose.yml', 'src/App.java', 'missing.yml']) assert.equal(await read(repo.root, file), null, file);
  await writeFile(path.join(repo.root, 'application.yml'), 'server:\n  port: 8080\npassword: \${DB_PASSWORD}\n');
  assert.equal(await read(repo.root, 'application.yml'), null, 'readable again once the value is out');
});

test('Copilot can read a file with such a name that the team already tracks, if it holds no value', async (t) => {
  const repo = await repository(t, { 'tsconfig.local.json': '{}\n', 'docker-compose.local.yml': 'services: {}\n', 'config.local.yml': `password: ${VALUE}\n` });
  repo.git('add', '-f', '.'); repo.git('commit', '-q', '-m', 'first');
  assert.equal(await read(repo.root, 'tsconfig.local.json'), null);
  assert.equal(await shell(repo.root, 'cat docker-compose.local.yml'), null);
  assert.match((await read(repo.root, 'config.local.yml')).permissionDecisionReason, /^CONFIG_VALUE_PRIVATE/u);
});

test('a document or a specification source takes the same rules, even in a repository that declares its own', async () => {
  for (const name of ['.env', '.env.production', 'application-local.yml']) assert.throws(() => assertNotPrivateEnvironmentName(name), { code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' });
  assert.doesNotThrow(() => assertNotPrivateEnvironmentName('.env.example'));
  const admit = (source, content) => assertDocumentInputContainsNoSecret({ source }, { bytes: Buffer.from(content) });
  assert.throws(() => admit('application.yml', `password: ${VALUE}\n`), { code: 'SECRET_DETECTED' });
  assert.doesNotThrow(() => admit('application.yml', 'password: ${DB_PASSWORD}\n'));
  assert.doesNotThrow(() => admit('.env.example', 'CALLBACK=https://x.io/a?auth=true\n'), 'a link is judged by its value, not only its name');
  assert.throws(() => admit('notes.env', `DB_PASSWORD=${VALUE}\r\n`), { code: 'SECRET_DETECTED' }, 'a Windows file, named by its extension');
});

test('env audit works with no declaration and says a value in the last publication has to rotate', async (t) => {
  const repo = await repository(t, { '.env.test': 'X=1\n', 'application.yml': `password: ${VALUE}\n` });
  repo.git('add', '-f', '.'); repo.git('commit', '-q', '-m', 'first');
  const result = cli(repo.root, ['env', 'audit', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.status, 'findings');
  assert.equal(audit.declarationSha256, null);
  assert.ok(audit.findings.some((finding) => finding.code === 'environment.local-file-tracked' && finding.path === '.env.test'));
  const secret = audit.findings.find((finding) => finding.code === 'environment.possible-secret' && finding.source === 'last-publication' && finding.path === 'application.yml');
  assert.match(secret.advice, /rotate it/u);
  assert.ok(!result.stdout.includes(VALUE), 'never the value');
});

test('a private file moves out of the way with no declaration, so the refusal never dead-ends', async (t) => {
  const repo = await repository(t, { 'app-secrets.yml': `password: ${VALUE}\n` });
  repo.git('add', 'README.md'); repo.git('commit', '-q', '-m', 'first');
  const added = cli(repo.root, ['env', 'files', 'add', 'dev', 'app-secrets.yml', '--personal', '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const adopted = cli(repo.root, ['env', 'files', 'adopt', 'dev', 'app-secrets.yml', '--json']);
  assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
  assert.equal(await readFile(path.join(repo.root, 'app-secrets.yml'), 'utf8'), `password: ${VALUE}\n`, 'tests still find it');
  assert.equal(repo.git('status', '--porcelain'), '', 'Git no longer offers it');
});

test('a person\'s .env in a Story\'s checkout is never a change to review, and setting it aside is never offered', async (t) => {
  const { startedSpecificationStory } = await import('./helpers/submitted-planning-story.mjs');
  const { root, git, cli } = await startedSpecificationStory(t, 'ENVF-REVIEW-1');
  // As in a new Story's checkout, before anything has listed these names.
  const exclude = path.resolve(root, git('rev-parse', '--git-common-dir'), 'info', 'exclude');
  const listed = new Set([ALWAYS_LOCAL_EXCLUDE_COMMENT, ...ALWAYS_LOCAL_EXCLUDES]);
  await writeFile(exclude, (await readFile(exclude, 'utf8')).split('\n').filter((line) => !listed.has(line)).join('\n'));
  await writeFile(path.join(root, '.env'), 'API_KEY=Xq7mA2pLz9vB4xT\n');
  assert.match(git('status', '--short'), /\.env/u);
  const entry = cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout;
  assert.doesNotMatch(entry, /PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED/u);
  assert.doesNotMatch(entry, /set-aside/u);
  assert.doesNotMatch(git('status', '--short'), /\.env/u);
  assert.match(await readFile(path.join(root, '.env'), 'utf8'), /API_KEY/u, 'the person\'s file stays where it is');
});
