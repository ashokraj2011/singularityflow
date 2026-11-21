/**
 * "Try it" on VS Code's approval and outcome pages (step intents spec §12.5). The runtime check puts the ready ways to
 * try a code step's version on the outcome review and the approval's review (src/runtime-check.mjs runtimeTryItView);
 * Copilot CLI already shows them. VS Code shows one optional line per way: a URL opened in the browser, ready requests
 * with copy buttons, commands to paste, a snippet. It is never a field, never required and records nothing; the page
 * posts only which way and which entry, and the panel looks the text up in what it loaded.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { buildOutcomeReview } from '../src/outcome-review.mjs';
import { runtimeTryIt } from '../src/runtime-check.mjs';
import * as messages from '../apps/vscode/src/views/messages.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import * as tryIt from '../apps/vscode/src/views/try-it.ts';

const { outcomeView } = await import('../apps/vscode/src/views/outcome-review-model.ts');
const { outcomeReviewHtml, OUTCOME_REVIEW_SCRIPT } = await import('../apps/vscode/src/views/outcome-review-page.ts');

/** The approval page with a stub `vscode`, as oap-m0-approval-defects.test.mjs loads it. */
async function approvalPage() {
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const [approvalsModel, sfGuardModel] = await Promise.all([import('../apps/vscode/src/views/approvals-model.ts'), import('../apps/vscode/src/views/sf-guard-model.ts')]);
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (name === './messages.ts') return messages;
    if (name === './webview.ts') return webview;
    if (name === './navigate.ts') return { navigateTo() {} };
    if (name === './approvals-model.ts') return approvalsModel;
    if (name === './sf-guard-model.ts') return sfGuardModel;
    if (name === './try-it.ts') return tryIt;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}

// The four kinds, as the runtime check writes them (runtime-check.mjs webCheck, backendCheck, cliCheck, libraryCheck).
const CAPTURE = { checks: [
  { kind: 'web', tryIt: { kind: 'web', url: 'http://127.0.0.1:5173/', words: 'Open http://127.0.0.1:5173/ once the app runs.',
    start: { command: 'singularity-flow app start web', copilotCommand: '/sf-run-app start' } } },
  { kind: 'backend', tryIt: { kind: 'backend', baseUrl: 'http://127.0.0.1:8080', start: { command: 'singularity-flow app start api', copilotCommand: '/sf-run-app start' },
    requests: ["curl -i -X POST 'http://127.0.0.1:8080/items' -H 'content-type: application/json' -d '{\"name\":\"sample\"}'", "curl -i -X GET 'http://127.0.0.1:8080/items/1'"] } },
  { kind: 'cli', tryIt: { kind: 'cli', commands: ['node bin/tool.mjs --help'] } },
  { kind: 'library', tryIt: { kind: 'library', snippet: "import * as library from '@acme/math';\nconsole.log(Object.keys(library));" } }
] };
// What `review --format json` and `outcome --json` carry as tryIt (runtimeTryItView), built from the capture.
const VIEW = { optional: true, recordsAcceptance: false, phase: 'implementation', generation: 2, current: true,
  words: 'Runtime check: ran web, backend; 0 findings that break use, 1 advice.', ways: runtimeTryIt(CAPTURE),
  line: 'Optional: try it at http://127.0.0.1:5173/ (start it with /sf-run-app start).' };

test('the four ways read as one optional line each, and only loopback addresses open in the browser', () => {
  const view = tryIt.tryItOf(VIEW);
  assert.deepEqual(view.ways.map((way) => [way.kind, way.shape]), [['web', 'url'], ['backend', 'requests'], ['cli', 'commands'], ['library', 'snippet']]);
  assert.equal(tryIt.tryItOpenUrl(view, 0), 'http://127.0.0.1:5173/');
  assert.equal(tryIt.tryItOpenUrl(view, 1), null, 'requests are copied, not opened');
  assert.equal(tryIt.tryItCopyText(view, 1, 1), "curl -i -X GET 'http://127.0.0.1:8080/items/1'");
  assert.equal(tryIt.tryItCopyText(view, 1, tryIt.TRY_IT_START_ENTRY), 'singularity-flow app start api');
  assert.equal(tryIt.tryItCopyText(view, 2, 0), 'node bin/tool.mjs --help');
  assert.match(tryIt.tryItCopyText(view, 3, 0), /^import \* as library from '@acme\/math';/u);
  assert.equal(tryIt.tryItCopyText(view, 9, 0), null);
  // An address that is not this laptop is never opened: the way is dropped, and nothing else is offered for it.
  assert.equal(tryIt.tryItOf({ ways: [{ kind: 'web', url: 'https://example.com/' }] }), null);
  assert.equal(tryIt.tryItOf({ ways: [{ kind: 'web', url: 'http://user:secret@127.0.0.1:3000/' }] }), null);
  assert.equal(tryIt.tryItOf(null), null);
  assert.equal(tryIt.tryItOf({ ways: [] }), null);
  assert.equal(tryIt.tryItHtml(null, () => ''), '', 'no way, no section');
});

