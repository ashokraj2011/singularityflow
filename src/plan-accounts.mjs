/**
 * What the approved plan already says about a changed path, for every reader that asks: convergence,
 * which stops asking a person what the plan answered, and the decisions table, which shows it.
 *
 * Only what really counts settles a path. A supporting file counts while a person's approval of that
 * plan generation stands, and an amendment while its record counts (SF Guard) and someone in the
 * plan's group decided it. A plan entry holds a path, a class and a reason and binds no content, so
 * nothing here can tell whether a change stayed within that reason. An amendment made since it could
 * holds the hash of what it accounted for, so a file changed after it is a question again; one from
 * before has no hash and reads as it did. What the record can show is checked below, and the entry
 * stays beside the file for the reviewer to read.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { approvalRequirementsMet } from './kernel/approval-policy.mjs';
import { planAuthorities } from './plan-amendments.mjs';
import { countedApprovals, countedRecords, isWithdrawn } from './presence/counted.mjs';
import { readRecord } from './schema-migrations.mjs';
import {convergenceValuePolicies} from './kernel/convergence-values.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_VALUE_SYNTAX} from './records.mjs';
const values=convergenceValuePolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX);
import { posix, secureRepositoryPath } from './util.mjs';

// Not an agreement with the change: each of these says a person still has something to say about it.
const KEPT_BY_PERSON = Object.freeze(['rework', 'update-intent', 'deferred']);

/**
 * What a person answered in an earlier iteration of this Story with anything but acceptance. A plan
 * entry must not quietly settle a path somebody sent back, so it is asked again, as it always was.
 * Null when an earlier record cannot be read: then nobody can tell, and nothing settles.
 */
export async function pathsKeptByPerson(root, itemRelative, iteration) {
  const kept = new Set();
  for (let earlier = 1; earlier < iteration; earlier += 1) {
    try {
      const secured = await secureRepositoryPath(root, posix(path.join(itemRelative, 'context', 'convergence', `iteration-${earlier}.json`)), {
        label: 'Earlier convergence record', type: 'file'
      });
      if (!secured.exists) continue;
      const { record } = readRecord('convergence-record', await readFile(secured.absolute));
      const items = new Map([...(record.facts ?? []), ...(record.settledByPlan ?? [])].map((item) => [item.id, item]));
      for (const finding of record.findings ?? []) {
        if (!KEPT_BY_PERSON.includes(finding.disposition)) continue;
        for (const file of items.get(finding.itemId)?.paths ?? []) kept.add(posix(file));
      }
    } catch { return null; }
  }
  return kept;
}

// A plan step that needs no approval, was waived by policy or reopened has answered nothing for a person.
function approvedByPerson(workflow, record) {
  const phase = workflow?.phases?.[record?.phase];
  const generation = Number(record?.generation);
  if (phase?.status !== 'approved' || phase.approvalPolicy?.mode === 'none' || Number(phase.generation) !== generation) return false;
  const active = countedApprovals(workflow, (phase.approvals ?? [])
    .filter((item) => !item.invalidatedAt && item.decision === 'approved' && Number(item.generation) === generation));
  return active.length > 0 && approvalRequirementsMet(phase.approvalPolicy, active);
}

function listedEntries(workflow, plans) {
  return plans.flatMap((record) => {
    const approved = approvedByPerson(workflow, record);
    const details = new Map((record.supportingFileDetails ?? []).map((entry) => [posix(entry.path), entry]));
    return [...new Set([...(record.supportingFiles ?? []).map(posix), ...details.keys()])].map((file) => {
      const detail = details.get(file);
      return { file, approved, problem: !approved ? 'no person approved the plan that lists it'
        : detail ? null : 'the plan lists it with no class or reason',
      entry: { kind: 'supporting', phase: record.phase ?? null, generation: Number(record.generation ?? 0), class: detail?.class ?? null, text: detail?.reason ?? null } };
    });
  });
}

// Only a decided amendment: anything still pending, rejected or withdrawn answered nothing.
function amendmentEntries(workflow, plans) {
  const groups = planAuthorities(workflow);
  const decided = (amendment) => (amendment?.status ?? 'approved') === 'approved' && (amendment?.decision ?? 'approved') === 'approved'
    && !isWithdrawn(workflow, amendment) && Boolean(amendment?.actor) && groups.includes(amendment?.authorityGroup);
  return countedRecords(workflow, workflow?.planAmendments).filter(decided).flatMap((amendment) => (amendment.changes ?? [])
    .filter((change) => change?.path).map((change) => ({ file: posix(change.path), approved: true,
      problem: change.clauseId && !plans.some((record) => record.claims?.[change.clauseId]) ? `the plan no longer has the row ${change.clauseId}` : null,
      entry: { kind: 'amendment', id: amendment.id, ...(change.clauseId ? { clause: change.clauseId } : {}), class: change.class ?? null, ...(amendment.contentHashes?.[change.path] ? { sha256: amendment.contentHashes[change.path] } : {}), text: change.reason ?? amendment.reason ?? null } })));
}

/**
 * What the plan says about a reconciliation finding, or null when it says nothing. `askedBecause` says
 * why an entry does not settle it; the entry that does comes first, then whichever a person approved.
 * `keptByPerson` holds what a person sent back earlier: the plan never overrules them. Null when it cannot be read.
 */
export function planAccounts(workflow, planned = [], { keptByPerson = new Set() } = {}) {
  const plans = planned.filter((record) => record && !record.amendment);
  return values.planAccountsFromEntries([...listedEntries(workflow, plans), ...amendmentEntries(workflow, plans)],{keptByPerson});
}

/**
 * Split the deterministic facts into what a person is asked and what the plan settled. Only a changed
 * path no claim cites can be settled, and it keeps its identity, so a reviewer finds the same item
 * from one Story to the next. Every other fact is asked as it always was.
 */
export const settleChangedPaths=values.settleChangedPaths;
