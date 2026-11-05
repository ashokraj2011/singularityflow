import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { childTimeout } from './helpers/child-timeout.mjs';
import { environment as isolatedEnvironment } from './helpers/run-and-test-fixture.mjs';

// SPEC-SPA v1.3 S3: the Spec Studio panel, model-free. The panel host runs against a `vscode` stub,
// as in vscode-apm-packages.test.mjs, and every command it runs goes through a recording client to
// the real CLI in a real repository, so the page and the engine can never disagree about a shape.
const panels = [];
const copied = [];
const chats = [];
const settings = { 'singularityFlow.modelMode': 'auto', 'singularityFlow.specStudio.automaticSync': false };
globalThis.__sfSpecStudioTestVscode = {
  ViewColumn: { Active: 1 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  Range: class { constructor(...args) { this.args = args; } },
  commands: { executeCommand: async (command, argument) => { if (command === 'workbench.action.chat.open') chats.push(argument); } },
  env: { clipboard: { writeText: async (text) => { copied.push(text); } } },
  workspace: { openTextDocument: async (uri) => ({ uri }), fs: { stat: async () => ({}) },
    getConfiguration: (section) => ({ get: (key, fallback) => settings[`${section}.${key}`] ?? fallback }) },
  window: {
    createWebviewPanel: (viewType, title) => {
      let receive = () => {};
      let disposed = () => {};
      const panel = {
        viewType, title, visible: true,
        webview: { html: '', messages: [], postMessage(message) { this.messages.push(message); return Promise.resolve(true); }, cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        reveal() {}, dispose() { panel.visible = false; disposed(); }
      };
      panels.push(panel);
      return panel;
    },
    setStatusBarMessage: () => ({ dispose() {} }),
    showTextDocument: async () => undefined
  }
};
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  const api = globalThis.__sfSpecStudioTestVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, Range = api.Range, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const model = await import('../apps/vscode/src/views/spec-studio-model.ts');
const { specStudioHtml, SPEC_STUDIO_SCRIPT } = await import('../apps/vscode/src/views/spec-studio-page.ts');
const { SpecStudioPanel } = await import('../apps/vscode/src/views/spec-studio.ts');
const { commandClass } = await import('../apps/vscode/src/cli/client.ts');
const { storyIntakeBody } = await import('../apps/vscode/src/views/story-intake-page.ts');
const tool = await import('../apps/vscode/src/views/spec-studio-tool.ts');

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const SPEC = 'SPEC-CHK-004';
const READS = new Set(['list', 'status', 'show', 'gaps', 'check', 'history', 'sources', 'shared']);

const PRICING = `// Cart pricing. All amounts are integers in paise (INR minor units).

export const DISCOUNT_RATE = 0.10;
export const DISCOUNT_THRESHOLD = 500000; // INR 5000.00

export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}

/** The order discount in paise for a cart. */
export function orderDiscount(cart) {
  const total = subtotal(cart.lines);
  if (cart.currency !== 'INR') return 0;
  if (total >= DISCOUNT_THRESHOLD) return Math.round(total * DISCOUNT_RATE);
  return 0;
}

export function orderSummary(cart) {
  const total = subtotal(cart.lines);
  const discount = orderDiscount(cart);
  return { subtotal: total, discount, payable: total - discount };
}
`;
const PRICING_TEST = `import test from 'node:test';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { orderDiscount } from '../src/pricing.mjs';

test('ten percent discount from INR 5000.00', () => {
  assert.equal(orderDiscount({ currency: 'INR', lines: [{ unitPrice: 500000, quantity: 1 }] }), 50000);
});
`;
const specText = (decisions) => `# Order discount threshold

## Outcome

The 10 percent order discount applies only to orders strictly above INR 5000.00.

## Actors

- Shopper: places INR orders.

## User scenarios

1. A shopper with an INR 6000.00 cart sees a 10 percent discount.

## Scope

In scope: the order discount rule. Out of scope: tax and shipping.

## Requirements

WHEN an INR order total is strictly greater than INR 5000.00, the cart SHALL apply a 10 percent order discount (R-001). [${SPEC}:REQ-001]

## Acceptance

An INR 5000.01 cart gets INR 500.00 off, and an INR 5000.00 cart gets nothing. [${SPEC}:AC-001]

## Decisions and open questions

${decisions}
`;

const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Spec Author' };
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function cli(cwd, args) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...env, ...isolatedEnvironment(path.join(path.dirname(cwd), '.test-context-' + path.basename(cwd))), SINGULARITY_FLOW_TEST_IDENTITY: 'Spec Author', GIT_CONFIG_VALUE_0: 'Spec Author', GIT_CONFIG_VALUE_1: 'spec.author@example.test' }, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const json = (cwd, args) => {
  const result = cli(cwd, [...args, '--json']);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};

/** A storefront with a draft whose code research disagrees with it: GAP-001 is open and names REQ-001. */
async function storefront(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-studio-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'app');
  git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{ "name": "storefront", "type": "module" }\n');
  await writeFile(path.join(root, 'src', 'pricing.mjs'), PRICING);
  await writeFile(path.join(root, 'test', 'pricing.test.mjs'), PRICING_TEST);
  git(directory, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Spec Author');
  git(root, 'config', 'user.email', 'spec.author@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Storefront');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  json(root, ['spec', 'author', 'new', SPEC, '--kind', 'business', '--title', 'Order discount threshold', '--area', 'src/pricing.mjs']);
  const file = path.join(directory, 'spec.md');
  await writeFile(file, specText('- None yet.'));
  json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1']);
  const { items } = json(root, ['spec', 'author', 'research', SPEC]);
  const rule = items.find((item) => item.kind === 'rule' && /total >= DISCOUNT_THRESHOLD/u.test(item.summary));
  assert.ok(rule, items.map((item) => item.summary).join('\n'));
  const options = path.join(directory, 'options.json');
  await writeFile(options, JSON.stringify([
    { wording: 'WHEN an order total is greater than INR 5000.00, the cart SHALL apply a 10 percent discount.', changesCode: true },
    { wording: 'WHEN an order total is INR 5000.00 or more, the cart SHALL apply a 10 percent discount.', changesCode: false }]));
  json(root, ['spec', 'author', 'gap', SPEC, '--kind', 'code-disagrees', '--question', 'Strictly above INR 5000.00, or at and above?',
    '--research', rule.id, '--clause', 'REQ-001', '--options', options]);
  return { directory, root, rule };
}

/** The panel's client: every command goes to the real CLI; refusals arrive as the runner's CliError does. */
function recordingClient(root) {
  const client = {
    calls: [], pending: 0,
    async run(argv) {
      client.calls.push(argv);
      client.pending += 1;
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const result = cli(root, argv);
        if (result.status !== 0) {
          let parsed = null;
          try { parsed = JSON.parse(result.stdout); } catch { /* prose */ }
          throw Object.assign(new Error(parsed?.error?.message ?? result.stderr), { result: parsed });
        }
        return JSON.parse(result.stdout);
      } finally { client.pending -= 1; }
    }
  };
  return client;
}
const writes = (calls) => calls.filter((argv) => argv[0] === 'spec' && argv[1] === 'author' && !READS.has(argv[2]) && !(argv[2] === 'coverage' && !argv.includes('--repair')));

