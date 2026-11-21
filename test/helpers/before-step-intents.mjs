/**
 * Workflows as a team has them before step intents (step intents Stage 5): the shipped workflow.yml without what only
 * version 4 reads, at version 3, and a team's own copy of any shipped workflow, with its steps renamed, so SFlow
 * recognises none of them as a step it ships and has to read each one from its settings.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHIPPED_WORKFLOW = Object.freeze(YAML.parse(readFileSync(path.join(ROOT, 'templates', 'workflow.yml'), 'utf8')));

const isMapping = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

function withoutIntent(step) {
  if (!isMapping(step)) return;
  delete step.intent;
  delete step.because;
  if (isMapping(step.approval) && step.approval.automatic === 'off') {
    delete step.approval.automatic;
    if (!Object.keys(step.approval).length) delete step.approval;
  }
}

/** `value` (a workflow.yml) without intents, reasons, `automatic: off` or intentProfiles, at `version`. */
export function beforeStepIntents(value = SHIPPED_WORKFLOW, version = 3) {
  const out = structuredClone(value);
  out.version = version;
  delete out.intentProfiles;
  for (const step of Object.values(out.phases ?? {})) withoutIntent(step);
  for (const type of Object.values(out.workTypes ?? {})) {
    if (!isMapping(type)) continue;
    delete type.because;
    for (const override of Object.values(type.phaseOverrides ?? {})) withoutIntent(override);
  }
  return out;
}

// Keys whose values are never a step ID, however they are spelled (an output kind may read "design" or "intake").
const NOT_STEP_REFERENCES = new Set(['label', 'description', 'kind', 'artifact', 'authoringSkill', 'generation', 'clarification', 'validation',
  'defaultTemplate', 'id', 'reason', 'mcp', 'qualityCommands', 'afterStep', 'specificationQuality', 'comparison', 'worldModel', 'when', 'values',
  'name', 'milestone', 'spec', 'intelligence', 'references', 'constitution', 'profiles', 'comparison', 'authority', 'authorities',
  'requiredAuthorities', 'responsibility', 'preserve', 'projection', 'expansion', 'fallback', 'testLevels', 'testIds']);

function renamed(value, rename, key = null) {
  if (NOT_STEP_REFERENCES.has(key)) return structuredClone(value);
  if (typeof value === 'string') return rename(value);
  if (Array.isArray(value)) return value.map((entry) => renamed(entry, rename, null));
  if (!isMapping(value)) return value;
  const keysAreSteps = ['phaseOverrides', 'templateOverrides', 'owners'].includes(key);
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [keysAreSteps ? rename(name) : name,
    key === 'templateOverrides' ? entry : renamed(entry, rename, name)]));
}

/**
 * Adds to `value` a team's own copy of shipped workflow `workTypeId` as `<prefix><workTypeId>`, each of its steps
 * copied as `<prefix><step>` (shared with the team's other copies that use the same step), every reference renamed.
 */
export function teamCopy(value, workTypeId, prefix = 'own-') {
  const type = value.workTypes[workTypeId];
  const steps = new Set(type.phases);
  const rename = (id) => (steps.has(id) ? `${prefix}${id}` : id);
  for (const id of type.phases) value.phases[rename(id)] ??= renamed(value.phases[id], rename);
  const copy = renamed(type, rename);
  copy.label = `Team ${type.label ?? workTypeId}`;
  value.workTypes[`${prefix}${workTypeId}`] = copy;
  // Steps the top-level lists name (attached documents, MCP servers) are named there in the copy too.
  const alsoCopies = (list) => [...new Set([...list, ...list.filter((id) => steps.has(id)).map(rename)])];
  if (Array.isArray(value.documents?.allowedPhases)) value.documents.allowedPhases = alsoCopies(value.documents.allowedPhases);
  for (const server of Object.values(value.mcpServers ?? {})) if (Array.isArray(server?.phases)) server.phases = alsoCopies(server.phases);
  return `${prefix}${workTypeId}`;
}
