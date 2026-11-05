/** Local originals reuse the document store; portable drafts contain only source descriptors. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { storeLocalDocument, readLocalDocument } from '../document-storage.mjs';
import { documentMimeType, extractSourceText, isTextualSource } from '../source-text.mjs';
import { normalizeArea } from './research.mjs';
import { secureRepositoryPath, SingularityFlowError } from '../util.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code) => { throw new SingularityFlowError(message, { code }); };
export const MAXIMUM_SPEC_SOURCE_BYTES = 20 * 1024 * 1024;
const MAXIMUM = MAXIMUM_SPEC_SOURCE_BYTES;
const MAXIMUM_DRAFT_BYTES = 256 * 1024;
/** The refusals every document input takes, loaded only when a source is added or read: an autosave pays nothing for them. */
const admit = async (root, input) => (await import('../documents-read.mjs')).assertSpecSourceAdmissible(root, input);
const REFUSED_CONTENT = new Set(['ENVIRONMENT_LOCAL_CONTENT_REFUSED', 'SECRET_DETECTED', 'DOCUMENT_CONTENT_UNSCANNABLE']);

/** Read at most the statted size plus one byte; a growing file never allocates without a bound. */
async function boundedRead(handle, maximum) {
  const info = await handle.stat();
  if (!info.isFile()) fail('Select a regular file.', 'SPEC_SOURCE_FILE_INVALID');
  if (info.size > maximum) fail('Select a file no larger than ' + maximum + ' bytes.', 'SPEC_SOURCE_FILE_TOO_LARGE');
  const bytes = Buffer.alloc(info.size + 1);
  let used = 0;
  while (used < bytes.length) {
    const read = await handle.read(bytes, used, bytes.length - used, null);
    if (!read.bytesRead) break;
    used += read.bytesRead;
  }
  const after = await handle.stat();
  if (used !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) fail('The file changed while it was read. Choose it again.', 'SPEC_SOURCE_FILE_CHANGED');
  return bytes.subarray(0, used);
}

export async function addSpecSource(root, specId, draft, { file, url, code, specification, restore, purpose = '' }) {
  if ([file, url, code, specification].filter(Boolean).length !== 1) fail('Choose one file, link or code location.', 'SPEC_SOURCE_SELECTION_INVALID');
  if (typeof purpose !== 'string' || purpose.length > 2000) fail('Keep the source note within 2000 characters.', 'SPEC_SOURCE_PURPOSE_INVALID');
  const sources = draft.sources ?? [];
  if (sources.length >= 32 && !restore) fail('This draft already has 32 sources. Remove an unneeded source before adding another.', 'SPEC_SOURCE_LIMIT');
  let source;
  if (specification) {
    const reference = specification.revision;
    source = { id: 'SRC-' + digest(Buffer.from(reference + ':' + specification.manifestSha256)).slice(0, 16), type: 'specification', name: specification.title, revision: reference, manifestSha256: specification.manifestSha256, purpose, standing: 'not-read' };
  } else if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { fail('Use a complete http or https link.', 'SPEC_SOURCE_URL_INVALID'); }
    if (parsed.href.length > 2048) fail('Use a link no longer than 2048 characters.', 'SPEC_SOURCE_URL_INVALID');
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('Use an http or https link without credentials.', 'SPEC_SOURCE_URL_INVALID');
    const credential = (await import('../documents-read.mjs')).credentialUrlParameter(parsed);
    if (credential) fail(`This link carries an access credential in its '${credential}' parameter, and a link is shared with the draft. Use a link without it, or add the document as a file.`, 'SPEC_SOURCE_URL_CREDENTIALS');
    source = { id: 'SRC-' + digest(Buffer.from(parsed.href)).slice(0, 16), type: 'url', name: parsed.hostname,
      url: parsed.href, purpose, standing: 'not-read' };
  } else if (code) {
    const selected = normalizeArea(code);
    const located = await secureRepositoryPath(root, selected, { mustExist: true, label: 'Selected code' });
    await admit(root, { repositoryPath: selected, name: selected, bytes: located.entry.isFile() ? await boundedFile(located.absolute, MAXIMUM) : null });
    source = { id: 'SRC-' + digest(Buffer.from('code:' + selected)).slice(0, 16), type: 'code', name: selected, path: selected, purpose, standing: 'not-read' };
  } else {
    const bytes = await boundedFile(path.resolve(file), MAXIMUM);
    const name = path.basename(file).replace(/[\u0000-\u001f]/gu, '').slice(0, 240);
    const filename = name.replace(/[^A-Za-z0-9._-]/gu, '_') || 'source.bin';
    const sha256 = digest(bytes);
    const previous = restore ? sources.find(item => item.id === restore) : null;
    if (restore && (!previous || previous.sha256 !== sha256)) fail('This is a different file. The original source was preserved; add this as a new source or choose the matching original.', 'SPEC_SOURCE_REPLACEMENT_REQUIRED');
    await admit(root, { file: path.resolve(file), name: previous?.sourceName ?? name, bytes });
    const storage = await storeLocalDocument(root, specId, { bytes, sha256, filename: previous?.sourceName ?? filename, replaceChanged: Boolean(restore) });
    source = previous ?? { id: 'SRC-' + sha256.slice(0, 16), type: 'file', name, sourceName: filename,
      mediaType: documentMimeType(name), size: bytes.length, sha256, storage: { kind: 'local', key: storage.key }, purpose, standing: 'not-read' };
  }
  return { ...draft, sources: [...sources.filter(item => item.id !== source.id), source] };
}

