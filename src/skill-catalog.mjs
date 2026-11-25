/**
 * Every skill a repository can use, on one page [owner, 2026-11-25: "Is there any page we can see all marketplace skills
 * and analyze it?"]: the repository's skill library and each marketplace it trusts, one row per skill.
 *
 * A row says where the skill comes from (the library, or a marketplace with its version and lifecycle mark); what it is
 * for (the step intents its tasks are, from AGENT_TASK_INTENTS, and the /sf-task kinds that would pick it when the person
 * names nothing, by the chooser task-skills.mjs runs); who it is for (kinds of software, tags); whether the library has
 * it and whether its marketplace has a newer version; and who uses it (agents and workflows from the skill master, and
 * the task Stories in this checkout whose composition chose it). The summary counts the rows, names the skills that look
 * alike and the step intents no skill covers for this repository's kinds of software.
 *
 * Skills look alike when they are two different skills for the same kind of step and the same kind of software (or one
 * of them is for any kind), and their names share most of their words, or their names, descriptions and tags do: plain
 * word overlap, so the same skills always give the same answer, and the answer names the words.
 *
 * Read only, as a task reads them (task-skills.mjs), from the approved configuration Stories use: its library and
 * workflow.yml, a Git-repository marketplace at the commit it trusts through that module's per-commit listing, and an
 * index marketplace through its index, read now, as `marketplace browse` reads it (its listing is kept for the next
 * task's plan). A marketplace this checkout's workflow.yml trusts that is not approved yet is named on its row, never
 * read. A marketplace that cannot be read is one warning on its source; the rest is listed.
 *
 * analyzeSkillCatalog is pure; readSkillCatalog reads.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { compareVersions } from './marketplace.mjs';
import { STEP_INTENTS } from './phase-roles.mjs';
import { composeTask, storyComposition, TASK_KINDS } from './task-composition.mjs';
import { chooseTaskSkills, definitionStepIntent, librarySkillCandidate, marketplaceSkillCandidate, sameMarketplaceTrust } from './task-skills.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKILL_CATALOG_RESULT = 'skill-catalog';
export const SKILL_CATALOG_COMMAND = 'singularity-flow skill catalog';
/** How far a task Story's record is read: the Stories in this checkout, never other branches. */
const STORY_LIMIT = 500;
/** Two names alike: half their words shared, at least two. Two texts alike: three in ten shared, at least three. */
export const ALIKE = Object.freeze({ name: 0.5, nameWords: 2, text: 0.3, textWords: 3 });
const KIND_WORDS = Object.freeze({ web: 'a web app', backend: 'a backend', job: 'a batch job', cli: 'a command-line tool', library: 'a library',
  mobile: 'a mobile app', artifact: 'infrastructure files' });
const HOW_WORDS = Object.freeze({ used: 'uses it', yes: 'asks you first', new: 'offers it, new here' });
/** A task kind's pick in a sentence: "A fix task uses it in its code step." */
function pickWords(pick) {
  const named = pick.intents.length ? pick.intents : pick.steps;
  const steps = `its ${listWords(named)} step${named.length > 1 ? 's' : ''}`;
  if (pick.how === 'used') return `A ${pick.kind} task uses it in ${steps}.`;
  if (pick.how === 'yes') return `A ${pick.kind} task asks you first, then uses it in ${steps}.`;
  return `A ${pick.kind} task offers it for ${steps}; it is not in the library yet.`;
}
/** Words that say nothing about what a skill does. */
const STOP = new Set(['a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'each', 'every', 'for', 'from', 'how', 'in', 'into', 'is', 'it',
  'its', 'new', 'no', 'not', 'of', 'on', 'one', 'or', 'so', 'that', 'the', 'their', 'them', 'then', 'this', 'to', 'use', 'used', 'uses', 'using',
  'what', 'when', 'who', 'will', 'with', 'without', 'you', 'your', 'skill', 'skills', 'step', 'steps', 'ga', 'beta', 'approved', 'proposed']);