async function settled(client, studio) {
  for (let quiet = 0, rounds = 0; quiet < 3 && rounds < 6000; rounds += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    quiet = client.pending === 0 && !/data-busy/u.test(studio.webview.html) ? quiet + 1 : 0;
  }
}

test('the Studio opens directly in the continuous editor with one question and no network quality pass', async t => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.at(-1); await settled(client, studio);
  assert.equal(writes(client.calls).length, 0);
  assert.ok(client.calls.some(argv => argv.join(' ') === `spec author status ${SPEC} --quick --json`));
  assert.ok(client.calls.some(argv => argv.join(' ') === 'spec author list --local --json'));
  const html = studio.webview.html;
  assert.match(html, /contenteditable="true" role="textbox" aria-label="Specification text"/u);
  assert.match(html, /Write with Copilot/u);
  assert.match(html, /One thing to confirm/u);
  assert.match(html, /Strictly above INR 5000\.00, or at and above\?/u);
  assert.match(html, /data-decide="O1"/u);
  assert.match(html, /Business needs/u); assert.match(html, /Technical details/u);
  assert.doesNotMatch(html, /<aside class="ss-left"|<nav class="ss-steps"|data-stage="elicit"/u);
  studio.dispose();
});

test('Close gap with O1 and sign runs spec author decide --option O1; the signer and reason are recorded; the counts update (SPA:AC-019)', async (t) => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  panels.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  const before = json(root, ['spec', 'author', 'status', SPEC]).gaps.filter(g => g.status === 'open').length;

  studio.post({ type: 'spec.decide', gap: 'GAP-001', option: 'O1', reason: 'Strictly above, as finance agreed.' });
  await settled(client, studio);
  const [decide] = writes(client.calls);
  assert.deepEqual(decide.slice(0, 10), ['spec', 'author', 'decide', SPEC, 'GAP-001', '--option', 'O1', '--reason', 'Strictly above, as finance agreed.', '--operation-id']);
  assert.match(decide[10], /^vsc-[0-9a-f-]{36}$/u, 'the host generates the operation ID');
  assert.equal(writes(client.calls).length, 1, 'one click, one write');

  const [gap] = json(root, ['spec', 'author', 'status', SPEC]).gaps;
  assert.deepEqual([gap.status, gap.decision.option, gap.decision.reason, gap.decision.by.name], ['decided', 'O1', 'Strictly above, as finance agreed.', 'Spec Author']);
  const html = studio.webview.html;
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).gaps.filter(g => g.status === 'open').length, before - 1);
  studio.post({ type: 'spec.gap', gap: 'GAP-001' }); await settled(client, studio);
  const decidedHtml = studio.webview.html;
  assert.match(html, /GAP-001 is closed with O1 and signed with your Git identity\./u);
  assert.match(decidedHtml, /<p data-decision><strong>Decided:<\/strong> WHEN an order total is greater than INR 5000\.00/u);
  assert.match(decidedHtml, /Spec Author, \d{4}-\d{2}-\d{2} \d{2}:\d{2}: Strictly above, as finance agreed\./u, 'the event shows the signer and the reason');
  assert.doesNotMatch(html, /class="ss-clause flagged"/u, 'a decided gap no longer flags its clause');

  // A refusal is shown with the command the engine names, and nothing changes.
  studio.post({ type: 'spec.decide', gap: 'GAP-001', option: 'O2', reason: 'Changed my mind.' });
  await settled(client, studio);
  assert.match(studio.webview.html, /<div class="notice error" role="alert" data-error>[\s\S]*GAP-001 is decided; reopen it before deciding it again\./u);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).gaps[0].decision.option, 'O1');
  studio.dispose();
});

test('with SF Guard on, Close gap with O1 and sign hands the refused step to SF Guard\'s card, and nothing is written (PSS:AC-014)', async (t) => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  const { CliError } = await import('../apps/vscode/src/cli/runner.ts');
  const { refusalEnvelope } = await import('../src/refusal-remediation.mjs');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const run = client.run;
  // The CLI's refusal for a person step started without a terminal, before it writes anything (src/presence/repository-steps.mjs).
  client.run = async (argv) => {
    if (argv[2] !== 'decide') return run(argv);
    client.calls.push(argv);
    const envelope = refusalEnvelope(new SingularityFlowError('SF Guard: spec.decide needs your presence signature, taken in your own terminal (this command has no terminal to show the card in). Nothing was written.',
      { code: 'PSS_CARD_NOT_SHOWN', details: {} }), argv);
    throw new CliError(envelope.error.message, 1, '', envelope, { repository: root, args: argv, input: false });
  };
  const handed = [];
  panels.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root, signRequired: (error) => { handed.push(error); return error.result?.error?.code === 'PSS_CARD_NOT_SHOWN'; } });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  studio.post({ type: 'spec.decide', gap: 'GAP-001', option: 'O1', reason: 'Strictly above, as finance agreed.' });
  await settled(client, studio);
  assert.equal(handed.length, 1, 'the refusal went to SF Guard\'s card');
  assert.deepEqual(handed[0].invocation.args.slice(0, 7), ['spec', 'author', 'decide', SPEC, 'GAP-001', '--option', 'O1'], 'the card gets the exact command');
  assert.match(studio.webview.html, /SF Guard: this step takes your Touch ID in your own terminal\. Its card is open; nothing was written yet\./u);
  assert.doesNotMatch(studio.webview.html, /data-error>/u, 'not shown as an error');
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).gaps[0].status, 'open', 'nothing was written');
  studio.dispose();
});

