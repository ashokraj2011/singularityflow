/**
 * Work: this person's Stories in flight and those done this week, across the active workspace [FPL:REQ-005, REQ-007].
 *
 * One read for every surface: `work list --json` (VS Code's Work tab), `/sf-task` with no words in Copilot CLI and
 * IntelliJ, and the terminal. "This person's" means they started the Story (its record's creator is the identity SFlow
 * records with in that repository), or it has a checkout on this computer (the Story index). Stories are found as Needs you
 * finds them (needs-you.mjs memberRoster: the Story list's state index, then each Story's workflow.json at its exact
 * commit), never by checking a branch out; a Story checked out here is read from its checkout, as `work status` reads it.
 *
 * What a read found is kept per repository and identity, beside Needs you's (needs-you-cache.mjs): a Story whose commit did
 * not move costs no read, `--offline` paints from what is kept with no Git, and a repository that cannot be read keeps its
 * last rows with one line. The status line says "Waiting for you: …" when an item in Needs you belongs to the Story, read
 * from what Needs you kept. It records nothing.
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { identitySection, identityKey, keptDirectory, keptFile, readKept, writeKept } from './needs-you-cache.mjs';
import { timeWords } from './needs-you-list.mjs';
import { DONE_WINDOW_MS, orderRows, WORK_LIST_RESULT, withWaiting, workRow } from './work-rows.mjs';
import { mapLimit } from './util.mjs';

/** Repositories are read three at a time, as Needs you reads them [FPL:REQ-017]. */
const READ_CONCURRENCY = 3;

/** Beside Needs you's kept reads, wherever SINGULARITY_FLOW_WORKSPACE_REGISTRY puts them. */
export function workKeptDirectory(env = process.env) {
  return path.join(path.dirname(keptDirectory(env)), 'work');
}

const real = (folder) => (folder ? realpath(folder).catch(() => path.resolve(folder)) : Promise.resolve(null));

/** The folder that holds a Story's folders, from its record's path (`<folder>/<ID>/workflow.json`). */
const folderOf = (relative) => path.posix.dirname(path.posix.dirname(String(relative ?? '').replace(/\\/gu, '/')));

/** Whether `actor` started the Story: its record's creator is the identity SFlow records with in its repository. */
async function startedBy(workflow, actor) {
  const creator = workflow?.workItem?.createdBy;
  if (!creator || typeof creator !== 'object' || !actor) return false;
  const { sameApprover } = await import('./approval-authority.mjs');
  return sameApprover(creator, actor);
}

/** A Story is listed while in flight, or when it ended in the last seven days; a cancelled one is not. */
function listable(workflow, now) {
  if (workflow?.status === 'in_progress') return true;
  if (workflow?.status !== 'closed') return false;
  const ended = Date.parse(workflow.history?.at(-1)?.at ?? workflow.workItem?.createdAt ?? '');
  return Number.isFinite(ended) && now.getTime() - ended <= DONE_WINDOW_MS;
}

/** The Stories checked out on this computer for this workspace (or the window's repository), from the Story index. */
async function checkoutEntries(scope, env) {
  let entries = [];
  try {
    const { listStoryIndex } = await import('./story-index.mjs');
    entries = (await listStoryIndex({ env })).entries.filter((entry) => entry.availability === 'ready' && entry.role !== 'secondary'
      && (scope.workspace ? entry.workspace?.id === scope.workspace.id : true));
  } catch { return []; }
  if (scope.workspace || !scope.here) return entries;
  const { gitCommonDir } = await import('./git.mjs');
  let common = null;
  try { common = await realpath(gitCommonDir(scope.here)); } catch { return []; }
  const kept = [];
  for (const entry of entries) if (await real(entry.commonDir) === common) kept.push({ ...entry, repository: { id: scope.members[0].id } });
  return kept;
}

/** A Story checked out here, read from its checkout as `work status` reads it; null when it cannot be read. */
async function checkoutRow(entry, member, { actor, now }) {
  try {
    const workflow = JSON.parse(await readFile(path.join(entry.checkoutPath, entry.workflowPath), 'utf8'));
    if (workflow?.workItem?.id !== entry.workId || !listable(workflow, now)) return null;
    return workRow(workflow, { repository: member, folder: folderOf(entry.workflowPath), now,
      mine: await startedBy(workflow, actor) ? 'started' : 'checkout', place: { checkout: entry.checkoutPath, clone: member.root ?? null } });
  } catch { return null; }
}

