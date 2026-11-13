/**
 * What SFlow settles in a code step before its tests run and before anything is recorded as a departure
 * [owner, 2026-11-13]: the Node the repository names (node-version-settle.mjs), and, in the agent's prepublish, a
 * changed file an approved plan row already covers. Each is recorded as settled with its evidence and listed on the
 * decisions card with an undo; anything less clear is asked, or recorded as a departure a person decides, as before.
 *
 * A row covers a file the plan does not name when that row names its companion: a file in the same folder with the
 * same name before its first dot (`Pricing.tsx` and `Pricing.module.css`, `rates.mjs` and `rates.d.ts`), and no
 * other row of the step names one. Never a supporting file (a person lists those), a protected path, or a file a
 * person undid once.
 */
import path from 'node:path';

const SECRET = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/iu;
const stem = (file) => path.posix.basename(file).split('.')[0];

/** The one row of `phase` that names a companion of `file`, with that path; null when none or several do. */
export function coveringRow(plan, phaseId, file) {
  const folder = path.posix.dirname(file);
  const name = stem(file);
  if (!name) return null;
  const rows = Object.entries(plan ?? {}).filter(([, claim]) => (!(claim.steps ?? []).length || claim.steps.includes(phaseId)) && claim.fulfillment !== 'test-only')
    .map(([clauseId, claim]) => ({ clauseId, path: (claim.expectedPaths ?? []).find((entry) => entry !== file && path.posix.dirname(entry) === folder && stem(entry) === name) }))
    .filter((row) => row.path);
  return new Set(rows.map((row) => row.clauseId)).size === 1 ? rows[0] : null;
}

/** Settle each changed file an approved row covers; returns what was settled. */
async function settlePlanAccounting(root, config, workflow, phase, { actor, agent }) {
  const [{ unreconciledCandidatePaths }, { rejectedDeparturePaths }, { classifySupportingChange }, { loadActiveSpecRecords, mergePlannedClaimRecords },
    { workDir }, { settlementState, commitSettledDecision }] = await Promise.all([import('./candidate-scope.mjs'), import('./departures.mjs'),
    import('./supporting-changes.mjs'), import('./specifications.mjs'), import('./story-paths.mjs'), import('./settled-decisions.mjs')]);
  const files = await unreconciledCandidatePaths(root, config, workflow, phase).catch(() => []);
  if (!files.length) return [];
  const rejected = rejectedDeparturePaths(workflow, phase.id);
  const guarded = [...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])]
    .map((entry) => String(entry).replace(/\/$/u, ''));
  const plan = mergePlannedClaimRecords((await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).planned ?? []);
  const settled = [];
  for (const file of files) {
    if (rejected.has(file) || SECRET.test(file) || classifySupportingChange(file).class
      || guarded.some((entry) => file === entry || file.startsWith(`${entry}/`))) continue;
    const row = coveringRow(plan, phase.id, file);
    if (!row || settlementState(workflow, 'plan-accounting', `file:${file}`) !== 'open') continue;
    try {
      const { record } = await commitSettledDecision(root, config, workflow, {
        kind: 'plan-accounting', by: 'sflow', phase: phase.id, subject: `file:${file}`,
        answer: `Accounted ${file} to ${row.clauseId}'s row, which names ${row.path} beside it.`,
        evidence: [
          { what: `${row.clauseId}'s row names ${row.path}`, where: 'the approved plan' },
          { what: `${file} sits beside it with the same name`, where: path.posix.dirname(file) },
          { what: `no other row of ${phase.id} names a file of that name there`, where: 'the approved plan' }
        ],
        effect: { clauseId: row.clauseId, path: file }
      }, { actor, agent });
      settled.push(record);
    } catch { /* Settling is a convenience over the question it replaces: that question stands. */ }
  }
  return settled;
}

/** Settle before the step's tests and its departures; never refuses. `accounting`: the agent's prepublish only. */
export async function settleBeforePublication(root, config, workflow, phase, { actor, agent = null, accounting = false } = {}) {
  if (workflow.status !== 'in_progress' || phase?.generationIntent?.status !== 'open' || workflow.currentPhase !== phase.id) return { node: null, files: [] };
  const node = await (await import('./node-version-settle.mjs')).settleRepositoryNode(root, config, workflow, phase, { actor, agent }).catch(() => null);
  const files = accounting ? await settlePlanAccounting(root, config, workflow, phase, { actor, agent }).catch(() => []) : [];
  return { node, files };
}
