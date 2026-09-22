import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadEnvironmentDeclaration, loadEnvironmentDeclarationSync, matchEnvironmentLocalPath,
  parseEnvironmentDeclaration, validateEnvironmentCheckMappings,
  validateEnvironmentQualityCommandCatalog
} from '../src/environment-declaration.mjs';
import {
  bindEnvironment, environmentBindingStatus, resolveEnvironmentBinding, unbindEnvironment
} from '../src/environment-bindings.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function repository(declaration) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-env-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Environment Binding Tester']);
  git(root, ['config', 'user.email', 'environment-binding@example.invalid']);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), '{}\n');
  await writeFile(path.join(root, 'singularity', 'environments.yml'), declaration);
  return root;
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : entry.isFile() ? [target] : [];
  }));
  return nested.flat();
}

const DECLARATION = `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_BASE_URL
        kind: endpoint
        value: https://qa.example.test
      - name: DB_CONN
        kind: secret
      - name: FEATURE_X
        kind: flag
        default: false
    localFiles:
      - .env.qa
checks:
  integration-tests:
    environment: qa
neverCommit:
  - "**/*.local.yml"
`;

test('environment declaration is closed, portable, and names secret requirements only', () => {
  const declaration = parseEnvironmentDeclaration(Buffer.from(DECLARATION));
  assert.equal(declaration.schemaVersion, 1);
  assert.equal(declaration.environments.qa.requires[0].value, 'https://qa.example.test');
  assert.equal(declaration.environments.qa.requires[2].default, 'false');
  assert.deepEqual(matchEnvironmentLocalPath(declaration, '.env.qa'), {
    environmentId: 'qa', kind: 'local-file', pattern: '.env.qa'
  });
  assert.deepEqual(matchEnvironmentLocalPath(declaration, '.ENV.QA'), {
    environmentId: 'qa', kind: 'local-file', pattern: '.env.qa'
  }, 'portable filesystem aliases must not bypass an environment-local rule');
  assert.deepEqual(matchEnvironmentLocalPath(declaration, '.ENV.QA...   '), {
    environmentId: 'qa', kind: 'local-file', pattern: '.env.qa'
  }, 'Win32 trailing-dot and space aliases must not bypass an environment-local rule');
  assert.deepEqual(matchEnvironmentLocalPath(declaration, 'nested/a.local.yml'), {
    environmentId: null, kind: 'never-commit', pattern: '**/*.local.yml'
  });
  assert.deepEqual(matchEnvironmentLocalPath(declaration, 'nested\\a.local.yml'), {
    environmentId: null, kind: 'never-commit', pattern: '**/*.local.yml'
  });
  assert.throws(() => parseEnvironmentDeclaration(Buffer.from(`schemaVersion: 1
environments:
  qa:
    requires:
      - { name: TOKEN, kind: secret, value: exposed }
`)), /unsupported field.*value/i);
  assert.throws(() => parseEnvironmentDeclaration(Buffer.from(`schemaVersion: 1
environments:
  qa:
    requires:
      - { name: PATH, kind: flag }
neverCommit: ["**/*"]
`)), /reserved/i);
  assert.throws(() => parseEnvironmentDeclaration(Buffer.from(`schemaVersion: 1
environments:
  qa-:
    requires:
      - { name: SERVICE_URL, kind: endpoint, value: "https://example.test" }
`)), /lower-kebab-case/i);
  assert.throws(() => parseEnvironmentDeclaration(Buffer.from(`schemaVersion: 1
environments:
  qa:
    requires:
      - { name: SERVICE_URL, kind: endpoint, value: "https://example.test/path?token=public" }
`)), /query, or fragment/i);
  assert.throws(() => parseEnvironmentDeclaration(Buffer.from(`schemaVersion: 1
environments:
  qa:
    requires:
      - { name: FEATURE_X, kind: flag, default: "${'x'.repeat(257)}" }
`)), /bounded flag value/i);

  const invalidUtf8 = Buffer.concat([
    Buffer.from('schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n'
      + '      - { name: API_BASE_URL, kind: endpoint, value: "https://qa.example.test/'),
    Buffer.from([0xff]),
    Buffer.from('" }\nchecks: {}\nneverCommit: []\n')
  ]);
  assert.throws(
    () => parseEnvironmentDeclaration(invalidUtf8),
    (error) => error?.code === 'ENVIRONMENT_DECLARATION_INVALID'
      && /valid UTF-8/i.test(error.message)
  );
});

