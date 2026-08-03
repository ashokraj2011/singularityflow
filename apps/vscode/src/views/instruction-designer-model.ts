/** Pure read/write model for the visual agent, prompt, skill and prompt-pack designer. */
import path from 'node:path';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type InstructionTab = 'agents' | 'prompts' | 'skills' | 'packs';

export interface AgentDraft {
  id: string;
  label: string;
  description: string;
  phases: string[];
  defaultFor: string[];
  worldModelViews: string[];
  tools: string[];
  body: string;
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
    worldModelViews: [...new Set([
      ...(definition?.worldModel?.views ?? []),
      ...Object.values(definition?.phases ?? {}).flatMap((phase) => phase.worldModel?.views ?? []),
      ...(snapshot.worldModel?.views ?? []).map((view) => view.id)
    ])].sort(),
    promptUsage
  };
}

export function parseAgent(content: string, fallbackId = ''): AgentDraft {
  const parsed = frontmatter(content);
  return {
    id: scalar(parsed.header, 'name') || fallbackId,
    label: scalar(parsed.header, 'sflow-label', '  ') || fallbackId,
    description: scalar(parsed.header, 'description'),
    phases: list(scalar(parsed.header, 'sflow-phases', '  ')),
    defaultFor: list(scalar(parsed.header, 'sflow-default-for', '  ')),
    worldModelViews: list(scalar(parsed.header, 'sflow-world-model-views', '  ')),
    tools: list(scalar(parsed.header, 'tools')),
    body: parsed.body.trim()
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

const REMOTE_TABLES = `## Remote skills\n\n| ID | URL | Phases | Personas | Optional | Max bytes |\n|---|---|---|---|---|---|\n\n## Remote artifact templates\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n\n## Remote generated artifacts\n\n| ID | URL template | Phase | Target | Optional | Max bytes |\n|---|---|---|---|---|---|`;

export function renderAgent(draft: AgentDraft): string {
  const body = draft.body.trim();
  const withTables = body.includes('## Remote skills') ? body : `${body}\n\n${REMOTE_TABLES}`;
  return `---\nname: ${draft.id}\ndescription: ${quoted(draft.description.trim())}\ntools: [${draft.tools.join(', ')}]\nmetadata:\n  sflow-label: ${quoted(draft.label.trim())}\n  sflow-phases: ${quoted(draft.phases.join(','))}\n  sflow-default-for: ${quoted(draft.defaultFor.join(','))}\n  sflow-world-model-views: ${quoted(draft.worldModelViews.join(','))}\n---\n\n${withTables}\n`;
}

export function renderPrompt(draft: PromptDraft): string { return `${draft.body.trim()}\n`; }

export function renderSkill(draft: SkillDraft): string {
  return `---\nname: ${draft.id}\ndescription: ${quoted(draft.description.trim())}\nargument-hint: ${quoted(draft.argumentHint.trim())}\ndisable-model-invocation: ${draft.disableModelInvocation ? 'true' : 'false'}\n---\n\n${draft.body.trim()}\n`;
}

export function agentPath(id: string): string { return `.github/agents/${id}.agent.md`; }
export function promptPath(id: string): string { return `singularity/prompts/${id}.md`; }
export function skillPath(id: string): string { return `.github/skills/${id}/SKILL.md`; }

export function phaseAgentLinks(snapshot: RepositorySnapshot): Array<{ phase: string; agent: string; views: string[] }> {
  return Object.entries(snapshot.definition?.phases ?? {}).flatMap(([phase, definition]) =>
    (definition.agents ?? []).map((agent) => ({ phase, agent, views: definition.worldModel?.views ?? [] }))
  );
}