const stem = (word) => (word.length >= 5 && word.endsWith('ies') ? `${word.slice(0, -3)}y`
  : word.length >= 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
/** The words that say what a skill is about, each once, plurals folded. */
export function skillWords(...values) {
  return [...new Set(values.flat().flatMap((value) => String(value ?? '').toLowerCase().split(/[^a-z0-9]+/u))
    .filter((word) => word.length >= 2 && !STOP.has(word) && !/^\d+$/u.test(word)).map(stem))].sort();
}

/** How alike two word lists are: the words they share and that count over all their words. */
export function alikeness(left, right) {
  const shared = left.filter((word) => right.includes(word));
  const all = new Set([...left, ...right]).size;
  return { shared, score: all ? shared.length / all : 0 };
}

const listWords = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const displayTags = (tags) => [...new Set(tags.map(String).filter((tag) => !/^(?:task|intent|lifecycle):/u.test(tag)))].sort(byText);

function refusal(code, message, nextAction, details = {}) {
  return new SingularityFlowError(message, { code, details: { ...details, nextAction } });
}

/** The steps a task picks a skill for: their labels in the composed task, and their intents. */
const stepsOf = (composition, ids) => {
  const steps = ids.map((id) => composition.steps.find((step) => step.id === id) ?? { id, label: id, intent: null });
  return { steps: steps.map((step) => step.label), intents: [...new Set(steps.map((step) => step.intent).filter(Boolean))] };
};

/**
 * Which /sf-task kinds would pick each skill when the person names nothing: each kind composed for this repository,
 * and the chooser run over every candidate with the repository's kinds of software. A kind that cannot be composed here
 * is named, with why.
 */
function taskKindPicks(definition, candidates, kinds) {
  const picks = new Map();
  const notComposed = [];
  const add = (key, entry) => { if (!picks.has(key)) picks.set(key, []); picks.get(key).push(entry); };
  for (const kind of TASK_KINDS) {
    let composition;
    try { composition = composeTask(definition, { kind }); } catch (error) {
      notComposed.push({ kind, why: String(error?.message ?? error).split('\n')[0] });
      continue;
    }
    if (composition.uses) {
      notComposed.push({ kind, why: `This team runs every ${kind} task as the ${composition.uses} workflow, which brings its own skills.` });
      continue;
    }
    let chosen;
    try { chosen = chooseTaskSkills(composition, { candidates, kinds }); } catch { continue; }
    for (const skill of chosen.skills) {
      add(`library:${skill.id}`, { kind, how: 'used', ...stepsOf(composition, skill.steps) });
    }
    for (const offer of chosen.offers) {
      add(offer.source === 'library' ? `library:${offer.id}` : `market:${offer.marketplace}/${offer.id}`,
        { kind, how: offer.new ? 'new' : 'yes', ...stepsOf(composition, offer.steps) });
    }
  }
  return { picks, notComposed };
}

/** Pairs of different skills for the same kind of step and software whose words say they do the same thing. */
function overlapsOf(rows) {
  const found = [];
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const a = rows[left]; const b = rows[right];
      if (a.id === b.id) continue;
      const intents = a.intents.filter((intent) => b.intents.includes(intent));
      if (!intents.length) continue;
      const kinds = a.softwareKinds.filter((kind) => b.softwareKinds.includes(kind));
      if (a.softwareKinds.length && b.softwareKinds.length && !kinds.length) continue;
      const name = alikeness(a.words.name, b.words.name);
      const text = alikeness(a.words.all, b.words.all);
      const namesAlike = name.score >= ALIKE.name && name.shared.length >= ALIKE.nameWords;
      const textsAlike = text.score >= ALIKE.text && text.shared.length >= ALIKE.textWords;
      if (!namesAlike && !textsAlike) continue;
      const shared = textsAlike ? text.shared : name.shared;
      const score = Math.round(100 * Math.max(namesAlike ? name.score : 0, textsAlike ? text.score : 0));
      const where = kinds.length ? ` for ${listWords(kinds.map((kind) => KIND_WORDS[kind] ?? kind))}`
        : a.softwareKinds.length || b.softwareKinds.length ? ' (one of them is for any kind of software)' : '';
      found.push({
        skills: [a.key, b.key], ids: [a.id, b.id], intents, softwareKinds: kinds, words: shared.slice(0, 12), alike: score,
        why: `${a.id} and ${b.id} are both for ${listWords(intents)} steps${where}, and ${namesAlike && !textsAlike ? 'their names' : 'their names, descriptions and tags'} share ${listWords(shared.slice(0, 8))} (${score}% alike).`
      });
    }
  }
  return found.sort((left, right) => right.alike - left.alike || byText(left.skills.join(' '), right.skills.join(' ')));
}

