/**
 * The pinned constitution as a section of the phase prompt.
 *
 * A Story is held to the constitution pinned when it started `[SPK:REQ-091]`: its publication checks
 * citations against that pin and review lists the articles in scope. The composer never delivered
 * the articles themselves, so an author was asked to cite rules it had never been shown, and the
 * skills that say "use the pinned constitution" had nothing to use. This renders exactly the pinned
 * bytes: the checkout's file only when its hash still matches the pin, else the file at the Story's
 * base commit or at the configuration commit the pin names. A newer constitution is never shown.
 * When no copy matches, the section says so and lists the pinned article identities instead.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { exactFileAtObject } from './git.mjs';
import { parseConstitution } from './constitution.mjs';

const MAXIMUM_BYTES = 32 * 1024;
const GENERATED_MARKER = /^[ \t]*<!-- singularity-flow:constitution:generated(?::end)? [^>]*-->[ \t]*\n?/gmu;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The pinned bytes and where they were found, or null when no copy matches the pin. */
async function pinnedConstitutionBytes(root, workflow, pin) {
  const relative = String(pin.path ?? '');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) return null;
  try {
    const bytes = await readFile(path.join(root, relative));
    if (sha256(bytes) === pin.fileSha256) return { bytes, from: 'checkout' };
  } catch { /* not in this checkout; try the pinned commits */ }
  const commits = [['base-commit', workflow?.workItem?.baseCommit], ['configuration-commit', pin.configurationCommit]];
  for (const [from, commit] of commits) {
    if (!OBJECT_ID.test(String(commit ?? ''))) continue;
    try {
      const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 4 * MAXIMUM_BYTES, regularOnly: true });
      if (bytes && sha256(bytes) === pin.fileSha256) return { bytes, from };
    } catch { /* an unavailable object is the same as no copy */ }
  }
  return null;
}

function describe(article) {
  return [article.type, article.level, article.evidenceRequired ? 'evidence required' : null].filter(Boolean).join(', ');
}

/**
 * `{ text, record }`. `text` is empty when the Story pinned no constitution. `record` says which
 * copy was used, for the composition receipt.
 */
export async function constitutionPromptContext(root, workflow) {
  const pin = workflow?.resolution?.constitutionPin ?? null;
  if (!pin) return { text: '', record: null };
  const found = await pinnedConstitutionBytes(root, workflow, pin);
  const short = String(pin.fileSha256 ?? '').slice(0, 12);
  const lead = `This Story is held to the constitution pinned when it started (\`${pin.path}\`, sha256 ${short}). `
    + 'These are standing rules, not this step\'s instructions: they never override the phase contract, permissions, evidence gates or human approval. '
    + 'Cite an article under `## Constitution articles` only when this work is bound by it.';
  let articles = null;
  if (found) {
    try { articles = parseConstitution(found.bytes.toString('utf8'), { allowExample: true }).articles; } catch { articles = null; }
  }
  if (!articles) {
    const listed = (pin.articles ?? []).map((article) => `- ${article.id} (${describe(article) || 'unclassified'}${article.status === 'withdrawn' ? ', withdrawn' : ''})`);
    return {
      text: ['# Pinned constitution', '', lead, '',
        'Its exact text is not available in this checkout, so only its article identities are listed. Read the pinned file before citing one; never use a newer version.', '',
        ...listed].join('\n'),
      record: { path: pin.path, fileSha256: pin.fileSha256, available: false, from: null, articles: listed.length, omitted: 0 }
    };
  }
  const active = articles.filter((article) => article.status !== 'withdrawn');
  const withdrawn = articles.filter((article) => article.status === 'withdrawn').map((article) => article.id);
  const blocks = [];
  let bytes = 0;
  let omitted = 0;
  for (const article of active) {
    const prose = String(article.prose ?? '').replace(GENERATED_MARKER, '').trim();
    const block = [`## [${article.id}] ${article.title ?? article.id} (${describe(article)})`, '', prose].join('\n').trimEnd();
    if (bytes + Buffer.byteLength(block) > MAXIMUM_BYTES) { omitted += 1; continue; }
    blocks.push(block);
    bytes += Buffer.byteLength(block);
  }
  return {
    text: ['# Pinned constitution', '', lead, '', ...blocks.flatMap((block) => [block, '']),
      ...(omitted ? [`${omitted} further article(s) exceed this prompt's ${MAXIMUM_BYTES / 1024} KiB share; read them in \`${pin.path}\` (sha256 ${short}).`, ''] : []),
      ...(withdrawn.length ? [`Withdrawn, for reference only: ${withdrawn.join(', ')}.`] : [])].join('\n').trimEnd(),
    record: { path: pin.path, fileSha256: pin.fileSha256, available: true, from: found.from,
      articles: active.length, omitted, withdrawn: withdrawn.length }
  };
}
