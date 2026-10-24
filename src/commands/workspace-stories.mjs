/**
 * `workspace stories [WORK-ID]`: every Story checkout on this computer, across all workspaces.
 *
 * Read from the machine's Story index (story-index.mjs). Each entry is checked against its
 * checkout before it is shown; one that no longer matches Git is dropped, never shown as current.
 * With a Work ID it locates that Story and gives the commands that go to its checkout.
 */
import { readFile } from 'node:fs/promises';
import { optionBoolean, SingularityFlowError, table } from '../util.mjs';

const OPTIONS = new Set(['json', 'rebuild', 'timings']);

function projected(entry, activeWorkspaceId) {
  return {
    workId: entry.workId, title: entry.title ?? null,
    workspace: entry.workspace, activeWorkspace: entry.workspace.id === activeWorkspaceId,
    repository: { id: entry.repository.id ?? null, url: entry.repository.url ?? null },
    checkoutPath: entry.checkoutPath, branch: entry.branch,
    phase: entry.phase ?? null, phaseStatus: entry.phaseStatus ?? null, storyStatus: entry.storyStatus ?? null,
    availability: entry.availability, ...(entry.reason ? { reason: entry.reason } : {}),
    updatedAt: entry.updatedAt ?? null
  };
}

async function activeWorkspaceId() {
  const { activeWorkspaceFile } = await import('../workspace-context.mjs');
  try { return JSON.parse(await readFile(activeWorkspaceFile(), 'utf8'))?.workspaceId ?? null; } catch { return null; }
}

export async function run(positionals = [], options = {}) {
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) throw new SingularityFlowError(`workspace stories takes --rebuild and --json, not --${key}.`,
      { code: 'WORKSPACE_STORIES_OPTION_UNSUPPORTED' });
  }
  if (positionals.length > 3) throw new SingularityFlowError('workspace stories takes at most one Work ID.',
    { code: 'WORKSPACE_STORIES_OPTION_UNSUPPORTED' });
  const workId = positionals[2] ?? null;
  const index = await import('../story-index.mjs');
  const listing = await index.listStoryIndex({ rebuild: optionBoolean(options, 'rebuild') });
  const active = await activeWorkspaceId();
  const stories = listing.entries
    .filter((entry) => !workId || entry.workId === workId || entry.branch === workId || (entry.aliases ?? []).includes(workId))
    .map((entry) => projected(entry, active));
  const json = optionBoolean(options, 'json');
  const result = {
    schemaVersion: 1, resultType: 'workspace-stories', // schema-transient: command response, never stored
    indexFile: listing.file, activeWorkspaceId: active, ...(workId ? { workId, found: stories.length > 0 } : {}),
    stories, dropped: listing.dropped,
    backfill: { status: listing.backfill.status, recorded: listing.backfill.recorded, skipped: listing.backfill.skipped }
  };
  if (workId && stories.length) {
    const story = stories[0];
    result.routes = index.storyCheckoutRoutes(story.workId, story, { sameWorkspace: story.activeWorkspace });
  }
  if (json) return console.log(JSON.stringify(result, null, 2));
  for (const dropped of listing.dropped) console.log(`Dropped ${dropped.workId} at ${dropped.checkoutPath}: ${dropped.reason}.`);
  if (workId) {
    if (!stories.length) {
      console.log(`Story ${workId} has no checkout on this computer.`);
      console.log(`Open it. Copilot: /sf-session ${workId}; Shell: singularity-flow session open ${workId}; VS Code (model-free): not available for this action.`);
      return result;
    }
    for (const story of stories) {
      console.log(`${story.workId}${story.title ? ` · ${story.title}` : ''}`);
      console.log(`Workspace: ${story.workspace.name}${story.activeWorkspace ? ' (active)' : ''} · ${story.workspace.path}`);
      console.log(`Repository: ${story.repository.id ?? '—'} · ${story.repository.url ?? '—'}`);
      console.log(`Checkout: ${story.checkoutPath}${story.availability === 'ready' ? '' : ` (unavailable: ${story.reason})`}`);
      console.log(`Branch: ${story.branch} · phase: ${story.phase ?? '—'} (${story.phaseStatus ?? '—'}) · Story: ${story.storyStatus ?? '—'}`);
      console.log(`Updated: ${story.updatedAt ?? '—'}`);
    }
    if (stories.length > 1) console.log('This Story has more than one checkout. Keep the one you work in; remove the other after checking it holds nothing you need.');
    console.log(`Go there. ${result.routes.text}.`);
    return result;
  }
  if (!stories.length) {
    console.log('No Story checkouts are recorded on this computer.');
    return result;
  }
  console.log(table(stories.map((story) => ({
    workId: story.workId,
    workspace: `${story.workspace.name}${story.activeWorkspace ? ' *' : ''}`,
    repository: story.repository.id ?? '—',
    phase: [story.phase, story.phaseStatus].filter(Boolean).join(' · ') || '—',
    status: story.availability === 'ready' ? story.storyStatus ?? '—' : 'unavailable',
    branch: story.branch,
    updated: String(story.updatedAt ?? '—').slice(0, 16).replace('T', ' '),
    checkoutPath: story.checkoutPath
  })), [
    { key: 'workId', label: 'STORY' }, { key: 'workspace', label: 'WORKSPACE' }, { key: 'repository', label: 'REPOSITORY' },
    { key: 'phase', label: 'PHASE' }, { key: 'status', label: 'STATUS' }, { key: 'branch', label: 'BRANCH' },
    { key: 'updated', label: 'UPDATED' }, { key: 'checkoutPath', label: 'CHECKOUT', kind: 'path' }
  ]));
  console.log('* the active workspace. Locate one Story with: singularity-flow workspace stories <WORK-ID>');
  return result;
}
