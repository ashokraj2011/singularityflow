/**
 * Needs you: everything waiting on this person across the active workspace's repositories [FPL:REQ-008 to REQ-018].
 *
 * One read for every surface: `needs-you --json` (VS Code's Needs-you tab and its badge), `/sf-inbox` in Copilot CLI
 * and IntelliJ, and the terminal. It finds Stories as `inbox` does (the Story list's state index, then each in-progress
 * Story's workflow.json at its exact commit), never checks a branch out, and judges each repository with the identity
 * SFlow records with there. Decision, next-version and intake items need the Story's checkout, so they are read for the
 * Stories checked out on this computer (the Story index); a Story without one shows them when its card opens.
 *
 * What it read is kept per repository and identity (needs-you-cache.mjs): a Story whose commit did not move costs no
 * read, `--offline` paints from what is kept and fetches nothing, and a repository that cannot be read keeps its last
 * items with one line saying so; the others are never hidden by it.
 *
 * It records nothing. Every choice goes through today's command for its kind, with its own checks.
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { identitySection, identityKey, keptDirectory, keptFile, readKept, sectionItems, writeKept } from './needs-you-cache.mjs';
import { itemCounts, LIST_LIMIT, NEEDS_YOU_CARD_RESULT, NEEDS_YOU_RESULT, orderItems, timeWords } from './needs-you-list.mjs';
import { mapLimit, SingularityFlowError } from './util.mjs';

/** Repositories are read three at a time, as VS Code reads them for the Stories page [FPL:REQ-017]. */
export const READ_CONCURRENCY = 3;
const TERMINAL = new Set(['closed', 'cancelled']);

const sameFolder = async (left, right) => {
  if (!left || !right) return false;
  const [a, b] = await Promise.all([realpath(left).catch(() => path.resolve(left)), realpath(right).catch(() => path.resolve(right))]);
  return a === b;
};

/** The window's repository: the Git root above `cwd`, or null. */
async function windowRoot(cwd) {
  try { return (await import('./git.mjs')).repoRoot(cwd); } catch { return null; }
}

/**
 * Which repositories are read [FPL:REQ-010]: every member of the active workspace (cloned or not), or the window's
 * repository when no workspace is active. Other workspaces are counted, never read (owner, 2026-11-26).
 */
export async function needsYouScope({ env = process.env, cwd = process.cwd() } = {}) {
  const [{ activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile }, manifest] = await Promise.all([
    import('./workspace-context.mjs'), import('./workspace-manifest.mjs')]);
  const registry = workspaceRegistryFile(env);
  const here = await windowRoot(cwd);
  const selected = await readActiveWorkspaceContext(activeWorkspaceFile(env), registry, { refresh: false }).catch(() => null);
  let workspace = null;
  if (selected?.workspacePath) workspace = await manifest.readWorkspace(selected.workspacePath).catch(() => null);
  const known = await manifest.readWorkspaceRegistry(registry).catch(() => []);
  const otherWorkspaces = known.filter((entry) => !entry.archivedAt && entry.id !== workspace?.id).length;
  if (!workspace) {
    if (!here) return { workspace: null, members: [], here: null, otherWorkspaces };
    const name = path.basename(here);
    return { workspace: null, here, otherWorkspaces,
      members: [{ id: name, name, url: null, root: here, cloned: true, lead: true }] };
  }
  const configurationUrl = workspace.capabilityAuthority?.url ?? workspace.repositories?.[workspace.leadRepository]?.url ?? null;
  const members = Object.values(workspace.repositories ?? {}).map((repository) => {
    const root = manifest.workspaceRepositoryPath(workspace, repository);
    const cloned = existsSync(path.join(root, '.git'));
    return { id: repository.id, name: repository.label ?? repository.name ?? repository.id, url: repository.url ?? null,
      root: cloned ? root : null, cloned, lead: repository.id === workspace.leadRepository };
  }).sort((left, right) => Number(right.lead) - Number(left.lead) || left.id.localeCompare(right.id));
  return { workspace: { id: workspace.id, name: workspace.name ?? workspace.id, path: workspace.path,
    configurationUrl, capabilityAuthority: workspace.capabilityAuthority?.url ?? null }, members, here, otherWorkspaces };
}

