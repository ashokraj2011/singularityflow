/**
 * Creating and changing the lifecycle a repository runs.
 *
 * A profile is an ordered list of phases; a phase is what that stage produces and who signs it off.
 * Both have always been editable — they are YAML in `singularity/portfolio.yml` — but only by
 * hand, which meant the first question anybody asked about this product ("how do I add a stage?")
 * was answered with "open the file and copy an existing one". That is a fine answer for somebody
 * who already knows the shape and a poor one for everybody else, and it has no validation until
 * the next command happens to load the file.
 *
 * So the edits are commands. They are deliberately narrow: create a profile, reorder its phases,
 * create a phase, change what a phase declares. Anything richer stays hand-edited, because a form
 * over the whole of `initiativePhases` would be a worse YAML editor than a YAML editor.
 *
 * Everything here writes through the YAML document API rather than re-emitting parsed objects.
 * `portfolio.yml` is mostly commentary explaining each setting — the reason a profile exists, what
 * a lane means — and a round trip through `YAML.parse` would throw all of it away on the first
 * edit anybody made.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { PORTFOLIO_PATH, validatePortfolio } from './initiative-config.mjs';
import { WORKFLOW_PATH, validateDefinition } from './config.mjs';
import { SingularityFlowError, YAML_OUTPUT } from './util.mjs';

/**
 * The two places a workflow can live.
 *
 * A workflow is a named, ordered list of phases either way. What differs is which file holds it and
 * what it governs — a Story or an Initiative — and that is a fact about storage, not about the
 * thing. So every operation here takes a store and does the same work in it, rather than there
 * being two vocabularies and two sets of commands as there were before.
 */
export const STORES = Object.freeze({
  story: Object.freeze({
    governs: 'story',
    file: WORKFLOW_PATH,
    workflows: 'workTypes',
    phases: 'phases',
    validate: validateDefinition,
    // A Story phase produces one artifact at a known path; an Initiative phase produces a set of
    // named outputs. Same idea, genuinely different record, so each store scaffolds its own rather
    // than one shape being bent to fit both.
    scaffold: ({ id, label, worldModelViews, agents, approvalAuthorities, approvalMinimum }) => ({
      label,
      ...(agents.length ? { agents } : {}),
      artifact: { path: `artifacts/${id}/${id}.md`, kind: id, minimumBytes: 200 },
      // A Story phase is invalid without a template, so adding one writes a starter alongside it.
      // Creating a phase that cannot be run and reporting success is not creating a phase.
      defaultTemplate: `common/${id}.md`,
      writeScope: 'artifact-only',
      ...(worldModelViews.length ? { worldModel: { views: worldModelViews, depth: 'quick' } } : {}),
      ...(approvalAuthorities.length
        ? { approval: { authorities: approvalAuthorities, minimum: approvalMinimum } }
        : {})
    })
  }),
  initiative: Object.freeze({
    governs: 'initiative',
    file: PORTFOLIO_PATH,
    workflows: 'initiativeProfiles',
    phases: 'initiativePhases',
    validate: validatePortfolio,
    scaffold: ({ label, worldModelViews, lanes, agents, approvalAuthorities, approvalMinimum }) => ({
      label,
      ...(lanes.length ? { lanes } : {}),
      ...(agents.length ? { agents } : {}),
      worldModelViews,
      outputs: [],
      checklist: [],
      ...(approvalAuthorities.length
        ? { bundleApproval: { mode: 'bundle', authorities: approvalAuthorities, minimum: approvalMinimum, allowSelfApproval: true } }
        : {})
    })
  })
});

function storeFor(governs) {
  const store = STORES[governs];
  if (!store) {
    throw new SingularityFlowError(`A workflow governs 'story' or 'initiative', not '${governs}'.`);
  }
  return store;
}

