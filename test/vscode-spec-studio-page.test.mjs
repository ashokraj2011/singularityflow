import assert from 'node:assert/strict';
import test from 'node:test';

// The writing page's script in a real browser: what a form keeps and gives back can only be seen on a real DOM.
// It runs where the pinned review browser is installed and says so where it is not; the explicit local check
// (scripts/spec-studio-visual-check.mjs) and a real VS Code cover the rest.
const { composeRegions, specStudioHtml, SPEC_STUDIO_SCRIPT, SPEC_STUDIO_STYLE } = await import('../apps/vscode/src/views/spec-studio-page.ts');
const { statusFrom } = await import('../apps/vscode/src/views/spec-studio-model.ts');
const { SPEC_STUDIO_SPLIT_SCRIPT } = await import('../apps/vscode/src/views/spec-studio-split.ts');
const { page: webviewPage } = await import('../apps/vscode/src/views/webview.ts');
const SPEC = 'SPEC-PAGE-001';

const openGap = (id, question) => ({ id, kind: 'open-question', status: 'open', question, evidence: [], clauses: [], options: [{ id: 'O1', wording: 'Option one', changesCode: false }] });
const closedGap = (id, question) => ({ ...openGap(id, question), status: 'decided', decision: { option: 'O1', choice: 'Option one', reason: 'Because.', by: { name: 'A person', email: null }, at: '2026-11-05T00:00:00.000Z' } });
const proposal = (id, spec) => ({ id, kind: 'edit', summary: 'A change', notes: [], basis: { sequence: 1 }, basisSequence: 1, proposedBy: null, at: '2026-11-05T00:00:00.000Z', spec, stale: true });
const statusWith = (overrides = {}) => statusFrom({ resultType: 'sflow-spec-author', action: 'status', specId: SPEC, title: 'A page', kind: 'business', sequence: 3, spec: '# A page\n\nWords.\n', areas: [], gaps: [], researchItems: [],
  counts: { d: { passed: 0, total: 0 }, a: { status: 'not-run', pending: 0 }, h: { open: 0, deferred: 0 } }, proposals: [], findings: [], sources: [], origins: [], rules: [], articles: [], clauseIds: [], blocking: [], ...overrides });
const stateWith = (status, overrides = {}) => ({ target: { specId: SPEC, revision: null, clauses: null, step: null }, step: 'draft', library: null, status, revision: null, coverage: null, split: null, splitDraft: null, selectedGap: null, impact: null, notice: null, error: null, busy: null, copilot: { available: true, tool: true }, ...overrides });

let chromium;
try { ({ chromium } = await import('playwright-core')); } catch { chromium = null; }
async function browserPage(t, state) {
  if (!chromium) return t.skip('playwright-core is not installed here.'), null;
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { return t.skip(`No browser is installed here, so the page script did not run: ${String(error.message).split('\n')[0]}`), null; }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'the page script threw'));
  await page.goto('about:blank');
  await page.evaluate(() => { window.__sfMessages = []; window.__sfVscode = { postMessage: message => window.__sfMessages.push(message) }; });
  await page.setContent(webviewPage('Spec Studio', specStudioHtml(state), '', 'page-test', `${SPEC_STUDIO_SCRIPT}${SPEC_STUDIO_SPLIT_SCRIPT}`, { styles: SPEC_STUDIO_STYLE }));
  return page;
}
const post = (page, message) => page.evaluate(value => window.postMessage(value, '*'), message);
const sentOf = (page, type) => page.evaluate(wanted => window.__sfMessages.filter(message => message.type === wanted), type);
const settled = async (page, submitId, outcome) => { await post(page, { type: 'spec.settled', submitId, outcome }); await page.waitForTimeout(50); };

test('two forms with one field name keep their own text through a region update, so a person accepts the words they wrote', async t => {
  const status = statusWith({ proposals: [proposal('P-001', 'First proposal.'), proposal('P-002', 'Second proposal.')] });
  const page = await browserPage(t, stateWith(status)); if (!page) return;
  const box = id => page.locator(`[data-region="cowriter"] form[data-form="spec.acceptEdited"]:has(input[value="${id}"]) textarea[name=text]`);
  await box('P-001').fill('My merge of the first.');
  await box('P-002').fill('My merge of the second.');
  const next = composeRegions(stateWith(status, { notice: 'Something else happened.' }), status);
  await post(page, { type: 'spec.regions', regions: { cowriter: next.cowriter + '<p data-arrived>New.</p>' } });
  await page.waitForSelector('[data-arrived]');
  assert.equal(await box('P-001').inputValue(), 'My merge of the first.');
  assert.equal(await box('P-002').inputValue(), 'My merge of the second.');
  await page.locator('[data-region="cowriter"] form[data-form="spec.acceptEdited"]:has(input[value="P-001"]) button[type=submit]').click();
  const [sent] = await sentOf(page, 'spec.acceptEdited');
  assert.equal(sent.proposal, 'P-001'); assert.equal(sent.text, 'My merge of the first.');
});

