/**
 * Exact captured source for the Change Explorer native diff [XPL2 14.4, XPL2-AC-022, XPL2-AC-025].
 *
 * Bytes come only from the existing exact-source owner (`comprehension source`), page by bounded
 * page. Every page must name the selected reference, continue the previous page exactly and report
 * the same whole-content digest; the assembled bytes must then hash to that digest. Anything else is
 * refused rather than shown. This module is host-free so the checks are testable without an editor.
 */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ComprehensionSourceExpansion, ComprehensionSourceReference } from '../cli/snapshot.ts';
import { commandData } from './surface-adapters.ts';

const PAGE_BYTES = 64 * 1024;
const MAXIMUM_SOURCE_BYTES = 1024 * 1024;

export interface ExactSourceContext {
  base: string;
  workId: string | null;
  phase: string | null;
}

export interface ExactSource {
  text: string;
  binary: boolean;
  bytes: number;
  contentSha256: string;
}

/** Decode captured bytes for display. Binary or invalid UTF-8 is described, never rendered. */
export function displayableSource(bytes: Buffer): { text: string; binary: boolean } {
  const decoded = bytes.toString('utf8');
  const binary = bytes.includes(0) || !Buffer.from(decoded, 'utf8').equals(bytes);
  return binary
    ? { text: `Binary content (${bytes.length} bytes) is not shown as text.`, binary: true }
    : { text: decoded, binary: false };
}

export type SourceRunner = (args: string[], signal?: AbortSignal) => Promise<unknown>;

/** Read one exact captured side through the source owner and verify every page and the whole. */
export async function readExactSource(
  run: SourceRunner, context: ExactSourceContext, reference: ComprehensionSourceReference, signal?: AbortSignal
): Promise<ExactSource> {
  const pages: Buffer[] = [];
  let offset = 0;
  let digest: string | null = null;
  let total: number | null = null;
  for (let attempt = 0; attempt < Math.ceil(MAXIMUM_SOURCE_BYTES / PAGE_BYTES) + 1; attempt += 1) {
    const args = [
      'comprehension', 'source', reference.ref, '--base', context.base,
      '--offset', String(offset), '--max-bytes', String(PAGE_BYTES), '--json'
    ];
    if (context.workId) args.push('--work-id', context.workId);
    if (context.phase) args.push('--phase', context.phase);
    const expansion = commandData<{ expansion: ComprehensionSourceExpansion }>(await run(args, signal))?.expansion;
    const page = expansion ? Buffer.from(expansion.content, 'base64') : null;
    if (!expansion || !page || expansion.reference !== reference.ref || expansion.referenceSha256 !== reference.referenceSha256
        || expansion.offset !== offset || page.length !== expansion.bytes || expansion.encoding !== 'base64'
        || (digest !== null && expansion.contentSha256 !== digest) || (total !== null && expansion.totalBytes !== total)) {
      throw new Error('The exact source response did not match the selected captured reference.');
    }
    if (expansion.totalBytes > MAXIMUM_SOURCE_BYTES) {
      throw new Error(`This file is larger than the ${MAXIMUM_SOURCE_BYTES}-byte inline diff ceiling; use the CLI for exact bytes.`);
    }
    digest = expansion.contentSha256;
    total = expansion.totalBytes;
    pages.push(page);
    offset += page.length;
    if (expansion.complete || expansion.nextOffset == null) break;
    if (expansion.nextOffset !== offset) throw new Error('The exact source pages were not contiguous.');
  }
  const bytes = Buffer.concat(pages);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (total === null || bytes.length !== total || actual !== digest) {
    throw new Error('The assembled source bytes do not match the digest reported by the source owner.');
  }
  const shown = displayableSource(bytes);
  return { text: shown.text, binary: shown.binary, bytes: bytes.length, contentSha256: actual };
}

export type ContainedPath = { target: string; refusal: null } | { target: null; refusal: string };

/**
 * Resolve a repository-relative path for "Open working file" [XPL2-AC-053]. The path must stay in
 * the repository lexically and, when it exists, after following links: a changed symlink that
 * points outside the repository is refused rather than opened. A path that no longer exists keeps
 * the lexical answer, so the editor reports the missing file itself.
 */
export async function containedWorkingPath(repositoryRoot: string, file: string): Promise<ContainedPath> {
  const repository = path.resolve(repositoryRoot);
  const target = path.resolve(repository, file);
  const inside = (candidate: string, root: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  if (!file || path.isAbsolute(file) || !inside(target, repository)) {
    return { target: null, refusal: 'The selected path resolves outside the governed repository and was not opened.' };
  }
  let real: string;
  try { real = await realpath(target); } catch { return { target, refusal: null }; }
  const realRepository = await realpath(repository).catch(() => repository);
  if (!inside(real, realRepository)) {
    return { target: null, refusal: 'The selected path is a link that resolves outside the governed repository and was not opened.' };
  }
  return { target, refusal: null };
}
