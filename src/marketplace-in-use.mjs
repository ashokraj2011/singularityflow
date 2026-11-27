/**
 * Deprecated and retired marketplace items still in use here [OMK §8, REQ-040–REQ-042, docs/SPEC-OMK-ORG-MARKETPLACE-v1.md].
 *
 * - An item is in use here when the library holds it, imported from its marketplace (a skill, or a template); an
 *   agent's imports hold it (an agent's own skill, an imported agent, an MCP server or a generated source); a workflow
 *   here was made from it (an agent, by its import record), or attaches a library skill that came from it; or an open
 *   Story on this computer runs it: its workflow was made from it, its task chose that library skill, or its frozen
 *   snapshot holds the installed copy's text (by SHA-256) [REQ-040]. Open Stories are read from the machine's Story
 *   index for this repository and this checkout's own Story, at most 500, from their files: no Git, no fetch.
 * - It is deprecated or retired in use when its state at the commit trusted now is, the index's as last read
 *   [REQ-011]; a person who asks for the newest commit (`--newest`) also sees one deprecated only there.
 * - It is never removed and never blocks (open question 3): every surface says it, with the replacement its record
 *   names when the same marketplace lists one that is neither deprecated nor retired, through the same reviewed
 *   import or conversion review [REQ-042]. Workflows run as they are: nothing here changes a workflow's skill or agent.
 *
 * Pure: the analysis (inUseOf, deprecatedInUseOf) and the words. Read: readInUse reads only what is kept (each
 * marketplace's listing at the commit it is trusted at, kept by a catalog, a task's plan or a conversion), never a
 * marketplace, so `singularity-flow check` never fetches; a marketplace with no kept listing is "not checked". Each
 * full answer is kept in the Git folder (never committed), so a Copilot session's start says it from one small read.
 */
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dayWords, lifecycleStateOf } from './marketplace-lifecycle.mjs';

export const MARKETPLACE_IN_USE_RESULT = 'marketplace-in-use';
const KEPT_FORMAT = 'sflow-marketplace-in-use/v1';
const FILE = 'marketplace-in-use.json';
/** How many open Stories are read, and how big a Story's record or snapshot manifest may be. */
const STORY_LIMIT = 500;
const RECORD_LIMIT = 16 * 1024 * 1024;
const MARKETPLACE_SOURCES = new Set(['marketplace', 'marketplace-skill']);
const CLOSED = new Set(['closed', 'cancelled']);
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sorted = (values) => [...new Set(values)].filter(Boolean).sort(byText);
const listWords = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const KIND_WORDS = Object.freeze({ skill: 'skill', agent: 'agent', template: 'template', 'mcp-server': 'MCP server', generated: 'generated source', workflow: 'workflow' });

/** Deprecated or retired, from an item's lifecycle record, else its apm.yml's lifecycle-state; null for any other state. */
export function inUseState(entry) {
  const state = lifecycleStateOf(entry?.lifecycleRecord?.word ?? entry?.lifecycle?.word ?? entry?.lifecycleState ?? null);
  return state === 'deprecated' || state === 'retired' ? state : null;
}

export const hasUses = (uses) => Boolean(uses && (uses.library.length || uses.agents.length || uses.workflows.length || uses.openStories.length));

/**
 * What here uses one marketplace item [OMK:REQ-040]: `{ library, agents, workflows, openStories }`, each a sorted list of
 * IDs. `imports` is the import record's entries, `library` the library's skill IDs, `workflows` each workflow ID here with
 * `{ archived }` (an archived one is offered to no new Story, so it uses nothing), `attachments` the library's skill
 * attachments, `openStories` each `{ workId, workflow, skills, sha256 }` (openStoriesHere).
 */
