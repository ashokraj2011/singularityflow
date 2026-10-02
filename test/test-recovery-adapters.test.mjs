import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTrpCaseInventory, matchTrpReports, snapshotTrpDeclaredRuntime,
  trpExecutionEnvironment, trpNativeReportCapture, verifyTrpCaseInventorySources } from '../src/test-recovery-adapters.mjs';
import { parseTestResult, parseTrpJunitReport } from '../src/code-delivery-tests.mjs';
import { runQualityCommand, verifyCompletedQualityLaunch } from '../src/quality-command-runner.mjs';
import { captureTrpIntakeBaseline, inspectTrpIntakeBaseline } from '../src/test-recovery-runtime.mjs';
import { withOperationContext } from '../src/operation-context.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const configuration = prefix => process.env[`${prefix}_EXECUTABLE`] && process.env[`${prefix}_ROOTS`]
  ? { executable: process.env[`${prefix}_EXECUTABLE`], roots: JSON.parse(process.env[`${prefix}_ROOTS`]) } : null;
const python = configuration('SF_TRP_PYTEST');
const maven = configuration('SF_TRP_MAVEN');

async function fixture(t, adapter, runtime) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-real-adapter-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pythonAdapter = adapter === 'pytest-junit-v1';
  const file = pythonAdapter ? 'test_example.py' : 'src/test/java/ExampleTest.java';
  const className = pythonAdapter ? 'test_example' : 'ExampleTest';
  const names = pythonAdapter ? ['test_pass', 'test_fail'] : ['testPass', 'testFail'];
  if (pythonAdapter) {
    await writeFile(path.join(root, file), 'def test_pass():\n    assert 2 + 2 == 4\n\ndef test_fail():\n    assert 2 + 2 == 5\n');
    await writeFile(path.join(root, 'pytest.ini'), '[pytest]\n');
    // If inherited configuration were honored this hook would make the real run impossible.
    await writeFile(path.join(root, 'conftest.py'), 'raise RuntimeError("unapproved conftest must never load")\n');
  } else {
    await mkdir(path.join(root, 'src/test/java'), { recursive: true });
    await writeFile(path.join(root, file), 'import org.junit.Test; import static org.junit.Assert.*; public class ExampleTest { @Test public void testPass(){assertEquals(4,2+2);} @Test public void testFail(){assertEquals(5,2+2);} }\n');
    await writeFile(path.join(root, 'settings.xml'), '<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"/>\n');
    await writeFile(path.join(root, 'pom.xml'), `<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>invalid.example</groupId><artifactId>trp-native-fixture</artifactId><version>1</version><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.11.0</version><configuration><release>17</release></configuration></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build></project>\n`);
  }
  const resultPath = pythonAdapter ? 'reports/pytest.xml' : 'target/surefire-reports';
  await mkdir(path.dirname(path.join(root, resultPath)), { recursive: true });
  const declaration = { phaseId: 'implementation', commandId: 'native-tests', adapter,
    dependencyScope: 'repository-and-declared-runtime-only',
    runtime: { executableSha256: digest(await readFile(await realpath(runtime.executable))), dependencyRoots: runtime.roots },
    tests: names.map((name, index) => ({ id: `case-${index}`, path: file, className, name })) };
  const argv = pythonAdapter ? [runtime.executable, '-I', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q',
    '--noconftest', '-c', 'pytest.ini', '--override-ini=addopts=', `--junitxml=${resultPath}`, file]
    : [runtime.executable, '-o', '-B', '-ntp', '-s', 'settings.xml', '-gs', 'settings.xml',
      `-Dmaven.repo.local=${process.env.SF_TRP_MAVEN_CACHE}`, 'clean', 'test'];
  const command = { id: 'native-tests', kind: 'test', argv, workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'junit-xml', path: resultPath, minimumDiscovered: 2, minimumPassed: 1 } };
  const workflow = { resolution: { testRecovery: { caseInventory: [declaration] } } };
  return { root, declaration, command, workflow, phase: { id: 'implementation' } };
}

