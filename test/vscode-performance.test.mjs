import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('VS Code activation keeps heavyweight webview panels behind dynamic imports', async () => {
  const source = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  const panels = [
    'workspace-panel', 'journey', 'reconciliation', 'approvals', 'inbox', 'stories', 'impact',
    'capabilities', 'intake-panel', 'dashboard', 'flow-impact', 'designer',
    'instruction-designer', 'workspace-logs', 'specification-trace', 'visual-assurance',
    'configuration-center', 'help', 'workspaces-panel', 'bootstrap-panel'
  ];

  for (const panel of panels) {
    const escaped = panel.replaceAll('-', '\\-');
    assert.doesNotMatch(
      source,
      new RegExp(`^import(?!\\s+type\\b)[^\\n]*['\"]\\./views/${escaped}\\.ts['\"]`, 'm'),
      `${panel} must not load while the extension activates`
    );
    assert.match(
      source,
      new RegExp(`import\\(['\"]\\./views/${escaped}\\.ts['\"]\\)`),
      `${panel} must load only when its command is selected`
    );
  }
});

test('gateway-only helpers initialize only when their surfaces are invoked', async () => {
  const source = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  for (const module of ['conversation', 'result']) {
    assert.doesNotMatch(source,
      new RegExp(`^import(?!\\s+type\\b)[^\\n]*['"]\\.\\.\\/\\.\\.\\/\\.\\.\\/src/gateway/${module}\\.mjs['"]`, 'm'),
      `${module}.mjs still initializes with the extension entry point`);
    assert.match(source,
      new RegExp(`await import\\(['"]\\.\\.\\/\\.\\.\\/\\.\\.\\/src/gateway/${module}\\.mjs['"]\\)`),
      `${module}.mjs is not loaded by its invoking surface`);
  }
});