async function boundedFile(file, maximum) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await boundedRead(handle, maximum); } finally { await handle.close(); }
}

/** The exact local path/text is an ephemeral tool result; never include it in synchronized drafts. */
export async function readSpecSource(root, specId, source, options = {}) {
  // A source from before these refusals, or code changed since it was chosen, is refused here too:
  // this read is what hands its text to a model. The draft and its other sources stay usable.
  try { return await readAdmittedSource(root, specId, source, options); }
  catch (error) {
    if (!REFUSED_CONTENT.has(error?.code)) throw error;
    return { source, status: 'refused', code: error.code, message: error.message,
      nextAction: 'singularity-flow spec author source ' + specId + ' --remove ' + source.id + ' --json' };
  }
}

async function readAdmittedSource(root, specId, source, { config = {} } = {}) {
  if (source.type === 'specification') {
    const { libraryView, resolveRevision } = await import('./library.mjs');
    const { parseSpecReference } = await import('./ids.mjs');
    const reference = parseSpecReference(source.revision);
    const revision = resolveRevision(root, await libraryView(root, config, { refresh: false }), reference.specId, reference.revision);
    if (revision.manifestSha256 !== source.manifestSha256) fail('The referenced specification does not match its pinned version.', 'SPEC_SOURCE_BINDING_INVALID');
    return { source, status: 'available', text: revision.spec, sha256: revision.manifestSha256, basis: source.revision, instruction: 'This is a pinned reference. It does not silently add requirements or change this draft’s parent links.' };
  }
  if (source.type === 'url') {
    // Saved before links with a credential were refused: the address itself must not reach a model.
    const credential = (await import('../documents-read.mjs')).credentialUrlParameter(new URL(source.url));
    if (credential) { const { url: _address, ...descriptor } = source; return { source: descriptor, status: 'refused', code: 'SPEC_SOURCE_URL_CREDENTIALS', message: `This link carries an access credential in its '${credential}' parameter. Remove it from this draft and add a link without it.`, nextAction: 'singularity-flow spec author source ' + specId + ' --remove ' + source.id + ' --json' }; }
    return { source, status: 'not-read', instruction: 'Open this link using the host research tools. If unavailable, ask for an excerpt; never claim its contents were read.' };
  }
  if (source.type === 'code') {
    const located = await secureRepositoryPath(root, source.path, { mustExist: true, label: 'Selected code' });
    await admit(root, { repositoryPath: source.path, name: source.path });
    if (!located.entry.isFile()) return { source, status: 'selected-folder', path: located.absolute,
      instruction: 'Read only this selected area using native tools; existing code is observed behaviour, not desired requirements.' };
    const handle = await open(located.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (info.size > 256 * 1024) return { source, status: 'native-read-required', path: located.absolute };
      const bytes = await boundedRead(handle, 256 * 1024);
      await admit(root, { repositoryPath: source.path, name: source.path, bytes });
      return { source, status: 'available', path: located.absolute, text: bytes.toString('utf8'), sha256: digest(bytes), basis: 'selected-working-code' };
    } finally { await handle.close(); }
  }
  try {
    const read = await readLocalDocument(root, specId, source);
    await admit(root, { name: source.sourceName ?? source.name, bytes: read.bytes });
    const mime = source.mediaType;
    const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
    if (image) {
      const valid = mime === 'image/png' ? read.bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        : mime === 'image/jpeg' ? read.bytes.subarray(0, 2).toString('hex') === 'ffd8'
          : mime === 'image/gif' ? /^GIF8/u.test(read.bytes.subarray(0, 6).toString())
            : read.bytes.subarray(0, 4).toString() === 'RIFF' && read.bytes.subarray(8, 12).toString() === 'WEBP';
      if (!valid) fail('This image does not match its media type. Choose the original image again.', 'SPEC_SOURCE_IMAGE_INVALID');
      return { source, status: 'image-ready', path: read.absolutePath, mediaType: mime, sha256: source.sha256,
        instruction: 'Read the image through the native image tool or delivered image part; its filename is not visual evidence.' };
    }
    const extracted = isTextualSource(mime, source.name) ? { status: 'extracted', text: read.bytes.toString('utf8') } : extractSourceText(read.bytes, mime);
    if (extracted.status !== 'extracted') return { source, status: 'native-read-required', path: read.absolutePath, reason: extracted.reason };
    return { source, status: 'available', path: read.absolutePath, text: extracted.text, sha256: source.sha256 };
  } catch (error) {
    if (!['DOCUMENT_LOCAL_UNAVAILABLE', 'DOCUMENT_LOCAL_CHANGED'].includes(error.code)) throw error;
    return { source, status: 'upload-required', code: error.code, message: error.message,
      nextAction: 'singularity-flow spec author source ' + specId + ' --restore ' + source.id + ' --file <LOCAL-FILE> --json' };
  }
}

