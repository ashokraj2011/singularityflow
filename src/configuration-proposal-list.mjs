/**
 * One list for every configuration proposal, of every kind [SCF:REQ-010]: drafts saved on this machine,
 * workflow, people and package proposals (approved with `configuration approve`), capability and repository
 * setup proposals, and an upgrade the Git host would not take directly, kept on a `sflow/config-refresh/*`
 * review branch for a merge there (D10). Each row says its kind, its author, its state and the one way to
 * act on it. A source that cannot be read is named, never shown as "nothing waiting".
 */
import { CONFIGURATION_BRANCH, resolveConfigurationRemote } from './configuration-branch.mjs';
import { configurationProposalKind } from './configuration-state-contract.mjs';
import { GitRemoteSession } from './git-execution.mjs';

/** The five states a person sees [SCF:REQ-009], plus why a proposal cannot be approved yet. */
const STATE_WORDS = Object.freeze({
  draft: 'draft (saved, not yet proposed)', proposed: 'proposed', 'needs-choice': 'needs a choice',
  approved: 'approved', rejected: 'rejected', blocked: 'proposed, cannot be approved yet',
  unreadable: 'could not be read', 'merge-on-host': 'proposed, merged on the Git host'
});

const approveCommand = (branch) => `singularity-flow configuration approve ${branch}`;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
/**
 * A row's two ways on, whole [audit 2026-11-19, entry 23]: approve or reject exactly the revision listed, so only the
 * reason is the person's to write. A proposal that needs a choice, or that approval would refuse, is read first, so
 * its approve route names no revision; with no revision known, neither does its reject route.
 */
export function proposalRoutes(branch, revision, state, lead = null) {
  const on = lead ? ` --lead ${lead}` : '';
  const exact = REVISION.test(revision ?? '') ? ` --confirm ${revision}` : '';
  return {
    act: { label: state === 'needs-choice' ? 'Approve, keeping one value for each field both changed' : 'Read it, then approve or reject it',
      command: `${approveCommand(branch)}${on}${['needs-choice', 'blocked'].includes(state) ? '' : exact}` },
    reject: { label: 'Reject it, saying why (its author reads the reason)', command: `singularity-flow configuration reject ${branch}${on}${exact} --reason "<REASON>"` }
  };
}

function engineRow(entry) {
  const kind = entry.kind ?? configurationProposalKind(entry.branch) ?? 'workflow';
  const state = entry.status === 'unreadable' ? 'unreadable' : entry.merged ? 'approved'
    : entry.valid === false ? 'blocked' : entry.state === 'needs-choice' ? 'needs-choice' : 'proposed';
  const subjects = [...(entry.workflows ?? []).map((row) => `${row.label ?? row.id} (${row.change})`),
    ...(entry.repositoryTests ? [`${entry.repositoryTests.label} (${entry.repositoryTests.change})`] : [])];
  return {
    kind, id: entry.branch, branch: entry.branch, state, revision: entry.proposalCommit ?? null,
    author: entry.proposer ? { name: entry.proposer.name ?? null, email: entry.proposer.email ?? null } : null,
    createdAt: entry.proposalCreatedAt ?? null, subjects,
    ...(entry.failure?.message ? { reason: entry.failure.message } : {}),
    ...(state === 'approved' ? { act: null } : proposalRoutes(entry.branch, entry.proposalCommit, state))
  };
}

/**
 * Every proposal waiting for `root`'s configuration authority, with `lead` (or the first known lead) for
 * capability and repository setup proposals. `{ proposals, sources }`: `sources` says what was read.
 */
