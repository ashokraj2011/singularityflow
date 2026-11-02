/**
 * SF Guard M4: the required remote check, `governance verify --presence` (SPEC-PSS-v1 REQ-021,
 * REQ-030, REQ-042, AC-011).
 *
 * A clone can be patched, and a local check runs on the same computer as the agent. So the boundary
 * is this check, run by an unmodified SFlow on the Git host's CI as a required status check of the
 * default branch. Against the base of the change it verifies:
 *
 * - the policy file only grew, and every event it adds verifies (an unsigned `disable`, a forged
 *   `register` or a rewritten history fails);
 * - each key event the change adds is listed on the approver's GitHub account now, and a recovery's
 *   old key is not (GitHub unreachable leaves it "unconfirmed", never failing for that alone);
 * - a host-reviewed exception the change adds (the lone-approver fallback) was approved on the host;
 * - every person record each Story adds verifies against its pinned keys, no person record
 *   disappears, and no withdrawal or invalidation is taken back;
 * - a Story the change adds that reads as `pre-signing` was really created before the opt-in: by
 *   commit ancestry, then by when the host first received each commit;
 * - each counted approval's sealed review packet, which carries the step's SF Guard labels, still
 *   holds the bytes the approval signed (SPEC-SFG-v1 AC-009).
 *
 * A record already on the base that does not verify is reported, not failed, so an unrelated change
 * is never held by an older one. A repository that never opted in passes with nothing to check.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { githubListsKey, githubSigningKeys } from './anchor.mjs';
import {
  extendsPresenceChain, foldPresenceChain, hostReviewedException, parsePresenceChain, PRESENCE_CHAIN_PATH, presenceApprovers,
  presenceEventDigest
} from './chain.mjs';
import { firstPushTime, githubRepository, hostReview } from './host.mjs';
import { personRecordRoute, presenceHistoryProblems, storyPersonRecords, storyPresenceReport } from './story-verify.mjs';

const KEY_EVENTS = new Set(['register', 'rotate', 'recover']);
const NO_BASE = /^0+$/u;

function defaultDependencies(root, { token, repository }) {
  const git = import('../git.mjs');
  const committed = async (ref, relative) => {
    const { committedFilesAtRevisions } = await git;
    try { return committedFilesAtRevisions(root, [{ key: relative, ref, path: relative }]).get(relative)?.toString('utf8') ?? null; }
    catch (error) {
      throw new SingularityFlowError(`SF Guard's remote check cannot read ${relative} at the base ${String(ref).slice(0, 12)}: ${error.message}. Check out the full history (actions/checkout with fetch-depth: 0).`,
        { code: 'PSS_REMOTE_BASE_UNAVAILABLE', details: { base: ref } });
    }
  };
  return {
    readPolicy: async (verify) => (await import('./store.mjs')).readPresencePolicy(root, verify ? { verify } : {}),
    loadDefinition: async () => {
      const [{ withApprovedConfigurationRead }, { loadDefinition }] = await Promise.all([import('../approved-configuration-reader.mjs'), import('../config.mjs')]);
      return withApprovedConfigurationRead(root, () => loadDefinition(root), { preferAuthority: true });
    },
    readHeadFile: (relative) => readFile(path.join(root, relative), 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error))),
    readBaseFile: committed,
    listStories: async (workItemRoot) => {
      const directory = path.join(root, workItemRoot);
      const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
      const stories = [];
      for (const entry of names.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
        const relative = path.posix.join(workItemRoot.replaceAll('\\', '/'), entry.name, 'workflow.json');
        const text = await readFile(path.join(root, relative), 'utf8').catch(() => null);
        if (text == null) continue;
        try { stories.push({ id: entry.name, relative, workflow: JSON.parse(text) }); }
        catch { stories.push({ id: entry.name, relative, workflow: null }); }
      }
      return stories;
    },
    creationCommit: async (relative) => (await git).commitAddingPath(root, relative),
    isAncestor: async (older, newer) => (await git).isAncestor(root, older, newer),
    configurationRevisions: async (tip) => (await git).pathRevisions(root, tip, PRESENCE_CHAIN_PATH) ?? [],
    signingKeys: (login) => githubSigningKeys(login, { token }),
    firstPushTime: async (commit) => {
      const { isAncestor } = await git;
      return firstPushTime(repository, commit, { contains: (older, newer) => isAncestor(root, older, newer), token });
    },
    hostReview: (target) => hostReview(repository, target, { token }),
    headCommit: async () => (await git).refCommit(root, 'HEAD')
  };
}

/** The GitHub repository the check runs for: the CI's own, else this clone's origin. */
export async function checkRepository(root, { env = process.env } = {}) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (owner && repo) return githubRepository(`https://${['github', 'com'].join('.')}/${owner}/${repo}`);
  const { remoteUrl } = await import('../git.mjs');
  return githubRepository(remoteUrl(root, 'origin'));
}

