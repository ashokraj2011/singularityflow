/**
 * The closed set of test adapter profiles and their assurance ceilings [E2G-015, E2G-017, D2].
 *
 * Pure data, safe for every surface (the evaluator, VS Code, the CLI). Exact profiles tie a
 * criterion to one declared test and can reach exact-local-observed; every other result adapter
 * only counts tests, so a criterion verified through it stops at module-observed. Nothing here
 * reaches exact-authenticated: that needs qualified execution (M4).
 */
import path from 'node:path';

const MAVEN = new Set(['mvn', 'mvnw', 'mvn.cmd', 'mvnw.cmd']);
const GRADLE = new Set(['gradle', 'gradlew', 'gradle.bat', 'gradlew.bat']);

export const TEST_ADAPTER_PROFILES = Object.freeze({
  'node-test-v1': Object.freeze({ language: 'javascript', framework: 'node:test', resultAdapter: 'node-tap', ceiling: 'exact-local-observed' }),
  'jest-static-v2': Object.freeze({ language: 'javascript', framework: 'jest', resultAdapter: 'jest-json', ceiling: 'exact-local-observed' }),
  'vitest-static-v2': Object.freeze({ language: 'javascript', framework: 'vitest', resultAdapter: 'vitest-json', ceiling: 'exact-local-observed' }),
  'junit5-surefire-v2': Object.freeze({ language: 'java', framework: 'junit5', runner: 'surefire', resultAdapter: 'junit-xml', ceiling: 'exact-local-observed' }),
  'junit5-gradle-v2': Object.freeze({ language: 'java', framework: 'junit5', runner: 'gradle', resultAdapter: 'junit-xml', ceiling: 'exact-local-observed' }),
  // Each Playwright test and each pytest test reports its own result [TCE:REQ-071, TCE:REQ-074].
  'playwright-json-v1': Object.freeze({ language: 'javascript', framework: 'playwright', resultAdapter: 'playwright-json', ceiling: 'exact-local-observed' }),
  'pytest-junit-v1': Object.freeze({ language: 'python', framework: 'pytest', resultAdapter: 'junit-xml', ceiling: 'exact-local-observed' }),
  'module-counts-v1': Object.freeze({ language: null, framework: null, resultAdapter: null, ceiling: 'module-observed' })
});

function executableName(value) {
  return path.posix.basename(String(value ?? '').replaceAll('\\', '/')).toLowerCase();
}

/** The profile that reads one normalized test command. Unknown shapes only count tests. */
export function profileForCommand(command) {
  const adapter = command?.result?.adapter;
  if (adapter === 'node-tap') return 'node-test-v1';
  if (adapter === 'jest-json') return 'jest-static-v2';
  if (adapter === 'vitest-json') return 'vitest-static-v2';
  if (adapter === 'playwright-json') return 'playwright-json-v1';
  if (adapter === 'junit-xml') {
    const executable = executableName(command?.argv?.[0]);
    if (MAVEN.has(executable)) return 'junit5-surefire-v2';
    if (GRADLE.has(executable)) return 'junit5-gradle-v2';
    if (/^(?:py(?:thon[\d.]*)?(?:\.exe)?|uv|poetry)$/u.test(executable) && command.argv.includes('pytest')) return 'pytest-junit-v1';
  }
  return 'module-counts-v1';
}

export function testAdapterProfile(id) {
  const profile = TEST_ADAPTER_PROFILES[id];
  if (!profile) throw new Error(`Unknown test adapter profile '${id}'.`);
  return { id, ...profile };
}

/** True when the profile can tie a criterion to one exact test. */
export function profileIsExact(id) {
  return testAdapterProfile(id).ceiling === 'exact-local-observed';
}

/** The strongest assurance a profile can produce; unknown profiles only count tests. */
export function profileCeiling(id) {
  return TEST_ADAPTER_PROFILES[id]?.ceiling ?? 'module-observed';
}
