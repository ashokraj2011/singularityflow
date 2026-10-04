/** Pure read/write model for the visual agent, prompt, skill and prompt-pack designer. */
import path from 'node:path';
import YAML from 'yaml';
import { worldModelViewCatalog } from '../../../../src/world-model-views.mjs';
import { renderPreservingFormatting } from '../../../../src/yaml-formatting.mjs';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type InstructionTab = 'agents' | 'delivery' | 'prompts' | 'skills' | 'packs';

export interface RemoteSkillDraft {
  id: string; url: string; phases: string[]; optional: boolean; maxBytes: string;
}

export interface RemoteTemplateDraft {
  id: string; url: string; phases: string[]; optional: boolean; maxBytes: string;
}

export interface RemoteOutputDraft {
  id: string; urlTemplate: string; phase: string; target: string; optional: boolean; maxBytes: string;
}

export interface AgentDraft {
  /** Original Markdown retained by the host, never taken from a webview save request. */
  sourceText?: string;
  id: string;
  label: string;
  description: string;
  phases: string[];
  defaultFor: string[];
  worldModelViews: string[];
  tools: string[];
  body: string;
  remoteSkills: RemoteSkillDraft[];
  remoteTemplates: RemoteTemplateDraft[];
  remoteOutputs: RemoteOutputDraft[];
}

export interface PromptDraft { id: string; body: string; }

export interface SkillDraft {
  id: string;
  description: string;
  argumentHint: string;
  disableModelInvocation: boolean;
  body: string;
}

export interface InstructionEntry {
  id: string;
  name: string;
  path: string;
  content: string;
  description: string;
  scope: 'repository' | 'packaged';
  editable: boolean;
  repositoryPath?: string;
  argumentHint?: string;
}

export interface InstructionCatalog {
  agents: InstructionEntry[];
  prompts: InstructionEntry[];
  skills: InstructionEntry[];
  packs: InstructionEntry[];
  phases: Array<{ id: string; label: string }>;
  worldModelViews: string[];
  promptUsage: Record<string, string[]>;
  mappings: Array<{ copilotAgent: string; agentId: string; source: string }>;
  mappingPath: string;
  /** Exact authority bytes rendered into the mapping editor, used as its save CAS baseline. */
  mappingContent: string;
  agentStatus: Array<{
    id: string; status: string; sourceChanged: boolean;
    dependencies: Array<{ id: string; type: string; status: string; sha256: string | null; optional: boolean }>;
  }>;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function value(line: string): string {
  const raw = line.trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try { return raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1).replace(/''/g, "'"); }
    catch { return raw.slice(1, -1); }
  }
  return raw;
}

function frontmatter(content: string): { header: string; body: string } {
  const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { header: match[1] ?? '', body: match[2] ?? '' } : { header: '', body: content };
}

function scalar(header: string, key: string, indent = ''): string {
  const found = header.split('\n').find((line) => new RegExp(`^${indent}${key}:\\s*`).test(line));
  return found ? value(found.replace(new RegExp(`^${indent}${key}:\\s*`), '')) : '';
}

function list(valueToParse: string): string[] {
  const raw = valueToParse.trim();
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1).split(',').map(value).filter(Boolean);
  return value(raw).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function quoted(valueToQuote: string): string { return JSON.stringify(valueToQuote); }

function promptId(filePath: string): string {
  return path.posix.basename(filePath, path.posix.extname(filePath));
}

const REMOTE_HEADINGS = ['Remote skills', 'Remote artifact templates', 'Remote generated artifacts'];

/**
 * Where a remote resource table sits, found the way the CLI's agent parser finds it: the first
 * matching heading, blank lines, a header row and its separator, then every row that starts with a
 * pipe. Markdown lets the heading and the rows be indented, and so does the CLI.
 */
