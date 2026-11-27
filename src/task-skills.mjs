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
 * - Sources, in order: the repository's skill library, then the repository's own skills beside it (a SKILL.md in
 *   .github/skills or .agents/skills, written here or installed by APM, read by task-local.mjs) for a step no library
 *   skill fits [ITW:REQ-020], then the marketplaces the repository trusts (only for a step no library or own skill
 *   fits): a Git repository read at the commit it trusts, and an HTTPS index read through its own pinned
 *   entries, its listing kept for an hour so a plan read does not fetch it each time. An untrusted marketplace is never
 *   read: only `marketplaces:` in workflow.yml names what is read. An index entry names the steps it is for by their IDs
 *   here (`phases`); each counts as the intent that step has. A skill in the library and in another place is the
 *   library's; one the repository has is never offered from a marketplace.
 * - A library skill is used as it is, unless it is marked proposed or beta (its `lifecycle:` tag, or the marketplace's
 *   lifecycle): that one needs the person's yes (`--use-skill <ID>`). A marketplace skill not yet in the library is
 *   offered, new here: the yes imports it through `import`, its exact text shown, and the next task finds it in the
 *   library. `--without-skill <ID>` is the person's no. The lifecycle words are marketplace-lifecycle.mjs's [OMK:REQ-010];
 *   a deprecated or retired skill is never offered.
 * - The lifecycle that counts for a library skill imported from a trusted marketplace is the marketplace's at the commit
 *   it is trusted at now (an index's as last read), not the one recorded at import [OMK:REQ-011]: one deprecated since is
 *   never offered once the pin moves. When that marketplace cannot be read, the recorded one is used, and a note says so.
 * - The plan line names each offered skill's owner and state [OMK:REQ-015].
 * - A library skill whose text SFlow's text checks refuse (installed-text-safety.mjs) is never offered or used: the plan
 *   line names it where it would have fitted, or where the team's own workflow attaches it [OMK:REQ-032]. It stays in the
 *   library, and a running Story keeps its snapshot.
 * - A library skill its marketplace deprecated or retired (at the commit trusted now) is never offered or used: the plan
 *   line names it, with who deprecated it and its replacement, where it would have fitted, and a step it leaves bare is
 *   offered the marketplace's skills, its replacement among them when that fits. The team's own workflow keeps a skill it
 *   attaches, named the same way, and a note says when that workflow was made from a deprecated agent [OMK:REQ-041].
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
import { isLifecycleWord, lifecycleReadiness, lifecycleStateOf } from './marketplace-lifecycle.mjs';
import { STEP_INTENTS } from './phase-roles.mjs';
import { SOFTWARE_KINDS } from './software-kinds.mjs';
import { SingularityFlowError } from './util.mjs';

/** The most skills one step of a task is given. */
export const TASK_SKILL_LIMIT = 2;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
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
    if (prefix === null && isLifecycleWord(value)) { marked ??= value; continue; }
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

/** The lifecycle word a marketplace entry carries: its record's, else its apm.yml's lifecycle-state [OMK:REQ-002]. */
export const entryLifecycleWord = (entry) => entry?.lifecycleRecord?.word ?? entry?.lifecycle?.word ?? entry?.lifecycleState ?? null;

/**
 * A library skill as a task reads it: its own tags, and, when it came from a marketplace, the tasks, tags, steps and
 * lifecycle its import recorded (singularity/imports.lock.yml), so an imported skill is found by the same step the next
 * time. `stepIntent` (definitionStepIntent) reads an index entry's recorded steps. `trusted` is the same skill in its
 * marketplace at the commit trusted now: its lifecycle is the one that counts [OMK:REQ-011]; with none, the recorded one
 * is used (`lifecycleFrom: 'recorded'`).
 */
export function librarySkillCandidate(skill, imported = null, { stepIntent = null, trusted = null } = {}) {
  const source = ['marketplace-skill', 'marketplace'].includes(imported?.source?.kind) ? imported.source : null;
  const trustedWord = trusted ? entryLifecycleWord(trusted) : null;
  const own = facts({ tags: [...(skill.tags ?? []), ...(source?.tags ?? []), ...phaseTags(source?.phases, stepIntent)], tasks: source?.tasks ?? [],
    lifecycleState: trusted ? trustedWord : source?.lifecycleState ?? null });
  return { id: skill.id, label: skill.label ?? skill.id, source: 'library', marketplace: source?.marketplace ?? null, sha256: skill.sha256,
    owner: trusted?.owner?.name ?? source?.owner?.name ?? null, ...own,
    ...(source ? { lifecycleFrom: trusted ? 'trusted' : 'recorded' } : {}),
    // Who replaces it, when its marketplace deprecated it [OMK:REQ-042]: what the plan line names.
    ...(trusted?.lifecycleRecord?.deprecation?.replacedBy ? { replacedBy: trusted.lifecycleRecord.deprecation.replacedBy } : {}),
    // A library skill written here, with no mark, is used as it is [OMK §5.1].
    lifecycle: lifecycleReadiness(own.state, { unmarked: 'ready' }) };
}

/**
 * A skill of the repository's own beside the library, as a task reads it [ITW:REQ-020]: `skill` as parseLibrarySkill
 * reads its SKILL.md, `path` where it is (the Story's snapshot reads it there), `apm` the APM package that installed it,
 * and `own`, what that package's apm.yml says of it (its tasks, tags and lifecycle) when APM's copy of the package is
 * on this computer. Its tags say what it is for, as a library skill's do; one with no mark is used as it is.
 */
export function localSkillCandidate(skill, { path: where, apm = null, own = null } = {}) {
  const read = facts({ tags: [...(skill.tags ?? []), ...(own?.tags ?? [])], tasks: own?.pdlcTasks ?? [], lifecycleState: own?.lifecycleState ?? null });
  return { id: skill.id, label: skill.label ?? skill.id, source: 'local', path: where, apm, marketplace: null, sha256: skill.sha256, owner: null, ...read,
    lifecycle: lifecycleReadiness(read.state, { unmarked: 'ready' }) };
}

/**
 * A marketplace's skill as a task reads it: a Git repository's package (marketplace-repository.mjs) or an index's entry
 * (indexMarketplaceSkillEntries), whose `phases` `stepIntent` reads. One with no lifecycle mark needs a yes.
 */
export function marketplaceSkillCandidate(entry, marketplaceId, { stepIntent = null } = {}) {
  const own = facts({ tags: [...(entry.tags ?? []), ...phaseTags(entry.phases, stepIntent)], tasks: entry.pdlcTasks ?? [], lifecycleState: entryLifecycleWord(entry) });
  return { id: entry.name, label: entry.name, source: 'marketplace', marketplace: marketplaceId, version: entry.version ?? null, owner: entry.owner?.name ?? null, ...own,
    lifecycle: lifecycleReadiness(own.state) };
}

/** Why a skill fits a step, in a person's words. */
function why(candidate, step, { kinds, words }) {
  const task = candidate.tasks.find((name) => AGENT_TASK_INTENTS[name]?.intent === step.intent);
  return [
    task ? `its task ${task} is a ${step.intent} step's work` : `it is for ${step.intent} steps`,
    ...kinds.map((kind) => `this repository is ${KIND_WORDS[kind] ?? kind}`),
    ...(words.length ? [`your words say ${words.join(', ')}`] : []),
    // Where a skill of the repository's own is [ITW:REQ-020].
    ...(candidate.source === 'local' ? [candidate.apm ? `APM installed it (${candidate.apm})` : `it is this repository's own (${candidate.path})`] : [])
  ].join('; ');
}

/** Whether a skill fits what the task touches: no kind of software, or one the task touches, and a kind or a word named. */
function skillFits(candidate, touched, said) {
  const kindHits = candidate.kinds.filter((kind) => touched.has(kind));
  const wordHits = candidate.words.filter((word) => said.some((token) => sameWord(token, word)));
  return (!candidate.kinds.length || kindHits.length > 0) && (kindHits.length > 0 || wordHits.length > 0);
}

/** A library skill its marketplace deprecated or retired, as the plan line names it: not used, or attached by the team's workflow. */
const deprecatedEntry = (candidate, status) => ({ id: candidate.id, status, marketplace: null, state: lifecycleStateOf(candidate.state),
  owner: candidate.owner ?? null, replacedBy: candidate.replacedBy ?? null });

/** What a plan line's entry is when no step is given it: a skill the checks refuse, or one its marketplace deprecated. */
export const NOT_GIVEN = Object.freeze(new Set(['withheld', 'deprecated', 'deprecated-attached']));

/**
 * The skills for each step of `composition`: `{ skills, offers, byStep }`. `skills` are those the Story uses, each
 * `{ id, steps, sha256, why }` (and, for one of the repository's own, its `path` and `from`), recorded on its composition
 * and frozen into its snapshot; `offers` are those that need the person's yes first, each
 * `{ id, steps, source, marketplace, state, why }`; `byStep` maps a step to both, for the plan line. `candidates` come
 * from librarySkillCandidate, localSkillCandidate and marketplaceSkillCandidate; `kinds` are the kinds of software the
 * task touches; `use` and `without` are the IDs the person said yes and no to.
 */
export function chooseTaskSkills(composition, { candidates = [], kinds = [], words = '', use = [], without = [] } = {}) {
  // A team's workflow (`use`, or the one the person chose, REQ-020) or a marketplace agent's (REQ-011) carries its own
  // skills: a task chooses none for it.
  if (composition.uses || composition.agent) return { skills: [], offers: [], byStep: {} };
  const touched = new Set(kinds);
  const said = tokens(words);
  const wanted = new Set(use);
  const declined = new Set(without);
  const libraryIds = new Set(candidates.filter((candidate) => candidate.source === 'library').map((candidate) => candidate.id));
  const localIds = new Set(candidates.filter((candidate) => candidate.source === 'local').map((candidate) => candidate.id));
  const picked = new Map();
  const byStep = {};
  for (const step of composition.steps) {
    // A skill SFlow's text checks refuse is never offered; where it would have fitted, the plan line says so [OMK:REQ-032].
    for (const candidate of candidates.filter((entry) => entry.safety === 'blocked' && !declined.has(entry.id) && entry.intents.includes(step.intent))) {
      if (!(byStep[step.id] ??= []).some((entry) => entry.id === candidate.id)) byStep[step.id].push({ id: candidate.id, status: 'withheld', marketplace: null, state: null, owner: null });
    }
    // A library skill its marketplace deprecated or retired is never offered; where it would have fitted, the plan line
    // names it with its replacement [OMK:REQ-041], and a step it leaves bare is offered the replacement when that fits.
    for (const candidate of candidates.filter((entry) => entry.source === 'library' && entry.lifecycle === 'retired' && entry.safety !== 'blocked'
      && !declined.has(entry.id) && entry.intents.includes(step.intent) && skillFits(entry, touched, said))) {
      if (!(byStep[step.id] ??= []).some((entry) => entry.id === candidate.id)) byStep[step.id].push(deprecatedEntry(candidate, 'deprecated'));
    }
    const fits = candidates
      .filter((candidate) => !declined.has(candidate.id) && candidate.lifecycle !== 'retired' && candidate.safety !== 'blocked' && candidate.intents.includes(step.intent))
      // One ID, one skill: the library's copy, else the repository's own, else a marketplace's [ITW:REQ-020].
      .filter((candidate) => candidate.source === 'library' || (!libraryIds.has(candidate.id) && (candidate.source === 'local' || !localIds.has(candidate.id))))
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
    // The library first, then the repository's own skills: a marketplace is offered only for a step neither has anything for.
    const fromLibrary = fits.filter((entry) => entry.candidate.source === 'library');
    const fromHere = fits.filter((entry) => entry.candidate.source === 'local');
    const chosen = (fromLibrary.length ? fromLibrary : fromHere.length ? fromHere : fits).filter((entry, index) => entry.named || index < TASK_SKILL_LIMIT);
    for (const entry of chosen) {
      const { candidate } = entry;
      const status = candidate.source === 'marketplace' ? 'new' : candidate.lifecycle === 'unreviewed' && !entry.named ? 'yes' : 'used';
      const current = picked.get(candidate.id) ?? { candidate, status, steps: [], why: why(candidate, step, { kinds: entry.kindHits, words: entry.wordHits }) };
      current.steps.push(step.id);
      picked.set(candidate.id, current);
      (byStep[step.id] ??= []).push({ id: candidate.id, status, marketplace: candidate.source === 'marketplace' ? candidate.marketplace : null,
        state: candidate.lifecycle === 'unreviewed' ? candidate.state ?? 'not yet approved' : null, owner: candidate.owner ?? null });
    }
  }
  const named = [...wanted].filter((id) => !picked.has(id));
  if (named.length) {
    const id = named[0];
    const there = candidates.find((candidate) => candidate.id === id);
    if (there?.safety === 'blocked') {
      throw refusal('TASK_SKILL_TEXT_REFUSED', `SFlow's text checks refuse ${id}'s text, so no task uses it. It stays in the library until a person updates or removes it.`,
        { command: `singularity-flow skill show ${id}`, label: `Show ${id} and who uses it.` }, { skill: id });
    }
    if (!there) {
      throw refusal('TASK_SKILL_UNKNOWN', `There is no skill '${id}' in this repository's skill library, its own skills or its trusted marketplaces.`,
        { command: 'singularity-flow skill list', label: 'See the skills in this repository\'s library.' }, { skill: id });
    }
    throw refusal('TASK_SKILL_NO_STEP', `${id} is for ${there.intents.join(' or ') || 'no kind of'} step, and this ${composition.kind} task has none.`,
      { command: `singularity-flow work "<what you want done>" --kind ${composition.kind}`, label: 'Plan the task without it.' },
      { skill: id, intents: there.intents });
  }
  const entries = [...picked.values()];
  return {
    // A skill of the repository's own records where it is and who put it there, for the snapshot [ITW:REQ-020].
    skills: entries.filter((entry) => entry.status === 'used')
      .map((entry) => ({ id: entry.candidate.id, steps: entry.steps, sha256: entry.candidate.sha256, why: entry.why,
        ...(entry.candidate.source === 'local' ? { path: entry.candidate.path, from: entry.candidate.apm ? 'apm' : 'repository',
          ...(entry.candidate.apm ? { package: entry.candidate.apm } : {}) } : {}) })),
    offers: entries.filter((entry) => entry.status !== 'used').map((entry) => ({
      id: entry.candidate.id, steps: entry.steps, source: entry.candidate.source, marketplace: entry.candidate.marketplace ?? null,
      new: entry.status === 'new', state: entry.candidate.lifecycle === 'unreviewed' ? entry.candidate.state ?? 'not yet approved' : null,
      owner: entry.candidate.owner ?? null, why: entry.why, ...(entry.candidate.version ? { version: entry.candidate.version } : {}) })),
    byStep
  };
}

/**
 * A skill as the plan line names it: used, needing a yes, or new here [ITW:REQ-012], with its owner [OMK:REQ-015]; or
 * withheld, as SFlow's text checks refuse its text [OMK:REQ-032].
 */
export function planSkillWords(entries = []) {
  const used = entries.filter((entry) => entry.status === 'used').map((entry) => entry.id);
  const parts = [];
  if (used.length) parts.push(`with ${used.length > 1 ? `${used.slice(0, -1).join(', ')} and ${used.at(-1)}` : used[0]}`);
  for (const entry of entries.filter((item) => item.status === 'withheld')) parts.push(`not ${entry.id}: SFlow's text checks refuse its text`);
  // Deprecated or retired by its marketplace [OMK:REQ-041]: not used by a task's own steps; the team's workflow keeps it.
  const by = (entry) => `${entry.state ?? 'deprecated'}${entry.owner ? ` by ${entry.owner}` : ''}`;
  for (const entry of entries.filter((item) => item.status === 'deprecated')) parts.push(`not ${entry.id}: it is ${by(entry)}${entry.replacedBy ? `; ${entry.replacedBy} replaces it` : ''}`);
  for (const entry of entries.filter((item) => item.status === 'deprecated-attached')) parts.push(`${entry.id} is ${by(entry)}${entry.replacedBy ? `: ${entry.replacedBy} replaces it` : ''}`);
  for (const entry of entries.filter((item) => !['used', ...NOT_GIVEN].includes(item.status))) {
    const owner = entry.owner ? ` (${entry.owner})` : '';
    parts.push(entry.status === 'new'
      ? `with ${entry.id} from ${entry.marketplace}${owner}, ${entry.state ? `${entry.state} and ` : ''}new here: add it?`
      : `with ${entry.id}${owner}, ${entry.state}: use it?`);
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

// v2 kept each skill's description too, for the page of every skill (skill-catalog.mjs). v3 keeps each item's owner,
// lifecycle record and the marketplace's findings on them, and the marketplace's channels [OMK:REQ-006]; a v2 listing is
// read again once.
const CATALOG_FORMAT = 'sflow-task-marketplace-skills/v3';
// A marketplace's agents, each with its agent.md, for a marketplace agent as a task's plan [ITW:REQ-011]. v2 kept each
// skill's SHA-256 too, so the marketplace page (marketplace-catalog.mjs) tells an installed copy from a changed one; v3
// adds what the skills' listing adds. A v2 listing is read again once.
const AGENTS_FORMAT = 'sflow-task-marketplace-agents/v3';

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

/** What a listing keeps of an item's owner, lifecycle record and the marketplace's findings on them [OMK §4]. */
const listingMetadata = (entry) => ({ owner: entry.owner ?? null, lifecycleRecord: entry.lifecycleRecord ?? null, findings: entry.findings ?? [] });

const listingSkills = (listing) => listing.packages.filter((entry) => entry.kind === 'skill' && ID.test(entry.name)).map((entry) => ({
  name: entry.name, version: entry.version ?? null, description: entry.description ?? null, tags: entry.tags ?? [], pdlcTasks: entry.pdlcTasks ?? [],
  lifecycleState: entry.lifecycleState ?? null, ...listingMetadata(entry) }));

/** What a listing keeps of the marketplace itself: its owner and its channels [OMK:REQ-004]. */
const listingMarketplace = (listing) => ({ owner: { name: listing.owner ?? null, email: listing.ownerEmail ?? null }, channels: listing.channels ?? {} });

/**
 * A trusted marketplace's skill packages at the commit the repository trusts, with its channels and the channel the
 * trust reads (marketplace-repository.mjs trustChannel): `{ skills, channels, channel }`. The listing at a pinned commit
 * never changes, so it is kept in the clone's Git folder and read once per commit; reading it again would fetch the same
 * commit. `skill catalog` (skill-catalog.mjs) reads a marketplace through this same listing.
 */
export async function trustedMarketplaceSkillListing(root, marketplace) {
  const file = await listingFile(root, 'task-marketplace-skills', marketplace);
  const { trustChannel } = await import('./marketplace-repository.mjs');
  const kept = await keptListing(file, CATALOG_FORMAT, marketplace, 'skills');
  if (kept) return { skills: kept.skills, channels: kept.channels ?? {}, channel: trustChannel(kept.channels, marketplace.ref ?? null) };
  const { readMarketplaceRepository } = await import('./marketplace-repository.mjs');
  const listing = await readMarketplaceRepository(marketplace);
  const skills = listingSkills(listing);
  const own = listingMarketplace(listing);
  await keepListing(file, { format: CATALOG_FORMAT, repository: marketplace.repository, commit: marketplace.commit, ...own, skills });
  return { skills, channels: own.channels, channel: trustChannel(own.channels, marketplace.ref ?? null) };
}

/** A trusted marketplace's skill packages at the commit the repository trusts (trustedMarketplaceSkillListing's). */
export async function trustedMarketplaceSkills(root, marketplace) {
  return (await trustedMarketplaceSkillListing(root, marketplace)).skills;
}

// v2 keeps each entry's owner and lifecycle and the index's channel [OMK:REQ-005]; a v1 listing is read again once.
const INDEX_LISTING_FORMAT = 'sflow-task-index-skills/v2';
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
    lifecycleState: null, owner: entry.owner ?? null, lifecycleRecord: entry.lifecycle ?? null, findings: [...(entry.findings ?? [])] }));
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
export async function trustedIndexMarketplaceSkills(root, marketplace, options = {}) {
  return (await trustedIndexMarketplaceSkillListing(root, marketplace, options)).skills;
}

