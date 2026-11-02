/**
 * One specification split into child specifications and Story slices (SPEC-SPA v1.3 §7, milestone S5).
 *
 * A split plan divides the clauses of one reviewed revision among:
 * - child specifications: a new ID, a title and the parent clauses it takes forward, each drafted on
 *   this clone with those clauses' text and `derivedFrom`, then authored and published on its own;
 * - Story slices: a title, a description and a clause list, each one ready-to-run `start … --spec`
 *   command, run by whoever takes the Story. A split starts no Story (§12 Q1: Stories, not an Epic);
 * - clauses not delivered here, each with its reason.
 * Every clause is allocated at least once or left out with a reason, and the slices' dependencies have
 * no cycle (allocation.mjs). The plan is proposed on this clone (`$git/spec-split-proposals/`), then the
 * person publishes it as `singularity/specifications/<SPEC-ID>/splits/<NNNNNN>/split.json`, bound to the
 * parent revision's manifest digest, through `publishToStateBranch` with an `absent` precondition.
 * Coverage reads the splits back: which child or slice each clause is allocated to, and which children
 * took a clause a later parent revision changed ("parent moved"). Nothing here calls a model.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import { committedFileBytes, committedTreePaths } from '../git.mjs';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from '../publication-storage.mjs';
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { extractClauses } from '../specifications.mjs';
import { SingularityFlowError, writeAtomic, writeAtomicExclusive } from '../util.mjs';
import { contradictedClauses, dependencyCycle, dependencyOrder, unallocatedClauses } from './allocation.mjs';
import { foldGaps } from './draft-model.mjs';
import { LIBRARY_ROOT, revisionName, validSpecId } from './ids.mjs';
import { libraryView } from './library.mjs';

export const SPLIT_FAMILY = 'spec-split';
export const PROPOSAL_FAMILY = 'spec-split-proposal';
const PROPOSALS = 'spec-split-proposals';
const PUBLISH_ATTEMPTS = 3;
const MAXIMUM_ENTRIES = 100;
const MAXIMUM_TITLE = 200;
const MAXIMUM_TEXT = 4000;
const PLAN_FIELDS = new Set(['children', 'stories', 'notDelivered']);
const CLAUSE = /^(?:(SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*):)?((?:REQ|BEH|IFC|AC|CON)-\d{3,})$/u;
const STORY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SPLIT_PATH = new RegExp(`^${LIBRARY_ROOT}/(SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*)/splits/(\\d{6})/split\\.json$`, 'u');

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const text = (value) => (typeof value === 'string' ? value.trim() : '');

export const splitDirectory = (specId) => `${LIBRARY_ROOT}/${specId}/splits`;
export const splitPath = (specId, split) => `${splitDirectory(specId)}/${revisionName(split)}/split.json`;
// SF Guard's seal for a split (SPEC-PSS-v1 §10.9), beside it.
export const splitSealPath = (specId, split) => `${splitDirectory(specId)}/${revisionName(split)}/presence.json`;
export const proposeCommand = (name) => `singularity-flow spec split ${name} --propose --file FILE`;

/** A plan file, JSON or YAML, as written. */
export async function readPlanFile(file) {
  let raw;
  try { raw = YAML.parse(await readFile(path.resolve(file), 'utf8')); }
  catch (error) {
    fail(`The split plan ${file} cannot be read as JSON or YAML: ${error.message}`, 'SPEC_SPLIT_PLAN_INVALID', { file, nextAction: `singularity-flow help spec` });
  }
  return raw;
}

/**
 * Check a plan against one read revision (library.mjs readRevision). Returns the normalized plan, its
 * findings (`{ code, at, message }`, empty when it may be proposed and published), and for each Story
 * slice the slices it depends on and the clauses it depends on that it does not deliver.
 */
