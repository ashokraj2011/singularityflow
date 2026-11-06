/**
 * What SFlow knows about each test runner, as one table.
 *
 * This knowledge was copied into about fourteen modules, and each new form of a runner drifted: a list that
 * still called a supported runner unsupported, a pin that bound another runner's configuration (study of
 * 2026-11-06, 7.3). A runner is now one row, and each consumer reads the columns it needs. Pure data with no
 * imports, because every lifecycle command loads it.
 *
 * - `name`: a person's word for it. `level: 'browser'` when it drives a browser.
 * - `launchers`: the program names that start it. `startedBy`: programs that run it for you, for what narrows a run.
 * - `adapter`: the report format its results arrive in. `onPath`: `{ program: word }`, a tool a gate starts by name.
 * - `ecosystem`: the source language it tests. `programSaysEcosystem`: its program alone says so, for a JUnit report,
 *   which says nothing itself; a package manager's run takes its report's word instead.
 * - `direct`: the reporter a call of the runner itself gets: its adapter, report extension and arguments. A package
 *   script or Nx target is completed by inference; a test pins these to inference's arguments.
 * - `buildFiles`: the build files a command is found from, for saying why.
 * - `pins`: what can select its tests, which a pin binds (`config`, file names; `keys`, package.json keys).
 *   `setupFiles`: its other configuration a test setup changes.
 * - `collection`: where its configuration says its tests are (src/test-collection-limits.mjs).
 * - `selection`: what narrows a run (src/test-narrowing.mjs): `filters`, those of them that take no value
 *   (`valueless`), the `verbs` it reads before its operands, which files are its tests (`testFiles`), how it
 *   matches an operand (`matchesAnywhere`) and where it looks with none (`defaultPlace`).
 * - `script`: a runner a package script starts by its program and verb, and the report arguments SFlow adds.
 * - `module`: a runner a build file implies, read at a gate like any other: which files, what says they mean this
 *   runner (`holds`), and its command. It must write a report SFlow reads with no change to the repository.
 * - `proposal`: a runner SFlow can name and cannot complete alone: it needs a gem, a person's choice or a target.
 *   Setup and the refusal offer the command with what is `missing`, and nothing runs until a person approves it.
 *
 * Flags of runners not installed where this was written (PHPUnit, Bun, Deno, RSpec, minitest, Bazel, Nx) come from
 * their documentation; test/real-test-tools.test.mjs runs each where it is installed, and skips visibly where not.
 */
