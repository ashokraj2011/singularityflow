/**
 * Library skills that cannot be used, and the way out of each [owner, 2026-11-25].
 *
 * Loading configuration reads no skill (skill-library.mjs assertAttachedLibrarySkills checks the
 * attachments file's structure only), so one skill missing from the skill master, or not a valid
 * skill, never stops a command, Story or step that does not use it. It is read, and refused with its
 * way out, only where it matters: a Story of a workflow that keeps it starts (assertStoryLibrarySkills),
 * a step's prompt uses it (agents.mjs), a Story's snapshot keeps it (workflow-snapshots.mjs), and a
 * configuration change, approval or refresh would leave an agent or workflow using it
 * (configurationSkillProblems before and after, addedSkillProblem). doctor and `workflow check` list
 * every one. Only those paths load this module; the commands a Story runs at each step do not.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIGURATION_SOURCE_PATH } from './configuration-assets.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { resolveSkillInstructions } from './instruction-library.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  SKILL_ATTACHMENTS_PATH, SKILL_FILE, effectiveLibrarySkills, librarySkillPath, parseLibrarySkill, parseSkillAttachments,
  readSkillAttachments
} from './skill-library.mjs';
import { SingularityFlowError, secureRepositoryPath } from './util.mjs';

/**
 * The agents and steps a Story of one workflow keeps skills for when it starts: every agent its
 * selection catalog holds (config.mjs snapshotResolution) and its steps. `resolved` is the workflow
 * as resolveWorkType gives it.
 */
export function storySkillScope(definition, workTypeId, resolved) {
  const phaseIds = new Set(resolved.phases.map((phase) => phase.id));
  const required = new Set([...resolved.phases.map((phase) => phase.defaultAgent),
    resolved.sourceReview?.mode !== 'off' ? resolved.sourceReview?.reviewerAgent : null].filter(Boolean));
  const agentIds = new Set((definition.agentCatalog ?? []).filter((agent) => required.has(agent.id)
    || (!(agent.phases?.length && !agent.phases.some((id) => phaseIds.has(id))) && !(agent.apm && agent.apm.state !== 'intact')))
    .map((agent) => agent.id));
  return { workTypeId, phaseIds, agentIds };
}

/**
 * The library skills attached here, one entry per attachment: `{ skillId, agentId, phases }` or
 * `{ skillId, workflowId, phases }`. With a Story's `scope` (storySkillScope), the ones that Story
 * keeps when it starts (workflow-snapshots.mjs); without, every one in use. A packaged agent is
 * dormant, and needs none, while none of the steps its own file attaches a skill for is here.
 */
export function librarySkillNeeds(agents, attachments, definition = {}, scope = null) {
  const applies = (phases) => !scope || !phases.length || phases.some((id) => scope.phaseIds.has(id));
  const needs = attachments.filter((entry) => entry.workflow && (!scope || entry.workflow === scope.workTypeId))
    .map((entry) => ({ skillId: entry.id, workflowId: entry.workflow, phases: entry.phases }));
  for (const agent of agents) {
    if (scope && !scope.agentIds.has(agent.id)) continue;
    const listed = new Set((agent.attachedSkills ?? []).map((entry) => entry.id));
    for (const attachment of effectiveLibrarySkills(agent)) {
      if (!scope && ['plugin', 'bundled'].includes(agent.scope) && attachment.phases.length
          && attachment.phases.every((id) => !definition.phases?.[id]) && !listed.has(attachment.id)) continue;
      if (!applies(attachment.phases)) continue;
      needs.push({ skillId: attachment.id, agentId: agent.id, phases: attachment.phases,
        // Detaching changes the attachments file, or the agent's own file when the repository owns it.
        detachable: listed.has(attachment.id) || agent.scope === 'repository' });
    }
  }
  return needs;
}

/** A configuration file's text under `configRoot` (the approved configuration when read in its scope), or null. */
export function configurationTextReader(configRoot) {
  return async (relative) => {
    const secured = await secureRepositoryPath(configRoot, relative, { label: 'Configuration file', type: 'file' });
    return secured.exists ? readFile(secured.absolute, 'utf8') : null;
  };
}

/**
 * Why each needed skill cannot be used: it is not in the skill master, or it is not a valid skill
 * (its text, or an instruction it places when `configRoot` is given). Each skill is read once, by
 * `read(relative)`, which gives a configuration file's text or null. `[{ ...need, path, reason, detail }]`.
 */
