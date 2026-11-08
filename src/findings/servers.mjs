/**
 * What a code step's submission reads from servers, once [decision 7]:
 *
 * SonarQube [CQF:REQ-048]. A scanner command with `sonarqube: { project, branchAnalysis | scratchProject }`
 * runs at submit with `sonar.qualitygate.wait=true`: on the Story branch under `project` when the server
 * supports branch analysis, otherwise only under the named scratch project. With neither it is not run:
 * SFlow never analyses into the main project, whose findings come from the project itself (M6). After
 * the scan, SFlow reads the branch's new code (a scratch project's open issues, all of them) from the
 * server the scan reported, with the host and token of the command's environment: `api/issues/search`,
 * `api/hotspots/search`, `api/qualitygates/project_status` and `api/measures/component`. A failed
 * quality gate is a finding, counted on a branch and shown for a scratch project.
 *
 * GitHub code scanning [CQF:REQ-049]. With `codeDelivery.staticAnalysis.codeql: github`, the open CodeQL
 * alerts for the Story branch, through gh's own sign-in (github-evidence.mjs). Before CodeQL has analysed
 * the branch they read as not analysed yet, which never blocks.
 *
 * Neither stores a token; responses are data, bounded and redacted by the readers. The SonarQube API
 * shapes follow the documented responses and were checked against recorded responses only, not a live
 * server; branch analysis needs SonarQube Developer Edition or above. How the scanners rank SFlow's
 * properties was read from their source (sonar-maven-plugin 3.9 to 5.8, the Gradle plugin 3.5 to 7.5,
 * sonar-scanner 8.3, the scanner engine of SonarQube 25.1), not run against a server.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { secureRepositoryPath } from '../util.mjs';
import { createFinding } from './model.mjs';
import { repositoryPaths } from './readers/common.mjs';
import { readCodeScanningAlerts } from './readers/github-code-scanning.mjs';
import { readSonarqubeHotspots, readSonarqubeIssues, readSonarqubeMeasures, readSonarqubeQualityGate, SONARQUBE_MEASURES } from './readers/sonarqube.mjs';
import { findingReportPath } from './code-step.mjs';
import { recordFindingRun } from './runs.mjs';

const PAGE_SIZE = 500;
const MAX_PAGES = 10;
const TIMEOUT_MS = 30_000;

/** `report-task.txt`, the scanner's own record of what it analysed and where: `key=value` lines. */
export function readReportTask(text) {
  const fields = {};
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const at = line.indexOf('=');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

const program = (command) => String(command.argv?.[0] ?? '').split(/[\\/]/u).at(-1);
const MAVEN_PROGRAM = /^(?:mvn|mvnw|mvnd)(?:\.cmd|\.bat)?$/iu;
// The scanners whose own command line takes `sonar.*` properties as `-D` options.
const SCANNER_PROGRAM = /^(?:mvn|mvnw|mvnd|gradle|gradlew|sonar-scanner)(?:\.cmd|\.bat)?$/iu;

/**
 * The scanner properties SFlow adds for one run: where it analyses, that it waits for the gate, and
 * where it writes report-task.txt. `reportFile` is that file's absolute path, as the scanner engine
 * requires of `sonar.scanner.metadataFilePath`: the report is then where SFlow reads it, whichever
 * folder the scanner resolves its work folder against (its project's base folder, which a `-f`, a
 * `-p` or a sonar-project.properties can move). The work folder is the report's own, in SFlow's
 * transient folder, except under Maven: its plugin gives every module the environment's properties
 * and the engine resolves a relative work folder against each module's own, so each module would get
 * a `.sflow/results` folder; Maven keeps its work in each module's `target/sonar`, the build's output.
 */
export function sonarScannerProperties(command, { branch, reportFile = null }) {
  const server = command.sonarqube;
  return {
    'sonar.qualitygate.wait': 'true',
    ...(MAVEN_PROGRAM.test(program(command)) ? {} : { 'sonar.working.directory': path.posix.dirname(command.result.path) }),
    ...(reportFile ? { 'sonar.scanner.metadataFilePath': reportFile } : {}),
    ...(server.branchAnalysis ? { 'sonar.projectKey': server.project, 'sonar.branch.name': branch } : { 'sonar.projectKey': server.scratchProject })
  };
}

/**
 * The command that runs the scan, with SFlow's properties in SONAR_SCANNER_JSON_PARAMS (and the older
 * SONARQUBE_SCANNER_PARAMS): Maven's and Gradle's plugins and sonar-scanner rank them above the
 * project's own settings, but below a `-D` option. A command carrying its own `-Dsonar.projectKey`, as
 * SonarQube's project setup page writes Maven's, would send a scratch scan into the main project. So
 * for those programs SFlow's properties are `-D` options too, last on the line, where the last one wins.
 * The report's absolute path stays in the environment, off the command line the check records.
 */
export function sonarScanCommand(command, properties) {
  const json = JSON.stringify(properties);
  const env = { ...(command.env ?? {}), SONAR_SCANNER_JSON_PARAMS: json, SONARQUBE_SCANNER_PARAMS: json };
  if (!command.argv || !SCANNER_PROGRAM.test(program(command))) return { ...command, env };
  const options = Object.entries(properties).filter(([key]) => key !== 'sonar.scanner.metadataFilePath').map(([key, value]) => `-D${key}=${value}`);
  return { ...command, argv: [...command.argv, ...options], env };
}

/**
 * Read one analysed branch (or a scratch project) from a SonarQube server. `fetch` is injectable; the
 * token goes only to `baseUrl`, whose origin the caller checked against the bound environment.
 * `source` is the scanner command's ID, as a local report's findings carry theirs, so the command's
 * check counts its own findings.
 */
export async function readSonarqubeServer({ baseUrl, token, project, branch = null, fetch = globalThis.fetch, paths = null, source = 'sonarqube' }) {
  const origin = new URL(baseUrl);
  const get = async (pathname, parameters) => {
    const url = new URL(pathname, `${origin.origin}${origin.pathname.replace(/\/?$/u, '/')}`);
    for (const [key, value] of Object.entries(parameters)) if (value != null) url.searchParams.set(key, String(value));
    if (url.origin !== origin.origin) throw new Error('SonarQube request left the configured host.');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`SonarQube answered ${response.status} for ${pathname}.`);
    return response.json();
  };
  const branchParameters = branch ? { branch } : {};
  // A branch's new code is its change from the branch it is compared with. A scratch project's is not
  // the Story's: a project's first analysis has none, and a later one is the change from whatever was
  // analysed there before. So a scratch project's open issues are all read, and the Story's changed
  // lines decide which are new code, as for every other finding.
  const newCodeParameters = branch ? { inNewCodePeriod: 'true' } : {};
  const issues = [];
  let issueCounts = { excepted: 0, closed: 0 };
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await get('api/issues/search', { components: project, componentKeys: project, ...branchParameters, ...newCodeParameters,
      resolved: 'false', ps: PAGE_SIZE, p: page, additionalFields: '_all' });
    const read = readSonarqubeIssues(response, { source, serverUrl: origin.origin, paths });
    issues.push(...read.findings);
    issueCounts = { excepted: issueCounts.excepted + read.excepted, closed: issueCounts.closed + read.closed };
    if ((response.issues ?? []).length < PAGE_SIZE) break;
  }
  const hotspots = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await get('api/hotspots/search', { project, ...branchParameters, ...newCodeParameters, status: 'TO_REVIEW', ps: PAGE_SIZE, p: page });
    hotspots.push(...readSonarqubeHotspots(response, { source, serverUrl: origin.origin, paths }).findings);
    if ((response.hotspots ?? []).length < PAGE_SIZE) break;
  }
  const gate = readSonarqubeQualityGate(await get('api/qualitygates/project_status', { projectKey: project, ...branchParameters }));
  const measures = readSonarqubeMeasures(await get('api/measures/component', { component: project, ...branchParameters, metricKeys: SONARQUBE_MEASURES.join(',') }));
  const findings = [...issues, ...hotspots];
  if (gate.passed === false) {
    // The gate is the server's verdict on the new code as a whole: one finding, on no line. On a
    // branch that is the Story's change; on a scratch project it is not, so it is shown, not counted.
    findings.push(createFinding({ source, tool: 'sonarqube', rule: 'quality-gate', severity: 'high', kind: 'code-smell', newCode: Boolean(branch),
      snippet: `quality-gate:${project}:${branch ?? ''}`,
      message: `The quality gate failed: ${gate.conditions.filter((condition) => condition.status === 'ERROR')
        .map((condition) => `${condition.metric} ${condition.actual ?? '?'} (${condition.comparator ?? ''} ${condition.threshold ?? ''})`).join(', ')}` }));
  }
  return { findings, gate, measures, counts: issueCounts };
}

