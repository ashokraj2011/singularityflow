/** Lazy ARA host-bound static preview and deterministic result renderer. Never loaded by hot reads. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, readFile, lstat, chmod, rm } from 'node:fs/promises';
import { applicationReviewSnapshot, bytesDigest, reviewLocalRoot, localCheckoutIdentity } from './application-review-read.mjs';
import { araFail, reviewDigest, reviewReportPages } from './application-review-contract.mjs';
import { escapeReviewHtml } from './application-review-human.mjs';
import { gateTestEnvironmentModule } from './test-runtime.mjs';
import { writeAtomicExclusive, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { redactionEntries, redactText } from './output-redaction.mjs';

export const ARA_BROWSER_VERSION = '1.64.1';

/** A stuck frame/font cannot hold a human action or its capture operation indefinitely. */
export async function evaluateReviewPage(page, script, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([page.evaluate(script), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new SingularityFlowError('The inspected browser frame did not answer before its deadline. Close the unsupported dialog or restart the verified preview; confirmation and evidence are preserved.', { code: 'ARA_TARGET_UNVERIFIED' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function reviewBrowser({ headless = true, timeoutMs = 30000 } = {}) {
  const { chromium } = await import('playwright-core');
  try { return await chromium.launch({ headless, timeout: timeoutMs }); }
  catch (error) { araFail('ARA_CAPTURE_UNAVAILABLE', 'The pinned review browser could not start. Run singularity-flow app-review browser install, then resume this review; no application or Story was recreated.', { cause: error.message }); }
}

/** Real report data only, escaped and network-free; result records remain the verdict source. */
export function applicationResultHtml(page, target) {
  const e = escapeReviewHtml;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Retained test results</title>
    <style>body{font:16px system-ui;margin:32px;color:#122332;background:#fff}h1{font-size:24px}p,td,th{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{padding:10px 12px;border:1px solid #c5ced7;text-align:left;font-size:14px}.meta{font-size:12px;color:#506171}.failed,.errored,.timed-out{color:#ac1624}.passed{color:#176034}</style>
    <h1>Actual retained test results</h1><p class="meta">Source ${e(target.snapshot.digest)} · Review ${e(target.id)} · Packet ${e(target.results.packet)}</p>
    ${page.summary ? `<h2>Attempt summary</h2>${page.summary.map(item => `<p><strong class="${e(item.status)}">${e(item.status)}</strong> ${e(item.commandId)} · ${e(item.attemptId)}</p><p>${e(item.startedAt)} → ${e(item.completedAt)}</p><p>${item.tests ? `${e(item.tests.discovered)} discovered, ${e(item.tests.passed)} passed, ${e(item.tests.failed)} failed, ${e(item.tests.skipped)} skipped` : 'No retained case counts'} · ${e(item.reportedCases)} actual case records</p>`).join('')}` : ''}
    ${page.cases.length ? `<table><thead><tr><th>Command / suite</th><th>Actual case</th><th>Outcome</th><th>Duration</th></tr></thead><tbody>${page.cases.map(item => `<tr><td>${e(item.commandId)}<br>${e(Array.isArray(item.suite) ? item.suite.join(' / ') : item.suite)}</td><td>${e(item.name)}</td><td class="${e(item.outcome)}">${e(item.outcome)}</td><td>${e(item.durationMs ?? 'unknown')}</td></tr>`).join('')}</tbody></table>` : '<p>No executed case records on this page. Nothing is inferred as passed.</p>'}
    ${page.kind === 'test-case-detail' ? page.cases.map(item => `<h2>Retained failure detail</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${e(item.detail ?? 'Safe retained detail is unavailable for this case. Its actual outcome above is unchanged; no response or assertion was invented.')}</pre>`).join('') : ''}
    <p class="meta">Read-only rendering of retained execution records. This is a test report, not the backend application or a new test run.</p></html>`;
}

async function outputFiles(directory, relative = '', state = { bytes: 0, files: new Map() }) {
  for (const name of await readdir(path.join(directory, relative))) {
    const file = path.posix.join(relative, name);
    const info = await lstat(path.join(directory, file));
    if (info.isSymbolicLink()) araFail('ARA_BUILD_UNSUPPORTED', 'The static preview cannot serve symbolic links.');
    if (info.isDirectory()) await outputFiles(directory, file, state);
    else if (info.isFile()) {
      if (state.files.size >= 10000 || info.size > 32 * 1024 * 1024 || state.bytes + info.size > 128 * 1024 * 1024) araFail('ARA_BUILD_INCOMPLETE', 'Static build exceeds its supported file or byte bound.');
      const bytes = await readFile(path.join(directory, file));
      state.bytes += bytes.length; state.files.set(file, bytes);
    }
  }
  return state.files;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

/** Serve immutable output buffers on an owned random loopback port. No HMR, arbitrary paths or proxy. */
export async function serveReviewBuild(files) {
  if (!files.has('index.html')) araFail('ARA_BUILD_FAILED', 'The approved static output has no index.html. No substitute server was guessed.');
  const instance = randomUUID();
  let origin;
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(403); response.end(); return; }
    let requested;
    try { requested = decodeURIComponent(new URL(request.url, origin).pathname).slice(1) || 'index.html'; } catch { response.writeHead(400); response.end(); return; }
    if (requested.split('/').some(part => part === '..' || part === '.') || /[\\\x00]/u.test(requested)) { response.writeHead(403); response.end(); return; }
    const bytes = files.get(requested);
    if (!bytes) { response.writeHead(404); response.end('Not in the verified static build.'); return; }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(requested)] ?? 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-SFlow-Review-Instance': instance });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const manifest = [...files].map(([file, bytes]) => ({ path: file, sha256: bytesDigest(bytes), bytes: bytes.length })).sort((a, b) => a.path.localeCompare(b.path));
  return { origin, instance, manifest, digest: reviewDigest(manifest), close: () => { server.close(); server.closeAllConnections(); } };
}

/** Build only declared before-launch steps, from checked source copies; never run ambient dev/HMR. */
export async function prepareStaticReview(root, config, workflow, session, { headless = false } = {}) {
  const policy = session.policy;
  if (!policy.preview) araFail('ARA_APP_SETUP_REQUIRED', 'Adopt a static output directory and declared application entry before starting a verified web preview.');
  const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
  const context = await resolveCapabilityApplication(root, { capabilityId: workflow.resolution?.capability?.id ?? null });
  const { selectStartEntry, applicationCommandSha256 } = await import('./application-run.mjs');
  const entry = selectStartEntry(context, policy.preview.entry);
  if (entry.dependsOn?.length || entry.environments?.length) araFail('ARA_RUNTIME_PROFILE_UNSUPPORTED', 'This static adapter does not yet bind external/backend dependencies or secret environments. Use a qualified adapter; observations remain available.');
  const { resolveStartCommand } = await import('./run-configurations.mjs');
  const command = resolveStartCommand(entry);
  if (Object.keys(command.appendEnv ?? {}).length) araFail('ARA_RUNTIME_PROFILE_UNSUPPORTED', 'Inherited environment appends require a qualified runtime adapter.');
  const snapshot = await applicationReviewSnapshot(root, config, workflow, { retainBytes: true });
  const materialization = path.join(reviewLocalRoot(root), 'materializations', randomUUID());
  await mkdir(materialization, { recursive: true, mode: 0o700 });
  for (const item of snapshot.manifest) {
    const target = path.join(materialization, item.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomicExclusive(target, snapshot.contents.get(item.path));
    if (item.executable && process.platform !== 'win32') await chmod(target, 0o700);
  }
  const { runQualityCommand, withoutHostSurfaceVariables } = await import('./quality-command-runner.mjs');
  for (const step of command.beforeLaunch ?? []) {
    const cwd = (await secureRepositoryPath(materialization, step.workingDirectory ?? entry.workingDirectory ?? '.', { label: 'Review build directory', mustExist: true, type: 'directory' })).absolute;
    const { environment: buildEnvironment } = await (await gateTestEnvironmentModule()).withProjectNodeVersion(withoutHostSurfaceVariables(process.env), { cwd, root: materialization });
    const result = await runQualityCommand(step.argv[0], step.argv.slice(1), { cwd, env: { ...buildEnvironment, ...command.env }, timeoutMs: step.timeoutMs,
      maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0 && result.exitCode !== 0) {
      const entries = redactionEntries(Object.entries({ ...process.env, ...command.env }).filter(([name]) => /secret|password|token|api.?key/iu.test(name)).map(([name, value]) => ({ name, value })));
      const diagnostic = redactDiagnosticText(redactText(result.stderr || result.stdout || result.error?.message || 'No process output was returned.', entries), { multiline: true }).slice(-2000);
      araFail('ARA_BUILD_FAILED', `The declared preview build failed (exit ${result.exitCode ?? result.status ?? 'unavailable'}). ${diagnostic} Its owned snapshot is retained for recovery; no replacement command ran.`,
        { exitCode: result.exitCode ?? result.status, signal: result.signal ?? null, timedOut: result.timedOut ?? false });
    }
  }
  if ((await applicationReviewSnapshot(root, config, workflow)).digest !== snapshot.digest) araFail('ARA_REVIEW_STALE', 'Source changed while the preview was being built.');
  const output = await secureRepositoryPath(materialization, policy.preview.outputDirectory, { label: 'Static preview output', mustExist: true, type: 'directory' });
  const files = await outputFiles(output.absolute);
  const served = await serveReviewBuild(files);
  // Check each served byte against its built manifest, in addition to the owned instance identity.
  for (const item of served.manifest) {
    const result = await fetch(`${served.origin}/${item.path.split('/').map(encodeURIComponent).join('/')}`);
    if (result.headers.get('x-sflow-review-instance') !== served.instance || bytesDigest(Buffer.from(await result.arrayBuffer())) !== item.sha256) {
      served.close(); araFail('ARA_TARGET_UNVERIFIED', 'The served build does not match its manifest.');
    }
  }
  let browser;
  try {
    browser = await reviewBrowser({ headless });
    const browserContext = await browser.newContext({ viewport: policy.capture.viewport, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, serviceWorkers: 'block' });
    const blockedOrigins = new Set();
    await browserContext.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === served.origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      blockedOrigins.add(url.origin); return route.abort();
    });
    await browserContext.routeWebSocket('**/*', socket => { blockedOrigins.add(new URL(socket.url()).origin); socket.close(); });
    const page = await browserContext.newPage();
    page.on('dialog', async dialog => { blockedOrigins.add(`unsupported-dialog:${dialog.type()}`); await dialog.dismiss().catch(() => {}); });
    await page.goto(served.origin, { waitUntil: 'networkidle', timeout: 30000 });
    await evaluateReviewPage(page, () => document.fonts.ready);
    return { page, browser, served, blockedOrigins,
      binding: { adapter: 'static-web', checkout: localCheckoutIdentity(root), instance: served.instance, origin: served.origin,
        buildManifest: served.manifest, buildDigest: served.digest, sourceDigest: snapshot.digest, commandDigest: applicationCommandSha256(context, entry),
        toolchain: { node: process.versions.node, platform: process.platform, architecture: process.arch, playwright: ARA_BROWSER_VERSION, chromium: browser.version() },
        profile: { viewport: policy.capture.viewport, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, serviceWorkers: 'blocked', externalServices: 'unsupported' } },
      close: async () => { await browser.close(); served.close(); await rm(materialization, { recursive: true, force: true }); } };
  } catch (error) { await browser?.close(); served.close(); throw error; }
}

export async function reviewedPageFingerprint(preview) {
  if (!preview || preview.page.isClosed() || preview.blockedOrigins.size || preview.page.context().pages().filter(page => !page.isClosed()).length !== 1) {
    araFail('ARA_TARGET_UNVERIFIED', 'This static adapter needs its one inspected page, with no unbound runtime channel or native dialog. Close extra tabs or use a qualified adapter.');
  }
  if (new URL(preview.page.url()).origin !== preview.served.origin) araFail('ARA_REVIEW_STALE', 'The browser no longer shows this verified application.');
  return reviewDigest(await evaluateReviewPage(preview.page, () => {
    const copy = document.documentElement.cloneNode(true);
    // Playwright temporarily hides the caret and can leave an empty style attribute behind.
    // Empty attributes have no presentation effect; substantive styles remain in the binding.
    for (const element of copy.querySelectorAll('[style]')) if (!element.getAttribute('style').trim()) element.removeAttribute('style');
    const html = copy.outerHTML; const body = document.body?.innerText ?? '';
    const fields = [...document.querySelectorAll('input,textarea,select')];
    if (html.length > 4194304 || body.length > 4194304 || fields.length > 10000) throw new Error('The inspected page exceeds the supported observation bound.');
    const values = fields.map(element => ({ value: element.value, checked: element.checked }));
    if (JSON.stringify(values).length > 4194304) throw new Error('The inspected form state exceeds the supported observation bound.');
    return { url: location.href, body, html, values, scroll: [scrollX, scrollY] };
  }));
}

async function retainImage(root, bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) araFail('ARA_CAPTURE_FAILED', 'The browser did not return a PNG image.');
  const sha256 = bytesDigest(bytes);
  const target = path.join(reviewLocalRoot(root), 'artifacts', `${sha256.slice(7)}.png`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { await writeAtomicExclusive(target, bytes, { mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || bytesDigest(await readFile(target)) !== sha256) throw error; }
  return { sha256, bytes: bytes.length, artifactRef: { kind: 'local-application-review-image', digest: sha256 }, checkout: localCheckoutIdentity(root) };
}

export async function captureApplicationReview(root, view, policy, preview = null) {
  if (!view.confirmation) araFail('ARA_HUMAN_ACTION_REQUIRED', 'Final screenshots start only after a valid All good action.');
  const plan = view.confirmation.capturePlan;
  const results = reviewReportPages(view.target.results, policy.capture);
  if (!results.complete) araFail('ARA_CAPTURE_INCOMPLETE', 'The report capture would omit cases or pages. Increase the adopted finite limit or supply complete structured results.', { missingCases: results.missingCases, omittedPages: results.omittedPages });
  const receipts = [];
  const deadline = Date.now() + policy.capture.timeoutMs;
  const remaining = () => {
    if (Date.now() >= deadline) araFail('ARA_CAPTURE_FAILED', 'The automatic capture operation reached its finite deadline. Confirmation is retained.');
    return deadline - Date.now();
  };
  let totalBytes = 0;
  const retain = async (bytes, kind, item, dimensions, browserVersion) => {
    if ((totalBytes += bytes.length) > policy.capture.maximumBytes) araFail('ARA_CAPTURE_INCOMPLETE', 'The confirmed capture set exceeded its byte bound; no partial acceptance was recorded.');
    const image = await retainImage(root, bytes);
    const receipt = { schemaVersion: 1, kind: 'application-review-capture', confirmation: view.confirmation.id, trigger: view.confirmation.hostAction.id,
      targetId: view.target.id, subject: view.subject, sourceSnapshot: view.target.snapshot.digest, resultsDigest: view.target.results.digest,
      captureKind: kind, captureItem: item.id, cases: item.cases?.map(row => row.id) ?? [], attempts: view.target.results.attempts.map(attempt => attempt.attemptId),
      obligations: view.confirmation.coverage, capturedAt: new Date().toISOString(), browser: { provider: 'playwright-chromium', version: browserVersion, adapterVersion: ARA_BROWSER_VERSION },
      image: { format: 'png', type: kind === 'application-ui' ? 'viewport' : 'full-page', ...dimensions }, ...image, status: 'captured' };
    receipts.push({ ...receipt, id: reviewDigest(receipt) });
  };
  if (plan.applicationUi) {
    if (!preview || reviewDigest(preview.binding) !== reviewDigest(view.target.binding)
        || plan.pageFingerprint !== await reviewedPageFingerprint(preview)) araFail('ARA_REVIEW_STALE', 'The confirmed live screen or browser instance is no longer available. Reinspect it; no journey was replayed.');
    await evaluateReviewPage(preview.page, () => document.fonts.ready, Math.min(10000, remaining()));
    await retain(await preview.page.screenshot({ type: 'png', animations: 'disabled', timeout: remaining() }), 'application-ui', { id: 'reviewed-current-page' }, policy.capture.viewport, preview.browser.version());
    if (plan.pageFingerprint !== await reviewedPageFingerprint(preview)) araFail('ARA_REVIEW_STALE', 'The application state changed during capture.');
  }
  const browser = await reviewBrowser({ timeoutMs: remaining() });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    for (const item of results.pages) {
      page.setDefaultTimeout(remaining());
      await page.setContent(applicationResultHtml(item, view.target), { waitUntil: 'load', timeout: remaining() });
      await evaluateReviewPage(page, () => document.fonts.ready, Math.min(10000, remaining()));
      const height = await evaluateReviewPage(page, () => document.documentElement.scrollHeight, Math.min(10000, remaining()));
      if (height > 16000) araFail('ARA_CAPTURE_INCOMPLETE', 'A report page would be unreadable at the image bound. Reduce the adopted cases-per-page limit.');
      await retain(await page.screenshot({ type: 'png', fullPage: true, timeout: remaining() }), item.kind, item, { width: 1280, height }, browser.version());
    }
  } finally { await browser.close(); }
  return receipts;
}
