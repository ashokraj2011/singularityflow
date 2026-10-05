/**
 * `singularity/imports.lock.yml`: where each imported skill, template, agent and MCP server came
 * from. A leaf, so the workflow bundle reader can carry these records without loading the import
 * pipeline (fetching, staging, marketplaces) into every command.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { SingularityFlowError, YAML_OUTPUT } from './util.mjs';

export const IMPORTS_LOCK_PATH = 'singularity/imports.lock.yml';
export const IMPORTS_VENDOR_ROOT = 'singularity/imports';

function fail(message, code) {
  return new SingularityFlowError(message, { code });
}

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