/** The step intents this repository's steps have, each with the skills that cover it for its kinds of software. */
function coverageOf(rows, definition, kinds) {
  const present = STEP_INTENTS.filter((intent) => Object.values(definition.phases ?? {}).some((phase) => phase?.intent === intent));
  const forHere = (row) => !row.softwareKinds.length || !kinds.length || row.softwareKinds.some((kind) => kinds.includes(kind));
  const here = kinds.length ? ` for ${listWords(kinds.map((kind) => KIND_WORDS[kind] ?? kind))}` : '';
  return (present.length ? present : STEP_INTENTS).map((intent) => {
    const fits = rows.filter((row) => row.readiness !== 'retired' && row.intents.includes(intent) && forHere(row));
    const library = fits.filter((row) => row.source === 'library').map((row) => row.id);
    const marketplace = fits.filter((row) => row.source === 'marketplace' && !row.inLibrary).map((row) => row.key);
    const status = library.length ? 'library' : marketplace.length ? 'marketplace' : 'none';
    return {
      intent, status, library, marketplace,
      words: status === 'library' ? `The library has ${library.length === 1 ? 'a skill' : `${library.length} skills`} for ${intent} steps${here}.`
        : status === 'marketplace' ? `Only a trusted marketplace has a skill for ${intent} steps${here}: ${listWords(marketplace.map((key) => key.replace(/^market:/u, '')))}.`
          : `No skill in the library or a trusted marketplace is for ${intent} steps${here}.`
    };
  });
}

const count = (rows, keyOf) => {
  const counted = {};
  for (const row of rows) for (const key of [keyOf(row)].flat()) counted[key] = (counted[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counted).sort(([left], [right]) => byText(left, right)));
};

/**
 * The catalog from what was read: `library` the library's skills (skill-library.mjs), `imports` the import record's
 * entries, `marketplaces` each trusted marketplace `{ id, label, kind, skills, warning }` with its skills as
 * task-skills.mjs lists them, `definition` the workflow configuration, `kinds` the repository's kinds of software, `uses`
 * a map of skill ID to `{ agents, workflows }`, and `stories` the task Stories `{ workId, kind, skills }` in this checkout.
 */
