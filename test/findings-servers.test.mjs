/**
 * What submission reads from servers [CQF:REQ-048, REQ-049]: a SonarQube scan of the Story branch (or a
 * named scratch project, never the main one) and its server's new-code issues, hotspots, gate and
 * measures; and GitHub code scanning's open CodeQL alerts through gh. The SonarQube server is a local
 * HTTP server answering with recorded responses, and gh answers with recorded `gh api` JSON: neither
 * was checked against a live service.
 */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { readSonarqubeJson } from '../src/findings/readers/sonarqube.mjs';
import { codeScanningRead, readReportTask, readSonarqubeServer, sonarScanCommand, sonarScannerProperties, submitServerAnalyses } from '../src/findings/servers.mjs';
import { laterStepCodeScanning } from '../src/findings/code-step.mjs';
import { markNewCode } from '../src/findings/model.mjs';
import { githubCodeScanning } from '../src/github-evidence.mjs';
import { javaProject, javaSonarServer, STANDIN, writeFiles } from './helpers/java-sonar-fixture.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/findings/${name}`, import.meta.url), 'utf8');
const TOKEN = 'fixture-bearer-not-a-credential';

/** A SonarQube Web API that answers the four reads with the recorded responses, and records each request. */
async function sonarServer(t) {
  const requests = [];
  const answers = { '/api/issues/search': await fixture('sonarqube-issues.json'), '/api/hotspots/search': await fixture('sonarqube-hotspots.json'),
    '/api/qualitygates/project_status': await fixture('sonarqube-quality-gate.json'), '/api/measures/component': await fixture('sonarqube-measures.json') };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization });
    const body = answers[url.pathname];
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(body ?? '{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-finding-servers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root }).status, 0);
  return root;
}

const scanner = (sonarqube, argv = ['sonar-scanner']) => normalizeExternalCommand({ id: 'sonar', kind: 'static-analysis', modelPolicy: 'never', environment: 'sonar',
  argv, result: { adapter: 'sonarqube', path: '.sflow/results/scannerwork/report-task.txt' }, sonarqube });

test('a scan names where it analyses: the Story branch under the project, or only the scratch project', () => {
  assert.deepEqual(sonarScannerProperties(scanner({ project: 'payments-api', branchAnalysis: true }), { branch: 'sflow/pay-12' }), {
    'sonar.qualitygate.wait': 'true', 'sonar.working.directory': '.sflow/results/scannerwork', 'sonar.projectKey': 'payments-api', 'sonar.branch.name': 'sflow/pay-12' });
  assert.deepEqual(sonarScannerProperties(scanner({ project: 'payments-api', scratchProject: 'payments-api-sflow' }), { branch: 'sflow/pay-12' }), {
    'sonar.qualitygate.wait': 'true', 'sonar.working.directory': '.sflow/results/scannerwork', 'sonar.projectKey': 'payments-api-sflow' });
  assert.deepEqual(readReportTask('projectKey=payments-api\nserverUrl=https://sonar.example.test\nserverVersion=10.6.0.92116\nbranch=sflow/pay-12\nceTaskId=AY1\n'),
    { projectKey: 'payments-api', serverUrl: 'https://sonar.example.test', serverVersion: '10.6.0.92116', branch: 'sflow/pay-12', ceTaskId: 'AY1' });
  // report-task.txt is written where SFlow reads it; Maven keeps its work in each module's target/sonar.
  const reportFile = path.resolve('/checkout/.sflow/results/scannerwork/report-task.txt');
  assert.deepEqual(sonarScannerProperties(scanner({ project: 'com.example:shop', scratchProject: 'com.example:shop-sflow' }, ['./mvnw', '-B', 'verify', 'sonar:sonar']),
    { branch: null, reportFile }), { 'sonar.qualitygate.wait': 'true', 'sonar.scanner.metadataFilePath': reportFile, 'sonar.projectKey': 'com.example:shop-sflow' });
  assert.equal(sonarScannerProperties(scanner({ project: 'shop', scratchProject: 'shop-sflow' }, ['./gradlew', 'build', 'sonar']), { branch: null, reportFile })['sonar.working.directory'],
    '.sflow/results/scannerwork', 'Gradle works in the report\'s folder: only the root project takes the environment\'s');
});