export function analyzeSplit(revision, raw) {
  const specId = revision.specId;
  const name = `${specId}@${revision.revision}`;
  const clauses = extractClauses(revision.spec, { namespace: specId });
  const byId = new Map(clauses.map((clause) => [clause.id, clause]));
  const findings = [];
  const finding = (code, at, message) => findings.push({ code, at, message });
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (value !== raw) finding('split.shape', '$', 'the plan is an object with children, stories and notDelivered lists');
  for (const key of Object.keys(value)) if (!PLAN_FIELDS.has(key)) finding('split.shape', key, `'${key}' is not part of a split plan; use children, stories and notDelivered`);
  const array = (key) => {
    if (value[key] === undefined) return [];
    if (!Array.isArray(value[key])) { finding('split.shape', key, `${key} is a list`); return []; }
    return value[key];
  };
  const qualify = (at, raw) => {
    const match = CLAUSE.exec(String(raw ?? '').trim().toUpperCase());
    const id = match && (!match[1] || match[1] === specId) ? `${specId}:${match[2]}` : null;
    if (!id) finding('split.clause-unknown', at, `'${raw}' is not a clause of ${name}; name clauses as REQ-001 or ${specId}:REQ-001`);
    else if (!byId.has(id)) finding('split.clause-unknown', at, `${id} is not a clause of ${name}`);
    return id && byId.has(id) ? id : null;
  };
  const clauseList = (at, list) => {
    if (!Array.isArray(list) || !list.length) { finding('split.shape', at, 'names at least one clause'); return []; }
    return [...new Set(list.map((entry, index) => qualify(`${at}[${index}]`, entry)).filter(Boolean))];
  };
  const titled = (at, entry) => {
    const title = text(entry?.title);
    if (!title || title.length > MAXIMUM_TITLE) finding('split.shape', `${at}.title`, `needs a title of at most ${MAXIMUM_TITLE} characters`);
    return title;
  };

  const children = array('children').map((entry, index) => {
    const at = `children[${index}]`;
    const childId = text(entry?.specId);
    if (!validSpecId(childId)) finding('split.child-id', `${at}.specId`, `'${childId}' is not a specification ID (SPEC- and uppercase letters, digits, single hyphens)`);
    else if (childId === specId) finding('split.child-id', `${at}.specId`, `a child cannot reuse the parent's ID ${specId}`);
    return { specId: childId, title: titled(at, entry), clauses: clauseList(`${at}.clauses`, entry?.clauses) };
  });
  const seenChildren = new Set();
  for (const child of children) {
    if (child.specId && seenChildren.has(child.specId)) finding('split.child-id', child.specId, `${child.specId} is named as a child twice`);
    seenChildren.add(child.specId);
  }

  const stories = array('stories').map((entry, index) => {
    const at = `stories[${index}]`;
    const key = entry?.key === undefined ? `S${index + 1}` : text(entry.key);
    if (!STORY_KEY.test(key)) finding('split.story-key', `${at}.key`, `'${key}' is not a slice key; use up to 32 letters, digits, '_' or '-'`);
    const description = text(entry?.description);
    if (description.length > MAXIMUM_TEXT) finding('split.shape', `${at}.description`, `is at most ${MAXIMUM_TEXT} characters`);
    const workId = entry?.workId === undefined || entry.workId === null ? null : text(entry.workId);
    if (workId !== null && !WORK_ID.test(workId)) finding('split.shape', `${at}.workId`, `'${workId}' is not a Work ID`);
    const dependsOn = entry?.dependsOn === undefined ? [] : Array.isArray(entry.dependsOn) ? [...new Set(entry.dependsOn.map(text))] : null;
    if (dependsOn === null) finding('split.shape', `${at}.dependsOn`, 'dependsOn is a list of slice keys');
    return { key, title: titled(at, entry), description, workId, clauses: clauseList(`${at}.clauses`, entry?.clauses), dependsOn: dependsOn ?? [] };
  });
  const keys = new Set();
  for (const story of stories) {
    if (keys.has(story.key)) finding('split.story-key', story.key, `the slice key ${story.key} is used twice`);
    keys.add(story.key);
  }
  for (const story of stories) {
    for (const key of story.dependsOn) {
      if (key === story.key) finding('split.dependency-unknown', story.key, `${story.key} cannot depend on itself`);
      else if (!keys.has(key)) finding('split.dependency-unknown', story.key, `${story.key} depends on ${key}, which is not a slice of this split`);
    }
  }

  const leftOut = [];
  array('notDelivered').forEach((entry, index) => {
    const at = `notDelivered[${index}]`;
    const clause = qualify(`${at}.clause`, entry?.clause);
    const reason = text(entry?.reason);
    if (!reason || reason.length > MAXIMUM_TEXT) finding('split.shape', `${at}.reason`, 'a clause left out needs its reason');
    if (clause && leftOut.some((other) => other.clause === clause)) finding('split.shape', at, `${clause} is listed as not delivered twice`);
    else if (clause) leftOut.push({ clause, reason });
  });
  if (!children.length && !stories.length) finding('split.shape', '$', 'a split names at least one child specification or Story slice');
  if (children.length + stories.length > MAXIMUM_ENTRIES) finding('split.shape', '$', `a split has at most ${MAXIMUM_ENTRIES} children and slices`);

  const plan = { children, stories: stories.map(({ dependsOn, ...story }) => ({ ...story, dependsOn: dependsOn.filter((key) => keys.has(key) && key !== story.key) })), notDelivered: leftOut };
  if (findings.length) return { plan, findings, stories: [], order: [] };

  const allocations = [...plan.children, ...plan.stories];
  for (const clause of unallocatedClauses(clauses.map((entry) => entry.id), allocations, leftOut)) {
    finding('split.clause-unallocated', clause, `${clause} is allocated to no child or Story slice and is not listed as not delivered here`);
  }
  for (const clause of contradictedClauses(allocations, leftOut)) {
    finding('split.clause-contradicted', clause, `${clause} is both allocated and listed as not delivered here`);
  }

  // A slice that delivers a clause depending on one another slice delivers comes after that slice.
  const edges = new Map(plan.stories.map((story) => [story.key, new Set(story.dependsOn)]));
  const analysed = plan.stories.map((story) => {
    const outside = [];
    for (const clause of story.clauses) {
      for (const needed of byId.get(clause).dependsOn.filter((id) => byId.has(id) && !story.clauses.includes(id))) {
        const holders = plan.stories.filter((other) => other.key !== story.key && other.clauses.includes(needed));
        for (const holder of holders) edges.get(story.key).add(holder.key);
        const children = plan.children.filter((child) => child.clauses.includes(needed)).map((child) => child.specId);
        const left = leftOut.find((entry) => entry.clause === needed);
        outside.push({ clause, dependsOn: needed, slices: holders.map((holder) => holder.key), children, leftOut: left ? left.reason : null });
      }
    }
    return { ...story, outside };
  });
  const cycle = dependencyCycle(plan.stories.map((story) => story.key), edges);
  if (cycle) finding('split.dependency-cycle', cycle[0], `the Story slices depend on each other in a cycle: ${cycle.join(' → ')}`);
  const order = cycle ? [] : dependencyOrder(plan.stories.map((story) => story.key), edges);
  const stated = analysed.map((story) => ({ ...story, dependsOn: [...edges.get(story.key)].sort(),
    command: startCommand(revision, story, clauses.map((entry) => entry.id), plan) }));
  return { plan, findings, stories: stated, order };
}