export function analyzeSkillCatalog({ library = [], imports = {}, marketplaces = [], definition = {}, kinds = [], uses = new Map(), stories = [], warnings = [],
  unapproved = [] } = {}) {
  const libraryIds = new Set(library.map((skill) => skill.id));
  const recordOf = (id) => {
    const source = imports[`library-skill:${id}`]?.source ?? null;
    return source && ['marketplace', 'marketplace-skill'].includes(source.kind) ? source : null;
  };
  const stepIntent = definitionStepIntent(definition);
  const entries = [];
  for (const skill of [...library].sort((left, right) => byText(left.id, right.id))) {
    const record = recordOf(skill.id);
    const candidate = librarySkillCandidate(skill, imports[`library-skill:${skill.id}`] ?? null, { stepIntent });
    entries.push({ candidate, key: `library:${skill.id}`, source: 'library', marketplace: record?.marketplace ?? null, version: record?.version ?? null,
      label: skill.label ?? skill.id, description: skill.description ?? '', tags: [...(skill.tags ?? []), ...(record?.tags ?? [])] });
  }
  for (const marketplace of [...marketplaces].sort((left, right) => byText(left.id, right.id))) {
    for (const entry of [...(marketplace.skills ?? [])].sort((left, right) => byText(left.name, right.name))) {
      // An index entry names the steps it is for by their IDs here; each is the intent that step has.
      const candidate = marketplaceSkillCandidate(entry, marketplace.id, { stepIntent });
      entries.push({ candidate, key: `market:${marketplace.id}/${entry.name}`, source: 'marketplace', marketplace: marketplace.id, version: entry.version ?? null,
        label: entry.label ?? entry.name, description: entry.description ?? '', tags: entry.tags ?? [] });
    }
  }
  const candidates = entries.map((entry) => entry.candidate);
  const { picks, notComposed } = taskKindPicks(definition, candidates, kinds);
  const labels = new Map(marketplaces.map((marketplace) => [marketplace.id, marketplace.label ?? marketplace.id]));
  const storyUses = new Map();
  for (const story of stories) {
    for (const skill of story.skills ?? []) {
      if (!storyUses.has(skill.id)) storyUses.set(skill.id, []);
      storyUses.get(skill.id).push({ workId: story.workId, kind: story.kind, steps: [...(skill.steps ?? [])] });
    }
  }
  const rows = entries.map(({ candidate, key, source, marketplace, version, label, description, tags }) => {
    const id = candidate.id;
    const record = recordOf(id);
    const inLibrary = source === 'library' || libraryIds.has(id);
    // The library's copy came from this marketplace when its import says so; only then is a higher version newer.
    const fromHere = source === 'marketplace' && record?.marketplace === marketplace;
    const libraryVersion = inLibrary ? record?.version ?? null : null;
    const newerVersion = fromHere && version && libraryVersion && compareVersions(version, libraryVersion) > 0 ? version : null;
    const used = uses.get(id) ?? { agents: [], workflows: [] };
    const reference = source === 'marketplace' ? key : null;
    return {
      key, id, label, description, source, marketplace, marketplaceLabel: marketplace ? labels.get(marketplace) ?? marketplace : null,
      version, lifecycle: candidate.state ?? null, readiness: candidate.lifecycle,
      intents: [...candidate.intents].sort((left, right) => STEP_INTENTS.indexOf(left) - STEP_INTENTS.indexOf(right)), tasks: [...candidate.tasks].sort(byText),
      pickedBy: (picks.get(key) ?? []).map((pick) => ({ ...pick, words: pickWords(pick) })),
      softwareKinds: [...candidate.kinds], tags: displayTags(tags),
      inLibrary, libraryVersion, newerVersion,
      usedBy: source === 'library' ? { agents: used.agents, workflows: used.workflows, tasks: storyUses.get(id) ?? [] } : { agents: [], workflows: [], tasks: [] },
      overlaps: [],
      actions: {
        ...(source === 'library' ? { show: `singularity-flow skill show ${id}` } : {}),
        ...(reference && (!inLibrary || newerVersion) ? { preview: `singularity-flow import preview "${reference}" --as skill --json`, reference } : {}),
        ...(source === 'marketplace' && inLibrary ? { show: `singularity-flow skill show ${id}` } : {})
      },
      words: { name: skillWords(id, label), all: skillWords(id, label, description, displayTags(tags)) }
    };
  });
  // The library's copy says so too when its marketplace has a newer version.
  for (const row of rows.filter((item) => item.source === 'library' && item.marketplace)) {
    row.newerVersion = rows.find((other) => other.key === `market:${row.marketplace}/${row.id}`)?.newerVersion ?? null;
  }
  const overlaps = overlapsOf(rows);
  for (const overlap of overlaps) {
    for (const [index, key] of overlap.skills.entries()) rows.find((row) => row.key === key).overlaps.push(overlap.skills[1 - index]);
  }
  const coverage = coverageOf(rows, definition, kinds);
  const pending = new Map(unapproved.map((entry) => [entry.id, entry]));
  const sources = [
    { id: 'library', kind: 'library', label: 'This repository\'s skill library', read: true, approved: true, skills: rows.filter((row) => row.source === 'library').length },
    ...[...marketplaces].sort((left, right) => byText(left.id, right.id)).map((marketplace) => ({
      id: marketplace.id, kind: marketplace.kind, label: marketplace.label ?? marketplace.id, read: !marketplace.warning, approved: true,
      skills: rows.filter((row) => row.marketplace === marketplace.id && row.source === 'marketplace').length,
      ...(marketplace.warning ? { warning: marketplace.warning } : {}),
      ...(pending.has(marketplace.id) ? { notApproved: pending.get(marketplace.id).words } : {})
    })),
    // Trusted only in the working copy: never read, and never presented as trusted.
    ...unapproved.filter((entry) => entry.change === 'added').map((entry) => ({
      id: entry.id, kind: entry.kind, label: entry.label, read: false, approved: false, skills: 0, notApproved: entry.words }))
  ];
  return {
    schemaVersion: 1, resultType: SKILL_CATALOG_RESULT,
    repository: { softwareKinds: [...kinds], words: kinds.length ? `This repository is ${listWords(kinds.map((kind) => KIND_WORDS[kind] ?? kind))}.`
      : 'SFlow did not find what kind of software this repository is, so every skill counts for it.' },
    sources,
    rows: rows.map(({ words: _words, ...row }) => row),
    summary: {
      skills: rows.length,
      bySource: count(rows, (row) => (row.source === 'library' ? 'library' : row.marketplace)),
      byLifecycle: count(rows, (row) => row.lifecycle ?? 'not marked'),
      byIntent: count(rows, (row) => (row.intents.length ? row.intents : ['no step'])),
      notInLibrary: rows.filter((row) => !row.inLibrary).length,
      newerAvailable: rows.filter((row) => row.source === 'marketplace' && row.newerVersion).length,
      overlaps,
      coverage,
      gaps: coverage.filter((entry) => entry.status === 'none').map(({ intent, words }) => ({ intent, words })),
      tasksNotComposed: notComposed
    },
    warnings: [...warnings, ...sources.filter((source) => source.warning).map((source) => source.warning)]
  };
}