/**
 * Which store holds a workflow, or which one a set of phases belongs to.
 *
 * Inferred rather than demanded: somebody editing `feature` should not have to know it is a
 * workType in workflow.yml while `epic-planning` is a profile in portfolio.yml. That distinction is
 * exactly what this layer exists to hide.
 */
async function locate(root, { workflowId = null, phases = [] } = {}) {
  for (const store of Object.values(STORES)) {
    const document = await loadIn(root, store).catch(() => null);
    if (!document) continue;
    const content = document.document.toJS() ?? {};
    if (workflowId && content[store.workflows]?.[workflowId]) return store;
    if (!workflowId && phases.length) {
      const defined = Object.keys(content[store.phases] ?? {});
      if (phases.every((phase) => defined.includes(phase))) return store;
    }
  }
  return null;
}

/** Identifiers are kebab-case throughout this product; a lifecycle is not the place to differ. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireId(value, label) {
  const id = String(value ?? '').trim();
  if (!ID.test(id)) throw new SingularityFlowError(`${label} must be lower-case kebab-case, like epic-planning.`);
  return id;
}

async function loadIn(root, store) {
  const file = path.join(root, store.file);
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { throw new SingularityFlowError(`No ${store.file} exists. Run singularity-flow init first.`); }
  return { file, document: YAML.parseDocument(text), store };
}

/**
 * Write, but only once the result is a portfolio the engine would accept.
 *
 * Validated before the write rather than after: a portfolio that is briefly invalid on disk is one
 * another command can load while it is invalid, and the failure then surfaces somewhere unrelated
 * to the edit that caused it.
 */
async function saveIn(file, document, store) {
  store.validate(document.toJS());
  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
}

/**
 * Refuse a phase that expects an agent this repository does not have.
 *
 * An agent named in a phase but absent from the repository fails at the moment the phase is run,
 * which is the worst time to discover it: the person hitting it did not write the phase and has no
 * reason to suspect the configuration. Checked when the phase is written instead, against the
 * agents actually discoverable here.
 */
async function assertAgentsExist(root, agents, phaseId) {
  if (!agents.length) return;
  const { discoverAgents } = await import('./agents.mjs');
  const available = (await discoverAgents(root)).map((agent) => agent.id);
  const unknown = agents.filter((agent) => !available.includes(agent));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Phase '${phaseId}' expects ${unknown.length === 1 ? 'an agent' : 'agents'} this repository does not have: ${unknown.join(', ')}. `
      + `Available: ${available.join(', ') || 'none'}.`);
  }
}

/**
 * The starter a new Story phase writes its artifact from.
 *
 * Enough structure to be worth opening and not so much that it reads as filled in: a heading, the
 * question the stage answers, and a note saying it is a starter. A template full of invented
 * content is worse than an empty one, because somebody will publish it.
 */
async function writeStarterTemplate(root, phaseId, label) {
  const relative = path.join('singularity', 'templates', 'common', `${phaseId}.md`);
  const file = path.join(root, relative);
  if (existsSync(file)) return relative;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    `# ${label}`,
    '',
    `A starter for the ${phaseId} phase. Replace this with what the stage actually has to answer;`,
    'the engine checks that the artifact is at least a couple of hundred bytes, not that it is good.',
    '',
    '## What this stage decides',
    '',
    '## Evidence',
    '',
    '## Open questions',
    ''
  ].join('\n'), 'utf8');
  return relative;
}

/** Every workflow in a store, with the phases it runs. */
export async function listWorkflows(root, governs = 'initiative') {
  const store = storeFor(governs);
  const { document } = await loadIn(root, store);
  const content = document.toJS() ?? {};
  return Object.entries(content[store.workflows] ?? {}).map(([id, workflow]) => ({
    id,
    label: workflow?.label ?? id,
    description: workflow?.description ?? '',
    governs: store.governs,
    phases: workflow?.phases ?? []
  }));
}

/** Kept for the Initiative-only callers that predate the store layer. */
export const listProfiles = (root) => listWorkflows(root, 'initiative');