/** The identity this repository records with: its Git email and the cached GitHub login, never dialling out [FPL:REQ-009]. */
async function memberIdentity(root, env) {
  const { identity } = await import('./git.mjs');
  try { return identity(root ?? process.cwd(), { offline: true, env }); } catch { return { name: null, email: null, login: null }; }
}

function repositoryRef(member) {
  return { id: member.id, name: member.name };
}

/** Why a repository could not be read, in a few words for its one line. */
function failureWords(error) {
  const code = String(error?.code ?? '');
  if (/OFFLINE|NETWORK|REMOTE|FETCH|REFRESH|TIMEOUT|UNREACHABLE|TRANSPORT/u.test(code)) return 'offline';
  if (/NOT_GOVERNED|NOT_INITIALIZED|NO_CONFIG|CONFIGURATION_UNAVAILABLE|STATE_INDEX/u.test(code)) return 'no SFlow Story list yet';
  return 'it could not be read';
}

/**
 * The Stories of one repository and the record items they hold for this person: step approvals and workflow decisions.
 * Stories whose commit did not move since the kept read reuse their kept items; closed or cancelled Stories cost nothing.
 */
async function storyRecords(member, scope, { actor, previous, env }) {
  const [{ discoverRemoteStoryCandidates }, items] = await Promise.all([import('./session-story-discovery.mjs'), import('./needs-you-items.mjs')]);
  let roster;
  let definition = null;
  if (member.root) {
    const [{ sessionRepositoryAuthority }, { sessionDiscoveryConfiguration }, { withApprovedConfigurationRead }] = await Promise.all([
      import('./commands/shared/session-repository-authority.mjs'), import('./commands/shared/session-discovery-configuration.mjs'),
      import('./approved-configuration-reader.mjs')]);
    const authority = await sessionRepositoryAuthority(member.root, { remoteProbe: true });
    if (!authority) throw new SingularityFlowError(`${member.name} has no SFlow configuration yet.`, { code: 'SESSION_REPOSITORY_NOT_GOVERNED' });
    ({ definition } = await withApprovedConfigurationRead(member.root, () => sessionDiscoveryConfiguration(member.root, authority)));
    const kept = previous.stories ?? {};
    roster = await discoverRemoteStoryCandidates(member.root, definition, { fetch: true, includeState: true,
      // Unchanged since the kept read, or ended: no workflow.json is read for it.
      skip: (pointer) => kept[pointer.id]?.commit === pointer.commitOid || TERMINAL.has(pointer.story?.status) });
  } else {
    // Not cloned yet: read from its remote URL, as `inbox` and session candidates do; nothing is cloned for it.
    if (!member.url || !scope.workspace?.configurationUrl) throw new SingularityFlowError(`${member.name} has no remote to read.`, { code: 'SESSION_REPOSITORY_UNAVAILABLE' });
    const { discoverRemoteStoryCandidatesByUrl } = await import('./session-remote-url-discovery.mjs');
    roster = await discoverRemoteStoryCandidatesByUrl(member.url, { configurationUrl: scope.workspace.configurationUrl, includeState: true, env });
  }
  const counts = member.root ? await import('./presence/person-records.mjs').then((module) => module.presenceCountsFor) : null;
  const stories = {};
  const tally = { read: 0, kept: 0 };
  for (const row of roster.items ?? []) {
    if (row.kept) {
      tally.kept += 1;
      const earlier = previous.stories?.[row.id];
      stories[row.id] = { commit: row.commitOid, items: earlier?.commit === row.commitOid ? earlier.items ?? [] : [] };
      continue;
    }
    const workflow = row.state;
    if (!workflow) continue;
    tally.read += 1;
    const fallbackAuthorities = row.definition?.approvalAuthorities ?? definition?.approvalAuthorities ?? null;
    let presence = null;
    if (counts && workflow.resolution?.presence) presence = await counts(member.root, workflow).catch(() => null);
    const found = [
      items.stepApprovalItem(workflow, { repository: repositoryRef(member), actor, fallbackAuthorities, counts: presence }),
      items.workflowDecisionItem(workflow, { repository: repositoryRef(member), actor, fallbackAuthorities })
    ].filter(Boolean);
    stories[row.id] = { commit: row.commitOid, items: found };
  }
  return { stories, tally, stateCommit: roster.ledgerCommit ?? roster.stateRef ?? null, unavailable: roster.unavailableCount ?? 0 };
}

