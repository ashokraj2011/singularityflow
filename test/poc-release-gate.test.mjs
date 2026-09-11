import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parsePocReleaseArguments, pocReleaseStages, runPocReleaseGate, runPocReleaseStage
} from '../scripts/poc-release-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('POC release gate covers the installed CLI and guided SGOS behavior on its supported invoking runtime', async () => {
  const gate = await readFile(path.join(root, 'scripts', 'poc-release-gate.mjs'), 'utf8');
  assert.match(gate, /resolvePlatformProcess/,
    'npm must use the centralized Windows-safe process resolver');
  assert.match(gate, /nodeTypeScriptFlags/,
    'Node 20 and Node 22 must share the guarded TypeScript runtime selector');
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
  assert.match(gate, /test\/comprehension-brownfield\.test\.mjs/,
    'the release gate must exercise incremental brownfield and no-fabricated-history contracts');
  assert.match(gate, /test\/sgos-read-model-benchmark\.test\.mjs/,
    'the release gate must exercise the content-free SGOS read-model benchmark contract');
  assert.match(gate, /benchmark:sgos-read-model:enforce/,
    'the release gate must enforce the accepted SGOS read-model budgets');
  assert.match(gate, /test\/comprehension-command\.test\.mjs/,
    'the release gate must exercise the model-free CMP command');
  assert.match(gate, /test\/cmp-corpus-measurement\.test\.mjs/,
    'the release gate must exercise the privacy-safe real-corpus measurement boundary');
  assert.match(gate, /test\/wel-corpus-measurement\.test\.mjs/,
    'the release gate must exercise the privacy-safe WEL real-corpus measurement boundary');
  assert.match(gate, /test\/comprehension-cached-symbols\.test\.mjs/,
    'the release gate must prove optional symbol navigation is cache-only');
  assert.match(gate, /test\/comprehension-diff-preview\.test\.mjs/,
    'the release gate must exercise bounded diff output and untracked-content privacy');
  assert.match(gate, /test\/comprehension-evidence-projection\.test\.mjs/,
    'the release gate must exercise bounded exact-region delivery evidence joins');
  assert.match(gate, /test\/wel-junit5\.test\.mjs/,
    'the release gate must exercise the WEL identity corpus and optional fallback');
  assert.match(gate, /test\/wel-javascript\.test\.mjs/,
    'the release gate must exercise the static Jest\/Vitest identity contract');
  assert.match(gate, /scripts\/packaged-cli-smoke\.mjs/);
  assert.match(gate, /scripts\/packaged-vsix-engine-smoke\.mjs/,
    'the generated VSIX must execute its own contained CLI engine');
  assert.match(gate, /'run', 'benchmark:wel'/,
    'the signed release path must execute the full content-free WEL benchmark');
  assert.match(gate, /'run', 'benchmark:cmp'/,
    'the signed release path must execute the content-free CMP pilot benchmark');
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

test('exact-artifact consumer mode executes supplied artifacts and schedules zero packaging work', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-artifact-consumer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageArtifact = path.join(directory, 'singularity-flow-0.0.0.tgz');
  const vsixArtifact = path.join(directory, 'singularity-flow-vscode-0.0.0.vsix');
  await Promise.all([
    writeFile(packageArtifact, 'exact package bytes'),
    writeFile(vsixArtifact, 'exact vsix bytes')
  ]);

  const observed = [];
  const result = await runPocReleaseGate({
    rootDir: root,
    artifactPackage: packageArtifact,
    artifactVsix: vsixArtifact,
    async runStage(stage) {
      observed.push(stage);
      return { status: 0, signal: null, error: null, timedOut: false };
    }
  });
  assert.equal(result.artifactConsumption, 'passed');
  assert.equal(observed.some((stage) => stage.args.join(' ').includes('vscode:package')), false);
  assert.equal(observed.some((stage) => stage.command === 'npm'
    && stage.args[0] === 'pack'), false);
  assert.equal(observed.some((stage) => stage.args.includes('test/vscode-host.test.mjs')), false,
    'consumer mode must not load the source-host test, whose module prelude can run esbuild');
  assert.deepEqual(
    observed.find((stage) => stage.args.includes('scripts/packaged-cli-smoke.mjs'))?.args,
    ['scripts/packaged-cli-smoke.mjs', '--package', packageArtifact]
  );
  assert.deepEqual(
    observed.find((stage) => stage.args.includes('scripts/packaged-vsix-engine-smoke.mjs'))?.args,
    ['scripts/packaged-vsix-engine-smoke.mjs', '--vsix', vsixArtifact]
  );
});

