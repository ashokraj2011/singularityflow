/**
 * Scanners found in a team's material [CQF:REQ-049]: sonar-scanner, codeql, semgrep, npm audit,
 * pip-audit, osv-scanner, dependency-check and eslint read as checks (team import and Build with
 * Copilot), and a CI workflow's CodeQL and SonarQube `uses:` steps, which no `run:` line shows, are
 * found with what sflow proposes for each.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CHECK_KINDS, classifyCommand, scanGuidanceText } from '../src/guidance-scan.mjs';
import { ciScannerOf, ciScannerSteps, ciStepFor, PROPOSED_CI_STEPS } from '../src/findings/ci-scanners.mjs';
import { inventoryCapture } from '../src/workflow-build/inventory.mjs';

test('each scanner a team runs is a check of the kind its findings are', () => {
  for (const [command, kind] of [
    ['sonar-scanner -Dsonar.qualitygate.wait=true', 'static-analysis'], ['mvn sonar:sonar', 'static-analysis'], ['./gradlew build sonar', 'static-analysis'],
    ['codeql database analyze db javascript-security-extended.qls --format=sarif-latest --output=out.sarif', 'security'],
    ['semgrep --config p/ci --sarif', 'security'], ['npm audit --json', 'security'], ['pnpm audit --json', 'security'], ['pip-audit -f json', 'security'],
    ['osv-scanner --format json -r .', 'security'], ['dependency-check.sh --scan . --format JSON', 'security'], ['npx eslint .', 'lint'], ['eslint src', 'lint']
  ]) assert.equal(CHECK_KINDS[classifyCommand(command)], kind, command);
  assert.equal(classifyCommand('npm run release-test'), 'deploy', 'a deployment still wins over everything');
  // A runbook's code lines are read as commands, so the importer sees them.
  const scan = scanGuidanceText(['```sh', 'codeql database create db --language=javascript', 'semgrep --config p/ci --sarif -o out.sarif', 'pip-audit -f json',
    'osv-scanner -r .', 'sonar-scanner', '```'].join('\n'));
  assert.deepEqual(scan.commands.map((entry) => entry.category), ['security', 'security', 'security', 'security', 'static-analysis']);
  assert.equal(ciStepFor('codeql database analyze db'), 'in GitHub CI it is the github/codeql-action init and analyze steps');
  assert.equal(ciStepFor('sonar-scanner'), 'in GitHub CI it is the SonarSource/sonarqube-scan-action step');
});

const WORKFLOW = [
  'name: ci', 'on: [push]', 'jobs:', '  analyze:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4',
  '      - uses: github/codeql-action/init@v3', '        with:', '          languages: javascript-typescript', '      - name: Run CodeQL',
  '        uses: github/codeql-action/analyze@v3', '  sonar:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4',
  '      - uses: SonarSource/sonarqube-scan-action@v5', '        env:', '          SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}', ''
].join('\n');

test("a CI workflow's CodeQL and SonarQube uses: steps are found, with what sflow proposes for each", () => {
  assert.equal(ciScannerOf('github/codeql-action/upload-sarif@v3'), 'codeql');
  assert.equal(ciScannerOf('SonarSource/sonarcloud-github-action@master'), 'sonarqube');
  assert.equal(ciScannerOf('actions/checkout@v4'), null);
  const steps = ciScannerSteps(WORKFLOW);
  assert.deepEqual(steps.map(({ scanner, uses, job, name, line }) => [scanner, uses, job, name, line]), [
    ['codeql', 'github/codeql-action/init@v3', 'analyze', null, 8], ['codeql', 'github/codeql-action/analyze@v3', 'analyze', 'Run CodeQL', 11],
    ['sonarqube', 'SonarSource/sonarqube-scan-action@v5', 'sonar', null, 17]]);
  assert.deepEqual(steps[0].configuration, { codeDelivery: { staticAnalysis: { codeql: 'github' } } });
  assert.equal(steps[2].configuration.qualityCommand.result.adapter, 'sonarqube');
  assert.deepEqual(ciScannerSteps('not: [valid'), []);
  assert.match(PROPOSED_CI_STEPS.codeql, /uses: github\/codeql-action\/analyze@v3/u);
  assert.match(PROPOSED_CI_STEPS.sonarqube, /uses: SonarSource\/sonarqube-scan-action@v5/u);

  // Build with Copilot's inventory names them, as a CI step that is not a step's local check.
  const file = { path: 'repo/.github/workflows/ci.yml', relative: '.github/workflows/ci.yml', screening: 'clean', sha256: 'a'.repeat(64) };
  const items = inventoryCapture({ files: [file] }, new Map([[file.path, WORKFLOW]])).filter((entry) => entry.kind === 'command');
  assert.deepEqual(items.map((entry) => [entry.name, entry.category, entry.checkable, entry.ci.scanner]), [
    ['uses: github/codeql-action/init@v3', 'security', false, 'codeql'], ['uses: github/codeql-action/analyze@v3', 'security', false, 'codeql'],
    ['uses: SonarSource/sonarqube-scan-action@v5', 'static-analysis', false, 'sonarqube']]);
  assert.match(items[1].detail, /^a CI step \(Run CodeQL\) in job analyze; CodeQL runs in GitHub: sflow reads its open alerts/u);
});
