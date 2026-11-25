/**
 * Skills for each step of a task [ITW:REQ-010, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]: chosen the same way every time
 * from what the step is for and what the task touches, bound to the Story's composed workflow, and frozen into its
 * snapshot like any skill a workflow attaches.
 *
 * - A skill fits a step when one of its tasks is that step's intent (AGENT_TASK_INTENTS, the table marketplace
 *   conversion uses; a library skill names its tasks as `task:<pdlc-task>` tags, or a step intent as `intent:<intent>`),
 *   and the task touches it: it names a kind of software the repository is (web, backend, mobile …, from
 *   software-kinds.mjs and any kind a person recorded) or the person's words name one of its tags. A skill naming only
 *   kinds the repository is not is never chosen.
 * - Sources, in order: the repository's skill library, then the marketplaces the repository trusts (only for a step no
 *   library skill fits): a Git repository read at the commit it trusts, and an HTTPS index read through its own pinned
 *   entries, its listing kept for an hour so a plan read does not fetch it each time. An untrusted marketplace is never
 *   read: only `marketplaces:` in workflow.yml names what is read. An index entry names the steps it is for by their IDs
 *   here (`phases`); each counts as the intent that step has.
 * - A library skill is used as it is, unless it is marked proposed or beta (its `lifecycle:` tag, or the marketplace's
 *   lifecycle its import recorded): that one needs the person's yes (`--use-skill <ID>`). A marketplace skill not yet in
 *   the library is offered, new here: the yes imports it through `import`, its exact text shown, and the next task finds
 *   it in the library. `--without-skill <ID>` is the person's no.
 * - At most two skills per step, ranked by what the task touches, then by ID: the same words and repository give the
 *   same skills.
 *
 * chooseTaskSkills is pure. taskSkillChooser reads the library, the import record, the software kinds and the trusted
 * marketplaces, and nothing is written but a cache of a marketplace's listing: at the commit it is read at, or, for an
 * index, as it was read with the index's digest and when.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AGENT_TASK_INTENTS } from './agent-task-intents.mjs';
import { STEP_INTENTS } from './phase-roles.mjs';
import { SOFTWARE_KINDS } from './software-kinds.mjs';
import { SingularityFlowError } from './util.mjs';

/** The most skills one step of a task is given. */
export const TASK_SKILL_LIMIT = 2;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** A marketplace's or a skill's lifecycle marks: offered directly, needs a person's yes, or never offered. */
const READY = new Set(['approved', 'ga', 'released', 'stable']);
const UNREVIEWED = new Set(['proposed', 'beta', 'alpha', 'draft', 'experimental', 'preview']);
const RETIRED = new Set(['deprecated', 'retired', 'withdrawn', 'archived']);
/** Platform words a skill's tags use for a kind of software. */
const KIND_ALIASES = Object.freeze({ android: 'mobile', ios: 'mobile', 'react-native': 'mobile', flutter: 'mobile', frontend: 'web', browser: 'web',
  api: 'backend', server: 'backend', service: 'backend', batch: 'job', infrastructure: 'artifact', terraform: 'artifact' });
/** Tag words too common to say what a task touches. */
const GENERIC = new Set(['test', 'tests', 'testing', 'automation', 'creation', 'generation', 'management', 'writing', 'writer', 'review', 'code',
  'skill', 'skills', 'pdlc', 'the', 'and', 'for', 'with', 'step', 'steps']);
const KIND_WORDS = Object.freeze({ web: 'a web app', backend: 'a backend', job: 'a batch job', cli: 'a command-line tool', library: 'a library',
  mobile: 'a mobile app', artifact: 'infrastructure files' });

function refusal(code, message, nextAction, details = {}) {
  return new SingularityFlowError(message, { code, details: { ...details, nextAction } });
}

const tokens = (value) => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 2);
const sameWord = (left, right) => left === right
  || (left.length >= 4 && right.length >= 4 && (left === `${right}s` || right === `${left}s`));

