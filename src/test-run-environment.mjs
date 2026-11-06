/**
 * The environment a gate gives a test run, and what the attempt records of it [TCE:REQ-030].
 *
 * A gate run inherited the whole environment of the CLI, and some variables change which tests run
 * without appearing in the command: `MAVEN_ARGS=-Dtest=One` ran one test class, and the attempt
 * still read like the whole suite. Every run of a test command by a gate (publish preflight,
 * submission, a runner epoch, and `tests run`, which runs exactly what they run) therefore
 *
 * - loses the inherited variables in SELECTION_VARIABLES, each with the reason it goes, and the
 *   selection flags inside NODE_OPTIONS and GOFLAGS [TCE:REQ-032]. JVM and memory options are not
 *   selection and stay: MAVEN_OPTS, GRADLE_OPTS, JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, _JAVA_OPTIONS,
 *   and every other NODE_OPTIONS or GOFLAGS flag, such as --max-old-space-size or -mod=vendor;
 * - runs with CI=1 unless the command's own environment sets CI [TCE:REQ-031]. Jest's --ci default
 *   (no new snapshots), the watch mode of Vitest and react-scripts, Vitest's allowOnly and a usual
 *   Playwright configuration's forbidOnly all follow CI; Jest reads no selection variable itself;
 * - is recorded on its attempt [TCE:REQ-033]: the CI value it saw, the names removed (never their
 *   values), a digest of the declared variables (names and literal values; a bound secret by name
 *   only) and the toolchain versions of its runner family (test-toolchain.mjs);
 * - runs on the Node version its repository asks for in `.nvmrc` or `.node-version`, as every command
 *   SFlow runs for a repository does (project-node-version.mjs) [TCE:REQ-035].
 *
 * Variables the command declares, an environment binding's or (from TCE phase 2) the command's own
 * `env`, are applied after the cleanup and kept: they are visible in its definition and recorded.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from './records.mjs';

/** [name or pattern, why a gate run loses it]. Matched without regard to case, as Windows does. */
export const SELECTION_VARIABLES = Object.freeze([
  ['MAVEN_ARGS', 'Maven adds it to every command line, so -Dtest=One runs one test class'],
  ['MAVEN_CONFIG', 'the Maven wrapper adds it to every command line, as MAVEN_ARGS'],
  ['PYTEST_ADDOPTS', 'pytest adds it to every command line, so -k one runs only the matching tests'],
  ['PYTEST_PLUGINS', 'pytest loads these plugins, which can deselect or skip tests'],
  ['TOXENV', 'tox runs only these environments, as -e does'],
  ['TOX_SKIP_ENV', 'tox leaves out the environments it matches'],
  ['NOXSESSION', 'nox runs only these sessions, as -s does'],
  ['NPM_CONFIG_WORKSPACE', 'npm runs the script only in these workspaces, as --workspace does'],
  ['NPM_CONFIG_WORKSPACES', 'npm runs the script in the workspaces instead of the package, as --workspaces does'],
  ['UPDATE_SNAPSHOT', 'Vitest rewrites snapshots instead of comparing them, so a changed snapshot passes'],
  ['PWTEST_WATCH', 'Playwright watches for changes, reruns only what changed and never ends'],
  ['PWTEST_SHARD_WEIGHTS', 'Playwright moves tests between the shards of a --shard run'],
  [/^CYPRESS_SPEC_?PATTERN$/iu, 'Cypress runs only the specs it matches (specPattern)'],
  [/^CYPRESS_EXCLUDE_?SPEC_?PATTERN$/iu, 'Cypress leaves out the specs it matches (excludeSpecPattern)'],
  [/^CYPRESS_GREP/iu, '@cypress/grep runs only the tests whose titles or tags match']
]);

/** Flags inside NODE_OPTIONS that choose which node:test tests run; `true` takes a value. */
export const NODE_SELECTION_FLAGS = Object.freeze({
  '--test-name-pattern': true, '--test-skip-pattern': true, '--test-shard': true, '--test-only': false
});
/** Flags inside GOFLAGS that choose which Go tests run: -run, -skip and -short (and -test.<name>). */
const GO_SELECTION_FLAG = /^--?(?:test\.)?(run|skip|short)(?:=|$)/u;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const named = (environment, name) => Object.keys(environment).filter(key => key.toUpperCase() === name);

function selectionReason(name) {
  return SELECTION_VARIABLES.find(([match]) => (typeof match === 'string' ? name.toUpperCase() === match : match.test(name)))?.[1] ?? null;
}

