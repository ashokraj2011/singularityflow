/**
 * The OneDrive and SharePoint writer for after-step actions: the approved artifact uploaded through
 * Microsoft Graph to a folder of a document library drive.
 *
 * The folder includes the step's generation, so every generation has its own place and an older
 * one arriving late can never replace a newer upload. Uploads never replace: a file already there
 * under that name is this generation's document, delivered before.
 */
import { boundedDetail, pinnedHttpRequest } from './pinned-http.mjs';
import { DEFAULT_ONEDRIVE_FOLDER, renderOneDriveFolder } from './step-actions.mjs';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const USER_AGENT = 'singularity-flow-step-actions/1';
const MAX_GRAPH_RESPONSE_BYTES = 256 * 1024;

/** The library drive a target uploads to, as a Graph path. */
export function graphDrivePath(target) {
  return target.site
    ? `/sites/${encodeURIComponent(target.site)}/drives/${encodeURIComponent(target.drive)}`
    : `/drives/${encodeURIComponent(target.drive)}`;
}

/** Where one delivery's file goes: the rendered folder and the artifact's own name. */
export function oneDriveItemPath(record) {
  const target = record.action.targetSpec;
  const folder = renderOneDriveFolder(target.folder ?? DEFAULT_ONEDRIVE_FOLDER, {
    workId: record.workId, phaseId: record.phaseId, generation: record.generation, trigger: record.trigger
  });
  const name = String(record.artifact?.path ?? 'artifact.md').split('/').pop().replace(/[^A-Za-z0-9 ._()-]+/g, '-').replace(/^[ .-]+/, '').slice(0, 120) || 'artifact.md';
  return `${folder}/${name}`;
}

/** A Graph answer as an attempt result, when it is not a success. */
export function graphAttempt(status, text) {
  let message = text;
  try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* keep the text */ }
  const detail = `Microsoft Graph answered HTTP ${status}${message ? `: ${boundedDetail(message)}` : ''}`;
  if (status === 408 || status === 429 || status >= 500) return { outcome: 'retry', status, code: 'STEP_ACTION_GRAPH_UNAVAILABLE', detail };
  if (status === 401) return { outcome: 'failed', status, code: 'STEP_ACTION_GRAPH_REFUSED', detail: `${detail}. The Graph token is missing a permission or has expired; store a fresh one, then retry.` };
  if (status === 403) return { outcome: 'failed', status, code: 'STEP_ACTION_GRAPH_REFUSED', detail: `${detail}. The account behind the token cannot write to that drive.` };
  if (status === 404) return { outcome: 'failed', status, code: 'STEP_ACTION_GRAPH_NOT_FOUND', detail: `${detail}. Check the target's drive (and site).` };
  if (status >= 300 && status < 400) return { outcome: 'failed', status, code: 'STEP_ACTION_REDIRECT_REFUSED', detail: 'Microsoft Graph answered with a redirect, which is never followed.' };
  return { outcome: 'failed', status, code: 'STEP_ACTION_GRAPH_FAILED', detail };
}

/** Upload the approved artifact without replacing anything. Returns an attempt result; never throws. */
export async function deliverToOneDrive(record, { env = process.env, request = pinnedHttpRequest, timeoutMs = 10_000 } = {}) {
  const target = record.action.targetSpec;
  const token = String(env[target.tokenSecret] ?? '').trim();
  if (!token) return { outcome: 'unavailable', code: 'STEP_ACTION_SECRET_MISSING', detail: `Secret ${target.tokenSecret} is not set on this machine.` };
  if (!record.artifact?.base64) {
    return { outcome: 'failed', code: 'STEP_ACTION_ARTIFACT_UNAVAILABLE', detail: record.artifact?.problem ?? 'The approved artifact was not recorded with this delivery.' };
  }
  const item = oneDriveItemPath(record);
  const encoded = item.split('/').map(encodeURIComponent).join('/');
  try {
    const answer = await request({
      url: `${GRAPH_BASE}${graphDrivePath(target)}/root:/${encoded}:/content?@microsoft.graph.conflictBehavior=fail`,
      method: 'PUT', timeoutMs, network: 'public', maxResponseBytes: MAX_GRAPH_RESPONSE_BYTES,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': record.artifact.mediaType ?? 'text/markdown', 'user-agent': USER_AGENT, 'x-sflow-delivery': record.key },
      body: Buffer.from(record.artifact.base64, 'base64')
    });
    if (answer.transport) return answer.transport;
    if (answer.status === 409) return { outcome: 'delivered', status: 409, detail: `${item} is already there.` };
    if (answer.status < 200 || answer.status >= 300) return graphAttempt(answer.status, answer.text);
    let uploaded = null;
    try { uploaded = JSON.parse(answer.text); } catch { uploaded = null; }
    return { outcome: 'delivered', status: answer.status, detail: `Uploaded ${item}${uploaded?.webUrl ? ` (${boundedDetail(uploaded.webUrl)})` : ''}.` };
  } catch (error) {
    return { outcome: 'retry', code: 'STEP_ACTION_GRAPH_FAILED', detail: boundedDetail(error?.message) };
  }
}
