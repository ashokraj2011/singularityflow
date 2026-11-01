/**
 * `singularity-flow spec split SPEC-ID@N [--propose --file FILE | --publish]` (SPEC-SPA v1.3 §7, S5).
 *
 * Without a flag it reads: the splits published for that revision and the plan proposed on this clone,
 * each Story slice with its ready `start` command. `--propose --file FILE` checks a plan (JSON or YAML)
 * against the reviewed revision and keeps it on this clone; anyone, an agent included, may propose.
 * `--publish` is the person's own step (OWN_TERMINAL_STEPS `spec-split-publication`): it publishes the
 * proposed plan to the state branch, then drafts each child specification on this clone. It starts no
 * Story; each slice's command is run by whoever takes that Story. Nothing here calls a model.
 */
import { repoRoot } from '../git.mjs';
import { newDraft } from '../spec-library/draft-model.mjs';
import { crashPoint, readDraft, requireOperationId, saveDraft } from '../spec-library/draft-store.mjs';
import { parseSpecReference } from '../spec-library/ids.mjs';
import { libraryView, resolveRevision } from '../spec-library/library.mjs';
import {
  analyzeSplit, childClauses, childSpecText, proposeCommand, publishSplit, readPlanFile, readProposal, readSplits, refuseFindings,
  removeProposal, stageProposal
} from '../spec-library/split.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

function planLines(name, analysis) {
  const { plan, stories } = analysis;
  const short = (clause) => clause.slice(clause.indexOf(':') + 1);
  return [
    ...plan.children.map((child) => `  child ${child.specId} "${child.title}": ${child.clauses.map(short).join(', ')}`),
    ...stories.map((story) => `  slice ${story.key} "${story.title}": ${story.clauses.map(short).join(', ')}${story.dependsOn.length ? ` (after ${story.dependsOn.join(', ')})` : ''}\n    ${story.command}`),
    ...plan.notDelivered.map((entry) => `  not delivered here: ${short(entry.clause)}: ${entry.reason}`)
  ].join('\n') || `  (an empty split of ${name})`;
}

/** The reviewed revision a split divides, read from one pinned state commit. */
async function reviewedRevision(root, config, specId, revision) {
  const view = await libraryView(root, config);
  const read = resolveRevision(root, view, specId, revision, { anyState: true });
  if (read.manifest.reviewState !== 'reviewed') {
    fail(`${specId}@${revision} is a draft revision; only a reviewed revision can be split, as only a reviewed one can be attached to a Story.`, 'SPEC_LIBRARY_NOT_REVIEWED',
      { specId, revision, nextAction: `singularity-flow spec author show ${specId}` });
  }
  return { view, read: { ...read, specId } };
}

async function proposeAction(root, config, name, read, options, { actor, print }) {
  const file = optionString(options, 'file');
  if (!file) fail(`spec split ${name} --propose names the plan: --file FILE (JSON or YAML with children, stories and notDelivered).`, 'SPEC_SPLIT_PLAN_INVALID', { nextAction: proposeCommand(name) });
  const analysis = analyzeSplit(read, await readPlanFile(file));
  if (analysis.findings.length) refuseFindings(read, analysis.findings);
  const record = await stageProposal(root, read, analysis.plan, { actor: actor(root) });
  return print(options, { action: 'split', mode: 'propose', specId: read.specId, revision: read.revision, planSha256: record.planSha256,
    plan: analysis.plan, stories: analysis.stories, order: analysis.order },
  `Proposed a split of ${name} on this clone; nothing is published yet.\n${planLines(name, analysis)}\nThe person publishes it: singularity-flow spec split ${name} --publish`);
}

