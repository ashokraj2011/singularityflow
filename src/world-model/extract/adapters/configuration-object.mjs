import path from 'node:path';

import YAML from 'yaml';

import {
  adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256, result,
  unavailableDraft
} from './common.mjs';

export const CONFIGURATION_OBJECT_ID = 'configuration-object';
export const CONFIGURATION_OBJECT_VERSION = '1.0.0';
export const CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256 = implementationSha256(
  CONFIGURATION_OBJECT_ID,
  CONFIGURATION_OBJECT_VERSION,
  'strict-json-yaml-and-closed-toml-properties-key-inventory-without-values-v1'
);

const EXACT_CONFIGURATION_NAMES = new Set([
  '.eslintrc', '.prettierrc', 'cargo.toml', 'composer.json', 'deno.json', 'go.mod',
  'jsconfig.json', 'package.json', 'pom.xml', 'pyproject.toml', 'tsconfig.json'
]);

export function configurationFormat(relative) {
  const normalized = String(relative).replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  const extension = path.posix.extname(basename);
  const explicit = EXACT_CONFIGURATION_NAMES.has(basename)
    || /(?:config|settings|workflow|capabilities|policy|rules|manifest|schema|openapi|asyncapi)/i.test(basename)
    || normalized.startsWith('.github/') || normalized.startsWith('singularity/');
  if (!explicit && !['.properties', '.ini'].includes(extension)) return null;
  if (extension === '.json' || basename === '.eslintrc' || basename === '.prettierrc') return 'json';
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.toml') return 'toml';
  if (extension === '.properties' || extension === '.ini') return 'properties';
  return null;
}

function safeStructuredValue(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 12) throw new Error('configuration structure exceeds the bounded parser limits');
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => safeStructuredValue(item, state, depth + 1));
  if (typeof value !== 'object') throw new Error('configuration contains an unsupported value type');
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('configuration contains an unsafe object key');
    }
    output[key] = safeStructuredValue(item, state, depth + 1);
  }
  return output;
}

function lexicalKeyInventory(source, format) {
  const keys = [];
  let section = '';
  const seen = new Set();
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (format === 'toml') {
      const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
      if (sectionMatch) { section = sectionMatch[1]; continue; }
    } else {
      const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
      if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
    }
    const key = /^([A-Za-z0-9_.-]+)\s*[=:]/.exec(line)?.[1];
    if (!key) continue;
    const qualified = section ? `${section}.${key}` : key;
    if (seen.has(qualified)) throw new Error(`duplicate configuration key '${qualified}'`);
    seen.add(qualified);
    keys.push(qualified);
  }
  if (!keys.length) throw new Error('configuration contains no recognized keys');
  return { root: null, topLevelKeys: keys.sort() };
}

/** Parse only a selected configuration file, with strict duplicate and alias handling. */
export function parseConfigurationObject(source, relative) {
  const format = configurationFormat(relative);
  if (!format) return null;
  if (format === 'toml' || format === 'properties') {
    return { format, ...lexicalKeyInventory(source, format) };
  }
  let parsed;
  if (format === 'json') {
    JSON.parse(source);
    const document = YAML.parseDocument(source, {
      maxAliasCount: 0, prettyErrors: false, schema: 'json', strict: true, uniqueKeys: true
    });
    if (document.errors.length) throw new Error(document.errors[0].message);
    parsed = document.toJS({ maxAliasCount: 0 });
  } else {
    const document = YAML.parseDocument(source, {
      maxAliasCount: 0, prettyErrors: false, schema: 'core', strict: true, uniqueKeys: true
    });
    if (document.errors.length) throw new Error(document.errors[0].message);
    parsed = document.toJS({ maxAliasCount: 0 });
  }
  const root = safeStructuredValue(parsed, { nodes: 0 });
  if (!root || Array.isArray(root) || typeof root !== 'object') {
    throw new Error('configuration root is not an object');
  }
  return { format, root, topLevelKeys: Object.keys(root).sort() };
}

export function lineForConfigurationKey(source, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = String(source).split(/\r?\n/);
  const pattern = new RegExp(`^\\s*(?:["']?${escaped}["']?)\\s*[:=]`);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? 1 : index + 1;
}

export function extractConfigurationObjects(context) {
  const observations = [];
  const facts = [];
  for (const file of adapterFiles(context).filter((entry) => configurationFormat(entry.path))) {
    const subject = { kind: 'configuration', id: file.path };
    let source;
    try {
      source = exactText(context, file);
    } catch (error) {
      if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      facts.push(unavailableDraft({
        factType: 'configuration-object', subject,
        attemptedProducer: CONFIGURATION_OBJECT_ID,
        code: 'INVALID_UTF8',
        detail: `The pinned configuration ${file.path} is not valid UTF-8.`
      }));
      continue;
    }
    let parsed;
    try {
      parsed = parseConfigurationObject(source, file.path);
    } catch (error) {
      const evidence = evidenceDescriptor(file, { kind: 'file', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'configuration-object', subject,
        attemptedProducer: CONFIGURATION_OBJECT_ID,
        code: 'PARSE_FAILURE',
        detail: `The selected configuration ${file.path} was refused: ${error.message}`,
        evidence: [evidence]
      }));
      continue;
    }
    const evidence = evidenceDescriptor(file, { kind: 'configuration-object', subject });
    const visibleKeys = parsed.topLevelKeys.filter((key) => (
      /^[A-Za-z0-9][A-Za-z0-9_.@$-]{0,99}$/.test(key)
    )).slice(0, 64);
    const keySummary = visibleKeys.length
      ? `${visibleKeys.join(', ')}${parsed.topLevelKeys.length > visibleKeys.length ? ', …' : ''}`
      : '(none)';
    observations.push(evidence);
    facts.push(factDraft({
      factType: 'configuration-object',
      subject,
      claim: `${file.path} is a ${parsed.format} configuration object with ${parsed.topLevelKeys.length} registered key(s); bounded key inventory: ${keySummary}.`,
      assurance: parsed.root ? 'deterministically-derived' : 'structurally-derived',
      evidence: [evidence]
    }));
  }
  return result(CONFIGURATION_OBJECT_ID, observations, facts);
}
