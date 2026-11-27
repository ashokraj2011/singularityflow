/**
 * The one place that joins a Story's paths, and branch membership, with no lifecycle mutation imports [SSB:REQ-009].
 * It stays a leaf: node:path and util.mjs only. Pure: no file or Git read.
 *
 * Two layouts. 'story-branch' is today's: a Story's records live in the code checkout under
 * `<Stories folder>/<ID>/`. 'state-ref' (SSB-v1) keeps them on `refs/singularity/state/<ID>`, checked out at
 * `.sflow-state/`, with each step's documents in `docs/stories/<ID>/`; `story.storage` chooses it at Story start.
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
/** A state-ref Story's pinned configuration copy, in its state (REQ-003). */
export const STATE_CONFIGURATION = 'configuration';

const UPDATE = Object.freeze({ executable: 'singularity-flow', argv: ['update'], label: 'Update SFlow, then run the command again.' });
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

// The layout a workflow records [SSB:REQ-010] (`resolution.storage` holds document storage providers).
function recordedLayout(sources) {
  for (const source of sources) {
    const layout = source != null && isWorkflow(source) ? source.resolution?.story?.storage : undefined;
    if (layout != null) return layout;
  }
  return null;
}

// Layouts seen on disk, by checkout and Story (the M1 plan's §4 step 3): a Map, no file read.
const knownLayouts = new Map();
const layoutKey = (root, id) => `${root}\0${id}`;

/** Remember a Story's layout in a checkout; null forgets it. */
export function rememberStoryLayout(root, id, layout) {
  if (layout === null) { knownLayouts.delete(layoutKey(path.resolve(root), id)); return; }
  if (!STORY_LAYOUTS.includes(layout)) throw new SingularityFlowError(`'${layout}' is not a Story storage layout.`, { code: 'STORY_LAYOUT_UNKNOWN', details: { nextAction: UPDATE } });
  knownLayouts.set(layoutKey(path.resolve(root), id), layout);
}

/**
 * The file a recorded state path names, for a reader with no Story in scope [SSB M3; the M1 plan's §9 B12]. In a
 * checkout whose Story keeps its records on its state ref (remembered for this process), a state-relative record is in
 * the state checkout; a story-branch spelling, and any other checkout, is joined to the checkout as written.
 */
export function recordedStateFile(root, recorded) {
  return typeof recorded === 'string' && !recorded.startsWith(`${DEFAULT_WORK_ITEM_ROOT}/`) && keepsStateRefRecords(root)
    ? path.join(root, STATE_CHECKOUT, recorded) : path.join(root, recorded);
}

function keepsStateRefRecords(root) {
  if (!knownLayouts.size || root == null) return false;
  const prefix = `${path.resolve(String(root))}\0`;
  for (const [key, layout] of knownLayouts) if (layout === 'state-ref' && key.startsWith(prefix)) return true;
  return false;
}

/**
 * A record under the Story folder a caller names by `itemRelative`, that folder's checkout-relative spelling
 * (`checkoutPath()`) [SSB M3, REQ-009]. A state-ref Story's folder is its state checkout, and its records are named
 * relative to it; a story-branch Story's records are named from the checkout, as before. `recordIn` is the spelling a
 * record stores, `recordFileIn` the file that spelling names.
 */
export function recordIn(itemRelative, ...parts) {
  return itemRelative === STATE_CHECKOUT ? slash(path, path.join(...parts)) : slash(path, path.join(itemRelative, ...parts));
}

export function recordFileIn(root, itemRelative, recorded) {
  // '.' is a state-ref Story's own `record()`, as Story start passes it (M2).
  return itemRelative === STATE_CHECKOUT || itemRelative === '.' ? path.join(root, STATE_CHECKOUT, recorded) : path.join(root, recorded);
}

/**
 * A path named from the checkout, as the state checkout names it [SSB M3]: how a state record spells it, and where a
 * state commit's tree has it. A path outside the state checkout is returned as written, so a story-branch Story's
 * paths never change.
 */