/** The configuration proposals this person may approve, read once per configuration authority [FPL:REQ-008, Review]. */
async function reviewRecords(member, { actor }) {
  const [{ listWorkflowConfigurationProposals }, { reviewItem }] = await Promise.all([import('./configuration-proposal.mjs'), import('./needs-you-items.mjs')]);
  const proposals = await listWorkflowConfigurationProposals(member.root, { includeMerged: false, includeDiff: false });
  return proposals.map((proposal) => reviewItem(proposal, { repository: repositoryRef(member), actor })).filter(Boolean);
}

/** Which members read configuration proposals: one per configuration authority, cloned, the lead first. */
function reviewReaders(scope) {
  const readers = new Map();
  for (const member of scope.members.filter((entry) => entry.root)) {
    const authority = scope.workspace?.capabilityAuthority ?? member.url ?? member.root;
    if (!readers.has(authority)) readers.set(authority, member.id);
  }
  return new Set(readers.values());
}

/**
 * The items only a Story's checkout on this computer can say: decisions, a step's next version and a task's intake
 * answers, read with `readPendingList(…, { offline: true })` and no probes [FPL:REQ-010].
 */
async function checkoutRecords(entries, scope, { actorFor, env }) {
  if (!entries.length) return new Map();
  const [{ loadAcceptedStoryExecution }, { readPendingList }, items, { versionOpeningOf }, clarifications] = await Promise.all([
    import('./accepted-story-execution.mjs'), import('./decision-list-reads.mjs'), import('./needs-you-items.mjs'),
    import('./commands/decisions.mjs'), import('./clarifications.mjs')]);
  const byRepository = new Map();
  for (const entry of entries) {
    const member = scope.members.find((candidate) => candidate.id === entry.repository?.id) ?? null;
    if (!member) continue;
    const actor = await actorFor(member);
    const found = [];
    try {
      const { config, workflow } = await loadAcceptedStoryExecution(entry.checkoutPath, entry.workId);
      if (!TERMINAL.has(workflow.status)) {
        const repository = repositoryRef(member);
        const packet = await readPendingList(entry.checkoutPath, config, workflow, { offline: true, reuse: false });
        const opening = await versionOpeningOf(entry.checkoutPath, workflow).catch(() => null);
        const decisions = items.decisionItems(packet, workflow, { repository, at: new Date().toISOString() })
          // The version question asks it once, here as on the Decide card.
          .filter((item) => !(opening && item.kind === 'next-version'));
        found.push(...decisions);
        const next = items.nextVersionItem(opening, workflow, { repository });
        if (next) found.push(next);
        const phase = workflow.phases?.[workflow.currentPhase] ?? null;
        // A task's intake waiting for its required answers: the clarification record of the version being written.
        if (phase && workflow.phaseOrder?.[0] === phase.id && clarifications.resolvedClarificationPolicy(config, workflow, phase).mode === 'required') {
          const verified = await clarifications.verifyClarificationRecord(entry.checkoutPath, config, workflow, phase).catch(() => null);
          const intake = verified ? items.intakeItem(workflow, { repository, actor, required: verified.mode === 'required',
            recorded: verified.recordState === 'complete' ? verified.record ?? true : null }) : null;
          if (intake) found.push(intake);
        }
      }
    } catch { /* A checkout that cannot be read now shows nothing extra; its record items still show. */ }
    for (const item of found) item.place = { checkout: entry.checkoutPath };
    byRepository.set(member.id, [...(byRepository.get(member.id) ?? []), ...found]);
  }
  return byRepository;
}

