import assert from 'node:assert/strict';
import test from 'node:test';

import {
  environmentFileKind, environmentFilePairs, redactionName, secretEnvironmentFileValues
} from '../src/environment-files-values.mjs';
import { redactText, redactionEntries } from '../src/output-redaction.mjs';
import { repository, writeFiles } from './helpers/environment-files-fixture.mjs';

const SENTINEL = 'sentinel-secret-never-read-4471';

test('env files suggest finds framework environment files by name only and drafts localFiles', async (t) => {
  const repo = await repository(t, { files: {
    'services/api/pom.xml': '<project/>',
    'services/api/src/main/resources/application.yml': 'server:\n  port: 8080\n',
    'services/api/src/main/resources/application-uat.example.yml': 'spring:\n  datasource:\n    password: CHANGE_ME\n',
    'services/billing/config/application-dev.properties.sample': 'x=1\n',
    'apps/web/package.json': '{}',
    'apps/web/.env.uat.example': 'API_TOKEN=\n',
    'backend/manage.py': '',
    'backend/proj/settings/__init__.py': '', 'backend/proj/settings/base.py': '',
    'svc/requirements.txt': 'fastapi==0.110\n', 'svc/.env.example': 'X=\n',
    'dotnet/appsettings.json': '{}', 'go/go.mod': 'module x\n',
    'rails/config/credentials/production.yml.enc': 'enc', 'rails/config/credentials.yml.enc': 'enc',
    'services/legacy/src/main/resources/application-qa.yml': 'tracked: true\n'
  } });
  // Real files present but never committed: their values must never be read.
  await writeFiles(repo.root, {
    'apps/web/.env.dev': `API_TOKEN=${SENTINEL}\n`, 'apps/web/.env.local': `IGNORED=${SENTINEL}\n`,
    'backend/proj/settings/uat.py': `SECRET_KEY = '${SENTINEL}'\n`, 'dotnet/appsettings.Development.json': `{"Secret":"${SENTINEL}"}`,
    'go/cmd/config.uat.yaml': `password: ${SENTINEL}\n`, 'node_modules/pkg/.env.dev': `X=${SENTINEL}\n`
  });
  const suggested = repo.json(['env', 'files', 'suggest']);
  assert.equal(suggested.status, 0, suggested.stderr);
  assert.equal(JSON.stringify(suggested.value).includes(SENTINEL), false, 'no value is ever read');
  const byPath = Object.fromEntries(suggested.value.candidates.map((candidate) => [`${candidate.environment}:${candidate.path}`, candidate]));
  const expect = (key, framework, extra = {}) => {
    assert.ok(byPath[key], `${key} in ${Object.keys(byPath).join(', ')}`);
    assert.equal(byPath[key].framework, framework, key);
    for (const [name, value] of Object.entries(extra)) assert.deepEqual(byPath[key][name], value, `${key}.${name}`);
  };
  expect('uat:services/api/src/main/resources/application-uat.yml', 'spring', { app: 'services/api', exists: false,
    template: 'services/api/src/main/resources/application-uat.example.yml' });
  expect('dev:services/billing/config/application-dev.properties', 'spring', { template: 'services/billing/config/application-dev.properties.sample' });
  expect('uat:apps/web/.env.uat', 'node', { template: 'apps/web/.env.uat.example' });
  expect('dev:apps/web/.env.dev', 'node', { exists: true, declared: true, tracked: false });
  expect('uat:backend/proj/settings/uat.py', 'django', { app: 'backend/proj' });
  expect('null:svc/.env', 'fastapi', { template: 'svc/.env.example' });
  expect('development:dotnet/appsettings.Development.json', 'dotnet');
  expect('uat:go/cmd/config.uat.yaml', 'go');
  expect('production:rails/config/credentials/production.key', 'rails', { app: 'rails' });
  expect('null:rails/config/master.key', 'rails');
  expect('qa:services/legacy/src/main/resources/application-qa.yml', 'spring', { tracked: true, exists: true });
  assert.equal(Object.keys(byPath).some((key) => key.includes('node_modules') || key.includes('.env.local') || key.includes('base.py')), false);
  const { draft } = suggested.value;
  assert.equal(draft.path, 'singularity/environments.yml');
  // The fixture already declares the Spring and Node uat files, so only the others are drafted.
  assert.equal(byPath['uat:apps/web/.env.uat'].declared, true);
  assert.deepEqual(draft.localFiles.uat.sort(), ['backend/proj/settings/uat.py', 'go/cmd/config.uat.yaml']);
  assert.deepEqual(draft.localFiles.dev, ['services/billing/config/application-dev.properties']);
  assert.deepEqual(Object.keys(draft.undeclaredEnvironments).sort(), ['development', 'production'], 'a tracked candidate is never drafted');
  assert.ok(suggested.value.notes.some((note) => /A tracked candidate is already in Git/u.test(note)));
  assert.equal(draft.valid, true, draft.error);
  assert.match(draft.document, /apps\/web\/\.env\.uat/u);
  assert.match(draft.document, /apps\/web\/\.env\.dev/u, 'the existing declaration is kept');
  assert.deepEqual(suggested.value.proposal, { command: 'singularity-flow configuration save singularity/environments.yml --propose', stdin: 'draft.document' });
  assert.ok(suggested.value.notes.some((note) => /not declared; declaring one needs at least one requires entry/u.test(note)));
  assert.ok(suggested.value.notes.some((note) => /shared by every environment/u.test(note)));
  const text = repo.sflow(['env', 'files', 'suggest']);
  assert.match(text.stdout, /uat · spring · services\/api\/src\/main\/resources\/application-uat\.yml \(declared, template /u);
});

test('bounded parsers find secret-looking values in every supported format, named FILE-KEY', () => {
  const cases = [
    ['.env.uat', 'export API_TOKEN="tok-value-1234"\nPORT=8080\nNAME=plain-name\n# PASSWORD=commented\n', ['ENV_UAT-API_TOKEN']],
    ['application-uat.yml', 'spring:\n  datasource:\n    password: yaml-pass-1234\n    url: jdbc:h2:mem\n---\napp:\n  auth:\n    enabled: true\n', ['APPLICATION_UAT_YML-SPRING_DATASOURCE_PASSWORD']],
    ['application-uat.properties', 'spring.datasource.password=props-pass-1234\nserver.port: 8080\napi.key  spaced-key-1234\n',
      ['APPLICATION_UAT_PROPERTIES-API_KEY', 'APPLICATION_UAT_PROPERTIES-SPRING_DATASOURCE_PASSWORD']],
    ['appsettings.UAT.json', '{"Jwt":{"Secret":"json-secret-1234"},"Port":5000,"Mode":"plain"}', ['APPSETTINGS_UAT_JSON-JWT_SECRET']],
    ['config.uat.toml', '[database]\npassword = "toml-pass-1234"\nport = 5432\n', ['CONFIG_UAT_TOML-DATABASE_PASSWORD']],
    ['service.ini', '[auth]\ntoken = ini-token-1234 ; note\n[server]\nhost = example\n', ['SERVICE_INI-AUTH_TOKEN']],
    ['uat.py', 'SECRET_KEY = "django-secret-1234"\nDEBUG = False\nDATABASES = {"default": {"PASSWORD": "db-pass-1234"}}\n', ['UAT_PY-PASSWORD', 'UAT_PY-SECRET_KEY']],
    ['production.key', '0123456789abcdef0123456789abcdef\n', ['PRODUCTION_KEY-VALUE']]
  ];
  for (const [name, text, expected] of cases) {
    const found = secretEnvironmentFileValues(name, environmentFilePairs(environmentFileKind(name), text));
    assert.deepEqual(found.map((entry) => entry.name).sort(), expected.sort(), name);
  }
  // Placeholders, booleans and numbers are never treated as secrets, even under a secret key.
  assert.deepEqual(secretEnvironmentFileValues('.env', environmentFilePairs('dotenv', 'PASSWORD=${DB_PASSWORD}\nTOKEN=true\nSECRET=1234\nKEY=changeme\n')), []);
  // A value that itself looks like a credential is redacted under any key.
  assert.deepEqual(secretEnvironmentFileValues('.env', environmentFilePairs('dotenv', 'DATABASE_URL=postgres://user:pw@db.example.test/app\n')).map((entry) => entry.name),
    ['ENV-DATABASE_URL']);
  // A broken YAML file still yields its simple lines; nothing is thrown or quoted.
  assert.deepEqual(secretEnvironmentFileValues('a.yml', environmentFilePairs('yaml', 'a: [unclosed\npassword: broken-yaml-pass\n')).map((entry) => entry.value), ['broken-yaml-pass']);
  assert.equal(redactionName('.env.dev', 'spring.datasource.password'), 'ENV_DEV-SPRING_DATASOURCE_PASSWORD');
  const entries = redactionEntries([{ name: 'ENV_DEV-API_TOKEN', value: 'tok-value-1234' }, { name: 'API_TOKEN', value: 'bound-value-1234' }]);
  assert.equal(redactText('a tok-value-1234 b bound-value-1234', entries), 'a [redacted:ENV_DEV-API_TOKEN] b [redacted:API_TOKEN]');
});
