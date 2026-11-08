/**
 * What M6 reads from `singularity/findings.yml` [CQF Configuration]: each upload source's `columns:`
 * map, and the grouping of remediation Stories. The file is optional, and one that cannot be read is
 * reported and the defaults apply, so a mistake in it never stops an import or a Story.
 *
 * The `api`, `link`, `confluence` and `file` sources are for `findings sync` (REQ-064, later); they
 * are kept as they are and not read here.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { configurationReadRootForPath } from '../../configuration-read-scope.mjs';
import { looksSecretValue } from '../../secret-looking.mjs';
import { COLUMNS, FEEDS } from './format.mjs';

export const FINDINGS_CONFIG_PATH = 'singularity/findings.yml';
const MAXIMUM_BYTES = 256 * 1024;
const SOURCE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export const STORY_DEFAULTS = Object.freeze({
  security: Object.freeze({ group: 'per-repository-by-due-date', maximumFindings: 10 }),
  tlm: Object.freeze({ group: 'per-component', maximumFindings: 10 })
});

const defaults = (warnings = [], present = false) => ({
  present, warnings, sources: { security: [], tlm: [] },
  stories: { security: { ...STORY_DEFAULTS.security }, tlm: { ...STORY_DEFAULTS.tlm } }
});

/** The upload sources and Story grouping, or the defaults with the reason the file was not used. */
export async function readFindingsConfig(root) {
  const file = path.join(configurationReadRootForPath(root, FINDINGS_CONFIG_PATH), FINDINGS_CONFIG_PATH);
  const entry = await lstat(file).catch(() => null);
  if (!entry) return defaults();
  if (!entry.isFile() || entry.size > MAXIMUM_BYTES) return defaults([`${FINDINGS_CONFIG_PATH} is not a file of at most ${MAXIMUM_BYTES} bytes; the defaults apply.`]);
  let value;
  try { value = YAML.parse(await readFile(file, 'utf8')); }
  catch (error) { return defaults([`${FINDINGS_CONFIG_PATH} is not valid YAML (${String(error.message).split('\n')[0]}); the defaults apply.`]); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults([`${FINDINGS_CONFIG_PATH} is not a mapping; the defaults apply.`]);
  const config = defaults([], true);
  for (const feed of FEEDS) {
    const section = value[feed];
    if (section == null) continue;
    if (typeof section !== 'object' || Array.isArray(section)) { config.warnings.push(`${feed} in ${FINDINGS_CONFIG_PATH} is not a mapping; it is left out.`); continue; }
    const known = new Set(COLUMNS[feed].map((definition) => definition.key));
    for (const [index, source] of (Array.isArray(section.sources) ? section.sources : []).entries()) {
      if (!source || typeof source !== 'object' || !SOURCE_ID.test(String(source.id ?? ''))) {
        config.warnings.push(`${feed}.sources[${index}] has no lower-kebab id; it is left out.`);
        continue;
      }
      const columns = {};
      for (const [key, header] of Object.entries(source.columns && typeof source.columns === 'object' ? source.columns : {})) {
        if (!known.has(key)) config.warnings.push(`${feed}.sources '${source.id}' maps an unknown column '${String(key).slice(0, 40)}'; it is left out.`);
        else if (typeof header !== 'string' || !header.trim() || header.length > 128) config.warnings.push(`${feed}.sources '${source.id}' column ${key} is not a header name; it is left out.`);
        else columns[key] = header;
      }
      // A token is never written here, as with a quality command's env.
      const secret = Object.entries(source).find(([, entryValue]) => typeof entryValue === 'string' && looksSecretValue(entryValue));
      if (secret) config.warnings.push(`${feed}.sources '${source.id}' field ${secret[0]} looks like a credential; bind it with env bind instead. The source is left out.`);
      else config.sources[feed].push({ id: source.id, type: String(source.type ?? 'upload'), columns });
    }
    const stories = section.stories && typeof section.stories === 'object' ? section.stories : {};
    const maximum = stories.maximumFindings;
    if (maximum != null) {
      if (Number.isInteger(maximum) && maximum >= 1 && maximum <= 50) config.stories[feed].maximumFindings = maximum;
      else config.warnings.push(`${feed}.stories.maximumFindings must be a whole number from 1 to 50; ${STORY_DEFAULTS[feed].maximumFindings} applies.`);
    }
  }
  return config;
}

/** The `columns:` map for an import from `source` into `feed`: that upload source's, or none. */
export function sourceColumns(config, feed, source) {
  return config.sources[feed].find((entry) => entry.id === source && entry.type === 'upload')?.columns ?? {};
}

/** The source an import names when it gives none: the feed's one upload source, else `upload`. */
export function defaultSource(config, feeds) {
  const uploads = [...new Set(feeds.flatMap((feed) => config.sources[feed].filter((entry) => entry.type === 'upload').map((entry) => entry.id)))];
  return uploads.length === 1 ? uploads[0] : 'upload';
}