/**
 * Create a workflow from phases that already exist.
 *
 * Refused when a named phase is not defined, because a workflow referring to a phase nobody wrote
 * stops at that stage — and it stops the first time somebody runs it, not now.
 */
/*
 * `defineWorkflow`, not `createWorkflow`: state.mjs already has the latter and it does something
 * else — it instantiates a workflow for one work item. This defines the type that instantiation
 * then follows. Two functions with one name doing different things is how a codebase starts lying
 * to whoever greps it.
 */
export async function defineWorkflow(root, workflowId, {
  label = null,
  description = '',
  phases = [],
  governs = null
} = {}) {
  const id = requireId(workflowId, 'A workflow identifier');
  if (!phases.length) throw new SingularityFlowError('A workflow needs at least one phase.');
  // Inferred from where the phases live, so nobody has to know which file holds which.
  const store = governs ? storeFor(governs) : (await locate(root, { phases })) ?? STORES.initiative;
  const { file, document } = await loadIn(root, store);
  const content = document.toJS() ?? {};

  if (content[store.workflows]?.[id]) {
    throw new SingularityFlowError(`Workflow '${id}' already exists. Use workflow edit to change it.`);
  }
  const defined = Object.keys(content[store.phases] ?? {});
  const unknown = phases.filter((phase) => !defined.includes(phase));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Workflow '${id}' names ${unknown.length === 1 ? 'a phase that is' : 'phases that are'} not defined for ${store.governs} work: ${unknown.join(', ')}. `
      + `Add ${unknown.length === 1 ? 'it' : 'them'} with workflow phase add, or choose from: ${defined.join(', ')}.`);
  }
  const duplicated = phases.filter((phase, index) => phases.indexOf(phase) !== index);
  if (duplicated.length) {
    throw new SingularityFlowError(`Workflow '${id}' runs ${[...new Set(duplicated)].join(', ')} more than once.`);
  }

  if (!content[store.workflows]) document.setIn([store.workflows], document.createNode({}));
  document.setIn([store.workflows, id], document.createNode({
    label: label ?? id,
    ...(description ? { description } : {}),
    phases
  }));
  await saveIn(file, document, store);
  return { workflowId: id, governs: store.governs, phases, path: store.file };
}

/**
 * Change a workflow.
 *
 * The phase list is replaced rather than merged: it is an order, and merging two orders has no
 * meaning. Everything else left unnamed is left alone.
 */
export async function editWorkflow(root, workflowId, changes = {}) {
  const id = requireId(workflowId, 'A workflow identifier');
  const store = await locate(root, { workflowId: id });
  if (!store) {
    // Named in the reader's vocabulary. "Unknown profile" leaked the storage word for a concept
    // this layer exists to present as one thing.
    const every = [
      ...await listWorkflows(root, 'story').catch(() => []),
      ...await listWorkflows(root, 'initiative').catch(() => [])
    ];
    throw new SingularityFlowError(
      `Unknown workflow '${id}'. This repository runs: ${every.map((entry) => entry.id).join(', ') || 'none'}.`);
  }
  const { file, document } = await loadIn(root, store);
  const content = document.toJS() ?? {};

  if (changes.phases) {
    if (!changes.phases.length) throw new SingularityFlowError('A workflow needs at least one phase.');
    const defined = Object.keys(content[store.phases] ?? {});
    const unknown = changes.phases.filter((phase) => !defined.includes(phase));
    if (unknown.length) {
      throw new SingularityFlowError(
        `Workflow '${id}' would name phases that are not defined for ${store.governs} work: ${unknown.join(', ')}.`);
    }
    document.setIn([store.workflows, id, 'phases'], changes.phases);
  }
  for (const field of ['label', 'description']) {
    if (changes[field] === undefined) continue;
    if (changes[field] === '') document.deleteIn([store.workflows, id, field]);
    else document.setIn([store.workflows, id, field], changes[field]);
  }
  await saveIn(file, document, store);
  return { workflowId: id, governs: store.governs, path: store.file };
}

/**
 * Add a phase.
 *
 * Deliberately minimal: a label, the world-model views it needs, its lanes, the agents it expects
 * and the approval that closes it. Outputs and checklists are where the real detail lives and they
 * are left to the file, because a phase with three outputs is a paragraph of YAML and a form
 * pretending otherwise just hides the shape.
 *
 * A new phase runs nowhere until a workflow lists it, which is the right default: adding a stage to
 * every workflow at once is not what anybody means by adding a stage.
 */
export async function addPhase(root, phaseId, {
  label = null,
  worldModelViews = [],
  lanes = [],
  agents = [],
  approvalAuthorities = [],
  approvalMinimum = 1,
  governs = 'initiative'
} = {}) {
  const id = requireId(phaseId, 'A phase identifier');
  const store = storeFor(governs);
  const { file, document } = await loadIn(root, store);
  const content = document.toJS() ?? {};
  if (content[store.phases]?.[id]) {
    throw new SingularityFlowError(`Phase '${id}' already exists. Use workflow phase edit to change it.`);
  }
  const authorities = Object.keys(content.approvalAuthorities ?? {});
  const unknown = approvalAuthorities.filter((authority) => !authorities.includes(authority));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Phase '${id}' names approval ${unknown.length === 1 ? 'authority' : 'authorities'} nobody configured: ${unknown.join(', ')}. `
      + `Configured: ${authorities.join(', ') || 'none'}.`);
  }
  await assertAgentsExist(root, agents, id);

  if (!content[store.phases]) document.setIn([store.phases], document.createNode({}));
  // `agents` is on both shapes: the agents a stage expects are part of its contract whatever the
  // stage governs.
  document.setIn([store.phases, id], document.createNode(store.scaffold({
    id, label: label ?? id, worldModelViews, lanes, agents, approvalAuthorities, approvalMinimum
  })));
  // Written before the phase is saved, because saving validates and the validation requires it.
  const template = store.governs === 'story'
    ? await writeStarterTemplate(root, id, label ?? id)
    : null;
  await saveIn(file, document, store);
  return { phaseId: id, governs: store.governs, path: store.file, template, usedBy: [] };
}