const javascriptConfig = (stem) => new RegExp(`^${stem}\\.config\\.[cm]?[jt]s$`, 'u');
const JAVASCRIPT_TEST_FILE = /(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?$|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const JEST_PINS = Object.freeze({ config: [javascriptConfig('jest'), /^jest\.config\.json$/u], keys: ['jest'] });
const KARMA_PINS = Object.freeze({ config: [/^karma\.(?:config|conf)\.[cm]?[jt]s$/u], keys: [] });

export const TEST_RUNNERS = Object.freeze({
  vitest: { name: 'Vitest', ecosystem: 'node', launchers: ['vitest'], adapter: 'vitest-json',
    direct: { adapter: 'vitest-json', extension: 'json', arguments: (report) => ['--reporter=json', `--outputFile=${report}`] },
    pins: { config: [javascriptConfig('vitest'), javascriptConfig('vite'), /^vitest\.workspace\.(?:[cm]?[jt]s|json)$/u], keys: [] },
    collection: { names: [javascriptConfig('vitest'), javascriptConfig('vite')], first: true, within: 'test', keys: ['include', 'exclude', 'dir'], opaque: ['projects', 'workspace'] },
    selection: { filters: ['-t', '--testNamePattern', '--shard', '--changed', '--related', '--project'], valueless: ['--changed'],
      verbs: ['run', 'watch', 'dev', 'related'], testFiles: JAVASCRIPT_TEST_FILE, matchesAnywhere: true } },
  jest: { name: 'Jest', ecosystem: 'node', launchers: ['jest', 'react-scripts'], adapter: 'jest-json', pins: JEST_PINS,
    direct: { adapter: 'jest-json', extension: 'json', arguments: (report) => ['--json', '--outputFile', report] },
    collection: { names: [javascriptConfig('jest'), /^jest\.config\.json$/u], packageKey: 'jest', keys: ['testMatch', 'testRegex', 'roots', 'testPathIgnorePatterns'], opaque: ['projects', 'preset', 'rootDir'] },
    selection: { filters: ['-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns', '--shard', '-o', '--onlyChanged', '--changedSince', '--findRelatedTests', '--onlyFailures', '--selectProjects'],
      valueless: ['-o', '--onlyChanged', '--onlyFailures'], verbs: [], testFiles: JAVASCRIPT_TEST_FILE, matchesAnywhere: true } },
  mocha: { name: 'Mocha', ecosystem: 'node', launchers: ['mocha'], adapter: 'mocha-json',
    pins: { config: [/^\.mocharc\.(?:[cm]?js|jsonc?|ya?ml)$/u], keys: ['mocha'] },
    collection: { names: [/^\.mocharc\.(?:json|c?js)$/u], packageKey: 'mocha', keys: ['spec', 'ignore'], opaque: [], unreadable: /^\.mocharc\.ya?ml$/u },
    selection: { filters: ['-g', '--grep', '-f', '--fgrep', '--invert'], valueless: ['--invert'], verbs: [], testFiles: JAVASCRIPT_TEST_FILE, defaultPlace: ['test'] } },
  node: { name: 'node:test', ecosystem: 'node', launchers: ['node'], launcherIsNotTheRunner: true, adapter: 'node-tap',
    selection: { filters: ['--test-name-pattern', '--test-skip-pattern', '--test-only', '--test-shard'], valueless: ['--test-only'], verbs: [],
      testFiles: /(?:^|\/)test\/.+\.[cm]?[jt]s$|\.test\.[cm]?[jt]s$/u } },
  playwright: { name: 'Playwright', ecosystem: 'node', level: 'browser', launchers: ['playwright'], adapter: 'playwright-json', pins: { config: [javascriptConfig('playwright')], keys: [] },
    direct: { adapter: 'playwright-json', extension: 'json', arguments: () => ['--reporter=json'] },
    collection: { names: [javascriptConfig('playwright')], keys: ['testDir', 'testMatch', 'testIgnore'], opaque: [] },
    selection: { filters: ['-g', '--grep', '--grep-invert', '--shard', '--project', '--only-changed', '--last-failed'], valueless: ['--last-failed', '--only-changed'], verbs: ['test'],
      testFiles: /\.(?:test|spec)\.[cm]?[jt]sx?$/u, matchesAnywhere: true } },
  cypress: { name: 'Cypress', ecosystem: 'node', level: 'browser', launchers: ['cypress'], pins: { config: [javascriptConfig('cypress')], keys: [] },
    selection: { filters: ['--spec'], valueless: [] } },
  karma: { name: 'Karma', ecosystem: 'node', launchers: ['karma'], adapter: 'karma-text', pins: KARMA_PINS },
  ng: { name: 'Angular Karma', ecosystem: 'node', launchers: ['ng'], pins: KARMA_PINS },
  pytest: { name: 'pytest', ecosystem: 'python', launchers: ['pytest', 'py.test'], startedBy: ['tox', 'nox'],
    direct: { adapter: 'junit-xml', extension: 'xml', arguments: (report) => [`--junitxml=${report}`] },
    buildFiles: ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'setup.py', 'requirements.txt'], setupFiles: [/^pytest\.ini$/u, /^conftest\.py$/u],
    collection: { sections: [['pytest.ini', '[pytest]'], ['pyproject.toml', '[tool.pytest'], ['tox.ini', '[pytest]'], ['setup.cfg', '[tool:pytest]']] },
    selection: { filters: ['-k', '-m', '--lf', '--last-failed', '--deselect', '--sw', '--stepwise'], valueless: ['--lf', '--last-failed', '--sw', '--stepwise'], verbs: [],
      testFiles: /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/u } },
  maven: { name: 'Maven', ecosystem: 'jvm', programSaysEcosystem: true, launchers: ['mvn', 'mvnw'], onPath: { mvn: 'Maven' }, buildFiles: ['pom.xml'],
    selection: { filters: ['-Dtest', '-Dit.test', '-Dgroups', '-DexcludedGroups'], valueless: [] } },
  gradle: { name: 'Gradle', ecosystem: 'jvm', programSaysEcosystem: true, launchers: ['gradle', 'gradlew'], onPath: { gradle: 'Gradle' }, buildFiles: ['build.gradle.kts', 'build.gradle'],
    selection: { filters: ['--tests'], valueless: [] } },
  go: { name: 'Go', ecosystem: 'go', programSaysEcosystem: true, launchers: ['go'], adapter: 'go-test-json', onPath: { go: 'Go' }, buildFiles: ['go.mod'],
    direct: { adapter: 'go-test-json', extension: 'jsonl', arguments: () => ['-json'] },
    selection: { filters: ['-run', '-skip', '-short'], valueless: ['-short'], verbs: ['test'], testFiles: /_test\.go$/u } },
  dotnet: { name: '.NET', ecosystem: 'dotnet', programSaysEcosystem: true, launchers: ['dotnet'], adapter: 'dotnet-trx', onPath: { dotnet: '.NET' },
    direct: { adapter: 'dotnet-trx', extension: null, arguments: (directory) => ['--logger', 'trx', '--results-directory', directory] }, selection: { filters: ['--filter'], valueless: [] } },
  cargo: { name: 'Cargo', ecosystem: 'rust', programSaysEcosystem: true, launchers: ['cargo'], adapter: 'cargo-json', onPath: { cargo: 'Cargo' }, buildFiles: ['Cargo.toml'],
    // Stable cargo refuses its JSON format, so a person chooses: that flag on a stable compiler, or nextest's JUnit report.
    proposal: { files: [/^Cargo\.toml$/u], holds: () => true, runner: 'cargo',
      words: 'Stable cargo writes no structured report. Choose one: RUSTC_BOOTSTRAP=1 with its JSON format, which reads each result, or cargo-nextest with a JUnit profile, which needs that tool. Either is a person\'s choice.',
      command: () => ({ argv: ['cargo', 'test', '--', '-Z', 'unstable-options', '--format', 'json'], env: { RUSTC_BOOTSTRAP: '1' }, result: { adapter: 'cargo-json', path: '.sflow/results/rust-tests.jsonl' } }),
      missing: ['which of the two'], choices: ['RUSTC_BOOTSTRAP=1 cargo test -- -Z unstable-options --format json', 'cargo nextest run --profile ci, with [profile.ci.junit] path = "junit.xml" in .config/nextest.toml; its report is target/nextest/ci/junit.xml'] } },
  swiftpm: { name: 'SwiftPM', ecosystem: 'swift', programSaysEcosystem: true, launchers: ['swift'], onPath: { swift: 'Swift' }, buildFiles: ['Package.swift'] },
  xcode: { name: 'Xcode', ecosystem: 'swift', launchers: ['xcodebuild'], onPath: { xcodebuild: 'Xcode' } },
  nx: { name: 'Nx', ecosystem: 'node', launchers: ['nx'], buildFiles: ['project.json', 'nx.json'],
    // That @nx/vite:test hands these to Vitest is unproven here: no real Nx has run it, so a person approves it first.
    proposal: { files: [/^project\.json$/u], holds: (text) => /["']@nx\/vite:test["']/u.test(text), runner: 'Vitest under @nx/vite:test',
      words: 'SFlow has not seen this executor pass a report option to Vitest, so it does not run this by itself. If its report is written, approve it as this project\'s test command.',
      command: (text) => ({ argv: ['npx', '--no-install', 'nx', 'run', `${/"name"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? '<project>'}:test`, '--skip-nx-cache', '--run', '--reporters=json', '--outputFile=.sflow/results/vitest-tests.json'],
        result: { adapter: 'vitest-json', path: '.sflow/results/vitest-tests.json' } }), missing: [] } },
  phpunit: { name: 'PHPUnit', ecosystem: 'php', programSaysEcosystem: true, launchers: ['phpunit'], buildFiles: ['phpunit.xml', 'phpunit.xml.dist', 'composer.json'],
    pins: { config: [/^phpunit\.xml(?:\.dist)?$/u], keys: [] },
    direct: { adapter: 'junit-xml', extension: 'xml', arguments: (report) => ['--log-junit', report] },
    selection: { filters: ['--filter', '--group', '--exclude-group', '--testsuite'], valueless: [], verbs: [], testFiles: /Test\.php$/u },
    module: { system: 'php', files: [/^phpunit\.xml(?:\.dist)?$/u, /^composer\.json$/u], holds: (name, text) => name !== 'composer.json' || /["']phpunit\/phpunit["']/u.test(text),
      command: (report) => ({ argv: ['vendor/bin/phpunit', '--log-junit', report], extension: 'xml', adapter: 'junit-xml' }) } },
  bun: { name: 'Bun', ecosystem: 'node', launchers: ['bun'], onPath: { bun: 'Bun' }, pins: { config: [/^bunfig\.toml$/u], keys: [] },
    script: { verb: 'test', adapter: 'junit-xml', arguments: (report) => ['--reporter=junit', `--reporter-outfile=${report}`], notAGate: /^--(?:watch|hot|reporter|reporter-outfile)(?:=|$)/u },
    selection: { filters: ['-t', '--test-name-pattern', '--only'], valueless: ['--only'], verbs: ['test'], testFiles: /[._](?:test|spec)\.[cm]?[jt]sx?$/u, matchesAnywhere: true } },
  deno: { name: 'Deno', ecosystem: 'node', programSaysEcosystem: true, launchers: ['deno'], onPath: { deno: 'Deno' }, buildFiles: ['deno.json', 'deno.jsonc'],
    pins: { config: [/^deno\.jsonc?$/u], keys: [] },
    direct: { adapter: 'junit-xml', extension: 'xml', arguments: (report) => [`--junit-path=${report}`] },
    selection: { filters: ['--filter'], valueless: [], verbs: ['test', 'task'], testFiles: /(?:^|[/_.])test\.[cm]?[jt]sx?$/u },
    module: { system: 'deno', files: [/^deno\.jsonc?$/u], holds: () => true,
      // A repository's own test task keeps the permissions it names; a bare `deno test` has none.
      command: (report, text) => ({ argv: ['deno', ...(/["']tasks["'][\s\S]*?["']test["']\s*:/u.test(text) ? ['task', 'test'] : ['test']), `--junit-path=${report}`], extension: 'xml', adapter: 'junit-xml' }) } },
  rspec: { name: 'RSpec', ecosystem: 'ruby', programSaysEcosystem: true, launchers: ['rspec'], pins: { config: [/^\.rspec$/u], keys: [] },
    selection: { filters: ['-e', '--example', '--tag', '--only-failures', '--next-failure'], valueless: ['--only-failures', '--next-failure'], verbs: [], testFiles: /_spec\.rb$/u },
    proposal: { files: [/^Gemfile$/u], holds: (text) => /["']rspec(?:-[a-z]+)?["']/u.test(text), runner: 'RSpec',
      words: 'SFlow reads results from JUnit reports, and RSpec writes one only through a formatter gem. Add rspec_junit_formatter to the test group, or ask a person to accept a Story-only command.',
      command: () => ({ argv: ['bundle', 'exec', 'rspec', '--format', 'RspecJunitFormatter', '--out', '.sflow/results/ruby-tests.xml'], result: { adapter: 'junit-xml', path: '.sflow/results/ruby-tests.xml' } }), missing: ['the rspec_junit_formatter gem'] } },
  minitest: { name: 'minitest', ecosystem: 'ruby', launchers: ['minitest'],
    selection: { filters: ['-n', '--name', '-e', '--exclude'], valueless: [], verbs: [], testFiles: /(?:^|[/_])test(?:_[^/]*)?\.rb$|_test\.rb$/u },
    proposal: { files: [/^Gemfile$/u, /^Rakefile$/u], holds: (text) => /\bminitest\b|Rake::TestTask/u.test(text), runner: 'minitest',
      words: 'SFlow reads results from JUnit reports, and minitest writes one only through a reporter gem. Add minitest-reporters and use its JUnitReporter, or ask a person to accept a Story-only command.',
      command: () => ({ argv: ['bundle', 'exec', 'rake', 'test'], result: { adapter: 'junit-xml', path: 'test/reports' } }), missing: ['the minitest-reporters gem with its JUnitReporter'] } },
  bazel: { name: 'Bazel', launchers: ['bazel'], onPath: { bazel: 'Bazel' }, pins: { config: [/^\.bazelrc$/u], keys: [] }, selection: { filters: ['--test_filter', '--test_tag_filters'], valueless: [] },
    proposal: { files: [/^MODULE\.bazel$/u, /^WORKSPACE(?:\.bazel)?$/u], holds: () => true, runner: 'Bazel',
      words: 'Bazel writes each test target\'s JUnit report under bazel-testlogs. Which targets to run is a person\'s choice, and SFlow does not guess it.',
      command: () => ({ argv: ['bazel', 'test', '//...', '--test_output=errors'], result: { adapter: 'junit-xml', path: 'bazel-testlogs' } }), missing: ['the targets, if not //...'] } }
});

const rows = Object.entries(TEST_RUNNERS);

/** The row a program name starts, with its key, or null. */
const BY_LAUNCHER = new Map(rows.flatMap(([key, row]) => row.launchers.map((launcher) => [launcher, { key, ...row }])));
export const runnerOfLauncher = (launcher) => BY_LAUNCHER.get(launcher) ?? null;

/** The row whose person's word this is, or null. */
const BY_NAME = new Map(rows.map(([key, row]) => [row.name, { key, ...row }]));
export const runnerNamed = (name) => BY_NAME.get(name) ?? null;

/** A person's word for the runner a report format comes from, or null. */
const NAME_OF_ADAPTER = new Map(rows.filter(([, row]) => row.adapter).map(([, row]) => [row.adapter, row.name]));
export const runnerNameOfAdapter = (adapter) => NAME_OF_ADAPTER.get(adapter) ?? null;

/** A person's word for what a program name starts, or null: `node` alone says nothing about tests. */
export const runnerNameOfLauncher = (launcher) => { const row = runnerOfLauncher(launcher); return row && !row.launcherIsNotTheRunner ? row.name : null; };

/** Tools a gate would start by name, and the word for each. */
export const TOOLS_ON_PATH = Object.freeze(Object.assign({}, ...rows.map(([, row]) => row.onPath ?? {})));

/** What a program name's run reads for narrowing: the runner key with a `selection` column, or null. */
const SELECTING_PROGRAMS = new Map(rows.filter(([, row]) => row.selection).flatMap(([key, row]) => [...row.launchers, ...(row.startedBy ?? [])].map((program) => [program, key])));
export const selectingRunner = (program) => SELECTING_PROGRAMS.get(program) ?? null;
export const SELECTING_RUNNERS = Object.freeze(Object.fromEntries(rows.filter(([, row]) => row.selection).map(([key, row]) => [key, row.selection])));

/** Whether a file's name is a runner's own configuration, which a test setup changes. */
const CONFIGURATION_NAMES = rows.flatMap(([, row]) => [...(row.pins?.config ?? []), ...(row.setupFiles ?? [])]);
export const isRunnerConfigurationName = (name) => CONFIGURATION_NAMES.some((pattern) => pattern.test(name));

/** The source language a report format is always about, or null: a JUnit report says nothing. */
const ECOSYSTEM_OF_ADAPTER = new Map(rows.filter(([, row]) => row.adapter && row.adapter !== 'junit-xml').map(([, row]) => [row.adapter, row.ecosystem]));
export const ecosystemOfAdapter = (adapter) => ECOSYSTEM_OF_ADAPTER.get(adapter) ?? null;

/** The source language a program alone says it tests, or null. */
const ECOSYSTEM_OF_PROGRAM = new Map(rows.filter(([, row]) => row.programSaysEcosystem).flatMap(([, row]) => row.launchers.map((launcher) => [launcher, row.ecosystem])));
export const ecosystemOfProgram = (program) => ECOSYSTEM_OF_PROGRAM.get(program) ?? null;

/** The reporter of each runner a person can call directly, by the name a written command uses. */
export const DIRECT_REPORTERS = Object.freeze(Object.fromEntries(rows.filter(([, row]) => row.direct).map(([key, row]) => [key, row.direct])));

/** The rows a build file implies, and the rows SFlow can only propose. */
export const MODULE_RUNNERS = Object.freeze(rows.filter(([, row]) => row.module).map(([key, row]) => ({ key, ...row })));
export const PROPOSED_RUNNERS = Object.freeze(rows.filter(([, row]) => row.proposal).map(([key, row]) => ({ key, ...row })));
/** The row of a build system a `module` column names, or null. */
export const moduleRunnerOfSystem = (system) => MODULE_RUNNERS.find((row) => row.module.system === system) ?? null;
/** The program and verb a package script starts a runner by. */
export const scriptRunnerOf = (program, verb) => (verb && TEST_RUNNERS[program]?.script?.verb === verb ? program : null);
export const SCRIPT_RUNNER_REFUSALS = Object.freeze(Object.fromEntries(rows.filter(([, row]) => row.script).map(([key, row]) => [key, row.script.notAGate])));