/** The one `start` command a Story slice becomes; it runs as written, `<WORK-ID>` and `<BRANCH>` filled in. */
function startCommand(revision, story, all, plan) {
  const name = `${revision.specId}@${revision.revision}`;
  const every = all.every((clause) => story.clauses.includes(clause));
  const local = all.filter((clause) => story.clauses.includes(clause)).map((clause) => clause.slice(revision.specId.length + 1));
  const parts = ['singularity-flow start', story.workId ?? '<WORK-ID>', '--from-branch <BRANCH>', '--title', quote(story.title)];
  if (story.description) parts.push('--description', quote(story.description));
  parts.push('--spec', every ? name : `${name}=${local.join(',')}`);
  if (story.outside.length) {
    const where = (entry) => [...entry.slices.map((key) => `slice ${key}`), ...entry.children.map((child) => `child ${child}`),
      ...(entry.leftOut === null ? [] : ['not delivered here'])].join(', ') || 'no slice';
    const reason = `Delivered elsewhere by the split of ${name}: ${story.outside.map((entry) => `${entry.dependsOn} (${where(entry)})`).join('; ')}`;
    parts.push('--allow-partial-dependency --reason', quote(reason));
  }
  return parts.join(' ');
}

/** Refuse a plan with findings, naming every one; nothing is staged or published. */
export function refuseFindings(revision, findings) {
  const name = `${revision.specId}@${revision.revision}`;
  const code = findings.some((entry) => entry.code === 'split.clause-unallocated') ? 'SPEC_SPLIT_CLAUSE_UNALLOCATED'
    : findings.some((entry) => entry.code === 'split.dependency-cycle') ? 'SPEC_SPLIT_DEPENDENCY_CYCLE' : 'SPEC_SPLIT_PLAN_INVALID';
  fail(`The split of ${name} is refused: ${findings.map((entry) => entry.message).join('; ')}. Nothing was proposed or published; correct the plan and propose it again.`,
    code, { specId: revision.specId, revision: revision.revision, findings, nextAction: proposeCommand(name) });
}

