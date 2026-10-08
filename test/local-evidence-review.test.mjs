import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { request } from 'node:http';
import { createLocalEvidenceReview, evidenceReviewPage } from '../src/local-evidence-review.mjs';
import { issueActionAuthorization, consumeActionAuthorization, captureEvidenceReviewAuthorization } from '../src/action-authorization.mjs';

const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
const label = 'Correct evidence PEA-' + 'a'.repeat(24);
const card = { plan: { planId: 'PEA-' + 'a'.repeat(24), planHash: 'sha256:' + 'b'.repeat(64), reviewer: 'reviewer@example.test',
  revision: '123', subject: { workId: 'UI-1', phaseId: 'custom-code' }, preview: {
    kind: 'evidence-contract-correction-preview', workId: 'UI-1', phaseId: 'custom-code', clauseId: 'UI-1:AC-001',
    path: 'stories/UI-1/evidence/screen.png', authorityGroups: ['plan-reviewers'], reason: 'Correct the retained screenshot delivery classification.',
    reviewedFile: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    previousClaim: { fulfillment: 'modified' }, previousContract: null,
    proposedClaim: { fulfillment: 'evidence' }, proposedContract: { slots: [{ method: 'visual', role: 'primary' }] }
  } }, action: { actionId: 'PEA-' + 'a'.repeat(24), confirmation: { required: true } } };

async function ui(t, options = {}) {
  const review = await createLocalEvidenceReview(card, label, bytes, options);
  t.after(() => review.close());
  const response = await fetch(review.url);
  const html = await response.text();
  const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/u)?.[1];
  assert.ok(nonce);
  const post = (body, headers = {}) => fetch(`${review.url}decision`, { method: 'POST',
    headers: { origin: new URL(review.url).origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ nonce, confirmation: label, decision: 'confirm', ...body }).toString() });
  return { review, response, html, nonce, post };
}

