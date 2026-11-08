/**
 * Dependency audits in the code step's loop [CQF:REQ-050]: npm audit, pnpm audit, pip-audit,
 * osv-scanner and OWASP dependency-check read into the one finding shape, a finding new code only
 * when this Story added the package or changed its version, and an audit run only when the Story
 * changed a manifest or lockfile it reads.
 *
 * test/fixtures/findings/npm-audit*.json are a real `npm audit --json` (npm 11) on a scratch project
 * with public packages, its lockfile and its report with the registry unreachable; the advisory links'
 * host reads github.example.test, as the repository check asks of every fixture. pnpm audit,
 * pip-audit, osv-scanner and dependency-check were not run here: their reports are recorded in the
 * format each tool documents.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFinding } from '../src/findings/model.mjs';
import { repositoryPaths } from '../src/findings/readers/common.mjs';
import { advisorySeverity, purlPackage, readDependencyCheck, readNpmAudit, readOsvScanner, readPipAudit } from '../src/findings/readers/dependency-audits.mjs';
import { readFindingReport } from '../src/findings/readers/index.mjs';
import {
  auditedManifests, auditsManifest, dependencyKey, manifestInventory, markNewDependencies, storyDependencyChanges
} from '../src/findings/dependency-changes.mjs';
import { newDependencyFindings, publishCheckFindings } from '../src/findings/code-step.mjs';
import { publishedFindingsSummary } from '../src/findings/presentation.mjs';
import { findingCommand, normalizeExternalCommand } from '../src/external-command-policy.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/findings/${name}`, import.meta.url), 'utf8');

async function directory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('npm audit: each advisory on an installed package is a dependency finding, its version from the lockfile npm read', async () => {
  const report = readNpmAudit(await fixture('npm-audit.json'), { lockfile: JSON.parse(await fixture('npm-audit-package-lock.json')), file: 'package-lock.json', toolVersion: '11.20.0' });
  assert.deepEqual(report.findings.map((finding) => [finding.package, finding.installedVersion, finding.fixedVersion, finding.rule, finding.severity]), [
    ['lodash', '4.17.20', '4.18.1', 'GHSA-35jh-r3h4-6jhm', 'high'], ['lodash', '4.17.20', '4.18.1', 'GHSA-29mw-wpgm-hmr9', 'medium'],
    ['lodash', '4.17.20', '4.18.1', 'GHSA-r5fr-rjxr-66jc', 'high'], ['lodash', '4.17.20', '4.18.1', 'GHSA-xxjr-mmjv-4gpg', 'medium'],
    ['minimist', '1.2.5', '1.2.8', 'GHSA-xvch-5gv4-984h', 'critical']]);
  for (const finding of report.findings) {
    assert.deepEqual([finding.kind, finding.feed, finding.tool, finding.toolVersion, finding.file, finding.newCode], ['dependency', 'security', 'npm-audit', '11.20.0', 'package-lock.json', false]);
    assert.match(finding.url, /^https:\/\/github\.example\.test\/advisories\/GHSA-/u);
  }
  assert.deepEqual(report.database, { live: true, updatedAt: null }, 'npm asks the registry: its advisories are as of the run');
  // The same advisory on the same package is the same finding at another version; another advisory is not.
  const again = readNpmAudit(await fixture('npm-audit.json'), { lockfile: { packages: { 'node_modules/lodash': { version: '4.17.19' } } } });
  assert.equal(again.findings[0].installedVersion, '4.17.19');
  assert.equal(again.findings[0].fingerprint, report.findings[0].fingerprint);
  assert.notEqual(report.findings[0].fingerprint, report.findings[2].fingerprint);
  // A registry npm cannot reach, or no lockfile, is the tool's error: no report to read, so the audit is unavailable.
  const offline = JSON.parse(await fixture('npm-audit-offline.json'));
  assert.throws(() => readNpmAudit(offline), { code: 'FINDING_REPORT_UNREADABLE', message: /ECONNREFUSED/u });
  assert.throws(() => readNpmAudit({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }), /ENOLOCK: This command requires an existing lockfile/u);
  assert.throws(() => readNpmAudit({ auditReportVersion: 2 }), /neither vulnerabilities nor advisories/u);
});

test('pnpm audit, pip-audit, osv-scanner and dependency-check read into the same shape, each in its documented format', async () => {
  const pnpm = readFindingReport('pnpm-audit', await fixture('pnpm-audit.json'), {});
  assert.deepEqual(pnpm.findings.map((finding) => [finding.tool, finding.package, finding.installedVersion, finding.fixedVersion, finding.rule, finding.cve, finding.severity]), [
    ['pnpm-audit', 'minimist', '1.2.5', '1.2.6', 'GHSA-xvch-5gv4-984h', 'CVE-2021-44906', 'critical'],
    ['pnpm-audit', 'lodash', '4.17.20', '4.17.21', 'GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337', 'high'],
    ['pnpm-audit', 'lodash', '4.17.20', '4.17.21', 'GHSA-29mw-wpgm-hmr9', 'CVE-2020-28500', 'medium']]);

  const pip = readPipAudit(await fixture('pip-audit.json'), { file: 'requirements.txt' });
  // pip-audit names no severity: a known advisory reads as high, for a person to look at.
  assert.deepEqual(pip.findings.map((finding) => [finding.package, finding.installedVersion, finding.fixedVersion, finding.rule, finding.cve, finding.severity]), [
    ['requests', '2.31.0', '2.32.0', 'GHSA-9wx4-h78v-vm56', 'CVE-2024-35195', 'high'], ['Jinja2', '3.1.2', '3.1.3', 'PYSEC-2024-36', 'CVE-2024-22195', 'high']]);
  assert.equal(pip.skipped, 1, 'a package it could not audit is counted, not a finding');

  const osv = readOsvScanner(await fixture('osv-scanner.json'), { paths: repositoryPaths({ bases: [{ absolute: '/home/runner/work/app/app', relative: '.' }] }) });
  assert.deepEqual(osv.findings.map((finding) => [finding.file, finding.package, finding.installedVersion, finding.fixedVersion, finding.rule, finding.cve, finding.severity]), [
    ['package-lock.json', 'minimist', '1.2.5', '1.2.6', 'GHSA-xvch-5gv4-984h', 'CVE-2021-44906', 'critical'],
    ['requirements.txt', 'requests', '2.31.0', '2.32.0', 'GHSA-9wx4-h78v-vm56', 'CVE-2024-35195', 'medium']], 'the fix is the range the installed version is in');

  const owasp = readDependencyCheck(await fixture('dependency-check.json'));
  assert.deepEqual(owasp.findings.map((finding) => [finding.package, finding.installedVersion, finding.fixedVersion, finding.rule, finding.cve, finding.severity, finding.toolVersion]), [
    ['org.apache.logging.log4j:log4j-core', '2.14.1', '2.15.0', 'CVE-2021-44228', 'CVE-2021-44228', 'critical', '10.0.4']]);
  // Its database is a local NVD copy: the report's data sources say when it was last updated.
  assert.deepEqual(owasp.database, { live: false, updatedAt: '2026-10-20T07:58:03.000Z' });

  assert.deepEqual(purlPackage('pkg:npm/%40scope/name@1.0.0'), { ecosystem: 'npm', name: '@scope/name', version: '1.0.0' });
  assert.deepEqual([advisorySeverity('moderate'), advisorySeverity('CRITICAL'), advisorySeverity('7.5'), advisorySeverity(9.8), advisorySeverity(null)],
    ['medium', 'critical', 'high', 'critical', null]);
});

test('an audit command names its reader; npm and pnpm print their report, which SFlow writes to the report path', () => {
  const npm = normalizeExternalCommand({ id: 'npm-audit', kind: 'security', modelPolicy: 'never', argv: ['npm', 'audit', '--json'],
    result: { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json' } });
  assert.deepEqual(npm.result, { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json', from: 'stdout' });
  assert.equal(findingCommand(npm), true);
  const pip = normalizeExternalCommand({ id: 'pip-audit', kind: 'security', argv: ['pip-audit', '-f', 'json', '-o', '.sflow/results/pip.json'],
    result: { adapter: 'pip-audit', path: '.sflow/results/pip.json' } });
  assert.deepEqual(pip.result, { adapter: 'pip-audit', path: '.sflow/results/pip.json' }, 'a tool that writes a file is read from it');
  assert.equal(normalizeExternalCommand({ id: 'osv', kind: 'security', argv: ['osv-scanner', '--format', 'json', '-r', '.'],
    result: { adapter: 'osv-scanner', path: '.sflow/results/osv.json', from: 'stdout' } }).result.from, 'stdout');
  assert.throws(() => normalizeExternalCommand({ id: 'npm', kind: 'security', argv: ['npm', 'audit', '--json'], result: { adapter: 'npm-audit', path: '.sflow/results/a.json', from: 'file' } }),
    { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
  assert.throws(() => normalizeExternalCommand({ id: 'x', kind: 'security', argv: ['x'], result: { adapter: 'dependency-check', path: '.sflow/results/a.json', from: 'pipe' } }),
    { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
});

test('every manifest and lockfile names its packages, versions and ranges', () => {
  const names = (relative, text) => Object.fromEntries([...manifestInventory(relative, text)].map(([key, entry]) => [key, [[...entry.versions].sort(), [...entry.specs].sort()]]));
  assert.deepEqual(names('package.json', JSON.stringify({ dependencies: { lodash: '^4.17.20' }, devDependencies: { '@scope/tool': '1.0.0' } })),
    { lodash: [[], ['^4.17.20']], '@scope/tool': [[], ['1.0.0']] });
  assert.deepEqual(names('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, 'apps/web': { name: 'web' },
    'node_modules/a': { version: '1.0.0' }, 'node_modules/a/node_modules/b': { version: '2.0.0' }, 'node_modules/web': { link: true } } })),
  { a: [['1.0.0'], []], b: [['2.0.0'], []] }, 'the project, a workspace and a link are not dependencies');
  assert.deepEqual(names('package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } } })),
    { a: [['1.0.0'], []], b: [['2.0.0'], []] });
  assert.deepEqual(names('pnpm-lock.yaml', ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:', '      lodash:', "        specifier: ^4.17.20", '        version: 4.17.20',
    'packages:', '  lodash@4.17.20:', '    resolution: {integrity: sha512-x}', "  '@scope/x@1.0.0':", '    resolution: {integrity: sha512-y}', ''].join('\n')),
  { lodash: [['4.17.20'], ['^4.17.20']], '@scope/x': [['1.0.0'], []] });
  assert.deepEqual(names('pnpm-lock.yaml', ["lockfileVersion: 5.4", 'packages:', '  /lodash/4.17.20:', '    dev: false', ''].join('\n')), { lodash: [['4.17.20'], []] });
  assert.deepEqual(names('yarn.lock', ['# yarn lockfile v1', '', '"lodash@^4.17.0", lodash@^4.17.20:', '  version "4.17.20"', '', '"@babel/core@^7.0.0":', '  version "7.1.0"', ''].join('\n')),
    { lodash: [['4.17.20'], []], '@babel/core': [['7.1.0'], []] });
  assert.deepEqual(names('requirements-dev.txt', ['# pinned', 'requests==2.31.0', 'Jinja2>=3.1  # templates', '-r base.txt', 'flask[async]==3.0.0 ; python_version > "3.8"', ''].join('\n')),
    { requests: [['2.31.0'], ['==2.31.0']], jinja2: [[], ['>=3.1']], flask: [['3.0.0'], ['==3.0.0']] });
  assert.deepEqual(names('pyproject.toml', ['[project]', 'authors = ["A Person"]', 'dependencies = [', '  "requests>=2.31",', '  "rich",', ']', '[project.optional-dependencies]',
    'dev = ["pytest>=8"]', '[tool.poetry.dependencies]', 'python = "^3.11"', 'httpx = "^0.27"', 'pydantic = { version = "^2.5", extras = ["email"] }', ''].join('\n')),
  { requests: [[], ['>=2.31']], rich: [[], []], pytest: [[], ['>=8']], httpx: [[], ['^0.27']], pydantic: [[], ['^2.5']] }, 'authors are not packages');
  assert.deepEqual(names('poetry.lock', ['[[package]]', 'name = "requests"', 'version = "2.31.0"', '', '[[package]]', 'name = "idna"', 'version = "3.7"', ''].join('\n')),
    { requests: [['2.31.0'], []], idna: [['3.7'], []] });
  assert.deepEqual(names('pom.xml', '<project><dependencies><dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency></dependencies></project>'),
    { 'org-apache-logging-log4j:log4j-core': [['2.14.1'], ['2.14.1']] });
  assert.deepEqual(names('build.gradle', "dependencies {\n  implementation 'org.apache.commons:commons-text:1.9'\n}\n"), { 'org-apache-commons:commons-text': [['1.9'], []] });
  assert.deepEqual(names('go.mod', 'module example.com/app\n\nrequire (\n\tgolang.org/x/net v0.17.0\n)\nrequire example.test/a/b v1.2.3\n'),
    { 'golang-org/x/net': [['0.17.0'], []], 'example-test/a/b': [['1.2.3'], []] });
  assert.equal(dependencyKey('Jinja_2.x'), dependencyKey('jinja-2-x'), 'PyPI names compare as PyPI compares them');
  assert.deepEqual([auditsManifest('npm-audit', 'apps/web/package-lock.json'), auditsManifest('npm-audit', 'requirements.txt'), auditsManifest('pip-audit', 'requirements/prod-requirements.txt'),
    auditsManifest('pip-audit', 'requirements-dev.txt'), auditsManifest('osv-scanner', 'go.mod'), auditsManifest('dependency-check', 'pom.xml'), auditsManifest('pnpm-audit', 'src/app.js')],
  [true, false, true, true, true, true, false]);
});

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A repository whose base has lodash 4.17.21 and minimist 1.2.8; `head` writes the Story's manifests. */
async function storyRepository(t, head) {
  const root = await directory(t, 'sflow-dependency-changes-');
  git(root, 'init', '-q', '-b', 'main');
  const lock = (packages) => JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' },
    ...Object.fromEntries(Object.entries(packages).map(([name, version]) => [`node_modules/${name}`, { version }])) } }, null, 2);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.21', minimist: '1.2.8' } }, null, 2));
  await writeFile(path.join(root, 'package-lock.json'), lock({ lodash: '4.17.21', minimist: '1.2.8' }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/app.js'), 'export const app = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  const entries = await head({ root, lock });
  return { root, base, workflow: { workItem: { id: 'DEP-1' }, workIntervals: { current: { sourceBaseCommit: base } } },
    changeSet: { entries: entries.map((newPath) => ({ newPath, oldPath: newPath, status: 'modified' })) } };
}

test('a dependency finding is new code only when the Story added the package or changed its version [CQF:REQ-050]', async (t) => {
  const story = await storyRepository(t, async ({ root, lock }) => {
    // The Story downgrades lodash, adds left-pad, and leaves minimist as it was.
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.20', minimist: '1.2.8', 'left-pad': '1.3.0' } }, null, 2));
    await writeFile(path.join(root, 'package-lock.json'), lock({ lodash: '4.17.20', minimist: '1.2.8', 'left-pad': '1.3.0' }));
    return ['package.json', 'package-lock.json'];
  });
  const changes = storyDependencyChanges(story.root, story.workflow, story.changeSet);
  assert.deepEqual(changes.manifests, ['package-lock.json', 'package.json']);
  assert.deepEqual([auditedManifests(changes, 'npm-audit'), auditedManifests(changes, 'pip-audit')], [['package-lock.json', 'package.json'], []]);
  const finding = (name, version) => createFinding({ tool: 'npm-audit', kind: 'dependency', package: name, installedVersion: version, advisory: `GHSA-${name}`, severity: 'critical' });
  const marked = markNewDependencies([finding('lodash', '4.17.20'), finding('minimist', '1.2.8'), finding('left-pad', '1.3.0'), finding('not-here', '1.0.0'),
    createFinding({ tool: 'eslint', rule: 'no-eval', file: 'src/app.js', line: 1 })], changes);
  assert.deepEqual(marked.map((entry) => [entry.package ?? entry.rule, entry.newCode]),
    [['lodash', true], ['minimist', false], ['left-pad', true], ['not-here', false], ['no-eval', false]], 'only the changed and added packages; code findings are left as they are');

  // A manifest the base did not have: every package in it is the Story's.
  const added = await storyRepository(t, async ({ root }) => {
    await mkdir(path.join(root, 'service'));
    await writeFile(path.join(root, 'service/requirements.txt'), 'requests==2.31.0\n');
    return ['service/requirements.txt'];
  });
  const python = storyDependencyChanges(added.root, added.workflow, { entries: [{ newPath: 'service/requirements.txt', status: 'added' }] });
  assert.deepEqual(markNewDependencies([createFinding({ tool: 'pip-audit', kind: 'dependency', package: 'Requests', installedVersion: '2.31.0', advisory: 'PYSEC-1', severity: 'high' })], python)
    .map((entry) => entry.newCode), [true]);
  assert.deepEqual(auditedManifests(python, 'npm-audit'), [], 'npm audit has nothing new to read here');
});

/** The findings loop's kernel, with each command's run replaced by writing its recorded report. */
function recordedKernel(reports) {
  const ran = [];
  return {
    ran, generation: 1, sourceTreeHash: async () => 'tree-1', testInputTreeHash: async () => null,
    qualityChecks: async (root, phase, config, workflow, commands) => Promise.all(commands.map(async (command) => {
      ran.push(command.id);
      await mkdir(path.join(root, '.sflow/results'), { recursive: true });
      await writeFile(path.join(root, command.result.path), reports[command.id]);
      const at = new Date().toISOString();
      return { id: command.id, status: 'failed', exitCode: 1, startedAt: at, completedAt: at };
    }))
  };
}

test('in the publish check an audit runs only on a changed manifest, and its findings on new packages never send the code step back [CQF:REQ-050]', async (t) => {
  const story = await storyRepository(t, async ({ root, lock }) => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.20', minimist: '1.2.5' } }, null, 2));
    await writeFile(path.join(root, 'package-lock.json'), lock({ lodash: '4.17.20', minimist: '1.2.5', 'left-pad': '1.3.0' }));
    return ['package.json', 'package-lock.json'];
  });
  const npm = { id: 'npm-audit', kind: 'security', modelPolicy: 'never', argv: [process.execPath, '-e', ''], result: { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json' } };
  const pip = { id: 'pip-audit', kind: 'security', modelPolicy: 'never', argv: [process.execPath, '-e', ''], result: { adapter: 'pip-audit', path: '.sflow/results/pip-audit.json' } };
  const workflow = { ...story.workflow, phaseOrder: ['implementation'], resolution: { approvalAuthorities: {} }, phases: {} };
  const phase = { id: 'implementation', qualityCommands: [npm, pip] };
  workflow.phases.implementation = phase;
  const kernel = recordedKernel({ 'npm-audit': await fixture('npm-audit.json'), 'pip-audit': await fixture('pip-audit.json') });
  const evidence = await publishCheckFindings(story.root, {}, workflow, phase, { changeSet: story.changeSet }, kernel);
  assert.deepEqual(kernel.ran, ['npm-audit'], 'no Python manifest changed, so pip-audit had nothing new to read');
  assert.deepEqual(evidence.commands.map((command) => [command.id, command.status]), [['npm-audit', 'read'], ['pip-audit', 'not-needed']]);
  assert.equal(evidence.outcome, 'passed', 'a vulnerable package is no finding to repair in the loop');
  assert.equal(evidence.counts.counted, 0);
  const held = evidence.dependencies.held.map((fingerprint) => evidence.findings.find((finding) => finding.fingerprint === fingerprint));
  assert.deepEqual(held.map((finding) => [finding.package, finding.installedVersion, finding.rule, finding.severity]).sort(), [
    ['lodash', '4.17.20', 'GHSA-35jh-r3h4-6jhm', 'high'], ['lodash', '4.17.20', 'GHSA-r5fr-rjxr-66jc', 'high'], ['minimist', '1.2.5', 'GHSA-xvch-5gv4-984h', 'critical']]);
  assert.equal(held[0].package, 'minimist', 'the most severe first');
  assert.equal(evidence.dependencies.warned.length, 2, 'the two moderate advisories warn');
  assert.deepEqual(evidence.dependencies.manifests, ['package-lock.json', 'package.json']);
  assert.equal(evidence.commands[0].database.live, true);
  assert.equal(evidence.commands[0].database.stale, false);
  const summary = publishedFindingsSummary(evidence);
  assert.match(summary.words, /^3 known vulnerabilities in packages this Story added or upgraded hold the step's approval until upgraded or accepted by a person \(minimist@1\.2\.5 GHSA-xvch-5gv4-984h; lodash@4\.17\.20 GHSA-/u);
  assert.deepEqual(summary.held.map((finding) => finding.fixedVersion), ['1.2.8', '4.18.1', '4.18.1']);

  // A database more than a week old informs.
  const owasp = { id: 'dependency-check', kind: 'security', modelPolicy: 'never', argv: [process.execPath, '-e', ''], result: { adapter: 'dependency-check', path: '.sflow/results/dc.json' } };
  const late = await publishCheckFindings(story.root, {}, workflow, { ...phase, qualityCommands: [owasp] }, { changeSet: story.changeSet },
    recordedKernel({ 'dependency-check': await fixture('dependency-check.json') }));
  assert.deepEqual([late.commands[0].database.updatedAt, late.commands[0].database.stale], ['2026-10-20T07:58:03.000Z', true]);
  assert.match(publishedFindingsSummary(late).words, /the advisory database of dependency-check is more than 7 days old/u);
  // newDependencyFindings counts only new packages; an existing one is shown and counts for nothing.
  const outcome = { results: [{ command: normalizeExternalCommand(npm), findings: [createFinding({ tool: 'npm-audit', kind: 'dependency', package: 'a', advisory: 'GHSA-a', severity: 'critical' })] }] };
  assert.deepEqual(newDependencyFindings(workflow, phase, outcome), { held: [], accepted: [], warned: [] });
});
