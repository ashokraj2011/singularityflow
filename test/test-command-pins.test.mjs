/**
 * Test command pins [TCE:REQ-010]: what a command resolves through, how a gate run is compared
 * with its pin, and how the pin is replayed. The whole-Story walk is test/test-command-pin-flow.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';
import {
  commandDefinition, DEFINITION_VERSION, gateTestCommandPins, packageScriptChain, pinCandidate, pinnedArgv, pinReplayProblem, pinSource, portableArgv,
  pendingTestCommandReviews, referencePin, removalRequest, repinRequest
} from '../src/test-command-pins.mjs';
import { resolveDeliveryQualityCommands, testCommandProvenance } from '../src/delivery-evidence.mjs';

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

test('restoring the pinned definition removes its re-pin from pending reviews without accepting or deleting it', async t => {
  const original = 'export default { test: { environment: "jsdom" } };\n';
  const changed = 'export default { test: { environment: "jsdom", environmentOptions: { jsdom: { url: "http://localhost" } } } };\n';
  const root = await repository(t, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'vite.config.js': original });
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'vitest-json', path: '.sflow/results/test.json' } };
  const phase = { id: 'custom-build', status: 'in_progress', qualityCommands: [command] };
  const workflow = { workItem: { id: 'PIN-1' }, phaseOrder: [phase.id], phases: { [phase.id]: phase } };
  const initial = await gateTestCommandPins(root, {}, workflow, phase, [command]);
  await initial.record(workflow, ['unit'], { at: 'original' });
  await writeFile(path.join(root, 'vite.config.js'), changed);
  const request = { id: 'TCD-001', phase: phase.id, command, repin: await repinRequest(root, {}, workflow, phase, command) };
  workflow.testCommandDecisions = [request];
  const before = JSON.stringify(workflow);
  const review = () => pendingTestCommandReviews(root, {}, workflow, phase, [request], { commands: [command] });
  assert.deepEqual((await review()).pending, [request], 'a genuine changed definition still requires its human decision');
  await writeFile(path.join(root, 'vite.config.js'), original);
  const restored = await review();
  assert.deepEqual(restored.pending, []);
  assert.equal(restored.inactive[0].request, 'TCD-001');
  assert.equal(restored.inactive[0].status, 'original-definition-restored');
  assert.equal(restored.bindings[0].current, restored.bindings[0].reference);
  assert.equal(JSON.stringify(workflow), before, 'the reader changes neither history nor authority');
  await gateTestCommandPins(root, {}, workflow, phase, [command]);
  await writeFile(path.join(root, 'vite.config.js'), changed);
  assert.deepEqual((await review()).pending, [request], 'restoring does not secretly accept the changed definition for later');
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command]), { code: 'TEST_COMMAND_PIN_CHANGED' });
  const duplicate = { ...request, id: 'TCD-002' };
  workflow.testCommandDecisions.push(duplicate);
  const duplicates = await pendingTestCommandReviews(root, {}, workflow, phase, [request, duplicate], { commands: [command] });
  assert.deepEqual(duplicates.pending.map(entry => entry.id), ['TCD-001']);
  assert.equal(duplicates.inactive[0].duplicateOf, 'TCD-001');
  workflow.testCommandDecisions.push({ accepts: 'TCD-001', phase: phase.id, actor: 'reviewer', authorityGroup: 'team' });
  const accepted = await pendingTestCommandReviews(root, {}, workflow, phase, [duplicate], { commands: [command] });
  assert.deepEqual(accepted.pending, []);
  assert.equal(accepted.inactive[0].acceptedBy, 'TCD-001', 'a duplicate needs no second human acceptance');
  assert.deepEqual((await pendingTestCommandReviews(root, {}, workflow, phase, [request], { commands: [] })).pending,
    [request], 'a missing command is not read as a restored pin');
});

test('an unreadable test definition keeps its review and diagnostic instead of hiding the request', async t => {
  const root = await repository(t, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'vitest-json', path: '.sflow/results/tests.json' } };
  const phase = { id: 'custom-build', status: 'in_progress' };
  const workflow = { workItem: { id: 'PIN-2' }, phaseOrder: [phase.id], phases: { [phase.id]: phase } };
  const request = { id: 'TCD-001', phase: phase.id, command, repin: { commandId: 'unit', sha256: 'unreadable' } };
  await unlink(path.join(root, 'package.json'));
  await mkdir(path.join(root, 'package.json'));
  const review = await pendingTestCommandReviews(root, {}, workflow, phase, [request], { commands: [command] });
  assert.deepEqual(review.pending, [request]);
  assert.deepEqual(review.inactive, []);
  assert.equal(review.unavailable.length, 1);
  assert.ok(review.unavailable[0].reason);
});

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
  // A script the command names that is not there is pinned as missing, so creating it later changes the pin.
  assert.deepEqual(definitionKeys(await commandDefinition(root, { argv: ['bash', 'scripts/missing.sh'] })), ['scripts/missing.sh#']);
  assert.deepEqual(definitionKeys(await commandDefinition(root, { argv: ['bash', 'scripts/missing.sh'] }, { version: 1 })), [], 'the first rules left it out');
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

const pinChangeList = (error) => error.details.testCommandPin.changes;
const refusal = (expected) => (error) => {
  assert.equal(error.code, 'TEST_COMMAND_PIN_CHANGED', error.message);
  for (const words of expected) assert.ok(pinChangeList(error).includes(words), `${words} in ${JSON.stringify(pinChangeList(error))}`);
  return true;
};
const accepted = (workflow, id, repin, command) => {
  workflow.testCommandDecisions ??= [];
  workflow.testCommandDecisions.push({ id, phase: 'implement', command, repin, reason: 'decided by a person', requestedBy: 'dev', at: 'x' },
    { accepts: id, phase: 'implement', reason: '', actor: 'lead', authorityGroup: 'g', at: 'x' });
};

test('a pin reads the configuration a script names, the workspace it selects and a named file that is missing (review, 2026-11-01)', async (t) => {
  const root = await repository(t, {
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'], scripts: {
      test: 'jest --config config/jest.config.cjs', 'test:missing': 'jest -c config/absent.cjs' } }),
    'config/jest.config.cjs': "module.exports = { testMatch: ['**/regression.test.js'] };\n",
    'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'npx --no-install vitest run -c vite.unit.mjs' } }),
    'packages/a/vite.unit.mjs': 'export default {};\n'
  });
  const phase = { id: 'implement', status: 'in_progress' };
  const workflow = { workItem: { id: 'W-3' }, phases: { implement: phase }, phaseOrder: ['implement'] };
  const inferred = (id, argv) => ({ id, kind: 'test', argv, workingDirectory: '.', affectedRoots: ['.'], provenance: 'inferred', result: { adapter: 'jest-json' } });
  const root_ = inferred('.-node-tests', ['npm', 'test']);
  assert.deepEqual(definitionKeys(await commandDefinition(root, root_)), ['config/jest.config.cjs#', 'package.json#scripts.test']);
  assert.deepEqual(definitionKeys(await commandDefinition(root, root_, { version: 1 })), ['package.json#scripts.test'], 'the first rules missed it');
  const first = await gateTestCommandPins(root, {}, workflow, phase, [root_]);
  await first.record(workflow, [root_.id], { at: '2026-11-01T00:00:00.000Z' });
  assert.equal(workflow.testCommandPins[0].definitionVersion, DEFINITION_VERSION);
  // The finding: a regression suite swapped for a smoke test through the named configuration, same count, same pin.
  await writeFile(path.join(root, 'config/jest.config.cjs'), "module.exports = { testMatch: ['**/smoke.test.js'] };\n");
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [root_]), refusal(['config/jest.config.cjs changed']));

  // A workspace by name or path pins that workspace's script chain and the configuration its runner names.
  for (const argv of [['npm', '--workspace', 'a', 'test'], ['npm', 'test', '-w', 'packages/a'], ['pnpm', '--filter', '{packages/a}', 'test'], ['yarn', 'workspace', 'a', 'test']]) {
    assert.deepEqual(definitionKeys(await commandDefinition(root, inferred('a', argv))), ['packages/a/package.json#scripts.test', 'packages/a/vite.unit.mjs#'], argv.join(' '));
  }
  const workspace = inferred('a-tests', ['npm', '--workspace', 'a', 'test']);
  const pinned = await gateTestCommandPins(root, {}, workflow, phase, [workspace]);
  await pinned.record(workflow, [workspace.id], { at: '2026-11-01T00:00:01.000Z' });
  await writeFile(path.join(root, 'packages/a/package.json'), JSON.stringify({ name: 'a', scripts: { test: 'npx --no-install vitest run -c vite.unit.mjs src/one' } }));
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [workspace]), refusal(['packages/a/package.json scripts.test changed']));
  // A selector that matches nothing runs nothing, and says so in the pin rather than pinning nothing.
  assert.deepEqual(definitionKeys(await commandDefinition(root, inferred('none', ['npm', '-w', 'nope', 'test']))), ['package.json#workspace:nope']);

  // A configuration the script names that is not there is pinned as missing; creating it is a change a person decides.
  const absent = inferred('absent', ['npm', 'run', 'test:missing']);
  const missing = await gateTestCommandPins(root, {}, workflow, phase, [absent]);
  await missing.record(workflow, [absent.id], { at: '2026-11-01T00:00:02.000Z' });
  await writeFile(path.join(root, 'config/absent.cjs'), 'module.exports = {};\n');
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [absent]), refusal(['config/absent.cjs created']));
});

