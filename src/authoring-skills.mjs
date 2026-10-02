/**
 * The Copilot skills a workflow step may name as the one that drafts it (`authoringSkill`).
 *
 * The list is declared once, here, in a module with no dependencies of its own. Routing and
 * guidance code that reads it runs inside every VS Code bundle, so a run-time read of the YAML
 * skill registry would carry the YAML parser into each of them. Configuration validation,
 * routing, guidance safety and Workflow Studio read this table; the skill-policy audit checks it
 * against the packaged registry and the skill bodies, so it cannot drift from the skills it names.
 *
 * A listed skill promises two things a table cannot express: it re-reads the step's verified route
 * before doing any work, and it follows the step's own contract instead of assumptions about the
 * step it was first written for. The audit enforces both on every listed body.
 */
import { SingularityFlowError } from './util.mjs';

/** A direct skill id as a step names it: `sf-design`, never `/sf-design` or `sflow-design`. */
export const AUTHORING_SKILL_ID = /^sf-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** What a step can produce, from `stepOutputKind`; `none` steps draft nothing and name no skill. */
export const AUTHORING_OUTPUT_KINDS = Object.freeze(['document', 'analysis', 'code']);

const SOURCE_ID = /^sflow-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Each selectable skill: the step outputs it can draft (`produces`), and the built-in step ids it
 * keeps accepting when a step names no skill (`legacyPhases`).
 */
export const AUTHORING_SKILL_DECLARATION = Object.freeze({
  'sflow-phase': Object.freeze({ produces: Object.freeze(['document', 'analysis']) }),
  'sflow-code': Object.freeze({ produces: Object.freeze(['code']) })
});

function fail(message) {
  return new SingularityFlowError(message, { code: 'AUTHORING_SKILL_CATALOG_INVALID' });
}

/** The packaged id behind a direct one: `sf-design` → `sflow-design`. */
export function authoringSkillSourceId(id) {
  return String(id).replace(/^sf-/, 'sflow-');
}

/** The direct id a step names for a packaged skill: `sflow-design` → `sf-design`. */
export function authoringSkillDirectId(sourceId) {
  return String(sourceId).replace(/^sflow-/, 'sf-');
}

/**
 * Check and freeze a declaration. `registeredSkills`, when given, is the set of packaged skill ids
 * every entry must belong to; build tooling passes the registry's.
 */
export function parseAuthoringSkills(declaration, { registeredSkills = null } = {}) {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw fail('The authoring skills must be a mapping.');
  const entries = [];
  for (const [sourceId, value] of Object.entries(declaration)) {
    if (!SOURCE_ID.test(sourceId)) throw fail(`Authoring skill '${sourceId}' must be a packaged sflow-* skill.`);
    if (registeredSkills && !registeredSkills.has(sourceId)) throw fail(`Authoring skill '${sourceId}' is not a registered skill.`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`Authoring skill '${sourceId}' must be a mapping.`);
    for (const key of Object.keys(value)) {
      if (!['produces', 'legacyPhases'].includes(key)) throw fail(`Authoring skill '${sourceId}' has unknown field '${key}'.`);
    }
    const produces = value.produces;
    if (!Array.isArray(produces) || !produces.length || new Set(produces).size !== produces.length
        || produces.some((kind) => !AUTHORING_OUTPUT_KINDS.includes(kind))) {
      throw fail(`Authoring skill '${sourceId}' produces must list distinct values from ${AUTHORING_OUTPUT_KINDS.join(', ')}.`);
    }
    const legacyPhases = value.legacyPhases ?? [];
    if (!Array.isArray(legacyPhases) || new Set(legacyPhases).size !== legacyPhases.length
        || legacyPhases.some((phase) => !PHASE_ID.test(String(phase)))) {
      throw fail(`Authoring skill '${sourceId}' legacyPhases must list distinct step ids.`);
    }
    entries.push(Object.freeze({
      id: authoringSkillDirectId(sourceId),
      sourceId,
      produces: Object.freeze([...produces]),
      legacyPhases: Object.freeze(legacyPhases.map(String))
    }));
  }
  return Object.freeze(entries);
}

const CATALOG = parseAuthoringSkills(AUTHORING_SKILL_DECLARATION);

/** The skills a step may name, in declaration order. */
export function authoringSkillCatalog() {
  return CATALOG;
}

/** The catalog entry for a direct skill id, or null. */
export function authoringSkillEntry(id) {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}