function remoteTable(lines: string[], heading: string): { start: number; rows: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return null;
  let index = start + 1;
  while (index < lines.length && !lines[index]?.trim()) index += 1;
  if (!lines[index]?.trim().startsWith('|')) return null;
  index += 2;
  const rows = index;
  while (index < lines.length && lines[index]?.trim().startsWith('|')) index += 1;
  return { start, rows, end: index };
}

function tableRows(content: string, heading: string): string[][] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const table = remoteTable(lines, heading);
  return table ? lines.slice(table.rows, table.end)
    .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())) : [];
}

/**
 * The body without the remote resource tables the form edits as rows. It removes exactly what
 * tableRows reads: a table left in the body is the one the CLI reads, ahead of the table a save
 * appends. The blank lines after a table go too when a blank line precedes its heading, so the text
 * around it closes up instead of gaining a gap.
 */
function withoutRemoteTables(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const heading of REMOTE_HEADINGS) {
    for (let table = remoteTable(lines, heading); table; table = remoteTable(lines, heading)) {
      let end = table.end;
      if (!lines[table.start - 1]?.trim()) while (end < lines.length && !lines[end]?.trim()) end += 1;
      lines.splice(table.start, end - table.start);
    }
  }
  return lines.join('\n').trim();
}

function bool(valueToParse: string): boolean { return ['true', 'yes'].includes(valueToParse.toLowerCase()); }

/**
 * An agent description as the form holds it: one trimmed line. The form edits it in a single-line
 * input, which drops line breaks, and a `description: |` block ends in one. parseAgent and the host's
 * save both read it through here, so an untouched description compares equal to the file's own.
 */
export function agentDescription(valueToRead: unknown): string {
  return typeof valueToRead === 'string' ? valueToRead.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
}

export function instructionCatalog(snapshot: RepositorySnapshot): InstructionCatalog {
  const definition = snapshot.definition;
  const phases = Object.entries(definition?.phases ?? {}).map(([id, phase]) => ({ id, label: phase.label ?? id }));
  const initiativePhases = (snapshot.portfolio as { initiativePhases?: Record<string, { label?: string }> } | null)?.initiativePhases ?? {};
  for (const [id, phase] of Object.entries(initiativePhases)) {
    if (!phases.some((entry) => entry.id === id)) phases.push({ id, label: phase.label ?? id });
  }
  phases.sort((left, right) => left.label.localeCompare(right.label));

  const promptUsage: Record<string, string[]> = {};
  const use = (filePath: string | undefined, label: string): void => {
    if (!filePath || filePath === 'builtin') return;
    (promptUsage[filePath] ??= []).push(label);
  };
  use(definition?.planning?.promptSource, 'Copilot planning');
  use(definition?.worldModel?.promptSource ?? 'singularity/prompts/worldmodel-builder.md', 'World-model builder');

  return {
    agents: (snapshot.agents ?? []).map((agent) => ({
      id: agent.id, name: agent.id, path: agent.path, content: agent.content ?? '',
      description: parseAgent(agent.content ?? '', agent.id).description,
      scope: agent.editable === false ? 'packaged' as const : 'repository' as const, editable: agent.editable !== false
    })).sort((left, right) => left.name.localeCompare(right.name)),
    prompts: (snapshot.prompts ?? []).map((file) => ({
      id: promptId(file.path), name: file.name, path: file.path, content: file.content ?? '',
      description: (promptUsage[file.path] ?? []).join(' · ') || 'Reusable repository instruction',
      scope: 'repository' as const, editable: true
    })).sort((left, right) => left.name.localeCompare(right.name)),
    skills: (snapshot.repositorySkills ?? []).map((file) => {
      const parsed = parseSkill(file.content ?? '', promptId(path.posix.dirname(file.path)));
      return { id: parsed.id, name: parsed.id, path: file.path, content: file.content ?? '',
        description: parsed.description, argumentHint: parsed.argumentHint,
        scope: 'repository' as const, editable: true };
    }).sort((left, right) => left.name.localeCompare(right.name)),
    packs: (snapshot.flowSkills ?? []).map((skill) => ({
      id: skill.id ?? skill.name ?? promptId(path.posix.dirname(skill.path)),
      name: skill.id ?? skill.name ?? skill.path, path: skill.path, content: skill.content ?? '',
      description: skill.description ?? '', argumentHint: skill.argumentHint ?? '',
      scope: 'packaged' as const, editable: false,
      repositoryPath: skill.repositoryPath ?? `.github/skills/${skill.id ?? skill.name}/SKILL.md`
    })).sort((left, right) => left.name.localeCompare(right.name)),
    phases,
    // Agent frontmatter accepts logical IDs only. Registered configuration retains `@version`, but
    // offering that exact reference here would create Markdown the agent parser correctly rejects.
    worldModelViews: worldModelViewCatalog(
      definition ?? {}, (snapshot.worldModel?.views ?? []).map((view) => view.id)
    ),
    promptUsage,
    mappings: snapshot.agentMappings?.rows ?? [],
    mappingPath: snapshot.agentMappings?.path ?? 'singularity/agent-mappings.yml',
    mappingContent: snapshot.agentMappings?.content ?? '',
    agentStatus: (snapshot.agentStatus ?? []).map((entry) => ({
      id: entry.id, status: entry.status, sourceChanged: entry.sourceChanged,
      dependencies: entry.dependencies.map((dependency) => ({
        id: dependency.id, type: dependency.type, status: dependency.status,
        sha256: dependency.sha256, optional: dependency.optional
      }))
    }))
  };
}