test('a pin recorded under the first rules keeps them, and a person\'s re-pin moves it to the current rules', async (t) => {
  const root = await repository(t, {
    'package.json': JSON.stringify({ scripts: { test: 'jest --config config/jest.config.cjs' } }),
    'config/jest.config.cjs': 'module.exports = {};\n'
  });
  const phase = { id: 'implement', status: 'in_progress' };
  const workflow = { workItem: { id: 'W-4' }, phases: { implement: phase }, phaseOrder: ['implement'] };
  const command = { id: '.-node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], provenance: 'inferred', result: { adapter: 'jest-json' } };
  // A Story started before this change: its pin has no definitionVersion and read only the script.
  const legacy = pinCandidate(phase, command, (await commandDefinition(root, command, { version: 1 })).entries, { version: 1 });
  assert.equal(legacy.definitionVersion, undefined);
  workflow.testCommandPins = [{ id: 'TCP-001', phase: 'implement', ...legacy, baseline: null, at: '2026-10-31T00:00:00.000Z' }];
  const unchanged = await gateTestCommandPins(root, {}, workflow, phase, [command]);
  assert.equal(unchanged.prepared.get(command.id).candidate.sha256, legacy.sha256, 'the running Story is compared as before, not refused for the new rules');
  assert.equal(unchanged.attempt(command.id).pin.sha256, legacy.sha256, 'its attempts replay against the pin on the Story');
  await unchanged.record(workflow, [command.id], { at: '2026-11-01T00:00:00.000Z' });
  assert.equal(workflow.testCommandPins.length, 1, 'nothing new to record');
  // What the first rules pinned still waits for a person.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config config/jest.config.cjs src/one' } }));
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command]), refusal(['package.json scripts.test changed']));
  // The request names that change; the pin a person accepts is the current rules' one.
  const request = await repinRequest(root, {}, workflow, phase, command);
  assert.deepEqual(request.changes, ['package.json scripts.test changed']);
  assert.equal(request.pin.definitionVersion, DEFINITION_VERSION);
  accepted(workflow, 'TCD-001', request, { id: command.id, kind: 'test' });
  const repinned = await gateTestCommandPins(root, {}, workflow, phase, [command]);
  await repinned.record(workflow, [command.id], { at: '2026-11-01T00:00:01.000Z' });
  assert.deepEqual([workflow.testCommandPins[1].replaces, workflow.testCommandPins[1].acceptedBy, workflow.testCommandPins[1].definitionVersion], ['TCP-001', 'TCD-001', 2]);
  // From then on the named configuration is pinned too.
  await writeFile(path.join(root, 'config/jest.config.cjs'), "module.exports = { testMatch: ['**/smoke.test.js'] };\n");
  await assert.rejects(gateTestCommandPins(root, {}, workflow, phase, [command]), refusal(['config/jest.config.cjs changed']));
});