test('Cancel and Back on every stage write nothing; publishing and discarding ask first, and declining leaves the draft (SPA:AC-020)', async (t) => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  panels.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  const sequence = json(root, ['spec', 'author', 'status', SPEC]).sequence;

  for (const step of model.STEP_IDS.filter(step => !['elicit', 'draft'].includes(step))) {
    studio.post({ type: 'spec.step', step });
    await settled(client, studio);
    const stage = studio.webview.html.match(/<section class="ss-stage" data-stage="([a-z]+)"[\s\S]*?<div class="ss-controls">[\s\S]*?<\/div>\s*<\/section>/u);
    assert.equal(stage?.[1], step, `${step} is shown`);
    assert.match(stage[0], /data-message="spec\.back">[\s\S]*?Back<\/button>/u, `${step} has Back`);
    if (/<form class="ss-form" data-form="spec\.(save|research|fact|openGap|settle|defer)"/u.test(stage[0])) {
      assert.ok(stage[0].includes(`data-message="spec.cancel" data-cancel>${step === 'draft' ? 'Discard unsaved changes' : 'Cancel'}</button>`), `${step}'s forms have an explicit cancel action`);
    }
    studio.post({ type: 'spec.cancel' });
    await settled(client, studio);
    assert.match(studio.webview.html, /Unsaved edits discarded\. The saved draft is unchanged\.|Nothing was saved; the draft is unchanged\./u);
    studio.post({ type: 'spec.back' });
    await settled(client, studio);
    if (step !== 'elicit') continue;
    assert.match(studio.webview.html, /data-view="library"/u, 'Back from the first step is the library');
    studio.post({ type: 'spec.open', spec: SPEC });
    await settled(client, studio);
  }

  SpecStudioPanel.show(client, { specId: SPEC, step: 'publish' }, { root: () => root });
  await settled(client, studio);
  studio.post({ type: 'spec.publish', state: 'draft' });
  await settled(client, studio);
  const publish = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  assert.equal(publish?.title, `Publish ${SPEC}@1`, 'one confirmation, naming the revision');
  assert.match(publish.webview.html, /singularity-flow spec author publish SPEC-CHK-004 --draft/u);
  publish.post({ type: 'confirmation.cancel' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Nothing was published\./u);

  studio.post({ type: 'spec.discard' });
  await settled(client, studio);
  const discard = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  assert.match(discard.webview.html, /Type this exact value: <code>SPEC-CHK-004<\/code>/u, 'discarding asks for the specification ID');
  discard.post({ type: 'confirmation.accept', confirmation: 'SPEC-CHK-00' });
  discard.post({ type: 'confirmation.cancel' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Nothing was discarded\./u);

  assert.deepEqual(writes(client.calls), [], 'nothing was written');
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).sequence, sequence, 'the draft is unchanged');
  studio.dispose();
});

test('the whole loop in the Studio, by hand: save, settle, publish reviewed, then a Story slice and its coverage', async (t) => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  panels.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  studio.post({ type: 'spec.decide', gap: 'GAP-001', option: 'O1', reason: 'Strictly above, as finance agreed.' });
  await settled(client, studio);

  const status = json(root, ['spec', 'author', 'status', SPEC]);
  studio.post({ type: 'spec.save', sequence: 1, text: status.spec });
  await settled(client, studio);
  assert.match(studio.webview.html, /Saving from an older snapshot|expected snapshot|snapshot/iu);
  assert.ok(studio.webview.html.includes('data-error'), 'a save from an older snapshot is refused');
  studio.post({ type: 'spec.save', sequence: status.sequence, text: specText('- GAP-001: only totals strictly above INR 5000.00 qualify.') });
  await settled(client, studio);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).sequence, status.sequence + 1);

  studio.post({ type: 'spec.step', step: 'check' }); await settled(client, studio);
  studio.post({ type: 'spec.settle', decisions: Object.fromEntries(status.articles.map(({ article }) => [article, 'satisfied'])), reason: '' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Recorded 6 checklist decision\(s\)\./u);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).counts.h.open, 0);

  studio.post({ type: 'spec.step', step: 'publish' });
  await settled(client, studio);
  assert.match(studio.webview.html, /<button type="button" data-message="spec\.publish" data-state="reviewed">/u, 'reviewed publication is offered once nothing blocks it');
  studio.post({ type: 'spec.publish', state: 'reviewed' });
  await settled(client, studio);
  const confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  await settled(client, studio);
  assert.match(studio.webview.html, new RegExp(`Published ${SPEC}@1 \\(reviewed\\) to the state branch\\.`, 'u'));
  assert.deepEqual(writes(client.calls).map((argv) => argv[2]), ['decide', 'edit', 'edit', 'settle', 'publish']);
  assert.deepEqual(writes(client.calls).at(-1), ['spec', 'author', 'publish', SPEC, '--reviewed', '--expected-seq', String(status.sequence + 2), '--json']);

  studio.post({ type: 'spec.step', step: 'attach' });
  await settled(client, studio);
  let html = studio.webview.html;
  assert.match(html, /<code data-slice-option>--spec SPEC-CHK-004@1<\/code>/u, 'every clause: no clause list');
  assert.match(html, /singularity-flow start &lt;WORK-ID&gt; --from-branch &lt;BRANCH&gt; --title &quot;&lt;TITLE&gt;&quot; --spec SPEC-CHK-004@1/u);
  studio.post({ type: 'spec.coverage' });
  await settled(client, studio);
  html = studio.webview.html;
  assert.match(html, /<td><code>REQ-001<\/code><\/td><td><span class="pill ">uncovered<\/span>/u);
  studio.post({ type: 'spec.copy', text: '--spec SPEC-CHK-004@1=REQ-001' });
  await settled(client, studio);
  assert.equal(copied.at(-1), '--spec SPEC-CHK-004@1=REQ-001');
  studio.dispose();

  // A Story's intake opens the Studio at its slice: the attach stage, with only its clauses chosen.
  panels.length = 0;
  SpecStudioPanel.show(client, { revision: `${SPEC}@1`, clauses: [`${SPEC}:REQ-001`], step: 'attach' }, { root: () => root });
  const focused = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, focused);
  html = focused.webview.html;
  assert.match(html, /data-stage="attach"/u);
  assert.match(html, /<code data-slice-option>--spec SPEC-CHK-004@1=REQ-001<\/code>/u);
  assert.match(html, new RegExp(`name="clauses\\[\\]" value="${SPEC}:REQ-001" checked`, 'u'));
  focused.dispose();
});