/** An unreadable marketplace in words, with no commit ID: what could not be read and what to check. */
function unreadable(marketplace, error) {
  const name = marketplace.label && marketplace.label !== marketplace.id ? `${marketplace.label} (${marketplace.id})` : marketplace.id;
  if (error?.code === 'MARKETPLACE_REPOSITORY_UNREACHABLE') {
    return `Marketplace ${name} could not be read: this computer could not reach ${marketplace.repository} with Git at the commit this repository trusts, so its skills are not listed.`;
  }
  const said = String(error?.message ?? error).split('\n')[0].replace(/\b(?:at )?(?:commit )?[0-9a-f]{12,64}\b/gu, 'at the commit it is trusted at');
  return `Marketplace ${name} could not be read, so its skills are not listed: ${said}`;
}

/** The task Stories in this checkout whose composition chose skills: their records here, no other branch. */
async function taskStories(root, definition) {
  const directory = path.join(root, definition.workItemRoot ?? 'singularity/work-items');
  let names;
  try { names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(byText).slice(0, STORY_LIMIT); }
  catch { return []; }
  const { readRecord } = await import('./schema-migrations.mjs');
  const stories = [];
  for (const name of names) {
    let workflow;
    try { workflow = readRecord('story-workflow', await readFile(path.join(directory, name, 'workflow.json'))).record; } catch { continue; }
    const composition = storyComposition(workflow);
    if (!composition || !Array.isArray(composition.skills) || !composition.skills.length) continue;
    stories.push({ workId: String(workflow.workItem?.id ?? name), kind: composition.kind,
      skills: composition.skills.map((skill) => ({ id: skill.id, steps: [...(skill.steps ?? [])] })) });
  }
  return stories;
}

/** Who uses each library skill, from the skill master's own view of it (asset-catalog.mjs). */
function usesFrom(model) {
  const labels = new Map((model?.agents ?? []).map((agent) => [agent.id, agent.label ?? agent.id]));
  return new Map((model?.skills ?? []).map((skill) => [skill.id, {
    agents: skill.usedBy.filter((use) => use.agent).map((use) => ({ id: use.agent, label: labels.get(use.agent) ?? use.agent, steps: [...use.phases] })),
    workflows: skill.usedBy.filter((use) => use.workflow).map((use) => ({ id: use.workflow, steps: [...use.phases] }))
  }]));
}