export function parseAgent(content: string, fallbackId = ''): AgentDraft {
  const parsed = frontmatter(content);
  const header = YAML.parse(parsed.header) ?? {};
  const metadata = header.metadata ?? {};
  const skills = tableRows(parsed.body, 'Remote skills');
  const templates = tableRows(parsed.body, 'Remote artifact templates');
  const outputs = tableRows(parsed.body, 'Remote generated artifacts');
  return {
    sourceText: content,
    id: typeof header.name === 'string' && ID.test(header.name) ? header.name : fallbackId,
    label: metadata['sflow-label'] || header.name || fallbackId,
    description: agentDescription(header.description),
    phases: list(metadata['sflow-phases'] ?? ''),
    defaultFor: list(metadata['sflow-default-for'] ?? ''),
    worldModelViews: list(metadata['sflow-world-model-views'] ?? ''),
    tools: Array.isArray(header.tools) ? [...header.tools] : [],
    body: withoutRemoteTables(parsed.body),
    remoteSkills: skills.filter((row) => row.length === 5 && row[0]).map((row) => ({
      id: row[0]!, url: row[1]!, phases: list(row[2]!), optional: bool(row[3]!), maxBytes: row[4]!
    })),
    remoteTemplates: templates.filter((row) => row.length === 5 && row[0]).map((row) => ({
      id: row[0]!, url: row[1]!, phases: list(row[2]!), optional: bool(row[3]!), maxBytes: row[4]!
    })),
    remoteOutputs: outputs.filter((row) => row.length === 6 && row[0]).map((row) => ({
      id: row[0]!, urlTemplate: row[1]!, phase: row[2]!, target: row[3]!, optional: bool(row[4]!), maxBytes: row[5]!
    }))
  };
}

export function parseSkill(content: string, fallbackId = ''): SkillDraft {
  const parsed = frontmatter(content);
  return {
    id: scalar(parsed.header, 'name') || fallbackId,
    description: scalar(parsed.header, 'description'),
    argumentHint: scalar(parsed.header, 'argument-hint'),
    disableModelInvocation: scalar(parsed.header, 'disable-model-invocation') === 'true',
    body: parsed.body.trim()
  };
}

export function parsePrompt(content: string, fallbackId = ''): PromptDraft {
  return { id: fallbackId, body: content.trim() };
}

