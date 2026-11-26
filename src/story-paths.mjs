/**
 * The one place that joins a Story's paths, and branch membership, with no lifecycle mutation imports [SSB:REQ-009].
 * It stays a leaf: node:path and util.mjs only. Pure: no file or Git read.
 *
 * Two layouts. 'story-branch' is today's: a Story's records live in the code checkout under
 * `<Stories folder>/<ID>/`. 'state-ref' (SSB-v1, from M2) keeps them on `refs/singularity/state/<ID>`, checked out
 * at `.sflow-state/`, with each step's documents in `docs/stories/<ID>/`. A Story reaches 'state-ref' only when
 * `story.storage: state-ref` chose it at its start (SSB M2); the layout is recorded in `resolution.story.storage`.
 */
import path from 'node:path';
import { SingularityFlowError } from './util.mjs';

export const DEFAULT_WORK_ITEM_ROOT = 'singularity/work-items';
export const STORY_LAYOUTS = Object.freeze(['story-branch', 'state-ref']);
/** The state checkout's folder in a Story's checkout (REQ-006; owner 2026-11-26, spec §11.2 item 4). */
export const STATE_CHECKOUT = '.sflow-state';
/** Where a state-ref Story's step documents live in the code base (REQ-001; owner 2026-11-26). */
export const STORY_DOCUMENTS = 'docs/stories';
export const STATE_REF_PREFIX = 'refs/singularity/state/';
/** The repository's configuration pin, beside the Stories folder (story-branch). */
export const CONFIGURATION_SOURCE_RELATIVE = 'singularity/configuration-source.json';
/** Where a state-ref Story's pinned configuration copy lives in its state, at its usual paths (REQ-003). */
export const STATE_CONFIGURATION = 'configuration';

const isWorkflow = (source) => source.workItem !== undefined || source.resolution !== undefined;

/**
 * The Stories folder: the first source, in the caller's order, that names one; else the default.
 * A workflow (it has `workItem` or `resolution`) gives its pinned `resolution.workItemRoot`; a definition gives its
 * `workItemRoot`. Sources may be nested in arrays. The same as `a ?? b ?? 'singularity/work-items'`.
 */
export function storiesRoot(...sources) {
  for (const source of sources.flat()) {
    if (source == null) continue;
    const value = isWorkflow(source) ? source.resolution?.workItemRoot : source.workItemRoot;
    if (value != null) return value;
  }
  return DEFAULT_WORK_ITEM_ROOT;
}

/**
 * The layout a workflow records: `resolution.story.storage`, copied once at Story start [SSB:REQ-010]. Not
 * `resolution.storage`: that already holds the Story's document storage providers (SharePoint, S3 and so on).
 */
function recordedLayout(sources) {
  for (const source of sources) {
    const layout = source != null && isWorkflow(source) ? source.resolution?.story?.storage : undefined;
    if (layout != null) return layout;
  }
  return null;
}

/**
 * The layouts this process has seen on disk, by checkout and Story [SSB M2, the plan's §4 step 3]. Story start and the
 * Story listing remember a state-ref Story when they create or find its state checkout, so a call that passes only the
 * definition still resolves the Story's records where they are. A Map lookup: the resolver reads no file.
 */
const knownLayouts = new Map();
const layoutKey = (root, id) => `${root}\0${id}`;

/** Remember a Story's layout in a checkout (root), as Story start or the listing found it; null forgets it. */
export function rememberStoryLayout(root, id, layout) {
  if (layout === null) { knownLayouts.delete(layoutKey(path.resolve(root), id)); return; }
  if (!STORY_LAYOUTS.includes(layout)) throw new SingularityFlowError(`'${layout}' is not a Story storage layout.`, { code: 'STORY_LAYOUT_UNKNOWN' });
  knownLayouts.set(layoutKey(path.resolve(root), id), layout);
}

/** Forget every remembered layout: for tests, and for a process that serves another repository next. */
export function forgetStoryLayouts() { knownLayouts.clear(); }

/**
 * A remembered layout: by checkout and Story; with no checkout (a record's spelling only), by Story when every
 * checkout that remembered it agrees. null when nothing was remembered.
 */
function rememberedLayout(root, id) {
  if (!knownLayouts.size || id == null) return null;
  if (root != null) return knownLayouts.get(layoutKey(path.resolve(String(root)), id)) ?? null;
  let found = null;
  for (const [key, layout] of knownLayouts) {
    if (!key.endsWith(`\0${id}`)) continue;
    if (found !== null && found !== layout) return null;
    found = layout;
  }
  return found;
}