test('Copilot\'s proposals wait in the Copilot tab; only the person\'s clicks accept, reject or settle them (SPA:AC-022, AC-023, AC-024)', async (t) => {
  const { root, directory } = await storefront(t);
  const prose = json(root, ['spec', 'author', 'status', SPEC]).spec.replace('- Shopper: places INR orders.', '- Shopper: places INR orders online.');
  const file = path.join(directory, 'proposals.json');
  await writeFile(file, JSON.stringify({ assistedCheck: true, proposals: [{ kind: 'edit', summary: 'Say where shoppers order.', spec: prose },
    { kind: 'research', summary: 'Finance says gift cards never count.' },
    { kind: 'finding', article: 'boundary-conditions', message: 'Nothing says what happens at exactly INR 5000.00.', clauses: ['REQ-001'] }] }));
  assert.deepEqual(json(root, ['spec', 'author', 'propose', SPEC, '--file', file]).staged, ['P-001', 'P-002', 'A-001']);

  const client = recordingClient(root);
  panels.length = 0;
  chats.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  let html = studio.webview.html;
  assert.equal(writes(client.calls).length, 0, 'opening reads only, whatever Copilot staged');
  assert.match(html, /data-tab="copilot">Copilot \(2\)<\/button>/u);
  assert.match(html, /<li data-proposal="P-001">[\s\S]*<strong>P-001<\/strong> edit: Say where shoppers order\.[\s\S]*The proposed prose/u);
  assert.match(html, /<li data-proposal="P-002">[\s\S]*Unverified: it cites no code/u);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).counts.a.pending, 1);
  assert.match(html, /Copilot suggests changes for you to accept/u);

  studio.post({ type: 'spec.askCopilot' });
  await settled(client, studio);
  assert.equal(chats.length, 1); assert.match(chats[0].query, new RegExp('^/sf-spec-author ' + SPEC)); assert.equal(chats[0].isPartialQuery, false);
  assert.equal(writes(client.calls).length, 0, 'asking Copilot writes nothing');

  studio.post({ type: 'spec.proposals', decision: 'reject', proposals: ['P-002'], reason: '' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Rejecting a proposal needs your reason\./u);
  assert.equal(writes(client.calls).length, 0);
  studio.post({ type: 'spec.proposals', decision: 'accept', proposals: ['P-001', 'P-999'] });
  await settled(client, studio);
  const [accept] = writes(client.calls);
  assert.deepEqual(accept.slice(0, 6), ['spec', 'author', 'accept', SPEC, 'P-001', '--operation-id'], 'only proposals still waiting are sent');
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).spec, prose);
  studio.post({ type: 'spec.proposals', decision: 'reject', proposals: ['P-002'], reason: 'We will cite the finance policy instead.' });
  await settled(client, studio);
  assert.deepEqual(writes(client.calls)[1].slice(0, 7), ['spec', 'author', 'reject', SPEC, 'P-002', '--reason', 'We will cite the finance policy instead.']);
  html = studio.webview.html;
  assert.match(html, /data-tab="copilot">Copilot \(0\)<\/button>/u);

  studio.post({ type: 'spec.step', step: 'check' });
  await settled(client, studio);
  html = studio.webview.html;
  assert.match(html, /<form class="ss-form" data-form="spec\.settleFindings" data-findings>[\s\S]*<tr data-finding="A-001">[\s\S]*Nothing says what happens at exactly INR 5000\.00\./u);
  studio.post({ type: 'spec.settleFindings', 'finding:A-001': 'dismissed', reason: '' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Dismissing a finding needs your reason\./u);
  assert.equal(writes(client.calls).length, 2);
  studio.post({ type: 'spec.settleFindings', 'finding:A-001': 'gap', reason: '' });
  await settled(client, studio);
  assert.deepEqual(writes(client.calls)[2].slice(0, 6), ['spec', 'author', 'settle', SPEC, '--finding', 'A-001=gap']);
  const after = json(root, ['spec', 'author', 'status', SPEC]);
  assert.deepEqual([after.findings[0].status, after.findings[0].gap, after.gaps.at(-1).kind], ['gap', 'GAP-002', 'missing-boundary']);

  settings['singularityFlow.modelMode'] = 'disabled';
  t.after(() => { settings['singularityFlow.modelMode'] = 'auto'; });
  studio.post({ type: 'spec.refresh' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Copilot is off for this window/u);
  studio.post({ type: 'spec.askCopilot' });
  await settled(client, studio);
  assert.equal(chats.length, 1, 'with models off, nothing opens Copilot');
  studio.dispose();
});