/** The Initiatives checked out in a member's clone and the approvals there that are this person's [FPL:REQ-008]. */
async function initiativeRecords(member, { actor }) {
  const { loadPortfolio } = await import('./initiative-config.mjs');
  const portfolio = await loadPortfolio(member.root, { required: false }).catch(() => null);
  if (!portfolio) return [];
  const [{ listInitiatives }, { loadInitiativeAggregate }, { evaluateInitiativePhase }, { deriveInitiativeReport }, { initiativePendingApprovals },
    { initiativeItems }, { loadDefinition }] = await Promise.all([import('./initiative-state.mjs'), import('./state-stores.mjs'),
    import('./initiative-evidence.mjs'), import('./initiative-report.mjs'), import('./initiative-approvals.mjs'), import('./needs-you-items.mjs'),
    import('./config.mjs')]);
  const definition = await loadDefinition(member.root).catch(() => null);
  const groupOf = (id) => definition?.approvalAuthorities?.[id] ?? portfolio.approvalAuthorities?.[id] ?? null;
  const found = [];
  for (const listed of await listInitiatives(member.root, portfolio).catch(() => [])) {
    if (!listed.currentPhase || ['closed', 'complete', 'completed', 'cancelled'].includes(listed.status)) continue;
    try {
      const { initiative: state } = await loadInitiativeAggregate(member.root, listed.id, portfolio);
      const phaseGate = state.currentPhase ? await evaluateInitiativePhase(member.root, portfolio, state, state.currentPhase) : null;
      const initiative = { state, phaseGate, report: await deriveInitiativeReport(member.root, listed.id), documents: [] };
      const approvals = initiativePendingApprovals(initiative, { person: actor, groupOf });
      found.push(...initiativeItems(approvals, { repository: repositoryRef(member), initiative }));
    } catch { /* An Initiative that cannot be read now shows nothing; its own page says why. */ }
  }
  return found;
}

/** Where each item runs, and the route a host without this repository open gives [FPL:REQ-014, REQ-038]. */
async function withRoutes(items, scope, entries) {
  const [{ storyCheckoutRoutes }, { safeCommandGuidance }] = await Promise.all([import('./story-index.mjs'), import('./safe-command-guidance.mjs')]);
  const routed = [];
  for (const item of items) {
    const member = scope.members.find((candidate) => candidate.id === item.repository?.id) ?? null;
    const entry = item.story?.id ? entries.find((candidate) => candidate.workId === item.story.id && candidate.repository?.id === member?.id) ?? null : null;
    const checkout = item.place?.checkout ?? entry?.checkoutPath ?? null;
    const clone = member?.root ?? null;
    const route = { checkout, clone, cloned: Boolean(member?.cloned) };
    if (item.story?.id && item.kind !== 'initiative-approval') {
      const workId = item.story.id;
      if (!checkout && clone && ['step-approval', 'workflow-decision'].includes(item.kind)) {
        route.checksOut = true;
        route.words = `${item.kind === 'step-approval' ? 'Approving' : 'Choosing'} checks out ${workId} in ${member.name}.`;
      }
      if (!clone && !checkout) route.words = `${member?.name ?? 'This repository'} is not cloned on this computer yet: opening ${workId} clones it.`;
      const commands = entry ? (await storyCheckoutRoutes(workId, entry, { sameWorkspace: true }).catch(() => null))?.commands ?? null : null;
      const open = scope.workspace ? `singularity-flow session open ${workId} --workspace ${scope.workspace.id} --repository ${member?.id}`
        : `singularity-flow session open ${workId}`;
      // The Copilot route names the Story, as storyCheckoutRoutes gives it.
      const copilot = safeCommandGuidance({ command: (commands ?? [open]).at(-1) })?.copilotCommand ?? null;
      route.elsewhere = { commands: commands ?? [open], copilotCommand: copilot ? `${copilot} ${workId}` : null };
    }
    routed.push({ ...item, route });
  }
  return routed;
}

