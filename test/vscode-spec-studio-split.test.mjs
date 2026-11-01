import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childTimeout } from './helpers/child-timeout.mjs';

// SPEC-SPA v1.3 S5: the Spec Studio's split planner, model-free. As in vscode-spec-studio.test.mjs,
// the panel host runs against a `vscode` stub and every command it runs goes to the real CLI in a
// real repository through a recording client.
const panels = [];
globalThis.__sfSpecSplitTestVscode = {
  ViewColumn: { Active: 1 },
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}) },
  Range: class { constructor(...args) { this.args = args; } },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
  workspace: { openTextDocument: async (uri) => ({ uri }), fs: { stat: async () => ({}) }, getConfiguration: () => ({ get: (key, fallback) => fallback }) },
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
  const api = globalThis.__sfSpecSplitTestVscode;
  export const ViewColumn = api.ViewColumn, Uri = api.Uri, Range = api.Range, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const split = await import('../apps/vscode/src/views/spec-studio-split.ts');
const { SpecStudioPanel } = await import('../apps/vscode/src/views/spec-studio.ts');
const { commandClass } = await import('../apps/vscode/src/cli/client.ts');

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const SPEC = 'SPEC-CHK-004';
const CHILD = 'SPEC-CHK-004-INR';
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' };

const SPEC_TEXT = `# Order discount threshold

## Outcome

The 10 percent order discount applies only to orders strictly above INR 5000.00.

## Actors

- Shopper: places INR orders.

## User scenarios

1. A shopper with an INR 6000.00 cart sees a 10 percent discount.

## Scope

In scope: the order discount rule. Out of scope: tax and shipping.

## Requirements

WHEN an INR order total is strictly greater than INR 5000.00, the cart SHALL apply a 10 percent order discount. [${SPEC}:REQ-001]

WHEN a cart is not in INR, the cart SHALL apply no order discount. [${SPEC}:REQ-002]

## Acceptance

An INR 5000.01 cart gets INR 500.00 off, as ${SPEC}:REQ-001 states. [${SPEC}:AC-001]

A USD cart of 6000.00 gets nothing off, as ${SPEC}:REQ-002 states. [${SPEC}:AC-002]

## Decisions and open questions

- None.
`;

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