export function validateAgent(draft: AgentDraft): string[] {
  const errors: string[] = [];
  if (!ID.test(draft.id)) errors.push('Agent ID must be lower-case kebab-case.');
  if (!draft.label.trim()) errors.push('Agent label is required.');
  if (!draft.description.trim()) errors.push('Agent description is required.');
  if (!draft.body.trim()) errors.push('Agent instructions are required.');
  const unavailableDefaults = draft.defaultFor.filter((phase) => !draft.phases.includes(phase));
  if (unavailableDefaults.length) errors.push(`Default phases must also be assigned phases: ${unavailableDefaults.join(', ')}.`);
  const remote = [...draft.remoteSkills, ...draft.remoteTemplates, ...draft.remoteOutputs];
  const ids = new Set<string>();
  for (const resource of remote) {
    if (!ID.test(resource.id)) errors.push(`Remote resource ID '${resource.id || '(empty)'}' must be lower-case kebab-case.`);
    if (ids.has(resource.id)) errors.push(`Remote resource ID '${resource.id}' is duplicated.`);
    ids.add(resource.id);
    const url = 'url' in resource ? resource.url : resource.urlTemplate;
    if (!url.startsWith('https://')) errors.push(`Remote resource '${resource.id || '(empty)'}' must use public HTTPS.`);
    const limit = resource.maxBytes.trim();
    if (limit && limit !== '-' && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 10 * 1024 * 1024)) {
      errors.push(`Remote resource '${resource.id}' max bytes must be 1–10485760, or '-' for the default.`);
    }
  }
  for (const output of draft.remoteOutputs) {
    if (!ID.test(output.phase)) errors.push(`Remote output '${output.id}' needs a valid phase.`);
    if (!output.target.startsWith(`artifacts/${output.phase}/`) || !output.target.endsWith('.md') || output.target.includes('..')) {
      errors.push(`Remote output '${output.id}' target must be a Markdown file under artifacts/${output.phase}/.`);
    }
  }
  return errors;
}

export function validatePrompt(draft: PromptDraft): string[] {
  const errors: string[] = [];
  if (!ID.test(draft.id)) errors.push('Prompt ID must be lower-case kebab-case.');
  if (!draft.body.trim()) errors.push('Prompt instructions are required.');
  return errors;
}

export function validateSkill(draft: SkillDraft): string[] {
  const errors: string[] = [];
  if (!ID.test(draft.id)) errors.push('Skill ID must be lower-case kebab-case.');
  if (!draft.description.trim()) errors.push('Skill description is required.');
  if (!draft.body.trim()) errors.push('Skill instructions are required.');
  return errors;
}

function cell(valueToRender: string | number | boolean | undefined): string {
  const rendered = String(valueToRender ?? '').trim();
  return rendered || '-';
}

function remoteTables(draft: AgentDraft): string {
  const skills = draft.remoteSkills.map((entry) => `| ${cell(entry.id)} | ${cell(entry.url)} | ${cell(entry.phases.join(','))} | ${entry.optional ? 'true' : 'false'} | ${cell(entry.maxBytes)} |`).join('\n');
  const templates = draft.remoteTemplates.map((entry) => `| ${cell(entry.id)} | ${cell(entry.url)} | ${cell(entry.phases.join(','))} | ${entry.optional ? 'true' : 'false'} | ${cell(entry.maxBytes)} |`).join('\n');
  const outputs = draft.remoteOutputs.map((entry) => `| ${cell(entry.id)} | ${cell(entry.urlTemplate)} | ${cell(entry.phase)} | ${cell(entry.target)} | ${entry.optional ? 'true' : 'false'} | ${cell(entry.maxBytes)} |`).join('\n');
  return [
    skills ? `## Remote skills\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n${skills}` : '',
    templates ? `## Remote artifact templates\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n${templates}` : '',
    outputs ? `## Remote generated artifacts\n\n| ID | URL template | Phase | Target | Optional | Max bytes |\n|---|---|---|---|---|---|\n${outputs}` : ''
  ].filter(Boolean).join('\n\n');
}