const NOT_APPROVED_WORDS = Object.freeze({
  added: 'Trusted only in your working copy of workflow.yml, and not approved yet: Stories do not use it, so its skills are not read.',
  changed: 'Your working copy of workflow.yml reads it elsewhere (another commit or index), and that is not approved yet: these are the skills Stories use.',
  removed: 'Your working copy of workflow.yml stops trusting it, and that is not approved yet: Stories still use it.'
});

/**
 * What this checkout's own workflow.yml trusts that the approved configuration does not, or trusts otherwise: each
 * `{ id, label, kind, change, words }`, `change` one of added, changed or removed. Empty when the working tree is the
 * configuration (no approved one is known here).
 */
export function unapprovedMarketplaces(approved = {}, working = {}) {
  const found = [];
  for (const id of [...new Set([...Object.keys(approved), ...Object.keys(working)])].sort(byText)) {
    const here = working[id]; const there = approved[id];
    const change = here && !there ? 'added' : there && !here ? 'removed' : sameMarketplaceTrust(here, there) ? null : 'changed';
    if (!change) continue;
    const entry = here ?? there;
    found.push({ id, label: entry.label ?? id, kind: entry.repository ? 'repository' : 'index', change, words: NOT_APPROVED_WORDS[change] });
  }
  return found;
}

/**
 * Read and analyze every skill, from the approved configuration: what Stories actually use [owner, 2026-11-25]. A
 * marketplace this checkout's workflow.yml trusts that is not approved yet is never read; its row says so, as does a
 * trusted one the working copy changes or drops. `marketplace` reads only that trusted marketplace (with the library).
 * `fetchImpl` reads an index marketplace's index.
 */
export async function readSkillCatalog(root, { marketplace: only = null, fetchImpl = globalThis.fetch } = {}) {
  const [{ withApprovedConfigurationRead }, { withoutConfigurationReadScope }, { configuredMarketplaces }] = await Promise.all([
    import('./approved-configuration-reader.mjs'), import('./configuration-read-scope.mjs'), import('./marketplace.mjs')]);
  // This checkout's own workflow.yml, read before the approved one is in scope, to name what is not approved yet.
  const working = await withoutConfigurationReadScope(() => configuredMarketplaces(root)).catch(() => null);
  return withApprovedConfigurationRead(root, (authority) => readApprovedSkillCatalog(root, {
    only, fetchImpl, working: authority && authority.kind !== 'working-tree' ? working : null
  }), { preferAuthority: true });
}

async function readApprovedSkillCatalog(root, { only, fetchImpl, working }) {
  const [{ configurationReadRoot }, { loadDefinition }, { loadSkillLibrary }, { loadImportsLedger }, { readAssetCatalog }, { taskSoftwareKinds, trustedSkillsOf }] = await Promise.all([
    import('./configuration-read-scope.mjs'), import('./config.mjs'), import('./skill-library.mjs'), import('./imports-ledger.mjs'),
    import('./asset-catalog.mjs'), import('./task-skills.mjs')]);
  const configRoot = configurationReadRoot(root);
  const definition = await loadDefinition(root);
  const trusted = Object.values(definition.marketplaces ?? {}).sort((left, right) => byText(left.id, right.id));
  const unapproved = working ? unapprovedMarketplaces(definition.marketplaces ?? {}, working) : [];
  const waiting = unapproved.find((entry) => entry.id === only && entry.change === 'added');
  if (waiting) {
    throw refusal('SKILL_CATALOG_MARKETPLACE_NOT_APPROVED', `Marketplace '${only}' is trusted only in your working copy of workflow.yml, and that is not approved yet, so its skills are not read.`,
      { command: 'singularity-flow configuration proposals', label: 'See whether the change that trusts it waits for approval.' }, { marketplace: only });
  }
  if (only != null && !trusted.some((marketplace) => marketplace.id === only)) {
    throw refusal('SKILL_CATALOG_MARKETPLACE_UNKNOWN', `This repository does not trust a marketplace called '${only}'.${trusted.length
      ? ` It trusts ${listWords(trusted.map((marketplace) => marketplace.id))}.` : ' It trusts none yet.'}`,
    { command: SKILL_CATALOG_COMMAND, label: 'See every skill, from the library and each trusted marketplace.' }, { marketplace: only, trusted: trusted.map((marketplace) => marketplace.id) });
  }
  const warnings = [];
  const library = await loadSkillLibrary(configRoot);
  for (const problem of library.problems) warnings.push(`The library's ${problem.id ?? 'folder'} is not listed: ${problem.message}`);
  const ledger = await loadImportsLedger(configRoot).catch((error) => {
    warnings.push(`Where imported skills came from could not be read, so their versions are not shown: ${String(error?.message ?? error).split('\n')[0]}`);
    return { imports: {} };
  });
  const model = await readAssetCatalog(root).catch((error) => {
    warnings.push(`Which agents and workflows use each skill could not be read: ${String(error?.message ?? error).split('\n')[0]}`);
    return null;
  });
  const kinds = await taskSoftwareKinds(root, []);
  const marketplaces = [];
  for (const marketplace of trusted.filter((entry) => only == null || entry.id === only)) {
    const kind = marketplace.repository ? 'repository' : 'index';
    try {
      // A person reads this page to see what is there now: an index is read fresh, and kept for the next plan.
      const skills = await trustedSkillsOf(root, marketplace, { fetchImpl, fresh: true });
      marketplaces.push({ id: marketplace.id, label: marketplace.label ?? marketplace.id, kind, skills, warning: null });
    } catch (error) {
      marketplaces.push({ id: marketplace.id, label: marketplace.label ?? marketplace.id, kind, skills: [], warning: unreadable(marketplace, error) });
    }
  }
  return analyzeSkillCatalog({ library: [...library.skills.values()], imports: ledger.imports ?? {}, marketplaces, definition, kinds,
    uses: usesFrom(model), stories: await taskStories(root, definition), warnings,
    unapproved: unapproved.filter((entry) => only == null || entry.id === only) });
}