test('declaration loader refuses a symlink instead of reading outside the repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-env-link-'));
  const outside = path.join(root, 'outside.yml');
  await mkdir(path.join(root, 'singularity'));
  await writeFile(outside, DECLARATION);
  await symlink(outside, path.join(root, 'singularity', 'environments.yml'));
  await assert.rejects(
    () => loadEnvironmentDeclaration(root, { optional: false }),
    (error) => error?.code === 'ENVIRONMENT_DECLARATION_INVALID'
  );
});

test('declaration loader bounds reads before parsing and check mappings name exact quality commands', async () => {
  const root = await repository(DECLARATION);
  validateEnvironmentCheckMappings(parseEnvironmentDeclaration(Buffer.from(DECLARATION)), [
    'unit-tests', 'integration-tests'
  ]);
  assert.throws(
    () => validateEnvironmentCheckMappings(parseEnvironmentDeclaration(Buffer.from(DECLARATION)), [
      'unit-tests', 'integration-tset'
    ]),
    /unknown quality command ID.*integration-tests/i
  );
  assert.throws(
    () => validateEnvironmentCheckMappings(parseEnvironmentDeclaration(Buffer.from(DECLARATION)), [
      'integration-tests', 'integration-tests'
    ]),
    /duplicate ID.*integration-tests/i
  );

  await writeFile(path.join(root, 'singularity', 'environments.yml'), Buffer.alloc((256 * 1024) + 1, 0x20));
  assert.throws(
    () => loadEnvironmentDeclarationSync(root, { optional: false }),
    /exceeds 262144 bytes/i
  );
  await assert.rejects(
    () => loadEnvironmentDeclaration(root, { optional: false }),
    /exceeds 262144 bytes/i
  );
});

test('quality-command environment validation rejects only relevant ambiguity and inconsistent bindings', () => {
  const declaration = parseEnvironmentDeclaration(Buffer.from(DECLARATION));
  const base = {
    id: 'integration-tests', argv: ['npm', 'test'], command: null,
    modelPolicy: 'never', requirement: 'required', timeoutMs: null,
    kind: 'test', environment: null, workingDirectory: '.', affectedRoots: [], result: null
  };
  validateEnvironmentQualityCommandCatalog(declaration, [
    base,
    { ...base, id: 'unmapped-duplicate', argv: ['npm', 'run', 'one'] },
    { ...base, id: 'unmapped-duplicate', argv: ['npm', 'run', 'two'] }
  ]);
  assert.throws(
    () => validateEnvironmentQualityCommandCatalog(declaration, [
      base, { ...base, argv: ['npm', 'run', 'different'] }
    ]),
    /checks maps ambiguous quality command ID.*integration-tests/i
  );
  assert.throws(
    () => validateEnvironmentQualityCommandCatalog(declaration, [
      { ...base, id: 'browser-tests', environment: 'missing' }
    ]),
    /references unknown environment 'missing'/i
  );
  const declarationWithOther = parseEnvironmentDeclaration(Buffer.from(DECLARATION.replace(
    'environments:\n',
    'environments:\n  other:\n    requires:\n      - name: OTHER_TOKEN\n        kind: secret\n'
  )));
  assert.throws(
    () => validateEnvironmentQualityCommandCatalog(declarationWithOther, [
      { ...base, environment: 'other' }
    ]),
    /explicitly uses environment 'other'.*checks maps it to 'qa'/i
  );
  assert.throws(
    () => validateEnvironmentQualityCommandCatalog(null, [
      { ...base, environment: 'qa' }
    ]),
    /no environment declaration exists/i
  );
});

test('private binding status never returns values, references, or process environment', async () => {
  const root = await repository(DECLARATION);
  const secret = 'correct-horse-private-value';
  const reference = 'broker:qa/feature-x';
  const bound = await bindEnvironment(root, 'qa', {
    bindings: {
      DB_CONN: { source: 'local', value: secret },
      FEATURE_X: { source: 'reference', reference }
    }
  });
  assert.equal(bound.status, 'unavailable');
  assert.deepEqual(bound.environment.secretsPresent, ['DB_CONN']);
  assert.equal(bound.environment.source, 'private-binding+declaration-defaults');
  assert.match(bound.environment.bindingRevision, /^envb_[0-9a-f-]{36}$/);
  assert.equal(bound.processEnvironment, undefined);
  const rendered = JSON.stringify(await environmentBindingStatus(root));
  const secretDigest = createHash('sha256').update(secret).digest('hex');
  assert.doesNotMatch(rendered, new RegExp(secret));
  assert.doesNotMatch(rendered, new RegExp(secretDigest));
  assert.doesNotMatch(rendered, new RegExp(reference));
  assert.doesNotMatch(rendered, /https:\/\/qa\.example\.test/);
  assert.doesNotMatch(rendered, /processEnvironment/);
  assert.match(rendered, /filesystem-private/);
  assert.match(bound.environment.endpointsSha256, /^sha256:[a-f0-9]{64}$/);
  const fromCheck = await resolveEnvironmentBinding(root, null, { commandId: 'integration-tests' });
  assert.equal(fromCheck.environment.name, 'qa');
  const noCheck = await resolveEnvironmentBinding(root, null, { commandId: 'unit-tests' });
  assert.deepEqual(noCheck, { status: 'unbound', environment: null, missing: [] });
  await assert.rejects(() => bindEnvironment(root, 'qa', {
    bindings: {
      API_BASE_URL: { source: 'local', value: 'https://qa.example.test/path#fragment' }
    }
  }), /query, or fragment/i);
});

