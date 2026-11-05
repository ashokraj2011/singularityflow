/**
 * SF Guard in VS Code [SPEC-PSS-v1 M5, AC-014] [SPEC-SFG-v1 G5, AC-012].
 *
 * The Guard page reads `guard status` and `guard report` exactly as the terminal does: the statuses
 * here are the real command's answers in a real repository that opted in, with software stand-ins
 * for the Secure Enclave passed in-process (as test/sf-guard.test.mjs does). The report's lines are
 * compared with `sfGuardReportText`, the CLI's own words for the same answer. The sign card takes
 * only the refusal the CLI gives a person step started without a terminal, and its one action types
 * the same command into the person's own terminal; it never runs it, and it never signs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { run as guard } from '../src/commands/guard.mjs';
import { approverId } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { attributionSummary, sfGuardReportText } from '../src/presence/attribution.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';

// The panels run against a `vscode` stub, as in vscode-spec-studio.test.mjs.
const panels = [];
const terminals = [];
const copied = [];
class EventEmitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
const executed = [];
globalThis.__sfGuardTestVscode = {
  ViewColumn: { Active: 1, Beside: 2 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  EventEmitter,
  commands: { executeCommand: async (command) => { executed.push(command); }, getCommands: async () => ['singularityFlow.openApprovals'] },
  env: { clipboard: { writeText: async (text) => { copied.push(text); } } },
  workspace: { workspaceFolders: [{ uri: { fsPath: os.tmpdir() } }], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: {
    createWebviewPanel: (viewType, title) => {
      let receive = () => {};
      let disposed = () => {};
      const panel = {
        viewType, title, visible: true,
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        reveal() {}, dispose() { panel.visible = false; disposed(); }
      };
      panels.push(panel);
      return panel;
    },
    createTerminal: (options) => {
      const terminal = { options, shown: null, sent: [], show(preserveFocus) { this.shown = { preserveFocus }; }, sendText(text, addNewLine) { this.sent.push({ text, addNewLine }); }, dispose() {} };
      terminals.push(terminal);
      return terminal;
    },
    setStatusBarMessage: () => ({ dispose() {} }),
    showErrorMessage: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__sfGuardTestVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, EventEmitter = api.EventEmitter, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const model = await import('../apps/vscode/src/views/sf-guard-model.ts');
const pageModule = await import('../apps/vscode/src/views/sf-guard-page.ts');
const { SfGuardPanel, SfGuardSignPanel, SfGuardStandings } = await import('../apps/vscode/src/views/sf-guard.ts');
const { CliError, terminalCommand } = await import('../apps/vscode/src/cli/runner.ts');
const { journeyBodyHtml } = await import('../apps/vscode/src/views/journey.ts');
const { buildJourney } = await import('../apps/vscode/src/views/journey-model.ts');
const { approvalReviewBody } = await import('../apps/vscode/src/views/approval-review.ts');

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const ONE = { name: 'Guard One', email: 'guard.one@example.com', githubLogin: 'guard-one' };
const TWO = { name: 'Guard Two', email: 'guard.two@example.com', githubLogin: 'guard-two' };
const WINDOWS = { name: 'Windows Three', email: 'windows.three@example.com' };
const VALID_TO = '11/1/27, 9:42 PM';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-sf-guard-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Guard One');
  git(root, 'config', 'user.email', ONE.email);
  await writeFile(path.join(root, 'README.md'), '# Guarded\n');
  const init = spawnSync(process.execPath, [bin, 'init'], { cwd: root, encoding: 'utf8', timeout: childTimeout(120_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' } });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const configPath = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalAuthorities['product-approvers'].members = [ONE, TWO, WINDOWS];
  config.approvalAuthorities['engineering-reviewers'].members = [ONE];
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Configured');
  return root;
}

/** A person at a Mac with software stand-in keys; branch protection reads as not requiring the check yet. */
function person(email, keys, { validTo = VALID_TO, valid = 'YES' } = {}) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId, validTo, valid })))) }),
    readableCopies: () => [],
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false }),
    requiredCheck: async () => ({ status: 'not-required', contexts: [], reason: 'branch protection does not list it' })
  };
}

/** One guard action's JSON answer, as `singularity-flow guard … --json` prints it. */
async function sfGuard(root, words, deps, options = {}) {
  const previous = process.cwd();
  const log = console.log;
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  try {
    await guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps);
  } finally {
    console.log = log;
    process.chdir(previous);
  }
  return JSON.parse(lines.join('\n'));
}

