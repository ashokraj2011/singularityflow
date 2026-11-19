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
 *
 * A draft's relation to the approved configuration can change after it is saved, and every draft
 * keeps a correct state and a way out (SDA sweep, batch 2): one approved from another clone is
 * settled when proposed and left out of other batches; one that conflicts is named with its discard
 * route; a proposal holds its drafts (`held`) even when its upload failed, and one that is gone from
 * the remote is recorded when merged and gives its drafts back when it was closed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from './publication-storage.mjs';
import { compactCanonicalJson } from './records.mjs';
import { configurationProposalKind } from './configuration-state-contract.mjs';
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
/**
 * The changes people make one at a time from the CLI or Copilot. Imports and workflow edits keep their
 * own routes. Which agent drafts a step (`phase.agent`) is a draft like the agent itself, so an agent
 * and the steps it drafts are saved, proposed and approved together.
 */
export const DRAFTABLE_OPERATIONS = Object.freeze(['skill.create', 'skill.update', 'skill.attach', 'skill.detach', 'skill.remove',
  'instruction.create', 'instruction.update', 'instruction.remove', 'agent.create', 'agent.update', 'phase.agent']);
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
  // The same change twice in the file (an edit back to an earlier value) is two drafts: the second
  // gets the next derived ID, by its place in the file, so a resumed migration names it the same.
  const repeats = new Set();
  for (const entry of value.changes) {
    const description = typeof entry.description === 'string' ? entry.description : describeChange(entry.change);
    const operationId = freeOperationId(defaultDraftOperationId(entry.change, description), repeats);
    repeats.add(operationId);
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
    case 'phase.agent': return `Step ${change.phase} drafted by agent ${change.agent}`;
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

/**
 * What a change is about: the skill, instruction or agent it creates, edits or removes, or the one
 * attachment it adds or drops. Saving the same subject twice is two changes unless nothing came between.
 */
export function changeSubject(change) {
  const [kind, action] = String(change?.op ?? '').split('.');
  if (action === 'attach' || action === 'detach') return `attachment:${change.skill}:${change.workflow ? `workflow:${change.workflow}` : `agent:${change.agent}`}`;
  // A step has one drafting agent: choosing another for the same step is a change of the same subject.
  if (kind === 'phase' && action === 'agent') return `step-agent:${change.phase}`;
  return `${kind}:${change?.id}`;
}

/** `operationId`, or the first `operationId.N` no draft in `taken` has. */
function freeOperationId(operationId, taken) {
  if (!taken.has(operationId)) return operationId;
  for (let suffix = 2; ; suffix += 1) if (!taken.has(`${operationId}.${suffix}`)) return `${operationId}.${suffix}`;
}

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
    if (!intents.has(id)) {
      intents.set(id, { operationId: id, change, description, payloadDigest: draftPayloadDigest(change, description),
        derived: operationId == null, subject: changeSubject(change) });
    }
  });
  return [...intents.values()];
}

/**
 * Split a save into the operations already saved and those still to save; a reused ID with other bytes is refused.
 *
 * A save that names no operation is a retry only of the latest draft of its subject. An edit back to
 * an earlier value (First, Second, First) is a change: it is saved, under the next free derived ID,
 * so it is never mistaken for the first draft and dropped while the second one wins.
 */