export function itemUses({ marketplace, kind, name }, { imports = {}, library = new Set(), workflows = {}, attachments = [], openStories = [] } = {}) {
  const held = []; const agents = []; const used = []; const made = []; const librarySkills = []; const texts = new Set();
  const live = (id) => Boolean(workflows[id]) && workflows[id].archived !== true;
  for (const record of Object.values(imports ?? {})) {
    if (!record || typeof record !== 'object') continue;
    const source = record.source ?? {};
    const target = record.target ?? {};
    // A Git repository marketplace's agent is installed as the workflow made from it (MCR's record).
    if (kind === 'agent' && record.kind === 'workflow' && source.kind === 'marketplace-agent' && source.marketplace === marketplace && source.agent === name) {
      if (live(record.workflow)) { used.push(record.workflow); made.push(record.workflow); }
      continue;
    }
    if (!MARKETPLACE_SOURCES.has(source.kind) || source.marketplace !== marketplace || (source.entry ?? target.id) !== name) continue;
    if (kind === 'skill' && record.kind === 'library-skill') {
      if (!library.has(target.id)) continue;
      held.push(target.id); librarySkills.push(target.id);
    } else if (kind === 'skill' && record.kind === 'skill') agents.push(target.agent);
    else if (record.kind !== kind) continue;
    else if (kind === 'template') held.push(target.id ?? name);
    else if (kind === 'agent') agents.push(target.id ?? name);
    else if (kind === 'mcp-server') agents.push(...(target.agents ?? []));
    else if (kind === 'generated') agents.push(target.agent);
    if (typeof record.sha256 === 'string') texts.add(record.sha256);
  }
  for (const entry of attachments ?? []) {
    if (!librarySkills.includes(entry?.id)) continue;
    if (entry.workflow) { if (live(entry.workflow)) used.push(entry.workflow); } else if (entry.agent) agents.push(entry.agent);
  }
  const stories = (openStories ?? []).filter((story) => made.includes(story.workflow) || (story.skills ?? []).some((id) => librarySkills.includes(id))
    || (story.sha256 ?? []).some((digest) => texts.has(digest))).map((story) => story.workId);
  return { library: sorted(held), agents: sorted(agents), workflows: sorted(used), openStories: sorted(stories) };
}

/** Who uses it, in a person's words: "the skill library, workflow web-tests and 1 open Story". */
export function usesWords(uses, kind = 'skill') {
  const named = (items, one, many) => (items.length === 1 ? `${one} ${items[0]}` : `${items.length} ${many}`);
  return listWords([
    uses.library.length ? (kind === 'template' ? named(uses.library, 'template', 'templates') : 'the skill library') : null,
    uses.agents.length ? named(uses.agents, 'agent', 'agents') : null,
    uses.workflows.length ? named(uses.workflows, 'workflow', 'workflows') : null,
    uses.openStories.length ? `${uses.openStories.length} open ${uses.openStories.length === 1 ? 'Story' : 'Stories'}` : null
  ].filter(Boolean));
}

/**
 * The first step to the replacement: its exact text, or the workflow an agent becomes, through the same review as any
 * import [OMK:REQ-042]. A generated source has no text, so its marketplace's entries are listed.
 */
export function replacementPreview({ kind, id, marketplace, marketplaceKind }) {
  if (kind === 'agent' && marketplaceKind === 'repository') {
    return { command: `singularity-flow workflow from-agent ${marketplace}/${id} --review`, label: `Make a workflow from the replacement, ${id}, through its review.` };
  }
  if (kind === 'generated') return { command: `singularity-flow marketplace browse ${marketplace}`, label: `See ${id} in its marketplace.` };
  return { command: `singularity-flow import preview ${JSON.stringify(`market:${marketplace}/${id}`)} --as ${kind} --json`, label: `Show the replacement ${id}'s exact text before installing it.` };
}

/**
 * The item that replaces it [OMK:REQ-042]: `{ kind, id, marketplace, offered, installed, words, preview }`, or null when
 * its record names none. Offered only when the same marketplace lists it and it is neither deprecated nor retired;
 * `items` are that marketplace's items, `installed(item)` whether one of them is installed here.
 */
export function replacementOf(entry, { marketplace, label = marketplace, marketplaceKind = 'repository', items = [], installed = () => false } = {}) {
  const named = entry?.lifecycleRecord?.deprecation?.replacedBy ?? entry?.lifecycle?.deprecation?.replacedBy ?? null;
  if (!named) return null;
  const listed = items.find((item) => item.name === named && item.kind === entry.kind) ?? items.find((item) => item.name === named) ?? null;
  const base = { kind: listed?.kind ?? entry.kind, id: named, marketplace, offered: false, installed: false, preview: null };
  if (!listed) return { ...base, words: `Its replacement ${named} is not in marketplace ${label}, so it is not offered here.` };
  const state = inUseState(listed);
  if (state) return { ...base, words: `Its replacement ${named} is ${state} too, so it is not offered.` };
  const here = Boolean(installed(listed));
  return { ...base, offered: !here, installed: here, preview: here ? null : replacementPreview({ kind: listed.kind, id: named, marketplace, marketplaceKind }),
    words: here ? `Its replacement ${named} is installed here too: move what uses this one to it.` : `Use ${named}.` };
}