export async function librarySkillProblems(needs, { read, configRoot = null }) {
  const verdicts = new Map();
  const verdict = async (id) => {
    try {
      const text = await read(librarySkillPath(id));
      if (text == null) return { reason: 'missing', detail: `it is not in the skill master (${librarySkillPath(id)})` };
      const skill = parseLibrarySkill(text, { id });
      if (configRoot) await resolveSkillInstructions(configRoot, skill);
      return null;
    } catch (error) { return { reason: 'unreadable', detail: error.message }; }
  };
  const problems = [];
  for (const need of needs) {
    if (!verdicts.has(need.skillId)) verdicts.set(need.skillId, await verdict(need.skillId));
    const found = verdicts.get(need.skillId);
    if (found) problems.push({ ...need, path: librarySkillPath(need.skillId), ...found });
  }
  return problems;
}

/**
 * Every skill problem of the configuration at `configRoot`, whose loaded `definition` gives its
 * agents: what doctor lists, and what a configuration change is compared on (addedSkillProblem).
 */
export async function configurationSkillProblems(configRoot, definition) {
  return librarySkillProblems(librarySkillNeeds(definition.agentCatalog ?? [], await readSkillAttachments(configRoot), definition),
    { read: configurationTextReader(configRoot), configRoot });
}

/** The first problem `after` a change has that `before` did not: what the change itself adds, or null. */
export function addedSkillProblem(before, after) {
  const key = (problem) => [problem.agentId ?? '', problem.workflowId ?? '', problem.skillId, problem.reason].join('\0');
  const known = new Set(before.map(key));
  return after.find((problem) => !known.has(key(problem))) ?? null;
}

/** Whether this build ships the skill, so restoring the packaged configuration brings it back. */
export function shipsLibrarySkill(id) {
  return existsSync(path.join(PACKAGE_ROOT, 'templates', 'skill-library', id, SKILL_FILE));
}

/**
 * A skill this build ships, against its file in the configuration at `configRoot`: `{ packaged, current, same, edited }`.
 * `packaged` is the text SFlow ships (null when it ships none), `current` the bytes here (null when missing). `edited`
 * says the bytes here are none SFlow ever shipped for that path (packaged-asset-history.mjs), line endings aside: a
 * deliberate edit in this repository, which `skill restore` replaces only when the person says so (--discard-edits).
 */
