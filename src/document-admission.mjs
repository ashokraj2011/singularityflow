/**
 * What may become a document or a specification source: its path against the environment-local rules, then
 * its content through the secret scanner. Only uploads and source reads load this, not everything that lists a document.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { environmentLocalRefusal, mimeType, safeName } from './documents-read.mjs';
import { withEnvironmentFilesRegistry } from './git.mjs';
import { loadEnvironmentDeclarationSync, matchEnvironmentLocalPath } from './environment-declaration.mjs';
import { alwaysLocalName } from './local-config-policy.mjs';
import { scannablePath, scanEntries, secretRefusal } from './secrets.mjs';
import { TEXT_RENDITION_SUFFIX, extractSourceText, hasTextExtractor } from './source-text.mjs';
import { SingularityFlowError, posix } from './util.mjs';

export async function repositoryRelativeSource(root, source) {
  // Compare canonical filesystem locations rather than caller spellings. macOS commonly exposes
  // the same file through /var and /private/var, while Windows drive casing and junctions create
  // equivalent aliases. A lexical comparison could treat a repository-local environment file as
  // external and thereby skip its path-specific localFiles rule.
  const [canonicalRoot, canonicalSource] = await Promise.all([
    realpath(path.resolve(root)), realpath(path.resolve(source))
  ]);
  const relative = path.relative(canonicalRoot, canonicalSource);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return null;
  return posix(relative);
}

/**
 * The source's own repository path with its last link not followed: a placed environment file is a
 * link into the private store, so only this spelling names it. Also refuse a real environment file
 * by where it lives (the store or a linked file) [ENVF].
 */
export async function environmentFileSourceCandidates(root, declaration, source) {
  const absolute = path.resolve(source);
  const [canonicalRoot, parent] = await Promise.all([realpath(path.resolve(root)), realpath(path.dirname(absolute))]).catch(() => []);
  const relative = parent ? path.relative(canonicalRoot, path.join(parent, path.basename(absolute))) : '';
  const lexical = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? posix(relative) : null;
  const match = lexical ? matchEnvironmentLocalPath(declaration, lexical) : null;
  if (match) throw environmentLocalRefusal(lexical, match);
  const canonical = await realpath(absolute).catch(() => null);
  if (canonical && (declaration?.environmentFileLocations ?? []).some((location) => canonical === location || canonical.startsWith(`${location}${path.sep}`))) {
    throw environmentLocalRefusal(source, { kind: 'environment-file', pattern: 'a private environment-file location' });
  }
  return lexical ? [lexical] : [];
}

/** `.env` and the like are local by name, whatever a repository declares [SPEC-ENVF v2]. A real example file is safe to share. */
export function assertNotPrivateEnvironmentName(name, { refused = 'Document upload was refused', becoming = 'a Story document' } = {}) {
  const rule = alwaysLocalName(name);
  if (!rule) return;
  const base = path.basename(String(name ?? '').replaceAll('\\', '/'));
  throw new SingularityFlowError(
    `${refused}: '${base}' is named like a private file, so it cannot become ${becoming}. If it holds no secrets, name it as a template such as .env.example; a private file belongs in singularity-flow env files.`,
    { code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED', details: { path: base, rule } });
}

/** Refuse secret-bearing text. A specification source says so in its own words, with what to do next, and not as a commit. */
function refuseSecretText(scan, refused) {
  // A document reaches a model, so a value in shared config is refused here during its commit rollout too.
  const blocking = [...scan.blocking, ...scan.warnings];
  if (!blocking.length) return;
  const message = refused ? `${refused}: ${blocking.slice(0, 3).map((finding) => `${finding.label} at ${finding.path}:${finding.line} (${finding.preview})`).join('; ')}. Remove the value from the file and choose it again.`
    : `Document upload was refused before any bytes were copied.\n\n${secretRefusal({ ...scan, blocking })}`;
  throw new SingularityFlowError(message, { code: 'SECRET_DETECTED' });
}

export function assertDocumentInputContainsNoSecret(input, captured, { refused = null } = {}) {
  const logicalPath = input.sourceRelativePath ? posix(input.sourceRelativePath) : safeName(input.source);
  // An Office document's text reaches prompts through its rendition, so that text is scanned too.
  const type = mimeType(input.source);
  if (hasTextExtractor(type)) {
    const extracted = extractSourceText(captured.bytes, type);
    if (extracted.status === 'extracted') {
      refuseSecretText(scanEntries([{ path: `${logicalPath}${TEXT_RENDITION_SUFFIX}`, content: extracted.text }]), refused);
    } else if (!extracted.empty) {
      throw new SingularityFlowError(
        `${refused ?? 'Document upload was refused before any bytes were copied'}: the text of '${logicalPath}' could not be read to scan it for secrets (${extracted.reason}).`,
        { code: 'DOCUMENT_CONTENT_UNSCANNABLE', details: { path: logicalPath } }
      );
    }
    return;
  }
  if (!scannablePath(logicalPath)) return;
  let content;
  try {
    if (captured.bytes.includes(0)) throw new TypeError('NUL byte');
    content = new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes);
  } catch {
    throw new SingularityFlowError(
      `${refused ?? 'Document upload was refused before any bytes were copied'}: '${logicalPath}' is not valid NUL-free UTF-8 text.`,
      { code: 'DOCUMENT_CONTENT_UNSCANNABLE', details: { path: logicalPath } }
    );
  }
  refuseSecretText(scanEntries([{ path: logicalPath, content }]), refused);
}

/**
 * The two refusals every document input takes, for a specification source: its path against the
 * repository's environment-local rules, then its content through the secret scanner. A source's
 * originals stay on this laptop, but `spec author sources` and a phase's read hand their text to a model.
 */
export async function assertSpecSourceAdmissible(root, { file = null, repositoryPath = null, name = null, bytes = null, reading = false, declaration = sourceAdmissionPolicy(root) } = {}) {
  const words = { refused: reading ? 'This source is not read out' : 'This source was not added', becoming: 'a specification source' };
  for (const candidate of [repositoryPath, name, file]) if (candidate) assertNotPrivateEnvironmentName(candidate, words);
  if (declaration) {
    const candidates = [repositoryPath, name && safeName(name),
      ...(file ? [await repositoryRelativeSource(root, file).catch(() => null), ...await environmentFileSourceCandidates(root, declaration, file)] : [])];
    for (const candidate of new Set(candidates.filter(Boolean))) {
      const match = matchEnvironmentLocalPath(declaration, candidate);
      if (match) throw environmentLocalRefusal(candidate, match, { refused: words.refused, becoming: 'specification sources' });
    }
  }
  if (bytes) assertDocumentInputContainsNoSecret({ source: name ?? repositoryPath ?? file }, { bytes }, { refused: words.refused });
}

/** The rules one read goes by, so a folder's many files need not load them again. */
export const sourceAdmissionPolicy = (root) => withEnvironmentFilesRegistry(root, loadEnvironmentDeclarationSync(root, { optional: true }));