/** One member, read fresh; on failure its kept items with one line. */
async function readMember(member, scope, { directory, refresh, entries, env, readReviews }) {
  const file = keptFile(directory, { workspaceId: scope.workspace?.id ?? null, repositoryId: member.id, url: member.url ?? member.root });
  const kept = await readKept(file);
  const actor = await memberIdentity(member.root ?? scope.members.find((entry) => entry.root)?.root ?? scope.here, env);
  const key = identityKey(actor);
  const previous = refresh ? identitySection(null, key) : identitySection(kept, key);
  const identity = { email: actor.email ?? null, login: actor.login ?? null, name: actor.name ?? null };
  const at = new Date().toISOString();
  try {
    const stories = await storyRecords(member, scope, { actor, previous, env });
    // Reviews and Initiatives belong to a clone; a failure there costs only its own items.
    const reviews = member.root && readReviews ? await reviewRecords(member, { actor }).catch(() => previous.reviews?.items ?? []) : [];
    const initiatives = member.root ? await initiativeRecords(member, { actor }).catch(() => []) : [];
    const section = { identity, at, stateCommit: stories.stateCommit, stories: stories.stories,
      reviews: { at, items: reviews }, initiatives: { at, items: initiatives }, local: previous.local ?? null };
    const record = { repository: { id: member.id, name: member.name, url: member.url ?? null }, workspaceId: scope.workspace?.id ?? null,
      lastIdentity: key, byIdentity: { ...(kept?.byIdentity ?? {}), [key]: section }, failure: null };
    return { member, file, record, section, read: 'fresh', at, identity, unavailable: stories.unavailable, stories: stories.tally };
  } catch (error) {
    const section = previous;
    const record = kept ? { ...kept, failure: { at, why: failureWords(error), code: error?.code ?? null } } : null;
    return { member, file, record, section, read: section.at ? 'kept' : 'failed', at: section.at ?? null, identity,
      why: failureWords(error), code: error?.code ?? null };
  }
}

/** The repository line every surface shows when one could not be read [FPL:REQ-016]; none for a good read. */
function repositoryLine(entry, now) {
  if (entry.read === 'fresh' || (entry.read === 'kept' && !entry.why)) return null;
  if (entry.why === 'not read yet') return `${entry.name} has not been read yet.`;
  return entry.at ? `${entry.name} could not be read (${entry.why}); showing ${timeWords(entry.at, now)}.`
    : `${entry.name} could not be read (${entry.why}).`;
}

function resultOf(scope, repositories, items, { now, offline }) {
  const ordered = orderItems(items);
  const counts = itemCounts(ordered);
  const read = repositories.filter((entry) => entry.read !== 'failed');
  const checked = read.map((entry) => entry.at).filter(Boolean).sort().at(-1) ?? null;
  const lines = repositories.map((entry) => repositoryLine(entry, now)).filter(Boolean);
  if (scope.otherWorkspaces) lines.push(`${scope.otherWorkspaces === 1 ? '1 other workspace' : `${scope.otherWorkspaces} other workspaces`} on this computer ${scope.otherWorkspaces === 1 ? 'was' : 'were'} not read.`);
  return {
    schemaVersion: 1, resultType: NEEDS_YOU_RESULT, generatedAt: now.toISOString(), offline,
    workspace: scope.workspace ? { id: scope.workspace.id, name: scope.workspace.name } : null,
    scope: { repositories: repositories.map(({ id, name, read: state, at, why, identity, here, stories }) => ({ id, name, read: state, at,
      ...(why ? { why } : {}), identity, ...(here ? { here: true } : {}), ...(stories ? { stories } : {}) })), otherWorkspaces: scope.otherWorkspaces },
    checked: checked ? { at: checked, words: `Checked ${timeWords(checked, now)} · ${repositories.length === 1 ? '1 repository' : `${repositories.length} repositories`}` } : null,
    counts, items: ordered, shown: Math.min(ordered.length, LIST_LIMIT), more: Math.max(0, ordered.length - LIST_LIMIT), lines,
    otherWorkspaces: scope.otherWorkspaces
  };
}