/** One member, read fresh; on failure its kept rows with one line. */
async function readMember(member, scope, { directory, entries, env, now }) {
  const { failureWords, memberIdentity, memberRoster } = await import('./needs-you.mjs');
  const file = keptFile(directory, { workspaceId: scope.workspace?.id ?? null, repositoryId: member.id, url: member.url ?? member.root });
  const kept = await readKept(file);
  const actor = await memberIdentity(member.root ?? scope.members.find((entry) => entry.root)?.root ?? scope.here, env);
  const key = identityKey(actor);
  const previous = identitySection(kept, key);
  const identity = { email: actor.email ?? null, login: actor.login ?? null, name: actor.name ?? null };
  const at = now.toISOString();
  const local = [];
  for (const entry of entries.filter((candidate) => candidate.repository?.id === member.id)) {
    const row = await checkoutRow(entry, member, { actor, now });
    if (row) local.push(row);
  }
  try {
    const keptStories = previous.stories ?? {};
    const since = now.getTime() - DONE_WINDOW_MS;
    // Unchanged since the kept read, cancelled, or ended before this week: no workflow.json is read for it.
    const { roster } = await memberRoster(member, scope, { env, skip: (pointer) => keptStories[pointer.id]?.commit === pointer.commitOid
      || pointer.story?.status === 'cancelled' || (pointer.story?.status === 'closed' && Date.parse(pointer.story?.updatedAt ?? '') < since) });
    const stories = {};
    const tally = { read: 0, kept: 0 };
    for (const found of roster.items ?? []) {
      if (found.kept) {
        tally.kept += 1;
        const earlier = keptStories[found.id];
        if (earlier?.commit === found.commitOid) stories[found.id] = earlier;
        continue;
      }
      const workflow = found.state;
      if (!workflow) continue;
      tally.read += 1;
      const mine = listable(workflow, now) && await startedBy(workflow, actor);
      stories[found.id] = { commit: found.commitOid, row: mine ? workRow(workflow, { repository: member, folder: folderOf(found.path), now, mine: 'started',
        place: { checkout: null, clone: member.root ?? null } }) : null };
    }
    const section = { identity, at, stories, local: { at, rows: local } };
    const record = { repository: { id: member.id, name: member.name, url: member.url ?? null }, workspaceId: scope.workspace?.id ?? null,
      lastIdentity: key, byIdentity: { ...(kept?.byIdentity ?? {}), [key]: section }, failure: null };
    await writeKept(file, record);
    return { member, section, read: 'fresh', at, identity, stories: tally };
  } catch (error) {
    // Its checkouts here are still read: they are files on this computer.
    const section = { ...previous, local: { at, rows: local } };
    if (kept) await writeKept(file, { ...kept, byIdentity: { ...kept.byIdentity, [key]: section }, failure: { at, why: failureWords(error), code: error?.code ?? null } });
    return { member, section, read: previous.at ? 'kept' : 'failed', at: previous.at ?? null, identity, why: failureWords(error) };
  }
}

/** Every row a kept section holds: a Story checked out here is its checkout's row, else its record's. */
function sectionRows(section) {
  const rows = new Map();
  for (const entry of Object.values(section?.stories ?? {})) if (entry?.row?.id) rows.set(entry.row.id, entry.row);
  for (const row of section?.local?.rows ?? []) {
    if (!row?.id) continue;
    const remote = rows.get(row.id);
    rows.set(row.id, remote?.mine === 'started' && row.mine === 'checkout' ? { ...row, mine: 'started' } : row);
  }
  return [...rows.values()];
}

/** Where each row is on this computer, and the route to it from another window [FPL:REQ-006, REQ-038]. */
async function withRoutes(rows, scope, entries) {
  const here = await real(scope.here);
  const { storyCheckoutRoutes } = await import('./story-index.mjs');
  const routed = [];
  for (const row of rows) {
    const checkout = row.place?.checkout ?? null;
    const inWindow = Boolean(here && checkout) && await real(checkout) === here;
    const route = { checkout, clone: row.place?.clone ?? null, ...(inWindow ? { here: true } : {}) };
    if (!inWindow) {
      const entry = entries.find((candidate) => candidate.workId === row.id && candidate.repository?.id === row.repository.id) ?? null;
      const commands = entry ? (await storyCheckoutRoutes(row.id, entry, { sameWorkspace: true }).catch(() => null))?.commands ?? null : null;
      const open = scope.workspace ? `singularity-flow session open ${row.id} --workspace ${scope.workspace.id} --repository ${row.repository.id}`
        : `singularity-flow session open ${row.id}`;
      route.elsewhere = { commands: commands ?? [open] };
    }
    const { place: _place, ...rest } = row;
    routed.push({ ...rest, route });
  }
  return routed;
}

/** The repository line every surface shows when one could not be read [FPL:REQ-016]. */
function repositoryLine(entry, now) {
  if (entry.read === 'fresh' || !entry.why) return null;
  if (entry.why === 'not read yet') return `${entry.name} has not been read yet.`;
  return entry.at ? `${entry.name} could not be read (${entry.why}); showing ${timeWords(entry.at, now)}.` : `${entry.name} could not be read (${entry.why}).`;
}

/** The items Needs you kept for this person, so a Story it holds says "Waiting for you: …"; no Git, no network. */
async function waitingItems({ env, cwd, now }) {
  try {
    const { needsYou } = await import('./needs-you.mjs');
    return (await needsYou({ offline: true, env, cwd, now })).items ?? [];
  } catch { return []; }
}

