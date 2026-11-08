/** Explicit read-only lifecycle observation shared by persistence and read hosts. */
import { createHash } from 'node:crypto';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceLifecycleStoryKey as encodedStoryKey,validWorkId} from './namespace-lifecycle-codec.mjs';
export {validWorkId} from './namespace-lifecycle-codec.mjs';
export function namespaceLifecycleStoryKey(workId){return encodedStoryKey(workId,NODE_TEXT_DIGESTS);}
import { SingularityFlowError } from '../foundation/failures.mjs';
import { validateNamespaceStore,namespaceLimits } from '../sda/namespace/contract.mjs';
import { namespaceJson,namespaceIdentifier,namespaceScope,namespaceRevision,exactObject } from '../sda/namespace/values.mjs';
import { contentReference,validateContentStore } from '../sda/content/contract.mjs';
import { LIFECYCLE_AUTHORITY_KEY,LIFECYCLE_STATE_MAXIMUM_BYTES,lifecycleAuthority,lifecycleConfiguration,lifecycleHead,lifecycleState } from './namespace-lifecycle-contract.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sameRef=(a,b)=>a.namespace===b.namespace&&a.sha256===b.sha256&&a.bytes===b.bytes;
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('The lifecycle operation was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}
export function createNamespaceLifecycleObserver({records,content,scope,workId,authority}={}) {
  validateNamespaceStore(records);validateContentStore(content);scope=namespaceScope(scope);workId=validWorkId(workId);
  exactObject(authority,['id','epoch']);authority=Object.freeze({id:namespaceIdentifier(authority.id,'Authority ID'),epoch:authority.epoch});
  if(!Number.isSafeInteger(authority.epoch)||authority.epoch<1||records.descriptor.binding.kind!=='shared'||content.descriptor.binding.kind!=='shared') {
    throw error('Lifecycle persistence needs explicit shared ports and an authority epoch.','ENGINE_INPUT_INVALID');
  }
  const recordId=records.descriptor.id,contentId=content.descriptor.id,limits=namespaceLimits(records.descriptor.limits);
  const read=records.read.bind(records),readContent=content.read.bind(content),headKey=namespaceLifecycleStoryKey(workId);
  function stored(validate, value, ...args) {
    try { return validate(value, scope, ...args); }
    catch (cause) { if (cause.code === 'ENGINE_STORAGE_UNSUPPORTED') throw cause;
      throw error('The persisted lifecycle record is invalid.', 'ENGINE_STORAGE_CORRUPT', { workId }, cause); }
  }
  async function record(namespace, key, immutable, signal, missing = false) {
    const result = await read(scope, namespace, key, { signal });
    if (result?.status === 'missing' && result.record === null) {
      if (missing) return null;
      throw error('A required lifecycle record is missing.', 'ENGINE_LIFECYCLE_RECORD_MISSING', { workId, namespace, key });
    }
    if (result?.status !== 'present' || result.record?.namespace !== namespace || result.record.key !== key
      || result.record.immutable !== immutable || namespaceRevision(result.record.version) === null) {
      throw error('The namespace port returned a differently bound lifecycle record.', 'ENGINE_PORT_RESULT_INVALID', { namespace, key });
    }
    return { version: result.record.version, value: namespaceJson(result.record.value, { maxBytes: limits.maxValueBytes }) };
  }
  function checkAuthority(value,requireActive) {
    stored(lifecycleAuthority, value);
    if (value.authorityId !== authority.id || value.epoch !== authority.epoch || requireActive&&value.status !== 'active'
      || value.recordsId !== recordId || value.contentId !== contentId) throw error('This lifecycle writer is fenced or bound to another authority.',
    'ENGINE_AUTHORITY_FENCED', { workId, authorityId: authority.id, epoch: authority.epoch });
  }
  function assertAuthority(value) {checkAuthority(value,true);}
  async function bytes(ref, maximumBytes, signal) {
    const selected = contentReference(ref), result = await readContent(scope, selected, { maximumBytes, signal });
    if (result?.status === 'missing' && result.data === null) throw error('Required immutable lifecycle content is missing.',
      'ENGINE_STORAGE_CONTENT_MISSING', { workId, reference: selected });
    if (result?.status !== 'present' || !sameRef(contentReference(result.reference), selected)
      || !(result.data instanceof Uint8Array) || result.data.byteLength !== Math.min(maximumBytes, selected.bytes)
      || result.truncated !== (maximumBytes < selected.bytes)) throw error('The content port returned another lifecycle binding.', 'ENGINE_PORT_RESULT_INVALID');
    const data = Buffer.from(result.data);
    if (!result.truncated && hash(data) !== selected.sha256) throw error('Immutable lifecycle bytes have a different digest.', 'ENGINE_STORAGE_CORRUPT');
    return data;
  }
  function state(data, head) {
    if (data.byteLength > LIFECYCLE_STATE_MAXIMUM_BYTES) throw error('Lifecycle state exceeds its content bound.', 'ENGINE_STORAGE_LIMIT');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch (cause) { throw error('Lifecycle state is not valid UTF-8 JSON.', 'ENGINE_STORAGE_CORRUPT', { workId }, cause); }
    const pending = [[value, 0]]; let nodes = 0;
    while (pending.length) {
      const [item, depth] = pending.pop();
      if (++nodes > 250_000 || depth > 64 || typeof item === 'number' && !Number.isFinite(item)) {
        throw error('Lifecycle JSON exceeds its structural bounds or contains a non-finite number.', 'ENGINE_STORAGE_CORRUPT');
      }
      if (item && typeof item === 'object') {
        if (Array.isArray(item) && item.length + nodes + pending.length > 250_000) throw error('Lifecycle JSON exceeds its node bound.', 'ENGINE_STORAGE_LIMIT');
        const values = Object.values(item);
        if (values.length + nodes + pending.length > 250_000) throw error('Lifecycle JSON exceeds its node bound.', 'ENGINE_STORAGE_LIMIT');
        for (const child of values) pending.push([child, depth + 1]);
      }
    }
    return stored(lifecycleState, value, head);
  }
  async function observe({ signal } = {},requireActive) {
    cancelled(signal);
    const a = await record('state', LIFECYCLE_AUTHORITY_KEY, false, signal); checkAuthority(a.value,requireActive);
    const h = await record('state', headKey, false, signal); stored(lifecycleHead, h.value, workId);
    if (h.value.authorityId !== authority.id || h.value.epoch !== authority.epoch) throw error('This Story uses another lifecycle authority.', 'ENGINE_AUTHORITY_FENCED');
    const c = await record('config', h.value.configuration.key, true, signal); stored(lifecycleConfiguration, c.value);
    if (!sameRef(c.value.content, h.value.configuration.content)) throw error('The Story configuration pin differs from its immutable record.', 'ENGINE_STORAGE_CORRUPT');
    const body = state(await bytes(h.value.state, h.value.state.bytes, signal), h.value);
    await bytes(c.value.content, 0, signal);
    const fresh = await record('state', headKey, false, signal), active = await record('state', LIFECYCLE_AUTHORITY_KEY, false, signal);
    cancelled(signal);
    if (fresh.version !== h.version || active.version !== a.version) throw error('The lifecycle snapshot changed while it was read.', 'ENGINE_CONTEXT_CHANGED');
    const snapshot = { workId, revision: h.version, workflow: body.workflow, configuration: structuredClone(h.value.configuration) };
    return { snapshot, basis: { authorityVersion: a.version, headVersion: h.version, configurationVersion: c.version, head: h.value } };
  }
  // Inspection can acknowledge retained facts while fenced; only capture is a writer basis.
  const capture=options=>observe(options,true),inspect=options=>observe(options,false);
  return Object.freeze({stored,record,assertAuthority,bytes,state,capture,inspect});
}
