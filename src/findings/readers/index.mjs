/**
 * The finding readers a quality command's `result.adapter` may name [CQF:REQ-040, REQ-041]. Each takes
 * the report and a context (source, feed, path mapping, tool identity) and returns
 * `{ tools, findings, ... }` in the shared shape (src/findings/model.mjs). The dependency audits'
 * readers (src/findings/readers/dependency-audits.mjs) also say when their advisories were current;
 * M6's sources read through the same ones.
 */
import { readDependencyCheck, readNpmAudit, readOsvScanner, readPipAudit } from './dependency-audits.mjs';
import { readCodeScanningAlerts } from './github-code-scanning.mjs';
import { readEslintJson } from './eslint-json.mjs';
import { readSarif } from './sarif.mjs';
import { readSonarqubeJson } from './sonarqube.mjs';

export const FINDING_READERS = Object.freeze({
  sarif: (value, context) => readSarif(value, context),
  'eslint-json': (value, context) => readEslintJson(value, context),
  sonarqube: (value, context) => readSonarqubeJson(value, context),
  'github-code-scanning': (value, context) => readCodeScanningAlerts(value, context),
  'npm-audit': (value, context) => readNpmAudit(value, context),
  'pnpm-audit': (value, context) => readNpmAudit(value, { ...context, tool: 'pnpm-audit' }),
  'pip-audit': (value, context) => readPipAudit(value, context),
  'osv-scanner': (value, context) => readOsvScanner(value, context),
  'dependency-check': (value, context) => readDependencyCheck(value, context)
});

/** Read one report with the named adapter. */
export function readFindingReport(adapter, value, context = {}) {
  const reader = FINDING_READERS[adapter];
  if (!reader) throw new TypeError(`No finding reader for adapter '${adapter}'.`);
  return reader(value, context);
}
