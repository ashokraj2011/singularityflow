/**
 * Imported configuration: agent skills, artifact templates, whole agents and generated-artifact
 * sources taken from a link.
 *
 * The model, in one place:
 * - Preview fetches once, checks the content for what it will be used as, and stages the exact bytes
 *   with provenance written by this engine under `.git/singularity-flow/imports/staged/`.
 * - An add names the SHA-256 that was previewed. Workflow Studio applies it as a change-set
 *   operation, from the staged bytes (or a fresh fetch that must produce the same hash), and the
 *   bytes are copied ("vendored") into the approved configuration in the same reviewed change.
 *   Nothing fetches them again: Stories, other machines and CI read the vendored copy, and a
 *   reviewer reads the content itself in the proposal's diff.
 * - `singularity/imports.lock.yml` records where each import came from, so `imports check` can say
 *   when the source has changed. Updating is another reviewed import, never a silent refresh.
 */
import path from 'node:path';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { AGENT_VENDOR_ROOT, parseAgentDependencies } from './agents.mjs';
import { validateArtifactTemplateText } from './config.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { repositoryGitPath } from './git-directory.mjs';
import {
  DEFAULT_REMOTE_MAX_BYTES, HARD_REMOTE_MAX_BYTES, decodeUtf8, fetchRemoteBytes, sha256Hex,
  validatePublicHttpsUrl
} from './remote-fetch.mjs';
import {
  configuredMarketplaces, fetchMarketplaceIndex, requireMarketplace, selectMarketplaceEntry
} from './marketplace.mjs';
import { scanText, secretRefusal } from './secrets.mjs';
import { SingularityFlowError, YAML_OUTPUT, nowIso, secureRepositoryPath, snapshot } from './util.mjs';

export const IMPORTS_LOCK_PATH = 'singularity/imports.lock.yml';
export const IMPORTS_VENDOR_ROOT = 'singularity/imports';
export const IMPORTED_TEMPLATE_DIRECTORY = 'imported';
/** What a fetched document can be used as. Generated artifacts are a source, not content. */
export const IMPORT_CONTENT_KINDS = Object.freeze(['skill', 'template', 'agent']);
const STAGED_FORMAT = 'sflow-import-staged@1';
const PREVIEW_TEXT_LIMIT = 64 * 1024;
const STAGED_KEEP = 64;
const STAGED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const AGENT_FILE_LIMIT = 64 * 1024;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GENERATED_TOKENS = Object.freeze(['workId', 'workType', 'phase', 'generation']);

/** The agent Markdown tables an import can add a row to, in the exact shape the parser reads. */
export const AGENT_RESOURCE_TABLES = Object.freeze({
  skill: Object.freeze({ heading: 'Remote skills', columns: Object.freeze(['ID', 'URL', 'Phases', 'Optional', 'Max bytes']) }),
  template: Object.freeze({ heading: 'Remote artifact templates', columns: Object.freeze(['ID', 'URL', 'Phases', 'Optional', 'Max bytes']) }),
  generated: Object.freeze({ heading: 'Remote generated artifacts', columns: Object.freeze(['ID', 'URL template', 'Phase', 'Target', 'Optional', 'Max bytes']) })
});

