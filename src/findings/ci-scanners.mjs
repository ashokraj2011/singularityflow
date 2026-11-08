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

// The scanners whose machine report a finding reader reads, how each is asked for it, and the flags that
// would send it to a file of the tool's own instead of standard output.
const READ_SCANNERS = Object.freeze([
  { tool: 'npm', subcommand: 'audit', adapter: 'npm-audit', extension: 'json', format: { flags: ['--json'] }, files: [] },
  { tool: 'pnpm', subcommand: 'audit', adapter: 'pnpm-audit', extension: 'json', format: { flags: ['--json'] }, files: [] },
  { tool: 'pip-audit', adapter: 'pip-audit', extension: 'json', format: { option: ['-f', '--format'], value: 'json' }, files: ['-o', '--output'] },
  { tool: 'osv-scanner', adapter: 'osv-scanner', extension: 'json', format: { option: ['-f', '--format'], value: 'json' }, files: ['--output', '--output-file'] },
  { tool: 'semgrep', adapter: 'sarif', extension: 'sarif', format: { flags: ['--sarif'], replaces: ['--json', '--text', '--emacs', '--vim', '--junit-xml', '--gitlab-sast', '--gitlab-secrets'] },
    files: ['-o', '--output', '--sarif-output', '--json-output', '--text-output'] },
  { tool: 'eslint', adapter: 'eslint-json', extension: 'json', format: { option: ['-f', '--format'], value: 'json' }, files: ['-o', '--output-file'] }
]);
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'yarn', 'pnpm', 'uv', 'pipx', 'poetry', 'pdm', 'hatch']);

/** Where the scanner's own program is in `argv`, past a package runner (`npx`, `pnpm exec`, `uv run`, `python -m`). */
function scannerAt(argv, scanner) {
  const name = (value) => String(value ?? '').split(/[\\/]/u).at(-1).replace(/\.(?:cmd|exe)$/iu, '').replace(/_/gu, '-');
  if (scanner.subcommand) return name(argv[0]) === scanner.tool && argv[1] === scanner.subcommand ? 1 : -1;
  for (const [index, argument] of argv.entries()) {
    if (name(argument) === scanner.tool) return index;
    const runner = PACKAGE_RUNNERS.has(name(argument)) || /^python(?:3(?:\.\d+)?)?$/u.test(name(argument)) || ['exec', 'run', 'dlx', '-m', '--'].includes(argument);
    if (!runner) return -1;
  }
  return -1;
}

/**
 * The finding reader an imported scanner check is read through [decision 6]: npm and pnpm audit,
 * pip-audit, osv-scanner, semgrep and ESLint each print a report a reader reads when asked for their
 * machine format, so the import asks for it (the format flag is added, or its value set to the one
 * the reader reads) and SFlow writes what it prints to `.sflow/results/<id>`; then only findings on
 * the Story's new code count. Null when no reader fits: another scanner, or a command that sends its
 * report to a file of its own. The caller imports that one as advisory.
 */
export function importedScannerCommand(argv, id) {
  const words = [...(argv ?? [])].map(String);
  for (const scanner of READ_SCANNERS) {
    const at = scannerAt(words, scanner);
    if (at < 0) continue;
    const rest = words.slice(at + 1);
    if (rest.some((argument) => scanner.files.some((flag) => argument === flag || argument.startsWith(`${flag}=`)))) return null;
    let next = [...words];
    const { flags = [], replaces = [], option = [], value = null } = scanner.format;
    if (flags.length) {
      next = next.filter((argument, index) => index <= at || !replaces.includes(argument));
      for (const flag of flags) if (!next.includes(flag)) next.push(flag);
    } else {
      const given = next.findIndex((argument, index) => index > at && (option.includes(argument) || option.some((flag) => argument.startsWith(`${flag}=`))));
      if (given < 0) next.push(option.at(-1), value);
      else if (next[given].includes('=')) next[given] = `${next[given].slice(0, next[given].indexOf('='))}=${value}`;
      else next[given + 1] = value;
    }
    const stem = String(id ?? scanner.adapter).replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 80) || scanner.adapter;
    return { argv: next, result: { adapter: scanner.adapter, path: `.sflow/results/${stem}.${scanner.extension}`, from: 'stdout' } };
  }
  return null;
}

// The categories (src/guidance-scan.mjs) that are scanners: a type check or a build is not one.
const SCANNER_CATEGORIES = new Set(['lint', 'security', 'static-analysis']);

/**
 * An imported check, read as a scanner where it is one [decision 6]: through its finding reader
 * (importedScannerCommand) when one fits, so only findings on new code count; else as advisory, since
 * its exit cannot tell new code's findings from existing ones: it warns and never fails submit. A
 * requirement the check already names is kept; `requirement` is what any other check gets.
 */
export function scannerCheck(check, category, { requirement = null } = {}) {
  if (!SCANNER_CATEGORIES.has(category)) return requirement && !check.requirement ? { ...check, requirement } : check;
  const read = check.argv ? importedScannerCommand(check.argv, check.id) : null;
  if (read) return { ...check, argv: read.argv, result: read.result, ...(check.requirement || requirement ? { requirement: check.requirement ?? requirement } : {}) };
  return { ...check, requirement: check.requirement ?? 'advisory' };
}