function replayOf(drafts, intents) {
  const saved = new Map(drafts.map((draft) => [draft.operationId, draft]));
  const taken = new Set(saved.keys());
  const existing = []; const pending = [];
  for (const intent of intents) {
    if (intent.derived) {
      const latest = drafts.filter((draft) => changeSubject(draft.change) === intent.subject).at(-1);
      if (latest?.payloadDigest === intent.payloadDigest) { existing.push(latest); continue; }
      const operationId = freeOperationId(intent.operationId, taken);
      taken.add(operationId);
      pending.push({ ...intent, operationId });
      continue;
    }
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

/** A save the approved configuration already holds, with no draft waiting: nothing is saved or proposed. */
function unchangedResult(intents) {
  return {
    schemaVersion: 1, resultType: 'configuration-draft', valid: true, draft: true, changed: false, saved: 'unchanged', state: null,
    summary: [], warnings: [], problems: [], files: [],
    drafts: { pending: 0, added: [], ids: [], unchanged: intents.map((intent) => intent.description) }, nextAction: null
  };
}

/**
 * Author one agent, skill or instruction change.
 *
 * - `--dry-run` previews it on top of the saved drafts, so a change that depends on a draft checks.
 * - `--propose` proposes the saved drafts and this change as one review (see `proposeWithDrafts`).
 * - Otherwise, when an approved configuration exists, it is checked with the drafts and saved as a
 *   draft; when none exists, it is written to the working tree as before. A change the approved
 *   configuration already holds, with no draft waiting, is not saved (`saved: 'unchanged'`).
 *
 * `apply(changeSet, { dryRun, propose, subject, message })` is the CLI's normal applier and
 * `check(changeSet, { refreshAuthority })` plans against the approved configuration, returning
 * `{ plan, source }`, where `source.kind === 'working-tree'` means none was found; with
 * `refreshAuthority: false` it reads only what this machine holds (see `checkForSave`).
 * `planner(work, { refreshAuthority })` runs `work(plan)` in one read of the approved configuration,
 * for checking the drafts one by one when a proposal is refused.
 * `operationId` names the save (default: derived from the change), so a retry returns the draft
 * already saved (`saved: 'existing'`) and a different change under that ID is refused.
 */
export async function authorChange(root, changeSet, { dryRun = false, propose = false, subject, message, apply, check, planner = null, operationId = null }) {
  if (!changeSet.changes.every((change) => DRAFTABLE.has(change.op))) return apply(changeSet, { dryRun, propose, subject, message });
  let drafts = await readDrafts(root);
  const included = drafts.changes.length;
  if (dryRun) {
    // A draft that no longer applies is left out of the preview, and named, rather than failing it.
    const preview = await runWithDrafts(root, changeSetOf(changeSet.changes), (set) => apply(set, { dryRun: true, subject, message }), { planner, preview: true });
    return withDrafts(leftOutWarnings(preview.result, preview.leftOut), { pending: included, included: preview.included.length });
  }
  if (propose) return proposeWithDrafts(root, drafts, changeSet.changes, { apply, planner, subject, message });
  const intents = saveIntents(changeSet.changes, operationId);
  let replay = replayOf(drafts.changes, intents);
  if (!replay.pending.length) return savedResult({ added: replay.existing, pending: drafts.changes.length, saved: 'existing' });
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const changes = replay.pending.map((intent) => intent.change);
    let { plan, source, record } = await checkForSave(check, combine(drafts.changes, changes), drafts.authority);
    if (!approvedSource(source)) return apply(changeSet, { subject, message });
    // A draft approved elsewhere or in conflict must not block saving another change: this one is
    // checked without it, and the save names it.
    const leftOut = plan?.valid === false && drafts.changes.length && planner ? await staleDrafts(drafts, planner) : [];
    if (leftOut.length) {
      ({ plan, source, record } = await checkForSave(check,
        combine(drafts.changes.filter((entry) => !leftOut.some((out) => out.draftId === entry.draftId)), changes), drafts.authority));
      if (!approvedSource(source)) return apply(changeSet, { subject, message });
      if (plan?.valid !== false) plan = leftOutWarnings(plan, leftOut);
    }
    if (plan?.valid === false) return withDrafts(plan, { pending: drafts.changes.length, included: drafts.changes.length });
    // Checked against the approved configuration itself (not this checkout's), it changes nothing
    // there: an edit or create already approved, say from a backup of a draft approved since.
    if (!drafts.changes.length && plan?.changed === false && source.kind !== CHECKOUT_SOURCE.kind) return unchangedResult(replay.pending);
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

/** How a waiting draft stands against the approved configuration (`draftStandings`). */
export const DRAFT_STANDINGS = Object.freeze(['waiting', 'already-approved', 'redundant', 'conflicts']);

/**
 * A command's save that did not check is refused, as the same change is without an approved
 * configuration: a non-zero exit naming the problem, not a list of files that were never written.
 * `authorChange` itself returns it (`valid: false`), which backup restore reports per draft.
 */
export function refuseUncheckedSave(result, { dryRun = false } = {}) {
  if (dryRun || result?.valid !== false) return result;
  const problems = result.problems ?? [];
  return fail(`This change was not saved: ${problems[0]?.message ?? 'it does not check against the approved configuration.'} Nothing was written.`,
    'STUDIO_CHANGES_INVALID', { problems });
}

/**
 * A create as the edit that makes an existing subject exactly what the create would write: every
 * field the create leaves to its default is that default, not the existing value. Null for a change
 * with no such edit.
 */
async function asReplacement(change) {
  if (change.op === 'instruction.create') return { ...change, op: 'instruction.update', label: change.label, tags: change.tags };
  if (change.op !== 'skill.create') return null;
  const { defaultSkillLabel } = await import('./skill-library.mjs');
  return { ...change, op: 'skill.update', label: change.label ?? defaultSkillLabel(change.id), loading: change.loading ?? 'eager',
    instructionRefs: change.instructionRefs ?? [] };
}
const changeSetOf = (changes) => ({ schema: CHANGE_SET_SCHEMA, changes });
// What a plan writes, comparable across plans; null when it does not check.
const planFiles = (plan) => (plan?.valid === false ? null
  : JSON.stringify((plan?.files ?? []).map((file) => [file.path, file.action, file.diff ?? '']).sort(([left], [right]) => left.localeCompare(right))));

/**
 * How each draft stands against the approved configuration, in order, each checked with the waiting
 * drafts before it. `plan(changeSet)` plans a change set against the approved configuration.
 *
 * - `waiting`: it still changes something there;
 * - `already-approved`: it changes nothing there: an edit approved from another clone, or a create
 *   whose subject now exists saying what the draft says;
 * - `redundant`: it changes nothing the waiting drafts before it do not already change;
 * - `conflicts`: it cannot be applied there, and `problem` says why: a create whose subject now exists
 *   with other content, or an edit or removal of something that is gone.
 */
export async function draftStandings(entries, plan) {
  const standings = []; const kept = [];
  const nothing = planFiles({ files: [] });
  let before = nothing;
  for (const [index, entry] of entries.entries()) {
    const base = { draftId: entry.draftId, number: index + 1, description: entry.description ?? describeChange(entry.change) };
    const after = await plan(changeSetOf([...kept, entry.change]));
    const files = planFiles(after);
    if (files !== null) {
      if (files !== before) { kept.push(entry.change); before = files; standings.push({ ...base, standing: 'waiting' }); continue; }
      const alone = kept.length ? planFiles(await plan(changeSetOf([entry.change]))) : nothing;
      standings.push({ ...base, standing: alone === nothing ? 'already-approved' : 'redundant' });
      continue;
    }
    const replacement = await asReplacement(entry.change);
    const replaced = replacement ? planFiles(await plan(changeSetOf([...kept, replacement]))) : null;
    if (replaced !== null && replaced === before) {
      standings.push({ ...base, standing: 'already-approved' });
      continue;
    }
    const problem = String(after?.problems?.[0]?.message ?? 'It no longer applies to the approved configuration.');
    standings.push({ ...base, standing: 'conflicts',
      problem: replaced === null ? problem : `${problem.replace(/\.$/u, '')}, with other content than this draft.` });
  }
  return standings;
}

/** The exact way to drop one listed draft: by its number while it is the only one, else by its ID. */
function discardRoute(entry, listing, several) {
  return several ? `singularity-flow configuration discard ${entry.draftId}` : `singularity-flow configuration discard ${entry.number} --listing ${listing}`;
}

/** Refuse a proposal one or more drafts no longer apply to, naming each with its discard route. */
function conflictRefusal(standings, listing, cause = null) {
  const conflicts = standings.filter((entry) => entry.standing === 'conflicts');
  const several = conflicts.length > 1;
  const routes = conflicts.map((entry) => discardRoute(entry, listing, several));
  const lines = conflicts.map((entry, index) => `  ${entry.number}. ${entry.description}: ${entry.problem}\n     Discard it: ${routes[index]}`);
  return fail(`${several ? `${conflicts.length} saved drafts no longer apply` : 'A saved draft no longer applies'} to the approved configuration, so nothing was proposed:\n${lines.join('\n')}\n`
    + `Discard ${several ? 'them' : 'it'}, or save a change that applies, then propose again. See every draft: singularity-flow configuration drafts`,
  'STUDIO_CHANGES_INVALID', { problems: cause?.details?.problems ?? [], listing,
    conflicts: conflicts.map(({ draftId, number, description, problem }, index) => ({ draftId, number, description, problem, discard: routes[index] })),
    nextAction: { command: routes[0], label: `Discard draft ${conflicts[0].number} (${conflicts[0].description}), which no longer applies.` },
    recoveryCommands: [...conflicts.slice(1).map((entry, index) => ({ command: routes[index + 1],
      label: `Discard draft ${entry.number} (${entry.description}), which no longer applies.` })),
    { command: 'singularity-flow configuration drafts', label: 'See every draft and how it stands against the approved configuration.' }] });
}

/** A draft as a proposal holds it, so a proposal that is gone without approval can give it back. */
const heldRecord = ({ draftId, operationId, payloadDigest, sequence, addedAt, description, change, checkedAgainst }) => (
  { draftId, operationId, payloadDigest, sequence, addedAt, description, change, checkedAgainst: checkedAgainst ?? null });

/** What a batch holds of the drafts: their IDs, every change's line, and the drafts themselves. */
const holding = (entries, changes) => ({ draftIds: entries.map((entry) => entry.draftId),
  changes: changes.map((change) => describeChange(change)), held: entries });

/**
 * A proposal whose upload was refused or failed is retained, and its sync publishes it: it holds its
 * drafts all the same, so they are not offered again while it waits, and approving it finishes them.
 */
async function holdForUpload(root, error, held, settled = []) {
  const details = error?.details;
  if (error?.code !== 'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING' || !details?.branch || !held.draftIds.length) return;
  try {
    await recordProposal(root, { branch: details.branch, commit: details.commit ?? null }, {
      ...held, upload: details.intentId ? { intentId: details.intentId } : null }, settled);
  } catch { /* the refusal says what happened; the drafts stay waiting */ }
}

/** Drop drafts the approved configuration already holds; returns how many are left waiting. */
async function settleApproved(root, settled) {
  if (!settled.length) return (await readDrafts(root)).changes.length;
  return withDraftStore(root, async (directory) => {
    const { drafts } = await readStore(root);
    const gone = new Set(settled.map((draft) => draft.draftId));
    await removeDrafts(directory, drafts.filter((draft) => gone.has(draft.draftId)).map((draft) => draft.draftId));
    return drafts.filter((draft) => !gone.has(draft.draftId)).length;
  });
}

/**
 * Propose the waiting drafts, and `changes` after them, as one review.
 *
 * A draft approved from another clone since it was saved is not proposed again. A batch that changes
 * nothing in the approved configuration settles every draft in it (`drafts.nothingToPropose`). A batch
 * refused because something no longer applies is checked draft by draft (`planner`): the drafts
 * already approved are settled and the rest proposed; a draft that conflicts is named with its discard
 * route and nothing is proposed. A proposal whose upload failed holds its drafts all the same.
 */
async function proposeWithDrafts(root, drafts, changes, { apply, planner = null, subject = null, message = null, overrideMessage = null }) {
  let entries = drafts.changes;
  const settled = [];
  for (let attempt = 0; ; attempt += 1) {
    const combined = combine(entries, changes);
    const held = holding(entries, combined.changes);
    const report = (pending) => ({ pending, included: entries.length, settled: settled.map((draft) => draft.description) });
    if (!combined.changes.length) {
      return { schemaVersion: 1, resultType: 'configuration-drafts-settled', valid: true, changed: false, reviewRequired: false,
        summary: [], warnings: [], problems: [], files: [], nextAction: null,
        drafts: { ...report(await settleApproved(root, settled)), nothingToPropose: true } };
    }
    const first = combined.changes[0];
    const identity = batchIdentity(combined.changes, subject ?? first.id ?? first.skill ?? 'change', message ?? `[configuration] ${describeChange(first)}`);
    let result;
    try { result = await apply(combined, { propose: true, ...identity, ...(overrideMessage ? { message: overrideMessage } : {}) }); }
    catch (error) {
      await holdForUpload(root, error, held, settled);
      const review = attempt === 0 && entries.length && planner && error?.code === 'STUDIO_CHANGES_INVALID'
        ? await planner((plan) => draftStandings(entries, plan)).catch(() => null) : null;
      if (!review) throw error;
      if (review.some((entry) => entry.standing === 'conflicts')) conflictRefusal(review, drafts.listing, error);
      const approved = new Set(review.filter((entry) => entry.standing === 'already-approved').map((entry) => entry.draftId));
      if (!approved.size) throw error;
      settled.push(...entries.filter((entry) => approved.has(entry.draftId)));
      entries = entries.filter((entry) => !approved.has(entry.draftId));
      continue;
    }
    if (result?.reviewRequired && result.branch) return withDrafts(approvalNext(result), report(await recordProposal(root, result, held, settled)));
    if (result && result.valid !== false && result.changed === false) {
      // The approved configuration already holds everything in the batch: nothing was proposed.
      settled.push(...entries);
      return withDrafts({ ...result, nextAction: null }, { ...report(await settleApproved(root, settled)), nothingToPropose: true });
    }
    return withDrafts(approvalNext(result), report(settled.length ? await settleApproved(root, settled) : drafts.changes.length));
  }
}

/**
 * Record a proposal holding exactly `draftIds` (with the drafts themselves, `held`), then remove those
 * drafts and any `settled` ones; one saved meanwhile keeps waiting. The proposal is written first, so a
 * crash in between leaves drafts it already holds, which are hidden at once and removed by the next
 * change to the store. `upload` names a retained upload still to finish. Returns the drafts left.
 */
async function recordProposal(root, result, { draftIds, changes, held = [], upload = null }, settled = []) {
  return withDraftStore(root, async (directory) => {
    const { drafts, revision } = await readStore(root);
    await writeProposed(directory, revision + 1, {
      branch: result.branch, commit: result.commit ?? result.proposalRevision ?? null,
      at: new Date().toISOString(), changes, draftIds, held: held.map(heldRecord), ...(upload ? { upload } : {})
    });
    const gone = new Set([...draftIds, ...settled.map((draft) => draft.draftId)]);
    await removeDrafts(directory, drafts.filter((draft) => gone.has(draft.draftId)).map((draft) => draft.draftId));
    return drafts.filter((draft) => !gone.has(draft.draftId)).length;
  });
}

/**
 * A change set with the saved drafts in front, for surfaces that build their own batch: what they
 * publish carries every waiting draft, so pending work still gets one review. `draftIds` names
 * exactly the drafts included, for `settleDrafts`. `runWithDrafts` also keeps a stale draft from
 * blocking the batch.
 */
export async function withSavedDrafts(root, changeSet) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) return { changeSet, included: [], draftIds: [] };
  return { included: drafts.changes.map((entry) => entry.description ?? describeChange(entry.change)),
    draftIds: drafts.changes.map((entry) => entry.draftId), held: drafts.changes,
    changeSet: { ...changeSet, changes: [...drafts.changes.map((entry) => entry.change), ...(changeSet.changes ?? [])] } };
}

/** After a batch carrying the drafts `draftIds` was proposed or written, exactly those are no longer waiting. */
export async function settleDrafts(root, result, { included = [], draftIds = [], held = [] } = {}, settled = []) {
  if (!draftIds.length && !settled.length) return;
  if (result?.reviewRequired && result.branch) await recordProposal(root, result, { draftIds, changes: included, held }, settled);
  else if (result && result.valid !== false) await settleApproved(root, [...draftIds.map((draftId) => ({ draftId })), ...settled]);
}

/**
 * Run a batch a surface builds itself (Workflow Studio, `workflow check`) with the waiting drafts in
 * front: `perform(changeSet)` previews, proposes or writes it. A draft must not block an unrelated batch:
 * when the batch is refused or does not check, the drafts are checked one by one (`planner`), those
 * already approved and those that conflict are left out, and the batch runs again without them. Each
 * draft left out is returned (`leftOut`) with why and, when it conflicts, its discard route; it stays
 * waiting, unless it is already approved and the batch was applied (`preview: false`), which settles it.
 */
export async function runWithDrafts(root, changeSet, perform, { planner = null, preview = false } = {}) {
  const drafts = await readDrafts(root);
  let entries = drafts.changes;
  let leftOut = [];
  for (let attempt = 0; ; attempt += 1) {
    const batch = { ...changeSet, changes: [...entries.map((entry) => entry.change), ...(changeSet.changes ?? [])] };
    const held = holding(entries, entries.map((entry) => entry.change));
    const approved = drafts.changes.filter((entry) => leftOut.some((out) => out.draftId === entry.draftId && out.standing === 'already-approved'));
    let result = null; let refusal = null;
    try { result = await perform(batch); }
    catch (error) {
      if (!preview) await holdForUpload(root, error, held, approved);
      refusal = error;
    }
    const refused = refusal ? refusal.code === 'STUDIO_CHANGES_INVALID' : result?.valid === false;
    if (refused && attempt === 0 && entries.length && planner) {
      const out = await staleDrafts(drafts, planner);
      if (out.length) {
        leftOut = out;
        entries = entries.filter((entry) => !out.some((skip) => skip.draftId === entry.draftId));
        continue;
      }
    }
    if (refusal) throw refusal;
    if (!preview && result && result.valid !== false) await settleDrafts(root, result, held, approved);
    return { result, included: held.changes, leftOut };
  }
}

/** The waiting drafts that no longer apply (approved elsewhere or in conflict), each with its discard route when it conflicts. */
async function staleDrafts(drafts, planner) {
  const review = await planner((plan) => draftStandings(drafts.changes, plan)).catch(() => null);
  const out = (review ?? []).filter((entry) => entry.standing === 'already-approved' || entry.standing === 'conflicts');
  const several = out.filter((entry) => entry.standing === 'conflicts').length > 1;
  return out.map((entry) => ({ ...entry, ...(entry.standing === 'conflicts' ? { discard: discardRoute(entry, drafts.listing, several) } : {}) }));
}

/** A plan with each draft left out of it named as a warning, as every surface shows warnings. */
export function leftOutWarnings(plan, leftOut) {
  if (!leftOut.length || !plan || typeof plan !== 'object') return plan;
  return { ...plan, warnings: [...(plan.warnings ?? []), ...leftOut.map((entry) => ({ code: 'CONFIGURATION_DRAFT_LEFT_OUT', message: leftOutLine(entry),
    draft: { draftId: entry.draftId, number: entry.number, standing: entry.standing, discard: entry.discard ?? null } }))] };
}

/** A draft left out of a batch, as a line a person reads. */
export function leftOutLine(entry) {
  return entry.standing === 'conflicts'
    ? `Draft ${entry.number}, ${entry.description}, was left out: ${entry.problem} It stays waiting; discard it: ${entry.discard}`
    : `Draft ${entry.number}, ${entry.description}, was left out: the approved configuration already has it.`;
}

/** Propose every saved draft as one review (see `proposeWithDrafts`). */
export async function proposeDrafts(root, { apply, planner = null, message = null }) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) {
    fail(drafts.proposed
      ? `No drafts are waiting. Your last proposal, ${drafts.proposed.branch}, is ready for approval: singularity-flow configuration approve`
      : 'No drafts are waiting. Create or edit an agent, skill or instruction first; each change is saved as a draft.',
    'CONFIGURATION_DRAFTS_EMPTY',
    drafts.proposed ? { nextAction: `singularity-flow configuration approve ${drafts.proposed.branch}` } : null);
  }
  return proposeWithDrafts(root, drafts, [], { apply, planner, overrideMessage: message });
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