/** Change what a phase declares. Lists are replaced; everything unnamed is left alone. */
export async function editPhase(root, phaseId, changes = {}, { governs = null } = {}) {
  const id = requireId(phaseId, 'A phase identifier');
  const store = governs ? storeFor(governs) : (await locate(root, { phases: [id] })) ?? STORES.initiative;
  const { file, document } = await loadIn(root, store);
  const content = document.toJS() ?? {};
  if (!content[store.phases]?.[id]) throw new SingularityFlowError(`Unknown phase '${id}'.`);

  if (changes.agents !== undefined) await assertAgentsExist(root, changes.agents, id);
  if (changes.label !== undefined) document.setIn([store.phases, id, 'label'], changes.label);
  if (changes.worldModelViews !== undefined) {
    const modelPath = store.governs === 'story'
      ? [store.phases, id, 'worldModel', 'views']
      : [store.phases, id, 'worldModelViews'];
    if (!changes.worldModelViews.length) document.deleteIn(modelPath);
    else document.setIn(modelPath, changes.worldModelViews);
  }
  for (const field of ['lanes', 'agents']) {
    if (changes[field] === undefined) continue;
    if (!changes[field].length) document.deleteIn([store.phases, id, field]);
    else document.setIn([store.phases, id, field], changes[field]);
  }
  await saveIn(file, document, store);

  // Which workflows this reaches, because changing a phase changes every workflow that runs it and
  // that consequence should not have to be worked out from the file.
  const usedBy = Object.entries(content[store.workflows] ?? {})
    .filter(([, workflow]) => (workflow?.phases ?? []).includes(id))
    .map(([workflowId]) => workflowId);
  return { phaseId: id, governs: store.governs, path: store.file, usedBy };
}