/**
 * Whether each item is in the window's repository (or its Story's checkout is the window): read for every paint, kept ones
 * too, since another window reads the same kept list. Each folder is resolved once.
 */
async function markHere(items, scope) {
  const resolved = new Map();
  const real = (folder) => {
    if (!folder) return Promise.resolve(null);
    if (!resolved.has(folder)) resolved.set(folder, realpath(folder).catch(() => path.resolve(folder)));
    return resolved.get(folder);
  };
  const here = await real(scope.here);
  const marked = [];
  for (const item of items) {
    const { here: _stale, ...route } = item.route ?? {};
    const inWindow = Boolean(here) && (await real(route.checkout) === here || await real(route.clone) === here);
    marked.push(item.route ? { ...item, route: { ...route, ...(inWindow ? { here: true } : {}) } } : item);
  }
  return marked;
}

/**
 * The Needs-you read [FPL:REQ-008 to REQ-018]. `offline` paints from what is kept and starts no Git process; `refresh`
 * reads every Story's workflow.json again. Returns `sflow-needs-you`.
 */
export async function needsYou({ offline = false, refresh = false, env = process.env, cwd = process.cwd(), now = new Date(),
  concurrency = READ_CONCURRENCY } = {}) {
  const scope = await needsYouScope({ env, cwd });
  const directory = keptDirectory(env);
  if (offline) return paintKept(scope, directory, { now });
  let entries = [];
  try {
    const { listStoryIndex } = await import('./story-index.mjs');
    entries = (await listStoryIndex({ env })).entries.filter((entry) => entry.availability === 'ready' && entry.role !== 'secondary'
      && (scope.workspace ? entry.workspace?.id === scope.workspace.id : true) && !TERMINAL.has(entry.storyStatus));
  } catch { entries = []; }
  if (!scope.workspace && scope.here) {
    const { gitCommonDir } = await import('./git.mjs');
    let common = null;
    try { common = await realpath(gitCommonDir(scope.here)); } catch { common = null; }
    const filtered = [];
    for (const entry of entries) if (common && await sameFolder(entry.commonDir, common)) filtered.push({ ...entry, repository: { id: scope.members[0].id } });
    entries = filtered;
  }
  const readers = reviewReaders(scope);
  const read = await mapLimit(scope.members, concurrency, (member) => readMember(member, scope,
    { directory, refresh, entries, env, readReviews: readers.has(member.id) }));
  const identities = new Map(read.map((entry) => [entry.member.id, entry.identity]));
  const local = await checkoutRecords(entries, scope, { env,
    actorFor: async (member) => identities.get(member.id) ?? memberIdentity(member.root, env) });
  const items = [];
  const repositories = [];
  for (const entry of read) {
    const section = entry.section ?? {};
    const own = entry.read === 'fresh' ? local.get(entry.member.id) ?? [] : section.local?.items ?? [];
    if (entry.read === 'fresh' && entry.record) {
      entry.record.byIdentity[entry.record.lastIdentity].local = { at: entry.at, items: own };
    }
    const kept = entry.read === 'fresh' ? sectionItems({ ...section, local: { items: own } }) : sectionItems(section);
    items.push(...kept);
    repositories.push({ id: entry.member.id, name: entry.member.name, read: entry.read, at: entry.at, why: entry.why ?? null,
      identity: entry.identity, here: await sameFolder(entry.member.root, scope.here), ...(entry.stories ? { stories: entry.stories } : {}) });
  }
  const routed = await markHere(await withRoutes(items, scope, entries), scope);
  // Kept with their routes, so the offline paint shows the same rows.
  const byKey = new Map(routed.map((item) => [item.key, item]));
  for (const entry of read) {
    if (!entry.record) continue;
    const section = entry.record.byIdentity[entry.record.lastIdentity];
    if (section && entry.read === 'fresh') {
      for (const story of Object.values(section.stories ?? {})) story.items = (story.items ?? []).map((item) => byKey.get(item.key) ?? item);
      for (const name of ['reviews', 'initiatives', 'local']) if (section[name]?.items) section[name].items = section[name].items.map((item) => byKey.get(item.key) ?? item);
    }
    await writeKept(entry.file, entry.record);
  }
  return resultOf(scope, repositories, routed, { now, offline: false });
}