export function stateRelative(relative) {
  return typeof relative === 'string' && relative.startsWith(`${STATE_CHECKOUT}/`) ? relative.slice(STATE_CHECKOUT.length + 1) : relative;
}

/**
 * What a Story's record spellings are relative to, from the Story folder a caller holds (`itemDirectory`): the state
 * checkout when that folder is it, else the checkout [SSB M3]. Pure: no file read.
 */
export function recordsRootFor(root, itemDirectory) {
  return itemDirectory && path.resolve(itemDirectory) === path.resolve(root, STATE_CHECKOUT) ? path.join(root, STATE_CHECKOUT) : root;
}

/**
 * Where Git answers for a path named from the checkout [SSB M3]: a path in the state checkout is asked of the state
 * checkout (its HEAD is the state ref), by the name it has there. Any other path is asked of the checkout as written.
 */
export function gitPlaceOf(root, relative) {
  const inside = stateRelative(relative);
  return inside === relative ? { cwd: root, relative } : { cwd: path.join(root, STATE_CHECKOUT), relative: inside };
}

/** Forget every remembered layout (tests). */
export function forgetStoryLayouts() { knownLayouts.clear(); }

// By checkout and Story; with no checkout, by Story when every checkout agrees.
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
  // A workflow's resolution is the Story's record: without a layout it is story-branch, whatever is on disk.
  const resolved = sources.some((source) => source != null && isWorkflow(source) && source.resolution != null);
  const chosen = layout ?? recorded ?? (resolved ? null : remembered) ?? 'story-branch';
  // A layout this build does not know, or a Story read against its own record, is a newer SFlow's Story: update.
  const update = UPDATE;
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

  /**
   * A step's document or other file named relative to the code checkout (REQ-009): the record itself for story-branch;
   * inside the state checkout for state-ref, where M3 keeps its documents until M4 moves them to docs/stories.
   */
  checkoutPath(...parts) {
    return this.branch ? this.record(...parts) : slash(this.path, this.path.join(STATE_CHECKOUT, ...parts));
  }

  /** The state file a record names, on disk, read as written. */
  fromRecord(recorded) {
    return this.branch ? this.path.join(this.root, recorded) : this.path.join(this.root, STATE_CHECKOUT, recorded);
  }

  /** story-branch: '<Stories folder>/<ID>'. A state-ref Story has none: a join on it refuses, loudly (M1 plan §8). */
  get prefix() {
    if (this.branch) return slash(this.path, this.path.join(this.storiesRoot, this.id));
    throw new SingularityFlowError(`Story '${this.id}' keeps its records on its state ref, and this step does not read them there yet. Nothing was changed.`, {
      code: 'STORY_STATE_REF_PATH_UNAVAILABLE', details: { id: this.id, nextAction: UPDATE }
    });
  }

  /** The prefix, or null for a state-ref Story. */
  get branchPrefix() { return this.branch ? this.prefix : null; }

  /** What `record()` spellings are relative to, on disk and for Git history: the checkout or the state checkout. */
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

  /** The Story's configuration pin: the repository's own, or inside the state's pinned copy at its usual path. */
  get configurationSource() {
    const relative = this.branch ? CONFIGURATION_SOURCE_RELATIVE : `${STATE_CONFIGURATION}/${CONFIGURATION_SOURCE_RELATIVE}`;
    return { relative, absolute: this.branch ? this.path.join(this.root, relative) : this.path.join(this.root, STATE_CHECKOUT, relative) };
  }

  /** Where the pinned configuration's usual paths resolve. */
  get configurationRoot() { return this.branch ? this.root : this.path.join(this.root, STATE_CHECKOUT, STATE_CONFIGURATION); }

  /**
   * The root a code-tree digest leaves out: the Stories folder's first segment. null for state-ref: its code checkout's
   * tree holds no records, so nothing is left out (REQ-004, SSB M3).
   */
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

/** Where a fetched state ref lands, so a fetch never overwrites unpublished state commits [REQ-007]. */
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