/**
 * Run the remote check in `root` (a checkout of the change). `base` is the base commit of the change
 * (a pull request's base, or the default branch before a push); without it every record is checked.
 * Returns the report; it never throws for what it finds, only for a base it cannot read.
 */
export async function remotePresenceCheck(root, { base = null, pullRequest = null, token = null, repository = null, verify = undefined } = {}, dependencies = {}) {
  const baseRef = base && !NO_BASE.test(base) ? base : null;
  const deps = { ...defaultDependencies(root, { token, repository }), ...dependencies };
  const failures = [];
  const warnings = [];
  const unconfirmed = [];
  const confirmed = [];
  const fail = (code, message, route, extra = {}) => failures.push({ code, message, route: route ?? null, ...extra });
  const verifyOption = verify ? { verify } : {};

  const policy = await deps.readPolicy(verify);
  const definition = await deps.loadDefinition();
  const workItemRoot = definition?.workItemRoot ?? 'singularity/work-items';
  const headChain = parsePresenceChain(await deps.readHeadFile(PRESENCE_CHAIN_PATH)).chain;
  const baseChain = baseRef ? parsePresenceChain(await deps.readBaseFile(baseRef, PRESENCE_CHAIN_PATH)).chain : null;
  const stories = await deps.listStories(workItemRoot);
  const folded = policy.folded;
  const chain = { chainId: folded.chainId ?? headChain?.chainId ?? null, events: headChain?.events?.length ?? 0, validEvents: folded.validLength,
    enabled: Boolean(folded.enabled), remoteCheck: folded.remoteCheck ?? null };
  if (!policy.present && !baseChain && !stories.some((story) => story.workflow?.resolution?.presence)) {
    return report({ status: 'not-opted-in', base: baseRef, chain, failures, warnings, unconfirmed, confirmed, stories: [] });
  }

  // 1. The policy file only grows, and what it adds verifies.
  for (const problem of policy.problems.filter((entry) => entry.code === 'PSS_POLICY_REWRITTEN')) {
    fail('PSS_POLICY_REWRITTEN', problem.message, `keep every event of ${PRESENCE_CHAIN_PATH}; restore the dropped ones from the last commit that had them`);
  }
  if (baseChain && !extendsPresenceChain(baseChain, headChain)) {
    fail('PSS_POLICY_REWRITTEN', `This change drops or rewrites SF Guard events: the base has ${baseChain.events.length}, the change keeps ${headChain?.events?.length ?? 0} of them unchanged or fewer.`,
      `keep ${PRESENCE_CHAIN_PATH} as the base has it and only append events a person signs (singularity-flow guard …, in their own terminal)`);
  }
  const headFold = foldPresenceChain(headChain, verifyOption);
  const baseLength = baseChain?.events?.length ?? 0;
  if (headChain && headFold.validLength < headChain.events.length) {
    const problem = headFold.problems[0];
    const added = !baseRef || headFold.validLength >= baseLength;
    const entry = { code: problem?.code ?? 'PSS_POLICY_UNSIGNED', message: problem?.message ?? 'An SF Guard event does not verify.',
      route: 'remove the event; a person records it with singularity-flow guard … in their own terminal, where it takes their Touch ID' };
    if (added) failures.push(entry);
    else warnings.push(`${entry.message} (already on the base; the valid events before it stay in force)`);
  }
  const validEvents = (headChain?.events ?? []).slice(0, headFold.validLength);
  const approvers = presenceApprovers(definition);

  // 2. New key events are on GitHub now; a recovery's lost key is not.
  if (baseRef) {
    for (const event of validEvents.filter((entry) => KEY_EVENTS.has(entry.kind) && entry.seq >= baseLength)) {
      // An author (SPEC-PSS-v1 §10.5) is in no member entry: their event names the login it is confirmed under.
      const login = approvers.get(event.approver)?.githubLogin ?? (event.role === 'author' && typeof event.githubLogin === 'string' ? event.githubLogin : null);
      const name = `SF Guard event ${event.seq} (${event.kind} ${event.keyId} for ${event.approver})`;
      if (!login) {
        fail('PSS_KEY_NOT_LISTED', `${name}: the approver has no GitHub login in the approved configuration, so the key cannot be confirmed.`,
          'add the approver\'s githubLogin to their member entry, or drop the event');
        continue;
      }
      const snapshot = await deps.signingKeys(login);
      if (snapshot.status === 'unavailable') { unconfirmed.push(`${name}: GitHub could not be read (${snapshot.reason}); confirm it on a later run`); continue; }
      if (!githubListsKey(snapshot, event.keyId)) {
        fail('PSS_KEY_NOT_LISTED', `${name}: GitHub does not list ${event.keyId} as a signing key of ${login}.`,
          'drop the event; the approver registers a key their GitHub account lists (singularity-flow guard register, in their own terminal)');
        continue;
      }
      if (event.kind === 'recover' && githubListsKey(snapshot, event.previousKeyId)) {
        fail('PSS_KEY_STILL_LISTED', `${name}: GitHub still lists the lost key ${event.previousKeyId}.`, 'remove the lost key from the GitHub account, then run the check again');
        continue;
      }
      confirmed.push(`${name}: listed on GitHub`);
    }
    // 3. A host-reviewed exception the change adds was approved on the host.
    for (const event of validEvents.filter((entry) => hostReviewedException(entry) && entry.seq >= baseLength)) {
      const name = `SF Guard event ${event.seq} (host-reviewed exception ${event.exception.id} for ${event.exception.approver})`;
      const review = await deps.hostReview(Number.isInteger(pullRequest) ? { pullRequest } : { commit: await deps.headCommit() });
      if (review.status === 'reviewed') confirmed.push(`${name}: approved on GitHub by ${review.reviewer} in pull request #${review.pullRequest}`);
      else if (review.status === 'unavailable') unconfirmed.push(`${name}: the review could not be read (${review.reason}); confirm it on a later run`);
      else fail('PSS_HOST_REVIEW_UNCONFIRMED', `${name}: ${review.reason}.`, 'have a member other than the author approve the pull request on GitHub, then run the check again');
    }
  } else {
    // A full run: a pinned key the account no longer lists is named, so a person revokes or rotates it.
    for (const [approver, pin] of folded.pins ?? new Map()) {
      const login = approvers.get(approver)?.githubLogin;
      if (!login) continue;
      const snapshot = await deps.signingKeys(login);
      if (snapshot.status === 'listed' && !githubListsKey(snapshot, pin.keyId)) {
        warnings.push(`SF Guard: GitHub no longer lists ${pin.keyId}, pinned for ${approver}; revoke or rotate it (singularity-flow guard revoke|rotate)`);
      }
    }
  }

  // 4. Every Story: its records verify, none disappears, none is taken back, and its pin is real.
  const optIn = folded.enabled ? await optInCommit(deps, policy, folded) : null;
  const storyRows = [];
  for (const story of stories) {
    if (!story.workflow) { warnings.push(`${story.relative} could not be read as JSON; it was not checked`); continue; }
    const baseText = baseRef ? await deps.readBaseFile(baseRef, story.relative) : null;
    let baseStory = null;
    try { baseStory = baseText ? JSON.parse(baseText) : null; } catch { baseStory = null; }
    const presence = await storyPresenceReport(root, story.workflow, verifyOption);
    const records = storyPersonRecords(story.workflow);
    const onBase = new Set(baseStory ? storyPersonRecords(baseStory).map((entry) => canonicalJson(entry.record)) : []);
    if (presence.required) {
      presence.records.forEach((entry, index) => {
        if (entry.counts || !entry.active) return;
        const message = `${story.id}: ${entry.name} does not verify (${entry.reason}).`;
        if (onBase.has(canonicalJson(records[index].record))) warnings.push(`${message} It is already on the base and counts for nothing.`);
        else fail(entry.code ?? 'PSS_RECORD_UNSIGNED', message, personRecordRoute(story.workflow, records[index]), { story: story.id });
      });
    }
    // AC-009 (SPEC-SFG-v1 REQ-050): a counted approval's sealed packet, and so its SF Guard labels,
    // still holds the bytes the approval signed. Already so on the base: a note, never a hold.
    const sealedApprovals = presence.records.map((entry, index) => ({ ...entry, record: records[index].record }))
      .filter((entry) => entry.list === 'approvals' && entry.counts && entry.active && entry.record?.decision === 'approved');
    if (sealedApprovals.length) {
      const { sealedPacketProblems } = await import('./attribution.mjs');
      for (const problem of await sealedPacketProblems(story.workflow, sealedApprovals, deps.readHeadFile)) {
        const message = `${story.id}: ${problem.name}: ${problem.reason}.`;
        const before = problem.path && baseRef ? await deps.readBaseFile(baseRef, problem.path) : undefined;
        const onBase = baseRef && (problem.status === 'missing'
          ? !(baseStory?.lineage?.submissions ?? []).some((item) => item.packetSha256 === problem.packetSha256)
          : before === await deps.readHeadFile(problem.path));
        if (onBase) warnings.push(`${message} It is already so on the base.`);
        else fail('PSS_PACKET_ALTERED', message, `restore ${problem.path ?? 'the packet'} as the approval sealed it (it is in the Story's history), or the approver reviews the new packet and approves it again in their own terminal: singularity-flow approve ${problem.phase} --work-id ${story.id}`, { story: story.id });
      }
    }
    if (baseStory) {
      const history = presenceHistoryProblems(baseStory, story.workflow);
      for (const entry of history.removed) {
        fail('PSS_RECORD_REMOVED', `${story.id}: the person record ${entry.name} is on the base and this change removes it.`, 'keep the record; a person withdraws a decision with its own command, never by deleting it', { story: story.id });
      }
      for (const entry of history.revived) {
        fail('PSS_WITHDRAWAL_REMOVED', `${story.id}: this change takes back ${entry.field} on ${entry.name}, which revives a decision.`, 'keep the record as the base has it', { story: story.id });
      }
      for (const entry of history.withdrawn) warnings.push(`${story.id}: ${entry.name} gains ${entry.field} in this change (stricter; it carries no signature of its own)`);
    }
    if (optIn && !presence.required) {
      const forged = await pinForgery(deps, story, { optIn, newInChange: Boolean(baseRef) && !baseStory });
      if (forged.status === 'forged') {
        fail('PSS_PIN_FORGED', `${story.id}: it was created after SF Guard was turned on (${forged.evidence}), but its record reads as made before it.`,
          'start the Story again from the current default branch, so SF Guard applies to it', { story: story.id });
      } else if (forged.status === 'unconfirmed') unconfirmed.push(`${story.id}: ${forged.evidence}`);
    }
    storyRows.push({ workId: story.id, required: presence.required, ...presence.summary, elapsedMs: presence.elapsedMs });
  }
  return report({ status: failures.length ? 'failed' : 'passed', base: baseRef, chain, failures, warnings, unconfirmed, confirmed, stories: storyRows });
}