test('partial binding updates preserve already validated names and rotate the opaque revision', async () => {
  const root = await repository(DECLARATION);
  const first = await bindEnvironment(root, 'qa', {
    bindings: { DB_CONN: { source: 'local', value: 'first-private-value' } }
  });
  assert.equal(first.status, 'bound');
  const second = await bindEnvironment(root, 'qa', {
    bindings: { FEATURE_X: { source: 'local', value: 'enabled' } }
  });
  assert.equal(second.status, 'bound');
  assert.deepEqual(second.environment.boundNames, ['API_BASE_URL', 'DB_CONN', 'FEATURE_X']);
  assert.deepEqual(second.environment.secretsPresent, ['DB_CONN']);
  assert.notEqual(second.environment.bindingRevision, first.environment.bindingRevision);

  const storedPath = path.join(root, '.git', 'singularity-flow', 'environments', 'v1', 'qa.json');
  const stored = JSON.parse(await readFile(storedPath, 'utf8'));
  assert.equal(stored.bindings.DB_CONN.value, 'first-private-value');
  assert.equal(stored.bindings.FEATURE_X.value, 'enabled');
});

test('stored private bindings are revalidated against current declaration names and kinds', async () => {
  const root = await repository(DECLARATION);
  await bindEnvironment(root, 'qa', {
    bindings: {
      DB_CONN: { source: 'local', value: 'private-value' },
      FEATURE_X: { source: 'local', value: 'enabled' }
    }
  });
  const storedPath = path.join(root, '.git', 'singularity-flow', 'environments', 'v1', 'qa.json');
  const original = JSON.parse(await readFile(storedPath, 'utf8'));
  const mutations = [
    (record) => { record.bindings.UNDECLARED_TOKEN = { source: 'local', value: 'private' }; },
    (record) => { record.bindings.API_BASE_URL = { source: 'local', value: 'file:///private' }; },
    (record) => { record.bindings.FEATURE_X = { source: 'local', value: 'x'.repeat(257) }; },
    (record) => { record.bindings.DB_CONN = { source: 'reference', reference: 'broker:qa\nunsafe' }; },
    (record) => { record.bindings.DB_CONN = { source: 'local', value: 'x'.repeat(16_385) }; }
  ];
  for (const mutate of mutations) {
    const tampered = structuredClone(original);
    mutate(tampered);
    await writeFile(storedPath, `${JSON.stringify(tampered)}\n`);
    const resolved = await resolveEnvironmentBinding(root, 'qa');
    assert.equal(resolved.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(resolved), /private-value|file:\/\/\/private|broker:qa/);
  }

  const invalidUtf8 = Buffer.concat([
    Buffer.from(JSON.stringify(original).replace('private-value', 'do-not-relay-')),
    Buffer.from([0xff])
  ]);
  await writeFile(storedPath, invalidUtf8);
  const unavailable = await resolveEnvironmentBinding(root, 'qa');
  assert.equal(unavailable.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /do-not-relay|private-value|�/);
});

test('unbind removes a corrupt private record without parsing or exposing it', async () => {
  const root = await repository(DECLARATION);
  await bindEnvironment(root, 'qa', {
    bindings: { DB_CONN: { source: 'local', value: 'private-value' } }
  });
  const storedPath = path.join(root, '.git', 'singularity-flow', 'environments', 'v1', 'qa.json');
  await writeFile(storedPath, '{"private":"malformed-secret-value"');
  const result = await unbindEnvironment(root, 'qa');
  assert.deepEqual(result, { environment: 'qa', removed: true });
  const status = await environmentBindingStatus(root, 'qa');
  assert.equal(status.environments[0].status, 'unbound');
  assert.doesNotMatch(JSON.stringify(status), /malformed-secret-value/);
});

