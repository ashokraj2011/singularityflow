/**
 * Approved, reusable engineering knowledge.
 *
 * Records are append-only, content-addressed, provenance-bound, and explicitly scoped.  The
 * deterministic recall function is intentionally conservative: a record is returned only when its
 * declared scope intersects the current work.  The model never decides what to recall.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { identity } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError, nowIso, secureRepositoryPath, snapshot, writeText } from './util.mjs';

export const KNOWLEDGE_ROOT = 'singularity/knowledge';
export const KNOWLEDGE_TYPES = new Set(['insight', 'decision', 'gotcha', 'constraint', 'uncertainty']);
const STATUS = new Set(['active', 'resolved', 'superseded']);
const SCOPE_KEYS = ['capabilities', 'repositories', 'paths', 'environments'];

const HARVEST_SECTIONS = new Map([
  ['learnings to carry forward', 'insight'], ['what we got wrong', 'gotcha'],
  ['decisions to revisit', 'decision'], ['options considered', 'decision'],
  ['still unknown', 'uncertainty'], ['assumptions and unknowns', 'uncertainty'],
  ['open questions', 'uncertainty'], ['unresolved concerns', 'uncertainty'],
  ['measured result', 'insight'], ['hypothesis outcome', 'insight']
]);

function actorKey(actor) {
  return String(actor?.email ?? actor?.name ?? '').toLowerCase() || null;
}

function values(value) {
  return [...new Set((Array.isArray(value) ? value : value == null ? [] : [value])
    .map((item) => String(item).trim()).filter(Boolean))].sort();
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new SingularityFlowError('Knowledge requires an explicit scope object.');
  }
  const result = Object.fromEntries(SCOPE_KEYS.map((key) => [key, values(scope[key])]).filter(([, list]) => list.length));
  if (!Object.keys(result).length) throw new SingularityFlowError('Knowledge scope must name at least one capability, repository, path, or environment.');
  return result;
}

function normalizeProvenance(provenance) {
  const items = Array.isArray(provenance) ? provenance : provenance ? [provenance] : [];
  if (!items.length) throw new SingularityFlowError('Knowledge requires approved artifact provenance.');
  return items.map((item) => {
    const normalized = {
      workId: String(item.workId ?? '').trim(), artifact: String(item.artifact ?? '').trim(),
      sha256: String(item.sha256 ?? '').trim(), approvedRevision: Number(item.approvedRevision)
    };
    if (!normalized.workId || !normalized.artifact || !/^[a-f0-9]{64}$/.test(normalized.sha256)
      || !Number.isInteger(normalized.approvedRevision) || normalized.approvedRevision < 0) {
      throw new SingularityFlowError('Knowledge provenance requires workId, artifact, a full SHA-256, and a non-negative approvedRevision.');
    }
    return normalized;
  });
}

async function approvedProvenance(root, provenance) {
  for (const item of provenance) {
    const candidates = [
      { kind: 'story', state: `singularity/work-items/${item.workId}/workflow.json`, base: `singularity/work-items/${item.workId}` },
      { kind: 'initiative', state: `singularity/initiatives/${item.workId}/state.json`, base: `singularity/initiatives/${item.workId}` }
    ];
    let matched = false;
    for (const candidate of candidates) {
      const statePath = await secureRepositoryPath(root, candidate.state, { label: 'Knowledge provenance state', type: 'file' });
      if (!statePath.exists) continue;
      const state = JSON.parse(await readFile(statePath.absolute, 'utf8'));
      for (const phase of Object.values(state.phases ?? {})) {
        const outputs = candidate.kind === 'story' ? (phase.artifacts ?? []) : Object.values(phase.outputs ?? {});
        for (const output of outputs) {
          const outputPath = String(output.path ?? '');
          if (!(outputPath === item.artifact || outputPath.endsWith(`/${item.artifact}`) || item.artifact.endsWith(`/${outputPath}`))) continue;
          const approved = phase.status === 'approved' || output.status === 'approved';
          const revision = Number(phase.generation ?? 0);
          if (!approved || revision !== item.approvedRevision || output.sha256 !== item.sha256) continue;
          const relative = outputPath.startsWith('singularity/') ? outputPath : path.posix.join(candidate.base, outputPath);
          const artifact = await secureRepositoryPath(root, relative, { label: 'Knowledge provenance artifact', mustExist: true, type: 'file' });
          if ((await snapshot(artifact.absolute)).sha256 !== item.sha256) {
            throw new SingularityFlowError(`Knowledge provenance artifact '${item.artifact}' no longer matches its approved hash.`);
          }
          matched = true;
        }
      }
    }
    if (!matched) throw new SingularityFlowError(`Knowledge provenance '${item.workId}:${item.artifact}@${item.approvedRevision}' is not an approved artifact revision.`);
  }
}

async function recordsDirectory(root) {
  return secureRepositoryPath(root, path.join(KNOWLEDGE_ROOT, 'records'), {
    label: 'Knowledge record directory', type: 'directory'
  });
}

function knowledgeCore(record) {
  // validFrom defaults to write time, so it is lifecycle metadata rather than
  // claim identity. Excluding it keeps an unchanged re-harvest idempotent.
  const { id: _id, createdAt: _createdAt, validFrom: _validFrom, ...core } = record;
  return core;
}

/** Append one schema-v2 entry. Recording the same claim twice is a no-op. */
export async function recordKnowledge(root, {
  type, text = null, title = null, detail = null, provenance, scope,
  status = 'active', validFrom = null, validUntil = null, supersedes = null,
  approvedSourceVerified = false
} = {}) {
  if (!KNOWLEDGE_TYPES.has(type)) throw new SingularityFlowError(`Knowledge type must be one of ${[...KNOWLEDGE_TYPES].join(', ')}.`);
  const cleanText = String(text ?? [title, detail].filter(Boolean).join(' — ')).trim();
  if (!cleanText) throw new SingularityFlowError('A knowledge entry requires text.');
  if (!STATUS.has(status)) throw new SingularityFlowError('Knowledge status must be active, resolved, or superseded.');
  if (supersedes != null && !/^[a-f0-9]{64}$/.test(supersedes)) throw new SingularityFlowError('Knowledge supersedes must be a full record SHA-256.');
  const normalizedProvenance = normalizeProvenance(provenance);
  const normalizedScope = normalizeScope(scope);
  if (!approvedSourceVerified) await approvedProvenance(root, normalizedProvenance);
  const core = {
    schemaVersion: 2, type, text: cleanText, provenance: normalizedProvenance,
    scope: normalizedScope, status, validFrom: validFrom ?? nowIso(),
    validUntil: validUntil ?? null, createdBy: actorKey(identity(root)), supersedes: supersedes ?? null
  };
  const sha256 = recordSha256(knowledgeCore(core));
  const record = { ...core, id: `K-${sha256.slice(0, 12)}`, createdAt: nowIso() };
  const directory = await recordsDirectory(root);
  const target = await secureRepositoryPath(root, path.join(directory.relative, `${sha256}.json`), {
    label: 'Knowledge record', type: 'file'
  });
  const created = !target.exists;
  if (created) await writeText(target.absolute, canonicalJson(record));
  return { sha256, path: target.relative, record, created };
}

