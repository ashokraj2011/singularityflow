/**
 * The one write of a narrow plan amendment [E2G-012]: `decision plan` and a choice recorded from the
 * decision list both come here, so the authority check, the record and the commit are the same.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { requireApprovalAuthority } from '../approval-authority.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { planAuthorities, recordPlanAmendment } from '../plan-amendments.mjs';
import { loadActiveSpecRecords, mergePlannedClaimRecords } from '../specifications.mjs';
import { actorKey, assertNoPendingPublication, transactStory } from '../state-stores.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { storyLocation } from '../story-paths.mjs';

/**
 * What each file an amendment names holds now, read as reconciliation reads it, so the two compare. A
 * file that is not there or cannot be read has no hash, and the amendment is recorded all the same.
 */
export async function amendmentContentHashes(root, changes) {
  try {
    const { fileEvidence } = await import('../work-intervals.mjs');
    const evidence = await fileEvidence(root, [...new Set(changes.map((change) => change.path))]);
    return Object.fromEntries(evidence.filter((entry) => entry.sha256).map((entry) => [entry.path, entry.sha256]));
  } catch { return {}; }
}

/**
 * Each location's clause as the plan row it names: a short ID (`AC-001`, from `decision plan --add-location` or
 * `decision departure --clause`) is the one row it ends with, and one ending several rows is refused with their full
 * IDs (stage 7 run, 2026-11-15). One naming no row is left for the plan's own refusal, which lists its rows.
 */
async function withPlanRows(changes = [], rows) {
  if (!changes.some((change) => change.kind === 'add-location' && !String(change.clauseId ?? '').includes(':'))) return changes;
  const { resolveClauseIds, unresolvedClauseWords } = await import('../clause-id-resolution.mjs');
  return changes.map((change) => {
    if (change.kind !== 'add-location') return change;
    const { resolved, unresolved } = resolveClauseIds([change.clauseId], rows);
    if (unresolved[0]?.candidates.length) {
      throw new SingularityFlowError(`${unresolvedClauseWords(unresolved, rows, { what: 'the plan' })}`, { code: 'PLAN_AMENDMENT_INVALID', details: { unresolved } });
    }
    return resolved.length ? { ...change, clauseId: resolved[0] } : change;
  });
}

export async function commitPlanAmendment(root, config, workflow, { changes: given, reason, departures = [] }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const groups = planAuthorities(workflow);
  if (!groups.length) {
    throw new SingularityFlowError('No step of this Story holds the plan with an approval group, so nobody can amend it.', { code: 'PLAN_AMENDMENT_AUTHORITY_UNAVAILABLE' });
  }
  const records = await loadActiveSpecRecords(storyLocation(root, config, id).directory, workflow);
  const plan = mergePlannedClaimRecords(records.planned ?? []);
  const changes = await withPlanRows(given, Object.keys(plan));
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const decide = (aggregate, contentHashes = {}) => recordPlanAmendment(aggregate, {
    changes, reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso(), plan, contentHashes, departures
  });
  // Checked first: only an exact repository path is ever read. A refused row comes with the filled command for each
  // row that can take the file, so it is never a dead end [owner, 2026-11-19].
  let checked;
  try { checked = decide(structuredClone(workflow)); } catch (error) {
    throw (await import('../plan-row-fit.mjs')).explainedAmendmentRefusal(error, { workId: id, plan, changes });
  }
  const contentHashes = await amendmentContentHashes(root, checked.changes);
  const { value: amendment, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'plan' }
    },
    `[${id}][plan:amend] ${changes.length} change(s)`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'amend the plan');
      const recorded = decide(aggregate, contentHashes);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'plan_amended', phase: aggregate.currentPhase ?? null,
        detail: `${recorded.id}: ${recorded.changes.map((change) => change.kind === 'add-location' ? `${change.path} added to ${change.clauseId}` : `${change.path} listed as ${change.class}`).join('; ')}${recorded.departures ? `, accepting ${recorded.departures.join(', ')}` : ''}. ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'plan', amendment: recorded.id, reviewPacketSha256: null }
      })
    }
  );
  return { amendment, publication };
}

/**
 * A person's choice to pin an installed Node: the file and the plan amendment that accounts for it, in
 * one action (src/node-pin.mjs). The file comes first, so the amendment binds what it holds; if the
 * amendment cannot be recorded, the file goes again and nothing changed. An amendment that already lists
 * the file stands, and only the file is created: a plan amended by hand must not need a second reason.
 */
export async function commitNodePin(root, config, workflow, { version, reason, replaces = null }, { actor, agent = null }) {
  const { NODE_PIN_CLASS, NODE_PIN_FILE, installedNodeOfMajor, nodePinVersion } = await import('../node-pin.mjs');
  const major = nodePinVersion(version);
  const node = major ? await installedNodeOfMajor(major) : null;
  if (!node) {
    throw new SingularityFlowError(`Node ${String(version).slice(0, 20)} is not installed here, so it cannot be pinned. Nothing was changed; install it with your version manager, or choose again.`, { code: 'NODE_PIN_NOT_INSTALLED' });
  }
  const file = path.join(root, NODE_PIN_FILE);
  // Replacing what a person was shown, and nothing else: a file that has changed since is theirs.
  const before = await readFile(file, 'utf8').catch(() => null);
  try {
    if (replaces && before?.trim() === replaces) await writeFile(file, `${major}\n`);
    else await writeFile(file, `${major}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new SingularityFlowError(`${NODE_PIN_FILE} already exists in this checkout, so it was left as it is and nothing was recorded. Its version is what SFlow runs the tests on; change it by hand if it is wrong.`, { code: 'NODE_PIN_FILE_EXISTS' });
  }
  const undo = () => (before == null ? rm(file, { force: true }) : writeFile(file, before)).catch(() => null);
  const listed = (workflow.planAmendments ?? []).find((record) => (record.changes ?? []).some((change) => change.path === NODE_PIN_FILE));
  if (listed) return { id: listed.id, file: NODE_PIN_FILE, version: major, node };
  try {
    const { amendment } = await commitPlanAmendment(root, config, workflow, {
      changes: [{ kind: 'add-supporting', path: NODE_PIN_FILE, class: NODE_PIN_CLASS, reason }], reason
    }, { actor, agent });
    // The next Story of this repository reads the person's choice as evidence, never asks it again (node-pin-history.mjs).
    // Read by path, out of the VS Code bundles.
    await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'node-pin-history.mjs')).href)).keepNodePin(root, { version: major, workId: workflow.workItem.id, by: 'person' }).catch(() => {});
    return { ...amendment, file: NODE_PIN_FILE, version: major, node };
  } catch (error) {
    await undo();
    throw error;
  }
}