async function resultOf(scope, repositories, rows, { now, offline, env, cwd, entries }) {
  const items = await waitingItems({ env, cwd, now });
  const joined = rows.map((row) => withWaiting(row, items.find((item) => item.story?.id === row.id && item.repository?.id === row.repository.id) ?? null));
  const { inProgress, doneThisWeek } = orderRows(await withRoutes(joined, scope, entries), { now });
  const read = repositories.filter((entry) => entry.read !== 'failed');
  const checked = read.map((entry) => entry.at).filter(Boolean).sort().at(-1) ?? null;
  const hereMember = await (async () => {
    const here = await real(scope.here);
    for (const member of scope.members) if (member.root && here && await real(member.root) === here) return { id: member.id, name: member.name };
    return null;
  })();
  return {
    schemaVersion: 1, resultType: WORK_LIST_RESULT, generatedAt: now.toISOString(), offline,
    workspace: scope.workspace ? { id: scope.workspace.id, name: scope.workspace.name } : null,
    here: hereMember, otherRepositories: Math.max(0, scope.members.length - (hereMember ? 1 : 0)),
    scope: { repositories: repositories.map(({ id, name, read: state, at, why, identity, stories }) => ({ id, name, read: state, at,
      ...(why ? { why } : {}), ...(identity ? { identity } : {}), ...(stories ? { stories } : {}) })) },
    checked: checked ? { at: checked, words: `Checked ${timeWords(checked, now)} · ${repositories.length === 1 ? '1 repository' : `${repositories.length} repositories`}` } : null,
    inProgress, doneThisWeek, lines: repositories.map((entry) => repositoryLine(entry, now)).filter(Boolean)
  };
}

/**
 * The Work read [FPL:REQ-005, REQ-007]. `offline` paints from what is kept and starts no Git process. Returns
 * `sflow-work-list`: this person's Stories in flight (`inProgress`) and those done this week (`doneThisWeek`).
 */
export async function workList({ offline = false, env = process.env, cwd = process.cwd(), now = new Date(), concurrency = READ_CONCURRENCY } = {}) {
  const { needsYouScope } = await import('./needs-you.mjs');
  const scope = await needsYouScope({ env, cwd });
  const directory = workKeptDirectory(env);
  if (offline) {
    const records = await Promise.all(scope.members.map((member) => readKept(keptFile(directory,
      { workspaceId: scope.workspace?.id ?? null, repositoryId: member.id, url: member.url ?? member.root }))));
    const repositories = [];
    const rows = [];
    scope.members.forEach((member, index) => {
      const record = records[index];
      const section = record ? identitySection(record, record.lastIdentity) : null;
      const at = section?.at ?? null;
      repositories.push({ id: member.id, name: member.name, read: at ? 'kept' : 'failed', at, why: at ? record.failure?.why ?? null : 'not read yet',
        identity: section?.identity ?? null });
      rows.push(...sectionRows(section).filter((row) => row.status === 'in_progress' || row.status === 'closed'));
    });
    return resultOf(scope, repositories, rows, { now, offline: true, env, cwd, entries: [] });
  }
  const entries = await checkoutEntries(scope, env);
  const read = await mapLimit(scope.members, concurrency, (member) => readMember(member, scope, { directory, entries, env, now }));
  const rows = read.flatMap((entry) => sectionRows(entry.section));
  const repositories = read.map((entry) => ({ id: entry.member.id, name: entry.member.name, read: entry.read, at: entry.at,
    why: entry.why ?? null, identity: entry.identity, ...(entry.stories ? { stories: entry.stories } : {}) }));
  return resultOf(scope, repositories, rows, { now, offline: false, env, cwd, entries });
}

/** The list in the terminal, in the Work tab's order and words. */
export function workListText(result) {
  const lines = [`Work${result.workspace ? ` · ${result.workspace.name}` : ''}${result.checked ? ` · ${result.checked.words}` : ''}`];
  const row = (entry, last) => [`  ${entry.title} · ${entry.id} · ${entry.repository.name}${entry.startedWhen ? ` · started ${entry.startedWhen}` : ''}`,
    `    ${entry.chips.map((chip) => chip.words).join(' → ')}`, `    ${last(entry)}`];
  lines.push('', 'In progress');
  if (!result.inProgress.length) lines.push('  Nothing in flight. Start one: singularity-flow work "<what you want done>" --start');
  for (const entry of result.inProgress) {
    lines.push(...row(entry, (value) => value.statusLine));
    if (entry.waiting) lines.push(`    Open its card: singularity-flow needs-you show ${entry.waiting.key}`);
    else if (!entry.route?.here && entry.route?.elsewhere?.commands?.length) lines.push(`    Go to it: ${entry.route.elsewhere.commands.join(' then ')}`);
  }
  if (result.doneThisWeek.length) {
    lines.push('', 'Done this week');
    for (const entry of result.doneThisWeek) lines.push(`  ${entry.title} · ${entry.id} · ${entry.repository.name} · ${entry.ended.where}${entry.ended.when ? `, ${entry.ended.when}` : ''}`);
  }
  if (result.lines.length) lines.push('', ...result.lines);
  return `${lines.join('\n')}\n`;
}