/** The catalog as a person reads it in a terminal. */
export function skillCatalogLines(catalog) {
  const lines = [];
  const { summary } = catalog;
  const sourceWords = catalog.sources.map((source) => (source.kind === 'library' ? `${source.skills} in the library`
    : `${source.read ? source.skills : 'none'} in marketplace ${source.id}${source.approved === false ? ' (not approved yet)' : source.read ? '' : ' (not read)'}`));
  lines.push(`${summary.skills === 1 ? '1 skill' : `${summary.skills} skills`}: ${listWords(sourceWords)}. ${catalog.repository.words}`);
  for (const row of catalog.rows) {
    const where = row.source === 'library' ? 'library' : row.marketplace;
    const facts = [
      row.version ? `version ${row.version}` : null,
      row.lifecycle,
      row.intents.length ? `for ${listWords(row.intents)} steps` : 'for no step',
      row.softwareKinds.length ? `on ${listWords(row.softwareKinds)}` : null,
      row.source === 'marketplace' ? (row.inLibrary ? `in the library${row.libraryVersion ? ` (version ${row.libraryVersion})` : ''}` : 'not in the library') : null,
      row.newerVersion ? `newer: ${row.newerVersion}` : null
    ].filter(Boolean);
    lines.push(`  ${where.padEnd(10)} ${row.id}: ${facts.join(', ')}`);
    if (row.pickedBy.length) lines.push(`             Picked by: ${row.pickedBy.map((pick) => `${pick.kind} (${HOW_WORDS[pick.how]})`).join(', ')}`);
    const users = [...row.usedBy.agents.map((use) => use.label), ...row.usedBy.workflows.map((use) => `workflow ${use.id}`), ...row.usedBy.tasks.map((use) => use.workId)];
    if (users.length) lines.push(`             Used by: ${users.join(', ')}`);
  }
  if (summary.overlaps.length) {
    lines.push('Skills that look alike:');
    for (const overlap of summary.overlaps) lines.push(`  ${overlap.why}`);
  }
  for (const entry of summary.coverage.filter((item) => item.status !== 'library')) lines.push(entry.words);
  for (const source of catalog.sources.filter((item) => item.notApproved)) lines.push(`Note: marketplace ${source.id}: ${source.notApproved}`);
  for (const warning of catalog.warnings) lines.push(`Note: ${warning}`);
  return lines;
}