test('a reason typed for one question is never carried into the next one, where it could be signed', async t => {
  const first = statusWith({ gaps: [openGap('GAP-001', 'First question?'), openGap('GAP-002', 'Second question?')] });
  const page = await browserPage(t, stateWith(first)); if (!page) return;
  const cowriter = page.locator('[data-region="cowriter"]');
  await cowriter.locator('[data-decide-for="GAP-001"] [data-rationale]').fill('A rationale for the first.');
  await cowriter.locator('form[data-form="spec.defer"] textarea[name=reason]').fill('A defer reason for the first.');
  await cowriter.locator('form[data-form="spec.defer"] input[name=owner]').fill('A person');
  // The first is settled elsewhere, so the second question takes its place in the same region.
  const second = statusWith({ gaps: [closedGap('GAP-001', 'First question?'), openGap('GAP-002', 'Second question?')] });
  await post(page, { type: 'spec.regions', regions: { cowriter: composeRegions(stateWith(second), second).cowriter } });
  await cowriter.locator('[data-decide-for="GAP-002"]').waitFor();
  assert.equal(await cowriter.locator('[data-decide-for="GAP-002"] [data-rationale]').inputValue(), '', 'nothing typed for GAP-001 reaches GAP-002');
  assert.equal(await cowriter.locator('form[data-form="spec.defer"] textarea[name=reason]').inputValue(), '');
  assert.equal(await cowriter.locator('form[data-form="spec.defer"] input[name=owner]').inputValue(), '');
  assert.equal(await cowriter.locator('[data-decide="O1"]').isDisabled(), true, 'and signing still waits for a reason of its own');
});

test('a form that was sent is usable again whatever the region did: emptied when accepted, kept when refused, and a reason is not sent twice', async t => {
  const status = statusWith({ proposals: [{ ...proposal('P-001', 'A proposal.'), stale: false }] });
  const page = await browserPage(t, stateWith(status)); if (!page) return;
  const form = page.locator('[data-region="cowriter"] form[data-form="spec.proposals"]');
  const reject = form.locator('button[value=reject]'), reason = form.locator('textarea[name=reason]');
  await form.locator('input[name="proposals[]"]').check();
  // Refused: the same error again changes no region, so nothing else would re-enable it.
  await reject.click();
  assert.equal(await reject.isDisabled(), true, 'a send disables it until it is answered');
  let [sent] = await sentOf(page, 'spec.proposals');
  await settled(page, sent.submitId, 'refused');
  assert.equal(await reject.isDisabled(), false, 'a refusal leaves it usable');
  await reason.fill('Not what we need.');
  await reject.click();
  sent = (await sentOf(page, 'spec.proposals')).at(-1);
  assert.equal(sent.reason, 'Not what we need.');
  await settled(page, sent.submitId, 'refused');
  assert.equal(await reason.inputValue(), 'Not what we need.', 'a refused form keeps what was typed');
  await reject.click();
  sent = (await sentOf(page, 'spec.proposals')).at(-1);
  // Accepted, with the region rendered unchanged before the answer: the typed value would have been restored into it.
  await post(page, { type: 'spec.regions', regions: { cowriter: composeRegions(stateWith(status), status).cowriter } });
  await page.waitForTimeout(50);
  await settled(page, sent.submitId, 'done');
  assert.equal(await reason.inputValue(), '', 'an accepted form starts empty, so the reason cannot be sent again');
  assert.equal(await reject.isDisabled(), false);
});

test('Send to Copilot works more than once, and clears only what was sent', async t => {
  const status = statusWith();
  const page = await browserPage(t, stateWith(status)); if (!page) return;
  const request = page.locator('#ss-request'), send = page.locator('[data-region="send"] button');
  await request.fill('Make this clearer.');
  await send.click();
  assert.equal(await send.isDisabled(), true);
  let sent = (await sentOf(page, 'spec.ask')).at(-1);
  assert.equal(sent.request, 'Make this clearer.');
  await settled(page, sent.submitId, 'done');
  assert.equal(await send.isDisabled(), false, 'the region did not change, and the button still comes back');
  assert.equal(await request.inputValue(), '');
  await request.fill('Second question.');
  await send.click();
  sent = (await sentOf(page, 'spec.ask')).at(-1);
  assert.equal(sent.request, 'Second question.');
  await settled(page, sent.submitId, 'refused');
  assert.equal(await request.inputValue(), 'Second question.', 'a refused request is kept');
  // An unavailable Copilot stays disabled through all of this.
  const off = stateWith(status, { copilot: { available: false, tool: false } });
  await post(page, { type: 'spec.regions', regions: { send: composeRegions(off, status).send } });
  await page.waitForTimeout(50);
  assert.equal(await send.isDisabled(), true);
});

test('the footer stops repeating a failure once the page has moved on', async t => {
  const status = statusWith();
  const page = await browserPage(t, stateWith(status)); if (!page) return;
  await post(page, { type: 'spec.saveFailed', message: 'Disk was busy.' });
  await page.waitForFunction(() => document.querySelector('[data-edit-status]').textContent === 'Disk was busy.');
  await post(page, { type: 'spec.regions', regions: {}, editStatus: 'Write freely. Changes save automatically.' });
  await page.waitForFunction(() => document.querySelector('[data-edit-status]').textContent.startsWith('Write freely'));
});

test('the questions list reaches every question, and a decided one can be reopened', async t => {
  const status = statusWith({ gaps: [closedGap('GAP-001', 'Settled question?'), openGap('GAP-002', 'Open question?')] });
  const state = stateWith(status, { step: 'gaps' });
  const page = await browserPage(t, state); if (!page) return;
  const rows = page.locator('[data-questions] button');
  assert.deepEqual(await rows.evaluateAll(buttons => buttons.map(button => button.dataset.gap)), ['GAP-002', 'GAP-001'], 'open questions first');
  await rows.nth(1).click();
  const [sent] = await sentOf(page, 'spec.gap');
  assert.equal(sent.gap, 'GAP-001');
  const open = stateWith(status, { step: 'gaps', selectedGap: 'GAP-001' });
  await post(page, { type: 'spec.regions', regions: { notices: composeRegions(open, status).notices } });
  await page.locator('form[data-form="spec.reopen"]').waitFor();
});

test('the styles carry no layout for a column that no longer exists', () => {
  assert.doesNotMatch(SPEC_STUDIO_STYLE, /\.ss-grid|\.ss-left|\.ss-steps/u);
});