export const planDigest = (plan) => digest(canonicalJson(plan));

// ---- The proposal on this clone -----------------------------------------------------------------

const proposalFile = (directory, specId, revision) => path.join(directory, specId, `${revisionName(revision)}.json`);

/** The plan proposed for one revision on this clone; a newer proposal replaces it. */
export async function stageProposal(root, revision, plan, { actor = null } = {}) {
  const directory = await prepareSharedPublicationStorage(root, PROPOSALS, 'Specification split proposals');
  const record = { schemaVersion: currentSchemaVersion(PROPOSAL_FAMILY), specId: revision.specId, revision: revision.revision,
    manifestSha256: revision.manifestSha256, plan, planSha256: planDigest(plan), proposedBy: actor, proposedAt: new Date().toISOString() };
  await writeAtomic(proposalFile(directory, revision.specId, revision.revision), canonicalJson(record), { mode: 0o600 });
  return record;
}

/** The proposal for one revision, null when there is none, or `{ damaged, reason }`. */
export async function readProposal(root, specId, revision) {
  let bytes;
  try { bytes = await readFile(proposalFile(sharedPublicationStorageDirectory(root, PROPOSALS), specId, revision)); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; }
  try {
    const record = readRecord(PROPOSAL_FAMILY, bytes).record;
    if (record.specId !== specId || record.revision !== revision || record.planSha256 !== planDigest(record.plan)) return { damaged: true, reason: 'it does not match its own digest' };
    return record;
  } catch (error) {
    if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error;
    return { damaged: true, reason: error.message };
  }
}

/** Remove the proposal that was published, never a newer one proposed since. */
export async function removeProposal(root, specId, revision, planSha256) {
  const current = await readProposal(root, specId, revision);
  if (current && !current.damaged && current.planSha256 !== planSha256) return false;
  await rm(proposalFile(sharedPublicationStorageDirectory(root, PROPOSALS), specId, revision), { force: true });
  return true;
}

/** A proposal record as a backup carries it: every field its file holds, checked against its own digest. */
export const validProposalRecord = (record) => Boolean(record) && typeof record === 'object' && validSpecId(record.specId)
  && Number.isSafeInteger(record.revision) && record.revision >= 1 && Boolean(record.plan) && typeof record.plan === 'object'
  && record.planSha256 === planDigest(record.plan);

/**
 * Every split proposal on this clone (they exist nowhere else until published), and each one that
 * cannot be read, with why: a backup names those and never leaves one out silently.
 */
export async function listProposals(root) {
  const directory = sharedPublicationStorageDirectory(root, PROPOSALS);
  const absent = (error) => (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? [] : Promise.reject(error));
  const proposals = []; const unreadable = [];
  for (const specId of (await readdir(directory).catch(absent)).filter(validSpecId).sort()) {
    // Other names are a write's own temporary files.
    for (const name of (await readdir(path.join(directory, specId)).catch(absent)).filter((entry) => /^\d{6}\.json$/u.test(entry)).sort()) {
      const revision = Number(name.slice(0, 6));
      try {
        const record = await readProposal(root, specId, revision);
        if (record?.damaged) unreadable.push({ specId, revision, reason: record.reason });
        else if (record) proposals.push(record);
      } catch (error) {
        unreadable.push({ specId, revision, reason: error?.code === 'SCHEMA_VERSION_FUTURE' ? 'a newer Singularity Flow wrote it' : error.message });
      }
    }
  }
  return { proposals, unreadable };
}

/**
 * Put a backed-up proposal back the way it was written. A clone with no proposal for that revision
 * gets it; one holding the same plan is left as it is, and one holding another plan (or a damaged
 * file) keeps its own, as a backed-up specification draft is restored.
 */
