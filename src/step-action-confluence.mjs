/**
 * The Confluence writer for after-step actions: one page per Story and step under the target's
 * parent page, created or updated with the step's summary or its approved artifact. Cloud speaks
 * REST v2 and Data Center REST v1. A content property on the page records the delivery it holds,
 * so a retry, or an older generation arriving late, never writes over what is there.
 */
import { markdownToConfluenceStorage, escapeStorageText as esc } from './confluence-storage.mjs';
import { boundedDetail, pinnedHttpRequest } from './pinned-http.mjs';
import { renderConfluenceTitle } from './step-actions.mjs';

export const CONFLUENCE_DELIVERY_PROPERTY = 'sflow-delivery';
const USER_AGENT = 'singularity-flow-step-actions/1';
const MAX_CONFLUENCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const TRIGGER_WORDS = Object.freeze({ submitted: 'submitted for approval', approved: 'approved', rejected: 'sent back' });

/** The page body a delivery writes: what happened and where it is recorded, then its content. */
export function confluencePageBody(record) {
  const event = record.event ?? {};
  const actor = typeof event.actor === 'string' ? event.actor : event.actor?.name ?? event.actor?.email ?? null;
  const facts = [
    `<strong>${esc(event.story?.id ?? record.workId)}</strong>${event.story?.title ? ` — ${esc(event.story.title)}` : ''}`,
    `${esc(event.step?.label ?? record.phaseId)}, generation ${Number(record.generation) || 0}, ${esc(TRIGGER_WORDS[record.trigger] ?? record.trigger)}${actor ? ` by ${esc(actor)}` : ''}${event.at ? ` at ${esc(event.at)}` : ''}`
  ];
  const where = [
    event.commit?.sha ? `Commit <code>${esc(String(event.commit.sha).slice(0, 12))}</code>${event.story?.branch ? ` on ${esc(event.story.branch)}` : ''}` : null,
    ...(event.artifacts ?? []).filter((artifact) => artifact?.path).map((artifact) => `Artifact <code>${esc(artifact.path)}</code>${artifact.sha256 ? ` · SHA-256 ${esc(String(artifact.sha256).slice(0, 12))}` : ''}`)
  ].filter(Boolean);
  let content = '';
  if (record.action?.send === 'artifact') {
    content = record.artifact?.base64 ? markdownToConfluenceStorage(Buffer.from(record.artifact.base64, 'base64').toString('utf8')) : '';
  } else {
    const summary = event.summary ?? {};
    content = [
      summary.title ? `<h2>${esc(summary.title)}</h2>` : '',
      (summary.acceptanceCriteria ?? []).length ? `<ul>${summary.acceptanceCriteria.map((criterion) => `<li>${esc(criterion)}</li>`).join('')}</ul>` : ''
    ].join('');
  }
  return [
    `<p>${facts.join('<br/>')}</p>`,
    where.length ? `<p>${where.join('<br/>')}</p>` : '',
    '<hr/>',
    content,
    `<p><em>Written by Singularity Flow · delivery ${esc(record.key)}</em></p>`
  ].filter(Boolean).join('\n');
}

/** An HTTP answer from Confluence as an attempt result, when it is not a success. */
export function confluenceAttempt(status, text, what) {
  const detail = `${what}: HTTP ${status}${text ? ` ${boundedDetail(confluenceMessage(text))}` : ''}`.trim();
  if (status === 409 || status === 429 || status >= 500 || status === 408) return { outcome: 'retry', status, code: 'STEP_ACTION_CONFLUENCE_UNAVAILABLE', detail };
  if (status === 401 || status === 403) return { outcome: 'failed', status, code: 'STEP_ACTION_CONFLUENCE_REFUSED', detail };
  if (status === 404) return { outcome: 'failed', status, code: 'STEP_ACTION_CONFLUENCE_NOT_FOUND', detail };
  if (status >= 300 && status < 400) return { outcome: 'failed', status, code: 'STEP_ACTION_REDIRECT_REFUSED', detail: `${what}: Confluence answered with a redirect, which is never followed. Check the target's url.` };
  return { outcome: 'failed', status, code: 'STEP_ACTION_CONFLUENCE_FAILED', detail };
}