test('SFlow\'s properties outrank the command\'s own: last -D options for Maven, Gradle and sonar-scanner, the report\'s path in the environment only', () => {
  const reportFile = path.resolve('/checkout/.sflow/results/scannerwork/report-task.txt');
  const options = ['-Dsonar.qualitygate.wait=true', '-Dsonar.projectKey=shop-sflow'];
  for (const argv of [['mvn', '-B', 'verify', 'sonar:sonar'], ['./mvnw', 'verify', 'sonar:sonar'], ['mvnw.cmd', 'verify', 'sonar:sonar'], ['mvnd', 'verify', 'sonar:sonar']]) {
    // As SonarQube's setup page writes Maven's command: the main project's key on the command line.
    const command = scanner({ project: 'shop', scratchProject: 'shop-sflow' }, [...argv, '-Dsonar.projectKey=shop']);
    const scan = sonarScanCommand(command, sonarScannerProperties(command, { branch: null, reportFile }));
    assert.deepEqual(scan.argv, [...argv, '-Dsonar.projectKey=shop', ...options], argv[0]);
    assert.equal(JSON.parse(scan.env.SONAR_SCANNER_JSON_PARAMS)['sonar.scanner.metadataFilePath'], reportFile);
    assert.equal(scan.env.SONARQUBE_SCANNER_PARAMS, scan.env.SONAR_SCANNER_JSON_PARAMS);
  }
  for (const argv of [['./gradlew', 'build', 'sonar'], ['gradlew.bat', 'build', 'sonar'], ['gradle', 'build', 'sonar'], ['sonar-scanner']]) {
    const command = scanner({ project: 'shop', scratchProject: 'shop-sflow' }, argv);
    assert.deepEqual(sonarScanCommand(command, sonarScannerProperties(command, { branch: null, reportFile })).argv,
      [...argv, '-Dsonar.qualitygate.wait=true', '-Dsonar.working.directory=.sflow/results/scannerwork', '-Dsonar.projectKey=shop-sflow'], argv[0]);
  }
  const branch = scanner({ project: 'shop', branchAnalysis: true }, ['mvn', 'verify', 'sonar:sonar']);
  assert.deepEqual(sonarScanCommand(branch, sonarScannerProperties(branch, { branch: 'sflow/shop-7', reportFile })).argv.slice(3),
    ['-Dsonar.qualitygate.wait=true', '-Dsonar.projectKey=shop', '-Dsonar.branch.name=sflow/shop-7']);
  // Another program's arguments are its own: SFlow's properties reach it in the environment only.
  for (const argv of [['npx', 'sonar-scanner'], ['./scripts/scan.sh']]) {
    const command = scanner({ project: 'shop', scratchProject: 'shop-sflow' }, argv);
    const scan = sonarScanCommand(command, sonarScannerProperties(command, { branch: null, reportFile }));
    assert.deepEqual(scan.argv, argv);
    assert.equal(JSON.parse(scan.env.SONAR_SCANNER_JSON_PARAMS)['sonar.projectKey'], 'shop-sflow');
  }
});

test('a Maven project\'s key holds a colon: a component without a path is the file after the whole key', () => {
  const project = 'com.example:shop-sflow';
  const read = readSonarqubeJson({ issues: [{ key: 'AZ1', rule: 'java:S3776', component: `${project}:core/src/main/java/com/example/core/Pricing.java`, project, line: 15,
    type: 'CODE_SMELL', severity: 'CRITICAL', status: 'OPEN', message: 'Refactor this method.' }] });
  assert.deepEqual(read.findings.map((finding) => [finding.file, finding.kind]), [['core/src/main/java/com/example/core/Pricing.java', 'complexity']]);
  const hotspots = readSonarqubeJson({ hotspots: [{ key: 'AZ2', ruleKey: 'java:S4790', component: `${project}:core/src/main/java/com/example/core/Pricing.java`, project,
    vulnerabilityProbability: 'LOW', status: 'TO_REVIEW', line: 37, message: 'Make sure this weak hash algorithm is not used.' }] });
  assert.equal(hotspots.findings[0].file, 'core/src/main/java/com/example/core/Pricing.java');
});

