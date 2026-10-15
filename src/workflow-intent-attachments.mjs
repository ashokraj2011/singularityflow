/** Explicit laptop selections are candidate data. Nothing is executed, fetched or installed. */
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { scanText } from './secrets.mjs';
import { blockedPath, EXCLUDED_DIRECTORIES, recognizeFormat, formatRole, splitFrontMatter, kebab } from './team-import/formats.mjs';
import { SingularityFlowError } from './util.mjs';

export const WORKFLOW_ATTACHMENT_LIMITS = Object.freeze({ selections: 32, files: 128, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024 });
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = message => { throw new SingularityFlowError(message, { code: 'WORKFLOW_ATTACHMENT_INVALID' }); };

export function classifyWorkflowAttachment(name, content, format = recognizeFormat(name)) {
  const front = splitFrontMatter(content);
  const basename = path.posix.basename(name).toLowerCase();
  let kind = formatRole(format), confidence = kind ? 'recognized' : 'suggested', reason = kind ? `Recognized ${format} layout.` : 'Copilot will review its purpose before generating an object.';
  if (kind === 'procedure') kind = 'skill';
  if (!kind && basename === 'skill.md') { kind = 'skill'; confidence = 'recognized'; reason = 'Named SKILL.md.'; }
  if (!kind && basename === 'instructions.md') { kind = 'instruction'; confidence = 'recognized'; reason = 'Named INSTRUCTIONS.md.'; }
  if (!kind && basename.endsWith('.mdc') && (front.frontMatter.globs != null || front.frontMatter.alwaysApply != null)) { kind = 'instruction'; confidence = 'recognized'; reason = 'Scoped rule front matter; retain its applicability as local guidance.'; }
  if (!kind && (front.frontMatter.tools || front.frontMatter.handoffs)) { kind = 'agent'; reason = 'Agent-like tools or handoffs in front matter; review the inferred role.'; }
  if (!kind && /(?:rules?|standards?|conventions?|instructions?|best-practices)/iu.test(basename)) { kind = 'instruction'; reason = 'Guidance-oriented filename; review the inferred role.'; }
  if (!kind && /^#{1,6}\s.*\b(?:steps|procedure|checklist)\b/imu.test(front.body)) { kind = 'skill'; reason = 'A procedural heading suggests a reusable skill; review this inference.'; }
  if (front.problem) { kind = null; confidence = 'needs-review'; reason = 'Malformed front matter; Copilot must explain and repair the object definition.'; }
  const scope = front.frontMatter.applyTo ?? front.frontMatter.globs;
  return { kind: kind ?? 'auto', confidence, reason, format, scope: typeof scope === 'string' ? scope : Array.isArray(scope) ? scope.filter(item => typeof item === 'string').join(', ') : null };
}

async function selectedText(file) {
  const selected = await lstat(file, { bigint: true });
  if (!selected.isFile() || selected.size > BigInt(WORKFLOW_ATTACHMENT_LIMITS.fileBytes)) fail('Select regular UTF-8 guidance files of at most 256 KiB; links and special files are not followed.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino || before.size !== selected.size) fail('An attachment changed while it was opened. Select it again.');
    const bytes = Buffer.alloc(WORKFLOW_ATTACHMENT_LIMITS.fileBytes + 1); let length = 0;
    while (length < bytes.length) { const chunk = await handle.read(bytes, length, bytes.length - length, null); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('An attachment changed while it was read. Select it again.');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    if (content.includes('\0') || !content.trim()) fail('Attachments must contain nonempty UTF-8 text.');
    return content;
  } finally { await handle.close(); }
}

export async function inspectWorkflowAttachments({ files = [], folders = [], expectedSource = null, id = null } = {}) {
  if (![files, folders].every(list => Array.isArray(list) && list.every(value => typeof value === 'string' && value.trim()))
      || !files.length && !folders.length || files.length + folders.length > WORKFLOW_ATTACHMENT_LIMITS.selections) fail('Choose up to 32 explicit files or folders. No directory is discovered automatically.');
  const items = [], selections = [], notices = [], locations = new Map(); let bytes = 0;
  const add = (source, name, content, format, screening = 'clean') => {
    const size = Buffer.byteLength(content ?? ''); bytes += size;
    if (bytes > WORKFLOW_ATTACHMENT_LIMITS.totalBytes || items.length >= WORKFLOW_ATTACHMENT_LIMITS.files) fail('The attachment selection exceeds 128 files or 2 MiB. Choose a smaller guidance folder.');
    const identity = hash(source), slug = kebab(path.basename(name).replace(/\.[^.]+$/u, '')).slice(0, 40).replace(/-+$/u, '') || 'guidance';
    const itemId = `local-${slug}-${identity.slice(7, 19)}`;
    if (items.some(item => item.id === itemId)) return;
    locations.set(itemId, path.resolve(source));
    if (content && scanText(content, { path: name }).length) screening = 'withheld'; // Imported waiver comments never grant disclosure.
    const clean = screening === 'clean' && content != null;
    items.push({ id: itemId, name, bytes: size, sha256: clean ? hash(content) : null, available: clean,
      classification: clean ? classifyWorkflowAttachment(name, content, format) : { kind: 'auto', confidence: 'blocked', reason: `Not shared: ${screening}.`, format: format ?? null, scope: null },
      ...(clean ? { content } : {}) });
  };
  for (const input of [...new Set(files)]) {
    const file = path.resolve(input), basename = path.basename(file), name = /^(?:SKILL|INSTRUCTIONS|AGENTS)\.md$/iu.test(basename) ? `${path.basename(path.dirname(file))}/${basename}` : basename; selections.push({ file });
    if (blockedPath(file.replaceAll('\\', '/'))) { add(file, name, null, null, 'blocked path'); continue; }
    if (!/\.(?:md|markdown|txt|mdc|json|ya?ml)$/iu.test(name)) fail('Attach Markdown, text, JSON or YAML guidance. Executables and archives are not opened.');
    add(file, name, await selectedText(file));
  }
  for (const input of [...new Set(folders)]) {
    const folder = path.resolve(input); selections.push({ folder });
    if (blockedPath(folder.replaceAll('\\', '/')) || EXCLUDED_DIRECTORIES.has(path.basename(folder)) || folder === path.parse(folder).root) fail('Choose a guidance folder, not credentials, dependencies, Git metadata or a filesystem root.');
    const { captureTeamDirectory } = await import('./team-import/capture.mjs');
    const { capture, contents } = await captureTeamDirectory(folder, { bounds: { files: WORKFLOW_ATTACHMENT_LIMITS.files, depth: 8, fileBytes: WORKFLOW_ATTACHMENT_LIMITS.fileBytes, totalBytes: WORKFLOW_ATTACHMENT_LIMITS.totalBytes } });
    for (const file of capture.files) add(`${folder}/${file.path}`, `${path.basename(folder)}/${file.path}`, contents.get(file.path) ?? null, file.format, file.screening);
    if (capture.excludedCount) notices.push(`${capture.excludedCount} dependency, generated or linked entries were excluded from ${path.basename(folder)}.`);
    const unresolved = capture.references.filter(reference => reference.status !== 'resolved').length;
    if (unresolved) notices.push(`${unresolved} source references in ${path.basename(folder)} need review; no missing or external file was fetched.`);
  }
  // References are navigation data only: resolve against this explicit capture, never open them.
  for (const item of items.filter(entry => entry.available)) {
    const written = [...item.content.matchAll(/!?\[[^\[\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"'\n]*["'])?\s*\)|#file:([^\s)\]`'"]+)/gu)]
      .map(match => match[1] ?? match[2]);
    const unique = [...new Set(written)].filter(value => !value.startsWith('#'));
    item.referenceCount = unique.length;
    item.references = unique.slice(0, 32).map(value => {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^[A-Za-z]:[\\/]/u.test(value)) return { status: 'external', label: 'External reference (not fetched)', targetId: null };
      let relative; try { relative = decodeURIComponent(value.replace(/[#?].*$/u, '')).replaceAll('\\', '/'); } catch { relative = ''; }
      const target = path.resolve(path.dirname(locations.get(item.id)), relative);
      const candidates = items.filter(entry => [target, path.join(target, 'SKILL.md')].includes(locations.get(entry.id)));
      const found = candidates.length === 1 ? candidates[0] : null;
      return { status: found?.available ? 'resolved' : found ? 'withheld' : 'not-in-capture', label: found?.name ?? (path.posix.basename(relative).slice(0, 120) || 'Unresolved reference'), targetId: found?.id ?? null };
    });
  }
  const sourceSha256 = hash(JSON.stringify({ selections, items: items.map(({ content, ...item }) => item) }));
  if (expectedSource && sourceSha256 !== expectedSource) fail('The selected local files changed. Preserve the workflow draft and reattach the files before rebinding it.');
  const selected = id ? items.find(item => item.id === id && item.available) : null;
  if (id && !selected) fail('That attachment is unavailable in this exact capture.');
  return { schemaVersion: 1, resultType: 'workflow-intent-attachments', sourceSha256, items: id ? [selected] : items, notices,
    meaning: 'Captured local data only. Classification is a proposal, not execution, installation, global guidance, approval or activation.' };
}