// Node splits NODE_OPTIONS on white space outside double quotes; names may use _ for -.
function withoutNodeSelection(value, removed) {
  const kept = [];
  const tokens = String(value).match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/gu) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index].split('=')[0].replaceAll('_', '-');
    if (!Object.hasOwn(NODE_SELECTION_FLAGS, flag)) { kept.push(tokens[index]); continue; }
    removed.add(`NODE_OPTIONS ${flag}`);
    if (NODE_SELECTION_FLAGS[flag] && !tokens[index].includes('=')) index += 1;
  }
  return kept.join(' ');
}

// GOFLAGS entries are standalone -flag[=value] settings separated by white space.
function withoutGoSelection(value, removed) {
  return String(value).split(/\s+/u).filter(Boolean).filter((entry) => {
    const match = GO_SELECTION_FLAG.exec(entry);
    if (match) removed.add(`GOFLAGS -${match[1]}`);
    return !match;
  }).join(' ');
}

/**
 * The environment of one gate test run, from the environment it would inherit, and its record.
 * `declared` is the command's own literal environment, applied after the cleanup. Returns
 * `{ environment, removed, observe, attach }`: `observe(command, { cwd, environment, bound })`
 * starts the record of the finished environment beside the run (`bound` is an environment
 * binding's public metadata), and `attach(check)` keeps it for that run's attempt.
 */
export function gateTestEnvironment(inherited = process.env, { declared = null } = {}) {
  const environment = {};
  const removed = new Set();
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || name.toUpperCase() === 'CI') continue;
    if (selectionReason(name)) { removed.add(name); continue; }
    environment[name] = value;
  }
  for (const [name, clean] of [['NODE_OPTIONS', withoutNodeSelection], ['GOFLAGS', withoutGoSelection]]) {
    for (const key of named(environment, name)) {
      const value = clean(environment[key], removed);
      if (value) environment[key] = value; else delete environment[key];
    }
  }
  environment.CI = '1';
  const literal = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : {};
  for (const [name, value] of Object.entries(literal)) {
    for (const key of named(environment, name.toUpperCase())) delete environment[key];
    environment[name] = String(value);
  }
  let recording = null;
  return {
    environment, removed: [...removed].sort(),
    observe(command, options = {}) {
      recording = testRunEnvironmentRecord(command, { ...options, removed: [...removed].sort(), declared: literal });
    },
    // Kept on the check itself, never in its JSON: the attempt records it (code-delivery-tests.mjs).
    async attach(check) {
      if (recording && check) Object.defineProperty(check, 'runEnvironment', { value: await recording, configurable: true });
    }
  };
}

/** A run's environment with the Node its repository asks for [TCE:REQ-035]; see project-node-version.mjs. */
export async function withProjectNodeVersion(environment, options) {
  return (await import('./project-node-version.mjs')).withRequestedNode(environment, options);
}

/**
 * The digest of what the command declared for its run: the literal variables with their values,
 * and an environment binding's variables, a secret by name only. Null when it declared nothing.
 */
export function declaredVariablesSha256({ declared = {}, environment = {}, bound = null } = {}) {
  const literal = Object.fromEntries(Object.entries(declared ?? {}).map(([name, value]) => [name, String(value)]));
  const secrets = new Set(bound?.secretsPresent ?? []);
  for (const name of bound?.boundNames ?? []) if (!secrets.has(name)) literal[name] = environment[name] ?? null;
  if (!Object.keys(literal).length && !secrets.size) return null;
  return `sha256:${sha256(canonicalJson({ literal, secrets: [...secrets].sort() }))}`;
}

/** The attempt's environment fields for one finished environment. Never rejects. */
export async function testRunEnvironmentRecord(command, { cwd = process.cwd(), environment = {}, bound = null, removed = [], declared = {}, nodeVersion = null } = {}) {
  const key = named(environment, 'CI').at(-1);
  const ci = key == null ? null : (bound?.secretsPresent ?? []).some(name => name.toUpperCase() === 'CI') ? '[redacted:CI]' : environment[key];
  let toolchain = {};
  try { toolchain = await (await import('./test-toolchain.mjs')).runnerToolchain(command, { cwd, environment }); } catch { /* recorded as unknown */ }
  // Only its digest: NODE_OPTIONS is no selection (it stays), yet a different value is a different environment [TCE:REQ-081].
  const nodeOptions = environment[named(environment, 'NODE_OPTIONS').at(-1)];
  return { ci, removed: [...removed], declaredSha256: declaredVariablesSha256({ declared, environment, bound }), toolchain, ...(nodeVersion ? { nodeVersion } : {}),
    ...(nodeOptions ? { nodeOptionsSha256: `sha256:${sha256(String(nodeOptions))}` } : {}) };
}