function chosenLayout(sources, layout, remembered = null) {
  const recorded = recordedLayout(sources);
  // A workflow's resolution is the Story's own record: one without a layout is a story-branch Story (every Story in
  // flight), whatever was seen on disk. A bare `{ workItem }` names a Story without recording anything.
  const resolved = sources.some((source) => source != null && isWorkflow(source) && source.resolution != null);
  const chosen = layout ?? recorded ?? (resolved ? null : remembered) ?? 'story-branch';
  // A layout this build does not know, or a Story read against its own record, is a newer SFlow's Story: update.
  const update = { executable: 'singularity-flow', argv: ['update'], label: 'Update SFlow, then run the command again.' };
  if (!STORY_LAYOUTS.includes(chosen)) {
    throw new SingularityFlowError(`'${chosen}' is not a Story storage layout this SFlow reads (${STORY_LAYOUTS.join(' or ')}). Nothing was changed.`, {
      code: 'STORY_LAYOUT_UNKNOWN', details: { layout: chosen, nextAction: update }
    });
  }
  if (layout != null && recorded != null && layout !== recorded) {
    throw new SingularityFlowError(`This Story keeps its state as ${recorded}; it cannot be read as ${layout}. A Story's layout never changes. Nothing was changed.`, {
      code: 'STORY_LAYOUT_CHANGED', details: { recorded, requested: layout, nextAction: update }
    });
  }
  return chosen;
}

const slash = (p, value) => value.split(p.sep).join('/');

/** One Story's paths: see `storyLocation`. Every member is computed when read, from the arguments only. */
class StoryLocation {
  constructor(root, base, id, layout, p) {
    this.root = root;
    this.storiesRoot = base;
    this.id = id;
    this.layout = layout;
    this.path = p;
  }

  get branch() { return this.layout === 'story-branch'; }

  /** The Story's state folder on disk. */
  get directory() {
    return this.branch ? this.path.join(this.root, this.storiesRoot, this.id) : this.path.join(this.root, STATE_CHECKOUT);
  }

  /** A state file on disk. */
  file(...parts) {
    return this.branch ? this.path.join(this.root, this.storiesRoot, this.id, ...parts)
      : this.path.join(this.root, STATE_CHECKOUT, ...parts);
  }

  /** How a record names that state file: repository-relative (story-branch) or state-relative (state-ref). */
  record(...parts) {
    return slash(this.path, this.branch ? this.path.join(this.storiesRoot, this.id, ...parts) : this.path.join(...parts));
  }

  /** The state file a record names, on disk, read as written. */
  fromRecord(recorded) {
    return this.branch ? this.path.join(this.root, recorded) : this.path.join(this.root, STATE_CHECKOUT, recorded);
  }

  /**
   * story-branch: '<Stories folder>/<ID>', the prefix of every record path. A state-ref Story has none: its records are
   * named relative to its state, so a join on the prefix is a place not yet moved to `record()` and `recordsRoot`. It
   * refuses there, loudly, rather than write a record into the code checkout (SSB M2; the M1 plan's §8).
   */
  get prefix() {
    if (this.branch) return slash(this.path, this.path.join(this.storiesRoot, this.id));
    throw new SingularityFlowError(`Story '${this.id}' keeps its records on its state ref, and this step does not read them there yet. Nothing was changed.`, {
      code: 'STORY_STATE_REF_PATH_UNAVAILABLE',
      details: { id: this.id, nextAction: { executable: 'singularity-flow', argv: ['update'], label: 'Update SFlow, then run the command again.' } }
    });
  }

  /** The prefix, or null for a state-ref Story: for a caller that asks which layout it has before it joins. */
  get branchPrefix() { return this.branch ? this.prefix : null; }

  /**
   * Where the Story's records are, on disk and in Git, and what every `record()` spelling is relative to: the checkout
   * (story-branch, `record()` names `<Stories folder>/<ID>/…`) or its state checkout (state-ref, `record()` names
   * paths inside it). A Git read of a record's history runs here; its HEAD is the Story branch or the state ref.
   */
  get recordsRoot() { return this.branch ? this.root : this.path.join(this.root, STATE_CHECKOUT); }

  /**
   * A recorded path relative to the Story's state: '' for the prefix itself, null when it is not this Story's.
   * A state-ref record is state-relative already, so it is returned as written.
   */
  inside(recorded) {
    if (!this.branch) return recorded;
    const prefix = this.prefix;
    if (recorded === prefix) return '';
    return typeof recorded === 'string' && recorded.startsWith(`${prefix}/`) ? recorded.slice(prefix.length + 1) : null;
  }

  /** Whether a code-checkout path lies under this Story's records (strictly below the prefix). Never for state-ref. */
  owns(candidate) { return this.branch && typeof candidate === 'string' && candidate.startsWith(`${this.prefix}/`); }

