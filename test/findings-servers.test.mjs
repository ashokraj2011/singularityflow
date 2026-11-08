/**
 * What submission reads from servers [CQF:REQ-048, REQ-049]: a SonarQube scan of the Story branch (or a
 * named scratch project, never the main one) and its server's new-code issues, hotspots, gate and
 * measures; and GitHub code scanning's open CodeQL alerts through gh. The SonarQube server is a local
 * HTTP server answering with recorded responses, and gh answers with recorded `gh api` JSON: neither
 * was checked against a live service.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { codeScanningRead, readReportTask, readSonarqubeServer, sonarScannerProperties, submitServerAnalyses } from '../src/findings/servers.mjs';
import { githubCodeScanning } from '../src/github-evidence.mjs';

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

const scanner = (sonarqube) => normalizeExternalCommand({ id: 'sonar', kind: 'static-analysis', modelPolicy: 'never', environment: 'sonar',
  argv: ['sonar-scanner'], result: { adapter: 'sonarqube', path: '.sflow/results/scannerwork/report-task.txt' }, sonarqube });

test('a scan names where it analyses: the Story branch under the project, or only the scratch project', () => {
  assert.deepEqual(sonarScannerProperties(scanner({ project: 'payments-api', branchAnalysis: true }), { branch: 'sflow/pay-12' }), {
    'sonar.qualitygate.wait': 'true', 'sonar.working.directory': '.sflow/results/scannerwork', 'sonar.projectKey': 'payments-api', 'sonar.branch.name': 'sflow/pay-12' });
  assert.deepEqual(sonarScannerProperties(scanner({ project: 'payments-api', scratchProject: 'payments-api-sflow' }), { branch: 'sflow/pay-12' }), {
    'sonar.qualitygate.wait': 'true', 'sonar.working.directory': '.sflow/results/scannerwork', 'sonar.projectKey': 'payments-api-sflow' });
  assert.deepEqual(readReportTask('projectKey=payments-api\nserverUrl=https://sonar.example.test\nserverVersion=10.6.0.92116\nbranch=sflow/pay-12\nceTaskId=AY1\n'),
    { projectKey: 'payments-api', serverUrl: 'https://sonar.example.test', serverVersion: '10.6.0.92116', branch: 'sflow/pay-12', ceTaskId: 'AY1' });
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
});

test('submission scans once and reads its own server; never the main project, another project or another host', async (t) => {
  const root = await repository(t);
  const server = await sonarServer(t);
  const ran = [];
  const kernel = { qualityChecks: async (_root, _phase, _config, _workflow, [command]) => {
    ran.push(command);
    const properties = JSON.parse(command.env.SONAR_SCANNER_JSON_PARAMS);
    await mkdir(path.join(root, '.sflow/results/scannerwork'), { recursive: true });
    await writeFile(path.join(root, '.sflow/results/scannerwork/report-task.txt'),
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