test('VS Code CLI diagnostics use the versioned privacy-safe timing envelope', async () => {
  const runner = codeOnly(await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8'));
  const client = await readFile(path.join(root, 'apps/vscode/src/cli/client.ts'), 'utf8');
  assert.match(runner, /event: 'dx\.vscode-command-timing'/);
  assert.match(runner, /outcome: 'success' \| 'error' \| 'cancelled'/);
  assert.match(runner, /stages: \{ spawnMs: number \}/);
  assert.match(client, /\[Singularity Flow timing\]/);
  assert.doesNotMatch(client, /JSON\.stringify\(args\)/, 'command arguments must not enter diagnostics');
});

test('activation defers auxiliary CLI reads until the initial snapshot is confirmed', async () => {
  const source = codeOnly(await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8'));
  const prime = source.indexOf('store.primeFromCache()');
  const refresh = source.indexOf('await store.refresh()', prime);
  const confirmed = source.indexOf('initialRefreshCompleted = true', refresh);
  const auxiliary = source.indexOf('startAuxiliaryReadsAfterConfirmedSnapshot()', confirmed);
  assert.ok(prime >= 0 && refresh > prime && confirmed > refresh && auxiliary > confirmed,
    'readiness or logs can start before the initial confirmed store refresh');
  assert.match(source, /if \(!initialRefreshCompleted \|\| state\.stale \|\| state\.error \|\| !state\.snapshot\) return/,
    'the auxiliary-read gate accepts an unconfirmed or failed snapshot');
  assert.match(source, /statusWorkId = workflow\.workItem\.id;\s*if \(state\.stale\) return/,
    'cached first paint launches status-chrome derivations before repository confirmation');
});

test('structured CLI payloads are buffered linearly and hidden from the Output channel', async () => {
  const runner = codeOnly(await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8'));
  const client = codeOnly(await readFile(path.join(root, 'apps/vscode/src/cli/client.ts'), 'utf8'));
  const invoke = runner.slice(runner.indexOf('export function invokeCli'));
  assert.match(invoke, /const stdoutChunks: string\[\] = \[\]/);
  assert.match(invoke, /stdoutChunks\.join\(''\)/);
  assert.doesNotMatch(invoke, /return target \+ text|stdout \+=|stderr \+=/,
    'chunk collection copies all previously received output for every chunk');
  assert.match(client, /if \(stream === 'stderr'\) this\.options\.onOutput\?\.\(text, stream\)/,
    'JSON stdout is still forwarded to the VS Code Output channel');
});

test('snapshot cache identity is resolved from the currently selected repository', async () => {
  const extension = codeOnly(await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8'));
  assert.match(extension, /const snapshotCacheKey = \(\): string => `snapshot:\$\{repository\}`/);
  const useRepository = extension.indexOf('client.useRepository(canonicalTarget)');
  const activeContext = extension.indexOf('setActiveRepositoryContext({', useRepository);
  const reset = extension.indexOf('store.repositoryChanged()', useRepository);
  const refresh = extension.indexOf('await store.refresh()', reset);
  assert.ok(useRepository >= 0 && activeContext > useRepository && reset > activeContext && refresh > reset,
    'repository switching leaves the previous snapshot/cache identity active or publishes before context is rebound');
});

test('nothing on the activation path stops the extension host with a synchronous subprocess', async () => {
  /**
   * `spawnSync` in an extension does not block a worker — it blocks the whole host, so every other
   * extension and the window's own responsiveness wait with it. Two places did it with the longest
   * bounds in the codebase, and both are reached at the worst possible moment.
   *
   * `firstRunChecks` probed Git and the bundled CLI with 5- and 10-second timeouts, inside a function
   * that was already `async` and already awaited four filesystem checks. On a first run, a slow Git
   * and a CLI that will not start could freeze the window for fifteen seconds before anything was
   * drawn. They now run together, so the worst case is the slower rather than the sum.
   *
   * The repository-resolution path in `runner.ts` did an `ls-remote` bounded at 30 seconds and a
   * `fetch` bounded at 120 — bounds that described how long VS Code could be frozen rather than how
   * long the operation could take. That path is the narrow-clone recovery, reached only when both
   * local authorities are missing, which is exactly when a remote is most likely to be slow.
   *
   * Local ref and object inspection uses the same asynchronous boundary and batches work across
   * refs. A local repository with thousands of remote-tracking refs can otherwise freeze the host
   * just as effectively as a slow remote, one short synchronous process at a time.
   */
  // `codeOnly`: the paragraph above says "spawnSync" four times, and a grep over raw source would
  // read its own explanation as the defect it describes.
  const extension = codeOnly(await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8'));
  assert.doesNotMatch(extension, /\bspawnSync\b/,
    'the extension entry point runs a synchronous subprocess; it blocks the whole extension host');

  const runnerRaw = await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8');
  const runner = codeOnly(runnerRaw);
  assert.doesNotMatch(runner, /\bspawnSync\b/,
    'repository validation or CLI cancellation still blocks the extension host synchronously');
  assert.match(runner, /spawn\(windowsSystemTool\('taskkill\.exe'\)/,
    'Windows process-tree termination no longer uses the asynchronous supervisor');
  assert.match(runner, /\^\[a-z\]:\[\\\\\/\]\/i\.test\(root\)/,
    'VS Code system tools do not require a fully qualified local drive root');
  assert.doesNotMatch(runner, /path\.win32\.isAbsolute\(root\)/,
    'VS Code system tools still accept root-relative, UNC, or device paths');
  assert.match(runner, /killer\.once\('close', \(code\) => finish\(code === 0\)\)/,
    'Windows taskkill is assumed successful without observing its exit status');
  assert.match(runner, /if \(killed\) return true;[\s\S]*?child\.kill\(signal\)/,
    'taskkill failure has no direct-child fallback');
  assert.match(runner,
    /const advertise = \(remote: string, signal = options\.signal\) => runRemote\(\[\s*'ls-remote'[\s\S]*?timeout: 30_000/,
    'the bounded asynchronous ls-remote observation is no longer recognisable');
  assert.match(runner, /const fetched = await runRemote\(\[\s*'fetch'[\s\S]*?timeout: 120_000/,
    'the bounded asynchronous fetch is no longer recognisable');
  assert.match(runner, /startRemoteProbePool\(additional, advertise, options\.signal\)/,
    'additional remotes are back behind serial timeout windows');
});
