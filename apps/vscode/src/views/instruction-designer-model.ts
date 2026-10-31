/**
 * Pure read/write model for the prompt, skill and prompt-pack designer. Agents are listed and read
 * here, but created and changed only in Workflow Studio, which renders and checks every agent.
 */
import path from 'node:path';
import YAML from 'yaml';
import { COPILOT_AGENT_MAPPING_NAME_RULE, validCopilotAgentMappingName } from '../../../../src/copilot-agent-names.mjs';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type InstructionTab = 'agents' | 'delivery' | 'prompts' | 'skills' | 'packs';

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

/** An agent as the library lists it: its label, one-line description and the steps it may draft. */
export interface AgentSummary { label: string; description: string; phases: string[] }

export function agentSummary(content: string, fallbackId = ''): AgentSummary {
  let header: Record<string, unknown> = {};
  try { header = YAML.parse(frontmatter(content).header) ?? {}; } catch { header = {}; }
  const metadata = (header.metadata && typeof header.metadata === 'object' ? header.metadata : {}) as Record<string, unknown>;
  const text = (valueToRead: unknown): string => typeof valueToRead === 'string' ? valueToRead.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  return {
    label: text(metadata['sflow-label']) || text(header.name) || fallbackId,
    description: text(header.description),
    phases: list(text(metadata['sflow-phases']))
  };
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

  return {
    agents: (snapshot.agents ?? []).map((agent) => ({
      id: agent.id, name: agent.id, path: agent.path, content: agent.content ?? '',
      description: agentSummary(agent.content ?? '', agent.id).description,
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

export function renderPrompt(draft: PromptDraft): string { return `${draft.body.trim()}\n`; }

export function renderSkill(draft: SkillDraft): string {
  return `---\nname: ${draft.id}\ndescription: ${quoted(draft.description.trim())}\nargument-hint: ${quoted(draft.argumentHint.trim())}\ndisable-model-invocation: ${draft.disableModelInvocation ? 'true' : 'false'}\n---\n\n${draft.body.trim()}\n`;
}

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
    if (!validCopilotAgentMappingName(row.copilotAgent)) {
      errors.push(`Copilot agent '${row.copilotAgent || '(empty)'}' is invalid: it must ${COPILOT_AGENT_MAPPING_NAME_RULE}.`);
    }
    if (seen.has(row.copilotAgent)) errors.push(`Copilot agent '${row.copilotAgent}' is mapped more than once.`);
    seen.add(row.copilotAgent);
    if (!known.has(row.agentId)) errors.push(`Flow agent '${row.agentId || '(empty)'}' is not available.`);
  }
  return errors;
}

export function phaseAgentLinks(snapshot: RepositorySnapshot): Array<{ phase: string; agent: string }> {
  return Object.entries(snapshot.definition?.phases ?? {}).flatMap(([phase, definition]) =>
    (definition.agents ?? []).map((agent) => ({ phase, agent }))
  );
}