test('generic JUnit identities retain genuine failure/skipped outcomes and reject inconsistent totals', () => {
  const report = '<testsuite tests="3" failures="1" errors="0" skipped="1"><testcase classname="Demo" name="ok"/><testcase classname="Demo" name="bad"><failure message="assertion">details</failure></testcase><testcase classname="Demo" name="skip"><skipped/></testcase></testsuite>';
  const parsed = parseTrpJunitReport(Buffer.from(report));
  assert.deepEqual(parsed.cases.map(entry => entry.outcome), ['passed', 'failed', 'skipped']);
  assert.match(parsed.cases[1].causeSha256, /^sha256:/u);
  assert.throws(() => parseTrpJunitReport(Buffer.from(report.replace('tests="3"', 'tests="2"'))));
});

test('runner environment cannot inject pytest collection or Maven JVM/project launch overrides', () => {
  const py = trpExecutionEnvironment({ adapter: 'pytest-junit-v1' }, { PYTHONPATH: '/ambient', PYTEST_ADDOPTS: 'other.py', KEEP: 'yes' });
  assert.equal(py.PYTHONPATH, undefined); assert.equal(py.PYTEST_ADDOPTS, undefined); assert.equal(py.KEEP, 'yes');
  assert.equal(py.PYTEST_DISABLE_PLUGIN_AUTOLOAD, '1');
  const mvn = trpExecutionEnvironment({ adapter: 'maven-surefire-junit-v1' }, {
    MAVEN_BASEDIR: '/ambient', MAVEN_DEBUG_OPTS: '-javaagent:bad', CLASSWORLDS_LAUNCHER: 'bad', JAVA_TOOL_OPTIONS: 'bad' }, { cwd: '/approved' });
  assert.deepEqual(mvn, { MAVEN_SKIP_RC: 'true', MAVEN_BASEDIR: '/approved' });
});

test('selected testcase source is rechecked after the independent inventory capture', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-inventory-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'test.mjs'), "import test from 'node:test'; test('case',()=>{});\n");
  const command = { id: 'tests', kind: 'test', argv: [process.execPath, '--test', '--test-reporter=junit', 'test.mjs'], workingDirectory: '.',
    result: { adapter: 'junit-xml', path: 'report.xml', minimumDiscovered: 1 } };
  const declaration = { phaseId: 'code', commandId: 'tests', dependencyScope: 'repository-and-node-builtins-only', tests: [{ id: 'case', name: 'case', path: 'test.mjs' }] };
  const inventory = await readTrpCaseInventory(root, { resolution: { testRecovery: { caseInventory: [declaration] } } }, { id: 'code' }, command);
  await verifyTrpCaseInventorySources(root, inventory);
  await writeFile(path.join(root, 'test.mjs'), "import test from 'node:test'; test('case',()=>{throw Error('different semantics')});\n");
  await assert.rejects(() => verifyTrpCaseInventorySources(root, inventory), /independently captured semantics/u);
});

