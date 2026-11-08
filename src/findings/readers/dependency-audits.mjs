/**
 * Dependency audits → findings [CQF:REQ-050]: `npm audit --json`, `pnpm audit --json`, `pip-audit -f
 * json`, `osv-scanner --format json` and OWASP dependency-check's JSON report. Each advisory against an
 * installed package is one finding of kind `dependency`, feed `security`, with its package, installed
 * version, the version that fixes it when the tool says, its CVE when the tool names one, and its
 * severity. Its fingerprint is the tool, the package and the advisory (src/findings/model.mjs), so the
 * same advisory on the same package is the same finding at any version.
 *
 * Whether a finding is new code is not the reader's: it is whether this Story added the package or
 * changed its version (src/findings/dependency-changes.mjs). A report that says the tool could not
 * reach its database is unreadable, so the audit is recorded as unavailable and blocks nothing
 * [decision 11]. `database` says when the advisories were current: the run itself for a tool that
 * asks its service live, the report's own data-source dates for dependency-check.
 */
import { createFinding, findingMessage, MAX_FINDINGS_PER_REPORT } from '../model.mjs';
import { securityScoreSeverity } from './sarif.mjs';
import { readerError, reportJson, repositoryPaths } from './common.mjs';

const WORDS = Object.freeze({ critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', info: 'info', none: 'info', negligible: 'info' });

/** A tool's severity word, or a CVSS score, as the shared severities; null when it gives neither. */
export function advisorySeverity(value) {
  if (value == null || value === '') return null;
  const word = WORDS[String(value).trim().toLowerCase()];
  return word ?? securityScoreSeverity(value);
}

const ghsa = (value) => String(value ?? '').match(/GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/u)?.[0] ?? null;
const cveOf = (values) => [values].flat().map((entry) => String(entry ?? '').match(/CVE-\d{4}-\d{4,}/u)?.[0]).find(Boolean) ?? null;

function bounded(findings, finding) {
  if (findings.length >= MAX_FINDINGS_PER_REPORT) return false;
  findings.push(finding);
  return true;
}

function dependencyFinding(context, fields) {
  return createFinding({ feed: 'security', source: context.source ?? fields.tool, kind: 'dependency', toolVersion: context.toolVersion ?? null,
    rulesetSha256: context.rulesetSha256 ?? null, line: null, ...fields, message: findingMessage(fields.message) });
}

/** A report that is the tool's own error: no advisories were read, so the audit could not run here. */
function auditError(report, label) {
  const error = report?.error;
  if (!error) return;
  // npm names a lockfile it needs in the error; a registry it cannot reach only in the message beside it.
  const text = typeof error === 'string' ? error : [error.code, error.summary, report.message].filter(Boolean).join(': ') || 'no reason given';
  throw readerError(`${label} could not read its advisories: ${findingMessage(text).slice(0, 240)}`);
}

/**
 * npm audit's report. `--json` from npm 7 on names each vulnerable package with the advisories it
 * matches (`vulnerabilities[name].via`); npm 6 and pnpm write the older `advisories` form, with the
 * installed versions under `findings`. npm 7's report omits the installed version: `lockfile` (the
 * parsed package-lock.json the audit read) supplies it from the package's install path.
 */
export function readNpmAudit(value, { source = null, tool = 'npm-audit', toolVersion = null, rulesetSha256 = null, lockfile = null, file = null } = {}) {
  const report = reportJson(value, 'npm audit');
  auditError(report, tool === 'pnpm-audit' ? 'pnpm audit' : 'npm audit');
  const context = { source, toolVersion, rulesetSha256 };
  const findings = [];
  let omitted = 0;
  if (report?.advisories && typeof report.advisories === 'object') {
    for (const advisory of Object.values(report.advisories)) {
      const versions = [...new Set((advisory?.findings ?? []).map((entry) => entry?.version).filter(Boolean))];
      for (const installed of versions.length ? versions : [null]) {
        const advisoryId = advisory.github_advisory_id ?? ghsa(advisory.url) ?? (advisory.id != null ? `npm-${advisory.id}` : null);
        if (!bounded(findings, dependencyFinding(context, { tool, file, package: advisory.module_name, installedVersion: installed,
          fixedVersion: /^>=\s*(\S+)$/u.exec(String(advisory.patched_versions ?? '').trim())?.[1] ?? null,
          cve: cveOf(advisory.cves ?? []), advisory: advisoryId, rule: advisoryId,
          severity: advisorySeverity(advisory.severity) ?? 'high', message: advisory.title ?? advisory.overview ?? advisoryId, url: advisory.url ?? null }))) omitted += 1;
      }
    }
    return { tools: [{ tool, toolVersion, rulesetSha256 }], findings, suppressed: (report.muted ?? []).length, omitted, database: { live: true, updatedAt: null } };
  }
  if (!report?.vulnerabilities || typeof report.vulnerabilities !== 'object') throw readerError('npm audit report has neither vulnerabilities nor advisories.');
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    const installed = [...new Set((entry?.nodes ?? []).map((node) => lockfile?.packages?.[node]?.version ?? lockfile?.dependencies?.[name]?.version).filter(Boolean))];
    const fix = entry?.fixAvailable && typeof entry.fixAvailable === 'object' && entry.fixAvailable.name === name ? entry.fixAvailable.version ?? null : null;
    // A `via` that is a name says this package is affected through another; that one carries the advisory.
    for (const via of (entry?.via ?? []).filter((item) => item && typeof item === 'object')) {
      const advisoryId = ghsa(via.url) ?? (via.source != null ? `npm-${via.source}` : null);
      for (const version of installed.length ? installed : [null]) {
        if (!bounded(findings, dependencyFinding(context, { tool, file, package: via.name ?? via.dependency ?? name, installedVersion: version,
          fixedVersion: fix, advisory: advisoryId, rule: advisoryId, cve: cveOf([via.cve, via.title]),
          severity: advisorySeverity(via.severity ?? entry.severity) ?? advisorySeverity(via.cvss?.score) ?? 'high',
          message: via.title ?? advisoryId, url: via.url ?? null }))) omitted += 1;
      }
    }
  }
  return { tools: [{ tool, toolVersion, rulesetSha256 }], findings, suppressed: 0, omitted, database: { live: true, updatedAt: null } };
}

/**
 * pip-audit's `-f json` report: each dependency with its version and the advisories against it. It
 * names no severity, so an advisory reads as high: a known vulnerability in a package the Story added
 * is a person's to look at [decision 9].
 */
export function readPipAudit(value, { source = null, toolVersion = null, rulesetSha256 = null, file = null } = {}) {
  const report = reportJson(value, 'pip-audit');
  const dependencies = Array.isArray(report) ? report : report?.dependencies;
  if (!Array.isArray(dependencies)) throw readerError('pip-audit report has no dependencies.');
  const context = { source, toolVersion, rulesetSha256 };
  const findings = [];
  let omitted = 0;
  let skipped = 0;
  for (const dependency of dependencies) {
    if (dependency?.skip_reason) { skipped += 1; continue; }
    for (const vulnerability of dependency?.vulns ?? []) {
      const aliases = vulnerability.aliases ?? [];
      if (!bounded(findings, dependencyFinding(context, { tool: 'pip-audit', file, package: dependency.name, installedVersion: dependency.version,
        fixedVersion: (vulnerability.fix_versions ?? [])[0] ?? null, advisory: vulnerability.id, rule: vulnerability.id, cve: cveOf([vulnerability.id, ...aliases]),
        severity: advisorySeverity(vulnerability.severity) ?? 'high',
        message: vulnerability.description ? `${vulnerability.id}: ${vulnerability.description}` : vulnerability.id }))) omitted += 1;
    }
  }
  return { tools: [{ tool: 'pip-audit', toolVersion, rulesetSha256 }], findings, suppressed: 0, omitted, skipped, database: { live: true, updatedAt: null } };
}

/** Dotted versions compared part by part, numbers as numbers; enough to place a version in a range. */
function compareVersions(left, right) {
  const parts = (value) => String(value ?? '').replace(/^v/u, '').split(/[.+-]/u);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const [x, y] = [a[index] ?? '0', b[index] ?? '0'];
    const order = /^\d+$/u.test(x) && /^\d+$/u.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (order) return Math.sign(order);
  }
  return 0;
}