test('env CLI accepts binding values only on bounded stdin and emits secret-free JSON', async () => {
  const root = await repository(DECLARATION);
  const secret = 'cli-private-secret-value';
  const payload = JSON.stringify({
    bindings: { DB_CONN: { source: 'local', value: secret } }
  });
  const result = spawnSync(process.execPath, [CLI, 'env', 'bind', 'qa', '--stdin', '--json'], {
    cwd: root, input: payload, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'bound');
  assert.deepEqual(output.environment.secretsPresent, ['DB_CONN']);
  assert.equal(output.processEnvironment, undefined);

  const rejectedSecret = 'rejected-legacy-private-value';
  const unsafe = spawnSync(process.execPath, [
    CLI, 'env', 'bind', 'qa', '--set', `DB_CONN=${rejectedSecret}`, '--json'
  ], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.notEqual(unsafe.status, 0);
  assert.doesNotMatch(`${unsafe.stdout}${unsafe.stderr}`, new RegExp(rejectedSecret));
  const refusal = JSON.parse(unsafe.stderr);
  assert.equal(refusal.resultType, 'sflow-refusal-plan');
  assert.doesNotMatch(JSON.stringify(refusal), new RegExp(rejectedSecret));
  for (const file of await filesBelow(path.join(root, '.git', 'singularity-flow'))) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes(Buffer.from(rejectedSecret)), false,
      `rejected private argv reached ${path.relative(root, file)}`);
  }

  const malformedSecret = 'malformed-private-json-value';
  const malformed = spawnSync(process.execPath, [CLI, 'env', 'bind', 'qa', '--stdin'], {
    cwd: root, input: `{"bindings":{"DB_CONN":${malformedSecret}}}`,
    encoding: 'utf8', env: { ...process.env }
  });
  assert.notEqual(malformed.status, 0);
  assert.doesNotMatch(`${malformed.stdout}${malformed.stderr}`, new RegExp(malformedSecret));
  assert.match(`${malformed.stdout}${malformed.stderr}`, /not valid JSON/i);

  const invalidUtf8Marker = 'invalid-utf8-private-value';
  const invalidUtf8 = spawnSync(process.execPath, [CLI, 'env', 'bind', 'qa', '--stdin'], {
    cwd: root,
    input: Buffer.concat([
      Buffer.from(`{"bindings":{"DB_CONN":{"source":"local","value":"${invalidUtf8Marker}`),
      Buffer.from([0xff]),
      Buffer.from('"}}}')
    ]),
    encoding: 'utf8', env: { ...process.env }
  });
  assert.notEqual(invalidUtf8.status, 0);
  assert.doesNotMatch(`${invalidUtf8.stdout}${invalidUtf8.stderr}`, new RegExp(invalidUtf8Marker));
  assert.match(`${invalidUtf8.stdout}${invalidUtf8.stderr}`, /must be valid UTF-8/i);
});

test('env audit reports tracked local files and redacts possible secrets', async () => {
  const root = await repository(DECLARATION);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, '.env.qa'), 'SAFE_NAME=value\n');
  await writeFile(path.join(root, 'src', 'credential.txt'), `token = "ghp_${'A'.repeat(36)}"\n`);
  git(root, ['add', 'singularity/environments.yml', '.env.qa', 'src/credential.txt']);
  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(`ghp_${'A'.repeat(36)}`));
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'findings');
  assert.ok(output.findings.some((entry) => entry.code === 'environment.local-file-tracked'));
  assert.ok(output.findings.some((entry) => entry.code === 'environment.possible-secret'));
  assert.ok(output.findings.every((entry) => !Object.hasOwn(entry, 'preview')));
});

test('env audit reads exact candidate-index and last-publication bytes, not only the worktree', async () => {
  const root = await repository(DECLARATION);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'credential.txt'), 'safe=true\n');
  git(root, ['add', 'singularity/environments.yml', 'src/credential.txt']);
  git(root, ['commit', '-q', '-m', 'safe baseline']);

  const stagedSecret = `ghp_${'B'.repeat(36)}`;
  await writeFile(path.join(root, 'src', 'credential.txt'), `token = "${stagedSecret}"\n`);
  git(root, ['add', 'src/credential.txt']);
  await writeFile(path.join(root, 'src', 'credential.txt'), 'safe=true\n');
  let result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(stagedSecret));
  let output = JSON.parse(result.stdout);
  assert.ok(output.findings.some((entry) =>
    entry.code === 'environment.possible-secret' && entry.source === 'candidate-index'));

  git(root, ['restore', '--staged', 'src/credential.txt']);
  const publishedSecret = `ghp_${'C'.repeat(36)}`;
  await writeFile(path.join(root, 'src', 'credential.txt'), `token = "${publishedSecret}"\n`);
  git(root, ['add', 'src/credential.txt']);
  git(root, ['commit', '-q', '-m', 'historical leaked publication']);
  await writeFile(path.join(root, 'src', 'credential.txt'), 'safe=true\n');
  result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(publishedSecret));
  output = JSON.parse(result.stdout);
  assert.ok(output.findings.some((entry) =>
    entry.code === 'environment.possible-secret' && entry.source === 'last-publication'));
});