/** The bound environment's host and token for a scanner command, never kept beyond this read. */
async function sonarEnvironment(root, command) {
  const { materializeEnvironmentBinding } = await import('../environment-bindings.mjs');
  const bound = await materializeEnvironmentBinding(root, command.environment, { commandId: command.id }).catch(() => null);
  if (bound?.status !== 'bound') return null;
  const values = bound.childEnvironment({});
  const host = values.SONAR_HOST_URL ?? values.SONARQUBE_HOST_URL ?? null;
  const token = values.SONAR_TOKEN ?? values.SONARQUBE_TOKEN ?? null;
  return host && token ? { host, token } : null;
}

const unavailable = (command, reason) => ({ command, status: 'unavailable', reason, findings: [] });

/**
 * Run each SonarQube scanner command once and read its server. Returns finding-command results in the
 * shape runFindingCommands gives, and `servers` (each server's gate and measures) for the evidence.
 */
export async function submitServerAnalyses(root, config, workflow, phase, commands, { kernel, candidate, branch, fetch = globalThis.fetch,
  environment = sonarEnvironment } = {}) {
  const results = [];
  const servers = [];
  for (const command of commands) {
    const server = command.sonarqube;
    if (!server.branchAnalysis && !server.scratchProject) {
      results.push(unavailable(command, `SonarQube branch analysis is not declared and no scratch project is named; SFlow never analyses into ${server.project}, whose findings come from the project itself`));
      continue;
    }
    if (server.branchAnalysis && !branch) { results.push(unavailable(command, 'the Story has no branch to analyse')); continue; }
    const reportPath = findingReportPath(command);
    // In the checkout, as SFlow reads it below; a scan run on an isolated candidate writes it here too.
    const properties = sonarScannerProperties(command, { branch, reportFile: path.resolve(root, reportPath) });
    const [check] = await kernel.qualityChecks(root, phase, config, workflow, [sonarScanCommand(command, properties)]);
    let task = null;
    if (check && !check.infrastructureUnavailable && check.status !== 'skipped-warning' && !(check.status === 'blocked' && check.errorCode)) {
      const target = await secureRepositoryPath(root, reportPath, { label: `SonarQube report '${reportPath}'`, mustExist: false });
      task = target.exists ? readReportTask(await readFile(target.absolute, 'utf8')) : null;
    }
    const expected = server.branchAnalysis ? server.project : server.scratchProject;
    let result;
    if (!task) {
      result = unavailable(command, check?.status === 'blocked' || check?.status === 'skipped-warning' ? String(check.stderr || 'it did not run').slice(0, 300)
        : `the scanner wrote no ${path.posix.basename(reportPath)} (exit ${check?.exitCode ?? 'none'})`);
    } else if (task.projectKey !== expected) {
      result = unavailable(command, `the scanner analysed ${task.projectKey ?? 'an unnamed project'}, not ${expected}; its results are not read`);
    } else {
      const bound = await environment(root, command);
      let origin = null;
      try { origin = bound ? new URL(bound.host).origin : null; } catch { origin = null; }
      let reported = null;
      try { reported = task.serverUrl ? new URL(task.serverUrl).origin : null; } catch { reported = null; }
      if (!bound || !origin) result = unavailable(command, `environment ${command.environment ?? 'none'} gives no SonarQube host and token`);
      else if (reported && reported !== origin) result = unavailable(command, `the scanner reported ${reported}, not the bound host ${origin}`);
      else {
        try {
          const read = await readSonarqubeServer({ baseUrl: bound.host, token: bound.token, project: expected, branch: server.branchAnalysis ? branch : null, fetch, source: command.id,
            paths: repositoryPaths({ bases: [{ absolute: root, relative: '.' }], cwd: command.workingDirectory ?? '.' }) });
          result = { command, status: 'read', findings: read.findings };
          servers.push({ commandId: command.id, provider: 'sonarqube', project: expected, branch: server.branchAnalysis ? branch : null,
            serverVersion: task.serverVersion ?? null, dashboardUrl: task.dashboardUrl ?? null, gate: read.gate, measures: read.measures, excepted: read.counts.excepted });
        } catch (error) {
          result = unavailable(command, `the server could not be read: ${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
    }
    const identity = { tool: 'sonarqube', toolVersion: task?.serverVersion ?? null, rulesetSha256: null };
    result.identity = identity;
    result.check = check;
    result.run = await recordFindingRun(root, { workId: workflow.workItem.id, phaseId: phase.id, generation: phase.generation, purpose: 'submission', command, candidate,
      identity, status: result.status, reason: result.reason ?? null, exitCode: check?.exitCode ?? null, findings: result.findings,
      startedAt: check?.startedAt ?? null, completedAt: check?.completedAt ?? null });
    results.push(result);
  }
  return { results, servers };
}

/**
 * The open CodeQL alerts for the Story branch, as GitHub code scanning holds them. Never throws: a
 * repository without code scanning, gh signed out or an unanalysed branch is said, and blocks nothing.
 */
export async function codeScanningRead(root, config, workflow, { branch, commit, read = null } = {}) {
  try {
    const { githubCodeScanning, storyCheckRemote } = await import('../github-evidence.mjs');
    const remote = storyCheckRemote(root, config).url;
    const answer = read ? await read({ root, remote, ref: `refs/heads/${branch}` }) : githubCodeScanning(root, remote, { ref: `refs/heads/${branch}` });
    if (!answer.available) return { status: 'unavailable', reason: `GitHub code scanning could not be read: ${answer.reason ?? 'unknown'}`, findings: [] };
    if (!answer.analysed) return { status: 'not-analysed', reason: 'CodeQL has not analysed this branch yet', repository: answer.repository, findings: [] };
    const report = readCodeScanningAlerts(answer.alerts, { source: 'codeql', repository: answer.repository });
    const analysedCommit = answer.analysis?.commit ?? report.analysedCommits[0] ?? null;
    return { status: 'read', repository: answer.repository, analysedCommit, submittedCommit: commit ?? null,
      current: Boolean(analysedCommit && commit && analysedCommit === commit), toolVersion: answer.analysis?.toolVersion ?? null, findings: report.findings };
  } catch (error) {
    return { status: 'unavailable', reason: `GitHub code scanning could not be read: ${String(error?.message ?? error).slice(0, 200)}`, findings: [] };
  }
}
