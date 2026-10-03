/**
 * A person's disposition of one accepted-scope inventory item [E2G-006].
 *
 * Reviewer agents and the extractor only propose; the decision is a record on the Story by someone
 * in the group that approves the step defining its scope. Excluded and deferred are scope decisions,
 * never exceptions. Included and existing must name the clauses that carry the statement. A
 * decision binds the statement's hash, so it lapses when the statement changes.
 */
import { omissionAuthorities } from '../evidence/applicability.mjs';
import { stepResponsibilities } from '../phase-roles.mjs';
import { STARTER_CHECKLIST, validateChecklistDecisions } from '../specification-quality.mjs';
import { SingularityFlowError } from '../util.mjs';
import { CLAUSE_LINKED_DISPOSITIONS, DECIDABLE_SCOPE_DISPOSITIONS } from './inventory.mjs';

/** Who may decide the scope: the approval groups of the steps that define it. */
export function scopeAuthorities(workflow) {
  const groups = new Set();
  for (const id of workflow?.phaseOrder ?? []) {
    if (!stepResponsibilities(workflow, id).includes('scope')) continue;
    const policy = workflow.phases?.[id]?.approvalPolicy ?? {};
    for (const group of [...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])]) groups.add(group);
  }
  // A route that leaves scope out has no scope step; whoever decides that omission decides here.
  for (const group of omissionAuthorities(workflow, 'scope')) groups.add(group);
  return [...groups].sort();
}

/**
 * Record a scope decision on the aggregate. `inventory` is the Story's current inventory and
 * `clauseIds` the IDs its clause indexes define; the caller has checked authority.
 */
export function recordScopeDecision(workflow, {
  item, disposition, clauseIds = [], reason, actor, authorityGroup, identityAssurance = null, at, inventory, knownClauseIds
}) {
  const target = inventory?.items?.find((entry) => entry.id === item);
  if (!target) {
    throw new SingularityFlowError(`The scope inventory of this Story has no item '${item}'. See it with singularity-flow evidence scope.`, {
      code: 'SCOPE_ITEM_UNKNOWN', details: { item }
    });
  }
  if (!DECIDABLE_SCOPE_DISPOSITIONS.includes(disposition)) {
    throw new SingularityFlowError(`--as must be one of ${DECIDABLE_SCOPE_DISPOSITIONS.join(', ')}.`, { code: 'SCOPE_DISPOSITION_INVALID' });
  }
  if (target.kind === 'source' && CLAUSE_LINKED_DISPOSITIONS.includes(disposition) && !clauseIds.length) {
    throw new SingularityFlowError('A source nobody could read is included only through the clauses that state it; name them with --clause.', {
      code: 'SCOPE_CLAUSES_REQUIRED'
    });
  }
  const linked = [...new Set(clauseIds.map((id) => String(id).toUpperCase()))].sort();
  if (CLAUSE_LINKED_DISPOSITIONS.includes(disposition)) {
    if (!linked.length) {
      throw new SingularityFlowError(`A statement is ${disposition} only through the clauses that carry it; name them with --clause.`, {
        code: 'SCOPE_CLAUSES_REQUIRED'
      });
    }
    const unknown = linked.filter((id) => !knownClauseIds.includes(id));
    if (unknown.length) {
      throw new SingularityFlowError(`This Story's specification defines no clause ${unknown.join(', ')}.`, { code: 'SCOPE_CLAUSE_UNKNOWN', details: { unknown } });
    }
  } else if (linked.length) {
    throw new SingularityFlowError(`A ${disposition} statement is not carried by clauses; leave out --clause.`, { code: 'SCOPE_CLAUSES_UNEXPECTED' });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say why in 20 to 1000 characters with --reason.', { code: 'SCOPE_REASON_REQUIRED' });
  }
  workflow.scopeDispositions ??= [];
  for (const entry of workflow.scopeDispositions) {
    if (entry.item === item && !entry.withdrawnAt) entry.withdrawnAt = at;
  }
  const decision = {
    item, disposition, clauseIds: linked, reason: text, statementSha256: target.statementSha256 ?? null,
    actor, authorityGroup, identityAssurance, at
  };
  workflow.scopeDispositions.push(decision);
  return decision;
}

/**
 * The record that an authorized reviewer assessed the inventory's interpretation [E2G-007]: missing
 * requirements, contradictions and ambiguity, negative and boundary cases, non-functional
 * requirements, and whether each criterion is observable. The reviewer answers every article of the
 * requirements-quality checklist, so the review is never a single rubber stamp. It binds the exact
 * inventory digest, so any later change to a statement or a disposition makes it no longer current.
 * It never claims the scope is correct, only that a person reviewed it.
 */
export function recordCompletenessReview(workflow, {
  inventory, confirm, checklist = [], reason, actor, authorityGroup, identityAssurance = null, at
}) {
  if (!inventory?.structurallyComplete) {
    throw new SingularityFlowError(
      `Every requirement statement needs a disposition before the scope can be reviewed for completeness (${inventory?.summary?.unresolved ?? 'some'} unresolved). See singularity-flow evidence scope.`,
      { code: 'SCOPE_INVENTORY_INCOMPLETE' }
    );
  }
  if (confirm !== inventory.inventorySha256) {
    throw new SingularityFlowError(
      `The inventory you reviewed is not the current one; review it again and confirm ${inventory.inventorySha256}.`,
      { code: 'SCOPE_INVENTORY_CHANGED', details: { expected: inventory.inventorySha256, supplied: confirm ?? null } }
    );
  }
  const known = new Set(STARTER_CHECKLIST.articles.map((article) => article.id));
  const unknown = checklist.map((entry) => entry?.article).filter((id) => !known.has(id));
  const { errors } = validateChecklistDecisions(checklist, { checklist: STARTER_CHECKLIST, mode: 'enforce' });
  if (unknown.length || errors.length) {
    throw new SingularityFlowError(
      `Answer every checklist article once with --article <id>=satisfied|exception|not-applicable (${STARTER_CHECKLIST.articles.map((article) => article.id).join(', ')}); ${[...unknown.map((id) => `there is no article '${id}'`), ...errors].join('; ')}.`,
      { code: 'SCOPE_CHECKLIST_INCOMPLETE', details: { unknown, problems: errors } }
    );
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError('Say what you assessed in 20 to 1000 characters with --reason.', { code: 'SCOPE_REASON_REQUIRED' });
  }
  const byArticle = new Map(checklist.map((entry) => [entry.article, entry]));
  const decisions = STARTER_CHECKLIST.articles.map(({ id }) => {
    const entry = byArticle.get(id);
    return { article: id, decision: entry.decision, ...(entry.decision === 'satisfied' ? {} : { reason: String(entry.reason).trim() }) };
  });
  workflow.completenessReviews ??= [];
  for (const entry of workflow.completenessReviews) if (!entry.withdrawnAt) entry.withdrawnAt = at;
  const review = {
    inventorySha256: inventory.inventorySha256, checklist: { id: STARTER_CHECKLIST.id, version: STARTER_CHECKLIST.version, decisions },
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.completenessReviews.push(review);
  return review;
}

/** The completeness review that still speaks for this inventory, or null. */
export function currentCompletenessReview(workflow, inventory) {
  const latest = [...(workflow?.completenessReviews ?? [])].reverse().find((entry) => !entry.withdrawnAt) ?? null;
  return latest && inventory && latest.inventorySha256 === inventory.inventorySha256 ? latest : null;
}