test('the approval page shows Try it beside the tests, optional and never a field, and posts only which way', async () => {
  const page = await approvalPage();
  const request = { title: 'Approve Implementation', expected: 'implementation', workId: 'TRY-1', phaseId: 'implementation', phaseLabel: 'Implementation', generation: 2,
    artifact: null, articles: [], findings: [], witnessedClauses: null, priorExceptions: [], selfApproval: false };
  const without = page.approvalReviewBody(request);
  assert.doesNotMatch(without, /aria-label="Try it"/u);
  const body = page.approvalReviewBody({ ...request, tryIt: tryIt.tryItOf(VIEW) });
  const section = body.match(/<section class="try-it"[\s\S]*?<\/section>/u)[0];
  for (const words of ['Optional: open the app at <code>http://127.0.0.1:5173/</code>', 'Open in browser', 'Start it first: <code>singularity-flow app start web</code>',
    'Optional: 2 ready requests against <code>http://127.0.0.1:8080/</code>', 'Optional: a command to paste in a terminal', '<code>node bin/tool.mjs --help</code>',
    'Optional: a snippet that uses the library', 'Copy the snippet', 'Trying it records nothing and holds nothing.', 'Runtime check: ran web, backend']) {
    assert.ok(section.includes(words), words);
  }
  assert.doesNotMatch(section, /<(?:input|select|textarea)\b|required/u, 'nothing to fill in, nothing required');
  assert.equal([...section.matchAll(/data-try="copy"/gu)].length, 6, 'one copy per request, command and snippet, and one per start command');
  // The approval itself is unchanged: the same choice, still disabled until the person chooses.
  assert.match(body, /<button type="submit" disabled>Approve Implementation v2<\/button>/u);
  assert.match(page.REVIEW_SCRIPT, /type: 'approval\.tryIt', action: button\.dataset\.try,\s+way: Number\(button\.dataset\.tryWay\), entry: Number\(button\.dataset\.tryEntry\)/u);
  assert.match(page.REVIEW_STYLE, /\.try-it-ways/u);
  // An earlier delivery's check says so.
  assert.match(page.approvalReviewBody({ ...request, tryIt: tryIt.tryItOf({ ...VIEW, current: false }) }), /of an earlier delivery: it may be out of date/u);
});

test('the outcome page reads tryIt from outcome --json and shows it above trying the Story result', () => {
  const outcome = buildOutcomeReview({
    workflow: { workItem: { id: 'TRY-2', title: 'Plot' }, currentPhase: 'implementation', phases: { implementation: { status: 'in_progress', generation: 2, generationPolicy: { task: 'code' } } } },
    graph: { records: { indexes: [] } }, evaluation: { lifecycle: { words: 'In progress at Implementation' }, completion: { label: 'Incomplete' }, findings: [], rows: [] },
    application: { status: 'none-declared' }
  });
  const view = outcomeView({ data: { outcome: { ...outcome, tryIt: VIEW } } });
  assert.deepEqual(view.tryIt.ways.map((way) => way.shape), ['url', 'requests', 'commands', 'snippet']);
  const html = outcomeReviewHtml(view, null);
  assert.ok(html.indexOf('aria-label="Try it"') < html.indexOf('1. Try the Story result'), 'Try it comes first');
  assert.match(html, /data-outcome="try-open" data-item="0" data-check="0">Open in browser/u);
  assert.match(html, /data-outcome="try-copy" data-item="1" data-check="0"/u);
  assert.match(html, new RegExp(`data-outcome="try-copy" data-item="0" data-check="${tryIt.TRY_IT_START_ENTRY}"`, 'u'));
  // The page posts an action name and indexes only, as before.
  assert.doesNotMatch(OUTCOME_REVIEW_SCRIPT, /command/u);
  // No check kept: no section, and the rest of the page is as it was.
  const plain = outcomeView({ data: { outcome } });
  assert.equal(plain.tryIt, undefined);
  assert.doesNotMatch(outcomeReviewHtml(plain, null), /aria-label="Try it"/u);
});

test('each panel handles Try it by looking the way up in what it loaded, and opens only loopback addresses', async () => {
  const approval = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  assert.match(approval, /'approval\.tryIt': \(message\) => \{[\s\S]*?tryItOpenUrl\(request\.tryIt, way\)[\s\S]*?tryItCopyText\(request\.tryIt, way, entry\)/u);
  const outcome = await readFile(new URL('../apps/vscode/src/views/outcome-review.ts', import.meta.url), 'utf8');
  assert.match(outcome, /action === 'try-open'[\s\S]*?tryItOpenUrl\(this\.view\?\.tryIt, item\)/u);
  assert.match(outcome, /action === 'try-copy'[\s\S]*?tryItCopyText\(this\.view\?\.tryIt, item, check\)/u);
  // The approval page's data: the review bundle the page already reads carries it.
  const actions = await readFile(new URL('../apps/vscode/src/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /tryIt: \(await import\('\.\/views\/try-it\.ts'\)\)\.tryItOf\(storyReview\?\.tryIt\)/u);
  const review = await readFile(new URL('../src/review.mjs', import.meta.url), 'utf8');
  assert.match(review, /runtimeTryItView\(root, workflow, phase\.id\)\.catch\(\(\) => null\)/u);
});