/** A repository that opted in: two pinned keys, a Windows approver's exception, a remote check named. */
async function guarded(t) {
  const root = await repository(t);
  const one = person(ONE.email, [softwarePresenceKey()]);
  await sfGuard(root, ['register'], one);
  await sfGuard(root, ['register'], person(TWO.email, [softwarePresenceKey()]));
  await sfGuard(root, ['enable'], one, { 'remote-check': 'sf-guard-verify', exception: [approverId(WINDOWS)] });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'SF Guard on');
  return { root, one, status: await sfGuard(root, ['status'], one), report: await sfGuard(root, ['report'], one) };
}

/** A report with recorded calls in two Stories, shaped as `sfGuardReport` returns it. */
const REPORT = {
  schemaVersion: 1, resultType: 'sflow-guard-report', sfGuard: 'on', recording: 'on', since: null, story: null,
  totals: { declared: 7, 'outside-workflow': 2, 'unknown-agent': 0, shell: 1, unattributed: 0, 'pre-guard': 0 },
  subjects: [
    { scope: 'repository', counts: { declared: 0, 'outside-workflow': 1, 'unknown-agent': 0, shell: 0, unattributed: 0, 'pre-guard': 0 },
      groups: [{ classification: 'outside-workflow', agent: 'helper', skill: null, kind: 'edit', calls: 1, last: '2026-11-02T08:00:00.000Z' }] },
    { scope: 'SFG-1', counts: { declared: 7, 'outside-workflow': 1, 'unknown-agent': 0, shell: 1, unattributed: 0, 'pre-guard': 0 },
      groups: [{ classification: 'declared', agent: 'coder', skill: 'sf-code', kind: 'edit', calls: 7, last: '2026-11-02T08:00:00.000Z' },
        { classification: 'outside-workflow', agent: 'helper', skill: 'tidy', continued: true, kind: 'edit', calls: 1, last: null },
        { classification: 'shell', agent: 'coder', skill: 'sf-code', kind: 'shell', calls: 1, last: null }] }
  ],
  storyLabels: null, gaps: [], lastGap: { code: 'SFG_RECORD_FAILED', at: '2026-11-01T10:00:00.000Z' }
};
const BLOCK = { schema: 'sfg-attribution/1', status: 'complete', counts: { declared: 40, 'outside-workflow': 6, 'unknown-agent': 0, shell: 2, unattributed: 3, 'pre-guard': 0 },
  items: [{ classification: 'outside-workflow', agent: 'helper', skill: 'tidy', lines: 6, files: 2 }], partial: null };
const STORY_REPORT = { ...REPORT, story: 'SFG-1', storyLabels: { status: 'available', steps: [
  { phase: 'implementation', generation: 1, packetSha256: `sha256:${'c'.repeat(64)}`, packet: 'intact', labels: ['Declared ✓ (40 lines)', 'Produced outside the workflow: agent helper, skill tidy (6 lines in 2 files)'], attribution: BLOCK }] } };
const APPROVALS = { resultType: 'command-result', data: { approvalChain: { phases: [
  { id: 'specification', approval: { decisions: [{ decision: 'approved', actor: 'Guard One', at: '2026-10-30T09:00:00.000Z', generation: 1, active: true, presence: 'pre-signing: SF Guard was off when this Story started', counted: true }] } },
  { id: 'implementation', approval: { decisions: [
    { decision: 'approved', actor: 'Guard One', at: '2026-11-02T09:00:00.000Z', generation: 1, active: true, presence: 'signed with SHA256:abc', counted: true },
    { decision: 'approved', actor: 'Windows Three', at: '2026-11-02T09:05:00.000Z', generation: 1, active: true, presence: 'bypass: per-person exception EXC-001', counted: true },
    { decision: 'approved', actor: 'Somebody', at: '2026-11-02T09:06:00.000Z', generation: 1, active: true, presence: 'not counted: it carries no presence signature', counted: false }] } }] } } };

