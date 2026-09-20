import rawCommands from './participant-commands.json';

export type ParticipantCommandClass = 'deterministic' | 'drafting';
export type ParticipantCommandTransport = 'local' | 'cli' | 'cli-text';
export type ParticipantCommandEffect = 'read' | 'human-decision' | 'mutation';

export interface ParticipantCommandDefinition {
  readonly id: string;
  readonly class: ParticipantCommandClass;
  readonly transport: ParticipantCommandTransport;
  readonly effect: ParticipantCommandEffect;
  readonly runtime: readonly string[] | null;
  readonly template: string;
  readonly skill: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly acceptsArguments: boolean;
  readonly requiresRepository: boolean;
  readonly requiresSession: boolean;
  readonly confirmation: 'none' | 'separate-guarded-flow';
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const TEMPLATE = /^[a-z][a-z0-9-]{0,47}$/;

function commandDefinition(value: unknown): ParticipantCommandDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Participant command entries must be objects.');
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !ID.test(entry.id)
      || !['deterministic', 'drafting'].includes(String(entry.class))
      || !['local', 'cli', 'cli-text'].includes(String(entry.transport))
      || !['read', 'human-decision', 'mutation'].includes(String(entry.effect))
      || typeof entry.template !== 'string' || !TEMPLATE.test(entry.template)
      || typeof entry.skill !== 'string' || !/^\/sf-[a-z0-9-]+$/.test(entry.skill)
      || typeof entry.description !== 'string' || entry.description.length > 160
      || !Array.isArray(entry.keywords)
      || entry.keywords.some((keyword) => typeof keyword !== 'string'
        || keyword !== keyword.trim().toLowerCase() || !keyword)
      || typeof entry.acceptsArguments !== 'boolean'
      || typeof entry.requiresRepository !== 'boolean'
      || typeof entry.requiresSession !== 'boolean'
      || !['none', 'separate-guarded-flow'].includes(String(entry.confirmation))) {
    throw new Error(`Participant command table entry '${String(entry.id ?? 'unknown')}' is invalid.`);
  }
  if (entry.runtime !== null && (!Array.isArray(entry.runtime)
      || entry.runtime.length === 0
      || entry.runtime.some((argument) => typeof argument !== 'string' || !argument))) {
    throw new Error(`Participant command '${entry.id}' has an invalid runtime argv.`);
  }
  if (entry.transport === 'local' && entry.runtime !== null) {
    throw new Error(`Local participant command '${entry.id}' cannot declare CLI argv.`);
  }
  if (entry.transport !== 'local' && entry.runtime === null) {
    throw new Error(`CLI participant command '${entry.id}' must declare argv.`);
  }
  if (entry.transport !== 'local' && entry.requiresRepository !== true) {
    throw new Error(`CLI participant command '${entry.id}' must be bound to a selected repository.`);
  }
  if (entry.class !== 'deterministic') {
    throw new Error(`Participant command '${entry.id}' uses unsupported class '${String(entry.class)}'.`);
  }
  if (entry.effect === 'mutation') {
    throw new Error(`Participant command '${entry.id}' cannot execute a mutation in the zero-model release.`);
  }
  if (entry.effect === 'read' && entry.confirmation !== 'none') {
    throw new Error(`Read-only participant command '${entry.id}' cannot declare a confirmation flow.`);
  }
  if (entry.effect === 'human-decision' && entry.confirmation !== 'separate-guarded-flow') {
    throw new Error(`Human-decision participant command '${entry.id}' requires a separate guarded flow.`);
  }
  if (Array.isArray(entry.runtime) && entry.runtime.some((argument) =>
    argument.startsWith('$') && !['$PROMPT', '$PHASE'].includes(argument))) {
    throw new Error(`Participant command '${entry.id}' contains an unsupported runtime placeholder.`);
  }
  return Object.freeze({
    id: entry.id,
    class: entry.class as ParticipantCommandClass,
    transport: entry.transport as ParticipantCommandTransport,
    effect: entry.effect as ParticipantCommandEffect,
    runtime: entry.runtime === null ? null : Object.freeze([...(entry.runtime as string[])]),
    template: entry.template,
    skill: entry.skill,
    description: entry.description,
    keywords: Object.freeze([...(entry.keywords as string[])]),
    acceptsArguments: entry.acceptsArguments,
    requiresRepository: entry.requiresRepository,
    requiresSession: entry.requiresSession,
    confirmation: entry.confirmation as ParticipantCommandDefinition['confirmation']
  });
}

const parsed = (rawCommands as unknown[]).map(commandDefinition);
const duplicateIds = parsed.filter((entry, index) =>
  parsed.findIndex((candidate) => candidate.id === entry.id) !== index);
if (duplicateIds.length) throw new Error(`Duplicate participant command '${duplicateIds[0]?.id}'.`);
const allKeywords = parsed.flatMap((entry) => entry.keywords.map((keyword) => ({ keyword, id: entry.id })));
const duplicateKeywords = allKeywords.filter((entry, index) =>
  allKeywords.findIndex((candidate) => candidate.keyword === entry.keyword) !== index);
if (duplicateKeywords.length) {
  throw new Error(`Duplicate participant keyword '${duplicateKeywords[0]?.keyword}'.`);
}

export const PARTICIPANT_COMMANDS: readonly ParticipantCommandDefinition[] = Object.freeze(parsed);
export const PARTICIPANT_COMMAND_BY_ID = new Map(PARTICIPANT_COMMANDS.map((entry) => [entry.id, entry]));

export interface ParticipantCommandMatch {
  readonly command: ParticipantCommandDefinition;
  readonly argument: string;
}

/** Exact, local routing only: a declared keyword by itself, or keyword + argument where allowed. */
export function matchParticipantCommand(prompt: string): ParticipantCommandMatch | null {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return null;
  for (const command of PARTICIPANT_COMMANDS) {
    for (const keyword of command.keywords) {
      if (normalized === keyword) return { command, argument: '' };
      if (command.acceptsArguments && normalized.startsWith(`${keyword} `)) {
        return { command, argument: prompt.trim().slice(keyword.length).trim() };
      }
    }
  }
  return null;
}

export function participantRuntimeArgv(
  command: ParticipantCommandDefinition,
  { prompt = '', phase = '' }: { prompt?: string; phase?: string } = {}
): string[] | null {
  if (!command.runtime) return null;
  const result: string[] = [];
  for (const value of command.runtime) {
    if (value === '$PROMPT') {
      if (prompt.trim()) result.push(prompt.trim());
      continue;
    }
    if (value === '$PHASE') {
      if (!phase.trim()) throw new Error(`Participant command '${command.id}' requires an active phase.`);
      result.push(phase.trim());
      continue;
    }
    result.push(value);
  }
  return result;
}