export async function readKnowledgeWithDiagnostics(root) {
  const directory = await recordsDirectory(root);
  if (!directory.exists) return { entries: [], diagnostics: [] };
  const entries = []; const diagnostics = [];
  for (const file of await readdir(directory.absolute, { withFileTypes: true })) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    const target = await secureRepositoryPath(root, path.join(directory.relative, file.name), { label: 'Knowledge record', mustExist: true, type: 'file' });
    let record;
    try { record = JSON.parse(await readFile(target.absolute, 'utf8')); }
    catch (error) { throw new SingularityFlowError(`Invalid knowledge record ${file.name}: ${error.message}`); }
    if (record.schemaVersion !== 2) {
      diagnostics.push({ code: 'knowledge.legacy_ignored', path: target.relative, message: 'Schema-v1 knowledge is not recalled or migrated.' });
      continue;
    }
    const expected = recordSha256(knowledgeCore(record));
    if (expected !== file.name.slice(0, 64) || record.id !== `K-${expected.slice(0, 12)}`) {
      throw new SingularityFlowError(`Knowledge record ${file.name} failed its content-hash check.`);
    }
    entries.push({ sha256: expected, record });
  }
  entries.sort((left, right) => String(left.record.createdAt).localeCompare(String(right.record.createdAt)));
  return { entries, diagnostics };
}

export async function readKnowledge(root) {
  return (await readKnowledgeWithDiagnostics(root)).entries;
}

export function currentKnowledge(entries, { at = new Date() } = {}) {
  const superseded = new Set(entries.map(({ record }) => record.supersedes).filter(Boolean));
  const now = at.getTime();
  return entries.filter(({ sha256, record }) => !superseded.has(sha256)
    && record.status !== 'superseded'
    && Date.parse(record.validFrom) <= now
    && (record.validUntil == null || Date.parse(record.validUntil) > now));
}

function intersects(declared, active) {
  if (!declared?.length) return true;
  return declared.some((item) => active.some((candidate) => candidate === item
    || candidate.startsWith(`${item}/`) || item.startsWith(`${candidate}/`)));
}

