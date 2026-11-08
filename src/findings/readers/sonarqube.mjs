/**
 * SonarQube Web API responses → findings, measures and the quality gate [CQF:REQ-040, REQ-048]:
 *
 * - `api/issues/search`: bugs, vulnerabilities and code smells. SonarQube 10.x describes an issue by
 *   its impacts (software quality and severity) and still sends the older `type` and `severity`; the
 *   impacts win when present. Cognitive complexity (rule S3776) and cyclomatic complexity (S1541) are
 *   issues there, and are kind `complexity` here.
 * - `api/hotspots/search`: security hotspots, by their vulnerability probability.
 * - `api/measures/component`: complexity, cognitive complexity, duplicated lines density and new-code
 *   coverage, as numbers.
 * - `api/qualitygates/project_status`: the gate's status and conditions.
 *
 * What the server already settled is not a finding: won't fix, false positive and accepted issues,
 * and hotspots reviewed as safe or fixed. Each is counted as an exception [CQF:REQ-064].
 * Shapes follow the documented responses; they were read from recorded fixtures, not a live server.
 */
import { createFinding, MAX_FINDINGS_PER_REPORT, mostSevere } from '../model.mjs';
import { readerError, reportJson } from './common.mjs';

const IMPACT_SEVERITY = Object.freeze({ BLOCKER: 'blocker', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' });
const LEGACY_SEVERITY = Object.freeze({ BLOCKER: 'blocker', CRITICAL: 'critical', MAJOR: 'medium', MINOR: 'low', INFO: 'info' });
const TYPE_KIND = Object.freeze({ BUG: 'bug', VULNERABILITY: 'vulnerability', CODE_SMELL: 'code-smell', SECURITY_HOTSPOT: 'hotspot' });
const QUALITY_KIND = Object.freeze({ SECURITY: 'vulnerability', RELIABILITY: 'bug', MAINTAINABILITY: 'code-smell' });
const COMPLEXITY_RULE = /:(?:S3776|S1541|FunctionComplexity|ClassComplexity)$/u;
const DUPLICATION_RULE = /^common-[a-z]+:DuplicatedBlocks$/u;
const EXCEPTED_RESOLUTIONS = new Set(['WONTFIX', 'FALSE-POSITIVE']);
const EXCEPTED_STATUSES = new Set(['ACCEPTED', 'FALSE_POSITIVE']);
const CLOSED_STATUSES = new Set(['CLOSED', 'RESOLVED', 'FIXED']);
export const SONARQUBE_MEASURES = Object.freeze(['complexity', 'cognitive_complexity', 'duplicated_lines_density', 'new_coverage']);

/**
 * A component key's file path: the response's own `components[].path`, else the key after its project's
 * key and a colon. A Maven project's key is `groupId:artifactId` unless one is set, so the path starts
 * after the issue's `project`, not after the key's first colon.
 */
function componentPaths(response) {
  const byKey = new Map((response.components ?? []).filter((entry) => entry?.key).map((entry) => [entry.key, entry.path ?? null]));
  return (key, project = null) => {
    if (!key) return null;
    if (byKey.get(key)) return byKey.get(key);
    const text = String(key);
    if (project && text.startsWith(`${project}:`)) return text.slice(String(project).length + 1) || null;
    const at = text.indexOf(':');
    return at < 0 ? null : text.slice(at + 1);
  };
}

function issueSeverity(issue) {
  const impacts = (issue.impacts ?? []).map((impact) => IMPACT_SEVERITY[impact?.severity]).filter(Boolean);
  return mostSevere(impacts) ?? LEGACY_SEVERITY[issue.severity] ?? 'medium';
}

function issueKind(issue) {
  if (COMPLEXITY_RULE.test(String(issue.rule ?? ''))) return 'complexity';
  if (DUPLICATION_RULE.test(String(issue.rule ?? ''))) return 'duplication';
  if (TYPE_KIND[issue.type]) return TYPE_KIND[issue.type];
  const qualities = (issue.impacts ?? []).map((impact) => impact?.softwareQuality);
  return QUALITY_KIND[['SECURITY', 'RELIABILITY', 'MAINTAINABILITY'].find((quality) => qualities.includes(quality))] ?? 'code-smell';
}

const base = (context, extra = {}) => ({ feed: context.feed ?? 'quality', source: context.source ?? 'sonarqube', tool: 'sonarqube',
  toolVersion: context.toolVersion ?? null, rulesetSha256: context.rulesetSha256 ?? null, ...extra });

/** `api/issues/search` → findings. `paths` may map the server's file paths into this repository. */
export function readSonarqubeIssues(value, context = {}) {
  const response = reportJson(value, 'SonarQube issues');
  if (!Array.isArray(response?.issues)) throw readerError('SonarQube issues response has no issues list.');
  const fileOf = componentPaths(response);
  const findings = [];
  let excepted = 0, closed = 0, omitted = 0;
  for (const issue of response.issues) {
    if (EXCEPTED_RESOLUTIONS.has(issue.resolution) || EXCEPTED_STATUSES.has(issue.issueStatus)) { excepted += 1; continue; }
    if (CLOSED_STATUSES.has(issue.status) || CLOSED_STATUSES.has(issue.issueStatus)) { closed += 1; continue; }
    if (findings.length >= MAX_FINDINGS_PER_REPORT) { omitted += 1; continue; }
    const file = fileOf(issue.component, issue.project);
    findings.push(createFinding(base(context, {
      rule: issue.rule ?? null, severity: issueSeverity(issue), kind: issueKind(issue),
      file: context.paths ? context.paths(file) : file,
      line: issue.textRange?.startLine ?? issue.line, endLine: issue.textRange?.endLine ?? issue.line,
      // Sonar's own line hash is the snippet's identity across analyses.
      snippet: issue.hash ? `sonar-line:${issue.hash}` : null, message: issue.message,
      ...(context.serverUrl && issue.key ? { url: `${context.serverUrl.replace(/\/$/u, '')}/project/issues?open=${encodeURIComponent(issue.key)}` } : {})
    })));
  }
  return { tools: [{ tool: 'sonarqube', toolVersion: context.toolVersion ?? null, rulesetSha256: context.rulesetSha256 ?? null }],
    findings, excepted, closed, omitted, total: response.paging?.total ?? response.total ?? response.issues.length };
}

/** `api/hotspots/search` → findings of kind hotspot. */
export function readSonarqubeHotspots(value, context = {}) {
  const response = reportJson(value, 'SonarQube hotspots');
  if (!Array.isArray(response?.hotspots)) throw readerError('SonarQube hotspots response has no hotspots list.');
  const fileOf = componentPaths(response);
  const findings = [];
  let excepted = 0, omitted = 0;
  for (const hotspot of response.hotspots) {
    if (hotspot.status === 'REVIEWED' && ['SAFE', 'FIXED'].includes(hotspot.resolution)) { excepted += 1; continue; }
    if (findings.length >= MAX_FINDINGS_PER_REPORT) { omitted += 1; continue; }
    const file = fileOf(hotspot.component, hotspot.project);
    findings.push(createFinding(base(context, {
      rule: hotspot.ruleKey ?? hotspot.rule?.key ?? null,
      severity: { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }[hotspot.vulnerabilityProbability] ?? 'medium',
      kind: 'hotspot', file: context.paths ? context.paths(file) : file,
      line: hotspot.textRange?.startLine ?? hotspot.line, endLine: hotspot.textRange?.endLine ?? hotspot.line,
      message: hotspot.message,
      ...(context.serverUrl && hotspot.key ? { url: `${context.serverUrl.replace(/\/$/u, '')}/security_hotspots?hotspots=${encodeURIComponent(hotspot.key)}` } : {})
    })));
  }
  return { tools: [{ tool: 'sonarqube', toolVersion: context.toolVersion ?? null, rulesetSha256: context.rulesetSha256 ?? null }],
    findings, excepted, omitted, total: response.paging?.total ?? response.hotspots.length };
}

/**
 * `api/measures/component` → `{ metric: number }`. A new-code metric's value is under `period` (10.x)
 * or `periods[0]` (older servers); a metric the server did not send is absent.
 */
export function readSonarqubeMeasures(value) {
  const response = reportJson(value, 'SonarQube measures');
  const measures = response?.component?.measures;
  if (!Array.isArray(measures)) throw readerError('SonarQube measures response has no component measures.');
  const read = {};
  for (const measure of measures) {
    if (!SONARQUBE_MEASURES.includes(measure?.metric)) continue;
    const raw = measure.value ?? measure.period?.value ?? measure.periods?.[0]?.value;
    const number = Number(raw);
    if (raw != null && Number.isFinite(number)) read[measure.metric] = number;
  }
  return read;
}

/** `api/qualitygates/project_status` → `{ status, conditions }`: OK, WARN, ERROR or NONE. */
export function readSonarqubeQualityGate(value) {
  const response = reportJson(value, 'SonarQube quality gate');
  const status = response?.projectStatus?.status;
  if (!['OK', 'WARN', 'ERROR', 'NONE'].includes(status)) throw readerError('SonarQube quality gate response has no projectStatus.status.');
  return {
    // NONE: the project has no gate, which neither passes nor fails.
    status, passed: status === 'ERROR' ? false : status === 'NONE' ? null : true,
    conditions: (response.projectStatus.conditions ?? []).slice(0, 50).map((condition) => ({
      metric: String(condition.metricKey ?? ''), status: String(condition.status ?? ''),
      comparator: condition.comparator ?? null, threshold: condition.errorThreshold ?? null, actual: condition.actualValue ?? null
    }))
  };
}

/**
 * Any of the four responses, recognised by its shape: an export file or a recorded response read
 * without knowing which call made it. Returns `{ findings, measures, gate }` with what it held.
 */
export function readSonarqubeJson(value, context = {}) {
  const response = reportJson(value, 'SonarQube');
  if (Array.isArray(response?.issues)) return { ...readSonarqubeIssues(response, context), measures: null, gate: null };
  if (Array.isArray(response?.hotspots)) return { ...readSonarqubeHotspots(response, context), measures: null, gate: null };
  if (response?.component?.measures) return { tools: [], findings: [], measures: readSonarqubeMeasures(response), gate: null };
  if (response?.projectStatus) return { tools: [], findings: [], measures: null, gate: readSonarqubeQualityGate(response) };
  throw readerError('SonarQube response is none of issues, hotspots, measures or quality gate.');
}