/**
 * Add or change one artifact produced by an Initiative phase.
 *
 * Story phases keep their single `artifact` contract. Initiative phases may produce several named
 * outputs, which is the shape the visual artifact designer needs to edit without re-emitting the
 * whole portfolio document (and losing its comments). The result still passes through the normal
 * portfolio validator before it reaches disk.
 */
export async function upsertPhaseOutput(root, phaseId, outputId, changes = {}, {
  action = 'add', governs = 'initiative'
} = {}) {
  const phase = requireId(phaseId, 'A phase identifier');
  const output = requireId(outputId, 'An output identifier');
  if (!['add', 'edit'].includes(action)) throw new SingularityFlowError(`Output action must be add or edit, not '${action}'.`);

  const store = storeFor(governs);
  const { file, document } = await loadIn(root, store);
  const content = document.toJS() ?? {};
  const definition = content[store.phases]?.[phase];
  if (!definition) throw new SingularityFlowError(`Unknown ${governs} phase '${phase}'.`);
  if (store.governs === 'story') {
    if (output !== phase) {
      throw new SingularityFlowError(`Story phase '${phase}' has one artifact contract, whose output ID is '${phase}'.`);
    }
    if (changes.label !== undefined) document.setIn([store.phases, phase, 'label'], changes.label);
    if (changes.kind !== undefined) document.setIn([store.phases, phase, 'artifact', 'kind'], changes.kind);
    if (changes.path !== undefined) document.setIn([store.phases, phase, 'artifact', 'path'], changes.path);
    if (changes.template !== undefined) document.setIn([store.phases, phase, 'defaultTemplate'], changes.template);
    await saveIn(file, document, store);
    return {
      phaseId: phase, outputId: output, governs, action: 'edit', path: store.file,
      output: {
        id: phase,
        label: changes.label ?? definition.label ?? phase,
        kind: changes.kind ?? definition.artifact?.kind ?? 'markdown',
        path: changes.path ?? definition.artifact?.path,
        template: changes.template ?? definition.defaultTemplate,
        required: true
      }
    };
  }
  const outputs = Array.isArray(definition.outputs) ? definition.outputs : [];
  const index = outputs.findIndex((entry) => entry?.id === output);
  if (action === 'add' && index >= 0) {
    throw new SingularityFlowError(`Output '${phase}/${output}' already exists. Use workflow phase output edit to change it.`);
  }
  if (action === 'edit' && index < 0) throw new SingularityFlowError(`Unknown output '${phase}/${output}'.`);

  const previous = index >= 0 ? outputs[index] : {};
  const next = {
    ...previous,
    id: output,
    label: changes.label ?? previous.label ?? output,
    kind: changes.kind ?? previous.kind ?? 'markdown',
    path: changes.path ?? previous.path ?? `${output}.md`,
    ...(changes.template !== undefined
      ? (changes.template ? { template: changes.template } : {})
      : (previous.template ? { template: previous.template } : {})),
    ...(changes.required !== undefined ? { required: Boolean(changes.required) }
      : (previous.required !== undefined ? { required: previous.required } : {})),
    ...(changes.consumes !== undefined
      ? (changes.consumes.length ? { consumes: changes.consumes } : {})
      : (previous.consumes?.length ? { consumes: previous.consumes } : {}))
  };
  if (changes.template === '') delete next.template;
  if (changes.consumes?.length === 0) delete next.consumes;

  const updated = [...outputs];
  if (index < 0) updated.push(next); else updated[index] = next;
  document.setIn([store.phases, phase, 'outputs'], document.createNode(updated));
  await saveIn(file, document, store);
  return { phaseId: phase, outputId: output, governs, action, path: store.file, output: next };
}