const validHeld = (entry) => Boolean(entry) && typeof entry === 'object' && DRAFTABLE.has(entry.change?.op)
  && typeof entry.description === 'string' && typeof entry.operationId === 'string' && OPERATION_ID.test(entry.operationId)
  && Number.isSafeInteger(entry.sequence) && entry.sequence >= 0 && (entry.addedAt === null || typeof entry.addedAt === 'string')
  && entry.payloadDigest === draftPayloadDigest(entry.change, entry.description);

/**
 * Forget the last proposal, which is gone without being approved, and give back the drafts it held
 * as waiting again. The drafts are written before the proposal is forgotten, so a crash in between
 * leaves both; doing it again repeats no draft. Returns the lines of the drafts given back.
 */
async function restoreProposal(root, branch) {
  return withDraftStore(root, async (directory) => {
    const store = await readStore(root);
    if (store.proposed?.branch !== branch) return { restored: [], pending: store.drafts.length };
    const taken = new Set(store.drafts.map((draft) => draft.operationId));
    const restored = [];
    for (const entry of (Array.isArray(store.proposed.held) ? store.proposed.held : []).filter(validHeld)) {
      // Given back already (an earlier attempt stopped before forgetting the proposal), or saved again since.
      if (store.drafts.some((draft) => draft.payloadDigest === entry.payloadDigest
        && (draft.operationId === entry.operationId || draft.operationId.startsWith(`${entry.operationId}.`)))) continue;
      const operationId = freeOperationId(entry.operationId, taken);
      taken.add(operationId);
      restored.push(await writeDraft(directory, { operationId, change: entry.change, description: entry.description,
        sequence: entry.sequence, addedAt: entry.addedAt, checkedAgainst: entry.checkedAgainst ?? null }));
    }
    await writeProposed(directory, store.revision + 1, null);
    return { restored: restored.map((draft) => draft.description), pending: store.drafts.length + restored.length };
  });
}

