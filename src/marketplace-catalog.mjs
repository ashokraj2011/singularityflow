/**
 * Every marketplace item on one page, like an app store [owner, 2026-11-25: "see what is installed in local and update,
 * like an app store"]: the skills, agents, templates, MCP servers and generated sources of each marketplace this
 * repository trusts, the workflows made from its agents, and what is installed here. Each item says whether it is installed here, has an update, is not
 * installed, or is only here, with the whole commands that preview, install, update or remove it.
 *
 * - Read as Stories use them: the approved configuration's marketplaces, library, import record and workflows. A Git
 *   repository marketplace is read at the commit it is trusted at, through task-skills.mjs's per-commit listing of its
 *   agents and skills (read once per commit, kept in the clone's Git folder); an index is read now, as `marketplace
 *   browse` reads it, its newest version of each entry. A marketplace this checkout's workflow.yml trusts that is not
 *   approved yet is one row that says so, never read (task-skills.mjs unapprovedMarketplaces).
 * - Installed is the same text as the marketplace has at the commit it is trusted at: a skill, agent or template by the
 *   SHA-256 its import recorded against the marketplace's own; a workflow made from an agent by the pieces its import
 *   recorded (agent.md, its apm.yml and each skill it uses, agent-workflow-provenance.mjs). Anything else is an update,
 *   and the item says which: a newer version, or a changed text. A commit newer than the trusted one is what `imports
 *   check` and Workflow Studio's Read its newest commit find: moving the trust is a reviewed change of its own.
 * - Every action is a whole command through the import's own review: a preview, then a proposal (`import add …
 *   --propose`, `workflow from-agent … --propose`, `skill remove … --propose`, `workflow archive … --propose`, `imports
 *   remove … --propose`). The install and update commands name the SHA-256 of the exact text they add, as `imports check`
 *   does; no screen shows it, and no commit is ever shown.
 * - An index also lists MCP servers, generated sources and workflows. An MCP server is added for the agents that may use
 *   its tools, which its preview shows, so its row has the preview and the person names the agents (an update keeps those
 *   it was added for). A generated source is fetched by the agent that drafts its step, so its install names that agent,
 *   and a step no workflow here has, or no agent drafts, says so instead. `workflow import` reads a bundle from a file
 *   only, so an index's workflow has no install: its row says why and what to do instead.
 *
 * analyzeMarketplaceCatalog is pure; readMarketplaceCatalog reads, and writes nothing but the per-commit listing a task
 * already keeps.
 */
import { createHash } from 'node:crypto';

import { differencesWords, piecesDifferences } from './agent-workflow-provenance.mjs';
import { compareVersions } from './marketplace.mjs';
import { librarySkillCandidate, marketplaceSkillCandidate, unapprovedMarketplaces } from './task-skills.mjs';
import { SingularityFlowError } from './util.mjs';

export const MARKETPLACE_CATALOG_RESULT = 'marketplace-catalog';
export const MARKETPLACE_CATALOG_COMMAND = 'singularity-flow marketplace catalog';
/** What the page has a tab for, in its order; a marketplace not approved yet is a row of its own kind. */
export const CATALOG_KINDS = Object.freeze(['skill', 'agent', 'workflow', 'template', 'mcp-server', 'generated']);
export const CATALOG_STATUSES = Object.freeze(['update-available', 'installed', 'not-installed', 'local-only', 'not-approved-yet']);
const KIND_ORDER = [...CATALOG_KINDS, 'marketplace'];
const INDEX_KINDS = new Set(CATALOG_KINDS);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MARKETPLACE_SOURCES = new Set(['marketplace', 'marketplace-skill']);
const sha256 = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
const EMPTY_SHA256 = sha256('');
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const listWords = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');
const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
const displayTags = (tags) => [...new Set((tags ?? []).map(String).filter((tag) => !/^(?:task|intent|lifecycle):/u.test(tag)))].sort(byText);
const capitalized = (text) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text);

function refusal(code, message, nextAction, details = {}) {
  return new SingularityFlowError(message, { code, details: { ...details, nextAction } });
}

// ---------------------------------------------------------------------------------------------- what a marketplace has

/**
 * A Git repository marketplace's items, from task-skills.mjs trustedMarketplaceAgents at the trusted commit: each skill
 * with the SHA-256 of its SKILL.md, each agent with the pieces a workflow made from it records.
 */
export function repositoryItems({ agents = [], skills = [] } = {}) {
  const skillSha256 = new Map(skills.map((skill) => [skill.name, skill.sha256 ?? null]));
  return [
    ...skills.map((skill) => ({ kind: 'skill', name: skill.name, label: skill.name, version: skill.version ?? null, description: skill.description ?? '',
      tags: skill.tags ?? [], pdlcTasks: skill.pdlcTasks ?? [], lifecycleState: skill.lifecycleState ?? null, sha256: skill.sha256 ?? null })),
    ...agents.map((agent) => ({ kind: 'agent', name: agent.name, label: agent.name, version: agent.version ?? null, description: agent.description ?? '',
      tags: agent.tags ?? [], pdlcTasks: agent.pdlcTasks ?? [], lifecycleState: agent.lifecycleState ?? null, sha256: null,
      // As agent-workflow-provenance.mjs sourcePieces makes them from the same files.
      pieces: { agent: sha256(agent.text), manifest: agent.manifestSha256 ?? null, skills: Object.fromEntries((agent.skills ?? [])
        .filter((name) => skillSha256.has(name)).sort(byText).map((name) => [name, skillSha256.get(name) ?? EMPTY_SHA256])) } }))
  ];
}

