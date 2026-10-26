/**
 * Test command pins [TCE:REQ-010]: what a command resolves through, how a gate run is compared
 * with its pin, and how the pin is replayed. The whole-Story walk is test/test-command-pin-flow.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';
import {
  commandDefinition, gateTestCommandPins, packageScriptChain, pinCandidate, pinnedArgv, pinReplayProblem, pinSource, portableArgv, referencePin
} from '../src/test-command-pins.mjs';

async function repository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

const definitionKeys = (definition) => definition.entries.map((entry) => `${entry.path}#${entry.selector ?? ''}`);

test('a package script is pinned with its whole chain and the runner configuration beside it', async (t) => {
  const root = await repository(t, {
    'package.json': JSON.stringify({ scripts: { pretest: 'node build.mjs', test: 'npm run unit && run-s "lint:*"', unit: 'jest', 'lint:a': 'eslint .',
      'lint:b': 'prettier -c .', deploy: 'npm publish' }, jest: { testMatch: ['**/*.spec.js'] } }),
    'jest.config.cjs': 'module.exports = {};\n', 'README.md': '# not configuration\n'
  });
  const definition = await commandDefinition(root, { argv: ['npm', 'test', '--', '--json'], workingDirectory: '.' });
  assert.deepEqual(definitionKeys(definition), ['jest.config.cjs#', 'package.json#jest', 'package.json#scripts.lint:a',
    'package.json#scripts.lint:b', 'package.json#scripts.pretest', 'package.json#scripts.test', 'package.json#scripts.unit']);
  assert.deepEqual(packageScriptChain({ test: 'yarn unit', unit: 'pnpm run deep', deep: 'vitest' }, 'test').map((entry) => entry.name), ['test', 'unit', 'deep']);
  // Line endings are the checkout's, never a change to what runs.
  const crlf = await repository(t, { 'package.json': JSON.stringify({ scripts: { test: 'jest\r\n' } }) });
  const lf = await repository(t, { 'package.json': JSON.stringify({ scripts: { test: 'jest\n' } }) });
  assert.equal((await commandDefinition(crlf, { argv: ['npm', 'test'] })).entries[0].sha256, (await commandDefinition(lf, { argv: ['npm', 'test'] })).entries[0].sha256);
});

test('Maven, Gradle and pytest commands are pinned with their test configuration only', async (t) => {
  const root = await repository(t, {
    'pom.xml': '<project><properties><java.version>21</java.version><skipTests>false</skipTests></properties><build><plugins>'
      + '<plugin><artifactId>maven-compiler-plugin</artifactId></plugin><plugin><artifactId>maven-surefire-plugin</artifactId><configuration><includes>**/*Test.java</includes></configuration></plugin>'
      + '</plugins></build></project>',
    'api/pom.xml': '<project><dependencies/></project>',
    '.mvn/maven.config': '-Dtest=OnlyThis\n',
    'build.gradle': 'plugins { id "java" }\ndependencies { testImplementation "junit" }\ntest {\n  useJUnitPlatform { includeTags "fast" }\n}\n',
    'pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\naddopts = "-k fast"\n[tool.ruff]\nline-length = 100\n',
    'conftest.py': 'collect_ignore = ["slow"]\n'
  });
  const maven = await commandDefinition(root, { argv: ['./mvnw', '-pl', 'api', '-am', 'test'], workingDirectory: '.' });
  assert.deepEqual(definitionKeys(maven), ['.mvn/maven.config#', 'pom.xml#test-plugins']);
  // A dependency or version bump is not a change to which tests run.
  const bumped = await repository(t, { 'pom.xml': '<project><properties><java.version>22</java.version><skipTests>false</skipTests></properties><build><plugins>'
    + '<plugin><artifactId>maven-compiler-plugin</artifactId><version>3</version></plugin><plugin><artifactId>maven-surefire-plugin</artifactId><configuration><includes>**/*Test.java</includes></configuration></plugin>'
    + '</plugins></build></project>' });
  assert.equal((await commandDefinition(bumped, { argv: ['mvn', 'test'] })).entries[0].sha256, maven.entries.find((entry) => entry.path === 'pom.xml').sha256);
  assert.deepEqual(definitionKeys(await commandDefinition(root, { argv: ['.\\gradlew.bat', 'test'] })), ['build.gradle#test-tasks']);
  assert.deepEqual(definitionKeys(await commandDefinition(root, { argv: ['python3', '-m', 'pytest'] })), ['conftest.py#', 'pyproject.toml#tool.pytest']);
  assert.deepEqual(definitionKeys(await commandDefinition(root, { argv: ['bash', 'scripts/missing.sh'] })), [], 'a missing script has no entry');
});