/** trustedIndexMarketplaceSkills's listing with the channel the index says it is (`{ skills, channels, channel }`). */
export async function trustedIndexMarketplaceSkillListing(root, marketplace, { fetchImpl = globalThis.fetch, fresh = false, now = Date.now() } = {}) {
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
  const answer = (from) => ({ skills: from.skills, channels: from.channels ?? {}, channel: from.channel ?? null });
  if (kept && !fresh && age >= 0 && age < INDEX_LISTING_FRESH_MS) return answer(kept);
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
      await keep({ indexSha256: kept.indexSha256, resolvedIndex: kept.resolvedIndex, ...validators({ ...kept, ...index }), channel: kept.channel ?? null,
        channels: kept.channels ?? {}, skills: kept.skills });
      return answer(kept);
    }
    index = await fetchMarketplaceIndex(marketplace, { fetchImpl });
  }
  const skills = indexMarketplaceSkillEntries(index, compareVersions);
  const listing = { skills, channel: index.channel ?? null, channels: index.channels ?? {} };
  await keep({ indexSha256: index.indexSha256, resolvedIndex: index.resolvedIndex, ...validators(index), ...listing });
  return listing;
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

/** trustedSkillsOf's listing, with the channel the trust reads: `{ skills, channels, channel }` [OMK:REQ-015]. */
export function trustedSkillListingOf(root, marketplace, options = {}) {
  return marketplace.repository ? trustedMarketplaceSkillListing(root, marketplace) : trustedIndexMarketplaceSkillListing(root, marketplace, options);
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
  if (kept && Array.isArray(kept.skills)) return { agents: kept.agents, skills: kept.skills, channels: kept.channels ?? {}, marketplaceOwner: kept.owner ?? null };
  const { readMarketplaceRepository } = await import('./marketplace-repository.mjs');
  // Each skill's SKILL.md is read too, for its SHA-256 alone: what an import of it would add (marketplace-catalog.mjs).
  const listing = await readMarketplaceRepository(marketplace, { documents: (packages) => packages.filter((entry) => ['agent', 'skill'].includes(entry.kind)).map((entry) => entry.name) });
  const agents = listing.packages.filter((entry) => entry.kind === 'agent' && ID.test(entry.name) && typeof entry.text === 'string').map((entry) => ({
    name: entry.name, version: entry.version ?? null, description: entry.description ?? null, lifecycleState: entry.lifecycleState ?? null,
    pdlcPhases: entry.pdlcPhases ?? [], pdlcTasks: entry.pdlcTasks ?? [], tags: entry.tags ?? [], skills: entry.skills ?? [],
    maintainer: entry.maintainer ?? null, sourceRepository: entry.sourceRepository ?? null, document: entry.document ?? null,
    manifestSha256: entry.manifestSha256 ?? null, ...listingMetadata(entry), text: entry.text }));
  const texts = new Map(listing.packages.filter((entry) => entry.kind === 'skill' && typeof entry.text === 'string').map((entry) => [entry.name, entry.text]));
  const skills = listingSkills(listing).map((skill) => ({ ...skill,
    sha256: texts.has(skill.name) ? createHash('sha256').update(texts.get(skill.name), 'utf8').digest('hex') : null }));
  const own = listingMarketplace(listing);
  await keepListing(file, { format: AGENTS_FORMAT, repository: marketplace.repository, commit: marketplace.commit, ...own, agents, skills });
  const skillFile = await listingFile(root, 'task-marketplace-skills', marketplace);
  if (!await keptListing(skillFile, CATALOG_FORMAT, marketplace, 'skills')) {
    await keepListing(skillFile, { format: CATALOG_FORMAT, repository: marketplace.repository, commit: marketplace.commit, ...own, skills });
  }
  return { agents, skills, channels: own.channels, marketplaceOwner: own.owner };
}