/**
 * What a skill's tags and recorded facts say: its tasks and step intents, the kinds of software it is for, its lifecycle
 * mark, and the words that say what it is about.
 */
function facts({ tags = [], tasks = [], lifecycleState = null }) {
  const own = { tasks: [...tasks], intents: [], kinds: [], words: [], state: lifecycleState ? String(lifecycleState).toLowerCase() : null };
  let marked = null;
  for (const raw of tags) {
    const tag = String(raw).toLowerCase();
    const [prefix, value] = tag.includes(':') ? [tag.slice(0, tag.indexOf(':')), tag.slice(tag.indexOf(':') + 1)] : [null, tag];
    if (prefix === 'task') { own.tasks.push(value); continue; }
    if (prefix === 'intent') { if (STEP_INTENTS.includes(value)) own.intents.push(value); continue; }
    if (prefix === 'lifecycle') { marked ??= value; continue; }
    const kind = SOFTWARE_KINDS.includes(value) ? value : KIND_ALIASES[value];
    if ((prefix === null || prefix === 'software') && kind) { own.kinds.push(kind); continue; }
    if (prefix === null && (READY.has(value) || UNREVIEWED.has(value) || RETIRED.has(value))) { marked ??= value; continue; }
    for (const word of tokens(value)) if (!GENERIC.has(word)) own.words.push(word);
  }
  own.state ??= marked;
  for (const task of own.tasks) {
    const intent = AGENT_TASK_INTENTS[task]?.intent;
    if (intent) own.intents.push(intent);
  }
  return { ...own, tasks: [...new Set(own.tasks)], intents: [...new Set(own.intents)], kinds: [...new Set(own.kinds)].sort(),
    words: [...new Set(own.words)].sort() };
}

/** The intent each step of `definition` has, by its ID: how an index entry's `phases` say what it is for. */
export function definitionStepIntent(definition) {
  return (phase) => definition?.phases?.[phase]?.intent ?? null;
}

/** `phases` (step IDs here) as `intent:` tags, by `stepIntent`. */
const phaseTags = (phases = [], stepIntent = null) => (stepIntent ? phases.map(stepIntent).filter(Boolean).map((intent) => `intent:${intent}`) : []);

/**
 * A library skill as a task reads it: its own tags, and, when it came from a marketplace, the tasks, tags, steps and
 * lifecycle its import recorded (singularity/imports.lock.yml), so an imported skill is found by the same step the next
 * time. `stepIntent` (definitionStepIntent) reads an index entry's recorded steps.
 */
export function librarySkillCandidate(skill, imported = null, { stepIntent = null } = {}) {
  const source = ['marketplace-skill', 'marketplace'].includes(imported?.source?.kind) ? imported.source : null;
  const own = facts({ tags: [...(skill.tags ?? []), ...(source?.tags ?? []), ...phaseTags(source?.phases, stepIntent)], tasks: source?.tasks ?? [],
    lifecycleState: source?.lifecycleState ?? null });
  return { id: skill.id, label: skill.label ?? skill.id, source: 'library', marketplace: source?.marketplace ?? null, sha256: skill.sha256,
    ...own, lifecycle: RETIRED.has(own.state) ? 'retired' : UNREVIEWED.has(own.state) ? 'unreviewed' : 'ready' };
}

/**
 * A marketplace's skill as a task reads it: a Git repository's package (marketplace-repository.mjs) or an index's entry
 * (indexMarketplaceSkillEntries), whose `phases` `stepIntent` reads. One with no lifecycle mark needs a yes.
 */
export function marketplaceSkillCandidate(entry, marketplaceId, { stepIntent = null } = {}) {
  const own = facts({ tags: [...(entry.tags ?? []), ...phaseTags(entry.phases, stepIntent)], tasks: entry.pdlcTasks ?? [], lifecycleState: entry.lifecycleState ?? null });
  return { id: entry.name, label: entry.name, source: 'marketplace', marketplace: marketplaceId, version: entry.version ?? null, ...own,
    lifecycle: RETIRED.has(own.state) ? 'retired' : READY.has(own.state) ? 'ready' : 'unreviewed' };
}