export async function packagedSkillState(configRoot, id) {
  const packaged = await readFile(path.join(PACKAGE_ROOT, 'templates', 'skill-library', id, SKILL_FILE), 'utf8')
    .catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  const relative = librarySkillPath(id);
  const secured = await secureRepositoryPath(configRoot, relative, { label: `Skill '${id}'`, type: 'file' });
  const current = secured.exists ? await readFile(secured.absolute) : null;
  if (packaged == null || current == null) return { packaged, current, same: false, edited: false };
  const { isKnownPackagedAssetHash } = await import('./packaged-asset-history.mjs');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const shipped = [current, Buffer.from(current.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8')].some((bytes) => isKnownPackagedAssetHash(relative, digest(bytes)));
  return { packaged, current, same: current.equals(Buffer.from(packaged, 'utf8')), edited: !shipped };
}

/**
 * Whether `root`'s configuration is an approved one (sflow/config): read through its overlay, or
 * materialized onto a Story from it. Its changes are then proposals; otherwise they are the
 * repository's own file edits.
 */
export function approvedConfigurationIn(root) {
  return path.resolve(configurationReadRoot(root)) !== path.resolve(root)
    || existsSync(path.join(root, CONFIGURATION_SOURCE_PATH));
}

/**
 * The way out of one skill problem, as complete commands a person runs. A skill this build ships
 * comes back as it shipped: missing, the packaged configuration refresh restores it to the approved
 * configuration (sflow/config), or `init --repair` to the repository's own files, keeping edits;
 * there but not a valid skill, which a refresh keeps as an edit, `skill restore` replaces it with
 * the packaged text through the reviewed configuration path (a proposal with an approved
 * configuration), and asks the person first when the text here is an edit (packagedSkillState).
 * Any other is written again, or detached from what attaches it; with an approved configuration
 * each is a proposal.
 */
export function librarySkillRepairs(problem, { approved = false } = {}) {
  const id = problem.skillId;
  if (problem.reason === 'missing' && shipsLibrarySkill(id)) {
    return [approved
      ? { command: 'singularity-flow workspace refresh-configuration',
        label: `Restore SFlow's packaged skill ${id} to sflow/config; your edits stay.` }
      : { command: 'singularity-flow init --repair',
        label: `Restore SFlow's packaged skill ${id}, then commit it; your edits stay.` }];
  }
  const propose = approved ? ' --propose' : '';
  const target = problem.workflowId ? `--workflow ${problem.workflowId}` : `--agent ${problem.agentId}`;
  const detach = problem.workflowId || problem.detachable !== false ? [{ command: `singularity-flow skill detach ${id} ${target}${propose}`,
    label: `Or stop using it: detach it from ${problem.workflowId ? `workflow ${problem.workflowId}` : `agent ${problem.agentId}`}.` }] : [];
  if (problem.reason === 'unreadable' && shipsLibrarySkill(id)) {
    return [{ command: `singularity-flow skill restore ${id}${propose}`,
      label: `Replace its text here with SFlow's packaged skill ${id}${approved ? ', as a configuration proposal' : ''}.` }, ...detach];
  }
  return [
    { command: `singularity-flow skill create ${id} --description "<what it does and when to use it>" --instructions "<the steps the agent follows>"${propose}`,
      label: `Write skill ${id} again in the skill master${approved ? ', as a configuration proposal' : ''}.` },
    ...detach
  ];
}

/** The refusal for one skill problem where the skill is used, naming its way out. */
export function librarySkillRefusal(problem, { approved = false, where = null } = {}) {
  const owner = problem.workflowId ? `Workflow '${problem.workflowId}'` : `Agent '${problem.agentId}'`;
  const repairs = librarySkillRepairs(problem, { approved });
  return new SingularityFlowError(`${owner} attaches skill '${problem.skillId}', but ${problem.detail}.${where ? ` ${where}` : ''}`
    + ` Run ${repairs[0].command}${repairs.length > 1 ? `, or ${repairs[1].command}` : ''}.`, {
    code: 'SKILL_LIBRARY_MISSING',
    details: {
      ...(problem.agentId ? { agentId: problem.agentId } : { workflowId: problem.workflowId }), skillId: problem.skillId,
      path: problem.path, reason: problem.reason, packaged: problem.reason === 'missing' && shipsLibrarySkill(problem.skillId),
      nextAction: repairs[0], recoveryCommands: repairs
    }
  });
}

/**
 * The refusal for skill `skillId` that an `agent` or a `workflowId` uses: missing, or not valid
 * (`error`), where it is read (a step's prompt, a Story's snapshot).
 */
export function unusableSkillRefusal(root, { agent = null, workflowId = null }, skillId, error, where) {
  const owner = agent ? { agentId: agent.id,
    detachable: agent.scope === 'repository' || (agent.attachedSkills ?? []).some((entry) => entry.id === skillId) } : { workflowId };
  return librarySkillRefusal({ ...owner, skillId, path: librarySkillPath(skillId), ...(error
    ? { reason: 'unreadable', detail: error.message } : { reason: 'missing', detail: `it is not in the skill master (${librarySkillPath(skillId)})` }) },
  { approved: approvedConfigurationIn(root), where });
}

/**
 * Refuse a Story of `workTypeId` that would keep a skill it cannot read, before it starts, with the
 * way out; unrelated workflows' skills are never read. It starts from an approved configuration
 * `snapshot` (its retained bytes) or from the files under `root`'s configuration.
 */
export async function assertStoryLibrarySkills(definition, workTypeId, resolved, { snapshot = null, root = null }) {
  const files = snapshot ? new Map((snapshot.assets ?? []).map((entry) => [entry.relative, entry.contents])) : null;
  const configRoot = snapshot ? null : configurationReadRoot(root);
  const read = files ? async (relative) => (files.has(relative) ? Buffer.from(files.get(relative)).toString('utf8') : null)
    : configurationTextReader(configRoot);
  const attachmentsText = await read(SKILL_ATTACHMENTS_PATH);
  const needs = librarySkillNeeds(definition.agentCatalog ?? Object.values(definition.agents ?? {}),
    attachmentsText == null ? [] : parseSkillAttachments(attachmentsText), definition, storySkillScope(definition, workTypeId, resolved));
  const [problem] = await librarySkillProblems(needs, { read, configRoot });
  if (problem) {
    throw librarySkillRefusal(problem, { approved: Boolean(snapshot) || approvedConfigurationIn(root),
      where: `A Story of workflow '${workTypeId}' keeps it when it starts, so none was started.` });
  }
}