test('baseline capture cannot bypass private-environment or disabled-model execution gates', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-baseline-execution-guards-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'test.mjs'), "import test from 'node:test'; import {writeFileSync} from 'node:fs'; writeFileSync('must-not-run','executed'); test('case',()=>{});\n");
  await writeFile(path.join(root, '.gitignore'), 'reports/\nmust-not-run\n');
  await mkdir(path.join(root, 'singularity'));
  const environmentDeclaration = 'schemaVersion: 1\nenvironments:\n  qa:\n    requires:\n      - name: API_TOKEN\n        kind: secret\n    localFiles: []\nchecks:\n  tests:\n    environment: qa\nneverCommit: []\n';
  await writeFile(path.join(root, 'singularity/environments.yml'), environmentDeclaration);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Native Fixture'); git('config', 'user.email', 'native@example.invalid');
  git('add', '.'); git('commit', '-qm', 'Execution guard fixture');
  const command = { id: 'tests', kind: 'test', argv: [process.execPath, '--test', '--test-reporter=junit', 'test.mjs'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never', environment: 'qa',
    result: { adapter: 'junit-xml', path: 'reports/result.xml', minimumDiscovered: 1, minimumPassed: 1 } };
  const definition = { approvalAuthorities: {}, testRecovery: { enabled: true, allowEvidenceReuse: true, riskAuthorities: ['reviewer'],
    enabledRiskCategories: ['known-test-failure'], caseInventory: [{ phaseId: 'code', commandId: 'tests',
      dependencyScope: 'repository-and-node-builtins-only', tests: [{ id: 'case', name: 'case', path: 'test.mjs' }] }] },
    phases: { code: { id: 'code', qualityCommands: [command] } } };
  const identity = { workId: 'GUARDS', phaseId: 'code', repositoryId: 'lifecycle', baseCommit: git('rev-parse', 'HEAD') };
  await assert.rejects(() => captureTrpIntakeBaseline(root, definition, identity), /approved isolated environment runner/u);
  delete command.environment; command.modelPolicy = 'required';
  await withOperationContext({ root, command: 'test', operation: { id: 'test.baseline-guards', command: 'test', modelPolicy: 'never' }, modelMode: { enabled: false, source: 'test' } },
    () => assert.rejects(() => captureTrpIntakeBaseline(root, definition, identity), /external-model policy/u));
  command.modelPolicy = 'never';
  await writeFile(path.join(root, 'singularity/environments.yml'), environmentDeclaration.replace('  tests:', '  undeclared-tests:'));
  git('add', '.'); git('commit', '-qm', 'Invalid environment command mapping fixture');
  identity.baseCommit = git('rev-parse', 'HEAD');
  await assert.rejects(() => captureTrpIntakeBaseline(root, definition, identity), /undeclared-tests/u);
  await assert.rejects(() => readFile(path.join(root, 'must-not-run')), { code: 'ENOENT' });
  await assert.rejects(() => readFile(path.join(root, 'reports/result.xml')), { code: 'ENOENT' });
});