test('one pin serves every platform: wrapper and launcher spellings read the same', () => {
  assert.deepEqual(portableArgv(['.\\mvnw.cmd', 'test']), ['./mvnw', 'test']);
  assert.deepEqual(portableArgv(['py', '-3', '-B', '-m', 'pytest']), ['python3', '-B', '-m', 'pytest']);
  assert.deepEqual(portableArgv(['.venv\\Scripts\\python.exe', '-m', 'pytest']), ['.venv/bin/python', '-m', 'pytest']);
});

test('a node --test pin names its runner and flags, never its test files: adding or editing a test is the Story\'s work', async (t) => {
  // spk-e2e (2026-10-26): the inferred `node --test <files>` grew a file, and the pin, which listed the
  // files and hashed the first one as a script, refused the Story until a person re-pinned it.
  const root = await repository(t, { 'tests/retry.test.mjs': "import test from 'node:test';\ntest('retry', () => {});\n" });
  const phase = { id: 'implement', status: 'in_progress' };
  const workflow = { workItem: { id: 'W-2' }, phases: { implement: phase }, phaseOrder: ['implement'] };
  const command = (files, extra = []) => ({ id: 'node-tests', kind: 'test', argv: ['node', '--test', ...extra, ...files], workingDirectory: '.',
    affectedRoots: ['.'], provenance: 'inferred', result: { adapter: 'node-tap' } });
  assert.deepEqual(pinnedArgv(['node', '--test', '--test-reporter', 'junit', 'tests/a.test.mjs', 'tests/b.test.mjs']),
    ['node', '--test', '--test-reporter', 'junit', '<test files>']);
  assert.deepEqual((await commandDefinition(root, command(['tests/retry.test.mjs']))).entries, [], 'a test file is not a script');
  const first = await gateTestCommandPins(root, {}, workflow, phase, [command(['tests/retry.test.mjs'])]);
  await first.record(workflow, ['node-tests'], { at: '2026-10-26T00:00:00.000Z' });
  assert.deepEqual(workflow.testCommandPins[0].argv, ['node', '--test', '<test files>']);
  // A new test file and an edited one: the same pin, and nothing to decide.
  await writeFile(path.join(root, 'tests/attempts.test.mjs'), "import test from 'node:test';\ntest('attempts', () => {});\n");
  await writeFile(path.join(root, 'tests/retry.test.mjs'), "import test from 'node:test';\ntest('retry twice', () => {});\n");
  const grown = await gateTestCommandPins(root, {}, workflow, phase, [command(['tests/attempts.test.mjs', 'tests/retry.test.mjs'])]);
  assert.equal(grown.prepared.get('node-tests').candidate.sha256, workflow.testCommandPins[0].sha256);
  // A pin recorded before this rule (its files listed, the first one hashed) reads the same way.
  const legacyIdentity = { commandId: 'node-tests', source: { kind: 'inferred' }, argv: ['node', '--test', 'tests/retry.test.mjs'], workingDirectory: '.',
    affectedRoots: ['.'], adapter: 'node-tap', definition: [{ path: 'tests/retry.test.mjs', selector: null, sha256: `sha256:${'1'.repeat(64)}` }] };
  workflow.testCommandPins = [{ id: 'TCP-001', phase: 'implement', ...legacyIdentity, sha256: `sha256:${recordSha256(legacyIdentity)}`, baseline: null, at: 'x' }];
  const upgraded = await gateTestCommandPins(root, {}, workflow, phase, [command(['tests/attempts.test.mjs', 'tests/retry.test.mjs'])]);
  await upgraded.record(workflow, ['node-tests'], { at: '2026-10-26T00:00:01.000Z' });
  assert.deepEqual([workflow.testCommandPins[1].replaces, workflow.testCommandPins[1].argv], ['TCP-001', ['node', '--test', '<test files>']]);
  // A changed runner flag is still a changed command, decided by a person.
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command(['tests/retry.test.mjs'], ['--test-only'])]), (error) => {
    assert.equal(error.code, 'TEST_COMMAND_PIN_CHANGED');
    assert.deepEqual(error.details.testCommandPin.changes, ['argv ["node","--test","<test files>"] → ["node","--test","--test-only","<test files>"]']);
    return true;
  });
});

