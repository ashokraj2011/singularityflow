/**
 * The tier mapping: the only place a concrete model name is allowed to appear. `[ADP:REQ-020]`
 *
 * Everything else in the product names a *task*. This file is the single indirection between the
 * two, which is what lets a vendor deprecation be a one-line edit to one reviewed file instead of a
 * sweep through skills, workflows, agents and the registry `[ADP:CON-002]`.
 *
 * It is also where model-specific parameters live — thinking effort, budgets — for the same reason:
 * volatility belongs in the one volatile file, not scattered across stable contracts
 * `[ADP:REQ-021]` `[ADP:CON-006]`.
 *
 * The separation from `workflow.yml` is deliberate and is the whole of `[ADP:REQ-030]`. A story pins
 * its *policy* — the task, the allowed-set, and the revision of this mapping — and resolves the
 * *logistics* at invocation time. A model retired mid-story degrades availability; it must never
 * silently change what the story was governed by `[ADP:CON-007]`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

import { assertModelTask, MODEL_TASKS } from './model-tasks.mjs';
import { canonicalJson } from './records.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const MODEL_TIERS_PATH = 'singularity/modelTiers.yml';

/** Parameters a tier may carry. Anything else is refused rather than passed to a provider unread. */
const ALLOWED_PARAMS = Object.freeze(['effort', 'temperature', 'maxOutputTokens', 'thinkingBudget']);

function assertModelName(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SingularityFlowError(`${label} must be a non-empty model identifier.`, { code: 'MODEL_TIER_INVALID' });
  }
  return value.trim();
}