test('#sflowSpecStudio reads the open draft and stages proposals; it has no way to accept, decide or publish (SPA:AC-006, AC-022)', async () => {
  for (const action of ['accept', 'reject', 'decide', 'settle', 'publish', 'discard']) {
    assert.throws(() => tool.specToolInput({ action, spec: SPEC }), /Accepting, rejecting, deciding, settling, publishing and discarding are for a person/u, action);
    // It names the person's own command, for the open specification, as the Copilot guard does.
    assert.throws(() => tool.specToolInput({ action, spec: SPEC }), new RegExp(`singularity-flow spec author ${action} ${SPEC}[ .]`, 'u'), action);
  }
  assert.throws(() => tool.specToolInput({ action: 'state', spec: 'spec-x' }), /specification ID/u);
  assert.throws(() => tool.specToolInput({ action: 'state', spec: SPEC, proposals: [] }), /does not take proposals/u);
  assert.throws(() => tool.specToolInput({ action: 'propose', spec: SPEC, proposals: [] }), /1 to 32 proposals/u);
  assert.equal(tool.specToolInput({ action: 'propose', spec: SPEC, proposals: [], assistedCheck: true }).assistedCheck, true);

  const status = { resultType: 'sflow-spec-author', action: 'status', specId: SPEC, sequence: 3, title: 'T', counts: {}, blocking: [], gaps: [], researchItems: [],
    articles: [], proposals: [{ id: 'P-001', kind: 'edit', summary: 'x', spec: 'long' }], findings: [], spec: 'line one\nline two' };
  const calls = [];
  const runner = { run: async (args) => { calls.push(args); return status; }, propose: async (payload) => { calls.push(payload); return { staged: ['P-002'], notes: [] }; }, recorded: () => calls.push('recorded') };
  const state = await tool.answerSpecStudioTool({ action: 'state', spec: SPEC }, runner);
  assert.deepEqual([state.prose, state.waiting], ['line one\nline two', [{ id: 'P-001', kind: 'edit', summary: 'x' }]]);
  assert.deepEqual(calls[0], ['spec', 'author', 'status', SPEC, '--quick', '--json']);
  const big = tool.specToolState({ ...status, spec: 'x'.repeat(9000) });
  assert.equal(big.prose, undefined);
  assert.match(big.proseOmitted, /action: "prose", from: 1/u);
  const page = tool.specToolProse(Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join('\n'), 10);
  assert.equal(page.lines[0], '10  line 10');
  assert.ok(page.next > 10 && Buffer.byteLength(JSON.stringify(page)) <= tool.SPEC_TOOL_ANSWER_BYTES);
  const staged = await tool.answerSpecStudioTool({ action: 'propose', spec: SPEC, proposals: [{ kind: 'edit', spec: 'y' }] }, runner);
  assert.deepEqual(staged.staged, ['P-002']);
  assert.ok(calls.includes('recorded'), 'the Studio reads the draft again after a proposal');
  const refusing = { ...runner, propose: async () => { throw Object.assign(new Error('refused'), { result: { error: { code: 'SPEC_PROPOSAL_INVALID', message: 'Nothing was staged',
    details: { findings: [{ field: 'proposals[0].citation', code: 'SPEC_PROPOSAL_SPAN_INVALID', message: 'bad span' }] } } } }); } };
  const refused = await tool.answerSpecStudioTool({ action: 'propose', spec: SPEC, proposals: [{ kind: 'research', summary: 'x' }] }, refusing);
  assert.deepEqual([refused.refused, refused.findings[0].field], ['SPEC_PROPOSAL_INVALID', 'proposals[0].citation'], 'a refusal comes back as data to repair from');
  assert.match(JSON.stringify(tool.SPEC_TOOL_GUIDE), /Only person acceptance changes the draft/u);
});