/** The version an OSV advisory's ranges name as fixing `installed` of `name`: the range it falls in, else the last fix named. */
function osvFixedVersion(vulnerability, name, installed) {
  let last = null;
  for (const affected of vulnerability?.affected ?? []) {
    if (affected?.package?.name && affected.package.name !== name) continue;
    for (const range of affected?.ranges ?? []) {
      let introduced = '0';
      for (const event of range?.events ?? []) {
        if (event?.introduced != null) introduced = String(event.introduced);
        if (event?.fixed == null) continue;
        last = String(event.fixed);
        if (installed && compareVersions(introduced, installed) <= 0 && compareVersions(installed, event.fixed) < 0) return last;
      }
    }
  }
  return last;
}

function osvSeverity(vulnerability, group) {
  return advisorySeverity(group?.max_severity) ?? advisorySeverity(vulnerability?.database_specific?.severity)
    ?? (vulnerability?.affected ?? []).map((entry) => advisorySeverity(entry?.database_specific?.severity) ?? advisorySeverity(entry?.ecosystem_specific?.severity)).find(Boolean)
    ?? null;
}

/**
 * osv-scanner's `--format json` report: per source file (a lockfile or manifest), each package with
 * its advisories. Aliases of one vulnerability (a GHSA, a CVE, an ecosystem ID) are grouped by the
 * tool; each group is one finding, named by its GHSA when it has one.
 */
