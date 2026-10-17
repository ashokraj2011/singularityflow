/** Pure governed-agent document parsing; no discovery, synchronization or model work. */
import path from 'node:path';
import { parseYamlText } from './yaml-parse-cache.mjs';
import { SingularityFlowError, posix } from './util.mjs';
import { DEFAULT_REMOTE_MAX_BYTES as DEFAULT_MAX_BYTES, HARD_REMOTE_MAX_BYTES as HARD_MAX_BYTES, validatePublicHttpsUrl } from './remote-fetch.mjs';
import { LIBRARY_SKILL_TABLE, normalizeSkillUse } from './skill-library.mjs';
export const AGENT_ALLOWED_TOKENS = Object.freeze(['workId', 'workType', 'phase', 'generation']);
export function validAgentId(value) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
function displayNameId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return validAgentId(normalized) ? normalized : null;
}
function splitList(value) { return !value || value === '*' || value === '-' ? [] : value.split(',').map((item) => item.trim()).filter(Boolean); }
function parseBoolean(value, label) {
  if (!value || value === '-') return false;
  if (['true', 'yes'].includes(value.toLowerCase())) return true;
  if (['false', 'no'].includes(value.toLowerCase())) return false;
  throw new SingularityFlowError(`${label} must be true or false.`);
}
function parseMaxBytes(value, label) {
  if (!value || value === '-') return DEFAULT_MAX_BYTES;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > HARD_MAX_BYTES) throw new SingularityFlowError(`${label} must be between 1 and ${HARD_MAX_BYTES}.`);
  return number;
}
function linkValue(value) { return value.match(/^\[[^\]]*\]\(([^)]+)\)$/)?.[1] ?? value; }
function validateRemoteUrl(value, label, { dynamic = false, mcp = false } = {}) {
  // A skill or template imported from an approved MCP server names its source as mcp://; it is only
  // ever read from its vendored copy, never fetched.
  if (mcp && String(value).startsWith('mcp://')) {
    if (!/^mcp:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:prompt|resource|tool)\/[^\s|]+$/.test(value)) {
      throw new SingularityFlowError(`${label} must be mcp://<server>/prompt|resource|tool/<name>.`);
    }
    return value;
  }
  return validatePublicHttpsUrl(value, label, { dynamic, allowedTokens: AGENT_ALLOWED_TOKENS });
}

export function isMcpDependencyUrl(value) { return typeof value === 'string' && value.startsWith('mcp://'); }

function parseAgentDocument(text, file) {
  // Git for Windows commonly checks Markdown out with CRLF line endings. Agent
  // documents are cross-platform interchange files, so their parser must not
  // depend on core.autocrlf. Some Windows editors also add a UTF-8 BOM.
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(normalized);
  if (!opening) return { frontmatter: {}, body: normalized };
  const remainder = normalized.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder);
  if (!closing) throw new SingularityFlowError(`Agent frontmatter is not closed: ${file}`);
  const value = parseYamlText(remainder.slice(0, closing.index)) ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`Agent frontmatter must be an object: ${file}`);
  return { frontmatter: value, body: remainder.slice(closing.index + closing[0].length) };
}

function metadataList(metadata, key) {
  const value = metadata?.[key];
  if (value == null || value === '' || value === '*' || value === '-') return [];
  if (typeof value !== 'string') throw new SingularityFlowError(`Agent metadata '${key}' must be a comma-separated string.`);
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function rowsForHeading(text, heading, expected) {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (headingIndex < 0) return [];
  let index = headingIndex + 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!lines[index]?.trim().startsWith('|')) throw new SingularityFlowError(`Agent heading '${heading}' must be followed by a Markdown table.`);
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const headers = cells(lines[index]).map((cell) => cell.toLowerCase());
  if (JSON.stringify(headers) !== JSON.stringify(expected.map((item) => item.toLowerCase()))) throw new SingularityFlowError(`Agent heading '${heading}' requires columns: ${expected.join(' | ')}.`);
  index += 1;
  if (!lines[index]?.includes('---')) throw new SingularityFlowError(`Agent heading '${heading}' has no Markdown table separator.`);
  index += 1;
  const rows = [];
  for (; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
    const values = cells(lines[index]);
    if (values.length !== expected.length) throw new SingularityFlowError(`Agent heading '${heading}' contains a row with ${values.length} columns; expected ${expected.length}.`);
    rows.push(Object.fromEntries(expected.map((key, cellIndex) => [key, values[cellIndex]])));
  }
  return rows;
}