export async function listEveryConfigurationProposal(root, { lead = null, env = process.env } = {}) {
  const proposals = [];
  const sources = [];
  const read = async (source, work) => {
    try { const count = await work(); sources.push({ source, status: 'read', count }); }
    catch (error) { sources.push({ source, status: 'unavailable', code: error?.code ?? null, reason: error?.message ?? String(error) }); }
  };
  await read('drafts', async () => {
    const { readDrafts } = await import('./configuration-drafts.mjs');
    const drafts = await readDrafts(root);
    for (const entry of drafts.changes ?? []) {
      proposals.push({ kind: 'workflow', id: entry.draftId, state: 'draft', author: null, createdAt: entry.addedAt ?? null,
        subjects: [entry.description].filter(Boolean),
        act: { label: 'Propose the saved drafts as one review', command: 'singularity-flow configuration propose' } });
    }
    return (drafts.changes ?? []).length;
  });
  await read('proposals', async () => {
    const { listWorkflowConfigurationProposals } = await import('./configuration-proposal.mjs');
    const listed = await listWorkflowConfigurationProposals(root, { env });
    for (const entry of listed) proposals.push(engineRow(entry));
    return listed.length;
  });
  await read('upgrade-reviews', async () => {
    const remote = await resolveConfigurationRemote(root, 'origin');
    if (!remote) return 0;
    const session = new GitRemoteSession({ cwd: root, env });
    const observed = await session.observeAsync(remote, { refs: ['refs/heads/sflow/config-refresh/*'], includeHead: false, refresh: true });
    if (!observed?.ok) throw Object.assign(new Error('The configuration authority could not be listed.'), { code: 'REMOTE_UNKNOWN' });
    const reviews = [...observed.refs].filter(([ref]) => ref.startsWith('refs/heads/sflow/config-refresh/'));
    for (const [ref, commit] of reviews) {
      const branch = ref.slice('refs/heads/'.length);
      proposals.push({ kind: 'package', id: branch, branch, state: 'merge-on-host', revision: commit, author: null, subjects: ['Packaged configuration the Git host would not take directly'],
        act: { label: `Merge it into ${CONFIGURATION_BRANCH} on the Git host`, command: null } });
    }
    return reviews.length;
  });
  const leadUrl = lead ?? await import('./lead-repositories.mjs').then(({ listLeadRepositories }) => listLeadRepositories())
    .then((leads) => leads?.[0]?.url ?? null).catch(() => null);
  if (leadUrl) {
    await read('capability', async () => {
      const { listCapabilityProposals } = await import('./organisation.mjs');
      const listed = await listCapabilityProposals(leadUrl, { includeDiff: false, env });
      for (const entry of listed) {
        const state = entry.merged ? 'approved' : entry.valid === false ? 'blocked' : 'proposed';
        proposals.push({ kind: 'capability', id: entry.branch, branch: entry.branch, revision: entry.proposalCommit ?? null, state,
          author: entry.proposer ?? null, subjects: [entry.capabilityId ?? entry.capability?.id].filter(Boolean),
          // Approved like every other proposal [SCF:REQ-010].
          ...proposalRoutes(entry.branch, entry.proposalCommit, state, leadUrl) });
      }
      return listed.length;
    });
    await read('setup', async () => {
      const { listRepositoryOnboardingProposals } = await import('./repository-onboarding.mjs');
      const listed = await listRepositoryOnboardingProposals(leadUrl, { env });
      for (const entry of listed) {
        const state = entry.merged ? 'approved' : 'proposed';
        proposals.push({ kind: 'onboarding', id: entry.branch, branch: entry.branch, revision: entry.proposalCommit ?? null, state,
          author: null, subjects: ['Repository setup'], ...proposalRoutes(entry.branch, entry.proposalCommit, state, leadUrl) });
      }
      return listed.length;
    });
  }
  return { schemaVersion: 1, resultType: 'configuration-proposals', proposals, sources };
}

/** The list as a person reads it: one line per proposal, then who made it, what it changes and what to do. */
export function proposalListLines(result) {
  const lines = [];
  const waiting = result.proposals.filter((entry) => entry.state !== 'approved');
  if (!waiting.length) lines.push('No configuration proposals or drafts are waiting.');
  for (const entry of waiting) {
    lines.push(`${entry.kind.padEnd(10)} ${STATE_WORDS[entry.state] ?? entry.state}  ${entry.branch ?? entry.id}`);
    if (entry.author?.name || entry.author?.email) lines.push(`  by ${entry.author.name ?? entry.author.email}`);
    for (const subject of entry.subjects ?? []) lines.push(`  ${subject}`);
    if (entry.reason) lines.push(`  why not yet: ${entry.reason}`);
    if (entry.act?.command) lines.push(`  next: ${entry.act.command}`);
    else if (entry.act?.label) lines.push(`  next: ${entry.act.label}`);
    if (entry.reject?.command) lines.push(`  or reject it: ${entry.reject.command}`);
  }
  for (const source of result.sources.filter((entry) => entry.status !== 'read')) {
    lines.push(`Could not read the ${source.source} list: ${source.reason}`);
  }
  return lines;
}