function fail(message, code, details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export function requireImportId(value, label) {
  const id = String(value ?? '').trim();
  if (!ID.test(id)) throw fail(`${label} must be lower-case kebab-case, like security-checklist.`, 'IMPORT_ID_INVALID');
  return id;
}

export function requireSha256(value) {
  const sha256 = String(value ?? '').trim().toLowerCase().replace(/^sha256:/, '');
  if (!SHA256.test(sha256)) throw fail('Name the previewed content by its 64-character SHA-256 (--sha256).', 'IMPORT_SHA256_REQUIRED');
  return sha256;
}

// ---------------------------------------------------------------------------------------------
// References

/**
 * What an import names: a public HTTPS link, or `market:<marketplace>/<entry>[@version]` in a
 * marketplace this repository trusts. Both resolve to bytes to fetch and the provenance to record.
 */
export function parseImportReference(value) {
  const text = String(value ?? '').trim();
  if (!text) throw fail('Name what to import: a public https:// link, or market:<marketplace>/<entry>.', 'IMPORT_REFERENCE_REQUIRED');
  const market = /^market:([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:@([0-9A-Za-z][0-9A-Za-z.+-]{0,63}))?$/.exec(text);
  if (market) return Object.freeze({ kind: 'marketplace', marketplace: market[1], entry: market[2], version: market[3] ?? null, display: text });
  if (text.startsWith('market:')) throw fail(`'${text}' is not a marketplace reference; use market:<marketplace>/<entry> or market:<marketplace>/<entry>@<version>.`, 'IMPORT_REFERENCE_UNSUPPORTED');
  if (/^https:\/\//i.test(text)) {
    if (text.includes('|')) throw fail('An import link cannot contain "|"; use its percent-encoded form.', 'IMPORT_REFERENCE_UNSUPPORTED');
    validatePublicHttpsUrl(text, 'The import link');
    return Object.freeze({ kind: 'url', url: text, display: text });
  }
  throw fail(`'${text}' is not something Singularity Flow can import from. Use a public https:// link to the raw file.`, 'IMPORT_REFERENCE_UNSUPPORTED');
}

/** The marketplace entry a reference names, checked against the repository's trust. */
export async function resolveMarketplaceReference(root, reference, { fetchImpl = globalThis.fetch } = {}) {
  const marketplace = requireMarketplace(await configuredMarketplaces(root), reference.marketplace);
  const index = await fetchMarketplaceIndex(marketplace, { fetchImpl });
  return { marketplace, index, entry: selectMarketplaceEntry(index, marketplace.id, reference.entry, reference.version) };
}

async function fetchReference(root, reference, { fetchImpl = globalThis.fetch, maxBytes = DEFAULT_REMOTE_MAX_BYTES } = {}) {
  if (reference.kind === 'marketplace') {
    const { marketplace, index, entry } = await resolveMarketplaceReference(root, reference, { fetchImpl });
    if (!entry.url) {
      throw fail(`Marketplace entry '${entry.id}' is a ${entry.kind} source, not content; add it with --as ${entry.kind}.`, 'IMPORT_KIND_INVALID');
    }
    const fetched = await fetchRemoteBytes(entry.url, {
      maxBytes: entry.bytes ? Math.min(entry.bytes, HARD_REMOTE_MAX_BYTES) : maxBytes, fetchImpl, label: 'Marketplace content'
    });
    if (fetched.sha256 !== entry.sha256) {
      throw fail(`Marketplace '${marketplace.id}' publishes ${entry.id}@${entry.version} as ${entry.sha256.slice(0, 12)}, but its file is ${fetched.sha256.slice(0, 12)}. Nothing was imported; tell the marketplace's owner.`, 'MARKETPLACE_CONTENT_MISMATCH');
    }
    return {
      bytes: fetched.bytes,
      entry,
      source: {
        kind: 'marketplace', marketplace: marketplace.id, index: marketplace.index, indexSha256: index.indexSha256,
        entry: entry.id, version: entry.version, url: entry.url, resolvedUrl: fetched.resolvedUrl
      }
    };
  }
  if (reference.kind === 'url') {
    const fetched = await fetchRemoteBytes(reference.url, {
      maxBytes, fetchImpl, label: 'Import',
      accept: 'text/markdown,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1'
    });
    return { bytes: fetched.bytes, source: { kind: 'url', url: reference.url, resolvedUrl: fetched.resolvedUrl } };
  }
  throw fail(`Unsupported import source '${reference.kind}'.`, 'IMPORT_REFERENCE_UNSUPPORTED');
}

// ---------------------------------------------------------------------------------------------
// Content checks

function frontmatterOf(text) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(normalized);
  if (!opening) return null;
  const remainder = normalized.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder);
  if (!closing) return null;
  try {
    const value = YAML.parse(remainder.slice(0, closing.index));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** The likeliest use of fetched text: an agent file, an artifact template, or a skill. */
export function suggestImportKind(text) {
  const frontmatter = frontmatterOf(text);
  const metadata = frontmatter?.metadata;
  if (frontmatter && (Array.isArray(frontmatter.tools)
      || (metadata && typeof metadata === 'object' && Object.keys(metadata).some((key) => key.startsWith('sflow-'))))) return 'agent';
  if (/\{\{\s*(?:work\.|phase\.|inputs\s*\}\})/.test(text)) return 'template';
  return 'skill';
}

function headings(text) {
  return text.split(/\r?\n/).filter((line) => /^#{1,3}\s+\S/.test(line)).map((line) => line.trim()).slice(0, 24);
}

/**
 * Check fetched text for the use it is being imported as. Returns what a person reviews before
 * adding it (`details`, `warnings`) and the ID it suggests; refuses what could never be used.
 */
export function inspectImportContent(kind, text, { id = null, label = 'The imported content' } = {}) {
  if (!IMPORT_CONTENT_KINDS.includes(kind)) {
    throw fail(`Import as one of: ${IMPORT_CONTENT_KINDS.join(', ')}.`, 'IMPORT_KIND_INVALID');
  }
  if (!text.trim()) throw fail(`${label} is empty.`, 'IMPORT_CONTENT_EMPTY');
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) {
    throw fail(`${label} is a web page, not Markdown. Use the link to the raw file.`, 'IMPORT_NOT_MARKDOWN');
  }
  if (text.includes('\0')) throw fail(`${label} contains NUL bytes; only text can be imported.`, 'IMPORT_NOT_MARKDOWN');
  const scan = { blocking: scanText(text, { path: label }).filter((finding) => !finding.waived), waived: [] };
  if (scan.blocking.length) throw fail(secretRefusal(scan), 'IMPORT_SECRET_DETECTED');
  const frontmatter = frontmatterOf(text);
  const warnings = [];
  if (kind === 'skill') {
    const suggested = typeof frontmatter?.name === 'string' && ID.test(frontmatter.name.trim()) ? frontmatter.name.trim() : null;
    return {
      id: id ?? suggested,
      details: {
        name: typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : null,
        description: typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : null,
        headings: headings(text)
      },
      warnings
    };
  }
  if (kind === 'template') {
    try { validateArtifactTemplateText(text, {}, 'imported'); }
    catch (error) { throw fail(error.message.replace("for phase 'imported' ", ''), 'IMPORT_TEMPLATE_INVALID'); }
    const tokens = [...new Set(text.match(/\{\{[^{}\r\n]+\}\}/g) ?? [])];
    if (!tokens.length) warnings.push('This template uses no {{work.*}} or {{phase.*}} values, so every Story starts from the same text.');
    return { id, details: { tokens, headings: headings(text) }, warnings };
  }
  // An agent's governed ID comes from its own file; the target file name only matters when the file
  // gives a display name instead of a kebab-case ID.
  if (Buffer.byteLength(text, 'utf8') > AGENT_FILE_LIMIT) throw fail(`${label} is larger than ${AGENT_FILE_LIMIT} bytes; an agent file is instructions, not a document.`, 'IMPORT_AGENT_INVALID');
  const fileId = id ?? (typeof frontmatter?.name === 'string' && ID.test(frontmatter.name.trim()) ? frontmatter.name.trim()
    : String(frontmatter?.name ?? '').trim().toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'imported-agent');
  let parsed;
  try { parsed = parseAgentDependencies(text, { source: `.github/agents/${fileId}.agent.md` }); }
  catch (error) { throw fail(`${label} is not a usable agent file: ${error.message}`, 'IMPORT_AGENT_INVALID'); }
  if (id && parsed.id !== id) {
    throw fail(`This agent file names itself '${parsed.id}', so it cannot be imported as '${id}'.`, 'IMPORT_AGENT_ID_MISMATCH');
  }
  if (parsed.dependencies.length) {
    warnings.push(`This agent names ${parsed.dependencies.length} remote resource(s) of its own; after it is published, trust them with singularity-flow agents lock ${parsed.id}.`);
  }
  if (parsed.defaultFor.length) {
    warnings.push(`This agent wants to draft ${parsed.defaultFor.join(', ')} by default; each step keeps exactly one default agent, so choose which one drafts it.`);
  }
  return {
    id: parsed.id,
    details: {
      label: parsed.label, description: parsed.description, tools: parsed.tools, phases: parsed.phases,
      defaultFor: parsed.defaultFor, views: parsed.worldModelViews, remoteResources: parsed.dependencies.length
    },
    warnings
  };
}

// ---------------------------------------------------------------------------------------------
// Staging

function stagedDirectory(root) { return repositoryGitPath(root, 'singularity-flow', 'imports', 'staged'); }

async function pruneStaged(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try { files.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { /* removed concurrently */ }
  }
  files.sort((left, right) => right.mtime - left.mtime);
  const now = Date.now();
  for (const [index, entry] of files.entries()) {
    if (index >= STAGED_KEEP || now - entry.mtime > STAGED_MAX_AGE_MS) await rm(entry.file, { force: true });
  }
}

/** Keep exact previewed bytes with the provenance this engine observed, keyed by their SHA-256. */
export async function stageImport(root, { bytes, source }) {
  const sha256 = sha256Hex(bytes);
  const directory = stagedDirectory(root);
  await mkdir(directory, { recursive: true });
  const record = { format: STAGED_FORMAT, sha256, size: bytes.length, source, fetchedAt: nowIso(), content: bytes.toString('base64') };
  await writeFile(path.join(directory, `${sha256}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await pruneStaged(directory);
  return { sha256, size: bytes.length, source, fetchedAt: record.fetchedAt };
}

/** Staged bytes for `sha256`, verified against it, or null when none are staged. */
export async function readStagedImport(root, sha256) {
  let record;
  try { record = JSON.parse(await readFile(path.join(stagedDirectory(root), `${requireSha256(sha256)}.json`), 'utf8')); }
  catch { return null; }
  if (record?.format !== STAGED_FORMAT || typeof record.content !== 'string') return null;
  const bytes = Buffer.from(record.content, 'base64');
  if (sha256Hex(bytes) !== sha256) return null;
  return { sha256, size: bytes.length, bytes, source: record.source, fetchedAt: record.fetchedAt };
}

/**
 * Fetch, check and stage something to import. Nothing in the repository changes; the result is what
 * a person reviews, and its `sha256` is what an add names.
 */
export async function previewImport(root, value, { as = null, id = null, fetchImpl = globalThis.fetch, maxBytes = DEFAULT_REMOTE_MAX_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_REMOTE_MAX_BYTES) {
    throw fail(`--max-bytes must be between 1 and ${HARD_REMOTE_MAX_BYTES}.`, 'IMPORT_LIMIT_INVALID');
  }
  const reference = parseImportReference(value);
  const fetched = await fetchReference(root, reference, { fetchImpl, maxBytes });
  const text = decodeUtf8(fetched.bytes, `The content at ${reference.display}`);
  const suggestedAs = fetched.entry?.kind ?? suggestImportKind(text);
  if (fetched.entry && as && as !== fetched.entry.kind) {
    throw fail(`Marketplace entry '${fetched.entry.id}' is published as a ${fetched.entry.kind}; import it as one.`, 'IMPORT_KIND_INVALID');
  }
  const kind = as ?? suggestedAs;
  const inspection = inspectImportContent(kind, text, { id, label: `The content at ${reference.display}` });
  const staged = await stageImport(root, fetched);
  const truncated = text.length > PREVIEW_TEXT_LIMIT;
  return {
    schemaVersion: 1,
    resultType: 'import-preview',
    reference: reference.display,
    as: kind,
    suggestedAs,
    id: inspection.id ?? null,
    source: fetched.source,
    sha256: staged.sha256,
    bytes: staged.size,
    fetchedAt: staged.fetchedAt,
    text: truncated ? text.slice(0, PREVIEW_TEXT_LIMIT) : text,
    truncated,
    details: inspection.details,
    warnings: inspection.warnings,
    ...(fetched.entry ? {
      marketplace: {
        id: fetched.source.marketplace, entry: fetched.entry.id, version: fetched.entry.version,
        label: fetched.entry.label, description: fetched.entry.description, phases: fetched.entry.phases
      }
    } : {})
  };
}

/** The import operations of a Studio change set, keyed by the content they name. */
export function changeSetImportOperations(changeSet) {
  return (Array.isArray(changeSet?.changes) ? changeSet.changes : [])
    .filter((change) => ['import.skill', 'import.template', 'import.agent'].includes(change?.op));
}

/**
 * The exact bytes every import operation names: staged ones, or a fresh fetch from the operation's
 * own source that must produce the same SHA-256. Resolve these in the checkout where previews ran,
 * before a proposal clone is made.
 */
export async function resolveChangeSetImports(root, changeSet, { fetchImpl = globalThis.fetch } = {}) {
  const resolved = new Map();
  for (const change of changeSetImportOperations(changeSet)) {
    const sha256 = requireSha256(change.sha256);
    if (resolved.has(sha256)) continue;
    const staged = await readStagedImport(root, sha256);
    if (staged) { resolved.set(sha256, staged); continue; }
    const reference = parseImportReference(change.source);
    const fetched = await fetchReference(root, reference, { fetchImpl, maxBytes: HARD_REMOTE_MAX_BYTES });
    const actual = sha256Hex(fetched.bytes);
    if (actual !== sha256) {
      throw fail(`The content at ${reference.display} changed since it was previewed (now ${actual.slice(0, 12)}, previewed ${sha256.slice(0, 12)}). Preview it again and review the new content.`, 'IMPORT_CONTENT_CHANGED', { expected: sha256, actual });
    }
    resolved.set(sha256, { ...(await stageImport(root, fetched)), bytes: fetched.bytes });
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// Ledger

export function importLedgerKey(kind, { agent = null, id }) {
  return ['skill', 'generated'].includes(kind) ? `${kind}:${agent}/${id}` : `${kind}:${id}`;
}

export function parseImportsLedger(text, label = IMPORTS_LOCK_PATH) {
  let value;
  try { value = YAML.parse(text) ?? {}; } catch (error) { throw fail(`${label} is not valid YAML: ${error.message}`, 'IMPORTS_LOCK_INVALID'); }
  if (value.version !== 1 || !value.imports || typeof value.imports !== 'object' || Array.isArray(value.imports)) {
    throw fail(`${label} must contain version: 1 and an imports map.`, 'IMPORTS_LOCK_INVALID');
  }
  for (const [key, entry] of Object.entries(value.imports)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.kind !== 'string' || !entry.source || typeof entry.source !== 'object') {
      throw fail(`${label} entry '${key}' must name its kind and source.`, 'IMPORTS_LOCK_INVALID');
    }
  }
  return value;
}

export async function loadImportsLedger(configRoot) {
  let text;
  try { text = await readFile(path.join(configRoot, IMPORTS_LOCK_PATH), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return { version: 1, imports: {} }; throw error; }
  return parseImportsLedger(text);
}

export function renderImportsLedger(ledger) {
  const imports = Object.fromEntries(Object.keys(ledger.imports).sort().map((key) => [key, ledger.imports[key]]));
  return [
    '# Where imported configuration came from. Written by Singularity Flow imports; review it with the',
    '# files it describes. `singularity-flow imports check` compares each source with what was imported.',
    YAML.stringify({ version: 1, imports }, YAML_OUTPUT).trimEnd(),
    ''
  ].join('\n');
}

/** The ledger entry for one import, from the staged provenance. */
export function ledgerEntry(kind, staged, target, extra = {}) {
  return {
    kind,
    target,
    source: staged.source,
    sha256: staged.sha256,
    bytes: staged.size,
    fetchedAt: staged.fetchedAt,
    ...extra
  };
}

// ---------------------------------------------------------------------------------------------
// Agent resource tables

function tableCells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()); }

function tableRow(values) { return `| ${values.join(' | ')} |`; }

/**
 * Add or replace one row in an agent's resource table, creating the table when the agent has none.
 * The rest of the instructions are left exactly as they were.
 */
export function upsertAgentTableRow(body, type, values, { replace = false } = {}) {
  const table = AGENT_RESOURCE_TABLES[type];
  if (!table) throw fail(`Agents have no '${type}' resource table.`, 'IMPORT_KIND_INVALID');
  if (values.length !== table.columns.length || values.some((value) => /[|\r\n]/.test(String(value)))) {
    throw fail(`A ${table.heading} row needs ${table.columns.length} cells without "|" or line breaks.`, 'IMPORT_ROW_INVALID');
  }
  const lines = String(body ?? '').replace(/\s+$/, '').split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${table.heading.toLowerCase()}`);
  const row = tableRow(values.map(String));
  if (headingIndex < 0) {
    return [...lines, '', `## ${table.heading}`, '', tableRow(table.columns), `|${table.columns.map(() => '---').join('|')}|`, row].join('\n').concat('\n');
  }
  let index = headingIndex + 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!lines[index]?.trim().startsWith('|') || !lines[index + 1]?.includes('---')) {
    throw fail(`The agent's '## ${table.heading}' heading is not followed by its table; fix the agent file first.`, 'IMPORT_ROW_INVALID');
  }
  let end = index + 2;
  let existing = -1;
  for (; end < lines.length && lines[end].trim().startsWith('|'); end += 1) {
    if (tableCells(lines[end])[0] === values[0]) existing = end;
  }
  if (existing >= 0) {
    if (!replace) throw fail(`This agent already has a ${table.heading.toLowerCase().replace('remote ', '')} row '${values[0]}'. Replace it deliberately, or choose another ID.`, 'IMPORT_TARGET_EXISTS');
    lines[existing] = row;
  } else lines.splice(end, 0, row);
  return `${lines.join('\n')}\n`;
}

/** Remove one row from an agent's resource table; the table heading stays. */
export function removeAgentTableRow(body, type, id) {
  const table = AGENT_RESOURCE_TABLES[type];
  const lines = String(body ?? '').split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${table.heading.toLowerCase()}`);
  if (headingIndex < 0) return null;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index])) break;
    if (lines[index].trim().startsWith('|') && tableCells(lines[index])[0] === id) {
      lines.splice(index, 1);
      return lines.join('\n');
    }
  }
  return null;
}

export function vendoredAgentResourcePath(agentId, type, id) {
  return `${AGENT_VENDOR_ROOT}/${agentId}/${type}-${id}.md`;
}

export function importedTemplateRelative(id) { return `${IMPORTED_TEMPLATE_DIRECTORY}/${id}.md`; }

export function validateGeneratedSource({ urlTemplate, phase, target }) {
  const url = validatePublicHttpsUrl(String(urlTemplate ?? '').trim(), 'The generated artifact URL template', { dynamic: true, allowedTokens: GENERATED_TOKENS });
  if (url.includes('|')) throw fail('A URL template cannot contain "|".', 'IMPORT_ROW_INVALID');
  const phaseId = requireImportId(phase, 'The step a generated artifact belongs to');
  const relative = path.posix.normalize(String(target ?? '').trim());
  if (!relative.startsWith(`artifacts/${phaseId}/`) || relative.split('/').includes('..') || !relative.endsWith('.md')) {
    throw fail(`A generated artifact is written to a Markdown file under artifacts/${phaseId}/.`, 'IMPORT_ROW_INVALID');
  }
  return { urlTemplate: url, phase: phaseId, target: relative };
}

export function textOf(bytes) { return decodeUtf8(bytes, 'Imported content'); }

// ---------------------------------------------------------------------------------------------
// Status and update checks

async function fileState(root, relative) {
  if (typeof relative !== 'string' || !relative) return { exists: false, sha256: null };
  const target = await secureRepositoryPath(root, relative, { label: 'Imported file', type: 'file' }).catch(() => null);
  if (!target?.exists) return { exists: false, sha256: null };
  return snapshot(target.absolute);
}

function sourceLabel(source) {
  if (source?.kind === 'marketplace') return `market:${source.marketplace}/${source.entry}@${source.version}`;
  return source?.url ?? source?.urlTemplate ?? source?.kind ?? 'unknown';
}

/**
 * Every import with what is on disk now. A vendored skill that was edited here is reported as such:
 * its agent refuses it, because the lock still names the imported bytes. Templates and agents may be
 * adapted after import; they are reported as edited or customized, not broken.
 */
export async function importsStatus(root) {
  const configRoot = configurationReadRoot(root);
  const ledger = await loadImportsLedger(configRoot);
  const rows = [];
  for (const key of Object.keys(ledger.imports).sort()) {
    const entry = ledger.imports[key];
    const target = entry.target ?? {};
    let status = 'current';
    if (entry.kind !== 'generated') {
      const state = await fileState(root, target.path);
      const expected = entry.fileSha256 ?? entry.sha256;
      status = !state.exists ? 'missing'
        : state.sha256 === expected ? 'current'
          : entry.kind === 'skill' ? 'edited (its agent refuses it until it is imported again)'
            : entry.kind === 'agent' ? 'customized' : 'edited here';
    }
    rows.push({ key, kind: entry.kind, status, source: sourceLabel(entry.source), sha256: entry.sha256 ?? null, bytes: entry.bytes ?? null, fetchedAt: entry.fetchedAt ?? null, target });
  }
  return rows;
}

function updateCommand(key, entry, sha256, reference = entry.source.url) {
  const target = entry.target ?? {};
  return ['singularity-flow import add', JSON.stringify(reference), `--as ${entry.kind}`,
    entry.kind === 'skill' ? `--agent ${target.agent}` : null,
    entry.kind !== 'agent' ? `--id ${target.id}` : null,
    entry.kind === 'skill' && target.phases?.length ? `--phases ${target.phases.join(',')}` : null,
    `--sha256 ${sha256}`, '--replace'].filter(Boolean).join(' ');
}

/**
 * Re-read every linked source and compare it with what was imported. A changed source is staged so
 * it can be reviewed and imported deliberately; nothing in the repository changes here.
 */
export async function checkImportSources(root, { fetchImpl = globalThis.fetch } = {}) {
  const configRoot = configurationReadRoot(root);
  const ledger = await loadImportsLedger(configRoot);
  const rows = [];
  for (const key of Object.keys(ledger.imports).sort()) {
    const entry = ledger.imports[key];
    if (entry.kind === 'generated') {
      rows.push({ key, status: 'not checked', detail: 'generated artifacts are fetched for each Story' });
      continue;
    }
    if (entry.source?.kind === 'marketplace') {
      let latest;
      try {
        latest = (await resolveMarketplaceReference(root, { marketplace: entry.source.marketplace, entry: entry.source.entry, version: null }, { fetchImpl })).entry;
      } catch (error) { rows.push({ key, status: 'unavailable', detail: error.message }); continue; }
      if (latest.sha256 === entry.sha256) { rows.push({ key, status: 'up to date', detail: `version ${entry.source.version}` }); continue; }
      const reference = `market:${entry.source.marketplace}/${latest.id}@${latest.version}`;
      try {
        const fetched = await fetchReference(root, parseImportReference(reference), { fetchImpl });
        await stageImport(root, fetched);
      } catch (error) { rows.push({ key, status: 'unavailable', detail: error.message }); continue; }
      rows.push({
        key, status: 'newer version available', detail: `${latest.version} (imported ${entry.source.version})`,
        sha256: latest.sha256, updateCommand: updateCommand(key, entry, latest.sha256, reference)
      });
      continue;
    }
    if (entry.source?.kind !== 'url' || typeof entry.source.url !== 'string') {
      rows.push({ key, status: 'not checked', detail: `${entry.source?.kind ?? 'this'} sources are checked by importing again` });
      continue;
    }
    let fetched;
    try { fetched = await fetchRemoteBytes(entry.source.url, { maxBytes: HARD_REMOTE_MAX_BYTES, fetchImpl, label: 'Import' }); }
    catch (error) { rows.push({ key, status: 'unavailable', detail: error.message }); continue; }
    if (fetched.sha256 === entry.sha256) { rows.push({ key, status: 'up to date', detail: null }); continue; }
    const staged = await stageImport(root, { bytes: fetched.bytes, source: { kind: 'url', url: entry.source.url, resolvedUrl: fetched.resolvedUrl } });
    rows.push({
      key, status: 'changed at its source',
      detail: `now ${staged.sha256.slice(0, 12)} (${staged.size} bytes); imported ${String(entry.sha256).slice(0, 12)}`,
      sha256: staged.sha256, updateCommand: updateCommand(key, entry, staged.sha256)
    });
  }
  return rows;
}
