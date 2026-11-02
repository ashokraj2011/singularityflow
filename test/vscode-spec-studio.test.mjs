import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childTimeout } from './helpers/child-timeout.mjs';

// SPEC-SPA v1.3 S3: the Spec Studio panel, model-free. The panel host runs against a `vscode` stub,
// as in vscode-apm-packages.test.mjs, and every command it runs goes through a recording client to
// the real CLI in a real repository, so the page and the engine can never disagree about a shape.
const panels = [];
const copied = [];
const chats = [];
const settings = { 'singularityFlow.modelMode': 'auto' };
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
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
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
const READS = new Set(['list', 'status', 'show', 'gaps', 'check']);

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

const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' };
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function cli(cwd, args) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 16 * 1024 * 1024 });
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
  json(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold', '--area', 'src/pricing.mjs']);
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

test('the Studio opens a draft at its open gap: D/A/H and the gap first, options with impact, the clause flagged (SPA:AC-018)', async (t) => {
  const { root, rule } = await storefront(t);
  const client = recordingClient(root);
  panels.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  const html = studio.webview.html;
  assert.equal(writes(client.calls).length, 0, 'opening reads only');
  assert.ok(client.calls.some((argv) => argv.join(' ') === `spec author status ${SPEC} --json`), '`spec author status` is the host\'s one read of a draft');

  const left = html.match(/<aside class="ss-left"[\s\S]*?<\/aside>/u)?.[0] ?? '';
  assert.match(left, /<strong>D \d\/8<\/strong><small>rules passed<\/small>/u);
  assert.match(left, /<strong>A<\/strong><small>not run<\/small>/u);
  assert.match(left, /<strong>H \d+<\/strong><small>open<\/small>/u);
  assert.match(left, /<ul class="ss-pipeline" data-pipeline><li><button type="button" class="ss-gap-row selected" data-message="spec.gap" data-gap="GAP-001">/u, 'the open gap is first, and selected');
  for (const file of ['spec.md', 'research.json', 'gaps.json', 'quality.json']) assert.match(left, new RegExp(`<code>${file.replace('.', '\\.')}</code>`, 'u'));

  const stage = html.match(/<section class="ss-stage" data-stage="gaps"[\s\S]*?<\/section>/u)?.[0] ?? '';
  assert.ok(stage, 'the middle column is the gap resolver');
  assert.match(stage, /Strictly above INR 5000\.00, or at and above\?/u);
  assert.match(stage, new RegExp(`<code>${rule.id}</code>`, 'u'), 'its evidence');
  const [o1, o2] = [...stage.matchAll(/<div class="ss-option" data-option-row="(O\d)">([\s\S]*?)<\/div>/gu)];
  assert.deepEqual([o1?.[1], o2?.[1]], ['O1', 'O2']);
  assert.match(o1[2], /<ul class="ss-impact">[\s\S]*orderDiscount[\s\S]*called by orderSummary/u, 'O1 changes the code: its impact, computed with no model');
  assert.match(o2[2], /Impact: none; it keeps the code as it is\./u);
  assert.match(o1[2], /data-decide="O1" data-gap="GAP-001" disabled>[\s\S]*Close gap with O1 and sign/u, 'closing waits for a rationale');

  const right = html.match(/<section class="ss-right"[\s\S]*?<\/section>/u)?.[0] ?? '';
  assert.match(right, new RegExp(`<div class="ss-clause flagged" data-clause-id="${SPEC}:REQ-001">[\\s\\S]*?<button type="button" class="pill wait ss-flag" data-message="spec.gap" data-gap="GAP-001">code disagrees, GAP-001</button>`, 'u'));
  assert.match(right, new RegExp(`<div class="ss-clause" data-clause-id="${SPEC}:AC-001">`, 'u'), 'a clause no open gap names is not flagged');
  assert.match(right, /data-step="research" data-item="R-001">R-001<\/button>/u, 'a research mention links to the research');
  studio.dispose();
});

test('Close gap with O1 and sign runs spec author decide --option O1; the signer and reason are recorded; the counts update (SPA:AC-019)', async (t) => {
  const { root } = await storefront(t);
  const client = recordingClient(root);
  panels.length = 0;
  SpecStudioPanel.show(client, SPEC, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  const before = Number(studio.webview.html.match(/<strong>H (\d+)<\/strong>/u)[1]);

  studio.post({ type: 'spec.decide', gap: 'GAP-001', option: 'O1', reason: 'Strictly above, as finance agreed.' });
  await settled(client, studio);
  const [decide] = writes(client.calls);
  assert.deepEqual(decide.slice(0, 10), ['spec', 'author', 'decide', SPEC, 'GAP-001', '--option', 'O1', '--reason', 'Strictly above, as finance agreed.', '--operation-id']);
  assert.match(decide[10], /^vsc-[0-9a-f-]{36}$/u, 'the host generates the operation ID');
  assert.equal(writes(client.calls).length, 1, 'one click, one write');

  const [gap] = json(root, ['spec', 'author', 'status', SPEC]).gaps;
  assert.deepEqual([gap.status, gap.decision.option, gap.decision.reason, gap.decision.by.name], ['decided', 'O1', 'Strictly above, as finance agreed.', 'Spec Author']);
  const html = studio.webview.html;
  assert.equal(Number(html.match(/<strong>H (\d+)<\/strong>/u)[1]), before - 1, 'H has one gap fewer open');
  assert.match(html, /GAP-001 is closed with O1 and signed with your Git identity\./u);
  assert.match(html, /<p data-decision><strong>Decided:<\/strong> WHEN an order total is greater than INR 5000\.00/u);
  assert.match(html, /Spec Author, \d{4}-\d{2}-\d{2} \d{2}:\d{2}: Strictly above, as finance agreed\./u, 'the event shows the signer and the reason');
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

  for (const step of model.STEP_IDS) {
    studio.post({ type: 'spec.step', step });
    await settled(client, studio);
    const stage = studio.webview.html.match(/<section class="ss-stage" data-stage="([a-z]+)"[\s\S]*?<div class="ss-controls">[\s\S]*?<\/div>\s*<\/section>/u);
    assert.equal(stage?.[1], step, `${step} is shown`);
    assert.match(stage[0], /data-message="spec\.back">[\s\S]*?Back<\/button>/u, `${step} has Back`);
    if (/<form class="ss-form" data-form="spec\.(save|research|fact|openGap|settle|defer)"/u.test(stage[0])) {
      assert.match(stage[0], /data-message="spec\.cancel" data-cancel>Cancel<\/button>/u, `${step}'s forms have Cancel`);
    }
    studio.post({ type: 'spec.cancel' });
    await settled(client, studio);
    assert.match(studio.webview.html, /Nothing was saved; the draft is unchanged\./u);
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
  assert.match(studio.webview.html, new RegExp(`Saved snapshot ${status.sequence + 1}\\.`, 'u'));

  studio.post({ type: 'spec.settle', decisions: Object.fromEntries(status.articles.map(({ article }) => [article, 'satisfied'])), reason: '' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Recorded 6 checklist decision\(s\)\./u);
  assert.match(studio.webview.html, /<strong>H 0<\/strong>/u);

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
  assert.deepEqual(writes(client.calls).at(-1), ['spec', 'author', 'publish', SPEC, '--reviewed', '--json']);

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
  assert.match(html, new RegExp(`<div class="ss-clause in-slice" data-clause-id="${SPEC}:REQ-001">`, 'u'));
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
  assert.match(html, /<strong>A<\/strong><small>1 pending<\/small>/u);
  assert.match(html, new RegExp(`Opens Copilot Chat with <code>/sf-spec-author ${SPEC} </code>`, 'u'), 'no tool outside VS Code proper: the plain prompt');

  studio.post({ type: 'spec.askCopilot' });
  await settled(client, studio);
  assert.deepEqual(chats, [{ query: `/sf-spec-author ${SPEC} `, isPartialQuery: true }]);
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
  assert.deepEqual(calls[0], ['spec', 'author', 'status', SPEC, '--json']);
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
  assert.match(JSON.stringify(tool.SPEC_TOOL_GUIDE), /Nothing lands in the draft until the person accepts it/u);
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
  assert.match(empty, /<form class="ss-form" data-form="spec\.new"/u);

  const source = { type: 'manual', title: 'Discounts', specification: [{ revision: `${SPEC}@1`, title: 'Order discount threshold',
    clauses: [{ anchor: `[${SPEC}:REQ-001]`, text: 'WHEN…' }], decisions: [], notThisStory: [] }] };
  const intake = storyIntakeBody({ workItem: { id: 'S-1', title: 'Discounts' }, resolution: {} },
    { record: { id: 'SYS-SOURCE', path: 'singularity/work-items/S-1/source.json' }, content: JSON.stringify(source) }, []);
  assert.match(intake, new RegExp(`<button class="secondary" data-action="spec-studio" data-revision="${SPEC}@1" data-clauses="${SPEC}:REQ-001">Open in Spec Studio</button>`, 'u'));
});