test('artifact-consumer arguments are an explicit fail-closed pair', () => {
  const cwd = path.join(path.parse(root).root, 'release-fixture');
  assert.deepEqual(parsePocReleaseArguments([
    '--artifact-package', 'release.tgz', '--artifact-vsix', 'release.vsix'
  ], { cwd }), {
    artifactPackage: path.join(cwd, 'release.tgz'),
    artifactVsix: path.join(cwd, 'release.vsix')
  });
  assert.throws(() => parsePocReleaseArguments(['--artifact-package', 'release.tgz'], { cwd }),
    /requires both --artifact-package and --artifact-vsix/);
  assert.throws(() => parsePocReleaseArguments(['--artifact-vsix']), /requires a path/);
  assert.throws(() => parsePocReleaseArguments(['--unknown', 'value']), /Unknown POC release-gate option/);
  assert.throws(() => parsePocReleaseArguments([
    '--artifact-package', 'release.zip', '--artifact-vsix', 'release.vsix'
  ], { cwd }), /requires one \.tgz package and one \.vsix extension/);
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
  assert.match(smoke, /comprehension', 'record-preview', '--experimental'/,
    'the contained engine must execute the experimental CMP record preview');
  assert.match(smoke, /src\/wel\/WelJunitCatalog\.java/,
    'the contained engine must carry the WEL parser helper');
  assert.match(smoke, /classifyJunit5SurefireCommandScope/,
    'the contained engine must load the WEL adapter rather than checking a filename only');
  assert.match(smoke, /welResultAdapter\('vitest-static-v1'\)/,
    'the contained engine must load the JavaScript WEL adapter registry');
  assert.match(smoke, /hostActivation: false/,
    'the code-level smoke must not claim real VS Code-host activation');
  assert.match(smoke, /vsixPath\s*\?\s*path\.resolve\(vsixPath\)/,
    'artifact-consumer mode must select the explicitly supplied VSIX');
  assert.match(smoke, /process\.argv\.indexOf\('--vsix'\)/,
    'the isolated VSIX smoke must accept an exact artifact path');
});

test('packaged CLI smoke installs the tarball into an isolated prefix before executing it', async () => {
  const [smoke, manifest] = await Promise.all([
    readFile(path.join(root, 'scripts', 'packaged-cli-smoke.mjs'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse)
  ]);
  assert.match(smoke, /resolvePlatformProcess/);
  assert.match(smoke, /'install', '--prefix', installRoot/);
  assert.match(smoke, /node_modules', 'singularity-flow'/);
  assert.match(smoke, /installedCommand, \['--version'\]/,
    'the smoke must execute npm\'s installed command shim rather than bypassing it');
  assert.match(smoke, /comprehension', 'record-preview', '--experimental'/,
    'the installed command shim must execute the experimental CMP record preview');
  assert.match(smoke, /scripts\/cmp-corpus-measurement\.mjs/,
    'the installed package must carry the privacy-safe real-corpus runner');
  assert.match(smoke, /scripts\/wel-corpus-measurement\.mjs/,
    'the installed package must carry the privacy-safe WEL real-corpus runner');
  assert.match(smoke, /src\/wel\/WelJunitCatalog\.java/,
    'the installed package must carry the WEL parser helper');
  assert.match(smoke, /classifyJunit5SurefireCommandScope/,
    'the installed package must load the WEL adapter rather than checking a filename only');
  assert.match(smoke, /welResultAdapter\('jest-static-v1'\)/,
    'the installed package must load the JavaScript WEL adapter registry');
  assert.match(smoke, /await rm\(sandbox, \{ recursive: true, force: true \}\)/,
    'the isolated install must always be removed');
  assert.match(smoke, /if \(packagePath\)/,
    'artifact-consumer mode must bypass npm pack when an exact package is supplied');
  assert.match(smoke, /process\.argv\.indexOf\('--package'\)/,
    'the isolated package smoke must accept an exact artifact path');
  assert.match(smoke, /'--offline', tarball/,
    'the exact package must install without consulting a mutable registry');
  assert.deepEqual(
    [...manifest.bundleDependencies].sort(), Object.keys(manifest.dependencies).sort(),
    'every direct production dependency must be embedded in the signed npm artifact'
  );
  for (const version of Object.values(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
      'release production dependencies must use exact versions');
  }
});

test('Node 20 executes TypeScript tests and release authorities still refuse future skips', async () => {
  const [runner, runtime, release, receipt] = await Promise.all([
    readFile(path.join(root, 'scripts', 'run-test-suite.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'typescript-runtime.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'release.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts', 'verification-receipt.mjs'), 'utf8')
  ]);
  assert.match(runner, /process\.env\.SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES === '1'/);
  assert.match(runner, /release-test-reporter\.mjs/);
  assert.match(runner, /nodeTypeScriptFlags/);
  assert.match(runtime, /typescript-test-loader\.mjs/);
  assert.doesNotMatch(runner, /skipped\.push\(relative\)/,
    'a supported Node release must execute, rather than omit, the selected test file');
  assert.match(release, /SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'/);
  assert.match(receipt, /SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'/);
  for (const [label, source] of [['release promotion', release], ['verification receipt', receipt]]) {
    assert.match(source, /'run', 'poc:release-gate', '--'/,
      `${label} must execute the complete packaged POC gate`);
    assert.match(source, /'--artifact-package'/,
      `${label} must pass the exact npm artifact to consumer mode`);
    assert.match(source, /'--artifact-vsix'/,
      `${label} must pass the exact VSIX artifact to consumer mode`);
  }
});