/** The list from what is kept, with no Git and no network [FPL:REQ-016 `--offline`, REQ-017 budget]. */
async function paintKept(scope, directory, { now }) {
  const repositories = [];
  const items = [];
  const records = await Promise.all(scope.members.map((member) => readKept(keptFile(directory,
    { workspaceId: scope.workspace?.id ?? null, repositoryId: member.id, url: member.url ?? member.root }))));
  scope.members.forEach((member, index) => {
    const record = records[index];
    const section = record ? identitySection(record, record.lastIdentity) : null;
    const at = section?.at ?? null;
    repositories.push({ id: member.id, name: member.name, read: at ? 'kept' : 'failed', at,
      why: at ? record.failure?.why ?? null : 'not read yet', identity: section?.identity ?? null, here: member.root ? member.root === scope.here : false });
    if (section) items.push(...sectionItems(section));
  });
  return resultOf(scope, repositories, await markHere(items, scope), { now, offline: true });
}

/** One item of the list by its key: what is kept first, then a fresh read. */
async function findItem(key, options) {
  const kept = await needsYou({ ...options, offline: true });
  const item = kept.items.find((entry) => entry.key === key);
  if (item || options.offline) return { item: item ?? null, list: kept };
  const fresh = await needsYou({ ...options, offline: false });
  return { item: fresh.items.find((entry) => entry.key === key) ?? null, list: fresh };
}

/**
 * One card's full content [FPL:REQ-013], read in the Story's place on this computer [FPL:REQ-014]: its checkout when it
 * has one, else what its record says, with what acting on it does first ("Approving checks out TASK-11 in shop-api.").
 * Returns `sflow-needs-you-card`; changes nothing.
 */
export async function needsYouCard(key, options = {}) {
  const { item, list } = await findItem(key, options);
  if (!item) {
    throw new SingularityFlowError('That item no longer waits on you: it was decided, or it changed. See what waits on you now.', {
      code: 'NEEDS_YOU_ITEM_GONE', details: { key, nextAction: { command: 'singularity-flow needs-you', label: 'See what waits on you now' } } });
  }
  const card = await cardContent(item);
  // Decisions found when the approval's card opens are cards of their own, before the approval they hold.
  const before = (card.before ?? []).map((entry) => ({ key: entry.key, question: entry.question }));
  const index = list.items.findIndex((entry) => entry.key === key);
  const next = list.items.slice(index + 1).find((entry) => entry.key !== key) ?? null;
  return {
    schemaVersion: 1, resultType: NEEDS_YOU_CARD_RESULT, key, item: { ...item, ...(card.recommended !== undefined ? { recommended: card.recommended } : {}) },
    card: { ...card, before }, next: next ? { key: next.key, question: next.question } : null
  };
}

/** What the card says, in REQ-013's order, from the place its Story is on this computer. */
async function cardContent(item) {
  const asked = `${item.question} ${item.story ? `${item.story.title ?? item.story.id} (${item.story.id}${item.story.kind ? `, ${item.story.kind}` : ''})` : ''}${item.repository ? ` in ${item.repository.name}` : ''}.`.replace(/\s+\./u, '.');
  const base = { question: item.question, asked, why: item.why, about: { lines: [] }, checked: [...(item.checked ?? [])],
    recommendation: item.recommended ? { choice: item.recommended.choice, words: item.recommended.words } : { choice: null, words: item.recommendation },
    choices: item.choices ?? [], place: placeOf(item), ...(item.couldNotTell ? { couldNotTell: true } : {}) };
  if (item.kind === 'step-approval' && item.route?.checkout) return approvalCard(item, base).catch(() => base);
  if (item.kind === 'review' && item.route?.clone) return reviewCard(item, base).catch(() => base);
  if (item.kind === 'step-approval') {
    return { ...base, about: { lines: [`SFlow reads ${item.step?.label ?? 'the step'}'s documents and runs its checks when it checks the Story out on this computer.`] },
      checked: ['Not run yet on this computer: SFlow runs the approval\'s checks when it checks the Story out.'] };
  }
  return base;
}