/** Conservative deterministic recall. Every declared scope dimension must match. */
export function recallKnowledge(entries, context = {}) {
  const active = Object.fromEntries(SCOPE_KEYS.map((key) => [key, values(context[key])]));
  return currentKnowledge(entries).filter(({ record }) => SCOPE_KEYS.every((key) => intersects(record.scope[key], active[key])));
}

export function filterKnowledge(entries, { type = null, status = null, query = null } = {}) {
  const needle = query ? String(query).toLowerCase() : null;
  return entries.filter(({ record }) => (!type || record.type === type) && (!status || record.status === status)
    && (!needle || `${record.id} ${record.text}`.toLowerCase().includes(needle)));
}

export async function resolveKnowledge(root, sha256, { resolution } = {}) {
  const entries = await readKnowledge(root);
  const matches = entries.filter((entry) => entry.sha256 === sha256 || entry.sha256.startsWith(sha256));
  if (matches.length !== 1) throw new SingularityFlowError(matches.length ? `Knowledge hash '${sha256}' is ambiguous.` : `No knowledge entry matches '${sha256}'.`);
  const target = matches[0];
  if (target.record.type !== 'uncertainty') throw new SingularityFlowError(`Only an uncertainty can be resolved; '${sha256}' is a ${target.record.type}.`);
  const text = String(resolution ?? '').trim();
  if (!text) throw new SingularityFlowError('Resolving an uncertainty requires the answer.');
  return recordKnowledge(root, {
    type: 'uncertainty', text, status: 'resolved', provenance: target.record.provenance,
    scope: target.record.scope, supersedes: target.sha256, approvedSourceVerified: true
  });
}

export async function harvestInitiativeKnowledge(root, portfolio, initiative, { phaseId = null, dryRun = false } = {}) {
  const { secureInitiativePath } = await import('./initiative-state.mjs');
  const initiativeId = initiative.initiative.id;
  const phases = phaseId ? [phaseId] : initiative.phaseOrder;
  const capability = initiative.resolution?.capability?.id;
  const repositories = Object.keys(initiative.resolution?.repositories ?? {});
  // A profile without an explicit repository registry still belongs to the lead checkout.
  // Pin that checkout's stable local identifier instead of the synthetic "lead-repository"
  // label so deterministic recall can intersect it with the current repository context.
  const scope = capability
    ? { capabilities: [capability] }
    : { repositories: repositories.length ? repositories : [path.basename(root)] };
  const candidates = [];
  for (const id of phases) {
    const phase = initiative.phases[id]; if (!phase) continue;
    const phaseApproved = phase.status === 'approved';
    for (const output of Object.values(phase.outputs ?? {})) {
      if (!output.sha256 || (output.status !== 'approved' && !phaseApproved)) continue;
      const target = await secureInitiativePath(root, portfolio, initiativeId, output.path, { label: `Initiative output '${id}/${output.id}'`, type: 'file' });
      if (!target.exists) continue;
      candidates.push(...harvestableEntries(await readFile(target.absolute, 'utf8'), {
        workId: initiativeId, artifact: output.path, sha256: output.sha256,
        approvedRevision: phase.generation ?? 0, scope
      }));
    }
  }
  if (dryRun) return { harvested: [], skipped: candidates.length, candidates };
  const harvested = [];
  for (const candidate of candidates) {
    const result = await recordKnowledge(root, { ...candidate, approvedSourceVerified: true });
    if (result.created) harvested.push(result);
  }
  return { harvested, skipped: candidates.length - harvested.length, candidates };
}

function tableRows(block) {
  const rows = block.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
  if (rows.length < 2) return [];
  return rows.slice(1).filter((cells) => !cells.every((cell) => /^-*:?-*$/.test(cell) || cell === ''))
    .filter((cells) => cells.some(Boolean));
}

export function harvestableEntries(markdown, provenance = {}) {
  const found = []; const headings = [...String(markdown ?? '').matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index][1].replace(/\{#[^}]*\}/g, '').replace(/["']/g, '').trim();
    const type = HARVEST_SECTIONS.get(heading.toLowerCase()); if (!type) continue;
    const start = headings[index].index + headings[index][0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : String(markdown).length;
    for (const cells of tableRows(String(markdown).slice(start, end))) {
      const populated = cells.filter(Boolean); if (!populated.length) continue;
      found.push({
        type, text: populated.join(' — '),
        provenance: [{ workId: provenance.workId, artifact: provenance.artifact, sha256: provenance.sha256, approvedRevision: provenance.approvedRevision }],
        scope: provenance.scope
      });
    }
  }
  return found;
}