const HEADER_FIELDS = ['id', 'description', 'tools', 'label', 'phases', 'defaultFor', 'worldModelViews'] as const;
const BODY_FIELDS = ['body', 'remoteSkills', 'remoteTemplates', 'remoteOutputs'] as const;
type AgentField = typeof HEADER_FIELDS[number] | typeof BODY_FIELDS[number];

/**
 * A field's value as the CLI reads it. The host, the page and parseAgent each shape a draft their
 * own way: checkboxes follow catalog order, the page builds remote rows key by key, an empty
 * max-bytes cell comes back as '-', and '-' or '*' alone means every phase. Comparing these values
 * instead of the drafts is what lets an untouched save return the file's own bytes.
 */
function comparable(draft: AgentDraft, key: AgentField): string {
  const text = (valueToRead: unknown): string => String(valueToRead ?? '').trim();
  const set = (values: unknown, anyPhase = false): string[] => {
    const entries = [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].sort();
    return anyPhase && entries.length === 1 && ['-', '*'].includes(entries[0]!) ? [] : entries;
  };
  const limit = (valueToRead: unknown): string => text(valueToRead) || '-';
  switch (key) {
    case 'description': return JSON.stringify(agentDescription(draft.description));
    case 'tools': return JSON.stringify(set(draft.tools));
    case 'phases': case 'defaultFor': case 'worldModelViews': return JSON.stringify(set(draft[key], true));
    case 'remoteSkills': case 'remoteTemplates':
      return JSON.stringify(draft[key].map((entry) =>
        [text(entry.id), text(entry.url), set(entry.phases, true), Boolean(entry.optional), limit(entry.maxBytes)]));
    case 'remoteOutputs':
      return JSON.stringify(draft.remoteOutputs.map((entry) =>
        [text(entry.id), text(entry.urlTemplate), text(entry.phase), text(entry.target), Boolean(entry.optional), limit(entry.maxBytes)]));
    default: return JSON.stringify(text(draft[key]));
  }
}

/**
 * The frontmatter with the fields the form changed written into the authored document. A changed
 * value keeps the quoting the file wrote it with, and a changed tool list stays a flow or a block
 * list. A value the file lacks, or a block scalar the one-line form cannot reproduce, is written the
 * way packaged agents write it: plain where YAML allows, metadata values double-quoted, tools as a
 * flow list.
 */
function renderHeader(source: string, draft: AgentDraft, unchanged: (key: AgentField) => boolean): string {
  // A new agent starts from an empty block mapping. Parsing '{}' gives a flow mapping, which the
  // library renders on one line with every key, list and metadata value inside it.
  const document = source ? YAML.parseDocument(source) : new YAML.Document({});
  if (document.errors.length) throw new Error('Agent frontmatter is not valid YAML.');
  const write = (field: string[], value: string, quoted = false): void => {
    const node = document.getIn(field, true);
    if (YAML.isScalar(node) && node.type !== YAML.Scalar.BLOCK_LITERAL && node.type !== YAML.Scalar.BLOCK_FOLDED) {
      node.value = value;
      return;
    }
    const created = new YAML.Scalar(value);
    if (quoted) created.type = YAML.Scalar.QUOTE_DOUBLE;
    document.setIn(field, created);
  };
  if (!unchanged('id')) write(['name'], draft.id);
  if (!unchanged('description')) write(['description'], agentDescription(draft.description));
  if (!unchanged('tools')) {
    const tools = document.get('tools', true);
    document.set('tools', document.createNode([...draft.tools], { flow: YAML.isSeq(tools) ? Boolean(tools.flow) : true }));
  }
  const metadata = ([
    ['label', 'sflow-label', draft.label.trim()], ['phases', 'sflow-phases', draft.phases.join(',')],
    ['defaultFor', 'sflow-default-for', draft.defaultFor.join(',')],
    ['worldModelViews', 'sflow-world-model-views', draft.worldModelViews.join(',')]
  ] as const).filter(([key]) => !unchanged(key));
  // `metadata:` with no value is an empty map to the CLI; make it one before writing into it.
  const map = document.get('metadata', true);
  if (metadata.length && YAML.isScalar(map) && map.value == null) document.set('metadata', document.createNode({}));
  for (const [, field, value] of metadata) write(['metadata', field], value, true);
  // Written over the frontmatter the file has, as the CLI writes configuration: only the lines of the
  // fields that changed are new, and the rest keep the layout people gave them.
  return renderPreservingFormatting(source ? `${source}\n` : null, document);
}