// An upload a sync can still finish: retained, and not refused for good.
const UPLOAD_RETRYABLE = new Set(['pending', 'pushing', 'outcome-unknown', 'needs-user', 'attempt-budget-exhausted']);

/**
 * The proposal this machine recorded is no longer on the remote. Merged into sflow/config through
 * the Git host, which then deleted its branch: it is recorded as approved and forgotten. Not merged:
 * an upload a sync can still finish is finished first; otherwise the proposal is forgotten and the
 * drafts it held are waiting again, to propose anew. `status(root, branch, commit)` reads whether
 * the exact proposal commit reached sflow/config; `upload(intentId)` reads a retained upload.
 */
async function settleGoneProposal(root, proposed, { status, upload, print }) {
  const { branch, commit } = proposed;
  const seen = commit ? await status(root, branch, commit) : null;
  if (seen?.merged) {
    await forgetProposal(root, branch);
    print(`Proposal ${branch} was merged into ${seen.targetBranch ?? 'sflow/config'} through your Git host, which then removed its branch. Recorded as approved: new Stories use these changes; Stories already running keep the configuration they started with.`);
    return { schemaVersion: 1, resultType: 'configuration-approval', status: 'merged', activated: true, branch,
      proposalCommit: commit, targetCommit: seen.targetCommit ?? null };
  }
  const intentId = proposed.upload?.intentId ?? null;
  if (intentId && typeof upload === 'function') {
    const intent = await upload(intentId).catch(() => null);
    if (UPLOAD_RETRYABLE.has(intent?.status)) {
      fail(`Proposal ${branch} has not been uploaded yet, so there is nothing to approve. Finish its upload: singularity-flow sync ${intentId}, then approve it.`,
        'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING', { branch, commit, intentId, status: intent.status,
          nextAction: `singularity-flow sync ${intentId}`, recoveryCommands: [`singularity-flow push status ${intentId}`] });
    }
  }
  const { restored, pending } = await restoreProposal(root, branch);
  const back = restored.length
    ? ` The ${restored.length === 1 ? 'draft it held is' : `${restored.length} drafts it held are`} waiting again: ${restored.join('; ')}.`
    : ` Its changes were: ${(proposed.changes ?? []).join('; ') || 'not recorded here'}; save them again to propose them.`;
  return fail(`Proposal ${branch} is no longer on the remote and its changes are not in sflow/config, so there is nothing to approve.${back} `
    + `Propose ${pending ? 'the waiting drafts' : 'your changes'} again: singularity-flow configuration propose`,
  'CONFIGURATION_APPROVE_NOTHING', { branch, restored, pending, nextAction: 'singularity-flow configuration propose' });
}

/**
 * The drafts of one kind ('skill', 'instruction' or 'agent') as lines to print after a list of the
 * approved ones, so a draft is visible where people look for it and plainly not in use yet. Never
 * fails the list it decorates, and never hides drafts without a word: a store this build cannot
 * read is named, with the way to read it.
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
  } catch (error) {
    const newer = error?.code === 'SCHEMA_VERSION_FUTURE';
    const nextAction = newer ? 'singularity-flow product status' : 'singularity-flow configuration drafts';
    return { lines: ['', `Drafts saved on this machine are not shown: ${error?.message ?? error}`, `See why: ${nextAction}`], entries: [],
      unavailable: { code: error?.code ?? 'CONFIGURATION_DRAFTS_INVALID', message: String(error?.message ?? error), nextAction } };
  }
}

const STANDING_NOTE = Object.freeze({
  'already-approved': 'already approved: the approved configuration has it, so proposing settles it',
  redundant: 'changes nothing the drafts above it do not'
});

/**
 * The drafts and the last proposal as lines a person reads. `standings` (from `draftStandings`), when
 * known, say how each draft stands against the approved configuration, with the way out of a conflict;
 * `uploadFinished` says a proposal whose upload failed has been uploaded since.
 */
