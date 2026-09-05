import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pocReleaseStages, runPocReleaseStage } from '../scripts/poc-release-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('POC release gate covers the installed CLI and guided SGOS behavior on its supported invoking runtime', async () => {
  const gate = await readFile(path.join(root, 'scripts', 'poc-release-gate.mjs'), 'utf8');
  assert.match(gate, /resolvePlatformProcess/,
    'npm must use the centralized Windows-safe process resolver');
  assert.match(gate, /typescript-test-loader\.mjs/,
    'Node 20 must execute the guided TypeScript behavior test rather than skip it');
  assert.match(gate, /test\/poc-lite-workflow\.test\.mjs/,
    'the release gate must exercise the model-free POC Lite lifecycle');
  assert.match(gate, /test\/mcp-auth-profile\.test\.mjs/,
    'the release gate must exercise private authenticated-browser profiles');
  assert.match(gate, /test\/platform-process\.test\.mjs/,
    'the release gate must exercise the Windows npm and npx process boundary');
  assert.match(gate, /test\/local-install-script\.test\.mjs/,
    'the release gate must exercise source-installer modes and recovery');
  assert.match(gate, /test\/install-staged-artifacts\.test\.mjs/,
    'the release gate must exercise exact staged-artifact validation');
  assert.match(gate, /test\/vscode-sgos-workflow-create\.test\.mjs/);
  assert.match(gate, /test\/comprehension-contracts\.test\.mjs/,
    'the release gate must exercise the deterministic CMP corpus');
  assert.match(gate, /test\/comprehension-command\.test\.mjs/,
    'the release gate must exercise the model-free CMP command');
  assert.match(gate, /test\/wel-junit5\.test\.mjs/,
    'the release gate must exercise the WEL identity corpus and optional fallback');
  assert.match(gate, /scripts\/packaged-cli-smoke\.mjs/);
  assert.match(gate, /scripts\/packaged-vsix-engine-smoke\.mjs/,
    'the generated VSIX must execute its own contained CLI engine');
  assert.match(gate, /SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'/);
  assert.match(gate, /release-test-reporter\.mjs/,
    'the direct grouped Node test stage must reject skipped, cancelled, and todo outcomes');
  assert.match(gate, /isolated stub host/,
    'the local bundle journey must not be mislabeled as real installed-VSIX activation');
  assert.match(gate, /Real-host and supported-platform receipts remain separate release evidence/);
});

test('every direct node:test release stage uses the strict reporter and gate self-tests do not recurse', () => {
  const stages = pocReleaseStages({ rootDir: root });
  assert.ok(stages.length >= 8);
  for (const stage of stages) {
    assert.ok(Number.isSafeInteger(stage.timeoutMs) && stage.timeoutMs > 0,
      `${stage.label} has no bounded deadline`);
  }

  const nodeTestStages = stages.filter((stage) => stage.command === process.execPath
    && stage.args.includes('--test'));
  assert.equal(nodeTestStages.length, 2);
  for (const stage of nodeTestStages) {
    const reporter = stage.args.indexOf('--test-reporter');
    assert.ok(reporter >= 0, `${stage.label} bypasses the strict release reporter`);
    assert.match(stage.args[reporter + 1], /scripts[/\\]release-test-reporter\.mjs$/u);
  }

  const grouped = nodeTestStages.find((stage) => stage.args.includes('test/poc-release-gate.test.mjs'));
  assert.ok(grouped, 'the release gate does not execute its own contract tests');
  assert.ok(grouped.args.includes('test/release-test-reporter.test.mjs'),
    'the release gate does not execute the strict reporter tests');
  assert.equal(stages.some((stage) => stage.args.includes('scripts/poc-release-gate.mjs')), false,
    'a release stage recursively executes the release gate');
  assert.equal(stages.some((stage) => stage.command === 'npm'
    && stage.args.join(' ') === 'run poc:release-gate'), false,
    'a release stage recursively invokes the npm release-gate script');
});