test('the scanners put the report where SFlow reads it, analyse only the scratch project, and leave no work folder in a Maven module', { skip: process.platform === 'win32' }, async (t) => {
  const server = await javaSonarServer(t, { lines: { complexity: 1, cipher: 1, digest: 1 } });
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-sonar-java-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const log = path.join(base, 'scans.jsonl');
  const scans = [];
  const scanned = async (tool, argv, properties) => {
    const root = path.join(base, `${tool}-${scans.length}`);
    await writeFiles(root, javaProject(tool, { log }));
    const command = scanner({ project: 'com.example:shop', scratchProject: 'com.example:shop-sflow' }, argv);
    const reportFile = path.join(root, '.sflow/results/scannerwork/report-task.txt');
    const scan = properties ? { ...command, env: { SONAR_SCANNER_JSON_PARAMS: JSON.stringify(properties(command)) } }
      : sonarScanCommand(command, sonarScannerProperties(command, { branch: null, reportFile }));
    // Not spawnSync: the scanner reads the gate from this process's server while it waits.
    const result = await new Promise((resolve) => execFile(process.execPath, [STANDIN, log, tool, ...scan.argv.slice(1)], { cwd: root, encoding: 'utf8',
      env: { ...process.env, ...scan.env, SONAR_HOST_URL: server.url, SONAR_TOKEN: TOKEN } }, (error, _stdout, stderr) => resolve({ status: error ? error.code : 0, stderr })));
    const ran = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1);
    scans.push(ran);
    const report = path.join(root, '.sflow/results/scannerwork/report-task.txt');
    return { status: result.status, stderr: result.stderr, ran, task: existsSync(report) ? readReportTask(await readFile(report, 'utf8')) : null,
      inModules: ['core', 'app'].filter((module) => existsSync(path.join(root, module, '.sflow'))) };
  };
  for (const [tool, argv] of [['maven', ['mvn', '-B', 'verify', 'sonar:sonar', '-Dsonar.projectKey=com.example:shop']], ['gradle', ['./gradlew', 'build', 'sonar']]]) {
    const scan = await scanned(tool, argv);
    assert.equal(scan.status, 1, `${tool}: the stand-in server's gate failed, so the scanner did too`);
    assert.match(scan.stderr, /QUALITY GATE STATUS: FAILED/u);
    assert.deepEqual([scan.task?.projectKey, scan.task?.serverUrl, scan.inModules], ['com.example:shop-sflow', server.url, []], tool);
  }
  assert.deepEqual(scans[0].workFolders, ['target/sonar', 'core/target/sonar', 'app/target/sonar'], 'Maven works in each module\'s build output');
  assert.deepEqual(scans[1].workFolders, ['.sflow/results/scannerwork', '.sflow/results/scannerwork/core', '.sflow/results/scannerwork/app']);
  // Built without compiling, Java is not analysed and no report is written.
  const unbuilt = await scanned('maven', ['mvn', '-B', 'sonar:sonar']);
  assert.match(unbuilt.ran.message, /provide compiled classes with sonar\.java\.binaries/u);
  assert.equal(unbuilt.task, null);
  // What the environment alone did before: a work folder in every Maven module, and the command's own key won.
  const before = await scanned('maven', ['mvn', '-B', 'verify', 'sonar:sonar', '-Dsonar.projectKey=com.example:shop'], (command) => ({
    'sonar.qualitygate.wait': 'true', 'sonar.working.directory': '.sflow/results/scannerwork', 'sonar.projectKey': command.sonarqube.scratchProject }));
  assert.deepEqual([before.task?.projectKey, before.inModules], ['com.example:shop', ['core', 'app']]);
});

test('the server is read for the branch\'s new code with a bearer token, and a failed gate is a finding [CQF:REQ-048]', async (t) => {
  const server = await sonarServer(t);
  const read = await readSonarqubeServer({ baseUrl: server.url, token: TOKEN, project: 'payments-api', branch: 'sflow/pay-12' });
  assert.deepEqual(server.requests.map((request) => request.path), ['/api/issues/search', '/api/hotspots/search', '/api/qualitygates/project_status', '/api/measures/component']);
  assert.ok(server.requests.every((request) => request.authorization === `Bearer ${TOKEN}` && request.query.branch === 'sflow/pay-12'));
  assert.deepEqual([server.requests[0].query.inNewCodePeriod, server.requests[0].query.components, server.requests[1].query.status],
    ['true', 'payments-api', 'TO_REVIEW']);
  assert.equal(server.requests[3].query.metricKeys, 'complexity,cognitive_complexity,duplicated_lines_density,new_coverage');
  assert.deepEqual(read.findings.map((finding) => [finding.rule, finding.kind]), [['javascript:S3776', 'complexity'], ['javascript:S2076', 'vulnerability'],
    ['javascript:S1481', 'code-smell'], ['javascript:S2245', 'hotspot'], ['quality-gate', 'code-smell']]);
  assert.match(read.findings.at(-1).message, /new_coverage 71\.4 \(LT 80\)/u);
  assert.deepEqual([read.gate.status, read.measures.new_coverage, read.counts.excepted], ['ERROR', 71.4, 1]);
  assert.doesNotMatch(JSON.stringify(read), new RegExp(TOKEN, 'u'), 'the token is in no result');
  // The branch's failed gate is new code; the Story's changed lines cannot place it, so it stays so.
  const gate = read.findings.at(-1);
  assert.equal(gate.newCode, true);
  assert.equal(markNewCode([gate], new Map()).at(0).newCode, true);

  // A scratch project's new code is not the Story's: all its open issues are read, and its gate is shown, not counted.
  const scratch = await readSonarqubeServer({ baseUrl: server.url, token: TOKEN, project: 'payments-api-sflow' });
  const scratchReads = server.requests.slice(4);
  assert.deepEqual(scratchReads.map((request) => [request.path, request.query.inNewCodePeriod, request.query.branch]), [
    ['/api/issues/search', undefined, undefined], ['/api/hotspots/search', undefined, undefined],
    ['/api/qualitygates/project_status', undefined, undefined], ['/api/measures/component', undefined, undefined]]);
  assert.deepEqual([scratch.gate.status, scratch.findings.at(-1).rule, scratch.findings.at(-1).newCode], ['ERROR', 'quality-gate', false]);
});