test('a configured command records its definition, and an edited script behind it waits for an accepted re-pin [TCE:REQ-013]', async (t) => {
  const root = await repository(t, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const configured = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'node-tap', path: 'r.tap' } };
  const phase = { id: 'implement', status: 'in_progress', qualityCommands: [configured] };
  const workflow = { workItem: { id: 'W-1' }, phases: { implement: phase }, phaseOrder: ['implement'] };
  const command = { ...configured, provenance: 'configured' };
  assert.deepEqual(pinSource(phase, command), { kind: 'configured', recordSha256: `sha256:${recordSha256(configured)}` });
  const first = await gateTestCommandPins(root, {}, workflow, phase, [command]);
  await first.record(workflow, ['unit'], { at: '2026-10-25T00:00:00.000Z' });
  assert.equal(workflow.testCommandPins[0].id, 'TCP-001');
  assert.equal(workflow.testCommandPins[0].source.kind, 'configured');
  assert.ok(workflow.testCommandPins[0].definition.some((entry) => entry.selector === 'scripts.test'));

  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/one.test.mjs' } }));
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command]), (error) => {
    assert.equal(error.code, 'TEST_COMMAND_PIN_CHANGED');
    assert.deepEqual(error.details.testCommandPin.changes, ['package.json scripts.test changed']);
    assert.match(error.details.testCommandPin.command, /^singularity-flow decision test-command W-1 --phase implement --repin unit /u);
    return true;
  });
  // An accepted re-pin of exactly this pin lets it through; the next pin names both.
  const candidate = pinCandidate(phase, command, (await commandDefinition(root, command)).entries);
  workflow.testCommandDecisions = [
    { id: 'TCD-001', phase: 'implement', command: configured, repin: { commandId: 'unit', sha256: `sha256:${'0'.repeat(64)}`, pinned: null, pin: {}, changes: [] }, reason: 'another pin', requestedBy: 'dev', at: 'x' },
    { accepts: 'TCD-001', phase: 'implement', reason: '', actor: 'lead', authorityGroup: 'g', at: 'x' }
  ];
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command]), { code: 'TEST_COMMAND_PIN_CHANGED' }, 'a re-pin admits only its own digest');
  workflow.testCommandDecisions.push(
    { id: 'TCD-002', phase: 'implement', command: configured, repin: { commandId: 'unit', sha256: candidate.sha256, pinned: workflow.testCommandPins[0].sha256, pin: {}, changes: [] }, reason: 'narrowed on purpose', requestedBy: 'dev', at: 'x' },
    { accepts: 'TCD-002', phase: 'implement', reason: '', actor: 'lead', authorityGroup: 'g', at: 'x' });
  const repinned = await gateTestCommandPins(root, {}, workflow, phase, [command]);
  assert.equal(repinned.prepared.get('unit').acceptedBy, 'TCD-002');
  await repinned.record(workflow, ['unit'], { at: '2026-10-25T00:00:01.000Z' });
  assert.deepEqual([workflow.testCommandPins[1].replaces, workflow.testCommandPins[1].acceptedBy], ['TCP-001', 'TCD-002']);
  // Used once: changing it back again needs a new request.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command]), { code: 'TEST_COMMAND_PIN_CHANGED' });
});

test('before a pin is on the Story, the step\'s first recorded run of the command stands for it', () => {
  const phase = { id: 'implement' };
  const command = { id: '.-node-tests', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'node-tap' }, provenance: 'inferred' };
  const original = pinCandidate(phase, command, [{ path: 'package.json', selector: 'scripts.test', sha256: 'a'.repeat(64) }]);
  const narrowed = pinCandidate(phase, command, [{ path: 'package.json', selector: 'scripts.test', sha256: 'b'.repeat(64) }]);
  const attempts = [{ commandId: '.-node-tests', purpose: 'preflight', pin: original, status: 'failed' },
    { commandId: '.-node-tests', purpose: 'preflight', pin: narrowed, status: 'passed' }];
  assert.equal(referencePin({}, narrowed, attempts).sha256, original.sha256);
  assert.equal(referencePin({}, narrowed, [{ ...attempts[0], purpose: 'local' }]), null, 'a local run pins nothing');
});

test('an attempt replays only under a pin recorded on its Story, with its own digest [TCE:REQ-014]', () => {
  const pin = pinCandidate({ id: 'implement' }, { id: 'unit', argv: ['npm', 'test'], result: { adapter: 'node-tap' } }, []);
  const attempt = { commandId: 'unit', pin };
  assert.equal(pinReplayProblem({ testCommandPins: [{ id: 'TCP-001', ...pin }] }, attempt), null);
  assert.match(pinReplayProblem({ testCommandPins: [] }, attempt), /not recorded on the Story/u);
  assert.match(pinReplayProblem({ testCommandPins: [{ ...pin }] }, { commandId: 'unit', pin: { ...pin, argv: ['npm', 'run', 'one'] } }), /differs from its own digest/u);
  assert.match(pinReplayProblem(null, attempt), /cannot be verified without its Story/u);
  assert.equal(pinReplayProblem(null, { commandId: 'unit' }), null, 'an attempt recorded before pins replays as before');
});