/** Why a skill fits a step, in a person's words. */
function why(candidate, step, { kinds, words }) {
  const task = candidate.tasks.find((name) => AGENT_TASK_INTENTS[name]?.intent === step.intent);
  return [
    task ? `its task ${task} is a ${step.intent} step's work` : `it is for ${step.intent} steps`,
    ...kinds.map((kind) => `this repository is ${KIND_WORDS[kind] ?? kind}`),
    ...(words.length ? [`your words say ${words.join(', ')}`] : [])
  ].join('; ');
}

/**
 * The skills for each step of `composition`: `{ skills, offers, byStep }`. `skills` are those the Story uses, each
 * `{ id, steps, sha256, why }`, recorded on its composition and frozen into its snapshot; `offers` are those that need
 * the person's yes first, each `{ id, steps, source, marketplace, state, why }`; `byStep` maps a step to both, for the plan
 * line. `candidates` come from librarySkillCandidate and marketplaceSkillCandidate; `kinds` are the kinds of software the
 * task touches; `use` and `without` are the IDs the person said yes and no to.
 */
export function chooseTaskSkills(composition, { candidates = [], kinds = [], words = '', use = [], without = [] } = {}) {
  // A team's workflow (`use`) or a marketplace agent's (REQ-011) carries its own skills: a task chooses none for it.
  if (composition.uses || composition.agent) return { skills: [], offers: [], byStep: {} };
  const touched = new Set(kinds);
  const said = tokens(words);
  const wanted = new Set(use);
  const declined = new Set(without);
  const libraryIds = new Set(candidates.filter((candidate) => candidate.source === 'library').map((candidate) => candidate.id));
  const picked = new Map();
  const byStep = {};
  for (const step of composition.steps) {
    const fits = candidates
      .filter((candidate) => !declined.has(candidate.id) && candidate.lifecycle !== 'retired' && candidate.intents.includes(step.intent))
      .filter((candidate) => candidate.source === 'library' || !libraryIds.has(candidate.id))
      .map((candidate) => {
        const kindHits = candidate.kinds.filter((kind) => touched.has(kind));
        const wordHits = candidate.words.filter((word) => said.some((token) => sameWord(token, word)));
        return { candidate, kindHits, wordHits, named: wanted.has(candidate.id),
          fits: wanted.has(candidate.id) || ((!candidate.kinds.length || kindHits.length > 0) && (kindHits.length > 0 || wordHits.length > 0)) };
      })
      .filter((entry) => entry.fits)
      .sort((left, right) => Number(right.named) - Number(left.named)
        || (right.kindHits.length ? 2 : 0) + right.wordHits.length - ((left.kindHits.length ? 2 : 0) + left.wordHits.length)
        || (left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0));
    // The library first: a marketplace is offered only for a step the library has nothing for.
    const fromLibrary = fits.filter((entry) => entry.candidate.source === 'library');
    const chosen = (fromLibrary.length ? fromLibrary : fits).filter((entry, index) => entry.named || index < TASK_SKILL_LIMIT);
    for (const entry of chosen) {
      const { candidate } = entry;
      const status = candidate.source === 'marketplace' ? 'new' : candidate.lifecycle === 'unreviewed' && !entry.named ? 'yes' : 'used';
      const current = picked.get(candidate.id) ?? { candidate, status, steps: [], why: why(candidate, step, { kinds: entry.kindHits, words: entry.wordHits }) };
      current.steps.push(step.id);
      picked.set(candidate.id, current);
      (byStep[step.id] ??= []).push({ id: candidate.id, status, marketplace: candidate.source === 'marketplace' ? candidate.marketplace : null,
        state: candidate.lifecycle === 'unreviewed' ? candidate.state ?? 'not yet approved' : null });
    }
  }
  const named = [...wanted].filter((id) => !picked.has(id));
  if (named.length) {
    const id = named[0];
    const there = candidates.find((candidate) => candidate.id === id);
    if (!there) {
      throw refusal('TASK_SKILL_UNKNOWN', `There is no skill '${id}' in this repository's skill library or its trusted marketplaces.`,
        { command: 'singularity-flow skill list', label: 'See the skills in this repository\'s library.' }, { skill: id });
    }
    throw refusal('TASK_SKILL_NO_STEP', `${id} is for ${there.intents.join(' or ') || 'no kind of'} step, and this ${composition.kind} task has none.`,
      { command: `singularity-flow work "<what you want done>" --kind ${composition.kind}`, label: 'Plan the task without it.' },
      { skill: id, intents: there.intents });
  }
  const entries = [...picked.values()];
  return {
    skills: entries.filter((entry) => entry.status === 'used')
      .map((entry) => ({ id: entry.candidate.id, steps: entry.steps, sha256: entry.candidate.sha256, why: entry.why })),
    offers: entries.filter((entry) => entry.status !== 'used').map((entry) => ({
      id: entry.candidate.id, steps: entry.steps, source: entry.candidate.source, marketplace: entry.candidate.marketplace ?? null,
      new: entry.status === 'new', state: entry.candidate.lifecycle === 'unreviewed' ? entry.candidate.state ?? 'not yet approved' : null,
      why: entry.why, ...(entry.candidate.version ? { version: entry.candidate.version } : {}) })),
    byStep
  };
}