async function publishAction(root, config, name, read, options, { actor, print }) {
  const proposal = await readProposal(root, read.specId, read.revision);
  if (!proposal) fail(`No split of ${name} is proposed on this clone.`, 'SPEC_SPLIT_PROPOSAL_MISSING', { specId: read.specId, nextAction: proposeCommand(name) });
  if (proposal.damaged || proposal.manifestSha256 !== read.manifestSha256) {
    fail(`The split proposed for ${name} on this clone ${proposal.damaged ? `cannot be read (${proposal.reason})` : 'was checked against other bytes of that revision'}; nothing was published. Propose it again.`,
      'SPEC_SPLIT_PROPOSAL_STALE', { specId: read.specId, nextAction: proposeCommand(name) });
  }
  const analysis = analyzeSplit(read, proposal.plan);
  if (analysis.findings.length) refuseFindings(read, analysis.findings);
  const operationId = optionString(options, 'operation-id')
    ? requireOperationId(optionString(options, 'operation-id'))
    : `sps-${proposal.planSha256.slice('sha256:'.length, 'sha256:'.length + 16)}-${read.revision}`;
  // A child's draft is created after the split lands; one already on this clone from anything else stops it first.
  for (const child of analysis.plan.children) {
    const existing = await readDraft(root, child.specId);
    if (existing?.head && existing.head.draft.derivedFrom?.operationId !== operationId) {
      fail(`${child.specId} already has a draft on this clone, so the split cannot draft it. Nothing was published: discard that draft, or give the child another ID and propose again.`,
        'SPEC_DRAFT_EXISTS', { specId: child.specId, nextAction: `singularity-flow spec author status ${child.specId}` });
    }
  }
  const who = actor(root);
  const command = `singularity-flow spec split ${name} --publish --operation-id ${operationId}`;
  const published = await publishSplit(root, config, { revision: read, analysis, operationId, actor: who, command });
  crashPoint('spec-split-published');
  const { split } = published.record;
  const drafted = [];
  for (const child of analysis.plan.children) {
    const derivedFrom = { specId: read.specId, revision: read.revision, manifestSha256: read.manifestSha256, split, operationId, clauses: childClauses(read, child) };
    const spec = childSpecText(read, child, { split });
    const saved = await saveDraft(root, child.specId, {
      operationId: `${operationId}.${child.specId}`, operation: 'new', create: true, actor: who,
      payload: { title: child.title, from: `split ${split} of ${name}`, spec, derivedFrom },
      change: () => ({ ...newDraft({ title: child.title, spec }), derivedFrom })
    });
    drafted.push({ specId: child.specId, sequence: saved.snapshot.sequence, replayed: saved.replayed });
  }
  await removeProposal(root, read.specId, read.revision, proposal.planSha256);
  return print(options, { action: 'split', mode: 'publish', specId: read.specId, revision: read.revision, split, replayed: published.replayed,
    commit: published.commit, operationId, children: drafted, stories: published.record.stories, notDelivered: published.record.notDelivered },
  [`${published.replayed ? 'Already published' : 'Published'} split ${split} of ${name} to the state branch${published.commit ? ` at ${published.commit.slice(0, 12)}` : ''}. No Story was started.`,
    ...drafted.map((child) => `  child ${child.specId}: ${child.replayed ? 'drafted before' : 'drafted'} on this clone (snapshot ${child.sequence}); author it with singularity-flow spec author status ${child.specId}`),
    ...published.record.stories.map((story) => `  slice ${story.key} "${story.title}":\n    ${story.command}`)].join('\n'));
}

async function readAction(root, name, view, read, options, { print }) {
  const { splits, unreadable } = readSplits(root, view, read.specId);
  const ofRevision = splits.filter((entry) => entry.revision === read.revision);
  const proposal = await readProposal(root, read.specId, read.revision);
  const pending = proposal && !proposal.damaged ? { ...analyzeSplit(read, proposal.plan), planSha256: proposal.planSha256, proposedBy: proposal.proposedBy, proposedAt: proposal.proposedAt,
    stale: proposal.manifestSha256 !== read.manifestSha256 } : null;
  const lines = [`${name}: ${ofRevision.length ? `${ofRevision.length} published split(s), the latest split ${ofRevision.at(-1).split}` : 'no published split'}${pending ? '; a plan is proposed on this clone' : ''}.`];
  for (const split of ofRevision) {
    lines.push(`Split ${split.split}, published ${split.recordedAt} by ${split.publishedBy?.name ?? 'unknown'}:`,
      ...split.children.map((child) => `  child ${child.specId} "${child.title}"`),
      ...split.stories.map((story) => `  slice ${story.key} "${story.title}":\n    ${story.command}`));
  }
  if (pending) lines.push('Proposed on this clone:', planLines(name, pending), pending.findings.length ? `It is refused as it stands: ${pending.findings.map((entry) => entry.message).join('; ')}` : `Publish it: singularity-flow spec split ${name} --publish`);
  if (proposal?.damaged) lines.push(`The proposal on this clone cannot be read (${proposal.reason}); propose the plan again.`);
  if (unreadable.length) lines.push(`Unreadable splits, not shown: ${unreadable.join(', ')}`);
  return print(options, { action: 'split', mode: 'read', specId: read.specId, revision: read.revision, stateCommit: view.commit, manifestSha256: read.manifestSha256,
    splits: ofRevision, unreadable,
    proposal: pending && { plan: pending.plan, planSha256: pending.planSha256, proposedBy: pending.proposedBy, proposedAt: pending.proposedAt, stale: pending.stale,
      findings: pending.findings, stories: pending.stories, order: pending.order } },
  lines.join('\n'));
}

export async function specSplitCommand(positionals, options, helpers) {
  const reference = positionals[2];
  if (!reference) fail('spec split needs a reviewed revision, for example SPEC-CHK-004@3.', 'SPEC_REFERENCE_INVALID', { nextAction: 'singularity-flow spec author list' });
  helpers.refuseStrayValues('spec split', positionals, 3);
  const { specId, revision } = parseSpecReference(reference);
  if (revision === null) fail(`spec split needs the revision it divides: ${specId}@N.`, 'SPEC_REFERENCE_INVALID', { specId, nextAction: `singularity-flow spec author show ${specId}` });
  const propose = optionBoolean(options, 'propose');
  const publish = optionBoolean(options, 'publish');
  const name = `${specId}@${revision}`;
  if (propose && publish) fail(`Propose and publish a split separately: first --propose --file FILE, then --publish.`, 'SPEC_SPLIT_PLAN_INVALID', { nextAction: proposeCommand(name) });
  const root = repoRoot();
  const config = await helpers.libraryConfig(root);
  const { view, read } = await reviewedRevision(root, config, specId, revision);
  if (propose) return proposeAction(root, config, name, read, options, helpers);
  if (publish) return publishAction(root, config, name, read, options, helpers);
  return readAction(root, name, view, read, options, helpers);
}
