/**
 * Marketplaces: catalogs of skills, templates, agents and generated-artifact sources that a
 * repository chooses to trust.
 *
 * Trust is configuration. `workflow.yml` names each marketplace, the HTTPS index it publishes and
 * any further origins its files may come from; the index itself can never widen that. Every entry
 * pins its content by SHA-256, so an import from a marketplace is verified against the index and
 * then vendored exactly like an import from a link.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { decodeUtf8, fetchRemoteBytes, validatePublicHttpsUrl } from './remote-fetch.mjs';
import { SingularityFlowError } from './util.mjs';

export const MARKETPLACE_INDEX_FORMAT = 'sflow-marketplace@1';
/** Entry kinds this build can import; others are listed but not offered. */
export const MARKETPLACE_IMPORT_KINDS = Object.freeze(['skill', 'template', 'agent', 'generated', 'mcp-server']);
const MARKETPLACE_KINDS = new Set([...MARKETPLACE_IMPORT_KINDS, 'workflow', 'mcp-server']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INDEX_MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const GENERATED_TOKENS =
  Object.freeze(['workId', 'workType', 'phase', 'generation']);
// The same path config.mjs owns; repeated here because config.mjs normalizes marketplaces.
const WORKFLOW_PATH = 'singularity/workflow.yml';

function fail(message, code = 'MARKETPLACE_INVALID', details = undefined) {
  return new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function origin(url) { return new URL(url.replace(/\{[^}]+\}/g, 'value')).origin; }

function text(value, label, max) {
  if (value == null) return null;
  const result = String(value).replace(/\s+/g, ' ').trim();
  if (!result || result.length > max) throw fail(`${label} must be 1 to ${max} characters.`);
  return result;
}

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const REF = /^(?![./-])(?!.*(?:\.\.|@\{|[~^:?*\\[]))(?!.*\/\.)(?!.*[/.]$)[^\s\u0000-\u001f\u007f]{1,200}$/u;

/**
 * A marketplace's Git repository as configuration holds it: an https or ssh URL, `user@host:path`, or an absolute
 * local path, with no password in it. The full transport check runs when it is read (git.mjs withRemoteCommitSnapshot).
 */
export function marketplaceRepositoryValue(value, label) {
  const remote = String(value ?? '').trim();
  const usable = remote.length > 0 && remote.length <= 1000 && !/[\s\u0000-\u001f\u007f]/u.test(remote) && !remote.startsWith('-')
    && (/^https:\/\/[^/@:\s]+(?::\d+)?\/\S+$/u.test(remote) || /^ssh:\/\/(?:[^/@:\s]+@)?[^/@:\s]+(?::\d+)?\/\S+$/u.test(remote)
      || /^[^/@:\s]+@[^/:\s]+:\S+$/u.test(remote) || /^\/\S*[^/]$/u.test(remote) || /^[A-Za-z]:[\\/]\S+$/u.test(remote));
  if (!usable) throw fail(`${label} must be an https or ssh Git URL, user@host:path, or an absolute folder path, with no password in it.`);
  return remote;
}

function repositoryMarketplace(id, entry) {
  for (const key of Object.keys(entry)) {
    if (!['label', 'repository', 'ref', 'commit'].includes(key)) throw fail(`Marketplace '${id}' contains unknown field '${key}'${key === 'index' ? ': a marketplace is a Git repository or an index, not both' : ''}.`);
  }
  const repository = marketplaceRepositoryValue(entry.repository, `Marketplace '${id}' repository`);
  const ref = entry.ref == null ? null : String(entry.ref);
  if (ref != null && !REF.test(ref)) throw fail(`Marketplace '${id}' ref must be a branch or tag name.`);
  const commit = String(entry.commit ?? '').toLowerCase();
  if (!COMMIT.test(commit)) throw fail(`Marketplace '${id}' must pin the commit it is read at (commit: the full commit ID).`);
  return Object.freeze({
    id, label: text(entry.label, `Marketplace '${id}' label`, 120) ?? id, repository, ref, commit, allowedOrigins: Object.freeze([])
  });
}

/**
 * The `marketplaces:` configuration: id → { label, index, allowedOrigins } for a compiled index, or
 * { label, repository, ref, commit } for a Git repository with an APM manifest at its root (marketplace-repository.mjs),
 * read at that pinned commit. A repository marketplace has no allowed origins: nothing is fetched from outside it.
 */
export function normalizeMarketplaces(value = {}) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('marketplaces must be an object of marketplace ID to its index or repository.');
  const normalized = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!ID.test(id)) throw fail(`Marketplace '${id}' must use lower-case kebab-case.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(`Marketplace '${id}' must be an object.`);
    if (Object.hasOwn(entry, 'repository')) { normalized[id] = repositoryMarketplace(id, entry); continue; }
    for (const key of Object.keys(entry)) {
      if (!['label', 'index', 'allowedOrigins'].includes(key)) throw fail(`Marketplace '${id}' contains unknown field '${key}'.`);
    }
    const index = validatePublicHttpsUrl(String(entry.index ?? ''), `Marketplace '${id}' index`);
    const allowedOrigins = (entry.allowedOrigins ?? []).map((candidate, position) => {
      const url = validatePublicHttpsUrl(String(candidate ?? ''), `Marketplace '${id}' allowedOrigins[${position}]`);
      const parsed = new URL(url);
      if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw fail(`Marketplace '${id}' allowedOrigins[${position}] must be an origin such as https://cdn.example.org.`);
      return parsed.origin;
    });
    if (!Array.isArray(entry.allowedOrigins ?? [])) throw fail(`Marketplace '${id}' allowedOrigins must be a list.`);
    normalized[id] = Object.freeze({
      id, label: text(entry.label, `Marketplace '${id}' label`, 120) ?? id, index,
      allowedOrigins: Object.freeze([...new Set(allowedOrigins)])
    });
  }
  return normalized;
}