/** A skill as the plan line names it: used, needing a yes, or new here [ITW:REQ-012]. */
export function planSkillWords(entries = []) {
  const used = entries.filter((entry) => entry.status === 'used').map((entry) => entry.id);
  const parts = [];
  if (used.length) parts.push(`with ${used.length > 1 ? `${used.slice(0, -1).join(', ')} and ${used.at(-1)}` : used[0]}`);
  for (const entry of entries.filter((item) => item.status !== 'used')) {
    parts.push(entry.status === 'new'
      ? `with ${entry.id} from ${entry.marketplace}, ${entry.state ? `${entry.state} and ` : ''}new here: add it?`
      : `with ${entry.id}, ${entry.state}: use it?`);
  }
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/** The kinds of software the task touches: the projects its paths are in, else every project's, as recorded or detected. */
export async function taskSoftwareKinds(root, touchedPaths = []) {
  const [{ checkoutFilesWithText }, { detectSoftwareKinds, softwareKindTextFiles }, record] = await Promise.all([
    import('./repository-projects-source.mjs'), import('./software-kinds.mjs'), import('./software-kind-record.mjs')]);
  let detected;
  try { detected = detectSoftwareKinds(checkoutFilesWithText(root, (files) => softwareKindTextFiles(files))); } catch { return []; }
  const recorded = new Map(((await record.recordedSoftwareKinds(root).catch(() => null))?.projects ?? []).map((project) => [project.id, project.kind]));
  const projects = detected.projects.map((project) => ({ ...project, kind: recorded.get(project.id) ?? project.kind }));
  const touched = touchedPaths.length ? record.kindsTouched({ projects }, touchedPaths) : [];
  return [...new Set((touched.length ? touched : projects).map((project) => project.kind).filter(Boolean))].sort();
}

// v2 keeps each skill's description too, for the page of every skill (skill-catalog.mjs); a v1 listing is read again once.
const CATALOG_FORMAT = 'sflow-task-marketplace-skills/v2';
// A marketplace's agents, each with its agent.md, for a marketplace agent as a task's plan [ITW:REQ-011]. v2 keeps each
// skill's SHA-256 too, so the marketplace page (marketplace-catalog.mjs) tells an installed copy from a changed one; a v1
// listing is read again once.
const AGENTS_FORMAT = 'sflow-task-marketplace-agents/v2';

/** Where a trusted marketplace's listing at its pinned commit is kept: the clone's Git folder, one file per commit. */
async function listingFile(root, folder, marketplace) {
  const { repositoryGitPath } = await import('./git-directory.mjs');
  const key = createHash('sha256').update(`${marketplace.repository}\n${marketplace.commit}`).digest('hex');
  return path.join(repositoryGitPath(root, 'singularity-flow', folder), `${key}.json`);
}

/** The listing kept in `file` for `marketplace` at its commit, or null when none is kept (or it is of another format). */
async function keptListing(file, format, marketplace, field) {
  try {
    const kept = JSON.parse(await readFile(file, 'utf8'));
    if (kept?.format === format && kept.repository === marketplace.repository && kept.commit === marketplace.commit && Array.isArray(kept[field])) return kept;
  } catch { /* not kept yet */ }
  return null;
}

async function keepListing(file, value) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value)}\n`);
  } catch { /* the listing is read again next time */ }
}

const listingSkills = (listing) => listing.packages.filter((entry) => entry.kind === 'skill' && ID.test(entry.name)).map((entry) => ({
  name: entry.name, version: entry.version ?? null, description: entry.description ?? null, tags: entry.tags ?? [], pdlcTasks: entry.pdlcTasks ?? [],
  lifecycleState: entry.lifecycleState ?? null }));

/**
 * A trusted marketplace's skill packages at the commit the repository trusts. The listing at a pinned commit never
 * changes, so it is kept in the clone's Git folder and read once per commit; reading it again would fetch the same commit.
 * `skill catalog` (skill-catalog.mjs) reads a marketplace through this same listing.
 */
export async function trustedMarketplaceSkills(root, marketplace) {
  const file = await listingFile(root, 'task-marketplace-skills', marketplace);
  const kept = await keptListing(file, CATALOG_FORMAT, marketplace, 'skills');
  if (kept) return kept.skills;
  const { readMarketplaceRepository } = await import('./marketplace-repository.mjs');
  const skills = listingSkills(await readMarketplaceRepository(marketplace));
  await keepListing(file, { format: CATALOG_FORMAT, repository: marketplace.repository, commit: marketplace.commit, skills });
  return skills;
}

const INDEX_LISTING_FORMAT = 'sflow-task-index-skills/v1';
/** How long an index marketplace's skill listing is used before it is read again. */
export const INDEX_LISTING_FRESH_MS = 60 * 60 * 1000;

/** An index's skill entries as a task reads them: the newest version of each (by marketplace.mjs compareVersions). */
export function indexMarketplaceSkillEntries(index, compareVersions) {
  const newest = new Map();
  for (const entry of index.entries.filter((item) => item.kind === 'skill' && ID.test(item.id))) {
    const kept = newest.get(entry.id);
    if (!kept || compareVersions(entry.version, kept.version) > 0) newest.set(entry.id, entry);
  }
  return [...newest.values()].sort((left, right) => (left.id < right.id ? -1 : 1)).map((entry) => ({ name: entry.id, label: entry.label ?? entry.id,
    version: entry.version ?? null, description: entry.description ?? null, tags: [...(entry.tags ?? [])], phases: [...(entry.phases ?? [])], pdlcTasks: [],
    lifecycleState: null }));
}

/**
 * A trusted HTTPS index marketplace's skills (A7: only one `marketplaces:` names). Its index is fetched through the hardened
 * reader, which checks every entry against the marketplace's allowed origins (marketplace.mjs); the listing is kept in the
 * clone's Git folder with the index's digest, when it was read, and the validators the server gave (ETag, Last-Modified),
 * and used for INDEX_LISTING_FRESH_MS, so a plan read does not fetch the index each time. Past that hour, or when `fresh`
 * reads it now (`skill catalog`, which a person refreshes), a kept listing with validators asks the index whether it
 * changed: a 304 from the same address keeps that listing, checked when it was read, and starts its hour again; any other
 * answer is read and checked in full, and a listing with no validators is read in full, by age as before. An import of
 * one of its skills fetches and verifies the entry's own file again, by its pinned SHA-256.
 */
export async function trustedIndexMarketplaceSkills(root, marketplace, { fetchImpl = globalThis.fetch, fresh = false, now = Date.now() } = {}) {
  const { repositoryGitPath } = await import('./git-directory.mjs');
  const origins = [...(marketplace.allowedOrigins ?? [])].sort();
  const key = createHash('sha256').update(`${marketplace.index}\n${origins.join(' ')}`).digest('hex');
  const file = path.join(repositoryGitPath(root, 'singularity-flow', 'task-marketplace-skills'), `index-${key}.json`);
  let kept = null;
  try {
    const read = JSON.parse(await readFile(file, 'utf8'));
    if (read?.format === INDEX_LISTING_FORMAT && read.index === marketplace.index && JSON.stringify(read.allowedOrigins) === JSON.stringify(origins)
      && Array.isArray(read.skills)) kept = read;
  } catch { /* not kept yet */ }
  const age = now - Date.parse(kept?.readAt ?? '');
  if (kept && !fresh && age >= 0 && age < INDEX_LISTING_FRESH_MS) return kept.skills;
  const keep = async (value) => {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ format: INDEX_LISTING_FORMAT, index: marketplace.index, allowedOrigins: origins, ...value, readAt: new Date(now).toISOString() })}\n`);
    } catch { /* the index is read again next time */ }
  };
  const validators = (from) => ({ ...(from.etag ? { etag: from.etag } : {}), ...(from.lastModified ? { lastModified: from.lastModified } : {}) });
  const { compareVersions, fetchMarketplaceIndex } = await import('./marketplace.mjs');
  const asked = kept && (kept.etag || kept.lastModified) && kept.resolvedIndex ? validators(kept) : null;
  let index = await fetchMarketplaceIndex(marketplace, { fetchImpl, conditional: asked });
  if (index.notModified) {
    // The same list, from the address it was read at: kept, with its digest, and its hour starts again.
    if (index.resolvedIndex === kept.resolvedIndex) {
      await keep({ indexSha256: kept.indexSha256, resolvedIndex: kept.resolvedIndex, ...validators({ ...kept, ...index }), skills: kept.skills });
      return kept.skills;
    }
    index = await fetchMarketplaceIndex(marketplace, { fetchImpl });
  }
  const skills = indexMarketplaceSkillEntries(index, compareVersions);
  await keep({ indexSha256: index.indexSha256, resolvedIndex: index.resolvedIndex, ...validators(index), skills });
  return skills;
}