export async function restoreProposal(root, record) {
  if (!validProposalRecord(record)) fail('The backed-up split proposal does not match its digest; nothing was restored.', 'SPEC_SPLIT_BACKUP_INVALID', { specId: record?.specId ?? null });
  const current = await readProposal(root, record.specId, record.revision);
  if (current) return { outcome: !current.damaged && current.planSha256 === record.planSha256 ? 'unchanged' : 'kept-local' };
  const directory = await prepareSharedPublicationStorage(root, PROPOSALS, 'Specification split proposals');
  try {
    // Create-only: a proposal staged here meanwhile is never replaced.
    await writeAtomicExclusive(proposalFile(directory, record.specId, record.revision), canonicalJson(record), { mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') return { outcome: 'kept-local' };
    throw error;
  }
  return { outcome: 'restored' };
}

// ---- Published splits ---------------------------------------------------------------------------

function readSplitFile(root, view, file, { env }) {
  const match = SPLIT_PATH.exec(file);
  const record = readRecord(SPLIT_FAMILY, committedFileBytes(root, view.commit, file, { env })).record;
  if (record.specId !== match[1] || record.split !== Number(match[2])) throw new Error('it names a different split');
  return record;
}

/** Every split of one specification at the pinned commit, in order, and the files that could not be read. */
export function readSplits(root, view, specId, { env = process.env } = {}) {
  const splits = [];
  const unreadable = [];
  if (!view.commit) return { splits, unreadable };
  for (const file of committedTreePaths(root, view.commit, [splitDirectory(specId)], { env })) {
    if (SPLIT_PATH.exec(file)?.[1] !== specId) continue;
    try { splits.push(readSplitFile(root, view, file, { env })); }
    catch (error) { if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error; unreadable.push(file); }
  }
  splits.sort((left, right) => left.split - right.split);
  return { splits, unreadable };
}

/**
 * Child IDs every published split in the library has taken, with the split that took each. A split that
 * does not count under SF Guard (`counts`) takes nothing.
 */
function takenChildren(root, view, { env, counts = () => true }) {
  const taken = new Map();
  for (const file of committedTreePaths(root, view.commit, [LIBRARY_ROOT], { env })) {
    if (!SPLIT_PATH.test(file)) continue;
    try {
      const record = readSplitFile(root, view, file, { env });
      if (!counts(record)) continue;
      for (const child of record.children) taken.set(child.specId, file);
    } catch (error) { if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error; }
  }
  return taken;
}

/** The child drafts' derivation: each child clause, the parent clause it carries, and that clause's text digest. */
export function childClauses(revision, child, childId = child.specId) {
  const byId = new Map(extractClauses(revision.spec, { namespace: revision.specId }).map((clause) => [clause.id, clause]));
  return child.clauses.map((parent) => ({ parent, child: `${childId}:${parent.slice(revision.specId.length + 1)}`, bodySha256: byId.get(parent).bodySha256 }));
}

/**
 * Publish a checked plan as the next split of its specification. A split this same operation already
 * published is returned instead of publishing twice; a child ID the library or another split already
 * holds is refused before anything is written.
 */
export async function publishSplit(root, config, { revision, analysis, operationId, actor, command, seal = null, env = process.env }) {
  const { publishToStateBranch } = await import('../ledger.mjs');
  const { specId } = revision;
  const name = `${specId}@${revision.revision}`;
  const planSha256 = planDigest(analysis.plan);
  // The split record and its SF Guard seal are made once, so a retry asks for no second touch.
  let prepared = null;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    const view = await libraryView(root, config, { env });
    const { splits } = readSplits(root, view, specId, { env });
    const earlier = splits.find((entry) => entry.operationId === operationId);
    if (earlier) {
      if (earlier.planSha256 !== planSha256) {
        fail(`Operation ${operationId} already published split ${earlier.split} of ${specId} from a different plan; nothing was published. Use a new operation ID.`,
          'SPEC_SPLIT_OPERATION_REUSED', { specId, split: earlier.split, nextAction: `singularity-flow spec split ${name}` });
      }
      return { record: earlier, commit: view.commit, replayed: true };
    }
    const presence = await (await import('./presence.mjs')).libraryPresence(root, { env });
    const taken = takenChildren(root, view, { env, counts: (record) => presence.split(view, record).counts });
    for (const child of analysis.plan.children) {
      if (view.specs.has(child.specId)) {
        fail(`${child.specId} is already in the specification library, so it cannot be a new child of this split. Nothing was published; choose another ID and propose again.`,
          'SPEC_LIBRARY_ID_TAKEN', { specId: child.specId, nextAction: proposeCommand(name) });
      }
      if (taken.has(child.specId)) {
        fail(`${child.specId} is already a child of another split (${taken.get(child.specId)}). Nothing was published; choose another ID and propose again.`,
          'SPEC_SPLIT_CHILD_TAKEN', { specId: child.specId, nextAction: proposeCommand(name) });
      }
    }
    const split = (splits.at(-1)?.split ?? 0) + 1;
    if (prepared && prepared.split !== split) {
      fail(`Split ${prepared.split} of ${specId} was taken while this split was being published. Nothing was published; run the same command again.`,
        'SPEC_SPLIT_CONFLICT', { specId, nextAction: command });
    }
    const record = prepared?.record ?? {
      schemaVersion: currentSchemaVersion(SPLIT_FAMILY), specId, revision: revision.revision, manifestSha256: revision.manifestSha256,
      stateCommit: revision.commit, split, operationId, planSha256,
      publishedBy: actor ? { name: actor.name ?? null, email: actor.email ?? null } : null, recordedAt: new Date().toISOString(),
      children: analysis.plan.children.map((child) => ({ specId: child.specId, title: child.title, clauses: childClauses(revision, child) })),
      stories: analysis.stories.map(({ key, title, description, workId, clauses, dependsOn, command: start }) => ({ key, title, description, workId, clauses, dependsOn, command: start })),
      notDelivered: analysis.plan.notDelivered
    };
    const file = splitPath(specId, split);
    const bytes = Buffer.from(canonicalJson(record), 'utf8');
    if (!prepared) prepared = { split, record, sealFile: seal ? await seal({ split, splitSha256: digest(bytes) }) : null };
    const files = { [file]: bytes, ...(prepared.sealFile ? { [splitSealPath(specId, split)]: prepared.sealFile } : {}) };
    try {
      const published = await publishToStateBranch(root, view.ledger, files, `[${specId}][spec:split] split ${split} of revision ${revision.revision}`, {
        exactBlobSha256: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])), pathPreconditions: { [file]: { condition: 'absent' } }, env
      });
      return { record, commit: published.commit, replayed: false };
    } catch (error) {
      if (error?.concurrent || error?.code === 'state_branch.path_precondition_failed') continue;
      if (error?.code === 'state_branch.publication_failed') {
        throw new SingularityFlowError(`Publishing the split of ${name} reached the remote, but its answer was lost or refused, so whether split ${split} landed is unknown. Run the same command again: it returns the split if it landed and publishes it once if it did not.`, {
          code: 'SPEC_SPLIT_PUBLISH_UNKNOWN', details: { specId, split, operationId, nextAction: command }, cause: error
        });
      }
      throw error;
    }
  }
  fail(`Other publications kept moving the ${config?.ledger?.branch ?? 'state'} branch; the split of ${name} was not published after ${PUBLISH_ATTEMPTS} attempts. Nothing changed; run the same command again.`,
    'SPEC_LIBRARY_BUSY', { specId, operationId, nextAction: command });
}