function report(fields) {
  return { schemaVersion: 1, resultType: 'sflow-presence-remote-check', ...fields }; // schema-transient: command result
}

/** The commit that added the enable event in force, on the configuration's history, or null. */
async function optInCommit(deps, policy, folded) {
  if (!Number.isInteger(folded.enabledAt) || !policy.chain) return null;
  const event = policy.chain.events[folded.enabledAt];
  const digest = event ? presenceEventDigest(event) : null;
  const tip = policy.source?.commit ?? 'HEAD';
  const revisions = [...await deps.configurationRevisions(tip)].reverse();
  for (const commit of revisions) {
    const chain = parsePresenceChain(await deps.readBaseFile(commit, PRESENCE_CHAIN_PATH)).chain;
    const at = chain?.events?.[folded.enabledAt];
    if (at && presenceEventDigest(at) === digest) return commit;
  }
  return null;
}

/**
 * Whether a Story that reads as `pre-signing` was really created after the opt-in: `{ status:
 * 'forged'|'ok'|'unconfirmed', evidence }`. Commit ancestry first; then, for a Story new in this
 * change, when the host first received each commit (a commit's own date can be backdated).
 */
async function pinForgery(deps, story, { optIn, newInChange }) {
  const created = await deps.creationCommit(story.relative);
  if (!created) return { status: 'ok', evidence: null };
  if (created !== optIn && await deps.isAncestor(optIn, created)) {
    return { status: 'forged', evidence: `its first commit ${created.slice(0, 12)} descends from the opt-in ${optIn.slice(0, 12)}` };
  }
  if (!newInChange) return { status: 'ok', evidence: null };
  const storyPush = await deps.firstPushTime(created);
  const optInPush = await deps.firstPushTime(optIn);
  if (storyPush.status !== 'known' || optInPush.status !== 'known') {
    return { status: 'unconfirmed', evidence: `when its first commit reached GitHub could not be compared with the opt-in (${storyPush.reason ?? optInPush.reason})` };
  }
  return Date.parse(storyPush.at) > Date.parse(optInPush.at)
    ? { status: 'forged', evidence: `GitHub first received its first commit at ${storyPush.at}, after the opt-in at ${optInPush.at}` }
    : { status: 'ok', evidence: null };
}