/**
 * A trusted marketplace's listing as it was kept, never read from the marketplace [OMK:REQ-041]: `{ items, kinds }`,
 * each item `{ kind, name, version, owner, lifecycleRecord, lifecycleState }`, or null when nothing is kept for the
 * commit it is trusted at (a Git repository: its agents and skills, else its skills alone) or for its index (as last
 * read, whatever its age). What `singularity-flow check` and a Story's start read, so neither fetches.
 */
export async function keptTrustedListing(root, marketplace) {
  const item = (kind) => (entry) => ({ kind, name: entry.name, version: entry.version ?? null, owner: entry.owner ?? null, lifecycleRecord: entry.lifecycleRecord ?? null,
    lifecycleState: entry.lifecycleState ?? null });
  if (marketplace.repository && marketplace.commit) {
    const agents = await keptListing(await listingFile(root, 'task-marketplace-agents', marketplace), AGENTS_FORMAT, marketplace, 'agents');
    if (agents && Array.isArray(agents.skills)) return { kinds: ['agent', 'skill'], items: [...agents.agents.map(item('agent')), ...agents.skills.map(item('skill'))] };
    const skills = await keptListing(await listingFile(root, 'task-marketplace-skills', marketplace), CATALOG_FORMAT, marketplace, 'skills');
    return skills ? { kinds: ['skill'], items: skills.skills.map(item('skill')) } : null;
  }
  if (!marketplace.index) return null;
  const { repositoryGitPath } = await import('./git-directory.mjs');
  const origins = [...(marketplace.allowedOrigins ?? [])].sort();
  const key = createHash('sha256').update(`${marketplace.index}\n${origins.join(' ')}`).digest('hex');
  try {
    const read = JSON.parse(await readFile(path.join(repositoryGitPath(root, 'singularity-flow', 'task-marketplace-skills'), `index-${key}.json`), 'utf8'));
    if (read?.format === INDEX_LISTING_FORMAT && read.index === marketplace.index && JSON.stringify(read.allowedOrigins) === JSON.stringify(origins) && Array.isArray(read.skills)) {
      return { kinds: ['skill'], items: read.skills.map(item('skill')) };
    }
  } catch { /* not kept yet */ }
  return null;
}