/** The words of a deprecated or retired item in use (§8's "Deprecated by Web QA on 20 Nov; still used by …"). */
export function inUseWords({ state, owner = null, since = null, sunset = null, uses, kind = 'skill', replacement = null, newest = false, recorded = false }) {
  const on = dayWords(since) ? ` on ${dayWords(since)}` : '';
  const head = newest ? `${state === 'retired' ? 'Retired' : 'Deprecated'} in the marketplace's newest commit`
    : state === 'retired' ? `Retired${owner ? ` by ${owner}` : ''}${on}: no longer supported`
      : `Deprecated${owner ? ` by ${owner}` : ''}${on}${dayWords(sunset) ? ` (supported until ${dayWords(sunset)})` : ''}`;
  const way = replacement ? replacement.words : 'Its marketplace names no replacement.';
  return `${head}; still used by ${usesWords(uses, kind)}. ${way}${recorded ? ' This is the state recorded when it was imported: its marketplace could not be read.' : ''}`;
}

/** The entry that moved a record into its state, for when. */
const arrivedAt = (record) => [...(record?.history ?? [])].reverse().find((entry) => lifecycleStateOf(entry.to) === record.state)?.at ?? record?.since ?? null;

/**
 * A row's `deprecatedInUse` [OMK:REQ-041]: `{ state, newest?, recorded?, replacedBy, sunset, since, owner, uses,
 * replacement, words }`, or null when the item is neither deprecated nor retired (at the trusted commit, or only in the
 * newest one read, `newest`) or nothing here uses it.
 */
export function deprecatedInUseOf(entry, { marketplace, label = marketplace, marketplaceKind = 'repository', uses, items = [], installed = () => false, newest = null, recorded = false } = {}) {
  const trusted = inUseState(entry);
  const later = !trusted && newest ? inUseState(newest) : null;
  const state = trusted ?? later;
  if (!state || !hasUses(uses)) return null;
  const shown = trusted ? entry : { ...newest, kind: entry.kind };
  const record = shown.lifecycleRecord ?? shown.lifecycle ?? null;
  const replacement = replacementOf(shown, { marketplace, label, marketplaceKind, items, installed });
  const owner = shown.owner?.name ?? entry.owner?.name ?? null;
  const facts = { state, owner, since: arrivedAt(record), sunset: record?.deprecation?.sunset ?? null, uses, kind: entry.kind, replacement, newest: Boolean(later), recorded };
  return { state, ...(later ? { newest: true } : {}), ...(recorded ? { recorded: true } : {}), replacedBy: record?.deprecation?.replacedBy ?? null,
    sunset: facts.sunset, since: facts.since, owner, uses, replacement, words: inUseWords(facts) };
}

/**
 * Every deprecated or retired item in use here, from what was read: `marketplaces` each `{ id, label, kind, items }`
 * (items `{ kind, name, owner, lifecycleRecord, lifecycleState }`), the rest as itemUses takes them. Each answer
 * `{ key, kind, id, marketplace, marketplaceLabel, ...deprecatedInUse }`, by marketplace, kind and name.
 */