test('a stage deadline force-cleans the process tree and settles without a child close event', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const signals = [];
  const started = Date.now();
  const result = await runPocReleaseStage({
    label: 'never closes', command: 'fixture', args: [], timeoutMs: 10
  }, {
    platform: 'linux',
    spawnCommand() { return child; },
    resolveProcess(command, args) { return { executable: command, arguments: args, spawnOptions: {} }; },
    terminateTree(_child, signal) {
      signals.push(signal);
      return new Promise(() => {});
    },
    terminationGraceMs: 20
  });

  assert.equal(result.status, 1);
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 250, 'the stage escaped its deadline plus cleanup grace');
});

test('the exact VSIX smoke extracts a bounded engine and enforces a source-module boundary', async () => {
  const smoke = await readFile(path.join(root, 'scripts', 'packaged-vsix-engine-smoke.mjs'), 'utf8');
  assert.match(smoke, /const CLI_PREFIX = 'extension\/cli\/'/);
  assert.match(smoke, /`\$\{CLI_PREFIX\}bin\/singularity-flow\.mjs`/);
  assert.match(smoke, /source-boundary-loader\.mjs/);
  assert.match(smoke, /VSIX engine attempted file-module resolution outside its extracted tree/);
  assert.match(smoke, /delete environment\.NODE_OPTIONS/);
  assert.match(smoke, /NODE_PATH: path\.join\(sandbox, 'no-node-path'\)/);
  assert.match(smoke, /help', '--json'/,
    'the contained engine must execute a structured surface, not merely parse its manifest');
  assert.match(smoke, /comprehension', 'regions'/,
    'the contained engine must execute the CMP observe-only command');
  assert.match(smoke, /src\/wel\/WelJunitCatalog\.java/,
    'the contained engine must carry the WEL parser helper');
  assert.match(smoke, /classifyJunit5SurefireCommandScope/,
    'the contained engine must load the WEL adapter rather than checking a filename only');
  assert.match(smoke, /hostActivation: false/,
    'the code-level smoke must not claim real VS Code-host activation');
});

test('packaged CLI smoke installs the tarball into an isolated prefix before executing it', async () => {
  const smoke = await readFile(path.join(root, 'scripts', 'packaged-cli-smoke.mjs'), 'utf8');
  assert.match(smoke, /resolvePlatformProcess/);
  assert.match(smoke, /'install', '--prefix', installRoot/);
  assert.match(smoke, /node_modules', 'singularity-flow'/);
  assert.match(smoke, /installedCommand, \['--version'\]/,
    'the smoke must execute npm\'s installed command shim rather than bypassing it');
  assert.match(smoke, /comprehension', 'regions'/,
    'the installed command shim must execute the CMP observe-only command');
  assert.match(smoke, /src\/wel\/WelJunitCatalog\.java/,
    'the installed package must carry the WEL parser helper');
  assert.match(smoke, /classifyJunit5SurefireCommandScope/,
    'the installed package must load the WEL adapter rather than checking a filename only');
  assert.match(smoke, /await rm\(sandbox, \{ recursive: true, force: true \}\)/,
    'the isolated install must always be removed');
});

test('Node 20 executes TypeScript tests and release authorities still refuse future skips', async () => {
  const [runner, release, receipt] = await Promise.all([
    readFile(path.join(root, 'scripts', 'run-test-suite.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'release.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'verification-receipt.mjs'), 'utf8')
  ]);
  assert.match(runner, /process\.env\.SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES === '1'/);
  assert.match(runner, /release-test-reporter\.mjs/);
  assert.match(runner, /typescript-test-loader\.mjs/);
  assert.doesNotMatch(runner, /skipped\.push\(relative\)/,
    'a supported Node release must execute, rather than omit, the selected test file');
  assert.match(release, /SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'/);
  assert.match(receipt, /SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'/);
  assert.match(release, /\['run', 'poc:release-gate'\]/,
    'release promotion must execute the complete packaged POC gate');
  assert.match(receipt, /\['run', 'poc:release-gate'\]/,
    'the signed verification receipt must bind the complete packaged POC gate');
});
