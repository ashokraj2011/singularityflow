/**
 * SARIF 2.1.0 → findings [CQF:REQ-040]: CodeQL's `--format=sarif-latest`, semgrep `--sarif`, and any
 * other analyser that writes SARIF.
 *
 * Severity comes from a rule's `security-severity` (the CVSS-style score CodeQL and GitHub use) when it
 * has one, else from the result's level. A result the tool itself reports as suppressed, or as absent
 * from its baseline, is not a finding here; the count says how many there were.
 */
import { createFinding, findingMessage, MAX_FINDINGS_PER_REPORT, snippetSha256 } from '../model.mjs';
import { digestOf, readerError, reportJson, repositoryPaths } from './common.mjs';

const LEVEL_SEVERITY = Object.freeze({ error: 'high', warning: 'medium', note: 'low', none: 'info' });

/** CVSS-style score (0–10) → severity, as GitHub code scanning reads `security-severity`. */
export function securityScoreSeverity(score) {
  const value = Number(score);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 9 ? 'critical' : value >= 7 ? 'high' : value >= 4 ? 'medium' : 'low';
}

function ruleKind(rule, level, scored) {
  const tags = (rule?.properties?.tags ?? []).map((tag) => String(tag).toLowerCase());
  if (scored || tags.includes('security') || tags.some((tag) => tag.startsWith('external/cwe/'))) return 'vulnerability';
  if (tags.some((tag) => /complexity/u.test(tag))) return 'complexity';
  if (tags.some((tag) => /duplicat/u.test(tag))) return 'duplication';
  if (tags.some((tag) => ['correctness', 'reliability', 'bug'].includes(tag))) return 'bug';
  return level === 'error' ? 'bug' : 'code-smell';
}

function resultRule(run, result) {
  const driverRules = run.tool?.driver?.rules ?? [];
  if (Number.isInteger(result.ruleIndex) && driverRules[result.ruleIndex]) return driverRules[result.ruleIndex];
  const reference = result.rule ?? {};
  if (Number.isInteger(reference.toolComponent?.index)) {
    const extension = run.tool?.extensions?.[reference.toolComponent.index];
    if (Number.isInteger(reference.index) && extension?.rules?.[reference.index]) return extension.rules[reference.index];
  }
  if (Number.isInteger(reference.index) && driverRules[reference.index]) return driverRules[reference.index];
  const id = result.ruleId ?? reference.id;
  return driverRules.find((rule) => rule.id === id)
    ?? (run.tool?.extensions ?? []).flatMap((extension) => extension.rules ?? []).find((rule) => rule.id === id) ?? null;
}

/** The rules and packs a run used: its ruleset's identity, apart from the code it read. */
export function sarifRulesetSha256(run) {
  const component = (entry) => ({ name: entry?.name ?? null, version: entry?.semanticVersion ?? entry?.version ?? null,
    rules: (entry?.rules ?? []).map((rule) => rule.id).filter(Boolean).sort() });
  return digestOf({ driver: component(run.tool?.driver), extensions: (run.tool?.extensions ?? []).map(component)
    .sort((left, right) => String(left.name).localeCompare(String(right.name))) });
}

/**
 * Read a SARIF log. `paths` turns reported locations into repository paths (common.repositoryPaths);
 * `source` names the command or source the findings came from.
 */
export function readSarif(value, { source = null, feed = 'quality', paths = repositoryPaths(), toolName = null } = {}) {
  const log = reportJson(value, 'SARIF');
  if (!Array.isArray(log?.runs)) throw readerError('SARIF report has no runs.');
  const findings = [];
  const tools = [];
  let suppressed = 0;
  let omitted = 0;
  for (const run of log.runs) {
    const driver = run?.tool?.driver ?? {};
    const tool = toolName ?? (String(driver.name ?? 'sarif').trim() || 'sarif');
    const toolVersion = driver.semanticVersion ?? driver.version ?? null;
    const rulesetSha256 = sarifRulesetSha256(run);
    tools.push({ tool, toolVersion, rulesetSha256 });
    const artifacts = run.artifacts ?? [];
    const baseIds = run.originalUriBaseIds ?? {};
    for (const result of run.results ?? []) {
      if ((result.suppressions ?? []).some((entry) => !entry?.status || entry.status === 'accepted')
          || result.baselineState === 'absent') { suppressed += 1; continue; }
      if (findings.length >= MAX_FINDINGS_PER_REPORT) { omitted += 1; continue; }
      const rule = resultRule(run, result);
      const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
      const scored = securityScoreSeverity(rule?.properties?.['security-severity']);
      const location = result.locations?.[0]?.physicalLocation ?? {};
      const artifact = location.artifactLocation ?? {};
      let uri = artifact.uri ?? (Number.isInteger(artifact.index) ? artifacts[artifact.index]?.location?.uri : null);
      // A uri relative to a base the log names (%SRCROOT% and the like) is joined to that base's own uri.
      const base = artifact.uriBaseId ? baseIds[artifact.uriBaseId]?.uri : null;
      if (uri && base && !/^[a-z]+:/iu.test(uri)) uri = `${String(base).replace(/\/?$/u, '/')}${uri}`;
      const region = location.region ?? {};
      const snippet = region.snippet?.text ?? location.contextRegion?.snippet?.text ?? null;
      const message = result.message?.text ?? rule?.shortDescription?.text ?? rule?.id ?? '';
      findings.push(createFinding({
        feed, source: source ?? tool, tool, toolVersion, rulesetSha256,
        rule: result.ruleId ?? rule?.id ?? null,
        severity: scored ?? LEVEL_SEVERITY[level] ?? 'medium',
        kind: ruleKind(rule, level, Boolean(scored)),
        file: uri ? paths(uri) : null, line: region.startLine, endLine: region.endLine ?? region.startLine,
        // The tool's own location hash stands in for a snippet it did not include.
        snippet: snippetSha256(snippet) ?? (result.partialFingerprints?.primaryLocationLineHash
          ? `sarif-line:${result.partialFingerprints.primaryLocationLineHash}` : null),
        message: findingMessage(message)
      }));
    }
  }
  return { tools, findings, suppressed, omitted };
}
