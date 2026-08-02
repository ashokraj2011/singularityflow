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
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { PORTFOLIO_PATH, validatePortfolio } from './initiative-config.mjs';
import { SingularityFlowError } from './util.mjs';

/** Identifiers are kebab-case throughout this product; a lifecycle is not the place to differ. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireId(value, label) {
  const id = String(value ?? '').trim();
  if (!ID.test(id)) throw new SingularityFlowError(`${label} must be lower-case kebab-case, like epic-planning.`);
  return id;
}

async function loadDocument(root) {
  const file = path.join(root, PORTFOLIO_PATH);
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { throw new SingularityFlowError(`No ${PORTFOLIO_PATH} exists. Run singularity-flow init first.`); }
  return { file, document: YAML.parseDocument(text) };
}

/**
 * Write, but only once the result is a portfolio the engine would accept.
 *
 * Validated before the write rather than after: a portfolio that is briefly invalid on disk is one
 * another command can load while it is invalid, and the failure then surfaces somewhere unrelated
 * to the edit that caused it.
 */
async function saveDocument(file, document) {
  validatePortfolio(document.toJS());
  await writeFile(file, document.toString({ flowCollectionPadding: false }), 'utf8');
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

/** Every profile, with the phases it runs — the same view `initiative profiles` reports. */
export async function listProfiles(root) {
  const { document } = await loadDocument(root);
  const portfolio = document.toJS() ?? {};
  return Object.entries(portfolio.initiativeProfiles ?? {}).map(([id, profile]) => ({
    id,
    label: profile?.label ?? id,
    description: profile?.description ?? '',
    lifecycleMode: profile?.lifecycleMode ?? null,
    phases: profile?.phases ?? []
  }));
}

/**
 * Create a profile from phases that already exist.
 *
 * Refused when a named phase is not defined, because a profile referring to a phase nobody wrote is
 * a lifecycle that stops at that stage — and it stops the first time somebody runs it, not now.
 */
export async function createProfile(root, profileId, {
  label = null,
  description = '',
  phases = [],
  lifecycleMode = null
} = {}) {
  const id = requireId(profileId, 'A profile identifier');
  const { file, document } = await loadDocument(root);
  const portfolio = document.toJS() ?? {};

  if (portfolio.initiativeProfiles?.[id]) {
    throw new SingularityFlowError(`Profile '${id}' already exists. Use profile edit to change it.`);
  }
  if (!phases.length) throw new SingularityFlowError('A profile needs at least one phase.');
  const defined = Object.keys(portfolio.initiativePhases ?? {});
  const unknown = phases.filter((phase) => !defined.includes(phase));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Profile '${id}' names ${unknown.length === 1 ? 'a phase that is' : 'phases that are'} not defined: ${unknown.join(', ')}. `
      + `Create ${unknown.length === 1 ? 'it' : 'them'} first with phase create, or choose from: ${defined.join(', ')}.`);
  }
  const duplicated = phases.filter((phase, index) => phases.indexOf(phase) !== index);
  if (duplicated.length) {
    throw new SingularityFlowError(`Profile '${id}' runs ${[...new Set(duplicated)].join(', ')} more than once.`);
  }

  if (!portfolio.initiativeProfiles) document.setIn(['initiativeProfiles'], document.createNode({}));
  document.setIn(['initiativeProfiles', id], document.createNode({
    label: label ?? id,
    ...(description ? { description } : {}),
    ...(lifecycleMode ? { lifecycleMode } : {}),
    phases
  }));
  await saveDocument(file, document);
  return { profileId: id, phases, path: PORTFOLIO_PATH };
}

/**
 * Change a profile.
 *
 * The phase list is replaced rather than merged: it is an order, and merging two orders has no
 * meaning. Everything else left unnamed is left alone.
 */
export async function editProfile(root, profileId, changes = {}) {
  const id = requireId(profileId, 'A profile identifier');
  const { file, document } = await loadDocument(root);
  const portfolio = document.toJS() ?? {};
  const existing = portfolio.initiativeProfiles?.[id];
  if (!existing) throw new SingularityFlowError(`Unknown profile '${id}'.`);

  if (changes.phases) {
    const defined = Object.keys(portfolio.initiativePhases ?? {});
    const unknown = changes.phases.filter((phase) => !defined.includes(phase));
    if (unknown.length) {
      throw new SingularityFlowError(`Profile '${id}' would name undefined phases: ${unknown.join(', ')}.`);
    }
    if (!changes.phases.length) throw new SingularityFlowError('A profile needs at least one phase.');
    document.setIn(['initiativeProfiles', id, 'phases'], changes.phases);
  }
  for (const field of ['label', 'description', 'lifecycleMode']) {
    if (changes[field] === undefined) continue;
    if (changes[field] === '') document.deleteIn(['initiativeProfiles', id, field]);
    else document.setIn(['initiativeProfiles', id, field], changes[field]);
  }
  await saveDocument(file, document);
  return { profileId: id, path: PORTFOLIO_PATH };
}

/**
 * Create a phase.
 *
 * Deliberately minimal: a label, the world-model views it needs, its lanes, and the approval that
 * closes it. Outputs and checklists are where the real detail lives and they are left to the file,
 * because a phase with three outputs and a checklist is a paragraph of YAML and a form that
 * pretends otherwise just hides the shape.
 *
 * A new phase runs nowhere until a profile lists it, which is the right default: adding a stage to
 * every lifecycle at once is not what anybody means by "add a stage".
 */
export async function createPhase(root, phaseId, {
  label = null,
  worldModelViews = [],
  lanes = [],
  agents = [],
  approvalAuthorities = [],
  approvalMinimum = 1
} = {}) {
  const id = requireId(phaseId, 'A phase identifier');
  const { file, document } = await loadDocument(root);
  const portfolio = document.toJS() ?? {};
  if (portfolio.initiativePhases?.[id]) {
    throw new SingularityFlowError(`Phase '${id}' already exists. Use phase edit to change it.`);
  }
  const authorities = Object.keys(portfolio.approvalAuthorities ?? {});
  const unknown = approvalAuthorities.filter((authority) => !authorities.includes(authority));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Phase '${id}' names approval ${unknown.length === 1 ? 'authority' : 'authorities'} nobody configured: ${unknown.join(', ')}. `
      + `Configured: ${authorities.join(', ') || 'none'}.`);
  }

  await assertAgentsExist(root, agents, id);

  if (!portfolio.initiativePhases) document.setIn(['initiativePhases'], document.createNode({}));
  document.setIn(['initiativePhases', id], document.createNode({
    label: label ?? id,
    ...(lanes.length ? { lanes } : {}),
    // The agents this stage expects. An agent was only ever chosen by whoever set the session, so a
    // phase could not say what it needs to be run properly — the knowledge lived in somebody's head
    // or in a runbook. Declared here it is part of the phase contract, versioned with it.
    ...(agents.length ? { agents } : {}),
    // Empty rather than absent: the field is the thing a reader edits next, and an absent key is
    // harder to find than an empty one.
    worldModelViews,
    outputs: [],
    checklist: [],
    ...(approvalAuthorities.length
      ? { bundleApproval: { mode: 'bundle', authorities: approvalAuthorities, minimum: approvalMinimum, allowSelfApproval: true } }
      : {})
  }));
  await saveDocument(file, document);
  return { phaseId: id, path: PORTFOLIO_PATH, usedBy: [] };
}

