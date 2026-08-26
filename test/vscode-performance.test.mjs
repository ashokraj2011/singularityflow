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

test('VS Code CLI diagnostics use the versioned privacy-safe timing envelope', async () => {
  const runner = codeOnly(await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8'));
  const client = await readFile(path.join(root, 'apps/vscode/src/cli/client.ts'), 'utf8');
  assert.match(runner, /event: 'dx\.vscode-command-timing'/);
  assert.match(runner, /outcome: 'success' \| 'error' \| 'cancelled'/);
  assert.match(runner, /stages: \{ spawnMs: number \}/);
  assert.match(client, /\[Singularity Flow timing\]/);
  assert.doesNotMatch(client, /JSON\.stringify\(args\)/, 'command arguments must not enter diagnostics');
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
   * The local Git calls in `runner.ts` are deliberately still synchronous: they read refs and blobs
   * from this repository and cost milliseconds. The rule is about the host, not about purity.
   */
  // `codeOnly`: the paragraph above says "spawnSync" four times, and a grep over raw source would
  // read its own explanation as the defect it describes.
  const extension = codeOnly(await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8'));
  assert.doesNotMatch(extension, /\bspawnSync\b/,
    'the extension entry point runs a synchronous subprocess; it blocks the whole extension host');

  const runner = await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8');
  for (const [verb, bound] of [['ls-remote', '30_000'], ['fetch', '120_000']]) {
    const call = new RegExp(`(spawnSync|await remoteGit)\\((?:'git', )?\\[[^\\]]*'${verb}'`, 's');
    const matched = call.exec(runner);
    assert.ok(matched, `the ${verb} call on the resolution path is no longer recognisable`);
    assert.equal(matched[1], 'await remoteGit',
      `remote Git \`${verb}\` is synchronous again, so a slow remote freezes the host for ${bound}ms`);
  }
});
