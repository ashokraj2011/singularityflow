/**
 * A SonarQube scan of a Java project, through the real CLI [CQF:REQ-048]: a quick-fix Story changes one
 * module of a two-module Java build, adding a method too complex to read, a weak cipher and a weak
 * hash, and submits its code step. Submission runs the scanner command once, with environment `sonar`
 * bound, on the scratch project (SonarQube Community Build has no branch analysis), and SFlow reads its
 * issues, hotspots, quality gate and measures, maps each `java:` finding's component key to the
 * module's file, and records what counted for the step's approvers. Maven runs
 * `mvn -B verify sonar:sonar` from the reactor root, with the main project's key on its own command
 * line as SonarQube's setup page writes it; Gradle runs `./gradlew build sonar`.
 *
 * No scanner or server runs here: the scanner is test/helpers/sonar-scanner-standin.mjs, which ranks
 * properties and writes report-task.txt as Maven's and Gradle's scanners do by their source, and the
 * server answers with Java-shaped responses (test/helpers/java-sonar-fixture.mjs). Neither was checked
 * against a live SonarQube.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cli, repository } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { javaProject, javaSonarServer, lineOf, MAIN, mavenOnPath, PRICING, PRICING_TEST, storyChange, writeFiles } from './helpers/java-sonar-fixture.mjs';

const SECRET = 'sonar-token-not-for-git-5d2e';
const CLAUSE = 'QF-1:AC-001';

async function javaStory(t, tool) {
  const tools = await mkdtemp(path.join(os.tmpdir(), 'sflow-sonar-java-tools-'));
  t.after(() => rm(tools, { recursive: true, force: true }));
  const log = path.join(tools, 'scans.jsonl');
  const change = storyChange(CLAUSE);
  const lines = { complexity: lineOf(change[PRICING], 'public static long discounted('), cipher: lineOf(change[PRICING], 'Cipher.getInstance("DES")'),
    digest: lineOf(change[PRICING], 'MessageDigest.getInstance("MD5")') };
  const server = await javaSonarServer(t, { lines });
  const maven = tool === 'maven';
  const project = maven ? 'com.example:shop' : 'shop';
  const scratch = `${project}-sflow`;
  const tests = maven
    ? { id: 'core-maven-tests', kind: 'test', argv: ['mvn', '-B', '-pl', 'core', '-am', 'test'], workingDirectory: '.', affectedRoots: ['core'], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: 'core/target/surefire-reports', minimumDiscovered: 1 } }
    : { id: 'core-gradle-tests', kind: 'test', argv: ['./gradlew', '-p', 'core', 'test'], workingDirectory: '.', affectedRoots: ['core'], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: 'core/build/test-results/test', minimumDiscovered: 1 } };
  const sonar = { id: 'sonar', kind: 'static-analysis', modelPolicy: 'never', environment: 'sonar',
    argv: maven ? ['mvn', '-B', 'verify', 'sonar:sonar', `-Dsonar.projectKey=${project}`] : ['./gradlew', 'build', 'sonar'],
    result: { adapter: 'sonarqube', path: '.sflow/results/scannerwork/report-task.txt' }, sonarqube: { project, scratchProject: scratch } };
  const repo = await repository(t, { implementQualityCommands: [tests, sonar] });
  if (maven) repo.env.PATH = `${await mavenOnPath(tools, { log })}${path.delimiter}${repo.env.PATH}`;
  await writeFiles(repo.root, javaProject(tool, { log }));
  await writeFile(path.join(repo.root, 'singularity/environments.yml'), ['schemaVersion: 1', 'environments:', '  sonar:', '    requires:',
    `      - { name: SONAR_HOST_URL, kind: endpoint, value: "${server.url}" }`, '      - { name: SONAR_TOKEN, kind: secret }', 'checks:', '  sonar: { environment: sonar }', ''].join('\n'));
  await writeFile(path.join(repo.root, 'singularity/capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: {
    kind: 'delivery', repository: 'web', policy: { localIntegrationEvidence: 'allowed' } } } }, null, 2));
  repo.must('git', ['add', '.']);
  repo.must('git', ['commit', '-q', '-m', `A ${tool} build scanned by SonarQube`]);
  const bound = spawnSync(process.execPath, [cli, 'env', 'bind', 'sonar', '--stdin'], { cwd: repo.root, env: repo.env, encoding: 'utf8',
    input: JSON.stringify({ bindings: { SONAR_TOKEN: { source: 'local', value: SECRET } } }) });
  assert.equal(bound.status, 0, bound.stderr);

  repo.must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  repo.must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  repo.must('git', ['push', '-q', '-u', 'origin', 'main']);
  repo.sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Discount gold members', '--description', 'Gold members get the discount.');
  repo.sflow('prepare', 'intake');
  await writeFile(path.join(repo.root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'Gold members must get their discount on the order total; add it to the pricing module.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${CLAUSE}] | A gold member's total is discounted. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${CLAUSE}\` | \`${PRICING}\` | \`${PRICING_TEST}\` | modified | The test reads the discounted total. |`, '',
    '## Out of scope', '', 'Nothing else changes in the modules or their interfaces.', ''].join('\n'));
  repo.sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  repo.sflow('submit', 'intake');
  repo.sflow('approve', 'intake', '--yes');
  repo.sflow('resume', 'QF-1');
  repo.sflow('phase', 'begin', 'implement', '--json');
  await writeFiles(repo.root, change);
  repo.sflow('prepare', 'implement');
  return { repo, server, log, lines, scratch, project };
}

for (const tool of ['maven', 'gradle']) {
  test(`${tool}: submission scans the scratch project once and reads its Java issues, hotspots, gate and measures [CQF:REQ-048]`, slowLane({ timeout: 600_000 }), async (t) => {
    if (process.platform === 'win32') return t.skip('the scanner stand-in runs through a shell launcher');
    const { repo, server, log, lines, scratch, project } = await javaStory(t, tool);
    repo.sflow('phase', 'publish', 'implement');
    const submitted = repo.run(process.execPath, [cli, '--no-model', 'submit', 'implement']);
    assert.equal(submitted.status, 0, `${submitted.stdout}\n${submitted.stderr}`);
    assert.match(submitted.stderr, /2 finding\(s\) on changed lines are recorded for the step's approvers: sonarqube java:S3776 at core\/src\/main\/java\/com\/example\/core\/Pricing\.java:\d+; sonarqube java:S5547 at core\/src\/main\/java\/com\/example\/core\/Pricing\.java:\d+\./u);

    // The scan ran once, on the scratch project, and wrote report-task.txt where SFlow read it.
    const scans = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((scan) => scan.properties);
    assert.equal(scans.length, 1, 'one scan, at submit');
    const [scan] = scans;
    assert.equal(scan.properties['sonar.projectKey'], scratch, 'never the main project');
    assert.equal(scan.report, '.sflow/results/scannerwork/report-task.txt');
    assert.ok(path.isAbsolute(scan.properties['sonar.scanner.metadataFilePath']));
    // SFlow's own -D options come last: Maven keeps its work in each module's target/sonar.
    assert.deepEqual(scan.args.slice(-2), tool === 'maven' ? ['-Dsonar.qualitygate.wait=true', `-Dsonar.projectKey=${scratch}`]
      : ['-Dsonar.working.directory=.sflow/results/scannerwork', `-Dsonar.projectKey=${scratch}`]);
    if (tool === 'maven') {
      assert.ok(scan.args.includes(`-Dsonar.projectKey=${project}`), 'the command\'s own key was there, and SFlow\'s came after it');
      assert.deepEqual(scan.workFolders, ['target/sonar', 'core/target/sonar', 'app/target/sonar']);
    }
    assert.deepEqual(['core', 'app'].filter((module) => existsSync(path.join(repo.root, module, '.sflow'))), [], 'no work folder in a module');
    const requests = await server.requests();
    const issues = requests.find((request) => request.path === '/api/issues/search');
    // A scratch project's new code is not the Story's: every open issue is read, and the changed lines decide.
    assert.deepEqual([issues.query.componentKeys, issues.query.branch, issues.query.inNewCodePeriod, issues.authorization], [scratch, undefined, undefined, `Bearer ${SECRET}`]);
    assert.deepEqual([...new Set(requests.map((request) => request.path))].sort(),
      ['/api/hotspots/search', '/api/issues/search', '/api/measures/component', '/api/qualitygates/project_status']);

    // What submission recorded: the scan's check, the server's gate and measures, and the findings.
    const workflow = JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
    const phase = workflow.phases.implement;
    const check = phase.checks.find((entry) => entry.id === 'sonar');
    assert.deepEqual([check.status, check.findings.adapter, check.findings.counted], ['passed', 'sonarqube', 2], JSON.stringify(check).slice(0, 2000));
    // It ran with the bound environment's values: local-integration evidence, and labelled so [RUN M3].
    assert.deepEqual([check.evidenceClass, check.environment?.name, check.countsForStep], ['local-integration', 'sonar', true]);
    const evidence = phase.deliveryEvidence.submittedFindings;
    assert.equal(evidence.outcome, 'warned');
    const [read] = evidence.servers;
    assert.deepEqual([read.provider, read.project, read.branch, read.serverVersion, read.gate.status], ['sonarqube', scratch, null, '26.11.0.134175', 'ERROR']);
    assert.deepEqual(read.measures, { complexity: 14, cognitive_complexity: 18, duplicated_lines_density: 0, new_coverage: 100 });
    // The Story's lines: a high complexity smell and vulnerability count; the low hotspot is new code, shown.
    const kept = evidence.findings.map((finding) => [finding.rule, finding.kind, finding.file ?? null, finding.line ?? null, finding.severity, evidence.counted.includes(finding.fingerprint)]);
    assert.deepEqual(kept.sort(), [
      ['java:S3776', 'complexity', PRICING, lines.complexity, 'high', true],
      ['java:S4790', 'hotspot', PRICING, lines.digest, 'low', false],
      ['java:S5547', 'vulnerability', PRICING, lines.cipher, 'high', true]].sort());
    // The existing finding in the other module maps to its own file; it and the scratch project's failed gate count for nothing.
    const runs = path.join(repo.root, '.git/singularity-flow/quality-runs/QF-1/implement');
    const run = (await Promise.all((await readdir(runs)).map(async (name) => JSON.parse(await readFile(path.join(runs, name), 'utf8')))))
      .find((entry) => entry.commandId === 'sonar');
    assert.deepEqual([run.status, run.findings.find((finding) => finding.rule === 'java:S106')?.file], ['read', MAIN]);
    assert.deepEqual(run.findings.filter((finding) => ['java:S106', 'quality-gate'].includes(finding.rule)).map((finding) => [finding.rule, finding.newCode]).sort(),
      [['java:S106', false], ['quality-gate', false]]);
    assert.doesNotMatch(JSON.stringify(workflow), new RegExp(SECRET, 'u'), 'the token is in no record');
    assert.doesNotMatch(repo.run('git', ['log', '-p', '--all']).stdout, new RegExp(SECRET, 'u'));
    assert.doesNotMatch(check.command, /metadataFilePath/u, 'the report\'s absolute path is off the recorded command line');
  });
}