/** Change what a phase declares. Views and lanes are replaced; everything unnamed is left alone. */
export async function editPhase(root, phaseId, changes = {}) {
  const id = requireId(phaseId, 'A phase identifier');
  const { file, document } = await loadDocument(root);
  const portfolio = document.toJS() ?? {};
  if (!portfolio.initiativePhases?.[id]) throw new SingularityFlowError(`Unknown phase '${id}'.`);

  if (changes.agents !== undefined) await assertAgentsExist(root, changes.agents, id);
  if (changes.label !== undefined) document.setIn(['initiativePhases', id, 'label'], changes.label);
  for (const field of ['worldModelViews', 'lanes', 'agents']) {
    if (changes[field] === undefined) continue;
    if (!changes[field].length) document.deleteIn(['initiativePhases', id, field]);
    else document.setIn(['initiativePhases', id, field], changes[field]);
  }
  await saveDocument(file, document);

  // Which profiles this reaches, because changing a phase changes every lifecycle that runs it and
  // that consequence should not have to be worked out from the file.
  const usedBy = Object.entries(portfolio.initiativeProfiles ?? {})
    .filter(([, profile]) => (profile?.phases ?? []).includes(id))
    .map(([profileId]) => profileId);
  return { phaseId: id, path: PORTFOLIO_PATH, usedBy };
}
