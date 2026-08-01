/**
 * The product knowledge base: what previous work learned, decided, and left unresolved.
 *
 * Everything else in this tool is scoped to one work item or one initiative. Nothing carried a
 * finding from one Epic to the next, so each initiative began by rediscovering what the last one
 * already knew, and an open uncertainty died with the Epic that raised it. This store sits beside the
 * initiatives rather than inside any of them, and is append-only and content-addressed like every
 * other governed record, so an entry can be cited by hash and never silently rewritten.
 *
 * Harvesting is deliberately deterministic. The engine has no model in it — judgement belongs to the
 * agent, state belongs here — so entries are not summarised out of prose. They are read from the
 * tables the initiative artifact templates already ask for: "Learnings to carry forward", "Still
 * unknown", "Assumptions and unknowns", "Open questions". A row in one of those tables is already a
 * discrete, human-written claim; lifting it preserves the author's words and their provenance.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { identity } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError, nowIso, secureRepositoryPath, writeText } from './util.mjs';

export const KNOWLEDGE_ROOT = 'singularity/knowledge';
export const KNOWLEDGE_TYPES = new Set(['decision', 'learning', 'uncertainty', 'result']);

/**
 * Sections a governed artifact may be harvested from, and what each row means.
 *
 * Keyed by the heading text the artifact templates use. Only tables are harvested: a table row is a
 * claim its author already chose to separate, where a paragraph would have to be interpreted.
 */
const HARVEST_SECTIONS = new Map([
  ['learnings to carry forward', { type: 'learning' }],
  ['what we got wrong', { type: 'learning' }],
  ['decisions to revisit', { type: 'decision' }],
  ['options considered', { type: 'decision' }],
  ['still unknown', { type: 'uncertainty' }],
  ['assumptions and unknowns', { type: 'uncertainty' }],
  ['open questions', { type: 'uncertainty' }],
  ['unresolved concerns', { type: 'uncertainty' }],
  ['measured result', { type: 'result' }],
  ['hypothesis outcome', { type: 'result' }]
]);

function actorKey(actor) {
  return String(actor?.email ?? actor?.name ?? '').toLowerCase() || null;
}

async function recordsDirectory(root, { mustExist = false } = {}) {
  return secureRepositoryPath(root, path.join(KNOWLEDGE_ROOT, 'records'), {
    label: 'Knowledge record directory',
    type: 'directory',
    ...(mustExist ? { mustExist: true } : {})
  });
}

/** Append one entry. Content addressing makes recording the same claim twice a no-op. */
export async function recordKnowledge(root, {
  type,
  title,
  detail = null,
  status = null,
  tags = [],
  provenance = null,
  supersedes = null
} = {}) {
  if (!KNOWLEDGE_TYPES.has(type)) {
    throw new SingularityFlowError(`Knowledge type must be one of ${[...KNOWLEDGE_TYPES].join(', ')}.`);
  }
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) throw new SingularityFlowError('A knowledge entry requires a title.');
  // The identity of an entry is the claim, not the moment it was written down. Hashing the timestamp
  // too would give the same finding a new address every time, and harvesting is meant to be safe to
  // re-run — a second harvest of an unchanged artifact must add nothing.
  const claim = {
    schemaVersion: 1,
    type,
    title: cleanTitle,
    detail: detail ? String(detail).trim() : null,
    // Only an uncertainty carries a lifecycle; the others are statements of what was true at a point
    // in time and are superseded rather than closed.
    status: type === 'uncertainty' ? (status ?? 'open') : null,
    tags: [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].sort(),
    provenance: provenance ?? null,
    supersedes: supersedes ?? null
  };
  const sha256 = recordSha256(claim);
  const record = { ...claim, recordedAt: nowIso(), actor: actorKey(identity(root)) };
  await recordsDirectory(root);
  const target = await secureRepositoryPath(root, path.join(KNOWLEDGE_ROOT, 'records', `${sha256}.json`), {
    label: 'Knowledge record',
    type: 'file'
  });
  if (!target.exists) await writeText(target.absolute, canonicalJson(record));
  return { sha256, path: target.relative, record, created: !target.exists };
}

export async function readKnowledge(root) {
  const directory = await recordsDirectory(root);
  if (!directory.exists) return [];
  const entries = [];
  for (const file of await readdir(directory.absolute, { withFileTypes: true })) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    const target = await secureRepositoryPath(root, path.join(KNOWLEDGE_ROOT, 'records', file.name), {
      label: 'Knowledge record', mustExist: true, type: 'file'
    });
    const raw = await readFile(target.absolute, 'utf8');
    let record;
    try { record = JSON.parse(raw); }
    catch (error) { throw new SingularityFlowError(`Invalid knowledge record ${file.name}: ${error.message}`); }
    entries.push({ sha256: file.name.slice(0, 64), record });
  }
  return entries.sort((left, right) => String(left.record.recordedAt).localeCompare(String(right.record.recordedAt)));
}

/**
 * Entries as they now stand: superseded ones drop out, and an uncertainty answered later reports as
 * resolved. Reading the raw records instead would show the same claim several times over.
 */