export function renderAgent(draft: AgentDraft, sourceText = draft.sourceText ?? ''): string {
  const original = frontmatter(sourceText);
  const before = sourceText ? parseAgent(sourceText, draft.id) : null;
  const unchanged = (key: AgentField): boolean => before !== null && comparable(before, key) === comparable(draft, key);
  const headerUnchanged = HEADER_FIELDS.every(unchanged);
  const bodyUnchanged = BODY_FIELDS.every(unchanged);
  if (headerUnchanged && bodyUnchanged) return sourceText;
  const header = headerUnchanged ? `${original.header}\n` : renderHeader(original.header, draft, unchanged);
  const body = bodyUnchanged ? original.body : `\n${[draft.body.trim(), remoteTables(draft)].filter(Boolean).join('\n\n')}\n`;
  const rendered = `---\n${header}---\n${body}`;
  return sourceText.includes('\r\n') ? rendered.replace(/\n/g, '\r\n') : rendered;
}

export function renderPrompt(draft: PromptDraft): string { return `${draft.body.trim()}\n`; }

export function renderSkill(draft: SkillDraft): string {
  return `---\nname: ${draft.id}\ndescription: ${quoted(draft.description.trim())}\nargument-hint: ${quoted(draft.argumentHint.trim())}\ndisable-model-invocation: ${draft.disableModelInvocation ? 'true' : 'false'}\n---\n\n${draft.body.trim()}\n`;
}

export function agentPath(id: string): string { return `.github/agents/${id}.agent.md`; }
export function promptPath(id: string): string { return `singularity/prompts/${id}.md`; }
export function skillPath(id: string): string { return `.github/skills/${id}/SKILL.md`; }

export function renderAgentMappings(rows: Array<{ copilotAgent: string; agentId: string }>): string {
  const configured = rows.filter((row) => row.copilotAgent.trim() && row.agentId.trim());
  if (!configured.length) return 'version: 1\nmappings: {}\n';
  return `version: 1\nmappings:\n${configured.map((row) => `  ${quoted(row.copilotAgent.trim())}: ${quoted(row.agentId.trim())}`).join('\n')}\n`;
}

export function validateAgentMappingsDraft(rows: Array<{ copilotAgent: string; agentId: string }>, agentIds: string[]): string[] {
  const errors: string[] = []; const seen = new Set<string>(); const known = new Set(agentIds);
  for (const row of rows) {
    if (row.copilotAgent !== row.copilotAgent.trim()
        || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(row.copilotAgent)) {
      errors.push(`Copilot agent '${row.copilotAgent || '(empty)'}' is invalid.`);
    }
    if (seen.has(row.copilotAgent)) errors.push(`Copilot agent '${row.copilotAgent}' is mapped more than once.`);
    seen.add(row.copilotAgent);
    if (!known.has(row.agentId)) errors.push(`Flow agent '${row.agentId || '(empty)'}' is not available.`);
  }
  return errors;
}

export function phaseAgentLinks(snapshot: RepositorySnapshot): Array<{ phase: string; agent: string; views: string[] }> {
  return Object.entries(snapshot.definition?.phases ?? {}).flatMap(([phase, definition]) =>
    (definition.agents ?? []).map((agent) => ({ phase, agent, views: definition.worldModel?.views ?? [] }))
  );
}