test('submission scans once and reads its own server; never the main project, another project or another host', async (t) => {
  const root = await repository(t);
  const server = await sonarServer(t);
  const ran = [];
  const kernel = { qualityChecks: async (_root, _phase, _config, _workflow, [command]) => {
    ran.push(command);
    const properties = JSON.parse(command.env.SONAR_SCANNER_JSON_PARAMS);
    // The scanner writes report-task.txt where SFlow told it to, and SFlow reads it there.
    assert.equal(properties['sonar.scanner.metadataFilePath'], path.resolve(root, '.sflow/results/scannerwork/report-task.txt'));
    await mkdir(path.dirname(properties['sonar.scanner.metadataFilePath']), { recursive: true });
    await writeFile(properties['sonar.scanner.metadataFilePath'],
      `projectKey=${properties['sonar.projectKey']}\nserverUrl=${ran.length === 3 ? 'https://elsewhere.example.test' : server.url}\nserverVersion=10.6.0.92116\n`);
    return [{ id: command.id, status: 'passed', exitCode: 0, startedAt: 'a', completedAt: 'b' }];
  } };
  const workflow = { workItem: { id: 'SQ-1', branch: 'sflow/sq-1' } };
  const phase = { id: 'code', generation: 1 };
  const environment = async () => ({ host: server.url, token: TOKEN });
  const analyse = (commands) => submitServerAnalyses(root, {}, workflow, phase, commands, { kernel, candidate: { commit: 'c', treeSha256: 't' }, branch: 'sflow/sq-1', environment });
  const main = await analyse([scanner({ project: 'payments-api' })]);
  assert.equal(ran.length, 0, 'no branch analysis and no scratch project: not run at all');
  assert.match(main.results[0].reason, /never analyses into payments-api/u);
  const branch = await analyse([scanner({ project: 'payments-api', branchAnalysis: true })]);
  assert.equal(JSON.parse(ran[0].env.SONAR_SCANNER_JSON_PARAMS)['sonar.branch.name'], 'sflow/sq-1');
  assert.equal(branch.results[0].status, 'read');
  assert.deepEqual([...new Set(branch.results[0].findings.map((finding) => finding.source))], ['sonar'], 'the command\'s own findings, as its check counts them');
  assert.deepEqual([branch.servers[0].gate.status, branch.servers[0].branch, branch.servers[0].serverVersion], ['ERROR', 'sflow/sq-1', '10.6.0.92116']);
  const scratch = await analyse([scanner({ project: 'payments-api', scratchProject: 'payments-api-sflow' })]);
  assert.equal(JSON.parse(ran[1].env.SONAR_SCANNER_JSON_PARAMS)['sonar.projectKey'], 'payments-api-sflow');
  assert.equal(scratch.results[0].status, 'read');
  assert.equal(server.requests.filter((request) => request.path === '/api/issues/search').at(-1).query.branch, undefined, 'a scratch project has no branch');
  const moved = await analyse([scanner({ project: 'payments-api', branchAnalysis: true })]);
  assert.match(moved.results[0].reason, /reported https:\/\/elsewhere\.example\.test, not the bound host/u, 'the token never goes to another host');
  const unbound = await submitServerAnalyses(root, {}, workflow, phase, [scanner({ project: 'payments-api', branchAnalysis: true })],
    { kernel, candidate: { commit: 'c', treeSha256: 't' }, branch: 'sflow/sq-1', environment: async () => null });
  assert.match(unbound.results[0].reason, /gives no SonarQube host and token/u, 'an unbound environment is unavailable, never a failure');
});