function confluenceMessage(text) {
  try {
    const payload = JSON.parse(text);
    return payload?.message ?? payload?.errors?.map?.((entry) => entry?.title ?? entry?.message).filter(Boolean).join('; ') ?? text;
  } catch { return text; }
}

class Attempt extends Error {
  constructor(result) { super(result.detail); this.result = result; }
}

/**
 * Create or update the Story's page for this step, then record the delivery on it. Returns an
 * attempt result; never throws.
 */
export async function deliverToConfluence(record, { env = process.env, request = pinnedHttpRequest, timeoutMs = 10_000 } = {}) {
  const target = record.action.targetSpec;
  const token = String(env[target.tokenSecret] ?? '').trim();
  if (!token) return { outcome: 'unavailable', code: 'STEP_ACTION_SECRET_MISSING', detail: `Secret ${target.tokenSecret} is not set on this machine.` };
  if (record.action.send === 'artifact' && !record.artifact?.base64) {
    return { outcome: 'failed', code: 'STEP_ACTION_ARTIFACT_UNAVAILABLE', detail: record.artifact?.problem ?? 'The approved artifact was not recorded with this delivery.' };
  }
  const cloud = target.deployment !== 'data-center';
  const authorization = cloud ? `Basic ${Buffer.from(`${target.user}:${token}`).toString('base64')}` : `Bearer ${token}`;
  const base = `${String(target.url).replace(/\/+$/, '')}${cloud ? '/api/v2' : '/rest/api'}`;
  const call = async (method, route, body = null, what = 'Confluence', { absentOk = false } = {}) => {
    const answer = await request({
      url: `${base}${route}`, method, timeoutMs, network: target.network ?? 'public', maxResponseBytes: MAX_CONFLUENCE_RESPONSE_BYTES,
      headers: { accept: 'application/json', authorization, 'user-agent': USER_AGENT, 'x-sflow-delivery': record.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : null
    });
    if (answer.transport) throw new Attempt(answer.transport);
    if (absentOk && answer.status === 404) return null;
    if (answer.status < 200 || answer.status >= 300) throw new Attempt(confluenceAttempt(answer.status, answer.text, what));
    try { return answer.text ? JSON.parse(answer.text) : {}; } catch { return {}; }
  };
  const title = renderConfluenceTitle(target.title, { workId: record.workId, stepLabel: record.event?.step?.label ?? record.phaseId, storyTitle: record.event?.story?.title });
  const body = confluencePageBody(record);
  const value = { key: record.key, workId: record.workId, step: record.phaseId, generation: record.generation, trigger: record.trigger };
  const message = `Singularity Flow: ${record.workId} ${record.phaseId} generation ${record.generation} ${record.trigger}`;
  const settled = (recorded) => {
    if (recorded?.key === record.key) return { outcome: 'delivered', status: 200, detail: `"${title}" already holds this delivery.` };
    if (recorded?.step === record.phaseId && Number(recorded?.generation) > record.generation) {
      return { outcome: 'delivered', status: 200, detail: `"${title}" already holds generation ${recorded.generation}.` };
    }
    return null;
  };
  let created = false;
  try {
    if (cloud) {
      const parent = await call('GET', `/pages/${encodeURIComponent(target.parentPage)}`, null, `Parent page ${target.parentPage}`);
      const found = await call('GET', `/pages?space-id=${encodeURIComponent(parent.spaceId ?? '')}&title=${encodeURIComponent(title)}&status=current&limit=5`, null, 'Finding the page');
      let page = (found?.results ?? []).find((entry) => entry?.title === title) ?? null;
      if (page && String(page.parentId) !== String(target.parentPage)) {
        return { outcome: 'failed', code: 'STEP_ACTION_CONFLUENCE_TITLE_TAKEN', detail: `A page called "${title}" already exists elsewhere in this space; change the target's title or parentPage.` };
      }
      let existing = null;
      if (page) {
        existing = (await call('GET', `/pages/${encodeURIComponent(page.id)}/properties?key=${CONFLUENCE_DELIVERY_PROPERTY}`, null, 'Reading the page record'))?.results?.[0] ?? null;
        const done = settled(existing?.value);
        if (done) return done;
        const current = await call('GET', `/pages/${encodeURIComponent(page.id)}`, null, 'Reading the page');
        await call('PUT', `/pages/${encodeURIComponent(page.id)}`, {
          id: page.id, status: 'current', title, body: { representation: 'storage', value: body },
          version: { number: Number(current?.version?.number ?? 0) + 1, message }
        }, 'Updating the page');
      } else {
        created = true;
        page = await call('POST', '/pages', { spaceId: parent.spaceId, status: 'current', title, parentId: target.parentPage, body: { representation: 'storage', value: body } }, 'Creating the page');
      }
      if (existing) {
        await call('PUT', `/pages/${encodeURIComponent(page.id)}/properties/${encodeURIComponent(existing.id)}`, {
          key: CONFLUENCE_DELIVERY_PROPERTY, value, version: { number: Number(existing.version?.number ?? 0) + 1 }
        }, 'Recording the delivery');
      } else {
        await call('POST', `/pages/${encodeURIComponent(page.id)}/properties`, { key: CONFLUENCE_DELIVERY_PROPERTY, value }, 'Recording the delivery');
      }
      return { outcome: 'delivered', status: 200, detail: `${created ? 'Created' : 'Updated'} "${title}".` };
    }
    const parent = await call('GET', `/content/${encodeURIComponent(target.parentPage)}?expand=space`, null, `Parent page ${target.parentPage}`);
    const spaceKey = parent?.space?.key ?? '';
    const found = await call('GET', `/content?type=page&spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=version,ancestors`, null, 'Finding the page');
    let page = (found?.results ?? []).find((entry) => entry?.title === title) ?? null;
    if (page && String(page.ancestors?.at?.(-1)?.id) !== String(target.parentPage)) {
      return { outcome: 'failed', code: 'STEP_ACTION_CONFLUENCE_TITLE_TAKEN', detail: `A page called "${title}" already exists elsewhere in this space; change the target's title or parentPage.` };
    }
    let existing = null;
    if (page) {
      existing = await call('GET', `/content/${encodeURIComponent(page.id)}/property/${CONFLUENCE_DELIVERY_PROPERTY}`, null, 'Reading the page record', { absentOk: true });
      const done = settled(existing?.value);
      if (done) return done;
      await call('PUT', `/content/${encodeURIComponent(page.id)}`, {
        id: page.id, type: 'page', title, version: { number: Number(page.version?.number ?? 0) + 1, message },
        body: { storage: { value: body, representation: 'storage' } }
      }, 'Updating the page');
    } else {
      created = true;
      page = await call('POST', '/content', {
        type: 'page', title, space: { key: spaceKey }, ancestors: [{ id: target.parentPage }], body: { storage: { value: body, representation: 'storage' } }
      }, 'Creating the page');
    }
    if (existing) {
      await call('PUT', `/content/${encodeURIComponent(page.id)}/property/${CONFLUENCE_DELIVERY_PROPERTY}`, {
        key: CONFLUENCE_DELIVERY_PROPERTY, value, version: { number: Number(existing.version?.number ?? 0) + 1 }
      }, 'Recording the delivery');
    } else {
      await call('POST', `/content/${encodeURIComponent(page.id)}/property`, { key: CONFLUENCE_DELIVERY_PROPERTY, value }, 'Recording the delivery');
    }
    return { outcome: 'delivered', status: 200, detail: `${created ? 'Created' : 'Updated'} "${title}".` };
  } catch (error) {
    if (error instanceof Attempt) return error.result;
    return { outcome: 'retry', code: 'STEP_ACTION_CONFLUENCE_FAILED', detail: boundedDetail(error?.message) };
  }
}