/** The library skills whose text SFlow's text checks refuse (installed-text-safety.mjs), by ID; none when it cannot be read. */
async function refusedLibrarySkills(root) {
  const { installedTextSafety } = await import('./installed-text-safety.mjs');
  const result = await installedTextSafety(root).catch(() => null);
  return new Set((result?.blocked ?? []).filter((entry) => entry.kind === 'library-skill').map((entry) => entry.id));
}

/**
 * The steps of the team's own workflow `composition.uses` with each library skill it attaches (skill-attachments, by the
 * workflow or by the agent that drafts the step) that SFlow's text checks refuse, or that its marketplace deprecated or
 * retired: `{ [step]: [{ id, status: 'withheld' | 'deprecated-attached', … }] }` [OMK:REQ-032, REQ-041]. The workflow runs
 * as it is: the plan line only names them. `candidates` are the library's (libraryCandidates).
 */
async function attachedFlags(root, definition, composition, candidates) {
  const flagged = new Map(candidates.filter((candidate) => candidate.safety === 'blocked' || candidate.lifecycle === 'retired').map((candidate) => [candidate.id, candidate]));
  if (!flagged.size) return {};
  const [{ configurationReadRoot }, { readSkillAttachments }] = await Promise.all([import('./configuration-read-scope.mjs'), import('./skill-library.mjs')]);
  const attachments = await readSkillAttachments(configurationReadRoot(root)).catch(() => []);
  const byStep = {};
  for (const step of composition.steps) {
    const agent = definition?.phases?.[step.id]?.agent ?? null;
    for (const entry of attachments) {
      const target = entry.workflow ? entry.workflow === composition.uses : Boolean(agent) && entry.agent === agent;
      const candidate = flagged.get(entry.id);
      if (!target || !candidate || (entry.phases.length && !entry.phases.includes(step.id))) continue;
      if ((byStep[step.id] ??= []).some((item) => item.id === entry.id)) continue;
      byStep[step.id].push(candidate.safety === 'blocked' ? { id: entry.id, status: 'withheld', marketplace: null, state: null, owner: null }
        : deprecatedEntry(candidate, 'deprecated-attached'));
    }
  }
  return byStep;
}

