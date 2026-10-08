/** Process-owned local review UI. No receipt, stdin answer or caller boolean grants consent. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SingularityFlowError } from './util.mjs';
import { resolveWindowsSystemTool } from './platform-process.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/gu,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const problem = message => new SingularityFlowError(message, { code: 'ACTION_LOCAL_REVIEW_UNAVAILABLE' });

export function evidenceReviewPage({ card, label, nonce, imageType }) {
  const preview = card.plan.preview;
  const json = value => escape(JSON.stringify(value, null, 2));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Review evidence correction · Singularity Flow</title><style nonce="${nonce}">
  :root{color-scheme:light dark;font:15px system-ui;background:Canvas;color:CanvasText}body{max-width:1000px;margin:32px auto;padding:0 24px}
  h1{font-size:24px;font-weight:600}h2{font-size:17px;font-weight:600}p{line-height:1.6}code,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:12px;padding:16px;background:color-mix(in srgb,CanvasText 5%,Canvas);border-radius:8px}
  .contracts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}img{max-width:100%;max-height:440px;object-fit:contain;border:1px solid GrayText;border-radius:8px}
  form{position:sticky;bottom:0;background:Canvas;border-top:1px solid GrayText;padding:16px 0}input{display:block;width:min(100%,520px);box-sizing:border-box;margin:8px 0;padding:9px}button{padding:9px 14px;margin:0 8px 0 0;cursor:pointer}details{margin:16px 0}
  </style></head><body><h1>Review evidence correction</h1>
  <p>${escape(preview.workId)} · ${escape(preview.phaseId)} · ${escape(preview.clauseId)}<br>
  Plan authority: ${escape(preview.authorityGroups.join(', '))}<br>Reviewer: ${escape(card.plan.reviewer)}</p>
  <p>This records an evidence <b>classification correction</b>, not a visual pass or phase approval. Tests and source-bound visual/inspection proof remain required. Approved artifacts and the current draft are preserved.</p>
  <h2>Retained file</h2><p><code>${escape(preview.path)}</code><br>SHA-256: <code>${escape(preview.reviewedFile.sha256)}</code> · ${escape(preview.reviewedFile.size)} bytes</p>
  ${imageType ? '<a href="evidence" target="_blank" rel="noopener"><img src="evidence" alt="Exact retained evidence bytes"></a><p>Select the image to inspect its captured full-size bytes.</p>' : '<p>This file cannot be previewed as a safe raster image. Inspect the retained file in your editor before confirming its classification.</p>'}
  <p>Reason: ${escape(preview.reason)}</p><div class="contracts"><section><h2>Before</h2><pre>${json({ claim: preview.previousClaim, contract: preview.previousContract })}</pre></section>
  <section><h2>After</h2><pre>${json({ claim: preview.proposedClaim, contract: preview.proposedContract })}</pre></section></div>
  <details><summary>Exact review binding and complete packet</summary><pre>${json(card)}</pre></details>
  <form method="post" action="decision"><input type="hidden" name="nonce" value="${nonce}">
  <label for="confirmation">After reviewing, type <code>${escape(label)}</code></label><input id="confirmation" name="confirmation" autocomplete="off" required>
  <button name="decision" value="cancel" formnovalidate>Cancel</button><button name="decision" value="confirm">Record correction</button></form></body></html>`;
}

/** A bounded, same-origin, one-shot browser ceremony, independently owned by this CLI process. */
export async function createLocalEvidenceReview(card, label, bytes, { timeoutMs = 15 * 60 * 1000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15 * 60 * 1000) throw problem('Invalid local review lifetime.');
  const secret = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  // Never execute SVG/HTML or serve arbitrary repository paths. Only captured raster bytes.
  const imageType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  let resolveDecision;
  let finished = false;
  let presented = false;
  let origin;
  const decision = new Promise(resolve => { resolveDecision = resolve; });
  const finish = confirmed => { if (!finished) { finished = true; resolveDecision(confirmed); } };
  const server = createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` };
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { ...headers, 'Content-Type': type }); response.end(body);
    };
    if (request.headers.host !== new URL(origin).host || finished) return send(403, 'This review is closed or invalid.');
    if (request.method === 'GET' && request.url === `/${secret}/`) {
      presented = true; return send(200, evidenceReviewPage({ card, label, nonce, imageType }), 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && request.url === `/${secret}/evidence` && presented && imageType) return send(200, bytes, imageType);
    if (request.method !== 'POST' || request.url !== `/${secret}/decision` || !presented
        || request.headers.origin !== origin || request.headers['content-type'] !== 'application/x-www-form-urlencoded'
        || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(403, 'Review the exact local page first.');
    let body = '';
    try {
      for await (const chunk of request) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 4096) return send(413, 'Review response is too large.');
      }
      if (finished) return send(403, 'This review expired or was already consumed.');
      const values = new URLSearchParams(body);
      if (values.getAll('nonce').length !== 1 || values.get('nonce') !== nonce
          || values.getAll('decision').length !== 1) return send(403, 'Invalid review response.');
      if (values.get('decision') === 'cancel') { send(200, 'Cancelled. Nothing was accepted. You may close this page.'); finish(false); return; }
      if (values.get('decision') !== 'confirm' || values.getAll('confirmation').length !== 1
          || values.get('confirmation').trim() !== label) return send(400, 'Confirmation did not match. Go back and review again, or cancel.');
      send(200, 'Review received. Check Singularity Flow for the revalidated result; this page does not claim publication success. You may close it.'); finish(true);
    } catch { send(400, 'Incomplete review response. Nothing was accepted.'); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish(false), timeoutMs);
  const close = () => { clearTimeout(timer); finish(false); server.close(); server.closeAllConnections(); };
  return { url: `${origin}/${secret}/`, decision, close };
}

function openBrowser(url) {
  // Fixed argument vectors, never a shell command or repository-provided executable.
  const executable = process.platform === 'darwin' ? '/usr/bin/open'
    : process.platform === 'win32' ? resolveWindowsSystemTool(process.env, 'rundll32.exe') : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', shell: false, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(problem('The browser did not open. Use the terminal review route; nothing was accepted.')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(problem('A local browser is unavailable. Use the terminal review route; nothing was accepted.')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(problem('Could not open local review. Use the terminal review route; nothing was accepted.')); });
  });
}

export async function presentLocalEvidenceReview(card, label, bytes) {
  const review = await createLocalEvidenceReview(card, label, bytes);
  try {
    await openBrowser(review.url);
    process.stderr.write('Evidence review opened in your local browser. Review and confirm there, or Cancel. No decision has been recorded yet.\n');
    return await review.decision;
  } finally { review.close(); }
}
