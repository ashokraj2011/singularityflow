/** Live local-host consent, following the existing local-evidence-review boundary. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { araFail, reviewDigest } from './application-review-contract.mjs';

const actions = new WeakMap();
export function consumeReviewHumanAction(handle, expected) {
  const actual = actions.get(handle); actions.delete(handle);
  if (!actual || reviewDigest(actual) !== reviewDigest({ ...expected, root: path.resolve(expected.root) })) {
    araFail('ARA_HUMAN_ACTION_REQUIRED', 'Acceptance and rechecks require the actual current local review action, not text supplied by a model.');
  }
}

/** The secret route and form nonce go only to the person's browser, never to a Copilot result. */
export async function createApplicationReviewHumanServer({ root, sessionId, read, render, perform, renderReport = null, renderImage = null, identity = null, timeoutMs = 2 * 60 * 60 * 1000 }) {
  const secret = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  let origin;
  let closed = false;
  const cards = new Map();
  let issuedImages = new Set();
  const server = createServer(async (request, response) => {
    let responseCard = null;
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      if (responseCard) { responseCard.completed = { status, body, type }; responseCard.pending = false; }
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(body);
    };
    if (closed || request.headers.host !== new URL(origin).host) return send(403, 'Review unavailable.');
    try {
      if (request.method === 'GET' && request.url === `/${secret}/`) {
        const view = await read();
        issuedImages = new Set((view.captures ?? []).filter(item => item.status === 'captured').map(item => item.sha256?.slice(7)).filter(Boolean));
        const actionId = randomUUID();
        cards.set(actionId, { revision: view.revision, targetId: view.target?.id ?? null });
        if (cards.size > 100) cards.delete(cards.keys().next().value);
        return send(200, render(view, { nonce, actionId, route: `/${secret}/action`, resultsRoute: `/${secret}/results?page=0`, evidenceRoute: `/${secret}/evidence/` }));
      }
      const requested = new URL(request.url, origin);
      if (identity && request.method === 'GET' && requested.pathname === `/${secret}/identity`) {
        const challenge = requested.searchParams.get('challenge');
        if (!/^[a-f0-9]{32}$/u.test(challenge ?? '')) return send(400, 'A fresh host challenge is required.');
        return send(200, JSON.stringify({ ...identity, challenge }), 'application/json');
      }
      if (request.method === 'GET' && requested.pathname.startsWith(`/${secret}/evidence/`) && renderImage) {
        const digest = requested.pathname.slice(`/${secret}/evidence/`.length);
        if (!/^[a-f0-9]{64}$/u.test(digest) || !issuedImages.has(digest)) return send(404, 'No such admitted review image.');
        return send(200, await renderImage(digest), 'image/png');
      }
      if (request.method === 'GET' && requested.pathname === `/${secret}/results` && renderReport) {
        const index = Number(requested.searchParams.get('page') ?? '0');
        if (!Number.isSafeInteger(index) || index < 0 || index > 500) return send(400, 'Choose an available result page.');
        const report = await renderReport(await read(), index);
        const nav = `<nav><a href="/${secret}/">Return to review</a> · Page ${index + 1} of ${report.pages}${index > 0 ? ` · <a href="/${secret}/results?page=${index - 1}">Previous</a>` : ''}${index + 1 < report.pages ? ` · <a href="/${secret}/results?page=${index + 1}">Next</a>` : ''}</nav>`;
        return send(200, report.html.replace('<h1>', `${nav}<h1>`));
      }
      if (request.method !== 'POST' || request.url !== `/${secret}/action` || request.headers.origin !== origin
          || request.headers['content-type'] !== 'application/x-www-form-urlencoded'
          || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(403, 'Open the current review page first.');
      let text = '';
      for await (const chunk of request) {
        text += chunk.toString('utf8');
        if (Buffer.byteLength(text) > 40000) return send(413, 'Feedback is too large; preserve it and shorten this observation.');
      }
      const values = new URLSearchParams(text);
      if (values.getAll('nonce').length !== 1 || values.get('nonce') !== nonce || values.getAll('actionId').length !== 1) return send(403, 'Invalid review action.');
      const actionId = values.get('actionId');
      const card = cards.get(actionId);
      if (!card) return send(409, 'This review card expired. Refresh it; keep any unsaved feedback.');
      const requestDigest = reviewDigest([...values.entries()]);
      if (card.requestDigest && card.requestDigest !== requestDigest) return send(409, 'This action already refers to different input. Keep your observation and open a fresh review card.');
      if (card.completed) return send(card.completed.status, card.completed.body, card.completed.type);
      if (card.pending) return send(409, 'This exact action is still running. Its state is retained; wait for its result instead of submitting another action.');
      const view = await read();
      const action = values.get('action');
      const isFeedback = ['report-only', 'report-and-fix'].includes(action);
      if (!isFeedback && (view.revision !== card.revision || view.target?.id !== card.targetId)) return send(409, 'The review changed. Preserve your feedback and refresh before acting.');
      const revision = isFeedback ? view.revision : card.revision;
      const input = { action, observed: values.get('observed') ?? '', expected: values.get('expected') ?? '',
        findingId: values.get('findingId'), result: values.get('result'), reason: values.get('reason') ?? '',
        coverage: values.getAll('coverage'), dimensions: values.getAll('dimension'), duplicateOf: values.get('duplicateOf'), targetId: card.targetId };
      const handle = Object.freeze({});
      const actionType = action === 'accept' ? 'review-confirmed' : action === 'recheck' ? 'finding-rechecked'
        : action === 'request-repair' ? 'finding-repair-requested' : ['dismiss', 'duplicate'].includes(action) ? 'finding-dispositioned' : ['report-only', 'report-and-fix'].includes(action) ? 'feedback-recorded' : action;
      // The server owns this event and the parsed native form. There is no CLI flag that mints it.
      const grant = (payload) => {
        actions.set(handle, { root: path.resolve(root), sessionId, revision, action: actionType, inputDigest: reviewDigest(payload) });
        return handle;
      };
      card.requestDigest = requestDigest; card.pending = true; responseCard = card;
      const result = await perform({ actionId, expectedRevision: revision, input, grant });
      const label = result?.message ?? 'Action recorded. The next view reports the observed state.';
      return send(200, `<html><meta charset="utf-8"><title>Application review</title><p>${escapeReviewHtml(label)}</p><a href="/${secret}/">Continue review</a></html>`);
    } catch (error) {
      return send(409, `<html><meta charset="utf-8"><title>Review needs attention</title><h1>${escapeReviewHtml(error.code ?? 'Review failed')}</h1><p>${escapeReviewHtml(error.message)}</p><p>Your work is preserved. If confirmation was recorded, retry capture without confirming again.</p><a href="/${secret}/">Read current review</a></html>`);
    }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  let timer;
  const close = () => { closed = true; clearTimeout(timer); server.close(); server.closeAllConnections(); };
  timer = setTimeout(close, timeoutMs); timer.unref();
  return { url: `${origin}/${secret}/`, close, origin };
}

export const escapeReviewHtml = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function applicationReviewPage(view, form) {
  const e = escapeReviewHtml;
  const fields = `<input type="hidden" name="nonce" value="${e(form.nonce)}"><input type="hidden" name="actionId" value="${e(form.actionId)}">`;
  const button = (action, label) => `<form method="post" action="${e(form.route)}">${fields}<button name="action" value="${e(action)}">${e(label)}</button></form>`;
  const report = view.target?.results?.attempts ?? [];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Application review</title>
    <style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;background:#10181f;color:#e7edf3}section{background:#19242f;border:1px solid #344758;border-radius:12px;margin:20px 0;padding:24px}button{padding:12px 18px;background:#88bfa9;border:0;border-radius:6px;color:#101820;cursor:pointer}textarea{display:block;width:95%;min-height:75px;margin:12px 0;padding:12px;background:#10181f;color:#fff;border:1px solid #60788c;border-radius:6px}label{display:block;margin:12px 0}small{color:#a9bac9}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:10px;border-bottom:1px solid #344758}code{overflow-wrap:anywhere}a{color:#a8d3ef}</style>
    <h1>Review your application</h1><p>${e(view.subject.workId)} · ${e(view.state)} · <small>Phase approval: ${e(view.phaseApproval)}</small></p>
    ${view.state === 'stale' ? '<p role="status">The delivery, references, results or local runtime binding changed. Refresh delivery and results, then inspect this laptop’s current target. Earlier reviews remain historical.</p>' : ''}
    <section><h2>Try this delivery</h2><p>${e(view.target?.applicability?.surface)} · ${e(view.target?.assurance)}</p>
    <p>Review the declared journeys and explore beyond them. Acceptance applies to this delivery and its results.</p>
    ${(view.target?.changedSurfaces ?? []).length ? `<details><summary>Changed application paths (${view.target.changedSurfaces.length})</summary><ul>${view.target.changedSurfaces.map(file => `<li><code>${e(file)}</code></li>`).join('')}</ul></details>` : ''}
    ${(view.target?.references ?? []).length ? `<h3>Reference materials</h3><p>Use the attached originals in this Story’s documents when comparing the result.</p><ul>${view.target.references.map(reference => `<li>${e(reference.name)} · ${e(reference.id)} · ${e(reference.mimeType)}</li>`).join('')}</ul>` : '<p>No attached reference material was declared. No expected screenshot was invented.</p>'}
    ${view.documents?.status === 'upload-required' ? `<p role="alert">Required original documents are missing on this laptop. Restore the existing document IDs, then resume this review.</p><ul>${view.documents.missing.map(item => `<li>${e(item.name)}: <code>${e(item.commandGuidance.command)}</code></li>`).join('')}</ul>` : ''}
    ${view.target?.applicability.surface === 'web' ? button('preview', 'Start / refresh verified preview') : '<p>This delivery uses its retained structured results; no application is launched for report capture.</p>'}<p><a href="${e(form.resultsRoute)}">Open complete test results</a></p></section>
    <section><h2>Report a problem</h2><form method="post" action="${e(form.route)}">${fields}<label>What happened?<textarea name="observed" required maxlength="16000"></textarea></label><label>What did you expect?<textarea name="expected" maxlength="16000"></textarea></label>
    <button name="action" value="report-and-fix">Report and fix</button> <button name="action" value="report-only">Report only</button></form></section>
    <section><h2>Findings and repairs</h2>${view.findings.map(item => `<article><p><strong>${e(item.observed)}</strong> · ${e(item.state)}</p><p>${e(item.expected)}</p>
      <form method="post" action="${e(form.route)}">${fields}<input type="hidden" name="findingId" value="${e(item.id)}"><label>After trying the current result<select name="result"><option value="">Choose an observed result</option><option value="fixed">Fixed</option><option value="still-failing">Still failing</option><option value="cannot-reproduce">Cannot reproduce</option><option value="blocked">Blocked</option></select></label><textarea name="reason" placeholder="What you observed, or why this observation is dismissed"></textarea><button name="action" value="recheck">Record my recheck</button> <button name="action" value="dismiss">Dismiss with my reason</button>
      ${!['repairing', 'ready-for-repair', 'resolved', 'dismissed', 'duplicate'].includes(item.state) ? '<button name="action" value="request-repair">Repair this finding</button>' : ''}
      <label>Duplicate of an existing problem<select name="duplicateOf"><option value="">Choose the original observation</option>${view.findings.filter(other => other.id !== item.id).map(other => `<option value="${e(other.id)}">${e(other.observed)}</option>`).join('')}</select></label><button name="action" value="duplicate">Record duplicate with my reason</button></form></article>`).join('') || '<p>No reported problems.</p>'}</section>
    <section><h2>Current submitted test results</h2>${report.map(attempt => `<p><strong>${e(attempt.status)}</strong> · ${e(attempt.commandId)} · ${e(attempt.tests?.passed ?? 0)} passed · ${e(attempt.tests?.failed ?? 0)} failed · ${e(attempt.tests?.skipped ?? 0)} skipped</p>`).join('') || '<p>No authoritative submitted execution is available yet. You can inspect and report problems now.</p>'}</section>
    ${view.target?.results?.reason ? `<p role="status">${e(view.target.results.reason)}</p>` : ''}
    <section><h2>Confirm this result</h2><p>All good records what you inspected live and in the retained results. SFlow then captures evidence automatically. It does not approve the phase or claim that you inspected images created afterwards.</p>
    <form method="post" action="${e(form.route)}">${fields}${view.coverage.map(item => `<label><input type="checkbox" name="coverage" value="${e(item.id)}"> ${e(item.text)} <small>(${e(item.dimension)})</small></label>`).join('')}
    ${Object.entries(view.dimensions ?? view.target?.applicability?.dimensions ?? {}).map(([dimension, status]) => status === 'not-applicable' ? `<p>${e(dimension)}: not applicable (${e(view.target.applicability.reason)})</p>` : status === 'accepted' ? `<p>${e(dimension)}: accepted for this target</p>` : `<label><input type="checkbox" name="dimension" value="${e(dimension)}"> I accept the current ${e(dimension)} result</label>`).join('')}
    <button name="action" value="accept" ${view.completion?.reviewSatisfied ? 'disabled' : ''}>${view.completion?.reviewSatisfied ? 'Application accepted' : 'All good — capture and accept'}</button></form>
    ${view.confirmation ? `<p>Confirmation retained. Capture: ${e(view.state)}.</p>${button('capture', 'Resume evidence capture')}` : ''}
    ${form.evidenceRoute && view.captures?.length ? `<details><summary>Captured evidence (${view.captures.length})</summary>${view.captures.map(item => `<figure><figcaption>${e(item.captureKind)} · ${e(item.captureItem)} · ${e(item.capturedAt)}</figcaption><a href="${e(form.evidenceRoute + item.sha256.slice(7))}" target="_blank" rel="noreferrer">Open image</a><img loading="lazy" style="display:block;max-width:100%;margin:12px 0" src="${e(form.evidenceRoute + item.sha256.slice(7))}" alt="${e(item.captureItem)}"></figure>`).join('')}</details>` : ''}
    ${view.error ? `<p>${e(view.error.message ?? view.error.code)}</p>` : ''}</section>
    <section><h2>Continue</h2>${view.continuation ? `<p>${e(view.continuation.nextAction.label)}</p><p><code>${e(view.continuation.nextAction.command)}</code></p>` : '<p>For an admitted repair, use Copilot <code>/sf-code</code>. Repair never resolves a finding without your recheck.</p>'}${button('refresh', 'Refresh delivery and results')}${button('defer', 'Review later')}${button('close', 'Close review and stop its preview')}</section></html>`;
}