test('guard status reads each pinned key\'s expiry from this Mac, and the page shows on, keys, exceptions as bypass and branch protection (PSS M5)', async (t) => {
  const { status, report } = await guarded(t);
  const parsed = model.guardStatusFrom(status);
  assert.equal(parsed.on, true);
  const keyed = parsed.keys.filter((row) => row.keyId);
  assert.equal(keyed.length, 2);
  const one = parsed.keys.find((row) => row.approver === approverId(ONE));
  assert.deepEqual([one.state, one.expiry, one.expiryTone], ['signed', `valid to ${VALID_TO}`, 'ok']);
  // TWO's key is held by another Mac: its expiry is read there, never guessed.
  assert.match(parsed.keys.find((row) => row.approver === approverId(TWO)).expiry, /^expiry read on the Mac that holds it \(this Mac does not hold it\)$/u);
  assert.deepEqual(parsed.exceptions.map((entry) => [entry.id, entry.label, entry.active, entry.who]), [['EXC-001', 'bypass: per-person exception EXC-001', true, 'Windows Three']]);
  assert.deepEqual(model.remoteWords(parsed), { words: 'sf-guard-verify is NOT a required status check on main yet (branch protection does not list it): a merge is not held by it.', tone: 'bad' });
  assert.equal(JSON.stringify(status).includes('@example.com'), false, 'the status names no email');

  const html = pageModule.guardPageHtml({ status: parsed, report: model.guardReportFrom(report), error: null, busy: false, firstRun: true, notice: null, stories: {}, recipe: null });
  assert.match(html, /<span class="pill ok">on<\/span> Person steps are presence-signed in this repository\./u);
  assert.ok(html.includes(`<span class="pill ok">valid to ${VALID_TO}</span>`));
  assert.match(html, /data-exception="EXC-001"><span class="pill wait">bypass<\/span>\s*<strong>bypass: per-person exception EXC-001<\/strong> · Windows Three/u);
  assert.match(html, /<span class="pill bad">not required<\/span> sf-guard-verify is NOT a required status check on main yet/u);
  assert.ok(html.includes(`<code>${model.SF_GUARD_RECIPE_ROUTE.replace('>', '&gt;')}</code>`), 'the recipe route is on the page');
  assert.ok(html.includes(model.SF_GUARD_RULE), 'the first-run card carries the rule');
  assert.match(html, /data-first-run-seen>Got it<\/button>/u);

});

test('an expired key reads expired with the rotation route; a repository that never opted in reads off with nothing to register', async (t) => {
  const root = await repository(t);
  const off = model.guardStatusFrom(await sfGuard(root, ['status'], person(ONE.email, [softwarePresenceKey()])));
  assert.equal(off.on, false);
  assert.equal(off.keys.every((row) => row.keyId === null && row.expiry === '—'), true);
  const html = pageModule.guardPageHtml({ status: off, report: null, error: null, busy: false, firstRun: false, notice: null, stories: {}, recipe: null });
  assert.match(html, /<span class="pill idle">off<\/span> Person steps are unsigned here\./u);
  assert.match(html, /No presence key is registered here\./u);
  assert.match(html, /<code>singularity-flow guard register<\/code>, then <code>singularity-flow guard enable<\/code>/u);
  assert.doesNotMatch(html, /sfg-first-run/u, 'a dismissed first-run card stays dismissed');

  const key = softwarePresenceKey();
  await sfGuard(root, ['register'], person(ONE.email, [key]));
  const expired = model.guardStatusFrom(await sfGuard(root, ['status'], person(ONE.email, [key], { valid: 'NO', validTo: '11/1/25, 9:00 AM' })));
  const row = expired.keys.find((entry) => entry.keyId === key.keyId);
  assert.deepEqual([row.expiry, row.expiryTone], ['expired 11/1/25, 9:00 AM: rotate it (singularity-flow guard rotate --key <NEW-KEY-ID>)', 'bad']);
});