test('GitHub code scanning: CodeQL alerts through gh, or "not analysed yet", and never a throw [CQF:REQ-049]', async (t) => {
  const alerts = await fixture('github-code-scanning-alerts.json');
  const calls = [];
  const gh = (answers) => (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ssh') return { status: 0, stdout: 'user git\nhostname ghe.example.test\nport 22\n' };
    const target = args.at(-1);
    const answer = answers.find(([pattern]) => pattern.test(target))?.[1];
    return answer ?? { status: 1, stderr: 'HTTP 404: Not Found' };
  };
  const analysis = JSON.stringify([{ commit_sha: '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0', created_at: '2026-11-05T08:10:00Z', tool: { name: 'CodeQL', version: '2.19.3' } }]);
  const read = githubCodeScanning('/repo', 'git@github-work:example-org/payments-api.git', { ref: 'refs/heads/sflow/pay-12',
    runCommand: gh([[/\/analyses\?/u, { status: 0, stdout: analysis }], [/\/alerts\?/u, { status: 0, stdout: alerts }]]) });
  assert.deepEqual(calls[0], ['ssh', '-G', 'github-work'], 'an SSH alias resolves to its real host, as for check runs');
  assert.deepEqual(calls[1].slice(0, 4), ['gh', 'api', '--hostname', 'ghe.example.test']);
  assert.equal(calls[2][4], 'repos/example-org/payments-api/code-scanning/alerts?ref=refs%2Fheads%2Fsflow%2Fpay-12&tool_name=CodeQL&state=open&per_page=100&page=1');
  assert.deepEqual([read.analysed, read.analysis.commit, read.alerts.length], [true, '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0', 2]);
  const none = githubCodeScanning('/repo', 'https://ghe.example.test/example-org/payments-api.git', { ref: 'refs/heads/x', runCommand: gh([[/\/analyses\?/u, { status: 0, stdout: '[]' }]]) });
  assert.deepEqual([none.available, none.analysed], [true, false]);
  const off = githubCodeScanning('/repo', 'https://ghe.example.test/example-org/payments-api.git', { ref: 'refs/heads/x', runCommand: gh([]) });
  assert.deepEqual([off.available, off.reason], [false, 'HTTP 404: Not Found']);

  const root = await repository(t);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'https://ghe.example.test/example-org/payments-api.git'], { cwd: root }).status, 0);
  const story = { workItem: { id: 'CQ-1', branch: 'sflow/pay-12' } };
  const status = (answer, commit = '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0') => codeScanningRead(root, {}, story, { branch: 'sflow/pay-12', commit, read: async () => answer });
  assert.deepEqual(await status({ available: true, analysed: false, repository: 'example-org/payments-api', alerts: [] }),
    { status: 'not-analysed', reason: 'CodeQL has not analysed this branch yet', repository: 'example-org/payments-api', findings: [] });
  const analysed = await status(read);
  assert.deepEqual([analysed.status, analysed.current, analysed.findings.map((finding) => finding.rule)], ['read', true, ['js/sql-injection', 'js/useless-assignment-to-local']]);
  assert.equal((await status(read, 'f'.repeat(40))).current, false, 'an analysis of another commit is shown as such');
  assert.match((await status(off)).reason, /^GitHub code scanning could not be read: HTTP 404/u);
  assert.equal((await codeScanningRead(root, {}, story, { branch: 'b', read: async () => { throw new Error('gh: not signed in'); } })).status, 'unavailable');
});

test('a later step reads the alerts too, new code by the code step\'s change set, and never blocks [CQF:REQ-049]', async (t) => {
  const root = await repository(t);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'https://ghe.example.test/example-org/payments-api.git'], { cwd: root }).status, 0);
  const alerts = JSON.parse(await fixture('github-code-scanning-alerts.json'));
  const workflow = { workItem: { id: 'CQ-2', branch: 'sflow/pay-12' }, phaseOrder: ['implementation', 'verification'], phases: {
    implementation: { id: 'implementation', deliveryEvidence: { changeSet: { entries: [{ status: 'added', newPath: 'src/db.js', untracked: true }] } } },
    verification: { id: 'verification' } } };
  const analysed = { available: true, analysed: true, repository: 'example-org/payments-api', alerts,
    analysis: { commit: '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0', toolVersion: '2.19.3' } };
  const read = await laterStepCodeScanning(root, {}, workflow, workflow.phases.verification, { read: async () => analysed });
  assert.deepEqual([read.status, read.counts.newCode, read.counts.existing, read.findings.map((finding) => finding.file)], ['read', 1, 1, ['src/db.js']]);
  const none = await laterStepCodeScanning(root, {}, workflow, workflow.phases.verification, { read: async () => ({ available: true, analysed: false, alerts: [] }) });
  assert.deepEqual([none.status, none.reason], ['not-analysed', 'CodeQL has not analysed this branch yet']);
});