  /** A step's document: today under the Story's `artifacts/`; state-ref under `docs/stories/<ID>/`. */
  document(artifact) {
    const relative = this.branch ? this.record(artifact)
      : slash(this.path, this.path.join(STORY_DOCUMENTS, this.id, String(artifact).replace(/^artifacts\//u, '')));
    return { relative, absolute: this.path.join(this.root, relative) };
  }

  isDocument(candidate) {
    const folder = this.branch ? `${this.prefix}/artifacts/` : `${STORY_DOCUMENTS}/${this.id}/`;
    return typeof candidate === 'string' && candidate.startsWith(folder);
  }

  get workflowFile() { return this.file('workflow.json'); }

  /**
   * The Story's configuration pin. story-branch: the repository's own, `singularity/configuration-source.json`.
   * state-ref: the same file inside the pinned copy (`configuration/singularity/…`, SSB M2), so every reader of a
   * pinned copy finds it at its usual path through the configuration overlay.
   */
  get configurationSource() {
    const relative = this.branch ? CONFIGURATION_SOURCE_RELATIVE : `${STATE_CONFIGURATION}/${CONFIGURATION_SOURCE_RELATIVE}`;
    return { relative, absolute: this.branch ? this.path.join(this.root, relative) : this.path.join(this.root, STATE_CHECKOUT, relative) };
  }

  /** Where the pinned configuration's usual paths resolve. */
  get configurationRoot() { return this.branch ? this.root : this.path.join(this.root, STATE_CHECKOUT, STATE_CONFIGURATION); }

  /** The root a code-tree digest leaves out: the Stories folder's first segment. null for state-ref until M3. */
  get codeTreeExclusion() { return this.branch ? `${String(this.storiesRoot).split('/')[0]}/` : null; }

  /** A Git object to read: revision null is the caller's commit. */
  object(...parts) {
    return this.branch ? { revision: null, path: this.record(...parts) }
      : { revision: stateRefName(this.id), path: slash(this.path, this.path.join(...parts)) };
  }

  /** What stages this Story's records. */
  get commitScope() {
    return this.branch ? { cwd: this.root, pathspecs: [this.prefix] } : { cwd: this.path.join(this.root, STATE_CHECKOUT), pathspecs: ['.'] };
  }
}

/**
 * One Story's paths. Pure: no file or Git read.
 * root: the code checkout, or null when the caller needs only the spellings a record stores.
 * sources: a definition, a workflow, or an array of them in precedence order, as storiesRoot.
 * layout: given by Story start and by tests; otherwise the workflow's `resolution.storage.layout`, else story-branch.
 * An explicit layout that contradicts the workflow's throws. `pathModule` is for tests (path.win32).
 */
export function storyLocation(root, sources, id, { layout, pathModule = path } = {}) {
  const list = [sources].flat();
  return new StoryLocation(root, storiesRoot(list), id, chosenLayout(list, layout, rememberedLayout(root, id)), pathModule);
}

/** The state ref of a Story: a hidden ref, or a branch where the ledger pins as branches. */
export function stateRefName(id, { pinTransport = 'refs' } = {}) {
  return pinTransport === 'branches' ? `refs/heads/sflow/state/${id}` : `${STATE_REF_PREFIX}${id}`;
}

/**
 * Where a fetch of a Story's state ref from `remote` lands [SSB:REQ-007; probe 1]: a tracking ref of its own, so a
 * fetch never overwrites local state commits that are not published yet.
 */
export function stateTrackingRefName(remote, id) { return `refs/singularity/remotes/${remote}/state/${id}`; }

/** The folder of every story-branch Story in a checkout. */
export function storiesDirectory(root, ...sources) { return path.join(root, storiesRoot(sources)); }

/** A story-branch record path's Story and the path inside it, or null when it names no Story's record. */
export function storyRecordOf(recorded, ...sources) {
  const base = storiesRoot(sources);
  if (typeof recorded !== 'string' || !recorded.startsWith(`${base}/`)) return null;
  const rest = recorded.slice(base.length + 1);
  const slashAt = rest.indexOf('/');
  const id = slashAt < 0 ? rest : rest.slice(0, slashAt);
  return id ? { id, inside: slashAt < 0 ? '' : rest.slice(slashAt + 1) } : null;
}

/** As storyRecordOf, for a path whose Stories folder may sit below another folder: the first at the start or after a '/'. */
export function storyRecordWithin(recorded, ...sources) {
  if (typeof recorded !== 'string') return null;
  const base = storiesRoot(sources);
  if (recorded.startsWith(`${base}/`)) return storyRecordOf(recorded, ...sources);
  const at = recorded.indexOf(`/${base}/`);
  return at < 0 ? null : storyRecordOf(recorded.slice(at + 1), ...sources);
}

/** The Story a story-branch record path belongs to, or null. */
export function storyIdOfRecord(recorded, ...sources) { return storyRecordOf(recorded, ...sources)?.id ?? null; }

/** Whether a path is any Story's record (story-branch). */
export function isStoryRecordPath(recorded, ...sources) { return storyRecordOf(recorded, ...sources) !== null; }

// The old spellings, kept for the test files that import them. No src module calls them after M1
// (test/story-paths-ratchet.test.mjs).
export function workDir(root, config, id) { return storyLocation(root, config, id).directory; }

export function workDirRelative(config, id) { return storyLocation(null, config, id).prefix; }

export function workflowPath(root, config, id) { return storyLocation(root, config, id).workflowFile; }

export function workflowBranchNames(workflow) {
  return [...new Set([
    workflow.workItem.branch,
    workflow.lineage?.canonicalBranch,
    ...(workflow.lineage?.childBranches ?? []).map((entry) => entry.name)
  ].filter(Boolean))];
}

export function workflowBranchAllowed(workflow, branchName) {
  return workflowBranchNames(workflow).includes(branchName);
}
