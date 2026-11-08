/**
 * GitHub code scanning alerts → findings [CQF:REQ-049]: the response of
 * `GET /repos/{owner}/{repo}/code-scanning/alerts?ref=&tool_name=CodeQL&state=open`, one page or the
 * pages joined. CodeQL as the team runs it, in GitHub; the shape follows GitHub's documented response
 * and was read from recorded fixtures, not a live repository.
 *
 * Severity is the alert rule's `security_severity_level` when it has one, else its level. The identity
 * is the alert itself (GitHub tracks an alert across commits), so a later read finds the same finding.
 * A dismissed or fixed alert is not one; the count says how many there were.
 */
import { createFinding, MAX_FINDINGS_PER_REPORT } from '../model.mjs';
import { readerError, reportJson } from './common.mjs';

const RULE_LEVEL = Object.freeze({ error: 'high', warning: 'medium', note: 'low' });
const SECURITY_LEVEL = Object.freeze({ critical: 'critical', high: 'high', medium: 'medium', low: 'low' });

function alertKind(rule) {
  const tags = (rule?.tags ?? []).map((tag) => String(tag).toLowerCase());
  if (rule?.security_severity_level || tags.includes('security')) return 'vulnerability';
  if (tags.includes('correctness') || tags.includes('reliability')) return 'bug';
  return 'code-smell';
}

/**
 * Read alerts. `repository` (owner/name) keeps two repositories' alert numbers apart; `pages` may be
 * an array of pages (arrays) or one array. Returns the findings and the commits the alerts were
 * analysed on, the most common first.
 */
export function readCodeScanningAlerts(value, { source = 'codeql', repository = '', feed = 'quality', paths = null } = {}) {
  const parsed = reportJson(value, 'GitHub code scanning');
  const alerts = Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed.flat() : parsed;
  if (!Array.isArray(alerts)) throw readerError('GitHub code scanning response is not a list of alerts.');
  const findings = [];
  const commits = new Map();
  const tools = new Map();
  let closed = 0, omitted = 0;
  for (const alert of alerts) {
    if (alert?.state && alert.state !== 'open') { closed += 1; continue; }
    if (findings.length >= MAX_FINDINGS_PER_REPORT) { omitted += 1; continue; }
    const instance = alert?.most_recent_instance ?? {};
    const location = instance.location ?? {};
    const tool = String(alert?.tool?.name ?? 'CodeQL');
    const toolVersion = alert?.tool?.version ?? null;
    tools.set(`${tool}\u0000${toolVersion ?? ''}`, { tool, toolVersion, rulesetSha256: null });
    if (instance.commit_sha) commits.set(instance.commit_sha, (commits.get(instance.commit_sha) ?? 0) + 1);
    findings.push(createFinding({
      feed, source, tool, toolVersion, rule: alert?.rule?.id ?? null,
      severity: SECURITY_LEVEL[alert?.rule?.security_severity_level] ?? RULE_LEVEL[alert?.rule?.severity] ?? 'medium',
      kind: alertKind(alert?.rule),
      file: paths ? paths(location.path) : location.path, line: location.start_line, endLine: location.end_line ?? location.start_line,
      snippet: Number.isInteger(alert?.number) ? `github-alert:${repository}#${alert.number}` : null,
      message: instance.message?.text ?? alert?.rule?.description ?? alert?.rule?.id ?? '',
      ...(alert?.html_url ? { url: alert.html_url } : {})
    }));
  }
  return { tools: [...tools.values()], findings, closed, omitted,
    analysedCommits: [...commits.entries()].sort((left, right) => right[1] - left[1]).map(([commit]) => commit) };
}
