import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const runner = await readFile(path.join(root, 'apps/vscode/src/cli/runner.ts'), 'utf8');
  const client = await readFile(path.join(root, 'apps/vscode/src/cli/client.ts'), 'utf8');
  assert.match(runner, /event: 'dx\.vscode-command-timing'/);
  assert.match(runner, /outcome: 'success' \| 'error' \| 'cancelled'/);
  assert.match(runner, /stages: \{ spawnMs: number \}/);
  assert.match(client, /\[Singularity Flow timing\]/);
  assert.doesNotMatch(client, /JSON\.stringify\(args\)/, 'command arguments must not enter diagnostics');
});
