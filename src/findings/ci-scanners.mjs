/**
 * Scanners a team runs in CI as `uses:` steps, which no `run:` line shows [CQF:REQ-049]: CodeQL
 * (github/codeql-action) and SonarQube (the SonarQube scan action, or the older SonarCloud one). For
 * each, what sflow proposes instead of a local command, since a CI action cannot run in a code step:
 *
 * - CodeQL: read its alerts for the Story branch at submit (`codeDelivery.staticAnalysis.codeql:
 *   github`), and the capability's `requiredChecks` may require its check run.
 * - SonarQube: a scanner quality command that runs once at submit, on the Story branch or a scratch
 *   project, with its host and token from environment `sonar`.
 *
 * And, for a team with neither, the `uses:` steps to propose adding to its CI. Recorded, never run.
 */
import YAML from 'yaml';

export const CI_SCANNER_ACTIONS = Object.freeze([
  { scanner: 'codeql', pattern: /^github\/codeql-action\/(?:init|analyze|autobuild|upload-sarif)(?:@|$)/iu },
  { scanner: 'sonarqube', pattern: /^sonarsource\/(?:sonarqube-scan-action|sonarcloud-github-action|sonarqube-quality-gate-action)(?:\/[\w-]+)?(?:@|$)/iu }
]);

const PROPOSALS = Object.freeze({
  codeql: Object.freeze({ category: 'security', words: "CodeQL runs in GitHub: sflow reads its open alerts for the Story branch at submit (codeDelivery.staticAnalysis.codeql: github), and a capability's requiredChecks can require its check run",
    configuration: Object.freeze({ codeDelivery: { staticAnalysis: { codeql: 'github' } } }) }),
  sonarqube: Object.freeze({ category: 'static-analysis', words: 'SonarQube scans in CI: the code step can scan its Story branch once at submit with a sonar-scanner quality command (result adapter sonarqube, environment sonar), and reads the gate',
    configuration: Object.freeze({ qualityCommand: { id: 'sonar', kind: 'static-analysis', modelPolicy: 'never', environment: 'sonar', argv: ['sonar-scanner'],
      result: { adapter: 'sonarqube', path: '.sflow/results/scannerwork/report-task.txt' }, sonarqube: { project: '<PROJECT-KEY>', branchAnalysis: true } } }) })
});

/** The CI steps to propose to a team whose workflows run neither scanner, as GitHub Actions YAML. */
export const PROPOSED_CI_STEPS = Object.freeze({
  codeql: ['- uses: github/codeql-action/init@v3', '  with:', '    languages: <LANGUAGE>', '    queries: security-extended', '- uses: github/codeql-action/analyze@v3'].join('\n'),
  sonarqube: ['- uses: SonarSource/sonarqube-scan-action@v5', '  env:', '    SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}', '    SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}'].join('\n')
});

/** The scanner a `uses:` reference names, or null. */
export function ciScannerOf(uses) {
  return CI_SCANNER_ACTIONS.find(({ pattern }) => pattern.test(String(uses ?? '').trim()))?.scanner ?? null;
}

/**
 * The scanner steps of one GitHub Actions workflow file: `{ scanner, uses, job, name, line, category,
 * words, configuration }` for each, in file order; [] for anything that is not a workflow.
 */
export function ciScannerSteps(text) {
  const lineCounter = new YAML.LineCounter();
  let document;
  try { document = YAML.parseDocument(String(text ?? ''), { lineCounter, maxAliasCount: 50, prettyErrors: false }); } catch { return []; }
  if (document.errors.length) return [];
  const jobs = document.get('jobs', true);
  const found = [];
  for (const job of YAML.isMap(jobs) ? jobs.items : []) {
    const steps = YAML.isMap(job.value) ? job.value.get('steps', true) : null;
    for (const step of YAML.isSeq(steps) ? steps.items : []) {
      if (!YAML.isMap(step)) continue;
      const uses = step.get('uses');
      const scanner = typeof uses === 'string' ? ciScannerOf(uses) : null;
      if (!scanner) continue;
      const proposal = PROPOSALS[scanner];
      found.push({ scanner, uses, job: String(job.key?.value ?? job.key ?? ''), name: step.get('name') ? String(step.get('name')) : null,
        line: step.range ? lineCounter.linePos(step.range[0]).line : 1, category: proposal.category, words: proposal.words, configuration: proposal.configuration });
    }
  }
  return found;
}

/** What a found scanner command proposes for CI as well, in words: the `uses:` step its CI would run. */
export function ciStepFor(command) {
  const text = String(command ?? '').toLowerCase();
  if (/^codeql\b/u.test(text)) return 'in GitHub CI it is the github/codeql-action init and analyze steps';
  if (/^sonar-scanner\b|sonar:sonar|\bsonar\b/u.test(text)) return 'in GitHub CI it is the SonarSource/sonarqube-scan-action step';
  return null;
}