/** The skills an agent's `## Attached skills` table attaches: ID, steps (empty for all), when to use it. */
export function parseAttachedSkills(text, source = 'agent.md') {
  const seen = new Set();
  return rowsForHeading(text, LIBRARY_SKILL_TABLE.heading, LIBRARY_SKILL_TABLE.columns).map((row) => {
    if (!validAgentId(row.Skill)) throw new SingularityFlowError(`Attached skill '${row.Skill}' in ${source} must be a lower-case kebab-case skill ID.`);
    if (seen.has(row.Skill)) throw new SingularityFlowError(`Skill '${row.Skill}' is attached more than once in ${source}.`);
    seen.add(row.Skill);
    return Object.freeze({ id: row.Skill, phases: splitList(row.Phases), use: normalizeSkillUse(row['When to use it']) });
  });
}

export function parseAgentDependencies(text, { source = 'agent.md', agentId = null } = {}) {
  const { frontmatter, body } = parseAgentDocument(text, source);
  const declaredName = frontmatter.name;
  if (declaredName != null && (typeof declaredName !== 'string' || !declaredName.trim()
      || declaredName.length > 128 || /[\u0000-\u001f\u007f]/.test(declaredName))) {
    throw new SingularityFlowError(`Agent name in ${source} must be non-empty display text of at most 128 characters.`);
  }
  const sourceId = path.basename(source).replace(/\.agent\.md$|\.md$/i, '');
  // Existing governed agents historically placed their kebab-case ID in `name`; preserve that
  // contract. Native Copilot Agent Markdown also permits a human display name in the same field.
  // In that shape the stable governed ID is the kebab-case filename, keeping display text out of
  // workflow identity and allowing capability review to validate the shared `.github/agents` tree.
  // Some native-agent editors also preserve the display name in the filename. Normalize that
  // legacy shape deterministically so Windows checkouts do not become unable to review otherwise
  // valid capability configuration. New files should still use the explicit kebab-case filename.
  const id = agentId ?? (validAgentId(declaredName) ? declaredName
    : validAgentId(sourceId) ? sourceId : displayNameId(declaredName) ?? sourceId);
  if (!validAgentId(id)) throw new SingularityFlowError(`Agent '${id}' must use lower-case kebab-case.`);
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) throw new SingularityFlowError(`Agent '${id}' requires a non-empty description.`);
  if (!body.trim()) throw new SingularityFlowError(`Agent '${id}' requires a non-empty prompt body.`);
  if (Buffer.byteLength(body, 'utf8') > 30000) throw new SingularityFlowError(`Agent '${id}' prompt body exceeds 30000 bytes.`);
  const metadata = frontmatter.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new SingularityFlowError(`Agent '${id}' metadata must be an object.`);
  for (const [key, value] of Object.entries(metadata)) if (typeof value !== 'string') throw new SingularityFlowError(`Agent '${id}' metadata '${key}' must be a string.`);
  const phases = metadataList(metadata, 'sflow-phases');
  const defaultFor = metadataList(metadata, 'sflow-default-for');
  // Read and kept as recorded; the registered World Model these views named was removed.
  const worldModelViews = metadataList(metadata, 'sflow-world-model-views');
  const tools = frontmatter.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string' || !tool.trim())) throw new SingularityFlowError(`Agent '${id}' tools must be an array of non-empty tool names.`);
  if (new Set(tools).size !== tools.length) throw new SingularityFlowError(`Agent '${id}' tools must not contain duplicates.`);
  for (const phase of [...phases, ...defaultFor]) if (!validAgentId(phase)) throw new SingularityFlowError(`Agent '${id}' references invalid phase '${phase}'.`);
  for (const phase of defaultFor) if (phases.length && !phases.includes(phase)) throw new SingularityFlowError(`Agent '${id}' defaults phase '${phase}' without supporting it.`);
  const skillRows = rowsForHeading(text, 'Remote skills', ['ID', 'URL', 'Phases', 'Optional', 'Max bytes']);
  const templateRows = rowsForHeading(text, 'Remote artifact templates', ['ID', 'URL', 'Phases', 'Optional', 'Max bytes']);
  const generatedRows = rowsForHeading(text, 'Remote generated artifacts', ['ID', 'URL template', 'Phase', 'Target', 'Optional', 'Max bytes']);
  const seen = new Set();
  const common = (row, type, urlKey, dynamic = false) => {
    if (!validAgentId(row.ID)) throw new SingularityFlowError(`Remote ${type} ID '${row.ID}' in ${source} must be lower-case kebab-case.`);
    if (seen.has(row.ID)) throw new SingularityFlowError(`Remote dependency ID '${row.ID}' is duplicated in ${source}.`);
    seen.add(row.ID);
    const url = validateRemoteUrl(linkValue(row[urlKey]), `${type} '${row.ID}' URL`, { dynamic, mcp: !dynamic });
    return { id: row.ID, type, url, optional: parseBoolean(row.Optional, `${type} '${row.ID}' Optional`), maxBytes: parseMaxBytes(row['Max bytes'], `${type} '${row.ID}' Max bytes`) };
  };
  const skills = skillRows.map((row) => ({ ...common(row, 'skill', 'URL'), phases: splitList(row.Phases) }));
  const templates = templateRows.map((row) => ({ ...common(row, 'template', 'URL'), phases: splitList(row.Phases) }));
  // Skills from the skill master: one row per attached skill, never fetched, read from the library.
  const librarySkills = parseAttachedSkills(text, source);
  for (const attachment of librarySkills) {
    if (seen.has(attachment.id)) throw new SingularityFlowError(`Skill '${attachment.id}' is attached to ${source} and is also the ID of one of its remote resources.`);
    seen.add(attachment.id);
  }
  const generated = generatedRows.map((row) => {
    const entry = { ...common(row, 'generated', 'URL template', true), phase: row.Phase };
    if (!validAgentId(entry.phase)) throw new SingularityFlowError(`Generated artifact '${entry.id}' has invalid phase '${entry.phase}'.`);
    const target = posix(row.Target);
    if (!target.startsWith(`artifacts/${entry.phase}/`) || path.isAbsolute(target) || target.split('/').includes('..') || !target.endsWith('.md')) throw new SingularityFlowError(`Generated artifact '${entry.id}' target must be a Markdown path under artifacts/${entry.phase}/.`);
    return { ...entry, target };
  });
  return {
    id,
    source,
    displayName: declaredName?.trim() ?? id,
    label: metadata['sflow-label'] ?? declaredName?.trim() ?? id,
    description: frontmatter.description.trim(),
    frontmatter,
    metadata,
    phases,
    defaultFor,
    worldModelViews,
    tools,
    prompt: body.trim(),
    skills,
    templates,
    generated,
    dependencies: [...skills, ...templates, ...generated],
    librarySkills
  };
}

export function parseAgentTemplateReference(value) {
  const match = /^agent:([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(value ?? '');
  if (!match) throw new SingularityFlowError(`Remote template reference '${value}' must use agent:<agent-id>/<template-id>.`);
  return { agentId: match[1], templateId: match[2] };
}

export function isAgentTemplateReference(value) { return typeof value === 'string' && value.startsWith('agent:'); }