/** The remote check's report in words, failures first, each with its route. */
export function remotePresenceText(result) {
  if (result.status === 'not-opted-in') return 'SF Guard remote check: passed — this repository has not opted in to SF Guard, so there is nothing to verify.';
  const lines = [`SF Guard remote check: ${result.status === 'passed' ? 'passed' : 'FAILED'}${result.base ? ` (against the base ${result.base.slice(0, 12)})` : ' (every record)'}`];
  lines.push(`  Policy chain ${result.chain.chainId ?? '(none)'}: ${result.chain.validEvents} of ${result.chain.events} event(s) verify; SF Guard ${result.chain.enabled ? 'on' : 'off'}${result.chain.remoteCheck ? `; required check: ${result.chain.remoteCheck}` : ''}.`);
  const required = result.stories.filter((row) => row.required);
  lines.push(`  Stories: ${result.stories.length} checked, ${required.length} requiring presence (${required.reduce((sum, row) => sum + row.signed, 0)} signed record(s), ${required.reduce((sum, row) => sum + row.bypass, 0)} under an exception).`);
  for (const entry of result.failures) lines.push(`  Failure (${entry.code}): ${entry.message}${entry.route ? ` Route: ${entry.route}.` : ''}`);
  for (const entry of result.unconfirmed) lines.push(`  Unconfirmed: ${entry}`);
  for (const entry of result.confirmed) lines.push(`  Confirmed: ${entry}`);
  for (const entry of result.warnings) lines.push(`  Note: ${entry}`);
  return lines.join('\n');
}
