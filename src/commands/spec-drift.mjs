/**
 * `singularity-flow spec drift [--work-id ID] [--ref REV] [--all] [--json]`: whether closed Stories'
 * approved clauses still match the code and tests (src/spec-drift.mjs). Read-only and advisory.
 *
 * `singularity-flow spec drift decide CLAUSE-ID (--accept | --adopt --story ID | --restore --story ID) --reason TEXT`
 * `singularity-flow spec drift decide --revoke DRD-NNN --work-id ID --reason TEXT`
 * A person who approves the step that delivered the clause records how its drift is resolved, in
 * singularity/spec-drift/<WORK-ID>.json, committed on the current branch. The Copilot guard refuses it.
 */
import { readFileSync as readFileSyncSafe } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { requireApprovalAuthority } from '../approval-authority.mjs';
import { branch, commitExactPaths, refHead, repoRoot } from '../git.mjs';
import { because, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  driftDecisionsPath, evaluateSpecDrift, readDriftDecisions, recordDriftDecision, recordDriftRevocation, recordedStories
} from '../spec-drift.mjs';
import { actorKey, loadConfig } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { testRunRiskAuthorities } from './decision-test-risk.mjs';
import { actionActor } from './kernel.mjs';

const LABEL = Object.freeze({ 'in-sync': 'in sync', drifted: 'drifted', orphaned: 'orphaned', unverifiable: 'unverifiable',
  accepted: 'drift accepted', resolving: 'resolving', adopted: 'adopted', restored: 'restored' });

/** The plain-text report: every clause that is not in sync, with what changed and by which commits. */
export function renderSpecDrift(report, { all = false } = {}) {
  const lines = [`Spec drift against ${report.target} (advisory; nothing is refused):`];
  if (!report.stories.length) lines.push('  No closed Story with approved code is recorded in this checkout.');
  for (const story of report.stories) {
    const shown = story.clauses.filter((clause) => all || clause.status !== 'in-sync');
    if (!shown.length && !story.findings.length && !all) continue;
    lines.push('', `${story.workId}${story.title ? ` ${story.title}` : ''} (${story.status})`);
    for (const finding of story.findings) lines.push(`  ! ${finding.message}`);
    for (const clause of shown) {
      const decided = clause.decision ? ` (${clause.decision.id}${clause.decision.story ? ` → ${clause.decision.story}` : ''} by ${clause.decision.actor}: ${clause.decision.reason})` : '';
      lines.push(`  ${clause.clauseId.padEnd(18)} ${LABEL[clause.status] ?? clause.status}${decided}`);
      for (const finding of clause.findings) {
        const by = finding.commits?.length ? ` (${finding.commits.map((entry) => `${entry.commit} ${entry.subject}`).join('; ')})` : '';
        lines.push(`      - ${finding.message}${by}`);
      }
    }
  }
  const summary = report.summary;
  const decided = ['accepted', 'resolving', 'adopted', 'restored'].filter((status) => summary[status])
    .map((status) => `${summary[status]} ${LABEL[status]}`);
  lines.push('', `${summary.stories} closed Stor${summary.stories === 1 ? 'y' : 'ies'}, ${summary.clauses} clause(s): ${summary['in-sync']} in sync, ${summary.drifted} drifted, ${summary.orphaned} orphaned, ${summary.unverifiable} unverifiable${decided.length ? `; ${decided.join(', ')}` : ''}.`);
  if (summary.drifted || summary.orphaned) {
    lines.push('A person who approves the step that delivered a drifted clause resolves it: singularity-flow spec drift decide CLAUSE-ID'
      + ' (--adopt --story ID: the specification follows the code | --restore --story ID: the code follows the specification | --accept) --reason TEXT.');
  }
  return lines.join('\n');
}

export async function specDriftCommand(positionals, options) {
  if (positionals[2] === 'decide') return specDriftDecideCommand(positionals, options);
  const root = repoRoot();
  const config = await loadConfig(root);
  const ref = optionString(options, 'ref') ?? null;
  if (ref && !refHead(root, ref)) throw new SingularityFlowError(`--ref ${ref} names no commit in this clone.`, { code: 'SPEC_DRIFT_REF_UNKNOWN' });
  const workId = optionString(options, 'work-id') ?? positionals[2] ?? null;
  const report = evaluateSpecDrift(root, { workItemRoot: config.workItemRoot ?? 'singularity/work-items', workId, ref });
  if (workId && !report.stories.length) {
    throw new SingularityFlowError(`No Story ${workId} is recorded in this checkout.`, { code: 'SPEC_DRIFT_STORY_UNKNOWN' });
  }
  if (!optionBoolean(options, 'json')) return console.log(renderSpecDrift(report, { all: optionBoolean(options, 'all') }));
  return emitCommandResult(commandResult({
    operation: { id: 'spec.drift', classification: 'read' },
    subject: { kind: workId ? 'story' : 'repository', id: workId ?? 'repository' },
    outcome: succeeded('spec.drift.reported', {
      stories: report.summary.stories, clauses: report.summary.clauses,
      drifted: report.summary.drifted, orphaned: report.summary.orphaned
    }),
    effects: noEffects(),
    why: [because('spec.drift.from-approved-receipts', 'evidence', { ref: report.target })],
    restState: 'informational',
    data: { drift: report }
  }), { json: true, restStateWhenIdle: 'informational' });
}