/**
 * An index marketplace's items: the newest version of each skill, agent, template, workflow, MCP server and generated
 * source it lists. A generated source keeps where it is fetched from and into, a workflow the link of its bundle.
 */
export function indexItems(index = {}) {
  const newest = new Map();
  for (const entry of index.entries ?? []) {
    if (!INDEX_KINDS.has(entry?.kind) || !ID.test(String(entry.id ?? ''))) continue;
    const key = `${entry.kind}:${entry.id}`;
    const kept = newest.get(key);
    if (!kept || compareVersions(entry.version, kept.version) > 0) newest.set(key, entry);
  }
  return [...newest.values()].map((entry) => ({ kind: entry.kind, name: entry.id, label: entry.label ?? entry.id, version: entry.version ?? null,
    description: entry.description ?? '', tags: entry.tags ?? [], pdlcTasks: [], lifecycleState: null, sha256: entry.sha256 ?? null,
    ...(entry.kind === 'generated' ? { generated: { urlTemplate: entry.urlTemplate ?? null, phase: entry.phase ?? null, target: entry.target ?? null } } : {}),
    ...(entry.kind === 'workflow' ? { url: entry.url ?? null } : {}) }));
}

// ---------------------------------------------------------------------------------------------- commands

const reference = (marketplace, name) => `market:${marketplace}/${name}`;
const AS = Object.freeze({ skill: 'skill', agent: 'agent', template: 'template', 'mcp-server': 'mcp-server', generated: 'generated' });

function previewCommand(kind, marketplace, name) {
  return `singularity-flow import preview ${JSON.stringify(reference(marketplace, name))} --as ${AS[kind]} --json`;
}

/**
 * `import add` of exactly the marketplace's text, proposed: the SHA-256 is the text's, as `imports check` names it. A
 * generated source has no text to pin: the index entry gives its URL template, step and target, and `agent` fetches it.
 */
function addCommand(kind, marketplace, name, { id = null, agent = null, agents = [], phases = [], sha256: hash = null, replace = false }) {
  return ['singularity-flow import add', JSON.stringify(reference(marketplace, name)), `--as ${AS[kind]}`, agent ? `--agent ${agent}` : null,
    agents.length ? `--agents ${agents.join(',')}` : null, id ? `--id ${id}` : null, phases.length ? `--phases ${phases.join(',')}` : null,
    hash ? `--sha256 ${hash}` : null, replace ? '--replace' : null, '--propose']
    .filter(Boolean).join(' ');
}

const action = (command, label) => ({ command, label });

// ---------------------------------------------------------------------------------------------- one row

/** Whether what was installed is what the marketplace has now: its text's SHA-256, else the commit or version recorded. */
function sameText(record, entry, marketplace) {
  if (record.sha256 && entry.sha256) return record.sha256 === entry.sha256;
  if (record.source?.commit && marketplace.commit) return record.source.commit === marketplace.commit;
  return (record.source?.version ?? null) === (entry.version ?? null);
}

/** An update in words: a newer (or other) version, or a changed text at the same version. */
function textUpdate(installedVersion, version, label) {
  if (version && installedVersion && version !== installedVersion) {
    return { kind: 'version', from: installedVersion, to: version, newer: compareVersions(version, installedVersion) > 0,
      words: `Marketplace ${label} has version ${version}; version ${installedVersion} is installed here.` };
  }
  return { kind: 'text', from: installedVersion, to: version, newer: false,
    words: `Marketplace ${label} has a changed text${version ? ` at the same version, ${version}` : ''}; the copy installed here is the earlier one.` };
}

function row({ key, kind, id, name = id, description = '', source, marketplace = null, labels, marketplaceKind = null, version = null, installedVersion = null,
  facts = null, tags = [], status, statusWords, update = null, installedAs = null, fromAgent = null, conflict = null, importable = true, actions = {} }) {
  return {
    key, kind, id, name, description, source, marketplace, marketplaceLabel: marketplace ? labels.get(marketplace) ?? marketplace : null, marketplaceKind,
    version, installedVersion, lifecycle: facts?.state ?? null, readiness: facts?.lifecycle ?? null, tags: displayTags(tags), softwareKinds: [...(facts?.kinds ?? [])],
    status, statusWords, update, installedAs, fromAgent, conflict, importable, actions
  };
}

/** Where an install here came from, for a row only here. */
function cameFromWords(record, { trusted, listed, labels }) {
  if (!record) return 'Written in this repository, or set up with SFlow: no marketplace has it.';
  const source = record.source ?? {};
  if (MARKETPLACE_SOURCES.has(source.kind) || source.kind === 'marketplace-agent') {
    const name = labels.get(source.marketplace) ?? source.marketplace;
    if (!trusted.has(source.marketplace)) return `It came from marketplace ${name}, which this repository no longer trusts; it stays until you remove it.`;
    if (!listed) return `It came from marketplace ${name}, which no longer lists it; it stays until you remove it.`;
  }
  if (source.kind === 'url') return 'It was imported from a link, not from a marketplace.';
  if (source.kind === 'mcp') return 'It was imported from an MCP server, not from a marketplace.';
  return 'It was imported from outside the trusted marketplaces.';
}