export function readOsvScanner(value, { source = null, toolVersion = null, rulesetSha256 = null, paths = repositoryPaths() } = {}) {
  const report = reportJson(value, 'osv-scanner');
  if (!Array.isArray(report?.results)) throw readerError('osv-scanner report has no results.');
  const context = { source, toolVersion, rulesetSha256 };
  const findings = [];
  let omitted = 0;
  for (const result of report.results) {
    const file = result?.source?.path ? paths(result.source.path) : null;
    for (const entry of result?.packages ?? []) {
      const name = entry?.package?.name;
      const vulnerabilities = new Map((entry?.vulnerabilities ?? []).map((vulnerability) => [vulnerability.id, vulnerability]));
      const groups = entry?.groups?.length ? entry.groups : [...vulnerabilities.keys()].map((id) => ({ ids: [id] }));
      for (const group of groups) {
        const ids = [...(group.ids ?? []), ...(group.aliases ?? [])];
        const vulnerability = ids.map((id) => vulnerabilities.get(id)).find(Boolean) ?? null;
        const advisory = ids.find((id) => ghsa(id)) ?? ids[0] ?? null;
        if (!bounded(findings, dependencyFinding(context, { tool: 'osv-scanner', file, package: name, installedVersion: entry?.package?.version ?? null,
          fixedVersion: osvFixedVersion(vulnerability, name, entry?.package?.version ?? null), advisory, rule: advisory, cve: cveOf([...ids, ...(vulnerability?.aliases ?? [])]),
          severity: osvSeverity(vulnerability, group) ?? 'high', message: vulnerability?.summary || vulnerability?.details || advisory }))) omitted += 1;
      }
    }
  }
  return { tools: [{ tool: 'osv-scanner', toolVersion, rulesetSha256 }], findings, suppressed: 0, omitted, database: { live: true, updatedAt: null } };
}

/** A package URL (`pkg:maven/org.example/lib@1.2.3`) → its name as the manifests write it, and its version. */
export function purlPackage(purl) {
  const match = /^pkg:([a-z0-9.+-]+)\/(.+?)@([^?#]+)/iu.exec(String(purl ?? ''));
  if (!match) return null;
  const [, type, rawName, version] = match;
  const name = decodeURIComponent(rawName);
  // A Maven package is group:artifact in pom.xml and Gradle files; an npm scope keeps its @.
  return { ecosystem: type.toLowerCase(), name: type.toLowerCase() === 'maven' ? name.replace('/', ':') : name, version: decodeURIComponent(version) };
}

/**
 * OWASP dependency-check's JSON report (`--format JSON`): each scanned dependency with the packages it
 * was identified as and the vulnerabilities matched to it. Its advisory database is a local copy of
 * the NVD, whose last update the report's data sources state.
 */
export function readDependencyCheck(value, { source = null, toolVersion = null, rulesetSha256 = null, paths = repositoryPaths() } = {}) {
  const report = reportJson(value, 'dependency-check');
  if (!Array.isArray(report?.dependencies)) throw readerError('dependency-check report has no dependencies.');
  const context = { source, toolVersion: toolVersion ?? report.scanInfo?.engineVersion ?? null, rulesetSha256 };
  const findings = [];
  let omitted = 0;
  let suppressed = 0;
  for (const dependency of report.dependencies) {
    suppressed += (dependency?.suppressedVulnerabilities ?? []).length;
    const identified = (dependency?.packages ?? []).map((entry) => purlPackage(entry?.id)).find(Boolean) ?? null;
    const file = dependency?.filePath ? paths(dependency.filePath) : null;
    for (const vulnerability of dependency?.vulnerabilities ?? []) {
      const fixed = (vulnerability?.vulnerableSoftware ?? []).map((entry) => entry?.software?.versionEndExcluding).find(Boolean) ?? null;
      if (!bounded(findings, dependencyFinding(context, { tool: 'dependency-check', file, package: identified?.name ?? dependency.fileName,
        installedVersion: identified?.version ?? null, fixedVersion: fixed, advisory: vulnerability.name, rule: vulnerability.name, cve: cveOf(vulnerability.name),
        severity: advisorySeverity(vulnerability.severity) ?? advisorySeverity(vulnerability.cvssv3?.baseSeverity) ?? advisorySeverity(vulnerability.cvssv3?.baseScore)
          ?? advisorySeverity(vulnerability.cvssv2?.score) ?? 'high',
        message: vulnerability.description ? `${vulnerability.name}: ${vulnerability.description}` : vulnerability.name }))) omitted += 1;
    }
  }
  const dates = (report.scanInfo?.dataSource ?? []).map((entry) => Date.parse(entry?.timestamp ?? '')).filter(Number.isFinite);
  return { tools: [{ tool: 'dependency-check', toolVersion: context.toolVersion, rulesetSha256 }], findings, suppressed, omitted,
    database: { live: false, updatedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null } };
}