export function draftLines(drafts, standings = null, { uploadFinished = false } = {}) {
  const lines = [];
  const listing = drafts.listing ?? draftListing(drafts.changes);
  const known = new Map((standings ?? []).map((entry) => [entry.draftId, entry]));
  const conflicts = (standings ?? []).filter((entry) => entry.standing === 'conflicts');
  if (!drafts.changes.length) lines.push('No drafts. Each agent, skill or instruction change you make is saved here until you propose it.');
  else {
    lines.push(`${drafts.changes.length} draft${drafts.changes.length === 1 ? '' : 's'} saved on this machine, not used by any Story until approved:`);
    drafts.changes.forEach((entry, index) => {
      const standing = known.get(entry.draftId);
      lines.push(`  ${index + 1}. ${entry.description ?? describeChange(entry.change)}${STANDING_NOTE[standing?.standing] ? ` (${STANDING_NOTE[standing.standing]})` : ''}`);
      if (standing?.standing === 'conflicts') {
        lines.push(`     Conflicts with the approved configuration: ${standing.problem}`);
        lines.push(`     Discard it: ${discardRoute(standing, listing, conflicts.length > 1)}`);
      }
    });
    lines.push('', conflicts.length
      ? `Next: discard or replace the draft${conflicts.length === 1 ? '' : 's'} that conflict, then singularity-flow configuration propose`
      : 'Next: singularity-flow configuration propose   (one review for all of them)');
    lines.push(`Drop one: singularity-flow configuration discard <NUMBER> --listing ${listing}   (or --all)`);
  }
  if (drafts.proposed) {
    lines.push('', `Waiting for approval: ${drafts.proposed.branch}`);
    for (const change of drafts.proposed.changes ?? []) lines.push(`  - ${change}`);
    lines.push(`Approve: singularity-flow configuration approve ${drafts.proposed.branch}`);
    if (drafts.proposed.upload?.intentId && !uploadFinished) lines.push(`Its upload has not finished; finish it first: singularity-flow sync ${drafts.proposed.upload.intentId}`);
  }
  return lines;
}

const SHOWN_FILE = 'approval-shown.json';
const SHOWN_SCHEMA = 'sflow-configuration-approval-shown@1';
const SHOWN_LIMIT = 50;

/** The proposal revision this machine last showed for `branch` with `configuration approve`, or null. */
async function shownRevision(root, branch) {
  try {
    const value = await readJson(path.join(draftsDirectory(root), SHOWN_FILE));
    const entry = value?.schema === SHOWN_SCHEMA ? value.shown?.[branch] : null;
    return typeof entry?.proposalCommit === 'string' ? entry.proposalCommit : null;
  } catch { return null; }
}

/** Remember that `configuration approve` showed this revision, so `--yes` approves only it (finding ER-F6). */
async function recordShown(root, branch, proposalCommit) {
  try {
    await withDraftStore(root, async (directory) => {
      let value = null;
      try { value = await readJson(path.join(directory, SHOWN_FILE)); } catch { value = null; }
      const shown = value?.schema === SHOWN_SCHEMA && value.shown && typeof value.shown === 'object' ? { ...value.shown } : {};
      delete shown[branch];
      shown[branch] = { proposalCommit, at: new Date().toISOString() };
      const kept = Object.entries(shown).slice(-SHOWN_LIMIT);
      await publishFile(directory, SHOWN_FILE, `${JSON.stringify({ schema: SHOWN_SCHEMA, shown: Object.fromEntries(kept) }, null, 2)}\n`, { replace: true });
    });
  } catch { /* the record only lets --yes follow a view; --confirm <revision> never needs it */ }
}

/** The approve command for exactly the revision shown, with a pick for each field still to choose. */
function approveCommand(branch, commit, clashes = [], choices = new Map()) {
  const picks = [...choices].map(([key, pick]) => ` --pick '${key}=${pick}'`).join('')
    + clashes.filter((clash) => !choices.has(clash.key)).map((clash) => ` --pick '${clash.key}=<proposal|current>'`).join('');
  return `singularity-flow configuration approve ${branch} --confirm ${commit}${picks}`;
}

async function askPicks(clashes, ask, print) {
  const choices = new Map();
  for (const [index, clash] of clashes.entries()) {
    for (;;) {
      const answer = String(await ask(`Choice ${index + 1} (${clash.key}): keep [p] this proposal's value or [c] sflow/config's value? `) ?? '').trim().toLowerCase();
      if (/^p(?:roposal)?$/u.test(answer)) { choices.set(clash.key, 'proposal'); break; }
      if (/^c(?:urrent)?$/u.test(answer)) { choices.set(clash.key, 'current'); break; }
      if (!answer) return null;
      print('Answer p or c, or press Enter to stop without approving.');
    }
  }
  return choices;
}

/**
 * Approve one proposal: show what it lands, confirm, and activate exactly the revision shown
 * [SCF:REQ-006, REQ-007, REQ-008].
 *
 * The approval names the revision the approver was shown: `--confirm <revision>` (the same on every
 * surface), a yes in the terminal right after the view, or `--yes`, which approves only the revision
 * this machine last showed for that proposal. A proposal that moved since is refused and shown again.
 * A field both this proposal and `sflow/config` changed is the approver's pick (`--pick
 * <file>#<field>=proposal|current`, or asked in the terminal); the pick is part of the approval.
 * `sflow/config` accepts the update directly unless the Git host protects it, in which case the
 * proposal is merged there and approved again to record. Running approve again on an approved proposal
 * finishes whatever an interruption left [SCF:REQ-009].
 */
