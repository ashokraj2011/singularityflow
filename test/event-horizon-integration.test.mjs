import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Event Horizon is a version-aligned private workspace bundled into the desktop', async () => {
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const desktop = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  const workbench = JSON.parse(await readFile(path.join(root, 'apps/event-horizon/package.json'), 'utf8'));

  assert.ok(rootPackage.workspaces.includes('apps/event-horizon'));
  assert.equal(workbench.name, 'singularity-event-horizon');
  assert.equal(workbench.private, true);
  assert.equal(workbench.version, rootPackage.version);
  assert.match(desktop.scripts.predev, /singularity-event-horizon/);
  assert.match(desktop.scripts.prebuild, /singularity-event-horizon/);
  assert.match(rootPackage.scripts['event-horizon:embedded-smoke'], /event-horizon-embedded-smoke/);
  assert.ok(desktop.build.extraResources.some((item) => item.from === '../event-horizon/out' && item.to === 'event-horizon/out'));
  await access(path.join(root, 'apps/event-horizon/src/main/acp/session.ts'));
  await access(path.join(root, 'apps/event-horizon/src/renderer/src/components/PermissionCard.tsx'));
});

test('Flow exposes Event Horizon through a dedicated menu and a narrow launch bridge', async () => {
  const app = await readFile(path.join(root, 'apps/desktop/src/App.jsx'), 'utf8');
  const preload = await readFile(path.join(root, 'apps/desktop/electron/preload.cjs'), 'utf8');
  const main = await readFile(path.join(root, 'apps/desktop/electron/main.mjs'), 'utf8');

  assert.match(app, /\['agent-workbench', 'Agent workbench'\]/);
  assert.match(app, /function AgentWorkbench/);
  assert.match(app, /Event Horizon/);
  assert.match(app, /window\.singularity\.openAgentWorkbench\(repository, selectedAgent, flowContext\)/);
  assert.match(preload, /agentWorkbenchStatus:/);
  assert.match(preload, /openAgentWorkbench:/);
  assert.match(main, /trustedHandle\('agent-workbench:status'/);
  assert.match(main, /trustedHandle\('agent-workbench:open'/);
  assert.match(main, /assertRepository\(repository\)/);
  assert.match(main, /SINGULARITY_FLOW_EMBED_EVENT_HORIZON/);
});

test('embedded Event Horizon reuses the active repository and preserves permission-gated ACP sessions', async () => {
  const entry = await readFile(path.join(root, 'apps/event-horizon/src/main/index.ts'), 'utf8');
  const agents = await readFile(path.join(root, 'apps/event-horizon/src/main/agents.ts'), 'utf8');
  const store = await readFile(path.join(root, 'apps/event-horizon/src/renderer/src/store.ts'), 'utf8');
  const permission = await readFile(path.join(root, 'apps/event-horizon/src/renderer/src/components/PermissionCard.tsx'), 'utf8');

  assert.match(entry, /openEventHorizonWindow\(options/);
  assert.match(entry, /activateWorkspace\(options\.cwd/);
  assert.match(entry, /session:activate/);
  assert.match(entry, /flow:context/);
  assert.match(entry, /FlowWorkspaceContext/);
  assert.match(entry, /registerEventHorizonHandlers/);
  assert.match(agents, /GitHub Copilot CLI/);
  assert.match(agents, /Claude Code/);
  assert.match(agents, /Gemini CLI/);
  assert.match(store, /case 'session:activate'/);
  assert.match(store, /case 'flow:context'/);
  assert.match(permission, /answerPermission/);
});