test('the Studio\'s pure parts: targets, slices, command classes, and the Story intake entry', () => {
  assert.deepEqual(model.specStudioTarget('SPEC-CHK-004@3'), { specId: SPEC, revision: 3, clauses: null, step: null });
  assert.deepEqual(model.specStudioTarget({ revision: 'SPEC-CHK-004@2', clauses: ['[SPEC-CHK-004:AC-001]', 'REQ-001'], step: 'attach' }),
    { specId: SPEC, revision: 2, clauses: [`${SPEC}:AC-001`, `${SPEC}:REQ-001`], step: 'attach' });
  assert.deepEqual(model.specStudioTarget({ specId: 'spec-x' }), { specId: null, revision: null, clauses: null, step: null }, 'an invalid ID opens the library');
  const all = [`${SPEC}:REQ-001`, `${SPEC}:REQ-002`, `${SPEC}:AC-001`];
  assert.equal(model.sliceOption(SPEC, 2, all, all), `--spec ${SPEC}@2`);
  assert.equal(model.sliceOption(SPEC, 2, [`${SPEC}:AC-001`, `${SPEC}:REQ-001`], all), `--spec ${SPEC}@2=REQ-001,AC-001`, 'clauses in the revision\'s order');

  for (const action of ['show', 'list', 'status', 'check', 'gaps', 'coverage']) assert.equal(commandClass(['spec', 'author', action, SPEC, '--json']), 'read', action);
  for (const action of ['new', 'edit', 'research', 'gap', 'propose', 'accept', 'reject', 'decide', 'settle', 'publish', 'discard']) assert.equal(commandClass(['spec', 'author', action, SPEC, '--json']), 'mutation', action);
  assert.equal(commandClass(['spec', 'author', 'coverage', `${SPEC}@1`, '--repair', '--story', 'S-1', '--json']), 'mutation', 'repair writes usage records');

  assert.doesNotMatch(SPEC_STUDIO_SCRIPT, /\$\{/u, 'the page script has no template holes');
  const empty = specStudioHtml({ target: model.specStudioTarget(null), step: 'elicit', library: null, status: null, revision: null, coverage: null,
    selectedGap: null, impact: null, notice: null, error: { message: 'The state branch <x> is unreachable.', next: 'singularity-flow spec author list' }, busy: null });
  assert.match(empty, /data-view="library"/u);
  assert.match(empty, /The state branch &lt;x&gt; is unreachable\.[\s\S]*Next: <code>singularity-flow spec author list<\/code>/u);
  assert.match(empty, /<form class="ss-form ss-create" data-form="spec\.new"/u);
  const partialLibrary = specStudioHtml({ target: model.specStudioTarget(null), step: 'elicit',
    library: { status: 'not-fetched', commit: null, drafts: [], specs: [{ specId: SPEC, revisions: [1], latest: { revision: 1, reviewState: 'draft', title: 'An unreviewed version' } }] },
    status: null, revision: null, coverage: null, selectedGap: null, impact: null, notice: null, error: null, busy: null });
  assert.match(partialLibrary, /Ready to use <span class="pill">0<\/span>/u, 'published drafts must not be presented as ready for Stories');
  assert.match(partialLibrary, /Published drafts <span class="pill">1<\/span>/u);
  assert.match(partialLibrary, /Load shared specifications/u, 'unfetched libraries have an explicit refresh action');

  const source = { type: 'manual', title: 'Discounts', specification: [{ revision: `${SPEC}@1`, title: 'Order discount threshold',
    clauses: [{ anchor: `[${SPEC}:REQ-001]`, text: 'WHEN…' }], decisions: [], notThisStory: [] }] };
  const intake = storyIntakeBody({ workItem: { id: 'S-1', title: 'Discounts' }, resolution: {} },
    { record: { id: 'SYS-SOURCE', path: 'singularity/work-items/S-1/source.json' }, content: JSON.stringify(source) }, []);
  assert.match(intake, new RegExp(`<button class="secondary" data-action="spec-studio" data-revision="${SPEC}@1" data-clauses="${SPEC}:REQ-001">Open in Spec Studio</button>`, 'u'));
});

test('title-first creation uses the returned CLI ID and replays an ambiguous creation without duplicating the draft', async (t) => {
  const { root } = await storefront(t);
  const original = recordingClient(root);
  let lost = true;
  const client = { ...original, run: async (argv) => {
    const result = await original.run(argv);
    if (argv[2] === 'new' && lost) { lost = false; throw new Error('Connection interrupted after saving'); }
    return result;
  }};
  SpecStudioPanel.show(client, undefined, { root: () => root });
  const studio = panels.at(-1);
  await settled(original, studio);
  assert.doesNotMatch(studio.webview.html, /name="specId"/u);
  assert.match(studio.webview.html, /data-library-search/u);
  const request = { type: 'spec.new', title: 'Reliable checkout', intent: 'Every shopper sees a clear confirmation.', areas: ['src/pricing.mjs'] };
  studio.post(request);
  await settled(original, studio);
  assert.match(studio.webview.html, /Connection interrupted after saving/u);
  assert.match(studio.webview.html, /value="Reliable checkout"/u, 'failed creation preserves the inputs');
  studio.post(request);
  await settled(original, studio);
  const creations = original.calls.filter((argv) => argv[2] === 'new');
  assert.equal(creations.length, 2);
  assert.deepEqual(creations[0], creations[1], 'retry keeps the operation ID');
  assert.equal(creations[0][3], '--title', 'the UI does not manufacture an ID');
  const library = json(root, ['spec', 'author', 'list']);
  const drafts = library.drafts.filter((draft) => draft.title === request.title);
  assert.equal(drafts.length, 1);
  const id = drafts[0].specId;
  assert.ok(studio.webview.html.includes(`data-spec="${id}"`));
  assert.match(studio.webview.html, /Every shopper sees a clear confirmation/u);
  assert.match(studio.webview.html, /data-message="spec.askCopilot">[\s\S]*?Ask Copilot/u);
  assert.equal(studio.webview.html.includes('ss-writing-form'), true);
  studio.dispose();
});

test('navigation flushes local writing; stale saves preserve text with explicit recovery', async t => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.at(-1); await settled(client, studio);
  const status = json(root, ['spec', 'author', 'status', SPEC]);
  const prose = status.spec + '\nManual detail <script> remains text.\n';
  studio.post({ type: 'spec.editing', spec: SPEC, sequence: status.sequence, text: prose });
  studio.post({ type: 'spec.home' }); await settled(client, studio);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).spec, prose, 'navigation saves before changing target');
  studio.post({ type: 'spec.open', spec: SPEC }); await settled(client, studio);
  assert.match(studio.webview.html, /Manual detail &lt;script&gt; remains text/u);
  const current = json(root, ['spec', 'author', 'status', SPEC]);
  json(root, ['spec', 'author', 'research', SPEC, '--fact', 'Another window saved', '--source', 'Product owner']);
  const pending = prose + '\nPending change from this window.\n';
  studio.post({ type: 'spec.save', sequence: current.sequence, text: pending }); await settled(client, studio);
  assert.match(studio.webview.html, /someone saved it since you read it/u);
  assert.match(studio.webview.html, /Pending change from this window/u);
  assert.match(studio.webview.html, /Keep mine as another draft/u);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).spec, prose);
  const before = writes(client.calls).length;
  studio.post({ type: 'spec.publish', state: 'draft' }); await settled(client, studio);
  assert.ok(!writes(client.calls).slice(before).some(argv => argv[2] === 'publish'), 'no publication on a failed save');
  studio.post({ type: 'spec.cancel' }); await settled(client, studio);
  assert.doesNotMatch(studio.webview.html, /Pending change from this window/u);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC]).spec, prose);
  studio.dispose();
});

