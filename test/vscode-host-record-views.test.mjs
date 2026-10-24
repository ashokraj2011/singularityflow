/**
 * The four record views a host action opens: who emits each action, what the editor keeps, what
 * each view shows from records that exist, and that a page can only ever run the routes its model
 * offered. `[INT:IFC-060]` `[INT:IFC-061]` `[INT:CON-130]` `[INT:CON-131]`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateHostAction } from '../src/gateway/argument-schemas.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { EVIDENCE_SEQUENCE, problemInvestigate } from '../src/gateway/planners/problem-investigate.mjs';
import { workContinueResult } from '../src/gateway/planners/work-continue.mjs';
import { workHandoffResult } from '../src/gateway/planners/work-handoff.mjs';
import { progressSnapshot } from '../src/progress.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A `vscode` the panel and its navigation can import, recording what they ask of the editor.
const editor = { panels: [], executed: [] };
globalThis.__sfHostRecordVscode = {
  ViewColumn: { Active: 1, Beside: 2 },
  window: {
    createWebviewPanel(viewType, title) {
      const panel = {
        viewType, title, listeners: [], disposed: [],
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { panel.listeners.push(listener); return { dispose() {} }; } },
        onDidDispose(listener) { panel.disposed.push(listener); return { dispose() {} }; },
        reveal() {},
        dispose() { for (const listener of panel.disposed) listener(); },
        post: async (message) => { for (const listener of panel.listeners) await listener(message); }
      };
      editor.panels.push(panel);
      return panel;
    },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  commands: {
    getCommands: async () => ['singularityFlow.openJourney', 'singularityFlow.openHandoff', 'singularityFlow.openProgress', 'singularityFlow.openStories'],
    executeCommand: async (id, ...args) => { editor.executed.push({ id, args }); }
  }
};
const vscodeShim = `data:text/javascript,${encodeURIComponent(`
  const api = globalThis.__sfHostRecordVscode;
  export const ViewColumn = api.ViewColumn; export const window = api.window; export const commands = api.commands;
  export const env = {}; export const Uri = { parse: (value) => value };
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`)}`);

const views = (name) => pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'views', name)).href;
const pageModule = await import(views('host-record-page.ts'));
const { HostRecordPanel } = await import(views('host-record-panel.ts'));
const {
  contextReceiptView, handoffView, hostRecordHtml, hostRecordRequest, investigationView, progressView
} = pageModule;

const binding = {
  workspaceId: 'payments', repository: 'payments-api', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: 'dev-1', hostSessionId: 'sess-records'
};

const workItem = Object.freeze({
  kind: 'story', id: 'WRK-42', title: 'Make <checkout> retries safe', repository: 'payments-api', repositoryId: 'payments-api',
  branch: 'WRK-42', branches: ['WRK-42'], phase: 'specification', phaseLabel: 'Specification', generation: 2,
  status: 'awaiting_approval',
  rail: [
    { id: 'intake', label: 'Intake', state: 'done', status: 'approved' },
    { id: 'specification', label: 'Specification', state: 'current', status: 'awaiting_approval' },
    { id: 'implementation', label: 'Implementation', state: 'pending', status: null }
  ],
  lastMaterialEvent: { event: 'phase_submitted', phase: 'specification', actor: 'dev-1', at: '2026-08-17T08:00:00.000Z' },
  blockers: ['approvals-outstanding'], recovery: null, group: 'waiting-on-you', whyVisible: 'approval.you-are-authorized',
  nextAction: { operation: 'review.packet', reasonCode: 'approval.open-the-packet' }
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: childTimeout(60_000) });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-host-records-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'records@example.test');
  git(dir, 'config', 'user.name', 'Records Fixture');
  await writeFile(path.join(dir, 'postal.mjs'), 'export const postalRequired = true;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'postal check');
  return dir;
}

const workflow = () => ({
  workItem: { id: 'WRK-42', workType: 'feature' }, status: 'active', currentPhase: 'specification',
  phaseOrder: ['intake', 'specification', 'implementation'],
  phases: {
    intake: { label: 'Intake', status: 'approved', generation: 1, approvals: [{ decision: 'approved' }], approvalPolicy: { minimum: 1 }, usage: [] },
    specification: { label: 'Specification', status: 'awaiting_approval', generation: 2, approvals: [], approvalPolicy: { minimum: 2 }, usage: [{ totalTokens: 1200, status: 'exact' }] },
    implementation: { label: 'Implementation', status: 'pending', generation: 0, approvals: [], approvalPolicy: {}, usage: [] }
  },
  documents: { count: 3 }, usage: { totalTokens: 1200 }
});

const ledger = () => ({
  workId: 'WRK-42', phase: null, models: [],
  packets: [{
    packetId: 'ctx-aaaaaaaaaaaaaaaaaaaa', phase: 'intake', generation: 1,
    correlation: { operationId: 'context.brief' }, flightPlanId: null,
    includedBytes: { value: 2048, status: 'exact', assurance: 'sflow-measured' },
    estimatedTokens: { value: 512, status: 'estimated', assurance: 'sflow-estimated' },
    estimationMethod: 'utf8-bytes-divided-by-four', omittedItems: 0, omissionClasses: {}, unavailableItems: 0, unavailableCodes: [],
    expansionRequests: 0, expandedBytes: { value: 0, status: 'exact', assurance: 'sflow-measured' }, expansions: [],
    cacheKey: 'k1', contextManifestSha256: 'm1', cacheManifestId: 'cache-1', tokenEconomy: { mode: 'balanced', profile: 'default', configurationDigest: 'd1' },
    itemUsage: [{ itemDigest: 'a'.repeat(64), bytes: 2048, estimatedTokens: 512, mandatory: true, cacheClass: 'stable' }],
    provider: { id: null, requestedModel: null, resolvedModel: null, resolutionAssurance: 'unavailable', captureCoverage: 'estimated' }
  }, {
    packetId: 'ctx-bbbbbbbbbbbbbbbbbbbb', phase: 'specification', generation: 2,
    correlation: { operationId: 'context.brief' }, flightPlanId: 'FP-1',
    includedBytes: { value: 9000, status: 'exact', assurance: 'sflow-measured' },
    estimatedTokens: { value: 2250, status: 'estimated', assurance: 'sflow-estimated' },
    estimationMethod: 'utf8-bytes-divided-by-four', omittedItems: 3, omissionClasses: { budget: 2, 'policy-excluded': 1 }, unavailableItems: 1,
    unavailableCodes: ['EPC_SOURCE_UNAVAILABLE'], expansionRequests: 1,
    expandedBytes: { value: 400, status: 'exact', assurance: 'sflow-measured' },
    expansions: [{ handleKind: 'symbol-body', includedBytes: 400, estimatedTokens: 100, expandedAt: '2026-10-24T09:00:00.000Z' }],
    cacheKey: 'k2', contextManifestSha256: 'm2', cacheManifestId: 'cache-2', tokenEconomy: { mode: 'balanced', profile: 'default', configurationDigest: 'd2' },
    itemUsage: [
      { itemDigest: 'b'.repeat(64), bytes: 6000, estimatedTokens: 1500, mandatory: true, cacheClass: 'stable' },
      { itemDigest: 'c'.repeat(64), bytes: 3000, estimatedTokens: 750, mandatory: false, cacheClass: 'variable' }
    ],
    provider: { id: 'copilot', requestedModel: 'auto', resolvedModel: null, resolutionAssurance: 'unavailable', captureCoverage: 'partial' }
  }]
});

const text = (html) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gu, '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ');

test('an investigation names its report by an ID derived from it and offers the Investigation view', async (t) => {
  const repo = await repository(t);
  const first = await problemInvestigate({ root: repo, arguments: { symptom: 'postal check fails at checkout' }, context: { workId: 'WRK-42' } });
  const open = first.next.find((action) => action.id === 'investigation:open-view');
  assert.match(first.data.investigationId, /^inv-[0-9a-f]{20}$/u);
  assert.deepEqual(open.hostAction, { id: 'vscode.openInvestigation', arguments: { investigationId: first.data.investigationId, workId: 'WRK-42' } });
  assert.deepEqual([open.kind, open.executable, open.fallback.command], ['host-action', false, 'sflow explain investigation']);
  assert.equal(validateHostAction(open.hostAction).ok, true);
  const again = await problemInvestigate({ root: repo, arguments: { symptom: 'postal check fails at checkout' }, context: { workId: 'WRK-42' } });
  assert.equal(again.data.investigationId, first.data.investigationId, 'the same evidence names the same report');
  // A work ID that is not an identifier is left out rather than sent.
  const odd = await problemInvestigate({ root: repo, arguments: { symptom: 'postal check fails' }, context: { workId: '../x' } });
  assert.deepEqual(Object.keys(odd.next.find((action) => action.id === 'investigation:open-view').hostAction.arguments), ['investigationId']);
});

test('a handoff offers its packet view and Story work offers its progress view, by ID only', () => {
  const handoff = workHandoffResult(workItem, { sourceCommit: 'a'.repeat(40) });
  const view = handoff.next.find((action) => action.id === 'handoff:WRK-42:open-view');
  assert.deepEqual(view.hostAction, { id: 'vscode.openHandoff', arguments: { workId: 'WRK-42', workKind: 'story' } });
  assert.equal(view.fallback.command, 'sflow status --work-id WRK-42');
  assert.equal(validateHostAction(view.hostAction).ok, true);

  const continued = workContinueResult(workItem, { sourceCommit: 'a'.repeat(40) });
  const progress = continued.next.find((action) => action.id === 'progress:WRK-42:open-view');
  assert.deepEqual(progress.hostAction, { id: 'vscode.openProgress', arguments: { workId: 'WRK-42' } });
  assert.equal(progress.fallback.command, 'sflow progress WRK-42');
  assert.equal(continued.next.at(-1), progress, 'the view trails the lifecycle actions');
  assert.equal(continued.next[0].emphasis, 'primary', 'the first legal action still leads');
  // An initiative has no Story progress to read, and an unreadable recovery marker offers diagnosis only.
  assert.equal(workContinueResult({ ...workItem, kind: 'initiative' }, { sourceCommit: 'a'.repeat(40) })
    .next.some((action) => action.hostAction), false);
  assert.deepEqual(workContinueResult({ ...workItem, recovery: { status: 'unreadable' } }, { sourceCommit: 'a'.repeat(40) }).next, []);
});

test('the kernel keeps a declared record view and withholds an undeclared one, keeping its terminal route', async () => {
  const planners = gatewayPlanners({ 'work-handoff': () => workHandoffResult(workItem, { sourceCommit: 'c'.repeat(40) }) });
  const read = async (hostActions) => {
    const kernel = createGatewayKernel({ binding, planners, hostCapabilities: { confirmationChannel: 'native', hostActions } });
    const resolved = await kernel.resolve({ utterance: 'handoff packet', arguments: { workId: 'WRK-42', workKind: 'story' } });
    return kernel.read({ resolutionId: resolved.next[0].handle });
  };
  const editorHost = (await read(['vscode.openHandoff'])).next.find((action) => action.id === 'handoff:WRK-42:open-view');
  assert.deepEqual(editorHost.hostAction, { id: 'vscode.openHandoff', arguments: { workId: 'WRK-42', workKind: 'story' } });
  const mcp = (await read([])).next.find((action) => action.id === 'handoff:WRK-42:open-view');
  assert.equal(mcp.hostAction, undefined, 'a host without the view is not offered it');
  assert.equal(mcp.fallback.command, 'sflow status --work-id WRK-42', 'and keeps the same continuation');
});

test('the editor session keeps the investigation reports its kernel returned, bounded, and nothing else', async (t) => {
  const repo = await repository(t);
  const editorSession = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts')).href);
  t.after(() => editorSession.resetGatewaySession());
  const session = editorSession.gatewaySession({ root: repo, workspaceId: null, workspaceName: null, repositoryId: 'payments-api', origin: 'test' });
  assert.deepEqual([...session.investigations.list()], []);
  const resolution = await session.kernel.resolve({ utterance: 'investigate this bug', arguments: { symptom: 'postal check fails at checkout' } });
  const result = resolution.kind === 'read' && resolution.next.length === 1
    ? await session.kernel.read({ resolutionId: resolution.next[0].handle }) : resolution;
  assert.equal(result.operation.id, 'problem.investigate');
  const id = result.data.investigationId;
  assert.equal(session.investigations.get(id)?.result, result, 'the report the kernel returned, kept as it was');
  const link = result.next.find((action) => action.id === 'investigation:open-view');
  assert.deepEqual(link.hostAction.arguments, { investigationId: id }, 'the editor declares the view, so the link survives');
  const received = session.hostActions.receive(link.hostAction);
  assert.deepEqual([received.command, received.args], ['singularityFlow.openInvestigation', [{ investigationId: id }]]);
  // Another read is not kept; an unknown ID finds nothing.
  await session.kernel.resolve({ utterance: 'home' });
  assert.equal(session.investigations.list().length, 1);
  assert.equal(session.investigations.get('inv-00000000000000000000'), null);
});

test('the Investigation view shows the kept report, and says plainly when this window has none', async (t) => {
  const repo = await repository(t);
  const result = await problemInvestigate({ root: repo, arguments: { symptom: 'postal check fails', expected: 'it passes' }, context: { repositoryId: 'payments-api' } });
  const kept = { investigationId: result.data.investigationId, receivedAt: '2026-10-24T10:00:00.000Z', result };
  const model = investigationView({ request: { investigationId: kept.investigationId }, record: kept, kept: [kept] });
  assert.equal(model.state, 'ready');
  assert.equal(model.choice, null, 'one report needs no choice');
  assert.deepEqual(model.facts.find(([label]) => label === 'Repository'), ['Repository', 'payments-api']);
  // A window with no workspace repository ID: the report names the checkout, so the page never shows its path.
  const editorSession = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts')).href);
  t.after(() => editorSession.resetGatewaySession());
  const session = editorSession.gatewaySession({ root: repo, workspaceId: null, workspaceName: null, repositoryId: null, origin: 'test' });
  const resolved = await session.kernel.resolve({ utterance: 'investigate this bug', arguments: { symptom: 'postal check fails' } });
  const unregistered = resolved.kind === 'read' && resolved.next.length === 1
    ? await session.kernel.read({ resolutionId: resolved.next[0].handle }) : resolved;
  const rooted = investigationView({ record: session.investigations.get(unregistered.data.investigationId) });
  assert.deepEqual(rooted.facts.find(([label]) => label === 'Repository'), ['Repository', path.basename(repo)]);
  assert.equal(hostRecordHtml(rooted, 'r0').includes(repo), false, 'the checkout path reached the page');
  const steps = model.sections.find((section) => section.heading === 'Evidence sequence');
  assert.deepEqual(steps.table.rows.map((row) => row[0]), EVIDENCE_SEQUENCE.map((step) => step.replaceAll('-', ' ')));
  const asked = model.sections.find((section) => section.heading === 'What was asked');
  assert.deepEqual(asked.facts.find(([label]) => label === 'expected'), ['expected', 'given (its words are not kept in the report)']);
  assert.match(asked.facts.find(([label]) => label === 'environment')[1], /^unknown/u, 'a missing input stays unknown');
  assert.match(text(hostRecordHtml(model, 'r1')), /None recorded — a person concludes/u);
  assert.match(model.sections.find((section) => section.heading === 'Change range and bisection').note, /No bisection was offered/u);

  const missing = investigationView({ request: { investigationId: 'inv-11111111111111111111' }, record: null, kept: [kept] });
  assert.equal(missing.state, 'unavailable');
  assert.match(missing.notice.text, /is not held by this window.*stores nothing/u);
  assert.deepEqual(missing.choice.options.map((option) => option.value), [kept.investigationId]);
  assert.match(investigationView().notice.text, /has not run an investigation/u);
  assert.equal(investigationView().guidance, 'singularity-flow explain investigation');
});

test('the Context receipt view reads one recorded receipt, never billing, and names what is missing', () => {
  const chosen = contextReceiptView({ request: { receiptId: 'ctx-bbbbbbbbbbbbbbbbbbbb' }, workId: 'WRK-42', ledger: ledger() });
  assert.equal(chosen.state, 'ready');
  assert.deepEqual(chosen.choice.options.map((option) => [option.value, option.selected]),
    [['ctx-aaaaaaaaaaaaaaaaaaaa', false], ['ctx-bbbbbbbbbbbbbbbbbbbb', true]]);
  const included = chosen.sections.find((section) => section.heading === 'What it included');
  assert.match(included.note, /an estimate \(utf8-bytes-divided-by-four\), not provider billing/u);
  assert.deepEqual(included.table.rows.map((row) => row[3]), ['required', 'optional']);
  assert.deepEqual(chosen.sections.find((section) => section.heading === 'What it left out').table.rows, [['budget', '2'], ['policy excluded', '1']]);
  assert.equal(chosen.sections.find((section) => section.heading === 'Model route').facts.find(([label]) => label === 'Resolved model')[1], 'unavailable');
  assert.equal(chosen.guidance, 'singularity-flow context xray --work-id WRK-42 --phase specification --packet ctx-bbbbbbbbbbbbbbbbbbbb');
  // With no receipt named, the newest is shown; a receipt not recorded here is said to be missing.
  assert.equal(contextReceiptView({ workId: 'WRK-42', ledger: ledger() }).facts[0][1], 'ctx-bbbbbbbbbbbbbbbbbbbb');
  const absent = contextReceiptView({ request: { receiptId: 'ctx-cccccccccccccccccccc' }, workId: 'WRK-42', ledger: ledger() });
  assert.equal(absent.state, 'unavailable');
  assert.match(absent.notice.text, /is not recorded for WRK-42 on this computer/u);
  assert.match(contextReceiptView({ workId: 'WRK-42', ledger: { packets: [] } }).notice.text, /No context receipt is recorded/u);
  assert.match(contextReceiptView().notice.text, /No Story is selected/u);
});

test('the Handoff view draws the packet sections, and a refusal as unavailable', () => {
  const result = workHandoffResult(workItem, { sourceCommit: 'a'.repeat(40) });
  const model = handoffView({ request: { workId: 'WRK-42', workKind: 'story' }, workId: 'WRK-42', result });
  assert.equal(model.state, 'ready');
  assert.deepEqual(model.facts.find(([label]) => label === 'Source commit'), ['Source commit', 'a'.repeat(40)]);
  assert.deepEqual(model.sections.find((section) => section.heading === 'Remaining').items,
    ['Specification · current · awaiting approval', 'Implementation · pending']);
  assert.deepEqual(model.sections.find((section) => section.heading === 'Risks').items, ['Blocked: approvals outstanding']);
  assert.match(model.sections.find((section) => section.heading === 'Tests').items[0], /^Not read by this packet/u);
  assert.deepEqual(model.routes.map((route) => [route.id, route.command, route.args]),
    [['refresh', null, []], ['progress', 'singularityFlow.openProgress', [{ workId: 'WRK-42' }]]]);
  const html = hostRecordHtml(model, 'r2');
  assert.match(html, /Make &lt;checkout&gt; retries safe/u, 'record text is escaped');
  assert.doesNotMatch(html, /<a\s/u, 'no anchors: VS Code would open a clicked link a second time');
  const refused = handoffView({ workId: 'WRK-9', result: { kind: 'refusal', why: [{ code: 'work.not-in-this-repository' }] } });
  assert.equal(refused.state, 'unavailable');
  assert.match(refused.notice.text, /WRK-9 is not governed work in this repository/u);
});

test('the Progress view reads Story progress and says a job has no record to read', () => {
  const model = progressView({ request: { workId: 'WRK-42' }, workId: 'WRK-42', progress: progressSnapshot(workflow()) });
  assert.equal(model.state, 'ready');
  assert.deepEqual(model.sections[0].table.rows.map((row) => [row[0], row[1], row[4]]),
    [['1', 'Intake', '1 of 1'], ['2 (current)', 'Specification', '0 of 2'], ['3', 'Implementation', '0 of 1']]);
  assert.equal(model.facts.find(([label]) => label === 'Approved')[1], '1 of 3 phases (33%)');
  assert.equal(model.guidance, 'singularity-flow progress WRK-42');
  const job = progressView({ request: { jobId: 'job-7' }, workId: null });
  assert.equal(job.state, 'unavailable');
  assert.match(job.notice.text, /Job job-7 has no record here\. This build keeps no job records/u);
  const both = progressView({ request: { jobId: 'job-7', workId: 'WRK-42' }, workId: 'WRK-42', progress: progressSnapshot(workflow()) });
  assert.equal(both.state, 'ready');
  assert.match(both.notice.text, /the Story's recorded progress is shown instead/u);
  assert.equal(progressView({ workId: 'WRK-42', progress: { workId: 'OTHER', phases: [] } }).state, 'unavailable');
});

test('a view reads only its own closed fields, and each route offered has its three-surface guidance', () => {
  assert.deepEqual(hostRecordRequest('vscode.openProgress', { workId: 'WRK-42', jobId: 'job 1', path: '/etc/passwd' }), { workId: 'WRK-42' });
  assert.deepEqual(hostRecordRequest('vscode.openHandoff', { workId: 'WRK-42', workKind: 'epic' }), { workId: 'WRK-42' });
  assert.deepEqual(hostRecordRequest('vscode.openInvestigation', 'inv-1'), {});
  const html = hostRecordHtml(progressView({ workId: 'WRK-42', progress: progressSnapshot(workflow()) }), 'render-1');
  assert.match(html, /data-render-id="render-1"/u);
  for (const route of ['refresh', 'journey', 'handoff']) assert.match(html, new RegExp(`data-route="${route}"`, 'u'));
  assert.match(text(html), /Copilot: \/sf-progress .*Shell: singularity-flow progress WRK-42/u);
  assert.match(text(html), /Open the journey from Copilot or a terminal .*singularity-flow status --work-id WRK-42/u);
});

test('the panel runs only a route its current render offered, with that route\'s own arguments', async () => {
  const reads = [];
  const sources = {
    read: async (argv) => {
      reads.push(argv);
      if (argv[0] === 'progress') return progressSnapshot(workflow());
      if (argv[0] === 'tokens') return { data: { ledger: ledger() } };
      throw new Error('unexpected read');
    },
    currentWorkId: () => 'WRK-42',
    gateway: () => null
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  HostRecordPanel.show('vscode.openProgress', { workId: 'WRK-42', path: 'x' }, sources);
  await settle();
  const progress = editor.panels.find((entry) => entry.viewType === 'singularityFlow.progress');
  assert.deepEqual(reads.at(-1), ['progress', 'WRK-42', '--json']);
  assert.match(text(progress.webview.html), /Specification/u);
  const renderId = progress.webview.html.match(/data-render-id="([^"]+)"/u)[1];

  await progress.post({ type: 'record.route', id: 'journey', renderId: 'stale' });
  assert.deepEqual(editor.executed, [], 'a click on a replaced page does nothing');
  await progress.post({ type: 'record.route', id: 'journey', command: 'workbench.action.terminal.new', renderId });
  await progress.post({ type: 'record.route', id: 'handoff', args: [{ workId: 'OTHER' }], renderId });
  assert.deepEqual(editor.executed, [
    { id: 'singularityFlow.openJourney', args: [] },
    { id: 'singularityFlow.openHandoff', args: [{ workId: 'WRK-42' }] }
  ], 'the command and arguments come from the model, never the message');
  await progress.post({ type: 'record.route', id: 'nowhere', renderId });
  assert.equal(editor.executed.length, 2);

  // The receipt page reads the attached Story with no argument, and a choice must be one it offered.
  HostRecordPanel.show('vscode.openContextReceipt', undefined, sources);
  await settle();
  const receipt = editor.panels.find((entry) => entry.viewType === 'singularityFlow.contextReceipt');
  assert.deepEqual(reads.at(-1), ['tokens', 'report', '--work-id', 'WRK-42', '--json']);
  assert.match(text(receipt.webview.html), /ctx-bbbbbbbbbbbbbbbbbbbb/u);
  let current = receipt.webview.html.match(/data-render-id="([^"]+)"/u)[1];
  await receipt.post({ type: 'record.choose', field: 'receiptId', value: 'ctx-not-offered', renderId: current });
  assert.equal(reads.length, 2, 'an option the page did not offer reads nothing');
  await receipt.post({ type: 'record.choose', field: 'receiptId', value: 'ctx-aaaaaaaaaaaaaaaaaaaa', renderId: current });
  await settle();
  assert.equal(reads.length, 3);
  assert.match(receipt.webview.html, /<dt>Receipt<\/dt><dd>ctx-aaaaaaaaaaaaaaaaaaaa<\/dd>/u);
  current = receipt.webview.html.match(/data-render-id="([^"]+)"/u)[1];
  assert.ok(current, 'every render carries its own ID');

  // Opening the same view again retargets the one panel rather than stacking another.
  HostRecordPanel.show('vscode.openProgress', { workId: 'WRK-42' }, sources);
  await settle();
  assert.equal(editor.panels.filter((entry) => entry.viewType === 'singularityFlow.progress').length, 1);
});

test('from the palette with nothing kept, the Investigation view asks what is failing and shows the report it ran', async (t) => {
  const repo = await repository(t);
  const editorSession = await import(pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'gateway-session.ts')).href);
  t.after(() => editorSession.resetGatewaySession());
  const session = editorSession.gatewaySession({ root: repo, workspaceId: null, workspaceName: null, repositoryId: 'payments-api', origin: 'test' });
  const asked = [];
  let answer = 'postal check fails at checkout';
  globalThis.__sfHostRecordVscode.window.showInputBox = async (options) => { asked.push(options.title); return answer; };
  const sources = { read: async () => { throw new Error('the Investigation view reads no CLI record'); }, currentWorkId: () => null, gateway: () => session };
  const state = async (panel, wanted) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (panel.webview.html.includes(`data-record-state="${wanted}"`)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`the page never became ${wanted}: ${text(panel.webview.html).slice(0, 400)}`);
  };

  HostRecordPanel.show('vscode.openInvestigation', undefined, sources);
  const panel = editor.panels.find((entry) => entry.viewType === 'singularityFlow.investigation');
  await state(panel, 'ready');
  assert.deepEqual(asked, ['Investigate a failure']);
  const [kept] = session.investigations.list();
  assert.ok(kept, 'the report it ran is the one the session keeps');
  assert.match(panel.webview.html, new RegExp(`<dt>Investigation</dt><dd>${kept.investigationId}</dd>`, 'u'));

  // Opened again with a report kept, it shows the report rather than asking.
  HostRecordPanel.show('vscode.openInvestigation', undefined, sources);
  await state(panel, 'ready');
  assert.equal(asked.length, 1);

  // The page's own button asks again; a cancelled question leaves the page on the same report.
  answer = undefined;
  const renderId = panel.webview.html.match(/data-render-id="([^"]+)"/u)[1];
  await panel.post({ type: 'record.route', id: 'investigate', renderId });
  await state(panel, 'ready');
  assert.equal(asked.length, 2);
  assert.match(panel.webview.html, new RegExp(`<dd>${kept.investigationId}</dd>`, 'u'));
  assert.equal(session.investigations.list().length, 1, 'nothing ran');
});