export async function approveProposal(root, requested, {
  yes = false, confirm = null, choices = null, interactive = false, ask = null, print = (line) => console.log(line),
  list, inspect, activate, status = null, upload = null, finish = null, identity = null
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
  let picks = new Map(choices instanceof Map ? choices : Object.entries(choices ?? {}));
  let reviewed;
  try { reviewed = await inspect(root, branch, picks.size ? { choices: picks } : undefined); }
  catch (error) {
    if (error?.code !== 'WORKFLOW_PROPOSAL_UNAVAILABLE') throw error;
    // The proposal recorded here is gone: merged and deleted by the Git host, or closed (SDA sweep C6).
    if (drafts.proposed?.branch === branch && typeof status === 'function') return settleGoneProposal(root, drafts.proposed, { status, upload, print });
    // Approved already, and an interruption left its finishing on this machine [SCF:REQ-009].
    const finished = typeof finish === 'function' ? await finish(root, branch) : null;
    if (!finished) throw error;
    print(`Proposal ${branch} was already approved; finished what was left: ${finished.status}.`);
    return { schemaVersion: 1, resultType: 'configuration-approval', ...finished, branch };
  }
  let approver = null;
  try { approver = typeof identity === 'function' ? identity(root) : null; } catch { approver = null; }
  const { proposalViewLines } = await import('./configuration-approval-view.mjs');
  const show = (shown) => { for (const line of proposalViewLines(shown, { approver })) print(line); };
  show(reviewed);
  // One policy for every approval [SCF:REQ-011, D4]: refused before anyone is asked to confirm or sign.
  if (reviewed.approvalPolicy?.allowSelfApproval === false && !reviewed.merged && approver?.email && reviewed.proposer?.email
      && approver.email.trim().toLowerCase() === reviewed.proposer.email.trim().toLowerCase()) {
    const { selfApprovalRefusalWords } = await import('./config-approvers.mjs');
    fail(`You proposed ${branch}, and this repository needs another person to approve configuration changes (approvalSecurity.allowSelfApproval is false). Nothing was approved; ask someone who may approve configuration to run: singularity-flow configuration approve ${branch}.`
      + selfApprovalRefusalWords(reviewed.approvalPolicy?.approvers, approver),
      'CONFIGURATION_SELF_APPROVAL_REFUSED', { nextAction: { label: 'Another person approves it', command: `singularity-flow configuration approve ${branch}` } });
  }
  if (reviewed.valid === false) {
    fail(`Proposal ${branch} cannot be approved: ${reviewed.failure?.message ?? `it changes files outside the configuration${reviewed.invalidFiles?.length ? ` (${reviewed.invalidFiles.join(', ')})` : ''}`}`,
      reviewed.failure?.code ?? 'WORKFLOW_PROPOSAL_INVALID');
  }
  const revision = reviewed.proposalCommit;
  const clashes = () => reviewed.lands?.clashes ?? [];
  // A pick for a field that is not one both changed: what it would land is not what was shown.
  if ((reviewed.lands?.unused ?? []).length) {
    const nextAction = approveCommand(branch, revision, clashes(), new Map([...picks].filter(([key]) => !reviewed.lands.unused.includes(key))));
    fail(`A pick names a field this proposal and sflow/config did not both change: ${reviewed.lands.unused.join(', ')}. Nothing was approved; approve what is shown above: ${nextAction}`,
      'CONFIGURATION_CHOICE_STALE', { nextAction, unused: reviewed.lands.unused });
  }
  if (confirm != null || yes) {
    // The revision the approver was shown: named, or the one this machine last showed.
    const named = confirm != null ? String(confirm).trim() : await shownRevision(root, branch);
    if (named !== revision) {
      await recordShown(root, branch, revision);
      const nextAction = approveCommand(branch, revision, clashes(), picks);
      fail(named
        ? `Proposal ${branch} changed after you were shown it, so nothing was approved. Read it again above, then approve what it shows now: ${nextAction}`
        : `Read what approving it changes above, then approve exactly this revision: ${nextAction} (or --yes, which approves only the revision shown here).`,
      named ? 'CONFIGURATION_APPROVE_PROPOSAL_MOVED' : 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction, shown: revision });
    }
  } else if (!interactive || typeof ask !== 'function') {
    await recordShown(root, branch, revision);
    const nextAction = approveCommand(branch, revision, clashes(), picks);
    fail(`Read what approving it changes above, then approve exactly this revision: ${nextAction} (or --yes, which approves only the revision shown here).`,
      'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction, shown: revision });
  } else {
    if (clashes().length) {
      const asked = await askPicks(clashes(), ask, print);
      if (!asked) { print('Nothing was approved.'); return { schemaVersion: 1, resultType: 'configuration-approval', status: 'declined', activated: false, branch }; }
      picks = new Map([...picks, ...asked]);
      reviewed = await inspect(root, branch, { choices: picks });
      if (reviewed.proposalCommit !== revision) {
        await recordShown(root, branch, reviewed.proposalCommit);
        fail(`Proposal ${branch} changed while you were choosing, so nothing was approved. Look at it again: singularity-flow configuration approve ${branch}`,
          'CONFIGURATION_APPROVE_PROPOSAL_MOVED', { nextAction: `singularity-flow configuration approve ${branch}` });
      }
      show(reviewed);
    }
    const answer = String(await ask('Approve these changes for new Stories? This updates sflow/config. [y/N] ') ?? '').trim();
    if (!/^y(?:es)?$/iu.test(answer)) {
      print('Nothing was approved.');
      return { schemaVersion: 1, resultType: 'configuration-approval', status: 'declined', activated: false, branch };
    }
  }
  if (clashes().length) {
    const nextAction = approveCommand(branch, revision, clashes(), picks);
    fail(`Proposal ${branch} needs a choice for ${clashes().length === 1 ? 'one field' : `${clashes().length} fields`} both it and sflow/config changed, so nothing was approved. Keep one value for each: ${nextAction}`,
      'CONFIGURATION_APPROVE_CHOICE_REQUIRED', { nextAction, clashes: clashes().map((clash) => clash.key) });
  }
  // SF Guard (SPEC-PSS-v1 §10.9): the approver's one touch over the exact proposal, before anything moves.
  const approval = await (await import('./presence/configuration-seal.mjs')).signConfigurationApproval(root, { ...reviewed, branch });
  const kind = configurationProposalKind(branch);
  const result = await activate(root, branch, { confirm: revision, acknowledgeUnprotected: true, ...(picks.size ? { choices: picks } : {}) });
  if (result?.activated !== false && result?.status !== 'review-required' && result?.status !== 'activation-pending') {
    await forgetProposal(root, branch);
    print(approvedWords(kind));
    if (result?.approval?.selfApproved) print('Recorded as a self-approval: you proposed it and approved it.');
    const back = (result?.approval?.readmitted ?? []).map((group) => group.id);
    if (back.length) print(`This put you back in ${back.join(', ')} (an earlier approved change removed you). As the workflow's creator you approved it yourself; the approval commit records it.`);
    if (approval?.unsigned) {
      print(`SF Guard: approved without a signature, because ${approval.unsigned}. Anyone with access to this repository can change the configuration, so this holds nothing back; guard status shows the commit as unsigned.`);
      result.presence = { status: 'unsigned', reason: approval.unsigned };
    } else if (approval) {
      const sealed = await (await import('./presence/configuration-seal.mjs')).publishConfigurationSeal(root, approval);
      result.presence = { status: sealed.status, path: sealed.path };
      if (sealed.status === 'failed') print(`SF Guard: ${sealed.message}.`);
    }
  } else if (result?.status === 'review-required') {
    print(`sflow/config only accepts reviewed merges here. Merge ${branch} through your Git host, then run singularity-flow configuration approve ${branch} again to record it.`);
  } else {
    print(`The approval did not complete: ${result?.failure?.message ?? 'the update was not accepted'}. Nothing else changed; retry with singularity-flow configuration approve ${branch}.`);
  }
  return { schemaVersion: 1, resultType: 'configuration-approval', kind, ...result, branch };
}

/** What an approval says it approved: its proposal's kind, as `configuration proposals` lists it [SCF:REQ-010, REQ-012]. */
const KIND_WORDS = Object.freeze({ workflow: 'Workflow', people: 'People', package: 'Package', capability: 'Capability', setup: 'Repository setup' });
export const approvedWords = (kind) => `${KIND_WORDS[kind] ?? 'Configuration'} ${KIND_WORDS[kind] ? 'configuration ' : ''}approved. `
  + 'New Stories use these changes; Stories already running keep the configuration they started with.';

/**
 * Reject a proposal, with a reason, or withdraw one's own [SCF:REQ-009]: show it, bind the decision to
 * the revision shown (`--confirm <revision>`, or `--yes` for the revision this machine last showed),
 * record who rejected it and why on the state branch, then remove its branch with a lease on that
 * revision. A withdrawal is a rejection by the proposal's own author. It is a person's step: an agent
 * that started this command is refused, as for an approval. A proposal of drafts saved on this machine
 * gives its drafts back, waiting again.
 */
export async function rejectProposal(root, branch, {
  yes = false, confirm = null, reason = null, interactive = false, ask = null, print = (line) => console.log(line),
  inspect, remove, identity, record, agent = () => false
}) {
  if (!branch) fail('Name the proposal to reject: singularity-flow configuration reject <PROPOSAL>.', 'CONFIGURATION_REJECT_PROPOSAL_REQUIRED',
    { nextAction: 'singularity-flow configuration proposals' });
  const reviewed = await inspect(root, branch);
  if (reviewed.merged) {
    fail(`Proposal ${branch} is already approved, so it cannot be rejected. To undo it, propose the change back.`, 'CONFIGURATION_REJECT_ALREADY_APPROVED',
      { nextAction: 'singularity-flow workflow studio' });
  }
  const rejecter = identity(root);
  const { proposalViewLines } = await import('./configuration-approval-view.mjs');
  for (const line of proposalViewLines(reviewed, { approver: rejecter })) print(line);
  const revision = reviewed.proposalCommit;
  const withdrawn = Boolean(reviewed.proposer?.email && rejecter?.email
    && reviewed.proposer.email.trim().toLowerCase() === rejecter.email.trim().toLowerCase());
  const verb = withdrawn ? 'withdraw' : 'reject';
  const command = `singularity-flow configuration reject ${branch} --confirm ${revision}${reason ? '' : ' --reason "<REASON>"'}`;
  if (confirm != null || yes) {
    const named = confirm != null ? String(confirm).trim() : await shownRevision(root, branch);
    if (named !== revision) {
      await recordShown(root, branch, revision);
      fail(named ? `Proposal ${branch} changed after you were shown it, so nothing was rejected. Read it again above, then: ${command}`
        : `Read the proposal above, then ${verb} exactly this revision: ${command}`,
      named ? 'CONFIGURATION_APPROVE_PROPOSAL_MOVED' : 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction: command, shown: revision });
    }
  } else if (!interactive || typeof ask !== 'function') {
    await recordShown(root, branch, revision);
    fail(`Read the proposal above, then ${verb} exactly this revision: ${command}`, 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction: command, shown: revision });
  } else {
    const answer = String(await ask(`${withdrawn ? 'Withdraw your proposal' : 'Reject this proposal'}? Nothing in sflow/config changes. [y/N] `) ?? '').trim();
    if (!/^y(?:es)?$/iu.test(answer)) {
      print(`Nothing was ${withdrawn ? 'withdrawn' : 'rejected'}.`);
      return { schemaVersion: 1, resultType: 'configuration-rejection', status: 'declined', branch };
    }
    if (!reason && !withdrawn) reason = String(await ask('Why? (the author reads this) ') ?? '').trim() || null;
  }
  if (agent()) {
    fail(`Rejecting a configuration proposal is a person's step, and an agent started this command. Nothing was changed. Run it in your own terminal: ${command}`,
      'PSS_CARD_NOT_SHOWN', { nextAction: { command, label: `Run in your own terminal: ${command}` } });
  }
  const recorded = await record(root, { branch, proposalCommit: revision, proposer: reviewed.proposer ?? null, rejectedBy: rejecter, reason });
  const removed = await remove(root, branch, { confirm: revision });
  let restored = [];
  if ((await readDrafts(root)).proposed?.branch === branch) restored = (await restoreProposal(root, branch)).restored;
  print(withdrawn ? `Withdrawn: ${branch}. Nothing in sflow/config changed.` : `Rejected: ${branch}. Nothing in sflow/config changed.`);
  if (reason) print(`Reason recorded for its author: ${reason}`);
  if (recorded?.status === 'failed') print(`The ${withdrawn ? 'withdrawal' : 'rejection'} stands, but ${recorded.message}.`);
  if (restored.length) print(`The drafts it held are waiting again: ${restored.join('; ')}.`);
  return { schemaVersion: 1, resultType: 'configuration-rejection', status: withdrawn ? 'withdrawn' : 'rejected', branch,
    proposalCommit: revision, reason: reason ?? null, record: recorded ?? null, removal: removed?.status ?? null, restored };
}