for (const [adapter, runtime] of [['pytest-junit-v1', python], ['maven-surefire-junit-v1', maven]]) {
  test(`${adapter}: real installed native runner authenticates exact failing inventory and report bytes`, {
    skip: !runtime ? 'Set explicit isolated runtime executable/roots to qualify this installed adapter; synthetic reports do not qualify it.' : false,
    timeout: 180000
  }, async t => {
    const value = await fixture(t, adapter, runtime);
    const { root, command, declaration, workflow, phase } = value;
    if (adapter === 'maven-surefire-junit-v1') {
      await mkdir(path.join(root, 'target/test-classes'), { recursive: true });
      await writeFile(path.join(root, 'target/test-classes/GhostTest.class'), 'stale build output must not execute');
    }
    const inventory = await readTrpCaseInventory(root, workflow, phase, command);
    const env = trpExecutionEnvironment(declaration, process.env, { cwd: root });
    const reportCapture = trpNativeReportCapture(root, command, declaration);
    const result = await runQualityCommand(command.argv[0], command.argv.slice(1), { cwd: root, env, reportCapture, timeoutMs: 120000 });
    assert.equal(result.status, 1, JSON.stringify({ error: result.error?.message, stdout: result.stdout, stderr: result.stderr }));
    const expected = { command: command.argv[0], args: command.argv.slice(1), cwd: root, stdoutFile: null, reportCapture,
      environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(env).sort())).digest('hex') };
    const launch = verifyCompletedQualityLaunch(result, expected);
    assert.ok(launch?.reports?.length, JSON.stringify(result));
    assert.equal(verifyCompletedQualityLaunch({ ...result }, expected), null, 'copied native-shaped output cannot mint provenance');
    const parsed = await parseTestResult(root, command, { startedAt: launch.startedAt });
    const matched = await matchTrpReports(root, inventory, parsed.rawReports);
    assert.deepEqual(matched.counts, { discovered: 2, passed: 1, failed: 1, skipped: 0, notRun: 0 });
    assert.deepEqual(matched.cases.map(entry => entry.id), ['case-0', 'case-1']);
    assert.deepEqual(parsed.rawReports.map(({ sourcePath, sha256, bytes }) => ({ sourcePath, sha256, bytes })), launch.reports);
    if (adapter === 'maven-surefire-junit-v1') await assert.rejects(() => readFile(path.join(root, 'target/test-classes/GhostTest.class')), { code: 'ENOENT' });
    assert.equal((await snapshotTrpDeclaredRuntime(root, declaration, command)).sha256, inventory.runtime.sha256,
      'real execution cannot silently alter approved runtime/cache bytes');
    const stale = await runQualityCommand(command.argv[0], command.argv.slice(1), { cwd: root, env, reportCapture, timeoutMs: 120000 });
    assert.ok(stale.error, 'pre-existing reports are never authenticated as a new standalone execution');
    assert.equal(verifyCompletedQualityLaunch(stale, expected), null);
    await assert.rejects(() => matchTrpReports(root, { ...inventory, tests: inventory.tests.slice(0, 1) }, parsed.rawReports));
    if (adapter === 'maven-surefire-junit-v1') {
      const pom = await readFile(path.join(root, 'pom.xml'), 'utf8');
      await writeFile(path.join(root, 'pom.xml'), pom.replace('<build>', '<build><directory>../unowned-output</directory>'));
      await assert.rejects(() => readTrpCaseInventory(root, workflow, phase, command), /standard target outputs/u);
    }
  });
  test(`${adapter}: real baseline binds native runtime and permits only approved product-source compatibility`, {
    skip: !runtime ? 'Explicit installed runtime qualification is required.' : false, timeout: 180000
  }, async t => {
    const { root, declaration, command } = await fixture(t, adapter, runtime);
    const productRoot = adapter === 'pytest-junit-v1' ? 'app' : 'src/main/java';
    const productFile = `${productRoot}/${adapter === 'pytest-junit-v1' ? 'service.py' : 'Service.java'}`;
    await mkdir(path.join(root, productRoot), { recursive: true });
    await writeFile(path.join(root, productFile), adapter === 'pytest-junit-v1' ? 'value = 1\n' : 'class Service { static int value = 1; }\n');
    await writeFile(path.join(root, '.gitignore'), 'reports/\ntarget/\n');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Native Fixture'); git('config', 'user.email', 'native@example.invalid');
    git('add', '.'); git('commit', '-qm', 'Exact independently inventoried native baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    declaration.baselineMutableRoots = [productRoot];
    const definition = { workItemRoot: 'singularity/work-items', approvalAuthorities: {},
      testRecovery: { enabled: true, riskAuthorities: ['reviewer'], enabledRiskCategories: ['known-test-failure'], allowEvidenceReuse: true, caseInventory: [declaration] },
      phases: { implementation: { id: 'implementation', qualityCommands: [command] } } };
    const identity = { workId: 'NATIVE-BASELINE', phaseId: 'implementation', repositoryId: 'lifecycle', baseCommit };
    const captured = await captureTrpIntakeBaseline(root, definition, identity);
    assert.equal(captured.observedOutcome, 'failed'); assert.equal(captured.counts.failed, 1);
    assert.equal(captured.record.agreementSha256, null, 'baseline capture is never Story authority');
    const inspect = () => inspectTrpIntakeBaseline(root, { ...identity, definition, recordSha256: captured.recordSha256 });
    assert.equal((await inspect()).authenticated, true);
    await writeFile(path.join(root, productFile), adapter === 'pytest-junit-v1' ? 'value = 2\n' : 'class Service { static int value = 2; }\n');
    assert.equal((await inspect()).authenticated, true, 'approved product source can change without fabricating a current test pass');
    await writeFile(path.join(root, productRoot, 'settings.json'), '{"behavior":"changed"}\n');
    await assert.rejects(inspect, /compatibility scope changed/u, 'configuration nested in a mutable source root remains bound');
  });
}
