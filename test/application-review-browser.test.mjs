/** Native browser qualification against disposable static source; no real application is touched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareStaticReview, reviewedPageFingerprint, captureApplicationReview } from '../src/application-review-preview.mjs';
import { applicationReviewSnapshot, reviewEvidenceAvailable, localCheckoutIdentity } from '../src/application-review-read.mjs';
import { normalizeApplicationReview, reviewApplicability, reviewDigest, reviewReportPages, validateReviewCaptureSet } from '../src/application-review-contract.mjs';

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Save a value</title><h1>Value editor</h1><label>Value <input id="value"></label><button id="save">Save</button><p id="result"></p><script>
const input=document.querySelector('#value');input.value=localStorage.getItem('review-value')||'';
document.querySelector('#save').onclick=()=>{localStorage.setItem('review-value',input.value);document.querySelector('#result').textContent='Saved '+input.value;};
</script></html>`;

test('static adapter builds the checked snapshot and captures the actual inspected browser state without replay', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ara-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']);
  await mkdir(path.join(root, 'singularity'));
  await mkdir(path.join(root, 'ui'));
  await writeFile(path.join(root, 'ui/index.src'), html);
  await writeFile(path.join(root, 'build.mjs'), "import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';mkdirSync('site',{recursive:true});writeFileSync('site/index.html',readFileSync('ui/index.src'));\n");
  const entry = { id: 'web', argv: ['node', 'unused-start.mjs'], workingDirectory: '.', url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 5000 },
    beforeLaunch: [{ argv: ['node', 'build.mjs'], workingDirectory: '.', timeoutMs: 10000 }] };
  await writeFile(path.join(root, 'singularity/capabilities.yml'), JSON.stringify({ version: 1, capabilities: { web: { kind: 'delivery', repository: 'web', application: { start: [entry] } } } }));
  git(['add', '.']); git(['-c', 'user.name=Review Tester', '-c', 'user.email=review@example.invalid', 'commit', '-qm', 'Static review fixture']);
  const policy = normalizeApplicationReview({ mode: 'required', surface: 'web', preview: { entry: 'web', outputDirectory: 'site' } });
  const subject = { kind: 'story-phase', workId: 'web-review', phaseId: 'deliver', generation: 1 };
  const workflow = { workItem: { id: subject.workId }, resolution: { capability: { id: 'web' } } };
  const snapshot = await applicationReviewSnapshot(root, {}, workflow);
  const preview = await prepareStaticReview(root, {}, workflow, { policy }, { headless: true });
  t.after(() => preview.close());
  assert.equal(preview.binding.sourceDigest, snapshot.digest);
  assert.equal(preview.binding.adapter, 'static-web');
  assert.equal(preview.binding.checkout, localCheckoutIdentity(root));
  assert.equal(preview.binding.buildManifest.length, 1);
  await preview.page.locator('#value').fill('Retained value');
  await preview.page.locator('#save').click();
  await preview.page.reload({ waitUntil: 'networkidle' });
  assert.equal(await preview.page.locator('#value').inputValue(), 'Retained value');
  const results = { packet: 'retained-packet', digest: 'retained-results', attempts: [{ attemptId: 'attempt-1', commandId: 'save-regression', status: 'passed',
    tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 }, occurrences: [{ name: 'Save persists after reload', outcome: 'passed' }] }] };
  const target = { id: 'current-static-target', subject, snapshot: { digest: snapshot.digest }, binding: preview.binding, results, applicability: reviewApplicability(policy, ['src/editor.html']) };
  const report = reviewReportPages(results, policy.capture);
  const view = { subject, target, confirmation: { id: 'actual-fixture-confirmation', at: new Date().toISOString(), hostAction: { id: 'actual-fixture-click' },
    coverage: ['save-journey'], capturePlan: { applicationUi: true, pageFingerprint: await reviewedPageFingerprint(preview), reportDigest: reviewDigest(report) } } };
  const captures = await captureApplicationReview(root, view, policy, preview);
  assert.equal(captures[0].captureKind, 'application-ui');
  assert.equal(await preview.page.locator('#value').inputValue(), 'Retained value', 'Capture must not recreate or reset the inspected page.');
  assert.equal(await reviewEvidenceAvailable(root, captures), true);
  assert.equal(validateReviewCaptureSet(view, captures, policy), captures);
  assert.throws(() => validateReviewCaptureSet(view, captures.slice(1), policy), { code: 'ARA_CAPTURE_INCOMPLETE' });
  await preview.page.locator('#value').fill('Changed after confirmation');
  await assert.rejects(captureApplicationReview(root, view, policy, preview), { code: 'ARA_REVIEW_STALE' });
  const extra = await preview.page.context().newPage();
  await assert.rejects(reviewedPageFingerprint(preview), { code: 'ARA_TARGET_UNVERIFIED' });
  await extra.close();
  await preview.page.evaluate(origin => { const socket = new WebSocket(origin.replace(/^http/u, 'ws')); socket.onerror = () => {}; }, preview.served.origin);
  for (let count = 0; count < 20 && !preview.blockedOrigins.size; count += 1) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(preview.blockedOrigins.size, 'An unbound socket cannot silently escape the static runtime profile.');
  await assert.rejects(reviewedPageFingerprint(preview), { code: 'ARA_TARGET_UNVERIFIED' });
});