test('the page sends title-only creation and unsaved edits, and searches titles and IDs without CLI requests', () => {
  const messages = [];
  const handlers = {};
  const cards = ['order discount spec-one', 'delivery fee spec-two'].map((search) => ({ dataset: { search }, hidden: false }));
  const count = { textContent: '' };
  const empty = { hidden: true };
  const root = { dataset: { spec: SPEC }, addEventListener: (event, handler) => { handlers[event] = handler; },
    querySelectorAll: (selector) => selector === '[data-library-item]' ? cards : [],
    querySelector: (selector) => selector === '.ss-writing-form' ? null : selector === '[data-search-count]' ? count : empty };
  runInNewContext(SPEC_STUDIO_SCRIPT, { window: { __sfVscode: { postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))) } },
    document: { querySelector: () => root }, setTimeout });
  const form = { dataset: { form: 'spec.new' }, querySelectorAll: (selector) => selector === '[name]' ? [
    { name: 'title', value: 'Delivery fee' }, { name: 'intent', value: 'Free above the threshold.' }, { name: 'areas', value: 'src/cart, src/shipping' }
  ] : [] };
  handlers.submit({ target: { closest: () => form }, preventDefault() {} });
  assert.deepEqual(messages.shift(), { type: 'spec.new', title: 'Delivery fee', intent: 'Free above the threshold.', areas: ['src/cart', 'src/shipping'] });
  const search = { value: 'SPEC-TWO', matches: () => true, closest: () => null };
  handlers.input({ target: search });
  assert.deepEqual(cards.map((card) => card.hidden), [true, false]);
  assert.equal(count.textContent, '1 entry');
  assert.equal(messages.length, 0, 'search does not request the CLI or a model');
  search.value = 'unknown'; handlers.input({ target: search });
  assert.equal(empty.hidden, false);
  const indicator = { textContent: '' }, words = { textContent: '' };
  const editor = { querySelectorAll: () => [{ name: 'sequence', value: '3' }, { name: 'text', value: 'Unsaved content' }],
    querySelector: (selector) => selector === '[data-edit-status]' ? indicator : words };
  handlers.input({ target: { closest: (selector) => selector === 'form[data-form="spec.save"]' ? editor : null, matches: () => false } });
  assert.deepEqual(messages.pop(), { type: 'spec.editing', spec: SPEC, sequence: 3, text: 'Unsaved content' });
  assert.equal(indicator.textContent, 'Unsaved changes');
  assert.equal(words.textContent, '2 words');
});

test('typing during an in-flight save is drained into the next exact local version', async t => {
  const { root } = await storefront(t);
  const client = recordingClient(root); const run = client.run;
  let release, entered = false;
  const wait = new Promise(resolve => { release = resolve; });
  client.run = async argv => { if (argv[2] === 'edit' && !entered) { entered = true; await wait; } return run(argv); };
  SpecStudioPanel.show(client, SPEC, { root: () => root }); const studio = panels.at(-1); await settled(client, studio);
  const status = json(root, ['spec', 'author', 'status', SPEC, '--quick']);
  const first = status.spec + '\nFirst thought.\n'; const second = first + 'Second thought.\n';
  studio.post({ type: 'spec.save', text: first, sequence: status.sequence });
  for (let i = 0; !entered && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(entered, true);
  studio.post({ type: 'spec.editing', spec: SPEC, text: second, sequence: status.sequence });
  release(); await settled(client, studio);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC, '--quick']).spec, second);
  const edits = writes(client.calls).filter(argv => argv[2] === 'edit'); assert.equal(edits.length, 2);
  assert.equal(edits[1][edits[1].indexOf('--expected-seq') + 1], String(status.sequence + 1));
  studio.dispose();
});

test('a lost save acknowledgement reuses its operation and clears the private recovery copy only after confirmation', async t => {
  const { root } = await storefront(t); const client = recordingClient(root); const run = client.run;
  let lost = true; const data = new Map();
  const memento = { get: key => data.get(key), update: async (key, value) => value === undefined ? data.delete(key) : data.set(key, structuredClone(value)) };
  client.run = async argv => { const value = await run(argv); if (argv[2] === 'edit' && lost) { lost = false; throw new Error('Save response was lost'); } return value; };
  SpecStudioPanel.show(client, SPEC, { root: () => root, memento }); const studio = panels.at(-1); await settled(client, studio);
  const status = json(root, ['spec', 'author', 'status', SPEC, '--quick']); const text = status.spec + '\nRetain this thought.\n';
  const message = { type: 'spec.save', text, sequence: status.sequence };
  studio.post(message); await settled(client, studio);
  assert.equal(data.size, 1); assert.match(studio.webview.html, /Save response was lost/u);
  studio.post(message); await settled(client, studio);
  const edits = writes(client.calls).filter(argv => argv[2] === 'edit'); assert.equal(edits.length, 2);
  assert.equal(edits[0][edits[0].indexOf('--operation-id') + 1], edits[1][edits[1].indexOf('--operation-id') + 1]);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC, '--quick']).sequence, status.sequence + 1);
  assert.equal(data.size, 0);
  studio.dispose();
});

test('the Copilot source tool pages text and preserves matching-file upload recovery', async () => {
  const source = { source: { id: 'SRC-aaaaaaaaaaaaaaaa', name: 'Notes' }, status: 'available', from: 1, text: Array.from({length: 3000}, (_, i) => 'Line ' + i).join('\n'), path: '/exact/issued/notes.txt' };
  const runner = { run: async () => ({ sources: [source] }), propose: async () => ({}) };
  const request = tool.specToolInput({ action: 'source', spec: SPEC, source: 'SRC-aaaaaaaaaaaaaaaa' });
  const answer = await tool.answerSpecStudioTool(request, runner);
  assert.ok(answer.next > 1); assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= tool.SPEC_TOOL_ANSWER_BYTES);
  assert.equal(answer.path, source.path);
  runner.run = async () => ({ sources: [{ status: 'upload-required', nextAction: 'exact matching-file route', source: source.source }] });
  const missing = await tool.answerSpecStudioTool(request, runner);
  assert.equal(missing.status, 'upload-required'); assert.equal(missing.nextAction, 'exact matching-file route');
});