test('the report on the page is the CLI\'s own: the same totals and group lines as guard report (SFG AC-012)', () => {
  const parsed = model.guardReportFrom(REPORT);
  const text = sfGuardReportText(REPORT);
  assert.ok(text.includes(`  Recorded calls: ${model.totalsWords(parsed.totals)}.`), 'the totals line is the CLI\'s');
  for (const subject of parsed.subjects) {
    assert.ok(text.includes(`  ${subject.title}:`), `${subject.title} is the CLI's heading`);
    for (const group of subject.groups) assert.ok(text.includes(`    ${group.words}\n`) || text.endsWith(`    ${group.words}`), `"${group.words}" is the CLI's line`);
  }
  const html = pageModule.guardPageHtml({ status: model.guardStatusFrom({ resultType: 'sflow-guard', status: 'required', approvers: [], exceptions: [], problems: [], agents: [],
    recording: { state: 'on', gaps: 2, lastGap: REPORT.lastGap } }), report: parsed, error: null, busy: false, firstRun: false, notice: null, stories: {}, recipe: null });
  assert.match(html, /<strong data-sfg-totals>7 declared · 2 outside the workflow · 1 shell commands<\/strong>/u);
  assert.match(html, /data-scope="SFG-1"><header><h3>Story SFG-1<\/h3><small class="muted">7 declared · 1 outside the workflow · 1 shell commands<\/small>/u);
  assert.match(html, /outside-workflow: 1 edit — agent helper, skill tidy \(continued\)/u);
  assert.match(html, /data-story="SFG-1">Show labels by step<\/button>/u);
  assert.doesNotMatch(html, /data-story="repository"/u, 'work outside a Story has no steps');
  assert.match(html, /<span class="pill ok">on<\/span> This checkout records which agent and skill wrote what\./u);
  assert.match(html, /Last gap: <code>SFG_RECORD_FAILED<\/code> at 2026-11-01T10:00:00.000Z \(2 recent\)/u);
});

test('a packet\'s attribution summary is the approval card\'s line, word for word', () => {
  for (const block of [BLOCK, { ...BLOCK, partial: { limit: 2000, reason: 'line' } }, { status: 'unavailable', reason: 'no records' },
    { status: 'complete', counts: { declared: 0, 'pre-guard': 4 } }]) {
    assert.equal(model.attributionSummaryText(block), attributionSummary(block));
  }
  assert.equal(model.attributionSummaryText(null), null);
});