test('a suite the Story pinned that its module no longer declares is refused until a person accepts it; an untouched module is not a removal', async (t) => {
  const manifest = (scripts) => JSON.stringify({ name: 'two', type: 'module', scripts, devDependencies: { jest: '29' } });
  const root = await repository(t, {
    'package.json': manifest({ test: 'jest', 'test:node': 'node --test' }),
    'src/value.js': 'export const value = 1;\n',
    'tools/package.json': JSON.stringify({ name: 'tools', type: 'module', scripts: { test: 'node --test' } }),
    'tools/run.js': 'export const run = 1;\n'
  });
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const phase = { id: 'implement', status: 'in_progress', generation: { task: 'code' }, qualityCommands: [] };
  const workflow = { workItem: { id: 'W-5' }, phases: { implement: phase }, phaseOrder: ['implement'] };
  const delivery = (paths) => ({ sourcePaths: paths, changeSet: { base: { commit: base } } });
  const gate = async (paths) => {
    const evidence = delivery(paths);
    const commands = (await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence: evidence }))
      .map((command) => ({ ...command, provenance: testCommandProvenance(phase, command) }));
    return gateTestCommandPins(root, {}, workflow, phase, commands, evidence).then((pins) => ({ pins, ids: commands.map((command) => command.id) }));
  };
  const first = await gate(['src/value.js']);
  assert.deepEqual(first.ids, ['.-node-tests', 'node-test-tests']);
  await first.pins.record(workflow, first.ids, { at: '2026-11-01T00:00:00.000Z' });
  // test:node deleted: Jest's pin is unchanged, and the node:test suite would stop counting unseen.
  await writeFile(path.join(root, 'package.json'), manifest({ test: 'jest' }));
  await assert.rejects(gate(['src/value.js']), (error) => {
    refusal(['removed: . no longer declares it, so its tests would stop counting unseen'])(error);
    assert.equal(error.details.testCommandPin.commandId, 'node-test-tests');
    assert.equal(error.details.testCommandPin.removed, true);
    assert.equal(error.details.testCommandPin.command, 'singularity-flow decision test-command W-5 --phase implement --repin node-test-tests --reason "<why the test command changed>"');
    return true;
  });
  // A change only in tools/ does not touch the root module: its suites are not selected, which is not a removal.
  assert.deepEqual((await gate(['tools/run.js'])).ids, ['tools-node-tests']);
  // A person accepts that it no longer runs: the request names the pin by digest.
  const removal = await removalRequest(root, {}, workflow, phase, 'node-test-tests');
  assert.deepEqual([removal.repin.removed, removal.repin.pinned], [true, workflow.testCommandPins.find((pin) => pin.commandId === 'node-test-tests').sha256]);
  accepted(workflow, 'TCD-001', removal.repin, removal.command);
  assert.deepEqual((await gate(['src/value.js'])).ids, ['.-node-tests']);
});

