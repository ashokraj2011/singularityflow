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
  cargo: { name: 'Cargo', ecosystem: 'rust', programSaysEcosystem: true, launchers: ['cargo'], adapter: 'cargo-json', onPath: { cargo: 'Cargo' }, buildFiles: ['Cargo.toml'] },
  swiftpm: { name: 'SwiftPM', ecosystem: 'swift', programSaysEcosystem: true, launchers: ['swift'], onPath: { swift: 'Swift' }, buildFiles: ['Package.swift'] },
  xcode: { name: 'Xcode', ecosystem: 'swift', launchers: ['xcodebuild'], onPath: { xcodebuild: 'Xcode' } },
  nx: { name: 'Nx', ecosystem: 'node', launchers: ['nx'], buildFiles: ['project.json', 'nx.json'] }
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
