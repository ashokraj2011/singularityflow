/** Runs only in a disposable VS Code profile created by verify-sidebar-installed.mjs. */
const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
  const report = process.env.SFLOW_UI_REPORT;
  if (!report) throw new Error('An isolated UI report destination is required.');
  const extension = vscode.extensions.getExtension('singularityflow.singularity-flow-vscode');
  assert.ok(extension, 'packaged extension is installed');
  const installedRelative = path.relative(process.env.SFLOW_UI_EXTENSION_ROOT, extension.extensionPath);
  assert.ok(installedRelative && !installedRelative.startsWith('..') && !path.isAbsolute(installedRelative),
    'target extension is loaded from the isolated installed-extension directory, not the development checkout');
  await extension.activate();
  await vscode.commands.executeCommand('singularityFlow.navigation.focus');
  const destinations = [
    ['singularityFlow.openWorkspaceStories', 'singularityFlow.workspaceStories'],
    ['singularityFlow.openReviews', 'singularityFlow.reviews'],
    ['singularityFlow.openWorkspaces', 'singularityFlow.workspaces'],
    ['singularityFlow.openConfigurationCenter', 'singularityFlow.configurationCenter'],
    ['singularityFlow.myWork', 'singularityFlow.result']
  ];
  const results = [];
  for (const [command, viewType] of destinations) {
    await vscode.commands.executeCommand(command);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputWebview && input.viewType.endsWith(viewType)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputWebview && input.viewType.endsWith(viewType),
      `${command} opens its own native editor tab`);
    results.push({ command, status: 'passed' });
  }
  await writeFile(report, JSON.stringify({
    editorVersion: vscode.version, extensionMode: 'installed-production', results
  }, null, 2));
};
