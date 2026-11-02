/**
 * SF Guard's remote check of the repository stores (SPEC-PSS-v1 §10.10), shared by
 * `governance verify --presence` (a branch: Epic approvals and completions, goal plan approvals, the
 * agents lock, a recorded host-policy assertion, a program approval) and `--state-records` (the state
 * branch: capability lease grants and revocations in the ledger).
 *
 * Every record a change adds or edits must count: its presence signature verifies against the
 * approver's pinned key, a per-person exception covered them, or SF Guard was off at the time it
 * claims. No sealed record and no seal may disappear. A record already on the base, unchanged, that
 * does not count is a note, never a failure, so an unrelated change is never held by an older one.
 */
import YAML from 'yaml';

import { fileVerdict, inlineVerdict, SEAL_SUFFIX, sealPathFor } from './store-seals.mjs';

const json = (bytes) => { try { return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch { return null; } };
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const AGENTS_LOCK = 'singularity/agents.lock.yml';
export const HOST_POLICY_REPORT = 'singularity/deployment/ledger-validation.json';
const LEASE_TYPES = new Set(['capability-lease-granted', 'capability-lease-revoked']);

/** The file stores under `initiativeRoot`, as `{ store, pattern, key(match, record), at(record), routeId(match, record) }`. */
function fileStores(initiativeRoot) {
  const initiatives = escape(String(initiativeRoot ?? 'singularity/initiatives').replace(/\/+$/u, ''));
  return [
    { store: 'epic-approval', pattern: new RegExp(`^${initiatives}/([^/]+)/approvals/records/([a-f0-9]{64})\\.json$`, 'u'),
      key: (match) => match[2], at: (record) => record?.at, routeId: (match) => match[1] },
    { store: 'epic-completion', pattern: new RegExp(`^${initiatives}/([^/]+)/delivery/records/([a-f0-9]{64})\\.json$`, 'u'),
      key: (match) => match[2], at: (record) => record?.completedAt, routeId: (match) => match[1] },
    { store: 'goal-plan-approval', pattern: /^singularity\/goals\/([^/]+)\/approvals\/plan-generation-[^/]+\.json$/u,
      key: (match, record) => `${record?.goalId}/${record?.generation}/${record?.planSha256}`, at: (record) => record?.at, routeId: (match) => match[1] },
    { store: 'program-authority', pattern: /^singularity\/sgos\/program-authorities\/[^/]+\.json$/u,
      key: (match) => match[0], at: (record) => record?.approvedAt, routeId: () => null }
  ];
}

/** The roots a branch check lists. */
export function storeRoots(initiativeRoot) {
  return [String(initiativeRoot ?? 'singularity/initiatives'), 'singularity/goals', 'singularity/sgos/program-authorities', AGENTS_LOCK, HOST_POLICY_REPORT];
}

/**
 * Check the stores between `base` and `head`. `deps.paths(ref)` lists the files under the store roots
 * at a ref, `deps.file(ref, path)` reads one (Buffer or null). `state` checks the state branch's ledger
 * instead of a branch's stores. Returns `{ failures, warnings, checked }`.
 */
export async function storeRecordProblems(policy, { head, base = null, initiativeRoot = null, state = false }, deps) {
  const failures = [];
  const warnings = [];
  let checked = 0;
  if (!policy?.present || !policy.chain) return { failures, warnings, checked };
  const headPaths = new Set(await deps.paths(head));
  const basePaths = base ? new Set(await deps.paths(base)) : new Set();
  const same = async (file, bytes) => Boolean(base && basePaths.has(file)) && Buffer.compare(Buffer.from(await deps.file(base, file) ?? ''), Buffer.from(bytes)) === 0;
  const judge = async (name, verdict, unchanged) => {
    checked += 1;
    if (verdict.counts) return;
    if (unchanged) warnings.push(`The ${name} does not verify (${verdict.reason}); it is already on the base and counts for nothing.`);
    else failures.push({ code: verdict.code ?? 'PSS_RECORD_UNSIGNED', message: `The ${name} does not verify: ${verdict.reason}.`, route: verdict.route });
  };
  const removed = (name, route) => failures.push({ code: 'PSS_RECORD_REMOVED', message: `The ${name} is on the base and this change removes it.`, route });

  if (state) {
    for (const file of [...headPaths].sort()) {
      if (!file.startsWith('ledger/entries/') || !file.endsWith('.json')) continue;
      const bytes = await deps.file(head, file);
      const entry = json(bytes);
      if (!LEASE_TYPES.has(entry?.eventType)) continue;
      await judge(`capability lease entry ${entry.eventId ?? file}`, inlineVerdict(policy, 'capability-lease', entry), await same(file, bytes));
    }
    for (const file of [...basePaths].sort()) {
      if (headPaths.has(file) || !file.startsWith('ledger/entries/')) continue;
      const entry = json(await deps.file(base, file));
      if (LEASE_TYPES.has(entry?.eventType) && entry?.payload?.presence) removed(`capability lease entry ${entry.eventId ?? file}`, 'restore it from the base; a lease is revoked with its own command, never by deleting its entry');
    }
    return { failures, warnings, checked };
  }

  const stores = fileStores(initiativeRoot);
  const matchOf = (file) => {
    for (const shape of stores) {
      const match = shape.pattern.exec(file);
      if (match) return { shape, match };
    }
    return null;
  };
  for (const file of [...headPaths].sort()) {
    if (file.endsWith(SEAL_SUFFIX)) continue;
    const found = matchOf(file);
    if (!found) continue;
    const bytes = await deps.file(head, file);
    const record = json(bytes);
    const seal = await deps.file(head, sealPathFor(file));
    const verdict = fileVerdict(policy, found.shape.store, { key: found.shape.key(found.match, record), bytes, seal,
      recordedAt: found.shape.at(record) ?? null, routeId: found.shape.routeId(found.match, record) });
    const sealFile = sealPathFor(file);
    const sealUnchanged = !seal ? !basePaths.has(sealFile) : await same(sealFile, seal);
    await judge(`${found.shape.store.replaceAll('-', ' ')} ${file}`, verdict, await same(file, bytes) && sealUnchanged);
  }
  for (const file of [...basePaths].sort()) {
    if (headPaths.has(file)) continue;
    if (file.endsWith(SEAL_SUFFIX)) removed(`presence seal ${file}`, 'restore it from the base; a person decides again with its own command, never by deleting a record');
    else if (matchOf(file) && basePaths.has(sealPathFor(file))) removed(`sealed record ${file}`, 'restore it from the base; a person decides again with its own command, never by deleting a record');
  }

  // The agents lock: each entry carries its own signature.
  if (headPaths.has(AGENTS_LOCK) || basePaths.has(AGENTS_LOCK)) {
    const read = async (ref) => { try { return YAML.parse(String(await deps.file(ref, AGENTS_LOCK) ?? ''))?.agents ?? {}; } catch { return {}; } };
    const after = headPaths.has(AGENTS_LOCK) ? await read(head) : {};
    const before = basePaths.has(AGENTS_LOCK) ? await read(base) : {};
    for (const [id, entry] of Object.entries(after)) {
      const unchanged = JSON.stringify(before[id] ?? null) === JSON.stringify(entry);
      await judge(`agents lock entry ${id}`, inlineVerdict(policy, 'agents-lock', entry, id), unchanged);
    }
    for (const [id, entry] of Object.entries(before)) {
      if (!(id in after) && entry?.presence) removed(`signed agents lock entry ${id}`, 'restore it from the base; a person locks the agent again with its own command');
    }
  }
  // A recorded host-policy assertion.
  if (headPaths.has(HOST_POLICY_REPORT)) {
    const bytes = await deps.file(head, HOST_POLICY_REPORT);
    const report = json(bytes);
    if (report?.confirmation) await judge('recorded host-policy assertion', inlineVerdict(policy, 'host-policy-assertion', report), await same(HOST_POLICY_REPORT, bytes));
  }
  return { failures, warnings, checked };
}
