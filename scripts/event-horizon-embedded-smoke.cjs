const assert = require('node:assert/strict');
const path = require('node:path');
const { app } = require('electron');

process.env.SINGULARITY_FLOW_EMBED_EVENT_HORIZON = '1';

app.whenReady().then(async () => {
  const entry = path.resolve(__dirname, '../apps/event-horizon/out/main/index.js');
  const workbench = require(entry);
  assert.equal(typeof workbench.openEventHorizonWindow, 'function');
  assert.equal(typeof workbench.registerEventHorizonHandlers, 'function');
  assert.equal(typeof workbench.eventHorizonStatus, 'function');

  const status = await workbench.eventHorizonStatus();
  assert.ok(Array.isArray(status.agents));
  assert.ok(Array.isArray(status.sessions));
  assert.ok(status.agents.some((agent) => agent.id === 'copilot'));
  process.stdout.write(`Event Horizon embedded smoke passed: ${status.agents.length} ACP runtime(s) discovered.\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  app.exit(1);
});