/** Whether `person` proposed `reviewed`: true, false, or 'unknown' when Git does not record its proposer [D4]. */
function proposedBy(reviewed, person) {
  if (!reviewed.proposer?.email) return 'unknown';
  return Boolean(person?.email) && person.email.trim().toLowerCase() === reviewed.proposer.email.trim().toLowerCase();
}

/**
 * A capability or setup proposal as a person reads it before deciding: what it is, who proposed it, its revision and
 * its files, and whether approving it would be a self-approval [SCF:REQ-011, REQ-018].
 */
function delegatedViewLines(kind, reviewed, { approver = null } = {}) {
  const label = kind === 'capability' ? 'Capability proposal' : 'Repository setup proposal';
  const by = reviewed.proposer?.name ? ` by ${reviewed.proposer.name}` : '';
  const files = (reviewed.changedFiles ?? []).map((entry) => `  ${String(entry.status ?? '').padEnd(4)} ${(entry.paths ?? [entry.path]).filter(Boolean).join(' -> ')}`);
  const lines = [`${label} ${reviewed.branch}${by}`, `  Revision ${reviewed.proposalCommit ?? '(unknown)'}`,
    ...(reviewed.merged ? [`  Already in ${reviewed.targetBranch ?? 'sflow/config'}.`] : files.length ? files : ['  No file changes.']),
    ...(reviewed.failure?.message ? [`  It cannot be approved yet: ${reviewed.failure.message}`] : [])];
  if (reviewed.merged || !approver) return lines;
  const self = proposedBy(reviewed, approver);
  const another = reviewed.approvalPolicy?.allowSelfApproval === false;
  if (self === 'unknown') {
    lines.push('', another ? 'Git does not record who proposed this, and this repository needs another person to approve configuration changes: reject it and propose it again.'
      : 'Git does not record who proposed this, so approving it is recorded as a possible self-approval.');
  } else if (self && another) {
    lines.push('', 'You proposed this, and this repository needs another person to approve configuration changes: someone else approves it.');
  } else if (self) {
    lines.push('', 'You proposed this, so approving it is a self-approval, and is recorded as one.');
  }
  return lines;
}

/**
 * The revision a decision names [SCF:REQ-006]: `--confirm`, or with `--yes` the one this machine last showed; in a
 * terminal, the person's yes right after the view. Null when they said no.
 */