/** Whether two `marketplaces:` entries trust the same thing: the same repository and commit, or the same index and origins. */
export const sameMarketplaceTrust = (left, right) => ['repository', 'ref', 'commit', 'index'].every((key) => (left[key] ?? null) === (right[key] ?? null))
  && JSON.stringify([...(left.allowedOrigins ?? [])].sort()) === JSON.stringify([...(right.allowedOrigins ?? [])].sort());

const NOT_APPROVED_WORDS = Object.freeze({
  added: 'Trusted only in your working copy of workflow.yml, and not approved yet: Stories do not use it, so its skills are not read.',
  changed: 'Your working copy of workflow.yml reads it elsewhere (another commit or index), and that is not approved yet: these are the skills Stories use.',
  removed: 'Your working copy of workflow.yml stops trusting it, and that is not approved yet: Stories still use it.'
});

/**
 * What this checkout's own workflow.yml trusts that the approved configuration does not, or trusts otherwise: each
 * `{ id, label, kind, change, words }`, `change` one of added, changed or removed. Empty when the working tree is the
 * configuration (no approved one is known here). The skill catalog and the marketplace page both say so.
 */
export function unapprovedMarketplaces(approved = {}, working = {}) {
  const found = [];
  for (const id of [...new Set([...Object.keys(approved), ...Object.keys(working)])].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const here = working[id]; const there = approved[id];
    const change = here && !there ? 'added' : there && !here ? 'removed' : sameMarketplaceTrust(here, there) ? null : 'changed';
    if (!change) continue;
    const entry = here ?? there;
    found.push({ id, label: entry.label ?? id, kind: entry.repository ? 'repository' : 'index', change, words: NOT_APPROVED_WORDS[change] });
  }
  return found;
}

