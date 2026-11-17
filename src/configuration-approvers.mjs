/**
 * Who the approval groups name, for the second-person policy [SCF:REQ-011, D4].
 *
 * With `approvalSecurity.allowSelfApproval: false` a configuration change needs someone other than its proposer.
 * In a repository whose groups name nobody else, turning that on would leave every later configuration change,
 * including the one that turns it back, waiting for a person who does not exist (review 11-17, finding 2). So a
 * proposal that turns self-approval off is refused until the groups name a second person, and a refused
 * self-approval names who else may approve it.
 */

import { SingularityFlowError } from './util.mjs';

const lower = (value) => String(value ?? '').trim().toLowerCase();

/** Each person the approval groups of `documents` (workflow.yml, portfolio.yml as objects) name, once. */
export function namedApprovers(...documents) {
  const people = new Map();
  for (const document of documents) {
    for (const group of Object.values(document?.approvalAuthorities ?? {})) {
      for (const member of Array.isArray(group?.members) ? group.members : []) {
        const email = lower(member?.email);
        const githubLogin = lower(member?.githubLogin ?? member?.login);
        const key = email || (githubLogin ? `@${githubLogin}` : '');
        if (!key || people.has(key)) continue;
        people.set(key, { name: String(member?.name ?? '').trim() || null, email: email || null, githubLogin: githubLogin || null });
      }
    }
  }
  return [...people.values()];
}

/** The named people who are not `person` ({ email, githubLogin }), matched by email or GitHub login. */
export function otherApprovers(people, person) {
  const email = lower(person?.email);
  const login = lower(person?.githubLogin ?? person?.login);
  return (people ?? []).filter((entry) => !((email && lower(entry.email) === email) || (login && lower(entry.githubLogin) === login)));
}

/** People as a person reads them: "Bob Example <bob@example.test>, @carol". */
export function approverWords(people, limit = 5) {
  const shown = (people ?? []).slice(0, limit).map((entry) => {
    const address = entry.email ?? (entry.githubLogin ? `@${entry.githubLogin}` : '');
    return entry.name ? `${entry.name} <${address}>` : address;
  });
  return shown.join(', ') + ((people ?? []).length > limit ? ` and ${people.length - limit} more` : '');
}

/**
 * What a refused self-approval adds: who else the groups name, or, when they name nobody else, the two ways that
 * still work: another person with access approves it, or a change to sflow/config merged on the Git host (D6).
 */
export function selfApprovalRefusalWords(approvers, proposer) {
  if (!Array.isArray(approvers)) return '';
  const others = otherApprovers(approvers, proposer);
  return others.length
    ? ` The approval groups name ${approverWords(others)}; any of them can approve it.`
    : ' The approval groups name nobody but you: someone else with access approves it, or the owner turns self-approval back on in sflow/config on the Git host.';
}

/**
 * Refuses, before anything is proposed, turning self-approval off while the approval groups of `workflow` (and `portfolio`)
 * name nobody but `people` (the person and the Git identity their commit names): each later configuration change would
 * then need someone other than its proposer, and none exists, the one turning it back on included [D4].
 */
export function refuseLastApprover(workflow, portfolio, people) {
  const named = namedApprovers(workflow, portfolio);
  if (people.reduce((others, person) => otherApprovers(others, person ?? {}), named).length) return;
  const command = 'singularity-flow configuration add-current-identity';
  throw new SingularityFlowError(`Self-approval stays on: the approval groups name ${named.length ? `only you (${approverWords(named)})` : 'nobody'}, `
    + 'so with it off nobody could approve a configuration change. Nothing was proposed.',
  { code: 'CONFIGURATION_SELF_APPROVAL_NO_SECOND_PERSON', details: { members: named,
    // The second person adds themselves from their own clone; once that is approved, self-approval may be turned off.
    nextAction: { command, label: 'A second person adds themselves, then turn self-approval off' } } });
}