/**
 * The page from what was read: `marketplaces` each `{ id, label, kind, commit, items, warning }` with its items from
 * repositoryItems or indexItems, `library` the skill library's skills, `imports` the import record's entries,
 * `workflows` each workflow ID here with `{ label, archived }`, `steps` each step ID here with `{ label, agent }` (the
 * agent that drafts it, which fetches a generated source for it), `unapproved` what the working copy trusts that is
 * not approved (task-skills.mjs unapprovedMarketplaces). `only`, `kind` and `search` narrow the rows.
 */
export function analyzeMarketplaceCatalog({ marketplaces = [], library = [], imports = {}, workflows = {}, steps = {}, unapproved = [], warnings = [],
  only = null, kind = null, search = null } = {}) {
  const markets = [...marketplaces].sort((left, right) => byText(left.id, right.id));
  const labels = new Map([...unapproved.map((entry) => [entry.id, entry.label ?? entry.id]), ...markets.map((market) => [market.id, market.label ?? market.id])]);
  const trusted = new Set(markets.map((market) => market.id));
  const readable = new Map(markets.filter((market) => !market.warning && !market.skipped).map((market) => [market.id, market]));
  const records = Object.entries(imports ?? {}).filter(([, record]) => record && typeof record === 'object').map(([key, record]) => ({ key, ...record }))
    .sort((left, right) => byText(left.key, right.key));
  const libraryById = new Map(library.map((skill) => [skill.id, skill]));
  const fromMarket = (kinds, marketplace, name) => records.filter((record) => kinds.includes(record.kind) && MARKETPLACE_SOURCES.has(record.source?.kind)
    && record.source.marketplace === marketplace && (record.source.entry ?? record.target?.id) === name);
  const represented = new Set();
  const rows = [];
  const agentRows = new Map();

  const skillRow = (market, entry) => {
    const facts = marketplaceSkillCandidate(entry, market.id);
    const installs = fromMarket(['library-skill', 'skill'], market.id, entry.name).filter((record) => record.kind !== 'library-skill' || libraryById.has(record.target?.id));
    for (const record of installs) represented.add(record.key);
    const install = installs.find((record) => record.kind === 'library-skill') ?? installs[0] ?? null;
    const label = labels.get(market.id);
    const target = install?.target ?? {};
    const installedAs = install ? (install.kind === 'library-skill' ? { as: 'library-skill', id: target.id, importKey: install.key }
      : { as: 'agent-skill', id: target.id, agent: target.agent ?? null, importKey: install.key }) : null;
    const actions = { preview: action(previewCommand('skill', market.id, entry.name), 'Show its exact text before installing it.') };
    let status; let statusWords; let update = null; let conflict = null;
    if (install) {
      const same = sameText(install, entry, market);
      status = same ? 'installed' : 'update-available';
      update = same ? null : textUpdate(install.source?.version ?? null, entry.version, label);
      statusWords = same ? `Installed here${install.kind === 'skill' ? ` for agent ${target.agent}` : ''}, the same as in marketplace ${label}.` : update.words;
      if (!same && entry.sha256) {
        actions.update = action(addCommand('skill', market.id, entry.name, { id: target.id, agent: install.kind === 'skill' ? target.agent : null,
          phases: install.kind === 'skill' ? target.phases ?? [] : [], sha256: entry.sha256, replace: true }), 'Propose replacing the installed copy with the marketplace\'s text.');
      }
      actions.remove = install.kind === 'library-skill'
        ? action(`singularity-flow skill remove ${target.id} --propose`, 'Propose removing it from the skill library.')
        : action(`singularity-flow imports remove ${install.key} --propose`, `Propose removing it from agent ${target.agent}.`);
      if (install.kind === 'library-skill') actions.open = action(`singularity-flow skill show ${target.id}`, 'Show the installed skill and who uses it.');
    } else {
      status = 'not-installed';
      if (libraryById.has(entry.name)) {
        const other = records.find((record) => record.key === `library-skill:${entry.name}`) ?? null;
        conflict = other
          ? { replaces: true, words: `The library's ${entry.name} came from ${MARKETPLACE_SOURCES.has(other.source?.kind) ? `marketplace ${labels.get(other.source.marketplace) ?? other.source.marketplace}` : 'elsewhere'}; installing this one replaces it.` }
          : { replaces: false, words: `The library has its own ${entry.name}, written in this repository, so this one cannot be installed under that name.` };
      }
      statusWords = conflict?.words ?? (entry.sha256 ? 'Not installed here.' : 'Not installed here, and it has no SKILL.md in the marketplace to install.');
      if (entry.sha256 && (!conflict || conflict.replaces)) {
        actions.install = action(addCommand('skill', market.id, entry.name, { id: entry.name, sha256: entry.sha256, replace: Boolean(conflict) }),
          'Propose adding it to the skill library, reviewed like any change.');
      }
    }
    return row({ key: `market:${market.id}/skill/${entry.name}`, kind: 'skill', id: entry.name, name: entry.label, description: entry.description, source: 'marketplace',
      marketplace: market.id, labels, marketplaceKind: market.kind, version: entry.version, installedVersion: install?.source?.version ?? null, facts, tags: entry.tags,
      status, statusWords, update, installedAs, conflict, importable: Boolean(entry.sha256), actions });
  };

  /** A Git repository marketplace's agent: installed as the workflow made from it. */
  const agentRow = (market, entry) => {
    const facts = marketplaceSkillCandidate({ name: entry.name, tags: entry.tags, pdlcTasks: [], lifecycleState: entry.lifecycleState }, market.id);
    const record = records.find((item) => item.kind === 'workflow' && item.source?.kind === 'marketplace-agent' && item.source.marketplace === market.id
      && item.source.agent === entry.name && workflows[item.workflow]) ?? null;
    if (record) represented.add(record.key);
    const workflow = record ? { id: record.workflow, ...workflows[record.workflow] } : null;
    const label = labels.get(market.id);
    const target = `${market.id}/${entry.name}`;
    const installedAs = workflow ? { as: 'workflow', id: workflow.id, label: workflow.label ?? workflow.id, importKey: record.key, archived: workflow.archived === true } : null;
    const actions = {};
    let status; let statusWords; let update = null;
    if (workflow && !workflow.archived) {
      const difference = record.pieces && entry.pieces ? piecesDifferences(record.pieces, entry.pieces) : null;
      const same = (record.source.commit && record.source.commit === market.commit) || Boolean(difference?.unchanged);
      status = same ? 'installed' : 'update-available';
      if (!same) {
        const newer = Boolean(entry.version && record.source.version && entry.version !== record.source.version);
        update = { kind: difference ? 'pieces' : 'version', from: record.source.version ?? null, to: entry.version, newer: newer && compareVersions(entry.version, record.source.version) > 0,
          words: `${difference ? capitalized(differencesWords(difference)) : 'What it was made from was not recorded'} in marketplace ${label}${newer ? `; it is now version ${entry.version}` : ''}.` };
      }
      statusWords = same ? `Installed here as workflow ${installedAs.label}, the same as in marketplace ${label}.` : update.words;
      if (!same) {
        actions.preview = action(`singularity-flow workflow from-agent ${target} --update --review`, 'See what changed and the workflow it becomes now.');
        actions.update = action(`singularity-flow workflow from-agent ${target} --update --propose`, 'Propose the updated workflow, through its conversion review.');
      }
      actions.remove = action(`singularity-flow workflow archive ${workflow.id} --propose`, 'Propose archiving its workflow; running Stories keep it.');
    } else if (workflow) {
      status = 'not-installed';
      statusWords = `Its workflow ${installedAs.label} is archived: new Stories are not offered it.`;
      actions.preview = action(`singularity-flow workflow from-agent ${target} --review`, 'See the workflow it becomes, stage by stage.');
      actions.install = action(`singularity-flow workflow restore ${workflow.id} --propose`, 'Propose offering its archived workflow to new Stories again.');
    } else {
      status = 'not-installed';
      statusWords = 'Not installed here: it becomes a workflow through its conversion review.';
      actions.preview = action(`singularity-flow workflow from-agent ${target} --review`, 'See the workflow it becomes, stage by stage.');
      actions.install = action(`singularity-flow workflow from-agent ${target} --propose`, 'Propose its workflow, through its conversion review.');
    }
    const made = row({ key: `market:${market.id}/agent/${entry.name}`, kind: 'agent', id: entry.name, name: entry.label, description: entry.description, source: 'marketplace',
      marketplace: market.id, labels, marketplaceKind: market.kind, version: entry.version, installedVersion: record?.source?.version ?? null, facts, tags: entry.tags,
      status, statusWords, update, installedAs, importable: true, actions });
    if (record) agentRows.set(record.key, made);
    return made;
  };

  /** An index marketplace's agent, template or MCP server: installed by its import. */
  const importRow = (market, entry) => {
    const facts = marketplaceSkillCandidate({ name: entry.name, tags: entry.tags, pdlcTasks: [], lifecycleState: null }, market.id);
    const install = fromMarket([entry.kind], market.id, entry.name)[0] ?? null;
    if (install) represented.add(install.key);
    const label = labels.get(market.id);
    const target = install?.target ?? {};
    const id = target.id ?? entry.name;
    const actions = { preview: action(previewCommand(entry.kind, market.id, entry.name), 'Show its exact text before installing it.') };
    const kindWords = { agent: 'agent', template: 'template', 'mcp-server': 'MCP server' }[entry.kind];
    // An MCP server is added for the agents that may use its tools, which only its preview shows: the person names them.
    const server = entry.kind === 'mcp-server';
    let status; let statusWords; let update = null;
    if (install) {
      const same = sameText(install, entry, market);
      status = same ? 'installed' : 'update-available';
      update = same ? null : textUpdate(install.source?.version ?? null, entry.version, label);
      statusWords = same ? `Installed here${server && target.agents?.length ? ` for ${listWords(target.agents)}` : ''}, the same as in marketplace ${label}.` : update.words;
      if (!same && entry.sha256) {
        actions.update = action(addCommand(entry.kind, market.id, entry.name, { id: entry.kind === 'template' ? id : null, agents: server ? target.agents ?? [] : [],
          phases: server ? target.phases ?? [] : [], sha256: entry.sha256, replace: true }), `Propose replacing the installed ${kindWords} with the marketplace's text.`);
      }
      actions.remove = action(`singularity-flow imports remove ${install.key} --propose`, `Propose removing the ${kindWords}.`);
    } else {
      status = 'not-installed';
      statusWords = server ? 'Not installed here: its preview shows the tools it offers and the command that adds it; name the agents that may use them with --agents.'
        : 'Not installed here.';
      if (entry.sha256 && !server) {
        actions.install = action(addCommand(entry.kind, market.id, entry.name, { id: entry.kind === 'template' ? entry.name : null, sha256: entry.sha256 }),
          `Propose adding the ${kindWords}, reviewed like any change.`);
      }
    }
    return row({ key: `market:${market.id}/${entry.kind}/${entry.name}`, kind: entry.kind, id: entry.name, name: entry.label, description: entry.description,
      source: 'marketplace', marketplace: market.id, labels, marketplaceKind: market.kind, version: entry.version, installedVersion: install?.source?.version ?? null,
      facts, tags: entry.tags, status, statusWords, update,
      installedAs: install ? { as: entry.kind, id, ...(server ? { agents: [...(target.agents ?? [])] } : {}), importKey: install.key } : null,
      importable: Boolean(entry.sha256), actions });
  };

  /**
   * An index marketplace's generated source: fetched for each Story, by the agent that drafts its step, into its target.
   * Installed by its import for that agent; the same when its version, URL template, step and target are.
   */
  const generatedRow = (market, entry) => {
    const facts = marketplaceSkillCandidate({ name: entry.name, tags: entry.tags, pdlcTasks: [], lifecycleState: null }, market.id);
    const source = entry.generated ?? {};
    const install = fromMarket(['generated'], market.id, entry.name)[0] ?? null;
    if (install) represented.add(install.key);
    const label = labels.get(market.id);
    const step = source.phase ? steps[source.phase] ?? null : null;
    const stepWords = step ? `step ${step.label ?? source.phase}` : `step ${source.phase ?? 'it names'}`;
    const target = install?.target ?? {};
    const actions = {};
    let status; let statusWords; let update = null;
    if (install) {
      const same = (install.source?.version ?? null) === (entry.version ?? null) && (install.source?.urlTemplate ?? null) === (source.urlTemplate ?? null)
        && (target.phase ?? null) === (source.phase ?? null) && (target.path ?? null) === (source.target ?? null);
      status = same ? 'installed' : 'update-available';
      if (!same) {
        update = entry.version && install.source?.version && entry.version !== install.source.version ? textUpdate(install.source.version, entry.version, label)
          : { kind: 'source', from: install.source?.version ?? null, to: entry.version, newer: false,
            words: `Marketplace ${label} fetches it from another address, step or file now; the source installed here is the earlier one.` };
        actions.update = action(addCommand('generated', market.id, entry.name, { agent: target.agent, id: target.id !== entry.name ? target.id : null, replace: true }),
          'Propose fetching it as the marketplace says now.');
      }
      statusWords = same ? `Installed here: agent ${target.agent} fetches it for each Story, the same as in marketplace ${label}.` : update.words;
      actions.remove = action(`singularity-flow imports remove ${install.key} --propose`, `Propose that agent ${target.agent} stops fetching it.`);
    } else {
      status = 'not-installed';
      if (!step) statusWords = `It is fetched for ${stepWords}, which no workflow here has, so nothing would fetch it.`;
      else if (!step.agent) statusWords = `No agent drafts ${stepWords} here, so nothing would fetch it.`;
      else {
        statusWords = `Not installed here: agent ${step.agent} would fetch it into ${source.target} for each Story, when ${stepWords} starts.`;
        actions.install = action(addCommand('generated', market.id, entry.name, { agent: step.agent }), `Propose that agent ${step.agent} fetches it, reviewed.`);
      }
    }
    return row({ key: `market:${market.id}/generated/${entry.name}`, kind: 'generated', id: entry.name, name: entry.label, description: entry.description,
      source: 'marketplace', marketplace: market.id, labels, marketplaceKind: market.kind, version: entry.version, installedVersion: install?.source?.version ?? null,
      facts, tags: entry.tags, status, statusWords, update,
      installedAs: install ? { as: 'generated', id: target.id ?? entry.name, agent: target.agent ?? null, importKey: install.key } : null,
      importable: Boolean(actions.install || actions.update || install), actions });
  };

  for (const market of markets) {
    if (market.warning || market.skipped) continue;
    for (const entry of [...(market.items ?? [])].sort((left, right) => byText(`${left.kind}:${left.name}`, `${right.kind}:${right.name}`))) {
      if (entry.kind === 'skill') rows.push(skillRow(market, entry));
      else if (entry.kind === 'agent' && market.kind === 'repository') rows.push(agentRow(market, entry));
      else if (['agent', 'template', 'mcp-server'].includes(entry.kind)) rows.push(importRow(market, entry));
      else if (entry.kind === 'generated') rows.push(generatedRow(market, entry));
      else if (entry.kind === 'workflow') {
        // `workflow import` reads a bundle from a file only, so an index's workflow has no install here: the row says why
        // and what to do instead, and has no button.
        rows.push(row({ key: `market:${market.id}/workflow/${entry.name}`, kind: 'workflow', id: entry.name, name: entry.label, description: entry.description,
          source: 'marketplace', marketplace: market.id, labels, marketplaceKind: market.kind, version: entry.version,
          facts: marketplaceSkillCandidate({ name: entry.name, tags: entry.tags, pdlcTasks: [] }, market.id), tags: entry.tags, status: 'not-installed',
          statusWords: `Not installed here: SFlow imports a workflow from a bundle file, not from a marketplace's link. Save the bundle${entry.url ? ` from ${entry.url}` : ''},`
            + ' then preview its import with singularity-flow workflow import, that file, --dry-run and --propose.', importable: false }));
      }
    }
  }

  // The workflows made from marketplace agents that are here (an archived one is under its agent): each with its agent's status.
  for (const record of records.filter((item) => item.kind === 'workflow' && item.source?.kind === 'marketplace-agent' && workflows[item.workflow]
    && !workflows[item.workflow].archived)) {
    const workflow = workflows[record.workflow];
    const agent = agentRows.get(record.key) ?? null;
    const marketplace = record.source.marketplace;
    const name = workflow.label ?? record.workflow;
    const base = { key: `here:${record.key}`, kind: 'workflow', id: record.workflow, name, source: 'here', marketplace, labels,
      marketplaceKind: trusted.has(marketplace) ? markets.find((market) => market.id === marketplace).kind : null, version: record.source.version ?? null,
      installedVersion: record.source.version ?? null, installedAs: { as: 'workflow', id: record.workflow, label: name, importKey: record.key, archived: false },
      fromAgent: { marketplace, agent: record.source.agent } };
    represented.add(record.key);
    if (agent) {
      rows.push(row({ ...base, description: agent.description, version: agent.version, facts: { state: agent.lifecycle, lifecycle: agent.readiness, kinds: agent.softwareKinds },
        tags: agent.tags, status: agent.status, update: agent.update,
        statusWords: agent.status === 'installed' ? `Made from agent ${record.source.agent}, the same as in marketplace ${agent.marketplaceLabel}.` : agent.statusWords,
        actions: Object.fromEntries(Object.entries(agent.actions).filter(([name_]) => ['preview', 'update', 'remove'].includes(name_))) }));
      continue;
    }
    const remove = { remove: action(`singularity-flow workflow archive ${record.workflow} --propose`, 'Propose archiving the workflow; running Stories keep it.') };
    if (trusted.has(marketplace) && !readable.has(marketplace)) {
      rows.push(row({ ...base, status: 'installed', actions: remove,
        statusWords: `Made from agent ${record.source.agent}; marketplace ${labels.get(marketplace)} could not be read just now, so an update is not known.` }));
      continue;
    }
    rows.push(row({ ...base, status: 'local-only', actions: remove,
      statusWords: cameFromWords(record, { trusted, listed: false, labels }).replace(/^It came/u, `Made from agent ${record.source.agent}, it came`) }));
  }

  // What is installed here that no row above stands for: library skills, and imported agents, templates and agents' skills.
  const unknownNow = (record) => record && MARKETPLACE_SOURCES.has(record.source?.kind) && trusted.has(record.source.marketplace) && !readable.has(record.source.marketplace);
  const hereRow = (record, fields) => {
    const marketplace = MARKETPLACE_SOURCES.has(record?.source?.kind) ? record.source.marketplace : null;
    const unknown = unknownNow(record);
    return row({ source: 'here', marketplace, labels, marketplaceKind: marketplace && trusted.has(marketplace) ? markets.find((market) => market.id === marketplace).kind : null,
      installedVersion: record?.source?.version ?? null, version: record?.source?.version ?? null, status: unknown ? 'installed' : 'local-only',
      statusWords: unknown ? `Installed here from marketplace ${labels.get(marketplace)}, which could not be read just now, so an update is not known.`
        : cameFromWords(record, { trusted, listed: false, labels }), ...fields });
  };
  for (const skill of [...libraryById.values()].sort((left, right) => byText(left.id, right.id))) {
    const record = records.find((item) => item.key === `library-skill:${skill.id}`) ?? null;
    if (record && represented.has(record.key)) continue;
    rows.push(hereRow(record, { key: `here:library-skill:${skill.id}`, kind: 'skill', id: skill.id, name: skill.label ?? skill.id, description: skill.description ?? '',
      facts: librarySkillCandidate(skill, record), tags: [...(skill.tags ?? []), ...(record?.source?.tags ?? [])],
      installedAs: { as: 'library-skill', id: skill.id, importKey: record?.key ?? null },
      actions: { open: action(`singularity-flow skill show ${skill.id}`, 'Show the installed skill and who uses it.'),
        remove: action(`singularity-flow skill remove ${skill.id} --propose`, 'Propose removing it from the skill library.') } }));
  }
  for (const record of records.filter((item) => ['skill', 'agent', 'template', 'mcp-server', 'generated'].includes(item.kind) && !represented.has(item.key))) {
    const target = record.target ?? {};
    const as = record.kind === 'skill' ? 'agent-skill' : record.kind;
    const forAgent = ['skill', 'generated'].includes(record.kind);
    rows.push(hereRow(record, { key: `here:${record.key}`, kind: record.kind, id: target.id ?? record.key, name: target.label ?? target.id ?? record.key,
      tags: record.source?.tags ?? [],
      installedAs: { as, id: target.id ?? null, ...(forAgent ? { agent: target.agent ?? null } : {}), importKey: record.key },
      actions: { remove: action(`singularity-flow imports remove ${record.key} --propose`, forAgent ? `Propose removing it from agent ${target.agent}.` : 'Propose removing what was imported.') } }));
  }

  // Trusted only in the working copy: one row, never read, never shown as trusted.
  for (const entry of unapproved.filter((item) => item.change === 'added')) {
    rows.push(row({ key: `marketplace:${entry.id}`, kind: 'marketplace', id: entry.id, name: entry.label ?? entry.id, source: 'marketplace', marketplace: entry.id, labels,
      marketplaceKind: entry.kind, status: 'not-approved-yet', importable: false,
      statusWords: 'Trusted only in your working copy of workflow.yml, and not approved yet: Stories do not use it, so its items are not read.',
      actions: { approve: action('singularity-flow configuration proposals', 'See whether the change that trusts it waits for approval.') } }));
  }

  const words = String(search ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
  const shown = rows
    .filter((item) => only == null || item.marketplace === only)
    .filter((item) => kind == null || item.kind === kind || item.kind === 'marketplace')
    .filter((item) => {
      const text = [item.id, item.name, item.description, item.marketplace ?? '', item.marketplaceLabel ?? '', ...item.tags].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || byText(left.id, right.id) || byText(left.marketplace ?? '', right.marketplace ?? '')
      || byText(left.key, right.key));
  const pending = new Map(unapproved.map((entry) => [entry.id, entry]));
  const sources = [
    ...markets.filter((market) => !market.skipped && (only == null || market.id === only)).map((market) => ({
      id: market.id, kind: market.kind, label: market.label ?? market.id, approved: true, read: !market.warning,
      items: rows.filter((item) => item.source === 'marketplace' && item.marketplace === market.id).length,
      ...(market.warning ? { warning: market.warning } : {}),
      ...(pending.has(market.id) ? { notApproved: pending.get(market.id).words } : {}) })),
    ...unapproved.filter((entry) => entry.change === 'added' && (only == null || entry.id === only)).map((entry) => ({
      id: entry.id, kind: entry.kind, label: entry.label ?? entry.id, approved: false, read: false, items: 0, notApproved: entry.words }))
  ];
  const count = (keyOf) => {
    const counted = {};
    for (const item of shown) counted[keyOf(item)] = (counted[keyOf(item)] ?? 0) + 1;
    return counted;
  };
  return {
    schemaVersion: 1, resultType: MARKETPLACE_CATALOG_RESULT,
    filters: { marketplace: only, kind, search: search ?? null },
    sources,
    items: shown,
    summary: {
      items: shown.length,
      byKind: Object.fromEntries(KIND_ORDER.map((name) => [name, shown.filter((item) => item.kind === name).length])),
      byStatus: Object.fromEntries(CATALOG_STATUSES.map((name) => [name, count((item) => item.status)[name] ?? 0])),
      updates: shown.filter((item) => item.status === 'update-available').length
    },
    warnings: [...warnings, ...sources.filter((source) => source.warning).map((source) => source.warning)]
  };
}

// ---------------------------------------------------------------------------------------------- reading

/** An unreadable marketplace in words, with no commit ID: what could not be read and what to check. */
function unreadableWords(marketplace, error) {
  const name = marketplace.label && marketplace.label !== marketplace.id ? `${marketplace.label} (${marketplace.id})` : marketplace.id;
  if (error?.code === 'MARKETPLACE_REPOSITORY_UNREACHABLE') {
    return `Marketplace ${name} could not be read: this computer could not reach ${marketplace.repository} with Git at the commit this repository trusts, so its items are not listed.`;
  }
  return `Marketplace ${name} could not be read, so its items are not listed: ${firstLine(error).replace(/\b(?:at )?(?:commit )?[0-9a-f]{12,64}\b/gu, 'at the commit it is trusted at')}`;
}

/**
 * Read the page from the approved configuration: what Stories use [owner, 2026-11-25]. `marketplace` reads only that
 * one (with what is installed from it), `kind` and `search` narrow the rows; `fetchImpl` reads an index.
 */
export async function readMarketplaceCatalog(root, { marketplace: only = null, kind = null, search = null, fetchImpl = globalThis.fetch } = {}) {
  const [{ withApprovedConfigurationRead }, { withoutConfigurationReadScope }, { configuredMarketplaces }] = await Promise.all([
    import('./approved-configuration-reader.mjs'), import('./configuration-read-scope.mjs'), import('./marketplace.mjs')]);
  // This checkout's own workflow.yml, read before the approved one is in scope, to name what is not approved yet.
  const working = await withoutConfigurationReadScope(() => configuredMarketplaces(root)).catch(() => null);
  return withApprovedConfigurationRead(root, (authority) => readApprovedCatalog(root, {
    only, kind, search, fetchImpl, working: authority && authority.kind !== 'working-tree' ? working : null
  }), { preferAuthority: true });
}

async function readApprovedCatalog(root, { only, kind, search, fetchImpl, working }) {
  const [{ configurationReadRoot }, { loadDefinition }, { loadSkillLibrary }, { loadImportsLedger }, { readWorkflowArchive, workflowArchived },
    { trustedMarketplaceAgents }, { fetchMarketplaceIndex }] = await Promise.all([
    import('./configuration-read-scope.mjs'), import('./config.mjs'), import('./skill-library.mjs'), import('./imports-ledger.mjs'),
    import('./workflow-archive.mjs'), import('./task-skills.mjs'), import('./marketplace.mjs')]);
  const configRoot = configurationReadRoot(root);
  const definition = await loadDefinition(root);
  const trusted = Object.values(definition.marketplaces ?? {}).sort((left, right) => byText(left.id, right.id));
  const unapproved = working ? unapprovedMarketplaces(definition.marketplaces ?? {}, working) : [];
  if (only != null && !trusted.some((marketplace) => marketplace.id === only) && !unapproved.some((entry) => entry.id === only && entry.change === 'added')) {
    const ids = trusted.map((marketplace) => marketplace.id);
    throw refusal('MARKETPLACE_CATALOG_UNKNOWN', `This repository does not trust a marketplace called '${only}'.${ids.length ? ` It trusts ${listWords(ids)}.` : ' It trusts none yet.'}`,
      { command: MARKETPLACE_CATALOG_COMMAND, label: 'See every item of every trusted marketplace.' }, { marketplace: only, trusted: ids });
  }
  const warnings = [];
  const library = await loadSkillLibrary(configRoot);
  for (const problem of library.problems) warnings.push(`The library's ${problem.id ?? 'folder'} is not listed: ${problem.message}`);
  const ledger = await loadImportsLedger(configRoot).catch((error) => {
    warnings.push(`What was installed from where could not be read, so nothing shows as installed from a marketplace: ${firstLine(error)}`);
    return { imports: {} };
  });
  const archive = await readWorkflowArchive(root).catch(() => ({ story: {}, initiative: {} }));
  const workflows = Object.fromEntries(Object.entries(definition.workTypes ?? {}).map(([id, type]) => [id, { label: type?.label ?? id, archived: workflowArchived(archive, 'story', id) }]));
  // Who drafts each step here: the agent that would fetch a generated source for it (config.mjs defaultAgent).
  const agents = definition.agentCatalog ?? Object.values(definition.agents ?? {});
  const steps = Object.fromEntries(Object.entries(definition.phases ?? {}).map(([id, phase]) => [id, { label: phase?.label ?? id,
    agent: agents.find((agent) => (agent.defaultFor ?? []).includes(id))?.id ?? null }]));
  const marketplaces = [];
  for (const marketplace of trusted) {
    const kind_ = marketplace.repository ? 'repository' : 'index';
    const base = { id: marketplace.id, label: marketplace.label ?? marketplace.id, kind: kind_, commit: marketplace.commit ?? null };
    // One marketplace named: the others are not read, and the rows of what came from them are not shown.
    if (only != null && marketplace.id !== only) { marketplaces.push({ ...base, items: [], warning: null, skipped: true }); continue; }
    try {
      const items = marketplace.repository ? repositoryItems(await trustedMarketplaceAgents(root, marketplace))
        : indexItems(await fetchMarketplaceIndex(marketplace, { fetchImpl }));
      marketplaces.push({ ...base, items, warning: null });
    } catch (error) {
      marketplaces.push({ ...base, items: [], warning: unreadableWords(marketplace, error) });
    }
  }
  return analyzeMarketplaceCatalog({ marketplaces, library: [...library.skills.values()], imports: ledger.imports ?? {}, workflows, steps, unapproved, warnings,
    only, kind, search });
}

// ---------------------------------------------------------------------------------------------- a terminal

const STATUS_WORDS = Object.freeze({ installed: 'installed', 'update-available': 'update available', 'not-installed': 'not installed',
  'local-only': 'only here', 'not-approved-yet': 'not approved yet' });
const KIND_HEADINGS = Object.freeze({ skill: 'Skills', agent: 'Agents', workflow: 'Workflows', template: 'Templates', 'mcp-server': 'MCP servers',
  generated: 'Generated sources', marketplace: 'Marketplaces not approved yet' });
const KIND_NOUNS = Object.freeze({ 'mcp-server': ['MCP server', 'MCP servers'], generated: ['generated source', 'generated sources'] });
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The page as a person reads it in a terminal: each item's state, and the preview to run next. No hash is printed. */
export function marketplaceCatalogLines(catalog) {
  const lines = [];
  const { summary } = catalog;
  const kinds = CATALOG_KINDS.filter((name) => summary.byKind[name]).map((name) => plural(summary.byKind[name], ...(KIND_NOUNS[name] ?? [name])));
  const states = CATALOG_STATUSES.filter((name) => summary.byStatus[name]).map((name) => `${summary.byStatus[name]} ${STATUS_WORDS[name]}`);
  const read = catalog.sources.filter((source) => source.approved && source.read).length;
  lines.push(`${plural(summary.items, 'item')} from ${plural(read, 'trusted marketplace')} and this repository${kinds.length ? `: ${listWords(kinds)}` : ''}.${states.length ? ` ${capitalized(listWords(states))}.` : ''}`);
  for (const name of KIND_ORDER) {
    const items = catalog.items.filter((item) => item.kind === name);
    if (!items.length) continue;
    lines.push(KIND_HEADINGS[name]);
    for (const item of items) {
      const where = item.marketplace ? `${item.marketplaceLabel ?? item.marketplace}${item.source === 'here' ? ' (here)' : ''}` : 'this repository';
      lines.push(`  ${item.id.padEnd(30)} ${where.padEnd(16)} ${(item.version ?? '').padEnd(12)} ${STATUS_WORDS[item.status]}`);
      if (item.status !== 'installed' || item.update) lines.push(`      ${item.statusWords}`);
      // A generated source has no text to preview: its next step is the reviewed proposal that adds it.
      const next = item.status === 'update-available' ? item.actions.preview ?? null : item.status === 'not-installed' ? item.actions.preview ?? item.actions.install ?? null
        : item.status === 'not-approved-yet' ? item.actions.approve : null;
      if (next) lines.push(`      Next: ${next.command.replace(/ --json$/u, '')}`);
    }
  }
  for (const source of catalog.sources.filter((item) => item.notApproved && item.approved)) lines.push(`Note: marketplace ${source.id}: ${source.notApproved}`);
  for (const warning of catalog.warnings) lines.push(`Note: ${warning}`);
  if (summary.items) lines.push('Each item\'s install, update and remove commands are in --json, under actions; each goes through review.');
  return lines;
}