/**
 * The marketplaces the approved configuration trusts, from this clone's own refs (no fetch), or null when no approved
 * configuration is known here and the working tree is the configuration. A marketplace only a working-copy edit trusts is
 * not trusted yet (A7).
 */
async function approvedMarketplaces(root) {
  const [{ withApprovedConfigurationRead }, { configuredMarketplaces }] = await Promise.all([
    import('./approved-configuration-reader.mjs'), import('./marketplace.mjs')]);
  return withApprovedConfigurationRead(root, (authority) => (authority && authority.kind !== 'working-tree' ? configuredMarketplaces(root) : null),
    { preferAuthority: true, refreshAuthority: false, selectPaths: ['singularity/workflow.yml'] });
}

/** A trusted marketplace's skills, as each kind is read: a Git repository at its commit, an index through its listing. */
export function trustedSkillsOf(root, marketplace, options = {}) {
  return marketplace.repository ? trustedMarketplaceSkills(root, marketplace) : trustedIndexMarketplaceSkills(root, marketplace, options);
}

/**
 * A trusted marketplace's agents at the commit the repository trusts, each with what its apm.yml says and its agent.md
 * text, and its skills as trustedMarketplaceSkills lists them: what convertAgent (agent-workflow.mjs) reads to tell what
 * each stage of an agent is for [ITW:REQ-011]. Kept like the skill listing, once per commit; the same read keeps the
 * skill listing too, so a task's skills do not fetch that commit again.
 */