/** The closed Story whose namespace a clause ID carries. */
function storyOfClause(stories, clauseId) {
  const namespace = String(clauseId ?? '').split(':')[0];
  return stories.find((story) => !story.unreadable && String(story.workItem?.id ?? '').toUpperCase() === namespace) ?? null;
}

export async function specDriftDecideCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workItemRoot = config.workItemRoot ?? 'singularity/work-items';
  const stories = recordedStories(root, workItemRoot);
  const revoke = optionString(options, 'revoke') ?? null;
  const clauseId = positionals[3] ?? null;
  if (!revoke === !clauseId) {
    throw new SingularityFlowError('Name a drifted clause (spec drift decide CLAUSE-ID ...), or a decision to revoke with --revoke DRD-NNN --work-id ID.', { code: 'SPEC_DRIFT_DECISION_INVALID' });
  }
  const current = branch(root);
  const open = stories.find((story) => !story.unreadable && story.workItem?.id === current && story.status !== 'closed');
  if (open) {
    throw new SingularityFlowError(`Record drift decisions on the default branch or a branch of their own, not on open Story ${open.workItem.id}'s branch: its own gates do not expect these files.`, { code: 'SPEC_DRIFT_DECISION_BRANCH' });
  }
  const story = revoke ? stories.find((entry) => entry.workItem?.id === optionString(options, 'work-id')) ?? null : storyOfClause(stories, clauseId);
  if (!story || story.unreadable) {
    throw new SingularityFlowError(revoke ? 'Name the Story whose decision you revoke with --work-id ID.' : `No Story recorded in this checkout owns ${clauseId}.`, { code: 'SPEC_DRIFT_STORY_UNKNOWN' });
  }
  const workId = story.workItem.id;
  const relative = driftDecisionsPath(workId);
  const absolute = path.join(root, relative);
  const existing = { schemaVersion: 1, workId, decisions: readDriftDecisions(await readFile(absolute).catch(() => null)) };
  let clause = null;
  if (!revoke) {
    const report = evaluateSpecDrift(root, { workItemRoot, workId, stories });
    clause = report.stories[0]?.clauses.find((entry) => entry.clauseId === clauseId) ?? null;
    if (!clause) throw new SingularityFlowError(`${workId} has no approved clause ${clauseId} with delivered code.`, { code: 'SPEC_DRIFT_CLAUSE_UNKNOWN' });
  }
  const phaseId = clause?.phase ?? existing.decisions.find((entry) => entry.id === revoke)?.phase ?? null;
  const groups = testRunRiskAuthorities(story, phaseId);
  if (!groups.length) throw new SingularityFlowError(`Step ${phaseId} of ${workId} has no approval group, so nobody can decide its drift.`, { code: 'RISK_AUTHORITY_UNAVAILABLE' });
  const actor = actionActor(root);
  const authority = requireApprovalAuthority(story.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const common = { workId, reason: optionString(options, 'reason') ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const outcomes = ['accept', 'adopt', 'restore'].filter((outcome) => optionBoolean(options, outcome));
  if (!revoke && outcomes.length !== 1) throw new SingularityFlowError('Choose exactly one of --accept, --adopt or --restore.', { code: 'SPEC_DRIFT_DECISION_INVALID' });
  const { file, decision } = revoke
    ? recordDriftRevocation(existing, { decisionId: revoke, ...common })
    : recordDriftDecision(existing, { clause, outcome: outcomes[0], story: optionString(options, 'story') ?? null, ...common,
      content: (file) => readFileBytes(root, file) });
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(file, null, 2)}\n`);
  const commit = commitExactPaths(root, [relative], `[${workId}][spec-drift:${revoke ? 'revoke' : decision.outcome}] ${revoke ?? clauseId}`);
  if (!optionBoolean(options, 'json')) {
    console.log(revoke
      ? `Revoked ${revoke} on ${decision.clauseId}.`
      : `Recorded ${decision.id}: ${clauseId} ${decision.outcome === 'accept' ? 'drift accepted while the code and tests keep these bytes' : `resolving through ${decision.story} (${decision.outcome})`}, decided through ${decision.authorityGroup}.`);
    console.log(`Committed ${commit.slice(0, 8)} on ${current ?? 'the current branch'} with only ${relative}; push it or open a pull request to share it.`);
  }
  if (optionBoolean(options, 'json')) emitCommandResult(commandResult({
    operation: { id: 'spec.drift.decide', classification: 'mutation' },
    subject: { kind: 'story', id: workId },
    outcome: succeeded('spec.drift.decided', { record: decision.id ?? `the revocation of ${revoke}`, clause: decision.clauseId }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: false }),
    data: { commit, path: relative, decision }
  }), { json: true });
}

function readFileBytes(root, relative) {
  try { return readFileSyncSafe(path.join(root, relative)); } catch { return null; }
}
