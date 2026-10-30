/**
 * Configuration drafts: agent, skill and instruction changes kept on this machine until they are
 * proposed together, so a batch of related changes gets one review and one approval.
 *
 * Without drafts every `skill create --propose` became its own proposal, and a change that depended
 * on another (attach the skill created a minute ago) could not be proposed until the first was
 * approved. A draft is checked against the approved configuration together with every earlier draft
 * when it is saved, is listed wherever skills and instructions are listed, and is used by nothing —
 * no Story, no prompt — until the one proposal holding all of them is approved. Drafts live in the
 * repository's Git directory, shared by its worktrees, and never in a commit.
 *
 * A repository with no approved configuration branch has nothing to approve: its working tree is
 * the configuration, so changes are written there exactly as before.
 *
 * Storage (SDA §6.3, §9 "Local drafts"): one immutable file per draft in `configuration-drafts/v2`,
 * created whole (a synced temporary file linked into place, then the directory synced), so after a
 * crash a draft is either absent or complete. The last proposal is `proposed.json`, replaced
 * atomically with a revision counter, and `authority.json` records that this repository has an
 * approved configuration, so later saves need no remote. Every change runs under one lock;
 * reads take none. A save names its operation: the same operation with the same change returns the
 * draft already saved, and a different change under that operation is refused. A proposal records
 * the exact drafts it holds and removes only those, so a draft saved meanwhile stays waiting. The
 * single `drafts.json` of earlier builds is migrated once and kept beside the store, never deleted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from './publication-storage.mjs';
import { compactCanonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

/** What `readDrafts` returns: every waiting draft in order, and the last proposal. */
export const DRAFTS_SCHEMA = 'sflow-configuration-drafts@2';
/** One saved draft file. */
export const DRAFT_SCHEMA = 'sflow-configuration-draft@2';
/** The last proposal made from the drafts. */
export const PROPOSED_SCHEMA = 'sflow-configuration-drafts-proposed@2';
/** The approved configuration a save last saw: the repository has one, so drafts are saved, not written. */
export const AUTHORITY_SCHEMA = 'sflow-configuration-drafts-authority@2';
/** Drafts are saved on this machine only: never published, submitted or approved (SDA §9). */
export const DRAFT_STATE = 'saved-local';
const LEGACY_SCHEMA = 'sflow-configuration-drafts@1';
const CHANGE_SET_SCHEMA = 'sflow-studio-change-set@1';
const DIRECTORY = 'configuration-drafts';
const STORE = 'v2';
const LEGACY_FILE = 'drafts.json';
const MIGRATED_SUFFIX = '.migrated-v2';
const PROPOSED_FILE = 'proposed.json';
const AUTHORITY_FILE = 'authority.json';
// A save checked only against this checkout's configuration, because the approved one is not held here.
const CHECKOUT_SOURCE = Object.freeze({ kind: 'checkout-configuration', commit: null });
// Remote failures that mean the approved configuration could not be asked at all.
const UNREACHABLE = new Set(['network-transient', 'offline', 'remote-not-found']);
const DRAFT_FILE = /^(cdr-[0-9a-f]{24})\.json$/u;
export const DRAFT_ID = /^cdr-[0-9a-f]{24}$/u;
const TEMPORARY_FILE = /^\..+\.tmp$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const OPERATION_ID_INPUT_LENGTH = 128;
const LOCK_SUBJECT = Object.freeze({ kind: 'configuration-drafts', id: 'drafts' });
const LOCK_WAIT_MS = 30_000;
const SAVE_ATTEMPTS = 5;
const MAXIMUM_DRAFTS = 200;
const LINKLESS_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']);
/** The changes people make one at a time from the CLI or Copilot. Imports and workflow edits keep their own routes. */
export const DRAFTABLE_OPERATIONS = Object.freeze(['skill.create', 'skill.update', 'skill.attach', 'skill.detach', 'skill.remove',
  'instruction.create', 'instruction.update', 'instruction.remove', 'agent.create', 'agent.update']);
const DRAFTABLE = new Set(DRAFTABLE_OPERATIONS);

const fail = (message, code, details = null) => { throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) }); };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/** The draft store: one file per draft, `proposed.json` and `authority.json`. */
export function draftsDirectory(root) {
  return path.join(sharedPublicationStorageDirectory(root, DIRECTORY), STORE);
}

/** The single drafts file of earlier builds, migrated on first access. */
export function legacyDraftsPath(root) {
  return path.join(sharedPublicationStorageDirectory(root, DIRECTORY), LEGACY_FILE);
}

/** The digest a draft's operation is bound to: its change and the line describing it. */
export function draftPayloadDigest(change, description = describeChange(change)) {
  return `sha256:${sha256(compactCanonicalJson({ change, description }))}`;
}