// ---- A child draft ------------------------------------------------------------------------------

/**
 * A child's first draft: the template's sections with the parent clauses it takes, each under the
 * child's ID with the parent's number, and the parent's decisions on them. A reference to another taken
 * clause follows it into the child; a reference to a clause the child does not take names the parent's.
 */
export function childSpecText(revision, child, { split }) {
  const parent = revision.specId;
  const byId = new Map(extractClauses(revision.spec, { namespace: parent }).map((clause) => [clause.id, clause]));
  const moved = new Map(child.clauses.map((id) => [id, `${child.specId}:${id.slice(parent.length + 1)}`]));
  const rewrite = (body) => body.replace(new RegExp(`\\b${parent}:((?:REQ|BEH|IFC|AC|CON)-\\d{3,})\\b`, 'gu'), (whole) => moved.get(whole) ?? whole);
  const clauses = (acceptance) => child.clauses.filter((id) => id.slice(parent.length + 1).startsWith('AC-') === acceptance)
    .flatMap((id) => [`${rewrite(byId.get(id).body)} [${moved.get(id)}]`, '']);
  const decisions = foldGaps(revision.gaps?.events ?? [])
    .filter((gap) => (gap.status === 'decided' || gap.status === 'deferred') && (!gap.clauses?.length || gap.clauses.some((id) => moved.has(id))))
    .map((gap) => `- ${parent} ${gap.id}: ${gap.status === 'decided' ? gap.decision.choice : `deferred to ${gap.deferral.owner}. ${gap.deferral.reason}`.trim()}`);
  const [[first, carried]] = moved;
  const requirements = clauses(false);
  const acceptance = clauses(true);
  return [
    `# ${child.title}`, '',
    `Derived from ${parent}@${revision.revision}, split ${split}. Each clause keeps the parent's number: \`${carried}\` carries \`${first}\`.`, '',
    '## Outcome', '', 'TODO: what is true for the people this serves once it is delivered.', '',
    '## Actors', '', '- TODO: who uses or is affected by this behaviour.', '',
    '## User scenarios', '', '1. TODO: one concrete scenario, start to finish.', '',
    '## Scope', '', 'In scope: TODO. Out of scope: TODO.', '',
    '## Requirements', '', ...(requirements.length ? requirements : ['TODO: the requirements this child adds.', '']),
    '## Acceptance', '', ...(acceptance.length ? acceptance : ['TODO: an observable result that proves each requirement.', '']),
    '## Decisions and open questions', '', ...(decisions.length ? [`Decided in ${parent}@${revision.revision}:`, '', ...decisions, ''] : []),
    'TODO: state each decided or deferred gap of this specification here by its ID and its outcome.', ''
  ].join('\n');
}