export function currentKnowledge(entries) {
  const superseded = new Set(entries.map(({ record }) => record.supersedes).filter(Boolean));
  const resolutions = new Map();
  for (const entry of entries) {
    if (entry.record.type === 'uncertainty' && entry.record.status === 'resolved' && entry.record.supersedes) {
      resolutions.set(entry.record.supersedes, entry);
    }
  }
  return entries
    .filter(({ sha256 }) => !superseded.has(sha256))
    .map((entry) => ({ ...entry, resolvedBy: null }))
    .concat([...resolutions.values()].map((entry) => ({ ...entry, resolvedBy: entry.sha256 })))
    .filter((entry, index, all) => all.findIndex((other) => other.sha256 === entry.sha256) === index);
}

export function filterKnowledge(entries, { type = null, status = null, tag = null, query = null } = {}) {
  const needle = query ? String(query).toLowerCase() : null;
  return entries.filter(({ record }) => {
    if (type && record.type !== type) return false;
    if (status && record.status !== status) return false;
    if (tag && !(record.tags ?? []).includes(tag)) return false;
    if (needle && !`${record.title} ${record.detail ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Mark an open uncertainty answered, without rewriting the original record. */
export async function resolveKnowledge(root, sha256, { resolution, tags = [] } = {}) {
  const entries = await readKnowledge(root);
  const target = entries.find((entry) => entry.sha256 === sha256 || entry.sha256.startsWith(sha256));
  if (!target) throw new SingularityFlowError(`No knowledge entry matches '${sha256}'.`);
  if (target.record.type !== 'uncertainty') throw new SingularityFlowError(`Only an uncertainty can be resolved; '${sha256}' is a ${target.record.type}.`);
  const text = String(resolution ?? '').trim();
  if (!text) throw new SingularityFlowError('Resolving an uncertainty requires the answer.');
  return recordKnowledge(root, {
    type: 'uncertainty',
    title: target.record.title,
    detail: text,
    status: 'resolved',
    tags: [...new Set([...(target.record.tags ?? []), ...tags])],
    provenance: target.record.provenance,
    supersedes: target.sha256
  });
}

/**
 * Harvest every approved output of an initiative, or of one phase.
 *
 * Only approved outputs are read: an unapproved artifact is still being argued over, and its claims
 * are not yet the organization's position. Each entry records the exact artifact hash it came from,
 * so a reader can always get back to the document that said it.
 */
export async function harvestInitiativeKnowledge(root, portfolio, initiative, { phaseId = null, dryRun = false } = {}) {
  const { secureInitiativePath } = await import('./initiative-state.mjs');
  const initiativeId = initiative.initiative.id;
  const phases = phaseId ? [phaseId] : initiative.phaseOrder;
  const candidates = [];
  for (const id of phases) {
    const phase = initiative.phases[id];
    if (!phase) continue;
    for (const output of Object.values(phase.outputs ?? {})) {
      if (output.status !== 'approved' || !output.sha256) continue;
      const target = await secureInitiativePath(root, portfolio, initiativeId, output.path, {
        label: `Initiative output '${id}/${output.id}'`, type: 'file'
      });
      if (!target.exists) continue;
      const markdown = await readFile(target.absolute, 'utf8');
      candidates.push(...harvestableEntries(markdown, {
        initiativeId, phase: id, output: output.id, path: output.path, sha256: output.sha256
      }));
    }
  }
  if (dryRun) return { harvested: [], skipped: candidates.length, candidates };
  const harvested = [];
  for (const candidate of candidates) {
    const result = await recordKnowledge(root, candidate);
    if (result.created) harvested.push(result);
  }
  return { harvested, skipped: candidates.length - harvested.length, candidates };
}

/** Split a Markdown table into rows of trimmed cells, ignoring the header and separator. */
function tableRows(block) {
  const rows = block.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
  if (rows.length < 2) return [];
  const body = rows.slice(1).filter((cells) => !cells.every((cell) => /^-*:?-*$/.test(cell) || cell === ''));
  return body.filter((cells) => cells.some((cell) => cell));
}

/**
 * Read harvestable claims out of one artifact.
 *
 * Empty template rows are skipped, so preparing an artifact and never filling it in contributes
 * nothing — only what a human actually wrote becomes knowledge.
 */
export function harvestableEntries(markdown, provenance = {}) {
  const found = [];
  const headings = [...String(markdown ?? '').matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const raw = headings[index][1].replace(/\{#[^}]*\}/g, '').replace(/["']/g, '').trim().toLowerCase();
    const section = HARVEST_SECTIONS.get(raw);
    if (!section) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length;
    for (const cells of tableRows(markdown.slice(start, end))) {
      const title = cells.find((cell) => cell) ?? '';
      if (!title) continue;
      const detail = cells.slice(cells.indexOf(title) + 1).filter(Boolean).join(' · ') || null;
      found.push({
        type: section.type,
        title,
        detail,
        provenance: { ...provenance, section: headings[index][1].trim() }
      });
    }
  }
  return found;
}