test('a suite the Story added and then removed is back to the base commit\'s suites, and a first-rules pin is never read as removed', async (t) => {
  const manifest = (scripts) => JSON.stringify({ name: 'two', type: 'module', scripts, devDependencies: { jest: '29' } });
  const root = await repository(t, { 'package.json': manifest({ test: 'jest' }), 'src/value.js': 'export const value = 1;\n' });
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('add', '.'); git('commit', '-q', '-m', 'base without test:node');
  const evidence = { sourcePaths: ['src/value.js'], changeSet: { base: { commit: git('rev-parse', 'HEAD') } } };
  const phase = { id: 'implement', status: 'in_progress', generation: { task: 'code' }, qualityCommands: [] };
  const commands = async () => (await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence: evidence }))
    .map((command) => ({ ...command, provenance: testCommandProvenance(phase, command) }));
  // The Story adds test:node, its gate pins it, and the Story then takes it out again: the base never had it.
  const added = { workItem: { id: 'W-6' }, phases: { implement: phase }, phaseOrder: ['implement'] };
  await writeFile(path.join(root, 'package.json'), manifest({ test: 'jest', 'test:node': 'node --test' }));
  const both = await commands();
  const pinned = await gateTestCommandPins(root, {}, added, phase, both, evidence);
  await pinned.record(added, both.map((command) => command.id), { at: '2026-11-01T00:00:00.000Z' });
  await writeFile(path.join(root, 'package.json'), manifest({ test: 'jest' }));
  const restored = await gateTestCommandPins(root, {}, added, phase, await commands(), evidence);
  assert.deepEqual([...restored.prepared.keys()], ['.-node-tests']);

  // Now the base has test:node. A Story whose pin of it was recorded under the first rules (no
  // definitionVersion) keeps those rules, which never checked for removal: deleting it is not refused.
  await writeFile(path.join(root, 'package.json'), manifest({ test: 'jest', 'test:node': 'node --test' }));
  git('add', '.'); git('commit', '-q', '-m', 'base with test:node');
  evidence.changeSet.base.commit = git('rev-parse', 'HEAD');
  const nodeCommand = (await commands()).find((command) => command.id === 'node-test-tests');
  const legacy = pinCandidate(phase, nodeCommand, (await commandDefinition(root, nodeCommand, { version: 1 })).entries, { version: 1 });
  const running = { workItem: { id: 'W-7' }, phases: { implement: phase }, phaseOrder: ['implement'],
    testCommandPins: [{ ...added.testCommandPins[0], id: 'TCP-001' }, { id: 'TCP-002', phase: 'implement', ...legacy, baseline: null, at: '2026-10-31T00:00:00.000Z' }] };
  await writeFile(path.join(root, 'package.json'), manifest({ test: 'jest' }));
  assert.deepEqual([...(await gateTestCommandPins(root, {}, running, phase, await commands(), evidence)).prepared.keys()], ['.-node-tests']);
  // The same deletion under a current-rules pin is refused: the base had the suite.
  const current = { ...running, testCommandPins: [{ ...added.testCommandPins[0], id: 'TCP-001' }, { ...added.testCommandPins[1], id: 'TCP-002' }] };
  await assert.rejects(gateTestCommandPins(root, {}, current, phase, await commands(), evidence), (error) => error.details?.testCommandPin?.removed === true);
});