export async function trustedMarketplaceAgents(root, marketplace) {
  const file = await listingFile(root, 'task-marketplace-agents', marketplace);
  const kept = await keptListing(file, AGENTS_FORMAT, marketplace, 'agents');
  if (kept && Array.isArray(kept.skills)) return { agents: kept.agents, skills: kept.skills };
  const { readMarketplaceRepository } = await import('./marketplace-repository.mjs');
  // Each skill's SKILL.md is read too, for its SHA-256 alone: what an import of it would add (marketplace-catalog.mjs).
  const listing = await readMarketplaceRepository(marketplace, { documents: (packages) => packages.filter((entry) => ['agent', 'skill'].includes(entry.kind)).map((entry) => entry.name) });
  const agents = listing.packages.filter((entry) => entry.kind === 'agent' && ID.test(entry.name) && typeof entry.text === 'string').map((entry) => ({
    name: entry.name, version: entry.version ?? null, description: entry.description ?? null, lifecycleState: entry.lifecycleState ?? null,
    pdlcPhases: entry.pdlcPhases ?? [], pdlcTasks: entry.pdlcTasks ?? [], tags: entry.tags ?? [], skills: entry.skills ?? [],
    maintainer: entry.maintainer ?? null, sourceRepository: entry.sourceRepository ?? null, document: entry.document ?? null,
    manifestSha256: entry.manifestSha256 ?? null, text: entry.text }));
  const texts = new Map(listing.packages.filter((entry) => entry.kind === 'skill' && typeof entry.text === 'string').map((entry) => [entry.name, entry.text]));
  const skills = listingSkills(listing).map((skill) => ({ ...skill,
    sha256: texts.has(skill.name) ? createHash('sha256').update(texts.get(skill.name), 'utf8').digest('hex') : null }));
  await keepListing(file, { format: AGENTS_FORMAT, repository: marketplace.repository, commit: marketplace.commit, agents, skills });
  const skillFile = await listingFile(root, 'task-marketplace-skills', marketplace);
  if (!await keptListing(skillFile, CATALOG_FORMAT, marketplace, 'skills')) {
    await keepListing(skillFile, { format: CATALOG_FORMAT, repository: marketplace.repository, commit: marketplace.commit, skills });
  }
  return { agents, skills };
}