export function inUseOf({ marketplaces = [], imports = {}, library = [], workflows = {}, attachments = [], openStories = [] } = {}) {
  const libraryIds = new Set(library);
  const installedIn = (marketplace) => (item) => Object.values(imports ?? {}).some((record) => {
    const source = record?.source ?? {};
    if (item.kind === 'agent' && record?.kind === 'workflow' && source.kind === 'marketplace-agent') return source.marketplace === marketplace && source.agent === item.name;
    return MARKETPLACE_SOURCES.has(source.kind) && source.marketplace === marketplace && (source.entry ?? record.target?.id) === item.name
      && (record.kind === item.kind || (item.kind === 'skill' && record.kind === 'library-skill' && libraryIds.has(record.target?.id)));
  });
  const found = [];
  for (const market of [...marketplaces].sort((left, right) => byText(left.id, right.id))) {
    const items = market.items ?? [];
    for (const entry of [...items].sort((left, right) => byText(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`))) {
      if (!inUseState(entry)) continue;
      const uses = itemUses({ marketplace: market.id, kind: entry.kind, name: entry.name }, { imports, library: libraryIds, workflows, attachments, openStories });
      const used = deprecatedInUseOf(entry, { marketplace: market.id, label: market.label ?? market.id, marketplaceKind: market.kind, uses, items, installed: installedIn(market.id) });
      if (used) found.push({ key: `market:${market.id}/${entry.kind}/${entry.name}`, kind: entry.kind, id: entry.name, marketplace: market.id, marketplaceLabel: market.label ?? market.id, ...used });
    }
  }
  return found;
}

/** What an item is, in a person's words: "skill web-e2e-test-generation of marketplace Acme". */
export const inUseWhat = (item) => `${KIND_WORDS[item.kind] ?? item.kind} ${item.id}${item.marketplaceLabel ? ` of marketplace ${item.marketplaceLabel}` : ''}`;

// ---------------------------------------------------------------------------------------------- reading what is kept

/**
 * The open Stories on this computer that belong to this repository: the machine's Story index entries that share its Git
 * folder, and this checkout's own Story, each `{ workId, workflow, skills, sha256 }` from its record and its newest
 * snapshot manifest's texts. Read from files only (no Git, no fetch), at most 500; one that cannot be read is left out.
 */
export async function openStoriesHere(root) {
  const [{ repositoryGitDirectory }, { readStoryIndex, storyInCheckout }, { samePlatformPath }] = await Promise.all([
    import('./git-directory.mjs'), import('./story-index.mjs'), import('./util.mjs')]);
  const common = await realpath(repositoryGitDirectory(root) ?? path.join(root, '.git')).catch(() => null);
  if (!common) return [];
  const index = await readStoryIndex().catch(() => ({ entries: [] }));
  const places = index.entries.filter((entry) => entry.role !== 'secondary' && samePlatformPath(entry.commonDir, common))
    .map((entry) => ({ workId: entry.workId, checkout: entry.checkoutPath, workflowPath: entry.workflowPath }));
  const own = await storyInCheckout(root).catch(() => null);
  if (own && !places.some((place) => place.workId === own.workId)) places.unshift({ workId: own.workId, checkout: root, workflowPath: own.workflowPath });
  const small = async (file) => readFile(file).then((bytes) => (bytes.length <= RECORD_LIMIT ? JSON.parse(bytes.toString('utf8')) : null), () => null).catch(() => null);
  const stories = [];
  for (const place of places.slice(0, STORY_LIMIT)) {
    if (!WORK_ID.test(place.workId ?? '') || stories.some((story) => story.workId === place.workId)) continue;
    const workflow = await small(path.join(place.checkout, ...String(place.workflowPath).split('/')));
    if (!workflow || workflow.workItem?.id !== place.workId || CLOSED.has(workflow.status)) continue;
    const manifestPath = workflow.workflowSnapshot?.manifestPath;
    const manifest = typeof manifestPath === 'string' && !manifestPath.split('/').includes('..') ? await small(path.join(place.checkout, ...manifestPath.split('/'))) : null;
    const composition = workflow.resolution?.composition ?? workflow.composition ?? null;
    const workType = workflow.workItem?.workType ?? workflow.workType;
    stories.push({ workId: place.workId, workflow: typeof workType === 'string' ? workType : null,
      skills: (Array.isArray(composition?.skills) ? composition.skills : []).map((skill) => skill?.id).filter((id) => typeof id === 'string'),
      // A manifest names each blob as `sha256:<hex>`; an import record keeps the bare hex.
      sha256: (Array.isArray(manifest?.assets) ? manifest.assets : []).map((asset) => asset?.blob?.sha256).filter((digest) => typeof digest === 'string')
        .map((digest) => digest.replace(/^sha256:/u, '')) });
  }
  return stories;
}

async function keptFile(root) {
  const { repositoryGitPath } = await import('./git-directory.mjs');
  return repositoryGitPath(root, 'singularity-flow', FILE);
}

/** Keep a full answer for a Copilot session's start (keptInUse): the items, in a few fields each. */
export async function keepInUse(root, items) {
  try {
    const file = await keptFile(root);
    const kept = items.map(({ key, kind, id, marketplace, marketplaceLabel, state, newest, replacedBy, replacement }) => ({ key, kind, id, marketplace, marketplaceLabel, state,
      ...(newest ? { newest: true } : {}), replacedBy: replacedBy ?? null, replacement: replacement?.offered ? replacement.id : null }));
    const text = `${JSON.stringify({ format: KEPT_FORMAT, keptAt: new Date().toISOString(), items: kept.filter((item) => !item.newest) })}\n`;
    if (await readFile(file, 'utf8').then((before) => before.replace(/"keptAt":"[^"]*",/u, '') === text.replace(/"keptAt":"[^"]*",/u, ''), () => false)) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } catch { /* the answer is still returned; it is only said at a session's start once kept */ }
}

/**
 * What the last full answer kept, read and never worked out again: what a Copilot session's start says (agent-hooks.mjs),
 * for one small read. Empty when nothing was kept.
 */
export async function keptInUse(root) {
  const kept = await readFile(await keptFile(root), 'utf8').then(JSON.parse, () => null).catch(() => null);
  if (kept?.format !== KEPT_FORMAT || !Array.isArray(kept.items)) return [];
  return kept.items.filter((item) => ['deprecated', 'retired'].includes(item?.state) && typeof item.id === 'string' && typeof item.kind === 'string');
}

/** One line for the person about keptInUse's items, with where to see them and their replacements; null when none. */
export function inUseSessionWords(items) {
  if (!items?.length) return null;
  const named = items.slice(0, 3).map((item) => `${KIND_WORDS[item.kind] ?? item.kind} ${item.id} (${item.state}${item.replacement ? `; use ${item.replacement}` : ''})`);
  const more = items.length > 3 ? ` and ${items.length - 3} more` : '';
  return `Still used here, though its marketplace deprecated or retired it: ${listWords(named)}${more}. Nothing was changed. See them and their replacements: /sf-marketplace (or in your terminal: singularity-flow marketplace catalog).`;
}

/**
 * Deprecated and retired items in use here, from what is kept only [OMK:REQ-041]: each trusted marketplace's listing at
 * the commit it is trusted at (task-skills.mjs keptTrustedListing), the library, the import record, the workflows and
 * their attachments, read in the configuration in scope (the caller sets the approved one). Nothing is fetched.
 * `{ resultType, marketplaces, items }`: each marketplace `{ id, label, checked, kinds, words? }` (unchecked when its
 * listing is not kept, or its agents are not); each item as inUseOf gives it. `workflow` keeps only what that workflow
 * uses, and reads no open Story; `openStories: false` reads none; `keep` keeps a full answer for a session's start.
 */
export async function readInUse(root, { definition = null, workflow = null, openStories = true, keep = workflow == null } = {}) {
  const [{ configurationReadRoot }, { loadDefinition }, { loadSkillLibrary, readSkillAttachments }, { loadImportsLedger }, { readWorkflowArchive, workflowArchived },
    { keptTrustedListing }] = await Promise.all([import('./configuration-read-scope.mjs'), import('./config.mjs'), import('./skill-library.mjs'),
    import('./imports-ledger.mjs'), import('./workflow-archive.mjs'), import('./task-skills.mjs')]);
  const configRoot = configurationReadRoot(root);
  const read = definition ?? await loadDefinition(root);
  const imports = (await loadImportsLedger(configRoot).catch(() => ({ imports: {} }))).imports ?? {};
  const library = workflow ? { skills: new Map() } : await loadSkillLibrary(configRoot).catch(() => ({ skills: new Map() }));
  const attachments = await readSkillAttachments(configRoot).catch(() => []);
  const archive = await readWorkflowArchive(root).catch(() => ({ story: {}, initiative: {} }));
  const workflows = Object.fromEntries(Object.keys(read.workTypes ?? {}).map((id) => [id, { archived: workflowArchived(archive, 'story', id) }]));
  // The library skills a workflow attaches count as the library's for it: what it uses is all that is asked.
  const libraryIds = workflow ? attachments.filter((entry) => entry.workflow === workflow).map((entry) => entry.id) : [...library.skills.keys()];
  const marketplaces = [];
  const sources = [];
  for (const marketplace of Object.values(read.marketplaces ?? {}).sort((left, right) => byText(left.id, right.id))) {
    const label = marketplace.label ?? marketplace.id;
    const kind = marketplace.repository ? 'repository' : 'index';
    const listing = await keptTrustedListing(root, marketplace).catch(() => null);
    const madeHere = Object.values(imports).some((record) => record?.kind === 'workflow' && record.source?.kind === 'marketplace-agent' && record.source.marketplace === marketplace.id);
    if (!listing) {
      sources.push({ id: marketplace.id, label, checked: false, kinds: [],
        words: `Not checked: what marketplace ${label} deprecated or retired, because its list of items at the commit trusted here is not on this computer yet.` });
      continue;
    }
    const agentsUnread = kind === 'repository' && !listing.kinds.includes('agent') && madeHere;
    sources.push({ id: marketplace.id, label, checked: !agentsUnread, kinds: listing.kinds,
      ...(agentsUnread ? { words: `Not checked: whether marketplace ${label} deprecated or retired the agents a workflow here was made from, because its list of agents is not on this computer yet.` } : {}) });
    marketplaces.push({ id: marketplace.id, label, kind, items: listing.items });
  }
  const anyMarked = marketplaces.some((market) => market.items.some((entry) => inUseState(entry)));
  const stories = anyMarked && openStories && !workflow ? await openStoriesHere(root).catch(() => []) : [];
  let items = inUseOf({ marketplaces, imports, library: libraryIds, workflows, attachments, openStories: stories });
  if (workflow) items = items.filter((item) => item.uses.workflows.includes(workflow));
  if (keep && !workflow) await keepInUse(root, items);
  return { schemaVersion: 1, resultType: MARKETPLACE_IN_USE_RESULT, marketplaces: sources, items };
}

/** The Copilot skill that carries a replacement's first step out: a conversion review, an import, or the marketplace's entries. */
const ROUTE_SKILLS = Object.freeze([[/^singularity-flow workflow from-agent /u, '/sf-workflows'], [/^singularity-flow import /u, '/sf-import'],
  [/^singularity-flow marketplace browse /u, '/sf-import']]);

/** The way on from an item in use: its replacement's first step, else the catalog that names it. */
export function inUseRoute(item) {
  if (item.replacement?.offered && item.replacement.preview) {
    const command = item.replacement.preview.command.replace(/ --json$/u, '');
    return { command, skill: ROUTE_SKILLS.find(([pattern]) => pattern.test(command))?.[1] ?? null, label: item.replacement.preview.label };
  }
  return { command: `singularity-flow marketplace catalog --marketplace ${item.marketplace}`, skill: '/sf-marketplace', label: `See ${item.id} and what uses it.` };
}

/**
 * A workflow's line at a Story's start, or in a task's plan, when it was made from or attaches an item in use: what,
 * that it runs as it is, and the way to the replacement (a whole command), or why there is none.
 */
export function workflowInUseWords(workflow, item) {
  const how = item.kind === 'agent' ? `was made from agent ${item.id}` : `attaches ${KIND_WORDS[item.kind] ?? item.kind} ${item.id}`;
  const on = dayWords(item.since) ? ` on ${dayWords(item.since)}` : '';
  const state = item.newest ? `is ${item.state} in its marketplace's newest commit` : `is ${item.state}${item.owner ? ` by ${item.owner}` : ''}${on}`;
  const way = item.replacement?.offered ? ` Its replacement is ${item.replacement.id}: ${inUseRoute(item).command}` : ` ${item.replacement?.words ?? 'Its marketplace names no replacement.'}`;
  return `Workflow ${workflow} ${how} of marketplace ${item.marketplaceLabel}, which ${state}; it runs as it is.${way}`;
}

/**
 * A Story's start: what its marketplace deprecated or retired of what the Story's workflow was made from or attaches, as
 * start advisories `{ id, message, nextAction }`, each with the way to the replacement [OMK:REQ-041]. Read from the
 * configuration the checkout carries and each marketplace's kept listing; it never fetches, and never stops a start.
 */
export async function workflowStartWarnings(root, definition, workType) {
  if (!workType || !Object.keys(definition?.marketplaces ?? {}).length) return [];
  try {
    const found = await readInUse(root, { definition, workflow: workType, keep: false });
    const label = definition.workTypes?.[workType]?.label ?? workType;
    return found.items.map((item) => ({ id: 'marketplace-in-use', message: workflowInUseWords(label, item),
      nextAction: { command: inUseRoute(item).command, label: inUseRoute(item).label } }));
  } catch {
    return [];
  }
}