function placeOf(item) {
  const route = item.route ?? {};
  return { checkout: route.checkout ?? null, clone: route.clone ?? null, here: route.here === true,
    ...(route.checksOut ? { checksOut: true } : {}), ...(route.words ? { words: route.words } : {}) };
}

/**
 * A step approval whose Story is checked out here: the approval focus ("What needs your eyes"), what SFlow checked, the
 * decision list's approval item for the recommendation, and the decisions that hold it [FPL:REQ-013, REQ-014].
 */
async function approvalCard(item, base) {
  const root = item.route.checkout;
  const [{ loadAcceptedStoryExecution }, { readPendingList }, { phaseReview }, items] = await Promise.all([
    import('./accepted-story-execution.mjs'), import('./decision-list-reads.mjs'), import('./commands/shared/phase-review.mjs'),
    import('./needs-you-items.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, item.story.id);
  const phase = workflow.phases?.[item.step.id];
  const [review, packet] = await Promise.all([
    phaseReview(root, config, workflow, phase, { includeFocus: true, includeApprovalCheck: false }).catch(() => null),
    readPendingList(root, config, workflow, { offline: true, reuse: false }).catch(() => null)]);
  const focus = review?.approvalFocus ?? null;
  const lines = [
    ...(focus?.eyes?.items ?? []).map((entry) => entry.words).filter(Boolean),
    ...(focus?.eyes?.none ? [focus.eyes.none] : [])
  ];
  const approval = (packet?.items ?? []).find((entry) => entry.kind === 'approval') ?? null;
  const recommendedOption = approval?.options?.find((option) => option.recommended) ?? null;
  const held = approval?.details?.ready === false;
  const before = packet ? items.decisionItems(packet, workflow, { repository: item.repository }).filter((entry) => entry.group === 'holds-work') : [];
  const checked = [...(focus?.eyes?.checked ? [focus.eyes.checked] : []), ...(phase?.checks ?? []).filter((check) => check?.label && check?.status)
    .map((check) => `${check.label}: ${check.status}`)].slice(0, 12);
  return {
    ...base,
    about: { title: focus?.eyes?.title ?? 'What needs your eyes', lines, documents: (focus?.documents ?? []).map((document) => ({ label: document.label, path: document.path, line: document.line ?? null })),
      words: focus?.words?.line ?? null },
    checked: checked.length ? checked : ['SFlow found no recorded checks for this version.'],
    recommended: !held && recommendedOption ? { choice: 'approve', words: 'SFlow recommends: approve. Nothing on this list holds it, and its checks are recorded.' } : null,
    recommendation: held ? { choice: null, words: `SFlow does not recommend it yet: ${before[0]?.question ?? 'a decision on its list'} holds it.`, heldBy: before.map((entry) => entry.key) }
      : recommendedOption ? { choice: 'approve', words: 'SFlow recommends: approve. Nothing on this list holds it, and its checks are recorded.' }
        : base.recommendation,
    choices: held ? base.choices.filter((choice) => choice.id !== 'approve') : base.choices,
    read: (focus?.documents ?? [])[0]?.path ? { path: focus.documents[0].path } : null,
    before
  };
}

/** A configuration proposal's card: what approving it lands, line by line, as Workflow Studio's Changes view shows it. */
async function reviewCard(item, base) {
  const { inspectWorkflowConfigurationProposal } = await import('./configuration-proposal.mjs');
  const { proposalViewLines } = await import('./configuration-approval-view.mjs');
  const reviewed = await inspectWorkflowConfigurationProposal(item.route.clone, item.proposal.branch);
  const lines = proposalViewLines(reviewed).slice(0, 60);
  const command = reviewed.activation?.command ?? null;
  return { ...base, about: { title: 'What approving it changes', lines },
    choices: base.choices.map((choice) => (choice.id === 'approve' && command ? { ...choice, command } : choice)) };
}