/** The marketplaces the effective configuration trusts, read without loading the whole definition. */
export async function configuredMarketplaces(root) {
  let raw;
  try { raw = YAML.parse(await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8')) ?? {}; }
  catch (error) { throw fail(`Cannot read the configured marketplaces: ${error.message}`, 'MARKETPLACE_CONFIGURATION_UNREADABLE'); }
  return normalizeMarketplaces(raw.marketplaces ?? {});
}

export function requireMarketplace(marketplaces, id) {
  const marketplace = marketplaces[id];
  if (!marketplace) {
    const known = Object.keys(marketplaces);
    throw fail(`This repository does not trust a marketplace called '${id}'.${known.length ? ` Configured: ${known.join(', ')}.` : ' Add one with singularity-flow marketplace add.'}`, 'MARKETPLACE_UNKNOWN');
  }
  return marketplace;
}

function compareVersions(left, right) {
  const parts = (value) => String(value).split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const a = parts(left); const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0; const y = b[index] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/**
 * Parse and check a marketplace index against the marketplace's configured trust. Entries whose
 * files would come from an origin the repository did not allow are refused, not filtered.
 */
export function parseMarketplaceIndex(bytes, marketplace) {
  let index;
  try { index = JSON.parse(decodeUtf8(bytes, `Marketplace '${marketplace.id}' index`)); }
  catch (error) { throw fail(`Marketplace '${marketplace.id}' index is not valid JSON: ${error.message}`); }
  if (!index || typeof index !== 'object' || index.format !== MARKETPLACE_INDEX_FORMAT || !Array.isArray(index.entries)) {
    throw fail(`Marketplace '${marketplace.id}' index must be a ${MARKETPLACE_INDEX_FORMAT} document with an entries list.`);
  }
  if (index.entries.length > MAX_ENTRIES) throw fail(`Marketplace '${marketplace.id}' lists more than ${MAX_ENTRIES} entries.`);
  const allowed = new Set([origin(marketplace.index), ...marketplace.allowedOrigins]);
  const seen = new Set();
  const entries = [];
  const ignored = [];
  index.entries.forEach((raw, position) => {
    const label = `Marketplace '${marketplace.id}' entry ${position + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(`${label} must be an object.`);
    if (!MARKETPLACE_KINDS.has(raw.kind)) { ignored.push(String(raw.id ?? position + 1)); return; }
    if (!ID.test(String(raw.id ?? ''))) throw fail(`${label} needs a lower-case kebab-case id.`);
    const version = text(raw.version ?? '0', `${label} version`, 64);
    const key = `${raw.kind}:${raw.id}@${version}`;
    if (seen.has(key)) throw fail(`${label} repeats ${key}.`);
    seen.add(key);
    const entry = {
      id: raw.id, kind: raw.kind, version,
      label: text(raw.label, `${label} label`, 120) ?? raw.id,
      description: text(raw.description, `${label} description`, 500),
      tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)).filter((tag) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)).slice(0, 12) : [],
      phases: Array.isArray(raw.phases) ? raw.phases.map(String).filter((phase) => ID.test(phase)).slice(0, 32) : []
    };
    if (raw.kind === 'generated') {
      entry.urlTemplate = validatePublicHttpsUrl(String(raw.urlTemplate ?? ''), `${label} urlTemplate`, { dynamic: true, allowedTokens: GENERATED_TOKENS });
      if (!allowed.has(origin(entry.urlTemplate))) throw fail(`${label} fetches from ${origin(entry.urlTemplate)}, which marketplace '${marketplace.id}' is not allowed to use.`, 'MARKETPLACE_ORIGIN_REFUSED');
      entry.phase = String(raw.phase ?? '');
      entry.target = String(raw.target ?? '');
      if (!ID.test(entry.phase)) throw fail(`${label} names an invalid phase.`);
    } else {
      entry.url = validatePublicHttpsUrl(String(raw.url ?? ''), `${label} url`);
      if (!allowed.has(origin(entry.url))) throw fail(`${label} is served from ${origin(entry.url)}, which marketplace '${marketplace.id}' is not allowed to use.`, 'MARKETPLACE_ORIGIN_REFUSED');
      const sha256 = String(raw.sha256 ?? '').toLowerCase().replace(/^sha256:/, '');
      if (!SHA256.test(sha256)) throw fail(`${label} must pin its content with a sha256.`);
      entry.sha256 = sha256;
      if (raw.bytes != null) {
        if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 1) throw fail(`${label} bytes must be a positive whole number.`);
        entry.bytes = raw.bytes;
      }
    }
    entries.push(Object.freeze(entry));
  });
  return Object.freeze({
    format: MARKETPLACE_INDEX_FORMAT,
    name: text(index.name, `Marketplace '${marketplace.id}' name`, 120) ?? marketplace.label,
    publisher: text(index.publisher, `Marketplace '${marketplace.id}' publisher`, 120),
    entries: Object.freeze(entries),
    ignored: Object.freeze(ignored)
  });
}

export async function fetchMarketplaceIndex(marketplace, { fetchImpl = globalThis.fetch } = {}) {
  if (marketplace.repository) {
    // A Git repository marketplace has no index of files to import one by one: its agents become workflows.
    throw fail(`Marketplace '${marketplace.id}' is a Git repository, which has no index of files to import one by one. `
      + `See what it has with singularity-flow marketplace browse ${marketplace.id}: it lists the command that turns each of its agents into a workflow.`,
    'MARKETPLACE_REPOSITORY_NOT_INDEX', { marketplace: marketplace.id, nextAction: `singularity-flow marketplace browse ${marketplace.id}` });
  }
  const fetched = await fetchRemoteBytes(marketplace.index, {
    maxBytes: INDEX_MAX_BYTES, fetchImpl, label: `Marketplace '${marketplace.id}' index`, accept: 'application/json'
  });
  return { ...parseMarketplaceIndex(fetched.bytes, marketplace), indexSha256: fetched.sha256, resolvedIndex: fetched.resolvedUrl };
}

/** The entry an import names: an exact version, or the newest version of that ID. */
export function selectMarketplaceEntry(index, marketplaceId, entryId, version = null) {
  const candidates = index.entries.filter((entry) => entry.id === entryId);
  if (!candidates.length) throw fail(`Marketplace '${marketplaceId}' has no entry '${entryId}'.`, 'MARKETPLACE_ENTRY_UNKNOWN');
  if (version) {
    const exact = candidates.find((entry) => entry.version === version);
    if (!exact) throw fail(`Marketplace '${marketplaceId}' has no version ${version} of '${entryId}' (it has ${candidates.map((entry) => entry.version).join(', ')}).`, 'MARKETPLACE_ENTRY_UNKNOWN');
    return exact;
  }
  return [...candidates].sort((left, right) => compareVersions(right.version, left.version))[0];
}

export function marketplaceEntriesView(index, { kind = null, search = null } = {}) {
  const query = String(search ?? '').trim().toLowerCase();
  return index.entries
    .filter((entry) => !kind || entry.kind === kind)
    .filter((entry) => !query || [entry.id, entry.label, entry.description ?? '', ...entry.tags].some((value) => value.toLowerCase().includes(query)))
    .map((entry) => ({ ...entry, importable: MARKETPLACE_IMPORT_KINDS.includes(entry.kind) }));
}