function normalizeParams(value, label) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} params must be an object.`, { code: 'MODEL_TIER_INVALID' });
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_PARAMS.includes(key)) {
      throw new SingularityFlowError(
        `${label} params contains unknown field '${key}'. Allowed: ${ALLOWED_PARAMS.join(', ')}.`,
        { code: 'MODEL_TIER_INVALID' }
      );
    }
  }
  return Object.freeze({ ...value });
}

/**
 * One tier: the model to prefer, the ordered alternatives, and the parameters that go with it.
 *
 * `alias` lets a task point at another task's tier rather than repeat its model name, so a mapping
 * can ship with two tiers actually filled and the rest pointed at them — the shape recommended for
 * v1, because a scorecard with no data is not a reason to invent four distinct model choices.
 */
function normalizeTier(task, raw) {
  assertModelTask(task, 'Tier task');
  if (typeof raw === 'string') return { task, alias: assertModelTask(raw, `Tier '${task}' alias`), model: null, fallback: [], params: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SingularityFlowError(`Tier '${task}' must be an object or an alias to another task.`, { code: 'MODEL_TIER_INVALID' });
  }
  for (const key of Object.keys(raw)) {
    if (!['model', 'fallback', 'params', 'alias'].includes(key)) {
      throw new SingularityFlowError(`Tier '${task}' contains unknown field '${key}'.`, { code: 'MODEL_TIER_INVALID' });
    }
  }
  if (raw.alias != null) {
    if (raw.model != null || raw.fallback != null) {
      throw new SingularityFlowError(`Tier '${task}' may alias another task or declare a model, not both.`, { code: 'MODEL_TIER_INVALID' });
    }
    return { task, alias: assertModelTask(raw.alias, `Tier '${task}' alias`), model: null, fallback: [], params: null };
  }
  const fallback = raw.fallback ?? [];
  if (!Array.isArray(fallback) || fallback.some((entry) => typeof entry !== 'string')) {
    throw new SingularityFlowError(`Tier '${task}' fallback must be an array of model identifiers.`, { code: 'MODEL_TIER_INVALID' });
  }
  const model = assertModelName(raw.model, `Tier '${task}' model`);
  const ladder = fallback.map((entry, index) => assertModelName(entry, `Tier '${task}' fallback[${index}]`));
  // A model that is its own fallback is a ladder with a rung that goes nowhere.
  if (ladder.includes(model)) {
    throw new SingularityFlowError(`Tier '${task}' lists its preferred model '${model}' as its own fallback.`, { code: 'MODEL_TIER_CYCLIC' });
  }
  if (new Set(ladder).size !== ladder.length) {
    throw new SingularityFlowError(`Tier '${task}' repeats a model in its fallback ladder.`, { code: 'MODEL_TIER_CYCLIC' });
  }
  return { task, alias: null, model, fallback: Object.freeze(ladder), params: normalizeParams(raw.params, `Tier '${task}'`) };
}

/**
 * Resolve alias chains to the tier that actually names a model. `[ADP:AC-002]`
 *
 * A cycle here is not a cosmetic error: it is a mapping that answers "which model?" with "ask
 * again", and it must fail at `check` rather than at the moment someone needs a model to run.
 */
function resolveAliases(tiers) {
  const resolved = new Map();
  for (const task of Object.keys(tiers)) {
    const seen = [];
    let current = task;
    while (tiers[current]?.alias) {
      if (seen.includes(current)) {
        throw new SingularityFlowError(
          `Tier alias cycle: ${[...seen, current].join(' → ')}. A tier must eventually name a model.`,
          { code: 'MODEL_TIER_CYCLIC', details: { cycle: [...seen, current] } }
        );
      }
      seen.push(current);
      current = tiers[current].alias;
      if (!tiers[current]) {
        throw new SingularityFlowError(
          `Tier '${seen.at(-1)}' aliases '${current}', which the mapping does not declare.`,
          { code: 'MODEL_TIER_INVALID' }
        );
      }
    }
    resolved.set(task, { ...tiers[current], task, aliasOf: current === task ? null : current });
  }
  return resolved;
}

/**
 * The mapping's identity, pinned per story alongside the task and the allowed-set `[ADP:REQ-030]`.
 *
 * Content-addressed over the normalized mapping rather than the file bytes, so reformatting or
 * reordering does not read as a policy change while a changed model or effort does.
 */
export function tierMappingRevision(tiers) {
  const canonical = [...tiers.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([task, tier]) => [task, { model: tier.model, fallback: [...tier.fallback], params: tier.params ?? null }]);
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/** The digest of one tier's parameters, recorded on every invocation `[ADP:REQ-040]`. */
export function paramsDigest(params) {
  return params ? createHash('sha256').update(canonicalJson(params)).digest('hex').slice(0, 16) : null;
}

export function normalizeModelTiers(raw, { label = MODEL_TIERS_PATH } = {}) {
  const source = raw?.modelTiers ?? raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError(`${label} must declare a modelTiers object.`, { code: 'MODEL_TIER_INVALID' });
  }
  const declared = {};
  for (const [task, tier] of Object.entries(source)) declared[task] = normalizeTier(task, tier);
  // Every task in the closed enum must resolve. A task with no tier is work with nowhere to go, and
  // it must be caught at `check` rather than the first time that phase runs.
  const missing = MODEL_TASKS.filter((task) => !declared[task]);
  if (missing.length) {
    throw new SingularityFlowError(
      `${label} declares no tier for ${missing.join(', ')}. Every task must map, even if only as an alias.`,
      { code: 'MODEL_TIER_MISSING', details: { missing } }
    );
  }
  const resolved = resolveAliases(declared);
  return Object.freeze({ tiers: resolved, revision: tierMappingRevision(resolved) });
}

/** Read and normalize the mapping. Absent is a first-class answer: routing is opt-in. */
export async function loadModelTiers(root) {
  let located = null;
  try {
    located = await secureRepositoryPath(root, MODEL_TIERS_PATH, { label: 'Model tier mapping', type: 'file' });
  } catch {
    return null;
  }
  // `secureRepositoryPath` returns a descriptor, not a path. Reading the object instead of
  // `.absolute` fails silently and looks exactly like a repository with no mapping — which is to
  // say, it turns "routing is misconfigured" into "routing is not configured".
  if (!located?.exists) return null;
  const text = await readFile(located.absolute, 'utf8').catch(() => null);
  if (text === null) return null;
  let parsed = null;
  try { parsed = YAML.parse(text); } catch (error) {
    throw new SingularityFlowError(`${MODEL_TIERS_PATH} is not valid YAML: ${error.message}`, { code: 'MODEL_TIER_INVALID', cause: error });
  }
  return normalizeModelTiers(parsed);
}

/**
 * The models a task may use, preferred first. `[ADP:REQ-031]`
 *
 * The ladder is returned whole rather than one rung at a time, because the caller records every hop
 * it took. A substitution nobody can see afterwards is indistinguishable from the preferred model
 * having run, and the entire point of routing by task is being able to ask later which model
 * actually did the work `[ADP:BEH-001]`.
 */
export function tierLadder(mapping, task) {
  assertModelTask(task);
  const tier = mapping?.tiers?.get(task);
  if (!tier) {
    throw new SingularityFlowError(`No tier is mapped for task '${task}'.`, { code: 'MODEL_TIER_MISSING', details: { task } });
  }
  return Object.freeze({
    task,
    aliasOf: tier.aliasOf,
    models: Object.freeze([tier.model, ...tier.fallback]),
    params: tier.params,
    paramsDigest: paramsDigest(tier.params)
  });
}

/**
 * Every concrete model name the mapping can reach, for the allowed-set check `[ADP:REQ-022]` and
 * for the lint that forbids these strings anywhere else `[ADP:REQ-023]`.
 */
export function mappedModelNames(mapping) {
  const names = new Set();
  for (const tier of mapping?.tiers?.values() ?? []) {
    if (tier.model) names.add(tier.model);
    for (const entry of tier.fallback) names.add(entry);
  }
  return Object.freeze([...names].sort());
}