test('a Story\'s standing: each decision signed, pre-signing, bypass or not counted, and each packet\'s labels, in the Story, approvals and review views', () => {
  const standing = model.storyStandingFrom('SFG-1', APPROVALS, STORY_REPORT);
  assert.deepEqual(standing.approvals.map((entry) => [entry.phase, entry.state, entry.counted]),
    [['specification', 'pre-signing', true], ['implementation', 'signed', true], ['implementation', 'bypass', true], ['implementation', 'not-counted', false]]);
  assert.equal(standing.packets[0].summary, attributionSummary(BLOCK));
  const html = pageModule.storyStandingHtml(standing, { phase: 'implementation' });
  assert.match(html, /data-sfg-state="signed" title="signed with SHA256:abc">signed<\/span>/u);
  assert.match(html, /data-sfg-state="bypass" title="bypass: per-person exception EXC-001">bypass<\/span>/u);
  assert.match(html, /data-sfg-state="not-counted"[^>]*>not counted<\/span>/u);
  assert.doesNotMatch(html, /pre-signing/u, 'narrowed to the step');
  assert.ok(html.includes(attributionSummary(BLOCK)), 'the packet shows its attribution summary');
  assert.match(html, /<span class="pill ok">packet intact<\/span>/u);
  assert.match(pageModule.storyStandingHtml(standing, { phase: 'specification' }), /data-sfg-state="pre-signing"/u);
  assert.match(pageModule.storyStandingHtml('loading'), /Reading SF Guard's standing…/u);
  assert.equal(pageModule.storyStandingHtml(null), '', 'a Story that did not pin SF Guard shows nothing');

  // Pinning and the cache key: a new approval or submission changes the key, so a cached standing is never shown stale.
  const workflow = { workItem: { id: 'SFG-1' }, resolution: { presence: { mode: 'required' } }, phases: { implementation: { approvals: [{ at: 'a', decision: 'approved' }] } }, lineage: { submissions: [] } };
  assert.equal(model.storyPinsSfGuard(workflow), true);
  assert.equal(model.storyPinsSfGuard({ ...workflow, resolution: {} }), false);
  const key = model.storyStandingKey(workflow);
  assert.notEqual(model.storyStandingKey({ ...workflow, phases: { implementation: { approvals: [{ at: 'a', decision: 'approved' }, { at: 'b', decision: 'approved' }] } } }), key);
  assert.notEqual(model.storyStandingKey({ ...workflow, lineage: { submissions: [{ packetSha256: 'x' }] } }), key);

  // The approval review page shows the packet's labels and this step's decisions before the person approves.
  const review = approvalReviewBody({ title: 'Approve implementation', expected: 'implementation', workId: 'SFG-1', phaseId: 'implementation', phaseLabel: 'Implementation',
    generation: 1, artifact: null, articles: [], findings: [], witnessedClauses: null, priorExceptions: [], selfApproval: false,
    sfGuard: { summary: attributionSummary(BLOCK), labels: STORY_REPORT.storyLabels.steps[0].labels, approvals: standing.approvals.filter((entry) => entry.phase === 'implementation') } });
  assert.match(review, /<section class="approval-sf-guard" aria-label="SF Guard">/u);
  assert.ok(review.includes(`<p data-sfg-summary>${attributionSummary(BLOCK)}</p>`));
  assert.match(review, /Produced outside the workflow: agent helper, skill tidy \(6 lines in 2 files\)/u);
  assert.match(review, /data-sfg-state="bypass">bypass<\/span>\s*<strong>Windows Three<\/strong>/u);
  assert.doesNotMatch(approvalReviewBody({ title: 'x', expected: 'x', workId: 'W', phaseId: 'p', phaseLabel: 'P', generation: 1, artifact: null, articles: [], findings: [],
    witnessedClauses: null, priorExceptions: [], selfApproval: false }), /approval-sf-guard/u, 'without SF Guard the review is unchanged');
});

test('the Story view carries each approval\'s SF Guard standing beside who approved, and its step\'s labels', () => {
  const standing = model.storyStandingFrom('SFG-1', APPROVALS, STORY_REPORT);
  const workflow = {
    workItem: { id: 'SFG-1', title: 'Guarded Story' }, currentPhase: 'implementation', phaseOrder: ['implementation'], resolution: { presence: { mode: 'required' } },
    phases: { implementation: { id: 'implementation', label: 'Implementation', status: 'in_review', generation: 1, approvalPolicy: { minimum: 3, authorities: [] },
      approvals: [{ decision: 'approved', actor: { name: 'Guard One', email: 'one@example.test' }, at: '2026-11-02T09:00:00.000Z', generation: 1 },
        { decision: 'approved', actor: { name: 'Windows Three', email: 'three@example.test' }, at: '2026-11-02T09:05:00.000Z', generation: 1 }] } }
  };
  const journey = buildJourney({ workflow, repository: { root: '/r' } }, 'implementation');
  const body = journeyBodyHtml(journey, null, standing);
  assert.match(body, /data-sfg-state="signed"[^>]*>signed<\/span><strong>/u, 'each approval carries its standing');
  assert.match(body, /data-sfg-state="bypass"[^>]*>bypass<\/span><strong>/u);
  assert.match(body, /<section class="sfg-story" data-sfg="story">/u);
  assert.doesNotMatch(journeyBodyHtml(journey, null, null), /sfg-story|data-sfg-state/u, 'a Story that did not pin SF Guard shows nothing new');
});

/** The CliError the runner raises for `--json` refusal `code`, with the CLI's own envelope. */
function refused(code, args, { input = false, repository = '/work/app' } = {}) {
  const envelope = refusalEnvelope(new SingularityFlowError(`SF Guard: this decision needs your presence signature, taken in your own terminal (this command has no terminal to show the card in). Nothing was written. Run it there: singularity-flow ${args.join(' ')}`,
    { code, details: { approver: 'approver-000000000001' } }), args);
  return new CliError(envelope.error.message, 1, '', envelope, { repository, args, input });
}

test('only PSS_CARD_NOT_SHOWN from a command the extension ran becomes a sign card, with any receipt hidden', () => {
  const args = ['approve', 'SFG-1', '--fetch', '--phase', 'implementation', '--selection-receipt', 'secret-token-1'];
  const request = model.signRequestFrom(refused('PSS_CARD_NOT_SHOWN', args));
  assert.deepEqual(request.args, args);
  assert.equal(request.title, 'approve implementation for SFG-1');
  assert.equal(model.signCommandText(request.args), 'singularity-flow approve SFG-1 --fetch --phase implementation --selection-receipt <receipt>');
  assert.equal(model.signRequestFrom(refused('PSS_CARD_NOT_SHOWN', [...args, '--json'])).args.includes('--json'), false, 'the terminal gets the person\'s output');
  assert.equal(model.signRequestFrom(refused('PSS_SIGNER_UNAVAILABLE', args)), null, 'another refusal stays an ordinary card with its routes');
  assert.equal(model.signRequestFrom(refused('PSS_CARD_NOT_SHOWN', args, { input: true })), null, 'stdin cannot be replayed in a terminal');
  assert.equal(model.signRequestFrom(Object.assign(new Error('x'), { result: refused('PSS_CARD_NOT_SHOWN', args).result })), null, 'only a CliError with its invocation');
  const decide = ['spec', 'author', 'decide', 'SPEC-PRICING', 'GAP-001', '--option', 'O1', '--reason', 'Strictly above.', '--operation-id', 'vsc-1'];
  assert.equal(model.signTitle(decide), 'spec decide SPEC-PRICING GAP-001 with O1');
  assert.equal(model.signCommandText(decide).includes('"Strictly above."'), true);

  const card = pageModule.signCardHtml({ request, firstRun: true, state: 'ready' });
  assert.match(card, /<h2 id="sfg-card-title">approve implementation for SFG-1<\/h2>/u);
  assert.doesNotMatch(card, /secret-token-1/u, 'a receipt token is never on the card');
  assert.ok(card.includes(model.SF_GUARD_RULE));
  assert.match(card, /How SF Guard asks for your touch/u, 'the first sign card explains the rule');
  assert.doesNotMatch(card, /data-first-run-seen/u, 'the explanation is not dismissed from the sign card');
  assert.match(card, /<button type="button" data-sign>[\s\S]*Open my terminal to sign<\/button>/u);
  assert.doesNotMatch(pageModule.signCardHtml({ request, firstRun: false, state: 'sent' }), /data-sign>/u);
});

function memento(values = new Map()) {
  return { values, get: (key, fallback) => (values.has(key) ? values.get(key) : fallback), update: async (key, value) => { values.set(key, value); } };
}

async function until(read, what) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('VS Code "Close gap with O1 and sign": the card, then the person\'s own terminal with the same command, typed for them to run (PSS AC-014)', async () => {
  terminals.length = 0; panels.length = 0;
  const args = ['spec', 'author', 'decide', 'SPEC-PRICING', 'GAP-001', '--option', 'O1', '--reason', 'Strictly above, as finance agreed.', '--operation-id', 'vsc-1', '--json'];
  const location = { executable: '/opt/vscode/code', cli: '/opt/vscode/cli/bin/singularity-flow.mjs', source: 'bundled' };
  const client = { repository: '/work/app', location, run: async () => assert.fail('the card reads nothing and runs nothing') };
  const state = memento();
  const refreshed = [];
  const hooks = { client: () => client, memento: state, refresh: async () => { refreshed.push(true); } };

  assert.equal(SfGuardSignPanel.fromRefusal(refused('PSS_SIGNER_UNAVAILABLE', args), hooks), false, 'not this card');
  assert.equal(SfGuardSignPanel.fromRefusal(refused('PSS_CARD_NOT_SHOWN', args), hooks), true);
  const card = panels.find((panel) => panel.viewType === 'singularityFlow.sfGuardSign');
  assert.match(card.webview.html, /spec decide SPEC-PRICING GAP-001 with O1/u);
  assert.match(card.webview.html, /How SF Guard asks for your touch/u);
  assert.equal(terminals.length, 0, 'nothing opens before the person asks');

  card.post({ type: 'sign.terminal' });
  await until(() => terminals.length === 1 && card.webview.html.includes('data-sign-state="sent"'), 'the terminal');
  const [terminal] = terminals;
  assert.deepEqual(terminal.sent, [{ text: terminalCommand('/work/app', args.filter((entry) => entry !== '--json'), process.platform, location), addNewLine: false }],
    'the same command, typed and not run: the person presses Enter, so the card and the prompt follow a command they started');
  assert.deepEqual(terminal.options.env, { ELECTRON_RUN_AS_NODE: '1' }, 'the engine runs as Node there; no variable is written into the command');
  assert.equal(terminal.sent[0].text.includes('ELECTRON_RUN_AS_NODE'), false);
  assert.equal(state.values.get(model.SF_GUARD_FIRST_RUN_KEY), true, 'the first-run explanation was shown once');
  assert.match(card.webview.html, /Press Enter there, read the card it prints, then touch the sensor\./u);
  card.post({ type: 'sign.done' });
  await until(() => refreshed.length === 1 && card.visible === false, 'the refresh, then the card closes');

  // A refusal from another repository than the client's is never handed to a terminal.
  SfGuardSignPanel.fromRefusal(refused('PSS_CARD_NOT_SHOWN', args, { repository: '/elsewhere' }), hooks);
  const stale = panels.filter((panel) => panel.viewType === 'singularityFlow.sfGuardSign').at(-1);
  stale.post({ type: 'sign.terminal' });
  await until(() => stale.webview.html.includes('data-sign-state="stale"'), 'the stale card');
  assert.equal(terminals.length, 1);
  // A stale card has no action of its own, and says to start the step again from its view: the footer goes there.
  assert.match(stale.webview.html, /<nav class="page-nav"[^>]*>.*data-nav="approvals"/su);
  stale.post({ type: 'navigate', to: 'approvals' });
  await until(() => executed.includes('singularityFlow.openApprovals'), 'the footer link');
  stale.dispose();
});

test('the Guard page reads guard status and guard report, loads a Story\'s labels by step, shows the recipe, and keeps the first-run card dismissed (SFG AC-012)', async (t) => {
  panels.length = 0;
  const { status } = await guarded(t);
  const calls = [];
  const answers = new Map([
    ['guard status --json', status], ['guard report --json', REPORT], ['guard report --story SFG-1 --json', STORY_REPORT],
    ['approvals SFG-1 --json', APPROVALS], ['guard remote-check --json', { resultType: 'sflow-guard', action: 'remote-check', path: '.github/workflows/sf-guard-verify.yml', recipe: 'name: SF Guard verify\n', incomplete: true }]
  ]);
  const client = { repository: '/work/app', run: async (argv) => { calls.push(argv.join(' ')); await new Promise((resolve) => setImmediate(resolve)); return structuredClone(answers.get(argv.join(' '))); } };
  const state = memento();
  SfGuardPanel.show(client, { memento: state });
  const guardPage = panels.find((panel) => panel.viewType === 'singularityFlow.sfGuard');
  await until(() => guardPage.webview.html.includes('data-sfg-totals'), 'the page');
  assert.deepEqual(calls, ['guard status --json', 'guard report --json'], 'the same readers as the terminal');
  assert.match(guardPage.webview.html, /data-sfg-totals>7 declared · 2 outside the workflow · 1 shell commands</u);
  assert.match(guardPage.webview.html, /<section class="sfg-first-run"/u);
  assert.match(guardPage.webview.html, /Content-Security-Policy" content="default-src 'none'/u);

  guardPage.post({ type: 'guard.firstRunSeen' });
  await until(() => !guardPage.webview.html.includes('<section class="sfg-first-run"'), 'the dismissal');
  assert.equal(state.values.get(model.SF_GUARD_FIRST_RUN_KEY), true);

  guardPage.post({ type: 'guard.story', workId: 'SFG-1' });
  await until(() => guardPage.webview.html.includes('data-sfg="story"') && !guardPage.webview.html.includes('aria-busy'), 'the Story');
  assert.deepEqual(calls.slice(2).sort(), ['approvals SFG-1 --json', 'guard report --story SFG-1 --json']);
  assert.match(guardPage.webview.html, /data-sfg-state="bypass"/u);
  guardPage.post({ type: 'guard.story', workId: 'NOT-LISTED' });

  guardPage.post({ type: 'guard.recipe' });
  await until(() => guardPage.webview.html.includes('<details open class="sfg-recipe">'), 'the recipe');
  assert.match(guardPage.webview.html, /<summary>\.github\/workflows\/sf-guard-verify\.yml — pin the SFlow release it installs first<\/summary><pre>name: SF Guard verify/u);
  guardPage.post({ type: 'guard.copy', text: model.SF_GUARD_RECIPE_ROUTE });
  await until(() => copied.includes(model.SF_GUARD_RECIPE_ROUTE), 'the copy');
  assert.equal(calls.includes('approvals NOT-LISTED --json'), false, 'only a Story the report lists is read');
  guardPage.dispose();

  // The shared Story standing reads once per change of the Story's approvals or submissions.
  calls.length = 0;
  const standings = new SfGuardStandings(() => client);
  const workflow = { workItem: { id: 'SFG-1' }, resolution: { presence: { mode: 'required' } }, phases: {}, lineage: { submissions: [] } };
  assert.equal(standings.standing({ ...workflow, resolution: {} }), null, 'a Story without SF Guard reads nothing');
  assert.equal(standings.standing(workflow), 'loading');
  const read = await standings.read(workflow);
  assert.equal(read.approvals.length, 4);
  assert.equal(standings.standing(workflow), read, 'cached');
  assert.deepEqual(calls.sort(), ['approvals SFG-1 --json', 'guard report --story SFG-1 --json']);
  standings.dispose();
});