/** Copy only verified local originals when creating another draft. Missing originals stay missing. */
export async function copySpecSources(root, fromSpecId, toSpecId, sources = [], { targetRoot = root } = {}) {
  for (const source of sources.filter(item => item.type === 'file')) {
    try {
      const original = await readLocalDocument(root, fromSpecId, source);
      await storeLocalDocument(targetRoot, toSpecId, { bytes: original.bytes, sha256: source.sha256, filename: source.sourceName });
    } catch (error) {
      if (!['DOCUMENT_LOCAL_UNAVAILABLE', 'DOCUMENT_LOCAL_CHANGED'].includes(error.code)) throw error;
    }
  }
}

/** A draft's prose from a file. Too large is its own answer: the person keeps the text and can split or export it. */
/**
 * Isolated Story bases can have another Git common directory on this same laptop. Carry available
 * originals from the verified launch clone before the existing phase reader needs them; another
 * laptop still receives descriptors and the matching-file restore route.
 */
export async function copySliceSources(launchRepository, root, slices, copied = new Set()) {
  for (const slice of slices) {
    const owner = slice.revision.split('@')[0];
    if (!copied.has(owner)) { await copySpecSources(launchRepository, owner, owner, slice.sources ?? [], { targetRoot: root }); copied.add(owner); }
    await copySliceSources(launchRepository, root, slice.inheritedSpecifications ?? [], copied);
  }
}

export async function readSpecTextFile(file, { tooLarge = 'This draft exceeds 256 KiB. Keep your text, export it or split it into smaller specifications.' } = {}) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await boundedFile(path.resolve(file), MAXIMUM_DRAFT_BYTES)); }
  catch (error) {
    if (error?.code === 'SPEC_SOURCE_FILE_TOO_LARGE') fail(tooLarge, 'SPEC_DRAFT_TOO_LARGE');
    throw error;
  }
}
