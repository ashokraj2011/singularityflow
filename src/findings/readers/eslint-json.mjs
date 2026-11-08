/**
 * ESLint `--format json` or `--format json-with-metadata` → findings [CQF:REQ-040]. With
 * `eslint-plugin-sonarjs` installed this is SonarQube's rules for JavaScript and TypeScript inside the
 * code step's loop [CQF:REQ-048].
 *
 * An error is high and a warning medium; a file ESLint could not parse is critical. The kind comes from
 * the rule: complexity and duplication rules by name, security rules by plugin or by Sonar's hotspot
 * rules, and otherwise the rule's own `meta.type` when the metadata format gives it.
 */
import { createFinding, MAX_FINDINGS_PER_REPORT, snippetSha256 } from '../model.mjs';
import { readerError, reportJson, repositoryPaths } from './common.mjs';

const COMPLEXITY_RULES = new Set(['complexity', 'max-depth', 'max-statements', 'max-lines-per-function', 'max-nested-callbacks',
  'max-params', 'sonarjs/cognitive-complexity', 'sonarjs/cyclomatic-complexity', 'sonarjs/nested-control-flow',
  'sonarjs/expression-complexity', 'sonarjs/max-switch-cases']);
const DUPLICATION_RULES = new Set(['sonarjs/no-duplicate-string', 'sonarjs/no-identical-functions']);
// Sonar reports these as security hotspots: code a person must review, not a proven vulnerability.
const HOTSPOT_RULES = new Set(['sonarjs/hashing', 'sonarjs/pseudo-random', 'sonarjs/os-command', 'sonarjs/no-os-command-from-path',
  'sonarjs/no-hardcoded-passwords', 'sonarjs/no-hardcoded-credentials', 'sonarjs/no-hardcoded-ip', 'sonarjs/insecure-cookie',
  'sonarjs/cookie-no-httponly', 'sonarjs/sql-queries', 'sonarjs/encryption', 'sonarjs/no-clear-text-protocols',
  'sonarjs/publicly-writable-directories', 'sonarjs/file-permissions', 'sonarjs/cors', 'sonarjs/csrf', 'sonarjs/regex-complexity',
  'sonarjs/slow-regex', 'sonarjs/no-ip-forward', 'sonarjs/content-length', 'sonarjs/xpath', 'sonarjs/code-eval']);
const SECURITY_RULES = new Set(['no-eval', 'no-implied-eval', 'no-new-func', 'no-script-url']);

export function eslintRuleKind(ruleId, meta = null) {
  const rule = String(ruleId ?? '');
  if (!rule) return 'bug';
  if (COMPLEXITY_RULES.has(rule)) return 'complexity';
  if (DUPLICATION_RULES.has(rule)) return 'duplication';
  if (HOTSPOT_RULES.has(rule)) return 'hotspot';
  if (SECURITY_RULES.has(rule) || /^(?:security|no-unsanitized|@microsoft\/sdl)\//u.test(rule)) return 'vulnerability';
  return meta?.type === 'problem' ? 'bug' : 'code-smell';
}

/** The source line(s) a message points at, from the report's own `source` when ESLint kept it. */
function sourceSnippet(source, line, endLine) {
  if (typeof source !== 'string' || !Number.isInteger(line)) return null;
  const lines = source.split(/\r?\n/u);
  return lines.slice(line - 1, Math.min(lines.length, (endLine ?? line), line + 19)).join('\n') || null;
}

/**
 * Read an ESLint report. `snippetOf(file, line, endLine)` may supply the source text when the report
 * has none (ESLint keeps `source` only for some files); `paths` maps reported paths (absolute).
 */
export function readEslintJson(value, { source = null, feed = 'quality', paths = repositoryPaths(), toolVersion = null,
  rulesetSha256 = null, snippetOf = null } = {}) {
  const report = reportJson(value, 'ESLint');
  const results = Array.isArray(report) ? report : report?.results;
  if (!Array.isArray(results)) throw readerError('ESLint report is neither the json nor the json-with-metadata format.');
  const rulesMeta = Array.isArray(report) ? {} : report.metadata?.rulesMeta ?? {};
  const findings = [];
  let suppressed = 0;
  let omitted = 0;
  for (const result of results) {
    const file = paths(result?.filePath);
    suppressed += Array.isArray(result?.suppressedMessages) ? result.suppressedMessages.length : 0;
    for (const message of result?.messages ?? []) {
      if (findings.length >= MAX_FINDINGS_PER_REPORT) { omitted += 1; continue; }
      const rule = message.ruleId ?? (message.fatal ? 'parse-error' : null);
      const line = Number.isInteger(message.line) ? message.line : null;
      const endLine = Number.isInteger(message.endLine) ? message.endLine : line;
      const snippet = sourceSnippet(result.source, line, endLine) ?? (file && snippetOf ? snippetOf(file, line, endLine) : null);
      findings.push(createFinding({
        feed, source: source ?? 'eslint', tool: 'eslint', toolVersion, rulesetSha256, rule,
        severity: message.fatal ? 'critical' : message.severity === 2 ? 'high' : message.severity === 1 ? 'medium' : 'info',
        kind: message.fatal ? 'bug' : eslintRuleKind(rule, rulesMeta[rule]),
        file, line, endLine, snippet: snippetSha256(snippet), message: message.message
      }));
    }
  }
  return { tools: [{ tool: 'eslint', toolVersion, rulesetSha256 }], findings, suppressed, omitted };
}