async function decidedRevision(root, branch, revision, { yes, confirm, interactive, ask, question, command }) {
  if (confirm != null || yes) {
    const named = confirm != null ? String(confirm).trim() : await shownRevision(root, branch);
    if (named !== revision) {
      await recordShown(root, branch, revision);
      fail(named ? `Proposal ${branch} changed after you were shown it, so nothing was decided. Read it again above, then: ${command}`
        : `Read the proposal above, then decide exactly this revision: ${command}`,
      named ? 'CONFIGURATION_APPROVE_PROPOSAL_MOVED' : 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction: command, shown: revision });
    }
    return revision;
  }
  if (!interactive || typeof ask !== 'function') {
    await recordShown(root, branch, revision);
    fail(`Read the proposal above, then decide exactly this revision: ${command}`, 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction: command, shown: revision });
  }
  return /^y(?:es)?$/iu.test(String(await ask(question) ?? '').trim()) ? revision : null;
}

/**
 * Approve a capability or repository setup proposal through `configuration approve`, like every other proposal
 * [SCF:REQ-010]: show it, bind the approval to the revision shown, then `activate(root, branch, { confirm, reviewed })`
 * signs it and hands it to its own engine.
 */
export async function approveDelegatedProposal(root, branch, kind, {
  yes = false, confirm = null, interactive = false, ask = null, print = (line) => console.log(line), inspect, activate, identity = null, lead = null
}) {
  const reviewed = { ...(await inspect(branch)), branch };
  // Every command it names reads the repository this one read (review 11-17, finding 9).
  const on = lead ? ` --lead ${lead}` : '';
  let approver = null;
  try { approver = typeof identity === 'function' ? identity() : null; } catch { approver = null; }
  for (const line of delegatedViewLines(kind, reviewed, { approver })) print(line);
  // One policy for every approval [SCF:REQ-011, D4]: refused before anyone is asked to confirm or sign. The engine
  // route checks again, for the earlier commands that reach it directly.
  const self = approver ? proposedBy(reviewed, approver) : false;
  if (reviewed.approvalPolicy?.allowSelfApproval === false && !reviewed.merged && self !== false) {
    if (self === true) {
      const { selfApprovalRefusalWords } = await import('./config-approvers.mjs');
      fail(`You proposed ${branch}, and this repository needs another person to approve it (allowSelfApproval is false). Nothing was approved.`
        + selfApprovalRefusalWords(reviewed.approvalPolicy?.approvers, approver),
        'CONFIGURATION_SELF_APPROVAL_REFUSED', { nextAction: { label: 'Another person approves it', command: `singularity-flow configuration approve ${branch}${on}` } });
    }
    fail(`Git does not record who proposed ${branch}, so it could be your own, and this repository needs another person to approve it. Nothing was approved. Reject it, then propose it again.`,
      'CONFIGURATION_PROPOSER_UNKNOWN', { nextAction: { label: 'Reject it, then propose it again', command: `singularity-flow configuration reject ${branch}${on}` } });
  }
  if (reviewed.valid === false && !reviewed.merged) {
    fail(`Proposal ${branch} cannot be approved: ${reviewed.failure?.message ?? 'it changes files outside the configuration'}`,
      reviewed.failure?.code ?? 'CONFIGURATION_PROPOSAL_INVALID', { nextAction: 'singularity-flow configuration proposals' });
  }
  const revision = reviewed.proposalCommit;
  const decided = await decidedRevision(root, branch, revision, { yes, confirm, interactive, ask,
    question: 'Approve this proposal for new Stories? This updates sflow/config. [y/N] ',
    command: `singularity-flow configuration approve ${branch} --confirm ${revision}${on}` });
  if (!decided) {
    print('Nothing was approved.');
    return { schemaVersion: 1, resultType: 'configuration-approval', kind, status: 'declined', activated: false, branch };
  }
  const result = await activate(branch, { confirm: decided, reviewed });
  if (result?.activated !== false && result?.status !== 'review-required') {
    print(approvedWords(kind));
    // Signed, or refused before anything moved, while SF Guard is on: never unsigned here.
    if (result?.presence?.status === 'failed') print(`SF Guard: ${result.presence.message}.`);
  } else if (result?.externalAction) {
    print(`sflow/config only accepts reviewed merges here. Merge ${result.externalAction.sourceBranch} into ${result.externalAction.targetBranch} on the Git host.`);
  } else {
    print(`The approval did not complete: ${result?.failure?.message ?? 'the update was not accepted'}. Nothing else changed; retry with singularity-flow configuration approve ${branch}${on}.`);
  }
  return { schemaVersion: 1, resultType: 'configuration-approval', kind, ...result, branch };
}

/**
 * Reject a capability or repository setup proposal through `configuration reject` [SCF:REQ-009, REQ-010]: show it,
 * bind the decision to the revision shown, then `remove(branch, { confirm, reason })`. A person's step.
 */
export async function rejectDelegatedProposal(root, branch, kind, {
  yes = false, confirm = null, reason = null, interactive = false, ask = null, print = (line) => console.log(line),
  inspect, remove, agent = () => false, identity = null, lead = null
}) {
  const reviewed = { ...(await inspect(branch)), branch };
  const on = lead ? ` --lead ${lead}` : '';
  if (reviewed.merged) {
    fail(`Proposal ${branch} is already approved, so it cannot be rejected. To undo it, propose the change back.`, 'CONFIGURATION_REJECT_ALREADY_APPROVED',
      { nextAction: 'singularity-flow configuration proposals' });
  }
  for (const line of delegatedViewLines(kind, reviewed)) print(line);
  let rejecter = null;
  try { rejecter = typeof identity === 'function' ? identity() : null; } catch { rejecter = null; }
  // Its proposer withdraws it [SCF:REQ-009].
  const withdrawn = Boolean(rejecter) && proposedBy(reviewed, rejecter) === true;
  const revision = reviewed.proposalCommit;
  // `--lead` before `--confirm`, as the proposal's other routes name it: nothing is joined to the revision a route confirms.
  const command = `singularity-flow configuration reject ${branch}${on} --confirm ${revision}${reason ? '' : ' --reason "<REASON>"'}`;
  const decided = await decidedRevision(root, branch, revision, { yes, confirm, interactive, ask,
    question: withdrawn ? 'Withdraw your proposal? Nothing in sflow/config changes. [y/N] ' : 'Reject this proposal? Nothing in sflow/config changes. [y/N] ', command });
  if (!decided) {
    print(withdrawn ? 'Nothing was withdrawn.' : 'Nothing was rejected.');
    return { schemaVersion: 1, resultType: 'configuration-rejection', kind, status: 'declined', branch };
  }
  if (interactive && !reason && typeof ask === 'function') reason = String(await ask('Why? (the author reads this) ') ?? '').trim() || null;
  if (await agent()) {
    fail(`Rejecting a configuration proposal is a person's step, and an agent started this command. Nothing was changed. Run it in your own terminal: ${command}`,
      'PSS_CARD_NOT_SHOWN', { nextAction: { command, label: `Run in your own terminal: ${command}` } });
  }
  const removed = await remove(branch, { confirm: decided,
    reason: reason ?? (withdrawn ? 'Withdrawn by its proposer with configuration reject.' : 'Rejected with configuration reject; no reason was given.') });
  print(`${withdrawn ? 'Withdrawn' : 'Rejected'}: ${branch}. Nothing in sflow/config changed.`);
  if (reason) print(`Reason kept with it: ${reason}`);
  return { schemaVersion: 1, resultType: 'configuration-rejection', kind, status: withdrawn ? 'withdrawn' : 'rejected', branch, proposalCommit: decided,
    proposer: reviewed.proposer ?? null, reason: reason ?? null, removal: removed?.status ?? null };
}