test('a Studio stays on its launch repository when the surrounding window selects another capability', async t => {
  const first = await storefront(t); const second = await storefront(t);
  let selected = first.root; const forks = [];
  const owner = recordingClient(first.root);
  owner.forkForRepository = root => { forks.push(root); return recordingClient(root); };
  SpecStudioPanel.show(owner, SPEC, { root: () => selected }); const studio = panels.at(-1);
  // The owned client is deliberately private; wait for its first HTML, then wait again after a write.
  for (let i = 0; !studio.webview.html.includes('<form data-form="spec.save"') && i < 1000; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const status = json(first.root, ['spec', 'author', 'status', SPEC, '--quick']);
  selected = second.root;
  studio.post({ type: 'spec.save', text: status.spec + '\nOnly the first repository changes.\n', sequence: status.sequence });
  for (let i = 0; studio.webview.html.includes(`name="sequence" value="${status.sequence}"`) && i < 1000; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(forks, [first.root]);
  assert.match(json(first.root, ['spec', 'author', 'status', SPEC, '--quick']).spec, /Only the first repository changes/u);
  assert.doesNotMatch(json(second.root, ['spec', 'author', 'status', SPEC, '--quick']).spec, /Only the first repository changes/u);
  studio.dispose();
});

test('writing remains saveable during a review and a changed version needs a fresh confirmation', async t => {
  const { root } = await storefront(t); const client = recordingClient(root);
  const previousDelay = settings['singularityFlow.specStudio.autosaveMs']; settings['singularityFlow.specStudio.autosaveMs'] = 100;
  t.after(() => { if (previousDelay === undefined) delete settings['singularityFlow.specStudio.autosaveMs']; else settings['singularityFlow.specStudio.autosaveMs'] = previousDelay; });
  SpecStudioPanel.show(client, SPEC, { root: () => root }); const studio = panels.at(-1); await settled(client, studio);
  const status = json(root, ['spec', 'author', 'status', SPEC, '--quick']);
  studio.post({ type: 'spec.publish', state: 'draft' }); await settled(client, studio);
  const confirmation = panels.find(panel => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  assert.ok(confirmation);
  const changed = status.spec + '\nChanged while reviewing.\n';
  studio.post({ type: 'spec.editing', spec: SPEC, text: changed, sequence: status.sequence });
  await new Promise(resolve => setTimeout(resolve, 200)); await settled(client, studio);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC, '--quick']).spec, changed);
  confirmation.post({ type: 'confirmation.accept', acknowledged: true }); await settled(client, studio);
  assert.match(studio.webview.html, /writing changed during review/u);
  assert.equal(writes(client.calls).some(argv => argv[2] === 'publish'), false);
  studio.dispose();
});

test('writing during publication saves after its metadata acknowledgement and remains outside the published version', async t => {
  const { root } = await storefront(t); const original = recordingClient(root);
  let release, announce;
  const waiting = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { announce = resolve; });
  const client = { ...original, run: async argv => {
    if (argv[2] === 'publish') { announce(); await waiting; }
    return original.run(argv);
  } };
  SpecStudioPanel.show(client, SPEC, { root: () => root }); const studio = panels.at(-1); await settled(original, studio);
  t.after(() => studio.dispose());
  const status = json(root, ['spec', 'author', 'status', SPEC, '--quick']);
  studio.post({ type: 'spec.publish', state: 'draft' }); await settled(original, studio);
  const confirmation = panels.find(panel => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  assert.ok(confirmation);
  confirmation.post({ type: 'confirmation.accept', acknowledged: true }); await started;
  const later = status.spec + '\nWriting while publication finishes.\n';
  studio.post({ type: 'spec.editing', spec: SPEC, text: later, sequence: status.sequence });
  release();
  for (let attempt = 0; !original.calls.some(argv => argv[2] === 'edit') && attempt < 1000; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  await settled(original, studio);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC, '--quick']).spec, later);
  assert.equal(json(root, ['spec', 'author', 'show', SPEC + '@1']).spec, status.spec);
  assert.doesNotMatch(studio.webview.html, /someone saved it since you read it/u);
});

test('a sharing timeout exposes its actual error and retry while local writing remains saveable', async t => {
  const { root } = await storefront(t); const original = recordingClient(root);
  const client = { ...original, run: async argv => {
    if (argv[2] === 'sync') throw Object.assign(new Error('Git exceeded its deadline (ETIMEDOUT); remote result unknown.'), { result: {
      error: { code: 'SPEC_SHARED_DRAFT_PENDING', message: 'Git exceeded its deadline (ETIMEDOUT); remote result unknown.', details: { nextAction: 'singularity-flow spec author sync ' + SPEC + ' --json' } }
    } });
    return original.run(argv);
  } };
  SpecStudioPanel.show(client, SPEC, { root: () => root }); const studio = panels.at(-1); await settled(original, studio);
  t.after(() => studio.dispose());
  studio.post({ type: 'spec.sync' }); await settled(original, studio);
  const problem = studio.webview.messages.find(message => message.type === 'spec.syncState' && message.message);
  assert.match(problem.message, /ETIMEDOUT/u);
  assert.equal(problem.next, 'singularity-flow spec author sync ' + SPEC + ' --json');
  const status = json(root, ['spec', 'author', 'status', SPEC, '--quick']);
  const later = status.spec + '\nSaved while the remote is unavailable.\n';
  studio.post({ type: 'spec.save', text: later, sequence: status.sequence }); await settled(original, studio);
  assert.equal(json(root, ['spec', 'author', 'status', SPEC, '--quick']).spec, later);
});

test('choosing code uses separate native file and folder modes and keeps selection in the bound repository', async t => {
  const { root } = await storefront(t); const client = recordingClient(root); const native = globalThis.__sfSpecStudioTestVscode.window;
  const previousPick = native.showQuickPick, previousDialog = native.showOpenDialog; const options = []; let folders = false;
  native.showQuickPick = async choices => choices.find(choice => choice.folders === folders);
  native.showOpenDialog = async value => { options.push(value); return [{ fsPath: path.join(root, folders ? 'src' : 'src/pricing.mjs') }]; };
  t.after(() => { native.showQuickPick = previousPick; native.showOpenDialog = previousDialog; });
  SpecStudioPanel.show(client, SPEC, { root: () => root }); const studio = panels.at(-1); await settled(client, studio);
  t.after(() => studio.dispose());
  for (const mode of [false, true]) { folders = mode; studio.post({ type: 'spec.chooseCode' }); await settled(client, studio); }
  assert.deepEqual(options.map(option => [option.canSelectFiles, option.canSelectFolders]), [[true, false], [false, true]], 'native pickers must not request mixed selection modes');
  assert.equal(options.every(option => option.defaultUri.fsPath === root), true);
  const status = json(root, ['spec', 'author', 'status', SPEC, '--quick']);
  assert.deepEqual(status.sources.map(source => source.path), ['src/pricing.mjs', 'src']);
});
