/**
 * Test commands a team wrote down are read at setup, completed and proposed [TCE:REQ-060..063], and a
 * test command's literal `env` [TCE model table].
 *
 * Fixture repositories through the real CLI: AGENTS.md, copilot-instructions, a GitHub workflow and a
 * Makefile, each command completed with its file and line; a secret-looking variable is named and its
 * value never read; and a proposal a person confirms and an approver activates publishes on a Story,
 * its tests running with the variable it declares.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { buildTestExecutionReceipt } from '../src/code-delivery-tests.mjs';
import { normalizeExternalCommand, withCommandLiteralEnvironment } from '../src/external-command-policy.mjs';
import { inferModuleTestCommand } from '../src/code-delivery-tests.mjs';
import { completeWrittenTestCommand, DIRECT_RUNNER_REPORTERS, parseCommandLine } from '../src/instruction-test-commands.mjs';
import { canonicalJson } from '../src/records.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function files(root, entries) {
  for (const [relative, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
}

function harness(base, root, identity = 'Instruction Tester') {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: identity,
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full', HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: identity,
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'instruction.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  delete env.BASE_URL;
  const run = (command, args, { cwd = root, allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(300_000) });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (...args) => run(process.execPath, [cli, '--no-model', ...args]).stdout;
  const json = (...args) => JSON.parse(sflow(...args, '--json'));
  return { env, run, sflow, json };
}

test('a test command\'s env is literal, refuses reserved and secret names, merges once and is part of its digest', () => {
  const command = { id: 'e2e', kind: 'test', argv: ['npx', 'playwright', 'test'], workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'playwright-json', path: '.sflow/results/playwright-tests.json' } };
  assert.deepEqual(normalizeExternalCommand({ ...command, env: { CI: true, BASE_URL: 'http://localhost:3000' } }).env,
    { BASE_URL: 'http://localhost:3000', CI: 'true' }, 'in name order, as text');
  assert.equal(Object.hasOwn(normalizeExternalCommand({ ...command, env: {} }), 'env'), false, 'no variables, no key');
  for (const [env, code] of [[{ NODE_ENV: 'test' }, 'QUALITY_COMMAND_ENV_INVALID'], [{ PATH: '/bin' }, 'QUALITY_COMMAND_ENV_INVALID'],
    [{ base_url: 'x' }, 'QUALITY_COMMAND_ENV_INVALID'], [{ X: 'a\nb' }, 'QUALITY_COMMAND_ENV_INVALID'], [['BASE_URL'], 'QUALITY_COMMAND_ENV_INVALID'],
    [{ API_TOKEN: 'abc123' }, 'QUALITY_COMMAND_ENV_SECRET']]) {
    assert.throws(() => normalizeExternalCommand({ ...command, env }), (error) => error.code === code && !error.message.includes('abc123'), JSON.stringify(env));
  }
  // The compatibility rule `env` follows: a key the validator does not know is ignored, never refused.
  const future = normalizeExternalCommand({ ...command, aKeyFromANewerEngine: { x: 1 } });
  assert.equal(Object.hasOwn(future, 'aKeyFromANewerEngine'), false);

  const merged = withCommandLiteralEnvironment({ base_url: 'from-the-caller', HOME: '/h' }, { env: { BASE_URL: 'http://localhost:3000' } });
  assert.deepEqual(merged, { HOME: '/h', BASE_URL: 'http://localhost:3000' }, 'a name is replaced whatever its case');
  const unchanged = { HOME: '/h' };
  assert.equal(withCommandLiteralEnvironment(unchanged, command), unchanged);

  const digest = (value) => buildTestExecutionReceipt(value, null, null, { attemptId: 'a', nonce: 'n' }).commandSha256;
  const core = { argv: command.argv, workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'playwright-json', path: '.sflow/results/playwright-tests.json' } };
  assert.equal(digest(command), `sha256:${createHash('sha256').update(canonicalJson(core)).digest('hex')}`, 'a command without env keeps its digest');
  const withUrl = digest({ ...command, env: { BASE_URL: 'http://localhost:3000' } });
  assert.notEqual(withUrl, digest(command));
  assert.notEqual(withUrl, digest({ ...command, env: { BASE_URL: 'http://localhost:4000' } }), 'a changed value is a changed command');
});

test('a written shell line becomes argv, variables and a folder; composed lines say why', async (t) => {
  const parsed = parseCommandLine("cd web && CI=true BASE='a b' npm run test:unit -- --grep \"x y\"");
  assert.deepEqual(parsed.commands.map((entry) => [entry.argv, entry.directory, Object.keys(entry.env)]),
    [[['npm', 'run', 'test:unit', '--', '--grep', 'x y'], 'web', ['CI', 'BASE']]]);
  assert.match(parseCommandLine('npm test | tee out.log').reason, /composed with `\|`/u);
  assert.match(parseCommandLine('cd ../outside && npm test').reason, /inside the repository/u);
  assert.deepEqual(parseCommandLine('npx jest $FILES').commands[0].dynamic, ['$FILES']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-complete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await files(root, { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
  assert.match((await completeWrittenTestCommand(root, { text: 'npx jest $FILES' })).reason, /which the shell expands/u);
  assert.equal(await completeWrittenTestCommand(root, { text: 'npm install' }), null, 'not a test run');
  assert.equal(await completeWrittenTestCommand(root, { text: 'npx playwright install --with-deps' }), null, 'not a test run');
  assert.match((await completeWrittenTestCommand(root, { text: 'npx cypress run' })).reason, /does not complete cypress/u);
  // An argv a team import read keeps its leading variables as variables.
  const imported = await completeWrittenTestCommand(root, { argv: ['CI=true', 'npm', 'test'] });
  assert.deepEqual([imported.command.argv, imported.command.env, imported.command.result.adapter],
    [['npm', 'test', '--', '--json', '--outputFile', '.sflow/results/node-tests.json'], { CI: 'true' }, 'jest-json']);
});

test('a written Maven command for a whole reactor asks for one per module: no one report path reads all of them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-reactor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await files(root, { 'pom.xml': '<project><modules><module>api</module></modules></project>\n', 'api/pom.xml': '<project/>\n' });
  assert.match((await completeWrittenTestCommand(root, { text: 'mvn test' })).reason, /pom\.xml is a reactor.*one command per module folder/u);
  assert.deepEqual((await completeWrittenTestCommand(root, { text: 'mvn -pl api -am test' })).command.result.path, 'api/target/surefire-reports');
  assert.deepEqual((await completeWrittenTestCommand(root, { text: 'cd api && mvn test' })).command.result.path, 'target/surefire-reports');
});

test('a runner called directly reports exactly as inference makes it report', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-reporters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tail = async (directory, manifests, module) => {
    await files(root, Object.fromEntries(Object.entries(manifests).map(([name, text]) => [`${directory}/${name}`, text])));
    return (await inferModuleTestCommand(root, { root: directory, system: module, manifest: Object.keys(manifests)[0] })).argv;
  };
  const endsWith = (argv, suffix) => assert.deepEqual(argv.slice(-suffix.length), suffix, JSON.stringify(argv));
  const report = '.sflow/results/node-tests.json';
  endsWith(await tail('jest', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }, 'node'), DIRECT_RUNNER_REPORTERS.jest.arguments(report));
  endsWith(await tail('vitest', { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, 'node'), DIRECT_RUNNER_REPORTERS.vitest.arguments(report));
  endsWith(await tail('playwright', { 'package.json': JSON.stringify({ scripts: { test: 'playwright test' }, devDependencies: { '@playwright/test': '1.48.0' } }) }, 'node'),
    DIRECT_RUNNER_REPORTERS.playwright.arguments());
  endsWith(await tail('python', { 'pyproject.toml': '[project]\nname = "x"\n' }, 'python'), DIRECT_RUNNER_REPORTERS.pytest.arguments('.sflow/results/python-tests.xml'));
  endsWith(await tail('go', { 'go.mod': 'module x\n' }, 'go'), [...DIRECT_RUNNER_REPORTERS.go.arguments(), './...']);
  // A test project: a product project is tested through the test projects that reference it [TCE:REQ-072].
  endsWith(await tail('dotnet', { 'App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.0" /></ItemGroup></Project>' }, 'dotnet'),
    DIRECT_RUNNER_REPORTERS.dotnet.arguments('TestResults'));
});

test('a written node --test, uv run, py.test, gradlew or nx line reaches the completer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-forms-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await files(root, {
    'AGENTS.md': ['# Agents', '', '```sh', 'FEATURE_FLAG=on node --test test/', 'uv run pytest -q', 'py.test tests', 'gradlew test', 'nx test api', '```', ''].join('\n'),
    'package.json': JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }),
    'test/value.test.mjs': "import test from 'node:test';\ntest('value', () => {});\n"
  });
  const { readInstructionTestCommands } = await import('../src/instruction-test-commands.mjs');
  const written = (await readInstructionTestCommands(root, { sourceRoots: ['.'] })).candidates.filter((entry) => entry.source.file === 'AGENTS.md');
  assert.deepEqual(written.map((entry) => entry.source.line), [4, 5, 6, 7, 8], 'each line is a candidate, completed or with its reason');
  assert.deepEqual([written[0].status, written[0].command.argv, written[0].command.env], ['complete', ['node', '--test', 'test/'], { FEATURE_FLAG: 'on' }]);
  assert.match(written[3].reason, /build\.gradle/);
  assert.match(written[4].reason, /Nx project 'api'/);
});

test('test commands in AGENTS.md, copilot-instructions, a CI workflow and a Makefile are completed with their file and line [TCE:REQ-061 REQ-062]', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-commands-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const { run, sflow, json } = harness(base, root);
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await files(root, {
    'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'jest' }, devDependencies: { '@playwright/test': '1.48.0', jest: '29.7.0' } }),
    'pom.xml': '<project><modules><module>api</module></modules></project>\n',
    'api/pom.xml': '<project/>\n',
    'web/package.json': JSON.stringify({ name: 'web', private: true, scripts: { 'test:unit': 'vitest run' }, devDependencies: { vitest: '2.1.0' } }),
    'svc/pyproject.toml': '[project]\nname = "svc"\n',
    'AGENTS.md': ['# Working here', '', 'Run `BASE_URL=http://localhost:3000 npx playwright test --project=chromium` before you push.', '',
      'The unit tests need the service token:', '', '```sh', 'API_TOKEN=abc123 npm test', '```', ''].join('\n'),
    '.github/copilot-instructions.md': ['# Copilot', '', 'Run the web unit tests:', '', '```bash', 'cd web && CI=true npm run test:unit', '```', ''].join('\n'),
    '.github/workflows/ci.yml': ['name: ci', 'on: push', 'jobs:', '  api:', '    runs-on: ubuntu-latest', '    steps:',
      '      - uses: actions/checkout@v4', '      - run: mvn -pl api test', ''].join('\n'),
    Makefile: ['build:', '\tgo build ./...', '', 'test:', '\tcd svc && python -m pytest tests', ''].join('\n')
  });
  const result = run(process.execPath, [cli, '--no-model', 'capability', 'test-setup', '--json']);
  assert.doesNotMatch(result.stdout, /abc123/u, 'a secret-looking value is never read into the result');
  const inspected = JSON.parse(result.stdout);
  const from = (file) => inspected.instructionCandidates.filter((entry) => entry.source.file === file);
  const [playwright, secret] = from('AGENTS.md');
  assert.deepEqual(playwright.source, { kind: 'agents-md', file: 'AGENTS.md', line: 3 });
  assert.deepEqual(playwright.command, {
    id: 'npx-playwright-test-project-chromium', kind: 'test', argv: ['npx', 'playwright', 'test', '--project=chromium', '--reporter=json'],
    env: { BASE_URL: 'http://localhost:3000' }, workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'playwright-json', path: '.sflow/results/playwright-tests.json', minimumDiscovered: 1 }
  });
  assert.deepEqual([secret.source.line, secret.written, secret.secrets, secret.command.env], [8, 'API_TOKEN=*** npm test', ['API_TOKEN'], undefined]);
  assert.match(secret.notes.join(' '), /API_TOKEN looks like a secret, so the value was not read: declare it as a secret in singularity\/environments\.yml/u);
  const [web] = from('.github/copilot-instructions.md');
  assert.deepEqual([web.source.line, web.written, web.command.argv, web.command.env, web.command.workingDirectory, web.command.affectedRoots, web.command.result.adapter],
    // A named script reports under its own name, so two scripts run in one step never share a file.
    [6, 'cd web && CI=true npm run test:unit', ['npm', 'run', 'test:unit', '--', '--reporter=json', '--outputFile=.sflow/results/test-unit-tests.json'],
      { CI: 'true' }, 'web', ['web'], 'vitest-json']);
  const [maven] = from('.github/workflows/ci.yml');
  assert.deepEqual([maven.source.line, maven.command.argv, maven.command.workingDirectory, maven.command.affectedRoots, maven.command.result],
    [8, ['mvn', '-pl', 'api', 'test'], '.', ['api'], { adapter: 'junit-xml', path: 'api/target/surefire-reports', minimumDiscovered: 1 }]);
  const [python] = from('Makefile');
  assert.deepEqual([python.source.line, python.command.argv, python.command.workingDirectory, python.command.affectedRoots, python.command.result.adapter],
    [5, ['python', '-m', 'pytest', 'tests', '--junitxml=.sflow/results/pytest-tests.xml'], 'svc', ['svc'], 'junit-xml']);
  assert.deepEqual(from('Makefile').map((entry) => entry.written), ['cd svc && python -m pytest tests'], 'the build target is not a test target');
  assert.equal(inspected.testsExecuted, false);
  // The terminal lists them by file and line.
  const text = sflow('capability', 'test-setup');
  assert.match(text, /npx-playwright-test-project-chromium \(AGENTS\.md:3\): \["npx","playwright","test","--project=chromium","--reporter=json"\] · cwd=\. · playwright-json · env BASE_URL/u);
  assert.match(text, /npm-test \(AGENTS\.md:8\): .* · secret API_TOKEN for environments\.yml/u);
  assert.doesNotMatch(text, /abc123/u);

  // --use proposes a candidate: the preview spells it out with its variables and where it was read.
  run('git', ['add', '-A']); run('git', ['commit', '-q', '-m', 'fixture']);
  sflow('init');
  const preview = json('capability', 'test-setup', '--step', 'implementation', '--use', 'npx-playwright-test-project-chromium');
  assert.deepEqual([preview.data.problems, preview.data.command.env, preview.data.source], [[], { BASE_URL: 'http://localhost:3000' },
    { kind: 'instruction', file: 'AGENTS.md', line: 3 }]);
  assert.match(preview.data.diff, /\+ {6}# Read from AGENTS\.md:3 by capability test-setup\.\n\+ {6}- id: npx-playwright-test-project-chromium[\s\S]*\+ {10}BASE_URL: http:\/\/localhost:3000/u);
  assert.match(preview.data.confirmCommand, /^singularity-flow capability test-setup --step implementation --use npx-playwright-test-project-chromium --confirm sha256:[0-9a-f]{64}$/u,
    'confirmed by --use: its digest binds the command and the line it was read from');
  // Given in full, the variables are spelled out.
  const full = json('capability', 'test-setup', '--step', 'implementation', '--id', 'e2e', '--argv', '["npx","playwright","test","--reporter=json"]',
    '--working-directory', '.', '--affected-root', '.', '--adapter', 'playwright-json', '--report', '.sflow/results/playwright-tests.json', '--env', 'BASE_URL=http://localhost:3000');
  assert.deepEqual([full.data.command.env, full.data.problems], [{ BASE_URL: 'http://localhost:3000' }, []]);
  assert.match(full.data.confirmCommand, / --env BASE_URL=http:\/\/localhost:3000 --confirm sha256:/u);
  // A secret-looking value given in full is refused, and never repeated.
  const refused = run(process.execPath, [cli, '--no-model', 'capability', 'test-setup', '--step', 'implementation', '--id', 'x', '--argv', '["npm","test"]',
    '--working-directory', '.', '--affected-root', '.', '--adapter', 'jest-json', '--report', 'r.json', '--env', 'SERVICE=ghp_abcdefghijklmnopqrstuvwxyz0123456789', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, 'QUALITY_COMMAND_ENV_SECRET');
  assert.doesNotMatch(refused.stdout, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/u);
});

test('a test command proposed from AGENTS.md is activated and publishes on a Story, run with its env [TCE:REQ-063]', slowLane({ timeout: 600_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-instruction-publish-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  const { run, sflow, json } = harness(base, root);
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await files(root, {
    'package.json': JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }),
    '.gitignore': '.sflow/results/\n',
    'AGENTS.md': ['# Working here', '', 'The tests read the app at BASE_URL:', '', '```sh', 'BASE_URL=http://localhost:3000 npm test', '```', ''].join('\n'),
    'src/value.mjs': 'export const value = 1;\n',
    'test/value.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n"
      + "test('value', () => assert.equal(value, 1));\n"
  });
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '-A']); run('git', ['commit', '-q', '-m', 'fixture']);
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], { cwd: base });
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-q', '-u', 'origin', 'main']);
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config']);

  const inspected = json('capability', 'test-setup');
  const written = inspected.instructionCandidates.find((entry) => entry.source.file === 'AGENTS.md');
  assert.deepEqual([written.id, written.command.argv, written.command.env, written.command.result.adapter],
    ['npm-test', ['npm', 'test'], { BASE_URL: 'http://localhost:3000' }, 'node-tap']);
  const preview = json('capability', 'test-setup', '--step', 'implement', '--use', 'npm-test');
  assert.deepEqual(preview.data.problems, []);
  const shell = (line) => JSON.parse(run('sh', ['-c', `${line.replace(/^singularity-flow /u, `'${process.execPath}' '${cli}' --no-model `)} --json`]).stdout);
  const proposed = shell(preview.data.confirmCommand);
  const branch = proposed.data.branch ?? proposed.data.proposal?.branch;
  const proposedText = run('git', ['--git-dir', remote, 'show', `${branch}:singularity/workflow.yml`]).stdout;
  assert.match(proposedText, /# Read from AGENTS\.md:6 by capability test-setup\./u);
  sflow('workflow', 'activate', branch, '--confirm', run('git', ['--git-dir', remote, 'rev-parse', branch]).stdout.trim(), '--acknowledge-unprotected');
  const approved = YAML.parse(run('git', ['--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml']).stdout);
  assert.deepEqual(approved.phases.implement.qualityCommands.at(-1).env, { BASE_URL: 'http://localhost:3000' });

  // A Story started now pins it; its tests pass only when they run with BASE_URL.
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\n"
    + "test('value', () => { assert.equal(process.env.BASE_URL, 'http://localhost:3000'); assert.equal(value, 2); });\n");
  sflow('prepare', 'implement');
  const checked = json('phase', 'prepublish', 'implement');
  // The approved command alone covers the change; its arguments stay withheld, as for any configured command.
  assert.deepEqual(checked.testExecution.commands.map((entry) => [entry.argvSource, entry.affectedRoots, entry.result.adapter]),
    [['approved-configuration', ['.'], 'node-tap']], JSON.stringify(checked.testExecution));
  sflow('phase', 'publish', 'implement');
  sflow('submit', 'implement');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  const executions = workflow.phases.implement.deliveryEvidence.testExecutions;
  assert.ok(executions.some((entry) => entry.commandId === 'npm-test' && entry.status === 'passed'), JSON.stringify(executions));
});