test('env audit marks invalid UTF-8 worktree and candidate bytes unavailable instead of clean', async () => {
  const root = await repository(DECLARATION);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'opaque.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
  git(root, ['add', 'singularity/environments.yml', 'src/opaque.txt']);
  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'unavailable');
  assert.equal(output.coverageComplete, false);
  assert.ok(output.skipped.some((entry) =>
    entry.path === 'src/opaque.txt' && entry.source === 'candidate-index'
      && entry.reason === 'staged-audit-invalid-utf8'));
});

test('env audit retains declared-local findings from HEAD after a staged deletion', async () => {
  const root = await repository(DECLARATION);
  await writeFile(path.join(root, '.env.qa'), 'SAFE_NAME=historical\n');
  git(root, ['add', 'singularity/environments.yml', '.env.qa']);
  git(root, ['commit', '-q', '-m', 'historical local publication']);
  git(root, ['rm', '-q', '.env.qa']);

  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.findings.some((entry) => entry.path === '.env.qa'
    && entry.code === 'environment.local-file-tracked'
    && entry.source === 'last-publication'));
});

test('env audit retains HEAD policy when the worktree declaration is weakened', async () => {
  const root = await repository(DECLARATION);
  await writeFile(path.join(root, '.env.qa'), 'SAFE_NAME=historical\n');
  git(root, ['add', 'singularity/environments.yml', '.env.qa']);
  git(root, ['commit', '-q', '-m', 'strict published policy']);
  await writeFile(path.join(root, 'singularity', 'environments.yml'), DECLARATION.replace(
    '    localFiles:\n      - .env.qa', '    localFiles: []'
  ));

  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.findings.some((entry) => entry.path === '.env.qa'
    && entry.code === 'environment.local-file-tracked'
    && entry.source === 'last-publication'));
});

test('env audit uses staged tightening even when the worktree declaration is weakened', async () => {
  const loose = DECLARATION.replace(
    '    localFiles:\n      - .env.qa', '    localFiles: []'
  );
  const root = await repository(loose);
  git(root, ['add', 'singularity/environments.yml']);
  git(root, ['commit', '-q', '-m', 'loose baseline policy']);
  await writeFile(path.join(root, 'singularity', 'environments.yml'), DECLARATION);
  await writeFile(path.join(root, '.env.qa'), 'SAFE_NAME=candidate\n');
  git(root, ['add', 'singularity/environments.yml', '.env.qa']);
  await writeFile(path.join(root, 'singularity', 'environments.yml'), loose);

  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.findings.some((entry) => entry.path === '.env.qa'
    && entry.code === 'environment.local-file-tracked'));
});

test('env audit fails closed when an exact Git declaration is invalid', async () => {
  const root = await repository(DECLARATION);
  const declarationPath = path.join(root, 'singularity', 'environments.yml');
  await writeFile(declarationPath, DECLARATION.replace('kind: secret', 'kind: unsupported'));
  git(root, ['add', 'singularity/environments.yml']);
  git(root, ['commit', '-q', '-m', 'invalid exact declaration']);
  await writeFile(declarationPath, DECLARATION);

  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ENVIRONMENT_DECLARATION_INVALID/);
});

test('env audit fails closed when a last-publication text blob is invalid UTF-8', async () => {
  const root = await repository(DECLARATION);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'historical-opaque.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
  git(root, ['add', 'singularity/environments.yml', 'src/historical-opaque.txt']);
  git(root, ['commit', '-q', '-m', 'historical opaque publication']);
  await writeFile(path.join(root, 'src', 'historical-opaque.txt'), 'safe=true\n');

  const result = spawnSync(process.execPath, [CLI, 'env', 'audit', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.coverageComplete, false);
  assert.ok(output.skipped.some((entry) => entry.path === 'src/historical-opaque.txt'
    && entry.source === 'last-publication'
    && entry.reason === 'head-audit-invalid-utf8'));
});