/** The library skills the team's own workflow `composition.uses` attaches, by the workflow or the agent of one of its steps. */
async function attachedSkillIds(root, definition, composition) {
  const [{ configurationReadRoot }, { readSkillAttachments }] = await Promise.all([import('./configuration-read-scope.mjs'), import('./skill-library.mjs')]);
  const agents = new Set(composition.steps.map((step) => definition?.phases?.[step.id]?.agent).filter(Boolean));
  return new Set((await readSkillAttachments(configurationReadRoot(root)).catch(() => []))
    .filter((entry) => (entry.workflow ? entry.workflow === composition.uses : agents.has(entry.agent))).map((entry) => entry.id));
}

/**
 * The library's skills as a task reads them, with the lifecycle that counts for each one imported from a trusted
 * marketplace: that marketplace's at the commit it is trusted at now [OMK:REQ-011], each read once (kept per commit, or
 * for an index's hour); one that cannot be read keeps the lifecycle recorded at import, with a note. A skill SFlow's text
 * checks refuse carries `safety: 'blocked'` [OMK:REQ-032]. `{ library, ledger, marketplaces, stepIntent, candidates }`.
 */
async function libraryCandidates(root, definition, { fetchImpl, notes, approvedOnce, only = null }) {
  const [{ configurationReadRoot }, { loadSkillLibrary }, { loadImportsLedger }] = await Promise.all([
    import('./configuration-read-scope.mjs'), import('./skill-library.mjs'), import('./imports-ledger.mjs')]);
  const configRoot = configurationReadRoot(root);
  const library = await loadSkillLibrary(configRoot).catch(() => ({ skills: new Map() }));
  const refused = await refusedLibrarySkills(root);
  const ledger = await loadImportsLedger(configRoot).catch(() => ({ imports: {} }));
  const stepIntent = definitionStepIntent(definition);
  const marketplaces = Object.values(definition.marketplaces ?? {}).filter((entry) => (entry?.repository && entry.commit) || entry?.index)
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  const imported = (skill) => ledger.imports?.[`library-skill:${skill.id}`] ?? null;
  const fromMarketplace = (skill) => (['marketplace-skill', 'marketplace'].includes(imported(skill)?.source?.kind) ? imported(skill).source.marketplace : null);
  const trustedNow = new Map();
  // `only`: the skills whose marketplace is read (a team's workflow reads those it attaches, and no other).
  for (const id of [...new Set([...library.skills.values()].filter((skill) => !only || only.has(skill.id)).map(fromMarketplace).filter(Boolean))].sort()) {
    const named = marketplaces.find((entry) => entry.id === id);
    if (!named) continue;
    const approved = await approvedOnce();
    const marketplace = approved ? approved[id] ?? null : named;
    if (!marketplace) continue;
    try {
      trustedNow.set(id, new Map((await trustedSkillsOf(root, marketplace, { fetchImpl })).map((entry) => [entry.name, entry])));
    } catch (error) {
      notes.push(`Marketplace ${id} could not be read, so the skills imported from it keep the lifecycle recorded when they were imported: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  const candidates = [...library.skills.values()].map((skill) => librarySkillCandidate(skill, imported(skill), { stepIntent,
    trusted: trustedNow.get(fromMarketplace(skill))?.get(imported(skill)?.source?.entry ?? skill.id) ?? null }))
    .map((candidate) => (refused.has(candidate.id) ? { ...candidate, safety: 'blocked' } : candidate));
  return { library, ledger, marketplaces, stepIntent, candidates };
}

/**
 * The team's own workflow made from a marketplace agent that marketplace deprecated or retired [OMK:REQ-041]: a note for
 * the plan, with the way to the replacement, read from what is kept (marketplace-in-use.mjs), never fetched.
 */
async function workflowInUseNotes(root, definition, workflow) {
  if (!Object.keys(definition?.marketplaces ?? {}).length) return [];
  try {
    const { readInUse, workflowInUseWords } = await import('./marketplace-in-use.mjs');
    const found = await readInUse(root, { definition, workflow, keep: false });
    return found.items.filter((item) => item.kind === 'agent').map((item) => workflowInUseWords(definition.workTypes?.[workflow]?.label ?? workflow, item));
  } catch {
    return [];
  }
}

/**
 * The chooser `taskPlan` calls with the composed steps: it reads the repository's library and import record, its own
 * skills beside the library (task-local.mjs), the kinds of software the task touches, and, for a step neither has
 * anything for, the marketplaces `definition` trusts. With no skill naming a task and no trusted marketplace, it reads
 * nothing more and chooses nothing. A skill of the repository's own that cannot be read is a note, never a refusal: the
 * task goes on without it. `fetchImpl` reads an index marketplace.
 */
export function taskSkillChooser(root, definition, { words = '', touchedPaths = [], use = [], without = [], fetchImpl = globalThis.fetch } = {}) {
  return async (composition) => {
    const notes = [];
    if (composition.agent) return { skills: [], offers: [], byStep: {}, notes };
    let approvedRead = null;
    const approvedOnce = () => (approvedRead ??= approvedMarketplaces(root).catch(() => null));
    // The team's own workflow runs as it is [ITW:REQ-020]; the plan line only names a skill it attaches that SFlow's text
    // checks refuse [OMK:REQ-032] or its marketplace deprecated, and a note says when it was made from a deprecated agent.
    if (composition.local) {
      const attached = await attachedSkillIds(root, definition, composition);
      const { candidates: own } = await libraryCandidates(root, definition, { fetchImpl, notes, approvedOnce, only: attached });
      notes.push(...await workflowInUseNotes(root, definition, composition.uses));
      return { skills: [], offers: [], byStep: await attachedFlags(root, definition, composition, own), notes };
    }
    const { library, marketplaces, stepIntent, candidates } = await libraryCandidates(root, definition, { fetchImpl, notes, approvedOnce });
    // The repository's own skills come after the library and before any marketplace [ITW:REQ-020].
    const here = await (await import('./task-local.mjs')).localSkills(root, { libraryIds: new Set(library.skills.keys()) });
    candidates.push(...here.skills.map((entry) => localSkillCandidate(entry.skill, entry)));
    notes.push(...here.notes);
    if (!candidates.some((candidate) => candidate.intents.length) && !marketplaces.length && !use.length) return { skills: [], offers: [], byStep: {}, notes };
    const kinds = await taskSoftwareKinds(root, touchedPaths);
    const fromLibrary = chooseTaskSkills(composition, { candidates, kinds, words, use: use.filter((id) => candidates.some((entry) => entry.id === id)), without });
    const bare = composition.steps.filter((step) => !fromLibrary.byStep[step.id]?.some((entry) => !NOT_GIVEN.has(entry.status)));
    const namedElsewhere = use.some((id) => !candidates.some((entry) => entry.id === id));
    if ((bare.length || namedElsewhere) && marketplaces.length) {
      const approved = await approvedOnce();
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
    const named = use.find((id) => !candidates.some((entry) => entry.source !== 'marketplace' && entry.id === id) && candidates.some((entry) => entry.id === id));
    if (named) {
      const offered = candidates.find((entry) => entry.id === named);
      throw refusal('TASK_SKILL_NOT_IN_LIBRARY', `${named} is in marketplace ${offered.marketplace} but not yet in this repository's skill library: its import is added, and reviewed, before a task uses it.`,
        { command: `singularity-flow import preview "market:${offered.marketplace}/${named}" --as skill --json`, label: `Show ${named}'s text; if the person says yes, run its addCommand.` },
        { skill: named, marketplace: offered.marketplace });
    }
    const chosen = chooseTaskSkills(composition, { candidates, kinds, words, use, without });
    if (composition.uses) notes.push(...await workflowInUseNotes(root, definition, composition.uses));
    return { ...chosen, ...(composition.uses ? { byStep: await attachedFlags(root, definition, composition, candidates.filter((entry) => entry.source === 'library')) } : {}), kinds, notes };
  };
}