// ---- Coverage -----------------------------------------------------------------------------------

/**
 * Coverage rows (usage.mjs coverageOf) with a split's allocation: a clause no Story claims or delivered is
 * allocated when the latest split of its revision gives it to a child or slice, or left out with its reason.
 */
export function allocatedCoverage(rows, { allocation, leftOut }) {
  return rows.map((row) => {
    const allocatedTo = allocation.get(row.clause) ?? [];
    const reason = leftOut.get(row.clause) ?? null;
    const status = row.status !== 'uncovered' ? row.status : allocatedTo.length ? 'allocated' : reason ? 'left-out' : 'uncovered';
    return { ...row, status, allocatedTo, ...(reason ? { leftOut: reason } : {}) };
  });
}

/**
 * What the splits say about one read revision: each clause's allocation in the latest split of that
 * revision, the clauses it leaves out, and every child of a split of this or an earlier revision with
 * whether a parent clause it took has changed since ("parent-moved").
 */
export function splitCoverage(revision, splits) {
  const current = [...splits].reverse().find((entry) => entry.revision === revision.revision) ?? null;
  const allocation = new Map();
  const leftOut = new Map();
  const add = (clause, entry) => { if (!allocation.has(clause)) allocation.set(clause, []); allocation.get(clause).push(entry); };
  for (const child of current?.children ?? []) for (const clause of child.clauses) add(clause.parent, { kind: 'child', specId: child.specId, title: child.title });
  for (const story of current?.stories ?? []) for (const clause of story.clauses) add(clause, { kind: 'story', key: story.key, title: story.title, workId: story.workId ?? null });
  for (const entry of current?.notDelivered ?? []) leftOut.set(entry.clause, entry.reason);
  const now = new Map(extractClauses(revision.spec, { namespace: revision.specId }).map((clause) => [clause.id, clause.bodySha256]));
  const children = splits.filter((entry) => entry.revision <= revision.revision).flatMap((entry) => entry.children.map((child) => {
    const changed = entry.revision === revision.revision ? [] : child.clauses.filter((clause) => now.get(clause.parent) !== clause.bodySha256).map((clause) => clause.parent);
    return { specId: child.specId, title: child.title, split: entry.split, fromRevision: entry.revision,
      status: entry.revision === revision.revision ? 'current' : changed.length ? 'parent-moved' : 'unchanged', changed };
  }));
  return { split: current ? { split: current.split, recordedAt: current.recordedAt, publishedBy: current.publishedBy } : null, allocation, leftOut, children };
}