/**
 * The chooser `taskPlan` calls with the composed steps: it reads the repository's library and import record, the kinds of
 * software the task touches, and, for a step the library has nothing for, the marketplaces `definition` trusts. With no
 * library skill naming a task and no trusted marketplace, it reads nothing more and chooses nothing. `fetchImpl` reads an
 * index marketplace.
 */
export function taskSkillChooser(root, definition, { words = '', touchedPaths = [], use = [], without = [], fetchImpl = globalThis.fetch } = {}) {
  return async (composition) => {
    const notes = [];
    if (composition.agent) return { skills: [], offers: [], byStep: {}, notes };
    const [{ configurationReadRoot }, { loadSkillLibrary }, { loadImportsLedger }] = await Promise.all([
      import('./configuration-read-scope.mjs'), import('./skill-library.mjs'), import('./imports-ledger.mjs')]);
    const configRoot = configurationReadRoot(root);
    const library = await loadSkillLibrary(configRoot).catch(() => ({ skills: new Map() }));
    const ledger = await loadImportsLedger(configRoot).catch(() => ({ imports: {} }));
    const stepIntent = definitionStepIntent(definition);
    const candidates = [...library.skills.values()].map((skill) => librarySkillCandidate(skill, ledger.imports?.[`library-skill:${skill.id}`], { stepIntent }));
    const marketplaces = Object.values(definition.marketplaces ?? {}).filter((entry) => (entry?.repository && entry.commit) || entry?.index)
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    if (!candidates.some((candidate) => candidate.intents.length) && !marketplaces.length && !use.length) return { skills: [], offers: [], byStep: {}, notes };
    const kinds = await taskSoftwareKinds(root, touchedPaths);
    const fromLibrary = chooseTaskSkills(composition, { candidates, kinds, words, use: use.filter((id) => candidates.some((entry) => entry.id === id)), without });
    const bare = composition.steps.filter((step) => !fromLibrary.byStep[step.id]?.length);
    const namedElsewhere = use.some((id) => !candidates.some((entry) => entry.id === id));
    if ((bare.length || namedElsewhere) && marketplaces.length) {
      const approved = await approvedMarketplaces(root).catch(() => null);
      for (const named of marketplaces) {
        // Read as the approved configuration trusts it (its commit or index), which is what an import of it reads.
        const marketplace = approved ? approved[named.id] ?? null : named;
        if (!marketplace) {
          notes.push(`Marketplace ${named.id} is trusted only in your working copy of workflow.yml, and that is not approved yet, so its skills are not offered.`);
          continue;
        }
        try {
          candidates.push(...(await trustedSkillsOf(root, marketplace, { fetchImpl })).map((entry) => marketplaceSkillCandidate(entry, marketplace.id, { stepIntent })));
        } catch (error) {
          notes.push(`Marketplace ${marketplace.id} could not be read, so its skills are not offered: ${String(error?.message ?? error).split('\n')[0]}`);
        }
      }
    }
    const named = use.find((id) => !candidates.some((entry) => entry.source === 'library' && entry.id === id) && candidates.some((entry) => entry.id === id));
    if (named) {
      const offered = candidates.find((entry) => entry.id === named);
      throw refusal('TASK_SKILL_NOT_IN_LIBRARY', `${named} is in marketplace ${offered.marketplace} but not yet in this repository's skill library: its import is added, and reviewed, before a task uses it.`,
        { command: `singularity-flow import preview "market:${offered.marketplace}/${named}" --as skill --json`, label: `Show ${named}'s text; if the person says yes, run its addCommand.` },
        { skill: named, marketplace: offered.marketplace });
    }
    return { ...chooseTaskSkills(composition, { candidates, kinds, words, use, without }), kinds, notes };
  };
}