/** A storefront whose SPEC-CHK-004@1 is published reviewed, with four clauses. */
async function library(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-split-studio-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const remote = path.join(directory, 'remote.git');
  const root = path.join(directory, 'app');
  git(directory, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{ "name": "storefront", "type": "module" }\n');
  await writeFile(path.join(root, 'src', 'pricing.mjs'), 'export const DISCOUNT_THRESHOLD = 500000;\n');
  git(directory, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Spec Author');
  git(root, 'config', 'user.email', 'spec.author@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Storefront');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  json(root, ['spec', 'author', 'new', SPEC, '--title', 'Order discount threshold']);
  const file = path.join(directory, 'spec.md');
  await writeFile(file, SPEC_TEXT);
  json(root, ['spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1']);
  json(root, ['spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied']);
  assert.equal(json(root, ['spec', 'author', 'publish', SPEC, '--reviewed']).revision, 1);
  return { directory, root };
}

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

async function settled(client, studio) {
  for (let quiet = 0, rounds = 0; quiet < 3 && rounds < 6000; rounds += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    quiet = client.pending === 0 && !/data-busy/u.test(studio.webview.html) ? quiet + 1 : 0;
  }
}

const PLAN = {
  children: [{ specId: CHILD, title: 'INR order discount', clauses: [`${SPEC}:REQ-001`, `${SPEC}:AC-001`] }],
  stories: [{ key: 'S1', title: 'No discount outside INR', description: '', workId: '', dependsOn: [], clauses: [`${SPEC}:REQ-002`, `${SPEC}:AC-002`] }],
  notDelivered: []
};

test('the Studio splits a reviewed revision: a refused plan names its clause, a proposal is checked, publishing asks once and starts no Story', async (t) => {
  const { root } = await library(t);
  const client = recordingClient(root);
  panels.length = 0;
  SpecStudioPanel.show(client, { revision: `${SPEC}@1`, step: 'attach' }, { root: () => root });
  const studio = panels.find((panel) => panel.viewType === 'singularityFlow.specStudio');
  await settled(client, studio);
  let html = studio.webview.html;
  assert.ok(html.includes('Split SPEC-CHK-004@1</h3>'), 'the attach stage has a split section');
  assert.match(html, /<form class="ss-form" data-split-form data-spec="SPEC-CHK-004" data-revision="1">/u);
  assert.equal((html.match(/<fieldset class="ss-split-group" data-split-group>/gu) ?? []).length, 2, 'one Story slice with every clause, and the template');
  assert.ok(client.calls.some((argv) => argv.join(' ') === `spec split ${SPEC}@1 --json`), 'the revision\'s splits are read');

  studio.post({ type: 'spec.splitPropose', revision: 1, plan: { ...PLAN, stories: [{ ...PLAN.stories[0], clauses: [`${SPEC}:REQ-002`] }] } });
  await settled(client, studio);
  html = studio.webview.html;
  assert.ok(html.includes('data-error'), 'the engine refuses an unallocated clause');
  assert.match(html, /SPEC-CHK-004:AC-002 is allocated to no child or Story slice/u);
  assert.equal(json(root, ['spec', 'split', `${SPEC}@1`]).proposal, null, 'nothing was proposed');

  studio.post({ type: 'spec.splitPropose', revision: 1, plan: PLAN });
  await settled(client, studio);
  html = studio.webview.html;
  assert.match(html, /Proposed the split on this clone; nothing is published yet\./u);
  assert.match(html, /data-split-proposal/u);
  assert.match(html, /singularity-flow start &lt;WORK-ID&gt; --from-branch &lt;BRANCH&gt; --title &#39;No discount outside INR&#39; --spec SPEC-CHK-004@1=REQ-002,AC-002/u);
  assert.match(html, /<button type="button" data-message="spec\.splitPublish" data-revision="1">/u);
  assert.deepEqual(client.calls.filter((argv) => argv.includes('--propose')).map((argv) => argv.slice(0, 4)), [
    ['spec', 'split', `${SPEC}@1`, '--propose'], ['spec', 'split', `${SPEC}@1`, '--propose']]);

  // Declining the confirmation publishes nothing; accepting publishes split 1.
  studio.post({ type: 'spec.splitPublish' });
  await settled(client, studio);
  let confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  assert.equal(confirmation?.title, `Publish split 1 of ${SPEC}@1`, 'one confirmation, naming the split');
  confirmation.post({ type: 'confirmation.cancel' });
  await settled(client, studio);
  assert.match(studio.webview.html, /Nothing was published\./u);
  assert.equal(client.calls.filter((argv) => argv.includes('--publish')).length, 0);

  studio.post({ type: 'spec.splitPublish' });
  await settled(client, studio);
  confirmation = panels.find((panel) => panel.viewType === 'singularityFlow.reviewConfirmation' && panel.visible);
  confirmation.post({ type: 'confirmation.accept', acknowledged: true });
  await settled(client, studio);
  html = studio.webview.html;
  assert.match(html, new RegExp(`Published split 1 of ${SPEC}@1\\. No Story was started; ${CHILD} drafted on this clone\\.`, 'u'));
  assert.match(html, /data-split-published/u);
  assert.match(html, new RegExp(`data-message="spec\\.open" data-spec="${CHILD}"`, 'u'), 'the child opens in the Studio');
  assert.deepEqual(client.calls.filter((argv) => argv.includes('--publish')), [['spec', 'split', `${SPEC}@1`, '--publish', '--json']]);
  assert.deepEqual(json(root, ['spec', 'author', 'status', CHILD]).clauseIds, [`${CHILD}:REQ-001`, `${CHILD}:AC-001`]);

  studio.post({ type: 'spec.coverage' });
  await settled(client, studio);
  html = studio.webview.html;
  assert.match(html, /<td><code>REQ-001<\/code><\/td><td><span class="pill wait">allocated<\/span><\/td>\s*<td>child SPEC-CHK-004-INR<\/td>/u);
  assert.match(html, /<td>slice S1 \(No discount outside INR\)<\/td>/u);
  studio.dispose();
});

test('the split planner\'s pure parts: answers, the posted plan, the plan file, the confirmation and command classes', () => {
  assert.equal(split.splitFrom({ resultType: 'sflow-spec-author', action: 'coverage' }), null);
  const view = split.splitFrom({ resultType: 'sflow-spec-author', action: 'split', mode: 'read', specId: SPEC, revision: 1,
    splits: [{ split: 1, recordedAt: '2026-11-01T10:00:00.000Z', publishedBy: { name: 'Spec Author' },
      children: [{ specId: CHILD, title: 'INR', clauses: [{ parent: `${SPEC}:REQ-001`, child: `${CHILD}:REQ-001` }] }], stories: [], notDelivered: [] }],
    proposal: { plan: { children: [], stories: [{ key: 'S1', title: 'All', clauses: [`${SPEC}:REQ-001`], command: 'x' }], notDelivered: [] }, planSha256: 'sha256:1', stale: false,
      findings: [], stories: [{ key: 'S1', title: 'All', clauses: [`${SPEC}:REQ-001`], dependsOn: [], command: 'singularity-flow start <WORK-ID> …' }] } });
  assert.deepEqual(view.splits[0].children[0].clauses, [`${SPEC}:REQ-001`], 'a published child\'s clauses read as the parent clauses');
  assert.equal(view.splits[0].publishedBy, 'Spec Author');
  const confirmation = split.splitConfirmation(view, view.proposal);
  assert.equal(confirmation.title, `Publish split 2 of ${SPEC}@1`);
  assert.match(confirmation.detail, /^singularity-flow spec split SPEC-CHK-004@1 --publish\n/u);
  assert.match(confirmation.summary, /No Story is started\./u);

  const clauses = [`${SPEC}:REQ-001`, `${SPEC}:AC-001`];
  const plan = split.splitPlanRequest({ plan: { children: [{ specId: ` ${CHILD} `, title: 'INR', clauses: [`${SPEC}:REQ-001`, `${SPEC}:REQ-099`, 7] }],
    stories: [{ key: 'S1', title: 'Proof', workId: '', description: '', dependsOn: [' ', 'S0'], clauses: [`${SPEC}:AC-001`] }],
    notDelivered: [{ clause: `${SPEC}:AC-001`, reason: '  ' }, { clause: `${SPEC}:REQ-001`, reason: 'Elsewhere.' }] } }, clauses);
  assert.deepEqual(plan.children, [{ specId: CHILD, title: 'INR', clauses: [`${SPEC}:REQ-001`] }], 'only the revision\'s own clauses');
  assert.deepEqual(plan.stories[0].dependsOn, ['S0']);
  assert.deepEqual(plan.notDelivered, [{ clause: `${SPEC}:REQ-001`, reason: 'Elsewhere.' }], 'a left-out clause needs its reason');
  assert.deepEqual(JSON.parse(split.planFileText(plan)).stories, [{ key: 'S1', title: 'Proof', clauses: [`${SPEC}:AC-001`], dependsOn: ['S0'] }]);

  assert.equal(commandClass(['spec', 'split', `${SPEC}@1`, '--json']), 'read');
  assert.equal(commandClass(['spec', 'split', `${SPEC}@1`, '--propose', '--file', 'plan.json', '--json']), 'mutation');
  assert.equal(commandClass(['spec', 'split', `${SPEC}@1`, '--publish', '--json']), 'mutation');

  const draft = split.splitSectionHtml(null, { specId: SPEC, revision: 2, reviewed: false }, []);
  assert.match(draft, /is a draft revision; only a reviewed revision can be split\./u);
});
