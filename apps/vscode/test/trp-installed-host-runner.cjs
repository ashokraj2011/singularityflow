/* Real installed extension-host smoke, not a mocked vscode module or human approval. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
exports.run = async function run() {
  const output = process.env.SF_TRP_HOST_REPORT;
  const events = [];
  const report = { schemaVersion: 1, kind: 'installed-extension-host-smoke', passed: false,
    nativeVisualInteractionQualified: false, humanApprovalQualified: false, events };
  const record = async (name, details = {}) => { events.push({ name, ...details });
    await fs.writeFile(output, JSON.stringify(report, null, 2)); };
  try {
    const extension = vscode.extensions.getExtension('singularityflow.singularity-flow-vscode');
    assert.ok(extension, 'packaged extension must actually be installed');
    assert.ok(extension.extensionPath.startsWith(process.env.SF_TRP_EXTENSION_ROOT + path.sep),
      'actual extension is loaded from isolated installed extensions, not development source');
    await record('installed-extension-located', { path: extension.extensionPath });
    await extension.activate();
    await record('activated-installed-vsix', { path: extension.extensionPath, version: extension.packageJSON.version,
      vscodeVersion: vscode.version, trustedDisposableFixture: vscode.workspace.isTrusted });
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['singularityFlow.startWork', 'singularityFlow.reviewStoryTestRecovery',
      'workbench.action.quickOpenSelectNext', 'workbench.action.acceptSelectedQuickOpenItem']) assert.ok(commands.includes(id), id);
    await vscode.commands.executeCommand('singularityFlow.refresh');
    await vscode.commands.executeCommand('singularityFlow.startWork', { shape: 'story', source: 'manual', workType: 'feature' });
    const intake = await until(() => vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(tab => tab.label.toLowerCase().includes('start work')), 'real installed intake webview tab');
    assert.ok(intake.input instanceof vscode.TabInputWebview);
    await record('intake-webview-opened', { label: intake.label, viewType: intake.input.viewType });
    await vscode.window.tabGroups.close(intake);
    const jsonDocuments = [];
    const observe = vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId !== 'json') return;
      try { jsonDocuments.push(JSON.parse(document.getText())); } catch { /* not a JSON preview */ }
    });
    const accept = () => vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const select = async count => { for (let index = 0; index < count; index++) {
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    } await accept(); };
    // Drive the editor's actual QuickPick, never replace showQuickPick or intercept the CLI.
    let pending = vscode.commands.executeCommand('singularityFlow.reviewStoryTestRecovery');
    await delay(500); await select(0);
    await Promise.race([pending, delay(30000).then(() => { throw new Error('Recovery read did not settle'); })]);
    const policy = await until(() => jsonDocuments.find(value => value.workId === 'TRP-UI-RISK'
      || value.data?.workId === 'TRP-UI-RISK'), 'real engine policy JSON document');
    await record('recovery-policy-json-opened', { resultType: policy.resultType ?? policy.data?.resultType });
    jsonDocuments.length = 0;
    pending = vscode.commands.executeCommand('singularityFlow.reviewStoryTestRecovery');
    await delay(500); await select(3); // risks, then publication
    await delay(300); await select(0);
    const risk = await until(() => jsonDocuments.map(value => value.data ?? value)
      .find(value => value.resultType === 'story-test-risk-plan'), 'real unavailable-risk engine preview');
    assert.equal(risk.executed, false); assert.equal(risk.stateChanged, false);
    assert.equal(risk.workId, 'TRP-UI-RISK'); assert.equal(risk.operation, 'publish');
    await fs.writeFile(path.join(path.dirname(output), 'installed-risk-preview.json'), JSON.stringify(risk, null, 2));
    assert.equal(risk.agreementAuthorization.status, 'review-required');
    assert.ok(risk.issues.some(issue => issue.category === 'policy-integrity' && issue.riskEligible === false),
      'unreviewed fixture agreement must remain a non-waivable blocker');
    await record('risk-preview-rendered', { resultType: risk.resultType, observedOutcome: risk.observedOutcome,
      agreementAuthorization: risk.agreementAuthorization.status });
    await delay(300); await select(0); // exact agreement authorization preview, not approval
    const attestation = await until(() => jsonDocuments.map(value => value.data ?? value)
      .find(value => value.resultType === 'story-test-risk-record-plan'), 'exact agreement review preview');
    assert.equal(attestation.ready, true); assert.equal(attestation.executed, false); assert.equal(attestation.stateChanged, false);
    await delay(300); await select(0); // prepare command only; NEVER accept again once terminal opens
    const terminal = await until(() => vscode.window.terminals.find(value => value.name.includes('Test recovery')
      && value.name.includes('TRP-UI-RISK')), 'native staged review terminal');
    await pending;
    await record('terminal-review-staged-not-submitted', { terminalName: terminal.name,
      planDigest: attestation.planDigest, observedOutcome: risk.observedOutcome });
    observe.dispose();
    terminal.dispose();
    report.passed = true;
    await record('host-smoke-complete');
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    throw error;
  }
};