/** The operation ID of a save that names none: an identical retried command is the same operation. */
export function defaultDraftOperationId(change, description = describeChange(change)) {
  return `cdo-${draftPayloadDigest(change, description).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

/** A short identity of the listed drafts in order: list numbers mean something only against it. */
export function draftListing(changes) {
  return sha256(changes.map((entry) => entry.draftId).join('\n')).slice(0, 12);
}

// Test-only crash injection (SDA-AC-003): the process dies at once, with no cleanup of any kind.
function crashPoint(point) {
  if (process.env.NODE_ENV !== 'test' || process.env.SINGULARITY_FLOW_TEST_CRASH_AT !== point) return;
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}

function damaged(file) {
  return fail(`The configuration draft ${file} cannot be read. Move it aside to continue; nothing in it has been proposed.`,
    'CONFIGURATION_DRAFTS_INVALID', { file });
}

/**
 * The writer fence of the draft store (SDA M5): a record a newer build wrote is refused with the
 * upgrade, never offered as damaged and moved aside, and this build writes nothing beside it.
 */
function refuseNewer(file, value) {
  const match = /^(sflow-configuration-drafts?(?:-proposed|-authority)?)@(\d+)$/u.exec(value?.schema ?? '');
  if (!match || Number(match[2]) <= 2) return;
  fail(`The configuration draft store holds ${file}, written by a newer Singularity Flow (${value.schema}). Upgrade to read or change drafts; nothing was changed.`,
    'SCHEMA_VERSION_FUTURE', { family: match[1], storedVersion: Number(match[2]), readable: { minimum: 2, maximum: 2 }, file });
}

async function regularFile(file) {
  const info = await lstat(file).catch((error) => (missing(error) ? null : Promise.reject(error)));
  if (info && (!info.isFile() || info.isSymbolicLink())) damaged(file);
  return info;
}

async function readJson(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (missing(error)) return undefined; throw error; }
  try { return JSON.parse(text); } catch { return damaged(file); }
}

function validDraft(value, draftId) {
  return value?.schema === DRAFT_SCHEMA && value.draftId === draftId
    && typeof value.operationId === 'string' && OPERATION_ID.test(value.operationId)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && (value.addedAt === null || typeof value.addedAt === 'string')
    && typeof value.description === 'string' && value.change && typeof value.change === 'object' && DRAFTABLE.has(value.change.op)
    && (value.checkedAgainst === null || (typeof value.checkedAgainst === 'object' && !Array.isArray(value.checkedAgainst)))
    && value.payloadDigest === draftPayloadDigest(value.change, value.description);
}

const draftOrder = (left, right) => left.sequence - right.sequence
  || String(left.addedAt ?? '').localeCompare(String(right.addedAt ?? '')) || left.draftId.localeCompare(right.draftId);

async function readAuthority(directory) {
  const file = path.join(directory, AUTHORITY_FILE);
  if (!await regularFile(file)) return null;
  const value = await readJson(file);
  if (value === undefined) return null;
  refuseNewer(file, value);
  if (value?.schema !== AUTHORITY_SCHEMA || (value.commit !== null && typeof value.commit !== 'string')) damaged(file);
  return value;
}

async function readProposed(directory) {
  const file = path.join(directory, PROPOSED_FILE);
  if (!await regularFile(file)) return { proposed: null, revision: 0 };
  const value = await readJson(file);
  if (value === undefined) return { proposed: null, revision: 0 };
  refuseNewer(file, value);
  if (value?.schema !== PROPOSED_SCHEMA || !Number.isSafeInteger(value.revision) || value.revision < 0
      || (value.proposed !== null && (typeof value.proposed !== 'object' || Array.isArray(value.proposed)))) damaged(file);
  return { proposed: value.proposed, revision: value.revision };
}

/**
 * The store as saved: drafts in order and the last proposal. Drafts that proposal already holds are
 * `consumed` (a crash came between recording it and removing them) and are never listed again.
 */
async function readStore(root) {
  const directory = draftsDirectory(root);
  const info = await lstat(directory).catch((error) => (missing(error) ? null : Promise.reject(error)));
  if (!info) return { drafts: [], consumed: [], proposed: null, revision: 0, authority: null };
  if (!info.isDirectory() || info.isSymbolicLink()) damaged(directory);
  const { proposed, revision } = await readProposed(directory);
  const held = new Set(Array.isArray(proposed?.draftIds) ? proposed.draftIds : []);
  const drafts = []; const consumed = [];
  for (const name of await readdir(directory)) {
    const match = DRAFT_FILE.exec(name);
    if (!match) continue;
    const file = path.join(directory, name);
    // A draft another process discarded or proposed while this one listed is simply gone.
    if (!await regularFile(file)) continue;
    const value = await readJson(file);
    if (value === undefined) continue;
    refuseNewer(file, value);
    if (!validDraft(value, match[1])) damaged(file);
    (held.has(value.draftId) ? consumed : drafts).push(value);
  }
  drafts.sort(draftOrder);
  return { drafts, consumed, proposed, revision, authority: await readAuthority(directory) };
}

function view(store) {
  return {
    schema: DRAFTS_SCHEMA,
    changes: store.drafts.map((draft) => ({ ...draft, state: DRAFT_STATE })),
    proposed: store.proposed,
    revision: store.revision,
    listing: draftListing(store.drafts),
    authority: store.authority
  };
}

/** The saved drafts, or none. A damaged draft is refused rather than silently dropped. Takes no lock. */
export async function readDrafts(root) {
  if (await regularFile(legacyDraftsPath(root))) await withDraftStore(root, () => null);
  return view(await readStore(root));
}

async function syncDirectory(directory) {
  // POSIX file plus directory fsync makes a link or rename durable. Some Windows and network
  // filesystems cannot open or sync a directory; the atomic link or rename and the file sync remain.
  let handle = null;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)) throw error; }
  finally { await handle?.close(); }
}

/** Write `text` as `name` whole: a synced temporary file, linked or renamed into place, then the directory synced. */
async function publishFile(directory, name, text, { replace }) {
  const file = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  crashPoint(replace ? 'configuration-proposed-publish' : 'configuration-draft-publish');
  try {
    if (replace) await rename(temporary, file);
    else {
      // A hard link never replaces an existing draft. A filesystem without links gets a rename:
      // the name is random, so there is nothing for it to replace.
      try { await link(temporary, file); }
      catch (error) { if (!LINKLESS_CODES.has(error?.code)) throw error; await rename(temporary, file); }
    }
  } finally { await rm(temporary, { force: true }); }
  await syncDirectory(directory);
}

async function removeDrafts(directory, draftIds) {
  for (const draftId of draftIds) await rm(path.join(directory, `${draftId}.json`), { force: true });
  if (draftIds.length) await syncDirectory(directory);
}

async function writeDraft(directory, fields) {
  const draft = { schema: DRAFT_SCHEMA, draftId: `cdr-${randomBytes(12).toString('hex')}`, operationId: fields.operationId,
    payloadDigest: draftPayloadDigest(fields.change, fields.description), sequence: fields.sequence, addedAt: fields.addedAt,
    description: fields.description, change: fields.change, checkedAgainst: fields.checkedAgainst ?? null };
  await publishFile(directory, `${draft.draftId}.json`, `${JSON.stringify(draft, null, 2)}\n`, { replace: false });
  return draft;
}

async function writeAuthority(directory, { commit = null, source = null }) {
  await publishFile(directory, AUTHORITY_FILE, `${JSON.stringify({ schema: AUTHORITY_SCHEMA, commit, source, seenAt: new Date().toISOString() }, null, 2)}\n`,
    { replace: true });
}

async function writeProposed(directory, revision, proposed) {
  await publishFile(directory, PROPOSED_FILE, `${JSON.stringify({ schema: PROPOSED_SCHEMA, revision, proposed }, null, 2)}\n`, { replace: true });
}

const nextSequence = (drafts) => drafts.reduce((highest, draft) => Math.max(highest, draft.sequence), 0) + 1;

async function prepareStore(root) {
  const parent = await prepareSharedPublicationStorage(root, DIRECTORY, 'Configuration drafts');
  const directory = path.join(parent, STORE);
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) damaged(directory);
  return directory;
}

/** Only a writer holding the lock creates temporary files, so any the next holder finds is an orphan. */
async function sweepTemporaryFiles(directory) {
  const orphans = (await readdir(directory)).filter((name) => TEMPORARY_FILE.test(name));
  for (const name of orphans) await rm(path.join(directory, name), { force: true });
  if (orphans.length) await syncDirectory(directory);
}

async function migratedName(file) {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = `${file}${MIGRATED_SUFFIX}${attempt ? `-${attempt}` : ''}`;
    if (!await lstat(candidate).catch((error) => (missing(error) ? null : Promise.reject(error)))) return candidate;
  }
}

/**
 * Move the drafts file of earlier builds into the store, once. Each change becomes a draft whose
 * operation ID is derived from it, so an interrupted migration resumes without duplicates; the last
 * proposal is carried over unless the store has its own; the old file is then renamed
 * `drafts.json.migrated-v2`, never deleted. A damaged file is refused and left exactly as it is.
 */
async function migrateLegacyDrafts(root, directory) {
  const file = legacyDraftsPath(root);
  if (!await regularFile(file)) return;
  const value = await readJson(file);
  if (value === undefined) return;
  if (value?.schema !== LEGACY_SCHEMA || !Array.isArray(value.changes)
      || value.changes.some((entry) => !entry || typeof entry !== 'object' || !DRAFTABLE.has(entry.change?.op))) damaged(file);
  const store = await readStore(root);
  const known = new Set([...store.drafts, ...store.consumed].map((draft) => draft.operationId));
  let sequence = nextSequence(store.drafts);
  for (const entry of value.changes) {
    const description = typeof entry.description === 'string' ? entry.description : describeChange(entry.change);
    const operationId = defaultDraftOperationId(entry.change, description);
    if (known.has(operationId)) continue;
    known.add(operationId);
    await writeDraft(directory, { operationId, change: entry.change, description, sequence: sequence++,
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : null, checkedAgainst: null });
    crashPoint('configuration-draft-migration');
  }
  if (value.proposed && typeof value.proposed === 'object' && !store.proposed && store.revision === 0) {
    await writeProposed(directory, 1, { ...value.proposed, draftIds: [] });
  }
  // Earlier builds saved drafts only where an approved configuration existed.
  if ((value.changes.length || value.proposed) && !store.authority) await writeAuthority(directory, { source: 'migrated' });
  await rename(file, await migratedName(file));
  await syncDirectory(path.dirname(file));
}

/**
 * Run `work(directory)` holding the repository's drafts lock, after repairing what an interrupted
 * writer can leave: orphaned temporary files, the drafts file of earlier builds, and drafts that a
 * recorded proposal holds but a crash kept from being removed. A busy lock is waited for briefly.
 */
async function withDraftStore(root, work) {
  const { withSubjectLock } = await import('./subject-lock.mjs');
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (let pause = 10; ; pause = Math.min(pause * 2, 250)) {
    let entered = false;
    try {
      return await withSubjectLock(root, LOCK_SUBJECT, async () => {
        entered = true;
        const directory = await prepareStore(root);
        await sweepTemporaryFiles(directory);
        await migrateLegacyDrafts(root, directory);
        await removeDrafts(directory, (await readStore(root)).consumed.map((draft) => draft.draftId));
        return work(directory);
      });
    } catch (error) {
      if (entered || error?.code !== 'SUBJECT_LOCK_BUSY' || Date.now() >= giveUpAt) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, pause + Math.floor(Math.random() * pause)));
  }
}

const scope = (change) => (change.workflow ? `workflow ${change.workflow}` : `agent ${change.agent}`);

/** One plain line saying what a change does. */
export function describeChange(change) {
  const name = change.label ? `${change.label} (${change.id})` : change.id;
  switch (change.op) {
    case 'skill.create': return `New skill ${name}`;
    case 'skill.update': return `Edit skill ${change.id}`;
    case 'skill.remove': return `Remove skill ${change.id}`;
    case 'skill.attach': return `Attach skill ${change.skill} to ${scope(change)}${change.phases?.length ? ` in ${change.phases.join(', ')}` : ''}`;
    case 'skill.detach': return `Detach skill ${change.skill} from ${scope(change)}`;
    case 'instruction.create': return `New instruction ${name}`;
    case 'instruction.update': return `Edit instruction ${change.id}`;
    case 'instruction.remove': return `Remove instruction ${change.id}`;
    case 'agent.create': return `New agent ${name}`;
    case 'agent.update': return `Edit agent ${change.id}`;
    default: return String(change.op);
  }
}

/** What a draft or a batch of drafts adds, by kind and ID, for marking lists. */
export function draftedIds(drafts, kind) {
  const ids = new Map();
  for (const { change } of drafts.changes) {
    const [subject, action] = change.op.split('.');
    if (subject !== kind) continue;
    if (['create', 'update', 'remove'].includes(action)) ids.set(change.id, action);
  }
  return ids;
}

function batchIdentity(changes, subject, message) {
  if (changes.length === 1) return { subject, message };
  const lines = changes.map(describeChange);
  const summary = lines.join('; ');
  return {
    subject: `${changes.length}-changes`,
    message: `[configuration] ${changes.length} changes: ${summary.length > 400 ? `${summary.slice(0, 397)}...` : summary}`
  };
}

const withDrafts = (result, drafts) => (result && typeof result === 'object' ? { ...result, drafts } : result);
/** A proposal's next step is approving it, which shows what it changes first. */
const approvalNext = (result) => (result?.reviewRequired && result.branch
  ? { ...result, nextAction: `singularity-flow configuration approve ${result.branch}` } : result);
const combine = (drafts, changes) => ({ schema: CHANGE_SET_SCHEMA, changes: [...drafts.map((entry) => entry.change), ...changes] });

/** Each change of a save as one operation: its ID, its digest and the line describing it. */
function saveIntents(changes, operationId) {
  if (operationId != null && (typeof operationId !== 'string' || operationId.length > OPERATION_ID_INPUT_LENGTH || !OPERATION_ID.test(operationId))) {
    fail(`--operation-id takes up to ${OPERATION_ID_INPUT_LENGTH} letters, digits, '.', '_', ':' or '-', starting with a letter or digit.`,
      'CONFIGURATION_DRAFT_OPERATION_INVALID');
  }
  const intents = new Map();
  changes.forEach((change, index) => {
    const description = describeChange(change);
    const id = operationId == null ? defaultDraftOperationId(change, description)
      : changes.length === 1 ? operationId : `${operationId}:${index + 1}`;
    // The same change twice in one save is one operation, saved once.
    if (!intents.has(id)) intents.set(id, { operationId: id, change, description, payloadDigest: draftPayloadDigest(change, description) });
  });
  return [...intents.values()];
}

/** Split a save into the operations already saved and those still to save; a reused ID with other bytes is refused. */
function replayOf(drafts, intents) {
  const saved = new Map(drafts.map((draft) => [draft.operationId, draft]));
  const existing = []; const pending = [];
  for (const intent of intents) {
    const draft = saved.get(intent.operationId);
    if (!draft) { pending.push(intent); continue; }
    if (draft.payloadDigest !== intent.payloadDigest) {
      fail(`Operation ${intent.operationId} already saved a different change (${draft.description}). Use a new operation ID for a new change.`,
        'CONFIGURATION_DRAFT_OPERATION_REUSED', { operationId: intent.operationId, draftId: draft.draftId });
    }
    existing.push(draft);
  }
  return { existing, pending };
}

const sameDrafts = (left, right) => left.length === right.length && left.every((draft, index) => draft.draftId === right[index].draftId);

const approvedSource = (source) => Boolean(source) && source.kind !== 'working-tree';

/**
 * Check a save without asking the remote whenever this machine can answer (SDA §9):
 *
 * 1. An approved configuration held here (a local `sflow/config` or state ref): checked against it.
 * 2. Otherwise, once a save has seen that this repository has an approved configuration
 *    (`authority.json`), against this checkout's configuration. When the checkout disagrees, the
 *    approved configuration is asked, since the checkout may predate an approval; if it cannot be
 *    reached, the draft is saved with that disagreement as warnings, to be checked when proposed.
 * 3. With nothing known here, the approved configuration is asked once, which also learns whether
 *    the repository has one at all (if not, the change is written to the working tree as before).
 *
 * `record` asks the save to remember that the repository has an approved configuration.
 */
async function checkForSave(check, set, known) {
  const held = await check(set, { refreshAuthority: false }).catch(() => null);
  if (approvedSource(held?.source)) return { plan: held.plan, source: held.source, record: false };
  if (known && held?.plan && held.plan.valid !== false) return { plan: held.plan, source: CHECKOUT_SOURCE, record: false };
  let fresh;
  try { fresh = await check(set); }
  catch (error) {
    if (!known || !held?.plan || !UNREACHABLE.has(error?.details?.classification)) throw error;
    const disagreements = (held.plan.problems ?? []).map((problem) => ({
      message: `Not checked against the approved configuration, which could not be reached; this checkout says: ${problem.message} It is checked again when you propose.`
    }));
    return { plan: { ...held.plan, valid: true, warnings: [...(held.plan.warnings ?? []), ...disagreements] }, source: CHECKOUT_SOURCE, record: false };
  }
  return { plan: fresh?.plan, source: fresh?.source ?? null, record: approvedSource(fresh?.source) };
}

function savedResult({ plan = null, added, pending, saved }) {
  return {
    schemaVersion: 1, resultType: 'configuration-draft', valid: true, draft: true, changed: false, saved, state: DRAFT_STATE,
    summary: plan?.summary ?? [], warnings: plan?.warnings ?? [], problems: [], files: [],
    drafts: { pending, added: added.map((draft) => draft.description), ids: added.map((draft) => draft.draftId) },
    nextAction: 'singularity-flow configuration propose'
  };
}

/**
 * Author one agent, skill or instruction change.
 *
 * - `--dry-run` previews it on top of the saved drafts, so a change that depends on a draft checks.
 * - `--propose` proposes the saved drafts and this change as one review.
 * - Otherwise, when an approved configuration exists, it is checked with the drafts and saved as a
 *   draft; when none exists, it is written to the working tree as before.
 *
 * `apply(changeSet, { dryRun, propose, subject, message })` is the CLI's normal applier and
 * `check(changeSet, { refreshAuthority })` plans against the approved configuration, returning
 * `{ plan, source }`, where `source.kind === 'working-tree'` means none was found; with
 * `refreshAuthority: false` it reads only what this machine holds (see `checkForSave`).
 * `operationId` names the save (default: derived from the change), so a retry returns the draft
 * already saved (`saved: 'existing'`) and a different change under that ID is refused.
 */
export async function authorChange(root, changeSet, { dryRun = false, propose = false, subject, message, apply, check, operationId = null }) {
  if (!changeSet.changes.every((change) => DRAFTABLE.has(change.op))) return apply(changeSet, { dryRun, propose, subject, message });
  let drafts = await readDrafts(root);
  const included = drafts.changes.length;
  if (dryRun) return withDrafts(await apply(combine(drafts.changes, changeSet.changes), { dryRun: true, subject, message }), { pending: included, included });
  if (propose) {
    const combined = combine(drafts.changes, changeSet.changes);
    const result = await apply(combined, { propose: true, ...batchIdentity(combined.changes, subject, message) });
    const pending = result?.reviewRequired && result.branch
      ? await recordProposal(root, result, { draftIds: drafts.changes.map((entry) => entry.draftId), changes: combined.changes.map(describeChange) })
      : included;
    return withDrafts(approvalNext(result), { pending, included });
  }
  const intents = saveIntents(changeSet.changes, operationId);
  let replay = replayOf(drafts.changes, intents);
  if (!replay.pending.length) return savedResult({ added: replay.existing, pending: drafts.changes.length, saved: 'existing' });
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const { plan, source, record } = await checkForSave(check, combine(drafts.changes, replay.pending.map((intent) => intent.change)), drafts.authority);
    if (!approvedSource(source)) return apply(changeSet, { subject, message });
    if (plan?.valid === false) return withDrafts(plan, { pending: drafts.changes.length, included: drafts.changes.length });
    const checked = drafts.changes;
    const outcome = await withDraftStore(root, async (directory) => {
      const current = (await readStore(root)).drafts;
      const now = replayOf(current, intents);
      if (!now.pending.length) return { existing: now.existing, pending: current.length };
      // Another process changed the drafts after this change was checked against them: check again.
      if (!sameDrafts(current, checked)) return { moved: true };
      if (current.length + now.pending.length > MAXIMUM_DRAFTS) {
        fail(`You have ${current.length} drafts already. Propose them for review with singularity-flow configuration propose before adding more.`,
          'CONFIGURATION_DRAFTS_LIMIT');
      }
      const addedAt = new Date().toISOString();
      const checkedAgainst = { commit: source.commit ?? null, source: source.ref ?? source.kind ?? null };
      if (record) await writeAuthority(directory, checkedAgainst);
      let sequence = nextSequence(current);
      const written = [];
      for (const intent of now.pending) written.push(await writeDraft(directory, { ...intent, addedAt, sequence: sequence++, checkedAgainst }));
      return { added: [...now.existing, ...written], pending: current.length + written.length };
    });
    if (outcome.existing) return savedResult({ added: outcome.existing, pending: outcome.pending, saved: 'existing' });
    if (!outcome.moved) return savedResult({ plan, added: outcome.added, pending: outcome.pending, saved: 'new' });
    drafts = await readDrafts(root);
    replay = replayOf(drafts.changes, intents);
    if (!replay.pending.length) return savedResult({ added: replay.existing, pending: drafts.changes.length, saved: 'existing' });
  }
  return fail('The drafts kept changing while this change was checked against them. Run the command again.', 'CONFIGURATION_DRAFTS_CHANGED');
}

/**
 * Record a proposal holding exactly `draftIds`, then remove exactly those drafts; one saved meanwhile
 * keeps waiting. The proposal is written first, so a crash in between leaves drafts it already holds,
 * which are hidden at once and removed by the next change to the store. Returns the drafts left.
 */
async function recordProposal(root, result, { draftIds, changes }) {
  return withDraftStore(root, async (directory) => {
    const { drafts, revision } = await readStore(root);
    await writeProposed(directory, revision + 1, {
      branch: result.branch, commit: result.commit ?? result.proposalRevision ?? null,
      at: new Date().toISOString(), changes, draftIds
    });
    const held = new Set(draftIds);
    await removeDrafts(directory, drafts.filter((draft) => held.has(draft.draftId)).map((draft) => draft.draftId));
    return drafts.filter((draft) => !held.has(draft.draftId)).length;
  });
}

/**
 * A change set with the saved drafts in front, for surfaces that build their own batch (Workflow
 * Studio): what they publish carries every waiting draft, so pending work still gets one review.
 * `draftIds` names exactly the drafts included, for `settleDrafts`.
 */
export async function withSavedDrafts(root, changeSet) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) return { changeSet, included: [], draftIds: [] };
  return { included: drafts.changes.map((entry) => entry.description ?? describeChange(entry.change)),
    draftIds: drafts.changes.map((entry) => entry.draftId),
    changeSet: { ...changeSet, changes: [...drafts.changes.map((entry) => entry.change), ...(changeSet.changes ?? [])] } };
}

/** After a batch carrying the drafts `draftIds` was proposed or written, exactly those are no longer waiting. */
export async function settleDrafts(root, result, { included = [], draftIds = [] } = {}) {
  if (!draftIds.length) return;
  if (result?.reviewRequired && result.branch) await recordProposal(root, result, { draftIds, changes: included });
  else if (result && result.valid !== false) {
    await withDraftStore(root, async (directory) => {
      const held = new Set(draftIds);
      await removeDrafts(directory, (await readStore(root)).drafts.filter((draft) => held.has(draft.draftId)).map((draft) => draft.draftId));
    });
  }
}

/** Propose every saved draft as one review. */
export async function proposeDrafts(root, { apply, message = null }) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) {
    fail(drafts.proposed
      ? `No drafts are waiting. Your last proposal, ${drafts.proposed.branch}, is ready for approval: singularity-flow configuration approve`
      : 'No drafts are waiting. Create or edit an agent, skill or instruction first; each change is saved as a draft.',
    'CONFIGURATION_DRAFTS_EMPTY',
    drafts.proposed ? { nextAction: `singularity-flow configuration approve ${drafts.proposed.branch}` } : null);
  }
  const changes = drafts.changes.map((entry) => entry.change);
  const identity = batchIdentity(changes, changes[0].id ?? changes[0].skill ?? 'change', `[configuration] ${describeChange(changes[0])}`);
  const result = await apply({ schema: CHANGE_SET_SCHEMA, changes }, { propose: true, ...identity, ...(message ? { message } : {}) });
  const pending = result?.reviewRequired && result.branch
    ? await recordProposal(root, result, { draftIds: drafts.changes.map((entry) => entry.draftId), changes: changes.map(describeChange) })
    : changes.length;
  return withDrafts(approvalNext(result), { pending, included: changes.length });
}

/**
 * Drop drafts: by draft ID, by number in the list (from 1), or all of them. `listing` is the
 * listing the numbers were read from (`configuration drafts` prints it); when the drafts changed
 * since, nothing is dropped and the refusal names the current listing.
 */
export async function discardDrafts(root, { ids = [], number = null, listing = null, all = false } = {}) {
  return withDraftStore(root, async (directory) => {
    const { drafts } = await readStore(root);
    if (!drafts.length) fail('There are no drafts to discard.', 'CONFIGURATION_DRAFTS_EMPTY');
    const current = draftListing(drafts);
    if (listing != null && listing !== current) {
      fail(`The drafts changed since that list was shown, so its numbers no longer mean the same drafts. Nothing was discarded. See them again: singularity-flow configuration drafts`,
        'CONFIGURATION_DRAFTS_CHANGED', { listing: current, nextAction: 'singularity-flow configuration drafts' });
    }
    let removed;
    if (all) removed = drafts;
    else if (ids.length) {
      const unknown = ids.filter((id) => !drafts.some((draft) => draft.draftId === id));
      if (unknown.length) fail(`No waiting draft has the ID ${unknown.join(', ')} (see singularity-flow configuration drafts).`, 'CONFIGURATION_DRAFT_UNKNOWN');
      removed = drafts.filter((draft) => ids.includes(draft.draftId));
    } else if (Number.isSafeInteger(number) && number >= 1 && number <= drafts.length) removed = [drafts[number - 1]];
    else {
      fail(`Say which draft to discard: a number from 1 to ${drafts.length} (see singularity-flow configuration drafts), a draft ID, or --all.`,
        'CONFIGURATION_DRAFT_UNKNOWN');
    }
    await removeDrafts(directory, removed.map((draft) => draft.draftId));
    const left = drafts.filter((draft) => !removed.includes(draft));
    return { schemaVersion: 1, resultType: 'configuration-drafts-discarded', removed: removed.map((draft) => draft.description),
      removedIds: removed.map((draft) => draft.draftId), pending: left.length, listing: draftListing(left) };
  });
}

/** Forget the last proposal once it is approved, so `approve` no longer offers it. */
export async function forgetProposal(root, branch) {
  if ((await readDrafts(root)).proposed?.branch !== branch) return;
  await withDraftStore(root, async (directory) => {
    const { proposed, revision } = await readStore(root);
    if (proposed?.branch === branch) await writeProposed(directory, revision + 1, null);
  });
}

/**
 * The drafts of one kind ('skill', 'instruction' or 'agent') as lines to print after a list of the
 * approved ones, so a draft is visible where people look for it and plainly not in use yet. Never
 * fails the list it decorates.
 */
export async function draftNotice(root, kind) {
  try {
    const drafts = await readDrafts(root);
    const mine = drafts.changes.filter((entry) => entry.change.op.startsWith(`${kind}.`));
    if (!mine.length) return { lines: [], entries: [] };
    return {
      entries: mine.map((entry) => ({ draftId: entry.draftId, state: entry.state, description: entry.description, change: entry.change })),
      lines: ['', 'Drafts, not used by any Story until approved:', ...mine.map((entry) => `  ${entry.description}`),
        'Propose them for one review: singularity-flow configuration propose']
    };
  } catch {
    return { lines: [], entries: [] };
  }
}

/** The drafts and the last proposal as lines a person reads. */
export function draftLines(drafts) {
  const lines = [];
  if (!drafts.changes.length) lines.push('No drafts. Each agent, skill or instruction change you make is saved here until you propose it.');
  else {
    lines.push(`${drafts.changes.length} draft${drafts.changes.length === 1 ? '' : 's'} saved on this machine, not used by any Story until approved:`);
    drafts.changes.forEach((entry, index) => lines.push(`  ${index + 1}. ${entry.description ?? describeChange(entry.change)}`));
    lines.push('', 'Next: singularity-flow configuration propose   (one review for all of them)');
    lines.push(`Drop one: singularity-flow configuration discard <NUMBER> --listing ${drafts.listing ?? draftListing(drafts.changes)}   (or --all)`);
  }
  if (drafts.proposed) {
    lines.push('', `Waiting for approval: ${drafts.proposed.branch}`);
    for (const change of drafts.proposed.changes ?? []) lines.push(`  - ${change}`);
    lines.push('Approve: singularity-flow configuration approve');
  }
  return lines;
}

function changedFileLine(entry) {
  if (typeof entry === 'string') return entry;
  const status = String(entry?.status ?? '').charAt(0);
  const verb = { A: 'new', M: 'changed', D: 'removed', R: 'renamed', C: 'copied' }[status] ?? 'changed';
  const paths = Array.isArray(entry?.paths) ? entry.paths : [entry?.path ?? entry?.file].filter(Boolean);
  return `${verb}: ${paths.join(' → ') || 'a file'}`;
}

/** What approving a proposal will change, in plain lines. */
export function proposalSummaryLines(reviewed) {
  const lines = [`Proposal ${reviewed.branch}${reviewed.proposalCreatedAt ? `, made ${reviewed.proposalCreatedAt.slice(0, 16).replace('T', ' ')}` : ''}:`];
  for (const workflow of reviewed.workflows ?? []) lines.push(`  Workflow ${workflow.label ?? workflow.id}: ${workflow.change}`);
  for (const entry of reviewed.changedFiles ?? []) lines.push(`  ${changedFileLine(entry)}`);
  if (!(reviewed.changedFiles ?? []).length) lines.push('  No file changes.');
  return lines;
}

/**
 * Approve one proposal: show what it changes, confirm, and activate exactly the revision shown.
 *
 * The person never copies a commit: the reviewed revision is pinned here and activation refuses if
 * the proposal moved after the summary was shown. `sflow/config` accepts the update directly unless
 * the Git host protects it, in which case the proposal is merged there and approved again to record.
 */
export async function approveProposal(root, requested, {
  yes = false, interactive = false, ask = null, print = (line) => console.log(line),
  list, inspect, activate
}) {
  const drafts = await readDrafts(root);
  let branch = requested ?? drafts.proposed?.branch ?? null;
  if (!branch) {
    const open = (await list(root)).filter((entry) => !entry.merged);
    if (!open.length) fail('No configuration proposal is waiting for approval.', 'CONFIGURATION_APPROVE_NOTHING');
    if (open.length > 1) {
      fail(`${open.length} proposals are waiting. Name the one to approve:\n${open.map((entry) => `  singularity-flow configuration approve ${entry.branch}`).join('\n')}`,
        'CONFIGURATION_APPROVE_PROPOSAL_REQUIRED', {
          proposals: open.map((entry) => entry.branch),
          recoveryCommands: open.map((entry) => `singularity-flow configuration approve ${entry.branch}`)
        });
    }
    branch = open[0].branch;
  }
  const reviewed = await inspect(root, branch);
  for (const line of proposalSummaryLines(reviewed)) print(line);
  if (reviewed.valid === false) {
    fail(`Proposal ${branch} cannot be approved: it changes files outside the configuration${reviewed.invalidFiles?.length ? ` (${reviewed.invalidFiles.join(', ')})` : ''}.`,
      'WORKFLOW_PROPOSAL_INVALID');
  }
  if (!yes) {
    if (!interactive || typeof ask !== 'function') {
      fail(`Read the summary above, then approve with: singularity-flow configuration approve ${branch} --yes`,
        'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction: `singularity-flow configuration approve ${branch} --yes` });
    }
    const answer = String(await ask('Approve these changes for new Stories? This updates sflow/config. [y/N] ') ?? '').trim();
    if (!/^y(?:es)?$/iu.test(answer)) {
      print('Nothing was approved.');
      return { schemaVersion: 1, resultType: 'configuration-approval', status: 'declined', activated: false, branch };
    }
  }
  const result = await activate(root, branch, { confirm: reviewed.proposalCommit, acknowledgeUnprotected: true });
  if (result?.activated !== false && result?.status !== 'review-required' && result?.status !== 'activation-pending') {
    await forgetProposal(root, branch);
    print('Approved. New Stories use these changes; Stories already running keep the configuration they started with.');
  } else if (result?.status === 'review-required') {
    print(`sflow/config only accepts reviewed merges here. Merge ${branch} through your Git host, then run singularity-flow configuration approve ${branch} again to record it.`);
  } else {
    print(`The approval did not complete: ${result?.failure?.message ?? 'the update was not accepted'}. Nothing else changed; retry with singularity-flow configuration approve ${branch}.`);
  }
  return { schemaVersion: 1, resultType: 'configuration-approval', ...result, branch };
}