test('review page escapes repository text, shows exact before/after and has no script or external resources', () => {
  const attacked = structuredClone(card); attacked.plan.preview.reason = '<script src="https://evil.test">execute()</script>';
  const html = evidenceReviewPage({ card: attacked, label, nonce: 'c'.repeat(64), imageType: 'image/png' });
  assert.doesNotMatch(html, /<script|onclick=|src="https:/u);
  assert.match(html, /&lt;script/); assert.match(html, /Before/); assert.match(html, /After/);
  assert.match(html, /not a visual pass or phase approval/); assert.match(html, /Plan authority: plan-reviewers/);
  assert.match(html, /Reviewer: reviewer@example.test/);
});

test('local review captures only exact confirmation; replay and cross-origin requests fail', async t => {
  const f = await ui(t);
  assert.match(f.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(f.response.headers.get('cache-control'), 'no-store');
  assert.equal((await f.post({}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.post({}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.post({ nonce: 'wrong' })).status, 403);
  assert.equal((await f.post({ confirmation: 'yes' })).status, 400);
  const image = await fetch(`${f.review.url}evidence`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal((await fetch(`${f.review.url}../../.git/config`)).status, 403);
  assert.equal((await f.post({})).status, 200);
  assert.equal(await f.review.decision, true);
  assert.equal((await f.post({})).status, 403);
});

test('cancel and expiry never confirm; non-raster evidence is not executable or served', async t => {
  const f = await ui(t);
  assert.equal((await f.post({ decision: 'cancel' })).status, 200);
  assert.equal(await f.review.decision, false);
  const expired = await createLocalEvidenceReview(card, label, bytes, { timeoutMs: 20 });
  t.after(() => expired.close());
  assert.equal(await expired.decision, false);
  const svg = await createLocalEvidenceReview(card, label, Buffer.from('<svg onload="execute()"/>'));
  t.after(() => svg.close());
  assert.doesNotMatch(await (await fetch(svg.url)).text(), /<img|<svg/u);
  assert.equal((await fetch(`${svg.url}evidence`)).status, 403);
});

test('unpresented page, wrong host and duplicate form fields cannot authorize', async t => {
  const review = await createLocalEvidenceReview(card, label, bytes); t.after(() => review.close());
  assert.equal((await fetch(`${review.url}decision`, { method: 'POST' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const sent = request(review.url, { headers: { host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    sent.on('error', reject); sent.end();
  });
  assert.equal(badHost, 403);
  const f = await ui(t);
  const result = await fetch(`${f.review.url}decision`, { method: 'POST',
    headers: { origin: new URL(f.review.url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['nonce', f.nonce], ['nonce', f.nonce], ['decision', 'confirm'], ['confirmation', label]]).toString() });
  assert.equal(result.status, 403);
  assert.equal((await f.post({})).status, 200); assert.equal(await f.review.decision, true);
});

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-browser-review-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [['init', '-q'], ['config', 'user.name', 'Browser Reviewer'], ['config', 'user.email', 'reviewer@example.test']]) {
    execFileSync('git', args, { cwd: root });
  }
  return root;
}

test('public issuer receipts and forged UI assurance cannot substitute for live presentation', async t => {
  const root = await repository(t);
  const grant = await issueActionAuthorization(root, card.plan, card.action, { confirmation: card.action.actionId, channel: 'local-evidence-review' });
  await assert.rejects(consumeActionAuthorization(root, grant.token, card.plan, card.action, { requireEvidencePresentation: true }),
    { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  await assert.rejects(captureEvidenceReviewAuthorization(root, card.plan, card.action, Buffer.from('wrong evidence')),
    { code: 'ACTION_LOCAL_REVIEW_UNAVAILABLE' });
});

/** Real local form + process-bound authorization; the test browser launcher only reports its URL. */
async function browserCeremony(t, { cancel = false, changedCard = false, changeActor = false } = {}) {
  const root = await repository(t);
  const browserBin = path.join(root, 'browser-bin'); await mkdir(browserBin);
  const urlPath = path.join(root, 'browser-url');
  await writeFile(path.join(browserBin, 'xdg-open'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(process.env.SF_TEST_BROWSER_URL,process.argv[2]);\n`, { mode: 0o700 });
  const source = `Object.defineProperty(process,'platform',{value:'linux'});
    const {captureEvidenceReviewAuthorization,consumeActionAuthorization}=await import(${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)});
    const card=${JSON.stringify(card)};const bytes=Buffer.from(${JSON.stringify(bytes.toString('hex'))},'hex');
    try { const grant=await captureEvidenceReviewAuthorization(${JSON.stringify(root)},card.plan,card.action,bytes);
      if(grant){${changedCard ? "card.plan.preview.reason='Different bytes';" : ''}
        await consumeActionAuthorization(${JSON.stringify(root)},grant.token,card.plan,card.action,{requireEvidencePresentation:true});
        try {await consumeActionAuthorization(${JSON.stringify(root)},grant.token,card.plan,card.action,{requireEvidencePresentation:true});throw Error('Replay accepted');}
        catch(error){if(error.code!=='ACTION_TERMINAL_PRESENTATION_REQUIRED')throw error;}}
      console.log(JSON.stringify({confirmed:!!grant,channel:grant?.channel}));
    }catch(error){console.log(JSON.stringify({code:error.code,message:error.message}));}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root,
    env: { ...process.env, PATH: `${browserBin}${path.delimiter}${process.env.PATH}`, SF_TEST_BROWSER_URL: urlPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = ''; let errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error(errors))); });
  let url;
  for (let attempt = 0; attempt < 500 && !url; attempt += 1) {
    try { url = await readFile(urlPath, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(url, errors);
  const html = await (await fetch(url)).text(); const nonce = html.match(/name="nonce" value="([a-f0-9]{64})"/u)[1];
  if (changeActor) execFileSync('git', ['config', 'user.email', 'other@example.test'], { cwd: root });
  await fetch(`${url}decision`, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, confirmation: label, decision: cancel ? 'cancel' : 'confirm' }).toString() });
  await closed; return JSON.parse(output);
}

test('browser ceremony creates one process-bound receipt; cancel, changed card and changed identity do not', async t => {
  assert.deepEqual(await browserCeremony(t), { confirmed: true, channel: 'local-evidence-review' });
  assert.deepEqual(await browserCeremony(t, { cancel: true }), { confirmed: false });
  assert.equal((await browserCeremony(t, { changedCard: true })).code, 'ACTION_TERMINAL_PRESENTATION_REQUIRED');
  assert.equal((await browserCeremony(t, { changeActor: true })).code, 'ACTION_LOCAL_REVIEW_UNAVAILABLE');
});
